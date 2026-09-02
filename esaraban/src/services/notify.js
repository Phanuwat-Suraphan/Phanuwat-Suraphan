import { db, uuid, nowIso } from '../db.js';

// linkUrl = ปลายทางของปุ่ม "เปิด" สำหรับเรื่องที่ไม่ได้ผูกกับเอกสาร (ใบลา/การมอบหมายรักษาการแทน)
// ถ้าส่ง documentId มาก็ไม่ต้องส่ง linkUrl — หน้าแจ้งเตือนจะทำลิงก์ไปหน้าเอกสารให้เอง
export function notifyUser({ userId, documentId, linkUrl, title, message, priority = 'info' }) {
  db.prepare(
    `INSERT INTO notifications (id, user_id, document_id, link_url, title, message, priority, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(uuid(), userId, documentId || null, linkUrl || null, title, message, priority, nowIso());
}
