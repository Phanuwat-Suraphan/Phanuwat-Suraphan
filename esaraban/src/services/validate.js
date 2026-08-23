// ตัวตรวจค่าที่กรอกเข้ามา ใช้ร่วมกันทั้งระบบ — หนังสือ, ใบลา, การมอบหมายรักษาการแทน
//
// เดิมมีแต่ฝั่งหนังสือที่ตรวจวันที่จริงจัง ส่วนใบลากับการมอบหมายรับค่าอะไรก็ได้แล้วเก็บลงฐานข้อมูลตรงๆ
// ผลที่ทดสอบยืนยันแล้วว่าเกิดขึ้นจริง:
//
//   - การมอบหมายที่ end_date = "ไม่ใช่วันที่" กลายเป็น "กำลังมีผล" ตลอดไป เพราะการเทียบวันที่ทำด้วย
//     การเทียบสตริง และอักษรไทยมีค่ามากกว่าตัวเลขทุกตัว — ตรวจแล้วว่าอีก 100 ปีข้างหน้าก็ยังมีผลอยู่
//     แปลว่าผู้รักษาการแทนถืออำนาจลงนามแทนผู้อำนวยการไปตลอดกาล โดยหน้าจอไม่มีอะไรบอกว่าทำไม
//   - ใบลาที่พิมพ์ปีผิดหนึ่งหลัก (2126 แทน 2026) ถูกบันทึกเป็นการลา 36,526 วัน
//   - วันที่แบบ พ.ศ. (2569-10-01) ถูกเก็บดิบๆ ใบลานั้นจึงไปโผล่อีก 543 ปีข้างหน้า = หายไปเงียบๆ
//   - วันที่ที่ไม่มีอยู่จริง (2026-02-30) ถูกเก็บไว้ทั้งอย่างนั้น
//
// จึงย้ายตัวตรวจมาไว้ที่เดียว แล้วให้ทุกโมดูลเรียกใช้ตัวเดียวกัน ไม่ใช่ต่างคนต่างตรวจ

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/**
 * ตรวจว่าเป็นวันที่จริงในรูปแบบ YYYY-MM-DD — คืน null ถ้าเว้นว่าง, throw ถ้ากรอกมาแต่ไม่ใช่วันที่
 */
export function normalizeDate(value, label) {
  if (!value) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw httpError(400, `${label}ไม่ใช่วันที่ที่ถูกต้อง (ต้องเป็นรูปแบบ ปี-เดือน-วัน)`);
  const d = new Date(`${s}T00:00:00Z`);
  // เช็คซ้ำว่าเป็นวันที่มีอยู่จริง — "2026-13-45" ผ่าน regex แต่ Date จะเลื่อนไปเป็นวันอื่นเงียบๆ
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw httpError(400, `${label}ไม่ใช่วันที่ที่มีอยู่จริง (${s})`);
  }
  // ช่องกรอกวันที่ของเบราว์เซอร์เป็น ค.ศ. เสมอ แต่ครูไทยคิดเป็น พ.ศ. การกรอก 2569 แทน 2026 จึงเกิดง่ายมาก
  const year = Number(s.slice(0, 4));
  if (year > 2400) {
    throw httpError(400, `${label}ดูเหมือนกรอกเป็นปี พ.ศ. (${year}) — ช่องนี้ใช้ปี ค.ศ. ถ้าเป็น พ.ศ. ${year} ให้กรอกเป็น ${year - 543}`);
  }
  if (year < 1900) throw httpError(400, `${label}มีปีที่ไม่สมเหตุสมผล (${year})`);
  return s;
}

/** วันที่ที่ต้องกรอก (เว้นว่างไม่ได้) */
export function requireDate(value, label) {
  const d = normalizeDate(value, label);
  if (!d) throw httpError(400, `กรุณาระบุ${label}`);
  return d;
}

export function assertMaxLength(value, max, label) {
  if (typeof value === 'string' && value.length > max) {
    throw httpError(400, `${label}ยาวเกินไป (${value.length} ตัวอักษร) — จำกัดไม่เกิน ${max} ตัวอักษร`);
  }
}

/** จำนวนวันแบบนับรวมวันแรกและวันสุดท้าย — ทั้งสองค่าต้องผ่าน normalizeDate มาแล้ว */
export function daysInclusive(startDate, endDate) {
  const ms = new Date(`${endDate}T00:00:00Z`) - new Date(`${startDate}T00:00:00Z`);
  return Math.floor(ms / 86400000) + 1;
}

/**
 * ตรวจช่วงวันที่ให้ครบทั้งชุด: เป็นวันที่จริงทั้งคู่ ไม่กลับหัวกลับหาง และไม่ยาวเกินเพดาน
 *
 * เพดานความยาวสำคัญกว่าที่คิด — พิมพ์ปีผิดหนึ่งหลักแล้วได้ใบลา 100 ปีคือสิ่งที่เกิดขึ้นจริงตอนทดสอบ
 * และไม่มีใครสังเกตเห็นจนกว่าจะไปเปิดดูรายงานวันลาสะสม
 */
export function assertDateRange({ startDate, endDate, startLabel, endLabel, maxDays, rangeLabel }) {
  const start = requireDate(startDate, startLabel);
  const end = requireDate(endDate, endLabel);
  if (end < start) throw httpError(400, `${endLabel}ต้องไม่ก่อน${startLabel}`);
  const days = daysInclusive(start, end);
  if (maxDays && days > maxDays) {
    throw httpError(400, `${rangeLabel}ยาวผิดปกติ (${days} วัน) — จำกัดไม่เกิน ${maxDays} วัน กรุณาตรวจสอบปีที่กรอกอีกครั้ง`);
  }
  return { start, end, days };
}
