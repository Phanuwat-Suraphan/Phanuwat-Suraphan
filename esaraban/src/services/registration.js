// ครูกดลงทะเบียนเองได้ แต่ผู้ดูแลเป็นคนรับรองตัวตนก่อนบัญชีจะใช้งานได้จริง
//
// ปัญหาเดิม: บัญชีทุกใบต้องให้ผู้ดูแลสร้างเองทีละคน แล้วส่งรหัสชั่วคราวให้เจ้าตัวทางไลน์ ซึ่งช้า
// ติดคอขวดที่คนคนเดียว และรหัสผ่านของครูเดินทางผ่านแชทซึ่งไม่ควรเกิดขึ้นเลย
//
// วิธีใหม่: ครูกรอกเอง ตั้งรหัสผ่านและ PIN ของตัวเองตั้งแต่แรก แล้วคำขอไปพักรอผู้ดูแลกด "อนุมัติ"
// ผู้ดูแลจึงไม่เคยรู้รหัสของใครเลย และยังคุมได้เต็มที่ว่าใครเข้าระบบได้ ใครอยู่ฝ่ายไหน บทบาทอะไร
//
// สิ่งที่ห้ามพลาดในไฟล์นี้:
//   1. คำขอ "ไม่ใช่" บัญชี — ตราบใดที่ยังไม่อนุมัติ ต้องล็อกอินไม่ได้เด็ดขาด
//   2. บทบาทที่ขอมาเป็นแค่คำขอ ผู้ดูแลเป็นคนเลือกของจริงตอนกดอนุมัติ ไม่งั้นใครก็ขอเป็นแอดมินได้
//   3. หน้าลงทะเบียนเปิดสาธารณะ จึงต้องไม่คายข้อมูลว่าใครมีบัญชีอยู่แล้วบ้าง
import { db, uuid, nowIso, hashSecret, audit, isWeakPin } from '../db.js';
import { httpError, assertMaxLength } from './validate.js';
import { notifyUser } from './notify.js';

// บทบาทที่ครูขอเองได้ — จงใจไม่มี admin/director/vice_director เพราะเป็นตำแหน่งที่โรงเรียนแต่งตั้ง
// ไม่ใช่สิ่งที่ประกาศตัวเองได้ ถึงจะมีผู้ดูแลกดอนุมัติอีกชั้นก็ตาม การเห็นคำขอ "ขอเป็นผู้อำนวยการ"
// ในรายการรอตรวจ เป็นการชวนให้กดผิดโดยไม่จำเป็น
export const SELF_REQUESTABLE_ROLES = ['teacher', 'registrar', 'head'];

const MAX_NAME = 100;
const MAX_NOTE = 300;

// กันคนกดซ้ำและกันสแปมจากหน้าเว็บสาธารณะ — คำขอที่ยังรอตรวจเยอะเกินนี้ ผู้ดูแลก็ตรวจไม่ไหวอยู่ดี
// และเป็นสัญญาณว่ามีคนยิงฟอร์มรัวๆ มากกว่าจะเป็นครูสมัครจริง
const MAX_PENDING = 200;

/** เปิดให้ลงทะเบียนเองหรือไม่ — โรงเรียนที่ไม่ต้องการก็ปิดได้ด้วย env var */
export function selfRegistrationEnabled() {
  return String(process.env.SELF_REGISTRATION || '').trim() !== 'off';
}

function cleanText(v, max, label) {
  const s = typeof v === 'string' ? v.trim() : '';
  assertMaxLength(s, max, label);
  return s;
}

/**
 * รับคำขอลงทะเบียนจากหน้าเว็บสาธารณะ
 *
 * คืนค่าเหมือนกันเสมอไม่ว่ารหัสพนักงานนั้นจะมีบัญชีอยู่แล้วหรือยัง — หน้านี้ใครก็เปิดได้ ถ้าตอบต่างกัน
 * ก็กลายเป็นเครื่องมือไล่เดาว่าใครมีบัญชีในระบบบ้าง ซึ่งเป็นข้อมูลบุคลากรของโรงเรียน
 * (ผู้ดูแลจะเห็นในรายการรอตรวจเองว่าคำขอนี้ซ้ำกับบัญชีที่มีอยู่)
 */
export function submitRegistration(input, { ip } = {}) {
  if (!selfRegistrationEnabled()) throw httpError(403, 'โรงเรียนนี้ปิดการลงทะเบียนด้วยตัวเองไว้ — ติดต่อผู้ดูแลระบบเพื่อขอบัญชี');

  const employeeCode = cleanText(input?.employeeCode, 50, 'รหัสพนักงาน');
  const firstName = cleanText(input?.firstName, MAX_NAME, 'ชื่อ');
  const lastName = cleanText(input?.lastName, MAX_NAME, 'นามสกุล');
  const prefix = cleanText(input?.prefix, 30, 'คำนำหน้า');
  const email = cleanText(input?.email, MAX_NAME, 'อีเมล');
  const position = cleanText(input?.position, MAX_NAME, 'ตำแหน่ง');
  const note = cleanText(input?.note, MAX_NOTE, 'ข้อความถึงผู้ดูแล');
  const departmentId = cleanText(input?.departmentId, 64, 'ฝ่าย');
  const password = typeof input?.password === 'string' ? input.password : '';
  const pin = typeof input?.pin === 'string' ? input.pin.trim() : '';

  if (!employeeCode || !firstName || !lastName || !departmentId) {
    throw httpError(400, 'กรุณากรอกรหัสพนักงาน ชื่อ นามสกุล และฝ่ายให้ครบ');
  }
  if (password.length < 8) throw httpError(400, 'รหัสผ่านต้องมีอย่างน้อย 8 ตัวอักษร');
  if (!/^\d{6}$/.test(pin)) throw httpError(400, 'PIN ต้องเป็นตัวเลข 6 หลัก');
  // เกณฑ์เดียวกับตอนตั้ง PIN ที่อื่นในระบบ — PIN ใช้แทนการลงลายมือชื่อ จึงห้ามอ่อนตั้งแต่วันแรก
  if (isWeakPin(pin)) throw httpError(400, 'PIN นี้เดาง่ายเกินไป — ห้ามใช้เลขซ้ำทั้งหมด (111111) หรือเลขเรียงติดกัน (123456)');
  if (!db.prepare('SELECT 1 x FROM departments WHERE id = ?').get(departmentId)) {
    throw httpError(400, 'ไม่พบฝ่ายที่เลือก');
  }

  const requestedRole = SELF_REQUESTABLE_ROLES.includes(input?.requestedRole) ? input.requestedRole : 'teacher';

  const pending = db.prepare("SELECT COUNT(*) c FROM registration_requests WHERE status = 'pending'").get().c;
  if (pending >= MAX_PENDING) {
    throw httpError(429, 'ตอนนี้มีคำขอรอตรวจอยู่เป็นจำนวนมาก กรุณาติดต่อผู้ดูแลระบบโดยตรง');
  }
  // กดปุ่มซ้ำ/กรอกซ้ำด้วยรหัสพนักงานเดิมที่ยังรอตรวจอยู่ — ไม่ต้องสร้างแถวใหม่ให้ผู้ดูแลต้องมานั่งลบ
  const already = db.prepare("SELECT id FROM registration_requests WHERE employee_code = ? AND status = 'pending'").get(employeeCode);
  if (already) return { ok: true, duplicate: true };

  const id = uuid();
  db.prepare(`
    INSERT INTO registration_requests
      (id, employee_code, prefix, first_name, last_name, email, position, department_id, requested_role,
       password_hash, pin_hash, note, status, ip, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `).run(id, employeeCode, prefix || null, firstName, lastName, email || null, position || null, departmentId,
    requestedRole, hashSecret(password), hashSecret(pin), note || null, ip || null, nowIso());

  // ไม่ใส่รหัสผ่าน/PIN ลง audit เด็ดขาด แม้แต่แบบแฮช — ผู้ดูแลอ่าน audit log ได้
  audit({ userId: null, action: 'registration_requested', tableName: 'registration_requests', recordId: id,
    detail: { employeeCode, requestedRole }, ip });

  // บอกผู้ดูแลทันที ไม่ใช่รอให้บังเอิญเปิดหน้านั้นเจอเอง — ครูที่ยื่นคำขอแล้วเข้าระบบไม่ได้จะรอเก้อ
  // และไปสรุปว่าระบบใช้ไม่ได้ ถ้าผู้ดูแลเชื่อมบัญชีไลน์ไว้ ข้อความจะเด้งเข้าไลน์ให้ด้วยโดยอัตโนมัติ
  // (notifyUser ต่อเข้าคิวไลน์ให้อยู่แล้ว) — ไม่ใส่ชื่อ-สกุลลงในข้อความ เพราะข้อความไลน์เป็นข้อมูล
  // ที่ยังไม่ได้ผ่านการรับรองตัวตน ใครกรอกอะไรมาก็ได้ ส่งแค่ว่ามีคำขอใหม่พร้อมลิงก์ให้เข้ามาดูในระบบ
  for (const admin of db.prepare(`
    SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
    WHERE r.name = 'admin' AND u.deleted_at IS NULL AND u.status = 'active'
  `).all()) {
    notifyUser({
      userId: admin.id, linkUrl: '/admin/registrations',
      title: 'มีคำขอลงทะเบียนใหม่รอตรวจสอบ',
      message: 'เปิดระบบเพื่อตรวจสอบตัวตนและอนุมัติ',
    });
  }
  return { ok: true, duplicate: false };
}

/** คำขอที่ยังรอตรวจ พร้อมธงว่าชนกับบัญชีที่มีอยู่แล้วหรือไม่ — ผู้ดูแลต้องเห็นก่อนกดอนุมัติ */
export function listPendingRegistrations(limit = 100) {
  return db.prepare(`
    SELECT r.*, d.name AS department_name,
      (SELECT u.id FROM users u WHERE u.employee_code = r.employee_code AND u.deleted_at IS NULL) AS clashes_with
    FROM registration_requests r
    LEFT JOIN departments d ON d.id = r.department_id
    WHERE r.status = 'pending' ORDER BY r.created_at LIMIT ?
  `).all(limit);
}

export function countPendingRegistrations() {
  return db.prepare("SELECT COUNT(*) c FROM registration_requests WHERE status = 'pending'").get().c;
}

export function recentReviewedRegistrations(limit = 20) {
  return db.prepare(`
    SELECT r.*, d.name AS department_name, u.first_name AS reviewer_first, u.last_name AS reviewer_last
    FROM registration_requests r
    LEFT JOIN departments d ON d.id = r.department_id
    LEFT JOIN users u ON u.id = r.reviewed_by
    WHERE r.status != 'pending' ORDER BY r.reviewed_at DESC LIMIT ?
  `).all(limit);
}

/**
 * ผู้ดูแลกดอนุมัติ — สร้างบัญชีจริงจากคำขอ
 *
 * roleId มาจากผู้ดูแลเสมอ ไม่ใช่จากคำขอ (requested_role เป็นแค่ข้อมูลประกอบการตัดสินใจ) ไม่งั้น
 * การเปิดให้ลงทะเบียนเองก็เท่ากับเปิดให้ตั้งบทบาทตัวเองได้ ซึ่งทำให้ทั้งระบบสิทธิ์ไม่มีความหมาย
 */
export function approveRegistration({ requestId, roleId, departmentId, actorUser }) {
  const req = db.prepare("SELECT * FROM registration_requests WHERE id = ? AND status = 'pending'").get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้ หรือมีคนตรวจไปแล้ว');
  const role = db.prepare('SELECT id, name FROM roles WHERE id = ?').get(roleId);
  if (!role) throw httpError(400, 'กรุณาเลือกบทบาทให้ผู้ใช้รายนี้');
  const deptId = departmentId || req.department_id;
  if (!db.prepare('SELECT 1 x FROM departments WHERE id = ?').get(deptId)) throw httpError(400, 'ไม่พบฝ่ายที่เลือก');

  const userId = uuid();
  // ทั้งการสร้างบัญชี ผูกบทบาท และปิดคำขอ ต้องสำเร็จหรือล้มเหลวไปด้วยกัน — ถ้าสร้างบัญชีแล้วแต่ปิด
  // คำขอไม่สำเร็จ ผู้ดูแลจะเห็นคำขอเดิมค้างอยู่แล้วกดอนุมัติซ้ำ จนได้บัญชีซ้ำหรือ error รหัสพนักงานชน
  db.exec('BEGIN IMMEDIATE');
  try {
    // ตรวจรหัสพนักงานชนกันในธุรกรรมเดียวกับที่ INSERT — ถ้าตรวจไว้ข้างนอก คำขอสองใบที่รหัสเดียวกัน
    // ถูกกดอนุมัติพร้อมกันจะผ่านด่านทั้งคู่ แล้วไปล้มที่ unique index โดยไม่มีข้อความที่อ่านรู้เรื่อง
    if (db.prepare('SELECT 1 x FROM users WHERE employee_code = ? AND deleted_at IS NULL').get(req.employee_code)) {
      throw httpError(409, `รหัสพนักงาน ${req.employee_code} มีบัญชีอยู่แล้ว — ถ้าเป็นคนเดียวกันให้ปฏิเสธคำขอนี้แล้วรีเซ็ตรหัสให้บัญชีเดิมแทน`);
    }
    db.prepare(`
      INSERT INTO users (id, employee_code, prefix, first_name, last_name, email, position, department_id,
        password_hash, pin_hash, status, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?)
    `).run(userId, req.employee_code, req.prefix, req.first_name, req.last_name, req.email, req.position, deptId,
      // ไม่บังคับเปลี่ยนรหัสตอนเข้าครั้งแรก (must_change_password = 0) เพราะรหัสนี้เจ้าตัวตั้งเองมาแต่ต้น
      // ไม่มีใครอื่นเคยรู้ ซึ่งต่างจากบัญชีที่ผู้ดูแลออกรหัสชั่วคราวให้
      req.password_hash, req.pin_hash, nowIso(), nowIso());
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(userId, role.id);
    db.prepare(`
      UPDATE registration_requests SET status = 'approved', reviewed_by = ?, reviewed_at = ?, created_user_id = ?
      WHERE id = ?
    `).run(actorUser.id, nowIso(), userId, req.id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  audit({ userId: actorUser.id, action: 'registration_approved', tableName: 'registration_requests', recordId: req.id,
    detail: { employeeCode: req.employee_code, role: role.name, createdUserId: userId } });
  return { userId, employeeCode: req.employee_code };
}

export function rejectRegistration({ requestId, reason, actorUser }) {
  const req = db.prepare("SELECT * FROM registration_requests WHERE id = ? AND status = 'pending'").get(requestId);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้ หรือมีคนตรวจไปแล้ว');
  const clean = typeof reason === 'string' ? reason.trim().slice(0, MAX_NOTE) : '';
  db.prepare(`
    UPDATE registration_requests SET status = 'rejected', reviewed_by = ?, reviewed_at = ?, reject_reason = ?
    WHERE id = ?
  `).run(actorUser.id, nowIso(), clean || null, req.id);
  audit({ userId: actorUser.id, action: 'registration_rejected', tableName: 'registration_requests', recordId: req.id,
    detail: { employeeCode: req.employee_code, reason: clean } });
  return { ok: true };
}
