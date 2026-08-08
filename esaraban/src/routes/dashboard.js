import { router, html } from '../router.js';
import { layout, esc, fmtDate, statusBadge, priorityBadge, illustratedEmptyState } from '../render.js';
import { requirePage } from '../middleware.js';
import { db } from '../db.js';

// รวมงานที่มอบหมายให้ตรงๆ + งานที่มีคนมอบหมายให้เรารักษาการแทน (ยัง active วันนี้) เข้าเป็นเงื่อนไขเดียว —
// ใช้ซ้ำได้ทั้งตัวนับ KPI, การ์ด "งานของฉัน" ในแดชบอร์ด, และหน้า /tasks
const MY_OR_DELEGATED_STEP_SQL = `(ws.assignee_id = ? OR ws.assignee_id IN (
  SELECT delegator_id FROM user_delegations
  WHERE delegate_id = ? AND cancelled_at IS NULL AND start_date <= date('now') AND end_date >= date('now')
))`;

// สีวงกลมไอคอนแต่ละใบสื่อความหมาย: primary=เข้า, secret=ออก(สีต่างให้แยกจากเข้าง่ายๆ), warning=รอดำเนินการ,
// danger=เกินกำหนด, success=เสร็จสิ้น — ไม่ชนกับสีของ badge สถานะเอกสาร (แยกคนละระบบสีกัน)
function kpi(value, label, emoji, tone) {
  return `<div class="kpi-card">
    <div class="kpi-icon kpi-icon-${tone || 'primary'}">${emoji}</div>
    <div><div class="kpi-value">${value}</div><div class="kpi-label">${esc(label)}</div></div>
  </div>`;
}

// ทักทายตามช่วงเวลา (UX Bible Part 21 §1) — ใช้เวลาของเซิร์ฟเวอร์ตรงๆ ไม่ผูก timezone ผู้ใช้
// เพราะโรงเรียนเดียว ผู้ใช้ทั้งหมดอยู่โซนเวลาเดียวกับเซิร์ฟเวอร์อยู่แล้ว
function timeGreeting() {
  const hour = new Date().getHours();
  if (hour >= 5 && hour < 12) return { text: 'สวัสดีตอนเช้าครับ', emoji: '☀️' };
  if (hour >= 12 && hour < 17) return { text: 'สวัสดีตอนบ่ายครับ', emoji: '🌤️' };
  if (hour >= 17 && hour < 20) return { text: 'สวัสดีตอนเย็นครับ', emoji: '🌇' };
  return { text: 'ทำงานดึกแล้วนะครับ พักผ่อนด้วยนะครับ', emoji: '🌙' };
}

router.get('/', requirePage((ctx) => {
  const user = ctx.user;
  const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
  const todayIso = todayStart.toISOString();

  const inToday = db.prepare(`SELECT COUNT(*) c FROM documents WHERE direction='incoming' AND created_at >= ? AND deleted_at IS NULL`).get(todayIso).c;
  const outToday = db.prepare(`SELECT COUNT(*) c FROM documents WHERE direction='outgoing' AND created_at >= ? AND deleted_at IS NULL`).get(todayIso).c;
  const myTasks = db.prepare(`SELECT COUNT(*) c FROM workflow_steps ws WHERE ${MY_OR_DELEGATED_STEP_SQL} AND status = 'waiting'`).get(user.id, user.id).c;
  const overdue = db.prepare(`SELECT COUNT(*) c FROM documents WHERE due_date IS NOT NULL AND due_date < date('now') AND status NOT IN ('completed','archived','voided','rejected') AND deleted_at IS NULL`).get().c;
  const completedToday = db.prepare(`SELECT COUNT(*) c FROM documents WHERE status='completed' AND updated_at >= ? AND deleted_at IS NULL`).get(todayIso).c;

  const myPending = db.prepare(`
    SELECT d.*, dt.name as type_name, ws.id as step_id, (ws.assignee_id != ?) as is_delegated FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE ${MY_OR_DELEGATED_STEP_SQL} AND ws.status = 'waiting' ORDER BY d.priority DESC, ws.created_at ASC LIMIT 8
  `).all(user.id, user.id, user.id);

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
        ${kpi(avgDays != null ? avgDays.toFixed(1) : '-', 'เวลาเฉลี่ยจนปิดงาน (วัน)', '⏱️', 'primary')}
        ${kpi(byDept.reduce((s, r) => s + r.pending_count, 0), 'งานค้างทั้งหมดทุกฝ่าย', '📋', 'warning')}
      </div>
      ${byDept.length ? byDept.map((r) => `
        <div style="margin-bottom:.5rem">
          <div class="flex" style="justify-content:space-between;font-size:.85rem"><span>${esc(r.dept_name)}</span><span class="text-muted">${r.pending_count} รายการ</span></div>
          <div style="background:var(--border);border-radius:4px;height:8px;overflow:hidden"><div style="background:var(--primary);height:100%;width:${(r.pending_count / maxCount) * 100}%"></div></div>
        </div>`).join('') : '<p class="text-muted">ไม่มีงานค้าง</p>'}
    </div>`;
  }

  const greeting = timeGreeting();
  const content = `
    ${ctx.query.warn ? `<div class="alert alert-warning">⚠️ ${esc(ctx.query.warn)}</div>` : ''}
    <div class="card-header">
      <div>
        <h2 class="mt-0">${greeting.emoji} ${greeting.text} ${esc(user.prefix || '')}${esc(user.first_name)}</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          วันนี้มีหนังสือเข้าใหม่ ${inToday} ฉบับ${myTasks > 0 ? ` · ยังไม่ได้ดำเนินการ ${myTasks} ฉบับ` : ' · งานของคุณครบหมดแล้ว 🎉'}
        </p>
      </div>
      <div class="chip-row">
        <a class="btn btn-primary btn-sm" href="/documents/new?direction=incoming">+ รับหนังสือ</a>
        <a class="btn btn-outline btn-sm" href="/documents/new?direction=outgoing">+ ส่งหนังสือ</a>
      </div>
    </div>

    <div class="kpi-grid">
      ${kpi(inToday, 'หนังสือเข้าวันนี้', '📥', 'primary')}
      ${kpi(outToday, 'หนังสือออกวันนี้', '📤', 'secret')}
      ${kpi(myTasks, 'งานรอฉันดำเนินการ', '📌', 'warning')}
      ${kpi(overdue, 'เกินกำหนด', '⏰', 'danger')}
      ${kpi(completedToday, 'เสร็จสิ้นวันนี้', '✅', 'success')}
    </div>

    ${execKpiHtml}

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><h3 class="mt-0">📌 งานของฉัน — ต้องดำเนินการ</h3><a class="text-muted" href="/tasks" style="font-size:.82rem">ดูทั้งหมด →</a></div>
        ${myPending.length ? `<div class="table-wrap"><table>
          <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ความเร็ว</th><th>สถานะ</th></tr></thead>
          <tbody>${myPending.map((d) => `<tr onclick="location.href='/documents/${d.id}'" style="cursor:pointer">
            <td>${esc(d.doc_number_display)}${d.is_delegated ? ' <span title="รักษาการแทน">🪪</span>' : ''}</td><td>${esc(d.title)}</td>
            <td>${priorityBadge(d.priority)}</td><td>${statusBadge(d.status)}</td></tr>`).join('')}</tbody>
        </table></div>` : illustratedEmptyState('allClear', 'วันนี้ไม่มีงานค้างแล้ว พักผ่อนสบายๆ ได้เลยครับ ☕')}
      </div>
      <div class="card">
        <h3 class="mt-0">🕒 เอกสารล่าสุดในระบบ</h3>
        ${recent.length ? recent.map((d) => `
          <div style="padding:.5rem 0;border-bottom:1px solid var(--border)">
            <a href="/documents/${d.id}" style="font-weight:600">${esc(d.doc_number_display)}</a> ${statusBadge(d.status)}
            <div class="text-muted" style="font-size:.82rem">${esc(d.title)}</div>
          </div>`).join('') : illustratedEmptyState('emptyInbox', 'ยังไม่มีเอกสารในระบบ เริ่มต้นสร้างรายการแรกได้เลยครับ')}
      </div>
    </div>
    ${ctx.query.celebrate === '1' && myTasks === 0 ? '<div id="celebrateTrigger" hidden></div>' : ''}`;

  html(ctx, 200, layout({ user, title: 'แดชบอร์ด', path: '/', content }));
}));

router.get('/tasks', requirePage((ctx) => {
  const rows = db.prepare(`
    SELECT d.*, dt.name as type_name, ws.id as step_id, ws.created_at as assigned_at, (ws.assignee_id != ?) as is_delegated
    FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE ${MY_OR_DELEGATED_STEP_SQL} AND ws.status = 'waiting' ORDER BY d.priority DESC, ws.created_at ASC
  `).all(ctx.user.id, ctx.user.id, ctx.user.id);

  const content = `
    <h2>📌 งานของฉัน</h2>
    <div class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ความเร็ว</th><th>ชั้นความลับ</th><th>มอบหมายเมื่อ</th></tr></thead>
        <tbody>${rows.map((d) => `<tr onclick="location.href='/documents/${d.id}'" style="cursor:pointer">
          <td>${esc(d.doc_number_display)}${d.is_delegated ? ' <span title="รักษาการแทน">🪪</span>' : ''}</td><td>${esc(d.title)}</td>
          <td>${priorityBadge(d.priority)}</td><td>${d.secret_level !== 'normal' ? '🔒 ' + esc(d.secret_level) : '-'}</td>
          <td class="text-muted">${fmtDate(d.assigned_at)}</td></tr>`).join('')}</tbody>
      </table></div>` : illustratedEmptyState('allClear', 'ไม่มีงานค้างสำหรับคุณเลยครับ พักผ่อนสบายๆ ได้เลยครับ ☕')}
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'งานของฉัน', path: '/tasks', content }));
}));
