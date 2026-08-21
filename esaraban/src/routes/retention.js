import { router, html, json } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateShort, statusBadge } from '../render.js';
import { requirePage, requireApi, requireRole } from '../middleware.js';
import { RETENTION_LABEL } from '../db.js';
import {
  listEligibleForDestruction, listBatches, getBatch,
  createDestructionBatch, approveDestructionBatch, rejectDestructionBatch,
} from '../services/retention.js';

const CAN_MANAGE = ['admin', 'registrar']; // สร้างบัญชีขอทำลาย
const CAN_APPROVE = ['admin', 'director', 'vice_director']; // อนุมัติ/ไม่อนุมัติการทำลาย

router.get('/retention', requireRole(...CAN_MANAGE, ...CAN_APPROVE)(requirePage((ctx) => {
  const eligible = listEligibleForDestruction();
  const batches = listBatches();
  const canManage = ctx.user.roleCodes.some((r) => CAN_MANAGE.includes(r));
  const canApprove = ctx.user.roleCodes.some((r) => CAN_APPROVE.includes(r));

  const eligibleRows = eligible.map((d) => `
    <tr>
      <td><input type="checkbox" class="destroy-check" value="${d.id}" /></td>
      <td>${esc(d.doc_number_display)}</td>
      <td>${esc(d.title)}</td>
      <td>${esc(d.dept_name)}</td>
      <td class="text-muted">${esc(fmtThaiDateShort(d.retention_until))}</td>
    </tr>`).join('');

  const batchRows = batches.map((b) => {
    const statusLabel = { pending_approval: 'รออนุมัติ', approved: 'อนุมัติแล้ว (ทำลายแล้ว)', rejected: 'ไม่อนุมัติ' }[b.status];
    const statusClass = { pending_approval: 'badge-warning', approved: 'badge-danger', rejected: 'badge-muted' }[b.status];
    return `<tr onclick="location.href='/retention/batches/${b.id}'" style="cursor:pointer">
      <td>${esc(b.id.slice(0, 8))}</td>
      <td>${b.item_count} รายการ</td>
      <td>${esc(b.creator_first)} ${esc(b.creator_last)}</td>
      <td><span class="badge ${statusClass}">${statusLabel}</span></td>
      <td class="text-muted">${fmtDate(b.created_at)}</td>
    </tr>`;
  }).join('');

  const content = `
    <h2>🗄️ อายุการเก็บ / การทำลายหนังสือ</h2>
    <p class="text-muted" style="font-size:.85rem">ตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ หมวด 3 — หนังสือที่ครบกำหนดอายุการเก็บต้องผ่านการพิจารณาของคณะกรรมการทำลายหนังสือก่อนจึงจะทำลายได้ ไม่สามารถลบทิ้งได้โดยตรง</p>

    <div class="card">
      <div class="card-header"><h3 class="mt-0">เอกสารที่ครบกำหนดอายุการเก็บ (${eligible.length})</h3></div>
      ${eligible.length ? `
        <form id="batchForm">
          <div class="table-wrap"><table>
            <thead><tr><th></th><th>เลขที่</th><th>เรื่อง</th><th>ฝ่าย</th><th>ครบกำหนด</th></tr></thead>
            <tbody>${eligibleRows}</tbody>
          </table></div>
          ${canManage ? `
          <div class="field" style="margin-top:1rem">
            <label>รายชื่อคณะกรรมการทำลายหนังสือ * (ตามระเบียบ อย่างน้อย 3 คน)</label>
            <textarea name="committeeNames" required placeholder="เช่น 1. นายกก. ประธาน 2. นางกก. กรรมการ 3. นายกก. กรรมการและเลขานุการ"></textarea>
          </div>
          <div class="field">
            <label>เหตุผล/หมายเหตุ</label>
            <textarea name="reason" placeholder="เช่น เอกสารการเงินประจำปี 2558 ครบกำหนดเก็บ 5 ปีตามระเบียบ"></textarea>
          </div>
          <button class="btn btn-danger" type="submit">เสนอขอทำลาย (รายการที่เลือก)</button>
          ` : '<p class="text-muted">เฉพาะธุรการ/ผู้ดูแลระบบเท่านั้นที่เสนอบัญชีขอทำลายได้</p>'}
        </form>
      ` : '<p class="text-muted">ยังไม่มีเอกสารที่ครบกำหนดอายุการเก็บในขณะนี้</p>'}
    </div>

    <div class="card">
      <div class="card-header"><h3 class="mt-0">ประวัติบัญชีขอทำลายหนังสือ</h3></div>
      ${batches.length ? `<div class="table-wrap"><table>
        <thead><tr><th>รหัสบัญชี</th><th>จำนวน</th><th>ผู้เสนอ</th><th>สถานะ</th><th>วันที่เสนอ</th></tr></thead>
        <tbody>${batchRows}</tbody></table></div>` : '<p class="text-muted">ยังไม่มีบัญชีขอทำลายหนังสือ</p>'}
    </div>

    <script>
      var bf = document.getElementById('batchForm');
      if (bf) bf.addEventListener('submit', function(e){
        e.preventDefault();
        var ids = Array.from(document.querySelectorAll('.destroy-check:checked')).map(function(c){ return c.value; });
        if (!ids.length) { toast('กรุณาเลือกเอกสารอย่างน้อย 1 รายการ', 'warning'); return; }
        var payload = { documentIds: ids, committeeNames: bf.committeeNames.value, reason: bf.reason.value };
        fetch('/retention/batches', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if(!res.ok) throw new Error(res.d.error); location.href = res.d.redirect; })
          .catch(function(e){ toast(e.message, 'danger'); });
      });
    </script>`;

  html(ctx, 200, layout({ user: ctx.user, title: 'อายุการเก็บ/ทำลายหนังสือ', path: '/retention', content }));
})));

router.get('/retention/batches/:id', requireRole(...CAN_MANAGE, ...CAN_APPROVE)(requirePage((ctx) => {
  const batch = getBatch(ctx.params.id);
  if (!batch) return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบข้อมูล', path: '/retention', content: '<p>ไม่พบบัญชีทำลายหนังสือนี้</p>' }));
  // ผู้เสนอบัญชีอนุมัติบัญชีของตัวเองไม่ได้ (บังคับฝั่งเซิร์ฟเวอร์ด้วย ดู approveDestructionBatch) —
  // ซ่อนปุ่มไว้ด้วยเพื่อไม่ให้กดแล้วเจอ error โดยไม่รู้สาเหตุ
  const isProposer = batch.created_by === ctx.user.id;
  const canApprove = ctx.user.roleCodes.some((r) => CAN_APPROVE.includes(r)) && !isProposer;

  const itemRows = batch.items.map((d) => `
    <tr><td>${esc(d.doc_number_display)}</td><td>${esc(d.title)}</td><td>${statusBadge(d.status)}</td></tr>`).join('');

  const statusLabel = { pending_approval: 'รออนุมัติ', approved: 'อนุมัติแล้ว (ทำลายแล้ว)', rejected: 'ไม่อนุมัติ' }[batch.status];

  const content = `
    <h2>บัญชีขอทำลายหนังสือ #${esc(batch.id.slice(0, 8))}</h2>
    <div class="card">
      <table class="table-plain">
        <tbody>
          <tr><td class="text-muted">สถานะ</td><td><strong>${statusLabel}</strong></td></tr>
          <tr><td class="text-muted">ผู้เสนอ</td><td>${esc(batch.creator_first)} ${esc(batch.creator_last)} — ${fmtDate(batch.created_at)}</td></tr>
          <tr><td class="text-muted">คณะกรรมการทำลายหนังสือ</td><td style="white-space:pre-wrap">${esc(batch.committee_names)}</td></tr>
          ${batch.reason ? `<tr><td class="text-muted">เหตุผล</td><td>${esc(batch.reason)}</td></tr>` : ''}
          ${batch.decision_note ? `<tr><td class="text-muted">บันทึกการพิจารณา</td><td>${esc(batch.decision_note)}</td></tr>` : ''}
        </tbody>
      </table>
      ${batch.status === 'pending_approval' && canApprove ? `
        <div class="callout-tip" style="margin-top:1rem">
          ⚠️ การอนุมัติจะเปลี่ยนสถานะเอกสาร ${batch.items.length} ฉบับเป็น "ทำลายแล้ว" และ<strong>ลบไฟล์แนบออกจากระบบถาวร</strong>
          กู้คืนไม่ได้ — รายการทะเบียนและเลขที่จะยังคงอยู่เป็นหลักฐานตามระเบียบ
        </div>
        <div class="chip-row" style="margin-top:.8rem">
          <button class="btn btn-danger btn-sm" onclick="doDecision('approve')">✅ อนุมัติให้ทำลาย</button>
          <button class="btn btn-outline btn-sm" onclick="doDecision('reject')">❌ ไม่อนุมัติ</button>
        </div>` : ''}
      ${batch.status === 'pending_approval' && isProposer ? `
        <div class="help-text" style="margin-top:1rem">
          บัญชีนี้คุณเป็นผู้เสนอเอง จึงต้องให้ผู้บริหารท่านอื่นเป็นผู้พิจารณาอนุมัติ
          (ตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ ผู้เสนอกับผู้อนุมัติต้องเป็นคนละคน)
        </div>` : ''}
    </div>
    <div class="card">
      <h3 class="mt-0">รายการเอกสาร (${batch.items.length})</h3>
      <div class="table-wrap"><table><thead><tr><th>เลขที่</th><th>เรื่อง</th><th>สถานะ</th></tr></thead><tbody>${itemRows}</tbody></table></div>
    </div>
    <script>
      async function doDecision(action){
        var note = action === 'reject' ? prompt('ระบุเหตุผลที่ไม่อนุมัติ') : (prompt('บันทึกเพิ่มเติม (ถ้ามี) — การอนุมัตินี้จะลบไฟล์แนบออกจากระบบถาวร กู้คืนไม่ได้') || '');
        if (note === null) return;
        if (action === 'reject' && !note) return;
        var body = { note: note };
        if (action === 'approve') {
          // ยืนยัน PIN ก่อนทำลายเอกสารถาวร เหมือนการลงนามอื่นๆ ในระบบ
          var pin = await window.askPin('ยืนยัน PIN เพื่ออนุมัติให้ทำลายเอกสาร ${batch.items.length} ฉบับถาวร');
          if (!pin) return;
          body.pin = pin;
        }
        fetch('/retention/batches/${batch.id}/' + action, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if(!res.ok) throw new Error(res.d.error); location.reload(); })
          .catch(function(e){ toast(e.message, 'danger'); });
      }
    </script>`;

  html(ctx, 200, layout({ user: ctx.user, title: 'บัญชีทำลายหนังสือ', path: '/retention', content }));
})));

router.post('/retention/batches', requireApi(async (ctx) => {
  if (!ctx.user.roleCodes.some((r) => CAN_MANAGE.includes(r))) return json(ctx, 403, { error: 'เฉพาะธุรการ/ผู้ดูแลระบบเท่านั้น' });
  const batchId = createDestructionBatch({
    documentIds: ctx.body.documentIds, committeeNames: ctx.body.committeeNames, reason: ctx.body.reason, actorUser: ctx.user,
  });
  json(ctx, 201, { redirect: `/retention/batches/${batchId}` });
}));

router.post('/retention/batches/:id/approve', requireApi(async (ctx) => {
  if (!ctx.user.roleCodes.some((r) => CAN_APPROVE.includes(r))) return json(ctx, 403, { error: 'เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่อนุมัติได้' });
  // ต้องยืนยัน PIN เหมือนการลงนามอื่นๆ — นี่คือการทำลายเอกสารราชการถาวร ลบไฟล์แนบทิ้งจริง กู้คืนไม่ได้
  // ซึ่งมีผลหนักกว่าการกด "รับทราบ" เอกสารฉบับเดียวที่บังคับ PIN อยู่แล้วมาก เดิมกลับไม่ต้องยืนยันอะไรเลย
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, ctx.body.pin)) return json(ctx, 401, { error: 'PIN ไม่ถูกต้อง' });
  await approveDestructionBatch({ batchId: ctx.params.id, actorUser: ctx.user, note: ctx.body.note });
  json(ctx, 200, { ok: true });
}));

router.post('/retention/batches/:id/reject', requireApi(async (ctx) => {
  if (!ctx.user.roleCodes.some((r) => CAN_APPROVE.includes(r))) return json(ctx, 403, { error: 'เฉพาะผู้บริหาร/ผู้ดูแลระบบเท่านั้นที่พิจารณาได้' });
  rejectDestructionBatch({ batchId: ctx.params.id, actorUser: ctx.user, note: ctx.body.note });
  json(ctx, 200, { ok: true });
}));
