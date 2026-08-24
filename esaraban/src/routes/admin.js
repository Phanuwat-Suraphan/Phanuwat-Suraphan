import { router, html, json, redirect, contentDispositionHeader } from '../router.js';
import { layout, esc, fmtDate, emptyState } from '../render.js';
import { requirePage, requireApi, requireRole } from '../middleware.js';
import { db, uuid, nowIso, hashSecret, audit } from '../db.js';
import { readTable, planUserImport, applyUserImport, templateCsv, generatePassword, generatePin } from '../services/userImport.js';
import { httpError } from '../services/workflow.js';
import { positionInput } from '../services/positions.js';
import {
  isGoogleDriveEnabled, isGoogleDriveConnected, getOAuthClientConfig, exchangeCodeForTokens, DRIVE_SCOPE, AUTH_URL,
  listAllAttachmentFiles, deleteFile,
} from '../services/googleDrive.js';

/**
 * ไฟล์บน Drive ที่ไม่มีรายการในระบบอ้างถึงแล้ว
 *
 * เกิดจากเวอร์ชันก่อนหน้าที่ประทับตราแต่ละชั้นแล้วอัปโหลดไฟล์ใหม่ทุกครั้งโดยไม่ลบชั้นเก่าทิ้ง หนังสือ
 * ฉบับเดียวที่ผ่านมือหลายคนจึงเหลือไฟล์ค้างชั้นละไฟล์ (ตอนนี้แก้ที่ต้นเหตุแล้วใน saveStampedCopy
 * แต่ของที่ค้างมาก่อนหน้านั้นยังอยู่) และจากไฟล์ของหนังสือที่ถูกลบถาวรไปแล้ว
 *
 * เทียบจาก id ตรงๆ ไม่ใช่เดาจากชื่อไฟล์ — ชื่อซ้ำกันได้ และการเดาผิดแปลว่าลบไฟล์แนบของจริงทิ้ง
 */
async function findOrphanDriveFiles() {
  const files = await listAllAttachmentFiles();
  const referenced = new Set();
  for (const row of db.prepare('SELECT drive_file_id, stamped_drive_file_id FROM attachments').all()) {
    if (row.drive_file_id) referenced.add(row.drive_file_id);
    if (row.stamped_drive_file_id) referenced.add(row.stamped_drive_file_id);
  }
  return files.filter((f) => !referenced.has(f.id));
}

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
            <td style="white-space:nowrap">
              ${u.must_change_password ? '<span class="badge badge-warning" title="ยังไม่ได้ตั้งรหัสผ่านของตัวเอง">🔑 รอตั้งรหัส</span> ' : ''}
              <a class="btn btn-outline btn-sm" href="/admin/users/${u.id}/edit">✏️ แก้ไข</a>
              <button class="btn btn-outline btn-sm" onclick="resetPassword('${u.id}','${esc(u.employee_code)}')">🔑 รีเซ็ตรหัส</button>
              ${u.id === ctx.user.id ? '' : `<button class="btn btn-outline btn-sm" onclick="deleteUser('${u.id}','${esc(u.first_name)} ${esc(u.last_name)}')">🗑️ ลบ</button>`}
            </td>
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
          <div class="field"><label>ตำแหน่ง</label>${positionInput({ id: 'position', listId: 'posNew' })}</div>
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
          function resetPassword(id, code) {
            // ห้ามใช้ \\n ตรงๆ ในสตริงนี้ — โค้ดก้อนนี้อยู่ใน template literal ของฝั่งเซิร์ฟเวอร์
            // \\n จึงถูกแปลงเป็นการขึ้นบรรทัดจริงตั้งแต่ตอนสร้าง HTML แล้วกลายเป็นสตริงที่ขึ้นบรรทัดใหม่
            // กลางคันในฝั่งเบราว์เซอร์ = SyntaxError ซึ่งทำให้ <script> ทั้งก้อนไม่ทำงานเลย
            // (ปุ่มเพิ่มผู้ใช้/ลบผู้ใช้ที่อยู่ในก้อนเดียวกันก็ตายไปด้วย — เคยหลุดไปแล้วครั้งหนึ่ง)
            if (!confirm('ออกรหัสผ่านชั่วคราวใหม่ให้ "' + code + '"? รหัสเดิมจะใช้ไม่ได้ทันที เครื่องที่เปิดค้างอยู่จะถูกให้ออกจากระบบ และเจ้าตัวต้องตั้งรหัสของตัวเองตอนเข้าใช้ครั้งถัดไป')) return;
            fetch('/admin/users/' + id + '/reset-password', {method:'POST'})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => {
                if(!ok) throw new Error(d.error);
                // แสดงครั้งเดียวและไม่เก็บไว้ที่ไหน — ผู้ดูแลต้องคัดลอกส่งให้เจ้าตัวตอนนี้เลย
                prompt('คัดลอกรหัสชั่วคราวนี้ส่งให้เจ้าตัว (แสดงครั้งเดียวเท่านั้น)', 'รหัสผ่าน: ' + d.password + '   PIN: ' + d.pin);
                location.reload();
              })
              .catch(e => toast(e.message, 'danger'));
          }
          function deleteUser(id, name) {
            if (!confirm('ยืนยันลบผู้ใช้ "' + name + '"? (บัญชีจะถูกระงับการใช้งานถาวร แต่ประวัติเอกสาร/audit log ที่เกี่ยวข้องยังคงอยู่)')) return;
            fetch('/admin/users/' + id + '/delete', {method:'POST'})
              .then(r => r.json().then(d => ({ok:r.ok,d})))
              .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
              .catch(e => toast(e.message, 'danger'));
          }
        </script>
      </div>
    </div>

    <div class="card">
      <h3 class="mt-0">📥 นำเข้ารายชื่อจาก Excel/CSV</h3>
      <p class="text-muted" style="font-size:.85rem;margin-top:-.3rem">
        เปิดใช้ระบบครั้งแรกไม่ต้องพิมพ์ทีละคน — อัปโหลดไฟล์รายชื่อครูที่มีอยู่แล้วได้เลย
        รองรับทั้ง <code>.xlsx</code> และ <code>.csv</code>
      </p>
      <a class="btn btn-outline btn-sm" href="/admin/users/template.csv">⬇️ ดาวน์โหลดไฟล์ตัวอย่าง</a>
      <div class="callout-tip" style="margin-top:.8rem">
        ต้องมีคอลัมน์อย่างน้อย <strong>รหัสประจำตัว, ชื่อ, นามสกุล</strong> —
        ส่วน คำนำหน้า/อีเมล/ตำแหน่ง/ฝ่าย/บทบาท ใส่หรือไม่ใส่ก็ได้ (ไม่ใส่บทบาทจะเป็น "ครู")
        <br/>ชื่อฝ่ายและบทบาทต้องตรงกับที่มีในระบบ ระบบจะบอกให้ก่อนถ้าไม่ตรง
        <br/><strong>รหัสผ่านและ PIN ระบบสุ่มให้คนละชุด</strong> แล้วแสดงครั้งเดียวหลังนำเข้าเสร็จ ให้พิมพ์เก็บไว้แจก
      </div>
      <input type="file" id="importFile" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" style="margin-top:.8rem" />
      <div id="importResult" style="margin-top:1rem"></div>
    </div>
    <script>
      var importPayload = null;
      document.getElementById('importFile').addEventListener('change', async function () {
        var file = this.files[0];
        if (!file) return;
        var box = document.getElementById('importResult');
        box.innerHTML = '<p class="text-muted">กำลังตรวจไฟล์…</p>';
        try {
          var b64 = await new Promise(function (res, rej) {
            var r = new FileReader();
            r.onload = function () { res(r.result.split(',')[1]); };
            r.onerror = rej;
            r.readAsDataURL(file);
          });
          importPayload = { fileName: file.name, fileDataBase64: b64 };
          var res = await fetch('/admin/users/import/preview', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(importPayload),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'อ่านไฟล์ไม่สำเร็จ');
          renderPreview(data);
        } catch (e) { box.innerHTML = '<div class="alert alert-danger">' + e.message + '</div>'; }
      });

      function renderPreview(data) {
        var s = data.summary;
        var rows = data.items.map(function (it) {
          var badge = it.status === 'ok' ? '<span class="badge badge-success">นำเข้าได้</span>'
            : it.status === 'skip' ? '<span class="badge badge-muted">มีอยู่แล้ว</span>'
            : '<span class="badge badge-danger">ผิดพลาด</span>';
          return '<tr><td>' + it.rowNumber + '</td><td>' + esc(it.employeeCode) + '</td><td>' +
            esc((it.prefix || '') + it.firstName + ' ' + it.lastName) + '</td><td>' + esc(it.roleLabel || it.roleName || '') +
            '</td><td>' + badge + '</td><td class="text-muted">' + esc(it.reason || '') + '</td></tr>';
        }).join('');
        document.getElementById('importResult').innerHTML =
          '<div class="alert ' + (s.error ? 'alert-warning' : 'alert-success') + '">ตรวจไฟล์แล้ว — นำเข้าได้ <strong>' + s.ok +
          '</strong> คน · มีอยู่แล้ว ' + s.skip + ' · ผิดพลาด ' + s.error + '</div>' +
          '<div class="table-wrap"><table><thead><tr><th>แถว</th><th>รหัส</th><th>ชื่อ</th><th>บทบาท</th><th>ผล</th><th>หมายเหตุ</th></tr></thead><tbody>' +
          rows + '</tbody></table></div>' +
          (s.ok ? '<button class="btn btn-primary" style="margin-top:.8rem" onclick="confirmImport(this)">✅ ยืนยันนำเข้า ' + s.ok + ' คน</button>' : '');
      }

      function esc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

      async function confirmImport(btn) {
        var pin = await window.askPin('ยืนยัน PIN เพื่อสร้างบัญชีผู้ใช้');
        if (!pin) return;
        window.setBtnLoading(btn);
        try {
          var res = await fetch('/admin/users/import', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Object.assign({ pin: pin }, importPayload)),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'นำเข้าไม่สำเร็จ');
          document.getElementById('importResult').innerHTML =
            '<div class="alert alert-success">สร้างบัญชีแล้ว <strong>' + data.created.length + '</strong> คน — ' +
            '<strong>รหัสผ่านและ PIN ด้านล่างแสดงครั้งเดียวเท่านั้น</strong> กรุณาพิมพ์หรือคัดลอกเก็บไว้ก่อนออกจากหน้านี้</div>' +
            '<div class="table-wrap"><table><thead><tr><th>รหัสประจำตัว</th><th>ชื่อ</th><th>รหัสผ่าน</th><th>PIN</th></tr></thead><tbody>' +
            data.created.map(function (c) {
              return '<tr><td>' + esc(c.employeeCode) + '</td><td>' + esc(c.name) +
                '</td><td><code>' + esc(c.password) + '</code></td><td><code>' + esc(c.pin) + '</code></td></tr>';
            }).join('') + '</tbody></table></div>' +
            '<button class="btn btn-outline btn-sm" style="margin-top:.8rem" onclick="window.print()">🖨️ พิมพ์รายการนี้</button>';
        } catch (e) { window.toast(e.message, 'danger'); window.restoreBtn(btn); }
      }
    </script>`;
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
      INSERT INTO users (id, employee_code, prefix, first_name, last_name, email, position, department_id, password_hash, pin_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
    `).run(id, b.employeeCode.trim(), b.prefix || '', b.firstName.trim(), b.lastName.trim(), b.email || null, b.position || null, b.departmentId, hashSecret(b.password), hashSecret(b.pin), nowIso(), nowIso());
  } catch (e) {
    return json(ctx, 409, { error: 'รหัสพนักงานนี้มีอยู่แล้ว' });
  }
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(id, b.roleId);
  audit({ userId: ctx.user.id, action: 'user_created', tableName: 'users', recordId: id, detail: { employeeCode: b.employeeCode } });
  json(ctx, 201, { ok: true });
}));

// รีเซ็ตรหัสผ่านให้ผู้ใช้ที่ลืมรหัส — ออกรหัสชั่วคราวแบบสุ่มให้ครั้งเดียว แล้วบังคับให้เจ้าตัวตั้งเองทันที
// ที่เข้ามา ผู้ดูแลจึงไม่ได้ถือรหัสของใครค้างไว้ (ถ้าถือไว้ ลายเซ็น/การลงนาม "ทราบ" ของคนนั้นจะพิสูจน์
// ตัวตนไม่ได้จริง เพราะมีคนอื่นเข้าบัญชีได้ด้วย) และเตะเซสชันที่ค้างอยู่ออกให้หมดพร้อมกัน
router.post('/admin/users/:id/reset-password', requireApi(async (ctx) => {
  if (!ctx.user.roleCodes.includes('admin')) return json(ctx, 403, { error: 'เฉพาะผู้ดูแลระบบเท่านั้น' });
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(ctx.params.id);
  if (!target) return json(ctx, 404, { error: 'ไม่พบผู้ใช้นี้' });

  const password = generatePassword();
  const pin = generatePin();
  // ต้องปลดล็อกบัญชีพร้อมกันเสมอ — ถ้าคนนั้นกรอกรหัสผิดครบ 5 ครั้งจนถูกล็อก 15 นาที (ซึ่งเป็นสาเหตุ
  // ที่คนมาขอให้รีเซ็ตรหัสบ่อยที่สุด) การให้รหัสใหม่อย่างเดียวไม่ช่วยอะไรเลย เพราะตัวล็อกไม่ได้ดูรหัสผ่าน
  // เจ้าตัวจะยังเข้าไม่ได้อยู่ดีโดยที่ผู้ดูแลไม่มีทางปลดล็อกให้ได้เลย
  db.prepare(`
    UPDATE users SET password_hash = ?, pin_hash = ?, must_change_password = 1,
      failed_login_count = 0, locked_until = NULL, updated_at = ? WHERE id = ?
  `).run(hashSecret(password), hashSecret(pin), nowIso(), target.id);
  const killed = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id).changes;
  audit({
    userId: ctx.user.id, action: 'user_password_reset', tableName: 'users', recordId: target.id,
    detail: { employeeCode: target.employee_code, revokedSessions: killed }, ip: ctx.ip,
  });
  json(ctx, 200, {
    ok: true, employeeCode: target.employee_code, password, pin,
    wasLocked: Boolean(target.locked_until),
    message: `ออกรหัสชั่วคราวให้ ${target.employee_code} แล้ว${target.locked_until ? ' และปลดล็อกบัญชีให้ด้วย' : ''} — เจ้าตัวจะต้องตั้งรหัสผ่านและ PIN ของตัวเองทันทีที่เข้าใช้งาน`,
  });
}));

// ---------------- แก้ไขข้อมูลผู้ใช้ ----------------
// เดิมทำได้แค่ "เพิ่ม" กับ "ลบ" เท่านั้น ครูย้ายฝ่าย เปลี่ยนตำแหน่ง ได้เลื่อนเป็นหัวหน้าฝ่าย หรือพิมพ์ชื่อผิด
// ตอนนำเข้าจาก Excel — ทั้งหมดนี้แก้ไม่ได้เลย ต้องลบทิ้งแล้วสร้างใหม่ ซึ่งทำให้ประวัติเอกสาร/ลายเซ็นเดิม
// ผูกอยู่กับบัญชีที่ถูกระงับไปแล้ว
//
// ทำเป็นหน้าแยกที่ส่งฟอร์มแบบธรรมดา ไม่ใช่ JavaScript ในหน้าเดิม — สคริปต์ที่ประกอบจาก template literal
// ของเซิร์ฟเวอร์เพิ่งทำให้ปุ่มทั้งหน้าตายมาแล้วครั้งหนึ่ง หน้าฟอร์มธรรมดาไม่มีทางพังแบบนั้น
const USER_STATUSES = { active: 'ใช้งาน', suspended: 'ระงับการใช้งาน' };

function userEditPage(ctx, target, { error, depts, roles, currentRoleId }) {
  return `
    <div class="card-header">
      <div>
        <h2 class="mt-0">✏️ แก้ไขข้อมูลผู้ใช้</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          รหัสประจำตัว <strong>${esc(target.employee_code)}</strong> — เปลี่ยนรหัสประจำตัวไม่ได้
          เพราะเป็นตัวอ้างอิงของประวัติเอกสารและลายเซ็นทั้งหมดที่ผ่านมา
        </p>
      </div>
      <a class="btn btn-outline" href="/admin/users">← กลับรายชื่อผู้ใช้</a>
    </div>
    <div class="card">
      ${error ? `<div class="alert alert-danger">${esc(error)}</div>` : ''}
      <form method="post" action="/admin/users/${target.id}/edit">
        <div class="form-grid cols-3">
          <div class="field"><label>คำนำหน้า</label>
            <input type="text" name="prefix" value="${esc(target.prefix || '')}" placeholder="นาย/นาง/นางสาว" /></div>
          <div class="field"><label>ชื่อ *</label>
            <input type="text" name="firstName" value="${esc(target.first_name)}" required /></div>
          <div class="field"><label>นามสกุล *</label>
            <input type="text" name="lastName" value="${esc(target.last_name)}" required /></div>
          <div class="field"><label>อีเมล</label>
            <input type="email" name="email" value="${esc(target.email || '')}" /></div>
          <div class="field"><label>ตำแหน่ง</label>
            ${positionInput({ name: 'position', value: target.position || '', listId: 'posEdit' })}</div>
          <div class="field"><label>ฝ่าย</label>
            <select name="departmentId">
              <option value="">— ไม่ระบุ —</option>
              ${depts.map((d) => `<option value="${d.id}" ${d.id === target.department_id ? 'selected' : ''}>${esc(d.name)}</option>`).join('')}
            </select></div>
          <div class="field"><label>บทบาท *</label>
            <select name="roleId" required>
              ${roles.map((r) => `<option value="${r.id}" ${r.id === currentRoleId ? 'selected' : ''}>${esc(r.name_th)}</option>`).join('')}
            </select></div>
          <div class="field"><label>สถานะ</label>
            <select name="status">
              ${Object.entries(USER_STATUSES).map(([k, v]) => `<option value="${k}" ${k === target.status ? 'selected' : ''}>${esc(v)}</option>`).join('')}
            </select>
            <div class="help-text">บัญชีที่ระงับจะเข้าใช้งานไม่ได้ทันที แต่ประวัติเอกสารและลายเซ็นเดิมยังอยู่ครบ</div></div>
        </div>
        <button class="btn btn-primary" type="submit">บันทึกการแก้ไข</button>
        <a class="btn btn-outline" href="/admin/users">ยกเลิก</a>
      </form>
    </div>`;
}

function loadUserForEdit(id) {
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(id);
  if (!target) return null;
  const currentRoleId = db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? LIMIT 1').get(id)?.role_id || null;
  return {
    target, currentRoleId,
    depts: db.prepare('SELECT * FROM departments ORDER BY name').all(),
    roles: db.prepare('SELECT * FROM roles ORDER BY level DESC').all(),
  };
}

router.get('/admin/users/:id/edit', requireRole('admin')(requirePage((ctx) => {
  const loaded = loadUserForEdit(ctx.params.id);
  if (!loaded) return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบผู้ใช้', path: '/admin/users', content: emptyState('🔍', 'ไม่พบผู้ใช้นี้') }));
  html(ctx, 200, layout({
    user: ctx.user, title: 'แก้ไขผู้ใช้', path: '/admin/users',
    content: userEditPage(ctx, loaded.target, loaded),
  }));
})));

router.post('/admin/users/:id/edit', requireRole('admin')(requirePage((ctx) => {
  const loaded = loadUserForEdit(ctx.params.id);
  if (!loaded) return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบผู้ใช้', path: '/admin/users', content: emptyState('🔍', 'ไม่พบผู้ใช้นี้') }));
  const { target } = loaded;
  const b = ctx.body;
  const fail = (error) => html(ctx, 400, layout({
    user: ctx.user, title: 'แก้ไขผู้ใช้', path: '/admin/users',
    content: userEditPage(ctx, { ...target, ...pendingEdit(b, target) }, { ...loaded, error, currentRoleId: b.roleId || loaded.currentRoleId }),
  }));

  const firstName = (b.firstName || '').trim();
  const lastName = (b.lastName || '').trim();
  if (!firstName || !lastName) return fail('กรุณากรอกชื่อและนามสกุล');
  for (const [value, max, label] of [[b.prefix, 50, 'คำนำหน้า'], [firstName, 100, 'ชื่อ'], [lastName, 100, 'นามสกุล'],
    [b.email, 200, 'อีเมล'], [b.position, 200, 'ตำแหน่ง']]) {
    if (typeof value === 'string' && value.length > max) return fail(`${label}ยาวเกินไป (จำกัดไม่เกิน ${max} ตัวอักษร)`);
  }
  const departmentId = (b.departmentId || '').trim() || null;
  if (departmentId && !db.prepare('SELECT 1 x FROM departments WHERE id = ?').get(departmentId)) return fail('ไม่พบฝ่ายที่เลือก');
  const role = db.prepare('SELECT * FROM roles WHERE id = ?').get(b.roleId);
  if (!role) return fail('กรุณาเลือกบทบาท');
  const status = b.status in USER_STATUSES ? b.status : target.status;

  // กันไม่ให้ผู้ดูแลระบบคนสุดท้ายถอดบทบาทตัวเองหรือระงับตัวเอง — ถ้าปล่อยไว้จะไม่เหลือใครเข้าหน้า
  // จัดการผู้ใช้ได้อีกเลย ต้องไปกู้คืนผ่าน environment variable อย่างเดียว (ดู DEPLOY.md)
  const wasAdmin = db.prepare(`
    SELECT 1 x FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.name = 'admin'
  `).get(target.id);
  if (wasAdmin && (role.name !== 'admin' || status !== 'active')) {
    const adminCount = db.prepare(`
      SELECT COUNT(DISTINCT u.id) c FROM users u
      JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
      WHERE r.name = 'admin' AND u.deleted_at IS NULL AND u.status = 'active'
    `).get().c;
    if (adminCount <= 1) return fail('ต้องมีผู้ดูแลระบบที่ใช้งานได้อย่างน้อย 1 คนเสมอ — กรุณาตั้งผู้ดูแลระบบคนอื่นก่อน');
  }

  try {
    db.prepare(`
      UPDATE users SET prefix = ?, first_name = ?, last_name = ?, email = ?, position = ?,
        department_id = ?, status = ?, updated_at = ? WHERE id = ?
    `).run((b.prefix || '').trim() || null, firstName, lastName, (b.email || '').trim() || null,
      (b.position || '').trim() || null, departmentId, status, nowIso(), target.id);
  } catch (e) {
    return fail('อีเมลนี้ถูกใช้งานโดยผู้ใช้อื่นแล้ว');
  }
  // บทบาทเก็บเป็นตาราง many-to-many แต่หน้านี้ให้เลือกได้บทบาทเดียว จึงล้างของเดิมแล้วใส่ใหม่
  db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(target.id);
  db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(target.id, role.id);
  // บัญชีที่ถูกระงับต้องหลุดออกจากระบบทันที ไม่ใช่ใช้ต่อได้จนกว่าเซสชันจะหมดอายุเอง
  if (status !== 'active') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);

  audit({
    userId: ctx.user.id, action: 'user_updated', tableName: 'users', recordId: target.id,
    detail: { employeeCode: target.employee_code, role: role.name, status }, ip: ctx.ip,
  });
  redirect(ctx, '/admin/users?updated=1');
})));

// ค่าที่ผู้ใช้เพิ่งกรอกมา ใช้เติมกลับลงฟอร์มเมื่อบันทึกไม่ผ่าน จะได้ไม่ต้องพิมพ์ใหม่ทั้งหมด
function pendingEdit(b, target) {
  return {
    prefix: b.prefix ?? target.prefix,
    first_name: b.firstName ?? target.first_name,
    last_name: b.lastName ?? target.last_name,
    email: b.email ?? target.email,
    position: b.position ?? target.position,
    department_id: b.departmentId ?? target.department_id,
    status: b.status ?? target.status,
  };
}

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
    </div>

    ${enabled && connected ? `
    <div class="card">
      <h3 class="mt-0">🧹 ล้างไฟล์ที่ไม่มีเจ้าของ</h3>
      <p class="text-muted" style="font-size:.85rem">
        ตรวจหาไฟล์บน Drive ที่ไม่มีหนังสือฉบับไหนในระบบอ้างถึงแล้ว — ส่วนใหญ่เป็นไฟล์ประทับตราชั้นเก่า
        ที่ค้างมาจากเวอร์ชันก่อน (ตอนนี้ระบบเก็บไฟล์ประทับตราไว้ฉบับเดียวเสมอแล้ว) และไฟล์ของหนังสือที่ถูกลบถาวรไป
        <br/><strong>ไม่แตะโฟลเดอร์สำเนาฐานข้อมูล</strong> — จัดการแยกที่หน้า "สำเนาสำรองข้อมูล"
      </p>
      <button class="btn btn-outline" onclick="scanOrphans(this)">🔍 ตรวจหาไฟล์ที่ไม่มีเจ้าของ</button>
      <div id="orphanResult" style="margin-top:1rem"></div>
    </div>
    <script>
      window.scanOrphans = async function (btn) {
        window.setBtnLoading(btn);
        var box = document.getElementById('orphanResult');
        try {
          var res = await fetch('/admin/google-drive/orphans');
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'ตรวจไม่สำเร็จ');
          window.restoreBtn(btn);
          if (!data.files.length) { box.innerHTML = '<div class="alert alert-success">ไม่พบไฟล์ที่ไม่มีเจ้าของ — สะอาดดีอยู่แล้ว</div>'; return; }
          var mb = (data.totalBytes / 1048576).toFixed(2);
          box.innerHTML = '<div class="alert alert-warning">พบ <strong>' + data.files.length + '</strong> ไฟล์ที่ไม่มีเจ้าของ รวม ' + mb + ' MB</div>' +
            '<div class="table-wrap"><table><thead><tr><th>ไฟล์</th><th>อยู่ใน</th><th>ขนาด</th></tr></thead><tbody>' +
            data.files.map(function (f) {
              return '<tr><td style="word-break:break-all">' + f.name + '</td><td>' + f.yearName + ' / ' + f.categoryName +
                '</td><td>' + Math.round((f.size || 0) / 1024) + ' KB</td></tr>';
            }).join('') + '</tbody></table></div>' +
            '<button class="btn btn-outline btn-sm" style="margin-top:.8rem;color:var(--danger);border-color:var(--danger)" onclick="deleteOrphans(this)">🗑️ ลบทั้งหมด ' + data.files.length + ' ไฟล์</button>';
        } catch (e) { window.restoreBtn(btn); box.innerHTML = '<div class="alert alert-danger">' + e.message + '</div>'; }
      };
      window.deleteOrphans = async function (btn) {
        if (!confirm('ยืนยันลบไฟล์ที่ไม่มีเจ้าของทั้งหมด?\\n\\nลบแล้วเรียกคืนไม่ได้')) return;
        var pin = await window.askPin('ยืนยัน PIN เพื่อลบไฟล์ที่ไม่มีเจ้าของ');
        if (!pin) return;
        window.setBtnLoading(btn);
        try {
          var res = await fetch('/admin/google-drive/orphans/delete', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: pin }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'ลบไม่สำเร็จ');
          window.toast('ลบไปแล้ว ' + data.deleted + ' ไฟล์' + (data.failed ? ' (ลบไม่สำเร็จ ' + data.failed + ' ไฟล์)' : ''), 'success');
          document.getElementById('orphanResult').innerHTML = '';
        } catch (e) { window.toast(e.message, 'danger'); }
        window.restoreBtn(btn);
      };
    </script>` : ''}`;
  html(ctx, 200, layout({ user: ctx.user, title: 'เชื่อมต่อ Google Drive', path: '/admin/google-drive', content }));
})));

router.get('/admin/google-drive/orphans', requireRole('admin')(requireApi(async (ctx) => {
  if (!isGoogleDriveEnabled() || !isGoogleDriveConnected()) return json(ctx, 400, { error: 'ยังไม่ได้เชื่อมต่อ Google Drive' });
  const files = await findOrphanDriveFiles();
  json(ctx, 200, {
    files: files.map((f) => ({ id: f.id, name: f.name, size: Number(f.size || 0), yearName: f.yearName, categoryName: f.categoryName })),
    totalBytes: files.reduce((s, f) => s + Number(f.size || 0), 0),
  });
})));

router.post('/admin/google-drive/orphans/delete', requireRole('admin')(requireApi(async (ctx) => {
  if (!isGoogleDriveEnabled() || !isGoogleDriveConnected()) return json(ctx, 400, { error: 'ยังไม่ได้เชื่อมต่อ Google Drive' });
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, ctx.body.pin)) return json(ctx, 401, { error: 'PIN ไม่ถูกต้อง' });

  // ตรวจหาใหม่ตรงนี้อีกครั้ง ไม่ใช้รายการที่ฝั่งเว็บส่งกลับมา — ระหว่างที่ผู้ใช้อ่านผลแล้วกดยืนยัน อาจมี
  // คนอื่นแนบไฟล์/ประทับตราเพิ่ม ไฟล์ที่เพิ่งกลายเป็น "มีเจ้าของ" จะได้ไม่ถูกลบทิ้งตามรายการเก่า
  // และผู้ใช้จะสั่งลบ id อะไรก็ได้ตามใจไม่ได้ด้วย
  const files = await findOrphanDriveFiles();
  let deleted = 0;
  let failed = 0;
  for (const f of files) {
    try { await deleteFile(f.id); deleted++; } catch { failed++; }
  }
  audit({ userId: ctx.user.id, action: 'drive_orphans_deleted', tableName: 'google_drive', recordId: null, detail: { deleted, failed } });
  json(ctx, 200, { deleted, failed });
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

// ---------------- นำเข้ารายชื่อบุคลากรจาก Excel/CSV ----------------
router.get('/admin/users/template.csv', requireRole('admin')(requirePage((ctx) => {
  const body = Buffer.from(templateCsv(), 'utf8');
  ctx.res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': body.length,
    'Content-Disposition': contentDispositionHeader('ตัวอย่างรายชื่อบุคลากร.csv', 'user-import-template.csv', 'attachment'),
  });
  ctx.res.end(body);
})));

// ตรวจไฟล์แล้วบอกว่าจะเกิดอะไรขึ้น โดยยังไม่เขียนอะไรลงฐานข้อมูล — แอดมินได้ตรวจก่อนกดยืนยันจริง
// (สร้างบัญชีผิด 50 บัญชีแล้วมาไล่ลบทีหลังเจ็บปวดกว่าตรวจก่อนมาก)
router.post('/admin/users/import/preview', requireRole('admin')(requireApi(async (ctx) => {
  const plan = buildPlan(ctx.body);
  json(ctx, 200, plan);
})));

router.post('/admin/users/import', requireRole('admin')(requireApi(async (ctx) => {
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, ctx.body.pin)) return json(ctx, 401, { error: 'PIN ไม่ถูกต้อง' });
  const plan = buildPlan(ctx.body);
  if (!plan.summary.ok) return json(ctx, 400, { error: 'ไม่มีรายชื่อที่นำเข้าได้ในไฟล์นี้' });
  const created = applyUserImport(plan.items, ctx.user.id);
  json(ctx, 201, { created, summary: plan.summary });
})));

// อ่านไฟล์แล้ววางแผนใหม่ทุกครั้ง ไม่รับรายการที่ฝั่งเว็บส่งกลับมา — ระหว่างที่แอดมินอ่านผลตรวจแล้วกดยืนยัน
// อาจมีคนเพิ่มผู้ใช้รหัสเดียวกันไปแล้ว และเพื่อไม่ให้คำขอที่ยิงเองสร้างบัญชีอะไรก็ได้ตามใจ
function buildPlan(body) {
  if (!body.fileDataBase64) throw httpError(400, 'ไม่พบไฟล์');
  const buffer = Buffer.from(body.fileDataBase64, 'base64');
  if (buffer.length > 5 * 1024 * 1024) throw httpError(413, 'ไฟล์ใหญ่เกิน 5MB');
  const rows = readTable(buffer, body.fileName || '');
  return planUserImport(rows, {
    departments: db.prepare('SELECT id, name FROM departments').all(),
    roles: db.prepare('SELECT id, name, name_th FROM roles').all(),
    existingCodes: db.prepare('SELECT employee_code FROM users WHERE deleted_at IS NULL').all().map((u) => u.employee_code),
  });
}
