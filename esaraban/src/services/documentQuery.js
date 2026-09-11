// เงื่อนไขค้นหา/กรองของทะเบียนหนังสือ — ที่เดียวสำหรับทั้งหน้ารายการ, ไฟล์ Excel และหน้าพิมพ์ทะเบียน
//
// สามที่นี้ต้องให้ผลตรงกันเป๊ะ ถ้าปล่อยให้ต่างคนต่างประกอบ SQL เอง สิ่งที่จะเกิดคือธุรการกรองบนหน้าเว็บ
// ได้ 40 ฉบับ แต่กด "ออก Excel" แล้วได้ 63 ฉบับ (หรือแย่กว่านั้นคือไฟล์ที่ส่งออกมีหนังสือลับที่คนนั้น
// ไม่มีสิทธิ์เห็นติดไปด้วย) โดยไม่มีอะไรฟ้องเลยจนกว่าจะมีคนเอาสองอันมาเทียบกัน
import { db, todayInBangkok, beYear, arabicDigits } from '../db.js';
import { LABELS, fmtThaiDateLong } from '../render.js';
import { visibleDocumentsSqlFilter } from './workflow.js';

// สถานะที่ถือว่า "ปิดเรื่องแล้ว" — เรื่องพวกนี้ไม่นับว่าเลยกำหนดอีก ต้องตรงกับตัวเลขบนแดชบอร์ด
export const CLOSED_STATUSES = ['completed', 'archived', 'voided', 'destroyed', 'rejected'];

// ค่าที่ไม่รู้จักให้ตกเป็นค่าว่าง (= ไม่กรอง) แทนที่จะยิงเข้า SQL ตรงๆ — พิมพ์ ?priority=xxx มั่วๆ
// แล้วต้องได้ "ทุกความเร็ว" ไม่ใช่ตารางว่างเปล่าที่ชวนให้เข้าใจผิดว่าไม่มีหนังสือ
const pick = (value, allowed) => (allowed.includes(value) ? value : '');

/**
 * แปลง query string ของหน้าทะเบียนเป็นเงื่อนไข SQL พร้อมพารามิเตอร์
 *
 * ค่าที่รับมาทั้งหมดผูกเป็น named parameter ไม่ต่อสตริงเข้า SQL และมีเงื่อนไขสิทธิ์
 * (visibleDocumentsSqlFilter) ติดไปกับทุกคำสั่งเสมอ ผู้เรียกลืมใส่เองไม่ได้
 */
export function buildDocumentQuery(user, query = {}) {
  // direction=all คือโหมดค้นหารวม ใช้กับแถบค้นหาด้านบนสุด — เดิมแถบนั้นส่งแต่ q ไปที่ /documents
  // ซึ่ง default เป็น incoming เสมอ ผลคือค้นเลขหนังสือ "ออก" จากแถบบนสุดแล้วไม่เจออะไรเลย
  // ทั้งที่หนังสือฉบับนั้นมีอยู่จริงในระบบ (ทดสอบยืนยันแล้ว)
  const direction = ['outgoing', 'all'].includes(query.direction) ? query.direction : 'incoming';
  const q = (query.q || '').trim();
  const statusFilter = pick(query.status, Object.keys(LABELS.STATUS_LABEL));

  // กรองสิทธิ์ตั้งแต่ในฐานข้อมูล ไม่ใช่ดึงมาแล้วค่อยกรองด้วย JS — ไม่งั้น LIMIT จะนับรวมฉบับที่ผู้ใช้
  // ไม่มีสิทธิ์เห็นไปด้วย แล้วจำนวนที่แสดงกับการแบ่งหน้าจะผิดทั้งคู่
  const visible = visibleDocumentsSqlFilter(user);
  const where = ['d.deleted_at IS NULL', visible.sql];
  const params = { ...visible.params };
  if (direction !== 'all') { where.push('d.direction = :direction'); params.direction = direction; }
  if (statusFilter) { where.push('d.status = :status'); params.status = statusFilter; }
  if (q) {
    // ค้นให้ครบทุกอย่างที่ธุรการ "มีอยู่ในมือ" ตอนตามหาหนังสือ ไม่ใช่แค่ข้อมูลที่ระบบออกให้เอง:
    // - external_doc_number = "ที่" ของหนังสือต้นทาง (เช่น ศธ ๐๔๐๔๙/ว๑๒๓) ซึ่งบ่อยครั้งเป็นสิ่งเดียว
    //   ที่คนโทรมาถามบอกได้ ระบบเก็บและพิมพ์ลงทะเบียนอยู่แล้ว แต่เดิมค้นไม่เจอ
    // - ชื่อไฟล์แนบ = เวลาจำได้แต่ชื่อไฟล์สแกน หรือหาว่า "ไฟล์นี้อยู่กับหนังสือฉบับไหน"
    // thdigits() แปลงเลขไทยเป็นเลขอารบิกทั้งสองฝั่งก่อนเทียบ คนพิมพ์ "04049" จึงเจอ "ศธ ๐๔๐๔๙/ว๑๒๓"
    // และคนพิมพ์ "๐๔๐๔๙" ก็เจอฉบับที่ธุรการพิมพ์เป็นเลขอารบิกไว้ (ดูเหตุผลเต็มที่ db.js)
    //
    // ครอบเฉพาะตอนที่คำค้นมีตัวเลขอยู่จริง เพราะ thdigits() เปลี่ยนเฉพาะตัวเลข ถ้าคำค้นไม่มีเลขสักตัว
    // ผลลัพธ์จะเหมือนเดิมทุกประการอยู่แล้ว แต่ต้องเรียกฟังก์ชันทุกช่องของทุกแถว — วัดกับทะเบียน 5,000
    // ฉบับแล้วต่างกัน 1.7 ms เป็น 17.3 ms ซึ่งเป็นราคาที่จ่ายฟรีๆ ทุกครั้งที่ครูค้นด้วยชื่อเรื่องเปล่าๆ
    const numeric = /[0-9๐-๙]/.test(q);
    const col = (c) => (numeric ? `thdigits(${c})` : c);
    where.push(`(${col('d.title')} LIKE :like OR ${col('d.doc_number_display')} LIKE :like
      OR ${col('d.subject')} LIKE :like OR ${col('d.correspondent_name')} LIKE :like
      OR ${col('d.external_doc_number')} LIKE :like
      OR EXISTS (SELECT 1 FROM attachments af WHERE af.document_id = d.id AND ${col('af.filename')} LIKE :like))`);
    params.like = `%${numeric ? arabicDigits(q) : q}%`;
  }

  const f = {
    dept: query.dept || '',
    priority: pick(query.priority, Object.keys(LABELS.PRIORITY_LABEL)),
    secret: pick(query.secret, Object.keys(LABELS.SECRET_LABEL)),
    from: /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : '',
    // ทะเบียนหนังสือรับ/ส่งเป็น "เล่มต่อปี" ตามระเบียบงานสารบรรณ (เลขรับเริ่มที่ 1 ใหม่ทุกวันที่ 1 ม.ค.)
    // เดิมกรองได้แค่ช่วงวันที่ซึ่งธุรการต้องพิมพ์เป็น ค.ศ. เอง ทั้งที่สิ่งที่ต้องการจริงคือ "ทะเบียนปี ๒๕๖๙"
    // กรองจาก year_be ตรงๆ ไม่ใช่จาก created_at เพราะเลขบนหน้าเอกสารคือปีนั้น
    year: /^\d{4}$/.test(query.year || '') ? Number(query.year) : '',
    overdue: query.overdue === '1',
    // "เฉพาะที่มีไฟล์แนบ" — ธุรการตามหา "ตัวไฟล์สแกน" ไม่ใช่แค่แถวในทะเบียน หนังสือที่ลงเลขไว้ก่อน
    // แล้วยังไม่ได้สแกนจึงเป็นสิ่งที่อยากกรองออก (หรือกรองเข้ามาเพื่อไล่ตามให้ครบ)
    hasFile: query.hasFile === '1',
  };
  if (f.year) { where.push('d.year_be = :yearBe'); params.yearBe = f.year; }
  if (f.dept) { where.push('d.department_id = :dept'); params.dept = f.dept; }
  if (f.priority) { where.push('d.priority = :priority'); params.priority = f.priority; }
  if (f.secret) { where.push('d.secret_level = :secret'); params.secret = f.secret; }
  // created_at เก็บเป็น ISO เต็ม (มีเวลาต่อท้าย) การเทียบกับวันที่ล้วนต้องตัดเอาเฉพาะ 10 ตัวแรก
  // ไม่งั้น "ถึงวันที่ 31 ส.ค." จะไม่รวมเอกสารที่ลงทะเบียนตอนบ่ายของวันที่ 31 เอง
  if (f.from) { where.push('substr(d.created_at, 1, 10) >= :from'); params.from = f.from; }
  if (f.to) { where.push('substr(d.created_at, 1, 10) <= :to'); params.to = f.to; }
  // ไม่นับไฟล์ที่ถูกทำลายตามระเบียบไปแล้ว — ตัวไฟล์ไม่มีอยู่จริงแล้ว ถ้ายังนับอยู่ ตัวกรอง "เฉพาะที่มีไฟล์แนบ"
  // จะพาไปเจอหนังสือที่เปิดไฟล์ไม่ได้ ซึ่งตรงข้ามกับที่ตัวกรองนี้มีไว้เพื่ออะไร
  if (f.hasFile) where.push('EXISTS (SELECT 1 FROM attachments ax WHERE ax.document_id = d.id AND ax.destroyed_at IS NULL)');
  if (f.overdue) {
    // "เลยกำหนด" ต้องนับจากวันนี้ตามเวลาไทย และนับเฉพาะเรื่องที่ยังไม่ปิด
    where.push(`d.due_date IS NOT NULL AND d.due_date < :today
      AND d.status NOT IN (${CLOSED_STATUSES.map((s) => `'${s}'`).join(', ')})`);
    params.today = todayInBangkok();
  }

  const activeFilters = Object.values(f).filter(Boolean).length;
  return {
    direction, q, statusFilter, f, params,
    whereSql: where.join(' AND '),
    activeFilters,
    filtering: activeFilters > 0 || Boolean(q) || Boolean(statusFilter),
  };
}

const SELECT_COLUMNS = `
  d.*, dt.name as type_name, dep.name as dept_name,
  -- นับไฟล์แนบมาด้วยเลย เพื่อให้รายการทะเบียนบอกได้ว่าฉบับไหน "มีไฟล์แล้ว" โดยไม่ต้องเปิดทีละฉบับ
  -- ไม่นับไฟล์ที่ถูกทำลายตามระเบียบ ไม่งั้นทะเบียนจะขึ้น 📎 ให้หนังสือที่ไฟล์ถูกลบทิ้งไปแล้ว
  (SELECT COUNT(*) FROM attachments ac WHERE ac.document_id = d.id AND ac.destroyed_at IS NULL) AS attachment_count
  FROM documents d
  JOIN document_types dt ON dt.id = d.doc_type_id
  JOIN departments dep ON dep.id = d.department_id`;

/** ปี พ.ศ. ที่มีหนังสืออยู่จริง (เฉพาะที่ผู้ใช้คนนี้เห็นได้) — ใช้สร้างตัวเลือก "ทะเบียนปี ..." */
export function listRegisterYears(user, direction) {
  const visible = visibleDocumentsSqlFilter(user);
  const where = ['d.deleted_at IS NULL', visible.sql];
  const params = { ...visible.params };
  if (direction && direction !== 'all') { where.push('d.direction = :direction'); params.direction = direction; }
  const years = db.prepare(`SELECT DISTINCT d.year_be y FROM documents d WHERE ${where.join(' AND ')} ORDER BY y DESC`)
    .all(params).map((r) => r.y);
  // ปีปัจจุบันต้องมีให้เลือกเสมอ แม้ยังไม่มีหนังสือสักฉบับ (ต้นปีที่เพิ่งขึ้นปีใหม่)
  const current = beYear();
  return years.includes(current) ? years : [current, ...years];
}

export function countDocuments({ whereSql, params }) {
  return db.prepare(`SELECT COUNT(*) as c FROM documents d WHERE ${whereSql}`).get(params).c;
}

/** @param {{limit?: number, offset?: number}} page เว้นว่าง = เอาทั้งหมด (ใช้ตอนส่งออกไฟล์) */
export function listDocuments({ whereSql, params }, page = {}) {
  const limit = Number.isInteger(page.limit) ? ` LIMIT ${page.limit} OFFSET ${Number(page.offset) || 0}` : '';
  return db.prepare(`SELECT ${SELECT_COLUMNS} WHERE ${whereSql} ORDER BY d.created_at DESC${limit}`).all(params);
}

/** บรรยายเงื่อนไขที่ใช้กรองเป็นข้อความไทย — พิมพ์กำกับหัวทะเบียนไว้ว่าไฟล์นี้คือหนังสือชุดไหน */
export function describeFilters({ q, statusFilter, f }) {
  const parts = [];
  if (q) parts.push(`คำค้น "${q}"`);
  if (statusFilter) parts.push(`สถานะ ${LABELS.STATUS_LABEL[statusFilter]}`);
  if (f.dept) {
    const dep = db.prepare('SELECT name FROM departments WHERE id = ?').get(f.dept);
    if (dep) parts.push(`ฝ่าย ${dep.name}`);
  }
  if (f.priority) parts.push(`ความเร็ว ${LABELS.PRIORITY_LABEL[f.priority]}`);
  if (f.hasFile) parts.push('เฉพาะที่มีไฟล์แนบแล้ว');
  if (f.secret) parts.push(`ชั้นความลับ ${LABELS.SECRET_LABEL[f.secret]}`);
  // ข้อความนี้ถูกพิมพ์กำกับหัว "ทะเบียนหนังสือรับ/ส่ง" ที่เก็บเข้าแฟ้มเป็นเอกสารราชการ — วันที่บนนั้น
  // ต้องเป็น พ.ศ. แบบไทย ไม่ใช่ค่าดิบจาก <input type="date"> ที่เป็น ค.ศ. (เดิมพิมพ์ออกมาว่า
  // "เงื่อนไข: ตั้งแต่ 2026-08-01 · ถึง 2026-08-31" ซึ่งอ่านไม่ได้ความในทะเบียนของโรงเรียน)
  if (f.from) parts.push(`ตั้งแต่ ${fmtThaiDateLong(f.from)}`);
  if (f.to) parts.push(`ถึง ${fmtThaiDateLong(f.to)}`);
  if (f.year) parts.push(`ปี พ.ศ. ${f.year}`);
  if (f.overdue) parts.push('เฉพาะที่เลยกำหนดและยังไม่ปิด');
  return parts.join(' · ');
}
