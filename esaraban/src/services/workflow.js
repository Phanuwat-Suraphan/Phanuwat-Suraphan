import { db, uuid, nowIso, beYear, audit, computeRetentionUntil } from '../db.js';
import { nextRunningNumber } from '../numbering.js';
import { notifyUser } from './notify.js';
import { deleteFile as deleteDriveFile, isGoogleDriveEnabled } from './googleDrive.js';
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
export function createDocument({ direction, title, subject, docTypeId, departmentId, priority, secretLevel, correspondentName, externalDocNumber, externalDocDate, dueDate, retentionClass, createdBy }) {
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    const { runningNumber, yearBe, display } = nextRunningNumber({ departmentId, docTypeId, direction });
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
    result = { id, docNumberDisplay: display };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit({ userId: createdBy, action: direction === 'incoming' ? 'document_received' : 'document_created', tableName: 'documents', recordId: result.id, detail: { docNumberDisplay: result.docNumberDisplay } });
  return result;
}

export function getDocument(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ? AND deleted_at IS NULL').get(id);
}

export function canUserSeeDocument(user, doc) {
  if (!doc) return false;
  if (user.roleCodes.includes('admin') || user.roleCodes.includes('director')) return true;
  if (doc.secret_level === 'secret' || doc.secret_level === 'top_secret') {
    // secret documents: only creator, current assignee, or explicit grant may even know it exists
    if (doc.created_by === user.id) return true;
    const isAssignee = db.prepare(`SELECT 1 FROM workflow_steps WHERE document_id = ? AND assignee_id = ?`).get(doc.id, user.id);
    if (isAssignee) return true;
    const grant = db.prepare(`SELECT 1 FROM document_access_grants WHERE document_id = ? AND (user_id = ? OR department_id = ?)`).get(doc.id, user.id, user.department_id);
    return !!grant;
  }
  if (doc.department_id === user.department_id) return true;
  if (doc.created_by === user.id) return true;
  const wasAssignee = db.prepare(`SELECT 1 FROM workflow_steps WHERE document_id = ? AND assignee_id = ?`).get(doc.id, user.id);
  return !!wasAssignee;
}

export function getWorkflowSteps(documentId) {
  return db.prepare(`
    SELECT ws.*, u.first_name, u.last_name, u.prefix, u.position, u.signature_image
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

export function assignStep({ documentId, assigneeId, instruction, actorUser }) {
  const doc = getDocument(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
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
  if (step.assignee_id !== actorUser.id && !actorUser.roleCodes.includes('admin')) {
    throw httpError(403, 'คุณไม่มีสิทธิ์ดำเนินการขั้นตอนนี้ (ผู้ไม่มีสิทธิ์ไม่สามารถข้ามขั้น Workflow ได้)');
  }
}

export function approveAndForward({ stepId, nextAssigneeId, comment, actorUser }) {
  const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  assertOwnsStep(step, actorUser);
  const doc = getDocument(step.document_id);

  db.prepare(`UPDATE workflow_steps SET status = 'approved', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(comment ? `\n[เกษียณ] ${comment}` : '', nowIso(), stepId);

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
  const doc = getDocument(step.document_id);

  db.prepare(`UPDATE workflow_steps SET status = 'acknowledged', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(comment ? `\n[รับทราบ] ${comment}` : '', nowIso(), stepId);
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
  const doc = getDocument(step.document_id);
  if (!reason) throw httpError(400, 'ต้องระบุเหตุผลที่ไม่อนุมัติ');

  db.prepare(`UPDATE workflow_steps SET status = 'rejected', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(`\n[ไม่อนุมัติ] ${reason}`, nowIso(), stepId);
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
  const doc = getDocument(step.document_id);
  if (!reason) throw httpError(400, 'ต้องระบุเหตุผลที่ส่งกลับแก้ไข');

  db.prepare(`UPDATE workflow_steps SET status = 'returned', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(`\n[ส่งกลับแก้ไข] ${reason}`, nowIso(), stepId);
  db.prepare(`UPDATE documents SET status = 'returned', updated_at = ? WHERE id = ?`).run(nowIso(), step.document_id);

  notifyUser({
    userId: doc.created_by, documentId: doc.id,
    title: `ส่งกลับแก้ไข: ${doc.doc_number_display}`, message: reason, priority: 'warning',
  });
  audit({ userId: actorUser.id, action: 'workflow_returned', tableName: 'workflow_steps', recordId: stepId, detail: { reason } });
}

export function voidDocument({ documentId, reason, actorUser }) {
  const doc = getDocument(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
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
  if (doc.status !== 'completed') throw httpError(409, 'จัดเก็บได้เฉพาะเอกสารที่เสร็จสิ้นแล้ว');
  db.prepare(`UPDATE documents SET status = 'archived', updated_at = ? WHERE id = ?`).run(nowIso(), documentId);
  audit({ userId: actorUser.id, action: 'document_archived', tableName: 'documents', recordId: documentId });
}

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}
