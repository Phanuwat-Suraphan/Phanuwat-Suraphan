import { db, uuid, nowIso, audit, todayInBangkok } from '../db.js';
import { fmtThaiDateShort } from '../render.js';
import { notifyUser } from './notify.js';

// httpError คัดลอกไว้ในไฟล์นี้เอง (ไม่ import จาก workflow.js) — เหตุผลเดียวกับ googleDrive.js/ocr.js/pdfStamp.js
export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function createDelegation({ delegatorId, delegateId, startDate, endDate, reason, leaveRequestId, createdBy }) {
  if (!delegatorId || !delegateId) throw httpError(400, 'กรุณาระบุผู้มอบหมายและผู้รักษาการแทน');
  if (delegatorId === delegateId) throw httpError(400, 'มอบหมายให้ตัวเองไม่ได้');
  if (!startDate || !endDate) throw httpError(400, 'กรุณาระบุวันที่เริ่มและวันที่สิ้นสุด');
  if (endDate < startDate) throw httpError(400, 'วันที่สิ้นสุดต้องไม่ก่อนวันที่เริ่ม');

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

export function listMyDelegations(userId) {
  return db.prepare(`
    SELECT ud.*,
      dg.first_name as delegate_first, dg.last_name as delegate_last, dg.prefix as delegate_prefix,
      dr.first_name as delegator_first, dr.last_name as delegator_last, dr.prefix as delegator_prefix
    FROM user_delegations ud
    JOIN users dg ON dg.id = ud.delegate_id
    JOIN users dr ON dr.id = ud.delegator_id
    WHERE ud.delegator_id = ? OR ud.delegate_id = ?
    ORDER BY ud.cancelled_at IS NOT NULL, ud.end_date DESC
  `).all(userId, userId);
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
