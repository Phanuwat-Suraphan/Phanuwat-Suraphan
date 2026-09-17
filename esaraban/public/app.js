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

  window.MAX_ATTACH_FILES = 8;
  const MAX_ATTACH_BYTES = 10 * 1024 * 1024;

  function fileSizeText(bytes) {
    return bytes >= 1024 * 1024 ? (bytes / 1024 / 1024).toFixed(1) + ' MB' : Math.round(bytes / 1024) + ' KB';
  }

  /**
   * ช่องแนบไฟล์แบบเลือกได้หลายไฟล์พร้อมกัน (สูงสุด window.MAX_ATTACH_FILES ไฟล์)
   *
   * ทำไมต้องมีรายการให้เห็น ไม่ใช่แค่ใส่ multiple ไว้เฉยๆ: ช่อง input แบบ multiple ของเบราว์เซอร์
   * แสดงแค่ "เลือกไฟล์ 6 ไฟล์" ลอยๆ ผู้ใช้จึงไม่มีทางรู้ว่าเลือกไฟล์ไหนไปบ้าง เลือกซ้ำหรือเปล่า
   * และเอาไฟล์ที่หยิบผิดออกทีละไฟล์ไม่ได้เลย (ต้องเลือกใหม่ทั้งชุด) ซึ่งเจ็บมากตอนหนังสือมีสิ่งที่
   * ส่งมาด้วยหลายฉบับและต้องไล่หาในโฟลเดอร์สแกนทีละไฟล์
   *
   * และทำไมต้องเลื่อนลำดับได้: ไฟล์แรกคือ "ไฟล์หลัก" ซึ่งเป็นไฟล์ที่ตราประทับรับและความเห็น ผอ. จะ
   * ไปลงจริง (ดู applyStampToFirstAttachment ใน routes/documents.js) ถ้าเลือกไฟล์มาแล้วเรียงผิด
   * ตราจะไปลงบนใบแนบแทนที่จะเป็นตัวหนังสือ โดยไม่มีอะไรเตือน — เบราว์เซอร์เรียงไฟล์ตามที่ระบบไฟล์
   * ส่งมา ไม่ใช่ตามที่ผู้ใช้กดเลือก จึงต้องให้ย้ายได้เอง
   *
   * เก็บผลไว้ใน input.files ตามเดิม (เขียนกลับผ่าน DataTransfer) เพื่อให้โค้ดที่อ่าน input.files
   * อยู่แล้วใช้ต่อได้โดยไม่ต้องรู้ว่ามีตัวช่วยนี้อยู่
   */
  window.attachMultiPreview = function (input, previewId, opts) {
    opts = opts || {};
    const max = opts.max || window.MAX_ATTACH_FILES;
    const preview = document.getElementById(previewId);
    if (!preview) return;

    // kept ต้องถูกอัปเดตที่นี่ที่เดียวเสมอ — ตอน change เบราว์เซอร์เขียนทับ input.files ไปแล้ว จึงอ่าน
    // "ของเดิม" จาก input.files ไม่ได้ ต้องจำไว้เอง และถ้าปุ่ม ✕/▲ ไปแก้ input.files โดยไม่แตะ kept
    // ไฟล์ที่เพิ่งกดเอาออกจะกลับมาเองตอนเลือกไฟล์รอบถัดไป
    let kept = [];
    function setFiles(list) {
      kept = list.slice();
      const dt = new DataTransfer();
      kept.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      render();
    }

    function render() {
      const files = Array.prototype.slice.call(input.files);
      preview.innerHTML = '';
      if (!files.length) return;

      const ol = document.createElement('ol');
      ol.className = 'file-pick-list';
      files.forEach(function (f, i) {
        const li = document.createElement('li');

        const name = document.createElement('span');
        name.className = 'file-pick-name';
        name.textContent = f.name + ' (' + fileSizeText(f.size) + ')';
        li.appendChild(name);

        if (i === 0 && opts.mainBadge !== false) {
          const badge = document.createElement('span');
          badge.className = 'badge badge-info';
          badge.textContent = 'ไฟล์หลัก';
          badge.title = 'ตราประทับรับและความเห็นของผู้อำนวยการจะไปลงบนไฟล์นี้';
          li.appendChild(badge);
        }

        if (i > 0) {
          const up = document.createElement('button');
          up.type = 'button';
          up.className = 'btn btn-outline btn-sm';
          up.textContent = '▲';
          up.title = 'เลื่อนขึ้น' + (i === 1 && opts.mainBadge !== false ? ' (ทำให้เป็นไฟล์หลัก)' : '');
          up.setAttribute('aria-label', 'เลื่อนไฟล์ ' + f.name + ' ขึ้นหนึ่งลำดับ');
          up.onclick = function () {
            const next = files.slice();
            next[i - 1] = files[i];
            next[i] = files[i - 1];
            setFiles(next);
          };
          li.appendChild(up);
        }

        const rm = document.createElement('button');
        rm.type = 'button';
        rm.className = 'btn btn-outline btn-sm';
        rm.textContent = '✕';
        rm.title = 'เอาไฟล์นี้ออก';
        rm.setAttribute('aria-label', 'เอาไฟล์ ' + f.name + ' ออกจากรายการ');
        rm.onclick = function () { setFiles(files.filter((_, j) => j !== i)); };
        li.appendChild(rm);

        ol.appendChild(li);
      });
      preview.appendChild(ol);

      const note = document.createElement('div');
      note.className = 'help-text';
      note.textContent = 'เลือกไว้ ' + files.length + ' ไฟล์ จากสูงสุด ' + max + ' ไฟล์'
        + (files.length > 1 && opts.mainBadge !== false ? ' · ไฟล์ลำดับที่ 1 คือไฟล์ที่ตราประทับจะไปลง กด ▲ เพื่อเปลี่ยนได้' : '');
      preview.appendChild(note);
    }

    // เลือกรอบใหม่ให้ "เพิ่มเข้าไป" ไม่ใช่แทนที่ของเดิม — ไฟล์สแกนมักกระจายอยู่หลายโฟลเดอร์ ถ้าเลือก
    // รอบที่สองแล้วรอบแรกหายไปเงียบๆ ผู้ใช้จะกดบันทึกโดยเชื่อว่าแนบครบแล้ว (ตัวกันไฟล์ซ้ำอยู่ที่
    // ชื่อ+ขนาด เพราะ File object คนละตัวกันเทียบด้วย === ไม่ได้)
    function absorb(incoming) {
      const merged = kept.slice();
      const rejected = { big: [], dup: [] };
      incoming.forEach(function (f) {
        if (f.size > MAX_ATTACH_BYTES) { rejected.big.push(f.name); return; }
        if (merged.some((k) => k.name === f.name && k.size === f.size)) { rejected.dup.push(f.name); return; }
        merged.push(f);
      });
      const overflow = merged.length > max ? merged.length - max : 0;
      const final = merged.slice(0, max);

      if (rejected.big.length) window.toast('ไฟล์ใหญ่เกิน 10MB จึงไม่ได้แนบ: ' + rejected.big.join(', '), 'warning');
      if (rejected.dup.length) window.toast('ไฟล์นี้เลือกไว้แล้ว: ' + rejected.dup.join(', '), 'info');
      if (overflow) window.toast('แนบได้สูงสุด ' + max + ' ไฟล์ต่อครั้ง — อีก ' + overflow + ' ไฟล์ยังไม่ได้แนบ แนบเพิ่มได้อีกหลังบันทึกเอกสารแล้ว', 'warning');

      setFiles(final);
    }

    input.addEventListener('change', function () { absorb(Array.prototype.slice.call(input.files)); });

    render();
    // add() มีไว้ให้โค้ดที่ได้ไฟล์มาจากทางอื่น (เช่นไฟล์ที่แชร์มาจากแอปไลน์) ใส่เข้ารายการนี้ได้โดย
    // ไม่ต้องไปเขียน input.files เอง ซึ่งจะทำให้ kept ไม่ตรงกับที่แสดงอยู่
    return {
      files: () => Array.prototype.slice.call(input.files),
      add: (list) => absorb(Array.prototype.slice.call(list)),
      clear: () => setFiles([]),
    };
  };

  /**
   * ส่ง JSON ไปที่เซิร์ฟเวอร์ — จัดการกรณี "ต้องถามยืนยันแล้วส่งใหม่" ให้ที่เดียว
   *
   * บางอย่างระบบกันไว้ก่อนเพราะไม่แน่ใจว่าผู้ใช้ตั้งใจหรือกดพลาด (เช่นเพิ่งลงทะเบียนเรื่องชื่อเดียวกัน
   * ไปเมื่อครู่ หรือเพิ่งกดประชาสัมพันธ์ไปแล้ว) เซิร์ฟเวอร์จะตอบ 409 พร้อม confirmRetry มาให้
   * — กันไว้ก่อนแต่ห้ามกันตาย เพราะบางทีก็เป็นคนละเรื่องกันจริงๆ (ดู services/validate.js)
   *
   * คืน null ถ้าผู้ใช้กดยกเลิกตอนถามยืนยัน / โยน Error ถ้าเซิร์ฟเวอร์ปฏิเสธจริง
   */
  window.postJson = async function (endpoint, payload) {
    const send = (body) => fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    }).then(async (r) => ({ ok: r.ok, data: await r.json().catch(() => ({})) }));

    let { ok, data } = await send(payload);
    if (!ok && data.confirmRetry && data.confirmRetry.field) {
      if (!confirm(data.confirmRetry.message)) return null;
      ({ ok, data } = await send(Object.assign({}, payload, { [data.confirmRetry.field]: true })));
    }
    if (!ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');
    return data;
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

      const data = await window.postJson(endpoint, payload);
      if (data === null) { if (btn) window.restoreBtn(btn); return; } // ผู้ใช้กดยกเลิกตอนถามยืนยัน
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
      if (!redirectTo && !data.warning) { window.location.reload(); return; }
      window.location.href = appendWarn(redirectTo || (window.location.pathname + window.location.search), data.warning);
    } catch (err) {
      window.toast(err.message || 'เกิดข้อผิดพลาด', 'danger');
      window.restoreBtn(btn);
    }
  };

  // ต่อ ?warn=... (หรือ &warn=... ถ้ามี query อยู่แล้ว) ต่อท้าย URL ปลายทาง — ใช้แสดงคำเตือนแบบ
  // ไม่บล็อกการทำงานหลัก (เช่น อนุมัติสำเร็จแต่ประทับตราลง PDF จริงไม่สำเร็จ) หลัง reload/redirect
  function appendWarn(url, warning) {
    if (!warning) return url;
    return url + (url.includes('?') ? '&' : '?') + 'warn=' + encodeURIComponent(warning);
  }

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
      if (data.warning) window.location.href = appendWarn(window.location.pathname + window.location.search, data.warning);
      else window.location.reload();
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

  // ---------- แถวตารางที่กดแล้วเปิดรายการนั้น ----------
  //
  // เดิมทุกตารางในระบบใช้ <tr onclick="location.href='...'"> ตรงๆ ซึ่งพังสี่อย่างพร้อมกัน
  // (ยิงทดสอบด้วยเบราว์เซอร์จริงแล้วทั้งสี่ข้อ):
  //
  //   1. ลากเลือกข้อความในแถว (เช่นจะคัดลอกเลขทะเบียนไปวางในอีเมล) แล้วหน้าเด้งไปหน้าเอกสารทันที
  //      คัดลอกจากทะเบียนไม่ได้เลย และหลุดจากรายการที่กรองไว้ด้วย
  //   2. Ctrl/Cmd+คลิก ไม่เปิดแท็บใหม่ ซ้ำร้ายยังพาแท็บเดิมไปด้วย — ธุรการที่ตั้งใจเปิดหลายฉบับ
  //      พร้อมกันจึงเสียรายการที่กรองไว้ทุกครั้ง
  //   3. คลิกลูกกลิ้ง (เปิดแท็บหลัง) ไม่ทำอะไรเลย
  //   4. ใช้คีย์บอร์ดอย่างเดียวเปิดหนังสือจากทะเบียนไม่ได้เลย — วัดแล้วทะเบียน 50 แถวมีจุดที่
  //      Tab ไปถึงได้ 0 จุด และโปรแกรมอ่านหน้าจอก็ไม่มีอะไรให้ประกาศว่ากดได้
  //
  // ตอนนี้แต่ละแถวมีลิงก์จริง (<a>) อยู่ในช่องแรก ซึ่งแก้ข้อ 2-4 ให้เองตามธรรมชาติของเบราว์เซอร์
  // ส่วนการกดที่ไหนก็ได้ในแถวยังใช้ได้เหมือนเดิม แต่ย้ายมาทำที่นี่เพื่อให้เว้นสามกรณีข้างล่างได้
  document.addEventListener('click', function (e) {
    const row = e.target.closest && e.target.closest('tr[data-href]');
    if (!row) return;
    // ปล่อยให้ลิงก์/ปุ่ม/ช่องติ๊กในแถวทำงานของตัวเอง (รวมลิงก์จริงในช่องแรก ซึ่งเบราว์เซอร์
    // จัดการ Ctrl+คลิก/คลิกลูกกลิ้ง/Enter ให้ถูกต้องอยู่แล้ว)
    if (e.target.closest('a, button, input, select, textarea, label')) return;
    // ปุ่มขวา/ปุ่มกลาง หรือกดปุ่มร่วม = ผู้ใช้ตั้งใจทำอย่างอื่น ไม่ใช่ "เปิดในแท็บนี้"
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    // กำลังลากเลือกข้อความอยู่ — ห้ามเด้งหน้า
    const sel = window.getSelection && window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    window.location.href = row.getAttribute('data-href');
  });

  // ---------- keyboard shortcuts (UI/UX Bible §28) ----------
  /**
   * ผูก <label> เข้ากับช่องกรอกของมันให้อัตโนมัติ
   *
   * ทั้งระบบเขียนฟอร์มเป็น <div class="field"><label>ชื่อช่อง</label><input ...></div> ซึ่ง "ดูเหมือน"
   * ผูกกันแล้วแต่จริงๆ ไม่ได้ผูก เพราะ label ไม่มี for และไม่ได้ครอบ input ไว้ ผลคือแตะที่ตัวหนังสือ
   * ชื่อช่องแล้วไม่มีอะไรเกิดขึ้น — ซึ่งบนมือถือเป็นสิ่งที่คนทำโดยสัญชาตญาณ เพราะตัวหนังสือเป็นเป้าที่
   * ใหญ่และแม่นกว่าตัวช่องมาก (วัดด้วยเบราว์เซอร์จริงแล้วพบว่าไม่มีช่องไหนในระบบผูกไว้เลยสักช่องเดียว)
   *
   * แก้ที่นี่ที่เดียวแทนการไล่เติม for/id ใส่ฟอร์มกว่าร้อยจุด เพราะนอกจากจะพลาดง่ายแล้ว ฟอร์มที่เพิ่ม
   * เข้ามาใหม่วันหลังก็จะลืมอีก — วิธีนี้ครอบคลุมของที่มีอยู่และของใหม่ไปพร้อมกัน
   */
  (function linkLabelsToFields() {
    let seq = 0;
    document.querySelectorAll('label:not([for])').forEach(function (label) {
      // label ที่ครอบ input ไว้ในตัวเองอยู่แล้ว (เช่น ช่องติ๊ก) ผูกกันโดยปริยาย ไม่ต้องทำอะไร
      if (label.querySelector('input, select, textarea')) return;
      const box = label.closest('.field') || label.parentElement;
      if (!box) return;
      // ปุ่มไม่นับ (เช่นปุ่ม "แสดง/ซ่อน" ข้างช่องรหัสผ่าน) และช่องที่ซ่อนอยู่ก็ไม่ใช่เป้าของ label
      const control = box.querySelector('input:not([type=hidden]), select, textarea');
      if (!control || control.disabled) return;
      // ต้องเป็นช่องที่อยู่ "หลัง" label ในเอกสารเท่านั้น — กัน .field ที่มีหลาย label ไม่ให้ผูกข้ามกัน
      if (!(label.compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING)) return;
      if (!control.id) control.id = 'f_auto_' + (seq += 1);
      label.htmlFor = control.id;
    });
  })();

  /**
   * ปุ่มดู/ซ่อนรหัสผ่านทุกช่องในระบบ
   *
   * ทำที่เดียวแบบกวาดทั้งหน้า แทนการไล่เติมปุ่มทีละฟอร์ม — ช่องรหัสผ่านกระจายอยู่หลายหน้า
   * (เข้าสู่ระบบ, ตั้งรหัสครั้งแรก, เปลี่ยนรหัสในโปรไฟล์, ลงทะเบียน, ผู้ดูแลตั้งรหัสให้) ถ้าไล่เติมเอง
   * จะตกหล่นและฟอร์มที่เพิ่มมาใหม่วันหลังก็จะลืมอีก วิธีนี้ครอบคลุมทั้งของเดิมและของใหม่
   *
   * ทำไมจำเป็น: รหัสที่ตั้งใหม่ต้องยาวอย่างน้อย 8 ตัวและพิมพ์บนแป้นมือถือ ซึ่งพิมพ์ผิดง่ายมากและ
   * มองไม่เห็นเลยว่าพิมพ์อะไรไป คนจึงตั้งรหัสที่ตัวเองก็ไม่รู้ว่าคืออะไร แล้วล็อกอินกลับเข้าไม่ได้
   */
  (function passwordRevealButtons() {
    function attach(input) {
      if (input.dataset.revealReady) return;
      input.dataset.revealReady = '1';

      const wrap = document.createElement('div');
      wrap.className = 'pw-wrap';
      input.parentNode.insertBefore(wrap, input);
      wrap.appendChild(input);

      const btn = document.createElement('button');
      btn.type = 'button'; // ต้องไม่ใช่ submit ไม่งั้นกดดูรหัสแล้วฟอร์มถูกส่งทันที
      btn.className = 'pw-reveal';
      btn.tabIndex = -1; // ไม่ขวางลำดับ Tab จากช่องรหัสผ่านไปยังปุ่มส่ง
      const sync = () => {
        const shown = input.type === 'text';
        btn.textContent = shown ? '🙈' : '👁️';
        btn.title = shown ? 'ซ่อนรหัส' : 'ดูรหัสที่พิมพ์ไว้';
        btn.setAttribute('aria-label', btn.title);
        btn.setAttribute('aria-pressed', shown ? 'true' : 'false');
      };
      btn.onclick = function () {
        // เก็บตำแหน่งเคอร์เซอร์ไว้ — การสลับ type ทำให้เคอร์เซอร์เด้งไปท้ายช่องทุกครั้ง
        // ซึ่งกวนมากถ้ากำลังแก้ตัวอักษรกลางรหัสอยู่
        const pos = input.selectionStart;
        input.type = input.type === 'password' ? 'text' : 'password';
        sync();
        input.focus();
        try { input.setSelectionRange(pos, pos); } catch (_) { /* บางเบราว์เซอร์ไม่ให้ตั้งกับ type=text ทันที */ }
      };
      sync();
      wrap.appendChild(btn);
    }
    document.querySelectorAll('input[type=password]').forEach(attach);
  })();

  /**
   * ข้อความเตือนของเบราว์เซอร์เป็นภาษาไทย
   *
   * ฟอร์มที่ส่งแบบ <form method="post"> ธรรมดา (หน้าเข้าสู่ระบบ ตั้งรหัสครั้งแรก ลงทะเบียน) พึ่ง
   * required/minlength ของ HTML ซึ่งเบราว์เซอร์จะบล็อกการส่งแล้วขึ้นฟองข้อความตามภาษาของ "เครื่อง"
   * ไม่ใช่ภาษาของเว็บ เครื่องส่วนใหญ่ตั้งเป็นอังกฤษ ครูจึงเห็นแค่ "Please fill out this field."
   * โผล่แวบเดียวแล้วหายไป — ซึ่งอ่านไม่ออกและไม่ได้บอกว่าช่องไหน
   *
   * อาการที่เกิดจริงและเป็นที่มาของการแก้ตรงนี้: ครูกรอกฟอร์มลงทะเบียนครบแล้วใช้ PIN 123456
   * ระบบตีกลับมาว่า PIN เดาง่ายเกินไป ครูแก้ PIN แล้วกด "ส่งคำขอลงทะเบียน" อีกครั้ง — แต่ช่อง
   * รหัสผ่านถูกล้างไปตอนตีกลับ (ตั้งใจ ไม่ส่งรหัสผ่านกลับมาหน้าเว็บ) ครูไม่รู้ เพราะข้อความพูดถึง
   * แต่ PIN พอกดส่ง เบราว์เซอร์บล็อกที่ช่องรหัสผ่านพร้อมฟองภาษาอังกฤษ หน้าจึงไม่ไปไหนเลย
   * กดกี่ครั้งก็เหมือนปุ่มเสีย = "กดส่งแล้วส่งไม่ได้" (ยืนยันด้วยเบราว์เซอร์จริงแล้วว่าเกิดขึ้นตามนี้)
   *
   * ใช้ทั้งระบบ ไม่เฉพาะหน้าลงทะเบียน เพราะทุกฟอร์มที่มี required เจอปัญหาเดียวกันหมด
   */
  (function thaiValidationMessages() {
    function labelOf(el) {
      const lb = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
      // ตัด * และวงเล็บอธิบายออก — ป้ายช่องหลายอันเขียนว่า "รหัสผ่าน (อย่างน้อย 8 ตัวอักษร) *"
      // ซึ่งพออ่านรวมกับข้อความจะกลายเป็น "กรุณากรอกรหัสผ่าน (อย่างน้อย 8 ตัวอักษร)" ที่รุงรัง
      const text = (lb ? lb.textContent : '').replace(/\([^)]*\)/g, '').replace(/\*/g, '').trim();
      if (!text) return 'ช่องนี้';
      // ภาษาไทยเขียนติดกันไม่เว้นวรรค แต่ป้ายที่ขึ้นต้นด้วยอักษรโรมัน/ตัวเลข (เช่น "PIN 6 หลัก")
      // ต้องมีช่องไฟคั่น ไม่งั้นได้ "กรุณากรอกPIN 6 หลัก" ที่อ่านติดกันเป็นคำเดียว
      return (/^[A-Za-z0-9]/.test(text) ? ' ' : '') + text;
    }
    function messageFor(el) {
      const v = el.validity;
      const name = labelOf(el);
      if (v.valueMissing) {
        if (el.tagName === 'SELECT') return 'กรุณาเลือก' + name + 'จากรายการ';
        if (el.type === 'checkbox' || el.type === 'radio') return 'กรุณาเลือก' + name;
        if (el.type === 'file') return 'กรุณาเลือกไฟล์';
        return 'กรุณากรอก' + name;
      }
      if (v.tooShort) return name + ' ต้องมีอย่างน้อย ' + el.minLength + ' ตัวอักษร (ตอนนี้ ' + el.value.length + ' ตัว)';
      if (v.tooLong) return name + ' ยาวเกินกำหนด (ไม่เกิน ' + el.maxLength + ' ตัวอักษร)';
      if (v.typeMismatch) return el.type === 'email' ? 'รูปแบบอีเมลไม่ถูกต้อง เช่น name@example.com' : 'รูปแบบของ' + name + 'ไม่ถูกต้อง';
      if (v.patternMismatch) return 'รูปแบบของ' + name + 'ไม่ถูกต้อง';
      if (v.rangeUnderflow) return name + ' ต้องไม่น้อยกว่า ' + el.min;
      if (v.rangeOverflow) return name + ' ต้องไม่เกิน ' + el.max;
      if (v.stepMismatch || v.badInput) return 'กรุณากรอก' + name + 'ให้ถูกต้อง';
      return '';
    }
    // capture: true — invalid ไม่ bubble ขึ้นถึง document ต้องดักขาลง
    document.addEventListener('invalid', function (e) {
      const el = e.target;
      if (!el || typeof el.setCustomValidity !== 'function') return;
      const msg = messageFor(el);
      if (msg) el.setCustomValidity(msg);
      // เลื่อนช่องแรกที่มีปัญหาให้เห็นเต็มๆ — บนมือถือช่องที่ถูกบล็อกมักอยู่นอกจอ ฟองข้อความจึงโผล่
      // นอกสายตาและดูเหมือนกดปุ่มแล้วไม่มีอะไรเกิดขึ้นเลย
      if (!document.__invalidScrolled) {
        document.__invalidScrolled = true;
        try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { /* เบราว์เซอร์เก่า */ }
        window.setTimeout(function () { document.__invalidScrolled = false; }, 300);
      }
    }, true);
    // ต้องล้างทุกครั้งที่ผู้ใช้แก้ ไม่งั้น customValidity ที่ตั้งไว้จะค้าง ทำให้ช่องนั้น "ผิดตลอดไป"
    // แล้วฟอร์มจะส่งไม่ออกอีกเลย ซึ่งร้ายแรงกว่าปัญหาเดิมที่กำลังแก้อยู่
    ['input', 'change'].forEach(function (evt) {
      document.addEventListener(evt, function (e) {
        if (e.target && typeof e.target.setCustomValidity === 'function') e.target.setCustomValidity('');
      }, true);
    });
  })();

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
