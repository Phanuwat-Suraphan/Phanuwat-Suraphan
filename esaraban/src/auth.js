import { db, uuid, nowIso, verifySecret, getUserByCode, getUserRoles, audit } from './db.js';
import { createHmac, randomBytes } from 'node:crypto';

const SESSION_COOKIE = 'esaraban_sid';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
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

export function login(employeeCode, password, ip) {
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

  if (!verifySecret(password, user.password_hash)) {
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
  const sessionId = uuid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare('INSERT INTO sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)').run(sessionId, user.id, expiresAt, nowIso());
  audit({ userId: user.id, action: 'login_success', ip });
  return { ok: true, cookie: sign(sessionId), user };
}

export function logout(sessionId, userId, ip) {
  if (sessionId) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  audit({ userId, action: 'logout', ip });
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
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').get(session.user_id);
  if (!user) return null;
  const roles = getUserRoles(user.id);
  return { ...user, roles, roleCodes: roles.map((r) => r.name), sessionId };
}

export function sessionCookieHeader(cookieValue, { clear = false } = {}) {
  const maxAge = clear ? 0 : Math.floor(SESSION_TTL_MS / 1000);
  const val = clear ? '' : cookieValue;
  return `${SESSION_COOKIE}=${val}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${maxAge}`;
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
