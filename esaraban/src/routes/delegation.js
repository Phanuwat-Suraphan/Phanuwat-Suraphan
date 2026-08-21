import { router, html, json } from '../router.js';
import { layout, esc, fmtThaiDateShort } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, todayInBangkok } from '../db.js';
import { createDelegation, listMyDelegations, cancelDelegation } from '../services/delegation.js';

function listUserOptions(excludeId) {
  return db.prepare(`
    SELECT u.*, GROUP_CONCAT(r.name_th) as role_names FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.deleted_at IS NULL AND u.status = 'active' GROUP BY u.id ORDER BY u.first_name
  `).all()
    .filter((u) => u.id !== excludeId)
    .map((u) => `<option value="${u.id}">${esc(u.prefix || '')}${esc(u.first_name)} ${esc(u.last_name)} — ${esc(u.role_names || u.position || '')}</option>`).join('');
}

function statusOf(d) {
  if (d.cancelled_at) return { text: 'ยกเลิกแล้ว', cls: 'badge-muted' };
  const today = todayInBangkok();
  if (d.end_date < today) return { text: 'สิ้นสุดแล้ว', cls: 'badge-muted' };
  if (d.start_date > today) return { text: 'ยังไม่เริ่ม', cls: 'badge-info' };
  return { text: 'กำลังรักษาการ', cls: 'badge-success' };
}

router.get('/delegations', requirePage((ctx) => {
  const rows = listMyDelegations(ctx.user.id);
  const asDelegator = rows.filter((r) => r.delegator_id === ctx.user.id);
  const asDelegate = rows.filter((r) => r.delegate_id === ctx.user.id);

  const rowHtml = (d, showCancel) => {
    const st = statusOf(d);
    return `<tr>
      <td>${esc(d.delegator_prefix || '')}${esc(d.delegator_first)} ${esc(d.delegator_last)}</td>
      <td>${esc(d.delegate_prefix || '')}${esc(d.delegate_first)} ${esc(d.delegate_last)}</td>
      <td>${esc(fmtThaiDateShort(d.start_date))} — ${esc(fmtThaiDateShort(d.end_date))}</td>
      <td>${esc(d.reason || '-')}</td>
      <td><span class="badge ${st.cls}">${st.text}</span></td>
      <td>${showCancel && !d.cancelled_at ? `<button type="button" class="btn btn-sm btn-outline" onclick="cancelDelegation('${d.id}')">ยกเลิก</button>` : ''}</td>
    </tr>`;
  };

  const content = `
    <div class="card-header">
      <h2 class="mt-0">🪪 มอบหมายรักษาการแทน</h2>
    </div>
    <div class="card">
      <p class="text-muted" style="margin-top:0">
        เมื่อคุณไปราชการ/ลา สามารถมอบหมายให้เพื่อนร่วมงานรักษาการแทนในช่วงเวลาที่กำหนดได้ — ระหว่างนั้นผู้รักษาการแทน
        จะเห็นและดำเนินการ (อนุมัติ/ส่งต่อ/รับทราบ/ไม่อนุมัติ) งานที่มอบหมายให้คุณแทนคุณได้ทันที โดยไม่ต้องรอส่งต่องานเอง
        ทีละฉบับ — เหมาะกับกรณีเดินทางไปราชการหรือลาระยะสั้นที่ยังมีเรื่องด่วนเข้ามาระหว่างนั้น
      </p>
      <form id="delegateForm" class="stack">
        <div class="field">
          <label>มอบหมายให้ *</label>
          <select id="delegateId" name="delegateId" required><option value="">— เลือกผู้รักษาการแทน —</option>${listUserOptions(ctx.user.id)}</select>
        </div>
        <div class="grid-2">
          <div class="field"><label>ตั้งแต่วันที่ *</label><input type="date" id="startDate" name="startDate" required /></div>
          <div class="field"><label>ถึงวันที่ *</label><input type="date" id="endDate" name="endDate" required /></div>
        </div>
        <div class="field"><label>เหตุผล/หมายเหตุ</label><input type="text" id="reason" name="reason" placeholder="เช่น ไปราชการอบรมที่กรุงเทพฯ" /></div>
        <button class="btn btn-primary" type="submit">มอบหมาย</button>
      </form>
    </div>

    <div class="card">
      <h3 class="mt-0">รายการที่ฉันมอบหมายให้ผู้อื่นรักษาการแทน</h3>
      ${asDelegator.length ? `<div class="table-wrap"><table>
        <thead><tr><th>ผู้มอบหมาย</th><th>ผู้รักษาการแทน</th><th>ช่วงเวลา</th><th>หมายเหตุ</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>${asDelegator.map((d) => rowHtml(d, true)).join('')}</tbody>
      </table></div>` : '<p class="text-muted">ยังไม่มีการมอบหมาย</p>'}
    </div>

    <div class="card">
      <h3 class="mt-0">รายการที่ฉันได้รับมอบหมายให้รักษาการแทนผู้อื่น</h3>
      ${asDelegate.length ? `<div class="table-wrap"><table>
        <thead><tr><th>ผู้มอบหมาย</th><th>ผู้รักษาการแทน</th><th>ช่วงเวลา</th><th>หมายเหตุ</th><th>สถานะ</th><th></th></tr></thead>
        <tbody>${asDelegate.map((d) => rowHtml(d, false)).join('')}</tbody>
      </table></div>` : '<p class="text-muted">ยังไม่มีใครมอบหมายให้คุณรักษาการแทน</p>'}
    </div>

    <script>
      document.getElementById('delegateForm').addEventListener('submit', function(e){
        e.preventDefault();
        var btn = this.querySelector('button[type=submit]');
        var payload = {
          delegateId: document.getElementById('delegateId').value,
          startDate: document.getElementById('startDate').value,
          endDate: document.getElementById('endDate').value,
          reason: document.getElementById('reason').value,
        };
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        fetch('/delegations', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if(!res.ok) throw new Error(res.d.error); window.toast('มอบหมายเรียบร้อยแล้ว', 'success'); location.reload(); })
          .catch(function(e){ window.toast(e.message, 'danger'); window.restoreBtn(btn); });
      });
      window.cancelDelegation = function(id){
        if (!confirm('ยืนยันยกเลิกการมอบหมายนี้?')) return;
        fetch('/delegations/' + id + '/cancel', { method: 'POST' })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if(!res.ok) throw new Error(res.d.error); location.reload(); })
          .catch(function(e){ window.toast(e.message, 'danger'); });
      };
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'มอบหมายรักษาการแทน', path: '/delegations', content }));
}));

router.post('/delegations', requireApi(async (ctx) => {
  const { delegateId, startDate, endDate, reason } = ctx.body;
  const id = createDelegation({ delegatorId: ctx.user.id, delegateId, startDate, endDate, reason, createdBy: ctx.user.id });
  json(ctx, 201, { ok: true, id });
}));

router.post('/delegations/:id/cancel', requireApi(async (ctx) => {
  cancelDelegation({ id: ctx.params.id, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));
