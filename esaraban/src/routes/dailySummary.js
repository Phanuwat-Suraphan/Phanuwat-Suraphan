// สรุปงานรายวันจากไฟล์ Excel ที่ธุรการอัปโหลด — แยกเก็บทีละวันเพื่อให้ย้อนหาง่าย แก้ไขต่อในระบบได้
// (ไม่ต้องกลับไปแก้ในไฟล์ Excel แล้วอัปโหลดใหม่) และดูรวมข้ามวันได้โดยยังแยกหัวข้อรายวันให้เห็นชัด
import { router, html, json, redirect } from '../router.js';
import { layout, esc, fmtThaiDateLong, illustratedEmptyState, rowAttrs, rowLink } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, uuid, nowIso, audit, todayInBangkok } from '../db.js';
import { httpError } from '../services/workflow.js';
import { requireDate } from '../services/validate.js';
import { parseUploadedWorkbook, COLUMNS, MAX_ITEM_ROWS } from '../services/dailySummaryParse.js';

const MAX_XLSX_BYTES = 5 * 1024 * 1024;

// จำนวนวันที่แสดงในหน้ารายการ — หนึ่งภาคเรียนกว่าๆ ซึ่งครอบคลุมสิ่งที่ธุรการต้องย้อนดูจริง
// (วัดจริง: 600 วันทำให้หน้านี้หนัก 313KB ต่อการเปิดหนึ่งครั้ง และโตขึ้นทุกวันไม่มีเพดาน)
// สรุปงานเก่ากว่านี้ยังอยู่ในระบบครบ เปิดได้จากหน้า "ดูรวมทุกวัน"
const DAY_LIST_LIMIT = 120;

function saveSummary({ summaryDate, filename, items, sources, userId }) {
  const id = uuid();
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO daily_summaries (id, summary_date, source_filename, uploaded_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(id, summaryDate, filename || null, userId, now, now);
    const insItem = db.prepare(`INSERT INTO daily_summary_items
      (id, summary_id, sort_order, priority, task_name, action_needed, schedule, detail, source_ref)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    items.forEach((it, i) => insItem.run(uuid(), id, i, it.priority, it.task_name, it.action_needed, it.schedule, it.detail, it.source_ref));
    const insSrc = db.prepare(`INSERT INTO daily_summary_sources (id, summary_id, ref_index, ref_text) VALUES (?, ?, ?, ?)`);
    sources.forEach((s) => insSrc.run(uuid(), id, s.ref_index, s.ref_text));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return id;
}

const PRIORITY_TONE = {
  'ด่วนที่สุด': 'badge-danger', 'ด่วนมาก': 'badge-danger', 'ด่วน': 'badge-warning',
  'สูง': 'badge-warning', 'ปานกลาง': 'badge-info', 'ปกติ': 'badge-muted',
};
function priorityChip(p) {
  if (!p) return '';
  return `<span class="badge ${PRIORITY_TONE[p.trim()] || 'badge-muted'}">${esc(p)}</span>`;
}

function getItems(summaryId) {
  return db.prepare('SELECT * FROM daily_summary_items WHERE summary_id = ? ORDER BY sort_order ASC').all(summaryId);
}

// ---------------- รายการรายวันทั้งหมด ----------------
router.get('/daily-summary', requirePage((ctx) => {
  const days = db.prepare(`
    SELECT s.*, u.prefix, u.first_name, u.last_name,
      (SELECT COUNT(*) FROM daily_summary_items i WHERE i.summary_id = s.id) as item_count,
      (SELECT COUNT(*) FROM daily_summary_items i WHERE i.summary_id = s.id AND i.is_done = 1) as done_count
    FROM daily_summaries s JOIN users u ON u.id = s.uploaded_by
    ORDER BY s.summary_date DESC, s.created_at DESC LIMIT ?
  `).all(DAY_LIST_LIMIT);
  const daysTotal = db.prepare('SELECT COUNT(*) c FROM daily_summaries').get().c;

  // อัปโหลดวันเดียวกันซ้ำได้โดยตั้งใจ (บางโรงเรียนแยกรอบเช้า/บ่าย) แต่ส่วนใหญ่ที่เกิดคือกดอัปโหลดซ้ำ
  // เพราะคิดว่าครั้งแรกไม่ผ่าน แล้วได้สรุปสองชุดของวันเดียวกันโดยไม่มีอะไรบอก — ติดป้ายเตือนไว้ให้เห็น
  const dayCounts = new Map();
  for (const d of days) dayCounts.set(d.summary_date, (dayCounts.get(d.summary_date) || 0) + 1);

  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">📅 สรุปงานรายวัน (จากไฟล์ Excel)</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          อัปโหลดไฟล์สรุปงานของแต่ละวัน แล้วแก้ไขต่อในระบบได้เลย — เก็บแยกทีละวันเพื่อให้ย้อนหาง่าย
        </p>
      </div>
      ${days.length ? '<div class="chip-row"><a class="btn btn-outline btn-sm" href="/daily-summary/combined">🧾 ดูรวมทุกวัน</a></div>' : ''}
      ${daysTotal > days.length ? `<p class="text-muted" style="font-size:.82rem;margin:.4rem 0 0">
        แสดง ${days.length} วันล่าสุด จากทั้งหมด ${daysTotal} วัน — สรุปงานเก่ากว่านี้ยังอยู่ในระบบครบ
      </p>` : ''}
    </div>

    <div class="card">
      <h3 class="mt-0">⬆️ อัปโหลดไฟล์สรุปงานของวัน</h3>
      <form id="uploadForm" class="stack">
        <div class="form-grid cols-2">
          <div class="field">
            <label>วันที่ของสรุปงานนี้ *</label>
            <!-- คำทวนวันที่เป็นภาษาไทย พ.ศ. ใต้ช่องนี้ ถูกเติมให้อัตโนมัติทุกช่องวันที่ในระบบแล้ว
                 (ดู thaiDateEcho ใน public/app.js) เดิมเขียนไว้เฉพาะหน้านี้หน้าเดียว -->
            <input type="date" id="summaryDate" required value="${todayInBangkok()}" />
          </div>
          <div class="field">
            <label>ไฟล์ Excel (.xlsx) *</label>
            <input type="file" id="xlsxFile" accept=".xlsx" required />
          </div>
        </div>
        <div class="help-text">
          ระบบจะอ่านชีตแรกเป็นตารางงาน (ลำดับความสำคัญ / ชื่องาน / สิ่งที่ต้องปฏิบัติ / กำหนดการ /
          รายละเอียด / แหล่งที่มา) และชีตที่สองเป็นรายการไฟล์อ้างอิง — รองรับเฉพาะ .xlsx ขนาดไม่เกิน 5MB
          (ไฟล์ .xls รุ่นเก่าต้อง "บันทึกเป็น" .xlsx ก่อน)
        </div>
        <button class="btn btn-primary" type="submit">อัปโหลดและแตกเป็นรายการ</button>
      </form>
    </div>

    <div class="card">
      ${days.length ? `<div class="table-wrap"><table>
        <thead><tr><th>วันที่</th><th>จำนวนงาน</th><th>ทำแล้ว</th><th>ไฟล์ต้นฉบับ</th><th>ผู้อัปโหลด</th><th></th></tr></thead>
        <tbody>${days.map((d) => `<tr ${rowAttrs(`/daily-summary/${d.id}`)}>
          <td>${rowLink(`/daily-summary/${d.id}`, `<strong>${esc(fmtThaiDateLong(d.summary_date))}</strong>`)}${dayCounts.get(d.summary_date) > 1
            ? ` <span class="badge badge-warning" title="วันนี้มีสรุปงานมากกว่าหนึ่งชุด — ตรวจว่าอัปโหลดซ้ำหรือตั้งใจแยกเป็นรอบเช้า/บ่าย">⚠️ ${dayCounts.get(d.summary_date)} ชุด</span>` : ''}</td>
          <td>${d.item_count} รายการ</td>
          <td>${d.done_count}/${d.item_count}</td>
          <td class="text-muted" style="font-size:.8rem">${esc(d.source_filename || '-')}</td>
          <td class="text-muted" style="font-size:.8rem">${esc(d.prefix || '')}${esc(d.first_name)} ${esc(d.last_name)}</td>
          <td><span class="text-muted">เปิด →</span></td>
        </tr>`).join('')}</tbody>
      </table></div>` : illustratedEmptyState('emptyInbox', 'ยังไม่มีสรุปงานรายวัน — อัปโหลดไฟล์แรกได้เลยครับ')}
    </div>

    <script>
      document.getElementById('uploadForm').addEventListener('submit', async function (e) {
        e.preventDefault();
        var btn = this.querySelector('[type=submit]');
        var file = document.getElementById('xlsxFile').files[0];
        var date = document.getElementById('summaryDate').value;
        if (!file || !date) { window.toast('กรุณาเลือกวันที่และไฟล์', 'warning'); return; }
        if (file.size > ${MAX_XLSX_BYTES}) { window.toast('ไฟล์ใหญ่เกิน 5MB', 'warning'); return; }
        window.setBtnLoading(btn, 'กำลังอ่านไฟล์...');
        try {
          var b64 = await window.fileToBase64(file);
          var res = await fetch('/daily-summary/upload', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ summaryDate: date, fileName: file.name, fileDataBase64: b64 }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'อัปโหลดไม่สำเร็จ');
          window.location.href = data.redirect;
        } catch (err) {
          window.toast(err.message || 'เกิดข้อผิดพลาด', 'danger');
          window.restoreBtn(btn);
        }
      });
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'สรุปงานรายวัน', path: '/daily-summary', content }));
}));

router.post('/daily-summary/upload', requireApi((ctx) => {
  const { summaryDate, fileName, fileDataBase64 } = ctx.body;
  // ใช้ตัวตรวจวันที่ตัวเดียวกับฝั่งหนังสือ/ใบลา — เดิมตรวจแค่ "รูปทรง" ด้วย regex ค่าอย่าง 9999-99-99,
  // 2026-13-45, 2026-02-30 และปี พ.ศ. (2569-10-01) จึงผ่านเข้ามาได้ทั้งหมด และเพราะหน้ารายการเรียงตาม
  // summary_date แบบข้อความ วันที่พังเหล่านั้นจะไปค้างอยู่บนสุดของรายการถาวร บังสรุปงานของวันนี้จริงๆ
  // (ยืนยันแล้วในฐานข้อมูลทดสอบ: 9999-99-99 กับ 2569-10-01 ลอยอยู่เหนือวันนี้)
  const summaryDateOk = requireDate(summaryDate, 'วันที่ของสรุปงาน');
  if (!fileDataBase64) throw httpError(400, 'ไม่พบไฟล์');
  const buf = Buffer.from(fileDataBase64, 'base64');
  if (buf.length > MAX_XLSX_BYTES) throw httpError(413, 'ไฟล์ใหญ่เกิน 5MB');
  // .xlsx เป็น ZIP เสมอ — เช็ค magic number กันไฟล์ประเภทอื่นที่เปลี่ยนนามสกุลมา
  if (buf.subarray(0, 2).toString('latin1') !== 'PK') throw httpError(400, 'ไฟล์นี้ไม่ใช่ .xlsx (ถ้าเป็น .xls รุ่นเก่า ให้บันทึกเป็น .xlsx ก่อน)');

  const { items, sources } = parseUploadedWorkbook(buf);
  const id = saveSummary({ summaryDate: summaryDateOk, filename: fileName, items, sources, userId: ctx.user.id });
  audit({ userId: ctx.user.id, action: 'daily_summary_uploaded', tableName: 'daily_summaries', recordId: id, detail: { summaryDate: summaryDateOk, items: items.length } });
  json(ctx, 201, { redirect: `/daily-summary/${id}?created=1` });
}));

// ---------------- ดู/แก้ไขของวันเดียว ----------------
router.get('/daily-summary/combined', requirePage((ctx) => {
  const days = db.prepare('SELECT * FROM daily_summaries ORDER BY summary_date DESC, created_at DESC LIMIT 120').all();
  // ดึงรายการของทุกวันในคำขอเดียวแล้วค่อยจัดกลุ่ม — เดิมวนเรียกทีละวัน (และเรียกซ้ำอีกรอบแค่เพื่อนับ)
  // ซึ่งกลายเป็นหลายร้อย query เมื่อสะสมไปสักปีหนึ่ง
  const allItems = days.length
    ? db.prepare(`SELECT * FROM daily_summary_items WHERE summary_id IN (${days.map(() => '?').join(',')})
        ORDER BY sort_order ASC`).all(...days.map((d) => d.id))
    : [];
  const itemsByDay = new Map(days.map((d) => [d.id, []]));
  for (const it of allItems) itemsByDay.get(it.summary_id)?.push(it);

  const blocks = days.map((d) => {
    const items = itemsByDay.get(d.id) || [];
    return `
      <div class="card">
        <div class="card-header">
          <h3 class="mt-0">${esc(fmtThaiDateLong(d.summary_date))} <span class="text-muted" style="font-weight:400;font-size:.85rem">— ${items.length} รายการ</span></h3>
          <a class="btn btn-outline btn-sm" href="/daily-summary/${d.id}">แก้ไขวันนี้</a>
        </div>
        <div class="table-wrap"><table>
          <thead><tr>${COLUMNS.map((c) => `<th>${esc(c.label)}</th>`).join('')}<th>สถานะ</th></tr></thead>
          <tbody>${items.map((it) => `<tr${it.is_done ? ' style="opacity:.55"' : ''}>
            <td>${priorityChip(it.priority)}</td>
            <td><strong>${esc(it.task_name || '')}</strong></td>
            <td>${esc(it.action_needed || '')}</td>
            <td>${esc(it.schedule || '')}</td>
            <td style="font-size:.85rem">${esc(it.detail || '')}</td>
            <td class="text-muted" style="font-size:.8rem">${esc(it.source_ref || '')}</td>
            <td>${it.is_done ? '<span class="badge badge-success">ทำแล้ว</span>' : '<span class="badge badge-muted">ค้าง</span>'}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>`;
  }).join('');

  const totalItems = allItems.length;
  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">🧾 สรุปงานรวมทุกวัน</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          รวม ${days.length} วัน · ${totalItems} รายการ — ยังแยกหัวข้อรายวันให้เห็นว่ามาจากวันไหน
        </p>
      </div>
      <div class="chip-row">
        <a class="btn btn-outline btn-sm" href="/daily-summary">← กลับรายวัน</a>
        <button class="btn btn-outline btn-sm" onclick="window.print()">🖨️ พิมพ์</button>
      </div>
    </div>
    ${days.length ? blocks : illustratedEmptyState('emptyInbox', 'ยังไม่มีสรุปงานให้รวมครับ')}`;
  html(ctx, 200, layout({ user: ctx.user, title: 'สรุปงานรวมทุกวัน', path: '/daily-summary', content }));
}));

router.get('/daily-summary/:id', requirePage((ctx) => {
  const s = db.prepare(`SELECT s.*, u.prefix, u.first_name, u.last_name FROM daily_summaries s
    JOIN users u ON u.id = s.uploaded_by WHERE s.id = ?`).get(ctx.params.id);
  if (!s) return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบ', path: '/daily-summary', content: '<h2>ไม่พบสรุปงานนี้</h2>' }));
  const items = getItems(s.id);
  const sources = db.prepare('SELECT * FROM daily_summary_sources WHERE summary_id = ? ORDER BY rowid').all(s.id);
  const canEdit = s.uploaded_by === ctx.user.id || ctx.user.roleCodes.some((r) => ['admin', 'registrar'].includes(r));

  const rowHtml = (it, i) => `
    <tr data-row>
      <td><input name="priority" value="${esc(it.priority || '')}" list="priorityList" style="width:100%" ${canEdit ? '' : 'disabled'} /></td>
      <td><textarea name="task_name" rows="2" style="width:100%" ${canEdit ? '' : 'disabled'}>${esc(it.task_name || '')}</textarea></td>
      <td><textarea name="action_needed" rows="2" style="width:100%" ${canEdit ? '' : 'disabled'}>${esc(it.action_needed || '')}</textarea></td>
      <td><input name="schedule" value="${esc(it.schedule || '')}" style="width:100%" ${canEdit ? '' : 'disabled'} /></td>
      <td><textarea name="detail" rows="2" style="width:100%" ${canEdit ? '' : 'disabled'}>${esc(it.detail || '')}</textarea></td>
      <td><input name="source_ref" value="${esc(it.source_ref || '')}" style="width:100%" ${canEdit ? '' : 'disabled'} /></td>
      <td style="text-align:center"><input type="checkbox" name="is_done" ${it.is_done ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /></td>
      <td>${canEdit ? '<button type="button" class="btn btn-outline btn-sm" onclick="this.closest(\'tr\').remove()">ลบ</button>' : ''}</td>
    </tr>`;

  // ── มุมมองอ่านอย่างเดียว ──
  //
  // เดิมหน้านี้เปิดมาเป็นตารางช่องกรอกทันที ทั้งหน้าเต็มไปด้วยกล่อง input/textarea ซึ่งอ่านยากมาก
  // สำหรับคนที่แค่ "มาดูว่าวันนี้มีงานอะไรบ้าง" ซึ่งเป็นคนส่วนใหญ่ที่เปิดหน้านี้ — คนที่แก้จริงมีไม่กี่คน
  // ตอนนี้จึงเห็นสรุปที่อ่านง่ายก่อน แล้วค่อยกดปุ่มเข้าโหมดแก้ไขเมื่อจะแก้จริง
  const doneCount = items.filter((it) => it.is_done).length;
  const urgentCount = items.filter((it) => /ด่วน/.test(it.priority || '')).length;
  const stat = (label, value, tone = '') =>
    `<div class="sum-stat${tone ? ` ${tone}` : ''}"><div class="sum-stat-n">${value}</div><div class="sum-stat-l">${esc(label)}</div></div>`;

  const viewRow = (it) => `
    <div class="sum-item${it.is_done ? ' done' : ''}">
      <div class="sum-item-head">
        <span class="sum-check">${it.is_done ? '✅' : '⬜'}</span>
        <strong>${esc(it.task_name || '(ไม่มีชื่องาน)')}</strong>
        ${priorityChip(it.priority)}
      </div>
      ${it.action_needed ? `<div class="sum-line"><span class="sum-k">สิ่งที่ต้องปฏิบัติ</span>${esc(it.action_needed)}</div>` : ''}
      ${it.schedule ? `<div class="sum-line"><span class="sum-k">กำหนดการ</span>${esc(it.schedule)}</div>` : ''}
      ${it.detail ? `<div class="sum-line"><span class="sum-k">รายละเอียด</span>${esc(it.detail)}</div>` : ''}
      ${it.source_ref ? `<div class="sum-line"><span class="sum-k">แหล่งที่มา</span>${esc(it.source_ref)}</div>` : ''}
    </div>`;

  const content = `
    ${ctx.query.created ? '<div class="alert alert-success">✅ อ่านไฟล์และแตกเป็นรายการเรียบร้อยแล้ว — กด “แก้ไขรายการ” ถ้าต้องการปรับข้อความ</div>' : ''}
    <div class="card-header">
      <div>
        <h2 class="mt-0">📅 สรุปงานวันที่ ${esc(fmtThaiDateLong(s.summary_date))}</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          ${items.length} รายการ · ไฟล์ต้นฉบับ: ${esc(s.source_filename || '-')} ·
          อัปโหลดโดย ${esc(s.prefix || '')}${esc(s.first_name)} ${esc(s.last_name)}
        </p>
      </div>
      <div class="chip-row">
        <a class="btn btn-outline btn-sm" href="/daily-summary">← ทุกวัน</a>
        <a class="btn btn-outline btn-sm" href="/daily-summary/combined">🧾 ดูรวมทุกวัน</a>
        <button class="btn btn-outline btn-sm" onclick="window.print()">🖨️ พิมพ์</button>
        ${canEdit ? `<button class="btn btn-primary btn-sm" id="editToggle" onclick="toggleEdit(true)">✏️ แก้ไขรายการ</button>
        <button class="btn btn-danger btn-sm" onclick="deleteSummary()">🗑️ ลบสรุปวันนี้</button>` : ''}
      </div>
    </div>

    <div id="viewMode">
      <div class="card">
        <div class="sum-stats">
          ${stat('งานทั้งหมด', items.length)}
          ${stat('ทำแล้ว', doneCount, 'ok')}
          ${stat('ยังเหลือ', items.length - doneCount, items.length - doneCount ? 'warn' : '')}
          ${stat('งานด่วน', urgentCount, urgentCount ? 'danger' : '')}
        </div>
      </div>
      <div class="card">
        ${items.length ? items.map(viewRow).join('') : '<p class="text-muted" style="margin:0">ยังไม่มีรายการในวันนี้</p>'}
      </div>
      ${canEdit ? '' : '<div class="help-text">คุณดูได้อย่างเดียว — แก้ไขได้เฉพาะผู้อัปโหลด ธุรการ หรือผู้ดูแลระบบ</div>'}
    </div>

    <datalist id="priorityList">
      ${['ด่วนที่สุด', 'ด่วนมาก', 'ด่วน', 'สูง', 'ปานกลาง', 'ปกติ'].map((p) => `<option value="${p}"></option>`).join('')}
    </datalist>

    <!-- รุ่นของข้อมูลที่หน้านี้โหลดมา — ส่งกลับไปตอนบันทึกเพื่อให้เซิร์ฟเวอร์รู้ว่ามีคนบันทึกคั่นหรือยัง -->
    <input type="hidden" name="summaryVersion" id="summaryVersion" value="${esc(s.updated_at || '')}" />
    <div id="conflictBox"></div>

    ${canEdit ? `
    <div id="editMode" hidden>
      <div class="card">
        <div class="table-wrap"><table id="itemsTable">
          <thead><tr>${COLUMNS.map((c) => `<th style="min-width:${c.width}">${esc(c.label)}</th>`).join('')}<th>ทำแล้ว</th><th></th></tr></thead>
          <tbody>${items.map(rowHtml).join('')}</tbody>
        </table></div>
        <div class="chip-row" style="margin-top:.8rem">
          <button class="btn btn-outline btn-sm" onclick="addRow()">+ เพิ่มแถว</button>
          <button class="btn btn-primary" onclick="saveAll(this)">💾 บันทึกการแก้ไข</button>
          <button class="btn btn-outline btn-sm" onclick="toggleEdit(false)">ปิดโหมดแก้ไข</button>
        </div>
        <div class="help-text">แก้ไขข้อความในช่องได้โดยตรง · ติ๊ก "ทำแล้ว" เมื่อดำเนินการเสร็จ · กดบันทึกครั้งเดียวเก็บทั้งตาราง</div>
      </div>
    </div>` : ''}

    ${sources.length ? `<div class="card">
      <h3 class="mt-0">📎 ไฟล์เอกสารอ้างอิงของวันนี้</h3>
      <div class="table-wrap"><table>
        <thead><tr><th style="width:5rem">ดัชนี</th><th>ชื่อไฟล์</th></tr></thead>
        <tbody>${sources.map((r) => `<tr><td>${esc(r.ref_index || '')}</td><td>${esc(r.ref_text || '')}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="help-text">คอลัมน์ "แหล่งที่มา" ในตารางด้านบนอ้างถึงเลขดัชนีในตารางนี้</div>
    </div>` : ''}

    <script>
      // สลับระหว่าง "ดู" กับ "แก้ไข" ในหน้าเดียว ไม่ต้องโหลดหน้าใหม่ — คนที่แก้จริงมักแก้หลายรอบติดกัน
      // และการโหลดหน้าใหม่ทุกครั้งที่กดแก้ จะทำให้ตำแหน่งที่เลื่อนหน้าไว้หายทุกที
      window.toggleEdit = function(on){
        var view = document.getElementById('viewMode');
        var edit = document.getElementById('editMode');
        var btn = document.getElementById('editToggle');
        if (!edit) return;
        view.hidden = on;
        edit.hidden = !on;
        if (btn) btn.textContent = on ? '👁️ ดูแบบอ่านอย่างเดียว' : '✏️ แก้ไขรายการ';
        if (btn) btn.onclick = function(){ window.toggleEdit(!on); };
        (on ? edit : view).scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      };

      function collectRows(){
        return Array.prototype.map.call(document.querySelectorAll('#itemsTable tbody tr[data-row]'), function (tr) {
          function v(n){ var el = tr.querySelector('[name="' + n + '"]'); return el ? el.value : ''; }
          var done = tr.querySelector('[name="is_done"]');
          return {
            priority: v('priority'), task_name: v('task_name'), action_needed: v('action_needed'),
            schedule: v('schedule'), detail: v('detail'), source_ref: v('source_ref'),
            is_done: done && done.checked ? 1 : 0,
          };
        });
      }
      window.addRow = function(){
        var tb = document.querySelector('#itemsTable tbody');
        var tr = document.createElement('tr');
        tr.setAttribute('data-row', '');
        tr.innerHTML = '<td><input name="priority" list="priorityList" style="width:100%" /></td>' +
          '<td><textarea name="task_name" rows="2" style="width:100%"></textarea></td>' +
          '<td><textarea name="action_needed" rows="2" style="width:100%"></textarea></td>' +
          '<td><input name="schedule" style="width:100%" /></td>' +
          '<td><textarea name="detail" rows="2" style="width:100%"></textarea></td>' +
          '<td><input name="source_ref" style="width:100%" /></td>' +
          '<td style="text-align:center"><input type="checkbox" name="is_done" /></td>' +
          '<td><button type="button" class="btn btn-outline btn-sm" onclick="this.closest(\\'tr\\').remove()">ลบ</button></td>';
        tb.appendChild(tr);
      };
      window.saveAll = function(btn, force){
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        fetch('/daily-summary/${s.id}/items', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            items: collectRows(),
            summaryVersion: document.getElementById('summaryVersion').value,
            force: force ? 1 : 0,
          }),
        }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok, status: r.status, d: d }; }); })
          .then(function(res){
            // มีคนบันทึกคั่นไปแล้ว — ห้ามรีโหลดหน้าทิ้ง เพราะสิ่งที่ผู้ใช้เพิ่งพิมพ์ยังอยู่แค่ในช่องกรอก
            // ถ้ารีโหลดคือทำข้อมูลหายด้วยตัวเอง ทั้งที่กำลังเตือนเรื่องข้อมูลหายอยู่พอดี
            if (res.status === 409) { showConflict(res.d.error); window.restoreBtn(btn); return; }
            if (!res.ok) throw new Error(res.d.error || 'บันทึกไม่สำเร็จ');
            document.getElementById('summaryVersion').value = res.d.summaryVersion || '';
            document.getElementById('conflictBox').innerHTML = '';
            window.toast('บันทึกการแก้ไขแล้ว', 'success');
            window.restoreBtn(btn);
            // มุมมองอ่านถูกสร้างจากฝั่งเซิร์ฟเวอร์ตอนเปิดหน้า ถ้าไม่โหลดใหม่ พอกดกลับไปดูจะเห็นของเก่า
            // ทั้งที่เพิ่งบันทึกไป — โหลดใหม่หลังบันทึกสำเร็จเท่านั้น (ตอนล้มเหลวห้ามโหลด ข้อมูลจะหาย)
            setTimeout(function(){ location.reload(); }, 600);
          })
          .catch(function(e){ window.toast(e.message, 'danger'); window.restoreBtn(btn); });
      };

      function showConflict(msg){
        var box = document.getElementById('conflictBox');
        box.innerHTML = '';
        var div = document.createElement('div');
        div.className = 'alert alert-warning';
        var p = document.createElement('p');
        p.style.margin = '0 0 .6rem';
        p.textContent = msg || 'มีคนอื่นบันทึกไปก่อนแล้ว';
        div.appendChild(p);

        var note = document.createElement('p');
        note.className = 'help-text';
        note.style.margin = '0 0 .6rem';
        note.textContent = 'สิ่งที่คุณพิมพ์ไว้ยังอยู่ครบในตารางด้านล่าง ยังไม่ได้ถูกบันทึกและยังไม่หายไปไหน';
        div.appendChild(note);

        var row = document.createElement('div');
        row.className = 'chip-row';

        var open = document.createElement('a');
        open.className = 'btn btn-outline btn-sm';
        open.href = location.pathname;
        open.target = '_blank';
        open.rel = 'noopener';
        open.textContent = '🔍 เปิดของล่าสุดในแท็บใหม่ (ไม่กระทบสิ่งที่พิมพ์ไว้)';
        row.appendChild(open);

        var over = document.createElement('button');
        over.type = 'button';
        over.className = 'btn btn-danger btn-sm';
        over.textContent = '⚠️ ยืนยันบันทึกทับ';
        over.onclick = function(){
          if (!confirm('ยืนยันบันทึกทับ? งานที่คนอื่นเพิ่งแก้ไว้จะหายทั้งหมด')) return;
          window.saveAll(over, true);
        };
        row.appendChild(over);

        div.appendChild(row);
        box.appendChild(div);
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      window.deleteSummary = function(){
        if (!confirm('ยืนยันลบสรุปงานของวันนี้ทั้งหมด? การกระทำนี้ย้อนกลับไม่ได้')) return;
        fetch('/daily-summary/${s.id}/delete', { method: 'POST' })
          .then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
          .then(function(res){
            if (!res.ok) throw new Error(res.d.error || 'ลบไม่สำเร็จ');
            window.location.href = '/daily-summary';
          })
          .catch(function(e){ window.toast(e.message, 'danger'); });
      };
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'สรุปงานรายวัน', path: '/daily-summary', content }));
}));

// แก้ไขได้เฉพาะผู้อัปโหลดเอง ธุรการ หรือแอดมิน — บังคับฝั่งเซิร์ฟเวอร์ ไม่พึ่งการ disable ช่องกรอกใน UI
function assertCanEdit(summary, user) {
  if (!summary) throw httpError(404, 'ไม่พบสรุปงานนี้');
  if (summary.uploaded_by === user.id) return;
  if (user.roleCodes.some((r) => ['admin', 'registrar'].includes(r))) return;
  throw httpError(403, 'แก้ไขได้เฉพาะผู้อัปโหลด ธุรการ หรือผู้ดูแลระบบเท่านั้น');
}

router.post('/daily-summary/:id/items', requireApi((ctx) => {
  const s = db.prepare('SELECT * FROM daily_summaries WHERE id = ?').get(ctx.params.id);
  assertCanEdit(s, ctx.user);
  // ต้องเป็น array เสมอ — ถ้าปล่อยให้ค่าที่ขาดหายกลายเป็น [] คำขอที่ผิดพลาด/ส่งไม่ครบจะลบรายการของวันนั้น
  // ทิ้งทั้งหมดแล้วตอบ 200 เหมือนสำเร็จ (ล้างข้อมูลโดยไม่ตั้งใจ)
  if (!Array.isArray(ctx.body.items)) throw httpError(400, 'ข้อมูลรายการไม่ถูกต้อง');
  const rows = ctx.body.items;
  if (rows.length > MAX_ITEM_ROWS) throw httpError(400, `จำนวนรายการมากเกินไป (สูงสุด ${MAX_ITEM_ROWS} แถว)`);

  // กันการบันทึกทับกันเงียบๆ — คำขอนี้ "แทนที่ทั้งตาราง" ด้วยสิ่งที่เบราว์เซอร์ส่งมา ถ้าธุรการกับ ผอ.
  // เปิดสรุปงานวันเดียวกันค้างไว้พร้อมกัน (ซึ่งเป็นเรื่องปกติมาก เพราะช่อง "ทำแล้ว" คือสิ่งที่ทุกคน
  // เข้ามาติ๊ก) คนที่กดบันทึกทีหลังจะล้างงานของคนแรกทิ้งทั้งหมด แล้วทั้งคู่ได้ข้อความเขียวว่าสำเร็จ
  // เหมือนกัน — ไม่มีใครรู้เลยว่าข้อมูลหาย (ทดสอบยืนยันแล้วว่าเกิดขึ้นจริง: ติ๊กงานที่หนึ่งไว้ แล้ว
  // กลายเป็นงานที่สามแทน โดยได้ HTTP 200 ทั้งสองครั้ง)
  //
  // หน้าแก้ไขจึงพก updated_at ของตอนที่โหลดหน้ามาด้วย ถ้าไม่ตรงกับของจริงแปลว่ามีคนบันทึกคั่นไปแล้ว
  // — ตอบ 409 ให้หน้าเว็บถามผู้ใช้ก่อน แทนที่จะทับให้เงียบๆ (หน้าเว็บเก็บสิ่งที่พิมพ์ไว้ให้ครบ
  // ไม่รีโหลดทิ้ง และมีปุ่มยืนยันทับให้ถ้าตั้งใจจริง ซึ่งจะส่ง force มา)
  //
  // ไม่ส่ง summaryVersion มาเลยถือว่าผ่าน (ไม่ตอบ 400) — หน้าที่ถูก service worker แคชไว้ตั้งแต่ก่อน
  // อัปเดตจะยังไม่รู้จักฟิลด์นี้ ถ้าปฏิเสธไปเลยครูจะกดบันทึกไม่ได้เลยจนกว่าจะล้างแคช ซึ่งแย่กว่า
  const clientVersion = ctx.body.summaryVersion;
  if (!ctx.body.force && clientVersion && clientVersion !== s.updated_at) {
    throw httpError(409, 'มีคนอื่นบันทึกสรุปงานของวันนี้ไปแล้วหลังจากที่คุณเปิดหน้านี้ — ถ้าบันทึกทับตอนนี้ งานที่เขาเพิ่งแก้จะหายทั้งหมด');
  }

  const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 4000) : '');
  const newVersion = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    // แทนที่ทั้งชุด — ง่ายและตรงกับ UI ที่ส่งทั้งตารางมาในครั้งเดียว (เพิ่ม/แก้/ลบ จบในคำขอเดียว)
    db.prepare('DELETE FROM daily_summary_items WHERE summary_id = ?').run(s.id);
    const ins = db.prepare(`INSERT INTO daily_summary_items
      (id, summary_id, sort_order, priority, task_name, action_needed, schedule, detail, source_ref, is_done)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((r, i) => ins.run(uuid(), s.id, i, clean(r.priority), clean(r.task_name), clean(r.action_needed),
      clean(r.schedule), clean(r.detail), clean(r.source_ref), r.is_done ? 1 : 0));
    db.prepare('UPDATE daily_summaries SET updated_at = ? WHERE id = ?').run(newVersion, s.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit({ userId: ctx.user.id, action: 'daily_summary_edited', tableName: 'daily_summaries', recordId: s.id, detail: { items: rows.length, forced: Boolean(ctx.body.force) } });
  // ส่ง version ใหม่กลับไปให้หน้าเดิมใช้บันทึกครั้งถัดไป — ไม่งั้นการ "แก้ไปบันทึกไป" หลายรอบจาก
  // หน้าเดิมโดยไม่รีโหลด (ซึ่งเป็นการใช้งานปกติ) จะถูกมองว่าชนกันเองตั้งแต่ครั้งที่สอง
  json(ctx, 200, { ok: true, summaryVersion: newVersion });
}));

router.post('/daily-summary/:id/delete', requireApi((ctx) => {
  const s = db.prepare('SELECT * FROM daily_summaries WHERE id = ?').get(ctx.params.id);
  assertCanEdit(s, ctx.user);
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM daily_summary_items WHERE summary_id = ?').run(s.id);
    db.prepare('DELETE FROM daily_summary_sources WHERE summary_id = ?').run(s.id);
    db.prepare('DELETE FROM daily_summaries WHERE id = ?').run(s.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit({ userId: ctx.user.id, action: 'daily_summary_deleted', tableName: 'daily_summaries', recordId: s.id, detail: { summaryDate: s.summary_date } });
  json(ctx, 200, { ok: true });
}));
