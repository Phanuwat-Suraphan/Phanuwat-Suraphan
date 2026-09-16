import { router, html } from '../router.js';
import { layout, esc, fmtDate, statusBadge, priorityBadge, illustratedEmptyState, daysUntil, dueCell, bangkokHour, rowAttrs, rowLink } from '../render.js';
import { requirePage } from '../middleware.js';
import { db, todayInBangkok } from '../db.js';
import { canUserSeeDocument, visibleDocumentsSqlFilter } from '../services/workflow.js';
import { getBackupStatus } from '../services/dbBackup.js';
import { appShortName } from '../services/settings.js';

// รวมงานที่มอบหมายให้ตรงๆ + งานที่มีคนมอบหมายให้เรารักษาการแทน (ยัง active วันนี้) เข้าเป็นเงื่อนไขเดียว —
// ใช้ซ้ำได้ทั้งตัวนับ KPI, การ์ด "งานของฉัน" ในแดชบอร์ด, และหน้า /tasks
const MY_OR_DELEGATED_STEP_SQL = `(ws.assignee_id = :me OR ws.assignee_id IN (
  SELECT delegator_id FROM user_delegations
  WHERE delegate_id = :me AND cancelled_at IS NULL AND start_date <= :today AND end_date >= :today
))`;

// สีวงกลมไอคอนแต่ละใบสื่อความหมาย: primary=เข้า, secret=ออก(สีต่างให้แยกจากเข้าง่ายๆ), warning=รอดำเนินการ,
// danger=เกินกำหนด, success=เสร็จสิ้น — ไม่ชนกับสีของ badge สถานะเอกสาร (แยกคนละระบบสีกัน)
//
// การ์ดที่มี href กดได้ — เห็น "เกินกำหนด 1" แล้วต้องกดไปดูได้ทันทีว่าฉบับไหน ไม่ใช่เห็นตัวเลขบอกว่ามีปัญหา
// แล้วต้องไปไล่หาเองในเมนูอื่น (เป็นปัญหาที่เจอตอนไล่ดูหน้าจอจริง)
function kpi(value, label, emoji, tone, href) {
  const inner = `<div class="kpi-icon kpi-icon-${tone || 'primary'}">${emoji}</div>
    <div><div class="kpi-value">${value}</div><div class="kpi-label">${esc(label)}</div></div>`;
  return href
    ? `<a class="kpi-card kpi-card-link" href="${href}">${inner}</a>`
    : `<div class="kpi-card">${inner}</div>`;
}

// ทักทายตามช่วงเวลา — ต้องใช้เวลาไทย ไม่ใช่เวลาเครื่องเซิร์ฟเวอร์ (ซึ่งเป็น UTC บนคลาวด์)
// ไม่งั้นตอน 8 โมงเช้าที่โรงเรียนจะขึ้นว่า 'ทำงานดึกแล้วนะครับ'
function timeGreeting() {
  const hour = bangkokHour();
  if (hour >= 5 && hour < 12) return { text: 'สวัสดีตอนเช้าครับ', emoji: '☀️' };
  if (hour >= 12 && hour < 17) return { text: 'สวัสดีตอนบ่ายครับ', emoji: '🌤️' };
  if (hour >= 17 && hour < 20) return { text: 'สวัสดีตอนเย็นครับ', emoji: '🌇' };
  return { text: 'ทำงานดึกแล้วนะครับ พักผ่อนด้วยนะครับ', emoji: '🌙' };
}

/**
 * แถบเตือนเรื่องการสำรองข้อมูลขึ้น Google Drive
 *
 * บนโฮสต์ที่ดิสก์ถูกล้างทุกครั้งที่ deploy การสำรองคือสิ่งเดียวที่กันทะเบียนหนังสือทั้งเล่มหาย
 * เดิมเตือนเฉพาะตอน "เคยต่อไว้แล้วแต่พัง" (state = warn) ส่วนกรณี **ยังไม่เคยต่อเลย** (state = off)
 * กลับเงียบสนิททั้งระบบ มีแค่บรรทัดเดียวใน log ตอนเปิดเซิร์ฟเวอร์ที่ไม่มีใครเปิดดู — ซึ่งเป็นสภาพ
 * ที่ทำให้ข้อมูลหายจริงมาแล้ว เพราะไม่มีอะไรบอกเลยว่ากำลังใช้ระบบอยู่บนทรายและกำลังจะเสียของ
 *
 * แยกความแรงของคำเตือนตามชนิดของดิสก์: บนโฮสต์ที่ล้างดิสก์ ข้อมูลจะหาย "แน่นอน" จึงเป็นแถบแดง
 * ปิดไม่ได้ ส่วนบนเครื่องที่มีดิสก์จริงเป็นแค่ความเสี่ยง จึงเป็นแถบเหลืองที่ปิดเก็บไว้ได้ เพื่อไม่ให้
 * กลายเป็นเสียงรบกวนที่ทุกคนเรียนรู้ที่จะมองข้าม (แล้วพลอยมองข้ามตอนที่มันสำคัญจริงๆ ด้วย)
 */
function backupWarningHtml(backup) {
  if (backup.state === 'ok' || backup.state === 'pending') return '';

  if (backup.state === 'off') {
    if (!backup.ephemeral) {
      return `<div class="alert alert-warning" id="backupOffNote" hidden>
        <strong>💾 ยังไม่ได้ตั้งค่าสำรองข้อมูลขึ้น Google Drive</strong>
        — ถ้าดิสก์ของเครื่องนี้เสียหาย ทะเบียนหนังสือทั้งเล่มจะไม่มีสำเนาให้กู้คืน
        <div style="margin-top:.5rem">
          <a class="btn btn-outline btn-sm" href="/admin/google-drive">ตั้งค่าการสำรองข้อมูล</a>
          <button class="btn btn-outline btn-sm" onclick="dismissBackupNote()">รับทราบแล้ว ไม่ต้องเตือนอีก</button>
        </div>
      </div>
      <script>
        // เครื่องที่มีดิสก์จริงและโรงเรียนรับความเสี่ยงนี้แล้ว ไม่ควรโดนเตือนซ้ำทุกวันจนชิน
        (function () {
          var el = document.getElementById('backupOffNote');
          if (el && localStorage.getItem('esaraban_backup_note_dismissed') !== '1') el.hidden = false;
        })();
        function dismissBackupNote() {
          try { localStorage.setItem('esaraban_backup_note_dismissed', '1'); } catch (e) { /* โหมดส่วนตัว */ }
          var el = document.getElementById('backupOffNote');
          if (el) el.hidden = true;
        }
      </script>`;
    }
    return `<div class="alert alert-danger">
      <strong>🚨 ยังไม่ได้เชื่อมต่อ Google Drive — ข้อมูลทั้งหมดจะหายในการ deploy ครั้งถัดไป</strong>
      <div style="margin-top:.35rem">
        เซิร์ฟเวอร์นี้ใช้ดิสก์แบบชั่วคราว ทุกครั้งที่มีการ deploy ใหม่หรือเซิร์ฟเวอร์ถูกรีสตาร์ท
        ทะเบียนหนังสือ ไฟล์แนบ ใบลา และรหัสผ่านที่ทุกคนตั้งไว้ <strong>จะถูกล้างทิ้งทั้งหมด</strong>
        การเชื่อม Google Drive เป็นวิธีเดียวที่ทำให้ข้อมูลอยู่รอด
      </div>
      <div style="margin-top:.5rem">
        <a class="btn btn-primary btn-sm" href="/admin/google-drive">เชื่อมต่อ Google Drive เดี๋ยวนี้</a>
      </div>
    </div>`;
  }

  // state = warn: เคยเชื่อมต่อไว้แล้ว แต่การสำรองล่าสุดล้มเหลวหรือเงียบไปนานผิดปกติ
  return `<div class="alert alert-danger">
    <strong>⚠️ ข้อมูลกำลังไม่ถูกสำรองขึ้น Google Drive</strong><br/>
    ${backup.lastOkAt
      ? `สำรองสำเร็จครั้งล่าสุดเมื่อ ${esc(fmtDate(new Date(backup.lastOkAt).toISOString()))}`
      : 'ยังสำรองไม่สำเร็จเลยสักครั้งตั้งแต่เปิดระบบ'}
    ${backup.lastError ? `<br/><span class="text-muted">สาเหตุ: ${esc(backup.lastError.message)}</span>` : ''}
    <div style="margin-top:.5rem">
      ${backup.ephemeral ? 'ถ้าเซิร์ฟเวอร์ถูก deploy ใหม่ตอนนี้ <strong>ข้อมูลที่บันทึกไว้จะหายทั้งหมด</strong> — ' : ''}
      กรุณาไปที่ <a href="/admin/google-drive">เชื่อมต่อ Google Drive</a> เพื่อเชื่อมต่อบัญชีใหม่
    </div>
  </div>`;
}

router.get('/', requirePage((ctx) => {
  const user = ctx.user;
  const scope = { me: user.id, today: todayInBangkok() };
  // เที่ยงคืนของ "วันนี้" ตามเวลาไทย แปลงเป็นจุดเวลา UTC เพื่อเทียบกับ created_at ที่เก็บเป็น ISO —
  // ถ้าใช้เที่ยงคืนของเครื่องเซิร์ฟเวอร์ (UTC) ตัวเลข "วันนี้" จะเริ่มนับตอน 7 โมงเช้าเวลาไทย
  // หนังสือที่ลงทะเบียนก่อน 7 โมงจะไม่ถูกนับ ส่วนของเมื่อวานตอนเย็นกลับถูกนับรวมเข้ามาแทน
  const todayIso = new Date(`${todayInBangkok()}T00:00:00+07:00`).toISOString();

  // ตัวเลขและรายการทุกอันบนหน้านี้ต้องนับเฉพาะหนังสือที่ผู้ใช้คนนี้มีสิทธิ์เห็น
  //
  // เดิมไม่มีการกรองสิทธิ์เลยแม้แต่ที่เดียว ที่ร้ายแรงที่สุดคือรายการ "เอกสารล่าสุด" ซึ่งดึง 8 ฉบับล่าสุด
  // ของทั้งระบบมาแสดง — ทดสอบยืนยันแล้วว่าครูธรรมดาเห็น "ชื่อเรื่อง" ของหนังสือชั้นลับมากที่ตัวเอง
  // เปิดอ่านไม่ได้ บนหน้าแรกที่ทุกคนเห็นทันทีหลังล็อกอิน โดยไม่ต้องพยายามอะไรเลย
  //
  // ส่วนตัวเลข KPI ที่ไม่กรองสิทธิ์ ทำให้ครูเห็น "หนังสือเข้าวันนี้ 15" ทั้งที่เปิดดูได้จริงน้อยกว่านั้น
  // ซึ่งทั้งชวนสับสนและบอกใบ้ปริมาณงานลับที่ตัวเองไม่เกี่ยวข้อง
  const visible = visibleDocumentsSqlFilter(user);
  const countVisible = (sql, extra = {}) => db.prepare(
    `SELECT COUNT(*) c FROM documents d WHERE d.deleted_at IS NULL AND ${visible.sql} AND ${sql}`,
  ).get({ ...visible.params, ...extra }).c;

  const inToday = countVisible("d.direction = 'incoming' AND d.created_at >= :since", { since: todayIso });
  const outToday = countVisible("d.direction = 'outgoing' AND d.created_at >= :since", { since: todayIso });
  const myTasks = db.prepare(`SELECT COUNT(*) c FROM workflow_steps ws WHERE ${MY_OR_DELEGATED_STEP_SQL} AND status = 'waiting'`).get(scope).c;
  const overdue = countVisible(
    "d.due_date IS NOT NULL AND d.due_date < :today AND d.status NOT IN ('completed','archived','voided','rejected')",
    { today: todayInBangkok() },
  );
  const completedToday = countVisible("d.status = 'completed' AND d.updated_at >= :since", { since: todayIso });

  const myPending = db.prepare(`
    SELECT d.*, dt.name as type_name, ws.id as step_id, (ws.assignee_id != :me) as is_delegated FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE ${MY_OR_DELEGATED_STEP_SQL} AND ws.status = 'waiting' ORDER BY d.priority DESC, ws.created_at ASC LIMIT 8
  `).all(scope);

  // กรองซ้ำด้วยตัวตรวจรายฉบับอีกชั้นเหมือนหน้าทะเบียน — การเปิดเผยหนังสือลับเป็นความผิดพลาด
  // ที่ยอมเสี่ยงไม่ได้ ดึงมาเผื่อแล้วค่อยตัดให้เหลือ 8 หลังกรอง
  const recent = db.prepare(`
    SELECT d.*, dt.name as type_name FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE d.deleted_at IS NULL AND ${visible.sql} ORDER BY d.created_at DESC LIMIT 40
  `).all(visible.params).filter((doc) => canUserSeeDocument(user, doc)).slice(0, 8);

  // Executive KPI (Master Spec §32) — avg completion time + pending load per department, ผู้บริหาร/แอดมินเท่านั้น
  const isExecutive = user.roleCodes.some((r) => ['admin', 'director', 'vice_director'].includes(r));
  let execKpiHtml = '';
  if (isExecutive) {
    const avgDays = db.prepare(`
      -- completed_at คือเวลาที่เรื่องปิดจริง ส่วน updated_at ขยับทุกครั้งที่แตะเอกสารทีหลัง (ดู db.js)
      SELECT AVG(julianday(COALESCE(d.completed_at, d.updated_at)) - julianday(d.created_at)) as avg_days FROM documents d
      WHERE d.status = 'completed' AND d.deleted_at IS NULL AND ${visible.sql}
    `).get(visible.params).avg_days;
    const byDept = db.prepare(`
      SELECT dep.name as dept_name, COUNT(*) as pending_count FROM documents d
      JOIN departments dep ON dep.id = d.department_id
      WHERE d.status IN ('registered', 'in_progress', 'returned') AND d.deleted_at IS NULL AND ${visible.sql}
      GROUP BY dep.id ORDER BY pending_count DESC
    `).all(visible.params);
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

  // แถบเตือนเรื่องการสำรองข้อมูล — แสดงเฉพาะแอดมิน/ธุรการ เพราะเป็นกลุ่มที่แก้ไขได้จริง
  // ครูทั่วไปเห็นแล้วทำอะไรไม่ได้ มีแต่ตกใจเปล่า
  const canFixBackup = user.roleCodes.some((r) => ['admin', 'registrar'].includes(r));
  const backup = canFixBackup ? getBackupStatus() : null;
  const backupAlert = !backup ? '' : backupWarningHtml(backup);

  // หนังสือที่ประทับความเห็น/ลายเซ็นลงไฟล์ PDF ไม่สำเร็จ — ค้างไว้จนกว่าจะแก้
  //
  // แถบเตือนตอนกดปุ่มขึ้นครั้งเดียวแล้วหายไป และคนที่เห็นคือผู้ตัดสินใจ ไม่ใช่ธุรการซึ่งเป็นคนเอาไฟล์
  // ไปส่งออกจริง ถ้าไม่รวมมาไว้ตรงนี้ ธุรการจะไม่มีทางรู้เลยว่ามีไฟล์ที่ขาดลายเซ็นอยู่ในระบบกี่ฉบับ
  const stampFailed = canFixBackup ? db.prepare(`
    SELECT a.document_id, d.doc_number_display, d.title
    FROM attachments a JOIN documents d ON d.id = a.document_id
    WHERE a.stamp_failed_at IS NOT NULL AND a.destroyed_at IS NULL AND d.deleted_at IS NULL
    ORDER BY a.stamp_failed_at DESC LIMIT 5
  `).all() : [];
  const stampAlert = stampFailed.length ? `
    <div class="alert alert-danger">
      <strong>⚠️ มีไฟล์หนังสือ ${stampFailed.length === 5 ? '5 ฉบับขึ้นไป' : `${stampFailed.length} ฉบับ`} ที่ยังไม่มีความเห็น/ลายเซ็นอยู่บนตัวไฟล์</strong>
      <div style="margin-top:.35rem;font-size:.9rem">
        ผลการตัดสินใจถูกบันทึกในทะเบียนแล้ว แต่เขียนลงในไฟล์ PDF จริงไม่สำเร็จ —
        <strong>อย่าเพิ่งส่งไฟล์เหล่านี้ออกไปหรือเก็บเข้าแฟ้ม</strong>
      </div>
      <ul style="margin:.4rem 0 0;padding-left:1.1rem;font-size:.9rem">
        ${stampFailed.map((r) => `<li><a href="/documents/${r.document_id}">${esc(r.doc_number_display)} — ${esc(r.title)}</a></li>`).join('')}
      </ul>
    </div>` : '';

  const greeting = timeGreeting();
  const content = `
    ${backupAlert}
    ${stampAlert}
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
        <strong>วิธีใช้หลังติดตั้ง:</strong> ใน LINE กดที่ไฟล์หนังสือ → กดปุ่มแชร์ → เลือก "${esc(appShortName())}" →
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
      ${kpi(inToday, 'หนังสือเข้าวันนี้', '📥', 'primary', '/documents?direction=incoming')}
      ${kpi(outToday, 'หนังสือออกวันนี้', '📤', 'secret', '/documents?direction=outgoing')}
      ${kpi(myTasks, 'งานรอฉันดำเนินการ', '📌', 'warning', '/tasks')}
      ${kpi(overdue, 'เกินกำหนด', '⏰', 'danger', '/summary')}
      ${kpi(completedToday, 'เสร็จสิ้นวันนี้', '✅', 'success', '/documents?status=completed')}
    </div>

    ${execKpiHtml}

    <div class="grid-2">
      <div class="card">
        <div class="card-header"><h3 class="mt-0">📌 งานของฉัน — ต้องดำเนินการ</h3><a class="text-muted" href="/tasks" style="font-size:.82rem">ดูทั้งหมด →</a></div>
        ${myPending.length ? `<div class="table-wrap"><table>
          <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ความเร็ว</th><th>สถานะ</th></tr></thead>
          <tbody>${myPending.map((d) => `<tr ${rowAttrs(`/documents/${d.id}`)}>
            <td>${rowLink(`/documents/${d.id}`, esc(d.doc_number_display))}${d.is_delegated ? ' <span title="รักษาการแทน">🪪</span>' : ''}</td><td>${esc(d.title)}</td>
            <td>${priorityBadge(d.priority)}</td><td>${statusBadge(d.status)}</td></tr>`).join('')}</tbody>
        </table></div>` : illustratedEmptyState('allClear', 'วันนี้ไม่มีงานค้างแล้ว พักผ่อนสบายๆ ได้เลยครับ ☕')}
      </div>
      <div class="card">
        <h3 class="mt-0">🕒 เอกสารล่าสุดในระบบ</h3>
        ${/* ทั้งรายการเป็นลิงก์เดียว ไม่ใช่แค่เลขทะเบียน — เดิมพื้นที่แตะสูงแค่ 17px (วัดบนจอ iPhone จริง)
              ซึ่งต่ำกว่าเกณฑ์ของทั้ง Apple และ Google มาก และ "ชื่อเรื่อง" ซึ่งเป็นสิ่งที่คนอ่านแล้วอยากกด
              กลับไม่ใช่ลิงก์เลย ต้องเล็งไปที่ตัวเลขเล็กๆ ข้างบนแทน */ ''}
        ${recent.length ? recent.map((d) => `
          <div style="border-bottom:1px solid var(--border)">
            <a class="list-link" href="/documents/${d.id}">
              <span style="font-weight:600;color:var(--primary)">${esc(d.doc_number_display)}</span> ${statusBadge(d.status)}
              <div class="text-muted" style="font-size:.82rem">${esc(d.title)}</div>
            </a>
          </div>`).join('') : illustratedEmptyState('emptyInbox', 'ยังไม่มีเอกสารในระบบ เริ่มต้นสร้างรายการแรกได้เลยครับ')}
      </div>
    </div>
    ${ctx.query.celebrate === '1' && myTasks === 0 ? '<div id="celebrateTrigger" hidden></div>' : ''}`;

  html(ctx, 200, layout({ user, title: 'แดชบอร์ด', path: '/', content }));
}));

// เพดานจำนวนงานค้างที่แสดงในหน้า "งานของฉัน" — ใช้ค่าเดียวกับหน้า "สรุปงานที่ต้องทำ" เพื่อความสม่ำเสมอ
const MAX_TASK_ROWS = 300;

router.get('/tasks', requirePage((ctx) => {
  const rawRows = db.prepare(`
    SELECT d.*, dt.name as type_name, ws.id as step_id, ws.created_at as assigned_at, (ws.assignee_id != :me) as is_delegated
    FROM workflow_steps ws
    JOIN documents d ON d.id = ws.document_id JOIN document_types dt ON dt.id = d.doc_type_id
    WHERE ${MY_OR_DELEGATED_STEP_SQL} AND ws.status = 'waiting' ORDER BY d.priority DESC, ws.created_at ASC
    LIMIT ${MAX_TASK_ROWS + 1}
  `).all({ me: ctx.user.id, today: todayInBangkok() });
  // ดึงมาเกินหนึ่งแถวเพื่อรู้ว่าถูกตัดหรือเปล่า แล้วบอกผู้ใช้ตรงๆ — เหมือนหน้า "สรุปงานที่ต้องทำ"
  // เดิมหน้านี้ไม่มีเพดานเลย ปกติไม่เป็นไรเพราะงานค้างของคนหนึ่งคนมีไม่กี่สิบฉบับ แต่ถ้าเรื่องไปค้าง
  // สะสมอยู่ที่ใครคนหนึ่ง (เช่นคนที่ย้ายออกไปแล้วแต่ยังมีเรื่องจ่อคิว) หน้าจะโตขึ้นเรื่อยๆ ไม่มีที่สิ้นสุด
  const tasksTruncated = rawRows.length > MAX_TASK_ROWS;

  // กรองชั้นความลับด้วยเสมอ เหมือนหน้าอื่นๆ — ปกติคนที่ถูกมอบหมายก็เห็นอยู่แล้ว แต่ถ้าชั้นความลับของ
  // เอกสารถูกยกระดับขึ้นทีหลัง แถวเก่าต้องหายไปจากหน้านี้ด้วย ไม่ใช่ยังโชว์ชื่อเรื่องค้างไว้
  const rows = rawRows.slice(0, MAX_TASK_ROWS).filter((d) => canUserSeeDocument(ctx.user, d));

  // เรียงของที่ "เลยกำหนด/ใกล้ครบกำหนด" ขึ้นก่อนเสมอ แล้วค่อยเรียงตามความเร็วที่ต้นทางระบุ —
  // เดิมเรียงตามความเร็วอย่างเดียว ทำให้หนังสือ "ปกติ" ที่เลยกำหนดมา 5 วันไปจมอยู่ท้ายตาราง
  rows.sort((a, b) => {
    const da = daysUntil(a.due_date), dbb = daysUntil(b.due_date);
    if (da === null && dbb !== null) return 1;
    if (dbb === null && da !== null) return -1;
    if (da !== null && dbb !== null && da !== dbb) return da - dbb;
    return new Date(a.assigned_at) - new Date(b.assigned_at);
  });
  const overdueCount = rows.filter((d) => daysUntil(d.due_date) < 0).length;

  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">📌 งานของฉัน</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          ${rows.length ? `รอคุณดำเนินการ${tasksTruncated ? 'มากกว่า' : ''} ${rows.length} ฉบับ${overdueCount ? ` · <strong style="color:var(--danger)">เลยกำหนดแล้ว ${overdueCount}</strong>` : ''} — เรียงตามวันครบกำหนด กดที่แถวเพื่อเปิดเอกสาร`
            : 'ไม่มีงานค้างอยู่ในมือคุณตอนนี้'}
        </p>
      </div>
    </div>
    <div class="card">
      ${tasksTruncated ? `<div class="alert alert-warning">⚠️ มีงานค้างมากกว่า ${MAX_TASK_ROWS} ฉบับ หน้านี้แสดงเฉพาะ ${MAX_TASK_ROWS} ฉบับที่ใกล้ครบกำหนดที่สุด — ดูทั้งหมดได้ที่<a href="/documents?direction=all&status=in_progress">ทะเบียนหนังสือ</a></div>` : ''}
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>เลขที่</th><th>เรื่อง</th><th>ความเร็ว</th><th>ครบกำหนด</th><th>มอบหมายเมื่อ</th></tr></thead>
        <tbody>${rows.map((d) => {
          const n = daysUntil(d.due_date);
          return `<tr ${rowAttrs(`/documents/${d.id}`)} style="${n !== null && n < 0 ? 'background:rgba(220,38,38,.06)' : ''}">
            <td style="white-space:nowrap">${rowLink(`/documents/${d.id}`, esc(d.doc_number_display))}${d.is_delegated ? ' <span title="รักษาการแทน">🪪</span>' : ''}${d.secret_level !== 'normal' ? ' <span title="ชั้นความลับ">🔒</span>' : ''}</td>
            <td class="wrap"><strong>${esc(d.title)}</strong></td>
            <td>${priorityBadge(d.priority)}</td>
            <td style="white-space:nowrap">${dueCell(d.due_date)}</td>
            <td class="text-muted">${fmtDate(d.assigned_at)}</td></tr>`;
        }).join('')}</tbody>
      </table></div>` : illustratedEmptyState('allClear', 'ไม่มีงานค้างสำหรับคุณเลยครับ พักผ่อนสบายๆ ได้เลยครับ ☕')}
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'งานของฉัน', path: '/tasks', content }));
}));

// ---------------- สรุปงานที่ต้องทำ ----------------
// ตารางรวมเอกสารที่ "มีกำหนดเสร็จและยังไม่ปิดเรื่อง" เรียงตามวันครบกำหนด — รูปแบบคอลัมน์อ้างอิงตาราง
// สรุปงานที่โรงเรียนใช้อยู่จริง (ระดับความสำคัญ / วันที่ต้องดำเนินการ / หัวข้อ / รายละเอียด / วิธีดำเนินการ /
// หมายเหตุ) เพื่อให้ดูแล้วเห็นภาพรวมได้ทันทีว่าค้างอะไรบ้าง ต้องทำอะไรก่อน โดยไม่ต้องเปิดทีละฉบับ
router.get('/summary', requirePage((ctx) => {
  const rawRows = db.prepare(`
    SELECT d.*, dep.name as dept_name,
      (SELECT ws.instruction FROM workflow_steps ws
        WHERE ws.document_id = d.id AND ws.status = 'waiting'
        ORDER BY ws.step_order DESC LIMIT 1) as pending_instruction,
      (SELECT COALESCE(u.prefix, '') || u.first_name || ' ' || u.last_name FROM workflow_steps ws
        JOIN users u ON u.id = ws.assignee_id
        WHERE ws.document_id = d.id AND ws.status = 'waiting'
        ORDER BY ws.step_order DESC LIMIT 1) as pending_assignee
    FROM documents d JOIN departments dep ON dep.id = d.department_id
    WHERE d.deleted_at IS NULL
      AND d.due_date IS NOT NULL AND d.due_date != ''
      AND d.status NOT IN ('completed', 'archived', 'voided', 'destroyed', 'rejected')
    ORDER BY d.due_date ASC,
      CASE d.priority WHEN 'most_urgent' THEN 0 WHEN 'very_urgent' THEN 1 WHEN 'urgent' THEN 2 ELSE 3 END ASC
    LIMIT 301
  `).all();
  // ดึงมา 301 เพื่อรู้ว่าโดนตัดหรือเปล่า (LIMIT ทำงานก่อนกรองสิทธิ์ในระดับ JS ด้านล่าง ตัวเลขสรุปด้านบน
  // จึงอาจไม่ครบถ้าเอกสารเยอะมาก) — ถ้าโดนตัดจริงจะขึ้นหมายเหตุบอกผู้ใช้ ไม่ปล่อยให้เข้าใจผิดว่าครบแล้ว
  const truncated = rawRows.length > 300;
  const rows = rawRows.slice(0, 300).filter((d) => canUserSeeDocument(ctx.user, d));

  // ป้ายนับถอยหลัง/เลยกำหนด ใช้ helper กลางจาก render.js เพื่อให้หน้ารายการหนังสือเข้าและหน้ารายละเอียด
  // แสดงผลเหมือนกันเป๊ะ — เดิมตรรกะนี้อยู่เฉพาะหน้านี้หน้าเดียว หน้าอื่นจึงไม่บอกเลยว่าเลยกำหนดหรือยัง
  const overdue = rows.filter((d) => daysUntil(d.due_date) < 0).length;
  const soon = rows.filter((d) => { const n = daysUntil(d.due_date); return n >= 0 && n <= 3; }).length;

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
          const n = daysUntil(d.due_date);
          return `<tr ${rowAttrs(`/documents/${d.id}`)} style="${n < 0 ? 'background:rgba(220,38,38,.06)' : ''}">
            <td>${priorityBadge(d.priority)}</td>
            <td style="white-space:nowrap">${dueCell(d.due_date, { long: true })}</td>
            <td>${rowLink(`/documents/${d.id}`, `<strong>${esc(d.title)}</strong>`)}<div class="text-muted" style="font-size:.78rem">${esc(d.doc_number_display)}${d.secret_level !== 'normal' ? ' 🔒' : ''}</div></td>
            <td>${d.subject ? esc(d.subject).replace(/\n/g, '<br/>') : '<span class="text-muted">—</span>'}</td>
            <td>${d.pending_instruction ? esc(d.pending_instruction).replace(/\n/g, '<br/>') : '<span class="text-muted">—</span>'}
              ${d.pending_assignee ? `<div class="text-muted" style="font-size:.78rem;margin-top:.2rem">ผู้รับผิดชอบ: ${esc(d.pending_assignee)}</div>` : ''}</td>
            <td>${statusBadge(d.status)}<div class="text-muted" style="font-size:.78rem;margin-top:.2rem">${esc(d.correspondent_name || '')}${d.dept_name ? `<br/>ฝ่าย${esc(d.dept_name)}` : ''}</div></td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>` : illustratedEmptyState('allClear', 'ยังไม่มีเอกสารที่ตั้งกำหนดเสร็จไว้ และยังค้างอยู่ครับ')}
    </div>
    ${truncated ? '<div class="alert alert-warning" style="margin-top:.6rem">⚠️ มีเอกสารที่มีกำหนดเสร็จมากกว่า 300 รายการ ตารางนี้แสดงเฉพาะ 300 รายการที่ใกล้ครบกำหนดที่สุด</div>' : ''}
    <div class="help-text" style="margin-top:.6rem">
      รายการนี้ดึงจากเอกสารที่กรอก "กำหนดเสร็จ" ไว้ตอนลงทะเบียน (อยู่ในหัวข้อ ⚙️ ตัวเลือกเพิ่มเติม) —
      ถ้าเอกสารไหนยังไม่โผล่ในตารางนี้ แปลว่ายังไม่ได้ใส่วันกำหนดเสร็จให้เอกสารฉบับนั้น
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'สรุปงานที่ต้องทำ', path: '/summary', content }));
}));
