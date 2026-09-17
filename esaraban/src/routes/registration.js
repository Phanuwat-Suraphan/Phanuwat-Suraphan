// หน้าลงทะเบียนด้วยตัวเองของครู และหน้าตรวจ/อนุมัติของผู้ดูแล
import { router, html, json, redirect } from '../router.js';
import { layout, esc, fmtDate, schoolName } from '../render.js';
import { requireApi, requireRole, requirePage } from '../middleware.js';
import { db } from '../db.js';
import { positionInput } from '../services/positions.js';
import { lineShareUrl } from '../services/line.js';
import {
  submitRegistration, listPendingRegistrations, recentReviewedRegistrations,
  approveRegistration, rejectRegistration, selfRegistrationEnabled, SELF_REQUESTABLE_ROLES,
  purgeOldReviewedRegistrations,
} from '../services/registration.js';

const ADMIN_ONLY = requireRole('admin');

const ROLE_LABEL = { teacher: 'ครู', registrar: 'เจ้าหน้าที่ธุรการ', head: 'หัวหน้าฝ่าย' };

function departments() {
  return db.prepare('SELECT id, name FROM departments ORDER BY name').all();
}

// ───────────────────────────── หน้าสาธารณะ: ครูกรอกเอง ─────────────────────────────

function registerPage({ error, done, values = {} } = {}) {
  if (done) {
    return `<div class="login-wrap"><div class="login-card"><div class="login-form-panel" style="max-width:520px">
      <h2 style="margin-top:0">✅ ส่งคำขอเรียบร้อยแล้ว</h2>
      <p>คำขอของคุณถูกส่งให้ผู้ดูแลระบบของโรงเรียนตรวจสอบแล้ว</p>
      <div class="callout-tip">
        <strong>ระหว่างนี้ยังเข้าใช้งานไม่ได้</strong> — ต้องรอผู้ดูแลกดอนุมัติก่อน
        เมื่ออนุมัติแล้วให้เข้าสู่ระบบด้วย<strong>รหัสพนักงานและรหัสผ่านที่คุณเพิ่งตั้งไว้เอง</strong>
        ได้เลย ไม่ต้องขอรหัสจากใครอีก
      </div>
      <p class="text-muted" style="font-size:.85rem">ถ้ารอนานผิดปกติ ให้แจ้งเจ้าหน้าที่ธุรการของโรงเรียนโดยตรง</p>
      <a class="btn btn-primary btn-block" href="/login">กลับไปหน้าเข้าสู่ระบบ</a>
    </div></div></div>`;
  }
  const v = (k) => esc(values[k] || '');
  return `<div class="login-wrap"><div class="login-card"><div class="login-form-panel" style="max-width:560px">
    <h2 style="margin-top:0">ลงทะเบียนขอใช้งานระบบ</h2>
    <p class="help-text" style="margin-top:-.3rem">
      กรอกข้อมูลของคุณแล้วตั้งรหัสผ่านกับ PIN ของตัวเอง จากนั้นผู้ดูแลระบบจะตรวจสอบและอนุมัติ
      — <strong>ไม่มีใครเห็นรหัสผ่านของคุณเลย แม้แต่ผู้ดูแล</strong>
    </p>
    ${error ? `<div class="alert alert-danger">
      <div>${esc(error)}</div>
      <!-- ต้องบอกเรื่องนี้ทุกครั้งที่ตีกลับ ไม่ใช่เฉพาะตอนที่รหัสผ่านเป็นต้นเหตุ — ระบบไม่ส่งรหัสผ่าน
           และ PIN กลับมาหน้าเว็บ (ตั้งใจ) ถ้าไม่บอก ครูจะแก้แต่สิ่งที่ข้อความพูดถึงแล้วกดส่งอีกครั้ง
           จากนั้นเบราว์เซอร์จะบล็อกที่ช่องรหัสผ่านที่ว่างอยู่ หน้าไม่ไปไหน กดกี่ครั้งก็เหมือนปุ่มเสีย -->
      <div style="margin-top:.5rem;font-size:.9rem">
        <strong>กรุณากรอกรหัสผ่านและ PIN ใหม่อีกครั้งด้วยครับ</strong> —
        สองช่องนี้ถูกล้างทุกครั้งที่ระบบตีกลับ เพื่อไม่ให้รหัสของคุณถูกส่งกลับมาแสดงบนหน้าเว็บ
      </div>
    </div>` : ''}
    <form method="post" action="/register">
      <div class="form-grid cols-2">
        <div class="field"><label>คำนำหน้า</label><input type="text" name="prefix" value="${v('prefix')}" placeholder="เช่น นาง, นาย" /></div>
        <div class="field"><label>รหัสพนักงาน / Username *</label><input type="text" name="employeeCode" value="${v('employeeCode')}" required placeholder="เช่น teacher012" /></div>
      </div>
      <div class="form-grid cols-2">
        <div class="field"><label>ชื่อ *</label><input type="text" name="firstName" value="${v('firstName')}" required /></div>
        <div class="field"><label>นามสกุล *</label><input type="text" name="lastName" value="${v('lastName')}" required /></div>
      </div>
      <div class="field"><label>ฝ่าย *</label>
        <select name="departmentId" required>
          <option value="">— เลือกฝ่าย —</option>
          ${departments().map((d) => `<option value="${esc(d.id)}"${values.departmentId === d.id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
        </select>
      </div>
      <div class="field"><label>ตำแหน่ง</label>${positionInput({ name: 'position', value: values.position || '', listId: 'posRegister' })}</div>
      <div class="field"><label>บทบาทที่ขอ</label>
        <select name="requestedRole">
          ${SELF_REQUESTABLE_ROLES.map((r) => `<option value="${r}"${values.requestedRole === r ? ' selected' : ''}>${esc(ROLE_LABEL[r] || r)}</option>`).join('')}
        </select>
        <div class="help-text">เป็นเพียงคำขอ — ผู้ดูแลระบบเป็นผู้กำหนดบทบาทจริงตอนอนุมัติ</div>
      </div>
      <div class="field"><label>อีเมล</label><input type="email" name="email" value="${v('email')}" /></div>
      <div class="field"><label for="regPassword">รหัสผ่าน (อย่างน้อย 8 ตัวอักษร) *</label>
        <input type="password" id="regPassword" name="password" minlength="8" required autocomplete="new-password"
          ${error ? 'autofocus' : ''} /></div>
      <div class="field"><label for="regPin">PIN 6 หลัก *</label>
        <input type="password" id="regPin" name="pin" inputmode="numeric" maxlength="6" required autocomplete="new-password" />
        <div class="help-text">ใช้แทนการลงลายมือชื่อเวลากด "ทราบ"/ลงนาม จึงต้องเป็นความลับเฉพาะตัว ห้ามใช้ 111111 หรือ 123456</div></div>
      <div class="field"><label>ข้อความถึงผู้ดูแล</label>
        <textarea name="note" rows="2" placeholder="เช่น ครูประจำชั้น ป.4 เพิ่งย้ายมาเทอมนี้">${v('note')}</textarea>
        <div class="help-text">ช่วยให้ผู้ดูแลยืนยันตัวตนคุณได้เร็วขึ้น</div></div>
      <button class="btn btn-primary btn-block" type="submit">ส่งคำขอลงทะเบียน</button>
    </form>
    <div class="text-muted" style="text-align:center;margin-top:1rem;font-size:.85rem">
      มีบัญชีอยู่แล้ว? <a href="/login">เข้าสู่ระบบ</a>
    </div>
  </div></div></div>`;
}

router.get('/register', (ctx) => {
  if (ctx.user) return redirect(ctx, '/');
  if (!selfRegistrationEnabled()) return redirect(ctx, '/login');
  html(ctx, 200, layout({ user: null, title: 'ลงทะเบียนขอใช้งาน', path: '/register', content: registerPage({ done: ctx.query.done === '1' }) }));
});

router.post('/register', (ctx) => {
  if (ctx.user) return redirect(ctx, '/');
  try {
    submitRegistration(ctx.body, { ip: ctx.ip });
  } catch (err) {
    const status = err.statusCode || 500;
    return html(ctx, status, layout({
      user: null, title: 'ลงทะเบียนขอใช้งาน', path: '/register',
      content: registerPage({ error: err.message, values: ctx.body || {} }),
    }));
  }
  // ตอบเหมือนกันเสมอ ไม่ว่าจะเป็นคำขอใหม่หรือกรอกซ้ำด้วยรหัสพนักงานเดิม — หน้านี้เปิดสาธารณะ
  // ถ้าตอบต่างกันก็ใช้ไล่เดาได้ว่ารหัสพนักงานไหนมีคนยื่นขอ/มีบัญชีอยู่แล้วบ้าง
  redirect(ctx, '/register?done=1');
});

// ───────────────────────────── หน้าผู้ดูแล: ตรวจและอนุมัติ ─────────────────────────────

router.get('/admin/registrations', ADMIN_ONLY(requirePage((ctx) => {
  // เก็บกวาดคำขอเก่าที่ตรวจไปแล้วตรงนี้ — เกิดนานๆ ครั้ง ไม่ต้องมีตัวจับเวลาแยก และเป็นจังหวะที่
  // ผู้ดูแลกำลังดูรายการอยู่พอดี (ดูเหตุผลเรื่องอายุการเก็บใน services/registration.js)
  purgeOldReviewedRegistrations();
  const pending = listPendingRegistrations();
  const reviewed = recentReviewedRegistrations();
  const roles = db.prepare('SELECT id, name, name_th FROM roles ORDER BY level DESC').all();
  const depts = departments();

  const registerUrl = `${ctx.req.headers['x-forwarded-proto'] || 'https'}://${ctx.req.headers.host || ''}/register`;
  const registerShareText = [
    `ลงทะเบียนขอใช้งานระบบสารบรรณอิเล็กทรอนิกส์ ${schoolName()}`,
    'กรอกข้อมูลและตั้งรหัสผ่านของตัวเองได้เลย แล้วรอผู้ดูแลระบบอนุมัติ',
    registerUrl,
  ].join('\n');

  const card = (r) => `
    <div class="card" id="req-${esc(r.id)}">
      <div class="card-header">
        <h3 class="mt-0">${esc(r.prefix || '')}${esc(r.first_name)} ${esc(r.last_name)}</h3>
        <span class="text-muted" style="font-size:.82rem">ยื่นเมื่อ ${esc(fmtDate(r.created_at))}</span>
      </div>
      ${r.clashes_with ? `<div class="alert alert-warning" style="font-size:.85rem">
        ⚠️ รหัสพนักงาน <strong>${esc(r.employee_code)}</strong> มีบัญชีอยู่ในระบบแล้ว —
        ถ้าเป็นคนเดียวกัน ให้<strong>ปฏิเสธคำขอนี้</strong>แล้วใช้ปุ่ม "ตั้งรหัสใหม่" ที่หน้าจัดการผู้ใช้แทน
      </div>` : ''}
      <table class="table-plain">
        <tr><td class="text-muted" style="white-space:nowrap">รหัสพนักงาน</td><td><strong>${esc(r.employee_code)}</strong></td></tr>
        <tr><td class="text-muted">ฝ่ายที่แจ้ง</td><td>${esc(r.department_name || '-')}</td></tr>
        <tr><td class="text-muted">ตำแหน่ง</td><td>${esc(r.position || '-')}</td></tr>
        <tr><td class="text-muted">บทบาทที่ขอ</td><td>${esc(ROLE_LABEL[r.requested_role] || r.requested_role || '-')}</td></tr>
        ${r.email ? `<tr><td class="text-muted">อีเมล</td><td>${esc(r.email)}</td></tr>` : ''}
        ${r.note ? `<tr><td class="text-muted">ข้อความ</td><td>${esc(r.note)}</td></tr>` : ''}
      </table>
      <div class="form-grid cols-2" style="margin-top:.6rem">
        <div class="field"><label>บทบาทจริงที่จะให้</label>
          <select id="role-${esc(r.id)}">
            ${roles.map((x) => `<option value="${esc(x.id)}"${x.name === r.requested_role ? ' selected' : ''}>${esc(x.name_th)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><label>ฝ่าย</label>
          <select id="dept-${esc(r.id)}">
            ${depts.map((d) => `<option value="${esc(d.id)}"${d.id === r.department_id ? ' selected' : ''}>${esc(d.name)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="help-text">
        บทบาทที่ครูขอมาเป็นเพียงคำขอ — ค่าที่เลือกตรงนี้คือบทบาทจริงที่จะถูกบันทึก
        กรุณายืนยันตัวตนกับเจ้าตัวก่อนกดอนุมัติทุกครั้ง
      </div>
      <div class="chip-row" style="margin-top:.6rem">
        <button class="btn btn-success" onclick="approveReq('${esc(r.id)}', this)">✅ อนุมัติและสร้างบัญชี</button>
        <button class="btn btn-outline" onclick="rejectReq('${esc(r.id)}', this)">✖️ ปฏิเสธ</button>
      </div>
    </div>`;

  const content = `
    <h2>📝 คำขอลงทะเบียน</h2>
    <p class="text-muted" style="margin-top:-.5rem">
      ครูกรอกข้อมูลและตั้งรหัสผ่านของตัวเองมาแล้ว รอคุณรับรองว่าเป็นบุคลากรของโรงเรียนจริง
      — จนกว่าจะกดอนุมัติ คำขอเหล่านี้ยังเข้าใช้งานระบบไม่ได้
    </p>
    ${selfRegistrationEnabled() ? '' : `<div class="alert alert-warning">
      ปิดการลงทะเบียนด้วยตัวเองไว้ (<code>SELF_REGISTRATION=off</code>) — หน้าลงทะเบียนสาธารณะจะไม่เปิดให้กรอก
    </div>`}
    <div class="card">
      <h3 class="mt-0">ลิงก์สำหรับส่งให้ครู</h3>
      <div class="flex gap-2 items-center">
        <input type="text" id="regUrl" readonly value="${esc(registerUrl)}" style="flex:1" />
        <button class="btn btn-outline btn-sm" type="button" onclick="copyRegUrl()">คัดลอก</button>
      </div>
      <!-- ช่องทางที่โรงเรียนใช้สื่อสารกันจริงคือกลุ่มไลน์ — ปุ่มนี้เปิดหน้าต่างแชร์ของ LINE พร้อม
           ข้อความและลิงก์ให้เสร็จ ผู้ดูแลเลือกกลุ่มแล้วกดส่งได้เลย ไม่ต้องคัดลอกไปวางเอง
           (ใช้ตัวแชร์ตัวเดียวกับที่หน้าประกาศใช้อยู่แล้ว) -->
      <div class="chip-row" style="margin-top:.6rem">
        <a class="btn btn-primary btn-sm" href="${esc(lineShareUrl(registerShareText))}" target="_blank" rel="noopener">
          💬 ส่งลิงก์เข้ากลุ่มไลน์
        </a>
      </div>
      <div class="help-text">ครูกรอกเองแล้วมารอคุณอนุมัติที่หน้านี้ — ลิงก์นี้ใช้ซ้ำได้เรื่อยๆ ไม่มีวันหมดอายุ</div>
    </div>

    <h3>รอตรวจ ${pending.length ? `<span class="badge badge-warning">${pending.length}</span>` : ''}</h3>
    ${pending.length ? pending.map(card).join('') : '<div class="card"><p class="text-muted" style="margin:0">ไม่มีคำขอรอตรวจ</p></div>'}

    ${reviewed.length ? `
      <h3 style="margin-top:1.5rem">ตรวจไปแล้วล่าสุด</h3>
      <div class="card"><table class="table-plain">
        ${reviewed.map((r) => `<tr>
          <td style="white-space:nowrap">${esc(r.prefix || '')}${esc(r.first_name)} ${esc(r.last_name)}</td>
          <td class="text-muted" style="font-size:.85rem">${esc(r.employee_code)}</td>
          <td>${r.status === 'approved'
            ? '<span class="badge badge-success">อนุมัติแล้ว</span>'
            : `<span class="badge badge-muted">ปฏิเสธ</span>${r.reject_reason ? ` <span class="text-muted" style="font-size:.82rem">${esc(r.reject_reason)}</span>` : ''}`}</td>
          <td class="text-muted" style="font-size:.82rem;white-space:nowrap">${esc(fmtDate(r.reviewed_at))}${r.reviewer_first ? ` โดย ${esc(r.reviewer_first)} ${esc(r.reviewer_last)}` : ''}</td>
        </tr>`).join('')}
      </table></div>` : ''}

    <script>
      function copyRegUrl() {
        var el = document.getElementById('regUrl');
        el.select(); el.setSelectionRange(0, 99999);
        navigator.clipboard ? navigator.clipboard.writeText(el.value).then(function(){ toast('คัดลอกแล้ว', 'success'); })
          : toast('กด Ctrl+C เพื่อคัดลอก', 'info');
      }
      function approveReq(id, btn) {
        var roleId = document.getElementById('role-' + id).value;
        var departmentId = document.getElementById('dept-' + id).value;
        if (!confirm('ยืนยันว่าได้ตรวจสอบตัวตนของผู้ขอรายนี้แล้ว และต้องการสร้างบัญชีให้?')) return;
        window.setBtnLoading(btn, 'กำลังสร้างบัญชี...');
        fetch('/admin/registrations/' + id + '/approve', {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({ roleId: roleId, departmentId: departmentId }),
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(x){
            if (!x.ok) throw new Error(x.d.error);
            toast('สร้างบัญชีให้ ' + x.d.employeeCode + ' แล้ว', 'success');
            // ไม่รีโหลดทันที — ถ้ารีโหลด การ์ดนี้จะหายไปพร้อมกับปุ่มแจ้งครู แล้วผู้ดูแลจะไม่มีทาง
            // บอกเจ้าตัวได้เลยว่าอนุมัติแล้ว (ระบบส่งถึงมือเองไม่ได้ ดูเหตุผลใน routes/registration.js)
            showApproved(id, x.d);
          })
          .catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
      }
      function showApproved(id, d) {
        var card = document.getElementById('req-' + id);
        if (!card) { location.reload(); return; }
        card.innerHTML = '';
        var box = document.createElement('div');
        box.className = 'alert alert-success';

        var head = document.createElement('p');
        head.style.margin = '0 0 .5rem';
        head.innerHTML = '<strong>✅ สร้างบัญชีให้ ' + d.fullName + ' แล้ว</strong>';
        box.appendChild(head);

        var note = document.createElement('p');
        note.className = 'help-text';
        note.style.margin = '0 0 .6rem';
        note.textContent = 'เจ้าตัวยังไม่รู้ว่าอนุมัติแล้ว — ระบบส่งบอกเองไม่ได้ เพราะตอนสมัครยังไม่มีบัญชี'
          + ' จึงยังไม่มีไลน์ผูกไว้ กรุณาส่งบอกด้วยปุ่มนี้ (ข้อความไม่มีรหัสผ่านอยู่ในนั้น ส่งในกลุ่มได้)';
        box.appendChild(note);

        var row = document.createElement('div');
        row.className = 'chip-row';

        var line = document.createElement('a');
        line.className = 'btn btn-primary btn-sm';
        line.href = d.notifyLineUrl;
        line.target = '_blank';
        line.rel = 'noopener';
        line.textContent = '💬 แจ้งเจ้าตัวทางไลน์';
        row.appendChild(line);

        var copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'btn btn-outline btn-sm';
        copy.textContent = '📋 คัดลอกข้อความ';
        copy.onclick = function () {
          if (navigator.clipboard) navigator.clipboard.writeText(d.notifyText).then(function () { toast('คัดลอกแล้ว', 'success'); });
          else toast('เบราว์เซอร์นี้คัดลอกให้ไม่ได้ กรุณาเลือกข้อความเอง', 'info');
        };
        row.appendChild(copy);

        var done = document.createElement('button');
        done.type = 'button';
        done.className = 'btn btn-outline btn-sm';
        done.textContent = 'แจ้งแล้ว ปิดรายการนี้';
        done.onclick = function () { location.reload(); };
        row.appendChild(done);

        box.appendChild(row);

        var pre = document.createElement('pre');
        pre.style.cssText = 'white-space:pre-wrap;font-size:.82rem;margin:.6rem 0 0;opacity:.85';
        pre.textContent = d.notifyText;
        box.appendChild(pre);

        card.appendChild(box);
      }

      function rejectReq(id, btn) {
        var reason = prompt('เหตุผลที่ปฏิเสธ (ไม่บังคับ)');
        if (reason === null) return;
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        fetch('/admin/registrations/' + id + '/reject', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ reason: reason }),
        }).then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(x){
            if (!x.ok) throw new Error(x.d.error);
            location.reload();
          })
          .catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
      }
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'คำขอลงทะเบียน', path: '/admin/registrations', content }));
})));

router.post('/admin/registrations/:id/approve', ADMIN_ONLY(requireApi((ctx) => {
  const res = approveRegistration({
    requestId: ctx.params.id, roleId: ctx.body?.roleId, departmentId: ctx.body?.departmentId, actorUser: ctx.user,
  });
  // ข้อความสำเร็จรูปให้ผู้ดูแลส่งบอกเจ้าตัว — ระบบส่งถึงมือเองไม่ได้ เพราะตอนสมัครยังไม่มีบัญชีจึงยัง
  // ไม่มีไลน์ผูกไว้ และโรงเรียนไม่มีเซิร์ฟเวอร์อีเมล ช่องทางที่ใช้จริงคือผู้ดูแลส่งในไลน์ให้
  //
  // ห้ามมีรหัสผ่านอยู่ในข้อความเด็ดขาด — รหัสนั้นเจ้าตัวตั้งเองมาแต่ต้น ผู้ดูแลไม่เคยรู้และไม่ควรรู้
  // ข้อความนี้จึงมีแต่ข้อมูลที่ไม่เป็นความลับ ส่งในกลุ่มไลน์ของโรงเรียนได้โดยไม่มีอะไรรั่ว
  const loginUrl = `${ctx.req.headers['x-forwarded-proto'] || 'https'}://${ctx.req.headers.host || ''}/login`;
  const notifyText = [
    `✅ ${res.fullName} — บัญชีใช้งานระบบสารบรรณ ${schoolName()} ได้รับอนุมัติแล้ว`,
    `เข้าใช้งานได้ที่ ${loginUrl}`,
    `รหัสพนักงาน: ${res.employeeCode}`,
    'รหัสผ่านคือรหัสที่ตั้งไว้เองตอนลงทะเบียน (ระบบไม่เก็บไว้ให้ใครดู)',
  ].join('\n');
  json(ctx, 200, { ok: true, ...res, notifyText, notifyLineUrl: lineShareUrl(notifyText) });
})));

router.post('/admin/registrations/:id/reject', ADMIN_ONLY(requireApi((ctx) => {
  json(ctx, 200, rejectRegistration({ requestId: ctx.params.id, reason: ctx.body?.reason, actorUser: ctx.user }));
})));
