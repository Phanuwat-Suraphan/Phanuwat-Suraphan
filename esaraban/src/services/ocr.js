import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { httpError } from './workflow.js';

// Render free tier (และโฮสต์ฟรีอื่นๆ) มี CPU จำกัดมาก — ไฟล์แค่ 1-2MB ก็ทำให้ pdftoppm ใช้เวลาเกิน
// 30 วินาทีได้จริงถ้าเครื่องกำลัง cold start/แชร์ CPU กับ process อื่น ไม่ใช่เพราะไฟล์ใหญ่/ซับซ้อนเสมอไป
// ขยับเป็น 45 วินาทีให้พอมีเวลาหายใจ
const RUN_TIMEOUT_MS = 45_000;

// เรียกโปรแกรมระบบ (pdftoppm/tesseract) — เป็น system package ผ่าน apt ไม่ใช่ npm dependency
// จึงยังอยู่ในกติกา zero-dependency ของโปรเจกต์นี้ ต้องติดตั้งบนเซิร์ฟเวอร์ก่อนใช้งาน (ดู DEPLOY.md)
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
        reject(httpError(501, `ไม่พบโปรแกรม "${cmd}" บนเซิร์ฟเวอร์ — ต้องติดตั้ง tesseract-ocr, tesseract-ocr-tha และ poppler-utils ก่อนใช้ฟีเจอร์นี้ (ดูขั้นตอนใน DEPLOY.md)`));
      } else reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
      else resolve(stdout);
    });
  });
}

// อ่านข้อความจาก PDF ด้วย OCR (เฉพาะ 2 หน้าแรก — ข้อมูลสำคัญของหนังสือราชการมักอยู่หน้าแรกเสมอ)
export async function extractTextFromPdf(pdfBuffer) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esaraban-ocr-'));
  const pdfPath = path.join(tmpDir, 'input.pdf');
  const imgPrefix = path.join(tmpDir, 'page');
  try {
    fs.writeFileSync(pdfPath, pdfBuffer);
    // ลดจาก 200 เป็น 150 DPI — เร็วขึ้นชัดเจนบนโฮสต์ฟรีที่ CPU จำกัด ยังคมพอสำหรับ Tesseract อ่านตัวพิมพ์
    // ทั่วไปได้ (นี่เป็น best-effort ที่บังคับให้ผู้ใช้ตรวจซ้ำอยู่แล้ว ไม่ใช่ผลลัพธ์สุดท้าย)
    await run('pdftoppm', ['-png', '-r', '150', '-f', '1', '-l', '2', pdfPath, imgPrefix]);
    const images = fs.readdirSync(tmpDir).filter((f) => f.startsWith('page') && f.endsWith('.png')).sort();
    if (!images.length) throw httpError(422, 'ไม่สามารถแปลง PDF เป็นภาพเพื่ออ่านได้ (ไฟล์อาจเสียหายหรือเข้ารหัสไว้)');

    let text = '';
    for (const img of images) {
      text += await run('tesseract', [path.join(tmpDir, img), 'stdout', '-l', 'tha+eng']);
      text += '\n';
    }
    return text;
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// เรนเดอร์หน้าแรกของ PDF เป็นภาพ PNG — ใช้เป็นพื้นหลังกล่องลากตำแหน่งตราประทับ/ลายเซ็นแทนการฝัง PDF
// ตรงๆ ผ่าน <iframe> เพราะเบราว์เซอร์/เว็บวิวหลายตัว (โดยเฉพาะที่ตั้งค่า "ดาวน์โหลด PDF แทนการเปิดดู"
// หรือเว็บวิวในแอป) ไม่แสดง PDF ที่ฝังใน iframe เลย ทำให้กล่องลากดูเหมือนพื้นที่ว่างเปล่า/ไอคอนพัง — ภาพ PNG
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

const THAI_MONTHS = {
  'มกราคม': 1, 'กุมภาพันธ์': 2, 'มีนาคม': 3, 'เมษายน': 4, 'พฤษภาคม': 5, 'มิถุนายน': 6,
  'กรกฎาคม': 7, 'สิงหาคม': 8, 'กันยายน': 9, 'ตุลาคม': 10, 'พฤศจิกายน': 11, 'ธันวาคม': 12,
};
const THAI_DIGITS = { '๐': '0', '๑': '1', '๒': '2', '๓': '3', '๔': '4', '๕': '5', '๖': '6', '๗': '7', '๘': '8', '๙': '9' };

function toArabicDigits(s) {
  return s.replace(/[๐-๙]/g, (d) => THAI_DIGITS[d]);
}

// แปลง "๑๒ มกราคม ๒๕๖๘" หรือ "12 มกราคม 2568" -> "2025-01-12" (ค.ศ.) — คืนค่า null ถ้าแปลงไม่ได้ ต้องให้ผู้ใช้กรอกเองแทนการเดาผิด
export function parseThaiDate(str) {
  if (!str) return null;
  const normalized = toArabicDigits(str);
  const monthPattern = Object.keys(THAI_MONTHS).join('|');
  const m = normalized.match(new RegExp(`(\\d{1,2})\\s*(${monthPattern})\\s*(\\d{4})`));
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = THAI_MONTHS[m[2]];
  let yearBe = parseInt(m[3], 10);
  if (day < 1 || day > 31) return null;
  const yearAd = yearBe > 2400 ? yearBe - 543 : yearBe; // เผื่อกรณี OCR อ่านเป็น ค.ศ. อยู่แล้ว
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yearAd}-${mm}-${dd}`;
}

// เดาฟิลด์จากข้อความ OCR ด้วยการจับรูปแบบพื้นฐาน — เป็นการเดาแบบ best-effort เท่านั้น
// ผู้ใช้ต้องตรวจสอบ/แก้ไขก่อนบันทึกเสมอ (ความแม่นยำของ OCR ภาษาไทยยังจำกัด โดยเฉพาะเอกสารที่มีตราประทับ/ลายมือ)
export function guessFieldsFromText(text) {
  const guess = { rawText: text.trim().slice(0, 3000) };

  const numMatch = text.match(/(?:ที่|เลขที่)\s*([ก-๙A-Za-z0-9./\-\s]{2,40}?)(?:\n|เรื่อง|วันที่|$)/);
  if (numMatch) guess.externalDocNumber = numMatch[1].trim();

  const dateMatch = text.match(/วันที่\s*([๐-๙0-9]{1,2}\s*[ก-๙]{4,15}\s*[๐-๙0-9]{4})/);
  if (dateMatch) {
    guess.externalDocDateRaw = dateMatch[1].trim();
    guess.externalDocDate = parseThaiDate(dateMatch[1]);
  }

  const subjMatch = text.match(/เรื่อง\s*[:：]?\s*([^\n]{3,150})/);
  if (subjMatch) guess.title = subjMatch[1].trim();

  const fromMatch = text.match(/(?:เรียน|จาก)\s*[:：]?\s*([^\n]{2,100})/);
  if (fromMatch) guess.correspondentName = fromMatch[1].trim();

  return guess;
}
