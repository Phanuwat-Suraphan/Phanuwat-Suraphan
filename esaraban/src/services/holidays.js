// ปฏิทินวันหยุดราชการของโรงเรียน — ใช้คำนวณ "วันทำการ" ของการลาพักผ่อน
//
// ทำไมต้องมี: ระเบียบสำนักนายกฯ ว่าด้วยการลา พ.ศ. 2555 ข้อ 6 ให้ลาพักผ่อนนับเฉพาะวันทำการ
// ซึ่งแปลว่าต้องหักทั้งเสาร์-อาทิตย์ "และวันหยุดราชการ" ออก เดิมระบบหักให้แค่เสาร์-อาทิตย์
// ครูที่ลาพักผ่อนคร่อมสงกรานต์หรือวันหยุดยาวจึงถูกหักสิทธิ์เกินจริงหลายวัน ทั้งที่สิทธิ์มีปีละ
// 10 วันทำการ — ของเดิมได้แต่ขึ้นคำเตือนให้ไปบอกผู้อนุญาตปรับเอง ซึ่งเป็นการโยนงานให้คน ไม่ใช่การแก้
import { db, nowIso, audit } from '../db.js';
import { httpError, normalizeDate, assertMaxLength } from './validate.js';

const MAX_HOLIDAY_NAME = 120;

/**
 * วันหยุดราชการไทยที่ "ตรึงวันที่ตายตัวทุกปี" — ใส่ให้อัตโนมัติตอนติดตั้ง
 *
 * จงใจไม่มีวันหยุดตามจันทรคติ (มาฆบูชา วิสาขบูชา อาสาฬหบูชา เข้าพรรษา) เพราะวันเปลี่ยนทุกปีตาม
 * ปฏิทินจันทรคติ คำนวณล่วงหน้าเองไม่ได้ถ้าไม่ฝังตารางปฏิทินจันทรคติทั้งชุดลงไป และถึงคำนวณได้
 * วันหยุดราชการจริงก็ยึดตามประกาศสำนักนายกฯ ของปีนั้น ไม่ใช่การคำนวณ
 *
 * และจงใจไม่ใส่ "วันหยุดชดเชย" อัตโนมัติเมื่อวันหยุดตรงกับเสาร์-อาทิตย์ ถึงจะมีกติกาทั่วไปอยู่
 * เพราะของจริงคณะรัฐมนตรีเป็นผู้ประกาศ และบางปีก็ไม่ตรงกับกติกา — เดาแทนแล้วผิดจะกลายเป็นตัวเลข
 * วันลาที่ผิดโดยไม่มีใครรู้ ซึ่งแย่กว่าการให้ผู้ดูแลกดเพิ่มเองปีละครั้ง
 */
export const FIXED_HOLIDAYS = [
  { md: '01-01', name: 'วันขึ้นปีใหม่' },
  { md: '04-06', name: 'วันจักรี' },
  { md: '04-13', name: 'วันสงกรานต์' },
  { md: '04-14', name: 'วันสงกรานต์' },
  { md: '04-15', name: 'วันสงกรานต์' },
  { md: '05-01', name: 'วันแรงงานแห่งชาติ' },
  { md: '05-04', name: 'วันฉัตรมงคล' },
  { md: '06-03', name: 'วันเฉลิมพระชนมพรรษา สมเด็จพระนางเจ้าฯ พระบรมราชินี' },
  { md: '07-28', name: 'วันเฉลิมพระชนมพรรษา พระบาทสมเด็จพระเจ้าอยู่หัว' },
  { md: '08-12', name: 'วันเฉลิมพระชนมพรรษา สมเด็จพระบรมราชชนนีพันปีหลวง (วันแม่แห่งชาติ)' },
  { md: '10-13', name: 'วันนวมินทรมหาราช' },
  { md: '10-23', name: 'วันปิยมหาราช' },
  { md: '12-05', name: 'วันคล้ายวันพระบรมราชสมภพ ร.9 (วันพ่อแห่งชาติ)' },
  { md: '12-10', name: 'วันรัฐธรรมนูญ' },
  { md: '12-31', name: 'วันสิ้นปี' },
];

const seedKey = (year) => `holidays_seeded_${year}`;

/**
 * ใส่วันหยุดที่ตรึงวันที่ให้ปีนั้น — ทำครั้งเดียวต่อปี
 *
 * ต้องกันไม่ให้ทำซ้ำ ไม่ใช่เพราะเปลือง แต่เพราะผู้ดูแลอาจ "ลบ" วันหยุดบางวันออกโดยตั้งใจ (เช่น
 * โรงเรียนเปิดสอนชดเชย) ถ้าใส่ใหม่ทุกครั้งที่เซิร์ฟเวอร์รีสตาร์ท วันที่ลบไปแล้วจะกลับมาเองเงียบๆ
 * แล้วตัวเลขวันลาจะเปลี่ยนโดยไม่มีใครสั่ง
 */
export function seedFixedHolidays(year) {
  const key = seedKey(year);
  if (db.prepare('SELECT 1 x FROM app_settings WHERE key = ?').get(key)) return 0;
  const ins = db.prepare(`
    INSERT INTO holidays (holiday_date, name, seeded, created_by, created_at) VALUES (?, ?, 1, NULL, ?)
    ON CONFLICT(holiday_date) DO NOTHING
  `);
  const now = nowIso();
  let added = 0;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const h of FIXED_HOLIDAYS) added += ins.run(`${year}-${h.md}`, h.name, now).changes;
    db.prepare('INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, NULL, ?)')
      .run(key, String(added), now);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return added;
}

/** วันหยุดทั้งหมดในช่วงที่กำหนด คืนเป็น Set ของ 'YYYY-MM-DD' — ใช้ตอนคำนวณวันทำการ */
export function holidaySetBetween(startDate, endDate) {
  const rows = db.prepare('SELECT holiday_date FROM holidays WHERE holiday_date BETWEEN ? AND ?')
    .all(startDate, endDate);
  return new Set(rows.map((r) => r.holiday_date));
}

/** วันหยุดในช่วงที่กำหนด พร้อมชื่อ — ใช้บอกผู้ใช้ว่าหักวันไหนออกให้บ้าง */
export function holidaysBetween(startDate, endDate) {
  return db.prepare('SELECT holiday_date, name FROM holidays WHERE holiday_date BETWEEN ? AND ? ORDER BY holiday_date')
    .all(startDate, endDate);
}

export function listHolidays(year) {
  return db.prepare('SELECT * FROM holidays WHERE holiday_date LIKE ? ORDER BY holiday_date')
    .all(`${year}-%`);
}

/** ปีที่มีวันหยุดบันทึกไว้ — ใช้ทำตัวเลือกปีในหน้าจัดการ */
export function holidayYears() {
  return db.prepare("SELECT DISTINCT substr(holiday_date, 1, 4) y FROM holidays ORDER BY y DESC")
    .all().map((r) => Number(r.y));
}

export function addHoliday({ date, name, actorUser }) {
  const d = normalizeDate(date, 'วันที่');
  if (!d) throw httpError(400, 'กรุณาระบุวันที่');
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) throw httpError(400, 'กรุณาระบุชื่อวันหยุด');
  assertMaxLength(clean, MAX_HOLIDAY_NAME, 'ชื่อวันหยุด');
  if (db.prepare('SELECT 1 x FROM holidays WHERE holiday_date = ?').get(d)) {
    throw httpError(409, 'วันที่นี้ถูกบันทึกเป็นวันหยุดไว้แล้ว');
  }
  db.prepare('INSERT INTO holidays (holiday_date, name, seeded, created_by, created_at) VALUES (?, ?, 0, ?, ?)')
    .run(d, clean, actorUser.id, nowIso());
  audit({ userId: actorUser.id, action: 'holiday_added', tableName: 'holidays', recordId: d, detail: { name: clean } });
  return { date: d, name: clean };
}

export function removeHoliday({ date, actorUser }) {
  const row = db.prepare('SELECT * FROM holidays WHERE holiday_date = ?').get(date);
  if (!row) throw httpError(404, 'ไม่พบวันหยุดนี้');
  db.prepare('DELETE FROM holidays WHERE holiday_date = ?').run(date);
  audit({ userId: actorUser.id, action: 'holiday_removed', tableName: 'holidays', recordId: date, detail: { name: row.name } });
  return { ok: true };
}
