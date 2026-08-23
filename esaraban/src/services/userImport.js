// นำเข้ารายชื่อบุคลากรจากไฟล์ Excel/CSV
//
// ทำไมต้องมี: โรงเรียนมีครู 30-50 คน หน้าจัดการผู้ใช้เดิมเพิ่มได้ทีละคน แปลว่าต้องกรอกฟอร์ม 10 ช่อง
// ซ้ำ 50 รอบตอนเปิดใช้ระบบครั้งแรก ซึ่งเป็นด่านแรกที่ทำให้โรงเรียนล้มเลิกไปก่อนได้ใช้งานจริง
//
// รับทั้ง .xlsx และ .csv เพราะไฟล์รายชื่อครูที่โรงเรียนมีอยู่แล้วมีทั้งสองแบบ และ CSV ทำให้เราแจก
// ไฟล์ตัวอย่างได้โดยไม่ต้องเขียนตัวสร้าง .xlsx เอง (โปรเจกต์นี้ไม่มี npm dependency)
import { readWorkbook } from './xlsx.js';
import { db, uuid, nowIso, hashSecret, audit, isWeakPin } from '../db.js';

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// ชื่อหัวคอลัมน์ที่ยอมรับ — เผื่อโรงเรียนตั้งชื่อไม่เหมือนกันเป๊ะ จะได้ไม่ต้องมานั่งแก้ไฟล์ก่อนอัปโหลด
const HEADER_ALIASES = {
  employeeCode: ['รหัสประจำตัว', 'รหัส', 'รหัสพนักงาน', 'username', 'ชื่อผู้ใช้'],
  prefix: ['คำนำหน้า', 'คำนำหน้าชื่อ'],
  firstName: ['ชื่อ'],
  lastName: ['นามสกุล', 'สกุล'],
  email: ['อีเมล', 'email', 'e-mail'],
  position: ['ตำแหน่ง'],
  department: ['ฝ่าย', 'กลุ่มงาน', 'กลุ่มสาระ', 'สังกัด'],
  role: ['บทบาท', 'สิทธิ์', 'สิทธิ์การใช้งาน'],
};

const norm = (s) => String(s ?? '').replace(/\s+/g, '').toLowerCase();

/** จับคู่หัวตารางกับชื่อฟิลด์ — คืน { field: columnIndex } */
export function mapHeaders(headerRow) {
  const map = {};
  headerRow.forEach((cell, i) => {
    const key = norm(cell);
    if (!key) return;
    for (const [field, aliases] of Object.entries(HEADER_ALIASES)) {
      // "ชื่อ" เป็นคำที่อยู่ในหลายหัวคอลัมน์ (ชื่อผู้ใช้ ชื่อ-สกุล) จึงเทียบแบบตรงตัวเท่านั้น
      if (map[field] === undefined && aliases.some((a) => norm(a) === key)) map[field] = i;
    }
  });
  return map;
}

/** อ่านไฟล์เป็นตาราง 2 มิติ — รองรับทั้ง .xlsx และ .csv */
export function readTable(buffer, filename = '') {
  const isCsv = /\.csv$/i.test(filename) || buffer.subarray(0, 2).toString('latin1') !== 'PK';
  if (!isCsv) {
    const sheets = readWorkbook(buffer);
    return sheets[0].rows;
  }
  // ตัด BOM ที่ Excel ใส่มาให้ตอน "บันทึกเป็น CSV UTF-8" ออกก่อน ไม่งั้นหัวคอลัมน์แรกจะจับคู่ไม่ติด
  let text = buffer.toString('utf8').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; } else inQuotes = false;
      } else cell += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

/**
 * ตรวจทุกแถวแล้วบอกว่าจะเกิดอะไรขึ้น โดยยังไม่เขียนอะไรลงฐานข้อมูล
 *
 * แยกเป็นฟังก์ชันล้วนๆ เพื่อสองเหตุผล: ทดสอบได้โดยไม่ต้องมีไฟล์ Excel จริง และเอาไปแสดงเป็นหน้า
 * "ดูก่อนนำเข้า" ให้แอดมินตรวจก่อนกดยืนยันได้ — การสร้างบัญชีผู้ใช้ผิดๆ 50 บัญชีแล้วมาไล่ลบทีหลัง
 * เจ็บปวดกว่าการตรวจก่อนมาก
 */
export function planUserImport(rows, { departments, roles, existingCodes }) {
  if (!rows.length) throw httpError(400, 'ไฟล์ว่างเปล่า');
  const headerIdx = rows.findIndex((r) => Object.keys(mapHeaders(r)).length >= 3);
  if (headerIdx < 0) {
    throw httpError(400, 'หาหัวตารางไม่เจอ — ต้องมีคอลัมน์อย่างน้อย รหัสประจำตัว, ชื่อ, นามสกุล (ดาวน์โหลดไฟล์ตัวอย่างเพื่อดูรูปแบบที่ถูกต้อง)');
  }
  const map = mapHeaders(rows[headerIdx]);
  for (const required of ['employeeCode', 'firstName', 'lastName']) {
    if (map[required] === undefined) {
      const label = { employeeCode: 'รหัสประจำตัว', firstName: 'ชื่อ', lastName: 'นามสกุล' }[required];
      throw httpError(400, `ไม่พบคอลัมน์ "${label}" ในไฟล์`);
    }
  }

  const deptByName = new Map(departments.map((d) => [norm(d.name), d]));
  const roleByName = new Map();
  for (const r of roles) { roleByName.set(norm(r.name_th), r); roleByName.set(norm(r.name), r); }
  const seen = new Set();
  const taken = new Set(existingCodes.map(norm));

  const items = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const cells = rows[i];
    const get = (f) => String(cells[map[f]] ?? '').trim();
    const employeeCode = get('employeeCode');
    const firstName = get('firstName');
    const lastName = get('lastName');
    // แถวว่างล้วน (Excel มักมีต่อท้ายเป็นสิบแถว) ข้ามเงียบๆ ไม่ต้องรายงานเป็นข้อผิดพลาด
    if (!employeeCode && !firstName && !lastName) continue;

    const item = { rowNumber: i + 1, employeeCode, prefix: get('prefix'), firstName, lastName,
      email: get('email'), position: get('position'), departmentName: get('department'), roleName: get('role') };

    if (!employeeCode || !firstName || !lastName) {
      items.push({ ...item, status: 'error', reason: 'ต้องมีรหัสประจำตัว ชื่อ และนามสกุล ครบทั้งสามช่อง' });
      continue;
    }
    if (taken.has(norm(employeeCode))) {
      items.push({ ...item, status: 'skip', reason: 'มีรหัสประจำตัวนี้ในระบบอยู่แล้ว' });
      continue;
    }
    if (seen.has(norm(employeeCode))) {
      items.push({ ...item, status: 'error', reason: 'รหัสประจำตัวซ้ำกับแถวก่อนหน้าในไฟล์เดียวกัน' });
      continue;
    }
    const dept = item.departmentName ? deptByName.get(norm(item.departmentName)) : null;
    if (item.departmentName && !dept) {
      items.push({ ...item, status: 'error', reason: `ไม่พบฝ่าย "${item.departmentName}" ในระบบ` });
      continue;
    }
    const role = item.roleName ? roleByName.get(norm(item.roleName)) : roleByName.get(norm('ครู'));
    if (item.roleName && !role) {
      items.push({ ...item, status: 'error', reason: `ไม่พบบทบาท "${item.roleName}" ในระบบ` });
      continue;
    }
    if (!role) {
      items.push({ ...item, status: 'error', reason: 'ไม่ได้ระบุบทบาท และไม่พบบทบาท "ครู" ให้ใช้เป็นค่าตั้งต้น' });
      continue;
    }

    seen.add(norm(employeeCode));
    items.push({ ...item, status: 'ok', departmentId: dept?.id || null, roleId: role.id, roleLabel: role.name_th });
  }

  return {
    items,
    summary: {
      ok: items.filter((i) => i.status === 'ok').length,
      skip: items.filter((i) => i.status === 'skip').length,
      error: items.filter((i) => i.status === 'error').length,
    },
  };
}

// รหัสผ่าน/PIN สุ่มให้คนละชุด แล้วแสดงครั้งเดียวให้แอดมินพิมพ์แจก — ดีกว่าให้กรอกลงไฟล์ Excel
// ซึ่งจะกลายเป็นไฟล์ที่มีรหัสผ่านของทั้งโรงเรียนวางอยู่ในเครื่อง/ในไลน์กลุ่ม
const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'; // ตัด 0/O/1/l/I ที่อ่านสับสน
export function generatePassword() {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => PW_CHARS[b % PW_CHARS.length]).join('');
}
export function generatePin() {
  // วนจนกว่าจะได้ PIN ที่ไม่เดาง่าย — ตัวที่สุ่มได้อาจออกมาเป็น 111111 หรือ 123456 ได้จริง แล้วหน้า
  // ตั้งรหัสครั้งแรกจะปฏิเสธ PIN นั้นเอง กลายเป็นระบบแจก PIN ที่ระบบตัวเองไม่ยอมรับ
  for (;;) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const pin = Array.from(bytes, (b) => String(b % 10)).join('');
    if (!isWeakPin(pin)) return pin;
  }
}

/** สร้างบัญชีจริงจากรายการที่ตรวจแล้ว — คืนรหัสผ่าน/PIN ที่สุ่มให้ เพื่อแสดงครั้งเดียว */
export function applyUserImport(items, actorId) {
  const created = [];
  const insUser = db.prepare(`
    INSERT INTO users (id, employee_code, prefix, first_name, last_name, email, position, department_id, password_hash, pin_hash, status, must_change_password, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?)
  `);
  const insRole = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');

  // ทั้งชุดอยู่ในทรานแซกชันเดียว — นำเข้า 50 คนแล้วพังกลางคันเหลือ 23 คนครึ่งๆ กลางๆ
  // แย่กว่าไม่ได้อะไรเลย เพราะแอดมินต้องมานั่งไล่ว่าใครเข้าไปแล้วบ้างก่อนลองใหม่
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of items) {
      if (item.status !== 'ok') continue;
      const id = uuid();
      const password = generatePassword();
      const pin = generatePin();
      const now = nowIso();
      insUser.run(id, item.employeeCode, item.prefix || '', item.firstName, item.lastName,
        item.email || null, item.position || null, item.departmentId, hashSecret(password), hashSecret(pin), now, now);
      insRole.run(id, item.roleId);
      created.push({ employeeCode: item.employeeCode, name: `${item.prefix || ''}${item.firstName} ${item.lastName}`, password, pin });
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  audit({ userId: actorId, action: 'users_imported', tableName: 'users', recordId: null, detail: { count: created.length } });
  return created;
}

// ไฟล์ตัวอย่างเป็น CSV พร้อม BOM — Excel ต้องเห็น BOM ถึงจะเปิดภาษาไทยไม่เป็นตัวยึกยือ
export function templateCsv() {
  const rows = [
    ['รหัสประจำตัว', 'คำนำหน้า', 'ชื่อ', 'นามสกุล', 'อีเมล', 'ตำแหน่ง', 'ฝ่าย', 'บทบาท'],
    ['teacher101', 'นาย', 'สมชาย', 'ใจดี', 'somchai@school.ac.th', 'ครู', 'กลุ่มบริหารวิชาการ', 'ครู'],
    ['teacher102', 'นางสาว', 'สมหญิง', 'ตั้งใจ', '', 'ครูผู้ช่วย', '', 'ครู'],
  ];
  return '﻿' + rows.map((r) => r.map((c) => (/[",\n]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n';
}
