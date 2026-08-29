import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'esaraban.db');

export const db = new DatabaseSync(dbPath);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

export function uuid() {
  return randomUUID();
}

export function nowIso() {
  return new Date().toISOString();
}

// "วันนี้" ต้องคิดตามเวลาประเทศไทยเสมอ ไม่ใช่เวลาของเครื่องเซิร์ฟเวอร์ — เครื่องบน Render รันเป็น UTC
// ซึ่งช้ากว่าไทย 7 ชั่วโมง ดังนั้นช่วง 00:00-07:00 น. ตามเวลาไทย ทั้ง new Date() ของ JS และ date('now')
// ของ SQLite จะยังคืนค่าเป็น "เมื่อวาน" อยู่ ผลคือ:
//   - การมอบหมายรักษาการแทนที่เริ่ม "วันนี้" ยังไม่มีผลจนถึง 7 โมงเช้า
//   - การมอบหมายที่หมดอายุเมื่อวาน ยังมีผลต่อไปจนถึง 7 โมงเช้าของวันถัดไป (ผู้รักษาการยังเซ็นแทนได้)
//   - หนังสือที่เลยกำหนดเมื่อวาน ยังไม่ถูกนับว่าเกินกำหนด
// ทุกที่ที่ต้องใช้ "วันนี้" ให้เรียกฟังก์ชันนี้แล้วส่งค่าเข้า SQL เป็นพารามิเตอร์ ห้ามใช้ date('now') ตรงๆ
export function todayInBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // en-CA ให้รูปแบบ YYYY-MM-DD
}

// Buddhist Era year (matches the school's numbering convention, e.g. 2569)
// ปีพุทธศักราชของเลขทะเบียนหนังสือ — ต้องคิดจากวันที่ตามเวลาไทย ไม่ใช่เวลาเครื่องเซิร์ฟเวอร์ (UTC)
// ไม่งั้นหนังสือที่ลงทะเบียนช่วงเช้ามืดของวันที่ 1 มกราคม จะได้เลขของปีที่แล้ว แล้วไปชนกับเลขที่ออกไป
// เมื่อปีก่อนพอดี ซึ่งเป็นความผิดพลาดที่แก้ย้อนหลังยากมากในทะเบียนหนังสือ
export function beYear(date) {
  const iso = date ? new Date(date).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }) : todayInBangkok();
  return Number(iso.slice(0, 4)) + 543;
}

// ระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ หมวด 3: อายุการเก็บหนังสือ
export const RETENTION_YEARS = { normal_10y: 10, financial_5y: 5, routine_1y: 1, permanent: null };
export const RETENTION_LABEL = {
  normal_10y: 'ปกติ (อย่างน้อย 10 ปี)',
  financial_5y: 'การเงิน (5 ปี)',
  routine_1y: 'เรื่องธรรมดา (อย่างน้อย 1 ปี)',
  permanent: 'เก็บตลอดไป (ประวัติศาสตร์/หลักฐานสำคัญ)',
};

// นับอายุการเก็บจากปี พ.ศ. ที่ออกเลขหนังสือ ครบกำหนดวันที่ 31 ธันวาคมของปีสุดท้าย
export function computeRetentionUntil(yearBe, retentionClass) {
  const years = RETENTION_YEARS[retentionClass];
  if (years === null || years === undefined) return null; // permanent
  const untilYearAd = yearBe + years - 543;
  return `${untilYearAd}-12-31`;
}

// รหัสผ่านตั้งต้นชุดเดิมที่เคยพิมพ์โชว์ไว้บนหน้าเข้าสู่ระบบ — เก็บไว้เพื่อ "ตรวจจับ" ว่าฐานข้อมูลที่
// deploy ไปแล้วยังมีบัญชีไหนใช้รหัสเหล่านี้อยู่ แล้วบังคับให้เปลี่ยน ไม่ได้ใช้ตั้งรหัสให้บัญชีใหม่อีกแล้ว
const LEGACY_SEED_PASSWORDS = {
  admin: 'Admin@2569',
  director01: 'Director@2569',
  vicedir01: 'Vice@2569',
  head_acad: 'Head@2569',
  reg001: 'Reg@2569',
  teacher001: 'Teacher@2569',
};

// ตัดอักขระที่อ่านสับสน (0/O, 1/l/I) ออก เพราะรหัสชุดนี้ถูกอ่านจากหน้าจอ/กระดาษแล้วพิมพ์ตามด้วยมือ
const SEED_PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function randomPassword() {
  const bytes = randomBytes(12);
  return Array.from(bytes, (b) => SEED_PW_CHARS[b % SEED_PW_CHARS.length]).join('');
}
function randomPin() {
  // ปฏิเสธ PIN ที่เป็นเลขซ้ำทั้งหมด (111111) หรือเรียงติดกัน — เดาง่ายเกินไปสำหรับสิ่งที่ใช้แทนลายเซ็น
  for (;;) {
    const pin = Array.from(randomBytes(6), (b) => String(b % 10)).join('');
    if (!isWeakPin(pin)) return pin;
  }
}

/** PIN ที่อ่อนเกินกว่าจะใช้แทนการลงนาม — เลขซ้ำทั้งหมด หรือเรียงขึ้น/ลงติดกันทั้ง 6 ตัว */
export function isWeakPin(pin) {
  if (!/^\d{6}$/.test(pin || '')) return true;
  if (/^(\d)\1{5}$/.test(pin)) return true;
  const digits = [...pin].map(Number);
  const step = digits[1] - digits[0];
  if ((step === 1 || step === -1) && digits.every((d, i) => i === 0 || d - digits[i - 1] === step)) return true;
  return false;
}

export function hashSecret(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifySecret(plain, stored) {
  if (!stored) return false;
  // ค่าที่ไม่ใช่ข้อความต้องตอบว่า "ไม่ตรง" ไม่ใช่โยน error — scryptSync จะโยน ERR_INVALID_ARG_TYPE
  // ถ้าได้ undefined หรือตัวเลข ทำให้ endpoint ที่ตรวจ PIN ตอบ 500 พร้อมข้อความอังกฤษของ Node
  // แทนที่จะเป็น "PIN ไม่ถูกต้อง" — เกิดได้จริงเมื่อฝั่งเว็บไม่ได้ส่งช่อง pin มา หรือส่งมาเป็นตัวเลข
  if (typeof plain !== 'string') return false;
  const [salt, hash] = stored.split(':');
  const check = scryptSync(plain, salt, 64).toString('hex');
  if (check.length !== hash.length) return false;
  // constant-time-ish compare
  let diff = 0;
  for (let i = 0; i < hash.length; i++) diff |= hash.charCodeAt(i) ^ check.charCodeAt(i);
  return diff === 0;
}

function tableExists(name) {
  const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
  return !!row;
}

export function migrate() {
  db.exec(`
  CREATE TABLE IF NOT EXISTS departments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT UNIQUE NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT
  );

  CREATE TABLE IF NOT EXISTS roles (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_th TEXT NOT NULL,
    level INTEGER NOT NULL DEFAULT 0, -- higher = more authority, used for escalation chain
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    employee_code TEXT UNIQUE NOT NULL,
    prefix TEXT,
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    email TEXT UNIQUE,
    position TEXT,
    department_id TEXT REFERENCES departments(id),
    password_hash TEXT NOT NULL,
    pin_hash TEXT,
    status TEXT NOT NULL DEFAULT 'active', -- active | suspended
    failed_login_count INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT, -- login rate limiting (Security Bible §7): lock 15 min after 5 bad attempts
    signature_image TEXT, -- ลายเซ็นสแกนของผู้ใช้แต่ละคน (data URL, base64) — ของใครของมัน
    avatar_emoji TEXT, -- อวตารอิโมจิที่ผู้ใช้เลือกเอง (UX Bible Part 21 §8) — NULL แปลว่ายังไม่เลือก ใช้ตัวอักษรย่อชื่อแทน
    -- บัญชีที่ยังใช้รหัสผ่านที่ "คนอื่นตั้งให้" (บัญชีตั้งต้นของระบบ / บัญชีที่นำเข้าจาก Excel) ต้องเปลี่ยน
    -- รหัสผ่านและ PIN ด้วยตัวเองก่อนใช้งานอย่างอื่น — ตราบใดที่ยังไม่เปลี่ยน คนที่ส่งรหัสให้ก็ยังเข้าบัญชี
    -- นั้นได้ ซึ่งทำให้ลายเซ็น/การลงนาม "ทราบ" ที่ออกจากบัญชีนั้นพิสูจน์ตัวตนไม่ได้จริง
    must_change_password INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  -- many-to-many, resolved decision from spec review (Part 3 item 1)
  CREATE TABLE IF NOT EXISTS user_roles (
    user_id TEXT NOT NULL REFERENCES users(id),
    role_id TEXT NOT NULL REFERENCES roles(id),
    PRIMARY KEY (user_id, role_id)
  );

  -- "รักษาการแทน" — ระหว่าง start_date..end_date คำขอ/ขั้นตอน workflow ที่มอบหมายให้ delegator_id
  -- delegate_id ดำเนินการแทนได้ด้วย (ดู src/services/delegation.js, ใช้ใน workflow.js/dashboard.js)
  -- leave_request_id ผูกไว้เผื่อสร้างอัตโนมัติตอนอนุมัติคำขอลา (ระบุ null ได้ถ้าตั้งเองแบบ ad-hoc)
  CREATE TABLE IF NOT EXISTS user_delegations (
    id TEXT PRIMARY KEY,
    delegator_id TEXT NOT NULL REFERENCES users(id),
    delegate_id TEXT NOT NULL REFERENCES users(id),
    reason TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    leave_request_id TEXT REFERENCES leave_requests(id),
    created_by TEXT REFERENCES users(id),
    cancelled_at TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_delegations_delegator ON user_delegations(delegator_id, start_date, end_date);
  CREATE INDEX IF NOT EXISTS idx_delegations_delegate ON user_delegations(delegate_id, start_date, end_date);

  CREATE TABLE IF NOT EXISTS document_types (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
  );

  -- atomic running-number counters, scoped by year+department+type+direction
  -- ตัวนับเลขทะเบียนหนังสือ: ชุดเดียวทั้งโรงเรียนต่อปี แยกแค่หนังสือเข้า/ออก ตรงตามทะเบียนหนังสือรับ-ส่ง
  -- ที่โรงเรียนใช้จริง (ดูเหตุผลเต็มใน src/numbering.js) — ตาราง document_counters เดิมนับแยกตามฝ่าย
  -- และประเภทหนังสือ ทำให้หนังสือคนละฝ่ายได้เลขซ้ำกัน จึงเลิกใช้แล้ว แต่เก็บไว้เป็นร่องรอยของข้อมูลเดิม
  CREATE TABLE IF NOT EXISTS document_number_counters (
    year_be INTEGER NOT NULL,
    direction TEXT NOT NULL, -- incoming | outgoing
    running_number INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (year_be, direction)
  );

  CREATE TABLE IF NOT EXISTS document_counters (
    year_be INTEGER NOT NULL,
    department_id TEXT NOT NULL,
    doc_type_id TEXT NOT NULL,
    direction TEXT NOT NULL, -- incoming | outgoing
    running_number INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (year_be, department_id, doc_type_id, direction)
  );

  CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    direction TEXT NOT NULL, -- incoming | outgoing
    running_number INTEGER NOT NULL,
    year_be INTEGER NOT NULL,
    doc_number_display TEXT NOT NULL, -- e.g. 0001/2569
    external_doc_number TEXT, -- เลขหนังสือจากหน่วยงานต้นทาง/เลขที่เราจะส่ง
    external_doc_date TEXT, -- ลงวันที่ (วันที่ระบุในหนังสือต้นฉบับ ตามแบบทะเบียนหนังสือรับ-ส่ง)
    title TEXT NOT NULL,
    subject TEXT,
    doc_type_id TEXT NOT NULL REFERENCES document_types(id),
    department_id TEXT NOT NULL REFERENCES departments(id),
    priority TEXT NOT NULL DEFAULT 'normal', -- normal | urgent | very_urgent | most_urgent
    secret_level TEXT NOT NULL DEFAULT 'normal', -- normal | internal | secret | top_secret
    correspondent_name TEXT, -- หน่วยงาน/บุคคลภายนอก (ผู้ส่ง สำหรับ incoming, ผู้รับ สำหรับ outgoing)
    status TEXT NOT NULL DEFAULT 'draft', -- draft|registered|in_progress|returned|completed|archived|voided|destroyed
    due_date TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    void_reason TEXT,
    -- อายุการเก็บ ตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ หมวด 3
    retention_class TEXT NOT NULL DEFAULT 'normal_10y', -- normal_10y | permanent | routine_1y | financial_5y
    retention_until TEXT, -- วันครบกำหนดเก็บ (NULL = permanent เก็บตลอดไป)
    destroyed_at TEXT,
    destroyed_by TEXT REFERENCES users(id),
    -- ตำแหน่งตราประทับ "ลงรับ" ที่ธุรการลากวางเองบนตัวอย่าง PDF (% จากมุมบนซ้ายของหน้ากระดาษ
    -- 0-100 ทั้งคู่) — NULL แปลว่ายังไม่เคยตั้งตำแหน่ง ใช้ตำแหน่งมุมขวาบนเป็นค่าเริ่มต้นแทน
    stamp_x REAL,
    stamp_y REAL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

  -- บัญชีหนังสือขอทำลาย + การอนุมัติของคณะกรรมการทำลายหนังสือ
  CREATE TABLE IF NOT EXISTS destruction_batches (
    id TEXT PRIMARY KEY,
    committee_names TEXT NOT NULL, -- รายชื่อคณะกรรมการทำลายหนังสือ (ระเบียบกำหนดอย่างน้อย 3 คน)
    reason TEXT,
    status TEXT NOT NULL DEFAULT 'pending_approval', -- pending_approval | approved | rejected
    created_by TEXT NOT NULL REFERENCES users(id),
    decided_by TEXT REFERENCES users(id),
    decision_note TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );

  CREATE TABLE IF NOT EXISTS destruction_batch_items (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES destruction_batches(id),
    document_id TEXT NOT NULL REFERENCES documents(id)
  );

  -- ระบบลาและไปราชการ (Part 14 §61 leave_requests) — single-approver flow, reuses notifications/audit
  CREATE TABLE IF NOT EXISTS leave_requests (
    id TEXT PRIMARY KEY,
    requester_id TEXT NOT NULL REFERENCES users(id),
    leave_type TEXT NOT NULL, -- sick | personal | vacation | maternity | ordination | official_travel
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    days_count REAL NOT NULL,
    reason TEXT NOT NULL,
    destination TEXT, -- สถานที่ไปราชการ (เฉพาะ leave_type = official_travel)
    contact_info TEXT, -- ช่องทางติดต่อระหว่างลา
    status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | cancelled
    approver_id TEXT NOT NULL REFERENCES users(id),
    decision_note TEXT,
    decided_at TEXT,
    delegate_id TEXT REFERENCES users(id), -- ผู้รักษาการแทนระหว่างลา (ถ้าระบุ) — ดู src/services/delegation.js
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leave_requester ON leave_requests(requester_id);
  CREATE INDEX IF NOT EXISTS idx_leave_approver ON leave_requests(approver_id, status);

  -- บอร์ดประกาศ/ประชาสัมพันธ์ — โมดูลแยกต่างหากจากงานสารบรรณ (ไม่มี running number/workflow)
  -- ใช้แจ้งข่าวสารทั่วไปให้บุคลากรทั้งโรงเรียน แนบไฟล์ได้ 1 ไฟล์ต่อประกาศ
  -- ไฟล์หลักฐานแนบใบลา (ใบนัดแพทย์สำหรับลาป่วย, หลักฐานประกอบสำหรับลาประเภทอื่น)
  -- เก็บแบบเดียวกับไฟล์แนบหนังสือทุกอย่าง รวมถึงขึ้น Google Drive เมื่อเปิดใช้ เพื่อให้ไม่หายตอนโฮสต์ล้างดิสก์
  CREATE TABLE IF NOT EXISTS leave_attachments (
    id TEXT PRIMARY KEY,
    leave_request_id TEXT NOT NULL REFERENCES leave_requests(id),
    filename TEXT NOT NULL,
    storage_provider TEXT NOT NULL DEFAULT 'local', -- local | google_drive
    filepath TEXT,
    drive_file_id TEXT,
    filesize INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    hash_sha256 TEXT,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leave_attachments_req ON leave_attachments(leave_request_id);

  -- ลายเซ็นรับรองของทุกขั้นตอนบนใบลา — เก็บ "ภาพลายเซ็น ณ ขณะที่ลงนาม" ไม่ใช่ชี้ไปที่โปรไฟล์ผู้ใช้
  --
  -- สำคัญมาก: ถ้าชี้ไปที่ users.signature_image วันไหนเจ้าตัวเปลี่ยนหรือลบลายเซ็นในโปรไฟล์
  -- ลายเซ็นบนใบลาที่ลงนามไปแล้วทั้งหมดจะเปลี่ยน/หายตามไปด้วยย้อนหลัง ซึ่งทำให้ใช้เป็นหลักฐานไม่ได้เลย
  -- ชื่อและตำแหน่งก็เก็บสำเนาไว้ด้วยเหตุผลเดียวกัน (คนย้ายฝ่าย/เปลี่ยนตำแหน่งได้)
  CREATE TABLE IF NOT EXISTS leave_signatures (
    id TEXT PRIMARY KEY,
    leave_request_id TEXT NOT NULL REFERENCES leave_requests(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    step TEXT NOT NULL,          -- requested | approved | rejected | cancelled
    signer_name TEXT NOT NULL,   -- สำเนาชื่อ ณ ขณะลงนาม
    signer_position TEXT,        -- สำเนาตำแหน่ง ณ ขณะลงนาม
    signature_image TEXT,        -- สำเนาภาพลายเซ็น ณ ขณะลงนาม (NULL ถ้าตอนนั้นยังไม่ได้บันทึกลายเซ็นไว้)
    note TEXT,
    signed_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_leave_signatures_req ON leave_signatures(leave_request_id);

  CREATE TABLE IF NOT EXISTS announcements (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL DEFAULT 'ประกาศ', -- ประกาศ | ประชาสัมพันธ์
    title TEXT NOT NULL,
    body TEXT,
    file_storage_provider TEXT, -- local | google_drive | NULL (ไม่มีไฟล์แนบ)
    file_path TEXT,
    file_drive_id TEXT,
    file_name TEXT,
    file_size INTEGER,
    file_mime TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_announcements_category ON announcements(category);

  CREATE TABLE IF NOT EXISTS document_access_grants (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    user_id TEXT REFERENCES users(id),
    department_id TEXT REFERENCES departments(id),
    granted_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    filename TEXT NOT NULL,
    storage_provider TEXT NOT NULL DEFAULT 'local', -- local | google_drive
    filepath TEXT, -- local safe filename (storage_provider = 'local')
    drive_file_id TEXT, -- Google Drive file id (storage_provider = 'google_drive')
    filesize INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    hash_sha256 TEXT NOT NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    -- สำเนาที่ประทับตรา "ลงรับ" ฝังลงในเนื้อไฟล์ PDF จริงแล้ว (ต่างจาก stamp_x/stamp_y ของ documents
    -- ที่เป็นแค่ตำแหน่งซ้อนแสดงในเว็บ) — ไฟล์ต้นฉบับใน filepath/drive_file_id ข้างบนยังคงเดิมไม่แตะต้อง
    stamped_storage_provider TEXT, -- local | google_drive | NULL (ยังไม่เคยประทับตรา)
    stamped_filepath TEXT,
    stamped_drive_file_id TEXT,
    stamped_at TEXT
  );

  -- sequential workflow steps for a document
  CREATE TABLE IF NOT EXISTS workflow_steps (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    step_order INTEGER NOT NULL,
    assignee_id TEXT NOT NULL REFERENCES users(id),
    instruction TEXT, -- ข้อความเกษียณ/สั่งการ
    status TEXT NOT NULL DEFAULT 'waiting', -- waiting|acknowledged|approved|rejected|returned
    decided_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    document_id TEXT NOT NULL REFERENCES documents(id),
    user_id TEXT NOT NULL REFERENCES users(id),
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    document_id TEXT REFERENCES documents(id),
    link_url TEXT, -- ปลายทางของปุ่ม "เปิด" สำหรับเรื่องที่ไม่ใช่เอกสาร (ใบลา, การมอบหมายรักษาการแทน)
    title TEXT NOT NULL,
    message TEXT NOT NULL,
    priority TEXT NOT NULL DEFAULT 'info', -- info|success|warning|urgent|critical
    is_read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  -- append-only, no deleted_at, no updates -- ever
  CREATE TABLE IF NOT EXISTS audit_logs (
    id TEXT PRIMARY KEY,
    user_id TEXT REFERENCES users(id),
    action TEXT NOT NULL,
    table_name TEXT,
    record_id TEXT,
    detail TEXT,
    ip TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- สรุปงานรายวันที่ธุรการอัปโหลดมาเป็นไฟล์ Excel แล้วระบบแตกออกมาเก็บเป็นรายการ เพื่อให้แก้ไขต่อในระบบได้
  -- และรวมดูข้ามวันได้ — แยกเก็บทีละวัน (summary_date) เพื่อให้ย้อนหาเอกสารของวันนั้นๆ ได้ง่าย
  CREATE TABLE IF NOT EXISTS daily_summaries (
    id TEXT PRIMARY KEY,
    summary_date TEXT NOT NULL,
    source_filename TEXT,
    note TEXT,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS daily_summary_items (
    id TEXT PRIMARY KEY,
    summary_id TEXT NOT NULL REFERENCES daily_summaries(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    priority TEXT,
    task_name TEXT,
    action_needed TEXT,
    schedule TEXT,
    detail TEXT,
    source_ref TEXT,
    is_done INTEGER NOT NULL DEFAULT 0
  );

  -- ชีตที่ 2 ของไฟล์ต้นฉบับ (ดัชนี -> ชื่อไฟล์เอกสารอ้างอิง) เก็บไว้ให้ธุรการตามกลับไปหาไฟล์จริงได้
  CREATE TABLE IF NOT EXISTS daily_summary_sources (
    id TEXT PRIMARY KEY,
    summary_id TEXT NOT NULL REFERENCES daily_summaries(id) ON DELETE CASCADE,
    ref_index TEXT,
    ref_text TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(summary_date);
  CREATE INDEX IF NOT EXISTS idx_daily_summary_items_summary ON daily_summary_items(summary_id, sort_order);
  CREATE INDEX IF NOT EXISTS idx_daily_summary_sources_summary ON daily_summary_sources(summary_id);

  CREATE INDEX IF NOT EXISTS idx_documents_status ON documents(status);
  CREATE INDEX IF NOT EXISTS idx_documents_dept ON documents(department_id);
  CREATE INDEX IF NOT EXISTS idx_documents_title ON documents(title);
  CREATE INDEX IF NOT EXISTS idx_workflow_doc ON workflow_steps(document_id);
  CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
  CREATE INDEX IF NOT EXISTS idx_audit_record ON audit_logs(table_name, record_id);
  CREATE INDEX IF NOT EXISTS idx_documents_retention ON documents(retention_until);
  CREATE INDEX IF NOT EXISTS idx_destruction_items_batch ON destruction_batch_items(batch_id);
  `);

  // ฐานข้อมูลที่ deploy ไปแล้วก่อนหน้านี้ยังไม่มีคอลัมน์นี้ — SQLite ไม่มี "ADD COLUMN IF NOT EXISTS"
  // จึงต้องเช็ค pragma ก่อนแล้วค่อย ALTER (CREATE TABLE ด้านบนใช้กับฐานข้อมูลใหม่ที่ยังไม่มีตารางเท่านั้น)
  const userCols = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
  if (!userCols.includes('avatar_emoji')) {
    db.exec('ALTER TABLE users ADD COLUMN avatar_emoji TEXT');
  }
  // ฐานข้อมูลที่ deploy ไปแล้วมีบัญชีตั้งต้นที่รหัสผ่านเคยถูกพิมพ์ไว้บนหน้าเข้าสู่ระบบให้ทุกคนเห็น
  // (Admin@2569, Director@2569, ...) ใครที่เปิดเว็บเจอก็ล็อกอินเป็นผู้อำนวยการได้ทันที — ตั้งธงบังคับ
  // เปลี่ยนรหัสเฉพาะบัญชีที่ "ยังใช้รหัสเดิมอยู่จริง" เท่านั้น คนที่เปลี่ยนไปแล้วไม่ต้องมาเจอหน้านี้ซ้ำ
  if (!userCols.includes('must_change_password')) {
    db.exec('ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL DEFAULT 0');
    const stmt = db.prepare('UPDATE users SET must_change_password = 1 WHERE id = ?');
    let flagged = 0;
    for (const u of db.prepare('SELECT id, employee_code, password_hash FROM users').all()) {
      const known = LEGACY_SEED_PASSWORDS[u.employee_code];
      if (known && verifySecret(known, u.password_hash)) { stmt.run(u.id); flagged++; }
    }
    if (flagged) {
      console.warn(`[security] พบ ${flagged} บัญชีที่ยังใช้รหัสผ่านตั้งต้นซึ่งเคยเปิดเผยไว้บนหน้าเข้าสู่ระบบ — บังคับให้เปลี่ยนรหัสผ่านและ PIN ก่อนใช้งานครั้งถัดไป`);
    }
  }

  // เวลาที่ "ดำเนินการเสร็จสิ้น" จริงๆ — แยกจาก updated_at ซึ่งขยับทุกครั้งที่แตะเอกสารทีหลัง
  // (จัดเก็บเข้าแฟ้ม / เลื่อนตำแหน่งตราประทับ / ทำลายเมื่อครบอายุอีกสิบปีข้างหน้า) เดิมแดชบอร์ดและ
  // หน้ารายงานคิด "ระยะเวลาเฉลี่ยจนเสร็จสิ้น" จาก updated_at ตัวเลขจึงพองตามการแตะเหล่านั้น
  //
  // ของเก่าย้อนหลังได้จากเวลาที่ขั้นตอนสุดท้ายถูกตัดสิน ซึ่งคือเวลาที่เรื่องปิดจริง — ถ้าไม่มีขั้นตอนเลย
  // (เอกสารที่ถูกปิดด้วยวิธีอื่น) ค่อยถอยไปใช้ updated_at ตามเดิม
  const documentColsForCompleted = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
  if (!documentColsForCompleted.includes('completed_at')) {
    db.exec('ALTER TABLE documents ADD COLUMN completed_at TEXT');
    const filled = db.prepare(`
      UPDATE documents SET completed_at = COALESCE(
        (SELECT MAX(ws.decided_at) FROM workflow_steps ws WHERE ws.document_id = documents.id AND ws.decided_at IS NOT NULL),
        updated_at)
      WHERE status IN ('completed', 'archived', 'destroyed')
    `).run().changes;
    if (filled) console.warn(`[data] เติมเวลาดำเนินการเสร็จสิ้นย้อนหลังให้หนังสือ ${filled} ฉบับ`);
  }

  const documentCols = db.prepare("PRAGMA table_info(documents)").all().map((c) => c.name);
  if (!documentCols.includes('stamp_x')) {
    db.exec('ALTER TABLE documents ADD COLUMN stamp_x REAL');
    db.exec('ALTER TABLE documents ADD COLUMN stamp_y REAL');
  }
  const attachmentCols = db.prepare("PRAGMA table_info(attachments)").all().map((c) => c.name);
  if (!attachmentCols.includes('stamped_storage_provider')) {
    db.exec('ALTER TABLE attachments ADD COLUMN stamped_storage_provider TEXT');
    db.exec('ALTER TABLE attachments ADD COLUMN stamped_filepath TEXT');
    db.exec('ALTER TABLE attachments ADD COLUMN stamped_drive_file_id TEXT');
    db.exec('ALTER TABLE attachments ADD COLUMN stamped_at TEXT');
  }
  // ขั้นตอน workflow ของหนังสือมีปัญหาเดียวกับใบลา — เดิมไทม์ไลน์ join เอาลายเซ็นจาก users มาแสดงสดๆ
  // พอเจ้าตัวเปลี่ยน/ลบลายเซ็นในโปรไฟล์ ลายเซ็นบนหนังสือที่ลงนามไปแล้วทุกฉบับก็เปลี่ยน/หายย้อนหลังตามไปด้วย
  // (ยืนยันแล้วว่าเกิดขึ้นจริง) จึงเก็บสำเนา ณ ขณะลงนามไว้ในตัวขั้นตอนเอง
  const stepCols = db.prepare("PRAGMA table_info(workflow_steps)").all().map((c) => c.name);
  if (!stepCols.includes('signature_image')) {
    db.exec('ALTER TABLE workflow_steps ADD COLUMN signature_image TEXT');
    db.exec('ALTER TABLE workflow_steps ADD COLUMN signer_name TEXT');
    db.exec('ALTER TABLE workflow_steps ADD COLUMN signer_position TEXT');
    // เติมย้อนหลังให้ขั้นตอนที่ลงนามไปแล้วก่อนมีคอลัมน์นี้ — ใช้ค่าปัจจุบันของเจ้าตัวเป็นตัวตั้งต้น
    // ดีกว่าปล่อยว่างเปล่า และหลังจากนี้จะถูกตรึงไว้ไม่เปลี่ยนตามโปรไฟล์อีก
    db.exec(`
      UPDATE workflow_steps SET
        signature_image = (SELECT u.signature_image FROM users u WHERE u.id = workflow_steps.assignee_id),
        signer_name = (SELECT COALESCE(u.prefix,'') || u.first_name || ' ' || u.last_name FROM users u WHERE u.id = workflow_steps.assignee_id),
        signer_position = (SELECT u.position FROM users u WHERE u.id = workflow_steps.assignee_id)
      WHERE decided_at IS NOT NULL
    `);
  }

  const delegationCols = db.prepare("PRAGMA table_info(user_delegations)").all().map((c) => c.name);
  if (!delegationCols.includes('leave_request_id')) {
    db.exec('ALTER TABLE user_delegations ADD COLUMN leave_request_id TEXT');
    db.exec('ALTER TABLE user_delegations ADD COLUMN created_by TEXT');
    db.exec('ALTER TABLE user_delegations ADD COLUMN cancelled_at TEXT');
  }
  // การมอบหมายรักษาการแทนที่วันที่ไม่ใช่รูปแบบ YYYY-MM-DD จะ "มีผลตลอดไป" เพราะการตรวจว่ายังมีผลอยู่ไหม
  // ทำด้วยการเทียบสตริงวันที่ใน SQL และอักษรไทย/อังกฤษมีค่ามากกว่าตัวเลขทุกตัว (ทดสอบยืนยันแล้วว่า
  // อีก 100 ปีข้างหน้าก็ยังถูกนับว่ามีผล) = ผู้รักษาการแทนถืออำนาจลงนามแทนผู้อำนวยการแบบถาวร
  // ตอนนี้ค่าแบบนั้นถูกปฏิเสธตั้งแต่ต้นทางแล้ว แถวเก่าที่ค้างอยู่จึงยกเลิกทิ้งให้ ไม่ปล่อยไว้เฉยๆ
  const brokenDelegations = db.prepare(`
    UPDATE user_delegations SET cancelled_at = ?
    WHERE cancelled_at IS NULL
      AND (start_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        OR end_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
  `).run(nowIso()).changes;
  if (brokenDelegations) {
    console.warn(`[security] ยกเลิกการมอบหมายรักษาการแทน ${brokenDelegations} รายการที่วันที่ไม่ถูกต้อง (รายการเหล่านี้จะมีผลตลอดไปถ้าปล่อยไว้)`);
  }

  // วันที่ของหนังสือที่ไม่ใช่วันที่จริง — มาจากช่วงที่ยังไม่มีการตรวจค่าที่กรอกเข้ามา (พบของจริง:
  // external_doc_date = 'ไม่ใช่วันที่' และ '2026-13-45' คือเดือน 13 วันที่ 45) ตอนนี้ต้นทางปฏิเสธแล้ว
  // แต่แถวเก่ายังไปโผล่บนทะเบียนหนังสือและในไฟล์ Excel ที่ส่งให้ สพฐ. เป็นวันที่ที่อ่านไม่ได้
  //
  // ล้างเป็น NULL แทนการเดาค่าที่ถูก — ระบบไม่มีทางรู้ว่าเจ้าตัวตั้งใจกรอกวันไหน การเดาแล้วเดาผิด
  // บนเอกสารราชการแย่กว่าการเว้นว่างไว้ให้เห็นชัดว่าไม่มีข้อมูล
  for (const col of ['external_doc_date', 'due_date']) {
    const cleaned = db.prepare(`
      UPDATE documents SET ${col} = NULL
      WHERE ${col} IS NOT NULL
        AND (${col} NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
          OR CAST(substr(${col}, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
          OR CAST(substr(${col}, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31)
    `).run().changes;
    if (cleaned) console.warn(`[data] ล้างค่า ${col} ที่ไม่ใช่วันที่จริงออกจากหนังสือ ${cleaned} ฉบับ`);
  }

  // ประกาศที่ยาวเกินเพดาน — มาจากช่วงที่ยังไม่มีการจำกัดความยาว พบของจริงสองแถว: เนื้อหา 500,000
  // ตัวอักษร และหัวข้อ 50,000 ตัวอักษร ทั้งคู่ทำให้หน้าประกาศหนัก 1.6MB ต่อการเปิดหนึ่งครั้งสำหรับ
  // ครูทุกคน ทั้งที่หน้านั้นมีประกาศจริงอยู่แค่ 7 รายการ (วัดจริงแล้ว)
  //
  // ตัดให้พอดีเพดานแทนการลบทั้งประกาศ — ข้อความส่วนต้นคือเนื้อหาจริงที่คนเขียนตั้งใจสื่อ
  if (tableExists('announcements')) {
    const trimmed = db.prepare(`
      UPDATE announcements SET title = substr(title, 1, 300), body = substr(body, 1, 20000), updated_at = ?
      WHERE length(title) > 300 OR length(body) > 20000
    `).run(nowIso()).changes;
    if (trimmed) console.warn(`[data] ตัดความยาวประกาศ ${trimmed} รายการที่ยาวเกินเพดาน (ทำให้หน้าประกาศหนักผิดปกติ)`);
  }

  // สรุปงานรายวันที่ "วันที่" เป็นไปไม่ได้ — หน้ารายการเรียงตาม summary_date แบบข้อความ ค่าอย่าง
  // 9999-99-99 หรือปี พ.ศ. (2569-10-01) จึงลอยอยู่บนสุดของรายการถาวร บังสรุปงานของวันนี้จริงๆ
  //
  // ย้ายไปใช้ "วันที่อัปโหลด" แทนการลบทิ้ง — รายการงานข้างในเป็นงานจริงที่ธุรการพิมพ์ไว้ สิ่งที่ผิดคือ
  // ตัวเลขวันที่เท่านั้น และวันที่อัปโหลดเป็นค่าที่จริงและใกล้เคียงที่สุดที่ระบบรู้
  if (tableExists('daily_summaries')) {
    const fixedSummaries = db.prepare(`
      UPDATE daily_summaries SET summary_date = substr(created_at, 1, 10), updated_at = ?
      WHERE summary_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        OR CAST(substr(summary_date, 6, 2) AS INTEGER) NOT BETWEEN 1 AND 12
        OR CAST(substr(summary_date, 9, 2) AS INTEGER) NOT BETWEEN 1 AND 31
        OR CAST(substr(summary_date, 1, 4) AS INTEGER) NOT BETWEEN 1900 AND 2400
    `).run(nowIso()).changes;
    if (fixedSummaries) {
      console.warn(`[data] แก้วันที่ของสรุปงานรายวัน ${fixedSummaries} รายการที่เป็นวันที่เป็นไปไม่ได้ ให้ใช้วันที่อัปโหลดแทน`);
    }
  }

  // ใบลาที่ช่วงวันที่เป็นไปไม่ได้ ค้างอยู่ในสถานะ "รออนุญาต" ตลอดไป — เกิดจากช่วงที่ยังไม่มีการตรวจวันที่
  // (พบของจริง 2 ใบ: ใบหนึ่งกรอกปี พ.ศ. ลงในช่องปี ค.ศ. อีกใบยาว 36,526 วันเพราะพิมพ์ปีผิด)
  // ตอนนี้ต้นทางปฏิเสธค่าแบบนี้แล้ว แต่ถ้าปล่อยแถวเก่าไว้ นอกจากค้างในกล่องรออนุญาตไม่มีวันหมดแล้ว
  // ยังไปชนกับการตรวจ "ลาทับช่วงเดิม" ทำให้เจ้าตัวยื่นใบลาใหม่ในช่วงนั้นไม่ได้อีกเลย
  const brokenLeaves = db.prepare(`
    UPDATE leave_requests SET status = 'cancelled', updated_at = ?
    WHERE status = 'pending'
      AND (start_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        OR end_date NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
        -- ปี 2100 ขึ้นไปคือพิมพ์ปีผิดแน่นอน (ปี พ.ศ. ที่หลุดมาลงช่อง ค.ศ. จะได้ 25xx/26xx)
        OR start_date >= '2100-01-01' OR end_date >= '2100-01-01'
        OR days_count > 366 OR end_date < start_date)
  `).run(nowIso()).changes;
  if (brokenLeaves) {
    console.warn(`[data] ยกเลิกใบลา ${brokenLeaves} ใบที่ช่วงวันที่เป็นไปไม่ได้ (ค้างอยู่ในกล่องรออนุญาตตลอดไปถ้าปล่อยไว้)`);
  }

  const leaveCols = db.prepare("PRAGMA table_info(leave_requests)").all().map((c) => c.name);
  if (!leaveCols.includes('delegate_id')) {
    db.exec('ALTER TABLE leave_requests ADD COLUMN delegate_id TEXT');
  }
  // เดิมการแจ้งเตือนลิงก์ได้เฉพาะเอกสาร (document_id) เท่านั้น เรื่องลา/ไปราชการและการมอบหมาย
  // รักษาการแทนจึงเป็นข้อความเปล่าๆ ที่กดต่อไม่ได้ ต้องไปหาเองในเมนู — เก็บ path ปลายทางไว้ตรงๆ
  // เพื่อให้ทุกการแจ้งเตือนมีปุ่ม "เปิด" ได้เหมือนกันหมด
  const notificationCols = db.prepare("PRAGMA table_info(notifications)").all().map((c) => c.name);
  if (!notificationCols.includes('link_url')) {
    db.exec('ALTER TABLE notifications ADD COLUMN link_url TEXT');
  }

  // ย้ายจากตัวนับเลขทะเบียนแบบแยกรายฝ่าย มาเป็นชุดเดียวทั้งโรงเรียนต่อปี (ดู src/numbering.js)
  // ต้องตั้งค่าเริ่มต้นจาก "เลขสูงสุดที่เคยออกไปแล้วจริง" ในแต่ละปี/ทิศทาง ไม่ใช่เริ่มนับ 1 ใหม่ ไม่งั้น
  // ฐานข้อมูลที่ใช้งานอยู่แล้วจะออกเลขทับหนังสือที่ลงทะเบียนไปแล้ว — นับรวมเอกสารที่ถูกลบ (deleted_at)
  // ด้วย เพราะเลขที่ออกไปแล้วต้องไม่ถูกนำกลับมาใช้ซ้ำตามหลักงานสารบรรณ
  const hasNewCounter = db.prepare("SELECT COUNT(*) c FROM document_number_counters").get().c;
  if (!hasNewCounter) {
    const seeds = db.prepare(`
      SELECT year_be, direction, MAX(running_number) AS m FROM documents GROUP BY year_be, direction
    `).all();
    const ins = db.prepare('INSERT INTO document_number_counters (year_be, direction, running_number) VALUES (?, ?, ?)');
    for (const s of seeds) ins.run(s.year_be, s.direction, s.m);
  }
}

export function audit({ userId, action, tableName, recordId, detail, ip }) {
  db.prepare(
    `INSERT INTO audit_logs (id, user_id, action, table_name, record_id, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(uuid(), userId || null, action, tableName || null, recordId || null, detail ? JSON.stringify(detail) : null, ip || null, nowIso());
}

function seedIfEmpty() {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count > 0) return;

  const depts = [
    { code: 'ADMIN', name: 'งานบริหารทั่วไป' },
    { code: 'ACAD', name: 'งานวิชาการ' },
    { code: 'BUDGET', name: 'งานงบประมาณ' },
    { code: 'HR', name: 'งานบุคคล' },
    { code: 'REG', name: 'ธุรการ' },
  ];
  const deptIds = {};
  const insDept = db.prepare('INSERT INTO departments (id, name, code, created_at) VALUES (?, ?, ?, ?)');
  for (const d of depts) {
    const id = uuid();
    deptIds[d.code] = id;
    insDept.run(id, d.name, d.code, nowIso());
  }

  const roles = [
    { code: 'admin', name_th: 'ผู้ดูแลระบบ', level: 100 },
    { code: 'director', name_th: 'ผู้อำนวยการ', level: 90 },
    { code: 'vice_director', name_th: 'รองผู้อำนวยการ', level: 80 },
    { code: 'head', name_th: 'หัวหน้าฝ่าย', level: 60 },
    { code: 'registrar', name_th: 'ธุรการ', level: 40 },
    { code: 'teacher', name_th: 'ครู', level: 20 },
  ];
  const roleIds = {};
  const insRole = db.prepare('INSERT INTO roles (id, name, name_th, level, created_at) VALUES (?, ?, ?, ?, ?)');
  for (const r of roles) {
    const id = uuid();
    roleIds[r.code] = id;
    insRole.run(id, r.code, r.name_th, r.level, nowIso());
  }

  // ประเภทหนังสือราชการ 6 ชนิด ตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ
  const types = [
    'หนังสือภายนอก',
    'หนังสือภายใน',
    'หนังสือประทับตรา',
    'หนังสือสั่งการ',
    'หนังสือประชาสัมพันธ์',
    'หนังสือที่เจ้าหน้าที่จัดทำขึ้นหรือรับไว้เป็นหลักฐาน',
  ];
  const typeIds = {};
  const insType = db.prepare('INSERT INTO document_types (id, name) VALUES (?, ?)');
  for (const t of types) {
    const id = uuid();
    typeIds[t] = id;
    insType.run(id, t);
  }

  const insUser = db.prepare(`
    INSERT INTO users (id, employee_code, prefix, first_name, last_name, email, position, department_id, password_hash, pin_hash, status, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
  `);
  const insUserRole = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');

  const seedUsers = [
    { code: 'admin', prefix: 'นาย', first: 'ระบบ', last: 'ผู้ดูแล', email: 'admin@school.local', pos: 'ผู้ดูแลระบบ', dept: 'ADMIN', role: 'admin' },
    { code: 'director01', prefix: 'นาย', first: 'สมชาย', last: 'ผู้นำโรงเรียน', email: 'director@school.local', pos: 'ผู้อำนวยการ', dept: 'ADMIN', role: 'director' },
    { code: 'vicedir01', prefix: 'นาง', first: 'สมหญิง', last: 'รองผู้อำนวยการ', email: 'vicedir@school.local', pos: 'รองผู้อำนวยการ', dept: 'ACAD', role: 'vice_director' },
    { code: 'head_acad', prefix: 'นาง', first: 'วิชาการ', last: 'หัวหน้าฝ่าย', email: 'head.acad@school.local', pos: 'หัวหน้าฝ่ายวิชาการ', dept: 'ACAD', role: 'head' },
    { code: 'reg001', prefix: 'นางสาว', first: 'ธุรการ', last: 'ใจดี', email: 'registrar@school.local', pos: 'เจ้าหน้าที่ธุรการ', dept: 'REG', role: 'registrar' },
    { code: 'teacher001', prefix: 'นาย', first: 'ครูใหญ่', last: 'สอนดี', email: 'teacher@school.local', pos: 'ครู', dept: 'ACAD', role: 'teacher' },
  ];

  const userIds = {};
  const passwords = {};
  for (const u of seedUsers) {
    const id = uuid();
    userIds[u.code] = id;
    // สุ่มรหัสผ่าน/PIN ใหม่ทุกครั้งที่สร้างฐานข้อมูล แล้วพิมพ์ออก log ของเซิร์ฟเวอร์ครั้งเดียว —
    // เดิมเป็นรหัสตายตัวที่พิมพ์โชว์อยู่บนหน้าเข้าสู่ระบบด้วย ใครเปิดเว็บเจอก็เข้าเป็นผู้อำนวยการได้ทันที
    const pass = randomPassword();
    const pin = randomPin();
    passwords[u.code] = { password: pass, pin };
    insUser.run(id, u.code, u.prefix, u.first, u.last, u.email, u.pos, deptIds[u.dept], hashSecret(pass), hashSecret(pin), nowIso(), nowIso());
    insUserRole.run(id, roleIds[u.role]);
  }

  console.warn([
    '',
    '='.repeat(78),
    '  สร้างฐานข้อมูลใหม่พร้อมบัญชีตั้งต้นแล้ว — รหัสผ่านชุดนี้แสดงเพียงครั้งเดียวเท่านั้น',
    '  ทุกบัญชีจะถูกบังคับให้ตั้งรหัสผ่านและ PIN ใหม่ด้วยตัวเองตอนเข้าใช้งานครั้งแรก',
    '='.repeat(78),
    ...seedUsers.map((u) => `  ${u.code.padEnd(12)} รหัสผ่าน ${passwords[u.code].password}   PIN ${passwords[u.code].pin}   (${u.pos})`),
    '='.repeat(78),
    '',
  ].join('\n'));

  db._seed = { deptIds, roleIds, typeIds, userIds, passwords };
}

/**
 * ทางกู้คืนบัญชีผู้ดูแลระบบ เมื่อเข้าไม่ได้แล้วจริงๆ
 *
 * ระบบนี้ไม่มีการรีเซ็ตรหัสผ่านทางอีเมล (โรงเรียนไม่มีเซิร์ฟเวอร์อีเมล และการต่อบริการส่งอีเมลภายนอก
 * เกินความจำเป็น) ถ้าผู้ดูแลลืมรหัสผ่านหรือบัญชีถูกล็อกจากการกรอกผิด จะไม่เหลือทางเข้าระบบเลย
 * แม้แต่ทางเดียว — ต้องรื้อฐานข้อมูลทิ้งอย่างเดียว ซึ่งแปลว่าทะเบียนหนังสือทั้งเล่มหายไปด้วย
 *
 * ทางออกคือใช้สิ่งที่เจ้าของระบบควบคุมได้อยู่แล้วแน่ๆ นั่นคือ environment variable บนเซิร์ฟเวอร์:
 * ตั้ง ADMIN_RESET_PASSWORD แล้ว restart หนึ่งครั้ง ระบบจะตั้งรหัสนั้นให้บัญชีผู้ดูแล ปลดล็อก
 * และบังคับให้ตั้งรหัสของตัวเองใหม่ทันทีที่เข้ามา (รหัสจาก env จึงเป็นรหัสชั่วคราวเสมอ ไม่ใช่รหัสถาวร)
 *
 * ADMIN_RESET_CODE เลือกได้ว่าจะรีเซ็ตบัญชีไหน (ค่าเริ่มต้นคือ 'admin')
 */
function applyEmergencyAdminReset() {
  const newPassword = (process.env.ADMIN_RESET_PASSWORD || '').trim();
  if (!newPassword) return;
  const code = (process.env.ADMIN_RESET_CODE || 'admin').trim();
  if (newPassword.length < 8) {
    console.warn('[recovery] ข้าม ADMIN_RESET_PASSWORD เพราะสั้นกว่า 8 ตัวอักษร');
    return;
  }
  const user = db.prepare('SELECT id, employee_code FROM users WHERE employee_code = ? AND deleted_at IS NULL').get(code);
  if (!user) {
    console.warn(`[recovery] ไม่พบบัญชี "${code}" — ตรวจ ADMIN_RESET_CODE อีกครั้ง`);
    return;
  }
  db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 1,
      failed_login_count = 0, locked_until = NULL, status = 'active', updated_at = ? WHERE id = ?
  `).run(hashSecret(newPassword), nowIso(), user.id);
  // เตะทุกเซสชันของบัญชีนั้นออก เผื่อคนที่ทำให้ต้องกู้คืนยังเปิดค้างอยู่
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  audit({ userId: user.id, action: 'admin_password_recovered', tableName: 'users', recordId: user.id, detail: { via: 'ADMIN_RESET_PASSWORD' } });
  console.warn([
    '',
    '='.repeat(78),
    `  [recovery] ตั้งรหัสผ่านชั่วคราวให้บัญชี "${user.employee_code}" จาก ADMIN_RESET_PASSWORD แล้ว`,
    '  เข้าสู่ระบบด้วยรหัสนี้ แล้วระบบจะให้ตั้งรหัสผ่านและ PIN ของตัวเองทันที',
    '  ⚠️  เสร็จแล้วให้ "ลบ" ตัวแปร ADMIN_RESET_PASSWORD ออกจากเซิร์ฟเวอร์ทันที',
    '     ไม่งั้นรหัสนี้จะถูกตั้งกลับทุกครั้งที่ระบบ restart และค้างอยู่ในหน้าตั้งค่า',
    '='.repeat(78),
    '',
  ].join('\n'));
}

migrate();
seedIfEmpty();
applyEmergencyAdminReset();

export function getUserByCode(code) {
  return db.prepare(`SELECT * FROM users WHERE employee_code = ? AND deleted_at IS NULL`).get(code);
}

export function getUserRoles(userId) {
  return db.prepare(`
    SELECT r.* FROM roles r
    JOIN user_roles ur ON ur.role_id = r.id
    WHERE ur.user_id = ?
  `).all(userId);
}
