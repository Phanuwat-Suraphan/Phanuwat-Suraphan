// หน้าช่วยย้ายเซิร์ฟเวอร์ — ใช้ตอนสร้าง service ใหม่แล้วจะเลิกใช้ตัวเก่า
//
// ทำไมต้องมีหน้านี้: การย้ายโฮสต์เป็นงานที่ทำครั้งเดียวแต่พลาดแล้วข้อมูลหายถาวร และสิ่งที่ต้องยกไป
// ด้วยไม่ได้อยู่ใน git เลยสักอย่าง — เป็นตัวแปรสภาพแวดล้อมที่ตั้งไว้ในหน้าเว็บของโฮสต์ ซึ่งมองจาก
// ที่ไหนไม่เห็นนอกจากเปิดหน้าตั้งค่าของโฮสต์เอง ถ้ายกไปไม่ครบ เซิร์ฟเวอร์ใหม่จะบูตขึ้นมาแบบ
// "ดูเหมือนทำงานได้" แต่กู้ข้อมูลเดิมไม่ได้ ส่งไลน์ไม่ได้ และเริ่มสำรองฐานข้อมูลเปล่าทับของเดิม
//
// หน้านี้บอกว่า "เครื่องนี้ตั้งตัวแปรอะไรไว้บ้าง" โดยแสดงแค่ชื่อตัวแปรกับสถานะว่าตั้งไว้แล้วหรือยัง
// ไม่แสดงค่าจริงเด็ดขาด — ค่าพวกนี้คือรหัสผ่านและโทเคน ถ้าโผล่บนหน้าเว็บก็เท่ากับรั่วทันทีที่มีคน
// แคปหน้าจอส่งต่อ ซึ่งเกิดขึ้นได้ง่ายมากเวลาขอความช่วยเหลือกัน
import { router, html, json } from '../router.js';
import { layout, esc } from '../render.js';
import { requirePage, requireApi, requireRole } from '../middleware.js';
import { audit } from '../db.js';
import {
  getBackupStatus, isBackupEnabled, backupNow, backupBlockedReason,
  confirmStartFreshOverBackups, restoredFromBackupAtBoot,
} from '../services/dbBackup.js';

const ADMIN_ONLY = requireRole('admin');

/**
 * ตัวแปรที่ต้องยกไปเซิร์ฟเวอร์ใหม่ เรียงตาม "ถ้าลืมแล้วเสียหายแค่ไหน"
 *
 * critical = ลืมแล้วข้อมูลเดิมกู้ไม่ได้ หรือทุกคนถูกเตะออกจากระบบ
 * important = ลืมแล้วฟีเจอร์นั้นหยุดทำงาน แต่ข้อมูลไม่หาย
 * optional  = ไม่ตั้งก็ใช้งานได้ครบ
 */
const ENV_VARS = [
  { name: 'GOOGLE_OAUTH_CLIENT_ID', level: 'critical', why: 'ไม่มี = กู้ฐานข้อมูลจากสำเนาบน Drive ไม่ได้ และเปิดไฟล์แนบเดิมไม่ได้' },
  { name: 'GOOGLE_OAUTH_CLIENT_SECRET', level: 'critical', why: 'คู่กับ Client ID — ขาดตัวใดตัวหนึ่งก็เชื่อม Drive ไม่ได้' },
  { name: 'GOOGLE_OAUTH_REFRESH_TOKEN', level: 'critical', why: 'ตัวที่ทำให้เชื่อม Drive ได้เองโดยไม่ต้องกดยืนยันใหม่ — ขาดตัวนี้คือกู้ข้อมูลไม่ได้' },
  { name: 'STORAGE_PROVIDER', level: 'critical', why: 'ต้องเป็น google_drive ไม่งั้นระบบจะเก็บไฟล์ลงดิสก์ชั่วคราวที่ถูกล้างทุกครั้งที่ deploy' },
  { name: 'SESSION_SECRET', level: 'critical', why: 'ไม่ยกไป = ทุกคนที่ล็อกอินค้างไว้ถูกเตะออกและต้องล็อกอินใหม่ทั้งโรงเรียน' },
  { name: 'LINE_CHANNEL_ACCESS_TOKEN', level: 'important', why: 'ไม่มี = ส่งแจ้งเตือนเข้าไลน์ไม่ได้' },
  { name: 'LINE_CHANNEL_SECRET', level: 'important', why: 'ไม่มี = ครูเชื่อมบัญชีไลน์ไม่ได้ (ตรวจลายเซ็นของ webhook ไม่ผ่าน)' },
  { name: 'LINE_OA_BASIC_ID', level: 'optional', why: 'ไม่มีก็ใช้ได้ แต่ครูต้องหาบัญชีทางการของโรงเรียนเองแทนการกดลิงก์' },
  { name: 'LINE_LIFF_ID', level: 'optional', why: 'สำหรับเปิดระบบในแอปไลน์ได้เลยโดยไม่ต้องล็อกอินซ้ำ' },
  { name: 'LINE_LOGIN_CHANNEL_ID', level: 'optional', why: 'คู่กับ LIFF' },
  { name: 'PUBLIC_BASE_URL', level: 'important', why: 'ที่อยู่เว็บที่ใช้ในลิงก์ของข้อความแจ้งเตือน — ย้ายเซิร์ฟเวอร์แล้วต้องแก้ให้เป็นที่อยู่ใหม่' },
  { name: 'SELF_REGISTRATION', level: 'optional', why: 'ตั้ง off ถ้าไม่ต้องการให้ครูลงทะเบียนเอง' },
  { name: 'PRIVACY_CONTACT_EMAIL', level: 'optional', why: 'อีเมลติดต่อบนหน้านโยบายความเป็นส่วนตัว' },
  { name: 'BACKUP_INTERVAL_MINUTES', level: 'optional', why: 'ความถี่ในการสำรอง (ค่าเริ่มต้น 5 นาที)' },
  { name: 'BACKUP_KEEP_DAYS', level: 'optional', why: 'เก็บสำเนาย้อนหลังกี่วัน (ค่าเริ่มต้น 365)' },
  { name: 'BACKUP_KEEP_RECENT', level: 'optional', why: 'เก็บสำเนาของวันนี้กี่ชุด (ค่าเริ่มต้น 12)' },
];

// ตัวแปรที่ "ห้าม" ยกไป — ตั้งไว้ชั่วคราวเพื่อแก้ปัญหาเฉพาะหน้า ถ้าติดไปด้วยจะกลายเป็นช่องโหว่ถาวร
const MUST_NOT_COPY = [
  { name: 'TEST_MODE_PASSWORD', why: 'ทุกบัญชีใช้รหัสเดียวกัน และรหัสที่แต่ละคนตั้งเองถูกล้างทุกครั้งที่เซิร์ฟเวอร์เริ่มทำงาน' },
  { name: 'TEST_MODE_PIN', why: 'เหมือนกัน — PIN ใช้แทนการลงลายมือชื่อ' },
  { name: 'ADMIN_RESET_PASSWORD', why: 'ตั้งรหัสแอดมินทับทุกครั้งที่บูต ใครรู้ค่านี้ก็เข้าเป็นแอดมินได้ตลอด' },
  { name: 'ADMIN_RESET_CODE', why: 'คู่กับ ADMIN_RESET_PASSWORD' },
];

const isSet = (name) => Boolean(String(process.env[name] ?? '').trim());

const LEVEL_BADGE = {
  critical: '<span class="badge badge-danger">ห้ามลืม</span>',
  important: '<span class="badge badge-warning">ควรยกไป</span>',
  optional: '<span class="badge badge-muted">ไม่บังคับ</span>',
};

router.get('/admin/migrate', ADMIN_ONLY(requirePage((ctx) => {
  const backup = getBackupStatus();
  const blocked = backupBlockedReason();
  const restored = restoredFromBackupAtBoot();
  const here = `${ctx.req.headers['x-forwarded-proto'] || 'https'}://${ctx.req.headers.host || ''}`;

  const setVars = ENV_VARS.filter((v) => isSet(v.name));
  const missingCritical = ENV_VARS.filter((v) => v.level === 'critical' && !isSet(v.name));
  const leftovers = MUST_NOT_COPY.filter((v) => isSet(v.name));

  const varRow = (v) => `<tr>
    <td><code>${esc(v.name)}</code></td>
    <td>${LEVEL_BADGE[v.level]}</td>
    <td>${isSet(v.name) ? '<span class="badge badge-success">ตั้งไว้แล้ว</span>' : '<span class="text-muted">ไม่ได้ตั้ง</span>'}</td>
    <td class="text-muted" style="font-size:.84rem">${esc(v.why)}</td>
  </tr>`;

  const content = `
    <h2>🚚 ย้ายไปเซิร์ฟเวอร์ใหม่</h2>
    <p class="text-muted" style="margin-top:-.5rem">
      ใช้หน้านี้ตอนสร้าง service ใหม่แล้วจะเลิกใช้ตัวเก่า — ทำตามลำดับ อย่าลบตัวเก่าจนกว่าจะตรวจครบ
    </p>

    ${blocked ? `<div class="alert alert-danger">
      <strong>⛔ หยุดการสำรองข้อมูลไว้ชั่วคราว</strong>
      <p style="margin:.5rem 0">${esc(blocked)}</p>
      <p style="margin:.5rem 0;font-size:.9rem">
        แปลว่าเซิร์ฟเวอร์นี้<strong>ไม่ได้กู้ข้อมูลเดิมมา</strong> ถ้าปล่อยให้สำรองต่อ ความว่างเปล่าจะทับ
        สำเนาที่ใช้กู้คืนได้ — ตรวจว่าตั้ง <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> ครบหรือยัง แล้ว
        <strong>restart เซิร์ฟเวอร์</strong> ระบบจะกู้ข้อมูลกลับมาให้เองตอนบูต
      </p>
      <button class="btn btn-outline btn-sm" onclick="startFresh()">ยืนยันว่าตั้งใจเริ่มใหม่ (ข้อมูลเดิมไม่ต้องใช้แล้ว)</button>
    </div>` : ''}

    ${restored ? `<div class="alert alert-success">
      ✅ เซิร์ฟเวอร์นี้กู้ฐานข้อมูลมาจากสำเนา <code>${esc(restored)}</code> ตอนเปิดระบบ — ข้อมูลเดิมมาครบแล้ว
    </div>` : ''}

    <div class="card">
      <h3 class="mt-0">1️⃣ ตรวจว่าสำเนาข้อมูลใช้การได้จริงก่อน</h3>
      <p class="text-muted" style="font-size:.9rem;margin-top:0">
        นี่คือขั้นที่สำคัญที่สุด — ดิสก์ของเซิร์ฟเวอร์แบบฟรีถูกล้างทุกครั้งที่ deploy
        <strong>สำเนาบน Google Drive คือข้อมูลตัวจริงเพียงชุดเดียว</strong> เซิร์ฟเวอร์ใหม่จะกู้จากตรงนี้
      </p>
      <div class="table-wrap"><table class="table-plain">
        <tr><td class="text-muted" style="width:12rem">เชื่อม Google Drive</td>
          <td>${isBackupEnabled() ? '<span class="badge badge-success">เชื่อมแล้ว</span>' : '<span class="badge badge-danger">ยังไม่ได้เชื่อม</span>'}</td></tr>
        <tr><td class="text-muted">สำรองล่าสุด</td>
          <td>${backup.lastOkAt ? esc(new Date(backup.lastOkAt).toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' })) : '<span class="badge badge-danger">ยังไม่เคยสำรองสำเร็จ</span>'}</td></tr>
        ${backup.lastError ? `<tr><td class="text-muted">ข้อผิดพลาดล่าสุด</td><td class="text-danger">${esc(backup.lastError.message)}</td></tr>` : ''}
      </table></div>
      <div class="chip-row" style="margin-top:.6rem">
        <button class="btn btn-primary btn-sm" onclick="backupNow(this)">สำรองเดี๋ยวนี้เลย</button>
        <a class="btn btn-outline btn-sm" href="/admin/backups">ดูสำเนาทั้งหมดบน Drive</a>
      </div>
      <div class="help-text">
        ต้องเห็นสำเนาของ<strong>วันนี้</strong>ในหน้าสำเนาสำรองก่อน จึงจะไปขั้นถัดไปได้
      </div>
    </div>

    <div class="card">
      <h3 class="mt-0">2️⃣ ยกตัวแปรสภาพแวดล้อมไปเซิร์ฟเวอร์ใหม่</h3>
      <p class="text-muted" style="font-size:.9rem;margin-top:0">
        ค่าพวกนี้<strong>ไม่ได้อยู่ในโค้ด</strong> อยู่ในหน้าตั้งค่าของโฮสต์เท่านั้น (Render → Environment)
        ต้องเปิดของเก่าแล้วคัดลอกไปวางในของใหม่เอง — หน้านี้แสดงเฉพาะ<strong>ชื่อ</strong>ตัวแปร ไม่แสดงค่า
        เพราะค่าพวกนี้คือรหัสผ่านและโทเคน ถ้าโผล่บนหน้าจอก็รั่วได้ทันทีที่แคปหน้าจอส่งต่อกัน
      </p>
      ${missingCritical.length ? `<div class="alert alert-warning">
        ⚠️ เซิร์ฟเวอร์<strong>ตัวนี้</strong>ยังไม่ได้ตั้ง ${missingCritical.map((v) => `<code>${esc(v.name)}</code>`).join(' ')}
        — ตรวจให้ครบก่อนย้าย ไม่งั้นตัวใหม่ก็จะขาดเหมือนกัน
      </div>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>ชื่อตัวแปร</th><th>ความสำคัญ</th><th>บนเครื่องนี้</th><th>ถ้าลืมจะเป็นอย่างไร</th></tr></thead>
        <tbody>${ENV_VARS.map(varRow).join('')}</tbody>
      </table></div>
      <div class="chip-row" style="margin-top:.6rem">
        <button class="btn btn-outline btn-sm" onclick="copyNames()">คัดลอกรายชื่อตัวแปรที่ตั้งไว้ (${setVars.length} ตัว)</button>
      </div>
      <textarea id="varNames" readonly style="display:none">${esc(setVars.map((v) => v.name).join('\n'))}</textarea>
    </div>

    <!-- แสดงเสมอ ไม่ใช่เฉพาะตอนที่มีตัวค้างอยู่ — ตอนย้ายเซิร์ฟเวอร์คนมักคัดลอกตัวแปร "ทั้งหมด"
         จากของเก่าไปวางในของใหม่รวดเดียว รายการนี้คือสิ่งที่ต้องรู้ก่อนทำแบบนั้น ไม่ใช่หลังจากทำไปแล้ว -->
    <div class="card"${leftovers.length ? ' style="border-color:var(--danger)"' : ''}>
      <h3 class="mt-0">⛔ ตัวแปรที่ห้ามยกไปด้วย</h3>
      <p class="text-muted" style="font-size:.9rem;margin-top:0">
        ${leftovers.length
          ? '<strong style="color:var(--danger)">เครื่องนี้ยังตั้งค่าเหล่านี้ค้างไว้</strong> — ตั้งไว้เพื่อแก้ปัญหาเฉพาะหน้า ถ้าติดไปเซิร์ฟเวอร์ใหม่ด้วยจะกลายเป็นช่องโหว่ถาวร <strong>และควรลบออกจากเครื่องนี้ด้วยเช่นกัน</strong>'
          : 'เครื่องนี้ไม่ได้ตั้งค่าเหล่านี้ไว้ (ดีแล้ว) — แต่ถ้าเคยตั้งไว้ที่ไหน อย่าคัดลอกติดไปเซิร์ฟเวอร์ใหม่'}
      </p>
      <div class="table-wrap"><table class="table-plain">
        ${MUST_NOT_COPY.map((v) => `<tr>
          <td style="white-space:nowrap"><code>${esc(v.name)}</code></td>
          <td>${isSet(v.name) ? '<span class="badge badge-danger">ตั้งค้างอยู่</span>' : '<span class="text-muted" style="font-size:.82rem">ไม่ได้ตั้ง</span>'}</td>
          <td class="text-muted" style="font-size:.84rem">${esc(v.why)}</td>
        </tr>`).join('')}
      </table></div>
    </div>

    <div class="card">
      <h3 class="mt-0">3️⃣ ลำดับที่ต้องทำ</h3>
      <ol style="line-height:2;padding-left:1.2rem;margin:0">
        <li>กด <strong>สำรองเดี๋ยวนี้เลย</strong> ข้างบน แล้วตรวจว่ามีสำเนาของวันนี้จริง</li>
        <li>สร้าง service ใหม่บนโฮสต์ ชี้มาที่ repo และ branch เดิม</li>
        <li><strong>ใส่ตัวแปรให้ครบตั้งแต่ก่อนบูตครั้งแรก</strong> โดยเฉพาะ <code>GOOGLE_OAUTH_REFRESH_TOKEN</code>
            — ถ้าบูตครั้งแรกโดยไม่มีตัวนี้ ระบบจะสร้างฐานข้อมูลเปล่าขึ้นมา แล้วการกู้คืนจะไม่ทำงานอีกเลย
            เพราะมันกู้เฉพาะตอนที่ยังไม่มีไฟล์ฐานข้อมูล</li>
        <li>แก้ <code>PUBLIC_BASE_URL</code> ให้เป็นที่อยู่ใหม่</li>
        <li>เปิดเว็บใหม่ แล้วตรวจว่า<strong>หนังสือเดิมอยู่ครบ</strong> (หน้านี้จะขึ้นแถบเขียวว่ากู้มาจากสำเนาไหน)</li>
        <li>แก้ <strong>Webhook URL</strong> ที่ developers.line.biz ให้ชี้มาที่ที่อยู่ใหม่ แล้วกด Verify</li>
        <li>ส่งที่อยู่ใหม่ให้ครูทุกคน และให้คนที่ติดตั้งแอปไว้บนหน้าจอโฮมลบของเก่าแล้วติดตั้งใหม่</li>
        <li><strong>ค่อยลบ service เก่า</strong> — ทิ้งไว้สักสัปดาห์จนแน่ใจว่าตัวใหม่ทำงานครบ</li>
      </ol>
      <div class="callout-tip" style="margin-top:.7rem">
        ที่อยู่ของเซิร์ฟเวอร์นี้ตอนนี้คือ <code>${esc(here)}</code> —
        Webhook URL ของไลน์คือ <code>${esc(here)}/line/webhook</code>
      </div>
    </div>

    <script>
      window.backupNow = function (btn) {
        window.setBtnLoading(btn, 'กำลังสำรอง...');
        fetch('/admin/migrate/backup-now', { method: 'POST' })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) {
            if (!x.ok || !x.d.ok) throw new Error(x.d.error || 'สำรองไม่สำเร็จ');
            window.toast('สำรองขึ้น Google Drive แล้ว', 'success');
            setTimeout(function () { location.reload(); }, 900);
          })
          .catch(function (e) { window.toast(e.message, 'danger'); window.restoreBtn(btn); });
      };
      window.startFresh = function () {
        if (!confirm('ยืนยันว่าข้อมูลเดิมบน Google Drive ไม่ต้องใช้แล้ว?\\n\\nระบบจะเริ่มสำรองฐานข้อมูลปัจจุบัน (ซึ่งว่างเปล่า) ทับสำเนาเดิม และย้อนกลับไม่ได้')) return;
        fetch('/admin/migrate/start-fresh', { method: 'POST' })
          .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
          .then(function (x) { if (!x.ok) throw new Error(x.d.error); location.reload(); })
          .catch(function (e) { window.toast(e.message, 'danger'); });
      };
      window.copyNames = function () {
        var t = document.getElementById('varNames');
        t.style.display = '';
        t.select();
        t.setSelectionRange(0, 99999);
        if (navigator.clipboard) navigator.clipboard.writeText(t.value).then(function () { window.toast('คัดลอกรายชื่อแล้ว', 'success'); });
        else window.toast('กด Ctrl+C เพื่อคัดลอก', 'info');
        t.style.display = 'none';
      };
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'ย้ายเซิร์ฟเวอร์', path: '/admin/migrate', content }));
})));

router.post('/admin/migrate/backup-now', ADMIN_ONLY(requireApi(async (ctx) => {
  const ok = await backupNow('ก่อนย้ายเซิร์ฟเวอร์');
  const status = getBackupStatus();
  json(ctx, ok ? 200 : 400, ok
    ? { ok: true }
    : { ok: false, error: backupBlockedReason() || status.lastError?.message || 'สำรองไม่สำเร็จ — ตรวจการเชื่อมต่อ Google Drive' });
})));

router.post('/admin/migrate/start-fresh', ADMIN_ONLY(requireApi((ctx) => {
  confirmStartFreshOverBackups();
  audit({ userId: ctx.user.id, action: 'backup_start_fresh_confirmed', tableName: 'settings', recordId: null, detail: {} });
  json(ctx, 200, { ok: true });
})));
