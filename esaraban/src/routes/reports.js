import { router, html } from '../router.js';
import { layout, esc, fmtDate, statusBadge, LABELS } from '../render.js';
import { requirePage } from '../middleware.js';
import { db, audit } from '../db.js';
import { visibleDocumentsSqlFilter, canUserSeeDocument } from '../services/workflow.js';

router.get('/reports', requirePage((ctx) => {
  // ตัวเลขทุกตัวนับเฉพาะเอกสารที่ผู้ใช้คนนี้มีสิทธิ์เห็น — ไม่งั้นครูจะเห็น "เอกสารทั้งหมด 639 ฉบับ"
  // ทั้งที่เปิดดูได้จริงแค่ 180 ฉบับ ซึ่งทั้งชวนสับสนและบอกใบ้ปริมาณงานลับที่ตัวเองไม่เกี่ยวข้อง
  const visible = visibleDocumentsSqlFilter(ctx.user);
  const scoped = (sql) => db.prepare(sql.replace('{{visible}}', visible.sql)).all(visible.params);
  const byStatus = scoped(`SELECT d.status, COUNT(*) c FROM documents d
    WHERE d.deleted_at IS NULL AND {{visible}} GROUP BY d.status`);
  const byDept = scoped(`
    SELECT dep.name, COUNT(*) c FROM documents d JOIN departments dep ON dep.id = d.department_id
    WHERE d.deleted_at IS NULL AND {{visible}} GROUP BY dep.name ORDER BY c DESC`);
  const byDirection = scoped(`SELECT d.direction, COUNT(*) c FROM documents d
    WHERE d.deleted_at IS NULL AND {{visible}} GROUP BY d.direction`);
  const totalDocs = scoped(`SELECT COUNT(*) c FROM documents d WHERE d.deleted_at IS NULL AND {{visible}}`)[0].c;
  const avgCompletionHours = scoped(`
    SELECT AVG((julianday(d.updated_at) - julianday(d.created_at)) * 24) h FROM documents d
    WHERE d.status IN ('completed','archived') AND d.deleted_at IS NULL AND {{visible}}`)[0].h;

  const content = `
    <div class="card-header">
      <h2 class="mt-0">📊 รายงานสรุป</h2>
      <a class="btn btn-outline btn-sm" href="/reports/export.csv">⬇️ Export CSV</a>
    </div>
    <div class="kpi-grid">
      <div class="kpi-card"><div class="kpi-value">${totalDocs}</div><div class="kpi-label">เอกสารทั้งหมด</div></div>
      ${byDirection.map((r) => `<div class="kpi-card"><div class="kpi-value">${r.c}</div><div class="kpi-label">${r.direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก'}</div></div>`).join('')}
      <div class="kpi-card"><div class="kpi-value">${avgCompletionHours ? avgCompletionHours.toFixed(1) : '-'}</div><div class="kpi-label">ชม. เฉลี่ยจนเสร็จสิ้น</div></div>
    </div>
    <div class="grid-2">
      <div class="card">
        <h3 class="mt-0">แยกตามสถานะ</h3>
        <div class="table-wrap"><table><thead><tr><th>สถานะ</th><th>จำนวน</th></tr></thead>
        <tbody>${byStatus.map((r) => `<tr><td>${statusBadge(r.status)}</td><td>${r.c}</td></tr>`).join('')}</tbody></table></div>
      </div>
      <div class="card">
        <h3 class="mt-0">แยกตามฝ่าย</h3>
        <div class="table-wrap"><table><thead><tr><th>ฝ่าย</th><th>จำนวน</th></tr></thead>
        <tbody>${byDept.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.c}</td></tr>`).join('')}</tbody></table></div>
      </div>
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'รายงาน', path: '/reports', content }));
}));

// เดิมไฟล์นี้ดัมป์เอกสาร "ทุกฉบับในฐานข้อมูล" ให้ใครก็ตามที่ล็อกอินได้ ทั้งที่หน้าทะเบียนซ่อนหนังสือลับ
// จากคนที่ไม่เกี่ยวข้องอยู่แล้ว — ทดสอบยืนยันแล้วว่าครูที่มองไม่เห็นหนังสือ "ลับมาก" ในหน้าเว็บ กดปุ่มนี้
// แล้วได้ชื่อเรื่อง/หน่วยงาน/สถานะของหนังสือฉบับนั้นมาครบ และไฟล์ที่ดาวน์โหลดไปแล้วเรียกคืนไม่ได้
// จึงต้องใช้เงื่อนไขสิทธิ์ชุดเดียวกับหน้าทะเบียน แล้วกรองซ้ำด้วยตัวตรวจรายฉบับอีกชั้น
router.get('/reports/export.csv', requirePage((ctx) => {
  const visible = visibleDocumentsSqlFilter(ctx.user);
  const rows = db.prepare(`
    SELECT d.*, dep.name as dept_name
    FROM documents d JOIN departments dep ON dep.id = d.department_id
    WHERE d.deleted_at IS NULL AND ${visible.sql} ORDER BY d.created_at DESC`)
    .all(visible.params)
    .filter((d) => canUserSeeDocument(ctx.user, d));

  const header = ['เลขที่', 'ประเภทการรับส่ง', 'เรื่อง', 'ฝ่าย', 'ความเร็ว', 'ชั้นความลับ', 'สถานะ', 'หน่วยงาน', 'วันที่บันทึก'];
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push([
      r.doc_number_display, r.direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก', r.title, r.dept_name,
      LABELS.PRIORITY_LABEL[r.priority] || r.priority, LABELS.SECRET_LABEL[r.secret_level] || r.secret_level,
      LABELS.STATUS_LABEL[r.status] || r.status, r.correspondent_name, r.created_at,
    ].map(csvEscape).join(','));
  }
  audit({ userId: ctx.user.id, action: 'report_exported', detail: { rows: rows.length }, ip: ctx.ip });
  const csv = '﻿' + lines.join('\r\n'); // BOM for Thai text in Excel
  ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="documents-report.csv"' });
  ctx.res.end(csv);
}));
