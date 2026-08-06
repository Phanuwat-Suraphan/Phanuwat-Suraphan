import { db, uuid, nowIso } from '../db.js';

export function notifyUser({ userId, documentId, title, message, priority = 'info' }) {
  db.prepare(
    `INSERT INTO notifications (id, user_id, document_id, title, message, priority, is_read, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(uuid(), userId, documentId || null, title, message, priority, nowIso());
}
