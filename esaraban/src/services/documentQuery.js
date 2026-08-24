// เงื่อนไขค้นหา/กรองของทะเบียนหนังสือ — ที่เดียวสำหรับทั้งหน้ารายการ, ไฟล์ Excel และหน้าพิมพ์ทะเบียน
//
// สามที่นี้ต้องให้ผลตรงกันเป๊ะ ถ้าปล่อยให้ต่างคนต่างประกอบ SQL เอง สิ่งที่จะเกิดคือธุรการกรองบนหน้าเว็บ
// ได้ 40 ฉบับ แต่กด "ออก Excel" แล้วได้ 63 ฉบับ (หรือแย่กว่านั้นคือไฟล์ที่ส่งออกมีหนังสือลับที่คนนั้น
// ไม่มีสิทธิ์เห็นติดไปด้วย) โดยไม่มีอะไรฟ้องเลยจนกว่าจะมีคนเอาสองอันมาเทียบกัน
import { db, todayInBangkok } from '../db.js';
import { LABELS } from '../render.js';
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
    where.push('(d.title LIKE :like OR d.doc_number_display LIKE :like OR d.subject LIKE :like OR d.correspondent_name LIKE :like)');
    params.like = `%${q}%`;
  }

  const f = {
    dept: query.dept || '',
    priority: pick(query.priority, Object.keys(LABELS.PRIORITY_LABEL)),
    secret: pick(query.secret, Object.keys(LABELS.SECRET_LABEL)),
    from: /^\d{4}-\d{2}-\d{2}$/.test(query.from || '') ? query.from : '',
    to: /^\d{4}-\d{2}-\d{2}$/.test(query.to || '') ? query.to : '',
    overdue: query.overdue === '1',
  };
  if (f.dept) { where.push('d.department_id = :dept'); params.dept = f.dept; }
  if (f.priority) { where.push('d.priority = :priority'); params.priority = f.priority; }
  if (f.secret) { where.push('d.secret_level = :secret'); params.secret = f.secret; }
  // created_at เก็บเป็น ISO เต็ม (มีเวลาต่อท้าย) การเทียบกับวันที่ล้วนต้องตัดเอาเฉพาะ 10 ตัวแรก
  // ไม่งั้น "ถึงวันที่ 31 ส.ค." จะไม่รวมเอกสารที่ลงทะเบียนตอนบ่ายของวันที่ 31 เอง
  if (f.from) { where.push('substr(d.created_at, 1, 10) >= :from'); params.from = f.from; }
  if (f.to) { where.push('substr(d.created_at, 1, 10) <= :to'); params.to = f.to; }
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
  d.*, dt.name as type_name, dep.name as dept_name
  FROM documents d
  JOIN document_types dt ON dt.id = d.doc_type_id
  JOIN departments dep ON dep.id = d.department_id`;

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
  if (f.secret) parts.push(`ชั้นความลับ ${LABELS.SECRET_LABEL[f.secret]}`);
  if (f.from) parts.push(`ตั้งแต่ ${f.from}`);
  if (f.to) parts.push(`ถึง ${f.to}`);
  if (f.overdue) parts.push('เฉพาะที่เลยกำหนดและยังไม่ปิด');
  return parts.join(' · ');
}
