import { todayInBangkok } from './db.js';

export function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// เวลาทุกจุดที่แสดงให้ผู้ใช้เห็นต้องระบุ timeZone ตรงๆ ห้ามพึ่งเวลาของเครื่องเซิร์ฟเวอร์ — เครื่องบนคลาวด์
// (ทั้ง Render และ Oracle Cloud) ตั้งเป็น UTC มาจากโรงงาน ถ้าไม่ระบุ เวลาที่แสดงจะช้ากว่าความจริง
// 7 ชั่วโมงทั้งระบบ รวมถึง "เวลา" ที่ประทับลงตรารับในไฟล์ PDF ของเอกสารราชการด้วย
// (บ่ายสามครึ่งจะถูกประทับเป็น 08:30 บนหนังสือจริง)
export const SCHOOL_TZ = 'Asia/Bangkok';

// ค่าที่เป็น "วันที่ล้วน" (YYYY-MM-DD เช่น วันครบกำหนด) ไม่ใช่จุดเวลา — ต้องอ่านเป็นวันที่ตามปฏิทินตรงๆ
// ไม่ผ่านการแปลงโซนเวลา ไม่งั้นวันจะเลื่อนไปหนึ่งวันบนเครื่องที่ตั้งโซนเวลาต่างจากไทย
function parseForDisplay(iso) {
  const dateOnly = typeof iso === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(iso);
  const d = new Date(dateOnly ? `${iso}T00:00:00Z` : iso);
  return { d, tz: dateOnly ? 'UTC' : SCHOOL_TZ, ok: !Number.isNaN(d.getTime()) };
}

export function fmtDate(iso) {
  if (!iso) return '-';
  const { d, tz, ok } = parseForDisplay(iso);
  if (!ok) return esc(iso);
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
}

// รูปแบบ "วัน เดือน ปี" ตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ พ.ศ. 2526 ภาคผนวก 2 —
// "ให้ลงตัวเลขของวันที่ ชื่อเต็มของเดือน และตัวเลขของปีพุทธศักราชที่ออกหนังสือ" (เลขวันที่ + ชื่อเดือนเต็ม
// + ปี พ.ศ. ไม่ย่อเดือน ไม่มีเวลา) ใช้เฉพาะบล็อกลงนามที่ต้องเป็นทางการ ส่วนอื่นยังใช้ fmtDate ตามเดิม
export function fmtThaiDateLong(iso) {
  if (!iso) return '-';
  const { d, tz, ok } = parseForDisplay(iso);
  if (!ok) return esc(iso);
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'long', year: 'numeric', timeZone: tz });
}

// วันที่แบบสั้นอ่านง่าย "25 ส.ค. 2569" — ใช้กับตารางและหน้ารายละเอียดทั่วไป ที่ต้องการเห็นวันเร็วๆ
// (ห้ามโชว์รูปแบบดิบจากฐานข้อมูลอย่าง "2026-08-25" ให้ผู้ใช้เห็น — เป็น ค.ศ. และไม่ใช่รูปแบบไทย
//  อ่านแล้วต้องแปลงในหัวเองทุกครั้ง หน้าอื่นๆ ในระบบก็แสดงเป็น พ.ศ. อยู่แล้ว จะสับสนกันเอง)
export function fmtThaiDateShort(iso) {
  if (!iso) return '-';
  const { d, tz, ok } = parseForDisplay(iso);
  if (!ok) return esc(iso);
  return d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
}

// วันที่/เวลาที่จะประทับลงตราในไฟล์ PDF จริง — ต้องเป็นเวลาไทยเสมอ เพราะเป็นเวลาที่ปรากฏบนหนังสือราชการ
export function stampDateThai(date = new Date()) {
  return date.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: SCHOOL_TZ });
}
export function stampTimeThai(date = new Date()) {
  return date.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: SCHOOL_TZ });
}
// ชั่วโมงปัจจุบันตามเวลาไทย (0-23) — ใช้เลือกคำทักทายให้ตรงกับเวลาจริงของโรงเรียน
export function bangkokHour(date = new Date()) {
  return Number(date.toLocaleString('en-GB', { hour: '2-digit', hour12: false, timeZone: SCHOOL_TZ }));
}

// จำนวนวันจากวันนี้ถึงวันครบกำหนด — ติดลบแปลว่าเลยกำหนดมาแล้ว
export function daysUntil(dateStr) {
  if (!dateStr) return null;
  // นับจาก "วันนี้ตามเวลาไทย" ไม่ใช่เวลาเครื่องเซิร์ฟเวอร์ (UTC) ไม่งั้นช่วงเช้ามืดของไทยจะบอกว่า
  // เลยกำหนดไปแล้ว 1 วัน ทั้งที่ยังเป็นวันครบกำหนดพอดี — และตัวเลขจะไม่ตรงกับหน้าอื่นที่นับจาก SQL
  const today = new Date(`${todayInBangkok()}T00:00:00`);
  const target = new Date(`${String(dateStr).slice(0, 10)}T00:00:00`);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round((target - today) / 86400000);
}

// ป้ายบอกว่าเหลืออีกกี่วัน/เลยมากี่วัน — คนละเรื่องกับ "ความเร็ว" ที่ธุรการกรอกตอนลงทะเบียน
// อันนั้นคือความเร่งด่วนที่ต้นทางระบุมา อันนี้คือความจริงว่าวันนี้ยังทันไหม
export function dueChip(n) {
  if (n === null) return '';
  if (n < 0) return `<span class="badge badge-danger">เลยกำหนด ${Math.abs(n)} วัน</span>`;
  if (n === 0) return '<span class="badge badge-danger">ครบกำหนดวันนี้</span>';
  if (n <= 3) return `<span class="badge badge-warning">อีก ${n} วัน</span>`;
  return `<span class="text-muted" style="font-size:.8rem">อีก ${n} วัน</span>`;
}

// วันครบกำหนดพร้อมป้ายนับถอยหลัง สำหรับใส่ในช่องตาราง/แถวรายละเอียด
export function dueCell(dateStr, { long = false } = {}) {
  if (!dateStr) return '<span class="text-muted">—</span>';
  const n = daysUntil(dateStr);
  const text = long ? fmtThaiDateLong(dateStr) : fmtThaiDateShort(dateStr);
  return `${esc(text)}<div style="margin-top:.2rem">${dueChip(n)}</div>`;
}

const PRIORITY_LABEL = { normal: 'ปกติ', urgent: 'ด่วน', very_urgent: 'ด่วนมาก', most_urgent: 'ด่วนที่สุด' };
const PRIORITY_BADGE = { normal: 'badge-muted', urgent: 'badge-warning', very_urgent: 'badge-danger', most_urgent: 'badge-danger' };
const SECRET_LABEL = { normal: 'ปกติ', internal: 'ภายใน', secret: 'ลับ', top_secret: 'ลับมาก' };
const STATUS_LABEL = {
  draft: 'ร่าง', registered: 'ลงทะเบียนแล้ว', in_progress: 'กำลังดำเนินการ',
  returned: 'ส่งกลับแก้ไข', rejected: 'ไม่อนุมัติ', completed: 'เสร็จสิ้น', archived: 'จัดเก็บแล้ว', voided: 'ยกเลิก', destroyed: 'ทำลายแล้ว',
};
const STATUS_BADGE = {
  draft: 'badge-muted', registered: 'badge-info', in_progress: 'badge-warning',
  returned: 'badge-warning', rejected: 'badge-danger', completed: 'badge-success', archived: 'badge-muted', voided: 'badge-danger', destroyed: 'badge-danger',
};

export function priorityBadge(p) {
  return `<span class="badge ${PRIORITY_BADGE[p] || 'badge-muted'}">${esc(PRIORITY_LABEL[p] || p)}</span>`;
}
export function secretBadge(s) {
  if (!s || s === 'normal') return `<span class="badge badge-muted">ปกติ</span>`;
  return `<span class="badge badge-secret">🔒 ${esc(SECRET_LABEL[s] || s)}</span>`;
}
export function statusBadge(s) {
  return `<span class="badge ${STATUS_BADGE[s] || 'badge-muted'}">${esc(STATUS_LABEL[s] || s)}</span>`;
}
export const LABELS = { PRIORITY_LABEL, SECRET_LABEL, STATUS_LABEL };

function navItem(href, icon, label, currentPath) {
  const active = currentPath === href || (href !== '/' && currentPath.startsWith(href));
  return `<a class="nav-link${active ? ' active' : ''}" href="${href}"><span class="icon">${icon}</span><span>${esc(label)}</span></a>`;
}

// อวตาร: ถ้าผู้ใช้เลือกอิโมจิไว้ (UX Bible Part 21 §8) ใช้อิโมจินั้น ไม่งั้น fallback เป็นตัวอักษรย่อชื่อ
export function avatarContent(user) {
  if (user?.avatar_emoji) return esc(user.avatar_emoji);
  return esc((user?.first_name?.[0] || '') + (user?.last_name?.[0] || ''));
}

export function layout({ user, title, path: currentPath, content, flash }) {
  const initials = avatarContent(user);
  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<title>${esc(title)} · ระบบสารบรรณอิเล็กทรอนิกส์</title>
<link rel="stylesheet" href="/style.css" />
<link rel="icon" href="/favicon.svg" type="image/svg+xml" />
<link rel="manifest" href="/manifest.webmanifest" />
<meta name="theme-color" content="#2059c9" />
<meta name="mobile-web-app-capable" content="yes" />
<link rel="apple-touch-icon" href="/icon-192.png" />
<script>
  (function(){ var t = localStorage.getItem('esaraban_theme'); if (t==='light'||t==='dark') document.documentElement.setAttribute('data-theme', t); })();
  // ลงทะเบียน service worker เพื่อเปิดใช้ "แชร์ไฟล์จาก LINE/แอปอื่น เข้าระบบโดยตรง" (ดู public/sw.js)
  // ต้องเป็น HTTPS เท่านั้น (Render ให้มาอยู่แล้ว) — ถ้าเบราว์เซอร์ไม่รองรับก็แค่ไม่มีฟีเจอร์นี้ ระบบอื่นปกติ
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () { navigator.serviceWorker.register('/sw.js').catch(function () {}); });
  }
</script>
</head>
<body>
${user ? renderAppShell({ user, currentPath, content, flash, initials }) : content}
<div id="pinModal" class="modal-backdrop">
  <div class="modal">
    <h3 id="pinModalTitle">ยืนยันตัวตนด้วย PIN</h3>
    <p class="text-muted" style="font-size:.82rem">กรอกรหัส PIN 6 หลักของคุณเพื่อยืนยันการทำรายการนี้ (ตาม Business Rule: ต้องยืนยันตัวตนก่อนรับทราบ/ลงนามทุกครั้ง)</p>
    <div class="field">
      <input type="text" inputmode="numeric" maxlength="6" id="pinInput" placeholder="••••••" style="text-align:center;font-size:1.4rem;letter-spacing:.4em" autocomplete="off" />
    </div>
    <div class="flex gap-2">
      <button class="btn btn-outline btn-block" onclick="closePinModal(false)">ยกเลิก</button>
      <button class="btn btn-primary btn-block" onclick="confirmPin()">ยืนยัน</button>
    </div>
  </div>
</div>
<script src="/app.js"></script>
</body>
</html>`;
}

function renderAppShell({ user, currentPath, content, flash, initials }) {
  return `
<div class="app-shell">
  <div id="sidebarBackdrop" class="sidebar-backdrop" onclick="toggleSidebar(false)"></div>
  <aside class="sidebar" id="sidebar">
    <div class="sidebar-brand">
      <div class="logo-dot">จพ</div>
      <div>ระบบสารบรรณ<br/><span class="text-muted" style="font-weight:400;font-size:.72rem">ร.ร.เจ้าพ่อหลวงอุปถัมภ์ ๑</span></div>
    </div>
    ${navItem('/', '🏠', 'แดชบอร์ด', currentPath)}
    ${navItem('/tasks', '📌', 'งานของฉัน', currentPath)}
    ${navItem('/notifications', '🔔', 'การแจ้งเตือน', currentPath)}

    <div class="nav-section-label">ทะเบียนหนังสือ</div>
    ${navItem('/documents?direction=incoming', '📥', 'หนังสือเข้า', currentPath)}
    ${navItem('/documents?direction=outgoing', '📤', 'หนังสือออก', currentPath)}
    ${navItem('/summary', '🗒️', 'สรุปงานที่ต้องทำ', currentPath)}
    ${navItem('/daily-summary', '📅', 'สรุปงานรายวัน', currentPath)}

    <div class="nav-section-label">งานบุคคล</div>
    ${navItem('/leave', '🗓️', 'ลา/ไปราชการ', currentPath)}
    ${navItem('/delegations', '🪪', 'มอบหมายรักษาการแทน', currentPath)}
    ${navItem('/announcements', '📢', 'ประกาศ/ประชาสัมพันธ์', currentPath)}

    <div class="nav-section-label">รายงาน</div>
    ${navItem('/reports', '📊', 'รายงาน', currentPath)}
    ${user.roleCodes.some((r) => ['admin', 'registrar', 'director', 'vice_director'].includes(r)) ? navItem('/retention', '🗄️', 'อายุการเก็บ/ทำลาย', currentPath) : ''}

    <div class="nav-section-label">ระบบ</div>
    ${user.roleCodes.includes('admin') ? navItem('/admin/users', '⚙️', 'จัดการผู้ใช้', currentPath) : ''}
    ${user.roleCodes.includes('admin') ? navItem('/admin/audit', '🧾', 'Audit Log', currentPath) : ''}
    ${user.roleCodes.includes('admin') ? navItem('/admin/google-drive', '🗂️', 'เชื่อมต่อ Google Drive', currentPath) : ''}
    ${user.roleCodes.includes('admin') ? navItem('/admin/line', '💬', 'แจ้งเตือนเข้ากลุ่ม LINE', currentPath) : ''}
    ${user.roleCodes.some((r) => ['admin', 'registrar'].includes(r)) ? navItem('/admin/backups', '💾', 'สำเนาสำรองข้อมูล', currentPath) : ''}
    ${navItem('/profile', '👤', 'โปรไฟล์ของฉัน', currentPath)}
    <a class="nav-link" href="/logout">${'<span class="icon">🚪</span><span>ออกจากระบบ</span>'}</a>
  </aside>

  <div class="main-col">
    <header class="topbar">
      <button class="hamburger-btn" onclick="toggleSidebar(true)" aria-label="เปิดเมนู">☰</button>
      <div class="topbar-search">
        <span>🔍</span>
        <form action="/documents" method="get" style="width:100%">
          <input type="text" id="globalSearchInput" name="q" placeholder="ค้นหา... (Ctrl+K)" />
        </form>
      </div>
      <div class="topbar-spacer"></div>
      <div class="topbar-right">
        <button class="icon-btn" onclick="toggleShortcutHelp(true)" title="ปุ่มลัดคีย์บอร์ด (?)">⌨️</button>
        <button class="icon-btn" onclick="toggleTheme()" title="สลับธีมสว่าง/มืด">🌓</button>
        <a class="icon-btn icon-btn-wrap" href="/notifications" title="การแจ้งเตือน">
          🔔
          ${user.unreadCount ? `<span class="notif-dot">${user.unreadCount > 9 ? '9+' : user.unreadCount}</span>` : ''}
        </a>
        <a href="/profile" class="avatar" title="${esc(user.first_name)} ${esc(user.last_name)}">${esc(initials)}</a>
      </div>
    </header>
    <main class="content">
      ${flash ? `<div class="alert alert-${flash.type}">${esc(flash.message)}</div>` : ''}
      ${content}
    </main>
  </div>

  <nav class="bottom-nav">
    <a href="/" class="${currentPath === '/' ? 'active' : ''}"><span class="icon">🏠</span>หน้าแรก</a>
    <a href="/documents?direction=incoming" class="${currentPath.startsWith('/documents') ? 'active' : ''}"><span class="icon">📄</span>เอกสาร</a>
    <a href="/tasks" class="${currentPath.startsWith('/tasks') ? 'active' : ''}"><span class="icon">📌</span>งานของฉัน</a>
    <a href="/notifications" class="${currentPath.startsWith('/notifications') ? 'active' : ''}"><span class="icon">🔔</span>แจ้งเตือน</a>
    <a href="/profile" class="${currentPath.startsWith('/profile') ? 'active' : ''}"><span class="icon">👤</span>โปรไฟล์</a>
  </nav>
</div>`;
}

// ถอด browser/OS แบบคร่าวๆ จาก User-Agent string ด้วย regex ล้วน (ไม่ใช้ library แยก) — พอสำหรับ
// แสดงในหน้าประวัติการเข้าใช้งาน ไม่ได้ต้องแม่นยำระดับ device fingerprinting
export function parseUserAgent(ua) {
  if (!ua) return 'ไม่ทราบอุปกรณ์';
  let browser = 'เบราว์เซอร์ไม่ทราบชนิด';
  if (/OPR\//.test(ua)) browser = 'Opera';
  else if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  let os = '';
  if (/iPhone|iPad/.test(ua)) os = 'iOS';
  else if (/Android/.test(ua)) os = 'Android';
  else if (/Windows/.test(ua)) os = 'Windows';
  else if (/Mac OS X/.test(ua)) os = 'macOS';
  else if (/Linux/.test(ua)) os = 'Linux';

  return os ? `${browser} บน ${os}` : browser;
}

export function emptyState(emoji, text) {
  return `<div class="empty-state"><div class="emoji">${emoji}</div><p>${esc(text)}</p></div>`;
}

// ภาพประกอบวาดเองด้วย SVG ล้วน (ไม่มี tool gen ภาพให้ใช้ในสภาพแวดล้อมนี้ และ sandbox บล็อกการโหลด
// asset จากภายนอกทั้งหมดด้วย — SVG แบบฝังในหน้าเว็บเลยเหมาะที่สุด: ไม่มี network request, ไฟล์เล็ก,
// ปรับสีตามธีมสว่าง/มืดได้ทันทีผ่าน currentColor/CSS variable) ใช้แทน emoji ในจุดที่เจอบ่อยที่สุด
const ILLUSTRATIONS = {
  // "งานหมดแล้ว" — ปึกกระดาษเรียบร้อยพร้อมเครื่องหมายถูกใหญ่ๆ
  allClear: `<svg viewBox="0 0 200 150" width="150" height="112" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="100" cy="132" rx="70" ry="10" fill="var(--surface-2)"/>
    <rect x="48" y="70" width="90" height="58" rx="8" fill="var(--info-bg)" stroke="var(--primary)" stroke-width="2"/>
    <rect x="60" y="52" width="90" height="58" rx="8" fill="var(--surface)" stroke="var(--primary)" stroke-width="2"/>
    <line x1="74" y1="68" x2="126" y2="68" stroke="var(--border)" stroke-width="3" stroke-linecap="round"/>
    <line x1="74" y1="80" x2="126" y2="80" stroke="var(--border)" stroke-width="3" stroke-linecap="round"/>
    <line x1="74" y1="92" x2="110" y2="92" stroke="var(--border)" stroke-width="3" stroke-linecap="round"/>
    <circle cx="148" cy="46" r="26" fill="var(--success)"/>
    <path d="M137 46 L145 54 L161 36" stroke="white" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </svg>`,
  // "ยังไม่มีเอกสาร" — กล่อง/แฟ้มเปล่าเป็นมิตร รอเอกสารแรก
  emptyInbox: `<svg viewBox="0 0 200 150" width="150" height="112" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <ellipse cx="100" cy="132" rx="65" ry="9" fill="var(--surface-2)"/>
    <path d="M45 60 L70 92 H130 L155 60" fill="var(--info-bg)" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M45 60 L60 40 H140 L155 60 H45Z" fill="var(--surface)" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round"/>
    <path d="M45 60 H155 V100 A8 8 0 0 1 147 108 H53 A8 8 0 0 1 45 100 Z" fill="var(--surface)" stroke="var(--primary)" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="150" cy="38" r="4" fill="var(--warning)"/>
    <circle cx="160" cy="55" r="3" fill="var(--secret)"/>
    <circle cx="42" cy="45" r="3" fill="var(--success)"/>
  </svg>`,
  // หน้าล็อกอิน — เอกสาร/ใบรับรองลอยอยู่พร้อมจุดสีสันประดับ ให้ความรู้สึกต้อนรับ ไม่เป็นทางการจนเกินไป
  loginWelcome: `<svg viewBox="0 0 220 220" width="200" height="200" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <circle cx="110" cy="110" r="95" fill="rgba(255,255,255,0.12)"/>
    <circle cx="150" cy="60" r="14" fill="#ffd166"/>
    <circle cx="55" cy="150" r="10" fill="#06d6a0"/>
    <rect x="55" y="70" width="90" height="110" rx="10" fill="#ffffff" opacity="0.95" transform="rotate(-6 100 125)"/>
    <rect x="70" y="60" width="90" height="110" rx="10" fill="#ffffff" transform="rotate(4 115 115)"/>
    <g transform="rotate(4 115 115)">
      <circle cx="95" cy="85" r="10" fill="#e8effd"/>
      <path d="M89 85 L94 90 L102 78" stroke="#2059c9" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
      <line x1="115" y1="82" x2="150" y2="82" stroke="#dde3ea" stroke-width="4" stroke-linecap="round"/>
      <line x1="80" y1="105" x2="150" y2="105" stroke="#dde3ea" stroke-width="4" stroke-linecap="round"/>
      <line x1="80" y1="120" x2="150" y2="120" stroke="#dde3ea" stroke-width="4" stroke-linecap="round"/>
      <line x1="80" y1="135" x2="130" y2="135" stroke="#dde3ea" stroke-width="4" stroke-linecap="round"/>
    </g>
    <circle cx="165" cy="150" r="6" fill="#ef476f"/>
  </svg>`,
};
export function illustratedEmptyState(name, text) {
  return `<div class="empty-state">${ILLUSTRATIONS[name] || ''}<p>${esc(text)}</p></div>`;
}
export function illustration(name) {
  return ILLUSTRATIONS[name] || '';
}

// คั่นหลักพันของตัวเลข — เขียนเองแทน toLocaleString เพราะเทสต์กวาดหา toLocale* ที่ไม่ระบุ timeZone
// (กันพลาดเรื่องโซนเวลาของวันที่) การยกเว้นเป็นรายบรรทัดจะทำให้ตัวกวาดนั้นอ่อนลงโดยไม่จำเป็น
export function fmtCount(n) {
  return String(Math.trunc(Number(n) || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
