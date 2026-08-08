import { router, html, json } from '../router.js';
import { layout, esc, fmtDate, avatarContent, parseUserAgent } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, nowIso, hashSecret, verifySecret, audit } from '../db.js';

// อวตารอิโมจิให้เลือก (UX Bible Part 21 §8) — คัดเฉพาะที่เหมาะกับบุคลากรโรงเรียน
const AVATAR_EMOJIS = ['👩‍🏫', '👨‍🏫', '🧑‍🏫', '👩‍💼', '👨‍💼', '🧑‍💼', '🎓', '📚', '🦉', '🐱', '🐶', '🦊', '🐰', '🐢', '🐼', '🌿', '⭐', '😊'];

router.get('/profile', requirePage((ctx) => {
  const dept = db.prepare('SELECT * FROM departments WHERE id = ?').get(ctx.user.department_id);
  const recentAudit = db.prepare('SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 10').all(ctx.user.id);
  const loginHistory = db.prepare(`
    SELECT * FROM audit_logs WHERE user_id = ? AND action IN ('login_success','logout') ORDER BY created_at DESC LIMIT 15
  `).all(ctx.user.id);
  const content = `
    <h2>👤 โปรไฟล์ของฉัน</h2>
    <div class="grid-2">
      <div class="card">
        <div class="flex items-center gap-2" style="margin-bottom:1rem">
          <div class="avatar" id="profileAvatarPreview" style="width:56px;height:56px;font-size:1.1rem">${avatarContent(ctx.user)}</div>
          <div>
            <div style="font-weight:700;font-size:1.05rem">${esc(ctx.user.prefix || '')}${esc(ctx.user.first_name)} ${esc(ctx.user.last_name)}</div>
            <div class="text-muted">${esc(ctx.user.position || '')}</div>
          </div>
        </div>
        <div class="field">
          <label>เลือกอวตาร</label>
          <div class="chip-row">
            ${AVATAR_EMOJIS.map((e) => `<button type="button" class="avatar-pick${ctx.user.avatar_emoji === e ? ' active' : ''}" onclick="pickAvatar('${e}')" title="ใช้อวตารนี้">${e}</button>`).join('')}
            ${ctx.user.avatar_emoji ? `<button type="button" class="avatar-pick" onclick="pickAvatar(null)" title="กลับไปใช้ตัวอักษรย่อชื่อ">↺</button>` : ''}
          </div>
        </div>
        <table>
          <tr><td class="text-muted">รหัสพนักงาน</td><td>${esc(ctx.user.employee_code)}</td></tr>
          <tr><td class="text-muted">ฝ่าย</td><td>${esc(dept?.name || '-')}</td></tr>
          <tr><td class="text-muted">บทบาท</td><td>${ctx.user.roles.map((r) => `<span class="badge badge-info">${esc(r.name_th)}</span>`).join(' ')}</td></tr>
        </table>
        <p class="text-muted" style="font-size:.8rem">รหัสพนักงาน/ฝ่าย/บทบาท แก้ไขได้เฉพาะผู้ดูแลระบบเท่านั้น</p>

        <h3 style="margin-top:1.2rem">แก้ไขข้อมูลส่วนตัว</h3>
        <form id="infoForm" class="stack">
          <div class="form-grid cols-2">
            <div class="field"><label>คำนำหน้า</label><input type="text" id="prefix" value="${esc(ctx.user.prefix || '')}" /></div>
            <div class="field"><label>ชื่อ</label><input type="text" id="firstName" value="${esc(ctx.user.first_name)}" required /></div>
          </div>
          <div class="field"><label>นามสกุล</label><input type="text" id="lastName" value="${esc(ctx.user.last_name)}" required /></div>
          <div class="field"><label>อีเมล</label><input type="email" id="email" value="${esc(ctx.user.email || '')}" /></div>
          <div class="field"><label>ตำแหน่ง</label><input type="text" id="position" value="${esc(ctx.user.position || '')}" /></div>
          <button class="btn btn-primary" type="submit">บันทึกข้อมูล</button>
        </form>

        <h3 style="margin-top:1.2rem">เปลี่ยนรหัสผ่าน</h3>
        <form id="passwordForm" class="stack">
          <div class="field"><label>รหัสผ่านปัจจุบัน</label><input type="password" id="curPasswordForPw" required /></div>
          <div class="field"><label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label><input type="password" id="newPassword" minlength="8" required /></div>
          <button class="btn btn-primary" type="submit">เปลี่ยนรหัสผ่าน</button>
        </form>

        <h3 style="margin-top:1.2rem">เปลี่ยน PIN (ใช้ยืนยันการรับทราบ/ลงนาม)</h3>
        <form id="pinForm" class="stack">
          <div class="field"><label>รหัสผ่านปัจจุบัน</label><input type="password" id="curPassword" required /></div>
          <div class="field"><label>PIN ใหม่ (6 หลัก)</label><input type="text" id="newPin" inputmode="numeric" maxlength="6" required /></div>
          <button class="btn btn-primary" type="submit">บันทึก PIN ใหม่</button>
        </form>

        <h3 style="margin-top:1.2rem">ลายเซ็น (ของฉันเท่านั้น)</h3>
        <p class="text-muted" style="font-size:.8rem">ใช้แสดงประกอบเมื่อคุณอนุมัติ/รับทราบเอกสาร — ตามธรรมเนียมราชการนิยมใช้<strong>สีน้ำเงิน</strong>เพื่อแยกต้นฉบับจากสำเนาถ่ายเอกสาร</p>
        <div id="signaturePreviewWrap" style="margin-bottom:.6rem">
          ${ctx.user.signature_image
            ? `<img src="${esc(ctx.user.signature_image)}" alt="ลายเซ็นปัจจุบัน" style="max-height:80px;max-width:240px;border:1px solid var(--border);border-radius:6px;padding:.4rem;background:#fff" />`
            : '<p class="text-muted" style="font-size:.85rem">ยังไม่มีลายเซ็นบันทึกไว้</p>'}
        </div>
        <div class="chip-row" style="margin-bottom:.6rem">
          <button type="button" class="btn btn-sm btn-outline" id="sigTabDrawBtn" onclick="switchSigTab('draw')">✏️ วาดลายเซ็น</button>
          <button type="button" class="btn btn-sm btn-outline" id="sigTabUploadBtn" onclick="switchSigTab('upload')">📁 อัปโหลดไฟล์ (สแกน)</button>
        </div>
        <div id="sigDrawPanel">
          <canvas id="sigCanvas" style="border:1px solid var(--border);border-radius:8px;background:#fff;touch-action:none;cursor:crosshair;width:100%;max-width:360px;height:140px;display:block"></canvas>
          <div class="chip-row" style="margin-top:.5rem;font-weight:400">
            <label style="display:flex;align-items:center;gap:.3rem"><input type="radio" name="sigColor" value="#1a3fa0" checked /> น้ำเงิน</label>
            <label style="display:flex;align-items:center;gap:.3rem"><input type="radio" name="sigColor" value="#000000" /> ดำ</label>
          </div>
          <div class="chip-row" style="margin-top:.6rem">
            <button type="button" class="btn btn-outline btn-sm" onclick="clearSigCanvas()">ล้าง</button>
            <button type="button" class="btn btn-primary btn-sm" onclick="saveSigCanvas()">บันทึกลายเซ็น</button>
          </div>
          <div class="help-text">วาดด้วยเมาส์หรือนิ้ว (บนมือถือ/แท็บเล็ต) — พื้นหลังโปร่งใสอัตโนมัติ</div>
        </div>
        <div id="sigUploadPanel" style="display:none">
          <form id="signatureForm" class="stack">
            <div class="field">
              <input type="file" id="signatureFile" accept="image/png,image/jpeg" />
              <div class="help-text">รองรับ PNG/JPG ขนาดไม่เกิน 1MB — สแกนหรือถ่ายรูปลายเซ็นบนกระดาษขาว แนะนำพื้นหลังสีขาว/โปร่งใส</div>
            </div>
            <button class="btn btn-primary btn-sm" type="submit">บันทึกลายเซ็น</button>
          </form>
        </div>
        ${ctx.user.signature_image ? `<button class="btn btn-outline btn-sm" style="margin-top:.6rem" type="button" onclick="deleteSignature()">ลบลายเซ็นที่บันทึกไว้</button>` : ''}
        <script>
          window.switchSigTab = function(tab){
            document.getElementById('sigDrawPanel').style.display = tab === 'draw' ? '' : 'none';
            document.getElementById('sigUploadPanel').style.display = tab === 'upload' ? '' : 'none';
          };
          (function(){
            var canvas = document.getElementById('sigCanvas');
            var c2d = canvas.getContext('2d');
            var drawing = false, hasDrawn = false;
            function fitCanvas(){
              var rect = canvas.getBoundingClientRect();
              var dpr = window.devicePixelRatio || 1;
              canvas.width = rect.width * dpr;
              canvas.height = rect.height * dpr;
              c2d.scale(dpr, dpr);
              c2d.lineWidth = 2.5;
              c2d.lineCap = 'round';
              c2d.lineJoin = 'round';
            }
            fitCanvas();
            function pos(e){ var r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
            function currentColor(){ var c = document.querySelector('input[name=sigColor]:checked'); return c ? c.value : '#1a3fa0'; }
            canvas.addEventListener('pointerdown', function(e){
              drawing = true; hasDrawn = true;
              var p = pos(e);
              c2d.strokeStyle = currentColor();
              c2d.beginPath();
              c2d.moveTo(p.x, p.y);
              canvas.setPointerCapture(e.pointerId);
            });
            canvas.addEventListener('pointermove', function(e){
              if (!drawing) return;
              var p = pos(e);
              c2d.lineTo(p.x, p.y);
              c2d.stroke();
            });
            canvas.addEventListener('pointerup', function(){ drawing = false; });
            canvas.addEventListener('pointerleave', function(){ drawing = false; });
            window.clearSigCanvas = function(){ c2d.clearRect(0, 0, canvas.width, canvas.height); hasDrawn = false; };
            window.saveSigCanvas = function(){
              if (!hasDrawn) { toast('กรุณาวาดลายเซ็นก่อนบันทึก', 'warning'); return; }
              var dataUrl = canvas.toDataURL('image/png');
              fetch('/profile/signature', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({dataUrl: dataUrl})})
                .then(r => r.json().then(d => ({ok:r.ok,d})))
                .then(({ok,d}) => { if(!ok) throw new Error(d.error); toast('บันทึกลายเซ็นสำเร็จ','success'); setTimeout(()=>location.reload(), 600); })
                .catch(e => toast(e.message, 'danger'));
            };
          })();
        </script>
        <script>
          document.getElementById('infoForm').addEventListener('submit', function(e){
            e.preventDefault();
            var payload = {
              prefix: document.getElementById('prefix').value,
              firstName: document.getElementById('firstName').value,
              lastName: document.getElementById('lastName').value,
              email: document.getElementById('email').value,
              position: document.getElementById('position').value,
            };
            fetch('/profile/info', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); toast('บันทึกข้อมูลสำเร็จ','success'); setTimeout(()=>location.reload(), 600); })
              .catch(e => toast(e.message, 'danger'));
          });
          document.getElementById('passwordForm').addEventListener('submit', function(e){
            e.preventDefault();
            var currentPassword = document.getElementById('curPasswordForPw').value;
            var newPassword = document.getElementById('newPassword').value;
            fetch('/profile/password', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({currentPassword, newPassword})})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); toast('เปลี่ยนรหัสผ่านสำเร็จ','success'); e.target.reset(); })
              .catch(e => toast(e.message, 'danger'));
          });
          document.getElementById('pinForm').addEventListener('submit', function(e){
            e.preventDefault();
            var currentPassword = document.getElementById('curPassword').value;
            var newPin = document.getElementById('newPin').value;
            if(!/^\\d{6}$/.test(newPin)){ toast('PIN ต้องเป็นตัวเลข 6 หลัก', 'warning'); return; }
            fetch('/profile/pin', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({currentPassword, newPin})})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); toast('เปลี่ยน PIN สำเร็จ','success'); e.target.reset(); })
              .catch(e => toast(e.message, 'danger'));
          });
          document.getElementById('signatureForm').addEventListener('submit', async function(e){
            e.preventDefault();
            var file = document.getElementById('signatureFile').files[0];
            if (!file) { toast('กรุณาเลือกไฟล์รูปลายเซ็น', 'warning'); return; }
            if (file.size > 1024 * 1024) { toast('ไฟล์ต้องมีขนาดไม่เกิน 1MB', 'warning'); return; }
            var dataUrl = await window.fileToDataUrl(file);
            fetch('/profile/signature', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({dataUrl})})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); toast('บันทึกลายเซ็นสำเร็จ','success'); setTimeout(()=>location.reload(), 600); })
              .catch(e => toast(e.message, 'danger'));
          });
          window.deleteSignature = function(){
            if (!confirm('ยืนยันลบลายเซ็นที่บันทึกไว้?')) return;
            fetch('/profile/signature', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({dataUrl: null})})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
              .catch(e => toast(e.message, 'danger'));
          };
          window.pickAvatar = function(emoji){
            fetch('/profile/avatar', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({emoji: emoji})})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
              .catch(e => toast(e.message, 'danger'));
          };
        </script>
      </div>
      <div class="card">
        <h3 class="mt-0">🔐 ประวัติการเข้า-ออกระบบ</h3>
        ${loginHistory.length ? `<div class="table-wrap"><table>
          <thead><tr><th>การกระทำ</th><th>IP</th><th>อุปกรณ์/เบราว์เซอร์</th><th>วันที่/เวลา</th></tr></thead>
          <tbody>${loginHistory.map((a) => {
            let ua = '';
            try { ua = JSON.parse(a.detail || '{}').userAgent || ''; } catch (e) { /* ignore malformed detail */ }
            return `<tr>
              <td>${a.action === 'login_success' ? '<span class="badge badge-success">เข้าสู่ระบบ</span>' : '<span class="badge badge-muted">ออกจากระบบ</span>'}</td>
              <td class="text-muted">${esc(a.ip || '-')}</td>
              <td class="text-muted">${esc(parseUserAgent(ua))}</td>
              <td class="text-muted">${fmtDate(a.created_at)}</td>
            </tr>`;
          }).join('')}</tbody>
        </table></div>` : '<p class="text-muted">ไม่มีข้อมูล</p>'}
      </div>
      <div class="card">
        <h3 class="mt-0">กิจกรรมล่าสุดของฉัน (Audit)</h3>
        ${recentAudit.map((a) => `<div style="padding:.4rem 0;border-bottom:1px solid var(--border);font-size:.84rem">
          <strong>${esc(a.action)}</strong> <span class="text-muted">${fmtDate(a.created_at)}</span></div>`).join('') || '<p class="text-muted">ไม่มีข้อมูล</p>'}
      </div>
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'โปรไฟล์', path: '/profile', content }));
}));

router.post('/profile/info', requireApi(async (ctx) => {
  const { prefix, firstName, lastName, email, position } = ctx.body;
  if (!firstName?.trim() || !lastName?.trim()) return json(ctx, 400, { error: 'กรุณากรอกชื่อและนามสกุล' });
  try {
    db.prepare(`
      UPDATE users SET prefix = ?, first_name = ?, last_name = ?, email = ?, position = ?, updated_at = ? WHERE id = ?
    `).run(prefix?.trim() || null, firstName.trim(), lastName.trim(), email?.trim() || null, position?.trim() || null, nowIso(), ctx.user.id);
  } catch (e) {
    return json(ctx, 409, { error: 'อีเมลนี้ถูกใช้งานโดยผู้ใช้อื่นแล้ว' });
  }
  audit({ userId: ctx.user.id, action: 'profile_info_updated', tableName: 'users', recordId: ctx.user.id });
  json(ctx, 200, { ok: true });
}));

router.post('/profile/password', requireApi(async (ctx) => {
  const { currentPassword, newPassword } = ctx.body;
  if (!newPassword || newPassword.length < 8) return json(ctx, 400, { error: 'รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
  if (!verifySecret(currentPassword, row.password_hash)) return json(ctx, 401, { error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hashSecret(newPassword), nowIso(), ctx.user.id);
  audit({ userId: ctx.user.id, action: 'password_changed', tableName: 'users', recordId: ctx.user.id });
  json(ctx, 200, { ok: true });
}));

const MAX_SIGNATURE_BYTES = 1024 * 1024; // 1MB

router.post('/profile/signature', requireApi(async (ctx) => {
  const { dataUrl } = ctx.body;

  if (dataUrl === null || dataUrl === undefined || dataUrl === '') {
    db.prepare('UPDATE users SET signature_image = NULL, updated_at = ? WHERE id = ?').run(nowIso(), ctx.user.id);
    audit({ userId: ctx.user.id, action: 'signature_removed', tableName: 'users', recordId: ctx.user.id });
    return json(ctx, 200, { ok: true });
  }

  const match = /^data:(image\/png|image\/jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return json(ctx, 400, { error: 'รูปแบบไฟล์ไม่ถูกต้อง (รองรับเฉพาะ PNG/JPG)' });
  const [, mimeType, base64Data] = match;
  const buf = Buffer.from(base64Data, 'base64');
  if (buf.length > MAX_SIGNATURE_BYTES) return json(ctx, 413, { error: 'ไฟล์มีขนาดใหญ่เกิน 1MB' });

  // magic-number check — don't trust the declared MIME type alone
  const isPng = buf.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  const isJpeg = buf.subarray(0, 3).toString('hex') === 'ffd8ff';
  if ((mimeType === 'image/png' && !isPng) || (mimeType === 'image/jpeg' && !isJpeg)) {
    return json(ctx, 400, { error: 'ไฟล์ไม่ใช่รูปภาพที่ถูกต้อง (ตรวจสอบ file signature ไม่ผ่าน)' });
  }

  db.prepare('UPDATE users SET signature_image = ?, updated_at = ? WHERE id = ?').run(dataUrl, nowIso(), ctx.user.id);
  audit({ userId: ctx.user.id, action: 'signature_uploaded', tableName: 'users', recordId: ctx.user.id });
  json(ctx, 200, { ok: true });
}));

router.post('/profile/avatar', requireApi(async (ctx) => {
  const { emoji } = ctx.body;
  if (emoji !== null && !AVATAR_EMOJIS.includes(emoji)) return json(ctx, 400, { error: 'อวตารที่เลือกไม่ถูกต้อง' });
  db.prepare('UPDATE users SET avatar_emoji = ?, updated_at = ? WHERE id = ?').run(emoji, nowIso(), ctx.user.id);
  audit({ userId: ctx.user.id, action: 'avatar_changed', tableName: 'users', recordId: ctx.user.id, detail: { emoji } });
  json(ctx, 200, { ok: true });
}));

router.post('/profile/pin', requireApi(async (ctx) => {
  const { currentPassword, newPin } = ctx.body;
  if (!/^\d{6}$/.test(newPin || '')) return json(ctx, 400, { error: 'PIN ต้องเป็นตัวเลข 6 หลัก' });
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(ctx.user.id);
  if (!verifySecret(currentPassword, row.password_hash)) return json(ctx, 401, { error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
  db.prepare('UPDATE users SET pin_hash = ?, updated_at = ? WHERE id = ?').run(hashSecret(newPin), nowIso(), ctx.user.id);
  audit({ userId: ctx.user.id, action: 'pin_changed', tableName: 'users', recordId: ctx.user.id });
  json(ctx, 200, { ok: true });
}));
