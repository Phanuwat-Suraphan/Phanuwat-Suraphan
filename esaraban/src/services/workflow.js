import { db, uuid, nowIso, beYear, audit, computeRetentionUntil, todayInBangkok } from '../db.js';
import { nextRunningNumber } from '../numbering.js';
import { notifyUser } from './notify.js';
import { deleteFile as deleteDriveFile, isGoogleDriveEnabled } from './googleDrive.js';
import { getActiveDelegateFor } from './delegation.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

/**
 * Create a new incoming/outgoing document with an atomic running number.
 * Wrapped in a SQLite transaction so the counter read+increment and the
 * document insert cannot interleave with another request (resolved
 * decision: Part 4 review #2/#3 — sequential, gapless, concurrency-safe).
 */
// customDocNumber: เลขที่ที่ธุรการพิมพ์เองแทนเลขที่ระบบออกอัตโนมัติ (ไม่ใช่ทุกโรงเรียนใช้เลขเรียง
// 0001/2569 อย่างเดียวเสมอไป — บางครั้งต้องต่อเลขจากทะเบียนกระดาษเดิม/มีเลขเฉพาะจากหน่วยงานอื่นกำกับ) —
// running_number/year_be ยังนับเดินหน้าตามปกติเบื้องหลังเสมอ (ใช้คำนวณอายุการเก็บ/นับสถิติ) ไม่ผูกกับ
// เลขที่กำหนดเอง เฉพาะ doc_number_display (เลขที่ที่แสดง/พิมพ์/ประทับตราจริง) เท่านั้นที่ถูกแทนที่
export function createDocument({ direction, title, subject, docTypeId, departmentId, priority, secretLevel, correspondentName, externalDocNumber, externalDocDate, dueDate, retentionClass, customDocNumber, createdBy }) {
  let result;
  let duplicateDocNumberWarning = null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const { runningNumber, yearBe, display: autoDisplay } = nextRunningNumber({ direction });
    const display = customDocNumber || autoDisplay;
    if (customDocNumber) {
      const dup = db.prepare('SELECT doc_number_display FROM documents WHERE doc_number_display = ? AND deleted_at IS NULL').get(customDocNumber);
      if (dup) duplicateDocNumberWarning = `เลขที่ "${customDocNumber}" ซ้ำกับเอกสารที่มีอยู่แล้วในระบบ — บันทึกให้แล้วตามที่กรอก แต่โปรดตรวจสอบว่าตั้งใจใช้เลขซ้ำจริงหรือไม่`;
    }
    const id = uuid();
    const now = nowIso();
    const retClass = retentionClass || 'normal_10y';
    const retentionUntil = computeRetentionUntil(yearBe, retClass);
    db.prepare(`
      INSERT INTO documents (id, direction, running_number, year_be, doc_number_display, external_doc_number, external_doc_date, title, subject,
        doc_type_id, department_id, priority, secret_level, correspondent_name, status, due_date, retention_class, retention_until, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?)
    `).run(id, direction, runningNumber, yearBe, display, externalDocNumber || null, externalDocDate || null, title, subject || null,
      docTypeId, departmentId, priority || 'normal', secretLevel || 'normal', correspondentName || null, dueDate || null, retClass, retentionUntil, createdBy, now, now);
    db.exec('COMMIT');
    result = { id, docNumberDisplay: display, duplicateDocNumberWarning };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit({ userId: createdBy, action: direction === 'incoming' ? 'document_received' : 'document_created', tableName: 'documents', recordId: result.id, detail: { docNumberDisplay: result.docNumberDisplay, customDocNumber: customDocNumber || null } });
  return result;
}

export function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(id);
}

// ขั้นตอน workflow ที่อ้างถึงต้องเป็นของเอกสารที่อ้างถึงจริงๆ — ห้ามเชื่อว่า documentId กับ stepId ที่ส่งมา
// คู่กันเอง เพราะ assertOwnsStep ตรวจแค่ว่า "ผู้ใช้เป็นเจ้าของขั้นตอนนั้นไหม" โดยหาเอกสารจากตัว step เอง
// ส่วนฟังก์ชันประทับตราใช้ documentId ที่ส่งเข้ามาตรงๆ ถ้าไม่ตรวจว่าทั้งคู่ตรงกัน ผู้ใช้ที่มีขั้นตอนค้างอยู่บน
// เอกสาร A จะยิงคำขอโดยใส่ stepId ของตัวเอง (บนเอกสาร A) คู่กับ id ของเอกสาร B ที่ตัวเองไม่มีสิทธิ์เลยได้
// แล้วลายเซ็นจะไปประทับลงไฟล์ PDF ของเอกสาร B แทน (ทดสอบยืนยันแล้วว่าเดิมทำได้จริง — ปลอมลายเซ็นข้ามเอกสาร)
export function assertStepBelongsToDocument(documentId, stepId) {
  const step = db.prepare('SELECT document_id FROM workflow_steps WHERE id = ?').get(stepId);
  if (!step || step.document_id !== documentId) throw httpError(404, 'ไม่พบขั้นตอนนี้ในเอกสารดังกล่าว');
}

// "รักษาการแทน" — ผู้ที่ได้รับมอบหมายให้รักษาการแทนคนที่กำลังถือขั้นตอนอยู่ (ยังไม่ตัดสินใจ) ของเอกสารนี้
// ต้องเห็น/ดำเนินการแทนได้เหมือนเป็นผู้ถูกมอบหมายเอง ไม่งั้นจะดำเนินการแทนไม่ได้เพราะหาเอกสารในระบบไม่เจอ
function hasActiveDelegateStep(documentId, userId) {
  return !!db.prepare(`
    SELECT 1 FROM workflow_steps ws JOIN user_delegations ud ON ud.delegator_id = ws.assignee_id
    WHERE ws.document_id = ? AND ws.status = 'waiting' AND ud.delegate_id = ? AND ud.cancelled_at IS NULL
      AND ud.start_date <= ? AND ud.end_date >= ?
  `).get(documentId, userId, todayInBangkok(), todayInBangkok());
}

/**
 * เงื่อนไข SQL ที่ให้ผลตรงกับ canUserSeeDocument ทุกประการ — ใช้กรองตั้งแต่ในฐานข้อมูล
 *
 * ทำไมต้องมีทั้งสองแบบ: canUserSeeDocument ตรวจทีละฉบับ ใช้ได้ดีตอนเปิดหน้าเอกสารเดียว แต่หน้ารายการ
 * ต้องนับจำนวนทั้งหมดและแบ่งหน้าให้ถูก ถ้าดึงมาก่อนแล้วค่อยกรองทีหลังด้วย JS จะได้ LIMIT ที่ผิด
 * (ดึงมา 200 กรองเหลือ 183 แล้วบอกผู้ใช้ว่า "ทั้งหมด 183 ฉบับ" ทั้งที่มีจริง 639) และเลื่อนหน้าไม่ได้
 *
 * ตัวนี้ "ต้องตรงกันเป๊ะ" กับ canUserSeeDocument เสมอ ถ้าหลวมกว่าคือเปิดเผยหนังสือลับ ถ้าแคบกว่าคือ
 * ซ่อนหนังสือที่ควรเห็น — มีเทสต์เทียบผลของทั้งสองแบบกับทุกฉบับ x ทุกบทบาทไว้กันตรงนี้เลื่อนจากกัน
 * ผู้เรียกยังควรเรียก canUserSeeDocument ซ้ำตอนเปิดเอกสารรายฉบับตามเดิม (กันไว้สองชั้น)
 *
 * คืน { sql, params } — sql ใช้ต่อท้าย WHERE ได้เลย โดยตารางเอกสารต้องใช้ชื่อย่อว่า d
 */
export function visibleDocumentsSqlFilter(user) {
  if (user.roleCodes.includes('admin') || user.roleCodes.includes('director')) {
    return { sql: '1=1', params: {} };
  }
  const today = todayInBangkok();
  return {
    sql: `(
      d.secret_level NOT IN ('secret', 'top_secret')
      OR d.created_by = :vis_me
      OR EXISTS (SELECT 1 FROM workflow_steps ws WHERE ws.document_id = d.id AND ws.assignee_id = :vis_me)
      OR EXISTS (
        SELECT 1 FROM workflow_steps ws2 JOIN user_delegations ud ON ud.delegator_id = ws2.assignee_id
        WHERE ws2.document_id = d.id AND ws2.status = 'waiting' AND ud.delegate_id = :vis_me
          AND ud.cancelled_at IS NULL AND ud.start_date <= :vis_today AND ud.end_date >= :vis_today
      )
      OR EXISTS (
        SELECT 1 FROM document_access_grants g
        WHERE g.document_id = d.id AND (g.user_id = :vis_me OR g.department_id = :vis_dept)
      )
    )`,
    params: { vis_me: user.id, vis_today: today, vis_dept: user.department_id ?? null },
  };
}

export function canUserSeeDocument(user, doc) {
  if (!doc) return false;
  if (user.roleCodes.includes('admin') || user.roleCodes.includes('director')) return true;
  if (doc.secret_level === 'secret' || doc.secret_level === 'top_secret') {
    // secret documents: only creator, current assignee, active delegate, or explicit grant may even know it exists
    if (doc.created_by === user.id) return true;
    const isAssignee = db.prepare(`SELECT 1 FROM workflow_steps WHERE document_id = ? AND assignee_id = ?`).get(doc.id, user.id);
    if (isAssignee) return true;
    if (hasActiveDelegateStep(doc.id, user.id)) return true;
    const grant = db.prepare(`SELECT 1 FROM document_access_grants WHERE document_id = ? AND (user_id = ? OR department_id = ?)`).get(doc.id, user.id, user.department_id);
    return !!grant;
  }
  // หนังสือทั่วไป (ชั้นความลับ "ปกติ"/"ภายใน") — บุคลากรทุกคนที่ล็อกอินแล้วเปิดอ่านและดาวน์โหลด PDF ได้
  // ตามที่โรงเรียนขอ: หนังสือราชการส่วนใหญ่เป็นเรื่องที่ครูทุกคนต้องรับรู้อยู่แล้ว (ประกาศ ระเบียบ
  // กำหนดการ) การจำกัดตามฝ่ายทำให้ครูเปิดหนังสือของฝ่ายอื่นไม่ได้ทั้งที่ควรอ่านได้
  //
  // ชั้นความลับ "ลับ"/"ลับมาก" ยังถูกจำกัดตามเดิม (เงื่อนไขด้านบน) — เป็นคนละเรื่องกัน และเป็นเหตุผล
  // ที่มีช่องชั้นความลับให้เลือกตั้งแต่แรก ถ้าเปิดให้ทุกคนเห็นหมดรวมชั้นความลับด้วย ช่องนั้นจะไม่มีความหมาย
  return true;
}

/**
 * SQL สำหรับตรึงสำเนาลายเซ็น/ชื่อ/ตำแหน่งของผู้ลงนามไว้ในตัวขั้นตอน ณ ขณะที่ตัดสินใจ
 *
 * ห้ามไปดึงจาก users ตอนแสดงผล เพราะถ้าเจ้าตัวเปลี่ยนหรือลบลายเซ็นในโปรไฟล์วันหลัง ลายเซ็นบนหนังสือ
 * ที่ลงนามไปแล้วทุกฉบับจะเปลี่ยน/หายย้อนหลังตามไปด้วย แล้วใช้เป็นหลักฐานไม่ได้เลย
 */
const SIGNATURE_SNAPSHOT_SQL = `
  signature_image = (SELECT u.signature_image FROM users u WHERE u.id = :signer),
  signer_name = (SELECT COALESCE(u.prefix,'') || u.first_name || ' ' || u.last_name FROM users u WHERE u.id = :signer),
  signer_position = (SELECT u.position FROM users u WHERE u.id = :signer)
`;

function snapshotSignature(stepId, signerId) {
  db.prepare(`UPDATE workflow_steps SET ${SIGNATURE_SNAPSHOT_SQL} WHERE id = :step`).run({ step: stepId, signer: signerId });
}

export function getWorkflowSteps(documentId) {
  return db.prepare(`
    -- ws.signature_image / ws.signer_name / ws.signer_position คือสำเนา ณ ขณะลงนาม (ใช้แสดงเป็นหลักฐาน)
    -- ส่วนคอลัมน์จาก users เป็นค่าปัจจุบัน ใช้แสดงว่า "ตอนนี้คนนี้คือใคร" เท่านั้น
    SELECT ws.*, u.first_name, u.last_name, u.prefix, u.position
    FROM workflow_steps ws JOIN users u ON u.id = ws.assignee_id
    WHERE ws.document_id = ? ORDER BY ws.step_order ASC
  `).all(documentId);
}

export function currentStep(documentId) {
  return db.prepare(`
    SELECT * FROM workflow_steps WHERE document_id = ? AND status = 'waiting'
    ORDER BY step_order DESC LIMIT 1
  `).get(documentId);
}

// ผู้รับงานต้องเป็นบัญชีที่ยังใช้งานได้จริง — ไม่งั้นเรื่องจะค้างอยู่กับคนที่ล็อกอินเข้ามาทำงานไม่ได้แล้ว
// (เช่น ครูที่ย้ายออกไปและถูกระงับบัญชี) ไม่มีใครดำเนินการต่อได้ และไม่มีอะไรบอกว่าทำไมเรื่องไม่เดิน
// ถ้าไม่ตรวจตรงนี้ ค่าที่ไม่มีตัวตนจะไปตกที่ FOREIGN KEY constraint ของ SQLite แล้วเด้งข้อความอังกฤษดิบใส่ผู้ใช้
function assertAssignableUser(userId) {
  if (!userId) throw httpError(400, 'กรุณาเลือกผู้รับงาน');
  const u = db.prepare("SELECT id FROM users WHERE id = ? AND deleted_at IS NULL AND status = 'active'").get(userId);
  if (!u) throw httpError(400, 'ไม่พบผู้รับงานที่เลือก หรือบัญชีนั้นถูกปิดใช้งานแล้ว — กรุณาเลือกผู้รับคนอื่น');
}

// ขั้นตอนที่ยังค้างอยู่อาจชี้ไปยังเอกสารที่แอดมินลบทิ้งไปแล้ว (ผู้รับงานเปิดหน้าค้างไว้แล้วเพิ่งมากด) —
// ถ้าไม่ตรวจ getDocument จะคืน undefined แล้วโค้ดข้างล่างไปอ่าน doc.created_by ต่อ กลายเป็น 500
// พร้อมข้อความ error ของโปรแกรมโผล่ใส่หน้าครู แทนที่จะบอกตรงๆ ว่าเอกสารถูกลบไปแล้ว
function documentOfStep(step) {
  const doc = getDocument(step.document_id);
  if (!doc) throw httpError(409, 'เอกสารฉบับนี้ถูกลบออกจากระบบไปแล้ว จึงดำเนินการต่อไม่ได้');
  return doc;
}

export function assignStep({ documentId, assigneeId, instruction, actorUser }) {
  const doc = getDocument(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  assertAssignableUser(assigneeId);
  // เดิม route ตรวจแค่ว่า "เห็นเอกสารนี้ได้ไหม" ซึ่งกว้างกว่าที่ UI ตั้งใจไว้มาก (ปุ่ม "เสนอ" ขึ้นเฉพาะผู้บันทึก
  // เอกสาร/แอดมิน) ทำให้ใครก็ตามที่แค่เห็นเอกสารในฝ่ายตัวเองยิง API มอบหมายงานให้ใครก็ได้ — คนในสาย workflow
  // ที่ต้องส่งต่อจริงๆ ใช้ปุ่มอนุมัติ/ส่งต่อ (approveAndForward) ซึ่งมี assertOwnsStep คุมอยู่แล้ว คนละทางกัน
  assertCanManageDocument(doc, actorUser, 'มอบหมายงานในเอกสาร');
  if (!['registered', 'returned'].includes(doc.status)) throw httpError(409, 'เอกสารนี้ไม่อยู่ในสถานะที่มอบหมายงานใหม่ได้');

  const maxOrder = db.prepare('SELECT COALESCE(MAX(step_order),0) m FROM workflow_steps WHERE document_id = ?').get(documentId).m;
  const id = uuid();
  db.prepare(`
    INSERT INTO workflow_steps (id, document_id, step_order, assignee_id, instruction, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'waiting', ?)
  `).run(id, documentId, maxOrder + 1, assigneeId, instruction || null, nowIso());

  db.prepare(`UPDATE documents SET status = 'in_progress', updated_at = ? WHERE id = ?`).run(nowIso(), documentId);

  notifyUser({
    userId: assigneeId, documentId,
    title: `หนังสือใหม่ต้องดำเนินการ: ${doc.doc_number_display}`,
    message: doc.title,
    priority: doc.priority === 'most_urgent' || doc.priority === 'very_urgent' ? 'urgent' : 'info',
  });

  audit({ userId: actorUser.id, action: 'workflow_assigned', tableName: 'workflow_steps', recordId: id, detail: { assigneeId, instruction } });
  return id;
}

function assertOwnsStep(step, actorUser) {
  if (!step || step.status !== 'waiting') throw httpError(409, 'ขั้นตอนนี้ถูกดำเนินการไปแล้วหรือไม่พบ');
  if (step.assignee_id === actorUser.id) return;
  if (actorUser.roleCodes.includes('admin')) return;
  const delegation = getActiveDelegateFor(step.assignee_id);
  if (delegation && delegation.delegate_id === actorUser.id) return;
  throw httpError(403, 'คุณไม่มีสิทธิ์ดำเนินการขั้นตอนนี้ (ผู้ไม่มีสิทธิ์ไม่สามารถข้ามขั้น Workflow ได้)');
}

export function approveAndForward({ stepId, nextAssigneeId, comment, actorUser }) {
  const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  assertOwnsStep(step, actorUser);
  assertAssignableUser(nextAssigneeId);
  // ส่งต่อให้ตัวเอง/ให้คนที่ถือเรื่องอยู่แล้ว เรื่องจะวนกลับมาที่เดิมโดยไม่คืบหน้า และดูเหมือนระบบทำงานผิด —
  // ถ้าตั้งใจจะจบเรื่องที่ตัวเอง ต้องกด "รับทราบ/ปิดเรื่อง" ไม่ใช่ "อนุมัติและส่งต่อ"
  if (nextAssigneeId === actorUser.id || nextAssigneeId === step.assignee_id) {
    throw httpError(400, 'ส่งต่อให้ตัวเองไม่ได้ — ถ้าต้องการจบเรื่องที่คุณ ให้กด "รับทราบ/ปิดเรื่อง" แทน');
  }
  const doc = documentOfStep(step);

  db.prepare(`UPDATE workflow_steps SET status = 'approved', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(comment ? `\n[เกษียณ] ${comment}` : '', nowIso(), stepId);
  snapshotSignature(stepId, actorUser.id);

  const nextOrder = step.step_order + 1;
  const nextId = uuid();
  db.prepare(`
    INSERT INTO workflow_steps (id, document_id, step_order, assignee_id, instruction, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'waiting', ?)
  `).run(nextId, step.document_id, nextOrder, nextAssigneeId, comment || null, nowIso());

  db.prepare(`UPDATE documents SET updated_at = ? WHERE id = ?`).run(nowIso(), step.document_id);

  notifyUser({
    userId: nextAssigneeId, documentId: step.document_id,
    title: `ส่งต่อถึงคุณ: ${doc.doc_number_display}`, message: doc.title, priority: 'info',
  });

  audit({ userId: actorUser.id, action: 'workflow_approved_forward', tableName: 'workflow_steps', recordId: stepId, detail: { nextAssigneeId, comment } });
}

export function acknowledgeAndComplete({ stepId, comment, actorUser }) {
  const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  assertOwnsStep(step, actorUser);
  const doc = documentOfStep(step);

  db.prepare(`UPDATE workflow_steps SET status = 'acknowledged', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(comment ? `\n[รับทราบ] ${comment}` : '', nowIso(), stepId);
  snapshotSignature(stepId, actorUser.id);
  db.prepare(`UPDATE documents SET status = 'completed', updated_at = ? WHERE id = ?`).run(nowIso(), step.document_id);

  notifyUser({
    userId: doc.created_by, documentId: doc.id,
    title: `รับทราบและดำเนินการเสร็จสิ้น: ${doc.doc_number_display}`,
    message: `${actorUser.prefix || ''}${actorUser.first_name} ${actorUser.last_name} ได้รับทราบและปิดเรื่องแล้ว`,
    priority: 'success',
  });

  audit({ userId: actorUser.id, action: 'workflow_acknowledged_completed', tableName: 'workflow_steps', recordId: stepId, detail: { comment } });
}

export function rejectStep({ stepId, reason, actorUser }) {
  const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  assertOwnsStep(step, actorUser);
  const doc = documentOfStep(step);
  if (!reason) throw httpError(400, 'ต้องระบุเหตุผลที่ไม่อนุมัติ');

  db.prepare(`UPDATE workflow_steps SET status = 'rejected', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(`\n[ไม่อนุมัติ] ${reason}`, nowIso(), stepId);
  snapshotSignature(stepId, actorUser.id);
  db.prepare(`UPDATE documents SET status = 'rejected', updated_at = ? WHERE id = ?`).run(nowIso(), step.document_id);

  notifyUser({
    userId: doc.created_by, documentId: doc.id,
    title: `ไม่อนุมัติ: ${doc.doc_number_display}`, message: reason, priority: 'warning',
  });
  audit({ userId: actorUser.id, action: 'workflow_rejected', tableName: 'workflow_steps', recordId: stepId, detail: { reason } });
}

export function returnStep({ stepId, reason, actorUser }) {
  const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  assertOwnsStep(step, actorUser);
  const doc = documentOfStep(step);
  if (!reason) throw httpError(400, 'ต้องระบุเหตุผลที่ส่งกลับแก้ไข');

  db.prepare(`UPDATE workflow_steps SET status = 'returned', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(`\n[ส่งกลับแก้ไข] ${reason}`, nowIso(), stepId);
  snapshotSignature(stepId, actorUser.id);
  db.prepare(`UPDATE documents SET status = 'returned', updated_at = ? WHERE id = ?`).run(nowIso(), step.document_id);

  notifyUser({
    userId: doc.created_by, documentId: doc.id,
    title: `ส่งกลับแก้ไข: ${doc.doc_number_display}`, message: reason, priority: 'warning',
  });
  audit({ userId: actorUser.id, action: 'workflow_returned', tableName: 'workflow_steps', recordId: stepId, detail: { reason } });
}

// ยกเลิก/จัดเก็บเอกสาร อนุญาตเฉพาะผู้บันทึกเอกสารเองหรือแอดมิน — ตรงกับเงื่อนไขที่ซ่อน/แสดงปุ่มในหน้าเว็บ
// (isCreatorOrAdmin ใน routes/documents.js) เดิมตรวจแค่ฝั่ง UI อย่างเดียว ฝั่งเซิร์ฟเวอร์ไม่ตรวจเลย ใครก็ตาม
// ที่ล็อกอินอยู่จึงยิง POST /documents/<id>/void ตรงๆ ข้าม UI แล้วยกเลิกหนังสือราชการของคนอื่นได้ทั้งระบบ
// (ทดสอบยืนยันแล้วว่าเดิมทำได้จริง) — ต้องบังคับฝั่งเซิร์ฟเวอร์ด้วยเสมอ ห้ามพึ่งการซ่อนปุ่มอย่างเดียว
function assertCanManageDocument(doc, actorUser, what) {
  if (doc.created_by === actorUser.id) return;
  if (actorUser.roleCodes.includes('admin')) return;
  throw httpError(403, `${what}ได้เฉพาะผู้บันทึกเอกสารหรือผู้ดูแลระบบเท่านั้น`);
}

export function voidDocument({ documentId, reason, actorUser }) {
  const doc = getDocument(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  assertCanManageDocument(doc, actorUser, 'ยกเลิกเอกสาร');
  if (!['draft', 'registered'].includes(doc.status)) {
    throw httpError(409, 'ห้ามลบ/ยกเลิกหนังสือที่อยู่ระหว่างดำเนินการ (Business Rule) — เลขที่ออกไปแล้วต้องคงอยู่ในลำดับเสมอ');
  }
  db.prepare(`UPDATE documents SET status = 'voided', void_reason = ?, updated_at = ? WHERE id = ?`).run(reason, nowIso(), documentId);
  audit({ userId: actorUser.id, action: 'document_voided', tableName: 'documents', recordId: documentId, detail: { reason } });
}

// ลบเอกสารถาวรโดยแอดมิน — ต่างจาก voidDocument ตรงที่ไม่จำกัดสถานะ (ใช้เก็บกวาดเอกสาร
// ที่ผิดพลาด/ค้างจากบั๊ก เช่น สร้างเอกสารสำเร็จแต่แนบไฟล์ไม่สำเร็จ) แต่ก็ยังเป็น soft-delete
// (ตั้ง deleted_at) ไม่ใช่ DELETE จริง เพื่อไม่ให้ audit_logs/workflow_steps ที่อ้างอิงเอกสารนี้เสียหาย
// และเลขที่เอกสารจะยังไม่ถูกนำไปใช้ซ้ำ (เอกสารแค่หายไปจากทุกหน้าจอ ไม่ใช่เลขว่างให้ใช้ใหม่)
export async function forceDeleteDocument({ documentId, reason, actorUser }) {
  if (!actorUser.roleCodes.includes('admin')) throw httpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้นที่ลบเอกสารได้');
  const doc = db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  if (!reason?.trim()) throw httpError(400, 'กรุณาระบุเหตุผลที่ลบเอกสาร');

  const attachments = db.prepare('SELECT * FROM attachments WHERE document_id = ?').all(documentId);
  for (const att of attachments) {
    try {
      if (att.storage_provider === 'google_drive' && att.drive_file_id && isGoogleDriveEnabled()) {
        await deleteDriveFile(att.drive_file_id);
      } else if (att.filepath) {
        const filePath = path.join(UPLOAD_DIR, att.filepath);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    } catch (e) {
      // ไฟล์ลบไม่สำเร็จไม่ควรทำให้การลบเอกสารทั้งฉบับล้มเหลว — บันทึกไว้แล้วลบเมทาดาต้าต่อ
      audit({ userId: actorUser.id, action: 'force_delete_attachment_cleanup_failed', tableName: 'attachments', recordId: att.id, detail: { error: e.message } });
    }
  }

  db.prepare(`UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(nowIso(), nowIso(), documentId);
  audit({ userId: actorUser.id, action: 'document_force_deleted', tableName: 'documents', recordId: documentId, detail: { reason, docNumberDisplay: doc.doc_number_display, previousStatus: doc.status } });
}

export function archiveDocument({ documentId, actorUser }) {
  const doc = getDocument(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  assertCanManageDocument(doc, actorUser, 'จัดเก็บเอกสาร');
  if (doc.status !== 'completed') throw httpError(409, 'จัดเก็บได้เฉพาะเอกสารที่เสร็จสิ้นแล้ว');
  db.prepare(`UPDATE documents SET status = 'archived', updated_at = ? WHERE id = ?`).run(nowIso(), documentId);
  audit({ userId: actorUser.id, action: 'document_archived', tableName: 'documents', recordId: documentId });
}

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
