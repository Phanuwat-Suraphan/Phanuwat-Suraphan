import { DatabaseSync } from 'node:sqlite';
import { randomUUID, scryptSync, randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'esaraban.db');

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

  CREATE TABLE IF NOT EXISTS user_delegations (
    id TEXT PRIMARY KEY,
    delegator_id TEXT NOT NULL REFERENCES users(id),
    delegate_id TEXT NOT NULL REFERENCES users(id),
    reason TEXT,
    start_date TEXT NOT NULL,
    end_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

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
    title TEXT NOT NULL,
    subject TEXT,
    doc_type_id TEXT NOT NULL REFERENCES document_types(id),
    department_id TEXT NOT NULL REFERENCES departments(id),
    priority TEXT NOT NULL DEFAULT 'normal', -- normal | urgent | very_urgent | most_urgent
    secret_level TEXT NOT NULL DEFAULT 'normal', -- normal | internal | secret | top_secret
    correspondent_name TEXT, -- หน่วยงาน/บุคคลภายนอก (ผู้ส่ง สำหรับ incoming, ผู้รับ สำหรับ outgoing)
    status TEXT NOT NULL DEFAULT 'draft', -- draft|registered|in_progress|returned|completed|archived|voided
    due_date TEXT,
    created_by TEXT NOT NULL REFERENCES users(id),
    void_reason TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
  );

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
    filepath TEXT NOT NULL,
    filesize INTEGER NOT NULL,
    mime_type TEXT NOT NULL,
    hash_sha256 TEXT NOT NULL,
    uploaded_by TEXT NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL
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
  `);
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

  const types = ['หนังสือราชการ', 'บันทึกข้อความ', 'คำสั่ง', 'ประกาศ', 'หนังสือเวียน', 'รายงาน'];
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
