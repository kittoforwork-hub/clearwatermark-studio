(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  // Load the model through this site's Worker proxy to avoid browser CORS failures.
  // Only the model file is proxied; user images remain in browser memory.
  const MODEL_URLS = { migan: '/model/migan_pipeline_v2.onnx', lama: '/model/lama_fp32.onnx' };
  const MODEL_LABELS = { migan: 'MI-GAN', lama: 'LaMa' };
  const ORT_BASE = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.23.2/dist/';
  const TESSERACT_BASE = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/';
  const LANG_BASE = 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int';
  const MAX_FILE_BYTES = 20 * 1024 * 1024;
  const MAX_SIDE = 2048;
  const MAX_HISTORY = 15;

  const state = {
    image: null, originalPixels: null, originalFileName: 'image', width: 0, height: 0,
    mask: null, maskedPixels: 0, resultData: null, mode: 'paint', showMask: true,
    pointerDown: false, sessions: Object.create(null), providers: Object.create(null), modelPromises: Object.create(null),
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
    $('modelSelect').disabled = busy;
    $('maskExpand').disabled = !state.image || busy;
    $('maskFeather').disabled = !state.image || busy;
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

  function selectedModel() { return $('modelSelect').value === 'migan' ? 'migan' : 'lama'; }

  async function ensureModel(kind) {
    if (state.sessions[kind]) return state.sessions[kind];
    if (state.modelPromises[kind]) return state.modelPromises[kind];
    state.modelPromises[kind] = (async () => {
      if (!window.ort) throw new Error('โหลด ONNX Runtime ไม่สำเร็จ กรุณารีเฟรชหน้า');
      window.ort.env.wasm.wasmPaths = ORT_BASE;
      window.ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;
      const modelSize = kind === 'lama' ? '~208 MB' : '~28 MB';
      setProgress(`กำลังโหลดโมเดล ${MODEL_LABELS[kind]} (${modelSize})…`, 6);
      let lastError;
      for (const provider of ['webgpu', 'wasm']) {
        try {
          setStatus(`กำลังเตรียม ${MODEL_LABELS[kind]}`, provider === 'webgpu' ? 'กำลังลอง WebGPU ก่อน' : 'กำลังใช้ WASM / CPU สำรอง', 'เตรียม', 'busy');
          const session = await window.ort.InferenceSession.create(MODEL_URLS[kind], {
            executionProviders: [provider], graphOptimizationLevel: 'all'
          });
          state.sessions[kind] = session;
          state.providers[kind] = provider === 'webgpu' ? 'WebGPU' : 'WASM / CPU';
          return session;
        } catch (err) {
          lastError = err;
          console.warn(`${MODEL_LABELS[kind]} ${provider} initialization failed`, err);
        }
      }
      throw lastError || new Error('ไม่สามารถเริ่มโมเดลได้');
    })();
    try { return await state.modelPromises[kind]; }
    catch (err) { state.modelPromises[kind] = null; state.sessions[kind] = null; state.providers[kind] = null; throw err; }
    finally { if (state.sessions[kind]) state.modelPromises[kind] = null; }
  }

  async function runModelWithFallback(kind, feeds) {
    try {
      return await state.sessions[kind].run(feeds);
    } catch (gpuError) {
      if (state.providers[kind] !== 'WebGPU') throw gpuError;
      console.warn(`${MODEL_LABELS[kind]} WebGPU inference failed; retrying with WASM`, gpuError);
      setProgress('WebGPU ไม่รองรับบาง operation — เปลี่ยนเป็น WASM / CPU…', 70);
      const previousSession = state.sessions[kind];
      state.sessions[kind] = null;
      try { if (previousSession && typeof previousSession.release === 'function') await previousSession.release(); } catch (_) {}
      state.sessions[kind] = await window.ort.InferenceSession.create(MODEL_URLS[kind], {
        executionProviders: ['wasm'], graphOptimizationLevel: 'all'
      });
      state.providers[kind] = 'WASM / CPU';
      return await state.sessions[kind].run(feeds);
    }
  }

  // A separable binary max filter expands the mask without quadratic brush-radius loops.
  function dilateMask(mask, width, height, radius) {
    const source = new Uint8Array(mask.length);
    for (let i = 0; i < mask.length; i++) source[i] = mask[i] === 0 ? 1 : 0;
    if (radius <= 0) return source;
    const horizontal = new Uint8Array(source.length);
    const output = new Uint8Array(source.length);
    for (let y = 0; y < height; y++) {
      const row = y * width; let count = 0;
      for (let x = 0; x <= Math.min(width - 1, radius); x++) count += source[row + x];
      for (let x = 0; x < width; x++) {
        horizontal[row + x] = count > 0 ? 1 : 0;
        const removeX = x - radius; if (removeX >= 0) count -= source[row + removeX];
        const addX = x + radius + 1; if (addX < width) count += source[row + addX];
      }
    }
    for (let x = 0; x < width; x++) {
      let count = 0;
      for (let y = 0; y <= Math.min(height - 1, radius); y++) count += horizontal[y * width + x];
      for (let y = 0; y < height; y++) {
        output[y * width + x] = count > 0 ? 1 : 0;
        const removeY = y - radius; if (removeY >= 0) count -= horizontal[removeY * width + x];
        const addY = y + radius + 1; if (addY < height) count += horizontal[addY * width + x];
      }
    }
    return output;
  }

  // Find disconnected mask islands on a 4px grid so distant corner marks use separate local crops.
  function findMaskRegions(binaryMask) {
    const scale = 4, width = state.width, height = state.height;
    const gw = Math.ceil(width / scale), gh = Math.ceil(height / scale), total = gw * gh;
    const active = new Uint8Array(total);
    for (let gy = 0; gy < gh; gy++) {
      const y0 = gy * scale, y1 = Math.min(height, y0 + scale);
      for (let gx = 0; gx < gw; gx++) {
        const x0 = gx * scale, x1 = Math.min(width, x0 + scale);
        let found = false;
        for (let y = y0; y < y1 && !found; y++) {
          const row = y * width;
          for (let x = x0; x < x1; x++) if (binaryMask[row + x]) { found = true; break; }
        }
        if (found) active[gy * gw + gx] = 1;
      }
    }
    const visited = new Uint8Array(total), queue = new Int32Array(total), regions = [];
    for (let id = 0; id < total; id++) {
      if (!active[id] || visited[id]) continue;
      let head = 0, tail = 0;
      queue[tail++] = id; visited[id] = 1;
      let minX = gw, minY = gh, maxX = 0, maxY = 0;
      while (head < tail) {
        const cur = queue[head++], x = cur % gw, y = (cur / gw) | 0;
        minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
          const ni = ny * gw + nx;
          if (active[ni] && !visited[ni]) { visited[ni] = 1; queue[tail++] = ni; }
        }
      }
      regions.push({ x0: minX * scale, y0: minY * scale, x1: Math.min(width - 1, (maxX + 1) * scale - 1), y1: Math.min(height - 1, (maxY + 1) * scale - 1) });
    }
    const gap = Math.max(12, Math.round(Math.min(width, height) * 0.012));
    const distance = (a, b) => {
      const dx = Math.max(0, a.x0 - b.x1 - 1, b.x0 - a.x1 - 1);
      const dy = Math.max(0, a.y0 - b.y1 - 1, b.y0 - a.y1 - 1);
      return Math.max(dx, dy);
    };
    let changed = true;
    while (changed) {
      changed = false;
      outer: for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
        if (distance(regions[i], regions[j]) <= gap) {
          const a = regions[i], b = regions[j];
          a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
          regions.splice(j, 1); changed = true; break outer;
        }
      }
    }
    while (regions.length > 16) {
      let bi = 0, bj = 1, bd = Infinity;
      for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
        const dx = ((regions[i].x0 + regions[i].x1) - (regions[j].x0 + regions[j].x1)) / 2;
        const dy = ((regions[i].y0 + regions[i].y1) - (regions[j].y0 + regions[j].y1)) / 2;
        const d = dx * dx + dy * dy;
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
      const a = regions[bi], b = regions[bj];
      a.x0 = Math.min(a.x0, b.x0); a.y0 = Math.min(a.y0, b.y0); a.x1 = Math.max(a.x1, b.x1); a.y1 = Math.max(a.y1, b.y1);
      regions.splice(bj, 1);
    }
    return regions;
  }

  function makeSoftMask(binaryMask, feather) {
    const canvas = document.createElement('canvas'); canvas.width = state.width; canvas.height = state.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const img = ctx.createImageData(state.width, state.height);
    for (let i = 0, p = 0; i < binaryMask.length; i++, p += 4) {
      const v = binaryMask[i] ? 255 : 0;
      img.data[p] = img.data[p + 1] = img.data[p + 2] = v; img.data[p + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    if (feather > 0) {
      const soft = document.createElement('canvas'); soft.width = state.width; soft.height = state.height;
      const sctx = soft.getContext('2d', { willReadFrequently: true });
      sctx.filter = `blur(${feather}px)`; sctx.drawImage(canvas, 0, 0); sctx.filter = 'none';
      return sctx.getImageData(0, 0, state.width, state.height).data;
    }
    return img.data;
  }

  function createCrop(sourceCanvas, roi) {
    const crop = document.createElement('canvas'); crop.width = crop.height = roi.side;
    const ctx = crop.getContext('2d', { willReadFrequently: true });
    const cx = Math.max(0, Math.min(state.width - 1, Math.round(roi.x0 + roi.side / 2)));
    const cy = Math.max(0, Math.min(state.height - 1, Math.round(roi.y0 + roi.side / 2)));
    const cp = (cy * state.width + cx) * 4, px = state.originalPixels.data;
    ctx.fillStyle = `rgb(${px[cp]},${px[cp + 1]},${px[cp + 2]})`; ctx.fillRect(0, 0, roi.side, roi.side);
    const sx = Math.max(0, roi.x0), sy = Math.max(0, roi.y0);
    const ex = Math.min(state.width, roi.x0 + roi.side), ey = Math.min(state.height, roi.y0 + roi.side);
    const sw = Math.max(0, ex - sx), sh = Math.max(0, ey - sy), dx = sx - roi.x0, dy = sy - roi.y0;
    if (sw && sh) {
      ctx.drawImage(sourceCanvas, sx, sy, sw, sh, dx, dy, sw, sh);
      // Extend image edges into any padded area to avoid a synthetic hard border near edge watermarks.
      if (dy > 0) ctx.drawImage(sourceCanvas, sx, 0, sw, 1, dx, 0, sw, dy);
      if (dy + sh < roi.side) ctx.drawImage(sourceCanvas, sx, state.height - 1, sw, 1, dx, dy + sh, sw, roi.side - dy - sh);
      if (dx > 0) ctx.drawImage(sourceCanvas, 0, sy, 1, sh, 0, dy, dx, sh);
      if (dx + sw < roi.side) ctx.drawImage(sourceCanvas, state.width - 1, sy, 1, sh, dx + sw, dy, roi.side - dx - sw, sh);
    }
    return crop;
  }

  function makeRoi(region) {
    const bw = region.x1 - region.x0 + 1, bh = region.y1 - region.y0 + 1;
    const pad = Math.max(24, Math.min(140, Math.round(Math.max(bw, bh) * 0.42)));
    const side = Math.min(Math.max(bw, bh) + 2 * pad, Math.max(state.width, state.height));
    const cx = (region.x0 + region.x1 + 1) / 2, cy = (region.y0 + region.y1 + 1) / 2;
    let x0 = Math.round(cx - side / 2), y0 = Math.round(cy - side / 2);
    x0 = Math.max(Math.min(0, state.width - side), Math.min(Math.max(0, state.width - side), x0));
    y0 = Math.max(Math.min(0, state.height - side), Math.min(Math.max(0, state.height - side), y0));
    return { x0, y0, side };
  }

  function localMaskForRoi(binaryMask, roi) {
    const local = new Uint8Array(roi.side * roi.side);
    const sx0 = Math.max(0, roi.x0), sy0 = Math.max(0, roi.y0);
    const sx1 = Math.min(state.width, roi.x0 + roi.side), sy1 = Math.min(state.height, roi.y0 + roi.side);
    for (let y = sy0; y < sy1; y++) {
      const sourceStart = y * state.width + sx0;
      const localStart = (y - roi.y0) * roi.side + (sx0 - roi.x0);
      local.set(binaryMask.subarray(sourceStart, sourceStart + (sx1 - sx0)), localStart);
    }
    return local;
  }

  function makeLaMaFeeds(cropCanvas, localMask, side) {
    const size = 512;
    const imgCanvas = document.createElement('canvas'); imgCanvas.width = imgCanvas.height = size;
    const ictx = imgCanvas.getContext('2d', { willReadFrequently: true });
    ictx.imageSmoothingEnabled = true; ictx.imageSmoothingQuality = 'high'; ictx.drawImage(cropCanvas, 0, 0, size, size);
    const rgba = ictx.getImageData(0, 0, size, size).data;
    const pixels = size * size, image = new Float32Array(3 * pixels);
    for (let i = 0, p = 0; p < pixels; p++, i += 4) {
      image[p] = rgba[i] / 255; image[pixels + p] = rgba[i + 1] / 255; image[pixels * 2 + p] = rgba[i + 2] / 255;
    }
    // Conservative max-pooling keeps thin mask strokes visible after resizing to 512x512.
    const mask = new Float32Array(pixels);
    for (let y = 0; y < size; y++) {
      const sy0 = Math.floor(y * side / size), sy1 = Math.max(sy0 + 1, Math.ceil((y + 1) * side / size));
      for (let x = 0; x < size; x++) {
        const sx0 = Math.floor(x * side / size), sx1 = Math.max(sx0 + 1, Math.ceil((x + 1) * side / size));
        let hit = false;
        for (let sy = sy0; sy < Math.min(side, sy1) && !hit; sy++) {
          const off = sy * side;
          for (let sx = sx0; sx < Math.min(side, sx1); sx++) if (localMask[off + sx]) { hit = true; break; }
        }
        mask[y * size + x] = hit ? 1 : 0;
      }
    }
    return { feeds: { image: new window.ort.Tensor('float32', image, [1, 3, size, size]), mask: new window.ort.Tensor('float32', mask, [1, 1, size, size]) }, size };
  }

  function outputTensorToCanvas(tensor, kind, targetSide) {
    if (!tensor || !tensor.data || tensor.dims.length !== 4 || tensor.dims[1] !== 3) {
      throw new Error(`ขนาดผลลัพธ์โมเดลไม่ตรงกับที่คาด: ${JSON.stringify(tensor?.dims || [])}`);
    }
    const height = tensor.dims[2], width = tensor.dims[3], pixels = width * height, raw = tensor.data;
    const rgba = new Uint8ClampedArray(pixels * 4);
    for (let p = 0; p < pixels; p++) {
      rgba[p * 4] = Math.max(0, Math.min(255, Math.round(raw[p])));
      rgba[p * 4 + 1] = Math.max(0, Math.min(255, Math.round(raw[pixels + p])));
      rgba[p * 4 + 2] = Math.max(0, Math.min(255, Math.round(raw[2 * pixels + p])));
      rgba[p * 4 + 3] = 255;
    }
    const small = document.createElement('canvas'); small.width = width; small.height = height;
    small.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
    if (width === targetSide && height === targetSide) return small;
    const full = document.createElement('canvas'); full.width = full.height = targetSide;
    const fctx = full.getContext('2d', { willReadFrequently: true });
    fctx.imageSmoothingEnabled = true; fctx.imageSmoothingQuality = 'high'; fctx.drawImage(small, 0, 0, targetSide, targetSide);
    return full;
  }

  async function processRegion(kind, sourceCanvas, binaryMask, softMaskData, outputPixels, region, regionNo, totalRegions) {
    const roi = makeRoi(region), cropCanvas = createCrop(sourceCanvas, roi);
    const localMask = localMaskForRoi(binaryMask, roi);
    if (!localMask.some(v => v === 1)) return;
    const session = await ensureModel(kind);
    let feeds;
    if (kind === 'migan') {
      const rgba = cropCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, roi.side, roi.side).data;
      const pixels = roi.side * roi.side, image = new Uint8Array(3 * pixels), mask = new Uint8Array(pixels);
      for (let i = 0, p = 0; p < rgba.length; i += 4, p++) {
        image[p] = rgba[i]; image[pixels + p] = rgba[i + 1]; image[pixels * 2 + p] = rgba[i + 2];
        mask[p] = localMask[p] ? 0 : 255; // MI-GAN pipeline: 0=erase, 255=keep
      }
      feeds = { image: new window.ort.Tensor('uint8', image, [1, 3, roi.side, roi.side]), mask: new window.ort.Tensor('uint8', mask, [1, 1, roi.side, roi.side]) };
    } else {
      feeds = makeLaMaFeeds(cropCanvas, localMask, roi.side).feeds;
    }
    setProgress(`AI ${MODEL_LABELS[kind]} · บริเวณ ${regionNo}/${totalRegions} · ${state.providers[kind] || 'กำลังประมวลผล'}…`, 20 + (regionNo - 1) / totalRegions * 70);
    const output = await runModelWithFallback(kind, feeds);
    const currentSession = state.sessions[kind];
    const outputTensor = output.result || output.output || output[currentSession.outputNames[0]];
    const patchCanvas = outputTensorToCanvas(outputTensor, kind, roi.side);
    const patch = patchCanvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, roi.side, roi.side).data;
    const xStart = Math.max(0, roi.x0), yStart = Math.max(0, roi.y0);
    const xEnd = Math.min(state.width, roi.x0 + roi.side), yEnd = Math.min(state.height, roi.y0 + roi.side);
    const original = state.originalPixels.data;
    for (let y = yStart; y < yEnd; y++) {
      const gy = y * state.width, ly = (y - roi.y0) * roi.side;
      for (let x = xStart; x < xEnd; x++) {
        const gi = gy + x, p = gi * 4, lp = (ly + x - roi.x0) * 4;
        const alpha = softMaskData[p] / 255;
        if (alpha <= 0) continue;
        outputPixels[p] = Math.round(original[p] * (1 - alpha) + patch[lp] * alpha);
        outputPixels[p + 1] = Math.round(original[p + 1] * (1 - alpha) + patch[lp + 1] * alpha);
        outputPixels[p + 2] = Math.round(original[p + 2] * (1 - alpha) + patch[lp + 2] * alpha);
        outputPixels[p + 3] = 255;
      }
    }
  }

  async function processImage() {
    if (!state.image || state.busy) return;
    if (!hasMask()) { toast('ยังไม่มีพื้นที่ลบ กรุณาค้นหาข้อความหรือระบายมาสก์ก่อน'); return; }
    const kind = selectedModel();
    setBusy(true); setStatus('กำลังเตรียม AI', 'ภาพต้นฉบับยังอยู่ในเบราว์เซอร์', 'ทำงาน', 'busy');
    try {
      const expansion = Number($('maskExpand').value);
      const feather = Number($('maskFeather').value);
      setProgress('ขยายมาสก์ให้คลุมขอบลายน้ำ…', 4);
      const binaryMask = dilateMask(state.mask, state.width, state.height, expansion);
      const softMaskData = makeSoftMask(binaryMask, feather);
      const regions = findMaskRegions(binaryMask);
      if (!regions.length) throw new Error('ไม่พบพื้นที่มาสก์ กรุณาระบายบริเวณที่ต้องการลบใหม่');
      const outputPixels = new Uint8ClampedArray(state.originalPixels.data);
      const sourceCanvas = document.createElement('canvas'); sourceCanvas.width = state.width; sourceCanvas.height = state.height;
      sourceCanvas.getContext('2d').putImageData(state.originalPixels, 0, 0);
      setProgress(`เตรียม ${MODEL_LABELS[kind]} · พบ ${regions.length} บริเวณ…`, 10);
      await ensureModel(kind);
      for (let i = 0; i < regions.length; i++) {
        await processRegion(kind, sourceCanvas, binaryMask, softMaskData, outputPixels, regions[i], i + 1, regions.length);
      }
      state.resultData = new ImageData(outputPixels, state.width, state.height);
      drawResult(); pushHistory();
      setStatus(`เสร็จแล้ว · ${MODEL_LABELS[kind]} · ${state.providers[kind]}`, `${regions.length} บริเวณ · ขยายมาสก์ ${expansion}px · เกลี่ยขอบ ${feather}px`, 'เสร็จแล้ว', 'ready');
      setProgress('เสร็จสิ้น', 100); setTimeout(hideProgress, 1000);
      setBusy(false); toast(`ประมวลผล ${regions.length} บริเวณเสร็จแล้ว กรุณาซูมตรวจสอบสินค้าและตัวเลขรุ่น`);
    } catch (err) {
      console.error(err); setBusy(false); hideProgress();
      setStatus('ประมวลผลไม่สำเร็จ', 'ตรวจการโหลดโมเดล หน่วยความจำ และการเชื่อมต่อ', 'ผิดพลาด');
      toast(`ไม่สามารถประมวลผลได้: ${err.message || 'ไม่ทราบสาเหตุ'}`, 7000);
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
      setStatus('พร้อมเมื่อคุณเริ่ม', `เลือก ${MODEL_LABELS[selectedModel()]} · WebGPU ก่อนเมื่อรองรับ`, 'รอ');
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
  $('maskExpand').addEventListener('input', () => $('maskExpandValue').textContent = `${$('maskExpand').value} px`);
  $('maskFeather').addEventListener('input', () => $('maskFeatherValue').textContent = `${$('maskFeather').value} px`);
  $('modelSelect').addEventListener('change', () => {
    const kind = selectedModel();
    $('modelHint').textContent = kind === 'lama' ? 'คุณภาพสูงกว่าในหลายกรณี · โหลดครั้งแรกประมาณ 208 MB · ใช้ภาพ crop 512×512 และอาจช้าบน CPU' : 'โหลดครั้งแรกประมาณ 28 MB · โดยทั่วไปเร็วกว่า แต่เติมพื้นผิว/รายละเอียดสินค้าที่ซับซ้อนได้ไม่ดีเท่าในบางภาพ';
    setStatus('พร้อมเมื่อคุณเริ่ม', `เลือกโมเดล ${MODEL_LABELS[kind]} · ภาพจะอยู่ในเบราว์เซอร์`, 'รอ');
  });
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
