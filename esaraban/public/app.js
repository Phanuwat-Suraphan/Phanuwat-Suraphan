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
    if (btn) { btn.disabled = true; btn.textContent = 'กำลังบันทึก...'; }
    try {
      const formData = new FormData(formEl);
      const payload = {};
      for (const [k, v] of formData.entries()) payload[k] = v;

      if (fileInput && fileInput.files[0]) {
        if (fileInput.files[0].size > 10 * 1024 * 1024) {
          alert('ไฟล์ต้องมีขนาดไม่เกิน 10MB');
          if (btn) { btn.disabled = false; btn.textContent = opts.submitLabel || 'บันทึก'; }
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
      alert(err.message || 'เกิดข้อผิดพลาด');
      if (btn) { btn.disabled = false; btn.textContent = opts.submitLabel || 'บันทึก'; }
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
    if (!/^\d{6}$/.test(val)) { alert('กรุณากรอก PIN 6 หลัก'); return; }
    document.getElementById('pinModal').classList.remove('show');
    if (pinResolver) { pinResolver(val); pinResolver = null; }
  };

  // action buttons that require PIN before POST
  window.actionWithPin = async function (btn, endpoint, extra) {
    const title = btn.dataset.pinTitle || 'ยืนยันตัวตนด้วย PIN';
    const pin = await window.askPin(title);
    if (!pin) return;
    btn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ pin }, extra || {})),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
      window.location.reload();
    } catch (err) {
      alert(err.message || 'เกิดข้อผิดพลาด');
      btn.disabled = false;
    }
  };

  // simple POST action (no pin) used for reject/return with reason prompt
  window.actionWithReason = async function (btn, endpoint, promptText) {
    const reason = prompt(promptText || 'ระบุเหตุผล');
    if (reason === null) return;
    btn.disabled = true;
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
      window.location.reload();
    } catch (err) {
      alert(err.message || 'เกิดข้อผิดพลาด');
      btn.disabled = false;
    }
  };
})();
