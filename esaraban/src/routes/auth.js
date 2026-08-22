import { router, html, redirect, json } from '../router.js';
import { layout, esc, illustration } from '../render.js';
import { login, logout, sessionCookieHeader } from '../auth.js';

function loginPage({ error } = {}) {
  return `<div class="login-wrap">
    <div class="login-card">
      <div class="login-illustration">
        ${illustration('loginWelcome')}
        <h3>ระบบสารบรรณอิเล็กทรอนิกส์</h3>
        <p>โรงเรียนเจ้าพ่อหลวงอุปถัมภ์ ๑</p>
      </div>
      <div class="login-form-panel">
        <div class="login-logo">
          <div class="logo-dot" style="display:flex;align-items:center;justify-content:center;background:var(--primary);color:var(--primary-contrast);border-radius:12px;font-weight:800;">จพ</div>
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
        <div class="login-hint">
          <strong>บัญชีทดสอบ:</strong><br/>
          admin / Admin@2569 (ผู้ดูแลระบบ)<br/>
          director01 / Director@2569 (ผู้อำนวยการ)<br/>
          head_acad / Head@2569 (หัวหน้าฝ่ายวิชาการ)<br/>
          reg001 / Reg@2569 (ธุรการ)<br/>
          teacher001 / Teacher@2569 (ครู)<br/>
          PIN ทดสอบทุกบัญชี: เลขซ้ำ 6 หลักตามท้ายรหัส (เช่น admin = 111111)
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

router.get('/logout', (ctx) => {
  if (ctx.user) logout(ctx.user.sessionId, ctx.user.id, ctx.ip, ctx.req.headers['user-agent'] || '');
  redirect(ctx, '/login', { 'Set-Cookie': sessionCookieHeader('', { clear: true }) });
});
