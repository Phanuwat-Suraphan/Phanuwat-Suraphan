import { db, uuid, nowIso, audit, todayInBangkok } from '../db.js';
import { fmtThaiDateShort } from '../render.js';
import { notifyUser } from './notify.js';
import { httpError, assertDateRange, assertMaxLength } from './validate.js';

export { httpError };

// เพดานช่วงเวลาการรักษาการแทน — 1 ปีการศึกษาเป็นช่วงที่ยาวที่สุดที่มีเหตุผลจริง (ลาศึกษาต่อ/ลาคลอด
// ต่อเนื่อง) ที่ยาวกว่านี้แปลว่าพิมพ์ปีผิด ซึ่งอันตรายมากเพราะเป็นการมอบอำนาจลงนามแทนผู้อำนวยการ
const MAX_DELEGATION_DAYS = 366;
const MAX_DELEGATION_REASON = 1000;

// ผู้รักษาการแทนต้องมีได้ครั้งละคนเดียว — getActiveDelegateFor เลือกรายการที่สร้าง "ล่าสุด" มาใช้เพียง
// รายการเดียวอยู่แล้ว ถ้าปล่อยให้มอบซ้อนช่วงเวลากันได้ คนที่ถูกมอบก่อนจะเห็นป้ายเขียว "กำลังรักษาการ"
// ในหน้า /delegations และเชื่อว่าตัวเองลงนามแทน ผอ. ได้ แต่พอกดปุ่มจริงจะถูกปฏิเสธ 403 ทุกครั้ง
// (ทดสอบผ่านเบราว์เซอร์ยืนยันแล้วว่าเกิดขึ้นจริง) — ระบบบอกว่ามีอำนาจแต่ไม่ให้ใช้ ซึ่งอันตรายมากกับ
// หนังสือด่วน เพราะทั้งคู่ต่างคิดว่าอีกฝ่ายไม่ได้ถืองานอยู่ ตามระเบียบราชการเองคำสั่งให้รักษาราชการแทน
// ก็ต้องระบุผู้รับมอบชัดเจนคนเดียวต่อช่วงเวลาอยู่แล้ว จึงกันไว้ตั้งแต่ตอนบันทึก พร้อมบอกว่าชนกับใครช่วงไหน
function findOverlappingDelegation({ delegatorId, startDate, endDate }) {
  return db.prepare(`
    SELECT ud.id, ud.start_date, ud.end_date, u.prefix, u.first_name, u.last_name
    FROM user_delegations ud JOIN users u ON u.id = ud.delegate_id
    WHERE ud.delegator_id = ? AND ud.cancelled_at IS NULL
      AND ud.start_date <= ? AND ud.end_date >= ?
    ORDER BY ud.created_at DESC
  `).all(delegatorId, endDate, startDate);
}

// supersedeOverlapping ใช้กับเส้นทาง "อนุมัติใบลาแล้วสร้างการมอบหมายอัตโนมัติ" เท่านั้น — ที่นั่นใบลาถูก
// บันทึกว่าอนุมัติไปแล้วก่อนถึงบรรทัดนี้ ถ้าโยน error ออกไปใบลาจะค้างครึ่งๆ กลางๆ และ ผอ. เห็นแต่หน้า
// error ทั้งที่กดอนุมัติสำเร็จ จึงยกเลิกรายการเดิมที่ซ้อนอยู่แทน ซึ่งไม่เปลี่ยนสิทธิ์ของใครเลย (รายการ
// ล่าสุดชนะอยู่แล้ว) แค่ทำให้หน้าจอตรงกับสิทธิ์จริง ส่วนหน้า /delegations ที่ผู้ใช้กรอกเองให้ฟ้อง 409 ไป
export function createDelegation({ delegatorId, delegateId, startDate, endDate, reason, leaveRequestId, createdBy, supersedeOverlapping = false }) {
  if (!delegatorId || !delegateId) throw httpError(400, 'กรุณาระบุผู้มอบหมายและผู้รักษาการแทน');
  if (delegatorId === delegateId) throw httpError(400, 'มอบหมายให้ตัวเองไม่ได้');
  // ตรวจก่อนที่จะไปชนกับ foreign key ของ SQLite — ไม่งั้นผู้ใช้จะได้ error 500 พร้อมข้อความ
  // "FOREIGN KEY constraint failed" ซึ่งอ่านไม่รู้เรื่องและดูเหมือนระบบพัง
  const delegate = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND status = 'active'").get(delegateId);
  if (!delegate) throw httpError(400, 'ไม่พบผู้รักษาการแทนที่เลือก หรือบัญชีนั้นถูกระงับอยู่');
  assertMaxLength(reason, MAX_DELEGATION_REASON, 'เหตุผล/หมายเหตุ');

  // การเทียบว่า "การมอบหมายนี้ยังมีผลอยู่ไหม" ทำด้วยการเทียบสตริงวันที่ใน SQL ถ้าปล่อยให้ค่าที่ไม่ใช่
  // วันที่หลุดเข้ามาได้ อักษรไทย/อังกฤษจะมากกว่าตัวเลขทุกตัว การมอบหมายนั้นจะ "มีผลตลอดไป"
  // (ทดสอบยืนยันแล้วว่าอีก 100 ปีก็ยังมีผล) = มอบอำนาจลงนามแทนผู้อำนวยการแบบถาวรโดยไม่มีอะไรฟ้อง
  ({ start: startDate, end: endDate } = assertDateRange({
    startDate, endDate,
    startLabel: 'วันที่เริ่มรักษาการแทน', endLabel: 'วันที่สิ้นสุด',
    maxDays: MAX_DELEGATION_DAYS, rangeLabel: 'ช่วงเวลารักษาการแทน',
  }));

  const clashes = findOverlappingDelegation({ delegatorId, startDate, endDate });
  if (clashes.length && !supersedeOverlapping) {
    const c = clashes[0];
    const who = `${c.prefix || ''}${c.first_name} ${c.last_name}`.trim();
    throw httpError(409, `ช่วงเวลานี้มอบหมายให้ ${who} รักษาการแทนอยู่แล้ว (${fmtThaiDateShort(c.start_date)} — ${fmtThaiDateShort(c.end_date)}) — ผู้รักษาการแทนมีได้ครั้งละคนเดียว ถ้าต้องการเปลี่ยนตัวผู้รักษาการแทน ให้กดปุ่ม "ยกเลิก" ที่รายการเดิมก่อน`);
  }
  for (const c of clashes) {
    db.prepare('UPDATE user_delegations SET cancelled_at = ? WHERE id = ?').run(nowIso(), c.id);
    audit({ userId: createdBy, action: 'delegation_superseded', tableName: 'user_delegations', recordId: c.id, detail: { reason: 'ถูกแทนที่ด้วยการมอบหมายจากการอนุมัติใบลา', leaveRequestId } });
  }

  const id = uuid();
  db.prepare(`
    INSERT INTO user_delegations (id, delegator_id, delegate_id, reason, start_date, end_date, leave_request_id, created_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, delegatorId, delegateId, reason?.trim() || null, startDate, endDate, leaveRequestId || null, createdBy, nowIso());

  notifyUser({
    userId: delegateId,
    linkUrl: '/delegations',
    title: 'คุณได้รับมอบหมายให้รักษาการแทน',
    message: `ตั้งแต่ ${fmtThaiDateShort(startDate)} ถึง ${fmtThaiDateShort(endDate)}${reason ? ' — ' + reason : ''}`,
    priority: 'info',
  });
  audit({ userId: createdBy, action: 'delegation_created', tableName: 'user_delegations', recordId: id, detail: { delegatorId, delegateId, startDate, endDate, leaveRequestId } });
  return id;
}

// คืนแถวการมอบหมายที่ยัง active สำหรับ delegatorId ณ วันที่ dateStr (ค่าเริ่มต้นคือวันนี้) — ถ้ามีมากกว่า
// หนึ่งรายการซ้อนช่วงกัน ใช้รายการที่สร้างล่าสุด (ผู้ดูแล/ผู้มอบหมายแก้ไขล่าสุดควรมีผลเหนือกว่า)
export function getActiveDelegateFor(delegatorId, dateStr) {
  const d = dateStr || todayInBangkok();
  return db.prepare(`
    SELECT ud.*, u.first_name as delegate_first, u.last_name as delegate_last, u.prefix as delegate_prefix
    FROM user_delegations ud JOIN users u ON u.id = ud.delegate_id
    WHERE ud.delegator_id = ? AND ud.cancelled_at IS NULL AND ud.start_date <= ? AND ud.end_date >= ?
    ORDER BY ud.created_at DESC LIMIT 1
  `).get(delegatorId, d, d);
}

// เพดานรายการที่แสดง — การมอบหมายรักษาการแทนสะสมทุกครั้งที่มีคนลาหรือไปราชการ ปีละหลายสิบครั้ง
// ต่อคน (วัดจริง: 300 รายการทำให้หน้านี้หนัก 161KB) รายการเก่ายังอยู่ในฐานข้อมูล แค่ไม่ต้องส่งมาทุกครั้ง
export const DELEGATION_PAGE_SIZE = 50;

export function countMyDelegations(userId) {
  return db.prepare('SELECT COUNT(*) c FROM user_delegations WHERE delegator_id = ? OR delegate_id = ?')
    .get(userId, userId).c;
}

export function listMyDelegations(userId, limit = DELEGATION_PAGE_SIZE) {
  return db.prepare(`
    SELECT ud.*,
      dg.first_name as delegate_first, dg.last_name as delegate_last, dg.prefix as delegate_prefix,
      dr.first_name as delegator_first, dr.last_name as delegator_last, dr.prefix as delegator_prefix
    FROM user_delegations ud
    JOIN users dg ON dg.id = ud.delegate_id
    JOIN users dr ON dr.id = ud.delegator_id
    WHERE ud.delegator_id = ? OR ud.delegate_id = ?
    ORDER BY ud.cancelled_at IS NOT NULL, ud.end_date DESC LIMIT ?
  `).all(userId, userId, limit);
}

export function cancelDelegation({ id, actorUser }) {
  const row = db.prepare('SELECT * FROM user_delegations WHERE id = ?').get(id);
  if (!row) throw httpError(404, 'ไม่พบรายการนี้');
  if (row.cancelled_at) throw httpError(409, 'ยกเลิกไปแล้ว');
  if (row.delegator_id !== actorUser.id && !actorUser.roleCodes.includes('admin')) {
    throw httpError(403, 'ยกเลิกได้เฉพาะผู้มอบหมายเองหรือแอดมินเท่านั้น');
  }
  db.prepare('UPDATE user_delegations SET cancelled_at = ? WHERE id = ?').run(nowIso(), id);
  audit({ userId: actorUser.id, action: 'delegation_cancelled', tableName: 'user_delegations', recordId: id });
}
