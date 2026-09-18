import { db, uuid, nowIso, beYear, audit, computeRetentionUntil, todayInBangkok, RETENTION_YEARS } from '../db.js';
import { nextRunningNumber } from '../numbering.js';
import { notifyUser } from './notify.js';
import { deleteFile as deleteDriveFile, isGoogleDriveEnabled } from './googleDrive.js';
import { getActiveDelegateFor } from './delegation.js';
import { httpError, normalizeDate, assertMaxLength, asTextOrNull } from './validate.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ตัวตรวจค่าที่กรอกเข้ามาทั้งหมดย้ายไปอยู่ที่ validate.js แล้ว เพื่อให้หนังสือ/ใบลา/การมอบหมายรักษาการแทน
// ใช้ตัวเดียวกัน — ต่างคนต่างตรวจคือเหตุผลที่ใบลากับการมอบหมายรับวันที่มั่วเข้ามาได้อยู่นาน
export { httpError };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');

// ค่าที่ยอมรับได้ของแต่ละช่องที่เป็นตัวเลือก — ต้องตรวจฝั่งเซิร์ฟเวอร์ ไม่ใช่พึ่ง <select> ในหน้าเว็บ
//
// ที่สำคัญที่สุดคือ secret_level: canUserSeeDocument จำกัดสิทธิ์เฉพาะค่า 'secret'/'top_secret' เท่านั้น
// ค่าอื่นทั้งหมดถูกถือว่าเป็นหนังสือทั่วไปที่ทุกคนอ่านได้ ถ้าปล่อยให้ค่าแปลกปลอมหลุดเข้ามา หนังสือที่
// ธุรการตั้งใจให้เป็นความลับสูงสุดจะกลายเป็นหนังสือสาธารณะทันทีโดยไม่มีอะไรฟ้อง (ทดสอบยืนยันแล้วว่า
// ครูเปิดอ่านได้จริง) — จึงปฏิเสธค่าที่ไม่รู้จักไปเลย ดีกว่าเดาแล้วเดาผิดในทางที่เปิดเผยข้อมูล
const VALID_PRIORITY = new Set(['normal', 'urgent', 'very_urgent', 'most_urgent']);
const VALID_SECRET = new Set(['normal', 'internal', 'secret', 'top_secret']);
const VALID_DIRECTION = new Set(['incoming', 'outgoing']);

// เพดานความยาวข้อความ — กันการวางเนื้อหาหนังสือทั้งฉบับลงช่องชื่อเรื่องโดยไม่ตั้งใจ ซึ่งเกิดขึ้นง่ายมาก
// เวลาก๊อปจากไฟล์ Word ทดสอบแล้ว: ชื่อเรื่อง 50,000 ตัวอักษรฉบับเดียวทำให้หน้าทะเบียนพองเป็น 115KB
// ต่อการเปิดหนึ่งครั้ง และทำให้ตาราง/ตราประทับ/ไฟล์ Excel ที่ส่งออกเสียรูปทั้งหมด
const MAX_LEN = { title: 500, subject: 5000, correspondentName: 300, externalDocNumber: 100, customDocNumber: 100 };

// เพดานของข้อความในขั้นตอน workflow — ยาวกว่านี้ไม่ได้ช่วยใครอ่านรู้เรื่องขึ้น แต่ทำให้ไทม์ไลน์
// ของเอกสารพองจนเปิดหน้าไม่ไหว (เทียบกับกรณีชื่อเรื่อง 50,000 ตัวอักษรที่เคยทำให้หน้าทะเบียนพอง 115KB)
const MAX_STEP_TEXT = 2000;

function assertLength(value, field, label) {
  assertMaxLength(value, MAX_LEN[field], label);
}

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
/**
 * ช่วงเวลาที่ถือว่า "เรื่องเดิมที่เพิ่งลงไป" ไม่ใช่เรื่องใหม่
 *
 * ทำไมต้องมี: ยิงทดสอบแล้วพบว่าการกดปุ่มบันทึกสองทีติดกัน (ซึ่งบนมือถือเกิดง่ายมาก และเน็ตกระตุก
 * แล้วเบราว์เซอร์ส่งซ้ำเองก็ให้ผลเดียวกัน) ได้หนังสือ 2 ฉบับกินเลขทะเบียน 2 เลข โดยธุรการไม่รู้ตัว
 * ซึ่งในงานสารบรรณแก้ไม่ได้ — เลขที่ออกไปแล้วนำกลับมาใช้ซ้ำไม่ได้ ต้องยกเลิกฉบับเกินทิ้งอย่างเดียว
 * ทะเบียนจึงมีเลขที่ถูกยกเลิกคาอยู่ถาวร และต้องอธิบายตอนตรวจ
 *
 * หนึ่งนาทีพอสำหรับดักการกดซ้ำ/ส่งซ้ำ (เกิดในหลักมิลลิวินาทีถึงไม่กี่วินาที) แต่สั้นพอที่การพิมพ์
 * ฟอร์มใหม่ทั้งชุดสำหรับหนังสือคนละฉบับที่บังเอิญชื่อเรื่องเหมือนกันจะใช้เวลานานกว่านั้นอยู่แล้ว
 * และถึงชนจริงก็ไม่ได้กันตาย — ระบบถามยืนยันแล้วลงให้ได้
 */
const DUPLICATE_REGISTER_WINDOW_SECONDS = 60;

// ต้องเรียกอยู่ภายใน transaction เดียวกับการ INSERT เสมอ — ถ้าตรวจนอก transaction คำขอสองอันที่มา
// พร้อมกันจะผ่านการตรวจทั้งคู่ก่อนที่อันไหนจะได้เขียน แล้วก็ได้หนังสือสองฉบับเหมือนเดิม
// (SQLite กันได้เพราะ BEGIN IMMEDIATE บังคับให้ผู้เขียนเข้าคิวทีละราย)
function findJustRegistered({ direction, title, correspondentName, createdBy }) {
  const since = new Date(Date.now() - DUPLICATE_REGISTER_WINDOW_SECONDS * 1000).toISOString();
  return db.prepare(`
    SELECT id, doc_number_display FROM documents
    WHERE created_by = :createdBy AND direction = :direction AND title = :title
      AND correspondent_name IS :correspondentName AND deleted_at IS NULL AND created_at >= :since
    ORDER BY created_at DESC LIMIT 1
  `).get({ createdBy, direction, title, correspondentName: correspondentName || null, since });
}

function assertNotJustRegistered(clean) {
  const { title } = clean;
  const recent = findJustRegistered(clean);
  if (!recent) return;
  throw httpError(409,
    `เพิ่งลงทะเบียนเรื่องนี้ไปแล้วเมื่อครู่ เป็นเลขที่ ${recent.doc_number_display} — ถ้ากดพลาดสองครั้ง ไม่ต้องทำอะไรต่อ`,
    { duplicateOf: recent.id, duplicateDocNumber: recent.doc_number_display,
      confirmRetry: { field: 'allowDuplicate',
        message: `เรื่อง "${title}" เพิ่งถูกลงทะเบียนไปแล้วเป็นเลขที่ ${recent.doc_number_display} เมื่อครู่นี้\n\nถ้าเป็นหนังสือคนละฉบับที่บังเอิญชื่อเรื่องเหมือนกัน กด "ตกลง" เพื่อลงทะเบียนเพิ่มอีกฉบับ\nถ้ากดพลาดสองครั้ง กด "ยกเลิก"` } });
}

export function createDocument(input) {
  const clean = normalizeDocumentInput(input);
  let result;
  db.exec('BEGIN IMMEDIATE');
  try {
    if (!input.allowDuplicate) assertNotJustRegistered(clean);
    result = insertDocumentRow(clean);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  auditDocumentCreated(clean, result);
  return result;
}

/**
 * ตรวจและปรับค่าของหนังสือหนึ่งฉบับให้พร้อมบันทึก โดยยังไม่แตะฐานข้อมูล
 *
 * แยกออกมาจากการเขียนจริง เพื่อให้การลงรับหลายฉบับรวดเดียวตรวจ "ทุกฉบับ" ให้ผ่านก่อน แล้วค่อยเริ่มเขียน
 * ไม่ใช่ออกเลขรับให้ 6 ฉบับแรกไปแล้วค่อยพบว่าฉบับที่ 7 กรอกวันที่ผิด — เลขรับที่ออกไปแล้วนำกลับมาใช้ซ้ำ
 * ไม่ได้ตามหลักงานสารบรรณ ทะเบียนจะมีเลขขาดหายเป็นรูโหว่ที่อธิบายไม่ได้ตอนตรวจ
 */
function normalizeDocumentInput({ direction, title, subject, docTypeId, departmentId, priority, secretLevel, correspondentName, externalDocNumber, externalDocDate, receivedDate, dueDate, retentionClass, customDocNumber, createdBy }) {
  title = typeof title === 'string' ? title.trim() : title;
  correspondentName = typeof correspondentName === 'string' ? correspondentName.trim() : correspondentName;
  if (!title) throw httpError(400, 'กรุณากรอกชื่อเรื่อง');
  if (!correspondentName) throw httpError(400, 'กรุณากรอกชื่อหน่วยงาน/บุคคลต้นทาง-ปลายทาง');
  if (!departmentId) throw httpError(400, 'กรุณาเลือกฝ่ายที่รับผิดชอบ');
  // ฐานข้อมูลเปิด foreign_keys ไว้ ฝ่ายที่ไม่มีอยู่จริงจึงถูกปฏิเสธอยู่แล้ว แต่ข้อความที่ได้เป็นข้อความ
  // ของ SQLite ล้วนๆ ซึ่งผู้ใช้อ่านไม่รู้เรื่อง — ดักเองก่อนเพื่อบอกให้ตรงว่าผิดตรงไหน
  if (!db.prepare('SELECT 1 x FROM departments WHERE id = ?').get(departmentId)) {
    throw httpError(400, 'ไม่พบฝ่ายที่เลือก — กรุณาเลือกฝ่ายที่รับผิดชอบใหม่');
  }
  if (direction && !VALID_DIRECTION.has(direction)) throw httpError(400, 'ประเภทหนังสือ (เข้า/ออก) ไม่ถูกต้อง');
  if (priority && !VALID_PRIORITY.has(priority)) throw httpError(400, `ชั้นความเร็ว "${priority}" ไม่ถูกต้อง`);
  if (secretLevel && !VALID_SECRET.has(secretLevel)) throw httpError(400, `ชั้นความลับ "${secretLevel}" ไม่ถูกต้อง`);
  if (retentionClass && !(retentionClass in RETENTION_YEARS)) throw httpError(400, `อายุการเก็บ "${retentionClass}" ไม่ถูกต้อง`);
  for (const [field, label] of [['title', 'ชื่อเรื่อง'], ['subject', 'สาระสำคัญ'], ['correspondentName', 'ชื่อหน่วยงาน'],
    ['externalDocNumber', 'เลขที่หนังสือต้นทาง'], ['customDocNumber', 'เลขที่กำหนดเอง']]) {
    assertLength({ title, subject, correspondentName, externalDocNumber, customDocNumber }[field], field, label);
  }
  return {
    direction, title, subject, docTypeId, departmentId, priority, secretLevel, correspondentName,
    externalDocNumber, customDocNumber, createdBy,
    externalDocDate: normalizeDate(externalDocDate, 'วันที่ของหนังสือต้นทาง'),
    // วันที่รับจริง — ไม่กรอกมาถือว่ารับวันนี้ ซึ่งเป็นกรณีปกติที่สุด (ลงรับทันทีที่หนังสือมาถึง)
    // หนังสือส่งไม่มีวันที่รับ จึงเก็บเป็น null ไว้ ไม่ใช่ยัดวันนี้ลงไปให้ทุกฉบับ
    receivedDate: direction === 'incoming'
      ? (normalizeDate(receivedDate, 'วันที่รับหนังสือ') || todayInBangkok())
      : null,
    dueDate: normalizeDate(dueDate, 'วันครบกำหนด'),
  };
}

// ต้องเรียกอยู่ภายใน transaction ของผู้เรียกเสมอ — การอ่าน+บวกตัวนับเลขรับกับการ INSERT ต้องอยู่ก้อนเดียวกัน
function insertDocumentRow({ direction, title, subject, docTypeId, departmentId, priority, secretLevel, correspondentName, externalDocNumber, externalDocDate, receivedDate, dueDate, retentionClass, customDocNumber, createdBy }) {
  const { runningNumber, yearBe, display: autoDisplay } = nextRunningNumber({ direction });
  const display = customDocNumber || autoDisplay;
  let duplicateDocNumberWarning = null;
  if (customDocNumber) {
    const dup = db.prepare('SELECT doc_number_display FROM documents WHERE doc_number_display = ? AND deleted_at IS NULL').get(customDocNumber);
    if (dup) duplicateDocNumberWarning = `เลขที่ "${customDocNumber}" ซ้ำกับเอกสารที่มีอยู่แล้วในระบบ — บันทึกให้แล้วตามที่กรอก แต่โปรดตรวจสอบว่าตั้งใจใช้เลขซ้ำจริงหรือไม่`;
  }
  const id = uuid();
  const now = nowIso();
  const retClass = retentionClass || 'normal_10y';
  const retentionUntil = computeRetentionUntil(yearBe, retClass);
  db.prepare(`
    INSERT INTO documents (id, direction, running_number, year_be, doc_number_display, external_doc_number, external_doc_date, received_date, title, subject,
      doc_type_id, department_id, priority, secret_level, correspondent_name, status, due_date, retention_class, retention_until, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'registered', ?, ?, ?, ?, ?, ?)
  `).run(id, direction, runningNumber, yearBe, display, externalDocNumber || null, externalDocDate || null, receivedDate || null, title, subject || null,
    docTypeId, departmentId, priority || 'normal', secretLevel || 'normal', correspondentName || null, dueDate || null, retClass, retentionUntil, createdBy, now, now);
  return { id, docNumberDisplay: display, duplicateDocNumberWarning };
}

// บันทึก audit หลัง COMMIT เสมอ ไม่ใช่ระหว่างทาง — ถ้า rollback แล้วจะได้ไม่เหลือร่องรอยของหนังสือที่ไม่มีอยู่จริง
function auditDocumentCreated(clean, result) {
  audit({
    userId: clean.createdBy,
    action: clean.direction === 'incoming' ? 'document_received' : 'document_created',
    tableName: 'documents', recordId: result.id,
    detail: { docNumberDisplay: result.docNumberDisplay, customDocNumber: clean.customDocNumber || null },
  });
}

// ลงรับได้ครั้งละไม่เกินเท่านี้ — กันการยิงคำขอก้อนมหึมาเข้ามาทีเดียว และเป็นจำนวนที่มากพอสำหรับ
// ซองหนังสือที่มาถึงโรงเรียนในหนึ่งวันจริงๆ (ปกติวันละไม่กี่ฉบับ วันประชุมใหญ่ก็ไม่เกินหลักสิบ)
export const MAX_BULK_DOCUMENTS = 50;

/**
 * ลงรับหนังสือหลายฉบับรวดเดียว — ตรวจครบทุกฉบับก่อน แล้วออกเลขรับให้ทั้งชุดใน transaction เดียว
 * ถ้าฉบับใดฉบับหนึ่งบันทึกไม่สำเร็จ จะไม่มีฉบับไหนถูกบันทึกเลย และตัวนับเลขรับไม่ขยับ
 */
export function createDocumentsBulk(items, createdBy, { allowDuplicate } = {}) {
  if (!Array.isArray(items) || items.length === 0) throw httpError(400, 'ยังไม่ได้กรอกรายการหนังสือที่จะลงรับ');
  if (items.length > MAX_BULK_DOCUMENTS) {
    throw httpError(400, `ลงรับได้ครั้งละไม่เกิน ${MAX_BULK_DOCUMENTS} ฉบับ (ส่งมา ${items.length} ฉบับ) — กรุณาแบ่งเป็นหลายรอบ`);
  }
  const cleaned = items.map((item, i) => {
    try {
      return normalizeDocumentInput({ ...item, createdBy });
    } catch (e) {
      // บอกให้ชัดว่าแถวไหนผิด ไม่งั้นผู้ใช้ที่กรอกมา 20 แถวต้องไล่หาเองว่าแถวไหนที่ทำให้ทั้งชุดไม่ผ่าน
      throw httpError(e.statusCode || 400, `แถวที่ ${i + 1}: ${e.message}`);
    }
  });
  let results;
  db.exec('BEGIN IMMEDIATE');
  try {
    // กดซ้ำตรงนี้เสียหายกว่าการลงทีละฉบับหลายเท่า — หนึ่งครั้งกินเลขทะเบียนได้ถึง 20 เลข
    // (ยิงทดสอบแล้วเกิดขึ้นจริง: กดสองทีได้ 6 ฉบับจากที่กรอกไว้ 3) ดูฉบับแรกของชุดเป็นตัวแทน
    // ถ้าฉบับแรกเพิ่งลงไปเมื่อครู่โดยคนเดียวกัน แปลว่าทั้งชุดนี้เพิ่งถูกส่งไปแล้ว
    if (!allowDuplicate) {
      const recent = findJustRegistered(cleaned[0]);
      if (recent) {
        throw httpError(409,
          `เพิ่งลงทะเบียนชุดนี้ไปแล้วเมื่อครู่ (เริ่มที่เลขที่ ${recent.doc_number_display}) — ถ้ากดพลาดสองครั้ง ไม่ต้องทำอะไรต่อ`,
          { confirmRetry: { field: 'allowDuplicate',
            message: `ชุดนี้เพิ่งถูกลงทะเบียนไปแล้วเมื่อครู่นี้ เริ่มที่เลขที่ ${recent.doc_number_display}\n\nกด "ตกลง" เพื่อลงทะเบียนซ้ำอีกชุด (จะกินเลขทะเบียนเพิ่มอีก ${cleaned.length} เลข)\nถ้ากดพลาดสองครั้ง กด "ยกเลิก"` } });
      }
    }
    results = cleaned.map(insertDocumentRow);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  cleaned.forEach((clean, i) => auditDocumentCreated(clean, results[i]));
  return results;
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
    -- ต้องมีตัวตัดสินเสมอกันด้วย ตั้งแต่ ผอ. ส่งให้หลายคนพร้อมกันได้ เพราะคนที่อยู่ขั้นเดียวกันมี
    -- step_order เท่ากัน ถ้าเรียงด้วย step_order อย่างเดียว ลำดับของคนในขั้นนั้นไม่ถูกกำหนดตามมาตรฐาน
    -- SQL แล้วแต่ว่าฐานข้อมูลจะคืนมาแบบไหน — ไทม์ไลน์กับหน้าพิมพ์ของหนังสือฉบับเดียวกันอาจสลับที่กันเอง
    -- ระหว่างการเปิดสองครั้ง ซึ่งอ่านเป็นความผิดพลาดของเอกสารราชการ
    WHERE ws.document_id = ? ORDER BY ws.step_order ASC, ws.created_at ASC, ws.rowid ASC
  `).all(documentId);
}

/**
 * จัดขั้นตอนเป็นกลุ่มตาม "ขั้นที่" — คนที่อยู่ขั้นเดียวกันคือคนที่ได้รับเรื่องพร้อมกัน
 *
 * ต้องแยกให้เห็นชัด ไม่งั้นทั้งไทม์ไลน์และหน้าพิมพ์จะไล่ชื่อทีละคนเหมือนกันหมด คนอ่านจะเข้าใจว่า
 * หนังสือวิ่งผ่านคนเหล่านั้นทีละคนตามลำดับ ทั้งที่ ผอ. สั่งการถึงทุกคนพร้อมกันในครั้งเดียว —
 * สำหรับหนังสือราชการ สองอย่างนี้มีความหมายต่างกันโดยสิ้นเชิง
 */
export function groupStepsByOrder(steps) {
  const groups = [];
  for (const step of steps) {
    const last = groups[groups.length - 1];
    if (last && last.order === step.step_order) last.steps.push(step);
    else groups.push({ order: step.step_order, steps: [step] });
  }
  return groups;
}

// ขั้นตอนที่ "ลงนามไปแล้วจริง" — อนุมัติหรือรับทราบ ซึ่งทั้งสองอย่างผ่านการยืนยัน PIN มาแล้ว
export const SIGNED_STEP_STATUSES = ['approved', 'acknowledged'];
export const isSignedStep = (step) => SIGNED_STEP_STATUSES.includes(step?.status);

/**
 * ชื่อและตำแหน่งของผู้ลงนาม "ณ วันที่ลงนาม" สำหรับใช้เป็นหลักฐานบนหนังสือ
 *
 * ต้องอ่านจากคอลัมน์สำเนา (signer_name / signer_position) ก่อนเสมอ ไม่ใช่จาก users — เดิมทั้งหน้าพิมพ์
 * "บันทึกข้อความ" และไทม์ไลน์บนหน้าเอกสารดึงชื่อ/ตำแหน่งปัจจุบันจากตาราง users มาแสดงใต้ลายเซ็น พอครูคนนั้น
 * เลื่อนวิทยฐานะ (ครูผู้ช่วย → ครู คศ.1 ซึ่งเกิดขึ้นเป็นปกติทุกปี) เปลี่ยนนามสกุล หรือย้ายโรงเรียน ตำแหน่งใต้
 * ลายเซ็นบนหนังสือที่ลงนามและเก็บเข้าแฟ้มไปแล้ว "ทุกฉบับย้อนหลัง" จะเปลี่ยนตามไปด้วย ทั้งที่ตอนลงนามจริง
 * เขายังเป็นอีกตำแหน่งหนึ่ง — หนังสือที่พิมพ์วันนี้กับที่พิมพ์เมื่อปีที่แล้วจะไม่ตรงกัน ใช้อ้างอิงไม่ได้
 *
 * ค่าจาก users เหลือไว้เป็นทางถอยสำหรับขั้นตอนเก่าที่บันทึกไว้ก่อนจะมีคอลัมน์สำเนา (สำเนาเป็น NULL)
 */
export function signerIdentity(step) {
  const liveName = `${step.prefix || ''}${step.first_name || ''} ${step.last_name || ''}`.trim();
  return {
    name: (step.signer_name || '').trim() || liveName || 'ไม่ทราบชื่อ',
    position: (step.signer_position || '').trim() || (step.position || '').trim(),
  };
}

export function currentStep(documentId) {
  return db.prepare(`
    SELECT * FROM workflow_steps WHERE document_id = ? AND status = 'waiting'
    ORDER BY step_order DESC LIMIT 1
  `).get(documentId);
}

/**
 * ขั้นตอนที่ค้างอยู่ "ของคนที่กำลังเปิดดู" — ไม่ใช่ขั้นตอนล่าสุดของเอกสารเฉยๆ
 *
 * จำเป็นตั้งแต่ ผอ. ส่งเรื่องให้หลายคนพร้อมกันได้ เพราะตอนนี้หนังสือหนึ่งฉบับมีขั้นตอนที่ค้างอยู่
 * พร้อมกันได้หลายอัน ถ้ายังใช้ currentStep เดิม (เอาอันบนสุดอันเดียว) คนที่ถูกสั่งการคนที่ 2-4 จะเปิด
 * หน้าหนังสือแล้วเห็นว่าเป็นงานของคนอื่น กดรับทราบไม่ได้เลย ทั้งที่ ผอ. สั่งถึงตัวเองด้วย
 *
 * ลำดับการเลือก: ขั้นตอนของตัวเอง → ขั้นตอนของคนที่ตัวเองรักษาการแทนอยู่ → ขั้นตอนล่าสุดของเอกสาร
 * (อันสุดท้ายไว้ให้คนนอกที่แค่เปิดดู ยังเห็นว่าตอนนี้เรื่องอยู่ที่ใคร)
 */
export function currentStepFor(documentId, userId) {
  const mine = db.prepare(`
    SELECT * FROM workflow_steps WHERE document_id = ? AND status = 'waiting' AND assignee_id = ?
    ORDER BY step_order DESC LIMIT 1
  `).get(documentId, userId);
  if (mine) return mine;
  const today = todayInBangkok();
  const delegated = db.prepare(`
    SELECT ws.* FROM workflow_steps ws
    JOIN user_delegations ud ON ud.delegator_id = ws.assignee_id
    WHERE ws.document_id = ? AND ws.status = 'waiting' AND ud.delegate_id = ? AND ud.cancelled_at IS NULL
      AND ud.start_date <= ? AND ud.end_date >= ?
    ORDER BY ws.step_order DESC LIMIT 1
  `).get(documentId, userId, today, today);
  return delegated || currentStep(documentId);
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
  assertMaxLength(instruction, MAX_STEP_TEXT, 'ข้อความเกษียณ/หมายเหตุ');
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

// ---------------- แจ้งเวียนประชาสัมพันธ์ (ส่งให้ทุกคนอ่าน ไม่ต้องลงนามรับทราบรายคน) ----------------

// ใครกดแจ้งเวียนได้ — ชุดเดียวกับผู้ที่โพสต์ประกาศบนบอร์ดได้ (routes/announcements.js) เพราะเป็น
// การสื่อสารถึงบุคลากรทั้งโรงเรียนเหมือนกัน ในทางปฏิบัติธุรการเป็นคนกดจริง ส่วน ผอ./รอง ผอ. สั่งให้
// ธุรการแจ้งเวียน แต่เปิดให้กดเองได้ด้วยจะได้ไม่ติดขัดเวลาธุรการไม่อยู่
const CAN_BROADCAST_ROLES = ['admin', 'director', 'vice_director', 'registrar'];
export const canBroadcast = (user) => user.roleCodes.some((r) => CAN_BROADCAST_ROLES.includes(r));

const MAX_BROADCAST_NOTE = 1000;

// สถานะที่แจ้งเวียนไม่ได้ — เรื่องที่ยกเลิก/ทำลาย/ไม่อนุมัติไปแล้ว ไม่ควรถูกส่งให้ทั้งโรงเรียนอ่าน
const UNBROADCASTABLE_STATUSES = ['voided', 'destroyed', 'rejected'];

export function listBroadcasts(documentId) {
  return db.prepare(`
    SELECT b.*, u.prefix, u.first_name, u.last_name
    FROM document_broadcasts b JOIN users u ON u.id = b.sent_by
    -- rowid ตัดสินเมื่อ created_at เท่ากัน — แจ้งเวียนสองครั้งรวดในวินาทีเดียวกันเกิดขึ้นได้จริง
    -- (กดซ้ำเพราะคิดว่าครั้งแรกไม่ติด) ถ้าเรียงด้วยเวลาอย่างเดียว ลำดับจะไม่แน่นอน แล้วกล่อง
    -- "ประชาสัมพันธ์แล้ว ... ล่าสุด" อาจโชว์ข้อความของครั้งเก่ากว่า
    WHERE b.document_id = ? ORDER BY b.created_at DESC, b.rowid DESC
  `).all(documentId);
}

/**
 * ส่งหนังสือให้บุคลากรทุกคนอ่าน โดยไม่สร้างขั้นตอน workflow ให้ใครต้องกด "ทราบ"
 *
 * ใช้กับหนังสือประชาสัมพันธ์/หนังสือเวียน ซึ่งตามระเบียบงานสารบรรณเป็นเรื่องที่ "แจ้งให้ทราบทั่วกัน"
 * ไม่ใช่เรื่องที่ต้องมอบหมายให้ใครไปดำเนินการแล้วลงนามกลับมา
 */
export function broadcastDocument({ documentId, note, actorUser, allowDuplicate }) {
  note = asTextOrNull(note);
  assertMaxLength(note, MAX_BROADCAST_NOTE, 'ข้อความประชาสัมพันธ์');
  const doc = getDocument(documentId);
  if (!doc) throw httpError(404, 'ไม่พบเอกสาร');
  if (!canBroadcast(actorUser)) {
    throw httpError(403, 'ประชาสัมพันธ์ให้ทุกคนได้เฉพาะธุรการ ผู้บริหาร หรือผู้ดูแลระบบเท่านั้น');
  }
  // หนังสือ "ลับ"/"ลับมาก" เปิดอ่านได้เฉพาะคนในสายเรื่องเท่านั้น (canUserSeeDocument) การส่งแจ้งเตือน
  // พร้อมชื่อเรื่องไปหาครูทุกคนจึงเป็นการเปิดเผยสิ่งที่ตั้งใจปกปิด แม้กดลิงก์เข้าไปแล้วจะเปิดไม่ได้ก็ตาม
  if (['secret', 'top_secret'].includes(doc.secret_level)) {
    throw httpError(400, 'หนังสือชั้นความลับ "ลับ"/"ลับมาก" ประชาสัมพันธ์ให้ทุกคนไม่ได้ — ถ้าต้องการให้คนอื่นเห็น ให้เปลี่ยนชั้นความลับก่อน หรือมอบหมายเป็นรายคนแทน');
  }
  if (UNBROADCASTABLE_STATUSES.includes(doc.status)) {
    throw httpError(409, 'หนังสือที่ยกเลิก/ไม่อนุมัติ/ทำลายไปแล้ว ประชาสัมพันธ์ไม่ได้');
  }

  const recipients = db.prepare(`
    SELECT id FROM users WHERE deleted_at IS NULL AND status = 'active' AND id != ?
  `).all(actorUser.id);
  if (!recipients.length) throw httpError(409, 'ยังไม่มีบุคลากรคนอื่นในระบบให้ประชาสัมพันธ์ถึง');

  const id = uuid();
  const now = nowIso();
  db.exec('BEGIN IMMEDIATE');
  try {
    // กดซ้ำ = ครูทั้งโรงเรียนได้แจ้งเตือนเรื่องเดียวกันสองรอบ (ยิงทดสอบแล้วเกิดขึ้นจริง 5 คน 2 รอบ)
    // และตั้งแต่ต่อกับไลน์แล้วก็แปลว่าได้ข้อความเข้าไลน์สองฉบับด้วย — ต้องตรวจในธุรกรรมเดียวกับการเขียน
    // ไม่งั้นคำขอสองอันที่มาพร้อมกันจะผ่านการตรวจทั้งคู่ (เหตุผลเดียวกับ assertNotJustRegistered)
    // การประชาสัมพันธ์ซ้ำเพื่อ "ย้ำเตือน" ทีหลังยังทำได้ตามปกติ เพราะพ้นช่วงเวลานี้ไปแล้ว
    if (!allowDuplicate) {
      const since = new Date(Date.now() - DUPLICATE_REGISTER_WINDOW_SECONDS * 1000).toISOString();
      const recent = db.prepare(`
        SELECT id FROM document_broadcasts WHERE document_id = ? AND sent_by = ? AND created_at >= ? LIMIT 1
      `).get(doc.id, actorUser.id, since);
      if (recent) {
        throw httpError(409, 'เพิ่งประชาสัมพันธ์หนังสือฉบับนี้ไปเมื่อครู่ — ถ้ากดพลาดสองครั้ง ไม่ต้องทำอะไรต่อ',
          { confirmRetry: { field: 'allowDuplicate',
            message: 'หนังสือฉบับนี้เพิ่งถูกประชาสัมพันธ์ไปเมื่อครู่นี้\n\nกด "ตกลง" เพื่อส่งซ้ำอีกรอบ (ทุกคนจะได้รับแจ้งเตือนอีกครั้ง)\nถ้ากดพลาดสองครั้ง กด "ยกเลิก"' } });
      }
    }
    for (const r of recipients) {
      notifyUser({
        userId: r.id, documentId: doc.id,
        title: `📢 ประชาสัมพันธ์: ${doc.doc_number_display}`,
        message: note ? `${doc.title} — ${note}` : doc.title,
        priority: doc.priority === 'most_urgent' || doc.priority === 'very_urgent' ? 'urgent' : 'info',
      });
    }
    db.prepare(`
      INSERT INTO document_broadcasts (id, document_id, note, recipient_count, sent_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, doc.id, note, recipients.length, actorUser.id, now);

    // ไม่มีใครต้องดำเนินการต่อแล้ว จึงปิดเรื่องให้เลย ไม่งั้นหนังสือจะค้างเป็น "รอดำเนินการ" บนหน้าแรก
    // ของธุรการตลอดไป ทั้งที่งานเสร็จแล้ว (หน้าแรกนับสถานะ registered/in_progress/returned เป็นงานค้าง)
    // แต่ถ้ายังมีขั้นตอนที่รอใครอยู่ ห้ามแตะสถานะ — การแจ้งเวียนเป็นการแจ้งให้ทราบคู่ขนาน ไม่ได้แปลว่า
    // งานที่มอบหมายไว้เสร็จแล้ว
    const stillWaiting = db.prepare(`SELECT 1 x FROM workflow_steps WHERE document_id = ? AND status = 'waiting'`).get(doc.id);
    if (!stillWaiting && !['completed', 'archived'].includes(doc.status)) {
      db.prepare(`UPDATE documents SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, doc.id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  audit({
    userId: actorUser.id, action: 'document_broadcast', tableName: 'document_broadcasts', recordId: id,
    detail: { documentId: doc.id, recipientCount: recipients.length, note },
  });
  return { id, recipientCount: recipients.length };
}

// ผู้ถือขั้นตอนที่ "ล็อกอินเข้ามาทำงานไม่ได้แล้วจริงๆ" — บัญชีถูกลบ (ย้ายโรงเรียน/ลาออก) หรือถูกระงับ
// assertAssignableUser กันไม่ให้มอบหมายให้คนแบบนี้ตั้งแต่แรกอยู่แล้ว แต่ไม่ได้กันกรณีที่บัญชีถูกปิด
// "หลังจาก" มอบหมายไปแล้ว ซึ่งเป็นเรื่องปกติมากในโรงเรียน เพราะครูย้ายกันทุกปีการศึกษา
export function inactiveStepHolder(step) {
  if (!step) return null;
  const u = db.prepare('SELECT id, prefix, first_name, last_name, status, deleted_at FROM users WHERE id = ?').get(step.assignee_id);
  if (!u) return null;
  if (!u.deleted_at && u.status === 'active') return null;
  // ถ้ามีผู้รักษาการแทนที่ยังมีผลอยู่ ก็ยังมีคนดำเนินการต่อได้ตามปกติ ไม่นับว่าเรื่องค้าง
  if (getActiveDelegateFor(step.assignee_id)) return null;
  return u;
}

// กู้หนังสือที่ค้างอยู่กับคนที่ปิดบัญชีไปแล้ว — เดินผ่านเบราว์เซอร์จริงแล้วพบว่าเดิมไม่มีทางออกเลย:
// แอดมินเปิดหน้าหนังสือก็ไม่มีปุ่มดำเนินการ (isCurrentAssignee ไม่รวมแอดมิน) ธุรการผู้บันทึกก็ไม่มีช่อง
// มอบหมายใหม่ (canAssign ต้องการสถานะ registered/returned แต่เรื่องค้างอยู่ที่ in_progress) และหน้าเว็บ
// ไม่บอกด้วยซ้ำว่าทำไมเรื่องไม่เดิน — หนังสือราชการฉบับนั้นค้างถาวรจนกว่าจะมีคนยิง API เอง
//
// ย้ายผู้รับผิดชอบในขั้นตอนเดิมแทนการปิดขั้นตอนแล้วเปิดใหม่ เพราะขั้นตอนนี้ยังไม่มีใครลงนาม จึงไม่มี
// ลายเซ็น/ตราประทับให้ต้องรักษา และการคงขั้นที่เดิมไว้ทำให้ลำดับใน Workflow กับหน้าพิมพ์ไม่เพี้ยน
// ร่องรอยว่าเดิมเป็นของใครเก็บไว้ทั้งในหมายเหตุของขั้นตอนและใน audit log
export function reassignStuckStep({ stepId, newAssigneeId, actorUser }) {
  const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  if (!step || step.status !== 'waiting') throw httpError(409, 'ขั้นตอนนี้ถูกดำเนินการไปแล้วหรือไม่พบ');
  const doc = documentOfStep(step);
  // เฉพาะแอดมินหรือผู้บันทึกเอกสาร — เงื่อนไขเดียวกับการมอบหมายงานปกติ
  assertCanManageDocument(doc, actorUser, 'มอบหมายผู้รับผิดชอบใหม่ในเอกสาร');

  // ต้องมี "คนถือเรื่องที่ทำงานไม่ได้จริงๆ" เท่านั้นถึงจะใช้ทางนี้ได้ ไม่งั้นทางนี้จะกลายเป็นช่องให้แอดมิน/
  // ผู้บันทึกดึงเรื่องออกจากมือคนที่กำลังพิจารณาอยู่ได้เงียบๆ ซึ่งข้ามลำดับการบังคับบัญชาใน Workflow
  const holder = inactiveStepHolder(step);
  if (!holder) throw httpError(409, 'ผู้รับผิดชอบคนปัจจุบันยังใช้งานบัญชีได้ตามปกติ จึงเปลี่ยนตัวด้วยวิธีนี้ไม่ได้ — ให้ผู้ที่ถือเรื่องอยู่กด "ส่งต่อ" หรือ "ส่งกลับแก้ไข" เอง');
  if (newAssigneeId === step.assignee_id) throw httpError(400, 'กรุณาเลือกผู้รับผิดชอบคนใหม่');
  assertAssignableUser(newAssigneeId);

  const oldName = `${holder.prefix || ''}${holder.first_name} ${holder.last_name}`.trim();
  db.prepare(`
    UPDATE workflow_steps SET assignee_id = ?, instruction = COALESCE(instruction,'') || ? WHERE id = ?
  `).run(newAssigneeId, `\n[มอบหมายใหม่] เดิมเป็นของ ${oldName} ซึ่งปิดบัญชีไปแล้ว`, stepId);
  db.prepare('UPDATE documents SET updated_at = ? WHERE id = ?').run(nowIso(), doc.id);

  notifyUser({
    userId: newAssigneeId, documentId: doc.id,
    title: `หนังสือที่ต้องดำเนินการแทน: ${doc.doc_number_display}`,
    message: `${doc.title} — เดิมเป็นของ ${oldName} ซึ่งปิดบัญชีไปแล้ว`,
    priority: doc.priority === 'most_urgent' || doc.priority === 'very_urgent' ? 'urgent' : 'info',
  });
  audit({
    userId: actorUser.id, action: 'workflow_reassigned', tableName: 'workflow_steps', recordId: stepId,
    detail: { documentId: doc.id, from: step.assignee_id, to: newAssigneeId, reason: 'ผู้ถือเรื่องเดิมปิดบัญชีแล้ว' },
  });
}

function assertOwnsStep(step, actorUser) {
  if (!step || step.status !== 'waiting') throw httpError(409, 'ขั้นตอนนี้ถูกดำเนินการไปแล้วหรือไม่พบ');
  if (step.assignee_id === actorUser.id) return;
  if (actorUser.roleCodes.includes('admin')) return;
  const delegation = getActiveDelegateFor(step.assignee_id);
  if (delegation && delegation.delegate_id === actorUser.id) return;
  throw httpError(403, 'คุณไม่มีสิทธิ์ดำเนินการขั้นตอนนี้ (ผู้ไม่มีสิทธิ์ไม่สามารถข้ามขั้น Workflow ได้)');
}

// ส่งต่อพร้อมกันได้สูงสุดกี่คน — ตรายาง "รับทราบและปฏิบัติตามคำสั่ง" มีบรรทัดให้ลงชื่อ 4 บรรทัด
// (ระบบขยายบรรทัดลงมาให้เองถ้าเกิน) เพดานนี้จึงไม่ใช่ข้อจำกัดของตรา แต่กันการกดพลาดเลือกยกโรงเรียน
// ซึ่งจะทำให้หนังสือฉบับเดียวไปโผล่เป็นงานค้างของทุกคนพร้อมกันโดยไม่มีใครตั้งใจ
export const MAX_PARALLEL_ASSIGNEES = 10;

/**
 * อนุมัติแล้วส่งต่อ — ส่งให้หลายคนพร้อมกันได้
 *
 * ผอ. สั่งการถึงครูหลายคนพร้อมกันเป็นเรื่องปกติของโรงเรียน (ตรายาง "รับทราบและปฏิบัติตามคำสั่ง" ถึงมี
 * บรรทัดให้ลงชื่อ 4 บรรทัด) เดิมระบบส่งต่อได้ทีละคนเท่านั้น เรื่องจึงกลายเป็นวิ่งต่อกันเป็นทอดๆ
 * คนที่สองต้องรอคนแรกกดเสร็จก่อน ทั้งที่บนกระดาษทุกคนได้รับพร้อมกัน
 *
 * ทุกคนได้ step_order เดียวกัน = อยู่ขั้นเดียวกันจริงๆ ไม่ใช่ไล่ลำดับกัน — ไทม์ไลน์จึงแสดงว่า
 * "ขั้นที่ N" มีหลายคน ซึ่งตรงกับความเป็นจริง
 */
export function approveAndForward({ stepId, nextAssigneeId, nextAssigneeIds, comment, actorUser }) {
  assertMaxLength(comment, MAX_STEP_TEXT, 'ความเห็น');
  const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  assertOwnsStep(step, actorUser);

  // รับได้ทั้งแบบเดิม (คนเดียว) และแบบใหม่ (หลายคน) — ตัดค่าซ้ำออก เพราะติ๊กคนเดียวกันสองที่แล้วได้
  // ขั้นตอนซ้อนสองอันให้คนคนเดียว จะกดรับทราบแล้วยังค้างอยู่อีกอันโดยไม่มีอะไรบอกว่าทำไม
  const raw = Array.isArray(nextAssigneeIds) && nextAssigneeIds.length ? nextAssigneeIds : [nextAssigneeId];
  const targets = [...new Set(raw.filter((id) => typeof id === 'string' && id))];
  if (!targets.length) throw httpError(400, 'กรุณาเลือกผู้รับที่จะส่งต่อ');
  if (targets.length > MAX_PARALLEL_ASSIGNEES) {
    throw httpError(400, `ส่งต่อพร้อมกันได้ครั้งละไม่เกิน ${MAX_PARALLEL_ASSIGNEES} คน (เลือกมา ${targets.length} คน)`);
  }
  // ตรวจให้ครบทุกคน "ก่อน" ลงมือ — ถ้าตรวจไปทำไป คนที่ผ่านด่านก่อนจะได้งานไปแล้วแต่คนหลังพัง
  // กลายเป็นส่งต่อครึ่งๆ กลางๆ ที่ผู้ใช้ไม่รู้ว่าสุดท้ายใครได้บ้าง
  for (const id of targets) {
    assertAssignableUser(id);
    // ส่งต่อให้ตัวเอง/ให้คนที่ถือเรื่องอยู่แล้ว เรื่องจะวนกลับมาที่เดิมโดยไม่คืบหน้า และดูเหมือนระบบทำงานผิด —
    // ถ้าตั้งใจจะจบเรื่องที่ตัวเอง ต้องกด "รับทราบ/ปิดเรื่อง" ไม่ใช่ "อนุมัติและส่งต่อ"
    if (id === actorUser.id || id === step.assignee_id) {
      throw httpError(400, 'ส่งต่อให้ตัวเองไม่ได้ — ถ้าต้องการจบเรื่องที่คุณ ให้กด "รับทราบ/ปิดเรื่อง" แทน');
    }
  }
  const doc = documentOfStep(step);

  const nextOrder = step.step_order + 1;
  const now = nowIso();
  // ปิดขั้นของตัวเองและเปิดขั้นของทุกคนต้องสำเร็จหรือล้มไปด้วยกัน ไม่งั้นอาจได้ขั้นที่ปิดแล้วแต่ไม่มีใครรับต่อ
  // = หนังสือค้างถาวรโดยไม่มีใครเห็นว่ามันค้างอยู่
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`UPDATE workflow_steps SET status = 'approved', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
      .run(comment ? `\n[เกษียณ] ${comment}` : '', now, stepId);
    const ins = db.prepare(`
      INSERT INTO workflow_steps (id, document_id, step_order, assignee_id, instruction, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'waiting', ?)
    `);
    for (const id of targets) ins.run(uuid(), step.document_id, nextOrder, id, comment || null, now);
    db.prepare(`UPDATE documents SET updated_at = ? WHERE id = ?`).run(now, step.document_id);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // อยู่นอกธุรกรรม เพราะเขียนลายเซ็น/ส่งแจ้งเตือนแล้วล้ม ไม่ควรย้อนการส่งต่อที่สำเร็จไปแล้วทิ้ง
  snapshotSignature(stepId, actorUser.id);

  for (const id of targets) {
    notifyUser({
      userId: id, documentId: step.document_id,
      title: `ส่งต่อถึงคุณ: ${doc.doc_number_display}`, message: doc.title, priority: 'info',
    });
  }

  audit({ userId: actorUser.id, action: 'workflow_approved_forward', tableName: 'workflow_steps', recordId: stepId, detail: { nextAssigneeIds: targets, comment } });
}

export function acknowledgeAndComplete({ stepId, comment, actorUser }) {
  assertMaxLength(comment, MAX_STEP_TEXT, 'ความเห็น');
  const step = db.prepare('SELECT * FROM workflow_steps WHERE id = ?').get(stepId);
  assertOwnsStep(step, actorUser);
  const doc = documentOfStep(step);

  db.prepare(`UPDATE workflow_steps SET status = 'acknowledged', instruction = COALESCE(instruction,'') || ?, decided_at = ? WHERE id = ?`)
    .run(comment ? `\n[รับทราบ] ${comment}` : '', nowIso(), stepId);
  snapshotSignature(stepId, actorUser.id);

  // ปิดเรื่องได้ต่อเมื่อ "ไม่เหลือใครต้องทำต่อแล้ว" เท่านั้น
  //
  // ตั้งแต่ ผอ. ส่งเรื่องให้หลายคนพร้อมกันได้ หนังสือหนึ่งฉบับมีขั้นตอนค้างพร้อมกันได้หลายอัน ถ้ายังปิดเรื่อง
  // ทันทีที่มีคนแรกกดรับทราบ อีกสามคนที่ ผอ. สั่งถึงจะเหลืองานค้างอยู่ในหนังสือที่ขึ้นว่า "เสร็จสิ้น" แล้ว
  // — หายไปจากรายการงานของธุรการ ไม่มีใครตามต่อ และตราบนกระดาษก็จะมีชื่อคนเดียวจากสี่บรรทัด
  const stillWaiting = db.prepare(`SELECT COUNT(*) c FROM workflow_steps WHERE document_id = ? AND status = 'waiting'`)
    .get(step.document_id).c;
  const who = `${actorUser.prefix || ''}${actorUser.first_name} ${actorUser.last_name}`.trim();
  if (!stillWaiting) {
    // completed_at ต้องเป็นคอลัมน์แยกของตัวเอง ห้ามใช้ updated_at แทน — updated_at ขยับทุกครั้งที่มีการ
    // แตะเอกสารทีหลัง (กดจัดเก็บเข้าแฟ้ม เลื่อนตำแหน่งตราประทับ หรือทำลายเมื่อครบอายุอีก 10 ปีข้างหน้า)
    // ตัวเลข "ระยะเวลาเฉลี่ยจนเสร็จสิ้น" บนแดชบอร์ดและหน้ารายงานจึงพองตาม (วัดจริงแล้ว: หนังสือที่เสร็จ
    // ภายใน 1 วัน พอกดจัดเก็บอีก 90 วันให้หลัง กลายเป็น 2,160 ชั่วโมง) ซึ่งเป็นตัวเลขที่โรงเรียนรายงาน สพฐ.
    db.prepare(`UPDATE documents SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?`)
      .run(nowIso(), nowIso(), step.document_id);
  } else {
    db.prepare(`UPDATE documents SET updated_at = ? WHERE id = ?`).run(nowIso(), step.document_id);
  }

  notifyUser({
    userId: doc.created_by, documentId: doc.id,
    title: stillWaiting
      ? `รับทราบแล้ว 1 คน (เหลืออีก ${stillWaiting} คน): ${doc.doc_number_display}`
      : `รับทราบและดำเนินการเสร็จสิ้น: ${doc.doc_number_display}`,
    message: stillWaiting
      ? `${who} ได้รับทราบแล้ว — ยังรอผู้รับผิดชอบอีก ${stillWaiting} คน`
      : `${who} ได้รับทราบและปิดเรื่องแล้ว`,
    priority: stillWaiting ? 'info' : 'success',
  });

  audit({ userId: actorUser.id, action: 'workflow_acknowledged_completed', tableName: 'workflow_steps', recordId: stepId, detail: { comment, stillWaiting } });
}

export function rejectStep({ stepId, reason, actorUser }) {
  assertMaxLength(reason, MAX_STEP_TEXT, 'เหตุผล');
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
  assertMaxLength(reason, MAX_STEP_TEXT, 'เหตุผล');
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
  // ค่าที่ไม่ใช่ข้อความ (undefined เมื่อไม่ได้ส่งช่องนี้มา หรือชนิดอื่นจาก client ที่ยิงเอง) ทำให้
  // SQLite ผูกค่าไม่ได้แล้วตอบ 500 พร้อมข้อความ "Provided value cannot be bound to SQLite
  // parameter 1" ภาษาอังกฤษดิบๆ ใส่หน้าผู้ใช้ (ยิงทดสอบแล้วเกิดขึ้นจริง)
  reason = asTextOrNull(reason);
  assertMaxLength(reason, MAX_STEP_TEXT, 'เหตุผลการยกเลิก');
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
