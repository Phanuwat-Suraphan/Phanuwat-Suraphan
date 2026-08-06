import { router, html, json, redirect } from '../router.js';
import { layout, esc, fmtDate, priorityBadge, secretBadge, statusBadge, emptyState, LABELS } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, uuid, nowIso, audit, RETENTION_LABEL } from '../db.js';
import {
  createDocument, getDocument, canUserSeeDocument, getWorkflowSteps, currentStep,
  assignStep, approveAndForward, acknowledgeAndComplete, rejectStep, returnStep,
  voidDocument, archiveDocument, httpError,
} from '../services/workflow.js';
import { extractTextFromPdf, guessFieldsFromText } from '../services/ocr.js';
import { isGoogleDriveEnabled, ensureCategoryFolder, uploadFile, downloadFileStream } from '../services/googleDrive.js';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ALLOWED_MIME = new Set(['application/pdf']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;

function listDeptOptions(selected) {
  return db.prepare('SELECT * FROM departments ORDER BY name').all()
    .map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
}
function listTypeOptions(selected) {
  return db.prepare('SELECT * FROM document_types ORDER BY name').all()
    .map((t) => `<option value="${t.id}" ${t.id === selected ? 'selected' : ''}>${esc(t.name)}</option>`).join('');
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
      <td><strong>${esc(d.doc_number_display)}</strong></td>
      <td>${esc(d.title)}${d.secret_level !== 'normal' ? ' 🔒' : ''}</td>
      <td>${esc(d.type_name)}</td>
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
        <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ประเภท</th><th>ฝ่าย</th><th>ความเร็ว</th><th>สถานะ</th><th>วันที่</th></tr></thead>
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
            <label>เลขหนังสือ${direction === 'incoming' ? 'จากต้นทาง (ถ้ามี)' : 'อ้างอิง (ถ้ามี)'}</label>
            <input type="text" name="externalDocNumber" placeholder="เช่น ศธ 04123/55 หรือเว้นว่างถ้าไม่มี" />
          </div>
          <div class="field">
            <label>ลงวันที่ (วันที่ในหนังสือต้นฉบับ)</label>
            <input type="date" name="externalDocDate" />
          </div>
          <div class="field">
            <label>ประเภทเอกสาร *</label>
            <select name="docTypeId" required>${listTypeOptions()}</select>
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
        <div class="field">
          <label>สาระสำคัญ / หมายเหตุ</label>
          <textarea name="subject" placeholder="สรุปใจความสำคัญของหนังสือ"></textarea>
        </div>
        <div class="field">
          <label>แนบไฟล์ PDF</label>
          <input type="file" id="fileInput" accept="application/pdf" onchange="attachFilePreview(this,'filePreview')" />
          <div id="filePreview" class="help-text"></div>
          <div class="help-text">รองรับเฉพาะไฟล์ PDF ขนาดไม่เกิน 10MB (ระบบจะตรวจ magic number และคำนวณ SHA-256 hash)</div>
          <button type="button" class="btn btn-outline btn-sm" style="margin-top:.5rem" onclick="runOcrExtract(this)">🔍 อ่านข้อมูลจากไฟล์อัตโนมัติ (OCR)</button>
          <div class="help-text">ใช้ Tesseract OCR อ่านตัวอักษรจากไฟล์ที่แนบไว้ด้านบน แล้วลองกรอกฟิลด์ให้อัตโนมัติ — <strong>เป็นการเดาเบื้องต้นเท่านั้น กรุณาตรวจสอบความถูกต้องทุกครั้งก่อนบันทึก</strong></div>
          <div id="ocrResult"></div>
        </div>
        <button class="btn btn-primary" type="submit">บันทึกและออกเลข${direction === 'incoming' ? 'รับ' : 'ส่ง'}อัตโนมัติ</button>
        <a class="btn btn-outline" href="/documents?direction=${direction}">ยกเลิก</a>
      </form>
    </div>
    <script>
      document.getElementById('docForm').addEventListener('submit', function(e){
        e.preventDefault();
        submitWithFile(this, 'fileInput', '/documents', { submitLabel: 'บันทึก' });
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
  if (buf.length > MAX_FILE_BYTES) throw httpError(413, 'ไฟล์มีขนาดใหญ่เกิน 10MB');
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'ไฟล์ไม่ใช่ PDF ที่ถูกต้อง (ตรวจสอบ file signature ไม่ผ่าน)');

  const text = await extractTextFromPdf(buf);
  const fields = guessFieldsFromText(text);
  audit({ userId: ctx.user.id, action: 'ocr_extract_attempted', tableName: 'documents', recordId: null, detail: { textLength: text.length } });
  json(ctx, 200, fields);
}));

// ---------------- create ----------------
router.post('/documents', requireApi(async (ctx) => {
  const b = ctx.body;
  if (!b.title || !b.correspondentName || !b.docTypeId || !b.departmentId) {
    throw httpError(400, 'กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน (ชื่อเรื่อง, หน่วยงาน, ประเภท, ฝ่าย)');
  }
  const doc = createDocument({
    direction: b.direction === 'outgoing' ? 'outgoing' : 'incoming',
    title: b.title.trim(), subject: b.subject?.trim(), docTypeId: b.docTypeId, departmentId: b.departmentId,
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

  const timelineHtml = steps.length ? `<ul class="timeline">
    ${steps.map((s) => {
      const cls = s.status === 'waiting' ? '' : (s.status === 'rejected' || s.status === 'returned' ? 'rejected' : 'done');
      const statusText = { waiting: 'รอดำเนินการ', approved: 'อนุมัติ ส่งต่อแล้ว', acknowledged: 'รับทราบ/เสร็จสิ้น', rejected: 'ไม่อนุมัติ', returned: 'ส่งกลับแก้ไข' }[s.status];
      const showSignature = ['approved', 'acknowledged'].includes(s.status) && s.signature_image;
      return `<li class="${cls}">
        <div class="t-title">ขั้นที่ ${s.step_order}: ${esc(s.prefix || '')}${esc(s.first_name)} ${esc(s.last_name)} — ${statusText}</div>
        <div class="t-meta">มอบหมาย ${fmtDate(s.created_at)}${s.decided_at ? ' · ดำเนินการ ' + fmtDate(s.decided_at) : ''}</div>
        ${s.instruction ? `<div class="t-note">${esc(s.instruction).replace(/\n/g, '<br/>')}</div>` : ''}
        ${showSignature ? `<div class="t-note"><img src="${esc(s.signature_image)}" alt="ลายเซ็น ${esc(s.first_name)} ${esc(s.last_name)}" style="max-height:60px;max-width:180px;border-bottom:1px solid var(--border);padding-bottom:2px" /></div>` : ''}
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
          <textarea id="stepComment" placeholder="เช่น มอบฝ่ายวิชาการดำเนินการ, เห็นชอบ, โปรดพิจารณา"></textarea>
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
        if (!next) { alert('กรุณาเลือกผู้รับที่จะส่งต่อ ก่อนกดอนุมัติ (ถ้าเป็นผู้รับคนสุดท้ายให้กด "รับทราบ/ปิดเรื่อง" แทน)'); return; }
        actionWithPin(btn, '/documents/${doc.id}/workflow/${step.id}/approve', { nextAssigneeId: next, comment: comment });
      }
      function doAcknowledge(btn){
        var comment = document.getElementById('stepComment').value;
        actionWithPin(btn, '/documents/${doc.id}/workflow/${step.id}/acknowledge', { comment: comment });
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
          .catch(e => { alert(e.message); btn.disabled = false; });
      }
    </script>` : '';

  const content = `
    ${ctx.query.created ? '<div class="alert alert-success">✅ บันทึกและออกเลขเอกสารเรียบร้อยแล้ว</div>' : ''}
    ${ctx.query.warn ? `<div class="alert alert-warning">⚠️ ${esc(ctx.query.warn)}</div>` : ''}
    <div class="card-header">
      <div>
        <h2 class="mt-0">${esc(doc.doc_number_display)} — ${esc(doc.title)}</h2>
        <div class="chip-row">${statusBadge(doc.status)}${priorityBadge(doc.priority)}${secretBadge(doc.secret_level)}</div>
      </div>
      <div class="chip-row">
        ${canVoid ? `<button class="btn btn-outline btn-sm" onclick="actionWithReason(this, '/documents/${doc.id}/void', 'ระบุเหตุผลที่ยกเลิกเอกสาร (เลขที่จะยังคงอยู่ในลำดับ ไม่ถูกนำไปใช้ซ้ำ)')">ยกเลิกเอกสาร</button>` : ''}
        ${canArchive ? `<button class="btn btn-outline btn-sm" onclick="fetch('/documents/${doc.id}/archive',{method:'POST'}).then(()=>location.reload())">📦 จัดเก็บเข้าแฟ้ม</button>` : ''}
      </div>
    </div>

    <div class="grid-2">
      <div>
        <div class="card">
          <h3>รายละเอียด</h3>
          <table style="min-width:0">
            <tbody>
              <tr><td class="text-muted">${doc.direction === 'incoming' ? 'หน่วยงานต้นทาง' : 'หน่วยงานปลายทาง'}</td><td>${esc(doc.correspondent_name)}</td></tr>
              ${doc.external_doc_number ? `<tr><td class="text-muted">เลขหนังสืออ้างอิง</td><td>${esc(doc.external_doc_number)}</td></tr>` : ''}
              ${doc.external_doc_date ? `<tr><td class="text-muted">ลงวันที่</td><td>${esc(doc.external_doc_date)}</td></tr>` : ''}
              <tr><td class="text-muted">ประเภท</td><td>${esc(doc.type_name)}</td></tr>
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
          ${attachments.length ? attachments.map((a) => `
            <div class="flex items-center justify-between" style="padding:.5rem 0;border-bottom:1px solid var(--border)">
              <div>📄 ${esc(a.filename)} <span class="text-muted" style="font-size:.78rem">(${Math.round(a.filesize / 1024)} KB)</span></div>
              <a class="btn btn-sm btn-outline" href="/files/${a.id}" target="_blank" rel="noopener">เปิดดู</a>
            </div>`).join('') : emptyState('📎', 'ยังไม่มีไฟล์แนบ')}
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
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/workflow/:stepId/acknowledge', requireApi(async (ctx) => {
  const { pin, comment } = ctx.body;
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
  acknowledgeAndComplete({ stepId: ctx.params.stepId, comment, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/workflow/:stepId/reject', requireApi(async (ctx) => {
  rejectStep({ stepId: ctx.params.stepId, reason: ctx.body.reason, actorUser: ctx.user });
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
router.get('/files/:attachmentId', requirePage(async (ctx) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(ctx.params.attachmentId);
  if (!att) return html(ctx, 404, '<h1>404</h1>');
  const doc = getDocument(att.document_id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) {
    return html(ctx, 403, '<h1>403</h1><p>คุณไม่มีสิทธิ์เปิดไฟล์นี้</p>');
  }

  if (att.storage_provider === 'google_drive') {
    let stream;
    try {
      stream = await downloadFileStream(att.drive_file_id);
    } catch (err) {
      return html(ctx, err.statusCode || 502, `<h1>เกิดข้อผิดพลาด</h1><p>${esc(err.message)}</p>`);
    }
    if (!stream) return html(ctx, 404, '<h1>ไม่พบไฟล์บน Google Drive</h1>');
    audit({ userId: ctx.user.id, action: 'attachment_opened', tableName: 'attachments', recordId: att.id, ip: ctx.ip });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="${att.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    Readable.fromWeb(stream).pipe(ctx.res);
    return;
  }

  const filePath = path.join(UPLOAD_DIR, att.filepath);
  if (!fs.existsSync(filePath)) return html(ctx, 404, '<h1>ไม่พบไฟล์</h1>');
  audit({ userId: ctx.user.id, action: 'attachment_opened', tableName: 'attachments', recordId: att.id, ip: ctx.ip });
  ctx.res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': `inline; filename="${att.filename.replace(/"/g, '')}"`,
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(ctx.res);
}));
