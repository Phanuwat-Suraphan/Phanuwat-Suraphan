// ค่าตั้งค่าของระบบที่แอดมินแก้เองได้จากหน้าเว็บ
//
// ที่มา: ระบบนี้ถูกนำไปใช้ที่โรงเรียนที่สอง ชื่อโรงเรียนเดิมจึงฝังอยู่ในโค้ด 8 จุด (รวมตราประทับบน PDF
// และแบบฟอร์มใบลา) การย้ายมาเป็นค่าตั้งค่าทำให้ติดตั้งที่โรงเรียนใหม่ไม่ต้องแก้โค้ดเลย และที่สำคัญกว่า
// คือโรงเรียนแก้คำผิดในชื่อตัวเองได้ โดยไม่ต้องรอผู้พัฒนาหรือรอ deploy ใหม่
import { db, nowIso, audit } from '../db.js';
import { httpError, asText } from './validate.js';

// ลำดับความสำคัญของค่า: ที่แอดมินตั้งในหน้าเว็บ → env var (ค่าเริ่มต้นตอน deploy) → ค่าตั้งต้นของระบบ
const ENV_FALLBACK = {
  school_name: 'SCHOOL_NAME',
  school_short_name: 'SCHOOL_SHORT_NAME',
  school_initials: 'SCHOOL_INITIALS',
};

// ค่าเริ่มต้นของระบบ — ใช้เมื่อยังไม่มีใครตั้งค่าและไม่ได้ตั้ง env var ไว้
//
// ตั้งเป็นชื่อโรงเรียนที่ใช้ระบบนี้อยู่จริง ไม่ใช่ข้อความว่างหรือ "ยังไม่ได้ตั้งชื่อ" เพราะบนโฮสต์ฟรี
// (Render free tier) ดิสก์ไม่ถาวร ฐานข้อมูลจึงถูกล้างทุกครั้งที่ deploy — ค่าที่แอดมินตั้งไว้ในหน้าเว็บ
// จะหายไปด้วย ถ้าค่าเริ่มต้นเป็นข้อความกลางๆ หัวหนังสือราชการจะขึ้นว่า "ยังไม่ได้ตั้งชื่อ" ทุกครั้งที่
// deploy จนกว่าจะมีคนสังเกตเห็นแล้วเข้าไปตั้งใหม่
//
// ย้ายโรงเรียนหรือติดตั้งให้ที่ใหม่: แก้ที่หน้า "ตั้งค่าโรงเรียน" (ถ้าข้อมูลอยู่ถาวรแล้ว) หรือตั้ง env var
// SCHOOL_NAME ซึ่งอยู่รอดการล้างดิสก์เหมือนกัน — ไม่ต้องแก้โค้ด ทั้งสองทางชนะค่าตั้งต้นนี้เสมอ
const DEFAULTS = {
  school_name: 'โรงเรียนวัดเสาหิน',
  school_short_name: '',
  school_initials: '',
};

export const MAX_SETTING_LENGTH = { school_name: 200, school_short_name: 100, school_initials: 8 };

// อ่านค่าทุกครั้งที่ render หน้าเว็บ = อ่านฐานข้อมูลหลายสิบครั้งต่อการเปิดหน้าเดียว (ชื่อโรงเรียนถูกใช้
// ในหัวเอกสาร ตราประทับ แถบข้าง และหน้าพิมพ์) จึงแคชไว้ในหน่วยความจำแล้วล้างทิ้งตอนมีการแก้ค่า
let cache = null;
function loadCache() {
  if (cache) return cache;
  cache = new Map(db.prepare('SELECT key, value FROM app_settings').all().map((r) => [r.key, r.value]));
  return cache;
}
export function invalidateSettingsCache() { cache = null; }

export function getSetting(key) {
  const stored = loadCache().get(key);
  if (stored != null && stored !== '') return stored;
  const envName = ENV_FALLBACK[key];
  const fromEnv = envName ? asText(process.env[envName]) : '';
  if (fromEnv) return fromEnv;
  return DEFAULTS[key] ?? '';
}

export function setSetting({ key, value, actorUser }) {
  if (!(key in DEFAULTS)) throw httpError(400, `ไม่รู้จักค่าตั้งค่า "${key}"`);
  const clean = asText(value);
  const max = MAX_SETTING_LENGTH[key];
  if (max && clean.length > max) throw httpError(400, `ค่านี้ยาวเกิน ${max} ตัวอักษร`);
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  `).run(key, clean, actorUser?.id || null, nowIso());
  invalidateSettingsCache();
  audit({ userId: actorUser?.id, action: 'setting_changed', tableName: 'app_settings', recordId: key, detail: { key, value: clean } });
}

/** ชื่อโรงเรียนเต็ม ที่พิมพ์ลงหัวเอกสารราชการทุกใบ — ต้องมีคำว่า "โรงเรียน" นำหน้าอยู่ในตัวค่าเอง
 *  เพราะหลายที่ต่อข้อความตรงๆ เช่น `ผู้อำนวยการ${schoolName()}` และ "เขียนที่ ..." บนใบลา */
export function schoolName() { return getSetting('school_name'); }

/** ชื่อย่อสำหรับแถบข้าง/ชื่อแอป — ถ้าไม่ได้ตั้งไว้ ย่อ "โรงเรียน" เป็น "ร.ร." ให้เอง */
export function schoolShortName() {
  const set = getSetting('school_short_name');
  if (set) return set;
  return schoolName().replace(/^โรงเรียน\s*/, 'ร.ร.');
}

/** ชื่อแอปที่ปรากฏใต้ไอคอนบนหน้าจอมือถือ และในเมนู "แชร์" ของ LINE/แอปอื่น
 *
 *  ต้องมีที่เดียว เพราะถูกใช้สองที่ที่ห้ามไม่ตรงกัน: ตัว manifest ที่กำหนดชื่อจริง และคำแนะนำวิธีใช้
 *  บนหน้าแรกที่บอกครูว่า "ให้เลือกเมนูชื่อนี้" — ถ้าสองที่นี้เพี้ยนกัน ครูจะหาเมนูตามที่บอกไม่เจอ
 *  ตัดที่ 30 ตัวอักษรเพราะระบบปฏิบัติการตัดชื่อที่ยาวกว่านั้นทิ้งเองอยู่แล้ว
 */
export function appShortName() {
  return `สารบรรณ ${schoolShortName()}`.slice(0, 30);
}

/** ตัวอักษรย่อในวงกลมโลโก้ — ถ้าไม่ได้ตั้งไว้ ตัดสระ/วรรณยุกต์ออกแล้วเอาพยัญชนะสองตัวแรกของชื่อ
 *  (ตัดคำว่า "โรงเรียน" ออกก่อน ไม่งั้นทุกโรงเรียนจะได้ "รง" เหมือนกันหมด) */
export function schoolInitials() {
  const set = getSetting('school_initials');
  if (set) return set;
  const base = schoolName().replace(/^โรงเรียน\s*/, '');
  // ตัดสระบน/ล่าง วรรณยุกต์ และเครื่องหมายที่ไม่ใช่พยัญชนะออก เหลือแต่ตัวที่มองเห็นเป็นตัวอักษรจริง
  const consonants = base.replace(/[ะ-ฺ็-๎\s]/g, '');
  return consonants.slice(0, 2) || 'สบ';
}
