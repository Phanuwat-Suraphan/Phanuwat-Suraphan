import { router, html, json, redirect, contentDispositionHeader } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateLong, fmtThaiDateShort, daysUntil, dueCell, stampDateThai, stampTimeThai, priorityBadge, secretBadge, statusBadge, emptyState, LABELS } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, uuid, nowIso, audit, RETENTION_LABEL } from '../db.js';
import {
  createDocument, getDocument, canUserSeeDocument, getWorkflowSteps, currentStep,
  assignStep, approveAndForward, acknowledgeAndComplete, rejectStep, returnStep,
  voidDocument, archiveDocument, forceDeleteDocument, httpError, assertStepBelongsToDocument,
} from '../services/workflow.js';
import { extractTextFromPdf, guessFieldsFromText, renderPdfFirstPageImage } from '../services/ocr.js';
import { isGoogleDriveEnabled, ensureCategoryFolder, uploadFile, downloadFileStream } from '../services/googleDrive.js';
import {
  stampPdf, stampDirectorDecision, stampAcknowledgeMark, stampRegistrarComment,
  DECISION_MAX_TOP_PERCENT, DEFAULT_ACK_MARK_X_PERCENT, DEFAULT_DECISION_X_PERCENT, DEFAULT_REGISTRAR_X_PERCENT,
} from '../services/pdfStamp.js';
import { getActiveDelegateFor } from '../services/delegation.js';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ALLOWED_MIME = new Set(['application/pdf']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// OCR อ่านแค่ 2 หน้าแรกของ PDF เสมอ (ดู extractTextFromPdf) และไม่เก็บไฟล์ไว้เลย (ใช้ temp file
// แล้วลบทิ้งทันที) จึงไม่มีเหตุผลผูกกับเพดาน MAX_FILE_BYTES ของไฟล์แนบถาวร — ที่ผ่านมาใช้ค่าเดียวกัน
// ทำให้ไฟล์สแกนความละเอียดสูงทั่วไป (ซึ่งมักใหญ่กว่า 10MB แม้แค่ 1-2 หน้า) ใช้ปุ่มนี้ไม่ได้เกือบทุกครั้ง
const MAX_OCR_BYTES = 20 * 1024 * 1024;
// checkbox บนตราประทับความเห็นของ ผอ./ผู้รักษาการแทน — ถ้อยคำตรงกับตรายางจริงของโรงเรียน (ยืนยันจาก
// ภาพถ่ายตราจริงและจากผู้ใช้โดยตรง) เลือกได้หลายอันพร้อมกัน ไม่ผูกกับปุ่ม workflow ที่กดส่ง (ปุ่มนั้นแค่
// ปิด/ส่งต่อขั้นตอนเท่านั้น) ผู้ตัดสินใจติ๊กเองว่าอันไหนตรงกับความเห็นจริง
// fillable: ช่อง "แจ้งให้ .......... ทราบ" มีจุดไข่ปลาให้เติมชื่อผู้ที่ต้องแจ้งเองบนตรายางจริง
// ถ้อยคำบนตราประทับความเห็นของ ผอ. — รวมของตรายาง 2 แบบที่โรงเรียนใช้จริงเข้าด้วยกัน:
// แบบเก่ามี ทราบ / อนุญาต-ไม่อนุญาต / อนุมัติ-ไม่อนุมัติ / "เห็นควรให้..."
// แบบใหม่มี ทราบ / เก็บรวมเรื่อง / แจ้งคณะครูทราบ / แจ้งให้...ทราบ / ดำเนินการ
// จึงรวมเป็นชุดเดียวที่มีครบทั้งหมด แล้วให้ผู้เซ็นติ๊กเฉพาะอันที่ต้องการ (ติ๊กได้หลายอัน)
// อนุญาต/ไม่อนุญาต และ อนุมัติ/ไม่อนุมัติ จับคู่อยู่บรรทัดเดียวกันเหมือนตรายางจริง
const DECISION_MARK_OPTIONS = [
  { value: 'ทราบ', label: 'ทราบ' },
  { value: 'อนุญาต', label: 'อนุญาต', pairWith: 'ไม่อนุญาต' },
  { value: 'ไม่อนุญาต', label: 'ไม่อนุญาต', pairedInto: 'อนุญาต' },
  { value: 'อนุมัติ', label: 'อนุมัติ', pairWith: 'ไม่อนุมัติ' },
  { value: 'ไม่อนุมัติ', label: 'ไม่อนุมัติ', pairedInto: 'อนุมัติ' },
  { value: 'เก็บรวมเรื่อง', label: 'เก็บรวมเรื่อง' },
  { value: 'แจ้งคณะครูทราบ', label: 'แจ้งคณะครูทราบ' },
  { value: 'แจ้งให้ทราบ', label: 'แจ้งให้ ........ ทราบ', fillable: true },
  { value: 'ดำเนินการ', label: 'ดำเนินการ' },
];
const DECISION_MARK_VALUES = DECISION_MARK_OPTIONS.map((m) => m.value);

function listDeptOptions(selected) {
  return db.prepare('SELECT * FROM departments ORDER BY name').all()
    .map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
}
// ประเภทเอกสารตัดออกจากฟอร์มแล้วตามคำขอ — เอกสารใหม่ทุกฉบับใช้ประเภทนี้เป็นค่าเริ่มต้นเดียวกันหมด
// (คอลัมน์/ตาราง document_types ยังอยู่เผื่ออนาคต แค่ไม่ให้ผู้ใช้เลือกเองแล้ว)
function defaultDocTypeId() {
  const row = db.prepare("SELECT id FROM document_types WHERE name = 'หนังสือภายนอก'").get()
    || db.prepare('SELECT id FROM document_types ORDER BY name LIMIT 1').get();
  if (!row) throw httpError(500, 'ไม่พบประเภทเอกสารเริ่มต้นในระบบ (ตาราง document_types ว่างเปล่า)');
  return row.id;
}
function listUserOptions(excludeId) {
  return db.prepare(`
    SELECT u.*, GROUP_CONCAT(r.name_th) as role_names FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.deleted_at IS NULL AND u.status = 'active' GROUP BY u.id ORDER BY u.first_name
  `).all()
    .filter((u) => u.id !== excludeId)
    .map((u) => `<option value="${u.id}">${esc(u.prefix || '')}${esc(u.first_name)} ${esc(u.last_name)} — ${esc(u.role_names || u.position || '')}</option>`).join('');
}

// ---------------- list ----------------
router.get('/documents', requirePage((ctx) => {
  const direction = ctx.query.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const q = (ctx.query.q || '').trim();
  const statusFilter = ctx.query.status || '';

  let sql = `SELECT d.*, dt.name as type_name, dep.name as dept_name FROM documents d
    JOIN document_types dt ON dt.id = d.doc_type_id JOIN departments dep ON dep.id = d.department_id
    WHERE d.direction = ? AND d.deleted_at IS NULL`;
  const params = [direction];
  if (statusFilter) { sql += ' AND d.status = ?'; params.push(statusFilter); }
  if (q) { sql += ' AND (d.title LIKE ? OR d.doc_number_display LIKE ? OR d.subject LIKE ? OR d.correspondent_name LIKE ?)'; const like = `%${q}%`; params.push(like, like, like, like); }
  sql += ' ORDER BY d.created_at DESC LIMIT 200';

  const rows = db.prepare(sql).all(...params).filter((d) => canUserSeeDocument(ctx.user, d));

  // เรื่องที่ยังไม่ปิดถือว่ายัง "นับเวลาอยู่" — เรื่องที่ปิดแล้วไม่ต้องขึ้นเตือนว่าเลยกำหนดอีก
  const stillOpen = (d) => !['completed', 'archived', 'voided', 'destroyed', 'rejected'].includes(d.status);
  const overdueCount = rows.filter((d) => stillOpen(d) && daysUntil(d.due_date) < 0).length;

  const rowsHtml = rows.map((d) => {
    const n = stillOpen(d) ? daysUntil(d.due_date) : null;
    return `
    <tr onclick="location.href='/documents/${d.id}'" style="cursor:pointer${n !== null && n < 0 ? ';background:rgba(220,38,38,.06)' : ''}">
      <td style="white-space:nowrap"><strong style="color:var(--primary)">${esc(d.doc_number_display)}</strong></td>
      <td class="wrap">${esc(d.title)}${d.secret_level !== 'normal' ? ' 🔒' : ''}</td>
      <td>${esc(d.dept_name)}</td>
      <td>${priorityBadge(d.priority)}</td>
      <td>${statusBadge(d.status)}</td>
      <td style="white-space:nowrap">${d.due_date ? (n === null ? esc(fmtThaiDateShort(d.due_date)) : dueCell(d.due_date)) : '<span class="text-muted">—</span>'}</td>
      <td class="text-muted" style="white-space:nowrap">${fmtDate(d.created_at)}</td>
    </tr>`;
  }).join('');

  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">${direction === 'incoming' ? '📥 หนังสือเข้า' : '📤 หนังสือออก'}</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          ${rows.length ? `ทั้งหมด ${rows.length} ฉบับ${rows.length >= 200 ? ' (แสดง 200 ฉบับล่าสุด — ใช้ช่องค้นหาเพื่อจำกัดผลลัพธ์)' : ''}${overdueCount ? ` · <strong style="color:var(--danger)">เลยกำหนดแล้ว ${overdueCount}</strong>` : ''}`
            : 'ยังไม่มีรายการ'}
        </p>
      </div>
      <a class="btn btn-primary" href="/documents/new?direction=${direction}">+ ${direction === 'incoming' ? 'รับหนังสือใหม่' : 'สร้างหนังสือส่ง'}</a>
    </div>
    <div class="card">
      <form method="get" class="flex gap-2 flex-wrap items-center" style="margin-bottom:1rem">
        <input type="hidden" name="direction" value="${direction}" />
        <input type="text" name="q" value="${esc(q)}" placeholder="ค้นหาเลขหนังสือ/ชื่อเรื่อง/หน่วยงาน" style="max-width:280px" />
        <select name="status" style="max-width:180px">
          <option value="">ทุกสถานะ</option>
          ${Object.entries(LABELS.STATUS_LABEL).map(([k, v]) => `<option value="${k}" ${k === statusFilter ? 'selected' : ''}>${esc(v)}</option>`).join('')}
        </select>
        <button class="btn btn-outline" type="submit">กรอง</button>
      </form>
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ฝ่าย</th><th>ความเร็ว</th><th>สถานะ</th><th>ครบกำหนด</th><th>วันที่ลงทะเบียน</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>`
      : emptyState('📭', `ไม่มี${direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก'}ในรายการนี้`)}
    </div>`;

  html(ctx, 200, layout({ user: ctx.user, title: direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก', path: '/documents', content }));
}));

// ---------------- new form ----------------
// Web Share Target — ปกติ service worker (public/sw.js) จะดักคำขอนี้ไว้เองตั้งแต่ในเครื่องผู้ใช้ แล้วพา
// ไฟล์เข้าฟอร์มให้เลย ไม่วิ่งมาถึงเซิร์ฟเวอร์ เส้นทางนี้เป็นทางสำรองเผื่อ SW ยังไม่ทันทำงาน (เช่น เพิ่งติดตั้ง
// แอปครั้งแรก) — กู้ไฟล์คืนไม่ได้เพราะเป็น multipart ที่ระบบนี้ไม่ได้ parse ไว้ จึงพาไปฟอร์มพร้อมบอกให้แนบเอง
router.post('/share-target', requirePage((ctx) => {
  redirect(ctx, '/documents/new?direction=incoming&shareerr=sw');
}));

router.get('/documents/new', requirePage((ctx) => {
  const direction = ctx.query.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const content = `
    <h2>${direction === 'incoming' ? '📥 รับหนังสือใหม่' : '📤 สร้างหนังสือส่ง'}</h2>
    <div class="card">
      <form id="docForm">
        <input type="hidden" name="direction" value="${direction}" />
        <div class="form-grid cols-2">
          <div class="field">
            <label>ชื่อเรื่อง *</label>
            <input type="text" name="title" required placeholder="เช่น ขออนุมัติจัดโครงการ..." />
          </div>
          <div class="field">
            <label>${direction === 'incoming' ? 'หน่วยงาน/บุคคลต้นทาง' : 'หน่วยงาน/บุคคลปลายทาง'} *</label>
            <input type="text" name="correspondentName" required placeholder="เช่น สพฐ., ผู้ปกครอง..." />
          </div>
          <div class="field">
            <label>ฝ่ายที่รับผิดชอบ *</label>
            <select name="departmentId" required>${listDeptOptions(ctx.user.department_id)}</select>
          </div>
          <div class="field">
            <label>ความเร็ว</label>
            <select name="priority">
              <option value="normal">ปกติ</option><option value="urgent">ด่วน</option>
              <option value="very_urgent">ด่วนมาก</option><option value="most_urgent">ด่วนที่สุด</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>สาระสำคัญ / หมายเหตุ</label>
          <textarea name="subject" placeholder="สรุปใจความสำคัญของหนังสือ"></textarea>
        </div>
        <details class="field-more">
          <summary>⚙️ ตัวเลือกเพิ่มเติม (ไม่บังคับ — ไม่กรอกก็ใช้ค่าเริ่มต้นได้เลย)</summary>
          <div class="form-grid cols-2" style="margin-top:.8rem">
            <div class="field">
              <label>เลขที่หนังสือ (กำหนดเอง)</label>
              <input type="text" name="customDocNumber" placeholder="เว้นว่างให้ระบบออกเลขอัตโนมัติ (เช่น 0001/2569)" />
              <div class="help-text">พิมพ์เลขที่เองได้ถ้าเลขที่ต้องการไม่ใช่เลขเรียงอัตโนมัติของระบบ — ระบบจะใช้เลขที่พิมพ์นี้แสดงแทนทุกที่ (ทะเบียน/ตราประทับ/พิมพ์เอกสาร)</div>
            </div>
            <div class="field">
              <label>เลขหนังสือ${direction === 'incoming' ? 'จากต้นทาง (ถ้ามี)' : 'อ้างอิง (ถ้ามี)'}</label>
              <input type="text" name="externalDocNumber" placeholder="เช่น ศธ 04123/55 หรือเว้นว่างถ้าไม่มี" />
            </div>
            <div class="field">
              <label>ลงวันที่ (วันที่ในหนังสือต้นฉบับ)</label>
              <input type="date" name="externalDocDate" />
            </div>
            <div class="field">
              <label>ชั้นความลับ</label>
              <select name="secretLevel">
                <option value="normal">ปกติ</option><option value="internal">ภายใน</option>
                <option value="secret">ลับ</option><option value="top_secret">ลับมาก</option>
              </select>
            </div>
            <div class="field">
              <label>กำหนดเสร็จ (ถ้ามี)</label>
              <input type="date" name="dueDate" />
            </div>
            <div class="field">
              <label>อายุการเก็บ</label>
              <select name="retentionClass">
                ${Object.entries(RETENTION_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'normal_10y' ? 'selected' : ''}>${esc(v)}</option>`).join('')}
              </select>
            </div>
          </div>
        </details>
        <div class="field">
          <label>ไฟล์แนบ 1 (ไฟล์หลัก)</label>
          <input type="file" id="fileInput" accept="application/pdf" onchange="attachFilePreview(this,'filePreview')" />
          <div id="filePreview" class="help-text"></div>
          <div class="help-text">รองรับเฉพาะไฟล์ PDF ขนาดไม่เกิน 10MB (ระบบจะตรวจ magic number และคำนวณ SHA-256 hash)</div>
          <button type="button" class="btn btn-outline btn-sm" style="margin-top:.5rem" onclick="runOcrExtract(this)">🔍 อ่านข้อมูลจากไฟล์อัตโนมัติ (OCR)</button>
          <div class="help-text">ใช้ Tesseract OCR อ่านตัวอักษรจากไฟล์ที่แนบไว้ด้านบน (เฉพาะ 2 หน้าแรก รองรับไฟล์สแกนขนาดใหญ่ถึง 20MB) แล้วลองกรอกฟิลด์ให้อัตโนมัติ — <strong>เป็นการเดาเบื้องต้นเท่านั้น กรุณาตรวจสอบความถูกต้องทุกครั้งก่อนบันทึก</strong></div>
          <div id="ocrResult"></div>
        </div>
        <div class="form-grid cols-2">
          <div class="field">
            <label>ไฟล์แนบ 2 (ถ้ามี)</label>
            <input type="file" id="fileInput2" accept="application/pdf" onchange="attachFilePreview(this,'filePreview2')" />
            <div id="filePreview2" class="help-text"></div>
          </div>
          <div class="field">
            <label>ไฟล์แนบ 3 (ถ้ามี)</label>
            <input type="file" id="fileInput3" accept="application/pdf" onchange="attachFilePreview(this,'filePreview3')" />
            <div id="filePreview3" class="help-text"></div>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">บันทึกและออกเลข${direction === 'incoming' ? 'รับ' : 'ส่ง'}อัตโนมัติ</button>
        <a class="btn btn-outline" href="/documents?direction=${direction}">ยกเลิก</a>
      </form>
    </div>
    <script>
      // รับไฟล์ที่ผู้ใช้แชร์มาจากแอปอื่น (LINE ฯลฯ) — service worker พักไฟล์ไว้ใน Cache Storage แล้วพามาที่
      // หน้านี้พร้อม ?shared=1 ตรงนี้ทำหน้าที่หยิบไฟล์ออกมาใส่ช่อง "ไฟล์แนบ 1" ให้อัตโนมัติ ผู้ใช้แค่กรอก
      // ชื่อเรื่องกับหน่วยงานต้นทางแล้วกดบันทึกได้เลย ไม่ต้องดาวน์โหลดไฟล์ลงเครื่องแล้วไล่หาเองอีก
      // รอ load ก่อน เพราะ /app.js (เจ้าของ window.toast / window.attachFilePreview) ถูกโหลดท้าย body
      window.addEventListener('load', async function pickUpSharedFile(){
        var params = new URLSearchParams(location.search);
        if (params.get('shareerr')) {
          window.toast(params.get('shareerr') === 'sw'
            ? 'เปิดแอปครั้งแรกยังรับไฟล์ที่แชร์มาอัตโนมัติไม่ได้ กรุณาแนบไฟล์เองครั้งนี้ ครั้งต่อไปจะเข้าให้เองอัตโนมัติ'
            : 'รับไฟล์ที่แชร์มาไม่สำเร็จ กรุณาแนบไฟล์เองครับ', 'warning');
        }
        // ตั้งใจไม่เช็ค ?shared=1 เป็นเงื่อนไขบังคับ — ถ้าเซสชันหมดอายุพอดี ระบบจะเด้งไปหน้า login ก่อน
        // แล้ว query string หายไป พอ login เสร็จกลับมาที่ฟอร์มนี้จะไม่มี ?shared=1 ติดมาด้วย ถ้าเช็คแบบตายตัว
        // ไฟล์ที่ผู้ใช้อุตส่าห์แชร์มาจะค้างใน cache เฉยๆ ไม่มีใครหยิบไปใช้ — เช็คจาก cache ตรงๆ ครอบคลุมกว่า
        if (!('caches' in window)) return;
        try {
          var cache = await caches.open('esaraban-shared-inbox');
          var res = await cache.match('/__shared-file__');
          if (!res) return;
          var blob = await res.blob();
          var name = decodeURIComponent(res.headers.get('X-Shared-Filename') || 'shared.pdf');
          await cache.delete('/__shared-file__'); // ใช้ครั้งเดียวแล้วลบ กันไฟล์เก่าค้างมาโผล่รอบหน้า
          if (blob.size > 10 * 1024 * 1024) { window.toast('ไฟล์ที่แชร์มาใหญ่เกิน 10MB', 'warning'); return; }

          var input = document.getElementById('fileInput');
          var dt = new DataTransfer();
          // บางแอป (รวมถึง LINE บางรุ่น) แชร์ไฟล์มาเป็น application/octet-stream ทั้งที่เป็น PDF —
          // ถ้าปล่อยไว้จะไปตกตอนกดบันทึก (เซิร์ฟเวอร์รับเฉพาะ application/pdf) หลังผู้ใช้กรอกฟอร์มจนเสร็จ
          // แล้ว เสียเวลาเปล่า จึงตั้ง type ให้ถูกตั้งแต่ตรงนี้ (เซิร์ฟเวอร์ยังตรวจ magic number ซ้ำอยู่ดี)
          var sharedType = /\.pdf$/i.test(name) ? 'application/pdf' : (blob.type || 'application/pdf');
          dt.items.add(new File([blob], name, { type: sharedType }));
          input.files = dt.files;
          window.attachFilePreview(input, 'filePreview');
          window.toast('รับไฟล์ "' + name + '" จากแอปที่แชร์มาแล้ว — กรอกชื่อเรื่องแล้วบันทึกได้เลย', 'success');
          var titleEl = document.querySelector('input[name="title"]');
          if (titleEl) titleEl.focus();
        } catch (err) {
          window.toast('รับไฟล์ที่แชร์มาไม่สำเร็จ กรุณาแนบไฟล์เองครับ', 'warning');
        }
      });
      document.getElementById('docForm').addEventListener('submit', async function(e){
        e.preventDefault();
        var formEl = this;
        var btn = formEl.querySelector('[type=submit]');
        var extraFiles = [document.getElementById('fileInput2').files[0], document.getElementById('fileInput3').files[0]].filter(Boolean);
        for (var f of extraFiles) {
          if (f.size > 10 * 1024 * 1024) { window.toast('ไฟล์ "' + f.name + '" ใหญ่เกิน 10MB — เอาออกหรือแนบทีหลังแทน', 'warning'); return; }
        }
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        try {
          var formData = new FormData(formEl);
          var payload = {};
          for (var pair of formData.entries()) payload[pair[0]] = pair[1];
          var mainFile = document.getElementById('fileInput').files[0];
          if (mainFile) {
            if (mainFile.size > 10 * 1024 * 1024) { window.toast('ไฟล์หลักใหญ่เกิน 10MB', 'warning'); window.restoreBtn(btn); return; }
            payload.fileName = mainFile.name;
            payload.fileType = mainFile.type || 'application/octet-stream';
            payload.fileDataBase64 = await window.fileToBase64(mainFile);
          }
          var res = await fetch('/documents', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');

          // แนบไฟล์ 2 และ 3 ต่อทันที (ใช้ endpoint แนบไฟล์เพิ่มเดิมที่มีอยู่แล้ว — ไม่ต้องเพิ่ม backend ใหม่)
          var docIdMatch = data.redirect.match(/documents\\/([a-f0-9-]+)/);
          var docId = docIdMatch && docIdMatch[1];
          var failedExtras = [];
          for (var ef of extraFiles) {
            try {
              var b64 = await window.fileToBase64(ef);
              var r2 = await fetch('/documents/' + docId + '/attachments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fileName: ef.name, fileType: ef.type || 'application/octet-stream', fileDataBase64: b64 }) });
              if (!r2.ok) failedExtras.push(ef.name);
            } catch (e) { failedExtras.push(ef.name); }
          }
          if (failedExtras.length) window.toast('บันทึกเอกสารสำเร็จ แต่แนบไม่สำเร็จ: ' + failedExtras.join(', '), 'warning');
          window.location.href = data.redirect;
        } catch (err) {
          window.toast(err.message || 'เกิดข้อผิดพลาด', 'danger');
          window.restoreBtn(btn);
        }
      });
      window.runOcrExtract = function(btn){ ocrExtractInto(btn, 'fileInput', 'ocrResult', document.getElementById('docForm')); };
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'สร้างเอกสารใหม่', path: '/documents/new', content }));
}));

async function saveAttachment({ documentId, fileName, fileType, fileDataBase64, uploadedBy }) {
  if (!fileDataBase64) return null;
  if (!ALLOWED_MIME.has(fileType)) throw httpError(400, 'อนุญาตเฉพาะไฟล์ PDF เท่านั้น');
  const buf = Buffer.from(fileDataBase64, 'base64');
  if (buf.length > MAX_FILE_BYTES) throw httpError(413, 'ไฟล์มีขนาดใหญ่เกิน 10MB');
  // magic-number check (file signature), not just declared MIME type
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'ไฟล์ไม่ใช่ PDF ที่ถูกต้อง (ตรวจสอบ file signature ไม่ผ่าน)');
  const hash = createHash('sha256').update(buf).digest('hex');
  const dup = db.prepare('SELECT a.*, d.doc_number_display FROM attachments a JOIN documents d ON d.id = a.document_id WHERE a.hash_sha256 = ?').get(hash);
  const id = uuid();
  const safeName = `${id}.pdf`;

  let storageProvider = 'local';
  let filepath = null;
  let driveFileId = null;

  if (isGoogleDriveEnabled()) {
    const doc = db.prepare(`
      SELECT d.year_be, dt.name as type_name FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id WHERE d.id = ?
    `).get(documentId);
    const folderId = await ensureCategoryFolder({ yearBe: doc.year_be, typeName: doc.type_name });
    driveFileId = await uploadFile({ buffer: buf, filename: `${safeName}__${fileName || 'document.pdf'}`, mimeType: fileType, folderId });
    storageProvider = 'google_drive';
  } else {
    fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buf);
    filepath = safeName;
  }

  db.prepare(`
    INSERT INTO attachments (id, document_id, filename, storage_provider, filepath, drive_file_id, filesize, mime_type, hash_sha256, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, documentId, fileName || 'document.pdf', storageProvider, filepath, driveFileId, buf.length, fileType, hash, uploadedBy, nowIso());
  audit({ userId: uploadedBy, action: 'attachment_uploaded', tableName: 'attachments', recordId: id, detail: { documentId, hash, storageProvider, duplicateOf: dup ? dup.doc_number_display : null } });
  return { id, duplicateWarning: dup ? `พบไฟล์นี้ซ้ำกับเอกสาร ${dup.doc_number_display} (Hash ตรงกัน)` : null };
}

// ---------------- OCR auto-fill (Tesseract, best-effort — ผู้ใช้ต้องตรวจสอบก่อนบันทึกเสมอ) ----------------
router.post('/documents/ocr-extract', requireApi(async (ctx) => {
  const { fileType, fileDataBase64 } = ctx.body;
  if (!fileDataBase64) throw httpError(400, 'ไม่พบไฟล์ที่จะอ่าน');
  if (fileType !== 'application/pdf') throw httpError(400, 'อนุญาตเฉพาะไฟล์ PDF เท่านั้น');
  const buf = Buffer.from(fileDataBase64, 'base64');
  if (buf.length > MAX_OCR_BYTES) throw httpError(413, `ไฟล์มีขนาดใหญ่เกิน ${MAX_OCR_BYTES / 1024 / 1024}MB (OCR อ่านแค่ 2 หน้าแรกเท่านั้น ถ้าเป็นไฟล์สแกนหลายหน้า ลองครอปเฉพาะหน้าแรกมาลองใหม่ได้)`);
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'ไฟล์ไม่ใช่ PDF ที่ถูกต้อง (ตรวจสอบ file signature ไม่ผ่าน)');

  const text = await extractTextFromPdf(buf);
  const fields = guessFieldsFromText(text);
  audit({ userId: ctx.user.id, action: 'ocr_extract_attempted', tableName: 'documents', recordId: null, detail: { textLength: text.length } });
  json(ctx, 200, fields);
}));

// ---------------- create ----------------
router.post('/documents', requireApi(async (ctx) => {
  const b = ctx.body;
  if (!b.title || !b.correspondentName || !b.departmentId) {
    throw httpError(400, 'กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน (ชื่อเรื่อง, หน่วยงาน, ฝ่าย)');
  }
  const doc = createDocument({
    direction: b.direction === 'outgoing' ? 'outgoing' : 'incoming',
    title: b.title.trim(), subject: b.subject?.trim(), docTypeId: defaultDocTypeId(), departmentId: b.departmentId,
    priority: b.priority, secretLevel: b.secretLevel, correspondentName: b.correspondentName.trim(),
    externalDocNumber: b.externalDocNumber?.trim(), externalDocDate: b.externalDocDate || null, dueDate: b.dueDate || null,
    retentionClass: b.retentionClass, customDocNumber: b.customDocNumber?.trim() || null, createdBy: ctx.user.id,
  });
  const warnParts = [];
  if (doc.duplicateDocNumberWarning) warnParts.push(doc.duplicateDocNumberWarning);
  if (b.fileDataBase64) {
    const att = await saveAttachment({ documentId: doc.id, fileName: b.fileName, fileType: b.fileType, fileDataBase64: b.fileDataBase64, uploadedBy: ctx.user.id });
    if (att?.duplicateWarning) warnParts.push(att.duplicateWarning);
  }
  const warn = warnParts.length ? `&warn=${encodeURIComponent(warnParts.join(' / '))}` : '';
  json(ctx, 201, { redirect: `/documents/${doc.id}?created=1${warn}` });
}));

router.post('/documents/:id/attachments', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  const att = await saveAttachment({ documentId: doc.id, fileName: ctx.body.fileName, fileType: ctx.body.fileType, fileDataBase64: ctx.body.fileDataBase64, uploadedBy: ctx.user.id });
  json(ctx, 200, { redirect: `/documents/${doc.id}${att?.duplicateWarning ? '?warn=' + encodeURIComponent(att.duplicateWarning) : ''}` });
}));

// ---------------- print view: หนังสือ/บันทึกข้อความรูปแบบทางการ พร้อมลายเซ็นทุกขั้นตอน ----------------
// รูปแบบอ้างอิงระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ พ.ศ. 2526 ภาคผนวก 4 (บันทึกข้อความ):
// ส่วนราชการ / ที่ / วันที่ / เรื่อง / เรียน ตามลำดับ ตามด้วยเนื้อความ แล้วจบด้วยบล็อกลงชื่อ-ตำแหน่ง
router.get('/documents/:id/print', requirePage((ctx) => {
  const doc = db.prepare(`
    SELECT d.*, dt.name as type_name, dep.name as dept_name, u.first_name as creator_first, u.last_name as creator_last
    FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id JOIN departments dep ON dep.id = d.department_id
    JOIN users u ON u.id = d.created_by WHERE d.id = ? AND d.deleted_at IS NULL
  `).get(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) {
    return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบเอกสาร', path: '/documents',
      content: emptyState('🔍', 'ไม่พบเอกสารนี้ หรือคุณไม่มีสิทธิ์เข้าถึง') }));
  }
  const steps = getWorkflowSteps(doc.id);
  const signedSteps = steps.filter((s) => ['approved', 'acknowledged'].includes(s.status) && s.signature_image);

  // เรียน: หนังสือส่ง -> หน่วยงาน/บุคคลปลายทางจริง; หนังสือรับ -> ผู้รับขั้นแรกในสายงาน (คนที่บันทึกนี้
  // ถูกเสนอให้ภายในโรงเรียน) เพราะ correspondent_name ของหนังสือรับคือ "ผู้ส่งจากภายนอก" ไม่ใช่ผู้รับ
  const addressee = doc.direction === 'outgoing'
    ? doc.correspondent_name
    : (steps[0] ? `${steps[0].prefix || ''}${steps[0].first_name} ${steps[0].last_name}` : 'ผู้เกี่ยวข้อง');

  const referenceLine = doc.direction === 'incoming'
    ? `<p>อ้างถึง หนังสือจาก ${esc(doc.correspondent_name)}${doc.external_doc_number ? ` ที่ ${esc(doc.external_doc_number)}` : ''}${doc.external_doc_date ? ` ลงวันที่ ${fmtThaiDateLong(doc.external_doc_date)}` : ''}</p>`
    : '';

  const signatureBlocksHtml = signedSteps.length ? signedSteps.map((s) => `
    <div class="sig-block">
      <img src="${esc(s.signature_image)}" alt="ลายเซ็น ${esc(s.first_name)} ${esc(s.last_name)}" />
      <div class="sig-line">(${esc(s.prefix || '')}${esc(s.first_name)} ${esc(s.last_name)})</div>
      ${s.position ? `<div class="sig-line">${esc(s.position)}</div>` : ''}
      <div class="sig-line">${fmtThaiDateLong(s.decided_at)}</div>
    </div>`).join('') : '<p class="text-muted" style="text-align:center;padding:1rem 0">ยังไม่มีผู้ลงนามในขั้นตอนใดเลย</p>';

  const content = `<!doctype html>
<html lang="th"><head><meta charset="utf-8" />
<title>${esc(doc.doc_number_display)} — พิมพ์เอกสาร</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans Thai", "TH Sarabun New", "Sarabun", sans-serif; font-size: 16pt; line-height: 1.7; max-width: 210mm; margin: 0 auto; padding: 20mm 20mm; color: #111; }
  .toolbar { display: flex; justify-content: flex-end; gap: .5rem; margin-bottom: 1.5rem; }
  .toolbar button, .toolbar a { font-family: inherit; font-size: 11pt; padding: .5rem 1rem; border-radius: 8px; border: 1px solid #ccc; background: #f4f4f4; cursor: pointer; text-decoration: none; color: #111; }
  h1 { text-align: center; font-size: 22pt; margin: 0 0 1.2rem; }
  .header-row { display: flex; justify-content: space-between; gap: 1rem; }
  .field-label { font-weight: 700; }
  p { margin: .3rem 0; }
  .body-text { margin: 1.2rem 0; text-indent: 2.5em; white-space: pre-wrap; }
  .sig-block { text-align: center; margin: 0 0 0 auto; width: 220px; margin-top: 2.5rem; }
  .sig-block img { max-height: 70px; max-width: 200px; }
  .sig-line { border-top: 1px dotted #111; margin-top: .3rem; padding-top: .2rem; font-size: 14pt; }
  .sig-block .sig-line:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
  @media print {
    .toolbar { display: none; }
    body { padding: 0; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <a href="/documents/${doc.id}">← กลับหน้าเอกสาร</a>
    <button onclick="window.print()">🖨️ พิมพ์ / บันทึกเป็น PDF</button>
  </div>
  <h1>บันทึกข้อความ</h1>
  <p><span class="field-label">ส่วนราชการ</span> ${esc(doc.dept_name)} ${esc(SCHOOL_NAME)}</p>
  <div class="header-row">
    <p><span class="field-label">ที่</span> ${esc(doc.doc_number_display)}</p>
    <p><span class="field-label">วันที่</span> ${fmtThaiDateLong(doc.created_at)}</p>
  </div>
  <p><span class="field-label">เรื่อง</span> ${esc(doc.title)}</p>
  <p><span class="field-label">เรียน</span> ${esc(addressee)}</p>
  ${referenceLine}
  <div class="body-text">${esc(doc.subject || doc.title)}</div>
  ${signatureBlocksHtml}
</body></html>`;
  html(ctx, 200, content);
}));

// ---------------- detail ----------------
router.get('/documents/:id', requirePage((ctx) => {
  const doc = db.prepare(`
    SELECT d.*, dt.name as type_name, dep.name as dept_name, u.first_name as creator_first, u.last_name as creator_last
    FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id JOIN departments dep ON dep.id = d.department_id
    JOIN users u ON u.id = d.created_by WHERE d.id = ? AND d.deleted_at IS NULL
  `).get(ctx.params.id);

  if (!doc || !canUserSeeDocument(ctx.user, doc)) {
    return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบเอกสาร', path: '/documents',
      content: emptyState('🔍', 'ไม่พบเอกสารนี้ หรือคุณไม่มีสิทธิ์เข้าถึง') }));
  }

  const attachments = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at').all(doc.id);
  const steps = getWorkflowSteps(doc.id);
  const step = currentStep(doc.id);
  const comments = db.prepare(`
    SELECT c.*, u.first_name, u.last_name FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.document_id = ? ORDER BY c.created_at`).all(doc.id);

  const isDirectAssignee = step && step.assignee_id === ctx.user.id;
  // "รักษาการแทน" — ถ้าไม่ใช่ผู้ถูกมอบหมายโดยตรง เช็คว่าเป็นผู้รักษาการแทนคนที่ถือขั้นตอนนี้อยู่หรือไม่
  const delegationForStep = !isDirectAssignee && step ? getActiveDelegateFor(step.assignee_id) : null;
  const isDelegateForStep = !!(delegationForStep && delegationForStep.delegate_id === ctx.user.id);
  const isCurrentAssignee = isDirectAssignee || isDelegateForStep;
  const stepAssignee = step ? db.prepare('SELECT prefix, first_name, last_name FROM users WHERE id = ?').get(step.assignee_id) : null;
  // ข้อความหัวกล่องความเห็นในตัวอย่างบนเว็บ ต้องตรงกับที่จะฝังจริงตอนกดปุ่ม (ดู stampDirectorDecisionIfApplicable)
  const decisionBoxMode = step ? directorTitleMode(step.id, ctx.user) : 'generic';
  const decisionBoxTitleHtml = decisionBoxMode === 'director' ? esc(`ผู้อำนวยการ${SCHOOL_NAME}`)
    : decisionBoxMode === 'acting_director' ? esc('รักษาการในตำแหน่งผู้อำนวยการสถานศึกษา') + '<br/>' + esc(SCHOOL_NAME)
    : esc(SCHOOL_NAME);
  // เฉพาะ ผอ. ตัวจริง/ผู้รักษาการแทน ผอ. เท่านั้นที่มีเมนูตัดสินใจแบบเต็ม (checkbox ตราประทับ, ความเห็น,
  // อนุมัติ/ไม่อนุมัติ/ส่งกลับแก้ไข) — คนอื่นในสาย workflow มีแค่ "ทราบ" กับ "มอบหมายให้" พอ เพราะตราประทับ
  // ความเห็นทางการเป็นของ ผอ. คนเดียว ไม่ใช่ของทุกคนที่ผ่านเรื่อง
  const isDirectorDecision = decisionBoxMode === 'director' || decisionBoxMode === 'acting_director';
  // ธุรการต้องเขียนความเห็นเสนอ ผอ. ด้วย — เงื่อนไขเดียวกับที่บังคับฝั่งเซิร์ฟเวอร์ใน
  // canWriteRegistrarComment() เพื่อไม่ให้ช่องกรอกโผล่มาแล้วกดไปเงียบๆ โดยไม่มีอะไรติดลงไฟล์
  const isRegistrarComment = !!step && !isDirectorDecision && ctx.user.roleCodes.includes('registrar');
  const isCreatorOrAdmin = doc.created_by === ctx.user.id || ctx.user.roleCodes.includes('admin');
  const canAssign = ['registered', 'returned'].includes(doc.status) && isCreatorOrAdmin;
  const canVoid = ['draft', 'registered'].includes(doc.status) && isCreatorOrAdmin;
  const canArchive = doc.status === 'completed' && isCreatorOrAdmin;
  const canForceDelete = ctx.user.roleCodes.includes('admin');

  const timelineHtml = steps.length ? `<ul class="timeline">
    ${steps.map((s) => {
      const cls = s.status === 'waiting' ? '' : (s.status === 'rejected' || s.status === 'returned' ? 'rejected' : 'done');
      const statusText = { waiting: 'รอดำเนินการ', approved: 'อนุมัติ ส่งต่อแล้ว', acknowledged: 'รับทราบ/เสร็จสิ้น', rejected: 'ไม่อนุมัติ', returned: 'ส่งกลับแก้ไข' }[s.status];
      const showSignature = ['approved', 'acknowledged'].includes(s.status) && s.signature_image;
      return `<li class="${cls}">
        <div class="t-title">ขั้นที่ ${s.step_order}: ${esc(s.prefix || '')}${esc(s.first_name)} ${esc(s.last_name)} — ${statusText}</div>
        <div class="t-meta">มอบหมาย ${fmtDate(s.created_at)}${s.decided_at ? ' · ดำเนินการ ' + fmtDate(s.decided_at) : ''}</div>
        ${s.instruction ? `<div class="t-note">${esc(s.instruction).replace(/\n/g, '<br/>')}</div>` : ''}
        ${showSignature ? `
        <div class="t-note" style="text-align:center;max-width:220px;margin-top:.4rem;color:var(--primary)">
          <img src="${esc(s.signature_image)}" alt="ลายเซ็น ${esc(s.first_name)} ${esc(s.last_name)}" style="max-height:60px;max-width:180px" />
          <div style="border-top:1px solid var(--primary);padding-top:.25rem;font-size:.82rem">
            <div>(${esc(s.prefix || '')}${esc(s.first_name)} ${esc(s.last_name)})</div>
            ${s.position ? `<div>${esc(s.position)}</div>` : ''}
            <div>${fmtThaiDateLong(s.decided_at)}</div>
          </div>
        </div>` : ''}
      </li>`;
    }).join('')}
  </ul>` : emptyState('🕒', 'ยังไม่มีการมอบหมายงาน (Workflow)');

  const actionBox = isCurrentAssignee ? `
    <div class="card" style="border-color:var(--primary)">
      <h3>ดำเนินการ (ขั้นที่ ${step.step_order} — มอบหมายให้คุณ)</h3>
      ${isDelegateForStep ? `<div class="alert alert-warning" style="margin-bottom:.8rem">
        🪪 คุณกำลังดำเนินการแทน <strong>${esc(stepAssignee?.prefix || '')}${esc(stepAssignee?.first_name)} ${esc(stepAssignee?.last_name)}</strong>
        ในฐานะผู้รักษาการแทน (${esc(fmtThaiDateShort(delegationForStep.start_date))} — ${esc(fmtThaiDateShort(delegationForStep.end_date))}${delegationForStep.reason ? ' · ' + esc(delegationForStep.reason) : ''})
      </div>` : ''}
      <div class="stack">
        <div>
          <label><span class="step-num">1</span> ${isDirectorDecision ? 'ส่งต่อ/อนุมัติไปยัง' : 'มอบหมายให้'} <span class="text-muted" style="font-weight:400">(ไม่เลือกก็ได้ ถ้าจบที่คุณ)</span></label>
          <select id="nextAssignee"><option value="">— ไม่ส่งต่อ จบเรื่องที่ฉัน —</option>${listUserOptions(ctx.user.id)}</select>
        </div>
        <div class="field">
          <label><span class="step-num">2</span> ความเห็น/ข้อความเกษียณ</label>
          <div class="chip-row" style="margin-bottom:.4rem">
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('เห็นชอบ')">เห็นชอบ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('อนุมัติ')">อนุมัติ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('ทราบ')">ทราบ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('มอบฝ่าย', ' ดำเนินการ')">มอบฝ่าย...ดำเนินการ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('เพื่อพิจารณา')">เพื่อพิจารณา</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('เพื่อทราบและดำเนินการ')">เพื่อทราบและดำเนินการ</button>
          </div>
          <textarea id="stepComment" placeholder="กดปุ่มด้านบนเพื่อใส่ข้อความสำเร็จรูป แล้วพิมพ์เพิ่มได้ หรือพิมพ์เองทั้งหมด"></textarea>
          <details class="help-details">
            <summary>คำไหนใช้ตอนไหน?</summary>
            <div class="help-text">
              <strong>อนุมัติ</strong> — ใช้อำนาจตามระเบียบ เช่น อนุมัติโครงการ/งบประมาณ<br/>
              <strong>เห็นชอบ</strong> — เห็นด้วยกับหลักการ แล้วให้หน่วยที่เกี่ยวข้องไปจัดทำรายละเอียดต่อ<br/>
              <strong>ทราบ</strong> — รับทราบเฉยๆ ไม่ได้สั่งการเพิ่ม
            </div>
          </details>
        </div>
        ${attachments.length && isRegistrarComment ? `
        <div class="field">
          <div class="flex items-center justify-between gap-2" style="flex-wrap:nowrap">
            <label style="margin-bottom:0"><span class="step-num">3</span> ความเห็นธุรการ เสนอ ผอ. <span class="text-muted" style="font-weight:400">(เว้นว่างได้)</span></label>
            <button type="button" class="btn btn-outline btn-sm" style="flex:0 0 auto;white-space:nowrap" onclick="window.clearRegistrarNote()">🗑️ ล้างค่า</button>
          </div>
          <div class="chip-row" style="margin:.4rem 0">
            <button type="button" class="btn btn-outline btn-sm" onclick="insertRegistrarPhrase('เพื่อโปรดทราบ')">เพื่อโปรดทราบ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertRegistrarPhrase('เพื่อโปรดพิจารณา')">เพื่อโปรดพิจารณา</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertRegistrarPhrase('เห็นควรมอบ', 'ดำเนินการ')">เห็นควรมอบ...ดำเนินการ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertRegistrarPhrase('เห็นควรแจ้งคณะครูทราบโดยทั่วกัน')">แจ้งคณะครูทราบ</button>
          </div>
          <textarea id="registrarNote" placeholder="พิมพ์ความเห็นที่จะเสนอ ผอ. — จะขึ้นบนไฟล์ PDF จริงมุมขวาล่าง"
                    oninput="window.updateRegistrarPreview && window.updateRegistrarPreview()"></textarea>
          <div class="callout-tip">
            ✍️ ระบบจะพิมพ์ลงไฟล์ PDF จริงให้เป็น 3 ส่วน — บรรทัดแรก <strong>“เรียนผู้อำนวยการโรงเรียน”</strong>
            บรรทัดถัดมาคือความเห็นที่พิมพ์ไว้ แล้วปิดท้ายด้วย<strong>ลายเซ็นและตำแหน่งของคุณ</strong>
            ${ctx.user.signature_image ? '' : '<br/><span style="color:var(--danger)">⚠️ คุณยังไม่ได้บันทึกลายเซ็นในโปรไฟล์ — ความเห็นจะขึ้นแต่จะไม่มีลายเซ็น</span>'}
          </div>
        </div>` : ''}
        ${attachments.length && isDirectorDecision ? `
        <div class="field">
          <label><span class="step-num">3</span> เครื่องหมายบนตราประทับ <span class="text-muted" style="font-weight:400">(ติ๊กได้หลายอัน — เฉพาะอันที่ติ๊กจะขึ้นบนตราใน PDF จริง)</span></label>
          <div class="stack" style="gap:.35rem">
            ${(() => {
              const tick = (m) => `<input type="checkbox" class="decisionMark" value="${esc(m.value)}" onchange="window.updateDecisionMarksPreview && window.updateDecisionMarksPreview()" />`;
              const body = (m) => (m.fillable
                ? `<span>แจ้งให้</span>
                   <input type="text" id="decisionNotify" placeholder="ระบุชื่อ/ฝ่าย" style="max-width:180px"
                          oninput="window.updateDecisionMarksPreview && window.updateDecisionMarksPreview()" />
                   <span>ทราบ</span>`
                : esc(m.label));
              // อนุญาต/ไม่อนุญาต และ อนุมัติ/ไม่อนุมัติ วางคู่กันในบรรทัดเดียวเหมือนตรายางจริง —
              // ตัวที่ถูกจับคู่เข้าไปแล้ว (pairedInto) ไม่ต้องขึ้นเป็นบรรทัดของตัวเองซ้ำอีก
              return DECISION_MARK_OPTIONS.filter((m) => !m.pairedInto).map((m) => {
                const pair = m.pairWith && DECISION_MARK_OPTIONS.find((x) => x.value === m.pairWith);
                return `<label style="display:flex;align-items:center;gap:.4rem;font-weight:400;cursor:pointer">
                  ${tick(m)}${body(m)}
                  ${pair ? `<span style="width:.9rem"></span>${tick(pair)}${esc(pair.label)}` : ''}
                </label>`;
              }).join('');
            })()}
          </div>
        </div>
        <div class="field">
          <div class="flex items-center justify-between gap-2" style="flex-wrap:nowrap">
            <label style="margin-bottom:0"><span class="step-num">4</span> ข้อความบนตราประทับ "เห็นควรให้..." <span class="text-muted" style="font-weight:400">(เว้นว่างได้)</span></label>
            <button type="button" class="btn btn-outline btn-sm" style="flex:0 0 auto;white-space:nowrap" onclick="window.clearDecisionInputs()">🗑️ ล้างค่า</button>
          </div>
          <textarea id="decisionNote" placeholder="พิมพ์ข้อความที่จะแสดงบนตราประทับในไฟล์ PDF จริง" oninput="window.updateDecisionMarksPreview && window.updateDecisionMarksPreview()"></textarea>
          <div class="callout-tip">
            💡 อยากเลือกตำแหน่งตราประทับเอง? กด <strong>👁️ ดูตัวอย่าง</strong> ที่ไฟล์แนบไฟล์แรก แล้วลากกล่องไปวางตรงที่ต้องการ
            <span class="text-muted">— ถ้าไม่ลาก ระบบจะวางตำแหน่งเริ่มต้นให้อัตโนมัติ</span>
          </div>
          <div class="help-text">ติ๊กผิด/พิมพ์ผิดกด "ล้างค่า" ได้ทุกเมื่อ ยังไม่มีผลจนกว่าจะกดปุ่มด้านล่าง</div>
        </div>` : ''}
        <div class="action-buttons">
          ${isDirectorDecision ? `
          <button class="btn btn-success btn-lg" data-pin-title="ยืนยัน PIN เพื่ออนุมัติและส่งต่อ" onclick="doApprove(this)">✅ อนุมัติและส่งต่อ</button>
          <button class="btn btn-primary btn-lg" data-pin-title="ยืนยัน PIN เพื่อรับทราบและปิดเรื่อง" onclick="doAcknowledge(this)">✔️ รับทราบ/ปิดเรื่อง</button>
          <div class="action-buttons-secondary">
            <button class="btn btn-outline btn-sm" onclick="actionWithReason(this, '/documents/${doc.id}/workflow/${step.id}/return', 'ระบุเหตุผลที่ส่งกลับแก้ไข')">↩️ ส่งกลับแก้ไข</button>
            <button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="doReject(this)">✖️ ไม่อนุมัติ</button>
          </div>` : `
          <button class="btn btn-success btn-lg" data-pin-title="ยืนยัน PIN เพื่อมอบหมายให้" onclick="doApprove(this)">➡️ มอบหมายให้</button>
          <button class="btn btn-primary btn-lg" data-pin-title="ยืนยัน PIN เพื่อทราบ" onclick="doAcknowledge(this)">✔️ ทราบ</button>`}
        </div>
        <div class="help-text" style="text-align:center">ทุกปุ่มต้องยืนยันด้วย PIN 6 หลักก่อนเสมอ</div>
      </div>
    </div>
    <script>
      // ตำแหน่งที่ลากไว้ (window.markPos/window.decisionPos จาก script ของกล่องไฟล์แนบด้านบน) — undefined
      // ถ้าไม่เคยกดดูตัวอย่าง/ไม่เคยลาก ให้ปล่อยเป็น undefined เพื่อให้ฝั่งเซิร์ฟเวอร์ใช้ตำแหน่งเริ่มต้นเอง
      function stampPositionFields(){
        var f = {};
        if (window.markPos) { f.markX = window.markPos.x; f.markY = window.markPos.y; }
        if (window.decisionPos) { f.decisionX = window.decisionPos.x; f.decisionY = window.decisionPos.y; }
        var noteEl = document.getElementById('decisionNote');
        if (noteEl && noteEl.value.trim()) f.decisionNote = noteEl.value.trim();
        var checkedMarks = Array.prototype.slice.call(document.querySelectorAll('.decisionMark:checked')).map(function (el) { return el.value; });
        if (checkedMarks.length) f.decisionMarks = checkedMarks;
        var notifyEl = document.getElementById('decisionNotify');
        if (notifyEl && notifyEl.value.trim()) f.decisionNotify = notifyEl.value.trim();
        var regEl = document.getElementById('registrarNote');
        if (regEl && regEl.value.trim()) f.registrarNote = regEl.value.trim();
        if (window.registrarPos) { f.registrarX = window.registrarPos.x; f.registrarY = window.registrarPos.y; }
        return f;
      }
      // แทรกคำที่ธุรการใช้บ่อยลงในช่องความเห็นเสนอ ผอ. — ทำงานแบบเดียวกับ insertQuickPhrase ของช่องเกษียณ
      function insertRegistrarPhrase(head, tail){
        var el = document.getElementById('registrarNote');
        var sep = el.value.trim() ? '\\n' : '';
        var insertPos = el.value.length + sep.length + head.length;
        el.value = el.value + sep + head + (tail || '');
        el.focus();
        el.setSelectionRange(insertPos, insertPos);
        if (window.updateRegistrarPreview) window.updateRegistrarPreview();
      }
      // เตือนถ้าเป็น ผอ. (มี checkbox ให้ติ๊ก) แต่ยังไม่ได้ติ๊กอะไรเลย — เผื่อลืมติ๊กเพราะเป็นคนละจุดกับปุ่ม
      // ดำเนินการ ไม่บล็อก แค่ถามยืนยันอีกที ถ้าไม่ใช่ ผอ. (ไม่มี checkbox ในหน้าเลย) ผ่านไปได้ปกติ
      function confirmIfNoMarksChecked(){
        var allMarks = document.querySelectorAll('.decisionMark');
        if (!allMarks.length || document.querySelectorAll('.decisionMark:checked').length) return true;
        return confirm('คุณยังไม่ได้ติ๊กเครื่องหมายใดๆ บนตราประทับเลย ต้องการดำเนินการต่อโดยไม่ติ๊กเครื่องหมายหรือไม่?');
      }
      function doApprove(btn){
        var next = document.getElementById('nextAssignee').value;
        var comment = document.getElementById('stepComment').value;
        if (!next) { toast('กรุณาเลือกผู้รับที่จะส่งต่อ ก่อนกดอนุมัติ (ถ้าเป็นผู้รับคนสุดท้ายให้กด "รับทราบ/ปิดเรื่อง" แทน)', 'warning'); return; }
        if (!confirmIfNoMarksChecked()) return;
        actionWithPin(btn, '/documents/${doc.id}/workflow/${step.id}/approve', Object.assign({ nextAssigneeId: next, comment: comment }, stampPositionFields()));
      }
      function doAcknowledge(btn){
        if (!confirmIfNoMarksChecked()) return;
        var comment = document.getElementById('stepComment').value;
        actionWithPin(btn, '/documents/${doc.id}/workflow/${step.id}/acknowledge', Object.assign({ comment: comment }, stampPositionFields()), '/?celebrate=1');
      }
      function doReject(btn){
        if (!confirmIfNoMarksChecked()) return;
        actionWithReason(btn, '/documents/${doc.id}/workflow/${step.id}/reject', 'ระบุเหตุผลที่ไม่อนุมัติ', stampPositionFields());
      }
      // แทรกคำเกษียณมาตรฐานลงในกล่องข้อความ — ไม่ทับของเดิม เพิ่มขึ้นบรรทัดใหม่ พิมพ์ต่อได้ตามปกติ
      // ถ้ามี tailText (เช่น "มอบฝ่าย...ดำเนินการ") จะวางเคอร์เซอร์ไว้ระหว่างกลางให้พิมพ์ชื่อฝ่ายแทรกได้เลย
      function insertQuickPhrase(head, tail){
        var el = document.getElementById('stepComment');
        var sep = el.value.trim() ? '\\n' : '';
        var insertPos = el.value.length + sep.length + head.length;
        el.value = el.value + sep + head + (tail || '');
        el.focus();
        el.setSelectionRange(insertPos, insertPos);
      }
    </script>` : '';

  const assignBox = canAssign ? `
    <div class="card">
      <h3>${doc.status === 'returned' ? 'แก้ไขแล้วเสนอใหม่' : 'เสนอ / มอบหมายงาน'}</h3>
      <div class="stack">
        <div>
          <label>มอบหมายให้</label>
          <select id="assignTo">${listUserOptions(ctx.user.id)}</select>
        </div>
        <div class="field">
          <label>ข้อความ/คำสั่ง</label>
          <textarea id="assignInstruction" placeholder="เช่น เพื่อโปรดพิจารณา"></textarea>
        </div>
        <button class="btn btn-primary" onclick="doAssign(this)">เสนอ</button>
      </div>
    </div>
    <script>
      function doAssign(btn){
        var assigneeId = document.getElementById('assignTo').value;
        var instruction = document.getElementById('assignInstruction').value;
        btn.disabled = true;
        fetch('/documents/${doc.id}/assign', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({assigneeId, instruction}) })
          .then(r => r.json().then(d => ({ok: r.ok, d})))
          .then(({ok, d}) => { if(!ok) throw new Error(d.error); location.reload(); })
          .catch(e => { toast(e.message, 'danger'); btn.disabled = false; });
      }
    </script>` : '';

  // ป้าย "เลยกำหนด/อีกกี่วัน" ขึ้นไปอยู่บนหัวเรื่องเลย เพราะเป็นข้อมูลที่ตัดสินใจว่าจะทำก่อนหรือหลัง —
  // เดิมวันครบกำหนดซ่อนอยู่กลางตารางรายละเอียด และแสดงเป็นวันที่ดิบ (2026-08-25) ไม่มีบอกว่าเหลือกี่วัน
  const docStillOpen = !['completed', 'archived', 'voided', 'destroyed', 'rejected'].includes(doc.status);
  const dueSummaryChip = doc.due_date && docStillOpen
    ? `<span class="badge ${daysUntil(doc.due_date) < 0 ? 'badge-danger' : daysUntil(doc.due_date) <= 3 ? 'badge-warning' : 'badge-muted'}">⏰ ครบกำหนด ${esc(fmtThaiDateShort(doc.due_date))}${
        daysUntil(doc.due_date) < 0 ? ` (เลยมาแล้ว ${Math.abs(daysUntil(doc.due_date))} วัน)`
          : daysUntil(doc.due_date) === 0 ? ' (วันนี้)' : ` (อีก ${daysUntil(doc.due_date)} วัน)`}</span>`
    : '';

  const content = `
    ${ctx.query.created ? '<div class="alert alert-success">✅ บันทึกและออกเลขเอกสารเรียบร้อยแล้ว</div>' : ''}
    ${ctx.query.warn ? `<div class="alert alert-warning">⚠️ ${esc(ctx.query.warn)}</div>` : ''}
    <div class="card-header">
      <div>
        <h2 class="mt-0"><span style="color:var(--primary)">${esc(doc.doc_number_display)}</span> — ${esc(doc.title)}</h2>
        <div class="chip-row">${statusBadge(doc.status)}${priorityBadge(doc.priority)}${
          // แสดงป้ายชั้นความลับเฉพาะตอนที่ "ไม่ปกติ" — เดิมขึ้น "ปกติ" ต่อท้าย "ด่วน" เสมอ
          // อ่านแล้วขัดกันเอง (ด่วน ปกติ?) ทั้งที่คนละเรื่องกัน และเป็นค่าที่ไม่ได้บอกอะไรเลย
          doc.secret_level !== 'normal' ? secretBadge(doc.secret_level) : ''
        }${dueSummaryChip}</div>
      </div>
      <div class="chip-row">
        <a class="btn btn-outline btn-sm" href="${attachments.length ? `/files/${attachments[0].id}` : `/documents/${doc.id}/print`}" target="_blank" rel="noopener">🖨️ พิมพ์เอกสาร${attachments.length ? ' (PDF ที่บันทึกไว้)' : ''}</a>
        ${attachments.length ? `<a class="btn btn-outline btn-sm" href="/documents/${doc.id}/print" target="_blank" rel="noopener">📝 บันทึกข้อความ/สรุปลายเซ็น</a>` : ''}
        ${canVoid ? `<button class="btn btn-outline btn-sm" onclick="actionWithReason(this, '/documents/${doc.id}/void', 'ระบุเหตุผลที่ยกเลิกเอกสาร (เลขที่จะยังคงอยู่ในลำดับ ไม่ถูกนำไปใช้ซ้ำ)')">ยกเลิกเอกสาร</button>` : ''}
        ${canArchive ? `<button class="btn btn-outline btn-sm" onclick="fetch('/documents/${doc.id}/archive',{method:'POST'}).then(()=>location.reload())">📦 จัดเก็บเข้าแฟ้ม</button>` : ''}
        ${canForceDelete ? `<button class="btn btn-danger btn-sm" onclick="forceDeleteThisDoc(this)">🗑️ ลบเอกสาร (แอดมิน)</button>` : ''}
      </div>
    </div>
    ${canForceDelete ? `<script>
      function forceDeleteThisDoc(btn){
        var reason = prompt('สำหรับผู้ดูแลระบบเท่านั้น: ระบุเหตุผลที่ลบเอกสารนี้ถาวร (ใช้กับเอกสารที่ผิดพลาด/ค้างจากบั๊กเท่านั้น เอกสารจริงควรใช้ปุ่มยกเลิก/ทำลายตามขั้นตอนปกติแทน)');
        if (reason === null) return;
        if (!confirm('ยืนยันลบเอกสารนี้ถาวร? การกระทำนี้ย้อนกลับไม่ได้')) return;
        btn.disabled = true;
        fetch('/documents/${doc.id}/force-delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({reason: reason}) })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if(!res.ok) throw new Error(res.d.error); window.location.href = '/documents'; })
          .catch(function(e){ toast(e.message, 'danger'); btn.disabled = false; });
      }
    </script>` : ''}

    <div class="grid-2 doc-detail-grid">
      <div class="doc-main">
        <div class="card">
          <h3>รายละเอียด</h3>
          <table class="table-plain" style="min-width:0">
            <tbody>
              <tr><td class="text-muted">${doc.direction === 'incoming' ? 'หน่วยงานต้นทาง' : 'หน่วยงานปลายทาง'}</td><td>${esc(doc.correspondent_name)}</td></tr>
              ${doc.external_doc_number ? `<tr><td class="text-muted">เลขหนังสืออ้างอิง</td><td>${esc(doc.external_doc_number)}</td></tr>` : ''}
              ${doc.external_doc_date ? `<tr><td class="text-muted">ลงวันที่</td><td>${esc(fmtThaiDateLong(doc.external_doc_date))}</td></tr>` : ''}
              <tr><td class="text-muted">ฝ่าย</td><td>${esc(doc.dept_name)}</td></tr>
              ${doc.due_date ? `<tr><td class="text-muted">กำหนดเสร็จ</td><td>${docStillOpen ? dueCell(doc.due_date, { long: true }) : esc(fmtThaiDateLong(doc.due_date))}</td></tr>` : ''}
              <tr><td class="text-muted">อายุการเก็บ</td><td>${esc(RETENTION_LABEL[doc.retention_class] || doc.retention_class)}${doc.retention_until ? ` (ครบกำหนด ${esc(fmtThaiDateLong(doc.retention_until))})` : ''}</td></tr>
              <tr><td class="text-muted">ผู้บันทึก</td><td>${esc(doc.creator_first)} ${esc(doc.creator_last)}</td></tr>
              <tr><td class="text-muted">วันที่บันทึก</td><td>${fmtDate(doc.created_at)}</td></tr>
            </tbody>
          </table>
          ${doc.subject ? `<p style="margin-top:.75rem"><strong>สาระสำคัญ:</strong><br/>${esc(doc.subject).replace(/\n/g, '<br/>')}</p>` : ''}
          ${doc.void_reason ? `<div class="alert alert-danger">ยกเลิกแล้ว: ${esc(doc.void_reason)}</div>` : ''}
          ${doc.status === 'destroyed' ? `<div class="alert alert-danger">🗄️ ทำลายแล้วตามมติคณะกรรมการทำลายหนังสือ เมื่อ ${fmtDate(doc.destroyed_at)} (ไฟล์แนบถูกลบออกจากระบบถาวร รายการทะเบียน/เลขที่ยังคงอยู่เป็นหลักฐาน)</div>` : ''}
        </div>

        <div class="card">
          <div class="card-header"><h3 class="mt-0">ไฟล์แนบ (${attachments.length})</h3></div>
          ${attachments.length ? attachments.map((a, i) => `
            <div style="padding:.5rem 0;border-bottom:1px solid var(--border)">
              <div class="flex items-center justify-between flex-wrap gap-2">
                <div>📄 ${esc(a.filename)} <span class="text-muted" style="font-size:.78rem">(${Math.round(a.filesize / 1024)} KB)</span>
                  ${a.stamped_storage_provider ? '<span class="badge badge-success" style="margin-left:.4rem">✅ ประทับตราแล้ว</span>' : ''}
                </div>
                <div class="chip-row">
                  ${i === 0 && doc.direction === 'incoming' && isCreatorOrAdmin ? `<button type="button" class="btn btn-sm btn-primary" onclick="applyStamp('${a.id}', this)">🖋️ ประทับตราลงไฟล์ PDF จริง</button>` : ''}
                  <button type="button" class="btn btn-sm btn-outline" onclick="togglePreview('${a.id}')">👁️ ดูตัวอย่าง</button>
                  <a class="btn btn-sm btn-outline" href="/files/${a.id}" target="_blank" rel="noopener">เปิดแท็บใหม่</a>
                  ${a.stamped_storage_provider ? `<a class="btn btn-sm btn-outline" href="/files/${a.id}?original=1" target="_blank" rel="noopener">ดูต้นฉบับ (ไม่มีตรา)</a>` : ''}
                </div>
              </div>
              <div id="preview-${a.id}" style="display:none;margin-top:.6rem"></div>
            </div>`).join('') : emptyState('📎', 'ยังไม่มีไฟล์แนบ')}
          <script>
            // ตราประทับ "ลงรับ" ซ้อนบนตัวอย่าง PDF ของไฟล์แรกเท่านั้น (แนวทางเดียวกับที่โปรแกรมสารบรรณ
            // ทั่วไปทำ — ปั๊มตราบนเอกสารต้นฉบับ) เฉพาะหนังสือรับเท่านั้น ลากวางตำแหน่งได้ (บันทึกอัตโนมัติ
            // ตอนปล่อยเมาส์) — หมายเหตุ: นี่คือการซ้อนแสดงตอนดูในแอปเท่านั้น ไม่ได้ฝังลงในไฟล์ PDF จริง
            var STAMP_DIRECTION = ${JSON.stringify(doc.direction)};
            var STAMP_CAN_EDIT = ${isCreatorOrAdmin ? 'true' : 'false'};
            var STAMP_X = ${doc.stamp_x != null ? doc.stamp_x : 70};
            var STAMP_Y = ${doc.stamp_y != null ? doc.stamp_y : 3};
            var STAMP_HTML = '<div class="doc-stamp"' + (STAMP_CAN_EDIT ? ' id="docStamp" style="cursor:move;left:' : ' style="left:') + STAMP_X + '%;top:' + STAMP_Y + '%">' +
              '<div class="stamp-title">${esc(SCHOOL_NAME)}</div>' +
              '<div>เลขรับ......${esc(doc.doc_number_display)}......</div>' +
              '<div>วันที่......${stampDateThai(new Date(doc.created_at))}......</div>' +
              '<div>เวลา......${stampTimeThai(new Date(doc.created_at))}......</div>' +
            '</div>';
            // ต้องประกาศก่อนสร้าง MARK_HTML/DECISION_HTML/REGISTRAR_HTML ที่เอาค่านี้ไปใส่ใน style="top:..%"
            // — var ถูก hoist ขึ้นไปด้านบนก็จริง แต่ "ค่า" ยังเป็น undefined จนกว่าจะรันบรรทัดนี้ ถ้าอยู่ทีหลัง
            // จะได้ top:undefined% ซึ่งเป็น CSS ที่ใช้ไม่ได้ เบราว์เซอร์จะทิ้งทั้งบรรทัด แล้วกล่องจะไปกองอยู่
            // ท้ายพื้นที่ตัวอย่างแทนตำแหน่งจริงที่จะประทับ — ตัวอย่างกับของจริงต้องตรงกันเสมอ
            var DECISION_MAX_TOP = ${DECISION_MAX_TOP_PERCENT};
            // เครื่องหมาย "ทราบ" + ลายเซ็นของผู้ใช้คนปัจจุบัน (ถ้ามีลายเซ็นบันทึกไว้ในโปรไฟล์) — ลากวาง
            // ตำแหน่งเองได้ก่อนกดปุ่มอนุมัติ/รับทราบ/ไม่อนุมัติ ตำแหน่งจะถูกส่งไปพร้อมคำขอนั้นเลย ไม่บันทึก
            // แยกต่างหาก (ต่างจากตราลงรับที่บันทึกทันทีที่ปล่อยเมาส์ เพราะอันนี้ยังไม่ได้ "ตัดสินใจ" จริง)
            var CAN_MARK = ${(isCurrentAssignee && ctx.user.signature_image && !isDirectorDecision) ? 'true' : 'false'};
            var MARK_HTML = '<div class="doc-mark" id="ackMark" style="left:${DEFAULT_ACK_MARK_X_PERCENT}%;top:${step ? markStackYPercent(doc.id, step.id) : MARK_BASE_Y}%">' +
              '<div class="mark-word">ทราบ</div>' +
              ${ctx.user.signature_image ? `'<img src="${esc(ctx.user.signature_image)}" />' +` : "''+"}
              '<div class="mark-name">(${esc(ctx.user.prefix || '')}${esc(ctx.user.first_name)} ${esc(ctx.user.last_name)})</div>' +
            '</div>';
            // ความเห็นธุรการเสนอ ผอ. — มุมขวาล่าง ขอบบนตรงกับกรอบตราปั๊ม ผอ. (ใช้ DECISION_MAX_TOP ตัวเดียวกัน)
            var CAN_REGISTRAR = ${(isCurrentAssignee && isRegistrarComment) ? 'true' : 'false'};
            var REGISTRAR_HTML = '<div class="doc-registrar-note" id="registrarBox" style="left:${DEFAULT_REGISTRAR_X_PERCENT}%;top:' + DECISION_MAX_TOP + '%">' +
              '<div class="reg-lead">เรียนผู้อำนวยการโรงเรียน</div>' +
              '<div class="reg-body" id="registrarNotePreview"></div>' +
              ${ctx.user.signature_image ? `'<div class="sig"><img src="${esc(ctx.user.signature_image)}" /></div>' +` : "''+"}
              '<div class="reg-name">(${esc(ctx.user.prefix || '')}${esc(ctx.user.first_name)} ${esc(ctx.user.last_name)})</div>' +
              '<div class="reg-name">ตำแหน่ง<span class="fill">${esc(ctx.user.position || '')}</span></div>' +
            '</div>';
            // ให้ตัวอย่างบนเว็บตรงกับที่จะพิมพ์ลง PDF จริงเป๊ะ ผู้ใช้จะได้เห็นว่าความเห็นยาวเกินกรอบหรือยัง
            window.updateRegistrarPreview = function () {
              var el = document.getElementById('registrarNotePreview');
              if (!el) return;
              var input = document.getElementById('registrarNote');
              el.textContent = (input && input.value.trim()) || '(ยังไม่ได้พิมพ์ความเห็น)';
            };
            window.clearRegistrarNote = function () {
              var input = document.getElementById('registrarNote');
              if (input) input.value = '';
              window.updateRegistrarPreview();
            };
            var DECISION_HTML = '<div class="doc-decision-box" id="decisionBox" style="left:${DEFAULT_DECISION_X_PERCENT}%;top:' + DECISION_MAX_TOP + '%">' +
              '<div class="box-title">${decisionBoxTitleHtml}</div>' +
              '<div id="decisionMarksPreview"></div>' +
              '<div class="box-note" id="decisionNotePreview">ความเห็น ...</div>' +
              ${ctx.user.signature_image ? `'<div class="sig"><img src="${esc(ctx.user.signature_image)}" /></div>' +` : "''+"}
              '<div style="margin-top:.3rem">(${esc(ctx.user.prefix || '')}${esc(ctx.user.first_name)} ${esc(ctx.user.last_name)})</div>' +
            '</div>';
            // แสดงช่องติ๊กตามที่ผู้ใช้ติ๊กไว้จริงในกล่องด้านขวา ให้ตรงกับที่จะฝังลง PDF จริงเป๊ะ (ถ้อยคำและ
            // ลำดับต้องตรงกับ DECISION_MARK_OPTIONS และ stampDirectorDecision เสมอ) — เรียกทั้งตอนเปิด
            // "ดูตัวอย่าง" ครั้งแรก และทุกครั้งที่ติ๊ก/พิมพ์ (ถ้ายังไม่เปิดกล่อง ฟังก์ชันนี้จะไม่ทำอะไรเลย)
            window.updateDecisionMarksPreview = function () {
              var el = document.getElementById('decisionMarksPreview');
              if (!el) return;
              function cb(v) {
                var box = document.querySelector('.decisionMark[value="' + v + '"]');
                return '<span class="cb' + (box && box.checked ? ' on' : '') + '"></span>';
              }
              var notifyInput = document.getElementById('decisionNotify');
              var notify = (notifyInput && notifyInput.value.trim()) || '';
              el.innerHTML =
                '<div class="opt">' + cb('ทราบ') + 'ทราบ</div>' +
                '<div class="opt">' + cb('อนุญาต') + 'อนุญาต <span class="gap"></span>' + cb('ไม่อนุญาต') + 'ไม่อนุญาต</div>' +
                '<div class="opt">' + cb('อนุมัติ') + 'อนุมัติ <span class="gap"></span>' + cb('ไม่อนุมัติ') + 'ไม่อนุมัติ</div>' +
                '<div class="opt">' + cb('เก็บรวมเรื่อง') + 'เก็บรวมเรื่อง</div>' +
                '<div class="opt">' + cb('แจ้งคณะครูทราบ') + 'แจ้งคณะครูทราบ</div>' +
                '<div class="opt">' + cb('แจ้งให้ทราบ') + 'แจ้งให้ <span class="fill">' +
                  notify.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span> ทราบ</div>' +
                '<div class="opt">' + cb('ดำเนินการ') + 'ดำเนินการ</div>';
              var noteEl = document.getElementById('decisionNotePreview');
              var noteInput = document.getElementById('decisionNote');
              if (noteEl) noteEl.textContent = 'เห็นควรให้ ' + ((noteInput && noteInput.value.trim()) || '...');
            };
            // ล้างเครื่องหมาย/ข้อความที่ติ๊ก/พิมพ์ไว้ทั้งหมด เผื่อกดหรือพิมพ์ผิด — ไม่กระทบตำแหน่งที่ลากไว้
            // (window.decisionPos) เพราะเป็นคนละเรื่องกัน
            window.clearDecisionInputs = function () {
              document.querySelectorAll('.decisionMark:checked').forEach(function (el) { el.checked = false; });
              var noteInput = document.getElementById('decisionNote');
              if (noteInput) noteInput.value = '';
              var notifyInput = document.getElementById('decisionNotify');
              if (notifyInput) notifyInput.value = '';
              window.updateDecisionMarksPreview();
            };
            window.markPos = null;
            window.decisionPos = null;
            window.registrarPos = null;
            var stampSaveTimer = null;
            function saveStampPosition(x, y) {
              fetch('/documents/${doc.id}/stamp-position', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({x: x, y: y}) })
                .then(r => r.json().then(d => ({ok: r.ok, d})))
                .then(({ok, d}) => { if (ok) window.toast('บันทึกตำแหน่งตราประทับแล้ว', 'success'); else window.toast(d.error, 'danger'); })
                .catch(e => window.toast(e.message, 'danger'));
            }
            // maxY: เพดานเฉพาะตัว (กล่องความเห็น ผอ. ห้ามต่ำกว่า DECISION_MAX_TOP ไม่งั้นตอนประทับจริง
            // ส่วนท้ายกล่องจะตกหน้า 2 แล้วหาย) — ถ้าไม่ส่งมา ใช้ 96% ตามเดิม
            function makeDraggable(wrap, el, onDragEnd, maxY) {
              el.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                // overlay โปร่งใสคลุมทั้งกล่อง preview ระหว่างลาก — กัน iframe ของ PDF แย่ง pointer event
                // ระหว่างลากผ่าน (ปัญหาคลาสสิกของการลากธาตุที่มี iframe ซ้อนอยู่ด้านล่าง)
                var capture = document.createElement('div');
                capture.style.cssText = 'position:absolute;inset:0;z-index:5;cursor:move;';
                wrap.appendChild(capture);
                function onMove(ev) {
                  var rect = wrap.getBoundingClientRect();
                  var x = ((ev.clientX - rect.left) / rect.width) * 100;
                  var y = ((ev.clientY - rect.top) / rect.height) * 100;
                  x = Math.max(0, Math.min(96, x));
                  y = Math.max(0, Math.min(maxY == null ? 96 : maxY, y));
                  el.style.left = x + '%';
                  el.style.top = y + '%';
                  el.dataset.x = x;
                  el.dataset.y = y;
                }
                function onUp() {
                  capture.remove();
                  document.removeEventListener('pointermove', onMove);
                  document.removeEventListener('pointerup', onUp);
                  if (el.dataset.x !== undefined && onDragEnd) onDragEnd(parseFloat(el.dataset.x), parseFloat(el.dataset.y));
                }
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
              });
            }
            function makeStampDraggable(wrap, stamp) { makeDraggable(wrap, stamp, saveStampPosition); }
            window.pdfPreviewError = function(imgEl) {
              if (imgEl.dataset.errored) return;
              imgEl.dataset.errored = '1';
              var note = document.createElement('div');
              note.className = 'pdf-preview-fallback';
              note.style.cssText = 'width:100%;aspect-ratio:595/842;display:flex;align-items:center;justify-content:center;text-align:center;padding:1rem;color:var(--text-muted,#666);background:var(--bg-muted,#f4f4f4);border-radius:6px';
              note.textContent = 'ไม่สามารถแสดงตัวอย่างไฟล์ได้ (เซิร์ฟเวอร์อาจยังไม่ได้ติดตั้ง poppler-utils — ดู DEPLOY.md) — ยังคงลากกล่องด้านล่างเพื่อกำหนดตำแหน่งได้ตามปกติ โดยอ้างอิงจากขอบเขตพื้นที่นี้';
              imgEl.replaceWith(note);
            };
            window.applyStamp = function(attId, btn){
              // ให้ธุรการแก้ไขเลขรับ/เวลาที่จะแสดงบนตราได้ก่อนกดยืนยันจริง (เผื่อกด/พิมพ์ผิดตอนนี้จะได้แก้ทัน
              // ก่อนที่จะฝังลง PDF จริงแบบแก้ไม่ได้อีก) — เลขรับ default เป็นเลขที่เอกสารนี้ แต่แก้ได้ ส่วนเวลา
              // เว้นว่างได้ถ้าไม่ต้องการระบุ (จะแสดงเป็นบรรทัดว่างบนตราให้เขียนเติมเองทีหลังได้)
              var num = prompt('เลขรับที่จะแสดงบนตราประทับ (แก้ไขได้ถ้าต้องการ)', ${JSON.stringify(doc.doc_number_display)});
              if (num === null) return;
              var defaultTime = ${JSON.stringify(stampTimeThai(new Date(doc.created_at)))};
              var time = prompt('เวลาที่จะแสดงบนตราประทับ (เว้นว่างได้ถ้าไม่ต้องการระบุเวลา)', defaultTime);
              if (time === null) return;
              if (!confirm('ยืนยันประทับตรา "ลงรับ" ลงในไฟล์ PDF จริง ณ ตำแหน่งที่ลากไว้ล่าสุด?\\nระบบจะสร้างไฟล์ใหม่ที่มีตราประทับ โดยเก็บไฟล์ต้นฉบับที่ไม่มีตราไว้เหมือนเดิม')) return;
              window.setBtnLoading(btn);
              fetch('/documents/${doc.id}/attachments/' + attId + '/apply-stamp', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ docNumberOverride: num.trim(), timeOverride: time.trim() }),
              })
                .then(r => r.json().then(d => ({ok: r.ok, d})))
                .then(({ok, d}) => {
                  if (ok) { window.toast('ประทับตราลงไฟล์ PDF สำเร็จ', 'success'); location.reload(); }
                  else { window.restoreBtn(btn); window.toast(d.error, 'danger'); }
                })
                .catch(e => { window.restoreBtn(btn); window.toast(e.message, 'danger'); });
            };
            var CAN_DECIDE = ${(isCurrentAssignee && isDirectorDecision) ? 'true' : 'false'};
            window.togglePreview = function(id){
              var el = document.getElementById('preview-' + id);
              if (el.style.display === 'none') {
                el.style.display = '';
                if (!el.dataset.loaded) {
                  var isFirstFile = ${JSON.stringify(attachments.length ? attachments[0].id : null)} === id;
                  var showStamp = isFirstFile && STAMP_DIRECTION === 'incoming';
                  var showMark = isFirstFile && CAN_MARK;
                  var showDecision = isFirstFile && CAN_DECIDE;
                  var showRegistrar = isFirstFile && CAN_REGISTRAR;
                  el.innerHTML = '<div class="pdf-preview-wrap" id="stampWrap">' +
                    '<img class="pdf-frame" src="/files/' + id + '/preview.png" alt="ตัวอย่างไฟล์แนบ" onerror="window.pdfPreviewError(this)" />' +
                    (showStamp ? STAMP_HTML : '') +
                    (showMark ? MARK_HTML : '') +
                    (showDecision ? DECISION_HTML : '') +
                    (showRegistrar ? REGISTRAR_HTML : '') +
                  '</div>' +
                  (showStamp && STAMP_CAN_EDIT ? '<div class="help-text">ลากกล่องตราประทับ "ลงรับ" เพื่อย้ายตำแหน่ง — บันทึกอัตโนมัติทันทีที่ปล่อยเมาส์</div>' : '') +
                  (showMark || showDecision || showRegistrar ? '<div class="help-text">ลากกล่อง "ทราบ" / กล่องความเห็นเพื่อย้ายตำแหน่งก่อนกดปุ่มด้านขวา — ตำแหน่งที่ลากไว้จะถูกใช้ตอนกดปุ่มดำเนินการ</div>' : '');
                  el.dataset.loaded = '1';
                  var wrap = document.getElementById('stampWrap');
                  if (showStamp && STAMP_CAN_EDIT) makeStampDraggable(wrap, document.getElementById('docStamp'));
                  if (showMark) makeDraggable(wrap, document.getElementById('ackMark'), function(x, y) { window.markPos = { x: x, y: y }; });
                  if (showDecision) makeDraggable(wrap, document.getElementById('decisionBox'), function(x, y) { window.decisionPos = { x: x, y: y }; }, DECISION_MAX_TOP);
                  if (showDecision) window.updateDecisionMarksPreview();
                  // เพดานเดียวกับกล่อง ผอ. — กันส่วนท้าย (ลายเซ็น/ชื่อ/ตำแหน่ง) ตกหน้า 2 แล้วหายตอนประทับจริง
                  if (showRegistrar) makeDraggable(wrap, document.getElementById('registrarBox'), function(x, y) { window.registrarPos = { x: x, y: y }; }, DECISION_MAX_TOP);
                  if (showRegistrar) window.updateRegistrarPreview();
                }
              } else {
                el.style.display = 'none';
              }
            };
          </script>
          <form id="addAttachForm" style="margin-top:.9rem">
            <input type="file" id="addAttachInput" accept="application/pdf" onchange="attachFilePreview(this,'addAttachPreview')" />
            <div id="addAttachPreview" class="help-text"></div>
            <button class="btn btn-outline btn-sm" style="margin-top:.5rem" type="submit">แนบไฟล์เพิ่ม</button>
          </form>
          <script>
            document.getElementById('addAttachForm').addEventListener('submit', function(e){
              e.preventDefault();
              submitWithFile(this, 'addAttachInput', '/documents/${doc.id}/attachments', {});
            });
          </script>
        </div>

        <div class="card">
          <h3>ความคิดเห็น</h3>
          <div class="stack">
            ${comments.map((c) => `<div style="padding:.5rem;background:var(--surface-2);border-radius:8px">
              <strong>${esc(c.first_name)} ${esc(c.last_name)}</strong> <span class="text-muted" style="font-size:.76rem">${fmtDate(c.created_at)}</span>
              <div>${esc(c.message)}</div></div>`).join('') || '<p class="text-muted">ยังไม่มีความคิดเห็น</p>'}
          </div>
          <form id="commentForm" style="margin-top:.7rem" class="flex gap-2">
            <input type="text" id="commentInput" placeholder="แสดงความคิดเห็น..." style="flex:1" />
            <button class="btn btn-outline" type="submit">ส่ง</button>
          </form>
          <script>
            document.getElementById('commentForm').addEventListener('submit', function(e){
              e.preventDefault();
              var msg = document.getElementById('commentInput').value.trim();
              if(!msg) return;
              fetch('/documents/${doc.id}/comment', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({message: msg})})
                .then(() => location.reload());
            });
          </script>
        </div>
      </div>

      <div class="doc-side">
        ${actionBox}
        ${assignBox}
        <div class="card">
          <h3>Timeline การเดินหนังสือ</h3>
          ${timelineHtml}
        </div>
      </div>
    </div>`;

  html(ctx, 200, layout({ user: ctx.user, title: doc.doc_number_display, path: '/documents', content }));
}));

// ---------------- workflow actions ----------------
router.post('/documents/:id/assign', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  if (!ctx.body.assigneeId) throw httpError(400, 'กรุณาเลือกผู้รับมอบหมาย');
  assignStep({ documentId: doc.id, assigneeId: ctx.body.assigneeId, instruction: ctx.body.instruction, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

// ตำแหน่งลายเซ็น/กล่องความเห็นที่ผู้ใช้ลากเลือกเองในหน้าจอก่อนกดปุ่ม — undefined ถ้าไม่ได้ส่งมา (แปลว่า
// ผู้ใช้ไม่ได้ลาก ให้ pdfStamp.js ใช้ตำแหน่งเริ่มต้นของมันเอง) ไม่ใช่ error เพราะเป็นฟีเจอร์เสริม ไม่บังคับ
function parsePercent(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined;
}

// รายการเครื่องหมายที่ผู้ใช้ติ๊กไว้ในกล่องความเห็น — กรองเฉพาะค่าที่รู้จัก (DECISION_MARK_OPTIONS)
// ทิ้งอย่างอื่นทั้งหมด กันกรณี client ส่งค่าแปลกปลอมมา ไม่ใช่แค่กรอง XSS (esc() จัดการอยู่แล้ว) แต่กันไม่ให้
// ค่าที่ไม่รู้จักหลุดเข้าไปปนกับ logic การเช็คใน stampDirectorDecision
function parseDecisionMarks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m) => DECISION_MARK_VALUES.includes(m));
}

// ชื่อผู้ที่ต้องแจ้ง ที่ผู้ใช้พิมพ์เติมในช่อง "แจ้งให้ .......... ทราบ" — จำกัดความยาวไม่ให้ล้นกรอบตรายาง
// (esc() ที่ pdfStamp.js กัน XSS อยู่แล้ว ตรงนี้กันเรื่องหน้าตาของตราที่พิมพ์ออกมาอย่างเดียว)
function parseNotifyTarget(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 60);
}


router.post('/documents/:id/workflow/:stepId/approve', requireApi(async (ctx) => {
  const { pin, nextAssigneeId, comment, markX, markY, decisionX, decisionY, decisionNote, decisionMarks, decisionNotify, registrarNote, registrarX, registrarY } = ctx.body;
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
  if (!nextAssigneeId) throw httpError(400, 'กรุณาเลือกผู้รับที่จะส่งต่อ');
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  approveAndForward({ stepId: ctx.params.stepId, nextAssigneeId, comment, actorUser: ctx.user });
  const warning1 = await stampAcknowledgeMarkIfApplicable({ documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, markX: parsePercent(markX), markY: parsePercent(markY) });
  // ผอ./ผู้รักษาการแทน ผอ. ที่กด "อนุมัติและส่งต่อ" ก็ยังใส่ checkbox/ความเห็น ลงตราประทับได้เหมือนกด
  // รับทราบ/ไม่อนุมัติ — เดิม endpoint นี้ไม่เรียก stampDirectorDecisionIfApplicable เลย ทำให้ check/ข้อความ
  // ที่กรอกไว้หายไปเงียบๆ ทั้งที่ฝั่ง client ส่งมาให้อยู่แล้ว (ดู stampPositionFields ในสคริปต์ฝั่งเว็บ)
  const warning2 = await stampDirectorDecisionIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, decision: 'approve', note: decisionNote,
    marks: parseDecisionMarks(decisionMarks), notifyTarget: parseNotifyTarget(decisionNotify), decisionX: parsePercent(decisionX), decisionY: parsePercent(decisionY),
  });
  const warning3 = await stampRegistrarCommentIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, comment: registrarNote,
    registrarX: parsePercent(registrarX), registrarY: parsePercent(registrarY),
  });
  json(ctx, 200, { ok: true, warning: warning1 || warning2 || warning3 });
}));

router.post('/documents/:id/workflow/:stepId/acknowledge', requireApi(async (ctx) => {
  const { pin, comment, markX, markY, decisionX, decisionY, decisionNote, decisionMarks, decisionNotify, registrarNote, registrarX, registrarY } = ctx.body;
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  acknowledgeAndComplete({ stepId: ctx.params.stepId, comment, actorUser: ctx.user });
  const warning1 = await stampAcknowledgeMarkIfApplicable({ documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, markX: parsePercent(markX), markY: parsePercent(markY) });
  const warning2 = await stampDirectorDecisionIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, decision: 'acknowledge', note: decisionNote,
    marks: parseDecisionMarks(decisionMarks), notifyTarget: parseNotifyTarget(decisionNotify), decisionX: parsePercent(decisionX), decisionY: parsePercent(decisionY),
  });
  const warning3 = await stampRegistrarCommentIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, comment: registrarNote,
    registrarX: parsePercent(registrarX), registrarY: parsePercent(registrarY),
  });
  json(ctx, 200, { ok: true, warning: warning1 || warning2 || warning3 });
}));

router.post('/documents/:id/workflow/:stepId/reject', requireApi(async (ctx) => {
  const { reason, markX, markY, decisionX, decisionY, decisionNote, decisionMarks, decisionNotify, registrarNote, registrarX, registrarY } = ctx.body;
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  rejectStep({ stepId: ctx.params.stepId, reason, actorUser: ctx.user });
  const warning1 = await stampAcknowledgeMarkIfApplicable({ documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, markX: parsePercent(markX), markY: parsePercent(markY) });
  const warning2 = await stampDirectorDecisionIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, decision: 'reject', note: decisionNote || reason,
    marks: parseDecisionMarks(decisionMarks), notifyTarget: parseNotifyTarget(decisionNotify), decisionX: parsePercent(decisionX), decisionY: parsePercent(decisionY),
  });
  const warning3 = await stampRegistrarCommentIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, comment: registrarNote,
    registrarX: parsePercent(registrarX), registrarY: parsePercent(registrarY),
  });
  json(ctx, 200, { ok: true, warning: warning1 || warning2 || warning3 });
}));

router.post('/documents/:id/workflow/:stepId/return', requireApi(async (ctx) => {
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  returnStep({ stepId: ctx.params.stepId, reason: ctx.body.reason, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/void', requireApi(async (ctx) => {
  voidDocument({ documentId: ctx.params.id, reason: ctx.body.reason, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/force-delete', requireApi(async (ctx) => {
  await forceDeleteDocument({ documentId: ctx.params.id, reason: ctx.body.reason, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

// ตำแหน่งตราประทับ "ลงรับ" ที่ธุรการลากวางเองบนตัวอย่าง PDF (Epic Coding Channel-style stamp) —
// เก็บเป็น % จากมุมบนซ้าย ไม่ผูกกับ pixel เพราะขนาดจอ/ระดับ zoom ของแต่ละคนต่างกัน
router.post('/documents/:id/stamp-position', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  if (doc.created_by !== ctx.user.id && !ctx.user.roleCodes.includes('admin')) {
    throw httpError(403, 'ปรับตำแหน่งตราประทับได้เฉพาะผู้บันทึกเอกสารหรือแอดมินเท่านั้น');
  }
  const x = Number(ctx.body.x);
  const y = Number(ctx.body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    throw httpError(400, 'ตำแหน่งตราประทับไม่ถูกต้อง');
  }
  db.prepare('UPDATE documents SET stamp_x = ?, stamp_y = ?, updated_at = ? WHERE id = ?').run(x, y, nowIso(), doc.id);
  audit({ userId: ctx.user.id, action: 'stamp_position_updated', tableName: 'documents', recordId: doc.id, detail: { x, y } });
  json(ctx, 200, { ok: true });
}));

// อ่านเนื้อไฟล์ดิบของไฟล์แนบจาก storage provider (ใช้ร่วมกันทั้งตอนประทับตรารับและตอนลงนามผู้อำนวยการ)
async function readAttachmentBytes(att, { preferStamped = false } = {}) {
  const useStamped = preferStamped && att.stamped_storage_provider;
  const provider = useStamped ? att.stamped_storage_provider : att.storage_provider;
  const filepath = useStamped ? att.stamped_filepath : att.filepath;
  const driveFileId = useStamped ? att.stamped_drive_file_id : att.drive_file_id;
  if (provider === 'google_drive') {
    const stream = await downloadFileStream(driveFileId);
    if (!stream) throw httpError(404, 'ไม่พบไฟล์บน Google Drive');
    const chunks = [];
    for await (const chunk of Readable.fromWeb(stream)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  const filePath = path.join(UPLOAD_DIR, filepath);
  if (!fs.existsSync(filePath)) throw httpError(404, 'ไม่พบไฟล์');
  return fs.readFileSync(filePath);
}

// บันทึกสำเนาที่ประทับตรา/ลงนามแล้วกลับเข้า storage provider เดียวกับไฟล์ต้นฉบับ แล้วอัปเดตคอลัมน์
// stamped_* ของ attachments (เขียนทับของเดิม เพราะไฟล์ใหม่มีทั้งกล่องเดิม + กล่องใหม่ซ้อนกันอยู่แล้ว)
async function saveStampedCopy(att, stampedBuffer, yearBe) {
  if (isGoogleDriveEnabled()) {
    const folderId = await ensureCategoryFolder({ yearBe: yearBe || (new Date().getFullYear() + 543), typeName: 'ประทับตราแล้ว' });
    const driveFileId = await uploadFile({ buffer: stampedBuffer, filename: `${att.id}__stamped__${att.filename}`, mimeType: 'application/pdf', folderId });
    db.prepare(`UPDATE attachments SET stamped_storage_provider = 'google_drive', stamped_filepath = NULL, stamped_drive_file_id = ?, stamped_at = ? WHERE id = ?`)
      .run(driveFileId, nowIso(), att.id);
  } else {
    const safeName = `${att.id}-stamped.pdf`;
    fs.writeFileSync(path.join(UPLOAD_DIR, safeName), stampedBuffer);
    db.prepare(`UPDATE attachments SET stamped_storage_provider = 'local', stamped_filepath = ?, stamped_drive_file_id = NULL, stamped_at = ? WHERE id = ?`)
      .run(safeName, nowIso(), att.id);
  }
}

const SCHOOL_NAME = 'โรงเรียนเจ้าพ่อหลวงอุปถัมภ์ ๑';

// เครื่องหมาย "ทราบ" + ลายเซ็นแบบง่าย — ทุกคนในสาย workflow ที่ตัดสินใจ (อนุมัติ/ส่งต่อ/รับทราบ/ไม่อนุมัติ)
// ได้เครื่องหมายของตัวเองคนละอัน ไม่จำกัดแค่ผู้อำนวยการ (มีกี่คนตอบก็มีลายเซ็นเท่านั้นบนไฟล์) ตำแหน่ง/
// เวลาลากมาจาก markX/markY ที่ผู้ใช้ลากเลือกเองในหน้าจอก่อนกดปุ่ม — ไม่ทำให้คำขอ workflow ล้มเหลวถ้า
// ประทับไม่สำเร็จ (เช่น ยังไม่ติดตั้ง chromium/qpdf) เพราะการดำเนินการ workflow หลักต้องสำเร็จไปก่อนแล้ว
// ถ้า actorUser กำลังดำเนินการขั้นตอนนี้ในฐานะ "รักษาการแทน" (ไม่ใช่ผู้ถูกมอบหมายตัวจริง) คืนชื่อผู้ที่ถูก
// รักษาการแทนไว้ให้ใส่ในตราประทับ — เพื่อให้เห็นในไฟล์ PDF จริงว่าใครลงนามแทนใคร ไม่ใช่แค่ในหน้าเว็บ
function actingForLabel(stepId, actorUser) {
  const step = db.prepare('SELECT assignee_id FROM workflow_steps WHERE id = ?').get(stepId);
  if (!step || step.assignee_id === actorUser.id) return null;
  const delegator = db.prepare('SELECT prefix, first_name, last_name FROM users WHERE id = ?').get(step.assignee_id);
  return delegator ? `${delegator.prefix || ''}${delegator.first_name} ${delegator.last_name}` : null;
}

// เลือกถ้อยคำหัว/ท้ายกล่องความเห็นให้ตรงกับตรายางจริง 2 แบบของโรงเรียน (ดู docs/stamp-reference/) —
// 'director' ถ้าผู้เซ็นเองเป็นผู้อำนวยการตัวจริง, 'acting_director' ถ้าเซ็นแทนในฐานะรักษาการแทนคนที่เป็น
// ผู้อำนวยการ (delegator มี role 'director'), 'generic' ถ้าไม่เข้าเงื่อนไขไหนเลย (เช่น หัวหน้าฝ่ายปิดเรื่องเอง)
function directorTitleMode(stepId, actorUser) {
  if (actorUser.roleCodes.includes('director')) return 'director';
  const step = db.prepare('SELECT assignee_id FROM workflow_steps WHERE id = ?').get(stepId);
  if (!step || step.assignee_id === actorUser.id) return 'generic';
  const delegatorIsDirector = db.prepare(`
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.name = 'director'
  `).get(step.assignee_id);
  return delegatorIsDirector ? 'acting_director' : 'generic';
}

// ตำแหน่ง Y เริ่มต้นของตรา "ทราบ" (ลายเซ็นของผู้ได้รับเอกสาร) — อยู่ข้างซ้ายของกรอบตราปั๊ม ผอ. โดยขอบบน
// ตรงกันพอดี ตามที่โรงเรียนขอ (ดูแผนผังแถบล่างใน pdfStamp.js) — ถ้ามีหลายคนในสาย workflow เซ็นทราบ
// จะเรียงลงมาทีละคนไม่ให้ทับกัน นับเฉพาะขั้นตอนที่ตัดสินใจไปแล้วก่อนหน้าขั้นตอนนี้ (ไม่รวมตัวเอง)
// ผอ. เองไม่มีตรานี้ซ้อนอยู่แล้ว เพราะมีลายเซ็นในกรอบตราปั๊มของตัวเอง (ดู stampAcknowledgeMarkIfApplicable)
// ค่านี้ใช้ร่วมกันทั้งตำแหน่งเริ่มต้นที่โชว์ในตัวอย่างบนเว็บ (ต้องตรงกันเป๊ะ ไม่งั้นลากดูตัวอย่างแล้วจะไม่ตรงกับ
// ตำแหน่งจริงที่ฝังตอนกดปุ่ม) และตำแหน่งที่ฝังจริงตอนกดปุ่ม
const MARK_BASE_Y = DECISION_MAX_TOP_PERCENT;
const MARK_STEP_Y = 9;
function markStackYPercent(documentId, stepId) {
  const { c } = db.prepare(`
    SELECT COUNT(*) as c FROM workflow_steps WHERE document_id = ? AND id != ? AND status IN ('approved', 'acknowledged', 'rejected')
  `).get(documentId, stepId);
  return Math.min(94, MARK_BASE_Y + c * MARK_STEP_Y);
}

// กันกล่องความเห็น ผอ. ซ้อนทับตัวเองเป๊ะๆ เวลา ผอ. คนเดิม (assignee ช่องเดิม) ต้องตัดสินใจซ้ำบนเอกสาร
// เดียวกันมากกว่า 1 ครั้งโดยไม่ได้ลากตำแหน่งเอง (เช่น ส่งกลับแก้ไข-เสนอใหม่-อนุมัติซ้ำ) — เลื่อนขึ้นทีละ 14%
// จากตำแหน่งฐาน 78% ทุกครั้งที่ assignee ช่องนี้เคยตัดสินใจบนเอกสารนี้มาก่อนแล้ว (นับจาก workflow_steps
// ที่ assignee_id เดียวกัน ไม่ใช่นับทุกคนแบบ markStackYPercent เพราะกล่องนี้เป็นของ ผอ. คนเดียว)
// ระยะเลื่อนขึ้นต่อครั้งต้องมากกว่าความสูงกล่อง (~230pt ≈ 27% ของหน้า) ไม่งั้นกล่องรอบที่ 2 ยังทับรอบแรก
const DECISION_BOX_BASE_Y = DECISION_MAX_TOP_PERCENT;
const DECISION_BOX_STEP_Y = 27;
const DECISION_BOX_MIN_Y = 4;
function decisionBoxStackYPercent(documentId, stepId, assigneeId) {
  const { c } = db.prepare(`
    SELECT COUNT(*) as c FROM workflow_steps
    WHERE document_id = ? AND id != ? AND assignee_id = ? AND status IN ('approved', 'acknowledged', 'rejected')
  `).get(documentId, stepId, assigneeId);
  return Math.max(DECISION_BOX_MIN_Y, DECISION_BOX_BASE_Y - c * DECISION_BOX_STEP_Y);
}

// คืนค่า warning message ถ้าประทับตราไม่สำเร็จ (undefined ถ้าสำเร็จ หรือข้ามเพราะไม่มีลายเซ็น/ไฟล์แนบ —
// นั่นไม่ใช่ความผิดพลาด) เพื่อให้ผู้เรียกส่งกลับไปแจ้งผู้ใช้ต่อ ไม่ใช่กลืนความผิดพลาดแบบเงียบๆ เหมือนเดิม
// ซึ่งทำให้ผู้ใช้ไม่รู้ว่าทำไมข้อความ/ลายเซ็นไม่ติดใน PDF ที่พิมพ์ออกมา
async function stampAcknowledgeMarkIfApplicable({ documentId, stepId, actorUser, markX, markY }) {
  // ผอ./ผู้รักษาการแทน ผอ. มีลายเซ็นอยู่ในกล่องความเห็นทางการ (มุมขวาล่าง) อยู่แล้ว ไม่ต้องมีตรา "ทราบ"
  // แยกซ้อนอีกอันนอกกล่อง — ตรานี้มีไว้สำหรับคนอื่นในสาย workflow ที่ไม่มีกล่องความเห็นเป็นของตัวเอง
  if (directorTitleMode(stepId, actorUser) !== 'generic') return;
  if (!actorUser.signature_image) return;
  const att = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at LIMIT 1').get(documentId);
  if (!att) return;
  try {
    const originalBuffer = await readAttachmentBytes(att, { preferStamped: true });
    const stampedBuffer = await stampAcknowledgeMark({
      originalBuffer,
      signatureDataUrl: actorUser.signature_image,
      prefix: actorUser.prefix,
      firstName: actorUser.first_name,
      lastName: actorUser.last_name,
      dateThaiLong: stampDateThai(),
      xPercent: markX ?? DEFAULT_ACK_MARK_X_PERCENT,
      yPercent: markY ?? markStackYPercent(documentId, stepId),
      actingForLabel: actingForLabel(stepId, actorUser),
    });
    await saveStampedCopy(att, stampedBuffer, getDocument(documentId)?.year_be);
    audit({ userId: actorUser.id, action: 'attachment_mark_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId } });
  } catch (err) {
    audit({ userId: actorUser.id, action: 'attachment_mark_stamp_failed', tableName: 'attachments', recordId: att.id, detail: { documentId, error: err.message } });
    return `บันทึกผลสำเร็จ แต่ลงลายเซ็น "ทราบ" ลงในไฟล์ PDF จริงไม่สำเร็จ: ${err.message}`;
  }
}

// ธุรการเป็นคนกลั่นกรองเรื่องก่อนถึง ผอ. จึงต้องเขียนความเห็นเสนอขึ้นไปด้วย ไม่ใช่แค่ลงรับแล้วส่งต่อเฉยๆ
// เงื่อนไข: ต้องมีบทบาทธุรการ (บังคับฝั่งเซิร์ฟเวอร์ ไม่พึ่งแค่ UI ที่ซ่อนช่องไว้), ต้องไม่ใช่ผู้ที่กำลังลงนาม
// ในฐานะ ผอ./ผู้รักษาการแทน (คนนั้นมีกล่องความเห็นทางการของตัวเองอยู่แล้ว จะได้ไม่มีความเห็นซ้อนสองที่)
// และต้องพิมพ์ความเห็นมาจริง — ไม่พิมพ์ก็ข้ามไป ไม่ถือเป็นความผิดพลาด
function canWriteRegistrarComment(stepId, actorUser) {
  return actorUser.roleCodes.includes('registrar') && directorTitleMode(stepId, actorUser) === 'generic';
}

async function stampRegistrarCommentIfApplicable({ documentId, stepId, actorUser, comment, registrarX, registrarY }) {
  const text = typeof comment === 'string' ? comment.trim() : '';
  if (!text || !canWriteRegistrarComment(stepId, actorUser)) return;
  const att = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at LIMIT 1').get(documentId);
  if (!att) return;
  try {
    const originalBuffer = await readAttachmentBytes(att, { preferStamped: true });
    const stampedBuffer = await stampRegistrarComment({
      originalBuffer,
      comment: text,
      signatureDataUrl: actorUser.signature_image || null,
      prefix: actorUser.prefix,
      firstName: actorUser.first_name,
      lastName: actorUser.last_name,
      position: actorUser.position,
      dateThaiLong: stampDateThai(),
      xPercent: registrarX,
      yPercent: registrarY,
    });
    await saveStampedCopy(att, stampedBuffer, getDocument(documentId)?.year_be);
    audit({ userId: actorUser.id, action: 'attachment_registrar_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId, comment: text } });
  } catch (err) {
    audit({ userId: actorUser.id, action: 'attachment_registrar_stamp_failed', tableName: 'attachments', recordId: att.id, detail: { documentId, error: err.message } });
    return `บันทึกผลสำเร็จ แต่ลงความเห็นธุรการลงในไฟล์ PDF จริงไม่สำเร็จ: ${err.message}`;
  }
}

// กล่องความเห็น/ลงนามของผู้ตัดสินใจคนสุดท้าย — เรียกจากทั้ง 3 endpoint (อนุมัติและส่งต่อ/รับทราบ/ไม่อนุมัติ)
// ไม่ได้จำกัดแค่ตอนปิดเรื่องแล้ว เพราะ ผอ. อาจอยากบันทึกความเห็น/ติ๊กเครื่องหมายไว้ตั้งแต่ตอนส่งต่อก็ได้ —
// note คือข้อความในช่อง "ความเห็น" ที่ผู้ใช้พิมพ์เอง ไม่ใช่ข้อความเกษียณภายในระบบ (คนละช่องกัน)
// จำกัดเฉพาะ ผอ. ตัวจริง/ผู้รักษาการแทน ผอ. เท่านั้น (titleMode !== 'generic') — คนอื่นในสาย workflow แค่
// "ทราบ" เฉยๆ ไม่มีตราประทับความเห็นทางการ (บังคับฝั่งเซิร์ฟเวอร์ ไม่พึ่งแค่ UI ที่ซ่อนปุ่ม/ช่องไว้แล้ว)
async function stampDirectorDecisionIfApplicable({ documentId, stepId, actorUser, decision, note, marks, notifyTarget, decisionX, decisionY }) {
  const titleMode = directorTitleMode(stepId, actorUser);
  if (titleMode === 'generic') return;
  const att = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at LIMIT 1').get(documentId);
  if (!att) return;
  const doc = getDocument(documentId);
  const forLabel = actingForLabel(stepId, actorUser);
  const { assignee_id: assigneeId } = db.prepare('SELECT assignee_id FROM workflow_steps WHERE id = ?').get(stepId);
  try {
    const originalBuffer = await readAttachmentBytes(att, { preferStamped: true });
    const stampedBuffer = await stampDirectorDecision({
      originalBuffer,
      schoolName: SCHOOL_NAME,
      decision,
      note,
      marks: marks || [],
      notifyTarget: notifyTarget || '',
      signatureDataUrl: actorUser.signature_image || null,
      prefix: actorUser.prefix,
      firstName: actorUser.first_name,
      lastName: actorUser.last_name,
      position: actorUser.position,
      titleMode,
      actingForLabel: titleMode === 'acting_director' ? forLabel : null,
      dateThaiLong: stampDateThai(),
      xPercent: decisionX,
      yPercent: decisionY ?? decisionBoxStackYPercent(documentId, stepId, assigneeId),
    });
    await saveStampedCopy(att, stampedBuffer, doc?.year_be);
    audit({ userId: actorUser.id, action: 'attachment_director_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId, decision, note, marks: marks || [], notifyTarget: notifyTarget || '' } });
  } catch (err) {
    audit({ userId: actorUser.id, action: 'attachment_director_stamp_failed', tableName: 'attachments', recordId: att.id, detail: { documentId, decision, error: err.message } });
    return `บันทึกผลสำเร็จ แต่ลงตราประทับ/ข้อความ "ความเห็น" ลงในไฟล์ PDF จริงไม่สำเร็จ: ${err.message}`;
  }
}

// ประทับตราลงในเนื้อไฟล์ PDF จริง (เขียนสำเนาใหม่ ไม่แตะไฟล์ต้นฉบับ) — ใช้ตำแหน่งที่บันทึกไว้ล่าสุดจาก
// /stamp-position ต้องติดตั้ง chromium + qpdf บนเซิร์ฟเวอร์ก่อน (ดู DEPLOY.md) ไม่งั้นจะ error 501 ชัดเจน
router.post('/documents/:id/attachments/:attId/apply-stamp', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  if (doc.created_by !== ctx.user.id && !ctx.user.roleCodes.includes('admin')) {
    throw httpError(403, 'สร้าง PDF ที่ประทับตราแล้วได้เฉพาะผู้บันทึกเอกสารหรือแอดมินเท่านั้น');
  }
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND document_id = ?').get(ctx.params.attId, doc.id);
  if (!att) throw httpError(404, 'ไม่พบไฟล์แนบนี้');

  const originalBuffer = await readAttachmentBytes(att, { preferStamped: false });

  const now = new Date(doc.created_at);
  // เลขรับ/เวลาที่จะแสดงบนตรา แก้ไขได้จากที่ธุรการพิมพ์ตอนกดยืนยัน (ดู applyStamp ฝั่งเว็บ) — เลขรับถ้าเว้น
  // ว่างไว้ใช้เลขที่เอกสารตามปกติ ส่วนเวลาเว้นว่างได้จริง (แสดงเป็นบรรทัดว่างบนตราให้เขียนเติมเองทีหลังได้)
  const docNumberDisplay = (typeof ctx.body.docNumberOverride === 'string' && ctx.body.docNumberOverride.trim()) || doc.doc_number_display;
  const timeStr = typeof ctx.body.timeOverride === 'string' ? ctx.body.timeOverride.trim() : stampTimeThai(now);
  const stampedBuffer = await stampPdf({
    originalBuffer,
    schoolName: SCHOOL_NAME,
    docNumberDisplay,
    dateThaiLong: stampDateThai(now),
    timeStr,
    xPercent: doc.stamp_x,
    yPercent: doc.stamp_y,
  });

  await saveStampedCopy(att, stampedBuffer, doc.year_be);
  audit({ userId: ctx.user.id, action: 'attachment_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId: doc.id, docNumberDisplay, timeStr } });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/archive', requireApi(async (ctx) => {
  archiveDocument({ documentId: ctx.params.id, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/comment', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  if (!ctx.body.message?.trim()) throw httpError(400, 'ข้อความว่างเปล่า');
  db.prepare('INSERT INTO comments (id, document_id, user_id, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), doc.id, ctx.user.id, ctx.body.message.trim(), nowIso());
  audit({ userId: ctx.user.id, action: 'comment_added', tableName: 'documents', recordId: doc.id });
  json(ctx, 200, { ok: true });
}));


// ---------------- file serving (ACL-checked, not static — proxied even for Google Drive so ACL always applies) ----------------
// ภาพหน้าแรกของ PDF (พื้นหลังกล่องลากตำแหน่งตราประทับ) — ดู renderPdfFirstPageImage สำหรับเหตุผลที่ใช้ภาพ
// แทนการฝัง PDF ตรงๆ ผ่าน iframe
router.get('/files/:attachmentId/preview.png', requirePage(async (ctx) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(ctx.params.attachmentId);
  if (!att) throw httpError(404, 'ไม่พบไฟล์แนบ');
  const doc = getDocument(att.document_id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(403, 'คุณไม่มีสิทธิ์เปิดไฟล์นี้');
  const buf = await readAttachmentBytes(att, { preferStamped: ctx.query.original !== '1' });
  const png = await renderPdfFirstPageImage(buf);
  ctx.res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' });
  ctx.res.end(png);
}));

// ค่าเริ่มต้นเปิดสำเนาที่ประทับตราแล้ว (ถ้ามี) — ต้นฉบับที่ไม่แตะต้องเลยเปิดได้ด้วย ?original=1
router.get('/files/:attachmentId', requirePage(async (ctx) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(ctx.params.attachmentId);
  if (!att) return html(ctx, 404, '<h1>404</h1>');
  const doc = getDocument(att.document_id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) {
    return html(ctx, 403, '<h1>403</h1><p>คุณไม่มีสิทธิ์เปิดไฟล์นี้</p>');
  }

  const useStamped = ctx.query.original !== '1' && att.stamped_storage_provider;
  const storageProvider = useStamped ? att.stamped_storage_provider : att.storage_provider;
  const filepath = useStamped ? att.stamped_filepath : att.filepath;
  const driveFileId = useStamped ? att.stamped_drive_file_id : att.drive_file_id;

  if (storageProvider === 'google_drive') {
    let stream;
    try {
      stream = await downloadFileStream(driveFileId);
    } catch (err) {
      return html(ctx, err.statusCode || 502, `<h1>เกิดข้อผิดพลาด</h1><p>${esc(err.message)}</p>`);
    }
    if (!stream) return html(ctx, 404, '<h1>ไม่พบไฟล์บน Google Drive</h1>');
    audit({ userId: ctx.user.id, action: 'attachment_opened', tableName: 'attachments', recordId: att.id, ip: ctx.ip, detail: { variant: useStamped ? 'stamped' : 'original' } });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDispositionHeader(att.filename),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    Readable.fromWeb(stream).pipe(ctx.res);
    return;
  }

  const filePath = path.join(UPLOAD_DIR, filepath);
  if (!fs.existsSync(filePath)) return html(ctx, 404, '<h1>ไม่พบไฟล์</h1>');
  audit({ userId: ctx.user.id, action: 'attachment_opened', tableName: 'attachments', recordId: att.id, ip: ctx.ip, detail: { variant: useStamped ? 'stamped' : 'original' } });
  ctx.res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDispositionHeader(att.filename),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(ctx.res);
}));
