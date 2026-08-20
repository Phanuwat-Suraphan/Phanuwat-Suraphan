// สรุปงานรายวันจากไฟล์ Excel ที่ธุรการอัปโหลด — แยกเก็บทีละวันเพื่อให้ย้อนหาง่าย แก้ไขต่อในระบบได้
// (ไม่ต้องกลับไปแก้ในไฟล์ Excel แล้วอัปโหลดใหม่) และดูรวมข้ามวันได้โดยยังแยกหัวข้อรายวันให้เห็นชัด
import { router, html, json, redirect } from '../router.js';
import { layout, esc, fmtThaiDateLong, illustratedEmptyState } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, uuid, nowIso, audit } from '../db.js';
import { httpError } from '../services/workflow.js';
import { parseUploadedWorkbook, COLUMNS, MAX_ITEM_ROWS } from '../services/dailySummaryParse.js';

const MAX_XLSX_BYTES = 5 * 1024 * 1024;

// วันที่ "วันนี้" ตามเวลาไทย ไม่ใช่ UTC — เซิร์ฟเวอร์รันเป็น UTC ถ้าใช้ new Date().toISOString() ตรงๆ
// ช่วง 00:00-07:00 น. ตามเวลาไทยจะได้วันที่ของเมื่อวาน แล้วสรุปงานจะไปลงผิดวันโดยไม่มีใครทันสังเกต
function todayInBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // en-CA ให้รูปแบบ YYYY-MM-DD
}

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
    ORDER BY s.summary_date DESC, s.created_at DESC
  `).all();

  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">📅 สรุปงานรายวัน (จากไฟล์ Excel)</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          อัปโหลดไฟล์สรุปงานของแต่ละวัน แล้วแก้ไขต่อในระบบได้เลย — เก็บแยกทีละวันเพื่อให้ย้อนหาง่าย
        </p>
      </div>
      ${days.length ? '<div class="chip-row"><a class="btn btn-outline btn-sm" href="/daily-summary/combined">🧾 ดูรวมทุกวัน</a></div>' : ''}
    </div>

    <div class="card">
      <h3 class="mt-0">⬆️ อัปโหลดไฟล์สรุปงานของวัน</h3>
      <form id="uploadForm" class="stack">
        <div class="form-grid cols-2">
          <div class="field">
            <label>วันที่ของสรุปงานนี้ *</label>
            <input type="date" id="summaryDate" required value="${todayInBangkok()}" oninput="echoThaiDate()" />
            <!-- ช่องเลือกวันที่ของเบราว์เซอร์แสดงตามภาษาของเครื่อง ซึ่งอาจเป็น ค.ศ. หรือแบบ ด/ว/ป สลับกัน
                 จึงทวนวันที่ที่เลือกเป็นภาษาไทย พ.ศ. ให้อ่านยืนยันอีกที กันบันทึกผิดวันโดยไม่รู้ตัว -->
            <div class="help-text" id="summaryDateThai"></div>
            <script>
              function echoThaiDate(){
                var v = document.getElementById('summaryDate').value;
                var out = document.getElementById('summaryDateThai');
                if (!v) { out.textContent = ''; return; }
                out.textContent = 'วันที่เลือกไว้: ' + new Date(v + 'T00:00:00')
                  .toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
              }
              echoThaiDate();
            </script>
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
        <tbody>${days.map((d) => `<tr onclick="location.href='/daily-summary/${d.id}'" style="cursor:pointer">
          <td><strong>${esc(fmtThaiDateLong(d.summary_date))}</strong></td>
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
  if (!summaryDate || !/^\d{4}-\d{2}-\d{2}$/.test(summaryDate)) throw httpError(400, 'กรุณาระบุวันที่ให้ถูกต้อง');
  if (!fileDataBase64) throw httpError(400, 'ไม่พบไฟล์');
  const buf = Buffer.from(fileDataBase64, 'base64');
  if (buf.length > MAX_XLSX_BYTES) throw httpError(413, 'ไฟล์ใหญ่เกิน 5MB');
  // .xlsx เป็น ZIP เสมอ — เช็ค magic number กันไฟล์ประเภทอื่นที่เปลี่ยนนามสกุลมา
  if (buf.subarray(0, 2).toString('latin1') !== 'PK') throw httpError(400, 'ไฟล์นี้ไม่ใช่ .xlsx (ถ้าเป็น .xls รุ่นเก่า ให้บันทึกเป็น .xlsx ก่อน)');

  const { items, sources } = parseUploadedWorkbook(buf);
  const id = saveSummary({ summaryDate, filename: fileName, items, sources, userId: ctx.user.id });
  audit({ userId: ctx.user.id, action: 'daily_summary_uploaded', tableName: 'daily_summaries', recordId: id, detail: { summaryDate, items: items.length } });
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

  const content = `
    ${ctx.query.created ? '<div class="alert alert-success">✅ อ่านไฟล์และแตกเป็นรายการเรียบร้อยแล้ว — แก้ไขข้อความในตารางได้เลย แล้วกดบันทึก</div>' : ''}
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
        <a class="btn btn-outline btn-sm" href="/daily-summary/combined">🧾 ดูรวม</a>
        <button class="btn btn-outline btn-sm" onclick="window.print()">🖨️ พิมพ์</button>
        ${canEdit ? `<button class="btn btn-danger btn-sm" onclick="deleteSummary()">🗑️ ลบสรุปวันนี้</button>` : ''}
      </div>
    </div>

    <datalist id="priorityList">
      ${['ด่วนที่สุด', 'ด่วนมาก', 'ด่วน', 'สูง', 'ปานกลาง', 'ปกติ'].map((p) => `<option value="${p}"></option>`).join('')}
    </datalist>

    <div class="card">
      <div class="table-wrap"><table id="itemsTable">
        <thead><tr>${COLUMNS.map((c) => `<th style="min-width:${c.width}">${esc(c.label)}</th>`).join('')}<th>ทำแล้ว</th><th></th></tr></thead>
        <tbody>${items.map(rowHtml).join('')}</tbody>
      </table></div>
      ${canEdit ? `
      <div class="chip-row" style="margin-top:.8rem">
        <button class="btn btn-outline btn-sm" onclick="addRow()">+ เพิ่มแถว</button>
        <button class="btn btn-primary" onclick="saveAll(this)">💾 บันทึกการแก้ไข</button>
      </div>
      <div class="help-text">แก้ไขข้อความในช่องได้โดยตรง · ติ๊ก "ทำแล้ว" เมื่อดำเนินการเสร็จ · กดบันทึกครั้งเดียวเก็บทั้งตาราง</div>
      ` : '<div class="help-text">คุณดูได้อย่างเดียว — แก้ไขได้เฉพาะผู้อัปโหลด ธุรการ หรือผู้ดูแลระบบ</div>'}
    </div>

    ${sources.length ? `<div class="card">
      <h3 class="mt-0">📎 ไฟล์เอกสารอ้างอิงของวันนี้</h3>
      <div class="table-wrap"><table>
        <thead><tr><th style="width:5rem">ดัชนี</th><th>ชื่อไฟล์</th></tr></thead>
        <tbody>${sources.map((r) => `<tr><td>${esc(r.ref_index || '')}</td><td>${esc(r.ref_text || '')}</td></tr>`).join('')}</tbody>
      </table></div>
      <div class="help-text">คอลัมน์ "แหล่งที่มา" ในตารางด้านบนอ้างถึงเลขดัชนีในตารางนี้</div>
    </div>` : ''}

    <script>
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
      window.saveAll = function(btn){
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        fetch('/daily-summary/${s.id}/items', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: collectRows() }),
        }).then(function(r){ return r.json().then(function(d){ return { ok: r.ok, d: d }; }); })
          .then(function(res){
            if (!res.ok) throw new Error(res.d.error || 'บันทึกไม่สำเร็จ');
            window.toast('บันทึกการแก้ไขแล้ว', 'success');
            window.restoreBtn(btn);
          })
          .catch(function(e){ window.toast(e.message, 'danger'); window.restoreBtn(btn); });
      };
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

  const clean = (v) => (typeof v === 'string' ? v.trim().slice(0, 4000) : '');
  db.exec('BEGIN IMMEDIATE');
  try {
    // แทนที่ทั้งชุด — ง่ายและตรงกับ UI ที่ส่งทั้งตารางมาในครั้งเดียว (เพิ่ม/แก้/ลบ จบในคำขอเดียว)
    db.prepare('DELETE FROM daily_summary_items WHERE summary_id = ?').run(s.id);
    const ins = db.prepare(`INSERT INTO daily_summary_items
      (id, summary_id, sort_order, priority, task_name, action_needed, schedule, detail, source_ref, is_done)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    rows.forEach((r, i) => ins.run(uuid(), s.id, i, clean(r.priority), clean(r.task_name), clean(r.action_needed),
      clean(r.schedule), clean(r.detail), clean(r.source_ref), r.is_done ? 1 : 0));
    db.prepare('UPDATE daily_summaries SET updated_at = ? WHERE id = ?').run(nowIso(), s.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit({ userId: ctx.user.id, action: 'daily_summary_edited', tableName: 'daily_summaries', recordId: s.id, detail: { items: rows.length } });
  json(ctx, 200, { ok: true });
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
