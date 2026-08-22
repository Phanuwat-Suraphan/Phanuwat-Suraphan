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
import { isBackupEnabled, readBackupTree, deleteBackupNode, getBackupStatus } from '../services/dbBackup.js';

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
            <details class="backup-node" style="margin-left:1rem">
              <summary>
                <span class="backup-name">📅 ${esc(dayLabel(day.name))}</span>
                <span class="text-muted">${day.files.length} ชุด</span>
                ${deleteButton(day.id, dayLabel(day.name), 'ทั้งวัน')}
              </summary>
              ${day.files.length ? day.files.map((f) => `
                <div class="backup-file">
                  <span>💾 ${esc(fileLabel(f.name))} <span class="text-muted">${esc(sizeLabel(f.size))}</span></span>
                  ${deleteButton(f.id, `${dayLabel(day.name)} ${fileLabel(f.name)}`, 'ไฟล์นี้')}
                </div>`).join('') : '<div class="backup-file text-muted">ไม่มีไฟล์ในวันนี้</div>'}
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
    years = await readBackupTree();
  } catch (err) {
    loadError = err.message;
  }

  const status = getBackupStatus();
  const totalFiles = years.reduce((s, y) => s + y.months.reduce((s2, m) => s2 + m.days.reduce((s3, d) => s3 + d.files.length, 0), 0), 0);
  const totalDays = years.reduce((s, y) => s + y.months.reduce((s2, m) => s2 + m.days.length, 0), 0);
  const totalBytes = years.reduce((s, y) => s + y.months.reduce((s2, m) => s2 + m.days.reduce(
    (s3, d) => s3 + d.files.reduce((s4, f) => s4 + Number(f.size || 0), 0), 0), 0), 0);

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
        <div class="kpi-card"><div class="kpi-icon kpi-icon-success">💾</div>
          <div><div class="kpi-value">${totalFiles}</div><div class="kpi-label">ไฟล์ทั้งหมด</div></div></div>
        <div class="kpi-card"><div class="kpi-icon kpi-icon-warning">📦</div>
          <div><div class="kpi-value">${(totalBytes / 1048576).toFixed(0)}</div><div class="kpi-label">ขนาดรวม (MB)</div></div></div>
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
