import { router, html } from '../router.js';
import { layout, esc, fmtDate, statusBadge, priorityBadge, emptyState } from '../render.js';
import { requirePage } from '../middleware.js';
import { db } from '../db.js';

function kpi(value, label, emoji) {
  return `<div class="kpi-card"><div class="kpi-value">${emoji ? emoji + ' ' : ''}${value}</div><div class="kpi-label">${esc(label)}</div></div>`;
}

router.get('/', requirePage((ctx) => {
  const user = ctx.user;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const inToday = db.prepare(`SELECT COUNT(*) c FROM documents WHERE direction='incoming' AND created_at >= ? AND deleted_at IS NULL`).get(todayIso).c;
  const outToday = db.prepare(`SELECT COUNT(*) c FROM documents WHERE direction='outgoing' AND created_at >= ? AND deleted_at IS NULL`).get(todayIso).c;
  const myTasks = db.prepare(`SELECT COUNT(*) c FROM workflow_steps WHERE assignee_id = ? AND status = 'waiting'`).get(user.id).c;
  const overdue = db.prepare(`SELECT COUNT(*) c FROM documents WHERE due_date IS NOT NULL AND due_date < date('now') AND status NOT IN ('completed','archived','voided','rejected') AND deleted_at IS NULL`).get().c;
  const completedToday = db.prepare(`SELECT COUNT(*) c FROM documents WHERE status='completed' AND updated_at >= ? AND deleted_at IS NULL`).get(todayIso).c;

  const myPending = db.prepare(`
    SELECT d.*, dt.name as type_name, ws.id as step_id FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE ws.assignee_id = ? AND ws.status = 'waiting' ORDER BY d.priority DESC, ws.created_at ASC LIMIT 8
  `).all(user.id);

  const recent = db.prepare(`
    SELECT d.*, dt.name as type_name FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE d.deleted_at IS NULL ORDER BY d.created_at DESC LIMIT 8
  `).all();

  // Executive KPI (Master Spec §32) — avg completion time + pending load per department, ผู้บริหาร/แอดมินเท่านั้น
  const isExecutive = user.roleCodes.some((r) => ['admin', 'director', 'vice_director'].includes(r));
  let execKpiHtml = '';
  if (isExecutive) {
    const avgDays = db.prepare(`
      SELECT AVG(julianday(updated_at) - julianday(created_at)) as avg_days FROM documents
      WHERE status = 'completed' AND deleted_at IS NULL
    `).get().avg_days;
    const byDept = db.prepare(`
      SELECT dep.name as dept_name, COUNT(*) as pending_count FROM documents d
      JOIN departments dep ON dep.id = d.department_id
      WHERE d.status IN ('registered', 'in_progress', 'returned') AND d.deleted_at IS NULL
      GROUP BY dep.id ORDER BY pending_count DESC
    `).all();
    const maxCount = Math.max(1, ...byDept.map((r) => r.pending_count));

    execKpiHtml = `
    <div class="card">
      <h3 class="mt-0">📊 ภาพรวมสำหรับผู้บริหาร</h3>
      <div class="kpi-grid" style="margin-bottom:1rem">
        ${kpi(avgDays != null ? avgDays.toFixed(1) : '-', 'เวลาเฉลี่ยจนปิดงาน (วัน)', '⏱️')}
        ${kpi(byDept.reduce((s, r) => s + r.pending_count, 0), 'งานค้างทั้งหมดทุกฝ่าย', '📋')}
      </div>
      ${byDept.length ? byDept.map((r) => `
        <div style="margin-bottom:.5rem">
          <div class="flex" style="justify-content:space-between;font-size:.85rem"><span>${esc(r.dept_name)}</span><span class="text-muted">${r.pending_count} รายการ</span></div>
          <div style="background:var(--border);border-radius:4px;height:8px;overflow:hidden"><div style="background:var(--primary);height:100%;width:${(r.pending_count / maxCount) * 100}%"></div></div>
        </div>`).join('') : '<p class="text-muted">ไม่มีงานค้าง</p>'}
    </div>`;
  }

  const content = `
    <div class="card-header">
      <h2 class="mt-0">สวัสดี, ${esc(user.prefix || '')}${esc(user.first_name)} ${esc(user.last_name)} 👋</h2>
      <div class="chip-row">
        <a class="btn btn-primary btn-sm" href="/documents/new?direction=incoming">+ รับหนังสือ</a>
        <a class="btn btn-outline btn-sm" href="/documents/new?direction=outgoing">+ ส่งหนังสือ</a>
      </div>
    </div>

    <div class="kpi-grid">
      ${kpi(inToday, 'หนังสือเข้าวันนี้', '📥')}
      ${kpi(outToday, 'หนังสือออกวันนี้', '📤')}
      ${kpi(myTasks, 'งานรอฉันดำเนินการ', '📌')}
      ${kpi(overdue, 'เกินกำหนด', '⏰')}
      ${kpi(completedToday, 'เสร็จสิ้นวันนี้', '✅')}
    </div>

    ${execKpiHtml}

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><h3 class="mt-0">📌 งานของฉัน — ต้องดำเนินการ</h3><a class="text-muted" href="/tasks" style="font-size:.82rem">ดูทั้งหมด →</a></div>
        ${myPending.length ? `<div class="table-wrap"><table>
          <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ประเภท</th><th>ความเร็ว</th><th>สถานะ</th></tr></thead>
          <tbody>${myPending.map((d) => `<tr onclick="location.href='/documents/${d.id}'" style="cursor:pointer">
            <td>${esc(d.doc_number_display)}</td><td>${esc(d.title)}</td><td>${esc(d.type_name)}</td>
            <td>${priorityBadge(d.priority)}</td><td>${statusBadge(d.status)}</td></tr>`).join('')}</tbody>
        </table></div>` : emptyState('🎉', 'ไม่มีงานค้าง ทำได้ดีมาก!')}
      </div>
      <div class="card">
        <h3 class="mt-0">🕒 เอกสารล่าสุดในระบบ</h3>
        ${recent.length ? recent.map((d) => `
          <div style="padding:.5rem 0;border-bottom:1px solid var(--border)">
            <a href="/documents/${d.id}" style="font-weight:600">${esc(d.doc_number_display)}</a> ${statusBadge(d.status)}
            <div class="text-muted" style="font-size:.82rem">${esc(d.title)}</div>
          </div>`).join('') : emptyState('📭', 'ยังไม่มีเอกสารในระบบ')}
      </div>
    </div>`;

  html(ctx, 200, layout({ user, title: 'แดชบอร์ด', path: '/', content }));
}));

router.get('/tasks', requirePage((ctx) => {
  const rows = db.prepare(`
    SELECT d.*, dt.name as type_name, ws.id as step_id, ws.created_at as assigned_at FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE ws.assignee_id = ? AND ws.status = 'waiting' ORDER BY d.priority DESC, ws.created_at ASC
  `).all(ctx.user.id);

  const content = `
    <h2>📌 งานของฉัน</h2>
    <div class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ประเภท</th><th>ความเร็ว</th><th>ชั้นความลับ</th><th>มอบหมายเมื่อ</th></tr></thead>
        <tbody>${rows.map((d) => `<tr onclick="location.href='/documents/${d.id}'" style="cursor:pointer">
          <td>${esc(d.doc_number_display)}</td><td>${esc(d.title)}</td><td>${esc(d.type_name)}</td>
          <td>${priorityBadge(d.priority)}</td><td>${d.secret_level !== 'normal' ? '🔒 ' + esc(d.secret_level) : '-'}</td>
          <td class="text-muted">${fmtDate(d.assigned_at)}</td></tr>`).join('')}</tbody>
      </table></div>` : emptyState('🎉', 'ไม่มีงานค้างสำหรับคุณ')}
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'งานของฉัน', path: '/tasks', content }));
}));
