import { router, html, json } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateShort, fmtThaiDateLong, statusBadge, rowAttrs, rowLink, schoolName } from '../render.js';
import { requirePage, requireApi, requireRole } from '../middleware.js';
import { RETENTION_LABEL } from '../db.js';
import {
  listEligibleForDestruction, countEligibleForDestruction, listBatches, getBatch,
  createDestructionBatch, approveDestructionBatch, rejectDestructionBatch,
} from '../services/retention.js';

const CAN_MANAGE = ['admin', 'registrar']; // สร้างบัญชีขอทำลาย
const CAN_APPROVE = ['admin', 'director', 'vice_director']; // อนุมัติ/ไม่อนุมัติการทำลาย

router.get('/retention', requireRole(...CAN_MANAGE, ...CAN_APPROVE)(requirePage((ctx) => {
  const eligible = listEligibleForDestruction();
  const eligibleTotal = countEligibleForDestruction();
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
    return `<tr ${rowAttrs(`/retention/batches/${b.id}`)}>
      <td>${rowLink(`/retention/batches/${b.id}`, esc(b.id.slice(0, 8)))}</td>
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
      <div class="card-header"><h3 class="mt-0">เอกสารที่ครบกำหนดอายุการเก็บ (${eligibleTotal})</h3></div>
      ${eligibleTotal > eligible.length ? `<div class="alert alert-info" style="margin-bottom:.8rem">
        แสดง ${eligible.length} ฉบับแรก (เรียงตามวันครบกำหนดเก่าสุดก่อน) จากทั้งหมด ${eligibleTotal} ฉบับ —
        ทำลายได้ครั้งละไม่เกิน 500 ฉบับอยู่แล้ว เมื่อจัดการชุดนี้เสร็จ ฉบับที่เหลือจะขึ้นมาแทน
      </div>` : ''}
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
      <div class="chip-row" style="margin-top:.8rem">
        <a class="btn btn-outline btn-sm" href="/retention/batches/${esc(batch.id)}/print" target="_blank" rel="noopener">🖨️ พิมพ์บัญชีหนังสือขอทำลาย (แบบที่ 25)</a>
      </div>
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

/**
 * หน้าพิมพ์ "บัญชีหนังสือขอทำลาย" ตามแบบที่ 25 ท้ายระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ พ.ศ. 2526
 *
 * ทำไมต้องมี: ระเบียบกำหนดให้คณะกรรมการทำลายหนังสือจัดทำบัญชีหนังสือขอทำลายเสนอหัวหน้าส่วนราชการ
 * พิจารณา แล้วเก็บบัญชีนั้นไว้เป็นหลักฐาน — ตัวระบบบันทึกครบทุกอย่างแล้ว แต่เดิม "พิมพ์ออกมาไม่ได้"
 * ทั้งที่ส่วนอื่นของระบบ (ทะเบียนหนังสือ ใบลา) มีหน้าพิมพ์หมด โรงเรียนจึงต้องพิมพ์หน้าจอหรือพิมพ์
 * บัญชีขึ้นมาใหม่เองด้วยมือ ซึ่งเสี่ยงคลาดเคลื่อนจากของจริงในระบบ
 *
 * ช่อง "การพิจารณา" เว้นว่างไว้ให้เขียนด้วยมือตามแบบราชการ เพราะเป็นความเห็นรายฉบับของคณะกรรมการ
 * ที่เกิดขึ้นตอนประชุมพิจารณา ไม่ใช่ข้อมูลที่ระบบมี
 */
router.get('/retention/batches/:id/print', requireRole(...CAN_MANAGE, ...CAN_APPROVE)(requirePage((ctx) => {
  const batch = getBatch(ctx.params.id);
  if (!batch) return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบข้อมูล', path: '/retention', content: '<p>ไม่พบบัญชีทำลายหนังสือนี้</p>' }));

  // แยกรายชื่อกรรมการทีละบรรทัด — ระเบียบกำหนดอย่างน้อย 3 คน จึงเว้นบล็อกลงนามไว้อย่างน้อย 3 ช่อง
  // ถ้ากรอกมาน้อยกว่านั้นก็ยังเว้นช่องว่างให้เซ็นครบ ไม่ใช่พิมพ์ออกมาแล้วมีที่เซ็นไม่พอ
  const committee = String(batch.committee_names || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  while (committee.length < 3) committee.push('');

  const sigBlock = (name, caption) => `
    <div class="sig">
      <div class="sig-space"></div>
      <div>(ลงชื่อ) ....................................................</div>
      <div>( ${esc(name || '..................................................')} )</div>
      <div class="cap">${esc(caption)}</div>
    </div>`;

  const rows = batch.items.map((d, i) => `
    <tr>
      <td class="c">${i + 1}</td>
      <td class="c">${esc(d.year_be || '')}</td>
      <td>${esc(d.external_doc_number || d.doc_number_display || '')}</td>
      <td class="c">${d.external_doc_date ? esc(fmtThaiDateShort(d.external_doc_date)) : '-'}</td>
      <td class="c">${esc(d.doc_number_display || '')}</td>
      <td>${esc(d.title || '')}</td>
      <td></td>
      <td>${esc(RETENTION_LABEL[d.retention_class] || '')}</td>
    </tr>`).join('');

  const body = `<!doctype html>
<html lang="th"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>บัญชีหนังสือขอทำลาย</title>
<style>
  * { box-sizing: border-box; }
  /* แนวนอน เพราะตารางตามแบบที่ 25 มี 8 คอลัมน์ ใส่ในแนวตั้งแล้วช่อง "เรื่อง" แคบจนอ่านไม่ออก */
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: "Noto Sans Thai", "TH Sarabun New", "Sarabun", sans-serif; font-size: 14pt;
    margin: 0 auto; padding: 10mm; color: #111; }
  .toolbar { display: flex; justify-content: flex-end; gap: .5rem; margin-bottom: 1rem; }
  .toolbar button, .toolbar a { font-family: inherit; font-size: 11pt; padding: .5rem 1rem; border-radius: 8px;
    border: 1px solid #ccc; background: #f4f4f4; cursor: pointer; text-decoration: none; color: #111; }
  h1 { text-align: center; font-size: 18pt; margin: 0 0 .2rem; }
  .sub { text-align: center; font-size: 14pt; margin-bottom: .8rem; }
  table { border-collapse: collapse; width: 100%; font-size: 12pt; }
  th, td { border: 1px solid #111; padding: .2rem .35rem; vertical-align: top; }
  th { background: #f0f0f0; font-weight: 700; text-align: center; }
  td.c { text-align: center; white-space: nowrap; }
  .sigs { display: flex; gap: 1.2rem; justify-content: space-between; margin-top: 2rem; flex-wrap: wrap; }
  .sig { text-align: center; min-width: 210px; flex: 1; }
  .sig .sig-space { height: 46px; }
  .sig .cap { font-size: 11pt; color: #444; margin-top: .2rem; }
  .approve-box { border: 1px solid #111; padding: .6rem .8rem; margin-top: 1.6rem; }
  .note { font-size: 11pt; color: #444; margin-top: .4rem; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style>
</head><body>
  <div class="toolbar">
    <a href="/retention/batches/${esc(batch.id)}">← กลับหน้าบัญชี</a>
    <button onclick="window.print()">🖨️ พิมพ์ / บันทึกเป็น PDF</button>
  </div>

  <h1>บัญชีหนังสือขอทำลาย</h1>
  <div class="sub">
    ${esc(schoolName())} &nbsp;·&nbsp; จำนวน ${batch.items.length} ฉบับ
    &nbsp;·&nbsp; วันที่จัดทำ ${esc(fmtThaiDateLong(batch.created_at))}
  </div>

  <table>
    <thead><tr>
      <th style="width:4%">ลำดับ</th>
      <th style="width:7%">ปี พ.ศ.</th>
      <th style="width:14%">ที่</th>
      <th style="width:10%">ลงวันที่</th>
      <th style="width:11%">เลขทะเบียนรับ</th>
      <th style="width:30%">เรื่อง</th>
      <th style="width:14%">การพิจารณา</th>
      <th style="width:10%">หมายเหตุ</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="note">
    ช่อง "การพิจารณา" เว้นไว้ให้คณะกรรมการบันทึกความเห็นรายฉบับด้วยลายมือตามแบบราชการ
    ${batch.reason ? `<br/>เหตุผลประกอบการขอทำลาย: ${esc(batch.reason)}` : ''}
  </div>

  <div class="sigs">
    ${committee.slice(0, 3).map((n, i) => sigBlock(n, i === 0 ? 'ประธานกรรมการทำลายหนังสือ' : 'กรรมการทำลายหนังสือ')).join('')}
  </div>

  <div class="approve-box">
    <div><strong>คำสั่ง/ความเห็นของหัวหน้าส่วนราชการ</strong></div>
    <div style="min-height:40px"></div>
    ${sigBlock(
      batch.status === 'approved' ? `${batch.decider_prefix || ''}${batch.decider_first || ''} ${batch.decider_last || ''}`.trim() : '',
      `ผู้อำนวยการ${schoolName()}`,
    )}
    ${batch.status === 'approved' ? `<div class="note">อนุมัติให้ทำลายเมื่อ ${esc(fmtThaiDateLong(batch.decided_at))}${batch.decision_note ? ` — ${esc(batch.decision_note)}` : ''}</div>` : ''}
    ${batch.status === 'rejected' ? `<div class="note">ไม่อนุมัติเมื่อ ${esc(fmtThaiDateLong(batch.decided_at))}${batch.decision_note ? ` — ${esc(batch.decision_note)}` : ''}</div>` : ''}
  </div>
</body></html>`;
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(body);
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
