import { router, html, json } from '../router.js';
import { layout, esc, fmtDate } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db } from '../db.js';
import {
  LEAVE_TYPE_LABEL, createLeaveRequest, getLeaveRequest, listMyLeaveRequests, listPendingApprovals,
  approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest,
} from '../services/leave.js';

const STATUS_LABEL = { pending: 'รออนุมัติ', approved: 'อนุมัติแล้ว', rejected: 'ไม่อนุมัติ', cancelled: 'ยกเลิกแล้ว' };
const STATUS_BADGE = { pending: 'badge-warning', approved: 'badge-success', rejected: 'badge-danger', cancelled: 'badge-muted' };
function leaveStatusBadge(s) {
  return `<span class="badge ${STATUS_BADGE[s] || 'badge-muted'}">${esc(STATUS_LABEL[s] || s)}</span>`;
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
      <td>${esc(r.start_date)} — ${esc(r.end_date)}</td>
      <td>${r.days_count} วัน</td>
      <td>${leaveStatusBadge(r.status)}</td>
      <td class="text-muted">${fmtDate(r.created_at)}</td>
    </tr>`;

  const content = `
    <div class="card-header">
      <h2 class="mt-0">🗓️ ลา / ไปราชการ</h2>
      <a class="btn btn-primary" href="/leave/new">+ ยื่นคำขอใหม่</a>
    </div>

    ${pending.length ? `
    <div class="card">
      <h3 class="mt-0">รออนุมัติจากคุณ (${pending.length})</h3>
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
            <label>ผู้อนุมัติ *</label>
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
        };
        fetch('/leave', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})
          .then(r => r.json().then(d => ({ok:r.ok,d})))
          .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.href = '/leave/' + d.id; })
          .catch(e => alert(e.message));
      });
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'ยื่นคำขอลา', path: '/leave/new', content }));
}));

router.get('/leave/:id', requirePage((ctx) => {
  const req = getLeaveRequest(ctx.params.id);
  if (!req) return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบข้อมูล', path: '/leave', content: '<p>ไม่พบคำขอนี้</p>' }));
  const canDecide = req.status === 'pending' && (req.approver_id === ctx.user.id || ctx.user.roleCodes.includes('admin'));
  const canCancel = req.status === 'pending' && req.requester_id === ctx.user.id;

  const content = `
    <h2>${esc(LEAVE_TYPE_LABEL[req.leave_type])}</h2>
    <div class="card">
      <table>
        <tbody>
          <tr><td class="text-muted">สถานะ</td><td>${leaveStatusBadge(req.status)}</td></tr>
          <tr><td class="text-muted">ผู้ขอ</td><td>${esc(req.requester_prefix || '')}${esc(req.requester_first)} ${esc(req.requester_last)}</td></tr>
          <tr><td class="text-muted">ผู้อนุมัติ</td><td>${esc(req.approver_first)} ${esc(req.approver_last)}</td></tr>
          <tr><td class="text-muted">ช่วงวันที่</td><td>${esc(req.start_date)} — ${esc(req.end_date)} (${req.days_count} วัน)</td></tr>
          ${req.destination ? `<tr><td class="text-muted">สถานที่</td><td>${esc(req.destination)}</td></tr>` : ''}
          <tr><td class="text-muted">เหตุผล</td><td>${esc(req.reason)}</td></tr>
          ${req.contact_info ? `<tr><td class="text-muted">ติดต่อระหว่างลา</td><td>${esc(req.contact_info)}</td></tr>` : ''}
          ${req.decision_note ? `<tr><td class="text-muted">หมายเหตุการพิจารณา</td><td>${esc(req.decision_note)}</td></tr>` : ''}
          <tr><td class="text-muted">ยื่นเมื่อ</td><td>${fmtDate(req.created_at)}</td></tr>
        </tbody>
      </table>
      ${canDecide ? `
      <div class="chip-row" style="margin-top:1rem">
        <button class="btn btn-primary btn-sm" onclick="decide('approve')">✅ อนุมัติ</button>
        <button class="btn btn-outline btn-sm" onclick="decide('reject')">❌ ไม่อนุมัติ</button>
      </div>` : ''}
      ${canCancel ? `<button class="btn btn-outline btn-sm" style="margin-top:1rem" onclick="cancelRequest()">ยกเลิกคำขอ</button>` : ''}
    </div>
    <script>
      function decide(action) {
        var note = prompt(action === 'reject' ? 'ระบุเหตุผลที่ไม่อนุมัติ' : 'หมายเหตุ (ถ้ามี)');
        if (note === null) return;
        if (action === 'reject' && !note.trim()) { alert('กรุณาระบุเหตุผล'); return; }
        fetch('/leave/${req.id}/' + action, {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({note})})
          .then(r => r.json().then(d => ({ok:r.ok,d})))
          .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
          .catch(e => alert(e.message));
      }
      function cancelRequest() {
        if (!confirm('ยืนยันยกเลิกคำขอนี้?')) return;
        fetch('/leave/${req.id}/cancel', {method:'POST'})
          .then(r => r.json().then(d => ({ok:r.ok,d})))
          .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
          .catch(e => alert(e.message));
      }
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'รายละเอียดคำขอ', path: '/leave', content }));
}));

router.post('/leave', requireApi(async (ctx) => {
  const b = ctx.body;
  const result = createLeaveRequest({
    requesterId: ctx.user.id, leaveType: b.leaveType, startDate: b.startDate, endDate: b.endDate,
    reason: b.reason, destination: b.destination, contactInfo: b.contactInfo, approverId: b.approverId,
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
