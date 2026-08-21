import { router, html, json, redirect } from '../router.js';
import { layout, esc, fmtDate, emptyState } from '../render.js';
import { requirePage, requireApi, requireRole } from '../middleware.js';
import { db, uuid, nowIso, hashSecret, audit } from '../db.js';
import {
  isGoogleDriveEnabled, isGoogleDriveConnected, getOAuthClientConfig, exchangeCodeForTokens, DRIVE_SCOPE, AUTH_URL,
} from '../services/googleDrive.js';

function oauthRedirectUri(ctx) {
  const proto = ctx.req.headers['x-forwarded-proto'] || 'https';
  const host = ctx.req.headers.host;
  return `${proto}://${host}/admin/google-drive/callback`;
}

router.get('/admin/users', requireRole('admin')(requirePage((ctx) => {
  const users = db.prepare(`
    SELECT u.*, dep.name as dept_name, GROUP_CONCAT(r.name_th) as role_names FROM users u
    LEFT JOIN departments dep ON dep.id = u.department_id
    LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.deleted_at IS NULL GROUP BY u.id ORDER BY u.created_at DESC`).all();
  const depts = db.prepare('SELECT * FROM departments ORDER BY name').all();
  const roles = db.prepare('SELECT * FROM roles ORDER BY level DESC').all();

  const content = `
    <h2>⚙️ จัดการผู้ใช้งาน</h2>
    <div class="grid-2">
      <div class="card">
        <h3 class="mt-0">รายชื่อผู้ใช้ (${users.length})</h3>
        <div class="table-wrap"><table>
          <thead><tr><th>รหัส</th><th>ชื่อ</th><th>ฝ่าย</th><th>บทบาท</th><th>สถานะ</th><th></th></tr></thead>
          <tbody>${users.map((u) => `<tr>
            <td>${esc(u.employee_code)}</td><td>${esc(u.prefix || '')}${esc(u.first_name)} ${esc(u.last_name)}</td>
            <td>${esc(u.dept_name || '-')}</td><td>${esc(u.role_names || '-')}</td>
            <td><span class="badge ${u.status === 'active' ? 'badge-success' : 'badge-muted'}">${u.status === 'active' ? 'ใช้งาน' : 'ระงับ'}</span></td>
            <td>${u.id === ctx.user.id ? '' : `<button class="btn btn-outline btn-sm" onclick="deleteUser('${u.id}','${esc(u.first_name)} ${esc(u.last_name)}')">🗑️ ลบ</button>`}</td>
          </tr>`).join('')}</tbody>
        </table></div>
      </div>
      <div class="card">
        <h3 class="mt-0">เพิ่มผู้ใช้ใหม่</h3>
        <form id="newUserForm" class="stack">
          <div class="field"><label>รหัสพนักงาน (username)</label><input type="text" id="employeeCode" required /></div>
          <div class="form-grid cols-2">
            <div class="field"><label>คำนำหน้า</label><input type="text" id="prefix" placeholder="นาย/นาง/นางสาว" /></div>
            <div class="field"><label>ชื่อ-สกุล</label><input type="text" id="firstName" required /></div>
          </div>
          <div class="field"><label>นามสกุล</label><input type="text" id="lastName" required /></div>
          <div class="field"><label>อีเมล</label><input type="email" id="email" /></div>
          <div class="field"><label>ตำแหน่ง</label><input type="text" id="position" /></div>
          <div class="field"><label>ฝ่าย</label><select id="departmentId">${depts.map((d) => `<option value="${d.id}">${esc(d.name)}</option>`).join('')}</select></div>
          <div class="field"><label>บทบาท</label><select id="roleId">${roles.map((r) => `<option value="${r.id}">${esc(r.name_th)}</option>`).join('')}</select></div>
          <div class="field"><label>รหัสผ่านเริ่มต้น</label><input type="text" id="password" required placeholder="เช่น Welcome@2569" /></div>
          <div class="field"><label>PIN เริ่มต้น (6 หลัก)</label><input type="text" id="pin" inputmode="numeric" maxlength="6" required /></div>
          <button class="btn btn-primary" type="submit">สร้างผู้ใช้</button>
        </form>
        <script>
          document.getElementById('newUserForm').addEventListener('submit', function(e){
            e.preventDefault();
            var payload = {
              employeeCode: document.getElementById('employeeCode').value,
              prefix: document.getElementById('prefix').value,
              firstName: document.getElementById('firstName').value,
              lastName: document.getElementById('lastName').value,
              email: document.getElementById('email').value,
              position: document.getElementById('position').value,
              departmentId: document.getElementById('departmentId').value,
              roleId: document.getElementById('roleId').value,
              password: document.getElementById('password').value,
              pin: document.getElementById('pin').value,
            };
            fetch('/admin/users', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload)})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
              .catch(e => toast(e.message, 'danger'));
          });
          function deleteUser(id, name) {
            if (!confirm('ยืนยันลบผู้ใช้ "' + name + '"? (บัญชีจะถูกระงับการใช้งานถาวร แต่ประวัติเอกสาร/audit log ที่เกี่ยวข้องยังคงอยู่)')) return;
            fetch('/admin/users/' + id + '/delete', {method:'POST'})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
              .catch(e => toast(e.message, 'danger'));
          }
        </script>
      </div>
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'จัดการผู้ใช้', path: '/admin/users', content }));
})));

router.post('/admin/users', requireApi(async (ctx) => {
  if (!ctx.user.roleCodes.includes('admin')) return json(ctx, 403, { error: 'เฉพาะผู้ดูแลระบบเท่านั้น' });
  const b = ctx.body;
  if (!b.employeeCode || !b.firstName || !b.lastName || !b.password || !b.pin || !b.departmentId || !b.roleId) {
    return json(ctx, 400, { error: 'กรุณากรอกข้อมูลให้ครบถ้วน' });
  }
  if (!/^\d{6}$/.test(b.pin)) return json(ctx, 400, { error: 'PIN ต้องเป็นตัวเลข 6 หลัก' });
  const id = uuid();
  try {
    db.prepare(`
      INSERT INTO users (id, employee_code, prefix, first_name, last_name, email, position, department_id, password_hash, pin_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
    `).run(id, b.employeeCode.trim(), b.prefix || '', b.firstName.trim(), b.lastName.trim(), b.email || null, b.position || null, b.departmentId, hashSecret(b.password), hashSecret(b.pin), nowIso(), nowIso());
  } catch (e) {
    return json(ctx, 409, { error: 'รหัสพนักงานนี้มีอยู่แล้ว' });
  }
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(id, b.roleId);
  audit({ userId: ctx.user.id, action: 'user_created', tableName: 'users', recordId: id, detail: { employeeCode: b.employeeCode } });
  json(ctx, 201, { ok: true });
}));

router.post('/admin/users/:id/delete', requireApi(async (ctx) => {
  if (!ctx.user.roleCodes.includes('admin')) return json(ctx, 403, { error: 'เฉพาะผู้ดูแลระบบเท่านั้น' });
  const targetId = ctx.params.id;
  if (targetId === ctx.user.id) return json(ctx, 400, { error: 'ไม่สามารถลบบัญชีของตัวเองได้' });
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(targetId);
  if (!target) return json(ctx, 404, { error: 'ไม่พบผู้ใช้นี้' });

  const isAdmin = db.prepare(`
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(targetId);
  if (isAdmin) {
    const adminCount = db.prepare(`
      SELECT COUNT(DISTINCT u.id) c FROM users u
      JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'admin' AND u.deleted_at IS NULL
    `).get().c;
    if (adminCount <= 1) return json(ctx, 409, { error: 'ไม่สามารถลบผู้ดูแลระบบคนสุดท้ายได้ ต้องมีผู้ดูแลระบบอย่างน้อย 1 คนเสมอ' });
  }

  db.prepare(`UPDATE users SET deleted_at = ?, status = 'suspended', updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), targetId);
  audit({ userId: ctx.user.id, action: 'user_deleted', tableName: 'users', recordId: targetId, detail: { employeeCode: target.employee_code } });
  json(ctx, 200, { ok: true });
}));

router.get('/admin/audit', requireRole('admin')(requirePage((ctx) => {
  const rows = db.prepare(`
    SELECT a.*, u.first_name, u.last_name FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
    ORDER BY a.created_at DESC LIMIT 300`).all();
  const content = `
    <h2>🧾 Audit Log</h2>
    <p class="text-muted">บันทึกทุกการกระทำในระบบแบบ append-only (ห้ามลบ/แก้ไข)</p>
    <div class="card">
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>เวลา</th><th>ผู้ใช้</th><th>การกระทำ</th><th>ตาราง</th><th>รายละเอียด</th></tr></thead>
        <tbody>${rows.map((a) => `<tr>
          <td class="text-muted">${fmtDate(a.created_at)}</td>
          <td>${a.first_name ? esc(a.first_name) + ' ' + esc(a.last_name) : '-'}</td>
          <td><code>${esc(a.action)}</code></td><td>${esc(a.table_name || '-')}</td>
          <td style="max-width:280px;white-space:normal">${esc(a.detail || '')}</td>
        </tr>`).join('')}</tbody>
      </table></div>` : emptyState('🧾', 'ยังไม่มีบันทึก')}
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'Audit Log', path: '/admin/audit', content }));
})));

// ---------------- Google Drive OAuth connection (admin only) ----------------
router.get('/admin/google-drive', requireRole('admin')(requirePage((ctx) => {
  let clientConfigured = true;
  try { getOAuthClientConfig(); } catch (e) { clientConfigured = false; }
  const connected = isGoogleDriveConnected();
  const enabled = isGoogleDriveEnabled();

  const content = `
    <h2>🗂️ เชื่อมต่อ Google Drive</h2>
    <div class="card">
      <table class="table-plain">
        <tbody>
          <tr><td class="text-muted">STORAGE_PROVIDER</td><td>${enabled ? '<span class="badge badge-success">google_drive (เปิดใช้งาน)</span>' : '<span class="badge badge-muted">local (ยังไม่เปิดใช้ Google Drive)</span>'}</td></tr>
          <tr><td class="text-muted">GOOGLE_OAUTH_CLIENT_ID / SECRET</td><td>${clientConfigured ? '<span class="badge badge-success">ตั้งค่าแล้ว</span>' : '<span class="badge badge-danger">ยังไม่ได้ตั้งค่า</span>'}</td></tr>
          <tr><td class="text-muted">เชื่อมต่อบัญชี Google แล้วหรือยัง</td><td>${connected ? '<span class="badge badge-success">เชื่อมต่อแล้ว</span>' : '<span class="badge badge-muted">ยังไม่เชื่อมต่อ</span>'}</td></tr>
        </tbody>
      </table>
      ${!clientConfigured ? `<div class="alert alert-warning" style="margin-top:1rem">ต้องตั้งค่า <code>GOOGLE_OAUTH_CLIENT_ID</code> และ <code>GOOGLE_OAUTH_CLIENT_SECRET</code> เป็น environment variable ก่อน (ดูขั้นตอนสร้างใน <code>deploy/GOOGLE_DRIVE.md</code>) แล้ว redeploy จึงจะกดเชื่อมต่อได้</div>` : ''}
      ${clientConfigured ? `<a class="btn btn-primary" style="margin-top:1rem" href="/admin/google-drive/start">${connected ? '🔄 เชื่อมต่อบัญชีใหม่ (เปลี่ยนบัญชี)' : '🔗 เชื่อมต่อบัญชี Google'}</a>` : ''}
      <p class="text-muted" style="font-size:.8rem;margin-top:1rem">ไฟล์ที่อัปโหลดหลังเชื่อมต่อจะไปอยู่ในโฟลเดอร์ "ระบบสารบรรณอิเล็กทรอนิกส์ (esaraban)" ในบัญชี Google Drive ที่เชื่อมต่อ นับพื้นที่ในโควตา 15GB ปกติของบัญชีนั้น</p>
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'เชื่อมต่อ Google Drive', path: '/admin/google-drive', content }));
})));

router.get('/admin/google-drive/start', requireRole('admin')(requirePage((ctx) => {
  const { clientId } = getOAuthClientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: oauthRedirectUri(ctx),
    response_type: 'code',
    scope: DRIVE_SCOPE,
    access_type: 'offline',
    prompt: 'consent', // บังคับให้ Google ส่ง refresh_token กลับมาทุกครั้ง (ปกติส่งแค่ครั้งแรกที่ยินยอม)
  });
  redirect(ctx, `${AUTH_URL}?${params.toString()}`);
})));

router.get('/admin/google-drive/callback', requireRole('admin')(requirePage(async (ctx) => {
  if (ctx.query.error) {
    return html(ctx, 400, layout({ user: ctx.user, title: 'เชื่อมต่อไม่สำเร็จ', path: '/admin/google-drive',
      content: `<div class="alert alert-danger">Google ปฏิเสธคำขอ: ${esc(ctx.query.error)}</div><a class="btn btn-outline" href="/admin/google-drive">กลับ</a>` }));
  }
  if (!ctx.query.code) {
    return html(ctx, 400, layout({ user: ctx.user, title: 'เชื่อมต่อไม่สำเร็จ', path: '/admin/google-drive',
      content: '<div class="alert alert-danger">ไม่พบ authorization code</div>' }));
  }
  let tokens;
  try {
    tokens = await exchangeCodeForTokens({ code: ctx.query.code, redirectUri: oauthRedirectUri(ctx) });
  } catch (err) {
    return html(ctx, err.statusCode || 500, layout({ user: ctx.user, title: 'เชื่อมต่อไม่สำเร็จ', path: '/admin/google-drive',
      content: `<div class="alert alert-danger">${esc(err.message)}</div><a class="btn btn-outline" href="/admin/google-drive">กลับ</a>` }));
  }
  audit({ userId: ctx.user.id, action: 'google_drive_connected', tableName: 'system', recordId: null });

  const content = `
    <h2>✅ เชื่อมต่อสำเร็จ</h2>
    <div class="card">
      ${tokens.refresh_token ? `
        <p>คัดลอกค่านี้ไปตั้งเป็น environment variable <code>GOOGLE_OAUTH_REFRESH_TOKEN</code> บนเซิร์ฟเวอร์ แล้ว redeploy อีกครั้ง (ค่านี้เป็นความลับ ห้ามแชร์ให้ใครเห็น):</p>
        <textarea readonly style="width:100%;font-family:monospace;font-size:.85rem" rows="3" onclick="this.select()">${esc(tokens.refresh_token)}</textarea>
        <p class="text-muted" style="font-size:.8rem;margin-top:.5rem">อย่าลืมตั้ง <code>STORAGE_PROVIDER=google_drive</code> ด้วยถ้ายังไม่ได้ตั้ง</p>
      ` : `
        <div class="alert alert-warning">Google ไม่ได้ส่ง refresh token กลับมารอบนี้ (มักเกิดเมื่อเคยยินยอมมาก่อนแล้ว) — ไปที่ <a href="https://myaccount.google.com/permissions" target="_blank" rel="noopener">การอนุญาตของบัญชี Google</a> เพิกถอนสิทธิ์ของแอปนี้ก่อน แล้วกด "เชื่อมต่อบัญชีใหม่" อีกครั้ง</div>
      `}
      <a class="btn btn-outline" style="margin-top:1rem" href="/admin/google-drive">กลับหน้าเชื่อมต่อ</a>
    </div>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'เชื่อมต่อสำเร็จ', path: '/admin/google-drive', content }));
})));
