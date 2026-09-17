// สร้างไฟล์ไอคอน PNG สำหรับหน้าจอโฮมของมือถือ (PWA) จากตัวย่อของโรงเรียน
//
// ไอคอนบนแท็บเบราว์เซอร์ (/favicon.svg) สร้างสดจากค่าตั้งค่าได้อยู่แล้ว แต่ PNG สร้างสดไม่ได้เพราะ
// ต้องใช้โปรแกรมวาดรูป (chromium) ซึ่งเซิร์ฟเวอร์ปลายทางอาจไม่มี จึงสร้างไว้ล่วงหน้าแล้ว commit เก็บไว้
//
// วิธีใช้ (รันบนเครื่องที่มี chromium และฟอนต์ไทย):
//   node tools/make-icons.mjs "วส"
// แล้ว commit ไฟล์ public/icon-*.png ที่ได้
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const initials = process.argv[2] || 'สบ';
const BRAND = '#2059c9';

// maskable ต้องเผื่อขอบไว้ให้ระบบปฏิบัติการครอบรูปทรงของตัวเอง (วงกลม/สี่เหลี่ยมมน) โดยไม่กินตัวอักษร
// มาตรฐานกำหนด safe zone ไว้ที่วงกลมรัศมี 40% กลางภาพ ตัวอักษรจึงต้องเล็กลงและไม่มีมุมโค้งของตัวเอง
const page = (size, { maskable = false } = {}) => `<!doctype html><html><head><meta charset="utf-8"><style>
  @font-face { font-family: 'Thai'; src: local('Noto Sans Thai'), local('Loma'), local('Garuda'); }
  html, body { margin: 0; padding: 0; width: ${size}px; height: ${size}px; }
  .box {
    width: ${size}px; height: ${size}px; background: ${BRAND};
    border-radius: ${maskable ? 0 : Math.round(size * 0.22)}px;
    display: flex; align-items: center; justify-content: center;
  }
  .t {
    color: #fff; font-family: 'Noto Sans Thai', 'Loma', 'Garuda', sans-serif; font-weight: 700;
    font-size: ${Math.round(size * (maskable ? 0.30 : 0.42))}px; line-height: 1;
    letter-spacing: ${Math.round(size * 0.01)}px;
  }
</style></head><body><div class="box"><div class="t">${initials}</div></div></body></html>`;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
for (const [file, size, opts] of [
  ['icon-192.png', 192, {}],
  ['icon-512.png', 512, {}],
  ['icon-maskable-512.png', 512, { maskable: true }],
]) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(page(size, opts));
  await p.waitForTimeout(150);
  await p.screenshot({ path: path.join(OUT, file), omitBackground: false });
  await p.close();
  console.log('สร้าง', file, size + 'x' + size, opts.maskable ? '(maskable)' : '');
}
await browser.close();
