// แจ้งเตือนเด้งเข้า LINE อัตโนมัติ
//
// ทำไมต้องมี: การแจ้งเตือนในระบบเป็นกระดิ่งบนหน้าเว็บ ซึ่งเห็นก็ต่อเมื่อเปิดเว็บอยู่ แต่ครูไม่ได้เปิด
// เว็บสารบรรณค้างไว้ทั้งวัน หนังสือด่วนที่เสนอเข้ามาตอนบ่ายจึงไปค้างอยู่ในกระดิ่งจนถึงวันรุ่งขึ้น
// ส่วนไลน์นั้นทุกคนเปิดอยู่แล้วตลอดเวลา
//
// วิธีทำงาน: ทุกครั้งที่ระบบสร้างการแจ้งเตือน (notifyUser) ถ้าคนนั้นเชื่อมบัญชีไลน์ไว้ ข้อความจะถูก
// เขียนลงคิว line_outbox ในธุรกรรมเดียวกัน แล้วตัวส่งที่เดินเป็นรอบๆ ค่อยยิงออกไปทีหลัง
//
// ต้องตั้งค่าอะไรบ้าง (ดูขั้นตอนเต็มที่หน้า /admin/line ในระบบ):
//   LINE_CHANNEL_ACCESS_TOKEN  โทเคนของ Messaging API channel — ใช้ส่งข้อความ
//   LINE_CHANNEL_SECRET        ใช้ตรวจว่า webhook ที่เข้ามาเป็นของ LINE จริง
//   LINE_OA_BASIC_ID           ไอดีบัญชีทางการ เช่น @123abcde — ใช้ทำลิงก์เพิ่มเพื่อน
//
// ถ้ายังไม่ได้ตั้ง ทุกอย่างในไฟล์นี้จะเงียบและไม่ทำอะไรเลย ระบบส่วนอื่นทำงานปกติทุกประการ
import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { db, uuid, nowIso, audit } from '../db.js';
import { absoluteUrl } from './publicUrl.js';
// esc มาจาก render.js ซึ่งไม่ได้ import ไฟล์นี้กลับ จึงไม่เกิดวงวน — ใช้เพราะข้อความอธิบายผลการตรวจ
// มีค่าที่ LINE ส่งกลับมาปนอยู่ (URL ที่ LINE ถืออยู่, เหตุผลที่ยิงไม่สำเร็จ) ซึ่งเป็นข้อมูลจากนอกระบบ
import { esc } from '../render.js';

const LINE_API = 'https://api.line.me/v2/bot';

// อ่าน env ทุกครั้งที่เรียก ไม่ใช่อ่านครั้งเดียวตอนโหลดไฟล์ — เทสต์ต้องสลับค่าไปมาได้ และการ deploy
// บางแบบตั้ง env หลังโปรเซสเริ่มแล้ว (ค่าพวกนี้ถูกอ่านถี่แค่ระดับวินาที ไม่ใช่ต่อแถวข้อมูล)
export function lineAccessToken() { return String(process.env.LINE_CHANNEL_ACCESS_TOKEN || '').trim(); }
export function lineChannelSecret() { return String(process.env.LINE_CHANNEL_SECRET || '').trim(); }
export function lineBasicId() { return String(process.env.LINE_OA_BASIC_ID || '').trim(); }
// LIFF = การเปิดเว็บนี้ขึ้นมาในแอป LINE เลย ไม่ต้องเด้งออกไปเบราว์เซอร์ (ดู routes/liff.js)
export function liffId() { return String(process.env.LINE_LIFF_ID || '').trim(); }
export function lineLoginChannelId() { return String(process.env.LINE_LOGIN_CHANNEL_ID || '').trim(); }

/** ส่งข้อความเข้าไลน์ได้หรือยัง — ถ้ายัง ทุกอย่างในไฟล์นี้เงียบไว้เฉยๆ */
export function isLineNotifyConfigured() { return Boolean(lineAccessToken()); }

/** รับ webhook จาก LINE ได้หรือยัง — ไม่มี secret ก็ตรวจลายเซ็นไม่ได้ จึงต้องปฏิเสธทุกอย่าง */
export function isLineWebhookConfigured() { return Boolean(lineChannelSecret()); }

// ───────────────────────────────── ตัวส่งของจริง ─────────────────────────────────

// แยกตัวส่งออกมาเป็นตัวแปร เพื่อให้เทสต์สลับเป็นตัวปลอมได้ — ไม่งั้นการทดสอบคิว/การส่งซ้ำ/การเลิกส่ง
// จะต้องยิงออกอินเทอร์เน็ตจริง ซึ่งทำไม่ได้และไม่ควรทำ
async function httpPostToLine(pathname, payload) {
  // ตั้งเวลาหมดอายุไว้เอง — fetch ที่ไม่มี timeout ค้างได้ไม่จำกัดเวลา ซึ่งจะทำให้ตัวส่งรอบนั้นค้างตาม
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(`${LINE_API}${pathname}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineAccessToken()}` },
      body: JSON.stringify(payload),
      signal: ac.signal,
    });
    if (res.ok) return { ok: true, status: res.status };
    const body = await res.text().catch(() => '');
    return { ok: false, status: res.status, error: `LINE ตอบ ${res.status}: ${body.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, status: 0, error: `ติดต่อ LINE ไม่ได้: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

let sender = httpPostToLine;
/** สำหรับเทสต์เท่านั้น — สลับตัวส่งจริงออก แล้วคืนค่าเดิมด้วยการเรียกโดยไม่ส่งอะไรมา */
export function _setLineSenderForTest(fn) { sender = fn || httpPostToLine; }

// ตัวเรียก API ที่ "อ่านคำตอบกลับมาด้วย" — ต่างจาก sender ข้างบนที่สนใจแค่ส่งผ่านหรือไม่ผ่าน
// เพราะหน้าตรวจสอบการตั้งค่าต้องใช้เนื้อคำตอบจริง (LINE ถือ URL อะไรอยู่, สวิตช์เปิดไหม, บัญชีอยู่โหมดไหน)
async function httpCallLine(method, pathname, payload) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch(`${LINE_API}${pathname}`, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${lineAccessToken()}` },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: ac.signal,
    });
    const text = await res.text().catch(() => '');
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    return { ok: res.ok, status: res.status, data, error: res.ok ? null : `LINE ตอบ ${res.status}: ${text.slice(0, 200)}` };
  } catch (err) {
    return { ok: false, status: 0, data: null, error: `ติดต่อ LINE ไม่ได้: ${err?.message || err}` };
  } finally {
    clearTimeout(timer);
  }
}

let apiCaller = httpCallLine;
/** สำหรับเทสต์เท่านั้น */
export function _setLineApiCallerForTest(fn) { apiCaller = fn || httpCallLine; }

// ───────────────────────────────── เชื่อมบัญชี ─────────────────────────────────

// ไม่ใช้ 0/O/1/I/L เพราะอ่านจากหน้าจอแล้วพิมพ์ตามได้ผิด — ผู้ใช้ส่วนใหญ่กดลิงก์ที่เตรียมข้อความไว้ให้
// อยู่แล้ว รหัสที่เห็นเป็นทางสำรองเวลาลิงก์เปิดไม่ได้
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 8;
const CODE_TTL_MINUTES = 30;
// คำนำหน้าในข้อความ ทำให้ตัวรับ webhook แยกออกว่าอันไหนคือการเชื่อมบัญชี อันไหนคือครูพิมพ์ทักมาเฉยๆ
export const LINK_KEYWORD = 'เชื่อมบัญชี';

function generateCode() {
  let out = '';
  // randomInt ของ node:crypto ไม่ใช่ Math.random — รหัสนี้คือสิ่งเดียวที่กั้นไม่ให้คนอื่นผูกบัญชีไลน์
  // ของตัวเองเข้ากับบัญชีครูในระบบ แล้วรับการแจ้งเตือนของครูคนนั้นไปทั้งหมด
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return out;
}

/** ขอรหัสเชื่อมบัญชีใหม่ — รหัสเก่าของคนเดียวกันถูกทับทิ้งทันที (มีได้ครั้งละหนึ่งรหัสเท่านั้น) */
export function createLinkCode(userId) {
  const code = generateCode();
  const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60000).toISOString();
  db.prepare('UPDATE users SET line_link_code = ?, line_link_code_expires_at = ?, updated_at = ? WHERE id = ?')
    .run(code, expiresAt, nowIso(), userId);
  const message = `${LINK_KEYWORD} ${code}`;
  const basic = lineBasicId();
  return {
    code,
    expiresAt,
    message,
    // ลิงก์เพิ่มเพื่อน และลิงก์ที่เปิดแชทพร้อมพิมพ์ข้อความไว้ให้แล้ว เหลือแค่กดส่ง
    addFriendUrl: basic ? `https://line.me/R/ti/p/${encodeURIComponent(basic)}` : '',
    sendUrl: basic ? `https://line.me/R/oaMessage/${encodeURIComponent(basic)}/?${encodeURIComponent(message)}` : '',
  };
}

/**
 * ผูกบัญชีไลน์เข้ากับผู้ใช้ตามรหัสที่ส่งเข้ามาในแชท
 *
 * คืน { ok, reason } เสมอ ไม่โยน error เพราะตัวเรียกคือ webhook ซึ่งต้องตอบ 200 ให้ LINE ทุกกรณี
 */
export function redeemLinkCode({ code, lineUserId }) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean || !lineUserId) return { ok: false, reason: 'invalid' };
  const user = db.prepare(`
    SELECT id, prefix, first_name, last_name, line_link_code_expires_at
    FROM users WHERE line_link_code = ? AND deleted_at IS NULL AND status = 'active'
  `).get(clean);
  if (!user) return { ok: false, reason: 'invalid' };
  if (!user.line_link_code_expires_at || user.line_link_code_expires_at < nowIso()) {
    return { ok: false, reason: 'expired' };
  }
  // บัญชีไลน์เดียวผูกได้กับคนเดียว — ถ้าเคยผูกไว้กับคนอื่น ต้องปลดของเดิมก่อน ไม่งั้นดัชนี unique
  // จะทำให้ INSERT ล้ม แล้วคนย้ายเครื่อง/เปลี่ยนบัญชีจะเชื่อมใหม่ไม่ได้เลยโดยไม่มีใครรู้สาเหตุ
  db.prepare('UPDATE users SET line_user_id = NULL, line_linked_at = NULL WHERE line_user_id = ? AND id != ?')
    .run(lineUserId, user.id);
  db.prepare(`
    UPDATE users SET line_user_id = ?, line_linked_at = ?, line_link_code = NULL,
      line_link_code_expires_at = NULL, updated_at = ? WHERE id = ?
  `).run(lineUserId, nowIso(), nowIso(), user.id);
  audit({ userId: user.id, action: 'line_linked', tableName: 'users', recordId: user.id, detail: {} });
  return { ok: true, user };
}

/** เลิกรับแจ้งเตือนทางไลน์ — ล้างคิวที่ยังไม่ได้ส่งของคนนั้นด้วย ไม่งั้นข้อความเก่ายังตามไปอีก */
export function unlinkLineAccount(userId, { actorUserId } = {}) {
  db.prepare('DELETE FROM line_outbox WHERE user_id = ? AND sent_at IS NULL').run(userId);
  const changes = db.prepare(`
    UPDATE users SET line_user_id = NULL, line_linked_at = NULL, line_link_code = NULL,
      line_link_code_expires_at = NULL, updated_at = ? WHERE id = ?
  `).run(nowIso(), userId).changes;
  if (changes) audit({ userId: actorUserId || userId, action: 'line_unlinked', tableName: 'users', recordId: userId, detail: {} });
  return changes > 0;
}

/** สถานะการเชื่อมบัญชีของคนคนหนึ่ง สำหรับแสดงในหน้าโปรไฟล์ */
export function lineLinkStatus(userId) {
  const u = db.prepare('SELECT line_user_id, line_linked_at, line_notify_enabled FROM users WHERE id = ?').get(userId);
  return {
    configured: isLineNotifyConfigured(),
    linked: Boolean(u?.line_user_id),
    linkedAt: u?.line_linked_at || null,
    enabled: u ? u.line_notify_enabled !== 0 : true,
  };
}

export function setLineNotifyEnabled(userId, enabled) {
  db.prepare('UPDATE users SET line_notify_enabled = ?, updated_at = ? WHERE id = ?')
    .run(enabled ? 1 : 0, nowIso(), userId);
}

// ───────────────────────────────── คิวข้อความ ─────────────────────────────────

// หนังสือชั้นความลับห้ามเอาชื่อเรื่องออกนอกระบบ (เหตุผลเดียวกับปุ่มแชร์เข้ากลุ่มไลน์ ดู services/line.js)
// แต่เจ้าตัวยังต้องรู้ว่ามีเรื่องรออยู่ จึงส่งข้อความกลางๆ พร้อมลิงก์ให้เข้ามาอ่านในระบบแทน
const SECRET_LEVELS_NO_DETAIL = ['secret', 'top_secret'];

// เพดานความยาวข้อความหนึ่งฉบับของ LINE คือ 5000 ตัวอักษร แต่ข้อความยาวๆ ในไลน์ถูกพับเก็บอยู่ดี
const MAX_LINE_TEXT = 900;

/** ประกอบข้อความที่จะไปโผล่ในไลน์ — แยกเป็นฟังก์ชันเพื่อให้เทสต์ตรวจเนื้อความได้โดยไม่ต้องส่งจริง */
export function composeLineMessage({ title, message, documentId, linkUrl, secretLevel }) {
  const link = documentId ? `/documents/${documentId}` : (linkUrl || '/notifications');
  const url = absoluteUrl(link);
  if (SECRET_LEVELS_NO_DETAIL.includes(secretLevel)) {
    return [
      '🔒 มีหนังสือชั้นความลับรอคุณดำเนินการ',
      'ไม่แสดงเลขที่และชื่อเรื่องทางไลน์ตามระเบียบว่าด้วยการรักษาความลับของทางราชการ',
      'เปิดอ่านในระบบสารบรรณ:',
      url,
    ].join('\n');
  }
  const lines = [`🔔 ${String(title || 'มีการแจ้งเตือนใหม่')}`];
  const body = String(message || '').trim();
  if (body) lines.push(body);
  lines.push(url);
  const text = lines.join('\n');
  return text.length > MAX_LINE_TEXT ? `${text.slice(0, MAX_LINE_TEXT - 1)}…` : text;
}

/**
 * เขียนข้อความลงคิว — เรียกจาก notifyUser() จุดเดียว
 *
 * ต้องไม่โยน error ออกไปไม่ว่าจะเกิดอะไรขึ้น เพราะตัวเรียกคือการลงทะเบียนหนังสือ/การลงนาม ซึ่งสำคัญ
 * กว่าการแจ้งเตือนมาก ถ้าเรื่องไลน์พังแล้วลากให้ลงทะเบียนหนังสือไม่ได้ด้วย ถือว่าเสียหายกว่าเดิม
 */
export function queueLineNotification({ userId, documentId, linkUrl, title, message }) {
  try {
    if (!isLineNotifyConfigured()) return false;
    const u = db.prepare('SELECT line_user_id, line_notify_enabled FROM users WHERE id = ? AND deleted_at IS NULL').get(userId);
    if (!u?.line_user_id || u.line_notify_enabled === 0) return false;
    let secretLevel = null;
    if (documentId) {
      secretLevel = db.prepare('SELECT secret_level FROM documents WHERE id = ?').get(documentId)?.secret_level || null;
    }
    db.prepare('INSERT INTO line_outbox (id, user_id, line_user_id, body, created_at, attempts) VALUES (?, ?, ?, ?, ?, 0)')
      .run(uuid(), userId, u.line_user_id, composeLineMessage({ title, message, documentId, linkUrl, secretLevel }), nowIso());
    return true;
  } catch (err) {
    console.error('[line] เขียนคิวแจ้งเตือนไม่สำเร็จ (ระบบส่วนอื่นทำงานต่อตามปกติ):', err?.message || err);
    return false;
  }
}

// ─────────────────────── ทดสอบว่าส่งออกไปได้จริงไหม (ยิงทันที ไม่เข้าคิว) ───────────────────────
//
// การเชื่อมบัญชีสำเร็จพิสูจน์ได้แค่ "ขาเข้า" คือ LINE ยิง webhook มาถึงเราได้ แต่ "ขาออก" คือเราส่ง
// ข้อความกลับไปหาครูได้จริงไหม เป็นคนละเรื่องและใช้คนละค่า (Channel access token คนละตัวกับ secret)
// เดิมจึงไม่มีทางรู้ว่าขาออกใช้ได้จนกว่าจะมีหนังสือจริงเข้ามาแล้วครูไม่ได้รับ — ซึ่งสายไปแล้ว
//
// ยิงทันทีไม่ผ่านคิวโดยตั้งใจ เพราะจุดประสงค์คือเอา "คำตอบจาก LINE" กลับมาให้เห็นเดี๋ยวนั้น
// ถ้าเข้าคิวจะได้แค่ "เข้าคิวแล้ว" ซึ่งไม่ได้ตอบอะไรเลย
export async function sendLineTestMessage(userId) {
  if (!isLineNotifyConfigured()) {
    return { ok: false, error: 'ยังไม่ได้ตั้งตัวแปร LINE_CHANNEL_ACCESS_TOKEN บนเซิร์ฟเวอร์' };
  }
  const u = db.prepare('SELECT line_user_id FROM users WHERE id = ? AND deleted_at IS NULL').get(userId);
  if (!u?.line_user_id) return { ok: false, error: 'บัญชีนี้ยังไม่ได้เชื่อมกับไลน์ — ขอรหัสแล้วส่งเข้าแชทก่อน' };

  const res = await sender('/message/push', {
    to: u.line_user_id,
    messages: [{ type: 'text', text: `✅ ทดสอบการแจ้งเตือนจากระบบสารบรรณ\nถ้าเห็นข้อความนี้ แปลว่าการแจ้งเตือนจะส่งถึงคุณได้แน่นอน\n${absoluteUrl('/')}` }],
  });
  if (res?.ok) return { ok: true };
  return { ok: false, error: explainLineSendError(res), raw: res?.error || null };
}

/**
 * แปลคำตอบของ LINE เป็นภาษาที่บอกได้ว่า "ต้องไปแก้ที่ไหน"
 *
 * LINE ตอบเป็นภาษาอังกฤษสั้นๆ อย่าง "Invalid reply token" หรือรหัสตัวเลขเปล่าๆ ซึ่งคนที่นั่งตั้งค่าอยู่
 * อ่านแล้วไปต่อไม่ถูก ที่สำคัญคือ 400 กับ 403 ชี้ไปคนละสาเหตุกันคนละเรื่อง แต่หน้าตาคล้ายกันมาก
 */
export function explainLineSendError(res) {
  const status = res?.status;
  const raw = String(res?.error || '');
  if (status === 401) {
    return 'LINE ปฏิเสธโทเคน (401) — ค่า LINE_CHANNEL_ACCESS_TOKEN บนเซิร์ฟเวอร์ผิดหรือถูกยกเลิกไปแล้ว ให้กด Issue ใหม่ในหน้า Messaging API แล้วเอามาตั้งใหม่';
  }
  if (status === 403) {
    return 'LINE ไม่อนุญาตให้ส่ง (403) — โทเคนที่ใช้เป็นของ channel คนละอันกับบัญชีทางการที่ครูเพิ่มเพื่อนไว้ ตรวจว่าคัดลอกมาจาก channel เดียวกัน';
  }
  if (status === 400 && /\bto\b/i.test(raw)) {
    return 'LINE บอกว่าไม่รู้จักผู้รับคนนี้ (400) — มักเกิดเมื่อ LINE Login channel กับ Messaging API channel อยู่คนละ provider ทำให้รหัสผู้ใช้ที่เก็บไว้เป็นคนละตัวกัน ให้ยกเลิกการเชื่อมแล้วเชื่อมใหม่';
  }
  if (status === 429) return 'ส่งถี่เกินโควตาของ LINE ชั่วคราว (429) — รอสักครู่แล้วลองใหม่';
  // raw คือเนื้อคำตอบดิบจาก LINE ซึ่งไปโผล่ใน innerHTML ของหน้าผู้ดูแล จึงต้อง escape ก่อนเสมอ
  if (status === 0) return `ติดต่อเซิร์ฟเวอร์ของ LINE ไม่ได้ — ${esc(raw || 'เครือข่ายมีปัญหา')}`;
  return raw ? esc(raw) : 'ส่งไม่สำเร็จโดยไม่ทราบสาเหตุ';
}

// ─────────────────── ถาม LINE ตรงๆ ว่าตอนนี้การตั้งค่าฝั่งโน้นเป็นยังไง ───────────────────
//
// ที่ผ่านมาการหาสาเหตุ "ส่งรหัสเข้าแชทแล้วเงียบ" ต้องเดาเอาทั้งหมด เพราะเรามองเห็นแค่ฝั่งเราเอง
// ว่า "ไม่มีอะไรวิ่งเข้ามา" แต่ไม่รู้ว่าฝั่ง LINE ตั้งค่าไว้ยังไง ซึ่งเป็นด้านที่พังจริงเกือบทุกครั้ง
//
// แต่ LINE มี API ให้ถามได้ด้วย Channel access token ตัวเดียวกับที่ใช้ส่งข้อความ (ซึ่งตั้งไว้แล้ว):
//   GET  /v2/bot/info                 → บัญชีนี้อยู่โหมดไหน (chatMode = 'chat' คือโหมดตอบกลับอัตโนมัติ
//                                       ซึ่ง LINE จะไม่ส่ง webhook มาเลย — เป็นสาเหตุที่เจอบ่อยที่สุด
//                                       และมองไม่เห็นจากฝั่งเราเด็ดขาด)
//   GET  /v2/bot/channel/webhook/endpoint → LINE ถือ URL อะไรอยู่ และสวิตช์เปิดหรือปิด
//   POST /v2/bot/channel/webhook/test     → สั่งให้ LINE ยิงของจริงมาที่เราเดี๋ยวนี้ แล้วบอกว่าเราตอบอะไรกลับ
//                                       (statusCode 401 = ลายเซ็นไม่ผ่าน = secret สองฝั่งไม่ตรงกัน)
//
// รวมสามอันนี้เข้าด้วยกันแล้วตอบได้เกือบทุกกรณีในคลิกเดียว แทนที่จะไล่เดาทีละอย่างเป็นชั่วโมง
export async function checkLineSetup({ expectedWebhookUrl } = {}) {
  const checks = [];
  const add = (c) => { checks.push(c); return c; };

  if (!isLineNotifyConfigured()) {
    add({ key: 'token', ok: false, label: 'Channel access token',
      detail: 'ยังไม่ได้ตั้งตัวแปร LINE_CHANNEL_ACCESS_TOKEN บนเซิร์ฟเวอร์ จึงถาม LINE ไม่ได้เลย' });
    return { checks, reachedLine: false };
  }

  // 1) บัญชีทางการนี้เป็นของโทเคนที่เราถืออยู่จริงไหม และอยู่โหมดไหน
  const info = await apiCaller('GET', '/info');
  if (!info.ok) {
    // แยก "ติดต่อ LINE ไม่ได้เลย" ออกจาก "LINE ตอบมาว่าโทเคนใช้ไม่ได้" — สองอย่างนี้ไม่เหมือนกัน
    // ถ้าเหมารวมเป็นเรื่องโทเคน ผู้ดูแลจะไปนั่งออกโทเคนใหม่ทั้งที่ปัญหาคือเครือข่าย/ตัวกลางกั้นอยู่
    // (เจอมากับตัวตอนทดสอบ: ตัวกลางของเครือข่ายตอบ 403 แทน LINE จนตัวตรวจฟ้องผิดจุด)
    const unreachable = info.status === 0;
    add({ key: unreachable ? 'reach' : 'token', ok: false,
      label: unreachable ? 'ติดต่อเซิร์ฟเวอร์ของ LINE' : 'Channel access token',
      detail: explainLineSendError(info),
      fix: unreachable ? 'ตรวจว่าเซิร์ฟเวอร์ออกอินเทอร์เน็ตได้ และไม่มีตัวกลาง/ไฟร์วอลล์กั้น api.line.me อยู่' : '' });
    return { checks, reachedLine: false };
  }
  // ชื่อบัญชีและ basicId มาจาก LINE และไปโผล่ใน innerHTML ของหน้าผู้ดูแล จึง escape ที่ต้นทางนี้
  // ทุกค่าที่มาจากนอกระบบในไฟล์นี้ escape ตั้งแต่ตรงนี้ที่เดียว ฝั่งหน้าเว็บจะได้ใส่ได้ตรงๆ
  add({ key: 'token', ok: true, label: 'Channel access token',
    detail: `ใช้ได้ — บัญชีทางการชื่อ "${esc(info.data?.displayName || '-')}"${info.data?.basicId ? ` (${esc(info.data.basicId)})` : ''}` });

  // โหมดแชท = LINE ตอบเองแล้วจบ ไม่ส่งต่อมาให้เรา ต้องไปปิดที่ manager.line.biz ไม่ใช่ที่ developers
  const chatMode = info.data?.chatMode;
  if (chatMode === 'chat') {
    add({ key: 'chatMode', ok: false, label: 'โหมดการตอบกลับ',
      detail: 'บัญชีนี้อยู่ใน<strong>โหมดแชท/ตอบกลับอัตโนมัติ</strong> — LINE จะตอบเองแล้วจบ ไม่ส่งข้อความต่อมาให้ระบบเลย นี่คือสาเหตุที่ส่งรหัสเข้าไปแล้วเงียบ',
      fix: 'เข้า <code>manager.line.biz</code> → ตั้งค่า → การตั้งค่าการตอบกลับ → ปิด "ข้อความตอบกลับอัตโนมัติ" กับ "ข้อความทักทายเพื่อนใหม่" แล้วเปิด "Webhook"' });
  } else {
    add({ key: 'chatMode', ok: true, label: 'โหมดการตอบกลับ', detail: 'อยู่ในโหมด bot แล้ว ข้อความจะถูกส่งต่อมาให้ระบบ' });
  }

  // 2) LINE ถือ URL อะไรอยู่ และสวิตช์ Use webhook เปิดหรือยัง
  const endpoint = await apiCaller('GET', '/channel/webhook/endpoint');
  if (!endpoint.ok) {
    add({ key: 'endpoint', ok: false, label: 'Webhook URL ที่ LINE ถืออยู่',
      detail: endpoint.status === 404
        ? 'ยังไม่ได้ตั้ง Webhook URL ไว้ที่ LINE เลย'
        : explainLineSendError(endpoint),
      fix: 'ที่ <code>developers.line.biz</code> → Messaging API → กรอก Webhook URL แล้วกด Update' });
  } else {
    const theirs = String(endpoint.data?.endpoint || '');
    const matches = !expectedWebhookUrl || theirs === expectedWebhookUrl;
    add({ key: 'endpoint', ok: matches, label: 'Webhook URL ที่ LINE ถืออยู่',
      detail: matches ? esc(theirs) : `LINE ถือ <code>${esc(theirs)}</code> ซึ่งไม่ตรงกับของระบบนี้ (<code>${esc(expectedWebhookUrl)}</code>)`,
      fix: matches ? '' : 'แก้ Webhook URL ที่ developers.line.biz ให้ตรงแล้วกด Update' });
    add({ key: 'active', ok: Boolean(endpoint.data?.active), label: 'สวิตช์ Use webhook',
      detail: endpoint.data?.active ? 'เปิดอยู่' : 'ปิดอยู่ — กรอก URL ไว้แล้วแต่ยังไม่ได้เปิดสวิตช์ คือ LINE จะไม่ส่งอะไรมาเลย',
      fix: endpoint.data?.active ? '' : 'ที่ developers.line.biz → Messaging API → เปิดสวิตช์ "Use webhook"' });
  }

  // 3) สั่งให้ LINE ยิงของจริงมาเดี๋ยวนี้ แล้วดูว่าเราตอบอะไรกลับไป
  const probe = await apiCaller('POST', '/channel/webhook/test', expectedWebhookUrl ? { endpoint: expectedWebhookUrl } : {});
  add(interpretWebhookProbe(probe));

  return { checks, reachedLine: true, chatMode };
}

/** แปลผลการทดสอบยิง webhook ของ LINE — รหัสตอบกลับแต่ละตัวชี้ไปคนละสาเหตุคนละวิธีแก้ */
export function interpretWebhookProbe(probe) {
  const base = { key: 'probe', label: 'ให้ LINE ลองยิงเข้ามาเดี๋ยวนี้' };
  if (!probe?.ok) {
    return { ...base, ok: false, detail: explainLineSendError(probe),
      fix: 'ถ้าเป็น 404 แปลว่ายังไม่ได้ตั้ง Webhook URL ไว้ที่ LINE' };
  }
  const code = probe.data?.statusCode;
  if (probe.data?.success === true || code === 200) {
    return { ...base, ok: true, detail: 'LINE ยิงเข้ามาแล้วระบบตอบรับเรียบร้อย (200) — ทางเดินครบทั้งเส้น' };
  }
  if (code === 401) {
    return { ...base, ok: false,
      detail: 'ยิงมาถึงระบบแล้ว แต่ระบบปฏิเสธเพราะ<strong>ลายเซ็นไม่ตรง</strong> (401)',
      fix: 'ค่า <code>LINE_CHANNEL_SECRET</code> บนเซิร์ฟเวอร์ไม่ตรงกับ Channel secret ปัจจุบัน — คัดลอกค่าจากหน้า Basic settings มาตั้งใหม่แล้ว restart' };
  }
  if (code === 503) {
    return { ...base, ok: false, detail: 'ยิงมาถึงแล้ว แต่ระบบยังไม่ได้ตั้ง Channel secret จึงตรวจลายเซ็นไม่ได้ (503)',
      fix: 'ตั้งตัวแปร <code>LINE_CHANNEL_SECRET</code> บนเซิร์ฟเวอร์แล้ว restart' };
  }
  return { ...base, ok: false,
    detail: `LINE ยิงเข้ามาแล้วไม่สำเร็จ${code ? ` (ระบบตอบ ${code})` : ''}${probe.data?.reason ? ` — ${esc(String(probe.data.reason))}` : ''}`,
    fix: 'ถ้าเป็น timeout หรือติดต่อไม่ได้ ให้เปิดเว็บระบบสักครั้งเพื่อปลุกเซิร์ฟเวอร์ที่หลับอยู่ แล้วตรวจใหม่' };
}

// ───────────────────────────────── ตัวส่งคิว ─────────────────────────────────

const MAX_ATTEMPTS = 5;
// ข้อความที่ค้างเกินหนึ่งวันไม่มีประโยชน์แล้ว — "หนังสือด่วนรอคุณ" ที่เด้งมาหลังจากผ่านไปสามวันมีแต่
// ทำให้สับสน และถ้า LINE ล่มยาวแล้วกลับมา ครูจะโดนถล่มด้วยข้อความเก่าทีเดียวเป็นสิบฉบับ
const MAX_AGE_HOURS = 24;
// เก็บประวัติที่ส่งสำเร็จไว้พอให้ตามหาได้ว่าข้อความหายไปไหน แล้วลบทิ้ง ไม่ให้ตารางโตไปเรื่อยๆ
const KEEP_SENT_DAYS = 14;

function hoursAgoIso(h) { return new Date(Date.now() - h * 3600000).toISOString(); }

/**
 * ส่งข้อความที่ค้างอยู่ในคิว
 *
 * คืน { sent, failed, expired } เพื่อให้เทสต์และหน้าผู้ดูแลตรวจได้ว่าเกิดอะไรขึ้นจริง
 */
export async function flushLineOutbox({ limit = 25 } = {}) {
  const result = { sent: 0, failed: 0, expired: 0 };
  if (!isLineNotifyConfigured()) return result;

  const cutoff = hoursAgoIso(MAX_AGE_HOURS);
  result.expired = db.prepare(`
    UPDATE line_outbox SET attempts = ?, last_error = 'ค้างในคิวเกิน ${MAX_AGE_HOURS} ชั่วโมง จึงเลิกส่ง'
    WHERE sent_at IS NULL AND attempts < ? AND created_at < ?
  `).run(MAX_ATTEMPTS, MAX_ATTEMPTS, cutoff).changes;

  const rows = db.prepare(`
    SELECT * FROM line_outbox WHERE sent_at IS NULL AND attempts < ? ORDER BY created_at LIMIT ?
  `).all(MAX_ATTEMPTS, limit);

  for (const row of rows) {
    const res = await sender('/message/push', { to: row.line_user_id, messages: [{ type: 'text', text: row.body }] });
    if (res?.ok) {
      db.prepare('UPDATE line_outbox SET sent_at = ?, attempts = attempts + 1, last_error = NULL WHERE id = ?')
        .run(nowIso(), row.id);
      result.sent++;
      continue;
    }
    // 4xx (ยกเว้น 429 ที่แปลว่าส่งถี่เกินไป) คือ "ส่งอีกกี่ครั้งก็ไม่ผ่าน" เช่นโทเคนผิด หรือผู้ใช้บล็อก
    // บัญชีทางการไปแล้ว — ลองซ้ำไปก็เปลืองเปล่าและทำให้ข้อความใหม่ของคนอื่นรอคิวอยู่ข้างหลัง
    const permanent = res?.status >= 400 && res.status < 500 && res.status !== 429;
    db.prepare('UPDATE line_outbox SET attempts = ?, last_error = ? WHERE id = ?')
      .run(permanent ? MAX_ATTEMPTS : row.attempts + 1, String(res?.error || 'ไม่ทราบสาเหตุ').slice(0, 300), row.id);
    result.failed++;
  }

  db.prepare('DELETE FROM line_outbox WHERE sent_at IS NOT NULL AND sent_at < ?')
    .run(hoursAgoIso(KEEP_SENT_DAYS * 24));
  return result;
}

let flushTimer = null;
/** เริ่มตัวส่งคิวแบบเดินเป็นรอบ — เรียกครั้งเดียวตอนระบบ start (ดู server.js) */
export function startLineOutboxFlusher({ intervalMs = 20000 } = {}) {
  if (flushTimer || !isLineNotifyConfigured()) return false;
  flushTimer = setInterval(() => {
    flushLineOutbox().catch((err) => console.error('[line] ส่งคิวไม่สำเร็จ:', err?.message || err));
  }, intervalMs);
  // อย่าให้ตัวจับเวลานี้กันโปรเซสไม่ให้ปิด เวลาสั่งหยุดระบบ
  flushTimer.unref?.();
  return true;
}

// ───────────────────────────────── รับ webhook ─────────────────────────────────

/**
 * ตรวจว่า request ที่เข้ามาเป็นของ LINE จริง
 *
 * ที่อยู่ของ webhook เป็นสาธารณะ ใครก็ยิงเข้ามาได้ ถ้าไม่ตรวจลายเซ็น ใครก็ปลอมเหตุการณ์ "ผู้ใช้ส่ง
 * รหัสเชื่อมบัญชีมา" พร้อมรหัสที่เดาเอง แล้วยิงรัวๆ จนเจอ เพื่อผูกบัญชีไลน์ของตัวเองเข้ากับบัญชีครู
 * ในระบบ แล้วรับการแจ้งเตือน (ซึ่งมีชื่อเรื่องหนังสือ) ของครูคนนั้นไปทั้งหมด
 */
export function verifyLineSignature(rawBody, signature) {
  const secret = lineChannelSecret();
  if (!secret || !signature) return false;
  const expected = createHmac('sha256', secret)
    .update(Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8'))
    .digest();
  let got;
  try { got = Buffer.from(String(signature), 'base64'); } catch { return false; }
  // ความยาวต้องเท่ากันก่อน ไม่งั้น timingSafeEqual โยน error แทนที่จะคืน false
  if (got.length !== expected.length) return false;
  return timingSafeEqual(got, expected);
}

const HELP_TEXT = [
  'สวัสดีครับ นี่คือบัญชีแจ้งเตือนของระบบสารบรรณอิเล็กทรอนิกส์',
  '',
  'วิธีเปิดรับแจ้งเตือน: เข้าเว็บระบบสารบรรณ → โปรไฟล์ของฉัน → "แจ้งเตือนเข้าไลน์" → กดขอรหัส',
  `แล้วส่งข้อความ "${LINK_KEYWORD} ตามด้วยรหัส" เข้ามาที่นี่`,
].join('\n');

function replyToLine(replyToken, text) {
  if (!replyToken) return Promise.resolve({ ok: false });
  return sender('/message/reply', { replyToken, messages: [{ type: 'text', text }] });
}

// ──────────────────────── บันทึกร่องรอยว่ามีอะไรยิงเข้ามาจาก LINE บ้าง ────────────────────────
//
// เก็บไว้เท่าที่จำเป็นต่อการหาสาเหตุเท่านั้น: เกิดอะไรขึ้น กับเมื่อไหร่ — ไม่เก็บเนื้อข้อความที่ครูพิมพ์
// และไม่เก็บ userId ฝั่งไลน์ เพราะหน้านี้ผู้ดูแลระบบเปิดดูได้ แต่แชทของครูไม่ใช่ของผู้ดูแล
// (รหัสเชื่อมบัญชีก็ห้ามเก็บด้วยเหตุผลเดียวกับที่ไม่เก็บลงใน audit log — ดู routes/line.js)
const WEBHOOK_LOG_KEEP = 50;

export function recordLineWebhook(kind, detail = null) {
  try {
    db.prepare('INSERT INTO line_webhook_log (id, received_at, kind, detail) VALUES (?, ?, ?, ?)')
      .run(uuid(), nowIso(), String(kind), detail ? String(detail).slice(0, 200) : null);
    // ตัดของเก่าทิ้งทุกครั้งที่เขียน — ตารางนี้มีไว้ตอบคำถาม "เมื่อกี้เกิดอะไรขึ้น" ไม่ใช่เก็บเป็นประวัติ
    // และเครื่องที่รันอยู่เป็นดิสก์เล็กๆ จึงไม่ปล่อยให้โตไปเรื่อยๆ ตามจำนวนข้อความที่ครูส่งเข้ามา
    db.prepare(`
      DELETE FROM line_webhook_log WHERE id NOT IN (
        SELECT id FROM line_webhook_log ORDER BY received_at DESC, id DESC LIMIT ?
      )`).run(WEBHOOK_LOG_KEEP);
  } catch (err) {
    // บันทึกไม่ได้ต้องไม่ทำให้ webhook พัง — ตารางนี้เป็นเครื่องมือช่วยหาสาเหตุ ไม่ใช่ทางเดินหลัก
    console.error('[line] บันทึกร่องรอย webhook ไม่สำเร็จ:', err?.message || err);
  }
}

/** ร่องรอยล่าสุด ใหม่ก่อน — สำหรับหน้า /admin/line */
export function recentLineWebhooks(limit = 15) {
  try {
    return db.prepare('SELECT received_at, kind, detail FROM line_webhook_log ORDER BY received_at DESC, id DESC LIMIT ?')
      .all(Math.max(1, Math.min(WEBHOOK_LOG_KEEP, Number(limit) || 15)));
  } catch { return []; }
}

// หารหัสในข้อความที่ครูส่งเข้ามา — รับทั้งแบบมีคำนำหน้า ("เชื่อมบัญชี ABCD2345") และแบบพิมพ์รหัส
// มาเปล่าๆ เพราะคนที่พิมพ์เองมักลืมคำนำหน้า แล้วจะงงว่าทำไมไม่ติด
function extractCode(text) {
  const s = String(text || '').trim();
  const withKeyword = s.match(new RegExp(`${LINK_KEYWORD}\\s*[:：]?\\s*([A-Za-z0-9]{${CODE_LENGTH}})`));
  if (withKeyword) return withKeyword[1].toUpperCase();
  const bare = s.match(new RegExp(`^([A-Za-z0-9]{${CODE_LENGTH}})$`));
  return bare ? bare[1].toUpperCase() : '';
}

/**
 * จัดการเหตุการณ์ที่ LINE ส่งมา
 *
 * ต้องไม่โยน error ออกไป — LINE ตัดสินว่า webhook ใช้การได้หรือไม่จากรหัสตอบกลับ ถ้าตอบไม่ใช่ 200
 * บ่อยๆ ระบบจะปิด webhook ให้เอง แล้วการเชื่อมบัญชีจะเงียบหายไปทั้งโรงเรียนโดยไม่มีอะไรฟ้อง
 */
export async function handleLineEvents(events) {
  const outcomes = [];
  for (const ev of Array.isArray(events) ? events : []) {
    const lineUserId = ev?.source?.userId;
    try {
      if (ev?.type === 'unfollow') {
        // บล็อก/ลบบัญชีทางการไปแล้ว — ถ้ายังผูกไว้ ข้อความจะถูกส่งออกไปแล้วล้มเงียบๆ ตลอดกาล
        // และเจ้าตัวจะเข้าใจว่ายังได้รับแจ้งเตือนอยู่
        const u = lineUserId ? db.prepare('SELECT id FROM users WHERE line_user_id = ?').get(lineUserId) : null;
        if (u) unlinkLineAccount(u.id);
        recordLineWebhook('unfollow', u ? 'ปลดการเชื่อมบัญชีให้แล้ว' : null);
        outcomes.push({ type: 'unfollow', unlinked: Boolean(u) });
        continue;
      }
      if (ev?.type === 'follow') {
        await replyToLine(ev.replyToken, HELP_TEXT);
        recordLineWebhook('follow');
        outcomes.push({ type: 'follow' });
        continue;
      }
      if (ev?.type !== 'message' || ev?.message?.type !== 'text') {
        recordLineWebhook('ignored', ev?.type ? `ชนิด ${ev.type}` : null);
        outcomes.push({ type: 'ignored' });
        continue;
      }
      const code = extractCode(ev.message.text);
      if (!code) {
        await replyToLine(ev.replyToken, HELP_TEXT);
        recordLineWebhook('no_code');
        outcomes.push({ type: 'help' });
        continue;
      }
      const res = redeemLinkCode({ code, lineUserId });
      if (res.ok) {
        const name = `${res.user.prefix || ''}${res.user.first_name} ${res.user.last_name}`.trim();
        await replyToLine(ev.replyToken, `✅ เชื่อมบัญชีสำเร็จ — ${name}\nตั้งแต่นี้ไปการแจ้งเตือนของระบบสารบรรณจะส่งมาที่นี่`);
      } else {
        await replyToLine(ev.replyToken, res.reason === 'expired'
          ? '⌛ รหัสนี้หมดอายุแล้ว กรุณาขอรหัสใหม่ที่หน้าโปรไฟล์ของฉันในระบบสารบรรณ'
          : '❌ ไม่พบรหัสนี้ในระบบ กรุณาตรวจตัวอักษรอีกครั้ง หรือขอรหัสใหม่ที่หน้าโปรไฟล์ของฉัน');
      }
      recordLineWebhook(res.ok ? 'link_ok' : res.reason === 'expired' ? 'link_expired' : 'link_invalid');
      outcomes.push({ type: 'link', ok: res.ok, reason: res.reason });
    } catch (err) {
      console.error('[line] จัดการเหตุการณ์จาก LINE ไม่สำเร็จ:', err?.message || err);
      recordLineWebhook('error', err?.message || String(err));
      outcomes.push({ type: 'error' });
    }
  }
  return outcomes;
}

// ──────────────────────── เชื่อมบัญชีอัตโนมัติเมื่อเปิดจากในแอป LINE ────────────────────────
//
// เวลาเปิดระบบผ่าน LIFF (คือเปิดขึ้นมาในแอป LINE เลย) ตัว LIFF บอกได้ว่าคนที่กำลังเปิดอยู่คือบัญชี
// ไลน์ไหน จึงไม่ต้องให้ครูขอรหัสแล้วพิมพ์ส่งเข้าแชทอีก — ระบบผูกให้เองในคลิกเดียว
//
// ห้ามเชื่อ userId ที่หน้าเว็บส่งมาตรงๆ เด็ดขาด ใครก็ยิง fetch ใส่เส้นทางนี้พร้อม userId ของคนอื่นได้
// จึงรับเป็น ID token (JWT ที่ LINE เซ็นไว้) แล้วส่งไปให้ LINE ตรวจให้ว่าเป็นของจริงและออกให้ใคร
async function httpVerifyIdToken(idToken, clientId) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 10000);
  try {
    const res = await fetch('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: clientId }).toString(),
      signal: ac.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

let idTokenVerifier = httpVerifyIdToken;
/** สำหรับเทสต์เท่านั้น */
export function _setLineIdTokenVerifierForTest(fn) { idTokenVerifier = fn || httpVerifyIdToken; }

/**
 * ผูกบัญชีจาก ID token ที่ได้มาจาก LIFF
 *
 * ตรวจสามชั้นก่อนเชื่อ: LINE บอกว่าโทเคนนี้ของจริงไหม, ออกให้แอปของเราหรือของคนอื่น (aud),
 * และหมดอายุหรือยัง (exp) — ชั้น aud สำคัญที่สุด เพราะ ID token ของแอป LINE อื่นก็เป็น "ของจริง"
 * เหมือนกัน ถ้าไม่ตรวจ ใครที่มีแอป LINE ของตัวเองก็เอาโทเคนจากแอปตัวเองมาผูกบัญชีที่นี่ได้
 */
export async function linkLineAccountByIdToken({ userId, idToken }) {
  const clientId = lineLoginChannelId();
  if (!clientId) return { ok: false, reason: 'not_configured' };
  if (!idToken || typeof idToken !== 'string') return { ok: false, reason: 'invalid_token' };
  const claims = await idTokenVerifier(idToken, clientId);
  if (!claims || !claims.sub) return { ok: false, reason: 'invalid_token' };
  if (String(claims.aud) !== clientId) return { ok: false, reason: 'wrong_audience' };
  if (claims.iss && claims.iss !== 'https://access.line.me') return { ok: false, reason: 'wrong_issuer' };
  if (claims.exp && Number(claims.exp) * 1000 < Date.now()) return { ok: false, reason: 'expired' };

  const existing = db.prepare('SELECT id FROM users WHERE line_user_id = ?').get(claims.sub);
  if (existing && existing.id === userId) return { ok: true, alreadyLinked: true };
  // บัญชีไลน์เดียวผูกได้กับคนเดียว (เหตุผลเดียวกับ redeemLinkCode)
  db.prepare('UPDATE users SET line_user_id = NULL, line_linked_at = NULL WHERE line_user_id = ? AND id != ?')
    .run(claims.sub, userId);
  db.prepare(`
    UPDATE users SET line_user_id = ?, line_linked_at = ?, line_link_code = NULL,
      line_link_code_expires_at = NULL, updated_at = ? WHERE id = ?
  `).run(claims.sub, nowIso(), nowIso(), userId);
  audit({ userId, action: 'line_linked', tableName: 'users', recordId: userId, detail: { via: 'liff' } });
  return { ok: true };
}

/** ตัวเลขสำหรับหน้าผู้ดูแล — เชื่อมกันกี่คน คิวค้างเท่าไร ส่งไม่ผ่านกี่ฉบับ */
export function lineNotifyStatus() {
  const linked = db.prepare('SELECT COUNT(*) c FROM users WHERE line_user_id IS NOT NULL AND deleted_at IS NULL').get().c;
  // ตัวหาร — "เชื่อมแล้ว 3 คน" ไม่ได้บอกอะไรเลยถ้าไม่รู้ว่าจากทั้งหมดกี่คน ธุรการที่กำลังไล่ตาม
  // ให้ครูเชื่อมบัญชีต้องเห็นว่าเหลืออีกกี่คน ไม่ใช่เห็นแค่ตัวเลขลอยๆ
  const totalUsers = db.prepare("SELECT COUNT(*) c FROM users WHERE deleted_at IS NULL AND status = 'active'").get().c;
  const active = db.prepare(`
    SELECT COUNT(*) c FROM users WHERE line_user_id IS NOT NULL AND line_notify_enabled = 1 AND deleted_at IS NULL
  `).get().c;
  const pending = db.prepare('SELECT COUNT(*) c FROM line_outbox WHERE sent_at IS NULL AND attempts < ?').get(MAX_ATTEMPTS).c;
  const givenUp = db.prepare('SELECT COUNT(*) c FROM line_outbox WHERE sent_at IS NULL AND attempts >= ?').get(MAX_ATTEMPTS).c;
  const lastError = db.prepare(`
    SELECT last_error, created_at FROM line_outbox WHERE last_error IS NOT NULL ORDER BY created_at DESC LIMIT 1
  `).get();
  return {
    configured: isLineNotifyConfigured(),
    webhookReady: isLineWebhookConfigured(),
    basicId: lineBasicId(),
    liffId: liffId(),
    // เปิดในแอป LINE ได้ต้องมีทั้งไอดี LIFF และไอดี channel ของ LINE Login ที่ LIFF อันนั้นสังกัดอยู่
    // (ไอดี channel ใช้ตรวจว่า ID token ที่หน้าเว็บส่งมาเป็นของแอปเราจริง ไม่ใช่ของแอปคนอื่น)
    liffReady: Boolean(liffId() && lineLoginChannelId()),
    linked, active, pending, givenUp, totalUsers,
    lastError: lastError?.last_error || null,
  };
}

/** คนที่ยังไม่ได้เชื่อมบัญชีไลน์ — สำหรับธุรการใช้ไล่ตามตอนเริ่มใช้งานระบบ */
export function usersWithoutLine(limit = 50) {
  return db.prepare(`
    SELECT u.id, u.prefix, u.first_name, u.last_name, u.employee_code,
      GROUP_CONCAT(r.name_th) AS role_names
    FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id
    LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.line_user_id IS NULL AND u.deleted_at IS NULL AND u.status = 'active'
    GROUP BY u.id ORDER BY u.first_name LIMIT ?
  `).all(limit);
}

export const _internals = { MAX_ATTEMPTS, MAX_AGE_HOURS, CODE_LENGTH, extractCode };
