# ใช้เมื่อต้องการให้ปุ่ม "อ่านข้อมูลจากไฟล์อัตโนมัติ (OCR)" ทำงานได้บน Render (หรือ container
# host อื่นๆ) — runtime แบบ Node ธรรมดาของ Render ไม่อนุญาตให้ apt install โปรแกรมระบบ
# (tesseract/poppler-utils) จึงต้องสร้าง image เองแบบนี้แทน ดูขั้นตอนเชื่อมกับ Render ใน
# deploy/RENDER.md หัวข้อ "ให้ OCR ทำงานบน Render ได้จริง (deploy แบบ Docker)"
#
# แอปนี้ไม่มี npm dependency เลย (ดู package.json) จึงไม่ต้อง COPY package-lock.json /
# npm ci — คัดลอกซอร์สแล้วรันได้ทันที
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    tesseract-ocr \
    tesseract-ocr-tha \
    poppler-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

EXPOSE 3000
CMD ["node", "--no-warnings", "server.js"]
