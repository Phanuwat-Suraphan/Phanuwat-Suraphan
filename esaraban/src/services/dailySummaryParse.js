// แปลงไฟล์ Excel สรุปงานรายวันเป็นรายการที่เก็บลงฐานข้อมูลได้ — แยกออกมาจาก route เพื่อให้ทดสอบตรงๆ ได้
// (ตรรกะการตัดแถวหัวตารางเคยมีบั๊กที่ทำให้แถวงานจริงหายไปเงียบๆ จึงต้องมีเทสต์คุมไว้)
import { readWorkbook } from './xlsx.js';
import { httpError } from './workflow.js';

export const MAX_ITEM_ROWS = 500;

// คอลัมน์ที่ระบบคาดหวังจากไฟล์สรุปงาน (อ้างอิงไฟล์จริงที่โรงเรียนใช้อยู่):
// ลำดับความสำคัญ | ชื่องาน/กิจกรรม | สิ่งที่ต้องปฏิบัติ | กำหนดการ | รายละเอียด/วิธีการ | แหล่งที่มา
export const COLUMNS = [
  { key: 'priority', label: 'ลำดับความสำคัญ', width: '9rem' },
  { key: 'task_name', label: 'ชื่องาน/กิจกรรม', width: '16rem' },
  { key: 'action_needed', label: 'สิ่งที่ต้องปฏิบัติ', width: '16rem' },
  { key: 'schedule', label: 'กำหนดการ', width: '11rem' },
  { key: 'detail', label: 'รายละเอียด/วิธีการ', width: '22rem' },
  { key: 'source_ref', label: 'แหล่งที่มา', width: '8rem' },
];

// ตัดแถวหัวตารางออก — ตรวจเฉพาะ "แถวแรกที่มีข้อมูล" เท่านั้น ห้ามตรวจทุกแถว เพราะชื่องานจริงมีคำว่า
// "กำหนดการ"/"ชื่องาน" ได้ตามปกติ (เช่น "แจ้งกำหนดการประชุมผู้บริหาร") ถ้ากรองทุกแถวงานจริงจะหายไปเงียบๆ
// ต้องเข้าเงื่อนไขอย่างน้อย 2 คำจึงนับเป็นหัวตาราง กันแถวงานที่บังเอิญมีคำเดียวโดนตัดทิ้ง
export function looksLikeHeader(row) {
  const joined = row.join(' ');
  const hits = ['ลำดับความสำคัญ', 'ชื่องาน', 'สิ่งที่ต้องปฏิบัติ', 'กำหนดการ', 'รายละเอียด', 'แหล่งที่มา']
    .filter((w) => joined.includes(w)).length;
  return hits >= 2;
}

// ตัดแถวหัวออกแบบใช้ครั้งเดียว: แถวแรกที่มีข้อมูลถ้าหน้าตาเหมือนหัวตารางให้ข้าม ที่เหลือถือเป็นข้อมูลทั้งหมด
export function dataRows(rows, isHeaderish) {
  const out = [];
  let checkedFirst = false;
  for (const row of rows) {
    if (!row.some((c) => c)) continue;
    if (!checkedFirst) {
      checkedFirst = true;
      if (isHeaderish(row)) continue;
    }
    out.push(row);
  }
  return out;
}

export function parseUploadedWorkbook(buffer) {
  const sheets = readWorkbook(buffer);
  const main = sheets[0];
  const items = dataRows(main.rows, looksLikeHeader).map((row) => ({
    priority: row[0] || '',
    task_name: row[1] || '',
    action_needed: row[2] || '',
    schedule: row[3] || '',
    detail: row[4] || '',
    source_ref: row[5] || '',
  }));
  if (!items.length) throw httpError(400, 'ไม่พบรายการงานในไฟล์นี้ — ตรวจสอบว่าชีตแรกมีตารางสรุปงานอยู่จริง');
  // ต้องใช้เพดานเดียวกับตอนบันทึกแก้ไข ไม่งั้นไฟล์ที่แถวเยอะกว่าเพดานจะอัปโหลดเข้ามาได้แต่กดบันทึกไม่ผ่าน
  // กลายเป็นวันที่แก้ไขอะไรไม่ได้เลย ต้องลบทิ้งอย่างเดียว
  if (items.length > MAX_ITEM_ROWS) {
    throw httpError(400, `ไฟล์นี้มี ${items.length} แถว เกินที่ระบบรองรับ (สูงสุด ${MAX_ITEM_ROWS} แถวต่อวัน)`);
  }

  // ชีตที่ 2 (ถ้ามี) = ตารางอ้างอิงชื่อไฟล์เอกสาร
  const sources = [];
  if (sheets[1]) {
    const isSourceHeader = (row) => /ดัชนี/.test(row[0] || '') && /ข้อมูลอ้างอิง|ชื่อไฟล์/.test(row[1] || '');
    for (const row of dataRows(sheets[1].rows, isSourceHeader)) {
      sources.push({ ref_index: row[0] || '', ref_text: row[1] || '' });
    }
  }
  return { items, sources };
}
