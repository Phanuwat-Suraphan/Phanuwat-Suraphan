import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// httpError คัดลอกไว้ในไฟล์นี้เอง (ไม่ import จาก workflow.js) — เหตุผลเดียวกับ googleDrive.js/pdfPreview.js
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

// เพดานความยาวข้อความที่จะถูกประทับลงบนไฟล์ PDF จริง — ไม่ใช่ตัวเลขที่เดาเอา แต่วัดจากการ render จริง
// ด้วย chromium: กล่องความเห็นที่ตำแหน่ง 72% พร้อม checkbox ครบทุกช่องและบล็อกลงชื่อ 3 บรรทัด
// ยังอยู่ในหน้าเดียวได้ถึงประมาณ 500 ตัวอักษร (หลังระบบเลื่อนกล่องขึ้นให้ครบ 8 ครั้งตาม fit-retry loop)
// แต่ที่ 700 ตัวอักษรจะล้นออกหน้า 2 แม้เลื่อนขึ้นสุดแล้ว ซึ่ง qpdf --overlay --to=1 จะทับให้แค่หน้าแรก
// = ตราประทับหายทั้งกล่อง
//
// ตั้งไว้ที่ 400 เพื่อกันเผื่อ: เครื่องที่วัดไม่มีฟอนต์ไทยติดตั้ง (ใช้ฟอนต์สำรอง) ส่วนเครื่องจริงใช้
// fonts-thai-tlwg ซึ่งตัวอักษรกว้างกว่า เพดานจริงจึงต่ำกว่าที่วัดได้ — และความเห็นบนตรายางจริง
// ของโรงเรียนก็สั้นกว่านี้มากอยู่แล้ว (หนึ่งถึงสองบรรทัด)
export const MAX_STAMP_TEXT = 400;

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
export const ACK_MARK_WIDTH_PT = 130;
export const DEFAULT_REGISTRAR_X_PERCENT = 2;
export const DEFAULT_ACK_MARK_X_PERCENT = 35;
export const DEFAULT_DECISION_X_PERCENT = 58;

// ตรา "รับทราบและปฏิบัติตามคำสั่ง" — กรอบเดียว มีบรรทัดเลขให้ลงชื่อ 4 บรรทัดตามตรายางจริง
//
//   ┌──────────────────────────────┐
//   │  รับทราบและปฏิบัติตามคำสั่ง      │
//   │  1. (ลายเซ็น) (ชื่อ) ..........  │  <- คนที่ 1 เป็นผู้วาดกรอบนี้
//   │  2. ........................  │  <- คนที่ 2 วาดแต่ชื่อลงบรรทัดนี้
//   │  3. ........................  │
//   │  4. ........................  │
//   └──────────────────────────────┘
//
// ทุกคน "ใช้ขอบบนเดียวกัน" คือขอบบนของกรอบ ต่างจากของเดิมที่แต่ละคนคำนวณขอบบนของตัวเองจากลำดับที่
// (ACK_WORD_HEIGHT_PERCENT/ACK_ENTRY_HEIGHT_PERCENT/ackSlotTopPercent ที่เอาออกไปแล้ว) — ตำแหน่งใน
// แนวตั้งตอนนี้เป็นเรื่องภายในกรอบล้วนๆ จัดการด้วย ACK_ROW_HEIGHT_PT ทำให้ไม่มีทางเหลื่อมกันได้อีก
// ไม่ว่าจะมีกี่คนหรือใครมีลายเซ็นบันทึกไว้บ้าง
export const ACK_BOX_ROWS = 4;
export const ACK_ROW_HEIGHT_PT = 18;
export const ACK_MAX_TOP_PERCENT = 94;

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// เรียกโปรแกรมระบบ (chromium/qpdf) — เป็น system package ผ่าน apt ไม่ใช่ npm dependency จึงยังอยู่ใน
// กติกา zero-dependency ของโปรเจกต์นี้ (แนวทางเดียวกับ poppler-utils ใน pdfPreview.js) ต้องติดตั้ง
// บนเซิร์ฟเวอร์ก่อนใช้งาน (ดู DEPLOY.md)
/**
 * รหัสจบการทำงานที่ถือว่า "สำเร็จ" ของแต่ละโปรแกรม
 *
 * qpdf ใช้ 3 = "ทำงานสำเร็จแล้ว แต่มีคำเตือน" ซึ่งต่างจาก 2 = "มีข้อผิดพลาด" (ดู qpdf --help=exit-status)
 * และไฟล์ผลลัพธ์ถูกสร้างครบถ้วนแล้วในกรณีนี้
 *
 * เรื่องนี้สำคัญมากกับงานจริง เพราะไฟล์ PDF ที่สแกนจากเครื่องถ่ายเอกสารของโรงเรียน หรือที่ส่งมาจาก
 * หน่วยงานต้นทาง เกือบทุกไฟล์มีคำเตือนแบบนี้เป็นปกติ:
 *   - "dictionary has duplicated key /Info"
 *   - "stream keyword followed by carriage return only"
 * ทั้งสองอย่างเป็นความไม่เรียบร้อยเล็กน้อยของไฟล์ที่ qpdf ซ่อมให้เองได้ ไม่กระทบเนื้อหาเอกสารเลย
 *
 * เดิมถือว่า "ไม่ใช่ 0 = ล้มเหลว" ทั้งหมด ผลคือการประทับตราล้มเหลวกับหนังสือจริงเกือบทุกฉบับ
 * โดยขึ้นข้อความ error ภาษาอังกฤษดิบๆ ที่อ่านไม่รู้เรื่อง (ยืนยันจากเครื่องใช้งานจริงแล้ว)
 */
const OK_EXIT_CODES = { qpdf: new Set([0, 3]) };

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
      const ok = (OK_EXIT_CODES[path.basename(cmd)] || new Set([0])).has(code);
      if (!ok) reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(0, 500)}`));
      else {
        // คำเตือนต้องเห็นใน log ของเซิร์ฟเวอร์ ไม่ใช่กลืนหายไปเฉยๆ — ถ้าวันหนึ่งไฟล์เสียจริง
        // จะได้ตามรอยได้ว่าเริ่มเตือนตั้งแต่เมื่อไร แต่ไม่ต้องไปกวนผู้ใช้ที่หน้าเว็บ
        if (code !== 0) console.warn(`[stamp] ${cmd} จบด้วยรหัส ${code} (คำเตือน ไม่ใช่ข้อผิดพลาด): ${stderr.slice(0, 300).replace(/\s+/g, ' ')}`);
        resolve();
      }
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
// ทางให้เทสต์/เครื่องมือตรวจหน้าตาดึง "HTML ของตัวตรา" ออกมาดูได้โดยไม่ต้องมี qpdf บนเครื่อง
// (แนวเดียวกับ _setLineApiCallerForTest / _setDriveFetchForTest) — จำเป็นเพราะหน้าตาของตราคือสิ่งที่
// ต้องตรวจให้ตรงกับตรายางจริงของโรงเรียน แต่ขั้นตอนรวมไฟล์ต้องใช้โปรแกรมระบบที่ไม่ได้มีทุกที่
let stampHtmlSink = null;
export function _setStampHtmlSinkForTest(fn) { stampHtmlSink = fn || null; }

async function overlayHtmlOnFirstPage(originalBuffer, buildHtml) {
  if (stampHtmlSink) return stampHtmlSink(buildHtml);
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

    // ตรวจไฟล์ผลลัพธ์เอง ไม่เชื่อรหัสจบการทำงานอย่างเดียว — รหัสจบบอกได้แค่ว่าโปรแกรมคิดว่าตัวเอง
    // ทำสำเร็จไหม แต่สิ่งที่ต้องรับประกันคือ "ไฟล์ที่จะเอาไปเก็บเป็นหนังสือราชการใช้เปิดได้จริง"
    // ถ้าปล่อยไฟล์เสียผ่านไป มันจะไปทับสำเนาที่ประทับตราแล้วของหนังสือฉบับนั้นโดยไม่มีอะไรฟ้อง
    const stamped = fs.readFileSync(outputPath);
    if (stamped.length < 512 || stamped.subarray(0, 5).toString('latin1') !== '%PDF-') {
      throw httpError(500, 'ไฟล์ที่ประทับตราแล้วไม่ใช่ PDF ที่ถูกต้อง — ยกเลิกการบันทึกเพื่อไม่ให้ทับไฟล์เดิม');
    }
    return stamped;
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

/**
 * ตรา "รับทราบและปฏิบัติตามคำสั่ง" ของผู้ปฏิบัติ — กรอบสี่เหลี่ยมมีบรรทัดเลข 1-4 ให้ลงชื่อเรียงกัน
 * ตามตรายางจริงของโรงเรียน (ภาพที่โรงเรียนส่งมา)
 *
 * แทนของเดิมที่เป็นคำว่า "ทราบ" ตัวโตๆ แล้วให้แต่ละคนเซ็นต่อกันลงมาลอยๆ ไม่มีกรอบ — โรงเรียนสั่งแก้
 * ให้ใช้ตรานี้แทนทั้งตำแหน่งคำว่าทราบและตำแหน่งลายเซ็นผู้รับทราบ เพราะ ผอ. สั่งการให้หลายคนพร้อมกันได้
 * ตรายางจึงเตรียมบรรทัดไว้ให้ 4 คน
 *
 * วิธีวางให้ตรงบรรทัดทุกครั้ง — จุดที่พลาดง่ายที่สุดของฟังก์ชันนี้:
 *
 * แต่ละคนประทับคนละครั้ง (ตอนที่ตัวเองกดรับทราบ) โดยซ้อนทับไฟล์ล่าสุดที่มีของคนก่อนหน้าอยู่แล้ว
 * ระบบจึงไม่เคยรู้ล่วงหน้าว่าจะมีทั้งหมดกี่คน คนแรกเป็นผู้วาดกรอบ (drawBox = true) คนถัดๆ ไปวาดแต่
 * ชื่อตัวเองลงบรรทัดที่ N ของกรอบที่มีอยู่แล้ว
 *
 * ทั้งสองกรณีจึงสร้าง HTML "โครงเดียวกันเป๊ะ" ทุกครั้ง แล้วคนที่ไม่ได้วาดกรอบค่อยซ่อนเส้นกรอบ/หัวตรา/
 * เส้นประออกด้วย visibility: hidden — ไม่ใช่ตัดองค์ประกอบทิ้ง เพราะการตัดทิ้งทำให้ความสูงเปลี่ยน
 * แล้วชื่อจะไปตกคนละที่กับบรรทัดที่วาดไว้จริง (ซึ่งเป็นบั๊กที่มองไม่เห็นจนกว่าจะมีคนที่สองมากดรับทราบ)
 * visibility: hidden กินที่เท่าเดิมทุกประการ เรขาคณิตจึงตรงกันโดยไม่ต้องคำนวณอะไรเพิ่ม
 *
 * ถ้ามีคนที่ 5 ขึ้นไป (มากกว่าที่ตรายางมีบรรทัดให้) จะต่อแถวลงมาใต้กรอบด้วยระยะเท่ากัน ดีกว่าปฏิเสธ
 * ไม่ให้กดรับทราบ หรือเขียนทับบรรทัดเดิมจนอ่านไม่ออก
 */
export async function stampAcknowledgeMark({ originalBuffer, signatureDataUrl, prefix, firstName, lastName, dateThaiLong, xPercent, yPercent, actingForLabel, slotIndex = 0, drawBox = true }) {
  const leftPt = Math.max(0, Math.min(90, xPercent ?? DEFAULT_ACK_MARK_X_PERCENT)) / 100 * PAGE_WIDTH_PT;
  const topPt = Math.max(0, Math.min(ACK_MAX_TOP_PERCENT, yPercent ?? DECISION_MAX_TOP_PERCENT)) / 100 * PAGE_HEIGHT_PT;
  const rows = Math.max(ACK_BOX_ROWS, slotIndex + 1); // ขยายลงล่างให้พอดีคนที่เกินบรรทัดของตรายาง
  // ไม่ใส่วันที่ลงบรรทัด — บรรทัดกว้างแค่ ~114pt ใส่ทั้งลายเซ็น ชื่อ และวันที่แล้วล้นจนโดนตัดทิ้ง
  // ตรายางจริงก็ไม่มีช่องวันที่ และระบบเก็บวันเวลาที่กดรับทราบไว้ในไทม์ไลน์ของหนังสือครบอยู่แล้ว
  const entry = (i) => (i === slotIndex ? `
    ${signatureDataUrl ? `<img class="sig" src="${esc(signatureDataUrl)}" />` : ''}
    <span class="who">(${esc(prefix || '')}${esc(firstName)} ${esc(lastName)})${actingForLabel ? ` แทน${esc(actingForLabel)}` : ''}</span>` : '');
  const build = (shiftUpPt) => `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .ack { position: absolute; left: ${leftPt}pt; top: ${Math.max(0, topPt - shiftUpPt)}pt; width: ${ACK_MARK_WIDTH_PT}pt; color: #2222aa; }
    .ack .box { border: 2px solid #2222aa; border-radius: 3pt; padding: 5pt 6pt; }
    .ack .title { font-size: 8.5pt; font-weight: 700; text-align: center; line-height: 1.25; margin-bottom: 2pt; }
    /* ความสูงต่อบรรทัดต้องคงที่เสมอ ไม่ว่าคนนั้นจะมีลายเซ็นบันทึกไว้หรือไม่ — ไม่งั้นคนถัดไปจะเหลื่อม */
    .ack .row { height: ${ACK_ROW_HEIGHT_PT}pt; display: flex; align-items: flex-end; gap: 2pt; }
    .ack .n { font-size: 8pt; line-height: 1.6; flex: 0 0 auto; }
    .ack .line { flex: 1 1 auto; border-bottom: 0.7pt dotted #2222aa; display: flex; align-items: flex-end; justify-content: center; gap: 2pt; overflow: hidden; height: ${ACK_ROW_HEIGHT_PT - 3}pt; }
    .ack .sig { max-height: ${ACK_ROW_HEIGHT_PT - 6}pt; max-width: 42pt; }
    .ack .who { font-size: 6pt; line-height: 1.3; white-space: nowrap; }
    /* คนที่ไม่ได้เป็นผู้วาดกรอบ: ซ่อนเส้นทุกเส้นแต่กินที่เท่าเดิม เหลือไว้แต่ชื่อของตัวเอง */
    .ghost .box { border-color: transparent; }
    .ghost .title, .ghost .n { visibility: hidden; }
    .ghost .line { border-bottom-color: transparent; }
  </style></head><body>
    <div class="ack${drawBox ? '' : ' ghost'}">
      <div class="box">
        <div class="title">รับทราบและปฏิบัติตามคำสั่ง</div>
        ${Array.from({ length: rows }, (_, i) => `<div class="row"><span class="n">${i + 1}.</span><span class="line">${entry(i)}</span></div>`).join('')}
      </div>
    </div>
  </body></html>`;
  return overlayHtmlOnFirstPage(originalBuffer, build);
}

/**
 * ตราธุรการที่เสนอเรื่องขึ้นไปให้ผู้อำนวยการ — วางมุมซ้ายล่าง ขอบบนตรงกับกรอบตราปั๊ม ผอ.
 *
 * รูปแบบตามตรายางจริงของโรงเรียน (ภาพที่โรงเรียนส่งมา): กรอบสี่เหลี่ยมสีน้ำเงิน หัวกล่องว่า
 * "เรียน ผู้อำนวยการ<ชื่อโรงเรียน>" แล้วเป็นตัวเลือกวงกลมให้ธุรการฝนเลือก 5 ข้อ
 *
 *   ◯ เพื่อโปรดทราบและพิจารณา
 *   ◯ เพื่อประชาสัมพันธ์
 *   ◯ เพื่อพิจารณา อนุมัติ
 *   ◯ เพื่อแจ้งฝ่ายงาน ...............
 *   ◯ เสนอความคิดเห็น ...............
 *
 * เดิมเป็นข้อความอิสระที่ธุรการพิมพ์เอาเองล้วนๆ ไม่มีกรอบ — ซึ่งไม่ตรงกับของจริงที่โรงเรียนใช้
 * ข้อความอิสระที่พิมพ์ไว้ยังอยู่ครบ แต่ย้ายไปเป็นเนื้อของข้อ "เสนอความคิดเห็น" ซึ่งเป็นช่องที่
 * ตรายางจริงเตรียมไว้ให้เขียนอยู่แล้ว หนังสือเก่าที่ประทับไปแล้วจึงอ่านได้เหมือนเดิมทุกฉบับ
 *
 * ตัวเลือกวาดเป็นวงกลม ไม่ใช่สี่เหลี่ยมเหมือนกล่อง ผอ. เพราะตรายางจริงของสองอันนี้ต่างกันจริงๆ
 * และวาดด้วย CSS ล้วน ไม่ใช้อักขระ ◯/● ด้วยเหตุผลเดียวกับกล่อง ผอ. (image ของ Docker มีแต่ฟอนต์ไทย
 * ซึ่งไม่มี glyph พวกนี้ จะกลายเป็นสี่เหลี่ยมโบ๋ตอนประทับลง PDF จริง)
 *
 * ไม่มีลายเซ็น/ชื่อธุรการอยู่บนตราแล้ว ตามที่โรงเรียนสั่งแก้ — ของเดิมธุรการต้องเซ็นและพิมพ์ชื่อ
 * ตำแหน่งกำกับไว้ตรงนี้ ตอนนี้แค่ปั๊มตรานี้แล้วส่งขึ้นไปได้เลย เร็วกว่าเดิมมากเพราะเป็นงานที่ทำ
 * ทุกฉบับ ส่วนหลักฐานว่า "ใครเป็นคนเสนอเรื่องนี้ขึ้นไปและเมื่อไหร่" ระบบยังเก็บครบเหมือนเดิมทั้งใน
 * audit log และในบันทึกความเห็นของหนังสือฉบับนั้น เพียงแต่ไม่พิมพ์ลงหน้ากระดาษอีกแล้ว
 */
export async function stampRegistrarComment({ originalBuffer, schoolName, marks, notifyUnit, comment, xPercent, yPercent }) {
  const leftPt = Math.max(0, Math.min(90, xPercent ?? DEFAULT_REGISTRAR_X_PERCENT)) / 100 * PAGE_WIDTH_PT;
  // ใช้เพดานเดียวกับกล่อง ผอ. — ทั้งกันส่วนท้ายตกหน้า 2 และทำให้ขอบบนตรงกันตามที่โรงเรียนขอ
  const topPt = Math.max(0, Math.min(DECISION_MAX_TOP_PERCENT, yPercent ?? DECISION_MAX_TOP_PERCENT)) / 100 * PAGE_HEIGHT_PT;
  const marked = new Set(marks || []);
  const dot = (on) => (on ? '<span class="rb"><i></i></span>' : '<span class="rb"></span>');
  const build = (shiftUpPt) => `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: ${PAGE_WIDTH_PT}pt ${PAGE_HEIGHT_PT}pt; margin: 0; }
    body { margin: 0; font-family: "Noto Sans Thai", sans-serif; -webkit-print-color-adjust: exact; }
    .reg { position: absolute; left: ${leftPt}pt; top: ${Math.max(0, topPt - shiftUpPt)}pt; width: ${REGISTRAR_BOX_WIDTH_PT}pt; color: #2222aa; font-size: 8pt; line-height: 1.55; }
    .reg .box { border: 2px solid #2222aa; padding: 6pt 7pt; border-radius: 3pt; }
    .reg .lead { font-weight: 700; margin-bottom: 2.5pt; }
    .reg .opt { margin: 1.5pt 0 1.5pt 7pt; text-indent: -7pt; padding-left: 7pt; }
    .reg .rb { display: inline-block; width: 7pt; height: 7pt; border: 0.8pt solid #2222aa; border-radius: 50%; position: relative; vertical-align: -1pt; margin-right: 3.5pt; }
    .reg .rb i { position: absolute; left: 1.4pt; top: 1.4pt; width: 3pt; height: 3pt; border-radius: 50%; background: #2222aa; }
    .reg .fill { display: inline-block; min-width: 54pt; border-bottom: 0.6pt dotted #2222aa; padding: 0 2pt; word-break: break-word; }
  </style></head><body>
    <div class="reg">
      <div class="box">
        <div class="lead">เรียน ผู้อำนวยการ${esc(schoolName || '')}</div>
        <div class="opt">${dot(marked.has('เพื่อโปรดทราบและพิจารณา'))} เพื่อโปรดทราบและพิจารณา</div>
        <div class="opt">${dot(marked.has('เพื่อประชาสัมพันธ์'))} เพื่อประชาสัมพันธ์</div>
        <div class="opt">${dot(marked.has('เพื่อพิจารณา อนุมัติ'))} เพื่อพิจารณา อนุมัติ</div>
        <div class="opt">${dot(marked.has('เพื่อแจ้งฝ่ายงาน'))} เพื่อแจ้งฝ่ายงาน <span class="fill">${esc(notifyUnit || '')}</span></div>
        <div class="opt">${dot(marked.has('เสนอความคิดเห็น'))} เสนอความคิดเห็น <span class="fill">${esc(comment || '')}</span></div>
      </div>
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
