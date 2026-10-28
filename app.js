(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // Load the model through this site's Worker proxy to avoid browser CORS failures.
  // Only the model file is proxied; user images remain in browser memory.
  const MODEL_URL = '/model/migan_pipeline_v2.onnx';
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';
  const TESSERACT_BASE = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/';
  const LANG_BASE = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int';
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_SIDE = 2048;
  const MAX_HISTORY = 15;

  const state = {
    image: null, originalPixels: null, originalFileName: 'image', width: 0, height: 0,
    mask: null, maskedPixels: 0, resultData: null, mode: 'paint', showMask: true,
    pointerDown: false, session: null, provider: null, modelPromise: null,
    ocrWorker: null, ocrPromise: null, history: [], historyIndex: -1,
    busy: false, fit: true, toastTimer: null
  };
  const originalCanvas = $('originalCanvas');
  const resultCanvas = $('resultCanvas');
  const originalCtx = originalCanvas.getContext('2d', { willReadFrequently: true });
  const resultCtx = resultCanvas.getContext('2d', { willReadFrequently: true });
  const overlayCanvas = document.createElement('canvas');
  const overlayCtx = overlayCanvas.getContext('2d');
  const ocrCanvas = document.createElement('canvas');
  const ocrCtx = ocrCanvas.getContext('2d', { willReadFrequently: true });

  function toast(message, ms = 3600) {
    const el = $('toast'); el.textContent = message; el.classList.add('show');
    clearTimeout(state.toastTimer); state.toastTimer = setTimeout(() => el.classList.remove('show'), ms);
  }
  function setStatus(title, detail, status, cls = '') {
    $('runtimeTitle').textContent = title;
    $('runtimeDetail').textContent = detail;
    $('runtimeStatus').textContent = status;
    $('runtimeStatus').className = `runtime-state ${cls}`;
  }
  function setProgress(label, value = null) {
    $('progressArea').classList.remove('hidden');
    $('progressText').textContent = label;
    if (value !== null) {
      const pct = Math.max(0, Math.min(100, Math.round(value)));
      $('progressPercent').textContent = `${pct}%`;
      $('progressBar').style.width = `${pct}%`;
    }
  }
  function hideProgress() { $('progressArea').classList.add('hidden'); }
  function setBusy(busy) {
    state.busy = busy;
    $('uploadButton').disabled = busy;
    $('emptyUploadButton').disabled = busy;
    $('detectButton').disabled = !state.image || busy;
    $('processButton').disabled = !state.image || busy || !hasMask();
    $('paintTool').disabled = !state.image || busy;
    $('eraseTool').disabled = !state.image || busy;
    $('brushSize').disabled = !state.image || busy;
    $('clearMaskButton').disabled = !state.image || busy || !hasMask();
    $('downloadButton').disabled = !state.image || busy || !state.resultData;
    $('maskToggle').disabled = !state.image || busy;
    $('fitButton').disabled = !state.image || busy;
    updateHistoryButtons();
  }
  function hasMask() { return state.maskedPixels > 0; }
  function updateHistoryButtons() {
    $('undoButton').disabled = state.busy || state.historyIndex <= 0;
    $('redoButton').disabled = state.busy || state.historyIndex < 0 || state.historyIndex >= state.history.length - 1;
  }
  function updateCanvasCursor() {
    $('originalFrame').classList.toggle('painting', !!state.image && (state.mode === 'paint' || state.mode === 'erase'));
    $('paintHint').textContent = state.mode === 'erase' ? 'ระบายเพื่อคืนพื้นที่ที่ไม่ต้องการลบ' : 'ระบายบนภาพเพื่อเลือกพื้นที่ลบ';
    $('paintTool').classList.toggle('active', state.mode === 'paint');
    $('eraseTool').classList.toggle('active', state.mode === 'erase');
  }
  function updatePreviewLabels() {
    $('maskToggle').classList.toggle('active', state.showMask);
    $('maskToggle').textContent = state.showMask ? 'ซ่อนมาสก์' : 'แสดงมาสก์';
    $('originalInfo').textContent = hasMask() ? 'มีพื้นที่เลือก' : 'ต้นฉบับ';
    $('resultInfo').textContent = state.resultData ? 'ประมวลผลแล้ว' : 'ยังไม่ประมวลผล';
    $('resultPlaceholder').classList.toggle('hidden', !!state.resultData);
    $('canvasStatus').innerHTML = `<i class="tiny-status"></i> ${hasMask() ? 'มาสก์พร้อมประมวลผล' : 'โหลดภาพแล้ว'}`;
  }
  function drawOriginal() {
    if (!state.image) return;
    originalCtx.putImageData(state.originalPixels, 0, 0);
    if (state.showMask && state.mask) {
      const overlay = overlayCtx.createImageData(state.width, state.height);
      const d = overlay.data;
      for (let i = 0, p = 0; i < state.mask.length; i++, p += 4) {
        if (state.mask[i] === 0) { d[p] = 245; d[p + 1] = 66; d[p + 2] = 66; d[p + 3] = 112; }
      }
      overlayCtx.putImageData(overlay, 0, 0);
      originalCtx.drawImage(overlayCanvas, 0, 0);
    }
    updatePreviewLabels();
  }
  function drawResult() {
    if (!state.image) return;
    if (state.resultData) resultCtx.putImageData(state.resultData, 0, 0);
    else resultCtx.putImageData(state.originalPixels, 0, 0);
    updatePreviewLabels();
  }
  function snapshot() {
    return { mask: state.mask ? new Uint8Array(state.mask) : null, maskedPixels: state.maskedPixels, resultData: state.resultData ? new ImageData(new Uint8ClampedArray(state.resultData.data), state.width, state.height) : null };
  }
  function pushHistory() {
    if (state.historyIndex < state.history.length - 1) state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push(snapshot());
    if (state.history.length > MAX_HISTORY) state.history.shift();
    state.historyIndex = state.history.length - 1;
    updateHistoryButtons();
  }
  function restoreHistory(index) {
    if (index < 0 || index >= state.history.length) return;
    state.historyIndex = index;
    const item = state.history[index];
    state.mask = item.mask ? new Uint8Array(item.mask) : null;
    state.maskedPixels = item.maskedPixels ?? (state.mask ? state.mask.reduce((n, value) => n + (value === 0 ? 1 : 0), 0) : 0);
    state.resultData = item.resultData ? new ImageData(new Uint8ClampedArray(item.resultData.data), state.width, state.height) : null;
    drawOriginal(); drawResult(); setBusy(false); updateHistoryButtons();
  }
  function setMaskPixel(x, y, value) {
    const r = Math.max(4, Math.round(Number($('brushSize').value) / 2));
    const minX = Math.max(0, Math.floor(x - r)), maxX = Math.min(state.width - 1, Math.ceil(x + r));
    const minY = Math.max(0, Math.floor(y - r)), maxY = Math.min(state.height - 1, Math.ceil(y + r));
    const rr = r * r;
    for (let py = minY; py <= maxY; py++) {
      const dy = py - y;
      for (let px = minX; px <= maxX; px++) {
        const dx = px - x;
        if (dx * dx + dy * dy <= rr) {
          const index = py * state.width + px;
          const previous = state.mask[index];
          if (previous !== value) {
            state.mask[index] = value;
            if (previous === 0) state.maskedPixels--;
            if (value === 0) state.maskedPixels++;
          }
        }
      }
    }
  }
  function paintSegment(x0, y0, x1, y1, value) {
    const distance = Math.hypot(x1 - x0, y1 - y0);
    const step = Math.max(1, Number($('brushSize').value) * 0.22);
    const count = Math.max(1, Math.ceil(distance / step));
    for (let i = 0; i <= count; i++) {
      const t = i / count;
      setMaskPixel(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, value);
    }
  }
  function canvasPoint(event) {
    const rect = originalCanvas.getBoundingClientRect();
    return { x: Math.max(0, Math.min(state.width - 1, (event.clientX - rect.left) * state.width / rect.width)), y: Math.max(0, Math.min(state.height - 1, (event.clientY - rect.top) * state.height / rect.height)) };
  }
  function clearMask() {
    if (!state.mask) return;
    state.mask.fill(255); state.maskedPixels = 0; state.resultData = null; drawOriginal(); drawResult(); pushHistory(); setBusy(false); toast('ล้างมาสก์แล้ว');
  }
  function expandMaskRect(x0, y0, x1, y1, pad) {
    const left = Math.max(0, Math.floor(x0 - pad)), top = Math.max(0, Math.floor(y0 - pad));
    const right = Math.min(state.width, Math.ceil(x1 + pad)), bottom = Math.min(state.height, Math.ceil(y1 + pad));
    for (let y = top; y < bottom; y++) {
      const start = y * state.width + left;
      const end = y * state.width + right;
      for (let i = start; i < end; i++) {
        if (state.mask[i] !== 0) { state.mask[i] = 0; state.maskedPixels++; }
      }
    }
  }
  function isEdgeText(box, text) {
    const marginX = state.width * 0.18, marginY = state.height * 0.18;
    const centerX = (box.x0 + box.x1) / 2, centerY = (box.y0 + box.y1) / 2;
    const nearEdge = box.x0 < marginX || box.x1 > state.width - marginX || box.y0 < marginY || box.y1 > state.height - marginY;
    const looksLikeWatermark = /https?:|www\.|\.com\b|\.net\b|\.cn\b|@|watermark|sample|preview|stock|copyright|\u00a9|\u00ae/i.test(text || '');
    const narrowText = (box.x1 - box.x0) < state.width * 0.65 && (box.y1 - box.y0) < state.height * 0.12;
    // Guard against deleting central product labels; explicit watermark-like terms are still limited to outer bands.
    return nearEdge && narrowText && (looksLikeWatermark || centerX < marginX || centerX > state.width - marginX || centerY < marginY || centerY > state.height - marginY);
  }

  async function loadOCR() {
    if (state.ocrWorker) return state.ocrWorker;
    if (state.ocrPromise) return state.ocrPromise;
    state.ocrPromise = (async () => {
      if (!window.Tesseract) throw new Error('โหลด OCR ไม่สำเร็จ กรุณาตรวจการเชื่อมต่อแล้วรีเฟรชหน้า');
      const worker = await window.Tesseract.createWorker('eng', 1, {
        workerPath: `${TESSERACT_BASE}worker.min.js`,
        corePath: `https://cdn.jsdelivr.net/npm/tesseract.js-core@5.1.1`,
        langPath: LANG_BASE,
        logger: (m) => {
          if (m.status === 'recognizing text') setProgress('กำลังอ่านข้อความบนภาพ…', 10 + m.progress * 55);
          else if (m.status === 'loading language traineddata') setProgress('ดาวน์โหลดชุดภาษา OCR ครั้งแรก…', (m.progress || 0) * 35);
        }
      });
      state.ocrWorker = worker; return worker;
    })();
    try { return await state.ocrPromise; } catch (err) { state.ocrPromise = null; throw err; }
  }

  async function detectWatermark() {
    if (!state.image || state.busy) return;
    setBusy(true); setStatus('กำลังตรวจจับข้อความ', 'OCR ทำงานบนอุปกรณ์ของคุณ', 'ทำงาน', 'busy');
    try {
      setProgress('เตรียม OCR ในเบราว์เซอร์…', 3);
      const worker = await loadOCR();
      setProgress('ตรวจหาข้อความที่ขอบภาพ…', 10);
      ocrCanvas.width = state.width; ocrCanvas.height = state.height;
      ocrCtx.putImageData(state.originalPixels, 0, 0);
      const { data } = await worker.recognize(ocrCanvas);
      const words = (data.words || []).filter(w => (w.confidence ?? 0) >= 45 && (w.text || '').trim().length >= 2);
      const candidates = words.filter(w => isEdgeText(w.bbox, w.text));
      if (!candidates.length) {
        setBusy(false); hideProgress(); setStatus('ไม่พบข้อความที่น่าสงสัย', 'ลองระบายพื้นที่ลายน้ำด้วยตนเอง', 'พร้อม', 'ready');
        toast('OCR ไม่พบข้อความบริเวณขอบภาพที่เข้าเกณฑ์ ลองเลือกพื้นที่เอง'); return;
      }
      for (const word of candidates) {
        const b = word.bbox;
        const pad = Math.max(4, Math.round(Math.min(state.width, state.height) * 0.006));
        expandMaskRect(b.x0, b.y0, b.x1, b.y1, pad);
      }
      state.resultData = null; drawOriginal(); drawResult(); pushHistory(); setBusy(false); hideProgress();
      setStatus(`พบข้อความที่น่าสงสัย ${candidates.length} จุด`, 'ตรวจมาสก์สีแดงก่อนสั่งให้ AI เติมภาพ', 'พบจุด', 'ready');
      toast(`พบข้อความ ${candidates.length} จุด — ตรวจพื้นที่สีแดงก่อนประมวลผล`);
    } catch (err) {
      console.error(err); setBusy(false); hideProgress(); setStatus('OCR ใช้งานไม่ได้', 'ระบายมาสก์เองได้โดยไม่ต้องใช้ OCR', 'แจ้งเตือน'); toast(err.message || 'ตรวจจับข้อความไม่สำเร็จ');
    }
  }

  async function ensureModel() {
    if (state.session) return state.session;
    if (state.modelPromise) return state.modelPromise;
    state.modelPromise = (async () => {
      if (!window.ort) throw new Error('โหลด ONNX Runtime ไม่สำเร็จ กรุณารีเฟรชหน้า');
      window.ort.env.wasm.wasmPaths = ORT_BASE;
      window.ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      setProgress('โหลดโมเดล MI-GAN (~28 MB) ผ่าน Worker ของเว็บ…', 5);
      try {
        setStatus('กำลังเตรียม AI', 'โหลดโมเดลจาก Worker ของเว็บ · ใช้ WebGPU ก่อน', 'เตรียม', 'busy');
        state.session = await window.ort.InferenceSession.create(MODEL_URL, { executionProviders: ['webgpu'], graphOptimizationLevel: 'all' });
        state.provider = 'WebGPU';
      } catch (gpuError) {
        console.warn('WebGPU init failed; falling back to WASM', gpuError);
        setStatus('เปลี่ยนเป็นโหมด CPU', 'WebGPU ใช้ไม่ได้ · กำลังใช้ WASM สำรอง', 'สำรอง', 'busy');
        state.session = await window.ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        state.provider = 'WASM / CPU';
      }
      return state.session;
    })();
    try { return await state.modelPromise; } catch (err) { state.modelPromise = null; state.session = null; throw err; }
  }

  async function runModelWithFallback(feeds) {
    try {
      return await state.session.run(feeds);
    } catch (webgpuError) {
      if (state.provider !== 'WebGPU') throw webgpuError;
      console.warn('WebGPU inference failed; retrying with WASM', webgpuError);
      setProgress('WebGPU ใช้ operator บางตัวไม่ได้ — เปลี่ยนเป็น WASM…', 78);
      const previousSession = state.session;
      state.session = null;
      try { if (previousSession && typeof previousSession.release === 'function') await previousSession.release(); } catch (_) {}
      state.session = await window.ort.InferenceSession.create(MODEL_URL, { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
      state.provider = 'WASM / CPU';
      return await state.session.run(feeds);
    }
  }

  async function processImage() {
    if (!state.image || state.busy) return;
    if (!hasMask()) { toast('ยังไม่มีพื้นที่ลบ กรุณาใช้ตรวจจับข้อความหรือระบายมาสก์ก่อน'); return; }
    setBusy(true); setStatus('กำลังเตรียม AI', 'โมเดลและภาพอยู่ในเบราว์เซอร์', 'ทำงาน', 'busy');
    try {
      const session = await ensureModel();
      setProgress('เตรียมข้อมูลภาพสำหรับ AI…', 65);
      const rgba = state.originalPixels.data;
      const imageCHW = new Uint8Array(3 * state.width * state.height);
      for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
        imageCHW[p] = rgba[i];
        imageCHW[state.width * state.height + p] = rgba[i + 1];
        imageCHW[2 * state.width * state.height + p] = rgba[i + 2];
      }
      const imageTensor = new window.ort.Tensor('uint8', imageCHW, [1, 3, state.height, state.width]);
      const maskTensor = new window.ort.Tensor('uint8', new Uint8Array(state.mask), [1, 1, state.height, state.width]);
      setProgress(`กำลังเติมภาพด้วย ${state.provider || 'AI'}…`, 75);
      const feeds = { image: imageTensor, mask: maskTensor };
      const output = await runModelWithFallback(feeds);
      const outTensor = output.result || output[session.outputNames[0]];
      if (!outTensor || !outTensor.data) throw new Error('ไม่พบผลลัพธ์จากโมเดล กรุณาตรวจ model signature');
      const raw = outTensor.data;
      let imageData;
      if (outTensor.dims.length === 4 && outTensor.dims[1] === 3) {
        const pixels = state.width * state.height;
        const rgbaOut = new Uint8ClampedArray(pixels * 4);
        for (let p = 0; p < pixels; p++) {
          rgbaOut[p * 4] = raw[p]; rgbaOut[p * 4 + 1] = raw[pixels + p]; rgbaOut[p * 4 + 2] = raw[2 * pixels + p]; rgbaOut[p * 4 + 3] = 255;
        }
        imageData = new ImageData(rgbaOut, state.width, state.height);
      } else if (outTensor.dims.length === 4 && outTensor.dims[3] === 3) {
        const rgbaOut = new Uint8ClampedArray(state.width * state.height * 4);
        for (let p = 0, q = 0; p < rgbaOut.length; p += 4, q += 3) { rgbaOut[p] = raw[q]; rgbaOut[p + 1] = raw[q + 1]; rgbaOut[p + 2] = raw[q + 2]; rgbaOut[p + 3] = 255; }
        imageData = new ImageData(rgbaOut, state.width, state.height);
      } else {
        throw new Error(`ขนาดผลลัพธ์โมเดลไม่ตรงกับที่คาด: ${JSON.stringify(outTensor.dims)}`);
      }
      state.resultData = imageData; drawResult(); pushHistory();
      setStatus(`พร้อมใช้งาน · ${state.provider}`, 'ผลลัพธ์ถูกสร้างภายในเบราว์เซอร์', 'เสร็จแล้ว', 'ready');
      setProgress('เสร็จสิ้น', 100); setTimeout(hideProgress, 1000);
      setBusy(false); toast('ประมวลผลเสร็จแล้ว ตรวจรายละเอียดก่อนดาวน์โหลด');
    } catch (err) {
      console.error(err); setBusy(false); hideProgress();
      setStatus('ประมวลผลไม่สำเร็จ', 'ตรวจ WebGPU / หน่วยความจำ / การโหลดโมเดล', 'ผิดพลาด');
      toast(`ไม่สามารถประมวลผลได้: ${err.message || 'ไม่ทราบสาเหตุ'}`, 6000);
    }
  }

  async function loadImage(file) {
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) { toast('รองรับเฉพาะไฟล์ JPG, PNG และ WebP'); return; }
    if (file.size > MAX_FILE_BYTES) { toast('ไฟล์ใหญ่เกิน 20 MB กรุณาย่อภาพก่อน'); return; }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const ratio = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
      state.width = Math.max(1, Math.round(img.naturalWidth * ratio)); state.height = Math.max(1, Math.round(img.naturalHeight * ratio));
      state.image = img; state.originalFileName = (file.name || 'image').replace(/\.[^.]+$/, '') || 'image';
      originalCanvas.width = resultCanvas.width = state.width; originalCanvas.height = resultCanvas.height = state.height;
      overlayCanvas.width = ocrCanvas.width = state.width; overlayCanvas.height = ocrCanvas.height = state.height;
      const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = state.width; sourceCanvas.height = state.height;
      const sourceCtx = sourceCanvas.getContext('2d', { willReadFrequently: true });
      sourceCtx.drawImage(img, 0, 0, state.width, state.height);
      state.originalPixels = sourceCtx.getImageData(0, 0, state.width, state.height);
      state.mask = new Uint8Array(state.width * state.height); state.mask.fill(255); state.maskedPixels = 0; state.resultData = null;
      state.history = []; state.historyIndex = -1;
      $('emptyState').classList.add('hidden'); $('canvasStage').classList.remove('hidden'); $('fileMeta').classList.remove('hidden');
      $('fileName').textContent = file.name; $('fileDimensions').textContent = `${img.naturalWidth} × ${img.naturalHeight}px${ratio < 1 ? ` · ปรับประมวลผลเป็น ${state.width} × ${state.height}px` : ''}`;
      drawOriginal(); drawResult(); pushHistory(); setBusy(false); updateCanvasCursor();
      setStatus('พร้อมเมื่อคุณเริ่ม', 'WebGPU ก่อน · WASM สำรอง', 'รอ');
      if (ratio < 1) toast(`ลดขนาดภาพเพื่อป้องกันหน่วยความจำเต็ม (${state.width} × ${state.height}px)`);
    };
    img.onerror = () => { URL.revokeObjectURL(url); toast('เปิดภาพไม่สำเร็จ ไฟล์อาจเสียหายหรือไม่รองรับ'); };
    img.src = url;
  }

  function downloadResult() {
    if (!state.image || !state.resultData) return;
    const exportCanvas = document.createElement('canvas'); exportCanvas.width = state.width; exportCanvas.height = state.height;
    exportCanvas.getContext('2d').putImageData(state.resultData, 0, 0);
    exportCanvas.toBlob((blob) => {
      if (!blob) { toast('สร้างไฟล์ดาวน์โหลดไม่สำเร็จ'); return; }
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `${state.originalFileName}-cleaned.png`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500); toast('ดาวน์โหลดภาพ PNG แล้ว');
    }, 'image/png');
  }

  $('uploadButton').addEventListener('click', () => $('fileInput').click());
  $('emptyUploadButton').addEventListener('click', () => $('fileInput').click());
  $('replaceButton').addEventListener('click', () => $('fileInput').click());
  $('fileInput').addEventListener('change', (e) => { loadImage(e.target.files?.[0]); e.target.value = ''; });
  $('detectButton').addEventListener('click', detectWatermark);
  $('processButton').addEventListener('click', processImage);
  $('downloadButton').addEventListener('click', downloadResult);
  $('clearMaskButton').addEventListener('click', clearMask);
  $('paintTool').addEventListener('click', () => { state.mode = 'paint'; updateCanvasCursor(); });
  $('eraseTool').addEventListener('click', () => { state.mode = 'erase'; updateCanvasCursor(); });
  $('brushSize').addEventListener('input', () => $('brushSizeValue').textContent = `${$('brushSize').value} px`);
  $('maskToggle').addEventListener('click', () => { state.showMask = !state.showMask; drawOriginal(); });
  $('fitButton').addEventListener('click', () => { state.fit = !state.fit; $('fitButton').textContent = state.fit ? 'พอดีหน้าจอ' : 'ขนาดภาพจริง'; for (const el of document.querySelectorAll('.canvas-frame')) { el.style.height = state.fit ? '' : 'auto'; el.style.minHeight = state.fit ? '' : '240px'; } });
  $('undoButton').addEventListener('click', () => restoreHistory(state.historyIndex - 1));
  $('redoButton').addEventListener('click', () => restoreHistory(state.historyIndex + 1));

  originalCanvas.addEventListener('pointerdown', (event) => {
    if (!state.image || state.busy || (state.mode !== 'paint' && state.mode !== 'erase')) return;
    event.preventDefault(); state.pointerDown = true; originalCanvas.setPointerCapture(event.pointerId);
    const p = canvasPoint(event); state.lastPoint = p; setMaskPixel(p.x, p.y, state.mode === 'paint' ? 0 : 255); drawOriginal();
  });
  originalCanvas.addEventListener('pointermove', (event) => {
    if (!state.pointerDown || !state.image) return;
    const p = canvasPoint(event); paintSegment(state.lastPoint.x, state.lastPoint.y, p.x, p.y, state.mode === 'paint' ? 0 : 255); state.lastPoint = p; drawOriginal();
  });
  const endPaint = () => { if (state.pointerDown) { state.pointerDown = false; state.resultData = null; drawResult(); pushHistory(); setBusy(false); } };
  originalCanvas.addEventListener('pointerup', endPaint); originalCanvas.addEventListener('pointercancel', endPaint); originalCanvas.addEventListener('lostpointercapture', endPaint);

  const dropzone = $('uploadButton');
  for (const eventName of ['dragenter', 'dragover']) dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.add('dragover'); });
  for (const eventName of ['dragleave', 'drop']) dropzone.addEventListener(eventName, (event) => { event.preventDefault(); dropzone.classList.remove('dragover'); });
  dropzone.addEventListener('drop', (event) => loadImage(event.dataTransfer?.files?.[0]));
  document.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !state.busy) { event.preventDefault(); restoreHistory(state.historyIndex + (event.shiftKey ? 1 : -1)); }
  });

  if (!('gpu' in navigator)) $('runtimeDetail').textContent = 'อุปกรณ์นี้อาจใช้ WASM / CPU สำรอง';
  setBusy(false); updateCanvasCursor();
})();
