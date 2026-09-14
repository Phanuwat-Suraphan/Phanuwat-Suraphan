// หน้าจัดการสำเนาสำรองฐานข้อมูลบน Google Drive — ดูว่ามีสำเนาของวันไหนบ้าง และลบทิ้งได้
// ทีละไฟล์ / ทั้งวัน / ทั้งเดือน / ทั้งปี ตามที่โรงเรียนขอ
//
// เปิดให้ธุรการใช้ด้วย (ไม่ใช่แค่แอดมิน) เพราะธุรการเป็นผู้ดูแลทะเบียนหนังสือตัวจริง และเป็นคนที่รู้ว่า
// สำเนาของวันไหนยังต้องเก็บไว้ — แต่การลบเป็นสิ่งที่ย้อนกลับไม่ได้ จึงบังคับยืนยัน PIN ทุกครั้ง
// เหมือนการลงนาม/ทำลายหนังสือในระบบ
import { router, html, json } from '../router.js';
import { layout, esc, fmtDate } from '../render.js';
import { requirePage, requireApi, requireRole } from '../middleware.js';
import { audit } from '../db.js';
import { isBackupEnabled, readBackupFolders, readBackupDayFiles, deleteBackupNode, getBackupStatus } from '../services/dbBackup.js';

const CAN_MANAGE = ['admin', 'registrar'];

const THAI_MONTHS = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];

// ชื่อโฟลเดอร์เก็บเป็นตัวเลขล้วน (2569-08-21) เพื่อให้เรียงลำดับถูกต้อง — แปลงเป็นคำอ่านตอนแสดงผล
function monthLabel(name) {
  const m = Number(name.slice(5, 7));
  return `${THAI_MONTHS[m - 1] || name} ${name.slice(0, 4)}`;
}
function dayLabel(name) {
  return `${Number(name.slice(8, 10))} ${THAI_MONTHS[Number(name.slice(5, 7)) - 1] || ''} ${name.slice(0, 4)}`;
}
function fileLabel(name) {
  const t = name.match(/(\d{2})(\d{2})\.db$/);
  return t ? `${t[1]}:${t[2]} น.` : name;
}
function sizeLabel(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '';
  return `${(n / 1048576).toFixed(2)} MB`;
}

function deleteButton(id, label, what) {
  return `<button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)"
    onclick="removeBackup('${esc(id)}', ${JSON.stringify(label).replace(/"/g, '&quot;')}, ${JSON.stringify(what).replace(/"/g, '&quot;')})">🗑️ ลบ${esc(what)}</button>`;
}

/**
 * แปลงโครงสร้าง ปี → เดือน → วัน → ไฟล์ เป็น HTML พับเก็บได้ พร้อมปุ่มลบทุกชั้น
 * แยกออกมาเป็นฟังก์ชันล้วนๆ เพื่อให้เทสต์เรียกได้โดยไม่ต้องต่อ Google Drive จริง
 */
export function backupTreeHtml(years) {
  return years.map((year) => `
    <details class="backup-node" open>
      <summary>
        <span class="backup-name">📁 ปี ${esc(year.name)}</span>
        <span class="text-muted">${year.months.reduce((s, m) => s + m.days.length, 0)} วัน</span>
        ${deleteButton(year.id, `ปี ${year.name}`, 'ทั้งปี')}
      </summary>
      ${year.months.map((month) => `
        <details class="backup-node" style="margin-left:1rem">
          <summary>
            <span class="backup-name">📁 ${esc(monthLabel(month.name))}</span>
            <span class="text-muted">${month.days.length} วัน</span>
            ${deleteButton(month.id, monthLabel(month.name), 'ทั้งเดือน')}
          </summary>
          ${month.days.map((day) => `
            <details class="backup-node" style="margin-left:1rem" ontoggle="loadBackupDay(this, '${esc(day.id)}', ${JSON.stringify(dayLabel(day.name)).replace(/"/g, '&quot;')})">
              <summary>
                <span class="backup-name">📅 ${esc(dayLabel(day.name))}</span>
                ${deleteButton(day.id, dayLabel(day.name), 'ทั้งวัน')}
              </summary>
              <div class="backup-file text-muted">กำลังอ่านรายการ…</div>
            </details>`).join('')}
        </details>`).join('')}
    </details>`).join('');
}

router.get('/admin/backups', requireRole(...CAN_MANAGE)(requirePage(async (ctx) => {
  if (!isBackupEnabled()) {
    return html(ctx, 200, layout({
      user: ctx.user, title: 'สำเนาสำรองฐานข้อมูล', path: '/admin/backups',
      content: `<h2>💾 สำเนาสำรองฐานข้อมูล</h2>
        <div class="alert alert-warning">
          ยังไม่ได้เปิดใช้การสำรองขึ้น Google Drive — ไปที่
          <a href="/admin/google-drive">เชื่อมต่อ Google Drive</a> ก่อน
        </div>`,
    }));
  }

  let years = [];
  let loadError = null;
  try {
    // อ่านเฉพาะโครงสร้างโฟลเดอร์ ไม่อ่านไฟล์ในแต่ละวัน — รายชื่อไฟล์โหลดตอนกดเปิดวันนั้นแทน
    // (ถ้าอ่านไฟล์ของทุกวันตรงนี้ พอเก็บครบ 1 ปีจะเป็น ~380 คำขอไป Google Drive หน้าจะค้างเป็นนาที)
    years = await readBackupFolders();
  } catch (err) {
    loadError = err.message;
  }

  const status = getBackupStatus();
  const allDays = years.flatMap((y) => y.months.flatMap((m) => m.days.map((d) => d.name))).sort();
  const totalDays = allDays.length;

  const treeHtml = backupTreeHtml(years);

  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">💾 สำเนาสำรองฐานข้อมูล</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          เก็บบน Google Drive แยกเป็นโฟลเดอร์ ปี → เดือน → วัน — ระบบเก็บวันละ 1 ชุดย้อนหลัง 1 ปี
          (ของวันนี้เก็บหลายชุด) และลบของเก่าเกิน 1 ปีให้เอง
        </p>
      </div>
    </div>

    ${status.state === 'warn' ? `<div class="alert alert-danger">
      ⚠️ การสำรองข้อมูลกำลังมีปัญหา${status.lastError ? ` — ${esc(status.lastError.message)}` : ''}
    </div>` : ''}
    ${loadError ? `<div class="alert alert-danger">อ่านรายการสำเนาสำรองไม่สำเร็จ: ${esc(loadError)}</div>` : ''}

    <div class="card">
      <div class="kpi-grid">
        <div class="kpi-card"><div class="kpi-icon kpi-icon-primary">📅</div>
          <div><div class="kpi-value">${totalDays}</div><div class="kpi-label">วันที่มีสำเนา</div></div></div>
        <div class="kpi-card"><div class="kpi-icon kpi-icon-success">🗓️</div>
          <div><div class="kpi-value" style="font-size:1.05rem">${totalDays ? esc(dayLabel(allDays[allDays.length - 1])) : '—'}</div>
          <div class="kpi-label">สำเนาล่าสุด</div></div></div>
        <div class="kpi-card"><div class="kpi-icon kpi-icon-warning">📦</div>
          <div><div class="kpi-value" style="font-size:1.05rem">${totalDays ? esc(dayLabel(allDays[0])) : '—'}</div>
          <div class="kpi-label">ย้อนหลังได้ถึง</div></div></div>
      </div>
      <div class="callout-tip" style="margin-top:1rem">
        ⚠️ สำเนาที่ลบไปแล้ว<strong>เรียกคืนไม่ได้</strong> — ถ้าเซิร์ฟเวอร์ถูกล้างหลังจากนั้น จะกู้ข้อมูลของวันที่ลบไปไม่ได้อีก
        กรุณาเก็บสำเนาล่าสุดไว้เสมออย่างน้อย 1 ชุด
      </div>
    </div>

    <div class="card">
      ${years.length ? treeHtml : '<p class="text-muted">ยังไม่มีสำเนาสำรอง — ระบบจะสำรองให้อัตโนมัติภายในไม่กี่นาทีหลังเปิดใช้งาน</p>'}
    </div>

    <script>
      // โหลดรายชื่อไฟล์ของวันนั้นตอนกดเปิดเท่านั้น — ถ้าโหลดมาพร้อมหน้าทั้งปี จะเป็นหลายร้อยคำขอ
      // ไป Google Drive ต่อการเปิดหน้าหนึ่งครั้ง หน้าจะค้างเป็นนาที
      async function loadBackupDay(el, dayId, label) {
        if (!el.open || el.dataset.loaded) return;
        el.dataset.loaded = '1';
        var box = el.querySelector('.backup-file');
        try {
          var res = await fetch('/admin/backups/day/' + encodeURIComponent(dayId));
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'อ่านรายการไม่สำเร็จ');
          if (!data.files.length) { box.textContent = 'ไม่มีไฟล์ในวันนี้'; return; }
          box.outerHTML = data.files.map(function (f) {
            return '<div class="backup-file"><span>💾 ' + f.timeLabel +
              ' <span class="text-muted">' + f.sizeLabel + '</span></span>' +
              '<button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" ' +
              'onclick="removeBackup(' + JSON.stringify(f.id).replace(/"/g, '&quot;') + ', ' +
              JSON.stringify(label + ' ').replace(/"/g, '&quot;') + ' + ' + JSON.stringify(f.timeLabel).replace(/"/g, '&quot;') +
              ', \\'ไฟล์นี้\\')">🗑️ ลบไฟล์นี้</button></div>';
          }).join('');
        } catch (e) {
          box.textContent = 'อ่านรายการไม่สำเร็จ: ' + e.message;
          el.dataset.loaded = '';
        }
      }

      async function removeBackup(id, label, what) {
        if (!confirm('ยืนยันลบสำเนาสำรอง ' + what + ' "' + label + '"?\\n\\nลบแล้วเรียกคืนไม่ได้')) return;
        var pin = await window.askPin('ยืนยัน PIN เพื่อลบสำเนาสำรอง ' + what);
        if (!pin) return;
        try {
          var res = await fetch('/admin/backups/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id: id, pin: pin }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'ลบไม่สำเร็จ');
          window.toast('ลบสำเนาสำรองเรียบร้อย', 'success');
          location.reload();
        } catch (e) {
          window.toast(e.message, 'danger');
        }
      }
    </script>`;

  html(ctx, 200, layout({ user: ctx.user, title: 'สำเนาสำรองฐานข้อมูล', path: '/admin/backups', content }));
})));

// รายชื่อสำเนาของวันหนึ่ง — โหลดตอนผู้ใช้กดเปิดวันนั้นบนหน้าจัดการ (ดู loadBackupDay ฝั่งเว็บ)
router.get('/admin/backups/day/:dayId', requireApi(async (ctx) => {
  if (!ctx.user.roleCodes.some((r) => CAN_MANAGE.includes(r))) {
    return json(ctx, 403, { error: 'เฉพาะธุรการ/ผู้ดูแลระบบเท่านั้น' });
  }
  if (!isBackupEnabled()) return json(ctx, 400, { error: 'ยังไม่ได้เปิดใช้การสำรองขึ้น Google Drive' });
  const dayId = decodeURIComponent(ctx.params.dayId);
  // ยืนยันก่อนว่า id ที่ส่งมาเป็นโฟลเดอร์รายวันของสำเนาสำรองจริง ไม่ใช่โฟลเดอร์อื่นในบัญชี Drive
  // (เหตุผลเดียวกับ deleteBackupNode — ห้ามให้คำขอที่ยิงเองอ่านโฟลเดอร์ไหนก็ได้ เช่นไฟล์แนบหนังสือ)
  const years = await readBackupFolders();
  const isBackupDay = years.some((y) => y.months.some((m) => m.days.some((d) => d.id === dayId)));
  if (!isBackupDay) return json(ctx, 404, { error: 'ไม่พบโฟลเดอร์สำเนาสำรองของวันนี้' });

  const files = (await readBackupDayFiles(dayId)).map((f) => ({
    id: f.id, timeLabel: fileLabel(f.name), sizeLabel: sizeLabel(f.size),
  }));
  json(ctx, 200, { files });
}));

router.post('/admin/backups/delete', requireApi(async (ctx) => {
  if (!ctx.user.roleCodes.some((r) => CAN_MANAGE.includes(r))) {
    return json(ctx, 403, { error: 'เฉพาะธุรการ/ผู้ดูแลระบบเท่านั้น' });
  }
  // ลบสำเนาสำรองย้อนกลับไม่ได้ และเป็นตัวกันข้อมูลหายทั้งระบบ จึงบังคับยืนยันตัวตนเหมือนการลงนาม
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, ctx.body.pin)) return json(ctx, 401, { error: 'PIN ไม่ถูกต้อง' });
  if (!ctx.body.id) return json(ctx, 400, { error: 'ไม่ได้ระบุรายการที่จะลบ' });

  await deleteBackupNode(ctx.body.id);
  audit({ userId: ctx.user.id, action: 'backup_deleted', tableName: 'google_drive', recordId: ctx.body.id });
  json(ctx, 200, { ok: true });
}));
