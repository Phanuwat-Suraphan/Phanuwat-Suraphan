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

// Buddhist Era year (matches the school's numbering convention, e.g. 2569)
export function beYear(date = new Date()) {
  return date.getFullYear() + 543;
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

export function hashSecret(plain) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(plain, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifySecret(plain, stored) {
  if (!stored) return false;
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
  const delegationCols = db.prepare("PRAGMA table_info(user_delegations)").all().map((c) => c.name);
  if (!delegationCols.includes('leave_request_id')) {
    db.exec('ALTER TABLE user_delegations ADD COLUMN leave_request_id TEXT');
    db.exec('ALTER TABLE user_delegations ADD COLUMN created_by TEXT');
    db.exec('ALTER TABLE user_delegations ADD COLUMN cancelled_at TEXT');
  }
  const leaveCols = db.prepare("PRAGMA table_info(leave_requests)").all().map((c) => c.name);
  if (!leaveCols.includes('delegate_id')) {
    db.exec('ALTER TABLE leave_requests ADD COLUMN delegate_id TEXT');
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
    INSERT INTO users (id, employee_code, prefix, first_name, last_name, email, position, department_id, password_hash, pin_hash, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
  `);
  const insUserRole = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');

  const demoUsers = [
    { code: 'admin', prefix: 'นาย', first: 'ระบบ', last: 'ผู้ดูแล', email: 'admin@school.local', pos: 'ผู้ดูแลระบบ', dept: 'ADMIN', role: 'admin', pass: 'Admin@2569', pin: '111111' },
    { code: 'director01', prefix: 'นาย', first: 'สมชาย', last: 'ผู้นำโรงเรียน', email: 'director@school.local', pos: 'ผู้อำนวยการ', dept: 'ADMIN', role: 'director', pass: 'Director@2569', pin: '222222' },
    { code: 'vicedir01', prefix: 'นาง', first: 'สมหญิง', last: 'รองผู้อำนวยการ', email: 'vicedir@school.local', pos: 'รองผู้อำนวยการ', dept: 'ACAD', role: 'vice_director', pass: 'Vice@2569', pin: '333333' },
    { code: 'head_acad', prefix: 'นาง', first: 'วิชาการ', last: 'หัวหน้าฝ่าย', email: 'head.acad@school.local', pos: 'หัวหน้าฝ่ายวิชาการ', dept: 'ACAD', role: 'head', pass: 'Head@2569', pin: '444444' },
    { code: 'reg001', prefix: 'นางสาว', first: 'ธุรการ', last: 'ใจดี', email: 'registrar@school.local', pos: 'เจ้าหน้าที่ธุรการ', dept: 'REG', role: 'registrar', pass: 'Reg@2569', pin: '555555' },
    { code: 'teacher001', prefix: 'นาย', first: 'ครูใหญ่', last: 'สอนดี', email: 'teacher@school.local', pos: 'ครู', dept: 'ACAD', role: 'teacher', pass: 'Teacher@2569', pin: '666666' },
  ];

  const userIds = {};
  for (const u of demoUsers) {
    const id = uuid();
    userIds[u.code] = id;
    insUser.run(id, u.code, u.prefix, u.first, u.last, u.email, u.pos, deptIds[u.dept], hashSecret(u.pass), hashSecret(u.pin), nowIso(), nowIso());
    insUserRole.run(id, roleIds[u.role]);
  }

  db._seed = { deptIds, roleIds, typeIds, userIds };
}

migrate();
seedIfEmpty();

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
