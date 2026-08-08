// Vanilla JS only — no framework/bundler available in this environment.
(function () {
  const root = document.documentElement;

  // ---------- theme ----------
  const THEME_KEY = 'esaraban_theme';
  function applyTheme(t) {
    if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
    else root.removeAttribute('data-theme');
  }
  applyTheme(localStorage.getItem(THEME_KEY));
  window.toggleTheme = function () {
    const current = root.getAttribute('data-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = current === 'dark' ? 'light' : 'dark';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
  };

  // ---------- toast notifications (replaces jarring alert() popups) ----------
  window.toast = function (message, type) {
    type = type || 'info'; // 'success' | 'danger' | 'warning' | 'info'
    let container = document.getElementById('toastContainer');
    if (!container) {
      container = document.createElement('div');
      container.id = 'toastContainer';
      container.className = 'toast-container';
      document.body.appendChild(container);
    }
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.setAttribute('role', type === 'danger' ? 'alert' : 'status');
    el.textContent = message;
    container.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('show'); });
    const life = type === 'danger' ? 5000 : 3000;
    setTimeout(function () {
      el.classList.remove('show');
      setTimeout(function () { el.remove(); }, 250);
    }, life);
  };

  // ---------- mobile sidebar ----------
  window.toggleSidebar = function (show) {
    const sb = document.getElementById('sidebar');
    const bd = document.getElementById('sidebarBackdrop');
    if (!sb) return;
    sb.classList.toggle('open', show);
    if (bd) bd.classList.toggle('show', show);
  };

  // ---------- generic confirm-submit ----------
  document.addEventListener('submit', function (e) {
    const form = e.target;
    if (form.dataset.confirm && !confirm(form.dataset.confirm)) {
      e.preventDefault();
    }
  });

  // ---------- file -> base64 for upload (no multipart parser server-side) ----------
  window.attachFilePreview = function (input, previewId) {
    const preview = document.getElementById(previewId);
    if (preview) preview.textContent = input.files[0] ? input.files[0].name + ' (' + Math.round(input.files[0].size / 1024) + ' KB)' : '';
  };

  window.submitWithFile = async function (formEl, fileInputId, endpoint, opts) {
    opts = opts || {};
    const fileInput = document.getElementById(fileInputId);
    const btn = formEl.querySelector('[type=submit]');
    if (btn) window.setBtnLoading(btn, opts.submitLabel ? 'กำลัง' + opts.submitLabel + '...' : 'กำลังบันทึก...');
    try {
      const formData = new FormData(formEl);
      const payload = {};
      for (const [k, v] of formData.entries()) payload[k] = v;

      if (fileInput && fileInput.files[0]) {
        if (fileInput.files[0].size > 10 * 1024 * 1024) {
          window.toast('ไฟล์ต้องมีขนาดไม่เกิน 10MB', 'warning');
          if (btn) window.restoreBtn(btn);
          return;
        }
        payload.fileName = fileInput.files[0].name;
        payload.fileType = fileInput.files[0].type || 'application/octet-stream';
        payload.fileDataBase64 = await fileToBase64(fileInput.files[0]);
      }

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
      window.location.href = data.redirect || window.location.href;
    } catch (err) {
      window.toast(err.message || 'เกิดข้อผิดพลาด', 'danger');
      if (btn) window.restoreBtn(btn);
    }
  };

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }
  window.fileToBase64 = fileToBase64;

  // keeps the "data:image/png;base64,..." prefix — used where the value is stored/rendered as-is (signature image)
  window.fileToDataUrl = function (file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  };

  // ---------- OCR auto-fill (Tesseract, ต้องติดตั้งบนเซิร์ฟเวอร์ — ดู DEPLOY.md) ----------
  window.ocrExtractInto = async function (btn, fileInputId, resultId, formEl) {
    const fileInput = document.getElementById(fileInputId);
    const resultBox = document.getElementById(resultId);
    if (!fileInput.files[0]) { window.toast('กรุณาเลือกไฟล์ PDF ก่อน', 'warning'); return; }
    if (fileInput.files[0].size > 20 * 1024 * 1024) {
      window.toast('ไฟล์ใหญ่เกิน 20MB สำหรับอ่านอัตโนมัติ — OCR อ่านแค่ 2 หน้าแรกเท่านั้น ลองครอปเฉพาะหน้าแรกมาลองใหม่ได้', 'warning');
      return;
    }
    const origLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ กำลังอ่านเอกสาร (อาจใช้เวลาสักครู่)...';
    resultBox.innerHTML = '';
    try {
      const payload = {
        fileType: fileInput.files[0].type || 'application/octet-stream',
        fileDataBase64: await fileToBase64(fileInput.files[0]),
      };
      const res = await fetch('/documents/ocr-extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'อ่านเอกสารไม่สำเร็จ');

      // เติมค่าแล้วเปิด <details> "ตัวเลือกเพิ่มเติม" ให้อัตโนมัติถ้าช่องที่เติมซ่อนอยู่ในนั้น —
      // ไม่งั้นผู้ใช้จะไม่เห็นว่า OCR เติมอะไรให้บ้าง (เลขหนังสือ/ลงวันที่ ถูกย้ายไปซ่อนไว้เพื่อลดความรก)
      let filled = [];
      function fillField(field, value, label) {
        if (!value || !field || field.value) return;
        field.value = value;
        filled.push(label);
        const details = field.closest('details');
        if (details) details.open = true;
      }
      fillField(formEl.title, data.title, 'ชื่อเรื่อง');
      fillField(formEl.correspondentName, data.correspondentName, 'หน่วยงานต้นทาง/ปลายทาง');
      fillField(formEl.externalDocNumber, data.externalDocNumber, 'เลขหนังสือ');
      fillField(formEl.externalDocDate, data.externalDocDate, 'ลงวันที่');

      resultBox.innerHTML =
        '<div class="alert alert-warning" style="margin-top:.5rem">' +
        (filled.length ? '✅ กรอกอัตโนมัติแล้ว: ' + filled.join(', ') + ' — ' : '⚠️ ไม่พบข้อมูลที่จับรูปแบบได้ — ') +
        'กรุณาตรวจสอบความถูกต้องทุกช่องก่อนบันทึก (OCR อาจอ่านผิดพลาดได้)' +
        (data.externalDocDateRaw && !data.externalDocDate ? '<br/>พบข้อความวันที่ "' + data.externalDocDateRaw + '" แต่แปลงเป็นวันที่อัตโนมัติไม่ได้ กรุณากรอกเอง' : '') +
        (data.rawText ? '<details style="margin-top:.5rem"><summary style="cursor:pointer">ข้อความทั้งหมดที่ OCR อ่านได้ (คลิกเพื่อดู/คัดลอก)</summary><pre style="white-space:pre-wrap;font-size:.78rem;max-height:220px;overflow:auto">' + data.rawText.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</pre></details>' : '') +
        '</div>';
    } catch (err) {
      resultBox.innerHTML = '<div class="alert alert-danger" style="margin-top:.5rem">' + (err.message || 'เกิดข้อผิดพลาด') + '</div>';
    } finally {
      btn.disabled = false;
      btn.textContent = origLabel;
    }
  };

  // ---------- PIN confirm modal ----------
  let pinResolver = null;
  window.askPin = function (title) {
    return new Promise((resolve) => {
      pinResolver = resolve;
      document.getElementById('pinModalTitle').textContent = title || 'ยืนยันตัวตนด้วย PIN';
      document.getElementById('pinInput').value = '';
      document.getElementById('pinModal').classList.add('show');
      document.getElementById('pinInput').focus();
    });
  };
  window.closePinModal = function (submitted) {
    document.getElementById('pinModal').classList.remove('show');
    if (!submitted && pinResolver) { pinResolver(null); pinResolver = null; }
  };
  window.confirmPin = function () {
    const val = document.getElementById('pinInput').value.trim();
    if (!/^\d{6}$/.test(val)) { window.toast('กรุณากรอก PIN 6 หลัก', 'warning'); return; }
    document.getElementById('pinModal').classList.remove('show');
    if (pinResolver) { pinResolver(val); pinResolver = null; }
  };

  // action buttons that require PIN before POST — pass redirectTo to land somewhere other
  // than a plain reload (e.g. acknowledge sends users back to the dashboard so the
  // "all caught up" confetti in dashboard.js has a place to fire from)
  window.actionWithPin = async function (btn, endpoint, extra, redirectTo) {
    const title = btn.dataset.pinTitle || 'ยืนยันตัวตนด้วย PIN';
    const pin = await window.askPin(title);
    if (!pin) return;
    window.setBtnLoading(btn, 'กำลังบันทึก...');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ pin }, extra || {})),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
      if (redirectTo) window.location.href = redirectTo;
      else window.location.reload();
    } catch (err) {
      window.toast(err.message || 'เกิดข้อผิดพลาด', 'danger');
      window.restoreBtn(btn);
    }
  };

  // simple POST action (no pin) used for reject/return with reason prompt
  window.actionWithReason = async function (btn, endpoint, promptText, extra) {
    const reason = prompt(promptText || 'ระบุเหตุผล');
    if (reason === null) return;
    window.setBtnLoading(btn, 'กำลังบันทึก...');
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ reason }, extra || {})),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
      window.location.reload();
    } catch (err) {
      window.toast(err.message || 'เกิดข้อผิดพลาด', 'danger');
      window.restoreBtn(btn);
    }
  };

  // ---------- button loading state with a little 📚 flourish (UX Bible Part 21 §13) ----------
  window.setBtnLoading = function (btn, text) {
    if (!btn) return;
    if (btn.dataset.origHtml === undefined) btn.dataset.origHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = '<span class="loading-book" aria-hidden="true">📚</span> ' + (text || 'กำลังบันทึก...');
  };
  window.restoreBtn = function (btn) {
    if (!btn) return;
    btn.disabled = false;
    if (btn.dataset.origHtml !== undefined) btn.innerHTML = btn.dataset.origHtml;
  };

  // ---------- confetti when every task is cleared (UX Bible Part 21 §11) ----------
  // triggered by a hidden marker element the server renders only when the user just
  // acknowledged their last pending item — never replays on a plain revisit with 0 tasks
  window.fireConfetti = function () {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const colors = ['#2059c9', '#17875a', '#b4720a', '#c62b3a', '#6b2fb3'];
    const layer = document.createElement('div');
    layer.className = 'confetti-layer';
    for (let i = 0; i < 40; i++) {
      const piece = document.createElement('span');
      piece.className = 'confetti-piece';
      piece.style.left = Math.random() * 100 + 'vw';
      piece.style.background = colors[i % colors.length];
      piece.style.animationDelay = (Math.random() * 0.3) + 's';
      piece.style.transform = 'rotate(' + Math.floor(Math.random() * 360) + 'deg)';
      layer.appendChild(piece);
    }
    document.body.appendChild(layer);
    setTimeout(function () { layer.remove(); }, 1400);
  };
  if (document.getElementById('celebrateTrigger')) window.fireConfetti();

  // ---------- keyboard shortcut help (discoverable via "?" or the topbar button — the
  // shortcuts themselves existed before but had no way for a user to find out about them) ----------
  const SHORTCUTS = [
    ['Ctrl/Cmd + K', 'ค้นหาเอกสาร'],
    ['Ctrl/Cmd + N', 'รับหนังสือใหม่'],
    ['?', 'แสดงปุ่มลัดนี้'],
    ['Esc', 'ปิดหน้าต่างนี้'],
  ];
  window.toggleShortcutHelp = function (show) {
    let modal = document.getElementById('shortcutModal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'shortcutModal';
      modal.className = 'modal-backdrop';
      modal.innerHTML = '<div class="modal">' +
        '<h3>⌨️ ปุ่มลัดคีย์บอร์ด</h3>' +
        '<table>' + SHORTCUTS.map(function (s) {
          return '<tr><td><kbd>' + s[0] + '</kbd></td><td class="text-muted">' + s[1] + '</td></tr>';
        }).join('') + '</table>' +
        '<button class="btn btn-outline btn-block" style="margin-top:1rem" onclick="toggleShortcutHelp(false)">ปิด</button>' +
        '</div>';
      modal.addEventListener('click', function (e) { if (e.target === modal) window.toggleShortcutHelp(false); });
      document.body.appendChild(modal);
    }
    modal.classList.toggle('show', show);
  };

  // ---------- keyboard shortcuts (UI/UX Bible §28) ----------
  // Ctrl/Cmd+K -> focus search. Ctrl/Cmd+N -> new document (note: some browsers reserve
  // Ctrl+N for "new window" and never deliver the keydown event to the page at all — no
  // workaround exists for that case, it's a browser-level reservation, not a bug here).
  document.addEventListener('keydown', function (e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod) {
      if (e.key === 'k' || e.key === 'K') {
        const input = document.getElementById('globalSearchInput');
        if (input) { e.preventDefault(); input.focus(); input.select(); }
      } else if (e.key === 'n' || e.key === 'N') {
        e.preventDefault();
        window.location.href = '/documents/new?direction=incoming';
      }
      return;
    }
    if (e.key === '?') {
      const tag = (e.target.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
      e.preventDefault();
      window.toggleShortcutHelp(true);
    } else if (e.key === 'Escape') {
      window.toggleShortcutHelp(false);
    }
  });
})();
