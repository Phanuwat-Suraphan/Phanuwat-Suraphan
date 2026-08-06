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
    if (btn) window.setBtnLoading(btn, opts.submitLabel ? 'กำลัง' + opts.submitLabel + '...' : 'กำลังบันทึก...');
    try {
      const formData = new FormData(formEl);
      const payload = {};
      for (const [k, v] of formData.entries()) payload[k] = v;

      if (fileInput && fileInput.files[0]) {
        if (fileInput.files[0].size > 10 * 1024 * 1024) {
          alert('ไฟล์ต้องมีขนาดไม่เกิน 10MB');
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
      alert(err.message || 'เกิดข้อผิดพลาด');
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
    if (!fileInput.files[0]) { alert('กรุณาเลือกไฟล์ PDF ก่อน'); return; }
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

      let filled = [];
      if (data.title && formEl.title && !formEl.title.value) { formEl.title.value = data.title; filled.push('ชื่อเรื่อง'); }
      if (data.correspondentName && formEl.correspondentName && !formEl.correspondentName.value) { formEl.correspondentName.value = data.correspondentName; filled.push('หน่วยงานต้นทาง/ปลายทาง'); }
      if (data.externalDocNumber && formEl.externalDocNumber && !formEl.externalDocNumber.value) { formEl.externalDocNumber.value = data.externalDocNumber; filled.push('เลขหนังสือ'); }
      if (data.externalDocDate && formEl.externalDocDate && !formEl.externalDocDate.value) { formEl.externalDocDate.value = data.externalDocDate; filled.push('ลงวันที่'); }

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
    if (!/^\d{6}$/.test(val)) { alert('กรุณากรอก PIN 6 หลัก'); return; }
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
      alert(err.message || 'เกิดข้อผิดพลาด');
      window.restoreBtn(btn);
    }
  };

  // simple POST action (no pin) used for reject/return with reason prompt
  window.actionWithReason = async function (btn, endpoint, promptText) {
    const reason = prompt(promptText || 'ระบุเหตุผล');
    if (reason === null) return;
    window.setBtnLoading(btn, 'กำลังบันทึก...');
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

  // ---------- keyboard shortcuts (UI/UX Bible §28) ----------
  // Ctrl/Cmd+K -> focus search. Ctrl/Cmd+N -> new document (note: some browsers reserve
  // Ctrl+N for "new window" and never deliver the keydown event to the page at all — no
  // workaround exists for that case, it's a browser-level reservation, not a bug here).
  document.addEventListener('keydown', function (e) {
    const mod = e.ctrlKey || e.metaKey;
    if (!mod) return;
    if (e.key === 'k' || e.key === 'K') {
      const input = document.getElementById('globalSearchInput');
      if (input) { e.preventDefault(); input.focus(); input.select(); }
    } else if (e.key === 'n' || e.key === 'N') {
      e.preventDefault();
      window.location.href = '/documents/new?direction=incoming';
    }
  });
})();
