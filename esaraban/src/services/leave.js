import { db, uuid, nowIso, audit, todayInBangkok } from '../db.js';
import { fmtThaiDateShort } from '../render.js';
import { notifyUser } from './notify.js';
import { createDelegation } from './delegation.js';

import { httpError, assertDateRange, assertMaxLength } from './validate.js';

export { httpError };

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

// เพดานของใบลาหนึ่งใบ — ลาคลอด/ลาอุปสมบทที่ยาวที่สุดตามระเบียบก็ไม่เกินไม่กี่เดือน ที่ยาวกว่า 1 ปี
// แปลว่าพิมพ์ปีผิด (ทดสอบแล้วเกิดขึ้นจริง: พิมพ์ 2126 แทน 2026 ได้ใบลา 36,526 วันโดยไม่มีอะไรฟ้อง)
const MAX_LEAVE_DAYS = 366;
const MAX_LEAVE_REASON = 2000;
const MAX_LEAVE_TEXT = 500; // สถานที่ไปราชการ / ข้อมูลติดต่อ

// บทบาทที่มีอำนาจอนุญาต/อนุมัติการลาได้จริงตามสายบังคับบัญชาของโรงเรียน
//
// เดิมไม่มีการจำกัดเลย ทั้งหน้าเว็บและฝั่งเซิร์ฟเวอร์ — ครูเลือก "ครูคนไหนก็ได้" เป็นผู้อนุญาตของตัวเองได้
// แล้วครูคนนั้นก็กดอนุญาตได้จริง (ทดสอบยืนยันแล้ว: ครูธรรมดาอนุมัติใบลาป่วยของครูอีกคนสำเร็จ 200
// สถานะกลายเป็น approved และลายเซ็นของเขาไปปรากฏบนใบลาในฐานะผู้อนุญาต)
//
// ผลคือใบลาที่ระบบออกให้ใช้เป็นหลักฐานทางราชการไม่ได้เลย เพราะคนอนุญาตไม่มีอำนาจอนุญาต —
// ซึ่งขัดกับเหตุผลทั้งหมดที่โมดูลนี้มีอยู่
export const APPROVER_ROLES = ['admin', 'director', 'vice_director', 'head'];

export function canApproveLeave(userId) {
  return !!db.prepare(`
    SELECT 1 x FROM user_roles ur JOIN roles r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.name IN (${APPROVER_ROLES.map(() => '?').join(', ')})
  `).get(userId, ...APPROVER_ROLES);
}

/** ผู้ที่เลือกเป็นผู้อนุญาต/อนุมัติได้ — ใช้ทั้งในหน้าเว็บและตรวจซ้ำฝั่งเซิร์ฟเวอร์ */
export function listLeaveApprovers(excludeId) {
  return db.prepare(`
    SELECT u.*, GROUP_CONCAT(r.name_th) as role_names FROM users u
    JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
    WHERE u.deleted_at IS NULL AND u.status = 'active'
      AND r.name IN (${APPROVER_ROLES.map(() => '?').join(', ')})
    GROUP BY u.id ORDER BY u.first_name
  `).all(...APPROVER_ROLES).filter((u) => u.id !== excludeId);
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
  // ใช้ตัวตรวจวันที่ตัวเดียวกับฝั่งหนังสือ — เดิมที่นี่แค่ลบวันที่กัน ค่าที่ไม่ใช่วันที่จึงกลายเป็น NaN
  // แล้วไปตกที่ NOT NULL constraint ของ days_count เป็น error 500 ภาษาอังกฤษดิบๆ ส่วนวันที่แบบ พ.ศ.
  // กับวันที่ที่ไม่มีอยู่จริง (2026-02-30) ผ่านฉลุยแล้วถูกบันทึกไปเงียบๆ
  const range = assertDateRange({
    startDate, endDate,
    startLabel: 'วันที่เริ่มลา', endLabel: 'วันที่สิ้นสุดการลา',
    maxDays: MAX_LEAVE_DAYS, rangeLabel: 'ช่วงวันลา',
  });
  startDate = range.start;
  endDate = range.end;
  const daysCount = range.days;
  if (!reason?.trim()) throw httpError(400, 'กรุณาระบุเหตุผล');
  assertMaxLength(reason, MAX_LEAVE_REASON, 'เหตุผล');
  assertMaxLength(destination, MAX_LEAVE_TEXT, 'สถานที่ไปราชการ');
  assertMaxLength(contactInfo, MAX_LEAVE_TEXT, 'ข้อมูลติดต่อระหว่างลา');
  if (!approverId) throw httpError(400, 'กรุณาเลือกผู้อนุมัติ');
  if (leaveType === 'official_travel' && !destination?.trim()) throw httpError(400, 'กรุณาระบุสถานที่ไปราชการ');
  if (delegateId === requesterId) throw httpError(400, 'มอบหมายให้ตัวเองรักษาการแทนไม่ได้');
  // หน้าเว็บตัดตัวเองออกจากรายการผู้อนุมัติอยู่แล้ว แต่ห้ามพึ่งแค่นั้น — คนที่ยิงคำขอตรงเข้ามาเองจะตั้ง
  // ตัวเองเป็นผู้อนุมัติแล้วกดอนุมัติใบลาตัวเองได้ (ทดสอบแล้วว่าเคยทำได้จริง)
  if (approverId === requesterId) throw httpError(400, 'เลือกตัวเองเป็นผู้อนุมัติ/อนุญาตไม่ได้');
  assertActiveUser(approverId, 'ผู้อนุมัติ/อนุญาต');
  // ห้ามเชื่อรายการใน dropdown อย่างเดียว — คนที่ยิงคำขอตรงเข้ามาเองจะตั้งครูคนไหนก็ได้เป็นผู้อนุญาต
  if (!canApproveLeave(approverId)) {
    throw httpError(400, 'ผู้ที่เลือกไม่มีอำนาจอนุญาต/อนุมัติการลา — ต้องเป็นผู้อำนวยการ รองผู้อำนวยการ หัวหน้าฝ่าย หรือผู้ดูแลระบบ');
  }
  if (delegateId) assertActiveUser(delegateId, 'ผู้รักษาการแทน');
  assertNotBackdatedTypo(startDate);
  assertNoOverlappingLeave({ requesterId, startDate, endDate, leaveType });

  const id = uuid();
  const now = nowIso();
  db.prepare(`
    INSERT INTO leave_requests (id, requester_id, leave_type, start_date, end_date, days_count, reason, destination, contact_info, status, approver_id, delegate_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
  `).run(id, requesterId, leaveType, startDate, endDate, daysCount, reason.trim(), destination?.trim() || null, contactInfo?.trim() || null, approverId, delegateId || null, now, now);

  // ผู้ขอลงนามรับรองข้อความในใบลาของตัวเองตั้งแต่ตอนยื่น — เป็นขั้นตอนแรกของหลักฐาน
  // (ใบลากระดาษก็ให้เจ้าตัวเซ็นชื่อท้ายใบก่อนเสนอเหมือนกัน)
  recordLeaveSignature({ leaveRequestId: id, userId: requesterId, step: 'requested' });

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

// ยื่นใบลาย้อนหลังได้ตามปกติ — ลาป่วยกะทันหันต้องยื่นตอนกลับมาปฏิบัติงานอยู่แล้ว จึงห้ามบล็อกการ
// ย้อนหลังทั้งหมด แต่ที่ย้อนไปไกลเกินหนึ่งปีคือพิมพ์ปีผิด ไม่ใช่การลาจริง (เจอบ่อยที่สุดคือกรอกปี พ.ศ.
// ลงในช่องที่เป็น ค.ศ. หรือหยิบปีเก่ามาจากปฏิทินที่เปิดค้างไว้) ถ้าปล่อยผ่าน ใบลานั้นจะไปโผล่ใน
// สถิติการลาของปีงบประมาณที่ปิดไปแล้ว แล้วยอดวันลาสะสมของคนนั้นผิดทั้งปี โดยไม่มีอะไรฟ้อง
const MAX_BACKDATE_DAYS = 366;
function assertNotBackdatedTypo(startDate) {
  const today = todayInBangkok();
  const daysBack = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86400000);
  if (daysBack > MAX_BACKDATE_DAYS) {
    throw httpError(400, `วันที่เริ่มลาย้อนหลังไปถึง ${fmtThaiDateShort(startDate)} ซึ่งเกิน 1 ปี — กรุณาตรวจสอบว่ากรอกปีถูกต้องหรือไม่ (ช่องวันที่ใช้ปี ค.ศ. ไม่ใช่ พ.ศ.)`);
  }
}

// สถานะที่ถือว่า "จองวันนั้นไว้แล้ว" — คำขอที่ถูกปฏิเสธหรือยกเลิกไปแล้วไม่นับ ยื่นทับได้ตามปกติ
const BLOCKING_LEAVE_STATUSES = ['pending', 'approved'];

/**
 * กันไม่ให้คนเดียวยื่นใบลาทับช่วงวันเดิมของตัวเอง
 *
 * เดิมยื่นทับกันได้ไม่จำกัด ทดสอบแล้วยืนยัน: ยื่นลากิจ 10–12 แล้วยื่นลาป่วย 11–13 ต่อทันที ระบบรับไว้
 * ทั้งสองใบและอนุญาตได้ทั้งคู่ ผลคือวันที่ 11–12 ถูกนับเป็นวันลาสองครั้งในสถิติการลาของปีงบประมาณ
 * (ยอดวันลาสะสมของครูคนนั้นเกินจริง ซึ่งใช้ประกอบการพิจารณาเลื่อนขั้นเงินเดือน) และผู้บริหารดูตาราง
 * แล้วไม่รู้ว่าวันนั้นครูคนนี้ลาด้วยเหตุอะไรกันแน่ ส่วนใหญ่เกิดจากกดยื่นซ้ำเพราะคิดว่าใบแรกไม่ผ่าน
 *
 * ปิดกั้นแทนการเตือน เพราะการลาทับซ้อนของคนคนเดียวไม่มีกรณีที่ถูกต้อง — ถ้าจะเปลี่ยนประเภทหรือ
 * ขยายวัน ต้องยกเลิกใบเดิมก่อน ซึ่งเป็นสิ่งที่ระเบียบกำหนดให้ทำอยู่แล้ว
 */
function assertNoOverlappingLeave({ requesterId, startDate, endDate, leaveType }) {
  const clash = db.prepare(`
    SELECT id, leave_type, start_date, end_date, status FROM leave_requests
    WHERE requester_id = :requester
      AND status IN (${BLOCKING_LEAVE_STATUSES.map((s) => `'${s}'`).join(',')})
      -- ช่วงสองช่วงทับกันเมื่อ "เริ่มก่อนที่อีกช่วงจะจบ" และ "จบหลังที่อีกช่วงจะเริ่ม" (เทียบเป็นข้อความได้
      -- เพราะวันที่เก็บเป็น YYYY-MM-DD ซึ่งเรียงตามลำดับเวลาอยู่แล้ว)
      AND start_date <= :end AND end_date >= :start
    ORDER BY start_date LIMIT 1
  `).get({ requester: requesterId, start: startDate, end: endDate });
  if (!clash) return;
  const same = clash.leave_type === leaveType ? '' : `(${LEAVE_TYPE_LABEL[clash.leave_type]}) `;
  const statusWord = clash.status === 'approved' ? `${decisionVerb(clash.leave_type)}แล้ว` : `รอ${decisionVerb(clash.leave_type)}`;
  throw httpError(409, `ช่วงวันที่นี้ทับกับใบลาเดิมของคุณ ${same}${fmtThaiDateShort(clash.start_date)} ถึง ${fmtThaiDateShort(clash.end_date)} ซึ่ง${statusWord} — หากต้องการแก้ไข กรุณายกเลิกใบเดิมก่อน`);
}

/**
 * ปีงบประมาณไทยของวันที่หนึ่งๆ — เริ่ม 1 ตุลาคม ถึง 30 กันยายน ปีถัดไป
 * (เช่น 1 ต.ค. 2568 – 30 ก.ย. 2569 คือปีงบประมาณ 2569)
 */
export function fiscalYearRange(dateStr) {
  const [y, m] = dateStr.split('-').map(Number);
  const startYearAd = m >= 10 ? y : y - 1;
  return { start: `${startYearAd}-10-01`, end: `${startYearAd + 1}-09-30`, yearBe: startYearAd + 1 + 543 };
}

/**
 * สถิติการลาในปีงบประมาณเดียวกับใบลาใบนี้ — ตารางที่อยู่ท้ายแบบใบลาราชการ
 *
 * แบบใบลาของทางราชการมีช่อง "ลามาแล้ว / ลาครั้งนี้ / รวมเป็น" ให้เจ้าหน้าที่กรอก ซึ่งเดิมต้องไปไล่นับ
 * จากแฟ้มใบลาเก่าด้วยมือทุกครั้ง ทั้งที่ระบบมีข้อมูลครบอยู่แล้ว — นับเฉพาะใบที่อนุญาตแล้วและไม่นับ
 * ใบนี้เอง (ใบนี้คือช่อง "ลาครั้งนี้")
 */
export function leaveStatsForFiscalYear({ requesterId, onDate, excludeLeaveId = null }) {
  const { start, end, yearBe } = fiscalYearRange(onDate);
  const rows = db.prepare(`
    SELECT leave_type, SUM(days_count) days, COUNT(*) times FROM leave_requests
    WHERE requester_id = :requester AND status = 'approved'
      AND start_date >= :start AND start_date <= :end
      AND (:exclude IS NULL OR id != :exclude)
    GROUP BY leave_type
  `).all({ requester: requesterId, start, end, exclude: excludeLeaveId });
  const byType = {};
  for (const r of rows) byType[r.leave_type] = { days: r.days, times: r.times };
  return { yearBe, start, end, byType };
}

/**
 * บันทึกลายเซ็นรับรองของขั้นตอนหนึ่งบนใบลา — เก็บ "สำเนา ณ ขณะลงนาม" ไม่ใช่ชี้ไปที่โปรไฟล์ผู้ใช้
 *
 * ใบลาเป็นหลักฐานทางราชการที่ต้องเก็บไว้ตรวจสอบย้อนหลังได้ ถ้าดึงลายเซ็นจาก users ตอนแสดงผล
 * วันไหนเจ้าตัวเปลี่ยนหรือลบลายเซ็นในโปรไฟล์ ลายเซ็นบนใบลาที่ลงนามไปแล้วทั้งหมดจะเปลี่ยน/หายย้อนหลัง
 * ตามไปด้วย (ยืนยันแล้วว่าเกิดขึ้นจริงกับขั้นตอนของหนังสือ) — ชื่อกับตำแหน่งก็เก็บสำเนาด้วยเหตุผลเดียวกัน
 * เพราะคนย้ายฝ่าย/เปลี่ยนตำแหน่งได้
 */
export function recordLeaveSignature({ leaveRequestId, userId, step, note }) {
  const u = db.prepare('SELECT prefix, first_name, last_name, position, signature_image FROM users WHERE id = ?').get(userId);
  if (!u) return;
  db.prepare(`
    INSERT INTO leave_signatures (id, leave_request_id, user_id, step, signer_name, signer_position, signature_image, note, signed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(uuid(), leaveRequestId, userId, step,
    `${u.prefix || ''}${u.first_name} ${u.last_name}`, u.position || null, u.signature_image || null, note || null, nowIso());
}

/** ลายเซ็นรับรองทั้งหมดบนใบลา เรียงตามเวลาที่ลงนาม — ใช้แสดงเป็นหลักฐานว่าผ่านมือใครมาบ้าง */
export function listLeaveSignatures(leaveRequestId) {
  return db.prepare('SELECT * FROM leave_signatures WHERE leave_request_id = ? ORDER BY signed_at').all(leaveRequestId);
}

/** ไฟล์หลักฐานที่แนบมากับใบลา (ใบนัดแพทย์ ฯลฯ) */
export function listLeaveAttachments(leaveRequestId) {
  return db.prepare('SELECT * FROM leave_attachments WHERE leave_request_id = ? ORDER BY created_at').all(leaveRequestId);
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
  recordLeaveSignature({ leaveRequestId: id, userId: actorUser.id, step: 'approved', note });
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
  recordLeaveSignature({ leaveRequestId: id, userId: actorUser.id, step: 'rejected', note });
  notifyUser({ userId: req.requester_id, linkUrl: `/leave/${id}`, title: `คำขอ${LEAVE_TYPE_LABEL[req.leave_type]}ไม่ได้รับการ${decisionVerb(req.leave_type)}`, message: note.trim(), priority: 'warning' });
  audit({ userId: actorUser.id, action: 'leave_request_rejected', tableName: 'leave_requests', recordId: id, detail: { note } });
}

export function cancelLeaveRequest({ id, actorUser }) {
  const req = getLeaveRequest(id);
  if (!req) throw httpError(404, 'ไม่พบคำขอนี้');
  if (req.requester_id !== actorUser.id) throw httpError(403, 'ยกเลิกได้เฉพาะคำขอของตัวเองเท่านั้น');
  if (req.status !== 'pending') throw httpError(409, 'ยกเลิกได้เฉพาะคำขอที่ยังรออนุมัติเท่านั้น');
  db.prepare(`UPDATE leave_requests SET status = 'cancelled', updated_at = ? WHERE id = ?`).run(nowIso(), id);
  recordLeaveSignature({ leaveRequestId: id, userId: actorUser.id, step: 'cancelled' });
  audit({ userId: actorUser.id, action: 'leave_request_cancelled', tableName: 'leave_requests', recordId: id });
}

// ---------------- ไฟล์หลักฐานแนบใบลา ----------------
//
// ลาป่วยแนบใบนัดแพทย์ ลาประเภทอื่นแนบหลักฐานประกอบได้ตามที่โรงเรียนขอ — เก็บแบบเดียวกับไฟล์แนบหนังสือ
// ทุกอย่าง รวมถึงขึ้น Google Drive เมื่อเปิดใช้ เพื่อให้ไม่หายตอนโฮสต์ล้างดิสก์ (โฮสต์ฟรีล้างทุกครั้งที่ deploy)
export const MAX_LEAVE_FILE_BYTES = 10 * 1024 * 1024;

// รับได้ทั้ง PDF และรูปถ่าย เพราะใบนัดแพทย์ส่วนใหญ่ครูถ่ายจากมือถือส่งมา ไม่ได้สแกนเป็น PDF
const ALLOWED = {
  'application/pdf': { ext: 'pdf', magic: (b) => b.subarray(0, 5).toString('latin1') === '%PDF-' },
  'image/jpeg': { ext: 'jpg', magic: (b) => b[0] === 0xff && b[1] === 0xd8 },
  'image/png': { ext: 'png', magic: (b) => b.subarray(1, 4).toString('latin1') === 'PNG' },
};

export function assertAllowedLeaveFile({ mimeType, buffer }) {
  const spec = ALLOWED[mimeType];
  if (!spec) throw httpError(400, 'รองรับเฉพาะไฟล์ PDF, JPG และ PNG เท่านั้น');
  if (buffer.length > MAX_LEAVE_FILE_BYTES) throw httpError(413, `ไฟล์ใหญ่เกิน ${MAX_LEAVE_FILE_BYTES / 1024 / 1024}MB`);
  // ตรวจ magic number ไม่ใช่เชื่อ mime type ที่ฝั่งเว็บบอกมา — เปลี่ยนได้ง่ายและไม่ใช่หลักฐานว่าไฟล์เป็นอะไรจริง
  if (!spec.magic(buffer)) throw httpError(400, 'เนื้อไฟล์ไม่ตรงกับชนิดที่แจ้ง (ตรวจ file signature ไม่ผ่าน)');
  return spec.ext;
}

export function insertLeaveAttachment({ id, leaveRequestId, filename, storageProvider, filepath, driveFileId, filesize, mimeType, hash, uploadedBy }) {
  db.prepare(`
    INSERT INTO leave_attachments (id, leave_request_id, filename, storage_provider, filepath, drive_file_id, filesize, mime_type, hash_sha256, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, leaveRequestId, filename, storageProvider, filepath || null, driveFileId || null, filesize, mimeType, hash || null, uploadedBy, nowIso());
}

export function getLeaveAttachment(id) {
  return db.prepare('SELECT * FROM leave_attachments WHERE id = ?').get(id);
}
