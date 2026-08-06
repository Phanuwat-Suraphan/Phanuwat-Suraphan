import { db, uuid, nowIso, audit } from '../db.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export function listEligibleForDestruction() {
  return db.prepare(`
    SELECT d.*, dt.name as type_name, dep.name as dept_name FROM documents d
    JOIN document_types dt ON dt.id = d.doc_type_id JOIN departments dep ON dep.id = d.department_id
    WHERE d.deleted_at IS NULL AND d.status IN ('completed', 'archived', 'voided')
      AND d.retention_until IS NOT NULL AND d.retention_until <= date('now')
      AND NOT EXISTS (
        SELECT 1 FROM destruction_batch_items bi JOIN destruction_batches b ON b.id = bi.batch_id
        WHERE bi.document_id = d.id AND b.status = 'pending_approval'
      )
    ORDER BY d.retention_until ASC
  `).all();
}

export function listBatches() {
  return db.prepare(`
    SELECT b.*, u1.first_name as creator_first, u1.last_name as creator_last,
      u2.first_name as decider_first, u2.last_name as decider_last,
      (SELECT COUNT(*) FROM destruction_batch_items WHERE batch_id = b.id) as item_count
    FROM destruction_batches b
    JOIN users u1 ON u1.id = b.created_by
    LEFT JOIN users u2 ON u2.id = b.decided_by
    ORDER BY b.created_at DESC
  `).all();
}

export function getBatch(id) {
  const batch = db.prepare(`
    SELECT b.*, u1.first_name as creator_first, u1.last_name as creator_last FROM destruction_batches b
    JOIN users u1 ON u1.id = b.created_by WHERE b.id = ?
  `).get(id);
  if (!batch) return null;
  const items = db.prepare(`
    SELECT d.* FROM destruction_batch_items bi JOIN documents d ON d.id = bi.document_id
    WHERE bi.batch_id = ? ORDER BY d.doc_number_display
  `).all(id);
  return { ...batch, items };
}

export function createDestructionBatch({ documentIds, committeeNames, reason, actorUser }) {
  if (!documentIds?.length) throw httpError(400, 'กรุณาเลือกเอกสารอย่างน้อย 1 รายการ');
  if (!committeeNames?.trim()) throw httpError(400, 'กรุณาระบุรายชื่อคณะกรรมการทำลายหนังสือ (อย่างน้อย 3 คนตามระเบียบ)');

  const eligible = new Set(listEligibleForDestruction().map((d) => d.id));
  const invalid = documentIds.filter((id) => !eligible.has(id));
  if (invalid.length) throw httpError(409, 'มีเอกสารบางรายการไม่อยู่ในเงื่อนไขที่ทำลายได้ (ครบกำหนดเก็บแล้ว/ยังไม่ถูกรวมอยู่ในบัญชีอื่น) กรุณารีเฟรชหน้า');

  const batchId = uuid();
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`
      INSERT INTO destruction_batches (id, committee_names, reason, status, created_by, created_at)
      VALUES (?, ?, ?, 'pending_approval', ?, ?)
    `).run(batchId, committeeNames.trim(), reason?.trim() || null, actorUser.id, now);
    const insItem = db.prepare('INSERT INTO destruction_batch_items (id, batch_id, document_id) VALUES (?, ?, ?)');
    for (const docId of documentIds) insItem.run(uuid(), batchId, docId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit({ userId: actorUser.id, action: 'destruction_batch_created', tableName: 'destruction_batches', recordId: batchId, detail: { count: documentIds.length } });
  return batchId;
}

export function approveDestructionBatch({ batchId, actorUser, note }) {
  const batch = getBatch(batchId);
  if (!batch) throw httpError(404, 'ไม่พบบัญชีทำลายหนังสือ');
  if (batch.status !== 'pending_approval') throw httpError(409, 'บัญชีนี้ถูกพิจารณาไปแล้ว');

  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const doc of batch.items) {
      db.prepare(`UPDATE documents SET status = 'destroyed', destroyed_at = ?, destroyed_by = ?, updated_at = ? WHERE id = ?`)
        .run(now, actorUser.id, now, doc.id);
      // ลบไฟล์แนบจริงออกจากดิสก์ — คงรายการทะเบียน/เลขที่ไว้เป็นหลักฐานว่าเคยมีและถูกทำลายแล้วตามระเบียบ (ไม่ใช้เลขซ้ำ)
      const atts = db.prepare('SELECT * FROM attachments WHERE document_id = ?').all(doc.id);
      for (const att of atts) {
        const filePath = path.join(UPLOAD_DIR, att.filepath);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      }
    }
    db.prepare(`UPDATE destruction_batches SET status = 'approved', decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?`)
      .run(actorUser.id, note?.trim() || null, now, batchId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit({ userId: actorUser.id, action: 'destruction_batch_approved', tableName: 'destruction_batches', recordId: batchId, detail: { count: batch.items.length } });
}

export function rejectDestructionBatch({ batchId, actorUser, note }) {
  const batch = getBatch(batchId);
  if (!batch) throw httpError(404, 'ไม่พบบัญชีทำลายหนังสือ');
  if (batch.status !== 'pending_approval') throw httpError(409, 'บัญชีนี้ถูกพิจารณาไปแล้ว');
  if (!note?.trim()) throw httpError(400, 'กรุณาระบุเหตุผลที่ไม่อนุมัติ');

  db.prepare(`UPDATE destruction_batches SET status = 'rejected', decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?`)
    .run(actorUser.id, note.trim(), nowIso(), batchId);
  audit({ userId: actorUser.id, action: 'destruction_batch_rejected', tableName: 'destruction_batches', recordId: batchId, detail: { note } });
}
