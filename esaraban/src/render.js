export function esc(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function fmtDate(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short' });
}

// รูปแบบ "วัน เดือน ปี" ตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ พ.ศ. 2526 ภาคผนวก 2 —
// "ให้ลงตัวเลขของวันที่ ชื่อเต็มของเดือน และตัวเลขของปีพุทธศักราชที่ออกหนังสือ" (เลขวันที่ + ชื่อเดือนเต็ม
// + ปี พ.ศ. ไม่ย่อเดือน ไม่มีเวลา) ใช้เฉพาะบล็อกลงนามที่ต้องเป็นทางการ ส่วนอื่นยังใช้ fmtDate ตามเดิม
export function fmtThaiDateLong(iso) {
  if (!iso) return '-';
  const d = new Date(iso);
  return d.toLocaleString('th-TH', { day: 'numeric', month: 'long', year: 'numeric' });
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
<script>
  (function(){ var t = localStorage.getItem('esaraban_theme'); if (t==='light'||t==='dark') document.documentElement.setAttribute('data-theme', t); })();
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
      <div>ระบบสารบรรณ<br/><span class="text-muted" style="font-weight:400;font-size:.72rem">ร.ร.เจ้าพ่อหลวงอุปถัมภ์ 1</span></div>
    </div>
    ${navItem('/', '🏠', 'แดชบอร์ด', currentPath)}
    ${navItem('/documents?direction=incoming', '📥', 'หนังสือเข้า', currentPath)}
    ${navItem('/documents?direction=outgoing', '📤', 'หนังสือออก', currentPath)}
    ${navItem('/tasks', '📌', 'งานของฉัน', currentPath)}
    ${navItem('/notifications', '🔔', 'การแจ้งเตือน', currentPath)}
    ${navItem('/leave', '🗓️', 'ลา/ไปราชการ', currentPath)}
    ${navItem('/reports', '📊', 'รายงาน', currentPath)}
    ${user.roleCodes.some((r) => ['admin', 'registrar', 'director', 'vice_director'].includes(r)) ? navItem('/retention', '🗄️', 'อายุการเก็บ/ทำลายหนังสือ', currentPath) : ''}
    <div class="nav-section-label">ระบบ</div>
    ${user.roleCodes.includes('admin') ? navItem('/admin/users', '⚙️', 'จัดการผู้ใช้', currentPath) : ''}
    ${user.roleCodes.includes('admin') ? navItem('/admin/audit', '🧾', 'Audit Log', currentPath) : ''}
    ${user.roleCodes.includes('admin') ? navItem('/admin/google-drive', '🗂️', 'เชื่อมต่อ Google Drive', currentPath) : ''}
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

export function emptyState(emoji, text) {
  return `<div class="empty-state"><div class="emoji">${emoji}</div><p>${esc(text)}</p></div>`;
}
