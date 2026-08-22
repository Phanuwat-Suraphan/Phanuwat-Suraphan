import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { router, html, json, contentDispositionHeader } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateShort, fmtThaiDateLong } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, uuid, audit, beYear } from '../db.js';
import {
  LEAVE_TYPE_LABEL, decisionVerb, createLeaveRequest, getLeaveRequest, listMyLeaveRequests, listPendingApprovals,
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest, canSeeLeaveRequest,
  listLeaveSignatures, listLeaveAttachments, getLeaveAttachment, insertLeaveAttachment,
  assertAllowedLeaveFile, MAX_LEAVE_FILE_BYTES, httpError,
} from '../services/leave.js';
import { isGoogleDriveEnabled, ensureCategoryFolder, uploadFile, downloadFileStream } from '../services/googleDrive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

const STATUS_BADGE = { pending: 'badge-warning', approved: 'badge-success', rejected: 'badge-danger', cancelled: 'badge-muted' };
// ป้ายสถานะใช้คำ "อนุมัติ" หรือ "อนุญาต" ตามประเภทการลา (ไปราชการ = อนุมัติ, ลาส่วนตัว = อนุญาต)
function leaveStatusBadge(status, leaveType) {
  const verb = decisionVerb(leaveType);
  const label = { pending: `รอ${verb}`, approved: `${verb}แล้ว`, rejected: `ไม่${verb}`, cancelled: 'ยกเลิกแล้ว' }[status] || status;
  return `<span class="badge ${STATUS_BADGE[status] || 'badge-muted'}">${esc(label)}</span>`;
}

function listApproverOptions(excludeId) {
  return db.prepare(`
    SELECT u.*, GROUP_CONCAT(r.name_th) as role_names FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.deleted_at IS NULL AND u.status = 'active' GROUP BY u.id ORDER BY u.first_name
  `).all()
    .filter((u) => u.id !== excludeId)
    .map((u) => `<option value="${u.id}">${esc(u.prefix || '')}${esc(u.first_name)} ${esc(u.last_name)} — ${esc(u.role_names || u.position || '')}</option>`).join('');
}

router.get('/leave', requirePage((ctx) => {
  const mine = listMyLeaveRequests(ctx.user.id);
  const pending = listPendingApprovals(ctx.user.id);

  const rowHtml = (r, showRequester) => `
    <tr onclick="location.href='/leave/${r.id}'" style="cursor:pointer">
      <td>${esc(LEAVE_TYPE_LABEL[r.leave_type])}</td>
      ${showRequester ? `<td>${esc(r.requester_prefix || '')}${esc(r.requester_first)} ${esc(r.requester_last)}</td>` : ''}
      <td>${esc(fmtThaiDateShort(r.start_date))} — ${esc(fmtThaiDateShort(r.end_date))}</td>
      <td>${r.days_count} วัน</td>
      <td>${leaveStatusBadge(r.status, r.leave_type)}</td>
      <td class="text-muted">${fmtDate(r.created_at)}</td>
    </tr>`;

  const content = `
    <div class="card-header">
      <h2 class="mt-0">🗓️ ลา / ไปราชการ</h2>
      <a class="btn btn-primary" href="/leave/new">+ ยื่นคำขอใหม่</a>
    </div>

    ${pending.length ? `
    <div class="card">
      <h3 class="mt-0">รอพิจารณาจากคุณ (${pending.length})</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>ประเภท</th><th>ผู้ขอ</th><th>ช่วงวันที่</th><th>จำนวนวัน</th><th>สถานะ</th><th>ยื่นเมื่อ</th></tr></thead>
        <tbody>${pending.map((r) => rowHtml(r, true)).join('')}</tbody>
      </table></div>
    </div>` : ''}

    <div class="card">
      <h3 class="mt-0">คำขอของฉัน (${mine.length})</h3>
      ${mine.length ? `<div class="table-wrap"><table>
        <thead><tr><th>ประเภท</th><th>ช่วงวันที่</th><th>จำนวนวัน</th><th>สถานะ</th><th>ยื่นเมื่อ</th></tr></thead>
        <tbody>${mine.map((r) => rowHtml(r, false)).join('')}</tbody>
      </table></div>` : '<p class="text-muted">ยังไม่มีคำขอ</p>'}
    </div>`;

  html(ctx, 200, layout({ user: ctx.user, title: 'ลา/ไปราชการ', path: '/leave', content }));
}));

router.get('/leave/new', requirePage((ctx) => {
  const content = `
    <h2>🗓️ ยื่นคำขอลา/ไปราชการ</h2>
    <div class="card">
      <form id="leaveForm" class="stack">
        <div class="form-grid cols-2">
          <div class="field">
            <label>ประเภท *</label>
            <select id="leaveType" required onchange="document.getElementById('destinationField').style.display = this.value === 'official_travel' ? '' : 'none'">
              ${Object.entries(LEAVE_TYPE_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
            </select>
          </div>
          <div class="field">
            <label>ผู้อนุมัติ/อนุญาต *</label>
            <select id="approverId" required>${listApproverOptions(ctx.user.id)}</select>
          </div>
          <div class="field">
            <label>วันที่เริ่ม *</label>
            <input type="date" id="startDate" required />
          </div>
          <div class="field">
            <label>วันที่สิ้นสุด *</label>
            <input type="date" id="endDate" required />
          </div>
        </div>
        <div class="field" id="destinationField" style="display:none">
          <label>สถานที่ไปราชการ</label>
          <input type="text" id="destination" placeholder="เช่น สพฐ., โรงแรม..." />
        </div>
        <div class="field">
          <label>เหตุผล *</label>
          <textarea id="reason" required placeholder="ระบุเหตุผลการลา/ไปราชการ"></textarea>
        </div>
        <div class="field">
          <label>ช่องทางติดต่อระหว่างลา (ถ้ามี)</label>
          <input type="text" id="contactInfo" placeholder="เบอร์โทร/LINE" />
        </div>
        <div class="field">
          <label>มอบหมายผู้รักษาการแทน (ถ้ามี)</label>
          <select id="delegateId"><option value="">— ไม่มอบหมาย —</option>${listApproverOptions(ctx.user.id)}</select>
          <div class="help-text">ถ้าเลือกไว้ เมื่อคำขอนี้ได้รับการอนุมัติ/อนุญาตแล้ว ผู้ที่เลือกจะดำเนินการ (อนุมัติ/ส่งต่อ/รับทราบ) แทนคุณได้ทันทีตลอดช่วงวันที่ลานี้</div>
        </div>
        <button class="btn btn-primary" type="submit">ยื่นคำขอ</button>
        <a class="btn btn-outline" href="/leave">ยกเลิก</a>
      </form>
    </div>
    <script>
      document.getElementById('leaveForm').addEventListener('submit', function(e){
        e.preventDefault();
        var payload = {
          leaveType: document.getElementById('leaveType').value,
          approverId: document.getElementById('approverId').value,
          startDate: document.getElementById('startDate').value,
          endDate: document.getElementById('endDate').value,
          destination: document.getElementById('destination').value,
          reason: document.getElementById('reason').value,
          contactInfo: document.getElementById('contactInfo').value,
          delegateId: document.getElementById('delegateId').value,
        };
        fetch('/leave', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})
          .then(r => r.json().then(d => ({ok:r.ok,d})))
          .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.href = '/leave/' + d.id; })
          .catch(e => toast(e.message, 'danger'));
      });
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'ยื่นคำขอลา', path: '/leave/new', content }));
}));

router.get('/leave/:id', requirePage((ctx) => {
  const req = getLeaveRequest(ctx.params.id);
  // ตอบ 404 เหมือนกันทั้งกรณีไม่มีจริงและกรณีไม่มีสิทธิ์ดู เพื่อไม่ให้เดาได้ว่าใครลาอยู่บ้าง
  if (!req || !canSeeLeaveRequest(req, ctx.user)) {
    return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบข้อมูล', path: '/leave', content: '<p>ไม่พบคำขอนี้</p>' }));
  }
  const canDecide = req.status === 'pending' && req.requester_id !== ctx.user.id
    && (req.approver_id === ctx.user.id || ctx.user.roleCodes.includes('admin'));
  const canCancel = req.status === 'pending' && req.requester_id === ctx.user.id;
  const canAttach = req.status === 'pending' && (req.requester_id === ctx.user.id || ctx.user.roleCodes.includes('admin'));
  const attachments = listLeaveAttachments(req.id);
  const signatures = listLeaveSignatures(req.id);

  const STEP_LABEL = {
    requested: 'ผู้ขอลงนามรับรองข้อความในใบลา',
    approved: `ผู้${decisionVerb(req.leave_type)}ลงนาม${decisionVerb(req.leave_type)}`,
    rejected: `ผู้${decisionVerb(req.leave_type)}ลงนามไม่${decisionVerb(req.leave_type)}`,
    cancelled: 'ผู้ขอยกเลิกคำขอ',
  };
  // ลายเซ็นที่แสดงเป็น "สำเนา ณ ขณะลงนาม" ที่ตรึงไว้ในตาราง leave_signatures ไม่ใช่ค่าปัจจุบันของโปรไฟล์
  // ถ้าดึงจากโปรไฟล์ วันไหนเจ้าตัวเปลี่ยน/ลบลายเซ็น หลักฐานบนใบลาที่ลงนามไปแล้วจะเปลี่ยน/หายย้อนหลังตามไปด้วย
  const signatureHtml = signatures.length ? `
    <div class="card">
      <h3 class="mt-0">🖋️ ลายเซ็นรับรอง (${signatures.length} ขั้นตอน)</h3>
      <p class="text-muted" style="margin-top:-.4rem;font-size:.85rem">
        เก็บเป็นภาพ ณ ขณะที่ลงนามจริง ไม่เปลี่ยนตามโปรไฟล์ที่แก้ไขภายหลัง — ใช้อ้างอิงเป็นหลักฐานได้
      </p>
      <div class="stack">
        ${signatures.map((sg) => `
          <div style="border:1px solid var(--border);border-radius:8px;padding:.7rem">
            <div style="font-weight:600;font-size:.9rem">${esc(STEP_LABEL[sg.step] || sg.step)}</div>
            <div class="text-muted" style="font-size:.8rem">${fmtDate(sg.signed_at)}</div>
            ${sg.note ? `<div style="margin-top:.3rem">${esc(sg.note)}</div>` : ''}
            <div style="text-align:center;margin-top:.5rem;color:var(--primary)">
              ${sg.signature_image
                ? `<img src="${esc(sg.signature_image)}" alt="ลายเซ็น ${esc(sg.signer_name)}" style="max-height:56px;max-width:180px" />`
                : '<div class="text-muted" style="font-size:.8rem">(ไม่ได้บันทึกลายเซ็นไว้ในโปรไฟล์ขณะลงนาม)</div>'}
              <div style="border-top:1px solid var(--primary);padding-top:.25rem;margin-top:.2rem;font-size:.82rem">
                <div>(${esc(sg.signer_name)})</div>
                ${sg.signer_position ? `<div>${esc(sg.signer_position)}</div>` : ''}
              </div>
            </div>
          </div>`).join('')}
      </div>
    </div>` : '';

  const evidenceHtml = `
    <div class="card">
      <div class="card-header"><h3 class="mt-0">📎 หลักฐานแนบ (${attachments.length})</h3></div>
      ${req.leave_type === 'sick' && !attachments.length && canAttach
        ? '<div class="alert alert-warning">ลาป่วย — ควรแนบใบนัดแพทย์/ใบรับรองแพทย์เป็นหลักฐานประกอบ</div>' : ''}
      ${attachments.length ? `<div class="stack">${attachments.map((a) => `
        <div class="flex items-center justify-between gap-2 flex-wrap" style="padding:.4rem 0;border-bottom:1px solid var(--border)">
          <span>${a.mime_type === 'application/pdf' ? '📄' : '🖼️'} ${esc(a.filename)}
            <span class="text-muted" style="font-size:.78rem">(${Math.round(a.filesize / 1024)} KB · ${fmtDate(a.created_at)})</span></span>
          <a class="btn btn-sm btn-outline" href="/leave-files/${a.id}" target="_blank" rel="noopener">เปิดดู</a>
        </div>`).join('')}</div>` : '<p class="text-muted">ยังไม่มีหลักฐานแนบ</p>'}
      ${canAttach ? `
      <form id="leaveAttachForm" style="margin-top:.8rem">
        <input type="file" id="leaveAttachInput" accept="application/pdf,image/jpeg,image/png" />
        <div class="help-text">แนบใบนัดแพทย์/ใบรับรองแพทย์ หรือหลักฐานประกอบอื่นๆ — รองรับ PDF, JPG, PNG ขนาดไม่เกิน 10MB (ถ่ายจากมือถือได้เลย)</div>
        <button class="btn btn-outline btn-sm" style="margin-top:.5rem" type="submit">แนบหลักฐาน</button>
      </form>
      <div class="help-text">แนบได้เฉพาะตอนที่ยังไม่ตัดสิน — หลังจากนั้นชุดหลักฐานจะถูกตรึงไว้ตรงกับที่ผู้${esc(decisionVerb(req.leave_type))}เห็นตอนลงนาม</div>` : ''}
    </div>`;

  const content = `
    <h2>${esc(LEAVE_TYPE_LABEL[req.leave_type])}</h2>
    <div class="card">
      <table class="table-plain">
        <tbody>
          <tr><td class="text-muted">สถานะ</td><td>${leaveStatusBadge(req.status, req.leave_type)}</td></tr>
          <tr><td class="text-muted">ผู้ขอ</td><td>${esc(req.requester_prefix || '')}${esc(req.requester_first)} ${esc(req.requester_last)}</td></tr>
          <tr><td class="text-muted">ผู้${esc(decisionVerb(req.leave_type))}</td><td>${esc(req.approver_first)} ${esc(req.approver_last)}</td></tr>
          <tr><td class="text-muted">ช่วงวันที่</td><td>${esc(fmtThaiDateLong(req.start_date))} — ${esc(fmtThaiDateLong(req.end_date))} (${req.days_count} วัน)</td></tr>
          ${req.destination ? `<tr><td class="text-muted">สถานที่</td><td>${esc(req.destination)}</td></tr>` : ''}
          <tr><td class="text-muted">เหตุผล</td><td>${esc(req.reason)}</td></tr>
          ${req.contact_info ? `<tr><td class="text-muted">ติดต่อระหว่างลา</td><td>${esc(req.contact_info)}</td></tr>` : ''}
          ${req.delegate_id ? `<tr><td class="text-muted">ผู้รักษาการแทน</td><td>${esc(req.delegate_prefix || '')}${esc(req.delegate_first)} ${esc(req.delegate_last)}${req.status === 'approved' ? ' <span class="badge badge-success">มอบหมายแล้ว</span>' : ' <span class="text-muted">(จะมอบหมายจริงเมื่ออนุมัติ)</span>'}</td></tr>` : ''}
          ${req.decision_note ? `<tr><td class="text-muted">หมายเหตุการพิจารณา</td><td>${esc(req.decision_note)}</td></tr>` : ''}
          <tr><td class="text-muted">ยื่นเมื่อ</td><td>${fmtDate(req.created_at)}</td></tr>
        </tbody>
      </table>
      ${canDecide ? `
      <div class="chip-row" style="margin-top:1rem">
        <button class="btn btn-primary btn-sm" onclick="decide('approve')">✅ ${esc(decisionVerb(req.leave_type))}</button>
        <button class="btn btn-outline btn-sm" onclick="decide('reject')">❌ ไม่${esc(decisionVerb(req.leave_type))}</button>
      </div>` : ''}
      ${canCancel ? `<button class="btn btn-outline btn-sm" style="margin-top:1rem" onclick="cancelRequest()">ยกเลิกคำขอ</button>` : ''}
    </div>
    ${evidenceHtml}
    ${signatureHtml}
    <script>
      var attachForm = document.getElementById('leaveAttachForm');
      if (attachForm) attachForm.addEventListener('submit', function (e) {
        e.preventDefault();
        window.submitWithFile(this, 'leaveAttachInput', '/leave/${req.id}/attachments', {});
      });
      function decide(action) {
        var note = prompt(action === 'reject' ? 'ระบุเหตุผลที่ไม่${esc(decisionVerb(req.leave_type))}' : 'หมายเหตุ (ถ้ามี)');
        if (note === null) return;
        if (action === 'reject' && !note.trim()) { toast('กรุณาระบุเหตุผล', 'warning'); return; }
        fetch('/leave/${req.id}/' + action, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({note})})
          .then(r => r.json().then(d => ({ok:r.ok,d})))
          .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
          .catch(e => toast(e.message, 'danger'));
      }
      function cancelRequest() {
        if (!confirm('ยืนยันยกเลิกคำขอนี้?')) return;
        fetch('/leave/${req.id}/cancel', {method:'POST'})
          .then(r => r.json().then(d => ({ok:r.ok,d})))
          .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
          .catch(e => toast(e.message, 'danger'));
      }
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'รายละเอียดคำขอ', path: '/leave', content }));
}));

router.post('/leave', requireApi(async (ctx) => {
  const b = ctx.body;
  const result = createLeaveRequest({
    requesterId: ctx.user.id, leaveType: b.leaveType, startDate: b.startDate, endDate: b.endDate,
    reason: b.reason, destination: b.destination, contactInfo: b.contactInfo, approverId: b.approverId,
    delegateId: b.delegateId || null,
  });
  json(ctx, 201, { id: result.id });
}));

router.post('/leave/:id/approve', requireApi(async (ctx) => {
  approveLeaveRequest({ id: ctx.params.id, note: ctx.body.note, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/leave/:id/reject', requireApi(async (ctx) => {
  rejectLeaveRequest({ id: ctx.params.id, note: ctx.body.note, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/leave/:id/cancel', requireApi(async (ctx) => {
  cancelLeaveRequest({ id: ctx.params.id, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

// ---------------- ไฟล์หลักฐานแนบใบลา ----------------
// สิทธิ์เข้าถึงผูกกับใบลาเสมอ (canSeeLeaveRequest) — ใบลาป่วยมีข้อมูลสุขภาพซึ่งเป็นเรื่องส่วนตัว
// คนที่ไม่เกี่ยวข้องต้องเปิดไม่ได้ทั้งตัวใบลาและไฟล์แนบ ไม่ใช่แค่ซ่อนลิงก์ไว้ในหน้าเว็บ
router.post('/leave/:id/attachments', requireApi(async (ctx) => {
  const req = getLeaveRequest(ctx.params.id);
  if (!req || !canSeeLeaveRequest(req, ctx.user)) throw httpError(404, 'ไม่พบใบลานี้');
  // แนบได้เฉพาะเจ้าของใบลา (หรือแอดมิน) และเฉพาะตอนที่ยังไม่ตัดสิน — หลังอนุมัติแล้วห้ามเพิ่มหลักฐาน
  // ย้อนหลัง ไม่งั้นชุดหลักฐานที่ผู้อนุมัติเห็นตอนลงนามกับที่เก็บไว้จะไม่ตรงกัน
  if (req.requester_id !== ctx.user.id && !ctx.user.roleCodes.includes('admin')) {
    throw httpError(403, 'แนบหลักฐานได้เฉพาะเจ้าของใบลาเท่านั้น');
  }
  if (req.status !== 'pending') throw httpError(409, 'ใบลานี้ตัดสินไปแล้ว แนบหลักฐานเพิ่มไม่ได้');

  const { fileName, fileType, fileDataBase64 } = ctx.body;
  if (!fileDataBase64) throw httpError(400, 'ไม่พบไฟล์');
  const buffer = Buffer.from(fileDataBase64, 'base64');
  const ext = assertAllowedLeaveFile({ mimeType: fileType, buffer });

  const id = uuid();
  const hash = crypto.createHash('sha256').update(buffer).digest('hex');
  const safeName = `${id}.${ext}`;
  if (isGoogleDriveEnabled()) {
    const folderId = await ensureCategoryFolder({ yearBe: beYear(new Date()), typeName: 'ใบลา-หลักฐานแนบ' });
    const driveFileId = await uploadFile({ buffer, filename: `${id}__${fileName || safeName}`, mimeType: fileType, folderId });
    insertLeaveAttachment({ id, leaveRequestId: req.id, filename: fileName || safeName, storageProvider: 'google_drive',
      driveFileId, filesize: buffer.length, mimeType: fileType, hash, uploadedBy: ctx.user.id });
  } else {
    fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buffer);
    insertLeaveAttachment({ id, leaveRequestId: req.id, filename: fileName || safeName, storageProvider: 'local',
      filepath: safeName, filesize: buffer.length, mimeType: fileType, hash, uploadedBy: ctx.user.id });
  }
  audit({ userId: ctx.user.id, action: 'leave_attachment_uploaded', tableName: 'leave_attachments', recordId: id, detail: { leaveRequestId: req.id, filename: fileName } });
  json(ctx, 201, { id });
}));

router.get('/leave-files/:attId', requirePage(async (ctx) => {
  const att = getLeaveAttachment(ctx.params.attId);
  if (!att) throw httpError(404, 'ไม่พบไฟล์');
  const req = getLeaveRequest(att.leave_request_id);
  if (!req || !canSeeLeaveRequest(req, ctx.user)) throw httpError(404, 'ไม่พบไฟล์');

  let buffer;
  if (att.storage_provider === 'google_drive') {
    const stream = await downloadFileStream(att.drive_file_id);
    if (!stream) throw httpError(404, 'เปิดไฟล์บน Google Drive ไม่ได้');
    const chunks = [];
    for await (const chunk of Readable.fromWeb(stream)) chunks.push(chunk);
    buffer = Buffer.concat(chunks);
  } else {
    const full = path.join(UPLOAD_DIR, att.filepath);
    if (!fs.existsSync(full)) throw httpError(404, 'ไม่พบไฟล์บนเซิร์ฟเวอร์');
    buffer = fs.readFileSync(full);
  }
  audit({ userId: ctx.user.id, action: 'leave_attachment_viewed', tableName: 'leave_attachments', recordId: att.id });
  ctx.res.writeHead(200, {
    'Content-Type': att.mime_type,
    'Content-Length': buffer.length,
    'Content-Disposition': contentDispositionHeader(att.filename, 'leave-evidence'),
    'X-Content-Type-Options': 'nosniff',
  });
  ctx.res.end(buffer);
}));
