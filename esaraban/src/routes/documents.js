import { router, html, json, redirect } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateLong, priorityBadge, secretBadge, statusBadge, emptyState, LABELS } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, uuid, nowIso, audit, RETENTION_LABEL } from '../db.js';
import {
  createDocument, getDocument, canUserSeeDocument, getWorkflowSteps, currentStep,
  assignStep, approveAndForward, acknowledgeAndComplete, rejectStep, returnStep,
  voidDocument, archiveDocument, forceDeleteDocument, httpError,
} from '../services/workflow.js';
import { extractTextFromPdf, guessFieldsFromText } from '../services/ocr.js';
import { isGoogleDriveEnabled, ensureCategoryFolder, uploadFile, downloadFileStream } from '../services/googleDrive.js';
import { stampPdf, stampDirectorDecision } from '../services/pdfStamp.js';
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

  const rowsHtml = rows.map((d) => `
    <tr onclick="location.href='/documents/${d.id}'" style="cursor:pointer">
      <td><strong style="color:var(--primary)">${esc(d.doc_number_display)}</strong></td>
      <td>${esc(d.title)}${d.secret_level !== 'normal' ? ' 🔒' : ''}</td>
      <td>${esc(d.dept_name)}</td>
      <td>${priorityBadge(d.priority)}</td>
      <td>${statusBadge(d.status)}</td>
      <td class="text-muted">${fmtDate(d.created_at)}</td>
    </tr>`).join('');

  const content = `
    <div class="card-header">
      <h2 class="mt-0">${direction === 'incoming' ? '📥 หนังสือเข้า' : '📤 หนังสือออก'}</h2>
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
        <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ฝ่าย</th><th>ความเร็ว</th><th>สถานะ</th><th>วันที่</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>`
      : emptyState('📭', `ไม่มี${direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก'}ในรายการนี้`)}
    </div>`;

  html(ctx, 200, layout({ user: ctx.user, title: direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก', path: '/documents', content }));
}));

// ---------------- new form ----------------
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
    retentionClass: b.retentionClass, createdBy: ctx.user.id,
  });
  let warn = '';
  if (b.fileDataBase64) {
    const att = await saveAttachment({ documentId: doc.id, fileName: b.fileName, fileType: b.fileType, fileDataBase64: b.fileDataBase64, uploadedBy: ctx.user.id });
    if (att?.duplicateWarning) warn = `&warn=${encodeURIComponent(att.duplicateWarning)}`;
  }
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
  <p><span class="field-label">ส่วนราชการ</span> ${esc(doc.dept_name)} โรงเรียนเจ้าพ่อหลวงอุปถัมภ์ 1</p>
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

  const isCurrentAssignee = step && step.assignee_id === ctx.user.id;
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
      <div class="stack">
        <div>
          <label>ส่งต่อ/อนุมัติไปยัง (ถ้าต้องการส่งต่อ)</label>
          <select id="nextAssignee"><option value="">— เลือกผู้รับ (ถ้าไม่เลือก แปลว่าคุณคือผู้รับคนสุดท้าย) —</option>${listUserOptions(ctx.user.id)}</select>
        </div>
        <div class="field">
          <label>ความเห็น/ข้อความเกษียณ</label>
          <div class="chip-row" style="margin-bottom:.4rem">
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('เห็นชอบ')">เห็นชอบ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('อนุมัติ')">อนุมัติ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('ทราบ')">ทราบ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('มอบฝ่าย', ' ดำเนินการ')">มอบฝ่าย...ดำเนินการ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('เพื่อพิจารณา')">เพื่อพิจารณา</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertQuickPhrase('เพื่อทราบและดำเนินการ')">เพื่อทราบและดำเนินการ</button>
          </div>
          <textarea id="stepComment" placeholder="เลือกจากปุ่มด้านบน แล้วพิมพ์ข้อความเพิ่มเติมได้ตามต้องการ — หรือพิมพ์เองทั้งหมดก็ได้"></textarea>
          <div class="help-text">
            "อนุมัติ" ใช้เมื่อใช้อำนาจตามระเบียบ (เช่น อนุมัติโครงการ/งบประมาณ) · "เห็นชอบ" ใช้เมื่อเห็นด้วยกับหลักการ
            แล้วให้หน่วยที่เกี่ยวข้องไปจัดทำรายละเอียดต่อ · "ทราบ" ใช้รับทราบเฉยๆ ไม่ได้สั่งการเพิ่ม
          </div>
        </div>
        <div class="chip-row">
          <button class="btn btn-success" data-pin-title="ยืนยัน PIN เพื่ออนุมัติและส่งต่อ" onclick="doApprove(this)">✅ อนุมัติและส่งต่อ</button>
          <button class="btn btn-primary" data-pin-title="ยืนยัน PIN เพื่อรับทราบและปิดเรื่อง" onclick="doAcknowledge(this)">✔️ รับทราบ/ปิดเรื่อง</button>
          <button class="btn btn-outline" onclick="actionWithReason(this, '/documents/${doc.id}/workflow/${step.id}/return', 'ระบุเหตุผลที่ส่งกลับแก้ไข')">↩️ ส่งกลับแก้ไข</button>
          <button class="btn btn-danger" onclick="actionWithReason(this, '/documents/${doc.id}/workflow/${step.id}/reject', 'ระบุเหตุผลที่ไม่อนุมัติ')">✖️ ไม่อนุมัติ</button>
        </div>
      </div>
    </div>
    <script>
      function doApprove(btn){
        var next = document.getElementById('nextAssignee').value;
        var comment = document.getElementById('stepComment').value;
        if (!next) { toast('กรุณาเลือกผู้รับที่จะส่งต่อ ก่อนกดอนุมัติ (ถ้าเป็นผู้รับคนสุดท้ายให้กด "รับทราบ/ปิดเรื่อง" แทน)', 'warning'); return; }
        actionWithPin(btn, '/documents/${doc.id}/workflow/${step.id}/approve', { nextAssigneeId: next, comment: comment });
      }
      function doAcknowledge(btn){
        var comment = document.getElementById('stepComment').value;
        actionWithPin(btn, '/documents/${doc.id}/workflow/${step.id}/acknowledge', { comment: comment }, '/?celebrate=1');
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

  const content = `
    ${ctx.query.created ? '<div class="alert alert-success">✅ บันทึกและออกเลขเอกสารเรียบร้อยแล้ว</div>' : ''}
    ${ctx.query.warn ? `<div class="alert alert-warning">⚠️ ${esc(ctx.query.warn)}</div>` : ''}
    <div class="card-header">
      <div>
        <h2 class="mt-0"><span style="color:var(--primary)">${esc(doc.doc_number_display)}</span> — ${esc(doc.title)}</h2>
        <div class="chip-row">${statusBadge(doc.status)}${priorityBadge(doc.priority)}${secretBadge(doc.secret_level)}</div>
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

    <div class="grid-2">
      <div>
        <div class="card">
          <h3>รายละเอียด</h3>
          <table style="min-width:0">
            <tbody>
              <tr><td class="text-muted">${doc.direction === 'incoming' ? 'หน่วยงานต้นทาง' : 'หน่วยงานปลายทาง'}</td><td>${esc(doc.correspondent_name)}</td></tr>
              ${doc.external_doc_number ? `<tr><td class="text-muted">เลขหนังสืออ้างอิง</td><td>${esc(doc.external_doc_number)}</td></tr>` : ''}
              ${doc.external_doc_date ? `<tr><td class="text-muted">ลงวันที่</td><td>${esc(doc.external_doc_date)}</td></tr>` : ''}
              <tr><td class="text-muted">ฝ่าย</td><td>${esc(doc.dept_name)}</td></tr>
              ${doc.due_date ? `<tr><td class="text-muted">กำหนดเสร็จ</td><td>${esc(doc.due_date)}</td></tr>` : ''}
              <tr><td class="text-muted">อายุการเก็บ</td><td>${esc(RETENTION_LABEL[doc.retention_class] || doc.retention_class)}${doc.retention_until ? ` (ครบกำหนด ${esc(doc.retention_until)})` : ''}</td></tr>
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
              '<div class="stamp-title">โรงเรียนเจ้าพ่อหลวงอุปถัมภ์ 1</div>' +
              '<div>เลขรับ......${esc(doc.doc_number_display)}......</div>' +
              '<div>วันที่......${new Date(doc.created_at).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' })}......</div>' +
              '<div>เวลา......${new Date(doc.created_at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' })}......</div>' +
            '</div>';
            var stampSaveTimer = null;
            function saveStampPosition(x, y) {
              fetch('/documents/${doc.id}/stamp-position', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({x: x, y: y}) })
                .then(r => r.json().then(d => ({ok: r.ok, d})))
                .then(({ok, d}) => { if (ok) window.toast('บันทึกตำแหน่งตราประทับแล้ว', 'success'); else window.toast(d.error, 'danger'); })
                .catch(e => window.toast(e.message, 'danger'));
            }
            function makeStampDraggable(wrap, stamp) {
              stamp.addEventListener('pointerdown', function (e) {
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
                  y = Math.max(0, Math.min(96, y));
                  stamp.style.left = x + '%';
                  stamp.style.top = y + '%';
                  stamp.dataset.x = x;
                  stamp.dataset.y = y;
                }
                function onUp() {
                  capture.remove();
                  document.removeEventListener('pointermove', onMove);
                  document.removeEventListener('pointerup', onUp);
                  if (stamp.dataset.x !== undefined) saveStampPosition(parseFloat(stamp.dataset.x), parseFloat(stamp.dataset.y));
                }
                document.addEventListener('pointermove', onMove);
                document.addEventListener('pointerup', onUp);
              });
            }
            window.applyStamp = function(attId, btn){
              if (!confirm('ยืนยันประทับตรา "ลงรับ" ลงในไฟล์ PDF จริง ณ ตำแหน่งที่ลากไว้ล่าสุด?\\nระบบจะสร้างไฟล์ใหม่ที่มีตราประทับ โดยเก็บไฟล์ต้นฉบับที่ไม่มีตราไว้เหมือนเดิม')) return;
              window.setBtnLoading(btn);
              fetch('/documents/${doc.id}/attachments/' + attId + '/apply-stamp', { method: 'POST' })
                .then(r => r.json().then(d => ({ok: r.ok, d})))
                .then(({ok, d}) => {
                  if (ok) { window.toast('ประทับตราลงไฟล์ PDF สำเร็จ', 'success'); location.reload(); }
                  else { window.restoreBtn(btn); window.toast(d.error, 'danger'); }
                })
                .catch(e => { window.restoreBtn(btn); window.toast(e.message, 'danger'); });
            };
            window.togglePreview = function(id){
              var el = document.getElementById('preview-' + id);
              if (el.style.display === 'none') {
                el.style.display = '';
                if (!el.dataset.loaded) {
                  var isFirstFile = ${JSON.stringify(attachments.length ? attachments[0].id : null)} === id;
                  var showStamp = isFirstFile && STAMP_DIRECTION === 'incoming';
                  el.innerHTML = '<div class="pdf-preview-wrap"' + (showStamp ? ' id="stampWrap"' : '') + '>' +
                    '<iframe class="pdf-frame" src="/files/' + id + '" title="ตัวอย่างไฟล์แนบ"></iframe>' +
                    (showStamp ? STAMP_HTML : '') +
                  '</div>' +
                  (showStamp && STAMP_CAN_EDIT ? '<div class="help-text">ลากกล่องตราประทับเพื่อย้ายตำแหน่ง — บันทึกอัตโนมัติทันทีที่ปล่อยเมาส์</div>' : '');
                  el.dataset.loaded = '1';
                  if (showStamp && STAMP_CAN_EDIT) makeStampDraggable(document.getElementById('stampWrap'), document.getElementById('docStamp'));
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

      <div>
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

router.post('/documents/:id/workflow/:stepId/approve', requireApi(async (ctx) => {
  const { pin, nextAssigneeId, comment } = ctx.body;
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
  if (!nextAssigneeId) throw httpError(400, 'กรุณาเลือกผู้รับที่จะส่งต่อ');
  approveAndForward({ stepId: ctx.params.stepId, nextAssigneeId, comment, actorUser: ctx.user });
  await stampDirectorDecisionIfApplicable({ documentId: ctx.params.id, actorUser: ctx.user, decision: 'approve', note: comment });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/workflow/:stepId/acknowledge', requireApi(async (ctx) => {
  const { pin, comment } = ctx.body;
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
  acknowledgeAndComplete({ stepId: ctx.params.stepId, comment, actorUser: ctx.user });
  await stampDirectorDecisionIfApplicable({ documentId: ctx.params.id, actorUser: ctx.user, decision: 'acknowledge', note: comment });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/workflow/:stepId/reject', requireApi(async (ctx) => {
  rejectStep({ stepId: ctx.params.stepId, reason: ctx.body.reason, actorUser: ctx.user });
  await stampDirectorDecisionIfApplicable({ documentId: ctx.params.id, actorUser: ctx.user, decision: 'reject', note: ctx.body.reason });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/workflow/:stepId/return', requireApi(async (ctx) => {
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

const SCHOOL_NAME = 'โรงเรียนเจ้าพ่อหลวงอุปถัมภ์ 1';

// ลงกล่องความเห็น/ลายเซ็นของผู้อำนวยการลงในไฟล์ PDF จริง (ต่อจากตราประทับ "ลงรับ" ถ้ามีอยู่แล้ว) —
// เรียกอัตโนมัติหลังผู้อำนวยการกดอนุมัติ/รับทราบ/ไม่อนุมัติในหน้าเอกสาร ไม่ทำให้ทั้งคำขอ error ถ้าล้มเหลว
// (เช่น เซิร์ฟเวอร์ยังไม่ได้ติดตั้ง chromium/qpdf) เพราะการดำเนินการ workflow หลักต้องสำเร็จไปก่อนแล้ว
async function stampDirectorDecisionIfApplicable({ documentId, actorUser, decision, note }) {
  if (!actorUser.roleCodes.includes('director') && !actorUser.roleCodes.includes('admin')) return;
  const att = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at LIMIT 1').get(documentId);
  if (!att) return;
  const doc = getDocument(documentId);
  try {
    const originalBuffer = await readAttachmentBytes(att, { preferStamped: true });
    const stampedBuffer = await stampDirectorDecision({
      originalBuffer,
      schoolName: SCHOOL_NAME,
      decision,
      note,
      signatureDataUrl: actorUser.signature_image || null,
      prefix: actorUser.prefix,
      firstName: actorUser.first_name,
      lastName: actorUser.last_name,
      position: actorUser.position,
      dateThaiLong: new Date().toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }),
    });
    await saveStampedCopy(att, stampedBuffer, doc?.year_be);
    audit({ userId: actorUser.id, action: 'attachment_director_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId, decision } });
  } catch (err) {
    audit({ userId: actorUser.id, action: 'attachment_director_stamp_failed', tableName: 'attachments', recordId: att.id, detail: { documentId, decision, error: err.message } });
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
  const stampedBuffer = await stampPdf({
    originalBuffer,
    schoolName: 'โรงเรียนเจ้าพ่อหลวงอุปถัมภ์ 1',
    docNumberDisplay: doc.doc_number_display,
    dateThaiLong: now.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }),
    timeStr: now.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' }),
    xPercent: doc.stamp_x,
    yPercent: doc.stamp_y,
  });

  await saveStampedCopy(att, stampedBuffer, doc.year_be);
  audit({ userId: ctx.user.id, action: 'attachment_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId: doc.id } });
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

// Node's raw HTTP headers only accept Latin-1 bytes — a Thai filename (the norm here) throws
// "Invalid character in header content" if put straight into Content-Disposition. RFC 5987's
// filename* carries the real UTF-8 name; filename= keeps an ASCII-only fallback for old clients.
function contentDispositionHeader(filename) {
  const asciiFallback = filename.replace(/[^\x20-\x7E]/g, '').replace(/"/g, '') || 'document.pdf';
  return `inline; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

// ---------------- file serving (ACL-checked, not static — proxied even for Google Drive so ACL always applies) ----------------
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
