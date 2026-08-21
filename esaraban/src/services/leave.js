import { db, uuid, nowIso, audit } from '../db.js';
import { fmtThaiDateShort } from '../render.js';
import { notifyUser } from './notify.js';
import { createDelegation } from './delegation.js';

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export const LEAVE_TYPE_LABEL = {
  sick: 'ลาป่วย',
  personal: 'ลากิจส่วนตัว',
  vacation: 'ลาพักผ่อน',
  maternity: 'ลาคลอดบุตร',
  ordination: 'ลาอุปสมบท',
  official_travel: 'ไปราชการ',
};

// "อนุมัติ" ใช้เมื่อใช้อำนาจตามระเบียบ/เกี่ยวข้องกับงบประมาณหน่วยงาน (ไปราชการ) — "อนุญาต" ใช้กับ
// เรื่องส่วนตัวที่ไม่เกี่ยวข้องกับงบประมาณ/ความรับผิดชอบของหน่วยงาน (ลาป่วย/ลากิจ/ลาพักผ่อน ฯลฯ)
// อ้างอิงหลักการใช้คำจากคู่มืองานสารบรรณ (อนุมัติ-อนุญาต-เห็นชอบ ต่างกันอย่างไร)
export function decisionVerb(leaveType) {
  return leaveType === 'official_travel' ? 'อนุมัติ' : 'อนุญาต';
}

function countDays(startDate, endDate) {
  const start = new Date(startDate);
  const end = new Date(endDate);
  const diffMs = end - start;
  if (diffMs < 0) return null;
  return Math.floor(diffMs / 86_400_000) + 1;
}

// ผู้ใช้ที่ยังใช้งานอยู่จริงเท่านั้น — ถ้าไม่ตรวจ ค่าที่ส่งมาจะไปตกที่ FOREIGN KEY constraint ของ SQLite
// แล้วเด้งข้อความภาษาอังกฤษดิบๆ ใส่หน้าครู และในฐานข้อมูลที่อัปเกรดมาจากรุ่นเก่า คอลัมน์ delegate_id
// ถูกเพิ่มด้วย ALTER TABLE ซึ่งไม่มี FK ติดมาด้วย ค่ามั่วจึงบันทึกผ่านได้ แล้วไปพังตอน "อนุมัติ" แทน
// (คือใบลาถูกอนุมัติและแจ้งเตือนไปแล้ว แต่การมอบหมายรักษาการแทนไม่เกิดขึ้น) จึงต้องตรวจในโค้ดเอง
function assertActiveUser(userId, what) {
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND status = 'active'").get(userId);
  if (!u) throw httpError(400, `ไม่พบ${what}ที่เลือก หรือบัญชีนั้นถูกปิดใช้งานแล้ว`);
}

export function createLeaveRequest({ requesterId, leaveType, startDate, endDate, reason, destination, contactInfo, approverId, delegateId }) {
  if (!LEAVE_TYPE_LABEL[leaveType]) throw httpError(400, 'ประเภทการลาไม่ถูกต้อง');
  if (!startDate || !endDate) throw httpError(400, 'กรุณาระบุวันที่เริ่มและวันที่สิ้นสุด');
  const daysCount = countDays(startDate, endDate);
  if (daysCount === null) throw httpError(400, 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม');
  if (!reason?.trim()) throw httpError(400, 'กรุณาระบุเหตุผล');
  if (!approverId) throw httpError(400, 'กรุณาเลือกผู้อนุมัติ');
  if (leaveType === 'official_travel' && !destination?.trim()) throw httpError(400, 'กรุณาระบุสถานที่ไปราชการ');
  if (delegateId === requesterId) throw httpError(400, 'มอบหมายให้ตัวเองรักษาการแทนไม่ได้');
  // หน้าเว็บตัดตัวเองออกจากรายการผู้อนุมัติอยู่แล้ว แต่ห้ามพึ่งแค่นั้น — คนที่ยิงคำขอตรงเข้ามาเองจะตั้ง
  // ตัวเองเป็นผู้อนุมัติแล้วกดอนุมัติใบลาตัวเองได้ (ทดสอบแล้วว่าเคยทำได้จริง)
  if (approverId === requesterId) throw httpError(400, 'เลือกตัวเองเป็นผู้อนุมัติ/อนุญาตไม่ได้');
  assertActiveUser(approverId, 'ผู้อนุมัติ/อนุญาต');
  if (delegateId) assertActiveUser(delegateId, 'ผู้รักษาการแทน');

  const id = uuid();
  const now = nowIso();
  db.prepare(`
    INSERT INTO leave_requests (id, requester_id, leave_type, start_date, end_date, days_count, reason, destination, contact_info, status, approver_id, delegate_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(id, requesterId, leaveType, startDate, endDate, daysCount, reason.trim(), destination?.trim() || null, contactInfo?.trim() || null, approverId, delegateId || null, now, now);

  const requester = db.prepare('SELECT * FROM users WHERE id = ?').get(requesterId);
  notifyUser({
    userId: approverId,
    linkUrl: `/leave/${id}`,
    title: `คำขอ${LEAVE_TYPE_LABEL[leaveType]}ใหม่รอ${decisionVerb(leaveType)}`,
    message: `${requester.prefix || ''}${requester.first_name} ${requester.last_name} — ${fmtThaiDateShort(startDate)} ถึง ${fmtThaiDateShort(endDate)} (${daysCount} วัน)`,
    priority: 'info',
  });
  audit({ userId: requesterId, action: 'leave_request_created', tableName: 'leave_requests', recordId: id, detail: { leaveType, startDate, endDate, daysCount } });
  return { id, daysCount };
}

export function getLeaveRequest(id) {
  return db.prepare(`
    SELECT l.*, u.first_name as requester_first, u.last_name as requester_last, u.prefix as requester_prefix,
      a.first_name as approver_first, a.last_name as approver_last,
      dg.first_name as delegate_first, dg.last_name as delegate_last, dg.prefix as delegate_prefix
    FROM leave_requests l
    JOIN users u ON u.id = l.requester_id
    JOIN users a ON a.id = l.approver_id
    LEFT JOIN users dg ON dg.id = l.delegate_id
    WHERE l.id = ?
  `).get(id);
}

export function listMyLeaveRequests(userId) {
  return db.prepare(`
    SELECT l.*, a.first_name as approver_first, a.last_name as approver_last FROM leave_requests l
    JOIN users a ON a.id = l.approver_id
    WHERE l.requester_id = ? ORDER BY l.created_at DESC
  `).all(userId);
}

export function listPendingApprovals(approverId) {
  return db.prepare(`
    SELECT l.*, u.first_name as requester_first, u.last_name as requester_last, u.prefix as requester_prefix FROM leave_requests l
    JOIN users u ON u.id = l.requester_id
    WHERE l.approver_id = ? AND l.status = 'pending' ORDER BY l.created_at ASC
  `).all(approverId);
}

function assertPendingAndOwnedByApprover(req, actorUser) {
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้');
  if (req.status !== 'pending') throw httpError(409, 'คำขอนี้ถูกพิจารณาไปแล้ว');
  // ห้ามพิจารณาคำขอของตัวเองเด็ดขาด ไม่ว่าจะเป็นผู้อนุมัติที่ระบุไว้หรือเป็นแอดมินก็ตาม — กันทั้ง
  // ใบลาที่ตั้งตัวเองเป็นผู้อนุมัติไว้ก่อนหน้านี้ และกรณีแอดมินยื่นใบลาเองแล้วกดอนุมัติเอง
  if (req.requester_id === actorUser.id) throw httpError(403, 'พิจารณาคำขอของตัวเองไม่ได้ ต้องให้ผู้อื่นเป็นผู้พิจารณา');
  if (req.approver_id !== actorUser.id && !actorUser.roleCodes.includes('admin')) {
    throw httpError(403, 'คุณไม่มีสิทธิ์พิจารณาคำขอนี้');
  }
}

/**
 * ใครเปิดดูคำขอลาใบนี้ได้บ้าง — เหตุผลการลามีข้อมูลส่วนตัว (เช่น อาการป่วย) และมีเบอร์ติดต่อ
 * จึงจำกัดเฉพาะผู้เกี่ยวข้องโดยตรง: ผู้ขอ, ผู้อนุมัติ, ผู้ที่ถูกระบุให้รักษาการแทน และแอดมิน
 * (ผู้บริหารเห็นได้อยู่แล้วเมื่อเป็นผู้อนุมัติ ซึ่งเป็นกรณีปกติของโรงเรียน)
 */
export function canSeeLeaveRequest(req, user) {
  if (!req || !user) return false;
  return req.requester_id === user.id
    || req.approver_id === user.id
    || req.delegate_id === user.id
    || user.roleCodes.includes('admin');
}

export function approveLeaveRequest({ id, note, actorUser }) {
  const req = getLeaveRequest(id);
  assertPendingAndOwnedByApprover(req, actorUser);
  db.prepare(`UPDATE leave_requests SET status = 'approved', decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
    .run(note?.trim() || null, nowIso(), nowIso(), id);
  notifyUser({ userId: req.requester_id, linkUrl: `/leave/${id}`, title: `คำขอ${LEAVE_TYPE_LABEL[req.leave_type]}ได้รับการ${decisionVerb(req.leave_type)}`, message: `${fmtThaiDateShort(req.start_date)} ถึง ${fmtThaiDateShort(req.end_date)}`, priority: 'success' });
  audit({ userId: actorUser.id, action: 'leave_request_approved', tableName: 'leave_requests', recordId: id });

  // ถ้าผู้ขอระบุผู้รักษาการแทนไว้ตอนยื่นคำขอ ให้สร้างการมอบหมายอัตโนมัติทันทีที่อนุมัติ — ผูกช่วงวันที่
  // เดียวกับวันลา ไม่ต้องให้ผู้ขอไปตั้งค่าซ้ำอีกรอบที่หน้า /delegations เอง
  if (req.delegate_id) {
    createDelegation({
      delegatorId: req.requester_id, delegateId: req.delegate_id, startDate: req.start_date, endDate: req.end_date,
      reason: `${LEAVE_TYPE_LABEL[req.leave_type]}: ${req.reason}`, leaveRequestId: id, createdBy: actorUser.id,
    });
  }
}

export function rejectLeaveRequest({ id, note, actorUser }) {
  const req = getLeaveRequest(id);
  assertPendingAndOwnedByApprover(req, actorUser);
  if (!note?.trim()) throw httpError(400, `กรุณาระบุเหตุผลที่ไม่${decisionVerb(req.leave_type)}`);
  db.prepare(`UPDATE leave_requests SET status = 'rejected', decision_note = ?, decided_at = ?, updated_at = ? WHERE id = ?`)
    .run(note.trim(), nowIso(), nowIso(), id);
  notifyUser({ userId: req.requester_id, linkUrl: `/leave/${id}`, title: `คำขอ${LEAVE_TYPE_LABEL[req.leave_type]}ไม่ได้รับการ${decisionVerb(req.leave_type)}`, message: note.trim(), priority: 'warning' });
  audit({ userId: actorUser.id, action: 'leave_request_rejected', tableName: 'leave_requests', recordId: id, detail: { note } });
}

export function cancelLeaveRequest({ id, actorUser }) {
  const req = getLeaveRequest(id);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้');
  if (req.requester_id !== actorUser.id) throw httpError(403, 'ยกเลิกได้เฉพาะคำขอของตัวเองเท่านั้น');
  if (req.status !== 'pending') throw httpError(409, 'ยกเลิกได้เฉพาะคำขอที่ยังรออนุมัติเท่านั้น');
  db.prepare(`UPDATE leave_requests SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(nowIso(), id);
  audit({ userId: actorUser.id, action: 'leave_request_cancelled', tableName: 'leave_requests', recordId: id });
}
