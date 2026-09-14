// เรนเดอร์หน้าแรกของ PDF เป็นภาพ สำหรับหน้า "ดูตัวอย่าง" ของไฟล์แนบ
//
// ไฟล์นี้เคยชื่อ ocr.js และมีฟีเจอร์ "อ่านข้อมูลจากไฟล์อัตโนมัติ" ด้วย Tesseract OCR อยู่ด้วย
// ถอดออกแล้วตามที่โรงเรียนแจ้งว่าใช้งานจริงไม่ได้ — หนังสือราชการที่สแกนมาส่วนใหญ่เอียง/ความคมชัดต่ำ/
// มีตราครุฑกับลายเซ็นทับข้อความ OCR จึงเดาเลขที่และวันที่ผิดบ่อยกว่าถูก ธุรการต้องมานั่งตรวจแก้ทุกช่อง
// ซึ่งช้ากว่าพิมพ์เองตั้งแต่แรก และการมีปุ่มที่ผลลัพธ์เชื่อถือไม่ได้อยู่ในหน้าจอทำให้คนเผลอเชื่อแล้วบันทึกผิด
//
// เหลือไว้เฉพาะการทำภาพตัวอย่าง ซึ่งใช้ pdftoppm (poppler-utils) อย่างเดียว ไม่ต้องใช้ tesseract แล้ว
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { httpError } from './workflow.js';

// Render free tier (และโฮสต์ฟรีอื่นๆ) มี CPU จำกัดมาก — ไฟล์แค่ 1-2MB ก็ทำให้ pdftoppm ใช้เวลาเกิน
// 30 วินาทีได้จริงถ้าเครื่องกำลัง cold start/แชร์ CPU กับ process อื่น ไม่ใช่เพราะไฟล์ใหญ่/ซับซ้อนเสมอไป
const RUN_TIMEOUT_MS = 45_000;

// เรียกโปรแกรมระบบ (pdftoppm) — เป็น system package ผ่าน apt ไม่ใช่ npm dependency จึงยังอยู่ในกติกา
// zero-dependency ของโปรเจกต์นี้ ต้องติดตั้งบนเซิร์ฟเวอร์ก่อนใช้งาน (ดู DEPLOY.md)
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(httpError(504, `${cmd} ใช้เวลานานเกินไป (เกิน ${RUN_TIMEOUT_MS / 1000} วินาที) — ไฟล์อาจมีขนาดใหญ่หรือซับซ้อนเกินไป`));
    }, RUN_TIMEOUT_MS);
    proc.stdout.on('data', (d) => { stdout += d; });
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(httpError(501, `ไม่พบโปรแกรม "${cmd}" บนเซิร์ฟเวอร์ — ต้องติดตั้ง poppler-utils ก่อนใช้ฟีเจอร์นี้ (ดูขั้นตอนใน DEPLOY.md)`));
      } else reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

// เรนเดอร์หน้าแรกของ PDF เป็นภาพ PNG — ใช้เป็นพื้นหลังหน้าดูตัวอย่างตำแหน่งตราประทับ/ลายเซ็น แทนการฝัง
// PDF ตรงๆ ผ่าน <iframe> เพราะเบราว์เซอร์/เว็บวิวหลายตัว (โดยเฉพาะที่ตั้งค่า "ดาวน์โหลด PDF แทนการเปิดดู"
// หรือเว็บวิวในแอป) ไม่แสดง PDF ที่ฝังใน iframe เลย ทำให้ดูเหมือนพื้นที่ว่างเปล่า/ไอคอนพัง — ภาพ PNG
// ธรรมดาแสดงได้แน่นอนในทุกเบราว์เซอร์
export async function renderPdfFirstPageImage(pdfBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esaraban-preview-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  const imgPrefix = path.join(tmpDir, 'page');
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    await run('pdftoppm', ['-png', '-r', '120', '-f', '1', '-l', '1', pdfPath, imgPrefix]);
    const images = fs.readdirSync(tmpDir).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
    if (!images.length) throw httpError(422, 'ไม่สามารถแปลง PDF เป็นภาพเพื่อแสดงตัวอย่างได้ (ไฟล์อาจเสียหายหรือเข้ารหัสไว้)');
    return fs.readFileSync(path.join(tmpDir, images[0]));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
