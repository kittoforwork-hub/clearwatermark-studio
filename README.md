# ClearMark Studio — CORS-fixed Cloudflare Worker build

เว็บช่วยลบข้อความ/วัตถุจากภาพที่คุณเป็นเจ้าของหรือได้รับอนุญาตให้แก้ไข ใช้ MI-GAN ONNX ในเบราว์เซอร์ ภาพของผู้ใช้ไม่ถูกอัปโหลดไปยัง Worker หรือ API ประมวลผลภาพ

## แก้ปัญหา CORS ที่เจอใน Console

หน้าเว็บโหลดโมเดลจาก URL ของเว็บตัวเอง `/model/migan_pipeline_v2.onnx` ผ่าน `worker.js` ซึ่งจะดึงเฉพาะไฟล์โมเดลจาก Hugging Face ฝั่ง Worker และพยายามแคชโมเดลไว้ที่ edge เมื่อ Cache API ใช้งานได้ ข้อมูลภาพที่คุณเลือกประมวลผลอยู่ในเบราว์เซอร์และไม่ได้ส่งไป Hugging Face หรือ Worker

## แก้ปัญหา Workers asset เกิน 25 MiB

ไฟล์ Static Assets ต้องอยู่ใน `public/` เท่านั้น ห้ามตั้ง `assets.directory` เป็น `.` เพราะจะรวม `node_modules` และไฟล์ Worker เข้าไปในชุด Static Assets ซึ่งอาจทำให้ Deploy ล้มเหลวจากไฟล์ `workerd` ขนาดใหญ่

โครงสร้างที่ถูกต้อง:

```text
ai-watermark-remover/
├── public/
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── favicon.ico
│   └── favicon.svg
├── worker.js
├── wrangler.jsonc
├── package.json
├── .gitignore
└── LICENSE
```

ใน `wrangler.jsonc` ตั้ง `assets.directory` เป็น `./public/` และเก็บ `worker.js` ไว้ที่ Root

## Deploy บน Cloudflare Workers + GitHub

1. แตก ZIP แล้วนำไฟล์และโฟลเดอร์ทั้งหมดจากโฟลเดอร์ `ai-watermark-remover` ไปไว้ที่ Root ของ GitHub Repository (ให้เห็น `wrangler.jsonc`, `worker.js`, `package.json` และโฟลเดอร์ `public/` อยู่ระดับเดียวกัน)
2. Commit และ push ไปยัง branch `main`.
3. ใน Cloudflare Dashboard เปิด Workers & Pages แล้วเลือก Worker ของ `clearmark-studio` หรือสร้าง Worker ที่เชื่อมกับ repository นี้.
4. ตั้งค่าการ Build/Deploy:
   - Build command: `npm install`
   - Deploy command: `npm run deploy` (หรือ `npx wrangler deploy`)
   - Root directory: โฟลเดอร์ที่มี `wrangler.jsonc` อยู่
5. อย่าตั้ง Static Assets directory เป็น `.` ใน Dashboard ให้ `wrangler.jsonc` เป็นแหล่ง config ตามโปรเจกต์นี้
6. Deploy ใหม่ แล้วเปิด `https://ชื่อ-worker.workers.dev/model/migan_pipeline_v2.onnx` ควรเริ่มดาวน์โหลดไฟล์โมเดลหรือได้ response แบบ binary ไม่ใช่ 404

### Deploy จากเครื่องด้วย Wrangler

ติดตั้ง Node.js LTS ก่อน จากนั้นเปิด Terminal ใน Root ของโปรเจกต์แล้วรัน:

```bash
npm install
npx wrangler login
npm run deploy
```

หากชื่อ Worker ซ้ำหรือไม่ตรงกับโปรเจกต์ ให้แก้ `name` ใน `wrangler.jsonc` ก่อน Deploy

## ตรวจสอบหลัง Deploy

- ถ้า URL `/model/migan_pipeline_v2.onnx` ดาวน์โหลดไฟล์โมเดลขนาดประมาณ 28 MB ได้ แสดงว่า route ทำงาน
- ถ้าได้ `404` ให้ตรวจว่ามี Worker deploy จาก config นี้และตั้ง `run_worker_first` สำหรับ `/model/*`
- ถ้าได้ `502` ให้ดู Worker Logs เพื่อดูสถานะจาก Hugging Face
- หลัง deploy ให้กด Ctrl+F5 หรือเปิดหน้าต่าง Incognito เพื่อล้าง JavaScript เก่าจาก cache

## ฟีเจอร์

- เลือกรูป JPG/PNG/WebP ได้ทีละภาพ (จำกัดขนาดตามที่ระบุใน UI)
- OCR ภาษาอังกฤษในเบราว์เซอร์ช่วยเสนอข้อความน่าสงสัยบริเวณขอบภาพ
- ระบาย/คืนพื้นที่มาสก์, Undo/Redo, preview ก่อน–หลัง และดาวน์โหลด PNG
- MI-GAN ONNX ผ่าน ONNX Runtime Web; เลือก WebGPU ก่อนและลอง WASM หากเริ่มต้น WebGPU ไม่สำเร็จ
- Worker proxy จำกัดไว้ที่ไฟล์ MI-GAN เท่านั้น ไม่ใช่ open proxy

## ข้อจำกัด

1. OCR ไม่ใช่ตัวตรวจจับลายน้ำโดยตรง อาจพลาดลายน้ำโลโก้/ลายน้ำกลางภาพ หรือเลือกข้อความสินค้าผิด ต้องตรวจมาสก์ก่อนประมวลผล
2. Inpainting สร้างรายละเอียดขึ้นใหม่ ไม่ได้กู้พิกเซลที่ถูกทับมาเหมือนเดิม โปรดระวังเลขรุ่น โลโก้ สเกล และเครื่องหมายรับรอง
3. ครั้งแรกต้องโหลดโมเดลประมาณ 28 MB และไลบรารี OCR/ONNX Runtime ผ่านอินเทอร์เน็ต แต่ภาพของคุณอยู่ในเบราว์เซอร์
4. Worker proxy ใช้โควตาของ Cloudflare Workers Free plan และอาจต้องดาวน์โหลดโมเดลจากต้นทางครั้งแรก
5. `Unknown CPU vendor` จาก ONNX Runtime เป็นคำเตือนแยกต่างหาก ไม่ใช่สาเหตุ CORS
6. มี `favicon.ico` และ `favicon.svg` ใน `public/` เพื่อลด error 404 จาก favicon

## Dependencies / License

- MI-GAN ONNX: [edgetools/migan](https://huggingface.co/edgetools/migan), model card ระบุ MIT; ตรวจใบอนุญาตต้นทางก่อนใช้งานเชิงพาณิชย์
- ONNX Runtime Web: [Microsoft ONNX Runtime](https://github.com/microsoft/onnxruntime)
- Tesseract.js: [Tesseract.js](https://github.com/naptha/tesseract.js)
- Wrangler: [Cloudflare Wrangler](https://developers.cloudflare.com/workers/wrangler/)

ใช้ภาพที่เป็นเจ้าของหรือได้รับอนุญาตให้แก้ไข และตรวจผลลัพธ์ก่อนนำไปเผยแพร่เชิงพาณิชย์
