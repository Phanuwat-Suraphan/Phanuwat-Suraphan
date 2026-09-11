import { router, html, redirect, json } from '../router.js';
import { layout, esc, illustration, schoolName, schoolInitials } from '../render.js';
import { login, logout, sessionCookieHeader, revokeOtherSessions } from '../auth.js';
import { db, audit, nowIso, hashSecret, verifySecret, isWeakPin, testModeCredentials, starterCredentials } from '../db.js';

/** กล่อง "โหมดทดสอบ" บนหน้า login — บอกรหัสตรงนั้นเลยและกดเลือกบัญชีได้ทันที
 *
 *  ที่ต้องมีปุ่มกดเลือก ไม่ใช่แค่พิมพ์รหัสบอกไว้ เพราะการทดสอบจริงคือสลับบทบาทไปมาหลายสิบรอบ
 *  (ธุรการลงทะเบียน → หัวหน้าฝ่ายเกษียณ → ผอ. ลงนาม → ครูรับทราบ) การพิมพ์ชื่อผู้ใช้ใหม่ทุกรอบ
 *  คือจุดที่ทำให้เลิกทดสอบกลางคัน
 *
 *  กล่องนี้จะหายไปเองเมื่อลบ TEST_MODE_PASSWORD ออก ไม่ต้องแก้โค้ดอะไรตอนขึ้นใช้งานจริง
 */
function testModePanel() {
  const test = testModeCredentials();
  // โหมดทดสอบ (ตั้ง env เอง) ใช้รหัสเดียวกันทุกบัญชี ส่วนโหมดเริ่มต้น (ระบบเพิ่งติดตั้ง) แต่ละบัญชีมี
  // รหัสสุ่มของตัวเอง จึงเก็บรหัสไว้กับตัวปุ่มแต่ละอัน แล้วให้ปุ่มเป็นตัวเติมรหัสของบัญชีนั้นเอง
  const starter = test ? null : starterCredentials();
  if (!test && !starter) return '';

  const items = test
    ? test.accounts.map((a) => ({
      code: a.employee_code, password: test.password,
      detail: `${a.roles || 'ไม่ได้กำหนดบทบาท'}${`${a.prefix || ''}${a.first_name} ${a.last_name}`.trim() ? ` · ${`${a.prefix || ''}${a.first_name} ${a.last_name}`.trim()}` : ''}`,
    }))
    // โชว์ PIN ด้วย เพราะ PIN คือสิ่งที่ใช้ลงนาม/กด "ทราบ" ซึ่งเป็นหัวใจของระบบ ถ้าไม่บอก ก็ทดลอง
    // เส้นทางเดินหนังสือไม่ได้เลยสักขั้น — และในโหมดนี้ยังไม่มีข้อมูลอะไรให้ปกป้องอยู่แล้ว
    : starter.accounts.map((a) => ({
      code: a.code, password: a.password,
      detail: `${a.position || ''}${a.name ? ` · ${a.name}` : ''} · PIN ${a.pin}`,
    }));

  const rows = items.map((a) => `<button type="button" class="testmode-account"
      data-code="${esc(a.code)}" data-password="${esc(a.password)}" onclick="fillTestLogin(this)">
      <strong>${esc(a.code)}</strong>
      <span>${esc(a.detail)}</span>
    </button>`).join('');

  const head = test
    ? '🧪 โหมดทดสอบ — กดเลือกบัญชีแล้วกด "เข้าสู่ระบบ" ได้เลย'
    : '👋 ระบบเพิ่งติดตั้งใหม่ — กดเลือกบัญชีแล้วกด "เข้าสู่ระบบ" ได้เลย';
  const cred = test
    ? `รหัสผ่าน <code>${esc(test.password)}</code> · PIN <code>${esc(test.pin)}</code> (ทุกบัญชีใช้ชุดเดียวกัน)`
    : 'กดปุ่มแล้วระบบเติมรหัสผ่านให้เอง · PIN คือเลข 6 หลักท้ายแต่ละบรรทัด (ใช้ตอนลงนาม/กดทราบ)';
  const warn = test
    ? '⚠️ ห้ามเปิดโหมดนี้ทิ้งไว้ตอนใช้งานจริง — ลบตัวแปร <code>TEST_MODE_PASSWORD</code> บนเซิร์ฟเวอร์แล้ว restart'
    : '⚠️ กล่องนี้จะหายไปเองทันทีที่มีหนังสือฉบับแรกเข้าระบบ — ก่อนใช้งานจริง ให้ทุกคนตั้งรหัสของตัวเองที่ "โปรไฟล์ของฉัน"';

  return `<div class="testmode-box">
    <div class="testmode-head">${head}</div>
    <div class="testmode-cred">${cred}</div>
    <div class="testmode-accounts">${rows}</div>
    <div class="testmode-warn">${warn}</div>
  </div>
  <script>
    function fillTestLogin(btn) {
      document.querySelector('[name=employeeCode]').value = btn.dataset.code;
      document.getElementById('loginPassword').value = btn.dataset.password;
      document.querySelectorAll('.testmode-account').forEach(function (b) { b.classList.remove('is-picked'); });
      btn.classList.add('is-picked');
    }
  </script>`;
}

function loginPage({ error } = {}) {
  return `<div class="login-wrap">
    <div class="login-card">
      <div class="login-illustration">
        ${illustration('loginWelcome')}
        <h3>ระบบสารบรรณอิเล็กทรอนิกส์</h3>
        <p>${esc(schoolName())}</p>
      </div>
      <div class="login-form-panel">
        <div class="login-logo">
          <div class="logo-dot" style="display:flex;align-items:center;justify-content:center;background:var(--primary);color:var(--primary-contrast);border-radius:12px;font-weight:800;">${esc(schoolInitials())}</div>
          <h2 style="margin-top:.6rem">ลงชื่อเข้าใช้งาน</h2>
        </div>
        ${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}
        <form method="post" action="/login">
          <div class="field">
            <label>รหัสพนักงาน / Username</label>
            <input type="text" name="employeeCode" required autofocus autocomplete="username" placeholder="เช่น teacher001" />
          </div>
          <div class="field">
            <label>รหัสผ่าน</label>
            <div class="password-field">
              <input type="password" name="password" id="loginPassword" required autocomplete="current-password" placeholder="••••••••" />
              <button type="button" class="password-toggle" onclick="var f=document.getElementById('loginPassword');var showing=f.type==='text';f.type=showing?'password':'text';this.textContent=showing?'แสดง':'ซ่อน';">แสดง</button>
            </div>
          </div>
          <button class="btn btn-primary btn-block" type="submit">เข้าสู่ระบบ</button>
        </form>
        ${testModePanel()}
        <div class="login-hint">
          ยังไม่มีรหัสผ่าน หรือลืมรหัสผ่าน? ติดต่อเจ้าหน้าที่ธุรการหรือผู้ดูแลระบบของโรงเรียน
          เพื่อขอรหัสผ่านชั่วคราว แล้วระบบจะให้ตั้งรหัสผ่านของตัวเองตอนเข้าใช้งานครั้งแรก
        </div>
        <div class="text-muted" style="text-align:center;margin-top:1rem;font-size:.82rem">
          <a href="/privacy">นโยบายความเป็นส่วนตัว</a>
        </div>
      </div>
    </div>
  </div>`;
}

router.get('/login', (ctx) => {
  if (ctx.user) return redirect(ctx, '/');
  html(ctx, 200, layout({ user: null, title: 'เข้าสู่ระบบ', path: '/login', content: loginPage() }));
});

router.post('/login', (ctx) => {
  const { employeeCode, password } = ctx.body;
  const result = login((employeeCode || '').trim(), password || '', ctx.ip, ctx.req.headers['user-agent'] || '');
  if (!result.ok) {
    return html(ctx, 401, layout({ user: null, title: 'เข้าสู่ระบบ', path: '/login', content: loginPage({ error: result.error }) }));
  }
  redirect(ctx, '/', { 'Set-Cookie': sessionCookieHeader(result.cookie) });
});

// ---------------- ตั้งรหัสผ่าน/PIN ของตัวเองตอนเข้าใช้ครั้งแรก ----------------
// ตราบใดที่ผู้ใช้ยังใช้รหัสที่คนอื่นตั้งให้ คนที่ตั้งให้ก็ยังเข้าบัญชีนั้นได้ ซึ่งแปลว่าลายเซ็นและการลงนาม
// "ทราบ" ที่ออกจากบัญชีนั้นพิสูจน์ตัวตนไม่ได้จริง — จึงบังคับให้ตั้งเองก่อนแตะอะไรในระบบ (ดู middleware.js)
function firstLoginPage(user, { error } = {}) {
  return `<div class="login-wrap">
    <div class="login-card">
      <div class="login-illustration">
        ${illustration('loginWelcome')}
        <h3>ยินดีต้อนรับ</h3>
        <p>${esc(`${user.prefix || ''}${user.first_name} ${user.last_name}`)}</p>
      </div>
      <div class="login-form-panel">
        <h2 style="margin-top:0">ตั้งรหัสผ่านของตัวเอง</h2>
        <p class="help-text" style="margin-top:-.3rem">
          รหัสผ่านที่ใช้เข้ามาครั้งนี้เป็นรหัสชั่วคราวที่คนอื่นตั้งให้ กรุณาตั้งรหัสผ่านและ PIN ของตัวเอง
          ก่อนเริ่มใช้งาน — PIN 6 หลักใช้แทนการลงลายมือชื่อเวลากด "ทราบ" จึงต้องเป็นความลับเฉพาะตัวจริงๆ
        </p>
        ${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}
        <form method="post" action="/first-login">
          <div class="field">
            <label>รหัสผ่านใหม่ (อย่างน้อย 8 ตัวอักษร)</label>
            <input type="password" name="newPassword" minlength="8" required autocomplete="new-password" />
          </div>
          <div class="field">
            <label>พิมพ์รหัสผ่านใหม่อีกครั้ง</label>
            <input type="password" name="confirmPassword" minlength="8" required autocomplete="new-password" />
          </div>
          <div class="field">
            <label>PIN ใหม่ (ตัวเลข 6 หลัก)</label>
            <input type="password" name="newPin" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required autocomplete="new-password" />
            <div class="help-text">ห้ามใช้เลขซ้ำทั้งหมด (111111) หรือเลขเรียง (123456)</div>
          </div>
          <button class="btn btn-primary btn-block" type="submit">บันทึกและเริ่มใช้งาน</button>
        </form>
        <div class="text-muted" style="text-align:center;margin-top:1rem;font-size:.82rem">
          <a href="/logout">ออกจากระบบ</a>
        </div>
      </div>
    </div>
  </div>`;
}

router.get('/first-login', (ctx) => {
  if (!ctx.user) return redirect(ctx, '/login');
  if (!ctx.user.must_change_password) return redirect(ctx, '/');
  html(ctx, 200, layout({ user: null, title: 'ตั้งรหัสผ่านของตัวเอง', path: '/first-login', content: firstLoginPage(ctx.user) }));
});

router.post('/first-login', (ctx) => {
  if (!ctx.user) return redirect(ctx, '/login');
  if (!ctx.user.must_change_password) return redirect(ctx, '/');
  const { newPassword, confirmPassword, newPin } = ctx.body;
  const fail = (error) => html(ctx, 400, layout({
    user: null, title: 'ตั้งรหัสผ่านของตัวเอง', path: '/first-login',
    content: firstLoginPage(ctx.user, { error }),
  }));

  if (!newPassword || newPassword.length < 8) return fail('รหัสผ่านใหม่ต้องมีอย่างน้อย 8 ตัวอักษร');
  if (newPassword !== confirmPassword) return fail('รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
  // ตั้งรหัสเดิมซ้ำเท่ากับไม่ได้เปลี่ยน คนที่ตั้งรหัสชั่วคราวให้ก็ยังเข้าบัญชีนี้ได้เหมือนเดิม
  const row = db.prepare('SELECT password_hash, pin_hash FROM users WHERE id = ?').get(ctx.user.id);
  if (verifySecret(newPassword, row.password_hash)) return fail('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านชั่วคราวที่ได้รับมา');
  if (!/^\d{6}$/.test(newPin || '')) return fail('PIN ต้องเป็นตัวเลข 6 หลัก');
  if (isWeakPin(newPin)) return fail('PIN นี้เดาง่ายเกินไป — ห้ามใช้เลขซ้ำทั้งหมดหรือเลขเรียงติดกัน');
  if (verifySecret(newPin, row.pin_hash)) return fail('PIN ใหม่ต้องไม่ซ้ำกับ PIN ชั่วคราวที่ได้รับมา');

  // ล้างตัวนับ/เวลาล็อกทิ้งด้วย — คนที่เพิ่งพิสูจน์ตัวตนแล้วตั้งรหัสใหม่ด้วยตัวเอง ไม่ควรเดินออกไปเจอ
  // "บัญชีถูกล็อก 15 นาที" ค้างจากการกรอกผิดก่อนหน้านี้ แล้วสรุปว่ารหัสใหม่ที่เพิ่งตั้งใช้ไม่ได้
  db.prepare(`
    UPDATE users SET password_hash = ?, pin_hash = ?, must_change_password = 0,
      failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?
  `).run(hashSecret(newPassword), hashSecret(newPin), nowIso(), ctx.user.id);
  // เตะเซสชันอื่นออกให้หมด — ถ้ามีใครล็อกอินด้วยรหัสชั่วคราวค้างไว้อยู่ ต้องหลุดทันทีที่เจ้าตัวตั้งรหัสเอง
  const revoked = revokeOtherSessions(ctx.user.id, ctx.user.sessionId);
  audit({
    userId: ctx.user.id, action: 'first_login_password_set', tableName: 'users', recordId: ctx.user.id,
    detail: { revokedSessions: revoked }, ip: ctx.ip,
  });
  redirect(ctx, '/?welcome=1');
});

router.get('/logout', (ctx) => {
  if (ctx.user) logout(ctx.user.sessionId, ctx.user.id, ctx.ip, ctx.req.headers['user-agent'] || '');
  redirect(ctx, '/login', { 'Set-Cookie': sessionCookieHeader('', { clear: true }) });
});
