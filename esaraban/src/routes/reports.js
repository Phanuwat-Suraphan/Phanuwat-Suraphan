import { router, html, contentDispositionHeader } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateShort, statusBadge, LABELS } from '../render.js';
import { requirePage } from '../middleware.js';
import { db, audit, todayInBangkok } from '../db.js';
import { visibleDocumentsSqlFilter, canUserSeeDocument } from '../services/workflow.js';
import { fiscalYearRange } from '../services/leave.js';

/**
 * ช่วงเวลาที่รายงานครอบคลุม — ตามปีงบประมาณไทย (1 ต.ค. – 30 ก.ย.) ไม่ใช่ปีปฏิทิน
 *
 * เดิมหน้ารายงานเป็นตัวเลขสะสม "ตั้งแต่เปิดใช้ระบบ" อย่างเดียว ไม่มีตัวกรองช่วงเวลาเลย ซึ่งตอบสิ่งที่
 * โรงเรียนต้องใช้จริงไม่ได้ — รายงานที่ต้องส่ง สพฐ. และที่ใช้ในการประเมินตนเอง (SAR) เป็นรายปี
 * งบประมาณเสมอ พอไม่มีตัวกรอง ตัวเลขก็โตขึ้นเรื่อยๆ ทุกปีจนใช้เปรียบเทียบปีต่อปีไม่ได้
 *
 * ยังเลือก "ทั้งหมด" ได้อยู่ เพราะบางครั้งต้องการภาพรวมตั้งแต่เปิดใช้ระบบ
 */
function resolveRange(query) {
  const raw = String(query.fy || '').trim();
  if (raw === 'all') return { key: 'all', label: 'ทั้งหมดตั้งแต่เปิดใช้ระบบ', where: '', params: {} };
  const current = fiscalYearRange(todayInBangkok());
  const yearBe = Number.parseInt(raw, 10);
  const chosen = Number.isFinite(yearBe) && yearBe >= 2500 && yearBe <= current.yearBe + 1
    ? fiscalYearRange(`${yearBe - 543 - 1}-10-01`)
    : current;
  return {
    key: String(chosen.yearBe),
    label: `ปีงบประมาณ ${chosen.yearBe}`,
    // เทียบกับ created_at ซึ่งคือ "วันลงรับ/ลงทะเบียน" — ปีงบประมาณของหนังสือคือปีที่ลงทะเบียน
    // ไม่ใช่ปีที่ปิดเรื่อง (หนังสือที่ลงรับ ก.ย. แล้วปิด ต.ค. ยังนับเป็นปีงบประมาณที่ลงรับ)
    where: " AND date(d.created_at) BETWEEN :fyStart AND :fyEnd",
    params: { fyStart: chosen.start, fyEnd: chosen.end },
  };
}

/** ปีงบประมาณที่มีหนังสืออยู่จริง ใช้สร้างตัวเลือกในหน้าเว็บ — ไม่ต้องเดาว่าโรงเรียนเริ่มใช้ระบบปีไหน */
function availableFiscalYears(visible) {
  const rows = db.prepare(`
    SELECT DISTINCT CAST(strftime('%Y', d.created_at) AS INTEGER) y, CAST(strftime('%m', d.created_at) AS INTEGER) m
    FROM documents d WHERE d.deleted_at IS NULL AND ${visible.sql}`).all(visible.params);
  const years = new Set(rows.map((r) => (r.m >= 10 ? r.y + 1 : r.y) + 543));
  years.add(fiscalYearRange(todayInBangkok()).yearBe);
  return [...years].sort((a, b) => b - a);
}

router.get('/reports', requirePage((ctx) => {
  // ตัวเลขทุกตัวนับเฉพาะเอกสารที่ผู้ใช้คนนี้มีสิทธิ์เห็น — ไม่งั้นครูจะเห็น "เอกสารทั้งหมด 639 ฉบับ"
  // ทั้งที่เปิดดูได้จริงแค่ 180 ฉบับ ซึ่งทั้งชวนสับสนและบอกใบ้ปริมาณงานลับที่ตัวเองไม่เกี่ยวข้อง
  const visible = visibleDocumentsSqlFilter(ctx.user);
  const range = resolveRange(ctx.query);
  const scoped = (sql) => db.prepare(sql.replace('{{visible}}', visible.sql).replace('{{range}}', range.where))
    .all({ ...visible.params, ...range.params });
  const byStatus = scoped(`SELECT d.status, COUNT(*) c FROM documents d
    WHERE d.deleted_at IS NULL AND {{visible}}{{range}} GROUP BY d.status`);
  const byDept = scoped(`
    SELECT dep.name, COUNT(*) c FROM documents d JOIN departments dep ON dep.id = d.department_id
    WHERE d.deleted_at IS NULL AND {{visible}}{{range}} GROUP BY dep.name ORDER BY c DESC`);
  const byDirection = scoped(`SELECT d.direction, COUNT(*) c FROM documents d
    WHERE d.deleted_at IS NULL AND {{visible}}{{range}} GROUP BY d.direction`);
  const totalDocs = scoped(`SELECT COUNT(*) c FROM documents d WHERE d.deleted_at IS NULL AND {{visible}}{{range}}`)[0].c;
  // วัดจาก completed_at (เวลาที่เรื่องปิดจริง) ไม่ใช่ updated_at ซึ่งขยับทุกครั้งที่แตะเอกสารทีหลัง —
  // กดจัดเก็บเข้าแฟ้ม เลื่อนตำแหน่งตราประทับ หรือทำลายเมื่อครบอายุอีกสิบปี ล้วนทำให้ตัวเลขนี้พองทั้งสิ้น
  // (วัดจริง: หนังสือที่เสร็จภายใน 1 วัน พอกดจัดเก็บอีก 90 วันให้หลัง กลายเป็น 2,160 ชั่วโมง)
  const avgCompletionHours = scoped(`
    SELECT AVG((julianday(COALESCE(d.completed_at, d.updated_at)) - julianday(d.created_at)) * 24) h FROM documents d
    WHERE d.status IN ('completed','archived') AND d.deleted_at IS NULL AND {{visible}}{{range}}`)[0].h;

  const content = `
    <div class="card-header">
      <h2 class="mt-0">📊 รายงานสรุป — ${esc(range.label)}</h2>
      <a class="btn btn-outline btn-sm" href="/reports/export.csv?fy=${esc(range.key)}">⬇️ Export CSV</a>
    </div>
    <div class="card" style="padding:.7rem 1rem">
      <form method="get" action="/reports" style="display:flex;gap:.6rem;align-items:flex-end;flex-wrap:wrap">
        <div style="min-width:200px">
          <label for="fy">ช่วงเวลา</label>
          <select id="fy" name="fy" onchange="this.form.submit()">
            ${availableFiscalYears(visible).map((y) => `<option value="${y}"${range.key === String(y) ? ' selected' : ''}>ปีงบประมาณ ${y} (1 ต.ค. ${y - 1} – 30 ก.ย. ${y})</option>`).join('')}
            <option value="all"${range.key === 'all' ? ' selected' : ''}>ทั้งหมดตั้งแต่เปิดใช้ระบบ</option>
          </select>
        </div>
        <noscript><button class="btn btn-sm" type="submit">ดูรายงาน</button></noscript>
      </form>
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
  // ไฟล์ที่ export ต้องครอบคลุมช่วงเวลาเดียวกับที่เห็นบนหน้าจอ ไม่งั้นตัวเลขบนหน้ากับในไฟล์จะไม่ตรงกัน
  const range = resolveRange(ctx.query);
  const rows = db.prepare(`
    SELECT d.*, dep.name as dept_name
    FROM documents d JOIN departments dep ON dep.id = d.department_id
    WHERE d.deleted_at IS NULL AND ${visible.sql}${range.where} ORDER BY d.created_at DESC`)
    .all({ ...visible.params, ...range.params })
    .filter((d) => canUserSeeDocument(ctx.user, d));

  const header = ['เลขที่', 'ประเภทการรับส่ง', 'เรื่อง', 'ฝ่าย', 'ความเร็ว', 'ชั้นความลับ', 'สถานะ', 'หน่วยงาน', 'วันที่บันทึก'];
  const csvEscape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [header.map(csvEscape).join(',')];
  for (const r of rows) {
    lines.push([
      r.doc_number_display, r.direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก', r.title, r.dept_name,
      LABELS.PRIORITY_LABEL[r.priority] || r.priority, LABELS.SECRET_LABEL[r.secret_level] || r.secret_level,
      // ห้ามใส่ created_at ดิบลงไฟล์ — เป็น ISO UTC เต็มรูป ("2026-09-02T01:46:09.983Z") ซึ่งมีปัญหา 3 ชั้น:
      // เป็น ค.ศ. ไม่ใช่ พ.ศ. ที่ทะเบียนราชการต้องใช้, เป็นรูปแบบเครื่องที่ไม่มีใครในโรงเรียนอ่านออก และ
      // ที่ร้ายที่สุดคือเป็นเวลา UTC — หนังสือที่ลงทะเบียนก่อน 07:00 น. ตามเวลาไทยจะแสดง "วันก่อนหน้า"
      // ในรายงาน ซึ่งทำให้ยอดรายวัน/รายปีงบประมาณคลาดเคลื่อนโดยไม่มีอะไรฟ้อง
      // (ไฟล์ทะเบียน .xlsx ใช้ fmtThaiDateShort อยู่แล้ว ตรงนี้จึงหลุดไปคนละมาตรฐานกับที่อื่นทั้งระบบ)
      LABELS.STATUS_LABEL[r.status] || r.status, r.correspondent_name, fmtThaiDateShort(r.created_at),
    ].map(csvEscape).join(','));
  }
  audit({ userId: ctx.user.id, action: 'report_exported', detail: { rows: rows.length, range: range.key }, ip: ctx.ip });
  const csv = '﻿' + lines.join('\r\n'); // BOM for Thai text in Excel
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    // ใช้ตัวช่วยกลางเสมอ — ชื่อไฟล์รายงานเป็น ASCII ก็จริง แต่การประกอบหัวเองคือจุดที่ชื่อไฟล์ภาษาไทย
    // เคยทำหัว HTTP พังมาแล้ว จึงมีเทสต์คุมไว้ว่าห้ามมีเส้นทางไหนประกอบเอง
    'Content-Disposition': contentDispositionHeader(`รายงานหนังสือ-${range.key}.csv`, `documents-report-${range.key}.csv`, 'attachment'),
  });
  ctx.res.end(csv);
}));
