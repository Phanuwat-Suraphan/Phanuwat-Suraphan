import { db, uuid, nowIso, verifySecret, getUserByCode, getUserRoles, audit } from './db.js';
import { observedHttps } from './services/publicUrl.js';
import { createHmac, randomBytes } from 'node:crypto';

const SESSION_COOKIE = 'esaraban_sid';

/**
 * อายุเซสชันมีสองชั้น: "ไม่ได้แตะนานแค่ไหนถึงหลุด" กับ "เปิดค้างได้นานสุดเท่าไร"
 *
 * เดิมมีชั้นเดียว คือนับ 8 ชั่วโมงจากตอนล็อกอินแล้วตัดทิ้ง ไม่ว่าจะใช้งานอยู่หรือไม่ ผลคือธุรการที่
 * ทำงานอยู่ทั้งวันถูกเด้งออกกลางคันพอดีตอนครบ 8 ชั่วโมง — ถ้ากำลังกรอกฟอร์มลงทะเบียนอยู่ ข้อความ
 * ที่พิมพ์ไว้หายทั้งหมด (ทดสอบยืนยันแล้วว่าเวลาหมดอายุไม่ขยับเลยแม้จะใช้งานต่อเนื่อง)
 *
 * เรื่องนี้เจ็บกว่าเดิมมากตั้งแต่ครูเข้าระบบจากลิงก์ในไลน์ เพราะนั่นคือเบราว์เซอร์ในแอปซึ่งเก็บคุกกี้
 * แยกจากเบราว์เซอร์ปกติ การล็อกอินใหม่แต่ละครั้งจึงต้องพิมพ์รหัสบนแป้นพิมพ์มือถือทุกตัว
 *
 * ชั้นที่สอง (เปิดค้างได้นานสุด 7 วัน) มีไว้กันไม่ให้เซสชันที่ถูกใช้เรื่อยๆ กลายเป็นถาวร ซึ่งสำคัญ
 * เพราะเครื่องส่วนกลางในห้องธุรการมีคนใช้ร่วมกันหลายคน
 */
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // ไม่ได้แตะเกิน 8 ชั่วโมง = หลุด
const SESSION_MAX_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000; // เปิดค้างได้นานสุด 7 วัน แล้วต้องล็อกอินใหม่

/**
 * "จำเครื่องนี้ไว้" — เครื่องส่วนตัวของเจ้าตัวเอง ไม่ใช่เครื่องส่วนกลางในห้องธุรการ
 *
 * ตัวเลขข้างบนถูกตั้งไว้เผื่อกรณีเครื่องส่วนกลางที่ครูหลายคนใช้ร่วมกัน ซึ่งถูกต้องสำหรับเครื่องนั้น
 * แต่กับมือถือส่วนตัวมันแปลว่าต้องพิมพ์รหัสผ่านใหม่อย่างน้อยทุก 7 วัน และถ้าไม่ได้เปิดข้ามคืนก็ทุกเช้า
 * — บนแป้นพิมพ์มือถือ ผ่านเบราว์เซอร์ในแอปไลน์ที่ไม่ได้จำรหัสให้ ซึ่งเป็นเหตุผลอันดับหนึ่งที่คนเลิกใช้
 *
 * ความเสี่ยงที่แลกมาคือ ถ้าเครื่องหาย คนที่ได้เครื่องไปใช้ต่อได้จนกว่าจะครบกำหนดหรือมีคนตัดเซสชันทิ้ง
 * จึงต้องเป็นการ "ติ๊กเอง" เท่านั้น ไม่ใช่ค่าเริ่มต้น และต้องเขียนข้างช่องให้ชัดว่าห้ามติ๊กบนเครื่องส่วนกลาง
 * ทางออกเวลาเครื่องหายมีอยู่แล้วสองทาง: เปลี่ยนรหัสผ่าน (ตัดเซสชันอื่นทิ้งหมด) หรือให้ผู้ดูแลรีเซ็ตรหัสให้
 */
const REMEMBERED_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// ต่ออายุอย่างมากทุกๆ 15 นาที ไม่ใช่ทุก request — ไม่งั้นการเปิดหน้าเว็บหนึ่งครั้งกลายเป็นการเขียน
// ฐานข้อมูลหนึ่งครั้งเสมอ ซึ่งแพงโดยไม่จำเป็นและทำให้ไฟล์ WAL โตเร็ว
const SESSION_REFRESH_AFTER_MS = 15 * 60 * 1000;
const SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me-esaraban-school';
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes — Security Bible §7

function sign(value) {
  const h = createHmac('sha256', SECRET).update(value).digest('hex');
  return `${value}.${h}`;
}

function unsign(signed) {
  if (!signed) return null;
  const idx = signed.lastIndexOf('.');
  if (idx === -1) return null;
  const value = signed.slice(0, idx);
  const sig = signed.slice(idx + 1);
  const expected = createHmac('sha256', SECRET).update(value).digest('hex');
  if (sig.length !== expected.length) return null;
  let diff = 0;
  for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 ? value : null;
}

/**
 * ช่องว่างหน้า-หลังที่ติดมาโดยไม่ตั้งใจ ต้องไม่นับเป็นตัวอักษรที่ผู้ใช้พิมพ์
 *
 * บนมือถือ แป้นพิมพ์เติมช่องว่างให้เองหลังเลือกคำจากแถบคำแนะนำ และการคัดลอกรหัสที่ผู้ดูแลส่งมาทางไลน์
 * มักติดช่องว่างหรือขึ้นบรรทัดใหม่มาด้วยเสมอ ผลคือ "บัญชีผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" ทั้งที่พิมพ์ถูกทุกตัว
 * และมองด้วยตาก็ไม่มีทางเห็นว่าต่างกันตรงไหน — ครูจะสรุปว่ารหัสที่ได้มาใช้ไม่ได้
 *
 * รหัสผ่านตัดช่องว่างทิ้งไปเลยไม่ได้ เพราะถ้ามีใครตั้งรหัสที่มีช่องว่างหน้า-หลังไว้จริง รหัสนั้นจะใช้ไม่ได้
 * ทันที จึงลองแบบที่พิมพ์มาก่อนเสมอ แล้วค่อยลองแบบตัดช่องว่างเป็นทางสำรอง — ไม่มีรหัสเดิมของใครพังเลย
 * และการนับครั้งที่กรอกผิดยังเดินตามปกติเมื่อผิดจริงทั้งสองแบบ
 */
function passwordMatches(password, hash) {
  if (verifySecret(password, hash)) return true;
  const trimmed = String(password ?? '').trim();
  return trimmed !== password && verifySecret(trimmed, hash);
}

export function login(employeeCode, password, ip, userAgent, { remember = false } = {}) {
  // รหัสพนักงานตัดช่องว่างได้เลย ไม่ต้องมีทางสำรอง — เป็นชื่อบัญชีที่ผู้ดูแลตั้งให้ ไม่มีกรณีที่ตั้งใจ
  // ให้มีช่องว่างหัวท้าย (และฝั่งสร้างผู้ใช้ก็ตัดทิ้งอยู่แล้ว)
  employeeCode = typeof employeeCode === 'string' ? employeeCode.trim() : employeeCode;
  const user = getUserByCode(employeeCode);
  if (!user || user.status !== 'active') {
    audit({ action: 'login_failed', detail: { employeeCode, reason: 'no_user' }, ip });
    return { ok: false, error: 'บัญชีผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  }

  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    const minutesLeft = Math.ceil((new Date(user.locked_until) - new Date()) / 60000);
    audit({ userId: user.id, action: 'login_blocked_locked', detail: { employeeCode }, ip });
    return { ok: false, error: `บัญชีถูกล็อกชั่วคราวเนื่องจากกรอกรหัสผ่านผิดหลายครั้ง กรุณาลองใหม่อีกครั้งในอีก ${minutesLeft} นาที` };
  }

  if (!passwordMatches(password, user.password_hash)) {
    const failedCount = (user.failed_login_count || 0) + 1;
    if (failedCount >= MAX_FAILED_ATTEMPTS) {
      const lockedUntil = new Date(Date.now() + LOCKOUT_MS).toISOString();
      db.prepare('UPDATE users SET failed_login_count = 0, locked_until = ? WHERE id = ?').run(lockedUntil, user.id);
      audit({ userId: user.id, action: 'account_locked', detail: { employeeCode, attempts: failedCount }, ip });
      return { ok: false, error: `กรอกรหัสผ่านผิดครบ ${MAX_FAILED_ATTEMPTS} ครั้ง บัญชีถูกล็อกชั่วคราว 15 นาที` };
    }
    db.prepare('UPDATE users SET failed_login_count = ? WHERE id = ?').run(failedCount, user.id);
    audit({ userId: user.id, action: 'login_failed', detail: { employeeCode, reason: 'bad_password', attempts: failedCount }, ip });
    return { ok: false, error: 'บัญชีผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' };
  }

  if (user.failed_login_count > 0 || user.locked_until) {
    db.prepare('UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = ?').run(user.id);
  }
  // เก็บกวาดเซสชันที่หมดอายุไปแล้วตอนนี้ — เดิมแถวที่ตายแล้วถูกลบก็ต่อเมื่อเจ้าของกลับมาใช้คุกกี้เดิม
  // อีกครั้ง ซึ่งส่วนใหญ่ไม่เกิดขึ้น แถวจึงสะสมไปเรื่อยๆ และติดไปกับสำเนาสำรองที่ส่งขึ้น Google Drive ด้วย
  // ทำตอนล็อกอินเพราะเกิดไม่บ่อย (วันละไม่กี่ครั้งต่อคน) ไม่ต้องมีตัวจับเวลาแยก
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());

  const sessionId = uuid();
  const remembered = Boolean(remember);
  const expiresAt = new Date(Date.now() + (remembered ? REMEMBERED_TTL_MS : SESSION_TTL_MS)).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at, remembered) VALUES (?, ?, ?, ?, ?)')
    .run(sessionId, user.id, expiresAt, nowIso(), remembered ? 1 : 0);
  // บันทึกไว้ใน audit ด้วย เพราะเซสชันยาว 90 วันเป็นข้อมูลที่ผู้ดูแลต้องเห็นตอนสอบสวนย้อนหลัง
  audit({ userId: user.id, action: 'login_success', ip, detail: { userAgent, remembered } });
  return { ok: true, cookie: sign(sessionId), user, remembered };
}

export function logout(sessionId, userId, ip, userAgent) {
  if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  audit({ userId, action: 'logout', ip, detail: { userAgent } });
}

/**
 * ตัดเซสชันอื่นๆ ของผู้ใช้คนนี้ทิ้งทั้งหมด เหลือไว้แต่เครื่องที่กำลังใช้อยู่
 *
 * เหตุผลที่ต้องมี: คนเปลี่ยนรหัสผ่านเพราะสงสัยว่ารหัสรั่ว (เผลอเปิดค้างที่เครื่องส่วนกลาง มีคนเห็นตอนพิมพ์)
 * ถ้าไม่ตัดเซสชันเดิม คนที่ถือคุกกี้อยู่ยังใช้งานต่อได้อีกถึง 8 ชั่วโมงตามอายุเซสชัน ทั้งที่รหัสผ่านเปลี่ยนไปแล้ว
 * — เท่ากับการเปลี่ยนรหัสผ่านไม่ได้แก้ปัญหาที่ตั้งใจจะแก้เลย (ทดสอบกับระบบจริงแล้วว่าเซสชันเดิมยังเปิดหน้าได้)
 */
export function revokeOtherSessions(userId, keepSessionId) {
  const result = db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, keepSessionId || '');
  return Number(result.changes || 0);
}

export function getSessionUser(cookieHeader) {
  const raw = parseCookie(cookieHeader, SESSION_COOKIE);
  const sessionId = unsign(raw);
  if (!sessionId) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    return null;
  }
  // ต้องเช็ค status ด้วย ไม่ใช่แค่ deleted_at — บัญชีที่ถูกระงับ (เช่น ครูที่ย้ายออกไปแล้ว) ต้องใช้งาน
  // ไม่ได้ทันที ไม่ใช่ใช้ต่อได้จนกว่าเซสชันจะหมดอายุเอง (login() กันไว้แล้ว แต่เซสชันที่เปิดค้างอยู่รอดมาได้)
  const user = db.prepare("SELECT * FROM users WHERE id = ? AND deleted_at IS NULL AND status = 'active'").get(session.user_id);
  if (!user) return null;
  extendSession(session);
  const roles = getUserRoles(user.id);
  return { ...user, roles, roleCodes: roles.map((r) => r.name), sessionId };
}

/** เลื่อนเวลาหมดอายุออกไปตามการใช้งาน แต่ไม่เกินอายุสูงสุดของเซสชันนั้น */
function extendSession(session) {
  const now = Date.now();
  const target = now + SESSION_TTL_MS;
  // เครื่องที่ติ๊ก "จำเครื่องนี้ไว้" ได้อายุ 90 วันตั้งแต่ตอนล็อกอินเลย (ดู login) และเป็นช่วงตายตัว
  // ไม่ใช่ช่วงที่ขยับตามการใช้งาน — ฟังก์ชันนี้จึงไม่มีอะไรต้องทำกับมัน เพราะเลื่อนได้แต่ไปข้างหน้า
  // และเพดานก็เท่ากับค่าที่ตั้งไว้แล้วพอดี ตั้งใจให้เป็นช่วงตายตัวเพื่อให้ยังต้องยืนยันตัวตนใหม่ทุกไตรมาส
  // ถ้าปล่อยให้ขยับไปเรื่อยๆ ตามการใช้งาน เครื่องที่เปิดใช้ทุกวันจะไม่มีวันหมดอายุเลย
  const hardLimit = Date.parse(session.created_at) + (session.remembered ? REMEMBERED_TTL_MS : SESSION_MAX_LIFETIME_MS);
  // created_at ที่อ่านไม่ออก (ข้อมูลเก่า/เพี้ยน) ต้องไม่ทำให้เซสชันหมดอายุทันทีหรือกลายเป็นถาวร —
  // ถ้าคำนวณเพดานไม่ได้ ก็ใช้เพดานจากตอนนี้ไปอีกหนึ่งช่วงอายุ ซึ่งปลอดภัยทั้งสองทาง
  const cap = Number.isNaN(hardLimit) ? target : hardLimit;
  const next = Math.min(target, cap);
  const current = Date.parse(session.expires_at);
  // ยังไม่ถึงรอบต่ออายุ หรือชนเพดานอายุสูงสุดแล้ว — ไม่ต้องเขียนฐานข้อมูล
  if (!(next - current >= SESSION_REFRESH_AFTER_MS)) return;
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(new Date(next).toISOString(), session.id);
}

export function sessionCookieHeader(cookieValue, { clear = false, remembered = false } = {}) {
  // อายุคุกกี้ในเบราว์เซอร์ต้องยาวเท่าอายุสูงสุดของเซสชัน ไม่ใช่เท่าช่วงไม่ได้แตะ — ไม่งั้นคุกกี้
  // หายจากเครื่องก่อนที่เซสชันฝั่งเซิร์ฟเวอร์จะหมดอายุ ครูก็ต้องล็อกอินใหม่อยู่ดีทั้งที่เซสชันยังมีชีวิต
  //
  // เครื่องที่ติ๊ก "จำเครื่องนี้ไว้" ต้องยืดคุกกี้ตามไปด้วย ไม่งั้นเบราว์เซอร์ลบคุกกี้ทิ้งตั้งแต่วันที่ 7
  // ทั้งที่เซสชันฝั่งเซิร์ฟเวอร์ยังอยู่อีก 83 วัน — ผู้ใช้จะเห็นว่า "ติ๊กจำไว้แล้วก็ยังหลุดอยู่ดี"
  const maxAge = clear ? 0 : Math.floor((remembered ? REMEMBERED_TTL_MS : SESSION_MAX_LIFETIME_MS) / 1000);
  const val = clear ? '' : cookieValue;
  // Secure = ห้ามเบราว์เซอร์ส่งคุกกี้นี้ผ่าน http ธรรมดาเด็ดขาด
  //
  // ระบบส่งหัว Strict-Transport-Security อยู่แล้ว แต่หัวนั้นช่วยได้ตั้งแต่ "ครั้งที่สอง" เป็นต้นไป
  // เท่านั้น — การเปิดเว็บครั้งแรกสุดของเครื่องนั้น (หรือหลังล้างข้อมูลเบราว์เซอร์) ถ้าพิมพ์ที่อยู่
  // ขึ้นต้นด้วย http:// คุกกี้เซสชันจะถูกส่งออกไปแบบอ่านได้ ซึ่งบนไวไฟของโรงเรียนใครก็ดักได้
  //
  // ใส่เฉพาะเมื่อ "รู้แน่ๆ" ว่าผู้ใช้เข้ามาด้วย https ห้ามเดาเด็ดขาด (ดู observedHttps ใน
  // services/publicUrl.js) — เดาผิดทางนี้แปลว่าเบราว์เซอร์ทิ้งคุกกี้ทิ้ง แล้วไม่มีใครล็อกอินได้เลย
  const secure = observedHttps() ? ' Secure;' : '';
  return `${SESSION_COOKIE}=${val};${secure} HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
}

export function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const parts = cookieHeader.split(';').map((p) => p.trim());
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    if (p.slice(0, eq) === name) return decodeURIComponent(p.slice(eq + 1));
  }
  return null;
}

export function verifyPin(userId, pin) {
  const user = db.prepare('SELECT pin_hash FROM users WHERE id = ?').get(userId);
  return verifySecret(pin, user?.pin_hash);
}

export function hasRole(user, ...codes) {
  return user?.roleCodes?.some((c) => codes.includes(c));
}

export function requireAuth(user, res) {
  if (!user) {
    res.writeHead(302, { Location: '/login' });
    res.end();
    return false;
  }
  return true;
}
