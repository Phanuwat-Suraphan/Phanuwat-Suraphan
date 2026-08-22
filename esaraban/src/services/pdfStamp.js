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
// เพดานตำแหน่งบนสุดของกล่องความเห็น ผอ. (ดูเหตุผลใน stampDirectorDecision) — export ให้ฝั่ง
// route/ตัวอย่างบนเว็บใช้ค่าเดียวกัน จะได้ไม่ลากไปวางในตำแหน่งที่ประทับจริงแล้วข้อมูลหาย
export const DECISION_MAX_TOP_PERCENT = 72;

// แถบล่างของเอกสารเรียงกัน 3 ช่องตามที่โรงเรียนขอ ขอบบนตรงกันทั้งสามช่อง (= DECISION_MAX_TOP_PERCENT):
//
//   [ ความเห็นธุรการ ]   [ ทราบ ]   [ กรอบตราปั๊ม ผอ. ]
//       ซ้ายล่าง           กลาง           ขวาล่าง
//
// "ความเห็นธุรการอยู่ซ้ายล่าง ผอ. ขวาล่าง และเซ็นทราบอยู่ข้างตราปั๊ม ผอ."
// กล่อง ผอ. อยู่มุมขวาล่างตามตรายางจริง ส่วนตรา "ทราบ" (ลายเซ็นของผู้ได้รับเอกสาร) แทรกอยู่ระหว่างกลาง
// ทั้งสามช่องยังลากย้ายตำแหน่งเองได้ก่อนกดปุ่มตามปกติ ค่าพวกนี้เป็นแค่ตำแหน่งตั้งต้น
export const DECISION_BOX_WIDTH_PT = 190;
export const REGISTRAR_BOX_WIDTH_PT = 190;
export const ACK_MARK_WIDTH_PT = 112;
export const DEFAULT_REGISTRAR_X_PERCENT = 2;
export const DEFAULT_ACK_MARK_X_PERCENT = 36;
export const DEFAULT_DECISION_X_PERCENT = 58;

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

// นับจำนวนหน้าของ PDF ที่ Chromium สร้าง — ใช้ตรวจว่ากล่องตราล้นไปหน้า 2 หรือยัง
// (ไฟล์นี้ Chromium สร้างเองล้วนๆ โครงสร้างเรียบง่าย นับ /Type /Page ได้ตรง ไม่ต้องพึ่ง qpdf/pdfinfo)
export function countPdfPages(buffer) {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page(?![s])/g);
  return matches ? matches.length : 1;
}

const MAX_FIT_ATTEMPTS = 8;
const FIT_STEP_PT = 18; // เลื่อนขึ้นทีละประมาณหนึ่งบรรทัดครึ่งของกล่อง

/**
 * ซ้อน HTML กล่องหนึ่งกล่อง (ตราประทับ/กล่องลงนาม) ทับหน้าแรกของ PDF จริง สองขั้นตอน:
 * 1) render กล่อง HTML เป็น PDF ด้วย headless Chromium (รองรับภาษาไทยถูกต้อง ต่างจากการเขียน
 *    PDF content stream เองที่ต้องฝัง font ภาษาไทยเอง ซับซ้อนและเสี่ยงผิดพลาดมาก)
 * 2) ซ้อนหน้านั้นทับหน้าแรกของ PDF เดิมด้วย qpdf --overlay (แก้แค่หน้า 1 เท่านั้น หน้าอื่นไม่แตะ)
 *
 * เรียกซ้ำได้หลายรอบ (เช่น ธุรการประทับตรารับก่อน แล้ว ผอ. ลงนามทีหลัง) เพราะรับ "ไฟล์เดิม" เป็น input
 * ทุกครั้ง แล้ว output ออกมาเป็นไฟล์ใหม่ที่มีกล่องเดิม + กล่องใหม่ซ้อนกันอยู่
 *
 * buildHtml(shiftUpPt) ต้องคืน HTML ที่เลื่อนกล่องขึ้นจากตำแหน่งที่ขอไว้ตามจำนวน pt ที่ส่งให้ —
 * เพราะ qpdf --overlay --to=1 ซ้อนให้แค่หน้า 1 ถ้ากล่องสูงจนตกไปหน้า 2 ส่วนท้ายกล่อง (ลายเซ็น ชื่อ
 * ตำแหน่ง วันที่) จะหายไปจากเอกสารจริงแบบเงียบๆ ไม่มีอะไรฟ้อง จึงต้อง render แล้วนับหน้าจริงทุกครั้ง
 * ถ้าเกินหนึ่งหน้าให้เลื่อนกล่องขึ้นแล้ว render ใหม่ — เชื่อถือได้กว่าการวัดความสูงกล่องไว้ล่วงหน้าเป็น
 * ค่าคงที่ เพราะความสูงจริงขึ้นกับฟอนต์บนเครื่องเซิร์ฟเวอร์ ความยาวข้อความ และจำนวนบรรทัดที่ตัดคำ
 * ซึ่งเปลี่ยนได้ทุกเมื่อโดยไม่มีใครทันสังเกต
 */
async function overlayHtmlOnFirstPage(originalBuffer, buildHtml) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esaraban-stamp-'));
  const originalPath = path.join(tmpDir, 'original.pdf');
  const stampHtmlPath = path.join(tmpDir, 'stamp.html');
  const stampPdfPath = path.join(tmpDir, 'stamp.pdf');
  const outputPath = path.join(tmpDir, 'output.pdf');
  try {
    fs.writeFileSync(originalPath, originalBuffer);

    let pages = 0;
    for (let attempt = 0; attempt < MAX_FIT_ATTEMPTS; attempt++) {
      fs.rmSync(stampPdfPath, { force: true });
      fs.writeFileSync(stampHtmlPath, buildHtml(attempt * FIT_STEP_PT));
      await run(CHROME_BIN, ['--headless', '--disable-gpu', '--no-sandbox', `--print-to-pdf=${stampPdfPath}`, '--print-to-pdf-no-header', stampHtmlPath]);
      if (!fs.existsSync(stampPdfPath)) throw httpError(500, 'สร้างภาพตราประทับไม่สำเร็จ');
      pages = countPdfPages(fs.readFileSync(stampPdfPath));
      if (pages === 1) break;
    }
    if (pages !== 1) {
      // ยอมล้มเหลวแบบเสียงดัง ดีกว่าประทับตราที่ลายเซ็นหายไปโดยไม่มีใครรู้
      throw httpError(500, 'กล่องตราประทับยาวเกินกว่าจะวางในหน้าเดียวได้ — กรุณาลดความยาวข้อความ "เห็นควรให้" แล้วลองใหม่');
    }

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
  const build = (shiftUpPt) => `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .stamp { position: absolute; left: ${leftPt}pt; top: ${Math.max(0, topPt - shiftUpPt)}pt; width: 150pt; border: 2px solid #2222aa; color: #2222aa; padding: 6pt; font-size: 8pt; line-height: 1.5; border-radius: 4pt; }
    .stamp .title { font-weight: 700; text-align: center; padding-bottom: 3pt; margin-bottom: 3pt; }
  </style></head><body>
    <div class="stamp">
      <div class="title">${esc(schoolName)}</div>
      <div>เลขรับ......${esc(docNumberDisplay)}......</div>
      <div>วันที่......${esc(dateThaiLong)}......</div>
      <div>เวลา......${esc(timeStr)}......</div>
    </div>
  </body></html>`;
  return overlayHtmlOnFirstPage(originalBuffer, build);
}

// เครื่องหมาย "ทราบ" + ลายเซ็นแบบง่าย ไม่มีกรอบ — เลียนแบบวิธีที่คนจริงเขียน "ทราบ" ด้วยลายมือแล้วเซ็นชื่อ
// ต่อท้ายบนที่ว่างของเอกสาร (ต่างจาก stampDirectorDecision ที่เป็นกล่องความเห็นทางการของผู้ตัดสินใจคนสุดท้าย)
// ใช้กับทุกคนในสาย workflow ที่ "เห็น" เอกสารนี้แล้ว (อนุมัติ/ส่งต่อ/รับทราบ/ไม่อนุมัติ) — มีกี่คนก็ประทับ
// ได้กี่ครั้ง เพราะแต่ละครั้งซ้อนทับไฟล์ล่าสุดที่มีเครื่องหมายของคนก่อนหน้าอยู่แล้ว (ดู overlayHtmlOnFirstPage)
export async function stampAcknowledgeMark({ originalBuffer, signatureDataUrl, prefix, firstName, lastName, dateThaiLong, xPercent, yPercent, actingForLabel }) {
  const leftPt = Math.max(0, Math.min(90, xPercent ?? DEFAULT_ACK_MARK_X_PERCENT)) / 100 * PAGE_WIDTH_PT;
  const topPt = Math.max(0, Math.min(94, yPercent ?? DECISION_MAX_TOP_PERCENT)) / 100 * PAGE_HEIGHT_PT;
  const build = (shiftUpPt) => `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .mark { position: absolute; left: ${leftPt}pt; top: ${Math.max(0, topPt - shiftUpPt)}pt; width: ${ACK_MARK_WIDTH_PT}pt; color: #2222aa; text-align: center; }
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
  return overlayHtmlOnFirstPage(originalBuffer, build);
}

/**
 * ความเห็นของธุรการที่เสนอขึ้นไปให้ผู้อำนวยการ — วางมุมซ้ายล่างของเอกสาร ขอบบนตรงกับกรอบตราปั๊ม ผอ.
 *
 * รูปแบบตามที่โรงเรียนใช้จริง เรียงจากบนลงล่าง:
 *   บรรทัดแรก  "เรียนผู้อำนวยการโรงเรียน"
 *   บรรทัดถัดมา ความเห็นที่ธุรการพิมพ์เอง (ขึ้นบรรทัดใหม่ได้ ยาวแล้วตัดคำเอง)
 *   บรรทัดท้าย  ลายเซ็น แล้วต่อด้วยชื่อในวงเล็บ และ "ตำแหน่ง........"
 *
 * ไม่มีกรอบ ต่างจากกล่อง ผอ. เพราะของจริงธุรการเขียนด้วยลายมือลงบนที่ว่างของเอกสาร ไม่ใช่ตรายาง
 * (แนวเดียวกับ stampAcknowledgeMark) — ส่วนหัว "เรียน..." ชิดซ้าย ให้อ่านเป็นข้อความ ส่วนบล็อกลงนาม
 * จัดกึ่งกลางตามธรรมเนียมหนังสือราชการ
 */
export async function stampRegistrarComment({ originalBuffer, comment, signatureDataUrl, prefix, firstName, lastName, position, dateThaiLong, xPercent, yPercent }) {
  const leftPt = Math.max(0, Math.min(90, xPercent ?? DEFAULT_REGISTRAR_X_PERCENT)) / 100 * PAGE_WIDTH_PT;
  // ใช้เพดานเดียวกับกล่อง ผอ. — ทั้งกันส่วนท้ายตกหน้า 2 และทำให้ขอบบนตรงกันตามที่โรงเรียนขอ
  const topPt = Math.max(0, Math.min(DECISION_MAX_TOP_PERCENT, yPercent ?? DECISION_MAX_TOP_PERCENT)) / 100 * PAGE_HEIGHT_PT;
  const build = (shiftUpPt) => `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .reg { position: absolute; left: ${leftPt}pt; top: ${Math.max(0, topPt - shiftUpPt)}pt; width: ${REGISTRAR_BOX_WIDTH_PT}pt; color: #2222aa; font-size: 8pt; line-height: 1.55; }
    .reg .lead { font-weight: 700; }
    .reg .body { margin-top: 1pt; white-space: pre-wrap; word-break: break-word; }
    .reg .sig { text-align: center; margin-top: 4pt; }
    .reg .sig img { max-height: 32pt; max-width: 110pt; }
    .reg .name { text-align: center; }
    .reg .fill { display: inline-block; min-width: 70pt; border-bottom: 0.6pt dotted #2222aa; text-align: center; padding: 0 2pt; }
  </style></head><body>
    <div class="reg">
      <div class="lead">เรียนผู้อำนวยการโรงเรียน</div>
      <div class="body">${esc(comment || '')}</div>
      ${signatureDataUrl ? `<div class="sig"><img src="${esc(signatureDataUrl)}" /></div>` : ''}
      <div class="name">(${esc(prefix || '')}${esc(firstName)} ${esc(lastName)})</div>
      <div class="name">ตำแหน่ง<span class="fill">${esc(position || '')}</span></div>
      <div class="name">${esc(dateThaiLong)}</div>
    </div>
  </body></html>`;
  return overlayHtmlOnFirstPage(originalBuffer, build);
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
export async function stampDirectorDecision({ originalBuffer, schoolName, decision, note, marks, notifyTarget, signatureDataUrl, prefix, firstName, lastName, position, titleMode, actingForLabel, dateThaiLong, xPercent, yPercent }) {
  // marks: รายการเครื่องหมายที่ผู้ตัดสินใจติ๊กเลือกเอง — ถ้อยคำอ้างอิงตรายางจริงของโรงเรียน (ดู
  // DECISION_MARK_OPTIONS ใน routes/documents.js) เลือกได้หลายอันพร้อมกัน ไม่ผูกกับ decision (ซึ่งเป็นแค่
  // ปุ่ม workflow ที่กดปิด/ส่งกลับเรื่อง) — กรองค่าที่ไม่รู้จักไว้แล้วที่ documents.js (parseDecisionMarks)
  const marked = new Set(marks || []);
  // วาดช่องติ๊กด้วย CSS ล้วน (ไม่ใช้อักขระ ☑/✓) เพราะ image ของ Docker มีแต่ฟอนต์ไทย (fonts-thai-tlwg)
  // ซึ่งไม่มี glyph พวกนี้ ถ้าใช้ตัวอักษรจะกลายเป็นสี่เหลี่ยมโบ๋ตอนประทับลง PDF จริง
  const box = (on) => (on ? '<span class="cb"><i></i></span>' : '<span class="cb"></span>');
  // ค่าเริ่มต้นชิดมุมขวาล่างของหน้า ตามที่ตราจริงของโรงเรียนใช้ตำแหน่งนี้ (ตราลงรับของธุรการอยู่มุมขวาบน
  // แยกกันคนละมุม ไม่ชนกัน) — ผู้ใช้ยังลากปรับตำแหน่งเองได้ก่อนกดปุ่มตามปกติ
  //
  // เพดาน 72% ห้ามเกินเด็ดขาด: กล่องนี้สูงได้ถึง ~230pt (กรณีหนักสุด = หัวตรารักษาการแทน 2 บรรทัด +
  // ข้อความความเห็นยาว) ถ้าวางต่ำกว่านี้ Chromium จะดันส่วนท้ายกล่องตกไปหน้า 2 ของไฟล์ตรา แล้ว
  // qpdf --overlay --to=1 ซ้อนให้แค่หน้า 1 → ลายเซ็น/ชื่อ/ตำแหน่ง/วันที่ หายไปจากเอกสารจริงแบบเงียบๆ
  // (วัดจริงแล้ว: 72% ยังพอดี 1 หน้า, 74% ขึ้นไปกลายเป็น 2 หน้าทันที) ที่ 72% ขอบล่างกล่องก็ชิดท้าย
  // กระดาษพอดีอยู่แล้ว จึงยังได้ตำแหน่ง "ขวาล่าง" ตามตราจริงโดยไม่เสี่ยงข้อมูลหาย
  const leftPt = Math.max(0, Math.min(80, xPercent ?? DEFAULT_DECISION_X_PERCENT)) / 100 * PAGE_WIDTH_PT;
  const topPt = Math.max(0, Math.min(DECISION_MAX_TOP_PERCENT, yPercent ?? DECISION_MAX_TOP_PERCENT)) / 100 * PAGE_HEIGHT_PT;

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

  const build = (shiftUpPt) => `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .box { position: absolute; left: ${leftPt}pt; top: ${Math.max(0, topPt - shiftUpPt)}pt; width: ${DECISION_BOX_WIDTH_PT}pt; border: 2px solid #2222aa; color: #2222aa; padding: 7pt; font-size: 8pt; line-height: 1.55; border-radius: 4pt; }
    .box .title { font-weight: 700; text-align: center; margin-bottom: 4pt; }
    .box .opt { margin: 1.5pt 0; }
    .box .cb { display: inline-block; width: 7pt; height: 7pt; border: 0.8pt solid #2222aa; position: relative; vertical-align: -1pt; margin-right: 3.5pt; }
    .box .cb i { position: absolute; left: 2pt; top: -0.5pt; width: 2.4pt; height: 5pt; border-right: 1.2pt solid #2222aa; border-bottom: 1.2pt solid #2222aa; transform: rotate(40deg); }
    .box .fill { display: inline-block; min-width: 54pt; border-bottom: 0.6pt dotted #2222aa; text-align: center; padding: 0 2pt; }
    .box .gap { display: inline-block; width: 10pt; }
    .box .note { margin: 3pt 0 0; word-break: break-word; }
    .box .sig { text-align: center; margin-top: 4pt; }
    .box .sig img { max-height: 34pt; max-width: 110pt; }
    .box .name { text-align: center; }
  </style></head><body>
    <div class="box">
      <div class="title">${titleHtml}</div>
      <div class="opt">${box(marked.has('ทราบ'))} ทราบ</div>
      <div class="opt">${box(marked.has('อนุญาต'))} อนุญาต <span class="gap"></span>${box(marked.has('ไม่อนุญาต'))} ไม่อนุญาต</div>
      <div class="opt">${box(marked.has('อนุมัติ'))} อนุมัติ <span class="gap"></span>${box(marked.has('ไม่อนุมัติ'))} ไม่อนุมัติ</div>
      <div class="opt">${box(marked.has('เก็บรวมเรื่อง'))} เก็บรวมเรื่อง</div>
      <div class="opt">${box(marked.has('แจ้งคณะครูทราบ'))} แจ้งคณะครูทราบ</div>
      <div class="opt">${box(marked.has('แจ้งให้ทราบ'))} แจ้งให้ <span class="fill">${esc(notifyTarget || '')}</span> ทราบ</div>
      <div class="opt">${box(marked.has('ดำเนินการ'))} ดำเนินการ</div>
      <div class="note">เห็นควรให้ ${esc(note || '')}</div>
      ${signatureDataUrl ? `<div class="sig"><img src="${esc(signatureDataUrl)}" /></div>` : ''}
      <div class="name">(${esc(prefix || '')}${esc(firstName)} ${esc(lastName)})</div>
      ${positionHtml}
      <div class="name">${esc(dateThaiLong)}</div>
    </div>
  </body></html>`;
  return overlayHtmlOnFirstPage(originalBuffer, build);
}
