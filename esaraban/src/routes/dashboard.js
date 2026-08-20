import { router, html } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateLong, statusBadge, priorityBadge, illustratedEmptyState } from '../render.js';
import { requirePage } from '../middleware.js';
import { db } from '../db.js';
import { canUserSeeDocument } from '../services/workflow.js';

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
    <div id="installHint" class="card" hidden style="border-color:var(--primary)">
      <div class="card-header">
        <h3 class="mt-0">📲 ติดตั้งลงมือถือ เพื่อรับไฟล์จาก LINE ได้ในคลิกเดียว</h3>
        <button class="btn btn-outline btn-sm" onclick="dismissInstallHint()">ไม่ต้องแสดงอีก</button>
      </div>
      <p style="margin:.2rem 0 .6rem">
        ปกติถ้าได้หนังสือมาทาง LINE ต้องกดดาวน์โหลดลงเครื่องก่อน แล้วมาไล่หาไฟล์ตอนแนบ ซึ่งหายากมากบนมือถือ
        ถ้าติดตั้งระบบนี้ลงหน้าจอโฮมแล้ว จะ<strong>แชร์ไฟล์จาก LINE เข้าระบบได้ตรงๆ ไม่ต้องดาวน์โหลดเลย</strong>
      </p>
      <div class="help-text">
        <strong>วิธีติดตั้ง (Android):</strong> เปิดเว็บนี้ใน Chrome → กดปุ่ม ⋮ มุมขวาบน → เลือก "ติดตั้งแอป"
        หรือ "เพิ่มลงในหน้าจอหลัก"<br/>
        <strong>วิธีใช้หลังติดตั้ง:</strong> ใน LINE กดที่ไฟล์หนังสือ → กดปุ่มแชร์ → เลือก "สารบรรณ จพ.๑" →
        ระบบจะเปิดฟอร์มรับหนังสือพร้อมไฟล์ให้เลย แค่กรอกชื่อเรื่องแล้วบันทึก<br/>
        <strong>หมายเหตุสำหรับ iPhone/iPad:</strong> ระบบแชร์ไฟล์ตรงแบบนี้ iOS ยังไม่รองรับ (เป็นข้อจำกัดของ
        ตัว iOS เอง ไม่ใช่ของระบบเรา) — บน iPhone ยังต้องกดบันทึกไฟล์จาก LINE ลงแอป "ไฟล์" ก่อน แล้วค่อยแนบ
        ตามปกติ แต่ติดตั้งลงหน้าจอโฮมไว้ก็ยังเปิดใช้งานได้เร็วขึ้นเหมือนกัน
      </div>
    </div>
    <script>
      // โชว์เฉพาะบนมือถือ ที่ยังไม่ได้ติดตั้งเป็นแอป และยังไม่เคยกดปิด — บนเดสก์ท็อป/ในแอปที่ติดตั้งแล้วไม่ต้องกวน
      (function () {
        var installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
        var dismissed = localStorage.getItem('esaraban_install_hint_dismissed') === '1';
        var isMobile = window.matchMedia('(max-width: 900px)').matches;
        if (!installed && !dismissed && isMobile) document.getElementById('installHint').hidden = false;
      })();
      function dismissInstallHint(){
        localStorage.setItem('esaraban_install_hint_dismissed', '1');
        document.getElementById('installHint').hidden = true;
      }
    </script>
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

// ---------------- สรุปงานที่ต้องทำ ----------------
// ตารางรวมเอกสารที่ "มีกำหนดเสร็จและยังไม่ปิดเรื่อง" เรียงตามวันครบกำหนด — รูปแบบคอลัมน์อ้างอิงตาราง
// สรุปงานที่โรงเรียนใช้อยู่จริง (ระดับความสำคัญ / วันที่ต้องดำเนินการ / หัวข้อ / รายละเอียด / วิธีดำเนินการ /
// หมายเหตุ) เพื่อให้ดูแล้วเห็นภาพรวมได้ทันทีว่าค้างอะไรบ้าง ต้องทำอะไรก่อน โดยไม่ต้องเปิดทีละฉบับ
router.get('/summary', requirePage((ctx) => {
  const rows = db.prepare(`
    SELECT d.*, dep.name as dept_name,
      (SELECT ws.instruction FROM workflow_steps ws
        WHERE ws.document_id = d.id AND ws.status = 'waiting'
        ORDER BY ws.step_order DESC LIMIT 1) as pending_instruction,
      (SELECT u.prefix || u.first_name || ' ' || u.last_name FROM workflow_steps ws
        JOIN users u ON u.id = ws.assignee_id
        WHERE ws.document_id = d.id AND ws.status = 'waiting'
        ORDER BY ws.step_order DESC LIMIT 1) as pending_assignee
    FROM documents d JOIN departments dep ON dep.id = d.department_id
    WHERE d.deleted_at IS NULL
      AND d.due_date IS NOT NULL AND d.due_date != ''
      AND d.status NOT IN ('completed', 'archived', 'voided', 'destroyed')
    ORDER BY d.due_date ASC, d.priority DESC
    LIMIT 300
  `).all().filter((d) => canUserSeeDocument(ctx.user, d));

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const daysLeft = (due) => Math.round((new Date(due + 'T00:00:00') - today) / 86400000);
  // ป้ายบอกความเร่งด่วนจากวันครบกำหนดจริง (คนละเรื่องกับ "ความเร็ว" ที่ธุรการกรอกไว้ตอนลงทะเบียน) —
  // ตัวเลขติดลบแปลว่าเลยกำหนดมาแล้วกี่วัน
  const dueChip = (n) => {
    if (n < 0) return `<span class="badge badge-danger">เลยกำหนด ${Math.abs(n)} วัน</span>`;
    if (n === 0) return '<span class="badge badge-danger">ครบกำหนดวันนี้</span>';
    if (n <= 3) return `<span class="badge badge-warning">อีก ${n} วัน</span>`;
    return `<span class="text-muted" style="font-size:.8rem">อีก ${n} วัน</span>`;
  };

  const overdue = rows.filter((d) => daysLeft(d.due_date) < 0).length;
  const soon = rows.filter((d) => { const n = daysLeft(d.due_date); return n >= 0 && n <= 3; }).length;

  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">🗒️ สรุปงานที่ต้องทำ</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          เอกสารที่มีกำหนดเสร็จและยังไม่ปิดเรื่อง เรียงตามวันครบกำหนด — ทั้งหมด ${rows.length} รายการ${overdue ? ` · <strong style="color:var(--danger)">เลยกำหนด ${overdue}</strong>` : ''}${soon ? ` · ใกล้ครบกำหนด ${soon}` : ''}
        </p>
      </div>
      <div class="chip-row">
        <button class="btn btn-outline btn-sm" onclick="window.print()">🖨️ พิมพ์ตาราง</button>
      </div>
    </div>
    <div class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr>
          <th>ระดับความสำคัญ</th><th>วันที่ต้องดำเนินการ</th><th>หัวข้อปฏิบัติ</th>
          <th>รายละเอียดสิ่งที่ต้องทำ</th><th>วิธีการดำเนินการ</th><th>หมายเหตุ/ข้อมูลเพิ่มเติม</th>
        </tr></thead>
        <tbody>${rows.map((d) => {
          const n = daysLeft(d.due_date);
          return `<tr onclick="location.href='/documents/${d.id}'" style="cursor:pointer${n < 0 ? ';background:rgba(220,38,38,.06)' : ''}">
            <td>${priorityBadge(d.priority)}</td>
            <td style="white-space:nowrap">${esc(fmtThaiDateLong(d.due_date))}<div style="margin-top:.2rem">${dueChip(n)}</div></td>
            <td><strong>${esc(d.title)}</strong><div class="text-muted" style="font-size:.78rem">${esc(d.doc_number_display)}${d.secret_level !== 'normal' ? ' 🔒' : ''}</div></td>
            <td>${d.subject ? esc(d.subject).replace(/\n/g, '<br/>') : '<span class="text-muted">—</span>'}</td>
            <td>${d.pending_instruction ? esc(d.pending_instruction).replace(/\n/g, '<br/>') : '<span class="text-muted">—</span>'}
              ${d.pending_assignee ? `<div class="text-muted" style="font-size:.78rem;margin-top:.2rem">ผู้รับผิดชอบ: ${esc(d.pending_assignee)}</div>` : ''}</td>
            <td>${statusBadge(d.status)}<div class="text-muted" style="font-size:.78rem;margin-top:.2rem">${esc(d.correspondent_name || '')}${d.dept_name ? `<br/>ฝ่าย${esc(d.dept_name)}` : ''}</div></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : illustratedEmptyState('allClear', 'ยังไม่มีเอกสารที่ตั้งกำหนดเสร็จไว้ และยังค้างอยู่ครับ')}
    </div>
    <div class="help-text" style="margin-top:.6rem">
      รายการนี้ดึงจากเอกสารที่กรอก "กำหนดเสร็จ" ไว้ตอนลงทะเบียน (อยู่ในหัวข้อ ⚙️ ตัวเลือกเพิ่มเติม) —
      ถ้าเอกสารไหนยังไม่โผล่ในตารางนี้ แปลว่ายังไม่ได้ใส่วันกำหนดเสร็จให้เอกสารฉบับนั้น
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'สรุปงานที่ต้องทำ', path: '/summary', content }));
}));
