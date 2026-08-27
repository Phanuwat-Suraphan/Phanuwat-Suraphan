import { db, uuid, nowIso, audit, todayInBangkok, computeRetentionUntil } from '../db.js';
import { isGoogleDriveEnabled, deleteFile as deleteDriveFile } from './googleDrive.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertMaxLength } from './validate.js';

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
      AND d.retention_until IS NOT NULL AND d.retention_until <= :today
      AND NOT EXISTS (
        SELECT 1 FROM destruction_batch_items bi JOIN destruction_batches b ON b.id = bi.batch_id
        WHERE bi.document_id = d.id AND b.status = 'pending_approval'
      )
    ORDER BY d.retention_until ASC
  `).all({ today: todayInBangkok() });
}

/**
 * ตรวจซ้ำก่อน "ลงมือทำลายจริง" ว่าทุกฉบับในบัญชียังครบกำหนดเก็บอยู่
 *
 * การอนุมัติคือจุดที่ย้อนกลับไม่ได้ — ไฟล์แนบถูกลบออกจากดิสก์/Google Drive ถาวร กู้คืนไม่ได้เลย
 * แต่เดิมตรวจเงื่อนไขแค่ตอน "ตั้งบัญชี" เท่านั้น ระหว่างที่บัญชีรออนุมัติ (ซึ่งของจริงกินเวลาเป็นสัปดาห์
 * กว่าคณะกรรมการจะประชุมและ ผอ. จะลงนาม) สถานะของหนังสืออาจเปลี่ยนไปแล้ว เช่น ธุรการแก้ชั้น
 * อายุการเก็บเป็น "เก็บตลอดไป" หลังพบว่าเป็นเอกสารประวัติศาสตร์
 *
 * และตรวจว่าวันครบกำหนดที่เก็บไว้ตรงกับสูตร (ปี พ.ศ. ที่ออกเลข + อายุตามชั้นการเก็บ) จริงหรือไม่ —
 * ถ้าคอลัมน์นี้เพี้ยนไปด้วยเหตุใดก็ตาม (นำเข้าข้อมูลผิด แก้ฐานข้อมูลด้วยมือ) หนังสือที่ต้องเก็บอีกสิบปี
 * จะถูกจัดว่าครบกำหนดแล้วและถูกทำลายทิ้งโดยไม่มีอะไรทัดทาน คิดใหม่จากสูตรตรงนี้จึงกันไว้อีกชั้น
 */
function assertStillEligible(batch) {
  const today = todayInBangkok();
  const problems = [];
  for (const item of batch.items) {
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(item.id);
    if (!doc || doc.deleted_at) { problems.push(`${item.doc_number_display} ถูกลบไปแล้ว`); continue; }
    if (doc.status === 'destroyed') { problems.push(`${doc.doc_number_display} ถูกทำลายไปแล้ว`); continue; }
    if (!['completed', 'archived', 'voided'].includes(doc.status)) {
      problems.push(`${doc.doc_number_display} กลับมาอยู่ในระหว่างดำเนินการแล้ว`); continue;
    }
    const expected = computeRetentionUntil(doc.year_be, doc.retention_class);
    if (expected === null) { problems.push(`${doc.doc_number_display} ถูกเปลี่ยนเป็นเก็บตลอดไป`); continue; }
    if (expected > today) {
      problems.push(`${doc.doc_number_display} ยังไม่ครบกำหนดเก็บ (ครบ ${expected})`);
    }
  }
  if (problems.length) {
    throw httpError(409, `ทำลายไม่ได้ เพราะมีหนังสือที่เงื่อนไขเปลี่ยนไปหลังตั้งบัญชี: ${problems.slice(0, 5).join(' · ')}${problems.length > 5 ? ` และอีก ${problems.length - 5} ฉบับ` : ''} — กรุณายกเลิกบัญชีนี้แล้วตั้งใหม่`);
  }
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

// เพดานของบัญชีทำลายหนังสือหนึ่งบัญชี — บัญชีนี้เป็นเอกสารราชการถาวรที่ต้องพิมพ์เก็บไว้ตรวจสอบย้อนหลัง
// รายชื่อคณะกรรมการตามระเบียบมีแค่ 3 คนขึ้นไป ไม่มีทางยาวถึงหลักหมื่นตัวอักษร
const MAX_COMMITTEE_NAMES = 1000;
const MAX_BATCH_REASON = 2000;
const MAX_BATCH_ITEMS = 500;

export function createDestructionBatch({ documentIds, committeeNames, reason, actorUser }) {
  // ต้องเช็คว่าเป็นอาเรย์จริง ไม่ใช่แค่ว่ามี length — สตริงก็มี length เหมือนกัน แล้วจะไปพังที่
  // documentIds.filter ต่อ กลายเป็น error 500 พร้อมข้อความ JavaScript ดิบๆ ใส่หน้าผู้ใช้
  if (!Array.isArray(documentIds) || documentIds.length === 0) throw httpError(400, 'กรุณาเลือกเอกสารอย่างน้อย 1 รายการ');
  if (documentIds.length > MAX_BATCH_ITEMS) {
    throw httpError(400, `ทำลายได้ครั้งละไม่เกิน ${MAX_BATCH_ITEMS} ฉบับ (เลือกมา ${documentIds.length} ฉบับ) — กรุณาแบ่งเป็นหลายบัญชี`);
  }
  if (new Set(documentIds).size !== documentIds.length) throw httpError(400, 'มีเอกสารซ้ำกันในรายการที่เลือก');
  if (!committeeNames?.trim()) throw httpError(400, 'กรุณาระบุรายชื่อคณะกรรมการทำลายหนังสือ (อย่างน้อย 3 คนตามระเบียบ)');
  assertMaxLength(committeeNames, MAX_COMMITTEE_NAMES, 'รายชื่อคณะกรรมการ');
  assertMaxLength(reason, MAX_BATCH_REASON, 'เหตุผล');

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

export async function approveDestructionBatch({ batchId, actorUser, note }) {
  const batch = getBatch(batchId);
  if (!batch) throw httpError(404, 'ไม่พบบัญชีทำลายหนังสือ');
  if (batch.status !== 'pending_approval') throw httpError(409, 'บัญชีนี้ถูกพิจารณาไปแล้ว');
  // ตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ การทำลายหนังสือต้องผ่านคณะกรรมการทำลายหนังสือ
  // แล้วเสนอหัวหน้าส่วนราชการพิจารณา — คนเสนอกับคนอนุมัติจึงต้องไม่ใช่คนเดียวกัน ซึ่งเดิมทำได้
  // เพราะแอดมินอยู่ทั้งกลุ่มผู้เสนอและกลุ่มผู้อนุมัติ (ทดสอบแล้วว่าเสนอเองอนุมัติเองได้จริง)
  if (batch.created_by === actorUser.id) {
    throw httpError(403, 'ผู้เสนอบัญชีทำลายหนังสือจะอนุมัติบัญชีของตัวเองไม่ได้ ต้องให้ผู้บริหารท่านอื่นเป็นผู้พิจารณา');
  }
  assertStillEligible(batch);

  const now = nowIso();
  const driveFilesToDelete = [];
  const localFilesToDelete = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const doc of batch.items) {
      db.prepare(`UPDATE documents SET status = 'destroyed', destroyed_at = ?, destroyed_by = ?, updated_at = ? WHERE id = ?`)
        .run(now, actorUser.id, now, doc.id);
      // รวบรวมไฟล์ที่ต้องลบไว้ก่อน แล้วค่อยลบจริงหลัง COMMIT — การลบไฟล์ย้อนกลับไม่ได้ ถ้าลบทิ้งระหว่าง
      // transaction แล้ว transaction ล้มเหลวจน ROLLBACK ฐานข้อมูลจะกลับไปเป็นเหมือนไม่มีอะไรเกิดขึ้น
      // แต่ไฟล์แนบหายไปแล้วจริงๆ กลายเป็นเอกสารที่ระบบบอกว่ายังอยู่แต่เปิดไฟล์ไม่ได้ โดยไม่มีร่องรอยว่าทำไม
      // คงรายการทะเบียน/เลขที่ไว้เป็นหลักฐานว่าเคยมีและถูกทำลายแล้วตามระเบียบ (ไม่ใช้เลขซ้ำ)
      const atts = db.prepare('SELECT * FROM attachments WHERE document_id = ?').all(doc.id);
      for (const att of atts) {
        if (att.storage_provider === 'google_drive' && att.drive_file_id) driveFilesToDelete.push(att.drive_file_id);
        else if (att.filepath) localFilesToDelete.push(att.filepath);
        // สำเนาที่ประทับตราแล้วเป็นคนละไฟล์กับต้นฉบับ ต้องลบด้วย ไม่งั้นเอกสารที่ "ทำลายแล้ว"
        // ยังเหลือฉบับประทับตราค้างอยู่ในเครื่อง ซึ่งขัดกับมติให้ทำลาย
        if (att.stamped_storage_provider === 'google_drive' && att.stamped_drive_file_id) driveFilesToDelete.push(att.stamped_drive_file_id);
        else if (att.stamped_filepath) localFilesToDelete.push(att.stamped_filepath);
      }
    }
    db.prepare(`UPDATE destruction_batches SET status = 'approved', decided_by = ?, decision_note = ?, decided_at = ? WHERE id = ?`)
      .run(actorUser.id, note?.trim() || null, now, batchId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  // ถึงตรงนี้มติทำลายถูกบันทึกลงฐานข้อมูลเรียบร้อยแล้ว การลบไฟล์ที่ล้มเหลวจึงไม่ควรทำให้การอนุมัติล้มตาม
  // แต่ต้องบันทึกไว้ให้แอดมินตามลบเองภายหลัง
  for (const filepath of localFilesToDelete) {
    try {
      const full = path.join(UPLOAD_DIR, filepath);
      if (fs.existsSync(full)) fs.unlinkSync(full);
    } catch (e) {
      audit({ userId: actorUser.id, action: 'destruction_file_delete_failed', tableName: 'attachments', recordId: filepath, detail: { error: e.message } });
    }
  }
  if (isGoogleDriveEnabled()) {
    for (const fileId of driveFilesToDelete) {
      try {
        await deleteDriveFile(fileId);
      } catch (e) {
        audit({ userId: actorUser.id, action: 'destruction_drive_delete_failed', tableName: 'attachments', recordId: fileId, detail: { error: e.message } });
      }
    }
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
