import { router, html } from '../router.js';
import { layout, esc, fmtDate, statusBadge, LABELS } from '../render.js';
import { requirePage } from '../middleware.js';
import { db, audit } from '../db.js';

router.get('/reports', requirePage((ctx) => {
  const byStatus = db.prepare(`SELECT status, COUNT(*) c FROM documents WHERE deleted_at IS NULL GROUP BY status`).all();
  const byDept = db.prepare(`
    SELECT dep.name, COUNT(*) c FROM documents d JOIN departments dep ON dep.id = d.department_id
    WHERE d.deleted_at IS NULL GROUP BY dep.name ORDER BY c DESC`).all();
  const byDirection = db.prepare(`SELECT direction, COUNT(*) c FROM documents WHERE deleted_at IS NULL GROUP BY direction`).all();
  const totalDocs = db.prepare('SELECT COUNT(*) c FROM documents WHERE deleted_at IS NULL').get().c;
  const avgCompletionHours = db.prepare(`
    SELECT AVG((julianday(updated_at) - julianday(created_at)) * 24) h FROM documents
    WHERE status IN ('completed','archived') AND deleted_at IS NULL`).get().h;

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

router.get('/reports/export.csv', requirePage((ctx) => {
  const rows = db.prepare(`
    SELECT d.doc_number_display, d.direction, d.title, dep.name as dept_name, dt.name as type_name,
           d.priority, d.secret_level, d.status, d.correspondent_name, d.created_at
    FROM documents d JOIN departments dep ON dep.id = d.department_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC`).all();

  const header = ['เลขที่', 'ประเภทการรับส่ง', 'เรื่อง', 'ฝ่าย', 'ประเภทเอกสาร', 'ความเร็ว', 'ชั้นความลับ', 'สถานะ', 'หน่วยงาน', 'วันที่บันทึก'];
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push([
      r.doc_number_display, r.direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก', r.title, r.dept_name, r.type_name,
      LABELS.PRIORITY_LABEL[r.priority] || r.priority, LABELS.SECRET_LABEL[r.secret_level] || r.secret_level,
      LABELS.STATUS_LABEL[r.status] || r.status, r.correspondent_name, r.created_at,
    ].map(csvEscape).join(','));
  }
  audit({ userId: ctx.user.id, action: 'report_exported', detail: { rows: rows.length }, ip: ctx.ip });
  const csv = '﻿' + lines.join('\r\n'); // BOM for Thai text in Excel
  ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="documents-report.csv"' });
  ctx.res.end(csv);
}));
