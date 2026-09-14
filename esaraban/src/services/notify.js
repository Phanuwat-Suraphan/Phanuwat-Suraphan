import { db, uuid, nowIso } from '../db.js';
import { queueLineNotification } from './lineNotify.js';

// linkUrl = ปลายทางของปุ่ม "เปิด" สำหรับเรื่องที่ไม่ได้ผูกกับเอกสาร (ใบลา/การมอบหมายรักษาการแทน)
// ถ้าส่ง documentId มาก็ไม่ต้องส่ง linkUrl — หน้าแจ้งเตือนจะทำลิงก์ไปหน้าเอกสารให้เอง
export function notifyUser({ userId, documentId, linkUrl, title, message, priority = 'info' }) {
  db.prepare(
    `INSERT INTO notifications (id, user_id, document_id, link_url, title, message, priority, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(uuid(), userId, documentId || null, linkUrl || null, title, message, priority, nowIso());

  // ส่งต่อเข้าไลน์ให้คนที่เชื่อมบัญชีไว้ — ต่อจุดนี้จุดเดียว ไม่ไปแปะทีละที่ที่เรียกแจ้งเตือน เพราะ
  // จุดที่แจ้งเตือนมีสิบกว่าแห่งและจะเพิ่มขึ้นอีก ถ้าแปะทีละที่ จุดที่เพิ่มใหม่จะลืมส่งเข้าไลน์เงียบๆ
  //
  // เป็นการ "เขียนลงคิว" ไม่ใช่ส่งออกทันที จึงอยู่ในธุรกรรมเดียวกับการแจ้งเตือนด้านบน — ถ้าตัวเรียก
  // ROLLBACK ข้อความก็หายไปด้วย ไม่เกิดกรณีที่ครูได้ไลน์แจ้งเรื่องที่สุดท้ายแล้วบันทึกไม่สำเร็จ
  queueLineNotification({ userId, documentId, linkUrl, title, message });
}
