import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// httpError คัดลอกไว้ในไฟล์นี้เอง (ไม่ import จาก workflow.js) — เหตุผลเดียวกับ googleDrive.js/ocr.js
export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

const RUN_TIMEOUT_MS = 45_000;
const PAGE_WIDTH_PT = 595; // A4
const PAGE_HEIGHT_PT = 842;
// ปรับได้ผ่าน env var เผื่อ distro ตั้งชื่อไบนารีต่างกัน (Debian มักชื่อ "chromium", Ubuntu เก่าบางรุ่น
// "chromium-browser") — ดูขั้นตอนติดตั้งใน DEPLOY.md
const CHROME_BIN = process.env.CHROME_BIN || 'chromium';

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// เรียกโปรแกรมระบบ (chromium/qpdf) — เป็น system package ผ่าน apt ไม่ใช่ npm dependency จึงยังอยู่ใน
// กติกา zero-dependency ของโปรเจกต์นี้ (แนวทางเดียวกับ tesseract/poppler-utils ใน ocr.js) ต้องติดตั้ง
// บนเซิร์ฟเวอร์ก่อนใช้งาน (ดู DEPLOY.md)
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(httpError(504, `${cmd} ใช้เวลานานเกินไป (เกิน ${RUN_TIMEOUT_MS / 1000} วินาที)`));
    }, RUN_TIMEOUT_MS);
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(httpError(501, `ไม่พบโปรแกรม "${cmd}" บนเซิร์ฟเวอร์ — ต้องติดตั้ง chromium และ qpdf ก่อนใช้ฟีเจอร์ประทับตราลงในไฟล์ PDF จริง (ดูขั้นตอนใน DEPLOY.md)`));
      } else reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
      else resolve();
    });
  });
}

// ซ้อน HTML กล่องหนึ่งกล่อง (ตราประทับ/กล่องลงนาม) ทับหน้าแรกของ PDF จริง — ใช้ร่วมกันทั้ง stampPdf
// (ตรา "ลงรับ" ของธุรการ) และ stampDirectorDecision (กล่องความเห็น/ลงนามของผู้อำนวยการ) สองขั้นตอน:
// 1) render กล่อง HTML เป็น PDF หน้าเดียวด้วย headless Chromium (รองรับภาษาไทยถูกต้อง ต่างจากการ
//    เขียน PDF content stream เองที่ต้องฝัง font ภาษาไทยเอง ซับซ้อนและเสี่ยงผิดพลาดมาก)
// 2) ซ้อนหน้านั้นทับหน้าแรกของ PDF เดิมด้วย qpdf --overlay (แก้แค่หน้า 1 เท่านั้น หน้าอื่นไม่แตะ)
// เรียกซ้ำได้หลายรอบ (เช่น ธุรการประทับตรารับก่อน แล้ว ผอ. ลงนามทีหลัง) เพราะรับ "ไฟล์เดิม" เป็น input
// ทุกครั้ง แล้ว output ออกมาเป็นไฟล์ใหม่ที่มีกล่องเดิม + กล่องใหม่ซ้อนกันอยู่ — ไฟล์ที่ส่งเข้ามา
// (originalBuffer) ไม่ถูกแก้ไข ฟังก์ชันนี้คืนค่าเป็น buffer ของไฟล์ใหม่เท่านั้น
async function overlayHtmlOnFirstPage(originalBuffer, html) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esaraban-stamp-'));
  const originalPath = path.join(tmpDir, 'original.pdf');
  const stampHtmlPath = path.join(tmpDir, 'stamp.html');
  const stampPdfPath = path.join(tmpDir, 'stamp.pdf');
  const outputPath = path.join(tmpDir, 'output.pdf');
  try {
    fs.writeFileSync(originalPath, originalBuffer);
    fs.writeFileSync(stampHtmlPath, html);

    await run(CHROME_BIN, ['--headless', '--disable-gpu', '--no-sandbox', `--print-to-pdf=${stampPdfPath}`, '--print-to-pdf-no-header', stampHtmlPath]);
    if (!fs.existsSync(stampPdfPath)) throw httpError(500, 'สร้างภาพตราประทับไม่สำเร็จ');

    // --to=1 จำกัดให้ทับแค่หน้า 1 ของ original เท่านั้น (อ้างอิงเอกสาร qpdf --help=overlay-underlay)
    await run('qpdf', [originalPath, '--overlay', stampPdfPath, '--to=1', '--', outputPath]);
    if (!fs.existsSync(outputPath)) throw httpError(500, 'รวมตราประทับเข้ากับ PDF ไม่สำเร็จ');

    return fs.readFileSync(outputPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ตรา "ลงรับ" ของธุรการ — อ้างอิงรูปแบบตรายางจริงของโรงเรียน (มุมขวาบน กรอบสี่เหลี่ยม 3 บรรทัด:
// เลขรับ/วันที่/เวลา) ลากตำแหน่งเองได้ผ่าน stamp_x/stamp_y ก่อนกดปุ่มนี้
export async function stampPdf({ originalBuffer, schoolName, docNumberDisplay, dateThaiLong, timeStr, xPercent, yPercent }) {
  const leftPt = Math.max(0, Math.min(96, xPercent ?? 70)) / 100 * PAGE_WIDTH_PT;
  const topPt = Math.max(0, Math.min(96, yPercent ?? 3)) / 100 * PAGE_HEIGHT_PT;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .stamp { position: absolute; left: ${leftPt}pt; top: ${topPt}pt; width: 150pt; border: 2px solid #2222aa; color: #2222aa; padding: 6pt; font-size: 8pt; line-height: 1.5; border-radius: 4pt; }
    .stamp .title { font-weight: 700; text-align: center; padding-bottom: 3pt; margin-bottom: 3pt; }
  </style></head><body>
    <div class="stamp">
      <div class="title">${esc(schoolName)}</div>
      <div>เลขรับ......${esc(docNumberDisplay)}......</div>
      <div>วันที่......${esc(dateThaiLong)}......</div>
      <div>เวลา......${esc(timeStr)}......</div>
    </div>
  </body></html>`;
  return overlayHtmlOnFirstPage(originalBuffer, html);
}

// เครื่องหมาย "ทราบ" + ลายเซ็นแบบง่าย ไม่มีกรอบ — เลียนแบบวิธีที่คนจริงเขียน "ทราบ" ด้วยลายมือแล้วเซ็นชื่อ
// ต่อท้ายบนที่ว่างของเอกสาร (ต่างจาก stampDirectorDecision ที่เป็นกล่องความเห็นทางการของผู้ตัดสินใจคนสุดท้าย)
// ใช้กับทุกคนในสาย workflow ที่ "เห็น" เอกสารนี้แล้ว (อนุมัติ/ส่งต่อ/รับทราบ/ไม่อนุมัติ) — มีกี่คนก็ประทับ
// ได้กี่ครั้ง เพราะแต่ละครั้งซ้อนทับไฟล์ล่าสุดที่มีเครื่องหมายของคนก่อนหน้าอยู่แล้ว (ดู overlayHtmlOnFirstPage)
export async function stampAcknowledgeMark({ originalBuffer, signatureDataUrl, prefix, firstName, lastName, dateThaiLong, xPercent, yPercent, actingForLabel }) {
  const leftPt = Math.max(0, Math.min(90, xPercent ?? 8)) / 100 * PAGE_WIDTH_PT;
  const topPt = Math.max(0, Math.min(94, yPercent ?? 55)) / 100 * PAGE_HEIGHT_PT;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .mark { position: absolute; left: ${leftPt}pt; top: ${topPt}pt; width: 130pt; color: #2222aa; text-align: center; }
    .mark .word { font-size: 20pt; font-weight: 700; margin-bottom: 2pt; }
    .mark img { max-height: 30pt; max-width: 110pt; }
    .mark .name { font-size: 7pt; margin-top: 1pt; }
    .mark .acting { font-size: 6.5pt; font-style: italic; }
  </style></head><body>
    <div class="mark">
      <div class="word">ทราบ</div>
      ${signatureDataUrl ? `<img src="${esc(signatureDataUrl)}" />` : ''}
      <div class="name">(${esc(prefix || '')}${esc(firstName)} ${esc(lastName)})</div>
      ${actingForLabel ? `<div class="acting">รักษาการแทน${esc(actingForLabel)}</div>` : ''}
      <div class="name">${esc(dateThaiLong)}</div>
    </div>
  </body></html>`;
  return overlayHtmlOnFirstPage(originalBuffer, html);
}

// กล่องความเห็น/ลงนามของผู้ตัดสินใจคนสุดท้าย (มักเป็นผู้อำนวยการ) — อ้างอิงรูปแบบตรายางจริงของโรงเรียน
// (มุมขวาล่าง กรอบสี่เหลี่ยม: ชื่อตำแหน่ง + checkbox ทราบ/อนุญาต-ไม่อนุญาต/อนุมัติ-ไม่อนุมัติ +
// "เห็นควรให้..." + ลายเซ็น + ชื่อ-ตำแหน่ง) — decision: 'acknowledge' | 'approve' | 'reject' ตรงกับปุ่ม
// รับทราบ/อนุมัติและส่งต่อ/ไม่อนุมัติ ในหน้าเอกสาร — note คือข้อความที่ผู้ใช้พิมพ์เองในช่อง "เห็นควรให้"
// titleMode อ้างอิงตรายางจริง 2 แบบของโรงเรียน (ดูภาพถ่ายใน docs/stamp-reference/) — ตรายางจริงพิมพ์
// หัว/ท้ายกล่องต่างกันตามว่าใครเป็นผู้เซ็น: 'director' = ผู้อำนวยการตัวจริง (หัวกล่อง "ผู้อำนวยการ<ชื่อ
// โรงเรียน>" บรรทัดเดียว), 'acting_director' = ผู้รักษาการแทนผู้อำนวยการ (หัวกล่อง "รักษาการในตำแหน่ง
// ผู้อำนวยการสถานศึกษา" 2 บรรทัด — คำนี้ห้ามใช้ผิดกับ "รักษาการในตำแหน่ง" เฉยๆ เพราะเป็นถ้อยคำทางการที่
// ตรายางจริงใช้), 'generic' = ผู้ตัดสินใจปิดเรื่องที่ไม่ใช่ผู้อำนวยการ/ผู้รักษาการแทนผู้อำนวยการ (เช่น
// หัวหน้าฝ่ายปิดเรื่องเอง) ใช้ตำแหน่งจริงของคนนั้นตรงๆ แทนคำที่ตายตัว
export async function stampDirectorDecision({ originalBuffer, schoolName, decision, note, marks, signatureDataUrl, prefix, firstName, lastName, position, titleMode, actingForLabel, dateThaiLong, xPercent, yPercent }) {
  // marks: รายการเครื่องหมายที่ผู้ตัดสินใจติ๊กเลือกเอง ('ทราบ'/'อนุญาต'/'ไม่อนุญาต'/'อนุมัติ'/'ไม่อนุมัติ')
  // เลือกได้หลายอันพร้อมกัน ไม่ผูกกับ decision (ซึ่งเป็นแค่ปุ่ม workflow ที่กดปิด/ส่งกลับเรื่อง) — ค่านี้มา
  // จากช่อง checkbox จริงในหน้าเว็บ กรองค่าที่ไม่รู้จักไว้แล้วที่ documents.js (parseDecisionMarks)
  const marked = new Set(marks || []);
  const mark = (label) => (marked.has(label) ? '●' : '○');
  // ค่าเริ่มต้นชิดมุมขวาบนของหน้า (ใต้ตราประทับ "ลงรับ" ที่อยู่มุมขวาบนสุดพอดี) ตามที่ตราจริงของ
  // โรงเรียนใช้ตำแหน่งนี้ — ผู้ใช้ยังลากปรับตำแหน่งเองได้ก่อนกดปุ่มตามปกติ
  const leftPt = Math.max(0, Math.min(80, xPercent ?? 58)) / 100 * PAGE_WIDTH_PT;
  const topPt = Math.max(0, Math.min(88, yPercent ?? 20)) / 100 * PAGE_HEIGHT_PT;

  let titleHtml, positionHtml;
  if (titleMode === 'director') {
    titleHtml = `ผู้อำนวยการ${esc(schoolName)}`;
    positionHtml = `<div class="name">ตำแหน่งผู้อำนวยการ${esc(schoolName)}</div>`;
  } else if (titleMode === 'acting_director') {
    titleHtml = `รักษาการในตำแหน่งผู้อำนวยการสถานศึกษา<br/>${esc(schoolName)}`;
    positionHtml = `<div class="name">รักษาการในตำแหน่งผู้อำนวยการสถานศึกษา</div><div class="name">${esc(schoolName)}</div>`;
  } else {
    titleHtml = esc(schoolName);
    positionHtml = `<div class="name">${esc(position || '')}</div>`;
  }
  // ถ้อยคำบนตรายางจริงไม่ได้ระบุว่ารักษาการแทน "ใคร" — ระบบเสริมบรรทัดเล็กๆ นี้เพิ่มเพื่อความโปร่งใส
  // (ตรวจสอบย้อนหลังได้ว่าใครเซ็นแทนใคร) โดยไม่ไปแก้ถ้อยคำทางการของตรายางที่ใช้จริง
  if (actingForLabel) positionHtml += `<div class="name" style="font-size:6.5pt;font-style:italic">(รักษาการแทน${esc(actingForLabel)})</div>`;

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .box { position: absolute; left: ${leftPt}pt; top: ${topPt}pt; width: 190pt; border: 2px solid #2222aa; color: #2222aa; padding: 7pt; font-size: 8pt; line-height: 1.55; border-radius: 4pt; }
    .box .title { font-weight: 700; text-align: center; margin-bottom: 4pt; }
    .box .note { margin: 3pt 0; word-break: break-word; }
    .box .sig { text-align: center; margin-top: 4pt; }
    .box .sig img { max-height: 34pt; max-width: 110pt; }
    .box .name { text-align: center; }
  </style></head><body>
    <div class="box">
      <div class="title">${titleHtml}</div>
      <div>${mark('ทราบ')} ทราบ &nbsp; ${mark('อนุญาต')} อนุญาต &nbsp; ${mark('ไม่อนุญาต')} ไม่อนุญาต</div>
      <div>${mark('อนุมัติ')} อนุมัติ &nbsp; ${mark('ไม่อนุมัติ')} ไม่อนุมัติ</div>
      <div class="note">เห็นควรให้ ${esc(note || '-')}</div>
      ${signatureDataUrl ? `<div class="sig"><img src="${esc(signatureDataUrl)}" /></div>` : ''}
      <div class="name">(${esc(prefix || '')}${esc(firstName)} ${esc(lastName)})</div>
      ${positionHtml}
      <div class="name">${esc(dateThaiLong)}</div>
    </div>
  </body></html>`;
  return overlayHtmlOnFirstPage(originalBuffer, html);
}
