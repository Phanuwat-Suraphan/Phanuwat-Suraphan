import { db, uuid, nowIso } from '../db.js';
import { isLineEnabled, sendLineMessage, publicUrl } from './line.js';

// linkUrl = ปลายทางของปุ่ม "เปิด" สำหรับเรื่องที่ไม่ได้ผูกกับเอกสาร (ใบลา/การมอบหมายรักษาการแทน)
// ถ้าส่ง documentId มาก็ไม่ต้องส่ง linkUrl — หน้าแจ้งเตือนจะทำลิงก์ไปหน้าเอกสารให้เอง
//
// lineAlert = true เมื่ออยากให้ยิงเข้ากลุ่ม LINE ของโรงเรียนด้วย ใช้เฉพาะเรื่องที่ "ด่วนจริง" เท่านั้น
// เพราะ LINE Official Account มีโควตาข้อความฟรีต่อเดือนจำกัด ถ้ายิงทุกการแจ้งเตือน โควตาจะหมดตั้งแต่
// ต้นเดือน แล้วเรื่องด่วนจริงๆ ปลายเดือนกลับส่งไม่ออก (ดู services/line.js)
export function notifyUser({ userId, documentId, linkUrl, title, message, priority = 'info', lineAlert = false }) {
  db.prepare(
    `INSERT INTO notifications (id, user_id, document_id, link_url, title, message, priority, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(uuid(), userId, documentId || null, linkUrl || null, title, message, priority, nowIso());

  if (lineAlert) pushLineAlert({ userId, documentId, linkUrl, title, message });
}

/**
 * ยิงแจ้งเตือนเข้ากลุ่ม LINE — ตั้งใจไม่ await
 *
 * การบันทึกงานต้องไม่ต้องรอเครือข่ายภายนอก ถ้ารอแล้ว LINE ตอบช้า 10 วินาที ผู้ใช้จะเห็นปุ่มค้าง
 * แล้วกดซ้ำจนเกิดรายการซ้ำ — sendLineMessage ไม่ throw อยู่แล้ว (คืน {ok,error} และบันทึกสถานะไว้เอง)
 * แต่ใส่ catch ไว้อีกชั้นกัน unhandled rejection ทำโปรเซสตายในกรณีที่คาดไม่ถึง
 */
function pushLineAlert({ userId, documentId, linkUrl, title, message }) {
  if (!isLineEnabled()) return;
  const who = db.prepare('SELECT prefix, first_name, last_name FROM users WHERE id = ?').get(userId);
  const url = publicUrl(documentId ? `/documents/${documentId}` : (linkUrl || '/'));
  const lines = [
    `🔔 ${title}`,
    message,
    who ? `ถึง: ${who.prefix || ''}${who.first_name} ${who.last_name}` : null,
    url,
  ].filter(Boolean);
  sendLineMessage(lines.join('\n')).catch(() => {});
}
