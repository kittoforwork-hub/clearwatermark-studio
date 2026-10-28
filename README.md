# ClearMark Studio — CORS-fixed Cloudflare Worker build

เว็บช่วยลบข้อความ/วัตถุจากภาพที่คุณเป็นเจ้าของหรือได้รับอนุญาตให้แก้ไข ใช้ MI-GAN ONNX ในเบราว์เซอร์ ภาพของผู้ใช้ไม่ถูกอัปโหลดไปยัง Worker หรือ API ประมวลผลภาพ

## แก้ปัญหา CORS ที่เจอใน Console

ก่อนหน้านี้หน้าเว็บโหลดโมเดลโดยตรงจาก Hugging Face แล้วเบราว์เซอร์บล็อกการดาวน์โหลดด้วย CORS ทำให้ทั้ง WebGPU และ WASM ล้มเหลว รุ่นนี้เปลี่ยนเป็นโหลดโมเดลจาก URL ของเว็บตัวเอง `/model/migan_pipeline_v2.onnx` ผ่าน `worker.js` ซึ่งจะดึงเฉพาะไฟล์โมเดลจาก Hugging Face ฝั่ง Worker และส่ง stream กลับมา พร้อมแคชโมเดลไว้ที่ edge เมื่อ Cache API ใช้งานได้

**ข้อมูลภาพที่คุณเลือกไม่ถูกส่งไปยัง Hugging Face หรือ Worker** มีเพียงการร้องขอไฟล์โมเดล ~28 MB จาก Worker ไปยัง Hugging Face เท่านั้น การดาวน์โหลดครั้งแรกจึงต้องใช้อินเทอร์เน็ต

## Deploy บน Cloudflare Workers + GitHub

โปรเจกต์นี้เพิ่ม `worker.js` และ `wrangler.jsonc` เพื่อแก้ CORS โดยใช้ Worker proxy แบบ same-origin จึงต้อง Deploy เป็น **Cloudflare Worker ที่มี Static Assets** (ไม่ใช่ Static Pages แบบที่ไม่มี Worker route)

### วิธีแนะนำ: GitHub เชื่อม Cloudflare Workers Builds

1. แตก ZIP และแทนที่ไฟล์โปรเจกต์ใน repository GitHub ด้วยไฟล์จากแพ็กเกจนี้ รวมทั้งไฟล์ที่ขึ้นต้นด้วยจุด เช่น `.assetsignore` และ `.gitignore`.
2. Commit และ push ไปยัง branch `main`.
3. ใน Cloudflare Dashboard เปิด Workers & Pages แล้วเลือก Worker ของ `clearmark-studio` หรือสร้าง Worker ใหม่ที่เชื่อมกับ repository นี้.
4. หากตั้งค่าคำสั่ง Build/Deploy ได้ ให้ใช้:
   - Build command: `npm install`
   - Deploy command: `npm run deploy`
   - Root directory: โฟลเดอร์ที่มี `wrangler.jsonc` อยู่
5. ตรวจว่า Worker ใช้ชื่อ `clearmark-studio` ตาม `wrangler.jsonc` หรือแก้ค่าชื่อในไฟล์ให้ตรงกับ Worker ที่ต้องการ จากนั้น Deploy ใหม่.
6. เปิดเว็บแล้วลอง URL `https://ชื่อ-worker.workers.dev/model/migan_pipeline_v2.onnx` โดยตรง ควรเริ่มดาวน์โหลดไฟล์ ONNX หรือแสดงการตอบกลับ binary (ไม่ใช่ 404). แล้วลองประมวลผลรูปในหน้าเว็บ.

### Deploy จากคอมพิวเตอร์ด้วย Wrangler

ติดตั้ง Node.js LTS ก่อน จากนั้นเปิด Terminal ในโฟลเดอร์โปรเจกต์แล้วรัน:

```bash
npm install
npx wrangler login
npm run deploy
```

หากชื่อ Worker ซ้ำหรือไม่ตรงกับโปรเจกต์ ให้แก้ `name` ใน `wrangler.jsonc` ก่อน Deploy

## เช็กว่า Proxy ทำงานแล้ว

เปิด URL ของ Worker ตามด้วย `/model/migan_pipeline_v2.onnx` ตัวอย่างเช่น `https://clearmark-studio.<บัญชี>.workers.dev/model/migan_pipeline_v2.onnx`:

- ถ้ามีการดาวน์โหลด/ส่งไฟล์ binary ขนาดประมาณ 28 MB แสดงว่า route ใช้ได้.
- ถ้าได้ `404` แสดงว่า Worker ยังไม่ได้ Deploy ด้วย config นี้ หรือไม่ได้สั่งให้ Worker ทำงานกับ `/model/*`.
- ถ้าได้ `502` ดู Worker Logs เพื่อทราบสถานะที่ต้นทาง Hugging Face ส่งกลับมา.
- หลังแก้แล้วกด Ctrl+F5 หรือเปิด Incognito เพื่อหลีกเลี่ยง JavaScript เก่าจาก cache.

## ฟีเจอร์

- เลือกรูป JPG/PNG/WebP ได้ทีละภาพ (จำกัด 20 MB)
- OCR ภาษาอังกฤษบนเบราว์เซอร์ ช่วยเสนอข้อความที่น่าสงสัยตามขอบภาพ
- ระบาย/คืนพื้นที่มาสก์, Undo/Redo, preview ก่อน–หลัง และดาวน์โหลด PNG
- MI-GAN ONNX ผ่าน ONNX Runtime Web; เลือก WebGPU ก่อนและลอง WASM/CPU หากเริ่มต้น WebGPU ไม่สำเร็จ
- model proxy จำกัดไว้ที่ไฟล์ MI-GAN เท่านั้น ไม่ใช่ open proxy

## ข้อจำกัด

1. OCR ไม่ใช่ตัวตรวจจับลายน้ำโดยตรง อาจพลาดลายน้ำโลโก้/ลายน้ำกลางภาพ หรือเลือกข้อความสินค้าผิด ต้องตรวจสีแดงก่อนประมวลผล.
2. Inpainting สร้างรายละเอียดขึ้นใหม่ ไม่ได้กู้พิกเซลที่ถูกทับกลับมาได้เหมือนเดิม โปรดระวังเลขรุ่น โลโก้ สเกล และเครื่องหมายรับรอง.
3. ครั้งแรกต้องโหลดโมเดล ~28 MB และไลบรารี OCR/ONNX Runtime ผ่านอินเทอร์เน็ต แต่ภาพของคุณอยู่ในเบราว์เซอร์.
4. Worker proxy เพิ่มหนึ่ง Worker request ต่อการดาวน์โหลดโมเดลที่ไม่อยู่ใน edge cache และยังอยู่ภายใต้ quota/ข้อกำหนดของ Cloudflare Free plan ไม่มีการเรียก paid AI API. หากการใช้งานเกิน quota ของแผน อาจต้องรอ quota รีเซ็ตหรือปรับแผน.
5. `Unknown CPU vendor` จาก ONNX Runtime โดยทั่วไปเป็น log เตือนด้านการตรวจ CPU ไม่ใช่เหตุ CORS ที่ทำให้ดาวน์โหลดโมเดลล้มเหลว.
6. หากเห็น `favicon.ico 404` จะหายเมื่อ browser ใช้ `favicon.svg` ที่เพิ่มในรุ่นนี้; ถ้ามี request เก่าจาก cache ให้ hard refresh.

## Dependencies / License

- MI-GAN ONNX: [edgetools/migan](https://huggingface.co/edgetools/migan), model card ระบุ MIT; ไฟล์ต้นแบบจาก MI-GAN/Picsart AI Research.
- ONNX Runtime Web: [Microsoft ONNX Runtime](https://github.com/microsoft/onnxruntime)
- Tesseract.js: [Tesseract.js](https://github.com/naptha/tesseract.js)
- Wrangler: [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/)

ใช้ภาพที่เป็นเจ้าของหรือได้รับอนุญาตให้แก้ไข และตรวจผลลัพธ์ก่อนนำไปเผยแพร่เชิงพาณิชย์
