// Zero-dependency test suite (node:test, built into Node 22 — no npm packages needed).
// Uses a throwaway SQLite file per run (DB_PATH) so it never touches data/esaraban.db.
// Run with: node --test test/
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `esaraban-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret-not-for-production';

const { db, computeRetentionUntil, beYear, todayInBangkok, hashSecret, verifySecret, isWeakPin, nowIso, migrate, uuid } = await import('../src/db.js');
const { login, getSessionUser, revokeOtherSessions, verifyPin } = await import('../src/auth.js');
const { contentDispositionHeader } = await import('../src/router.js');
const { daysUntil, fmtDate, fmtThaiDateShort, fmtThaiDateLong, stampDateThai, stampTimeThai, bangkokHour } = await import('../src/render.js');
const {
  createDocument, createDocumentsBulk, MAX_BULK_DOCUMENTS, getDocument, canUserSeeDocument, currentStep,
  assignStep, approveAndForward, acknowledgeAndComplete, rejectStep, returnStep, voidDocument, archiveDocument,
  assertStepBelongsToDocument, forceDeleteDocument,
} = await import('../src/services/workflow.js');
const { nextRunningNumber } = await import('../src/numbering.js');
const { readWorkbook } = await import('../src/services/xlsx.js');
const { buildXlsx } = await import('../src/services/xlsxWrite.js');
const { parseUploadedWorkbook, looksLikeHeader } = await import('../src/services/dailySummaryParse.js');
const {
  createLeaveRequest, approveLeaveRequest, rejectLeaveRequest, cancelLeaveRequest, canSeeLeaveRequest, getLeaveRequest,
  canApproveLeave, leaveStatsForFiscalYear, fiscalYearRange,
} = await import('../src/services/leave.js');
const { SCHOOL_POSITIONS } = await import('../src/services/positions.js');
const { planUserImport, MAX_IMPORT_ROWS } = await import('../src/services/userImport.js');
const { truncateFilename, MAX_HEADER_FILENAME_CHARS } = await import('../src/router.js');
const { buildDocumentQuery, describeFilters, listRegisterYears } = await import('../src/services/documentQuery.js');
const { createDelegation } = await import('../src/services/delegation.js');
const { isBackupEnabled, restoreDatabaseIfMissing, backupNow, planBackupCleanup, thaiDateParts } = await import('../src/services/dbBackup.js');
const sqliteModule = await import('node:sqlite');
const { createDestructionBatch, approveDestructionBatch } = await import('../src/services/retention.js');
const { MAX_STAMP_TEXT } = await import('../src/services/pdfStamp.js');
const zlib = await import('node:zlib');

const seed = db._seed;
// รหัสผ่าน/PIN ของบัญชีตั้งต้นถูกสุ่มใหม่ทุกครั้งที่สร้างฐานข้อมูล (เดิมเป็นค่าตายตัวที่พิมพ์โชว์ไว้บน
// หน้าเข้าสู่ระบบ) เทสต์จึงต้องอ่านจากที่ seed คืนมา ไม่ใช่ฝังค่าไว้เอง
const pw = (code) => seed.passwords[code].password;
const userPin = (code) => seed.passwords[code].pin;
// บัญชีตั้งต้นถูกตั้งธง must_change_password ไว้ตอน seed เทสต์ส่วนใหญ่จำลอง "ระบบที่ใช้งานอยู่จริง"
// คือทุกคนตั้งรหัสของตัวเองไปแล้ว จึงเคลียร์ธงตรงนี้ทีเดียว ส่วนตัวด่านบังคับเปลี่ยนรหัสมีเทสต์แยกของ
// ตัวเองที่ตั้งธงขึ้นมาเองเฉพาะกิจ (describe 'ด่านบังคับตั้งรหัสผ่านเองตอนเข้าใช้ครั้งแรก')
db.prepare('UPDATE users SET must_change_password = 0').run();
const adminUser = { id: seed.userIds.admin, roleCodes: ['admin'] };
const teacherUser = { id: seed.userIds.teacher001, roleCodes: ['teacher'], prefix: 'นาย', first_name: 'ครูใหญ่', last_name: 'สอนดี' };
const registrarUser = { id: seed.userIds.reg001, roleCodes: ['registrar'] };
const deptId = seed.deptIds.ACAD;
const typeId = Object.values(seed.typeIds)[0];

function makeDoc(overrides = {}) {
  return createDocument({
    direction: 'incoming', title: 'เอกสารทดสอบ', correspondentName: 'ผู้ทดสอบ',
    docTypeId: typeId, departmentId: deptId, priority: 'normal', secretLevel: 'normal',
    // ธุรการเป็นผู้ลงทะเบียนหนังสือเข้าในความเป็นจริง จึงเป็นทั้งผู้บันทึกและผู้เสนอ/ยกเลิกเอง — เดิม fixture
    // ตั้งผู้บันทึกเป็นแอดมินแต่ไปเสนอ/ยกเลิกด้วยธุรการ ซึ่งเป็นสถานการณ์ที่ไม่เกิดขึ้นจริง และบังเอิญผ่านมาได้
    // เพราะตอนนั้นฝั่งเซิร์ฟเวอร์ยังไม่ได้ตรวจสิทธิ์ในสองฟังก์ชันนั้นเลย
    createdBy: registrarUser.id, ...overrides,
  });
}

// ช่วงวันลาที่ไม่ซ้ำกับใบไหนเลย — ระบบกันไม่ให้คนเดียวยื่นใบลาทับช่วงเดิมของตัวเอง (โดยตั้งใจ) fixture
// ที่ใช้วันที่ตายตัวร่วมกันจึงชนกันเองข้ามเทสต์ ตัวช่วยนี้เดินหน้าไปเรื่อยๆ ให้แต่ละใบได้ช่วงของตัวเอง
// เริ่มไกลจากวันนี้มากพอที่จะไม่ทับกับเทสต์ที่จงใจใช้วันที่ใกล้ๆ ปัจจุบัน
let leaveWindowCursor = 2000;
function nextLeaveWindow(days = 2) {
  const start = leaveWindowCursor;
  leaveWindowCursor += days + 5; // เว้นช่องว่างระหว่างใบ กันการชนขอบ
  const at = (n) => new Date(Date.parse(`${todayInBangkok()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  return { startDate: at(start), endDate: at(start + days - 1) };
}

// ผู้ใช้พร้อม roleCodes/department_id เหมือนที่ ctx.user ได้ตอนล็อกอินจริง — ตัวตรวจสิทธิ์ใช้ทั้งสองอย่าง
function loadUserForTest(userId) {
  // คืนแถวเต็มเหมือนที่ getSessionUser คืนตอนล็อกอินจริง — หน้าเว็บใช้ทั้ง prefix/first_name/position
  // ไม่ใช่แค่ id กับ roleCodes ถ้าคืนมาไม่ครบ หน้าที่ใช้ฟิลด์อื่นจะพังในเทสต์ทั้งที่ของจริงไม่พัง
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
  if (!u) return null;
  const roleCodes = db.prepare(`
    SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?
  `).all(userId).map((r) => r.name);
  return { ...u, roleCodes, roles: roleCodes.map((name) => ({ name })), unreadCount: 0 };
}

function getDocRow(id) {
  return db.prepare('SELECT * FROM documents WHERE id = ?').get(id);
}

// เรียกเส้นทาง GET จริงผ่าน router โดยจำลอง ctx เหมือนที่ server.js ประกอบให้ แล้วเก็บสิ่งที่เส้นทาง
// เขียนออกมา — ตรรกะหลายอย่าง (ตัวกรอง, การส่งออกไฟล์, การกรองสิทธิ์ตอน export) อยู่ในตัวเส้นทางเอง
// ถ้าเทสต์ระดับฟังก์ชันอย่างเดียวจะไม่ได้ตรวจสิ่งที่ผู้ใช้ได้รับจริงเลย
let routerForTest = null;
async function dispatchGet(user, path, query = {}) {
  if (!routerForTest) {
    ({ router: routerForTest } = await import('../src/router.js'));
    await import('../src/routes/index.js');
  }
  let status = 0;
  const chunks = [];
  const headers = {};
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(code, h) { status = code; Object.assign(headers, h || {}); this.headersSent = true; return this; },
    end(chunk) { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); },
  };
  const ctx = { req: { method: 'GET', headers: {} }, res, url: new URL(`http://x${path}`), query, user, body: {}, ip: '127.0.0.1' };
  await routerForTest.dispatch('GET', path, ctx);
  const buffer = Buffer.concat(chunks);
  return { status, headers, buffer, body: buffer.toString('utf8') };
}

// เหมือน dispatchGet แต่เป็น POST พร้อม body — ใช้ตรวจว่าเส้นทางปฏิเสธค่าที่ไม่ถูกต้อง "ก่อน" ที่จะ
// ไปแตะฐานข้อมูล ซึ่งเทสต์ระดับฟังก์ชันมองไม่เห็น เพราะการตรวจบางอย่างอยู่ในตัวเส้นทางเอง
async function dispatchPost(user, path, body = {}) {
  if (!routerForTest) {
    ({ router: routerForTest } = await import('../src/router.js'));
    await import('../src/routes/index.js');
  }
  let status = 0;
  const chunks = [];
  const headers = {};
  const res = {
    headersSent: false,
    setHeader() {},
    writeHead(code, h) { status = code; Object.assign(headers, h || {}); this.headersSent = true; return this; },
    end(chunk) { if (chunk) chunks.push(String(chunk)); },
  };
  const ctx = { req: { method: 'POST', headers: {} }, res, url: new URL(`http://x${path}`), query: {}, user, body, ip: '127.0.0.1' };
  await routerForTest.dispatch('POST', path, ctx);
  const text = chunks.join('');
  let json = {};
  try { json = JSON.parse(text); } catch { /* หน้าเว็บธรรมดา ไม่ใช่ JSON */ }
  return { status, headers, body: text, json };
}

describe('auth: login + rate limiting', () => {
  test('rejects unknown user with a generic error', () => {
    const result = login('nonexistent', 'whatever', '127.0.0.1');
    assert.equal(result.ok, false);
  });

  test('accepts correct credentials', () => {
    const result = login('teacher001', pw('teacher001'), '127.0.0.1');
    assert.equal(result.ok, true);
    assert.ok(result.cookie);
  });

  test('locks the account after 5 failed attempts and blocks even the correct password', () => {
    for (let i = 0; i < 4; i++) {
      const r = login('reg001', 'wrong-password', '127.0.0.1');
      assert.equal(r.ok, false);
      assert.doesNotMatch(r.error, /ล็อก/);
    }
    const lockingAttempt = login('reg001', 'wrong-password', '127.0.0.1');
    assert.equal(lockingAttempt.ok, false);
    assert.match(lockingAttempt.error, /ล็อกชั่วคราว/);

    const blockedEvenCorrect = login('reg001', pw('reg001'), '127.0.0.1');
    assert.equal(blockedEvenCorrect.ok, false);
    assert.match(blockedEvenCorrect.error, /ล็อกชั่วคราว/);
  });
});

// scryptSync โยน ERR_INVALID_ARG_TYPE ถ้าได้ค่าที่ไม่ใช่ข้อความ ทำให้ทุก endpoint ที่ตรวจ PIN/รหัสผ่าน
// ตอบ 500 พร้อมข้อความภาษาอังกฤษของ Node แทนที่จะเป็น "PIN ไม่ถูกต้อง" — ทดสอบกับระบบจริงแล้วว่า
// ปุ่มรับทราบเอกสารตอบ 500 จริงเมื่อฝั่งเว็บไม่ได้ส่งช่อง pin มา
describe('ตรวจรหัสผ่าน/PIN: ค่าที่ไม่ใช่ข้อความต้องตอบว่าไม่ตรง ไม่ใช่ทำให้ระบบพัง', () => {
  test('undefined / null / ตัวเลข / object ต้องได้ false โดยไม่โยน error', () => {
    const stored = hashSecret('123456');
    for (const bad of [undefined, null, 123456, {}, [], true]) {
      assert.equal(verifySecret(bad, stored), false, `ค่า ${JSON.stringify(bad)} ต้องได้ false`);
    }
    assert.equal(verifySecret('123456', stored), true, 'PIN ที่ถูกต้องต้องยังผ่าน');
    assert.equal(verifySecret('654321', stored), false);
  });

  test('verifyPin ของผู้ใช้จริง ไม่พังเมื่อไม่ได้ส่ง PIN มา', () => {
    assert.equal(verifyPin(teacherUser.id, undefined), false);
    assert.equal(verifyPin(teacherUser.id, Number(userPin('teacher001'))), false, 'ตัวเลขต้องไม่ผ่าน (ต้องเป็นข้อความ)');
    assert.equal(verifyPin(teacherUser.id, userPin('teacher001')), true);
  });
});

describe('เลขทะเบียนหนังสือ: เรียงต่อเนื่อง ไม่ซ้ำ ไม่ข้าม', () => {
  test('เลขเดินหน้าทีละหนึ่งเสมอ', () => {
    const year = beYear();
    const a = nextRunningNumber({ direction: 'incoming', year });
    const b = nextRunningNumber({ direction: 'incoming', year });
    assert.equal(b.runningNumber, a.runningNumber + 1);
  });

  test('หนังสือเข้ากับหนังสือออกนับแยกเล่มกัน', () => {
    const year = beYear();
    const before = nextRunningNumber({ direction: 'outgoing', year }).runningNumber;
    nextRunningNumber({ direction: 'incoming', year });
    nextRunningNumber({ direction: 'incoming', year });
    // ออกเลขหนังสือเข้าไป 2 ฉบับ ต้องไม่ดันเลขหนังสือออกให้กระโดดตาม
    assert.equal(nextRunningNumber({ direction: 'outgoing', year }).runningNumber, before + 1);
  });

  // ทะเบียนหนังสือรับของโรงเรียนเป็นเล่มเดียว เลขที่ต้องอ้างอิงได้ตัวเดียวไม่กำกวม — เดิมนับแยกรายฝ่าย
  // แต่เลขที่แสดงไม่มีรหัสฝ่าย ทำให้หนังสือของฝ่ายบริหารทั่วไปกับฝ่ายงบประมาณได้ "0001/2569" ทั้งคู่
  test('หนังสือคนละฝ่ายต้องไม่ได้เลขทะเบียนซ้ำกัน', () => {
    const deptCodes = db.prepare('SELECT id FROM departments ORDER BY code').all().map((d) => d.id);
    assert.ok(deptCodes.length >= 3, 'ต้องมีหลายฝ่ายจึงจะทดสอบเรื่องนี้ได้');
    const numbers = deptCodes.map((departmentId, i) =>
      makeDoc({ title: `ทดสอบเลขซ้ำข้ามฝ่าย ${i}`, departmentId }).docNumberDisplay);
    assert.equal(new Set(numbers).size, numbers.length, `เลขทะเบียนซ้ำกัน: ${numbers.join(', ')}`);
  });

  test('เลขที่แสดงอยู่ในรูปแบบ 0000/2569', () => {
    const doc = makeDoc({ title: 'ตรวจสอบเลขที่เอกสาร' });
    assert.match(doc.docNumberDisplay, /^\d{4}\/\d{4}$/);
  });

  // ฐานข้อมูลที่ใช้งานมาก่อนหน้านี้มีหนังสือลงทะเบียนไปแล้ว ตัวนับชุดใหม่ต้องเริ่มนับต่อจากเลขสูงสุด
  // ที่เคยออกไป ไม่ใช่ย้อนกลับไปเริ่มที่ 1 แล้วออกเลขทับหนังสือเก่า
  test('ตัวนับชุดใหม่เริ่มต่อจากเลขสูงสุดที่เคยออกไปแล้ว ไม่ออกเลขซ้ำของเดิม', () => {
    const year = beYear() + 90; // ปีที่ยังไม่มีตัวนับ ใช้จำลองฐานข้อมูลที่เพิ่งอัปเกรดมา
    const doc = makeDoc({ title: 'หนังสือเก่าที่ลงทะเบียนไว้ก่อนแล้ว' });
    db.prepare('UPDATE documents SET year_be = ?, running_number = 47 WHERE id = ?').run(year, doc.id);
    assert.equal(nextRunningNumber({ direction: 'incoming', year }).runningNumber, 48);
  });
});

describe('document lifecycle: assign -> approve -> acknowledge', () => {
  test('full happy path reaches status=completed', () => {
    const doc = makeDoc({ title: 'ทดสอบ workflow เต็มรูปแบบ' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, instruction: 'โปรดพิจารณา', actorUser: registrarUser });

    let step = currentStep(doc.id);
    assert.ok(step, 'expected a waiting step after assignment');
    assert.equal(getDocument(doc.id).status, 'in_progress');

    approveAndForward({ stepId: step.id, nextAssigneeId: adminUser.id, comment: 'เห็นชอบ', actorUser: teacherUser });

    step = currentStep(doc.id);
    assert.ok(step, 'expected a new waiting step after forwarding');
    assert.equal(step.assignee_id, adminUser.id);

    acknowledgeAndComplete({ stepId: step.id, comment: 'รับทราบแล้ว', actorUser: adminUser });
    assert.equal(getDocument(doc.id).status, 'completed');
  });

  test('reject sets a distinct rejected status', () => {
    const doc = makeDoc({ title: 'ทดสอบปฏิเสธ' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    const step = currentStep(doc.id);
    rejectStep({ stepId: step.id, reason: 'ไม่ตรงตามระเบียบ', actorUser: teacherUser });
    assert.equal(getDocument(doc.id).status, 'rejected');
  });

  test('return sets status=returned and requires a reason', () => {
    const doc = makeDoc({ title: 'ทดสอบส่งกลับ' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    const step = currentStep(doc.id);
    assert.throws(() => returnStep({ stepId: step.id, reason: '', actorUser: teacherUser }));
    returnStep({ stepId: step.id, reason: 'ขาดเอกสารแนบ', actorUser: teacherUser });
    assert.equal(getDocument(doc.id).status, 'returned');
  });

  test('a user outside the workflow cannot act on someone else\'s step', () => {
    const doc = makeDoc({ title: 'ทดสอบสิทธิ์ workflow' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    const step = currentStep(doc.id);
    assert.throws(() => approveAndForward({ stepId: step.id, nextAssigneeId: adminUser.id, actorUser: registrarUser }), /ไม่มีสิทธิ์/);
  });
});

describe('void: numbers are never reused', () => {
  test('void is allowed while still registered (not yet assigned)', () => {
    const doc = makeDoc({ title: 'ทดสอบยกเลิก' });
    voidDocument({ documentId: doc.id, reason: 'สร้างผิดพลาด', actorUser: registrarUser });
    assert.equal(getDocument(doc.id).status, 'voided');
  });

  test('void is blocked once the document has left the registered state', () => {
    const doc = makeDoc({ title: 'ทดสอบยกเลิกหลังมอบหมาย' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    assert.throws(() => voidDocument({ documentId: doc.id, reason: 'สาย', actorUser: registrarUser }), /ห้ามลบ/);
  });
});

describe('ACL: secret documents are hidden from unrelated departments', () => {
  test('a normal user outside the doc\'s department cannot see a secret-level document', () => {
    const doc = makeDoc({ title: 'เอกสารลับ', secretLevel: 'secret', departmentId: seed.deptIds.BUDGET });
    const outsider = { id: seed.userIds.teacher001, roleCodes: ['teacher'], department_id: deptId };
    assert.equal(canUserSeeDocument(outsider, getDocument(doc.id)), false);
  });

  test('admin can always see every document regardless of secrecy level', () => {
    const doc = makeDoc({ title: 'เอกสารลับ 2', secretLevel: 'top_secret', departmentId: seed.deptIds.BUDGET });
    assert.equal(canUserSeeDocument({ id: adminUser.id, roleCodes: ['admin'] }, getDocument(doc.id)), true);
  });

  // ตามที่โรงเรียนขอ: หนังสือราชการทั่วไปเป็นเรื่องที่ครูทุกคนต้องรับรู้อยู่แล้ว การจำกัดตามฝ่ายทำให้
  // ครูเปิดหนังสือของฝ่ายอื่นไม่ได้ทั้งที่ควรอ่านได้ — ส่วนชั้นความลับยังจำกัดตามเดิม
  test('ครูทุกคนเปิด/ดาวน์โหลดหนังสือทั่วไปได้ทุกฉบับ แม้เป็นของฝ่ายอื่น', () => {
    const outsider = { id: seed.userIds.teacher001, roleCodes: ['teacher'], department_id: deptId };
    for (const secretLevel of ['normal', 'internal']) {
      const doc = makeDoc({ title: `หนังสือทั่วไป ${secretLevel}`, secretLevel, departmentId: seed.deptIds.BUDGET });
      assert.equal(canUserSeeDocument(outsider, getDocument(doc.id)), true, `ชั้นความลับ ${secretLevel} ครูต้องเปิดได้`);
    }
  });

  test('แต่ชั้นความลับ "ลับ"/"ลับมาก" ยังจำกัดเหมือนเดิม (ไม่งั้นช่องชั้นความลับจะไม่มีความหมาย)', () => {
    const outsider = { id: seed.userIds.teacher001, roleCodes: ['teacher'], department_id: deptId };
    for (const secretLevel of ['secret', 'top_secret']) {
      const doc = makeDoc({ title: `หนังสือลับ ${secretLevel}`, secretLevel, departmentId: seed.deptIds.BUDGET });
      assert.equal(canUserSeeDocument(outsider, getDocument(doc.id)), false, `ชั้นความลับ ${secretLevel} ต้องยังปิดอยู่`);
    }
  });
});

describe('ACL: a workflow step cannot be used against a different document', () => {
  test('pairing your own stepId with someone else\'s documentId is rejected', () => {
    const mine = makeDoc({ title: 'เอกสารของฉัน' });
    assignStep({ documentId: mine.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    const myStep = currentStep(mine.id);

    const other = makeDoc({ title: 'เอกสารของคนอื่น' });

    // เดิมช่องโหว่นี้ทำให้ประทับลายเซ็นลง PDF ของเอกสารอื่นได้ เพราะ assertOwnsStep ตรวจแค่เจ้าของขั้นตอน
    // (ผ่าน เพราะ myStep เป็นของเราจริง) แต่ documentId ที่ใช้ประทับตรามาจาก URL ที่ผู้ใช้กำหนดเองได้
    assert.throws(
      () => assertStepBelongsToDocument(other.id, myStep.id),
      (err) => err.statusCode === 404,
    );
  });

  test('the matching document/step pair still passes', () => {
    const doc = makeDoc({ title: 'เอกสารคู่ถูกต้อง' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    const step = currentStep(doc.id);
    assert.doesNotThrow(() => assertStepBelongsToDocument(doc.id, step.id));
  });
});

describe('retention: computeRetentionUntil matches the regulation\'s year counts', () => {
  test('normal_10y adds 10 years, expressed in ค.ศ.', () => {
    const until = computeRetentionUntil(2569, 'normal_10y');
    assert.equal(until, '2036-12-31'); // 2569+10=2579 พ.ศ. -> 2036 ค.ศ.
  });

  test('financial_5y adds 5 years', () => {
    assert.equal(computeRetentionUntil(2569, 'financial_5y'), '2031-12-31');
  });

  test('routine_1y adds 1 year', () => {
    assert.equal(computeRetentionUntil(2569, 'routine_1y'), '2027-12-31');
  });

  test('permanent never expires', () => {
    assert.equal(computeRetentionUntil(2569, 'permanent'), null);
  });
});

// ช่องโหว่จริงที่เคยเกิด: ปุ่มถูกซ่อนไว้ใน UI (isCreatorOrAdmin) แต่ฝั่งเซิร์ฟเวอร์ไม่ตรวจสิทธิ์เลย ใครก็ตามที่
// ล็อกอินอยู่จึงยิง API ตรงๆ ข้าม UI แล้วยกเลิก/จัดเก็บ/มอบหมายงานในหนังสือราชการของคนอื่นได้ทั้งระบบ
describe('ACL: ยกเลิก/จัดเก็บ/มอบหมาย ต้องบังคับสิทธิ์ฝั่งเซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนปุ่ม', () => {
  test('ครูที่ไม่ใช่ผู้บันทึกเอกสาร ยกเลิกเอกสารของคนอื่นไม่ได้', () => {
    const doc = makeDoc({ title: 'ห้ามให้คนอื่นยกเลิก' });
    assert.throws(
      () => voidDocument({ documentId: doc.id, reason: 'ไม่มีสิทธิ์', actorUser: teacherUser }),
      /เฉพาะผู้บันทึกเอกสารหรือผู้ดูแลระบบ/,
    );
    assert.equal(getDocument(doc.id).status, 'registered');
  });

  test('ครูที่ไม่ใช่ผู้บันทึกเอกสาร มอบหมายงานในเอกสารของคนอื่นไม่ได้', () => {
    const doc = makeDoc({ title: 'ห้ามให้คนอื่นมอบหมาย' });
    assert.throws(
      () => assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: teacherUser }),
      /เฉพาะผู้บันทึกเอกสารหรือผู้ดูแลระบบ/,
    );
  });

  test('ครูที่ไม่ใช่ผู้บันทึกเอกสาร จัดเก็บเอกสารของคนอื่นไม่ได้', () => {
    const doc = makeDoc({ title: 'ห้ามให้คนอื่นจัดเก็บ' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    acknowledgeAndComplete({ stepId: currentStep(doc.id).id, comment: 'ทราบ', actorUser: teacherUser });
    assert.equal(getDocument(doc.id).status, 'completed');
    assert.throws(
      () => archiveDocument({ documentId: doc.id, actorUser: teacherUser }),
      /เฉพาะผู้บันทึกเอกสารหรือผู้ดูแลระบบ/,
    );
  });

  test('ผู้บันทึกเอกสารเอง และแอดมิน ยังทำได้ตามปกติ', () => {
    const own = makeDoc({ title: 'ของธุรการเอง' });
    voidDocument({ documentId: own.id, reason: 'สร้างผิด', actorUser: registrarUser });
    assert.equal(getDocument(own.id).status, 'voided');

    const other = makeDoc({ title: 'แอดมินจัดการได้' });
    voidDocument({ documentId: other.id, reason: 'แอดมินสั่ง', actorUser: adminUser });
    assert.equal(getDocument(other.id).status, 'voided');
  });
});

// ---- ตัวช่วยสร้างไฟล์ .xlsx ขนาดจิ๋วในเทสต์ (ไม่พึ่ง npm package ตามกติกาโปรเจกต์) ----
// .xlsx = ZIP ของไฟล์ XML จึงประกอบ ZIP เองด้วย zlib + ตาราง CRC32
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0 ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}
function buildZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, textContent] of Object.entries(files)) {
    const nameBuf = Buffer.from(name, 'utf8');
    const raw = Buffer.from(textContent, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    locals.push(lh, nameBuf, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameBuf);
    offset += lh.length + nameBuf.length + comp.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}
const SHEET_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
function makeXlsx(sheetRows, { dateStyle = false, extraSheet = null } = {}) {
  const colLetter = (i) => String.fromCharCode(65 + i);
  const sheetXml = (rows) => `<?xml version="1.0"?><worksheet xmlns="${SHEET_NS}"><sheetData>` +
    rows.map((row, ri) => `<row r="${ri + 1}">` + row.map((v, ci) => {
      const ref = colLetter(ci) + (ri + 1);
      if (typeof v === 'object' && v.serial != null) return `<c r="${ref}" s="1"><v>${v.serial}</v></c>`;
      return `<c r="${ref}" t="inlineStr"><is><t>${String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')}</t></is></c>`;
    }).join('') + '</row>').join('') + '</sheetData></worksheet>';

  const files = {
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns="${SHEET_NS}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>` +
      `<sheet name="Table 1" sheetId="1" r:id="rId1"/>` +
      (extraSheet ? `<sheet name="การอ้างอิงแหล่งข้อมูล" sheetId="2" r:id="rId2"/>` : '') +
      `</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="ws" Target="worksheets/sheet1.xml"/>` +
      (extraSheet ? `<Relationship Id="rId2" Type="ws" Target="worksheets/sheet2.xml"/>` : '') +
      `</Relationships>`,
    'xl/worksheets/sheet1.xml': sheetXml(sheetRows),
  };
  if (dateStyle) {
    files['xl/styles.xml'] = `<?xml version="1.0"?><styleSheet xmlns="${SHEET_NS}"><cellXfs count="2"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"/></cellXfs></styleSheet>`;
  }
  if (extraSheet) files['xl/worksheets/sheet2.xml'] = sheetXml(extraSheet);
  return buildZip(files);
}

const HEADER_ROW = ['ลำดับความสำคัญ', 'ชื่องาน/กิจกรรม', 'สิ่งที่ต้องปฏิบัติ', 'กำหนดการ', 'รายละเอียด/วิธีการ', 'แหล่งที่มา'];

describe('xlsx: อ่านไฟล์ Excel โดยไม่ใช้ npm package', () => {
  test('อ่านข้อความ หลายชีต และถอด XML entity ได้ถูกต้อง', () => {
    const buf = makeXlsx([HEADER_ROW, ['ด่วน', 'งาน A & B', 'ทำ', '1 ก.ย.', '', '1']],
      { extraSheet: [['ดัชนี', 'ข้อมูลอ้างอิง'], ['1', 'เอกสาร.pdf']] });
    const sheets = readWorkbook(buf);
    assert.equal(sheets.length, 2);
    assert.equal(sheets[0].name, 'Table 1');
    assert.equal(sheets[0].rows[1][1], 'งาน A & B');   // &amp; ต้องกลายเป็น & ไม่ใช่ &amp;
    assert.equal(sheets[1].rows[1][1], 'เอกสาร.pdf');
  });

  test('ไฟล์ที่ไม่ใช่ .xlsx ถูกปฏิเสธ ไม่ใช่พังกลางทาง', () => {
    assert.throws(() => readWorkbook(Buffer.from('ไม่ใช่ไฟล์ zip เลย')), /ไม่ใช่ไฟล์ Excel/);
  });

  test('เซลล์วันที่ของ Excel แปลงเป็นวันที่ไทย ไม่ใช่ตัวเลขลำดับวัน', () => {
    // Excel เก็บวันที่เป็นตัวเลข ถ้าไม่แปลง ช่อง "กำหนดการ" จะขึ้นเป็น 46255
    const buf = makeXlsx([HEADER_ROW, ['ด่วน', 'ประชุม', 'เข้าร่วม', { serial: 46255 }, '', '']], { dateStyle: true });
    const schedule = readWorkbook(buf)[0].rows[1][3];
    assert.doesNotMatch(schedule, /^\d+$/, 'ต้องไม่ใช่ตัวเลขดิบ');
    assert.match(schedule, /สิงหาคม/);
    assert.match(schedule, /2569/);
  });
});

describe('สรุปงานรายวัน: แตกไฟล์เป็นรายการ', () => {
  test('ตัดแถวหัวตารางออก แต่ต้องไม่ทิ้งแถวงานจริงที่มีคำว่า "กำหนดการ"/"ชื่องาน"', () => {
    // บั๊กเดิม: ตัวกรองหัวตารางทำงานกับทุกแถว ทำให้งานจริงหายไปเงียบๆ โดยไม่มีใครรู้
    const buf = makeXlsx([
      HEADER_ROW,
      ['ด่วนมาก', 'แจ้งกำหนดการประชุมผู้บริหาร', 'เข้าร่วมประชุม', '20 ส.ค.', '', '1'],
      ['ด่วน', 'ส่งชื่องานวิจัยเข้าประกวด', 'ส่งผลงาน', '31 ส.ค.', '', '2'],
    ]);
    const { items } = parseUploadedWorkbook(buf);
    assert.equal(items.length, 2, 'แถวงานจริงต้องอยู่ครบ ไม่ถูกกรองทิ้ง');
    assert.equal(items[0].task_name, 'แจ้งกำหนดการประชุมผู้บริหาร');
    assert.equal(items[1].task_name, 'ส่งชื่องานวิจัยเข้าประกวด');
  });

  test('ไฟล์ที่ไม่มีแถวหัวตาราง เก็บข้อมูลครบทุกแถว', () => {
    const buf = makeXlsx([['ปกติ', 'งานแรก', 'ทำ', '', '', '']]);
    assert.equal(parseUploadedWorkbook(buf).items.length, 1);
  });

  test('แถวว่างถูกข้าม และไฟล์ที่ไม่มีข้อมูลเลยถูกปฏิเสธ', () => {
    const withBlanks = makeXlsx([HEADER_ROW, ['', '', '', '', '', ''], ['ปกติ', 'งานเดียว', '', '', '', '']]);
    assert.equal(parseUploadedWorkbook(withBlanks).items.length, 1);
    assert.throws(() => parseUploadedWorkbook(makeXlsx([HEADER_ROW])), /ไม่พบรายการงาน/);
  });

  test('อ่านชีตที่ 2 เป็นรายการไฟล์อ้างอิง โดยตัดเฉพาะแถวหัว', () => {
    const buf = makeXlsx([HEADER_ROW, ['ปกติ', 'งาน', '', '', '', '1']],
      { extraSheet: [['ดัชนี', 'ข้อมูลอ้างอิง'], ['1', 'ก.pdf'], ['2', 'ข.pdf']] });
    const { sources } = parseUploadedWorkbook(buf);
    assert.equal(sources.length, 2);
    assert.deepEqual(sources[0], { ref_index: '1', ref_text: 'ก.pdf' });
  });

  test('แถวเกินเพดานถูกปฏิเสธตั้งแต่ตอนอัปโหลด (ไม่ปล่อยให้เข้ามาแล้วแก้ไม่ได้)', () => {
    const many = [HEADER_ROW];
    for (let i = 0; i < 501; i++) many.push(['ปกติ', 'งานที่ ' + i, '', '', '', '']);
    assert.throws(() => parseUploadedWorkbook(makeXlsx(many)), /เกินที่ระบบรองรับ/);
  });

  test('looksLikeHeader ต้องใช้คำตรงกันอย่างน้อย 2 คำ', () => {
    assert.equal(looksLikeHeader(HEADER_ROW), true);
    assert.equal(looksLikeHeader(['ด่วน', 'แจ้งกำหนดการประชุม', '', '', '', '']), false);
  });
});

// หน้าเว็บทั้งหมดพังได้เงียบๆ ถ้าเทมเพลตอ้างตัวแปรผิดชื่อ เพราะ template string จะระเบิดตอน "เรนเดอร์"
// เท่านั้น ไม่ใช่ตอนโหลดไฟล์ — เทสต์เดิมเรียกเฉพาะ service ฝั่งใน จึงไม่เคยแตะหน้าเว็บจริงเลย ผลคือหน้า
// "งานของฉัน" (/tasks) เคย 500 ทุกครั้งที่เปิดกับผู้ใช้ทุกคน โดยเทสต์ทั้งชุดยังเขียวหมด
// ชุดนี้จึงยิงทุกหน้า GET ที่ไม่มีพารามิเตอร์ ด้วยผู้ใช้หลายบทบาท แล้วบังคับว่าต้องไม่ระเบิด
const { router } = await import('../src/router.js');
await import('../src/routes/index.js'); // ลงทะเบียนทุก route เข้ากับ router (ต้องอยู่นอก describe เพราะ import แบบ await)

describe('smoke: ทุกหน้าต้องเปิดได้จริง ไม่ 500', () => {
  function fakeRes() {
    return {
      statusCode: 0, body: '', headers: {}, headersSent: false,
      setHeader(k, v) { this.headers[k] = v; },
      getHeader(k) { return this.headers[k]; },
      writeHead(status, headers) { this.statusCode = status; Object.assign(this.headers, headers || {}); this.headersSent = true; return this; },
      write(chunk) { if (chunk) this.body += chunk; return true; },
      end(chunk) { if (chunk) this.body += chunk; },
      on() {}, once() {},
    };
  }

  async function openPage(pathname, user) {
    const res = fakeRes();
    const url = new URL(`http://test${pathname}`);
    const ctx = {
      req: { method: 'GET', headers: {}, url: pathname }, res, url,
      query: {}, user, body: {}, ip: '127.0.0.1', params: {},
    };
    const handled = await router.dispatch('GET', pathname, ctx);
    // ถ้าไม่ match แปลว่าถอด pattern จาก regex ผิด — ต้องดังตรงนี้ ไม่ใช่ปล่อยให้เทสต์เขียวทั้งที่ไม่ได้ยิงอะไรเลย
    assert.ok(handled, `router ไม่รู้จักหน้า ${pathname}`);
    return res;
  }

  // ผู้ใช้เหมือนที่ getSessionUser คืนออกมา (ข้อมูลผู้ใช้เต็มแถว + roleCodes) เพราะหน้าเว็บใช้ทั้ง
  // user.first_name/prefix (แสดงผล) และ user.roleCodes (แตกกิ่งตามสิทธิ์)
  function userAs(code) {
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(seed.userIds[code]);
    const roleCodes = db.prepare(
      'SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?',
    ).all(row.id).map((r) => r.name);
    return { ...row, roleCodes, roles: roleCodes.map((name) => ({ name })), unreadCount: 0 };
  }

  // ดึงรายการหน้าจาก router เอง ไม่ใช่ลิสต์ที่พิมพ์มือ — หน้าใหม่ที่เพิ่มทีหลังจะถูกคุมอัตโนมัติ
  const SKIP = new Set([
    '/logout',                       // ลบ session ทิ้ง ทำให้เทสต์ที่เหลือใช้ผู้ใช้คนนั้นไม่ได้
    '/admin/google-drive/start',     // เด้งออกไปหา Google
    '/admin/google-drive/callback',  // ต้องมี code จาก Google จริง
  ]);
  const pages = router.routes
    .filter((r) => r.method === 'GET' && r.keys.length === 0)
    // regex.source มี \/ ตาม escape ของ RegExp ต้องถอดกลับเป็น path จริงก่อน
    .map((r) => r.regex.source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\(.)/g, '$1'))
    .filter((p) => !SKIP.has(p));

  // หน้าที่มี :id ในเส้นทาง (หน้ารายละเอียดเอกสาร หน้าใบลา หน้าแก้ไขผู้ใช้ ฯลฯ) ไม่เคยถูกกวาดเลย
  // เพราะเทสต์เดิมกรองเอาเฉพาะเส้นทางที่ไม่มีพารามิเตอร์ — ทั้งที่เป็นหน้าที่ใช้งานหนักที่สุดในระบบ
  // เติม id จริงเข้าไปแล้วกวาดด้วย จะได้ครอบคลุมทั้งหมด (ยกเว้นหน้าที่ส่งไฟล์ ซึ่งไม่ใช่ HTML)
  let detailPages = [];

  test('พบรายการหน้าจาก router (กันกรณี filter ผิดแล้วเทสต์ผ่านเพราะไม่ได้ยิงอะไรเลย)', () => {
    assert.ok(pages.length >= 15, `ควรเจอหน้ามากกว่านี้ แต่เจอ ${pages.length}: ${pages.join(', ')}`);
    assert.ok(pages.includes('/tasks') && pages.includes('/'), pages.join(', '));
  });

  // ทุกเทสต์ในกลุ่มนี้กวาดหน้าเว็บทั้งระบบ ถ้าหน้าไหนยังไม่มีข้อมูลเลย ส่วนที่แสดงเฉพาะเมื่อมีรายการ
  // (ปุ่มลบ ปุ่มยกเลิก แถวในตาราง) จะไม่ถูก render ออกมา แล้วเทสต์จะเขียวทั้งที่ไม่ได้ตรวจส่วนนั้นเลย
  // — พิสูจน์แล้ว: ใส่ชื่อฟังก์ชันผิดในปุ่มยกเลิกการมอบหมาย แต่เทสต์ยังผ่าน เพราะไม่มีการมอบหมายสักรายการ
  before(() => {
    const doc = makeDoc({ title: 'เอกสารตัวอย่างสำหรับกวาดหน้าเว็บ', dueDate: '2026-08-25' });
    assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, instruction: 'เพื่อพิจารณา', actorUser: registrarUser });
    createLeaveRequest({
      requesterId: teacherUser.id, leaveType: 'sick', startDate: '2026-08-24', endDate: '2026-08-26',
      reason: 'ไม่สบาย', approverId: seed.userIds.director01,
    });
    createDelegation({
      delegatorId: seed.userIds.director01, delegateId: teacherUser.id,
      startDate: '2026-08-24', endDate: '2026-08-26', reason: 'ผอ. ไปราชการ', createdBy: seed.userIds.director01,
    });
    db.prepare(`
      INSERT INTO announcements (id, category, title, body, created_by, created_at, updated_at)
      VALUES (?, 'ประกาศ', 'ประกาศตัวอย่างสำหรับกวาดหน้าเว็บ', 'เนื้อหาประกาศ', ?, ?, ?)
    `).run('ann-' + Math.random().toString(36).slice(2), seed.userIds.admin, nowIso(), nowIso());

    // เอกสารฉบับนี้ยังค้างอยู่ที่ ผอ. ปุ่มอนุมัติ/รับทราบ/ไม่อนุมัติ จึงถูก render ออกมาให้ตรวจได้จริง
    // ตอนกวาดในบทบาทของ director01 (ถ้าไม่มีขั้นตอนค้าง ปุ่มพวกนี้จะไม่ขึ้นเลย แล้วเทสต์จะไม่ได้ตรวจ)
    const leaveId = db.prepare('SELECT id FROM leave_requests ORDER BY created_at DESC LIMIT 1').get()?.id;
    detailPages = [
      `/documents/${doc.id}`,
      `/documents/${doc.id}/print`,
      leaveId && `/leave/${leaveId}`,
      `/admin/users/${seed.userIds.teacher001}/edit`,
    ].filter(Boolean);
  });

  for (const code of ['admin', 'director01', 'reg001', 'teacher001']) {
    test(`เปิดทุกหน้าในบทบาทของ ${code} ได้โดยไม่ระเบิด`, async () => {
      const user = userAs(code);
      const broken = [];
      for (const pathname of [...pages, ...detailPages]) {
        try {
          const res = await openPage(pathname, user);
          // 403 ถือว่าถูกต้อง (หน้าเฉพาะแอดมิน) แต่ 500 คือระบบพัง
          if (res.statusCode >= 500) broken.push(`${pathname} -> ${res.statusCode}`);
        } catch (err) {
          broken.push(`${pathname} -> โยน error: ${err.message}`);
        }
      }
      assert.deepEqual(broken, [], `หน้าที่เปิดไม่ได้:\n  ${broken.join('\n  ')}`);
    });
  }

  // สคริปต์ฝั่งเบราว์เซอร์ถูกเขียนอยู่ใน template literal ของฝั่งเซิร์ฟเวอร์ ทำให้พลาดได้ง่ายมาก:
  // \n ในสตริงจะถูกแปลงเป็นการขึ้นบรรทัดจริงตั้งแต่ตอนสร้าง HTML แล้วกลายเป็น SyntaxError ในเบราว์เซอร์
  // ซึ่งทำให้ <script> "ทั้งก้อน" ไม่ทำงานเลย — ปุ่มอื่นที่อยู่ในก้อนเดียวกันตายไปด้วยทั้งหมด
  //
  // เกิดขึ้นจริงมาแล้ว: เพิ่มปุ่ม "รีเซ็ตรหัส" ในหน้าจัดการผู้ใช้ แล้วปุ่มเพิ่มผู้ใช้กับลบผู้ใช้หยุดทำงาน
  // ทั้งคู่ โดยฝั่งเซิร์ฟเวอร์ยังตอบ 200 ปกติ เทสต์ smoke เดิมจึงเขียวสนิท และไม่มีใครรู้จนผู้ใช้มาแจ้ง
  test('สคริปต์ฝั่งเบราว์เซอร์ในทุกหน้าต้องไม่มีไวยากรณ์ผิด', async () => {
    const vm = await import('node:vm');
    const offenders = [];
    for (const code of ['admin', 'director01', 'reg001', 'teacher001']) {
      const user = userAs(code);
      for (const pathname of [...pages, ...detailPages]) {
        const res = await openPage(pathname, user);
        if (!String(res.headers['Content-Type'] || '').includes('text/html')) continue;
        // เอาเฉพาะ <script> ที่มีโค้ดอยู่ในตัว (ไม่ใช่ src=) เพราะนั่นคือส่วนที่ประกอบจากเซิร์ฟเวอร์
        for (const m of res.body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
          try {
            new vm.Script(m[1]);
          } catch (err) {
            const line = (m[1].split('\n')[Number((err.stack.match(/<anonymous>:(\d+)/) || [])[1] || 1) - 1] || '').trim();
            offenders.push(`${pathname} (${code}): ${err.message} — ใกล้ๆ "${line.slice(0, 70)}"`);
          }
        }
      }
    }
    assert.deepEqual([...new Set(offenders)], [],
      `สคริปต์ในหน้าเว็บมีไวยากรณ์ผิด (ปุ่มทั้งก้อนจะไม่ทำงาน):\n  ${[...new Set(offenders)].join('\n  ')}`);
  });

  // ปุ่มที่เรียกฟังก์ชันซึ่งไม่มีอยู่จริง จะ "กดแล้วไม่มีอะไรเกิดขึ้น" เงียบๆ เหมือนกัน — เซิร์ฟเวอร์ตอบ 200
  // ปกติ ไม่มี error อะไรให้เห็นนอกจากใน console ของเบราว์เซอร์ที่ไม่มีใครเปิดดู เกิดได้ง่ายมากเวลาเปลี่ยนชื่อ
  // ฟังก์ชันใน public/app.js แล้วลืมแก้หน้าที่เรียกใช้ หรือพิมพ์ชื่อผิดใน onclick
  test('ทุกปุ่มที่เรียกฟังก์ชันจาก onclick ต้องมีฟังก์ชันนั้นอยู่จริง', async () => {
    const appJs = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const globals = new Set([...appJs.matchAll(/window\.(\w+)\s*=/g)].map((m) => m[1]));
    for (const m of appJs.matchAll(/^\s*function\s+(\w+)/gm)) globals.add(m[1]);
    const BUILTIN = new Set(['alert', 'confirm', 'prompt', 'print', 'open', 'fetch', 'Number', 'String',
      'Boolean', 'Math', 'JSON', 'Date', 'Array', 'Object', 'setTimeout', 'encodeURIComponent',
      'decodeURIComponent', 'parseInt', 'parseFloat', 'if', 'for', 'while', 'switch', 'return', 'catch', 'function']);
    const offenders = [];
    let checked = 0;
    for (const code of ['admin', 'director01', 'reg001', 'teacher001']) {
      const user = userAs(code);
      for (const pathname of [...pages, ...detailPages]) {
        const res = await openPage(pathname, user);
        if (!String(res.headers['Content-Type'] || '').includes('text/html')) continue;
        // ฟังก์ชันที่ประกาศอยู่ในสคริปต์ของหน้านั้นเอง
        const inline = [...res.body.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1]).join('\n');
        const local = new Set([...inline.matchAll(/function\s+(\w+)/g)].map((m) => m[1]));
        for (const m of inline.matchAll(/(?:var|let|const)\s+(\w+)\s*=\s*(?:function|\()/g)) local.add(m[1]);
        for (const m of inline.matchAll(/window\.(\w+)\s*=/g)) local.add(m[1]);

        for (const attr of res.body.matchAll(/\bon(?:click|change|submit|input)="([^"]*)"/g)) {
          for (const call of attr[1].matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
            // เมธอดของออบเจกต์ (a.b()) ไม่ใช่ฟังก์ชันระดับบนสุด ข้ามไป
            if (/[.\w]$/.test(attr[1].slice(0, call.index))) continue;
            checked++;
            const fn = call[1];
            if (BUILTIN.has(fn) || globals.has(fn) || local.has(fn)) continue;
            offenders.push(`${pathname} (${code}): เรียก ${fn}() แต่ไม่มีการประกาศไว้ที่ไหนเลย`);
          }
        }
      }
    }
    assert.ok(checked > 100, `ตรวจน้อยเกินไป (${checked} จุด) — น่าจะดึง onclick ออกมาไม่ได้`);
    assert.deepEqual([...new Set(offenders)], [], `ปุ่มที่กดแล้วจะไม่มีอะไรเกิดขึ้น:\n  ${[...new Set(offenders)].join('\n  ')}`);
  });

  // ฟอร์มหรือ fetch ที่ยิงไปยังเส้นทางที่ไม่มีอยู่จริง ก็เงียบแบบเดียวกัน — ได้ 404 กลับมาแล้วจบ
  // เกิดเวลาเปลี่ยนชื่อเส้นทางฝั่งเซิร์ฟเวอร์แล้วลืมแก้หน้าเว็บที่เรียกใช้
  test('ทุกฟอร์ม/fetch ต้องยิงไปยังเส้นทางที่ router รู้จักจริง', async () => {
    const matchesRoute = (method, path) => router.routes.some((r) => r.method === method && r.regex.test(path));
    const offenders = [];
    const seen = new Set();
    for (const code of ['admin', 'director01', 'reg001', 'teacher001']) {
      const user = userAs(code);
      for (const pathname of [...pages, ...detailPages]) {
        const res = await openPage(pathname, user);
        if (!String(res.headers['Content-Type'] || '').includes('text/html')) continue;
        const targets = [];
        for (const m of res.body.matchAll(/<form[^>]*\baction="(\/[^"'`${}]*)"[^>]*>/g)) {
          targets.push([/method="post"/i.test(m[0]) ? 'POST' : 'GET', m[1].split('?')[0]]);
        }
        // เอาเฉพาะ fetch ที่เป็นสตริงตายตัวล้วน — ที่ต่อสตริงกับตัวแปร (fetch('/x/' + id)) เดา path ไม่ได้
        for (const m of res.body.matchAll(/fetch\(\s*'(\/[^'"`${}]*)'\s*(,|\))/g)) {
          const after = res.body.slice(m.index + m[0].length - 1);
          const method = (after.match(/^\s*,\s*\{[^}]*method\s*:\s*'(\w+)'/) || [])[1] || 'GET';
          targets.push([method.toUpperCase(), m[1].split('?')[0]]);
        }
        for (const [method, path] of targets) {
          const key = `${method} ${path}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (!matchesRoute(method, path)) offenders.push(`${pathname} (${code}) -> ${key}`);
        }
      }
    }
    assert.ok(seen.size > 10, `ตรวจน้อยเกินไป (${seen.size} เส้นทาง)`);
    assert.deepEqual(offenders, [], `ฟอร์ม/fetch ที่ยิงไปยังเส้นทางที่ไม่มีอยู่:\n  ${offenders.join('\n  ')}`);
  });

  // ทั้งระบบใช้ปีพุทธศักราชและชื่อเดือนไทย ถ้าที่ไหนลืมแปลง วันที่ดิบจากฐานข้อมูล (2026-08-25) จะโผล่มา
  // ให้ครูอ่านเอง ซึ่งเป็น ค.ศ. และเรียงคนละแบบ — เคยหลุดมาแล้วทั้งหน้ารายละเอียดเอกสาร หน้าลา
  // หน้ามอบหมายรักษาการแทน และหน้าอายุการเก็บ เพราะไม่มีอะไรคอยจับ
  test('ไม่มีวันที่ดิบแบบ 2026-08-25 หลุดออกมาให้ผู้ใช้เห็น', async () => {
    // ข้อมูลตัวอย่างถูกสร้างไว้ใน before() ของกลุ่มนี้แล้ว
    // Audit Log แสดง detail ดิบของแต่ละเหตุการณ์ตามที่บันทึกไว้ เพื่อใช้สอบทานย้อนหลัง — ตรงนั้น
    // ต้องเป็นค่าดิบจริงๆ ไม่ใช่ค่าที่จัดรูปแบบใหม่ ไม่งั้นหลักฐานไม่ตรงกับที่เก็บ
    const RAW_OK = new Set(['/admin/audit']);
    const offenders = [];
    for (const code of ['admin', 'director01', 'reg001']) {
      const user = userAs(code);
      for (const pathname of [...pages, ...detailPages].filter((p) => !RAW_OK.has(p))) {
        const res = await openPage(pathname, user);
        // ตรวจเฉพาะหน้าเว็บ — /health (JSON) และ /reports/export.csv (เปิดใน Excel) ต้องเป็น ISO
        // ตามรูปแบบที่เครื่องอ่าน ไม่ใช่ พ.ศ. ที่คนอ่าน
        if (!String(res.headers['Content-Type'] || '').includes('text/html')) continue;
        // ตัด <script>/<style> และค่าใน attribute ออกก่อน — <input type="date" value="2026-08-25">
        // ต้องเป็นรูปแบบ ISO จริงๆ ตามสเปกของ HTML ไม่ใช่ของที่ผู้ใช้อ่าน
        const visible = res.body
          .replace(/<script[\s\S]*?<\/script>/g, '')
          .replace(/<style[\s\S]*?<\/style>/g, '')
          .replace(/<[^>]*>/g, '');
        const hit = visible.match(/\d{4}-\d{2}-\d{2}/);
        if (hit) offenders.push(`${pathname} (${code}) -> "${hit[0]}"`);
      }
    }
    assert.deepEqual(offenders, [], `พบวันที่ดิบในหน้าเว็บ:\n  ${offenders.join('\n  ')}`);
  });

  // การแจ้งเตือนเรื่องลา/รักษาการแทน เดิมกดต่อไม่ได้เลย เพราะตารางแจ้งเตือนผูกได้แค่ document_id
  // ต้องไปหาเองในเมนู — ตอนนี้เก็บ link_url ไว้ ปุ่ม "เปิด" จึงขึ้นได้ทุกประเภท
  test('การแจ้งเตือนที่ไม่ใช่เอกสารต้องมีปุ่ม "เปิด" และต้องไม่ยอมให้ลิงก์ออกนอกระบบ', async () => {
    const director = userAs('director01');
    const { id: leaveId } = createLeaveRequest({
      requesterId: teacherUser.id, leaveType: 'vacation', startDate: '2026-09-01', endDate: '2026-09-03',
      reason: 'ลาพักผ่อนประจำปี', approverId: director.id,
    });
    const body = (await openPage('/notifications', director)).body;
    assert.ok(body.includes(`href="/leave/${leaveId}"`), 'ไม่พบปุ่มเปิดที่ลิงก์ไปหน้าใบลา');

    // ถ้าวันหลังมี link_url ที่มาจากค่าของผู้ใช้ ต้องไม่กลายเป็นทางพาผู้ใช้ออกไปเว็บอื่น
    db.prepare('UPDATE notifications SET link_url = ? WHERE link_url = ?')
      .run('https://evil.example.com/phish', `/leave/${leaveId}`);
    const after = (await openPage('/notifications', director)).body;
    assert.ok(!after.includes('evil.example.com'), 'ลิงก์ออกนอกระบบไม่ถูกกรองทิ้ง');
  });
});

// เซิร์ฟเวอร์บน Render รันเป็น UTC ซึ่งช้ากว่าไทย 7 ชั่วโมง ช่วง 00:00-07:00 น. ตามเวลาไทยจึงยังเป็น
// "เมื่อวาน" ในสายตาของทั้ง new Date() และ date('now') ของ SQLite — บั๊กนี้มองไม่เห็นเลยถ้าทดสอบตอน
// กลางวัน จึงต้องมีเทสต์ที่จำลองเวลานั้นตรงๆ ไม่ใช่รอให้ไปเจอเองหน้างานตอนเช้ามืด
// ชื่อไฟล์ภาษาไทยเป็นเรื่องปกติที่โรงเรียนไทย แต่หัว HTTP ของ Node รับได้เฉพาะไบต์ Latin-1 —
// ถ้าเอาชื่อไทยไปต่อใส่ Content-Disposition ตรงๆ Node จะโยน ERR_INVALID_CHAR ตอบ 500 และผู้ใช้
// โหลดไฟล์ไม่ได้เลย (ทดสอบกับระบบจริงแล้วว่าไฟล์แนบของประกาศชื่อ "ประกาศรับสมัครครู.pdf" ได้ 500)
// การทำลายหนังสือราชการเป็นการกระทำที่ย้อนกลับไม่ได้ — ลบไฟล์แนบทิ้งจริง จึงต้องคุมเข้มที่สุดในระบบ
describe('ทำลายหนังสือ: ผู้เสนอกับผู้อนุมัติต้องคนละคน และไฟล์ต้องไม่หายก่อนบันทึกมติ', () => {
  const directorUser = { id: seed.userIds.director01, roleCodes: ['director'] };

  function batchReadyToApprove(actorUser = registrarUser) {
    const doc = makeDoc({ title: 'เอกสารครบกำหนดทำลาย' });
    // ทำให้เป็นหนังสือเก่าจริงๆ ด้วยการย้อน "ปี พ.ศ. ที่ออกเลข" ไม่ใช่ย้อนแค่คอลัมน์วันครบกำหนด —
    // ระบบคิดวันครบกำหนดใหม่จาก year_be + ชั้นอายุการเก็บอีกครั้งก่อนลงมือทำลายจริง (assertStillEligible)
    // ถ้าย้อนแต่คอลัมน์ หนังสือจะกลายเป็น "ยังไม่ครบกำหนดแต่ถูกทำเครื่องหมายว่าครบ" ซึ่งเป็นสภาพที่
    // ระบบตั้งใจปฏิเสธ เพราะการทำลายก่อนกำหนดย้อนคืนไม่ได้
    const oldYearBe = beYear() - 20;
    db.prepare("UPDATE documents SET status = 'completed', year_be = ?, retention_until = ? WHERE id = ?")
      .run(oldYearBe, computeRetentionUntil(oldYearBe, 'normal_10y'), doc.id);
    const batchId = createDestructionBatch({
      documentIds: [doc.id], committeeNames: 'กรรมการ ก\nกรรมการ ข\nกรรมการ ค',
      reason: 'ครบอายุการเก็บ', actorUser,
    });
    return { docId: doc.id, batchId };
  }

  // แอดมินอยู่ทั้งกลุ่มผู้เสนอและกลุ่มผู้อนุมัติ เดิมจึงเสนอเองอนุมัติเองได้ (ทดสอบกับระบบจริงแล้วว่าทำได้)
  // ระเบียบสำนักนายกฯ ว่าด้วยงานสารบรรณกำหนดให้คณะกรรมการเสนอ แล้วหัวหน้าส่วนราชการเป็นผู้พิจารณา
  test('ผู้เสนอบัญชีอนุมัติบัญชีของตัวเองไม่ได้', async () => {
    const { batchId, docId } = batchReadyToApprove(adminUser);
    await assert.rejects(
      () => approveDestructionBatch({ batchId, actorUser: adminUser, note: 'อนุมัติเอง' }),
      /อนุมัติบัญชีของตัวเองไม่ได้/,
    );
    assert.equal(getDocument(docId).status, 'completed', 'เอกสารต้องยังไม่ถูกทำลาย');
  });

  test('ผู้บริหารท่านอื่นอนุมัติได้ตามปกติ', async () => {
    const { batchId, docId } = batchReadyToApprove(registrarUser);
    await approveDestructionBatch({ batchId, actorUser: directorUser, note: 'เห็นชอบให้ทำลาย' });
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(docId);
    assert.equal(doc.status, 'destroyed');
    // เลขทะเบียนต้องยังอยู่เป็นหลักฐานว่าเคยมีหนังสือฉบับนี้ ไม่ใช่ลบทิ้งทั้งแถว
    assert.ok(doc.doc_number_display, 'เลขทะเบียนต้องคงอยู่หลังทำลาย');
  });

  // การอนุมัติคือจุดที่ย้อนกลับไม่ได้ — ไฟล์แนบถูกลบถาวร แต่เดิมตรวจเงื่อนไขแค่ตอน "ตั้งบัญชี" เท่านั้น
  // ระหว่างรออนุมัติ (ของจริงกินเวลาเป็นสัปดาห์กว่าคณะกรรมการจะประชุมและ ผอ. จะลงนาม) สถานะอาจเปลี่ยนไปแล้ว
  describe('ตรวจซ้ำก่อนลงมือทำลายจริง', () => {
    test('ธุรการเปลี่ยนเป็น "เก็บตลอดไป" ระหว่างรออนุมัติ ต้องทำลายไม่ได้', async () => {
      const { batchId, docId } = batchReadyToApprove(registrarUser);
      db.prepare("UPDATE documents SET retention_class = 'permanent', retention_until = NULL WHERE id = ?").run(docId);
      await assert.rejects(() => approveDestructionBatch({ batchId, actorUser: directorUser }), /เก็บตลอดไป/);
      assert.notEqual(db.prepare('SELECT status FROM documents WHERE id = ?').get(docId).status, 'destroyed');
    });

    test('เรื่องกลับมาอยู่ระหว่างดำเนินการระหว่างรออนุมัติ ต้องทำลายไม่ได้', async () => {
      const { batchId, docId } = batchReadyToApprove(registrarUser);
      db.prepare("UPDATE documents SET status = 'in_progress' WHERE id = ?").run(docId);
      await assert.rejects(() => approveDestructionBatch({ batchId, actorUser: directorUser }), /ระหว่างดำเนินการ/);
    });

    // ถ้าคอลัมน์วันครบกำหนดเพี้ยน (นำเข้าข้อมูลผิด/แก้ฐานข้อมูลด้วยมือ) หนังสือที่ต้องเก็บอีกสิบปี
    // จะถูกจัดว่าครบกำหนดแล้วและถูกทำลายทิ้งโดยไม่มีอะไรทัดทาน
    test('คอลัมน์วันครบกำหนดที่เพี้ยนไปต้องไม่ทำให้ทำลายหนังสือก่อนกำหนดได้', async () => {
      const { batchId, docId } = batchReadyToApprove(registrarUser);
      // ทำให้เป็นหนังสือปีปัจจุบัน (ต้องเก็บอีก 10 ปี) แต่คอลัมน์ยังบอกว่าครบกำหนดไปแล้ว
      db.prepare("UPDATE documents SET year_be = ?, retention_class = 'normal_10y', retention_until = '2020-01-01' WHERE id = ?")
        .run(beYear(), docId);
      await assert.rejects(() => approveDestructionBatch({ batchId, actorUser: directorUser }), /ยังไม่ครบกำหนดเก็บ/);
      assert.notEqual(db.prepare('SELECT status FROM documents WHERE id = ?').get(docId).status, 'destroyed',
        'หนังสือที่ยังไม่ครบกำหนดต้องไม่ถูกทำลาย');
    });

    test('หนังสือที่ครบกำหนดจริงยังทำลายได้ตามปกติ', async () => {
      const { batchId, docId } = batchReadyToApprove(registrarUser);
      await approveDestructionBatch({ batchId, actorUser: directorUser });
      assert.equal(db.prepare('SELECT status FROM documents WHERE id = ?').get(docId).status, 'destroyed');
    });
  });

  // ไฟล์ที่ลบทิ้งแล้วเรียกคืนไม่ได้ ถ้าลบระหว่าง transaction แล้ว transaction ล้มจน ROLLBACK
  // ฐานข้อมูลจะกลับไปเหมือนไม่มีอะไรเกิดขึ้น แต่ไฟล์หายไปแล้วจริง กลายเป็นเอกสารที่เปิดไม่ได้โดยไม่มีร่องรอย
  test('ไฟล์แนบต้องถูกลบหลังบันทึกมติแล้วเท่านั้น ไม่ใช่ระหว่าง transaction', () => {
    const src = fs.readFileSync(new URL('../src/services/retention.js', import.meta.url), 'utf8');
    const body = src.match(/export async function approveDestructionBatch[\s\S]*?\n\}/)[0];
    const commitAt = body.indexOf("db.exec('COMMIT')");
    const unlinkAt = body.indexOf('fs.unlinkSync');
    assert.ok(commitAt > 0 && unlinkAt > 0, 'หา COMMIT/unlinkSync ในฟังก์ชันไม่เจอ');
    assert.ok(unlinkAt > commitAt, 'fs.unlinkSync ต้องอยู่หลัง COMMIT ไม่ใช่ก่อน');
  });
});

describe('workflow: กรณีที่ทำให้เรื่องค้างหรือขึ้น error ของโปรแกรมใส่หน้าผู้ใช้', () => {
  // เรื่องจะค้างอยู่กับคนที่ล็อกอินเข้ามาทำงานไม่ได้แล้ว และไม่มีอะไรบอกว่าทำไมงานไม่เดินต่อ
  test('มอบหมายให้บัญชีที่ถูกระงับไม่ได้', () => {
    const doc = makeDoc({ title: 'ทดสอบมอบหมายให้บัญชีที่ถูกระงับ' });
    try {
      db.prepare("UPDATE users SET status = 'suspended' WHERE id = ?").run(teacherUser.id);
      assert.throws(
        () => assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser }),
        /ถูกปิดใช้งาน/,
      );
      assert.equal(getDocument(doc.id).status, 'registered', 'เอกสารต้องไม่ถูกเปลี่ยนสถานะเมื่อมอบหมายไม่สำเร็จ');
    } finally {
      db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(teacherUser.id);
    }
  });

  // เดิมค่าที่ไม่มีตัวตนไปตกที่ FOREIGN KEY constraint ของ SQLite แล้วเด้ง "FOREIGN KEY constraint failed"
  // เป็นภาษาอังกฤษดิบใส่หน้าครู
  test('มอบหมายให้ผู้ใช้ที่ไม่มีตัวตน ได้ข้อความภาษาไทย ไม่ใช่ error ของฐานข้อมูล', () => {
    const doc = makeDoc({ title: 'ทดสอบมอบหมายให้คนที่ไม่มีจริง' });
    assert.throws(
      () => assignStep({ documentId: doc.id, assigneeId: 'ไม่มีคนนี้', actorUser: registrarUser }),
      /ไม่พบผู้รับงาน/,
    );
  });

  // ส่งต่อให้ตัวเองแล้วเรื่องวนกลับมาที่เดิม ดูเหมือนกดแล้วไม่มีอะไรเกิดขึ้น
  test('ส่งต่อให้ตัวเองไม่ได้ ต้องบอกให้ไปกดรับทราบ/ปิดเรื่องแทน', () => {
    const doc = makeDoc({ title: 'ทดสอบส่งต่อให้ตัวเอง' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    const step = currentStep(doc.id);
    assert.throws(
      () => approveAndForward({ stepId: step.id, nextAssigneeId: teacherUser.id, actorUser: teacherUser }),
      /ส่งต่อให้ตัวเองไม่ได้/,
    );
    assert.equal(currentStep(doc.id).id, step.id, 'ขั้นตอนเดิมต้องยังค้างอยู่เหมือนเดิม');
  });

  // ผู้รับงานเปิดหน้าค้างไว้ ระหว่างนั้นแอดมินลบเอกสาร พอกดปุ่มจะได้ 500 พร้อมข้อความ
  // "Cannot read properties of undefined (reading 'created_by')" โผล่ใส่หน้าครู
  test('กดดำเนินการหลังเอกสารถูกลบ ต้องได้ข้อความที่อ่านรู้เรื่อง ไม่ใช่ error ของโปรแกรม', async () => {
    const doc = makeDoc({ title: 'ทดสอบดำเนินการหลังเอกสารถูกลบ' });
    assignStep({ documentId: doc.id, assigneeId: teacherUser.id, actorUser: registrarUser });
    const step = currentStep(doc.id);
    await forceDeleteDocument({ documentId: doc.id, reason: 'ทดสอบ', actorUser: adminUser });

    for (const [ชื่อ, fn] of [
      ['รับทราบ/ปิดเรื่อง', () => acknowledgeAndComplete({ stepId: step.id, actorUser: teacherUser })],
      ['อนุมัติและส่งต่อ', () => approveAndForward({ stepId: step.id, nextAssigneeId: adminUser.id, actorUser: teacherUser })],
      ['ไม่อนุมัติ', () => rejectStep({ stepId: step.id, reason: 'ทดสอบ', actorUser: teacherUser })],
      ['ส่งกลับแก้ไข', () => returnStep({ stepId: step.id, reason: 'ทดสอบ', actorUser: teacherUser })],
    ]) {
      assert.throws(fn, /ถูกลบออกจากระบบไปแล้ว/, `ปุ่ม "${ชื่อ}" ยังไม่ได้จัดการกรณีเอกสารถูกลบ`);
    }
  });
});

describe('เซสชัน: เปลี่ยนรหัสผ่าน/ระงับบัญชี ต้องมีผลกับเครื่องที่เปิดค้างอยู่ทันที', () => {
  const cookieOf = (signed) => `esaraban_sid=${encodeURIComponent(signed)}`;

  function twoSessions(code, pass) {
    const a = login(code, pass, '127.0.0.1', 'เครื่อง ก');
    const b = login(code, pass, '127.0.0.1', 'เครื่อง ข');
    assert.ok(a.ok && b.ok, 'ต้องล็อกอินได้ทั้งสองเครื่องก่อน');
    return [a, b];
  }

  // คนเปลี่ยนรหัสผ่านเพราะกลัวรหัสรั่ว ถ้าเซสชันเดิมยังใช้ได้ต่ออีก 8 ชั่วโมงตามอายุคุกกี้
  // การเปลี่ยนรหัสก็ไม่ได้แก้ปัญหาที่ตั้งใจจะแก้ (ทดสอบกับระบบจริงแล้วว่าเซสชันเดิมยังเปิดหน้าได้จริง)
  test('เปลี่ยนรหัสผ่านแล้ว เครื่องอื่นถูกเตะออก แต่เครื่องที่กำลังใช้อยู่ยังอยู่', () => {
    const [other, current] = twoSessions('vicedir01', pw('vicedir01'));
    assert.ok(getSessionUser(cookieOf(other.cookie)), 'ก่อนเปลี่ยนรหัส เครื่องอื่นต้องยังใช้ได้');

    const me = getSessionUser(cookieOf(current.cookie));
    const revoked = revokeOtherSessions(me.id, me.sessionId);

    assert.ok(revoked >= 1, 'ต้องตัดเซสชันอื่นออกอย่างน้อยหนึ่งเครื่อง');
    assert.equal(getSessionUser(cookieOf(other.cookie)), null, 'เครื่องอื่นต้องใช้ไม่ได้แล้ว');
    assert.ok(getSessionUser(cookieOf(current.cookie)), 'เครื่องที่กำลังใช้อยู่ต้องไม่ถูกเตะออกไปด้วย');
  });

  // ครูที่ย้ายออกไปแล้ว/ถูกระงับบัญชี ต้องใช้งานไม่ได้ทันที ไม่ใช่ใช้ต่อได้จนเซสชันหมดอายุเอง
  // login() กันไว้อยู่แล้ว แต่เซสชันที่เปิดค้างอยู่ก่อนหน้านั้นรอดมาได้
  test('บัญชีที่ถูกระงับ ใช้เซสชันเดิมต่อไม่ได้', () => {
    const s = login('head_acad', pw('head_acad'), '127.0.0.1', 'เครื่องเดิม');
    assert.ok(s.ok, 'ต้องล็อกอินได้ก่อน');
    assert.ok(getSessionUser(cookieOf(s.cookie)), 'ตอนบัญชียังปกติต้องใช้ได้');
    try {
      db.prepare("UPDATE users SET status = 'suspended' WHERE employee_code = 'head_acad'").run();
      assert.equal(getSessionUser(cookieOf(s.cookie)), null, 'บัญชีถูกระงับแล้วต้องใช้เซสชันเดิมต่อไม่ได้');
    } finally {
      db.prepare("UPDATE users SET status = 'active' WHERE employee_code = 'head_acad'").run();
    }
  });
});

describe('ดาวน์โหลดไฟล์: ชื่อไฟล์ภาษาไทยต้องไม่ทำให้หัว HTTP พัง', () => {
  test('contentDispositionHeader ให้ค่าที่ใส่ในหัว HTTP ได้จริง', () => {
    const header = contentDispositionHeader('ประกาศรับสมัครครู.pdf');
    // ถ้ามีไบต์นอก Latin-1 หลงเหลือ Node จะปฏิเสธตอน writeHead
    assert.ok(!/[^\x00-\xFF]/.test(header), `ยังมีอักขระที่ใส่ในหัว HTTP ไม่ได้: ${header}`);
    assert.match(header, /filename\*=UTF-8''/, 'ต้องแนบชื่อจริงแบบ UTF-8 มาด้วย');
    assert.ok(header.includes(encodeURIComponent('ประกาศรับสมัครครู.pdf')), 'ชื่อไฟล์จริงต้องอยู่ในหัว');
  });

  test('ชื่อไทยล้วนต้องได้ชื่อสำรองที่ใช้ได้จริง ไม่ใช่เหลือแค่ ".pdf"', () => {
    // ตัดอักขระไทยออกจาก "ประกาศ.pdf" จะเหลือ ".pdf" ซึ่งบนเครื่องผู้ใช้กลายเป็นไฟล์ซ่อนไม่มีชื่อ
    const header = contentDispositionHeader('ประกาศ.pdf', 'announcement.pdf');
    assert.match(header, /filename="announcement\.pdf"/, `ควรถอยไปใช้ชื่อสำรอง แต่ได้: ${header}`);
    // ชื่อที่มีตัวอักษร ASCII ปนอยู่ ต้องเก็บส่วนนั้นไว้ ไม่ใช่ทิ้งไปใช้ชื่อสำรองทั้งหมด
    assert.match(contentDispositionHeader('รายงาน-PA-2569.pdf'), /filename="-PA-2569\.pdf"/);

    // ชื่อไทยที่มีแต่ "ตัวเลข" ปนอยู่ (ปี พ.ศ.) เคยผ่านการตรวจแบบเดิมแล้วได้ชื่อสำรองที่บอกอะไรไม่ได้เลย
    // อย่าง "-2569.csv" (ขึ้นต้นด้วยขีดจนดูเหมือนไฟล์เสีย) หรือ "2569.pdf" — ตัวเลขอย่างเดียวไม่พอ
    assert.match(contentDispositionHeader('รายงานหนังสือ-2569.csv', 'documents-report-2569.csv', 'attachment'),
      /filename="documents-report-2569\.csv"/, 'ชื่อไทยที่มีแต่ตัวเลขปน ต้องถอยไปใช้ชื่อสำรอง');
    assert.match(contentDispositionHeader('ประกาศ2569.pdf', 'announcement.pdf'), /filename="announcement\.pdf"/);
  });

  // อักษรไทยหนึ่งตัวกลายเป็น 9 ไบต์เมื่อ percent-encode ชื่อไฟล์ไทย 3,000 ตัวจึงได้หัว HTTP 27KB
  // ซึ่งเกินเพดาน 16KB ของ Node — วัดจริงแล้วการดาวน์โหลดล้มที่ระดับโปรโตคอล (UND_ERR_HEADERS_OVERFLOW)
  // ไม่ใช่ขึ้นข้อความบอกผู้ใช้ แปลว่าไฟล์แนบฉบับนั้นเปิดไม่ได้อีกเลยและไม่มีอะไรบอกว่าทำไม
  test('ชื่อไฟล์ยาวต้องไม่ทำให้หัว HTTP ล้นจนดาวน์โหลดไม่ได้', async () => {
    const http = await import('node:http');
    const header = contentDispositionHeader('ก'.repeat(3000) + '.pdf');
    assert.ok(Buffer.byteLength(header) < http.default.maxHeaderSize / 4,
      `หัวยาว ${Buffer.byteLength(header)} ไบต์ เทียบกับเพดาน ${http.default.maxHeaderSize}`);
    assert.match(header, /\.pdf"/, 'ต้องยังเหลือนามสกุลไฟล์ไว้');
  });

  test('ตัดชื่อไฟล์แล้วต้องยังเหลือนามสกุลเดิม', () => {
    assert.equal(truncateFilename('สั้น.pdf'), 'สั้น.pdf', 'ชื่อปกติต้องไม่ถูกแตะ');
    const cut = truncateFilename('ก'.repeat(500) + '.xlsx');
    assert.equal(cut.length, MAX_HEADER_FILENAME_CHARS);
    assert.ok(cut.endsWith('.xlsx'), `ต้องเก็บนามสกุลไว้ ได้: ${cut.slice(-10)}`);
    // ชื่อที่ไม่มีนามสกุล และชื่อที่จุดอยู่ไกลจนไม่ใช่นามสกุล ต้องไม่พัง
    assert.equal(truncateFilename('ก'.repeat(500)).length, MAX_HEADER_FILENAME_CHARS);
    assert.equal(truncateFilename('ก'.repeat(300) + '.' + 'ข'.repeat(300)).length, MAX_HEADER_FILENAME_CHARS);
  });

  test('Node ยอมรับหัวนี้จริง ไม่ใช่แค่ผ่าน regex', async () => {
    const http = await import('node:http');
    const header = contentDispositionHeader('ประกาศรับสมัครครู.pdf');
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Disposition': header });
      res.end('ok');
    });
    await new Promise((r) => server.listen(0, r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-disposition'), header);
    } finally {
      server.close();
    }
  });

  // ทุกเส้นทางที่ส่งไฟล์ต้องใช้ helper ตัวเดียวกัน — บั๊กนี้เกิดเพราะหน้าประกาศประกอบหัวนี้เองแยกจาก
  // หน้าเอกสาร แล้วลืมเรื่องภาษาไทยไป
  test('ไม่มีเส้นทางไหนประกอบ Content-Disposition เองอีก', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.js') || e.name === 'router.js') continue;
        fs.readFileSync(full, 'utf8').split('\n').forEach((line) => {
          // ยอมให้เขียนตรงๆ ได้เฉพาะกรณีชื่อไฟล์เป็นค่าคงที่ ASCII ที่เราตั้งเอง (เช่น รายงาน CSV)
          if (line.includes('Content-Disposition') && !line.includes('contentDispositionHeader')
              && !/filename="[\x20-\x7E]*"'?\s*\}?\s*\);?\s*$/.test(line.trim())) {
            offenders.push(`${e.name}: ${line.trim().slice(0, 90)}`);
          }
        });
      }
    };
    walk(new URL('../src/', import.meta.url).pathname);
    assert.deepEqual(offenders, [], `ประกอบหัวเอง เสี่ยงพังกับชื่อไฟล์ภาษาไทย:\n  ${offenders.join('\n  ')}`);
  });
});

describe('เวลา: "วันนี้" ต้องคิดตามเวลาไทยเสมอ ไม่ใช่เวลาเครื่องเซิร์ฟเวอร์', () => {
  test('ตอนเช้ามืดของไทย ยังต้องได้วันที่ของวันนั้น ไม่ใช่เมื่อวาน', () => {
    const RealDate = Date;
    // 06:00 น. วันที่ 21 ส.ค. ที่กรุงเทพ = 23:00 UTC ของวันที่ 20 ส.ค.
    const frozen = new RealDate('2026-08-21T06:00:00+07:00');
    globalThis.Date = class extends RealDate {
      constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(frozen); }
      static now() { return frozen.getTime(); }
    };
    try {
      assert.equal(frozen.toISOString().slice(0, 10), '2026-08-20', 'ยืนยันว่าเวลานี้ UTC ยังเป็นเมื่อวานจริง');
      assert.equal(todayInBangkok(), '2026-08-21', 'todayInBangkok ต้องคืนวันที่ตามเวลาไทย');
      // หนังสือที่ครบกำหนดวันนั้นพอดี ต้องขึ้นว่า "ครบกำหนดวันนี้" ไม่ใช่ "เลยกำหนด 1 วัน"
      assert.equal(daysUntil('2026-08-21'), 0);
      assert.equal(daysUntil('2026-08-20'), -1);
    } finally {
      globalThis.Date = RealDate;
    }
  });

  // เลขทะเบียนหนังสือผูกกับปี พ.ศ. ถ้าคิดปีจากเวลาเซิร์ฟเวอร์ หนังสือที่ลงทะเบียนเช้ามืดวันที่ 1 มกราคม
  // จะได้เลขของปีที่แล้ว ไปชนกับเลขที่ออกไปเมื่อปีก่อนพอดี ซึ่งแก้ย้อนหลังในทะเบียนหนังสือยากมาก
  test('ปี พ.ศ. ของเลขทะเบียน คิดตามเวลาไทย แม้เป็นเช้ามืดวันปีใหม่', () => {
    const RealDate = Date;
    // 01:00 น. วันที่ 1 ม.ค. 2027 ที่กรุงเทพ = 18:00 UTC ของวันที่ 31 ธ.ค. 2026
    const frozen = new RealDate('2027-01-01T01:00:00+07:00');
    globalThis.Date = class extends RealDate {
      constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(frozen); }
      static now() { return frozen.getTime(); }
    };
    try {
      assert.equal(frozen.getUTCFullYear(), 2026, 'ยืนยันว่าเวลานี้ UTC ยังเป็นปีที่แล้วจริง');
      assert.equal(beYear(), 2570, 'ต้องได้ปี พ.ศ. ใหม่ (2027 + 543) ไม่ใช่ 2569');
    } finally {
      globalThis.Date = RealDate;
    }
  });

  // เครื่องบนคลาวด์ (ทั้ง Render และ Oracle Cloud) ตั้งเป็น UTC มาจากโรงงาน ถ้า format วันเวลาโดยไม่ระบุ
  // timeZone เวลาที่ผู้ใช้เห็นจะช้ากว่าความจริง 7 ชั่วโมงทั้งระบบ — รวมถึง "เวลา" ที่ประทับลงตรารับ
  // ในไฟล์ PDF ของหนังสือราชการ (บ่ายสามครึ่งกลายเป็น 08:30 บนเอกสารจริง)
  test('เวลาที่แสดงและที่ประทับลงเอกสาร เป็นเวลาไทยเสมอ ไม่ขึ้นกับโซนเวลาเครื่อง', () => {
    const bangkokAfternoon = new Date('2026-08-21T15:30:00+07:00');
    assert.match(fmtDate(bangkokAfternoon.toISOString()), /15:30/, 'เวลาที่แสดงต้องเป็นเวลาไทย');
    assert.equal(stampTimeThai(bangkokAfternoon), '15:30', 'เวลาบนตราประทับต้องเป็นเวลาไทย');
    assert.match(stampDateThai(bangkokAfternoon), /21/, 'วันที่บนตราประทับต้องเป็นวันไทย');
    assert.equal(bangkokHour(bangkokAfternoon), 15, 'คำทักทายต้องอิงชั่วโมงตามเวลาไทย');

    // ช่วงหัวค่ำของไทยยังเป็น "วันเดิม" ทั้งที่ UTC ข้ามไปวันใหม่แล้ว
    const lateEvening = new Date('2026-08-21T23:30:00+07:00');
    assert.equal(lateEvening.toISOString().slice(0, 10), '2026-08-21');
    assert.equal(bangkokHour(lateEvening), 23);
    // และเช้ามืดของไทยยังเป็นวันใหม่แล้ว ทั้งที่ UTC ยังเป็นเมื่อวาน
    const earlyMorning = new Date('2026-08-22T06:00:00+07:00');
    assert.equal(earlyMorning.toISOString().slice(0, 10), '2026-08-21', 'ยืนยันว่า UTC ยังเป็นเมื่อวานจริง');
    assert.match(fmtThaiDateShort(earlyMorning.toISOString()), /22/, 'ต้องแสดงเป็นวันที่ 22 ตามเวลาไทย');
  });

  // ค่าที่เป็น "วันที่ล้วน" เช่น วันครบกำหนด ไม่ใช่จุดเวลา ห้ามถูกแปลงโซนเวลาจนวันเลื่อน
  test('วันที่ล้วน (YYYY-MM-DD) แสดงตรงตามที่บันทึกไว้เสมอ ไม่เลื่อนวัน', () => {
    assert.match(fmtThaiDateShort('2026-08-25'), /25/);
    assert.match(fmtThaiDateLong('2026-01-01'), /1 มกราคม/);
    assert.match(fmtThaiDateLong('2026-12-31'), /31 ธันวาคม/);
  });

  test('ไม่มีที่ไหน format วันเวลาโดยไม่ระบุ timeZone (นอกจาก helper กลางใน render.js)', () => {
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        // render.js เป็นที่รวม helper และระบุ timeZone ไว้ในตัวแล้ว
        if (!e.name.endsWith('.js') || e.name === 'render.js') continue;
        fs.readFileSync(full, 'utf8').split('\n').forEach((line) => {
          // สคริปต์ที่รันในเบราว์เซอร์ผู้ใช้ใช้เวลาเครื่องผู้ใช้ได้ตามปกติ (ครูอยู่ไทยอยู่แล้ว)
          if (/toLocale(String|DateString|TimeString)\(/.test(line) && !line.includes('timeZone') && !line.includes('en-CA')) {
            offenders.push(`${e.name}: ${line.trim().slice(0, 90)}`);
          }
        });
      }
    };
    walk(new URL('../src/', import.meta.url).pathname);
    assert.deepEqual(offenders, [], `format วันเวลาโดยไม่ระบุโซนเวลา:\n  ${offenders.join('\n  ')}`);
  });

  test('ไม่มีที่ไหนใช้ date(\'now\') ของ SQLite อีก (นั่นคือ UTC เสมอ แก้ด้วย TZ ไม่ได้)', () => {
    const srcDir = new URL('../src/', import.meta.url).pathname;
    const offenders = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.js')) continue;
        // db.js อธิบายเรื่องนี้ไว้ในคอมเมนต์ จึงมีคำนี้ปรากฏได้
        if (e.name === 'db.js') continue;
        for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
          if (line.includes("date('now')")) offenders.push(`${e.name}: ${line.trim().slice(0, 80)}`);
        }
      }
    };
    walk(srcDir);
    assert.deepEqual(offenders, [], `ยังมีการใช้ date('now'):\n  ${offenders.join('\n  ')}`);
  });
});

describe('ลา/ไปราชการ: สิทธิ์ต้องบังคับฝั่งเซิร์ฟเวอร์ ไม่ใช่แค่ซ่อนตัวเลือกในหน้าเว็บ', () => {
  const directorUser = { id: seed.userIds.director01, roleCodes: ['director'] };

  function newLeave(overrides = {}) {
    return createLeaveRequest({
      requesterId: teacherUser.id, leaveType: 'personal', ...nextLeaveWindow(2),
      reason: 'ธุระส่วนตัว', approverId: directorUser.id, ...overrides,
    });
  }

  // หน้าเว็บตัดตัวเองออกจากรายการผู้อนุมัติอยู่แล้ว แต่ก่อนหน้านี้เซิร์ฟเวอร์ไม่ได้ตรวจซ้ำ — ยิงคำขอตรง
  // เข้ามาโดยใส่ id ตัวเองเป็นผู้อนุมัติ แล้วกดอนุมัติใบลาตัวเองได้จริง (ทดสอบกับระบบที่รันอยู่แล้วผ่าน)
  test('ตั้งตัวเองเป็นผู้อนุมัติไม่ได้', () => {
    assert.throws(() => newLeave({ approverId: teacherUser.id }), /เลือกตัวเองเป็นผู้อนุมัติ/);
  });

  test('ต่อให้ใบลาเก่าตั้งผู้อนุมัติเป็นตัวเองไว้ ก็ยังกดอนุมัติเองไม่ได้', () => {
    const { id } = newLeave();
    // จำลองใบลาที่ค้างมาจากก่อนแก้บั๊ก (ผู้ขอ = ผู้อนุมัติ)
    db.prepare('UPDATE leave_requests SET approver_id = ? WHERE id = ?').run(teacherUser.id, id);
    assert.throws(() => approveLeaveRequest({ id, note: 'อนุมัติเอง', actorUser: teacherUser }), /พิจารณาคำขอของตัวเองไม่ได้/);
    assert.throws(() => rejectLeaveRequest({ id, note: 'ไม่อนุมัติเอง', actorUser: teacherUser }), /พิจารณาคำขอของตัวเองไม่ได้/);
    assert.equal(getLeaveRequest(id).status, 'pending');
  });

  test('แอดมินก็พิจารณาใบลาของตัวเองไม่ได้', () => {
    const { id } = newLeave({ requesterId: adminUser.id, approverId: directorUser.id });
    assert.throws(() => approveLeaveRequest({ id, actorUser: adminUser }), /พิจารณาคำขอของตัวเองไม่ได้/);
  });

  // เหตุผลการลามีข้อมูลส่วนตัว (อาการป่วย) และมีเบอร์ติดต่อ — เดิมหน้า /leave/:id ไม่ตรวจสิทธิ์เลย
  // ใครล็อกอินได้ก็เปิดดูใบลาของทุกคนได้ ถ้ารู้ id
  test('คนนอกเรื่องเปิดดูใบลาของคนอื่นไม่ได้ แต่ผู้เกี่ยวข้องดูได้', () => {
    const { id } = newLeave({ delegateId: registrarUser.id });
    const req = getLeaveRequest(id);
    assert.equal(canSeeLeaveRequest(req, teacherUser), true, 'ผู้ขอต้องดูได้');
    assert.equal(canSeeLeaveRequest(req, directorUser), true, 'ผู้อนุมัติต้องดูได้');
    assert.equal(canSeeLeaveRequest(req, registrarUser), true, 'ผู้รักษาการแทนที่ถูกระบุต้องดูได้');
    assert.equal(canSeeLeaveRequest(req, adminUser), true, 'แอดมินต้องดูได้');
    // ใช้ผู้ใช้จริงที่มีอยู่ในระบบ ไม่ใช่ id สมมติ — และจงใจเลือกรองผู้อำนวยการ เพื่อยืนยันว่าแม้เป็น
    // ผู้บริหารก็ยังไม่เห็นเหตุผลการลาของครู ถ้าไม่ได้เป็นผู้อนุมัติหรือผู้รักษาการแทนของใบนั้น
    const viceId = seed.userIds.vicedir01;
    assert.ok(viceId, 'ไม่พบผู้ใช้ vicedir01 ในข้อมูลตั้งต้น');
    assert.equal(canSeeLeaveRequest(req, { id: viceId, roleCodes: ['vice_director'] }), false, 'คนนอกเรื่องต้องดูไม่ได้');
  });

  // ค่ามั่วต้องได้ข้อความภาษาไทยที่อ่านรู้เรื่อง ไม่ใช่ "FOREIGN KEY constraint failed" จาก SQLite
  // และในฐานข้อมูลที่อัปเกรดมา คอลัมน์ delegate_id ไม่มี FK ค่ามั่วจะผ่านเข้ามาแล้วไปพังตอนอนุมัติ
  test('ผู้อนุมัติ/ผู้รักษาการแทนที่ไม่มีตัวตน ถูกปฏิเสธพร้อมข้อความภาษาไทย', () => {
    assert.throws(() => newLeave({ approverId: 'ไม่มีคนนี้' }), /ไม่พบผู้อนุมัติ/);
    assert.throws(() => newLeave({ delegateId: 'ไม่มีคนนี้' }), /ไม่พบผู้รักษาการแทน/);
  });
});

// นำเข้ารายชื่อครูทีเดียว 30-50 คนตอนเปิดใช้ระบบครั้งแรก — ถ้าสร้างบัญชีผิดแล้วต้องมาไล่ลบทีหลัง
// เจ็บปวดกว่าตรวจก่อนมาก ตรรกะการตรวจจึงแยกเป็นฟังก์ชันล้วนๆ และต้องมีเทสต์คุมทุกกรณีที่พลาดได้
describe('นำเข้ารายชื่อบุคลากรจาก Excel/CSV', () => {
  const departments = [{ id: 'd1', name: 'กลุ่มบริหารวิชาการ' }];
  const roles = [{ id: 'r1', name: 'teacher', name_th: 'ครู' }, { id: 'r2', name: 'registrar', name_th: 'เจ้าหน้าที่ธุรการ' }];

  test('อ่าน CSV ที่ Excel บันทึกมา (มี BOM, ขึ้นบรรทัดแบบ CRLF, มีเครื่องหมายคำพูด)', async () => {
    const { readTable } = await import('../src/services/userImport.js');
    const csv = '﻿รหัสประจำตัว,ชื่อ,นามสกุล\r\nkru01,"สมชาย, ก.",ใจดี\r\n';
    const rows = readTable(Buffer.from(csv, 'utf8'), 'ครู.csv');
    assert.equal(rows[0][0], 'รหัสประจำตัว', 'ต้องตัด BOM ออก ไม่งั้นหัวคอลัมน์แรกจับคู่ไม่ติด');
    assert.deepEqual(rows[1], ['kru01', 'สมชาย, ก.', 'ใจดี'], 'ต้องอ่านค่าที่มีลูกน้ำในเครื่องหมายคำพูดได้');
  });

  test('แยกแถวดี/ซ้ำ/ผิด ออกจากกันได้ถูกต้อง และข้ามแถวว่าง', async () => {
    const { planUserImport } = await import('../src/services/userImport.js');
    const rows = [
      ['รหัสประจำตัว', 'คำนำหน้า', 'ชื่อ', 'นามสกุล', 'ฝ่าย', 'บทบาท'],
      ['kru01', 'นาย', 'สมชาย', 'ใจดี', 'กลุ่มบริหารวิชาการ', 'ครู'],
      ['kru02', 'นางสาว', 'สมหญิง', 'ตั้งใจ', '', ''],           // ไม่ระบุบทบาท -> ครู
      ['มีอยู่แล้ว', 'นาย', 'ซ้ำ', 'ของเดิม', '', 'ครู'],
      ['kru01', 'นาย', 'ซ้ำในไฟล์', 'เอง', '', 'ครู'],
      ['kru03', '', '', '', '', ''],                              // ข้อมูลไม่ครบ
      ['kru04', 'นาง', 'ฝ่าย', 'ไม่มี', 'ฝ่ายที่ไม่มีจริง', 'ครู'],
      ['kru05', 'นาย', 'บทบาท', 'ไม่มี', '', 'ผู้วิเศษ'],
      ['', '', '', '', '', ''],                                    // แถวว่างล้วน ต้องข้ามเงียบๆ
    ];
    const plan = planUserImport(rows, { departments, roles, existingCodes: ['มีอยู่แล้ว'] });
    assert.deepEqual(plan.summary, { ok: 2, skip: 1, error: 4 });
    assert.deepEqual(plan.items.map((i) => i.status), ['ok', 'ok', 'skip', 'error', 'error', 'error', 'error']);
    assert.match(plan.items[2].reason, /มีรหัสประจำตัวนี้ในระบบอยู่แล้ว/);
    assert.match(plan.items[3].reason, /ซ้ำกับแถวก่อนหน้าในไฟล์เดียวกัน/);
    assert.match(plan.items[5].reason, /ไม่พบฝ่าย/);
    assert.match(plan.items[6].reason, /ไม่พบบทบาท/);
    // ไม่ระบุบทบาทต้องได้ "ครู" เป็นค่าตั้งต้น ไม่ใช่ error
    assert.equal(plan.items[1].roleId, 'r1');
    // เลขแถวต้องตรงกับที่เห็นใน Excel จริง ไม่งั้นแอดมินหาแถวที่ผิดไม่เจอ
    assert.deepEqual(plan.items.map((i) => i.rowNumber), [2, 3, 4, 5, 6, 7, 8]);
  });

  test('หัวตารางที่ตั้งชื่อต่างกันเล็กน้อยต้องยังจับคู่ได้ และบอกให้รู้ถ้าขาดคอลัมน์บังคับ', async () => {
    const { planUserImport, mapHeaders } = await import('../src/services/userImport.js');
    const m = mapHeaders(['รหัส', 'ชื่อ', 'สกุล', 'สังกัด', 'สิทธิ์']);
    assert.equal(m.employeeCode, 0);
    assert.equal(m.lastName, 2);
    assert.equal(m.department, 3);
    assert.equal(m.role, 4);
    assert.throws(() => planUserImport([['ชื่อ', 'นามสกุล'], ['ก', 'ข']], { departments, roles, existingCodes: [] }),
      /หาหัวตารางไม่เจอ|ไม่พบคอลัมน์/);
  });

  test('รหัสผ่านและ PIN ที่สุ่มให้ต้องใช้ได้จริงและไม่ซ้ำกัน', async () => {
    const { generatePassword, generatePin } = await import('../src/services/userImport.js');
    const pins = new Set();
    const pws = new Set();
    for (let i = 0; i < 200; i++) { pins.add(generatePin()); pws.add(generatePassword()); }
    assert.ok(pws.size > 190, 'รหัสผ่านต้องไม่ซ้ำกันเป็นกลุ่มก้อน');
    assert.ok(pins.size > 150, 'PIN ต้องกระจายตัว');
    assert.ok([...pins].every((p) => /^\d{6}$/.test(p)), 'PIN ต้องเป็นตัวเลข 6 หลักเสมอ (ระบบใช้ยืนยันการลงนาม)');
    // ตัดอักขระที่อ่านสับสน (0/O/1/l/I) ออก เพราะแอดมินต้องพิมพ์แจกครูด้วยมือ
    assert.ok([...pws].every((p) => !/[0O1lI]/.test(p)), 'รหัสผ่านต้องไม่มีอักขระที่อ่านสับสน');
  });

  // users.email เป็น UNIQUE ในฐานข้อมูล แต่ผู้วางแผนนำเข้าไม่เคยตรวจช่องนี้เลย ผลคือหน้าตรวจไฟล์
  // บอกว่า "นำเข้าได้ 40 คน" แล้วพอกดยืนยันจริงได้ error 500 "UNIQUE constraint failed: users.email"
  // ภาษาอังกฤษดิบๆ โดยไม่บอกว่าแถวไหนผิด (ยืนยันกับระบบที่รันอยู่แล้ว)
  describe('อีเมลซ้ำต้องถูกจับตั้งแต่ตอนตรวจไฟล์ ไม่ใช่ไประเบิดตอนบันทึกจริง', () => {
    const header = ['รหัสประจำตัว', 'ชื่อ', 'นามสกุล', 'อีเมล'];
    const plan = (rows, opts = {}) => planUserImport([header, ...rows],
      { departments, roles, existingCodes: [], existingEmails: [], ...opts });

    test('อีเมลซ้ำกันเองในไฟล์เดียวกัน', () => {
      const p = plan([['a1', 'ก', 'ข', 'same@s.ac.th'], ['a2', 'ค', 'ง', 'same@s.ac.th']]);
      assert.equal(p.summary.ok, 1, 'แถวแรกยังนำเข้าได้');
      assert.equal(p.summary.error, 1);
      assert.match(p.items[1].reason, /ซ้ำกับแถวก่อนหน้า/);
    });

    test('อีเมลที่มีผู้ใช้ในระบบใช้อยู่แล้ว', () => {
      const p = plan([['b1', 'ก', 'ข', 'taken@s.ac.th']], { existingEmails: ['TAKEN@s.ac.th'] });
      assert.equal(p.summary.ok, 0);
      assert.match(p.items[0].reason, /มีผู้ใช้ในระบบใช้อยู่แล้ว/, 'ต้องเทียบแบบไม่สนตัวพิมพ์เล็ก-ใหญ่');
    });

    test('อีเมลผิดรูปแบบ', () => {
      const p = plan([['c1', 'ก', 'ข', 'ไม่ใช่อีเมล'], ['c2', 'ค', 'ง', 'ok@s.ac.th']]);
      assert.equal(p.summary.error, 1);
      assert.match(p.items[0].reason, /ไม่ใช่รูปแบบอีเมล/);
      assert.equal(p.items[1].status, 'ok');
    });

    test('ช่องอีเมลว่างยังนำเข้าได้ตามปกติ และหลายแถวว่างพร้อมกันไม่ถือว่าซ้ำ', () => {
      const p = plan([['d1', 'ก', 'ข', ''], ['d2', 'ค', 'ง', '']]);
      assert.equal(p.summary.ok, 2, 'อีเมลไม่ใช่ช่องบังคับ — ว่างได้ และ NULL ไม่ชนกันเองใน SQLite');
    });
  });

  test('ช่องที่ยาวผิดปกติต้องถูกปฏิเสธพร้อมบอกว่าช่องไหน', () => {
    const rows = [['รหัสประจำตัว', 'ชื่อ', 'นามสกุล', 'ตำแหน่ง'],
      ['e1', 'ก'.repeat(5000), 'ข', 'ครู'],
      ['e2', 'ก', 'ข', 'ค'.repeat(5000)],
      ['e3', 'ก', 'ข', 'ครู']];
    const p = planUserImport(rows, { departments, roles, existingCodes: [] });
    assert.equal(p.summary.error, 2);
    assert.match(p.items[0].reason, /"ชื่อ" ยาวเกิน/);
    assert.match(p.items[1].reason, /"ตำแหน่ง" ยาวเกิน/);
    assert.equal(p.items[2].status, 'ok', 'แถวปกติต้องไม่โดนลูกหลง');
  });

  // ไฟล์เป็นพันแถวแปลว่าหยิบไฟล์ผิด (เช่นไฟล์รายชื่อนักเรียน) การสร้างบัญชีพันบัญชีแล้วไล่ลบทีหลัง
  // เจ็บปวดกว่าการให้แบ่งไฟล์มาก และหน้าที่แสดงรหัสผ่านครั้งเดียวจะยาวจนพิมพ์แจกไม่ไหว
  test('จำนวนแถวเกินเพดานต้องถูกปฏิเสธทั้งไฟล์', () => {
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [`f${i}`, 'ก', `ข${i}`]);
    assert.throws(() => planUserImport([['รหัสประจำตัว', 'ชื่อ', 'นามสกุล'], ...many],
      { departments, roles, existingCodes: [] }), /เกินเพดาน/);
    const justFits = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => [`g${i}`, 'ก', `ข${i}`]);
    assert.equal(planUserImport([['รหัสประจำตัว', 'ชื่อ', 'นามสกุล'], ...justFits],
      { departments, roles, existingCodes: [] }).summary.ok, MAX_IMPORT_ROWS, 'พอดีเพดานต้องยังผ่าน');
  });
});

// ค่าที่หน้าเว็บส่งมาเป็น <select>/<input type=date> ก็จริง แต่ต้องตรวจฝั่งเซิร์ฟเวอร์เสมอ —
// ค่าที่หลุดเข้ามาได้สร้างปัญหาเงียบๆ ที่ร้ายแรงกว่าที่คิด โดยเฉพาะชั้นความลับ
describe('ตรวจค่าที่กรอกเข้ามาตอนลงทะเบียนหนังสือ', () => {
  test('ชั้นความลับที่ไม่อยู่ในรายการต้องถูกปฏิเสธ (ไม่งั้นหนังสือลับกลายเป็นสาธารณะ)', () => {
    // canUserSeeDocument จำกัดสิทธิ์เฉพาะค่า 'secret'/'top_secret' ค่าอื่นถือเป็นหนังสือทั่วไปที่ทุกคนอ่านได้
    // ถ้าค่าแปลกปลอมหลุดเข้ามา หนังสือที่ตั้งใจให้เป็นความลับสูงสุดจะเปิดให้ทุกคนอ่านทันทีโดยไม่มีอะไรฟ้อง
    assert.throws(() => makeDoc({ title: 'ลับสุดยอด', secretLevel: 'ลับสุดยอด' }), /ชั้นความลับ/);
    assert.throws(() => makeDoc({ title: 'x', secretLevel: 'SECRET' }), /ชั้นความลับ/);
    // ค่าที่ถูกต้องต้องยังใช้ได้ตามปกติ ไม่ใช่ปิดตายทั้งหมด
    for (const lv of ['normal', 'internal', 'secret', 'top_secret']) {
      assert.ok(makeDoc({ title: `ชั้นความลับ ${lv}`, secretLevel: lv }).id);
    }
  });

  test('ชั้นความเร็วและอายุการเก็บที่ไม่อยู่ในรายการต้องถูกปฏิเสธ', () => {
    assert.throws(() => makeDoc({ title: 'x', priority: 'ด่วนมากที่สุด' }), /ชั้นความเร็ว/);
    // อายุการเก็บที่ไม่รู้จักทำให้ retention_until เป็น null เงียบๆ แล้วหนังสือจะไม่เข้าระบบทำลายเลยตลอดไป
    assert.throws(() => makeDoc({ title: 'x', retentionClass: 'ตลอดกาล' }), /อายุการเก็บ/);
    assert.ok(makeDoc({ title: 'เก็บถาวร', retentionClass: 'permanent' }).id);
  });

  test('วันที่ต้องเป็นวันที่จริง และดักกรณีกรอกปี พ.ศ. ลงช่องที่เป็น ค.ศ.', () => {
    assert.throws(() => makeDoc({ title: 'x', dueDate: 'ไม่ใช่วันที่' }), /ไม่ใช่วันที่ที่ถูกต้อง/);
    assert.throws(() => makeDoc({ title: 'x', dueDate: '2026-13-45' }), /ไม่ใช่วันที่ที่มีอยู่จริง/);
    assert.throws(() => makeDoc({ title: 'x', dueDate: '2027-02-29' }), /ไม่ใช่วันที่ที่มีอยู่จริง/);
    // ช่องกรอกวันที่ของเบราว์เซอร์เป็น ค.ศ. แต่ครูไทยคิดเป็น พ.ศ. — กรอก 2569 แทน 2026 เกิดง่ายมาก
    // ถ้าปล่อยผ่าน วันครบกำหนดจะไปอยู่อีก 543 ปีข้างหน้า แล้วหนังสือจะไม่มีวันขึ้นว่าเลยกำหนดเลย
    assert.throws(() => makeDoc({ title: 'x', dueDate: '2569-12-31' }), /พ\.ศ\..*2026/s);
    assert.ok(makeDoc({ title: 'วันที่ปกติ', dueDate: '2026-12-31', externalDocDate: '2026-01-15' }).id);
    assert.ok(makeDoc({ title: 'ปีอธิกสุรทิน', dueDate: '2028-02-29' }).id);
    // เว้นว่างได้ตามเดิม เพราะไม่ใช่ช่องบังคับ
    assert.ok(makeDoc({ title: 'ไม่ระบุวันครบกำหนด' }).id);
  });

  test('ข้อความยาวเกินจริงต้องถูกปฏิเสธ ไม่ใช่เก็บเข้าไปทั้งก้อน', () => {
    // ทดสอบแล้ว: ชื่อเรื่อง 50,000 ตัวอักษรฉบับเดียวทำให้หน้าทะเบียนพองเป็น 115KB ต่อการเปิดหนึ่งครั้ง
    // เกิดง่ายมากเวลาก๊อปเนื้อหาจากไฟล์ Word มาวางผิดช่อง
    assert.throws(() => makeDoc({ title: 'ก'.repeat(50000) }), /ชื่อเรื่องยาวเกินไป/);
    assert.throws(() => makeDoc({ title: 'x', subject: 'ก'.repeat(50000) }), /สาระสำคัญยาวเกินไป/);
    assert.throws(() => makeDoc({ title: 'x', correspondentName: 'ก'.repeat(500) }), /ชื่อหน่วยงานยาวเกินไป/);
    // ความยาวปกติของหนังสือราชการจริงต้องผ่านสบายๆ
    assert.ok(makeDoc({ title: 'ก'.repeat(400), subject: 'ก'.repeat(4000) }).id);
  });
});

// ใบลาและลายเซ็นรับรองเป็นหลักฐานทางราชการที่ต้องตรวจสอบย้อนหลังได้ ถ้าลายเซ็นที่แสดงถูกดึงจากโปรไฟล์
// ผู้ใช้แบบสดๆ วันไหนเจ้าตัวเปลี่ยนหรือลบลายเซ็น หลักฐานบนใบลา/หนังสือที่ลงนามไปแล้วทั้งหมดจะเปลี่ยน
// หรือหายย้อนหลังตามไปด้วยโดยไม่มีอะไรฟ้อง — ยืนยันแล้วว่าเดิมเกิดขึ้นจริง
describe('หลักฐานการลงนาม: ต้องตรึงไว้ ณ ขณะลงนาม ห้ามเปลี่ยนตามโปรไฟล์', () => {
  test('ขั้นตอนของหนังสือเก็บสำเนาลายเซ็น/ชื่อ/ตำแหน่งไว้เอง ไม่ join จาก users ตอนแสดงผล', () => {
    const cols = db.prepare('PRAGMA table_info(workflow_steps)').all().map((c) => c.name);
    for (const c of ['signature_image', 'signer_name', 'signer_position']) {
      assert.ok(cols.includes(c), `workflow_steps ต้องมีคอลัมน์ ${c} ไว้เก็บสำเนา ณ ขณะลงนาม`);
    }
    const wf = fs.readFileSync(new URL('../src/services/workflow.js', import.meta.url), 'utf8');
    // ไทม์ไลน์ต้องไม่ดึง signature_image จาก users อีก
    const q = wf.slice(wf.indexOf('export function getWorkflowSteps'), wf.indexOf('export function currentStep'));
    assert.ok(!/u\.signature_image/.test(q), 'getWorkflowSteps ต้องไม่ดึงลายเซ็นจาก users มาแสดงสดๆ');
    // และทุกจุดที่ตัดสินใจต้องตรึงสำเนาไว้
    assert.equal((wf.match(/snapshotSignature\(stepId, actorUser\.id\);/g) || []).length, 4,
      'ต้องตรึงลายเซ็นทั้ง 4 จุดที่ตัดสินใจ (อนุมัติ/รับทราบ/ไม่อนุมัติ/ส่งกลับแก้ไข)');
  });

  test('ลายเซ็นบนหนังสือไม่หายเมื่อเจ้าตัวลบลายเซ็นในโปรไฟล์', () => {
    const doc = makeDoc({ title: 'ทดสอบตรึงลายเซ็นบนหนังสือ' });
    const stepId = assignStep({ documentId: doc.id, assigneeId: seed.userIds.head_acad, actorUser: registrarUser });
    db.prepare('UPDATE users SET signature_image = ? WHERE id = ?').run('data:image/png;base64,AAAA', seed.userIds.head_acad);
    acknowledgeAndComplete({ stepId, actorUser: loadUserForTest(seed.userIds.head_acad) });

    const before = db.prepare('SELECT signature_image, signer_name FROM workflow_steps WHERE id = ?').get(stepId);
    assert.equal(before.signature_image, 'data:image/png;base64,AAAA', 'ต้องตรึงภาพลายเซ็นไว้ตอนลงนาม');
    assert.match(before.signer_name, /หัวหน้าฝ่าย/);

    db.prepare('UPDATE users SET signature_image = NULL WHERE id = ?').run(seed.userIds.head_acad);
    const after = db.prepare('SELECT signature_image FROM workflow_steps WHERE id = ?').get(stepId);
    assert.equal(after.signature_image, 'data:image/png;base64,AAAA',
      'เจ้าตัวลบลายเซ็นในโปรไฟล์แล้ว หลักฐานบนหนังสือที่ลงนามไปแล้วต้องไม่หาย');
  });

  test('ใบลาเก็บลายเซ็นรับรองทุกขั้นตอน และไม่หายเมื่อลบลายเซ็นในโปรไฟล์', async () => {
    const leave = await import('../src/services/leave.js');
    const requester = loadUserForTest(seed.userIds.teacher001);
    const approver = loadUserForTest(seed.userIds.director01);
    db.prepare('UPDATE users SET signature_image = ? WHERE id IN (?, ?)')
      .run('data:image/png;base64,BBBB', requester.id, approver.id);

    const { id } = leave.createLeaveRequest({
      requesterId: requester.id, leaveType: 'sick', ...nextLeaveWindow(1),
      reason: 'ทดสอบหลักฐานใบลา', approverId: approver.id,
    });
    let sigs = leave.listLeaveSignatures(id);
    assert.equal(sigs.length, 1, 'ตอนยื่นต้องมีลายเซ็นผู้ขอทันที');
    assert.equal(sigs[0].step, 'requested');

    leave.approveLeaveRequest({ id, note: 'อนุญาต', actorUser: approver });
    sigs = leave.listLeaveSignatures(id);
    assert.deepEqual(sigs.map((s) => s.step), ['requested', 'approved'], 'ต้องเก็บลายเซ็นครบทุกขั้นตอน');
    assert.ok(sigs.every((s) => s.signature_image === 'data:image/png;base64,BBBB'));
    assert.ok(sigs.every((s) => s.signer_name && s.signer_position), 'ต้องเก็บสำเนาชื่อและตำแหน่งด้วย');
    assert.equal(sigs[1].note, 'อนุญาต');

    db.prepare('UPDATE users SET signature_image = NULL WHERE id IN (?, ?)').run(requester.id, approver.id);
    assert.ok(leave.listLeaveSignatures(id).every((s) => s.signature_image === 'data:image/png;base64,BBBB'),
      'ลบลายเซ็นในโปรไฟล์แล้ว หลักฐานบนใบลาต้องไม่หาย');
  });

  test('ไฟล์หลักฐานแนบใบลา: รับเฉพาะชนิดที่อนุญาตและเนื้อไฟล์ต้องตรงกับชนิดที่แจ้ง', async () => {
    const { assertAllowedLeaveFile } = await import('../src/services/leave.js');
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUg', 'base64');
    const pdf = Buffer.from('%PDF-1.4\ntrailer<<>>\n%%EOF\n', 'latin1');
    assert.equal(assertAllowedLeaveFile({ mimeType: 'application/pdf', buffer: pdf }), 'pdf');
    assert.equal(assertAllowedLeaveFile({ mimeType: 'image/png', buffer: png }), 'png');
    // บอกว่าเป็น PDF แต่เนื้อไฟล์เป็น PNG — ต้องไม่ผ่าน (เชื่อ mime type ที่ฝั่งเว็บส่งมาไม่ได้)
    assert.throws(() => assertAllowedLeaveFile({ mimeType: 'application/pdf', buffer: png }), /file signature/);
    assert.throws(() => assertAllowedLeaveFile({ mimeType: 'application/x-msdownload', buffer: png }), /รองรับเฉพาะ/);
  });
});

// หน้ารายการทะเบียนหนังสือกรองสิทธิ์ตั้งแต่ใน SQL เพื่อให้นับจำนวนและแบ่งหน้าได้ถูก แต่การตรวจสิทธิ์
// รายฉบับยังใช้ canUserSeeDocument เหมือนเดิม — สองตัวนี้ต้องให้ผลตรงกันเป๊ะเสมอ ถ้าเงื่อนไข SQL หลวมกว่า
// คือเปิดเผยหนังสือลับให้คนที่ไม่มีสิทธิ์เห็น ถ้าแคบกว่าคือซ่อนหนังสือที่ควรเห็นจนหาไม่เจอ ทั้งสองแบบ
// ไม่มีอะไรฟ้องเลยจนกว่าจะมีคนมาบ่น เทสต์นี้จึงเทียบผลของทั้งสองกับหนังสือทุกฉบับ x ผู้ใช้ทุกบทบาท
// คำเตือน "ไฟล์นี้ซ้ำกับเอกสาร 0042/2569" เดิมค้นทั้งฐานข้อมูล ครูที่บังเอิญอัปโหลดไฟล์เดียวกับที่แนบอยู่
// กับหนังสือ "ลับมาก" จึงได้เลขที่หนังสือฉบับนั้นมาฟรีๆ ทั้งที่เปิดอ่านไม่ได้
describe('คำเตือนไฟล์ซ้ำต้องไม่บอกเลขหนังสือที่ผู้อัปโหลดไม่มีสิทธิ์เห็น', () => {
  // แต่ละเทสต์ต้องใช้เนื้อหาไฟล์ของตัวเอง ไม่งั้นการค้นด้วย hash จะไปเจอไฟล์ของเทสต์ก่อนหน้าแทน
  const pdfWith = (tag) => Buffer.from(`%PDF-1.4\n% ${tag}\ntrailer<</Root 1 0 R>>\n%%EOF\n`).toString('base64');
  const upload = (user, title, pdf, over = {}) => dispatchPost(user, '/documents', {
    title, departmentId: deptId, correspondentName: 'ทดสอบ',
    fileName: 'a.pdf', fileType: 'application/pdf', fileDataBase64: pdf, ...over,
  });
  const warnOf = (res) => decodeURIComponent(/warn=([^&]*)/.exec(res.body || '')?.[1] || '');

  test('ครูที่เห็นหนังสือลับไม่ได้ ต้องไม่ได้เลขที่หนังสือนั้นมาจากคำเตือน', async () => {
    const pdf = pdfWith('เนื้อหาของหนังสือลับ');
    const secret = await upload(registrarUser, 'รายงานสอบสวนลับมาก', pdf, { secretLevel: 'top_secret' });
    const secretId = /\/documents\/([0-9a-f-]{36})/.exec(secret.body)?.[1];
    const secretNumber = db.prepare('SELECT doc_number_display d FROM documents WHERE id = ?').get(secretId).d;
    assert.equal(canUserSeeDocument(loadUserForTest(seed.userIds.teacher001), getDocRow(secretId)), false);

    const byTeacher = await upload(loadUserForTest(seed.userIds.teacher001), 'ครูอัปโหลดไฟล์เดียวกัน', pdf);
    assert.ok(!warnOf(byTeacher).includes(secretNumber),
      `คำเตือนบอกเลขหนังสือลับให้ครูรู้: "${warnOf(byTeacher)}"`);
  });

  test('คนที่มีสิทธิ์เห็นยังได้คำเตือนไฟล์ซ้ำตามเดิม', async () => {
    const pdf = pdfWith('เนื้อหาของหนังสือทั่วไป');
    const first = await upload(registrarUser, 'หนังสือทั่วไปฉบับแรก', pdf);
    const firstId = /\/documents\/([0-9a-f-]{36})/.exec(first.body)?.[1];
    const number = db.prepare('SELECT doc_number_display d FROM documents WHERE id = ?').get(firstId).d;
    const second = await upload(registrarUser, 'หนังสือทั่วไปฉบับที่สอง', pdf);
    assert.ok(warnOf(second).includes(number),
      `ควรเตือนว่าซ้ำกับ ${number} แต่ได้: "${warnOf(second)}"`);
  });
});

describe('สิทธิ์เห็นหนังสือ: เงื่อนไขใน SQL ต้องตรงกับการตรวจรายฉบับเสมอ', () => {
  test('ทุกฉบับ x ทุกบทบาท ให้ผลเหมือนกันทั้งสองทาง', async () => {
    const { canUserSeeDocument, visibleDocumentsSqlFilter } = await import('../src/services/workflow.js');
    const { getSessionUser } = await import('../src/auth.js');

    const docs = db.prepare('SELECT * FROM documents WHERE deleted_at IS NULL').all();
    assert.ok(docs.length >= 3, 'ต้องมีข้อมูลพอให้เทียบ ไม่งั้นเทสต์ผ่านแบบไม่ได้ตรวจอะไรเลย');
    const users = db.prepare('SELECT id FROM users').all()
      .map((u) => loadUserForTest(u.id))
      .filter(Boolean);
    assert.ok(users.length >= 4, 'ต้องมีผู้ใช้หลายบทบาท');

    let checked = 0;
    let secretChecked = 0;
    for (const user of users) {
      const visible = visibleDocumentsSqlFilter(user);
      const allowedIds = new Set(db.prepare(
        `SELECT d.id FROM documents d WHERE d.deleted_at IS NULL AND ${visible.sql}`,
      ).all(visible.params).map((r) => r.id));

      for (const doc of docs) {
        const bySql = allowedIds.has(doc.id);
        const byJs = canUserSeeDocument(user, doc);
        assert.equal(bySql, byJs,
          `ไม่ตรงกัน: ผู้ใช้ ${user.employee_code} กับหนังสือ ${doc.doc_number_display} (ชั้นความลับ ${doc.secret_level}) — SQL=${bySql} แต่ตรวจรายฉบับ=${byJs}`);
        checked++;
        if (doc.secret_level === 'secret' || doc.secret_level === 'top_secret') secretChecked++;
      }
    }
    assert.ok(secretChecked > 0, 'ต้องมีหนังสือชั้นความลับในชุดทดสอบ ไม่งั้นไม่ได้ตรวจส่วนที่สำคัญที่สุด');
    assert.ok(checked >= 12, `ตรวจน้อยเกินไป (${checked} คู่)`);
  });

  test('คนที่ไม่เกี่ยวข้องต้องมองไม่เห็นหนังสือลับ ทั้งสองทาง', async () => {
    const { canUserSeeDocument, visibleDocumentsSqlFilter } = await import('../src/services/workflow.js');
    const outsider = loadUserForTest(seed.userIds.teacher001);
    const secretDoc = makeDoc({ title: 'หนังสือลับที่ครูคนนี้ไม่เกี่ยวข้อง', secretLevel: 'secret', createdBy: seed.userIds.reg001 });

    assert.equal(canUserSeeDocument(outsider, getDocRow(secretDoc.id)), false, 'ตัวตรวจรายฉบับต้องปฏิเสธ');
    const visible = visibleDocumentsSqlFilter(outsider);
    const seenBySql = db.prepare(`SELECT 1 as x FROM documents d WHERE d.id = :id AND ${visible.sql}`)
      .get({ id: secretDoc.id, ...visible.params });
    assert.equal(seenBySql, undefined, 'เงื่อนไข SQL ต้องไม่ปล่อยหนังสือลับหลุดไปให้คนที่ไม่เกี่ยวข้อง');

    // และผู้บันทึกเองต้องยังเห็นได้ทั้งสองทาง ไม่ใช่ซ่อนหมดทุกคนแล้วเทสต์ผ่านแบบไม่ได้ตรวจอะไร
    const owner = loadUserForTest(seed.userIds.reg001);
    assert.equal(canUserSeeDocument(owner, getDocRow(secretDoc.id)), true);
    const ownerVis = visibleDocumentsSqlFilter(owner);
    assert.ok(db.prepare(`SELECT 1 as x FROM documents d WHERE d.id = :id AND ${ownerVis.sql}`)
      .get({ id: secretDoc.id, ...ownerVis.params }), 'ผู้บันทึกต้องยังเห็นหนังสือลับของตัวเอง');
  });
});

// ลงรับหลายฉบับรวดเดียว — สิ่งที่ต้องกันให้ได้คือ "เลขทะเบียนขาดเป็นรู" เพราะเลขรับที่ออกไปแล้วนำกลับมา
// ใช้ซ้ำไม่ได้ตามหลักงานสารบรรณ ถ้าฉบับที่ 7 ใน 10 ฉบับกรอกผิดแล้วระบบบันทึก 6 ฉบับแรกไปก่อน ทะเบียน
// จะมีเลขหายไปโดยอธิบายไม่ได้ตอนตรวจ — ทั้งชุดจึงต้องสำเร็จหรือไม่สำเร็จพร้อมกันเท่านั้น
describe('ลงรับหลายฉบับรวดเดียว', () => {
  const bulkItem = (n, extra = {}) => ({
    direction: 'incoming', title: `หนังสือชุด ฉบับที่ ${n}`, correspondentName: 'สพป.ทดสอบ',
    docTypeId: typeId, departmentId: deptId, ...extra,
  });
  const runningNumbers = () => db.prepare(
    "SELECT running_number FROM documents WHERE direction = 'incoming' ORDER BY running_number",
  ).all().map((r) => r.running_number);

  test('ออกเลขให้ทั้งชุดเรียงติดกันไม่ข้าม', () => {
    const docs = createDocumentsBulk([1, 2, 3, 4].map((n) => bulkItem(n)), registrarUser.id);
    assert.equal(docs.length, 4);
    const nums = docs.map((d) => Number(d.docNumberDisplay.split('/')[0]));
    assert.deepEqual(nums, [nums[0], nums[0] + 1, nums[0] + 2, nums[0] + 3], `เลขไม่เรียงติดกัน: ${nums}`);
    for (const d of docs) assert.ok(getDocument(d.id), `หาเอกสาร ${d.docNumberDisplay} ไม่เจอ`);
  });

  test('ฉบับใดฉบับหนึ่งผิด ต้องไม่บันทึกฉบับไหนเลย และตัวนับเลขต้องไม่ขยับ', () => {
    const before = runningNumbers();
    const counterBefore = db.prepare(
      "SELECT running_number FROM document_number_counters WHERE direction = 'incoming'",
    ).get()?.running_number;

    // แถวที่ 3 กรอกวันครบกำหนดเป็น พ.ศ. ซึ่ง normalizeDate ปฏิเสธ
    assert.throws(
      () => createDocumentsBulk([
        bulkItem(1), bulkItem(2), bulkItem(3, { dueDate: '2569-01-01' }), bulkItem(4),
      ], registrarUser.id),
      /แถวที่ 3/,
      'ต้องบอกด้วยว่าแถวไหนผิด ไม่งั้นผู้ใช้ที่กรอก 20 แถวต้องไล่หาเอง',
    );

    assert.deepEqual(runningNumbers(), before, 'มีเอกสารบางฉบับหลุดเข้าไปทั้งที่ทั้งชุดควรถูกยกเลิก');
    const counterAfter = db.prepare(
      "SELECT running_number FROM document_number_counters WHERE direction = 'incoming'",
    ).get()?.running_number;
    assert.equal(counterAfter, counterBefore, 'ตัวนับเลขรับขยับไปแล้วทั้งที่ไม่มีฉบับไหนถูกบันทึก — ทะเบียนจะมีเลขขาด');
  });

  test('เลขที่ออกหลังชุดที่ล้มเหลว ต้องต่อจากเลขเดิมพอดี ไม่มีรู', () => {
    const ok = createDocumentsBulk([bulkItem(1), bulkItem(2)], registrarUser.id);
    const last = Number(ok[1].docNumberDisplay.split('/')[0]);
    assert.throws(() => createDocumentsBulk([bulkItem(3, { secretLevel: 'ไม่มีชั้นนี้' })], registrarUser.id));
    const next = createDocumentsBulk([bulkItem(4)], registrarUser.id);
    assert.equal(Number(next[0].docNumberDisplay.split('/')[0]), last + 1);
  });

  test('ปฏิเสธรายการว่าง ไม่ใช่อาเรย์ และเกินจำนวนสูงสุด', () => {
    assert.throws(() => createDocumentsBulk([], registrarUser.id), /ยังไม่ได้กรอกรายการ/);
    assert.throws(() => createDocumentsBulk('ไม่ใช่อาเรย์', registrarUser.id), /ยังไม่ได้กรอกรายการ/);
    assert.throws(
      () => createDocumentsBulk(Array.from({ length: MAX_BULK_DOCUMENTS + 1 }, (_, i) => bulkItem(i)), registrarUser.id),
      new RegExp(`ไม่เกิน ${MAX_BULK_DOCUMENTS} ฉบับ`),
    );
  });

  // ตัวตรวจชุดเดียวกับการลงทีละฉบับ ไม่ใช่ทางลัดที่ตรวจน้อยกว่า — ไม่งั้นหน้านี้จะกลายเป็นช่องให้ค่าที่
  // ระบบตั้งใจปฏิเสธ (โดยเฉพาะชั้นความลับ ซึ่งค่าที่ไม่รู้จักเท่ากับเปิดหนังสือลับให้ทุกคนอ่าน) หลุดเข้ามาได้
  test('ใช้ตัวตรวจชุดเดียวกับการลงทีละฉบับ', () => {
    for (const [label, extra] of [
      ['ชั้นความลับที่ไม่รู้จัก', { secretLevel: 'hack' }],
      ['ชั้นความเร็วที่ไม่รู้จัก', { priority: 'ด่วนสุดๆ' }],
      ['อายุการเก็บที่ไม่รู้จัก', { retentionClass: 'forever' }],
      ['วันครบกำหนดที่ไม่มีอยู่จริง', { dueDate: '2026-13-45' }],
      ['ชื่อเรื่องยาวเกินกำหนด', { title: 'ก'.repeat(501) }],
      ['ไม่ได้กรอกชื่อเรื่อง', { title: '   ' }],
      ['ไม่ได้กรอกหน่วยงาน', { correspondentName: '' }],
      ['ฝ่ายที่ไม่มีอยู่จริง', { departmentId: 'ฝ่ายผี' }],
    ]) {
      assert.throws(() => createDocumentsBulk([bulkItem(1, extra)], registrarUser.id), undefined, `ควรปฏิเสธ: ${label}`);
    }
  });

  test('บันทึก audit ครบทุกฉบับ', () => {
    const docs = createDocumentsBulk([bulkItem(1), bulkItem(2), bulkItem(3)], registrarUser.id);
    for (const d of docs) {
      const row = db.prepare(
        "SELECT 1 x FROM audit_logs WHERE action = 'document_received' AND record_id = ?",
      ).get(d.id);
      assert.ok(row, `ไม่มี audit ของเอกสาร ${d.docNumberDisplay}`);
    }
  });
});

// ตัวกรองละเอียดของทะเบียนหนังสือ — เรียกเส้นทางจริงผ่าน router.dispatch แล้วอ่าน HTML ที่ได้ เพราะ
// ตรรกะการกรองอยู่ในตัวเส้นทางเอง ถ้าเทสต์ระดับฟังก์ชันอย่างเดียวจะไม่ได้ตรวจสิ่งที่ผู้ใช้เห็นจริงเลย
describe('ทะเบียนหนังสือ: ตัวกรองละเอียด', () => {
  const getDocumentsPage = (user, query) => dispatchGet(user, '/documents', query);
  const rowIds = (body) => [...body.matchAll(/location\.href='\/documents\/([^']+)'/g)].map((m) => m[1]);

  const reg = () => loadUserForTest(seed.userIds.reg001);

  test('กรองตามความเร็วและฝ่าย แล้วเหลือเฉพาะฉบับที่ตรงจริง', async () => {
    const hit = makeDoc({ title: 'หนังสือด่วนที่สุดของฝ่ายวิชาการ', priority: 'most_urgent', departmentId: deptId });
    const miss = makeDoc({ title: 'หนังสือปกติของฝ่ายวิชาการ', priority: 'normal', departmentId: deptId });

    const filtered = await getDocumentsPage(reg(), { direction: 'incoming', priority: 'most_urgent', dept: deptId });
    assert.equal(filtered.status, 200);
    const ids = rowIds(filtered.body);
    assert.ok(ids.includes(hit.id), 'ฉบับที่ตรงเงื่อนไขต้องอยู่ในผลลัพธ์');
    assert.ok(!ids.includes(miss.id), 'ฉบับที่ความเร็วไม่ตรงต้องไม่ติดมาด้วย');

    // และเมื่อไม่กรอง ต้องเห็นทั้งคู่ ไม่ใช่ผ่านเพราะรายการว่างเปล่าอยู่แล้ว
    const all = rowIds((await getDocumentsPage(reg(), { direction: 'incoming' })).body);
    assert.ok(all.includes(hit.id) && all.includes(miss.id), 'ตอนไม่กรองต้องเห็นทั้งสองฉบับ');
  });

  test('ค่ากรองที่ไม่รู้จักต้องถูกมองข้าม ไม่ใช่ทำให้รายการว่างเปล่า', async () => {
    const baseline = rowIds((await getDocumentsPage(reg(), { direction: 'incoming' })).body).length;
    assert.ok(baseline > 0, 'ต้องมีหนังสืออยู่ก่อน ไม่งั้นเทสต์นี้ไม่ได้ตรวจอะไร');
    for (const bogus of [
      { priority: 'ด่วนมากที่สุดที่สุด' },
      { secret: "' OR 1=1 --" },
      { from: 'ไม่ใช่วันที่' },
      { to: '2569-13-45' },
    ]) {
      const res = await getDocumentsPage(reg(), { direction: 'incoming', ...bogus });
      assert.equal(res.status, 200, `ค่ากรองมั่ว ${JSON.stringify(bogus)} ต้องไม่ทำให้หน้าพัง`);
      assert.equal(rowIds(res.body).length, baseline,
        `ค่ากรองมั่ว ${JSON.stringify(bogus)} ต้องถูกมองข้าม แต่จำนวนรายการเปลี่ยนไป`);
    }
  });

  test('ช่วงวันที่นับรวมหนังสือที่ลงทะเบียนตอนบ่ายของวันสุดท้ายด้วย', async () => {
    const today = todayInBangkok();
    const doc = makeDoc({ title: 'หนังสือที่ลงทะเบียนวันนี้' });
    // created_at เป็น ISO เต็มที่มีเวลาต่อท้าย ถ้าเทียบสตริงตรงๆ กับ 'YYYY-MM-DD' จะตกหล่นทั้งวัน
    const ids = rowIds((await getDocumentsPage(reg(), { direction: 'incoming', from: today, to: today })).body);
    assert.ok(ids.includes(doc.id), 'ตั้งช่วง "วันนี้ถึงวันนี้" ต้องเห็นหนังสือที่เพิ่งลงทะเบียน');
  });

  test('เฉพาะที่เลยกำหนด ต้องไม่รวมเรื่องที่ปิดไปแล้ว', async () => {
    const past = '2020-01-01';
    const open = makeDoc({ title: 'เรื่องค้างที่เลยกำหนดแล้ว', dueDate: past });
    const closed = makeDoc({ title: 'เรื่องที่เลยกำหนดแต่ปิดไปแล้ว', dueDate: past });
    db.prepare("UPDATE documents SET status = 'completed' WHERE id = ?").run(closed.id);

    const ids = rowIds((await getDocumentsPage(reg(), { direction: 'incoming', overdue: '1' })).body);
    assert.ok(ids.includes(open.id), 'เรื่องที่ยังไม่ปิดและเลยกำหนดต้องติดมา');
    assert.ok(!ids.includes(closed.id), 'เรื่องที่ปิดแล้วต้องไม่ถูกนับว่าเลยกำหนดอีก');
  });

  test('ลิงก์เปลี่ยนหน้าต้องหอบตัวกรองไปด้วย ไม่ใช่หลุดกลับไปดูทั้งหมด', () => {
    // อ่านจากซอร์สแทนการสร้างหนังสือ 51 ฉบับ — สิ่งที่ต้องกันคือการลืมใส่ตัวกรองลงใน query string
    const src = fs.readFileSync(new URL('../src/routes/documents.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('const filterQs = ()'), src.indexOf('const pager ='));
    assert.ok(fn.length > 0, 'หา filterQs/pageLink ในซอร์สไม่เจอ — เทสต์นี้ต้องแก้ตามชื่อใหม่');
    assert.match(fn, /Object\.entries\(f\)/,
      'ตัวประกอบ query string ต้องวนใส่ตัวกรองทุกตัว ไม่ใช่ใส่ทีละตัวแล้วลืมตัวใหม่ที่เพิ่มทีหลัง');
    // ลิงก์ส่งออกไฟล์ต้องใช้ตัวประกอบตัวเดียวกับลิงก์เปลี่ยนหน้า ไม่งั้นไฟล์ที่ได้จะเป็นทั้งทะเบียน
    // ทั้งที่ผู้ใช้กรองไว้แล้ว ซึ่งเป็นความผิดพลาดที่ผู้ใช้ไม่มีทางสังเกตเห็นจากปุ่มเลย
    assert.match(fn, /const exportLink = \(path\) => `\$\{path\}\?\$\{filterQs\(\)/);
  });

  // ทะเบียนหนังสือรับ/ส่งเป็น "เล่มต่อปี" ตามระเบียบงานสารบรรณ เลขรับเริ่มที่ 1 ใหม่ทุกวันที่ 1 ม.ค.
  // เดิมกรองได้แค่ช่วงวันที่ซึ่งต้องพิมพ์เป็น ค.ศ. เอง ทั้งที่สิ่งที่ธุรการต้องการคือ "ทะเบียนประจำปี ๒๕๖๙"
  describe('กรองทะเบียนตามปี พ.ศ.', () => {
    const yearOf = (id) => db.prepare('SELECT year_be FROM documents WHERE id = ?').get(id).year_be;
    const putInYear = (id, yearBe, runningNumber) => db.prepare(
      'UPDATE documents SET year_be = ?, running_number = ?, doc_number_display = ? WHERE id = ?')
      .run(yearBe, runningNumber, `${String(runningNumber).padStart(4, '0')}/${yearBe}`, id);

    test('เลือกปีแล้วเหลือเฉพาะหนังสือของปีนั้น', async () => {
      const thisYear = makeDoc({ title: 'หนังสือของปีนี้' });
      const lastYear = makeDoc({ title: 'หนังสือของปีที่แล้ว' });
      putInYear(lastYear.id, yearOf(thisYear.id) - 1, 999);

      const res = await getDocumentsPage(reg(), { direction: 'incoming', year: String(yearOf(thisYear.id)) });
      const ids = rowIds(res.body);
      assert.ok(ids.includes(thisYear.id), 'หนังสือของปีที่เลือกต้องอยู่');
      assert.ok(!ids.includes(lastYear.id), 'หนังสือของปีอื่นต้องไม่ปน');
    });

    test('กรองจากปีของเลขทะเบียน ไม่ใช่จากวันที่ลงทะเบียน', async () => {
      // หนังสือที่ออกเลขปีก่อน แต่เพิ่งบันทึกเข้าระบบต้นปีถัดไป — ต้องอยู่ในทะเบียนของ "ปีที่ออกเลข"
      const oldNumberNewEntry = makeDoc({ title: 'เลขเป็นปีก่อน แต่บันทึกเข้าระบบปีถัดไป' });
      const oldYear = yearOf(oldNumberNewEntry.id) - 1;
      putInYear(oldNumberNewEntry.id, oldYear, 888);

      // กลับกัน: เลขเป็นปีปัจจุบัน แต่ created_at ย้อนไปอยู่ในปีก่อน — ต้องไม่โผล่ในทะเบียนปีก่อน
      const newNumberOldEntry = makeDoc({ title: 'เลขเป็นปีปัจจุบัน แต่วันที่บันทึกย้อนไปปีก่อน' });
      db.prepare("UPDATE documents SET created_at = datetime('now','-400 days') WHERE id = ?").run(newNumberOldEntry.id);

      const ids = rowIds((await getDocumentsPage(reg(), { direction: 'incoming', year: String(oldYear) })).body);
      assert.ok(ids.includes(oldNumberNewEntry.id), 'ต้องกรองจาก year_be (ปีบนหน้าเอกสาร)');
      assert.ok(!ids.includes(newNumberOldEntry.id), 'ต้องไม่กรองจาก created_at');
    });

    test('ปีที่กรอกมั่วต้องถูกมองข้าม ไม่ใช่ได้ทะเบียนว่างเปล่า', async () => {
      const doc = makeDoc({ title: 'หนังสือที่ต้องยังเห็นแม้กรอกปีมั่ว' });
      for (const year of ['abc', '25', '25690', '-1', "2569' OR '1'='1"]) {
        const ids = rowIds((await getDocumentsPage(reg(), { direction: 'incoming', year })).body);
        assert.ok(ids.includes(doc.id), `year=${year} ควรถูกมองข้ามแล้วแสดงทุกปีตามเดิม`);
      }
      assert.ok(db.prepare('SELECT COUNT(*) c FROM documents').get().c > 0, 'ตาราง documents ต้องยังอยู่');
    });

    test('ไฟล์ Excel และหน้าพิมพ์ทะเบียนต้องได้ชุดเดียวกับหน้าจอ', async () => {
      const doc = makeDoc({ title: 'หนังสือเฉพาะปีเก่าที่ต้องไปอยู่ในไฟล์ด้วย' });
      const oldYear = yearOf(doc.id) - 2;
      putInYear(doc.id, oldYear, 777);
      const q = { direction: 'incoming', year: String(oldYear) };

      const page = rowIds((await getDocumentsPage(reg(), q)).body);
      assert.deepEqual(page, [doc.id], 'หน้าจอต้องเหลือฉบับเดียว');

      const xlsx = await dispatchGet(reg(), '/documents/export.xlsx', q);
      const sheet = readWorkbook(xlsx.buffer)[0];
      assert.equal(sheet.rows.length - 1, 1, 'ไฟล์ Excel ต้องมีแถวข้อมูลเดียว');
      assert.ok(sheet.rows[1].some((c) => String(c).includes(`0777/${oldYear}`)));

      const printed = await dispatchGet(reg(), '/documents/register', q);
      assert.ok(printed.body.includes(`0777/${oldYear}`), 'หน้าพิมพ์ต้องมีฉบับนั้น');
      assert.ok(printed.body.includes(`ปี พ.ศ. ${oldYear}`), 'หัวทะเบียนต้องบอกว่าเป็นทะเบียนปีไหน');
    });

    test('ตัวเลือกปีมีปีปัจจุบันเสมอ แม้ยังไม่มีหนังสือของปีนั้น', () => {
      const years = listRegisterYears(reg(), 'incoming');
      assert.ok(years.includes(beYear()), 'ต้นปีที่เพิ่งขึ้นปีใหม่ยังต้องเลือกปีปัจจุบันได้');
      assert.deepEqual(years, [...years].sort((a, b) => b - a), 'ต้องเรียงปีล่าสุดขึ้นก่อน');
    });

    test('ตัวเลือกปีต้องไม่บอกใบ้ว่ามีหนังสือลับของปีไหนอยู่', () => {
      const teacher = loadUserForTest(seed.userIds.teacher001);
      const secret = makeDoc({ title: 'ลับมากของปีโบราณ', secretLevel: 'top_secret', createdBy: seed.userIds.reg001 });
      putInYear(secret.id, 2400, 1);
      assert.equal(canUserSeeDocument(teacher, getDocRow(secret.id)), false);
      assert.ok(!listRegisterYears(teacher, 'incoming').includes(2400),
        'ปีที่มีแต่หนังสือลับต้องไม่โผล่ในตัวเลือกของคนที่เห็นไม่ได้');
      assert.ok(listRegisterYears(reg(), 'incoming').includes(2400), 'ผู้บันทึกเองต้องยังเห็นปีนั้น');
    });
  });
});

// วันที่ที่ไม่ใช่วันที่จริงหลุดเข้าฐานข้อมูลได้ในช่วงที่ยังไม่มีการตรวจค่าที่กรอกเข้ามา — พบของจริงสองแบบ
// ('ไม่ใช่วันที่' และ '2026-13-45' คือเดือน 13 วันที่ 45) แล้วไปโผล่บนทะเบียนและในไฟล์ที่ส่งให้ สพฐ.
describe('ล้างวันที่ของหนังสือที่ไม่ใช่วันที่จริง', () => {
  test('ค่าที่ไม่ใช่วันที่ต้องถูกล้างเป็นค่าว่างตอนอัปเกรดฐานข้อมูล', () => {
    const doc = makeDoc({ title: 'หนังสือเก่าที่วันที่พัง' });
    const bad = ['ไม่ใช่วันที่', '2026-13-45', '2026-02-32', '2569-10-01x', ''];
    for (const value of bad) {
      db.prepare('UPDATE documents SET external_doc_date = ?, due_date = ? WHERE id = ?').run(value, value, doc.id);
      migrate();
      const row = getDocRow(doc.id);
      assert.equal(row.external_doc_date, null, `ควรถูกล้าง: ${JSON.stringify(value)}`);
      assert.equal(row.due_date, null, `ควรถูกล้าง: ${JSON.stringify(value)}`);
    }
  });

  test('วันที่ที่ถูกต้องต้องไม่โดนลูกหลง', () => {
    const doc = makeDoc({ title: 'หนังสือที่วันที่ปกติ' });
    db.prepare("UPDATE documents SET external_doc_date = '2026-02-29', due_date = '2026-12-31' WHERE id = ?").run(doc.id);
    migrate();
    const row = getDocRow(doc.id);
    // 2026 ไม่ใช่ปีอธิกสุรทิน แต่ 29 ก.พ. ยังอยู่ในช่วง 1–31 จึงไม่ถูกล้าง — ตัวตรวจตอนกรอกจับกรณีนี้อยู่แล้ว
    assert.equal(row.external_doc_date, '2026-02-29');
    assert.equal(row.due_date, '2026-12-31');
  });
});

// หัวทะเบียนที่พิมพ์ออกมาเป็นเอกสารราชการเก็บเข้าแฟ้ม วันที่บนนั้นต้องเป็น พ.ศ. แบบไทย ไม่ใช่ค่าดิบ
// จาก <input type="date"> ที่เป็น ค.ศ. (เดิมพิมพ์ว่า "เงื่อนไข: ตั้งแต่ 2026-08-01 · ถึง 2026-08-31")
describe('หัวทะเบียนที่พิมพ์: วันที่ต้องเป็น พ.ศ.', () => {
  test('ช่วงวันที่ในบรรทัดเงื่อนไขต้องเป็นวันที่ไทย', () => {
    const q = buildDocumentQuery(loadUserForTest(seed.userIds.reg001),
      { direction: 'incoming', from: '2026-08-01', to: '2026-08-31' });
    const note = describeFilters(q);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(note), `ยังมีวันที่ดิบแบบ ค.ศ. อยู่: ${note}`);
    assert.ok(note.includes('1 สิงหาคม 2569') && note.includes('31 สิงหาคม 2569'), note);
  });

  test('ปีที่เลือกต้องถูกบรรยายไว้ในบรรทัดเงื่อนไขด้วย', () => {
    const q = buildDocumentQuery(loadUserForTest(seed.userIds.reg001), { direction: 'incoming', year: '2569' });
    assert.ok(describeFilters(q).includes('ปี พ.ศ. 2569'));
  });
});

// ระบบประกาศ/ประชาสัมพันธ์
describe('ประกาศ/ประชาสัมพันธ์', () => {
  const asUser = (code) => loadUserForTest(seed.userIds[code]);

  // เดิมจำกัดไว้ที่บทบาท admin อย่างเดียว ซึ่งเป็นบทบาทเชิงเทคนิค ไม่ใช่คนที่ประกาศเรื่องของโรงเรียนจริง
  // ผอ. ประกาศถึงคณะครูเองไม่ได้ และธุรการซึ่งเป็นคนติดประกาศตัวจริงก็ทำไม่ได้
  test('ผอ./รอง ผอ./ธุรการ ประกาศได้ ครูทั่วไปประกาศไม่ได้', async () => {
    for (const code of ['director01', 'vicedir01', 'reg001', 'admin']) {
      const res = await dispatchPost(asUser(code), '/announcements', { category: 'ประกาศ', title: `ประกาศโดย ${code}`, body: 'เนื้อหา' });
      assert.ok(res.status < 400, `${code} ควรประกาศได้ แต่ได้ ${res.status}`);
    }
    const teacher = await dispatchPost(asUser('teacher001'), '/announcements', { category: 'ประกาศ', title: 'ครูประกาศเอง', body: 'x' });
    assert.equal(teacher.status, 403, 'ครูทั่วไปต้องประกาศไม่ได้');
  });

  test('ครูทั่วไปลบประกาศไม่ได้', async () => {
    const id = db.prepare('SELECT id FROM announcements WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT 1').get()?.id;
    assert.ok(id, 'ต้องมีประกาศอยู่ก่อน ไม่งั้นเทสต์นี้ไม่ได้ตรวจอะไร');
    assert.equal((await dispatchPost(asUser('teacher001'), `/announcements/${id}/delete`, {})).status, 403);
    assert.ok(db.prepare('SELECT deleted_at FROM announcements WHERE id = ?').get(id).deleted_at === null, 'ประกาศต้องยังอยู่');
  });

  // ประกาศแสดงเต็มหน้าจอทุกคนที่เปิดเข้ามา ถ้าปล่อยให้ยาวไม่จำกัด ประกาศเดียวทำให้หน้าประกาศ
  // พองจนเปิดไม่ไหวบนมือถือ (ทดสอบก่อนแก้: หัวข้อ 50,000 และเนื้อหา 500,000 ตัวอักษร บันทึกได้ทั้งคู่)
  test('หัวข้อและเนื้อหามีเพดานความยาว', async () => {
    const admin = asUser('admin');
    for (const [label, body] of [
      ['หัวข้อยาวเกินกำหนด', { category: 'ประกาศ', title: 'ก'.repeat(50000), body: 'x' }],
      ['เนื้อหายาวเกินกำหนด', { category: 'ประกาศ', title: 'ก', body: 'ข'.repeat(500000) }],
      ['หมวดหมู่ที่ไม่รู้จัก', { category: 'hack', title: 'ก', body: 'x' }],
      ['ไม่กรอกหัวข้อ', { category: 'ประกาศ', title: '   ', body: 'x' }],
    ]) {
      assert.equal((await dispatchPost(admin, '/announcements', body)).status, 400, `ควรปฏิเสธ: ${label}`);
    }
    assert.ok((await dispatchPost(admin, '/announcements', { category: 'ประกาศ', title: 'ประกาศปกติ', body: 'เนื้อหาปกติ' })).status < 400,
      'ประกาศความยาวปกติต้องยังโพสต์ได้');
  });
});

// ใครมีอำนาจอนุญาต/อนุมัติการลา
//
// เดิมไม่จำกัดเลยทั้งหน้าเว็บและฝั่งเซิร์ฟเวอร์ — ครูเลือก "ครูคนไหนก็ได้" เป็นผู้อนุญาตของตัวเองได้
// แล้วครูคนนั้นกดอนุญาตได้จริง (ทดสอบยืนยันแล้วก่อนแก้: ตอบ 200 สถานะกลายเป็น approved และ
// ลายเซ็นของครูคนนั้นไปปรากฏบนใบลาในฐานะผู้อนุญาต) ผลคือใบลาใช้เป็นหลักฐานทางราชการไม่ได้เลย
describe('ผู้อนุญาต/อนุมัติการลา ต้องมีอำนาจจริง', () => {
  const roleId = (name) => db.prepare('SELECT id FROM roles WHERE name = ?').get(name).id;
  function userWithRole(code, role) {
    const id = `approver-${code}`;
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.prepare(`
      INSERT INTO users (id, employee_code, first_name, last_name, department_id, password_hash, status, created_at, updated_at)
      VALUES (?, ?, 'ทดสอบ', 'สิทธิ์อนุมัติ', ?, ?, 'active', ?, ?)
    `).run(id, code, deptId, hashSecret('Welcome@2569'), nowIso(), nowIso());
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(id, roleId(role));
    return id;
  }
  const submit = (approverId) => createLeaveRequest({
    requesterId: teacherUser.id, leaveType: 'sick', ...nextLeaveWindow(2),
    reason: 'ทดสอบสิทธิ์ผู้อนุญาต', approverId,
  });


  test('ตั้งครูธรรมดาเป็นผู้อนุญาตไม่ได้ แม้ยิงคำขอตรงเข้ามาเอง', () => {
    for (const role of ['teacher', 'registrar']) {
      const id = userWithRole(`noauth_${role}`, role);
      assert.throws(() => submit(id), /ไม่มีอำนาจอนุญาต/, `${role} ไม่ควรเป็นผู้อนุญาตได้`);
    }
  });

  test('ผู้มีอำนาจตามสายบังคับบัญชายังยื่นให้อนุญาตได้ตามปกติ', () => {
    for (const role of ['director', 'vice_director', 'head']) {
      const id = userWithRole(`auth_${role}`, role);
      assert.ok(submit(id).id, `${role} ควรเป็นผู้อนุญาตได้`);
    }
    // ผู้ดูแลระบบใช้บัญชีที่มีอยู่แล้ว ไม่สร้างเพิ่ม — จำนวนผู้ดูแลในระบบเป็นเงื่อนไขของเทสต์อื่น
    assert.equal(canApproveLeave(seed.userIds.admin), true, 'ผู้ดูแลระบบควรเป็นผู้อนุญาตได้');
    assert.ok(submit(seed.userIds.admin).id);
  });

  test('รายการผู้อนุญาตในหน้าเว็บต้องมีแต่ผู้มีอำนาจ', async () => {
    const res = await dispatchGet(loadUserForTest(seed.userIds.teacher001), '/leave/new', {});
    const select = res.body.match(/<select id="approverId"[^>]*>([\s\S]*?)<\/select>/)[1];
    const ids = [...select.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(ids.length > 0, 'ต้องมีผู้อนุญาตให้เลือกอย่างน้อยหนึ่งคน');
    for (const id of ids) {
      assert.equal(canApproveLeave(id), true, `มีคนที่ไม่มีอำนาจอนุญาตอยู่ในรายการ: ${id}`);
    }
    // ผู้รักษาการแทนคือคนที่มาทำงานแทน ไม่ใช่ผู้มีอำนาจอนุญาต — ต้องยังเลือกครูด้วยกันได้
    const delegateSelect = res.body.match(/<select id="delegateId"[^>]*>([\s\S]*?)<\/select>/)[1];
    const delegateIds = [...delegateSelect.matchAll(/<option value="([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
    assert.ok(delegateIds.some((id) => !canApproveLeave(id)),
      'รายการผู้รักษาการแทนไม่ควรถูกจำกัดเฉพาะผู้มีอำนาจอนุญาต');
  });
});

// พบตอนไล่เส้นทางการใช้งานจริงของโมดูลลา — ทั้งสามข้อทดสอบยืนยันแล้วว่าเกิดขึ้นได้จริงก่อนแก้
describe('ใบลา: ช่วงวันที่ต้องสมเหตุสมผลและไม่ทับกันเอง', () => {
  const dayOffset = (n) => {
    const t = Date.parse(`${todayInBangkok()}T00:00:00Z`) + n * 86400000;
    return new Date(t).toISOString().slice(0, 10);
  };
  const submit = (over = {}) => createLeaveRequest({
    requesterId: teacherUser.id, leaveType: 'personal', reason: 'ทดสอบช่วงวันลา',
    approverId: seed.userIds.director01, startDate: dayOffset(400), endDate: dayOffset(401), ...over,
  });

  test('ยื่นใบลาทับช่วงเดิมของตัวเองไม่ได้ ไม่ว่าจะทับหัว ทับท้าย หรือคร่อมทั้งช่วง', () => {
    const base = { startDate: dayOffset(500), endDate: dayOffset(504) };
    assert.ok(submit(base).id, 'ใบแรกต้องยื่นได้');
    const overlaps = [
      ['ทับท้าย', dayOffset(503), dayOffset(507)],
      ['ทับหัว', dayOffset(497), dayOffset(501)],
      ['อยู่ข้างในทั้งช่วง', dayOffset(501), dayOffset(502)],
      ['คร่อมทั้งช่วง', dayOffset(495), dayOffset(510)],
      ['ตรงกันเป๊ะ', dayOffset(500), dayOffset(504)],
    ];
    for (const [label, startDate, endDate] of overlaps) {
      assert.throws(() => submit({ startDate, endDate, leaveType: 'sick' }), /ทับกับใบลาเดิม/, `ควรถูกปฏิเสธ: ${label}`);
    }
  });

  test('ช่วงที่ชนกันแค่ปลายเดียวโดยไม่ทับวันจริง ต้องยังยื่นได้', () => {
    assert.ok(submit({ startDate: dayOffset(600), endDate: dayOffset(602) }).id);
    // เริ่มวันถัดจากวันที่ใบเดิมจบพอดี = ไม่ทับกัน
    assert.ok(submit({ startDate: dayOffset(603), endDate: dayOffset(604) }).id, 'วันติดกันแต่ไม่ทับ ต้องยื่นได้');
  });

  test('ใบที่ถูกยกเลิก/ไม่อนุญาตไปแล้ว ต้องไม่กันช่วงวันนั้นไว้อีก', () => {
    const cancelled = submit({ startDate: dayOffset(700), endDate: dayOffset(702) });
    cancelLeaveRequest({ id: cancelled.id, actorUser: teacherUser });
    assert.ok(submit({ startDate: dayOffset(700), endDate: dayOffset(702) }).id,
      'ยกเลิกใบเดิมแล้วต้องยื่นช่วงเดิมใหม่ได้ — ไม่งั้นแก้ไขใบลาไม่ได้เลย');

    const rejected = submit({ startDate: dayOffset(800), endDate: dayOffset(802) });
    rejectLeaveRequest({ id: rejected.id, note: 'ไม่อนุญาต', actorUser: loadUserForTest(seed.userIds.director01) });
    assert.ok(submit({ startDate: dayOffset(800), endDate: dayOffset(802) }).id, 'ใบที่ไม่อนุญาตต้องไม่กันวันไว้');
  });

  test('คนละคนลาวันเดียวกันได้ตามปกติ', () => {
    const range = { startDate: dayOffset(900), endDate: dayOffset(901) };
    assert.ok(submit(range).id);
    assert.ok(createLeaveRequest({
      requesterId: seed.userIds.reg001, leaveType: 'personal', reason: 'คนละคน',
      approverId: seed.userIds.director01, ...range,
    }).id, 'การกันวันซ้ำต้องดูเฉพาะใบลาของคนเดียวกัน');
  });

  // ลาป่วยกะทันหันต้องยื่นย้อนหลังตอนกลับมาปฏิบัติงาน จึงห้ามบล็อกการย้อนหลังทั้งหมด —
  // ที่ย้อนเกิน 1 ปีคือกรอกปีผิด (พ.ศ. หลุดลงช่อง ค.ศ.) ซึ่งจะไปเพี้ยนสถิติของปีงบประมาณที่ปิดไปแล้ว
  test('ยื่นย้อนหลังตามปกติได้ แต่ย้อนเกิน 1 ปีต้องถูกปฏิเสธ', () => {
    assert.ok(submit({ startDate: dayOffset(-20), endDate: dayOffset(-19), leaveType: 'sick' }).id,
      'ลาป่วยย้อนหลัง 20 วันต้องยื่นได้');
    assert.throws(() => submit({ startDate: dayOffset(-400), endDate: dayOffset(-399), leaveType: 'sick' }),
      /เกิน 1 ปี/, 'ย้อนหลังเกินหนึ่งปีต้องถูกปฏิเสธ');
  });

  // ใบลาที่ค่าวันที่พังจากยุคก่อนมีการตรวจสอบ ถ้าปล่อยไว้จะค้าง "รออนุญาต" ตลอดกาล และตอนนี้ยัง
  // ไปกันไม่ให้เจ้าตัวยื่นใบลาช่วงนั้นได้อีกเลยเพราะการตรวจการลาทับช่วง
  test('ใบลาเก่าที่ช่วงวันที่เป็นไปไม่ได้ ต้องถูกยกเลิกตอนอัปเกรดฐานข้อมูล', () => {
    const insert = db.prepare(`
      INSERT INTO leave_requests (id, requester_id, leave_type, start_date, end_date, days_count, reason, status, approver_id, created_at, updated_at)
      VALUES (?, ?, 'sick', ?, ?, ?, 'ข้อมูลเก่าที่วันที่พัง', 'pending', ?, ?, ?)`);
    const broken = [
      ['พ.ศ. หลุดลงช่อง ค.ศ.', '2569-10-01', '2569-10-05', 5],
      ['พิมพ์ปีผิดจนยาว 100 ปี', '2026-10-01', '2126-10-02', 36526],
      ['วันสิ้นสุดมาก่อนวันเริ่ม', '2026-10-05', '2026-10-01', 1],
    ];
    const madeIds = [];
    for (const [label, s, e, days] of broken) {
      const id = `broken-leave-${madeIds.length}`;
      insert.run(id, teacherUser.id, s, e, days, seed.userIds.director01, nowIso(), nowIso());
      madeIds.push([id, label]);
    }
    const stillPending = () => madeIds.filter(([id]) =>
      db.prepare("SELECT status FROM leave_requests WHERE id = ?").get(id).status === 'pending');
    assert.equal(stillPending().length, 3, 'เตรียมข้อมูลพังไว้ 3 ใบ');

    migrate();
    for (const [id, label] of madeIds) {
      assert.equal(db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(id).status, 'cancelled',
        `ต้องถูกยกเลิก: ${label}`);
    }
    // ใบลาปกติต้องไม่โดนลูกหลง
    const ok = submit({ startDate: dayOffset(950), endDate: dayOffset(951) });
    migrate();
    assert.equal(db.prepare('SELECT status FROM leave_requests WHERE id = ?').get(ok.id).status, 'pending',
      'ใบลาปกติต้องไม่ถูกยกเลิกตอนอัปเกรด');
  });
});

// โรงเรียนยังต้องมีใบลากระดาษเก็บเข้าแฟ้มตามระเบียบ — เดิมโมดูลนี้ไม่มีหน้าพิมพ์เลย ครูจึงต้องไปกรอก
// แบบฟอร์มกระดาษซ้ำอีกใบด้วยมือ ทั้งที่ข้อมูลอยู่ในระบบครบแล้ว (ฝั่งหนังสือมีหน้าพิมพ์มาตั้งแต่แรก)
describe('แบบใบลาสำหรับพิมพ์', () => {
  const dayOffset = (n) => new Date(Date.parse(`${todayInBangkok()}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  function approvedLeave(over = {}) {
    const { id } = createLeaveRequest({
      requesterId: teacherUser.id, leaveType: 'sick', reason: 'เป็นไข้ พักรักษาตัว',
      approverId: seed.userIds.director01, startDate: dayOffset(1000), endDate: dayOffset(1002), ...over,
    });
    approveLeaveRequest({ id, note: 'อนุญาตตามที่ขอ', actorUser: loadUserForTest(seed.userIds.director01) });
    return id;
  }

  test('พิมพ์ได้ และมีทุกช่องที่แบบใบลาราชการต้องมี', async () => {
    const id = approvedLeave({ startDate: dayOffset(1100), endDate: dayOffset(1102) });
    const res = await dispatchGet(teacherUser, `/leave/${id}/print`, {});
    assert.equal(res.status, 200);
    for (const field of ['เขียนที่', 'เรื่อง', 'เรียน', 'ข้าพเจ้า', 'ตำแหน่ง', 'มีกำหนด',
      'ความเห็นผู้บังคับบัญชา', 'คำสั่ง', 'สถิติการลาในปีงบประมาณ']) {
      assert.ok(res.body.includes(field), `แบบใบลาต้องมีช่อง "${field}"`);
    }
    assert.ok(res.body.includes('อนุญาตตามที่ขอ'), 'ต้องมีความเห็นของผู้อนุญาต');
    assert.match(res.body, /☑ อนุญาต/, 'ใบที่อนุญาตแล้วต้องติ๊กช่อง "อนุญาต"');
  });

  test('ตารางสถิติการลานับเฉพาะใบที่อนุญาตแล้วในปีงบประมาณเดียวกัน และไม่นับใบนี้ซ้ำ', () => {
    const requesterId = seed.userIds.head_acad;
    const fy = fiscalYearRange(todayInBangkok());
    const inYear = (n) => {
      // วันที่ n วันหลังต้นปีงบประมาณ — อยู่ในปีงบประมาณเดียวกันแน่นอน
      return new Date(Date.parse(`${fy.start}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
    };
    db.prepare('DELETE FROM leave_requests WHERE requester_id = ?').run(requesterId);
    const mk = (leaveType, from, days, status) => {
      const id = uuid();
      db.prepare(`
        INSERT INTO leave_requests (id, requester_id, leave_type, start_date, end_date, days_count, reason, status, approver_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'สร้างสำหรับนับสถิติ', ?, ?, ?, ?)`)
        .run(id, requesterId, leaveType, inYear(from), inYear(from + days - 1), days, status, seed.userIds.admin, nowIso(), nowIso());
      return id;
    };
    mk('sick', 10, 3, 'approved');
    mk('sick', 20, 2, 'approved');
    mk('personal', 30, 1, 'approved');
    mk('sick', 40, 9, 'pending');    // ยังไม่อนุญาต — ต้องไม่ถูกนับ
    mk('sick', 50, 7, 'rejected');   // ไม่อนุญาต — ต้องไม่ถูกนับ
    const thisOne = mk('sick', 60, 4, 'approved');

    const stats = leaveStatsForFiscalYear({ requesterId, onDate: inYear(60), excludeLeaveId: thisOne });
    assert.equal(stats.byType.sick?.days, 5, 'ลาป่วยที่อนุญาตแล้วก่อนหน้านี้ต้องเป็น 3+2 = 5 วัน (ไม่รวมใบนี้/รอ/ไม่อนุญาต)');
    assert.equal(stats.byType.personal?.days, 1);
    assert.equal(stats.yearBe, fy.yearBe);
  });

  test('ปีงบประมาณไทยเริ่ม 1 ตุลาคม', () => {
    assert.deepEqual(fiscalYearRange('2026-09-30'), { start: '2025-10-01', end: '2026-09-30', yearBe: 2569 });
    assert.deepEqual(fiscalYearRange('2026-10-01'), { start: '2026-10-01', end: '2027-09-30', yearBe: 2570 });
  });

  test('ชื่อและตำแหน่งบนใบลาต้องเป็นสำเนา ณ วันที่ลงนาม ไม่เปลี่ยนตามโปรไฟล์', async () => {
    const id = approvedLeave({ startDate: dayOffset(1200), endDate: dayOffset(1201) });
    const at = db.prepare("SELECT signer_name, signer_position FROM leave_signatures WHERE leave_request_id = ? AND step = 'approved'").get(id);
    db.prepare("UPDATE users SET last_name = 'เปลี่ยนหลังลงนามแล้ว', position = 'ย้ายไปโรงเรียนอื่น' WHERE id = ?")
      .run(seed.userIds.director01);
    const res = await dispatchGet(teacherUser, `/leave/${id}/print`, {});
    assert.ok(res.body.includes(at.signer_name), 'ต้องคงชื่อผู้อนุญาต ณ วันที่ลงนาม');
    assert.ok(!res.body.includes('เปลี่ยนหลังลงนามแล้ว') && !res.body.includes('ย้ายไปโรงเรียนอื่น'),
      'ต้องไม่เอาชื่อ/ตำแหน่งปัจจุบันมาแทนหลักฐานบนใบลาที่ลงนามไปแล้ว');
  });

  test('ผู้อนุญาตที่ไม่มีรูปลายเซ็นต้องยังได้ที่ว่างให้เซ็นด้วยปากกา', async () => {
    db.prepare('UPDATE users SET signature_image = NULL WHERE id = ?').run(seed.userIds.vicedir01);
    const id = approvedLeave({ startDate: dayOffset(1300), endDate: dayOffset(1301) });
    const res = await dispatchGet(teacherUser, `/leave/${id}/print`, {});
    assert.match(res.body, /sig-space/, 'ต้องเว้นที่ว่างไว้ให้ลงลายมือชื่อจริง');
    assert.ok(res.body.includes('(ลงชื่อ)'), 'ต้องมีเส้น (ลงชื่อ) ให้เซ็น');
  });

  // ใบลาป่วยมีข้อมูลสุขภาพซึ่งเป็นเรื่องส่วนตัว หน้าพิมพ์ต้องคุมสิทธิ์เท่ากับหน้ารายละเอียด
  test('คนที่ไม่เกี่ยวข้องพิมพ์ใบลาของคนอื่นไม่ได้', async () => {
    const id = approvedLeave({ startDate: dayOffset(1400), endDate: dayOffset(1401) });
    const outsider = loadUserForTest(seed.userIds.reg001);
    assert.equal((await dispatchGet(outsider, `/leave/${id}/print`, {})).status, 404);
    // ผู้ขอกับผู้อนุญาตยังเปิดได้ตามปกติ
    assert.equal((await dispatchGet(teacherUser, `/leave/${id}/print`, {})).status, 200);
    assert.equal((await dispatchGet(loadUserForTest(seed.userIds.director01), `/leave/${id}/print`, {})).status, 200);
  });
});

// ตำแหน่งของบุคลากรในโรงเรียน — ถูกคัดลอกไปเป็น "ตำแหน่งผู้ลงนาม" บนตราประทับในไฟล์ PDF และบนใบลา
// ถ้าปล่อยให้พิมพ์เองอิสระ ตำแหน่งเดียวกันจะถูกเขียนคนละแบบในเอกสารของโรงเรียนเดียวกัน
describe('รายการตำแหน่งในโรงเรียน', () => {
  test('ครอบคลุมตำแหน่งจริงของโรงเรียนครบทุกกลุ่ม', () => {
    const groups = SCHOOL_POSITIONS.map((g) => g.group);
    for (const need of ['ผู้บริหารสถานศึกษา', 'หัวหน้ากลุ่มงาน', 'ข้าราชการครู', 'บุคลากรทางการศึกษาและลูกจ้าง']) {
      assert.ok(groups.includes(need), `ขาดกลุ่ม "${need}"`);
    }
    const all = SCHOOL_POSITIONS.flatMap((g) => g.items);
    // ตำแหน่งที่โรงเรียนขนาดนี้ต้องมีแน่ๆ
    for (const need of ['ผู้อำนวยการโรงเรียน', 'รองผู้อำนวยการโรงเรียน', 'ครูผู้ช่วย', 'ครู (คศ.1)',
      'พนักงานราชการ', 'ครูอัตราจ้าง', 'เจ้าหน้าที่ธุรการ', 'นักการภารโรง', 'หัวหน้าฝ่ายบริหารวิชาการ']) {
      assert.ok(all.includes(need), `ขาดตำแหน่ง "${need}"`);
    }
    assert.equal(new Set(all).size, all.length, 'มีตำแหน่งซ้ำกันในรายการ');
    assert.ok(all.length >= 20, `ตำแหน่งน้อยเกินไป (${all.length})`);
  });

  test('ทุกหน้าที่กรอกตำแหน่งต้องมีรายการให้เลือก และยังพิมพ์เองได้', async () => {
    const admin = loadUserForTest(seed.userIds.admin);
    for (const [label, path] of [['หน้าโปรไฟล์', '/profile'], ['หน้าจัดการผู้ใช้', '/admin/users']]) {
      const body = (await dispatchGet(admin, path, {})).body;
      const list = body.match(/<datalist id="[^"]+">([\s\S]*?)<\/datalist>/);
      assert.ok(list, `${label} ไม่มีรายการตำแหน่งให้เลือก`);
      assert.ok(list[1].includes('ครูผู้ช่วย'), `${label} รายการตำแหน่งไม่ครบ`);
      // ต้องเป็น input+datalist ไม่ใช่ select — ไม่งั้นตำแหน่งเฉพาะของโรงเรียนที่ไม่มีในรายการจะกรอกไม่ได้
      assert.match(body, /<input[^>]*list="[^"]+"/, `${label} ต้องยังพิมพ์ตำแหน่งเองได้`);
    }
  });

  test('ตำแหน่งเดิมที่พิมพ์เองไว้ก่อนหน้านี้ ต้องไม่หายไปจากฟอร์ม', async () => {
    const custom = 'ครูผู้รับผิดชอบโครงการพิเศษของโรงเรียน';
    db.prepare('UPDATE users SET position = ? WHERE id = ?').run(custom, seed.userIds.teacher001);
    const body = (await dispatchGet(loadUserForTest(seed.userIds.teacher001), '/profile', {})).body;
    assert.ok(body.includes(custom), 'ค่าที่พิมพ์เองไว้เดิมหายไปจากฟอร์มตอนเปิดมาแก้');
  });
});

// แดชบอร์ด — หน้าแรกที่ทุกคนเห็นทันทีหลังล็อกอิน
//
// เดิมทุกคำสั่งบนหน้านี้ไม่มีการกรองสิทธิ์เลยแม้แต่ที่เดียว ที่ร้ายแรงที่สุดคือรายการ "เอกสารล่าสุด"
// ซึ่งดึง 8 ฉบับล่าสุดของทั้งระบบมาแสดง — ทดสอบยืนยันแล้วว่าครูธรรมดาเห็นชื่อเรื่องของหนังสือ
// ชั้นลับมากที่ตัวเองเปิดอ่านไม่ได้ โดยไม่ต้องพยายามอะไรเลย แค่ล็อกอินเข้ามาก็เห็น
// "ระยะเวลาเฉลี่ยจนเสร็จสิ้น" เป็นตัวเลขที่โรงเรียนรายงาน สพฐ. และใช้ประเมินตนเอง (SAR) — เดิมคิดจาก
// updated_at ซึ่งขยับทุกครั้งที่แตะเอกสารทีหลัง จึงพองตามเรื่องที่ไม่เกี่ยวกับความเร็วในการทำงานเลย
describe('เวลาที่ดำเนินการเสร็จสิ้น ต้องไม่ขยับตามการแตะเอกสารทีหลัง', () => {
  const hoursOf = (id) => db.prepare(`
    SELECT (julianday(COALESCE(completed_at, updated_at)) - julianday(created_at)) * 24 h
    FROM documents WHERE id = ?`).get(id).h;

  function completedDoc(title) {
    const doc = makeDoc({ title });
    const stepId = assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, actorUser: registrarUser });
    acknowledgeAndComplete({ stepId, actorUser: loadUserForTest(seed.userIds.director01) });
    // ย้อนวันให้เหมือนของจริง: ลงรับเมื่อ 90 วันก่อน ดำเนินการเสร็จภายในวันเดียว
    db.prepare(`UPDATE documents SET created_at = datetime('now','-90 days'),
      updated_at = datetime('now','-89 days'), completed_at = datetime('now','-89 days') WHERE id = ?`).run(doc.id);
    return doc;
  }

  test('บันทึกเวลาที่ปิดเรื่องไว้ตอนกดรับทราบ', () => {
    const doc = makeDoc({ title: 'ทดสอบว่าบันทึกเวลาปิดเรื่อง' });
    assert.equal(getDocRow(doc.id).completed_at, null, 'ยังไม่ปิดเรื่องต้องยังไม่มีเวลา');
    const stepId = assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, actorUser: registrarUser });
    acknowledgeAndComplete({ stepId, actorUser: loadUserForTest(seed.userIds.director01) });
    assert.ok(getDocRow(doc.id).completed_at, 'ปิดเรื่องแล้วต้องมีเวลาที่ปิด');
  });

  test('กดจัดเก็บเข้าแฟ้มหลายเดือนให้หลัง ต้องไม่ทำให้เวลาที่ใช้ดำเนินการพองขึ้น', () => {
    const doc = completedDoc('หนังสือที่เสร็จเร็วแต่เพิ่งมาจัดเก็บทีหลัง');
    const before = hoursOf(doc.id);
    assert.ok(Math.abs(before - 24) < 1, `ตั้งต้นต้องเป็น ~24 ชม. ได้ ${before}`);
    archiveDocument({ documentId: doc.id, actorUser: registrarUser });
    const after = hoursOf(doc.id);
    assert.ok(Math.abs(after - before) < 1,
      `กดจัดเก็บแล้วเวลาดำเนินการเปลี่ยนจาก ${before.toFixed(0)} เป็น ${after.toFixed(0)} ชม.`);
  });

  test('เลื่อนตำแหน่งตราประทับทีหลัง ต้องไม่ทำให้เวลาที่ใช้ดำเนินการพองขึ้น', async () => {
    const doc = completedDoc('หนังสือที่ถูกเลื่อนตราประทับทีหลัง');
    const before = hoursOf(doc.id);
    await dispatchPost(registrarUser, `/documents/${doc.id}/stamp-position`, { x: 60, y: 70 });
    assert.ok(Math.abs(hoursOf(doc.id) - before) < 1, 'การเลื่อนตราประทับไม่ควรนับเป็นเวลาดำเนินการ');
  });

  // หนังสือถูกทำลายเมื่อครบอายุเก็บอีก 5–10 ปีข้างหน้า ถ้าเวลานั้นไปนับเป็นเวลาดำเนินการ
  // ค่าเฉลี่ยของทั้งโรงเรียนจะกลายเป็นหน่วยปีทันทีที่เริ่มทำลายหนังสือเก่าชุดแรก
  test('ทำลายหนังสือเมื่อครบอายุเก็บ ต้องไม่ทำให้เวลาที่ใช้ดำเนินการพองขึ้น', () => {
    const doc = completedDoc('หนังสือที่จะถูกทำลายเมื่อครบอายุ');
    const before = hoursOf(doc.id);
    db.prepare(`UPDATE documents SET status = 'destroyed', destroyed_at = ?, updated_at = ? WHERE id = ?`)
      .run(nowIso(), nowIso(), doc.id);
    assert.ok(Math.abs(hoursOf(doc.id) - before) < 1, 'การทำลายเมื่อครบอายุไม่ควรนับเป็นเวลาดำเนินการ');
  });

  test('หนังสือเก่าที่ปิดไปก่อนมีคอลัมน์นี้ ต้องถูกเติมเวลาย้อนหลังจากขั้นตอนสุดท้าย', () => {
    const doc = makeDoc({ title: 'หนังสือเก่าที่ยังไม่มีเวลาปิดเรื่อง' });
    const stepId = assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, actorUser: registrarUser });
    acknowledgeAndComplete({ stepId, actorUser: loadUserForTest(seed.userIds.director01) });
    const decidedAt = db.prepare('SELECT decided_at FROM workflow_steps WHERE id = ?').get(stepId).decided_at;
    // จำลองฐานข้อมูลรุ่นเก่าจริงๆ: ตัดคอลัมน์ทิ้งแล้วขยับ updated_at ไปไกลเหมือนถูกแตะทีหลัง
    // (ถ้าแค่ล้างค่าเป็น NULL จะไม่ได้ทดสอบอะไร เพราะ migrate() ข้ามเมื่อคอลัมน์มีอยู่แล้ว)
    db.prepare(`UPDATE documents SET updated_at = datetime('now','+400 days') WHERE id = ?`).run(doc.id);
    db.exec('ALTER TABLE documents DROP COLUMN completed_at');
    assert.ok(!db.prepare('PRAGMA table_info(documents)').all().some((c) => c.name === 'completed_at'));

    migrate();

    assert.ok(db.prepare('PRAGMA table_info(documents)').all().some((c) => c.name === 'completed_at'),
      'migrate() ต้องเพิ่มคอลัมน์กลับมา');
    assert.equal(getDocRow(doc.id).completed_at, decidedAt,
      'ต้องเติมจากเวลาที่ขั้นตอนสุดท้ายถูกตัดสิน ไม่ใช่ updated_at ที่ถูกแตะทีหลัง');
  });
});

// รายงานที่โรงเรียนต้องส่ง สพฐ. และใช้ประเมินตนเองเป็นรายปีงบประมาณเสมอ — เดิมหน้านี้เป็นตัวเลข
// สะสมตั้งแต่เปิดใช้ระบบอย่างเดียว ไม่มีตัวกรองช่วงเวลาเลย จึงเปรียบเทียบปีต่อปีไม่ได้
describe('รายงานสรุป: แยกตามปีงบประมาณ', () => {
  const admin = () => loadUserForTest(seed.userIds.admin);
  const totalOf = (body) => Number(/kpi-value">(\d+)<\/div><div class="kpi-label">เอกสารทั้งหมด/.exec(body)?.[1]);
  const countInRange = (start, end) => db.prepare(
    'SELECT COUNT(*) c FROM documents WHERE deleted_at IS NULL AND date(created_at) BETWEEN ? AND ?').get(start, end).c;

  test('ปีงบประมาณไทยเริ่ม 1 ตุลาคม — ตัวเลขต้องตรงกับที่นับจากฐานข้อมูลจริง', async () => {
    const fy = fiscalYearRange(todayInBangkok());
    const res = await dispatchGet(admin(), '/reports', { fy: String(fy.yearBe) });
    assert.equal(res.status, 200);
    assert.equal(totalOf(res.body), countInRange(fy.start, fy.end));
    assert.ok(res.body.includes(`ปีงบประมาณ ${fy.yearBe}`), 'ต้องบอกว่ากำลังดูปีไหนอยู่');
  });

  test('เลือก "ทั้งหมด" ได้ และต้องไม่น้อยกว่าปีเดียว', async () => {
    const fy = fiscalYearRange(todayInBangkok());
    const all = totalOf((await dispatchGet(admin(), '/reports', { fy: 'all' })).body);
    const one = totalOf((await dispatchGet(admin(), '/reports', { fy: String(fy.yearBe) })).body);
    assert.ok(all >= one, `ทั้งหมด (${all}) ต้องไม่น้อยกว่าปีเดียว (${one})`);
    assert.equal(all, db.prepare('SELECT COUNT(*) c FROM documents WHERE deleted_at IS NULL').get().c);
  });

  test('ปีที่ไม่มีหนังสือเลยต้องได้ 0 ไม่ใช่ตกกลับไปนับทั้งหมด', async () => {
    const res = await dispatchGet(admin(), '/reports', { fy: '2500' });
    assert.equal(res.status, 200);
    assert.equal(totalOf(res.body), 0, 'ปี 2500 ไม่ควรมีหนังสือ');
  });

  test('ค่าปีที่กรอกมั่วต้องไม่ทำให้หน้าพัง และตกกลับไปปีปัจจุบัน', async () => {
    const fy = fiscalYearRange(todayInBangkok());
    const expected = countInRange(fy.start, fy.end);
    for (const fyParam of ['abc', '9999', '0', '-5', '', '2569; DROP TABLE documents']) {
      const res = await dispatchGet(admin(), '/reports', { fy: fyParam });
      assert.equal(res.status, 200, `fy=${fyParam} ต้องไม่พัง`);
      assert.equal(totalOf(res.body), expected, `fy=${fyParam} ควรตกกลับไปปีปัจจุบัน`);
    }
    assert.ok(db.prepare('SELECT COUNT(*) c FROM documents').get().c > 0, 'ตาราง documents ต้องยังอยู่');
  });

  test('ไฟล์ CSV ต้องครอบคลุมช่วงเดียวกับที่เห็นบนหน้าจอ', async () => {
    const fy = fiscalYearRange(todayInBangkok());
    const page = totalOf((await dispatchGet(admin(), '/reports', { fy: String(fy.yearBe) })).body);
    const csv = await dispatchGet(admin(), '/reports/export.csv', { fy: String(fy.yearBe) });
    const dataRows = csv.body.trim().split('\r\n').length - 1;
    assert.equal(dataRows, page, 'จำนวนแถวใน CSV ต้องตรงกับตัวเลขบนหน้าจอ');
    // ชื่อไฟล์จริงเป็นภาษาไทย (ผ่าน filename*=UTF-8'') ส่วน filename= เป็นชื่อสำรอง ASCII สำหรับเบราว์เซอร์เก่า
    assert.match(csv.headers['Content-Disposition'] || '', new RegExp(`documents-report-${fy.yearBe}\\.csv`),
      'ชื่อไฟล์สำรองต้องบอกว่าเป็นของปีไหน');
  });

  test('ตัวกรองปีต้องไม่ทำให้สิทธิ์หลุด', async () => {
    const secret = makeDoc({ title: 'ลับมากที่ต้องไม่โผล่ในรายงานของครู', secretLevel: 'top_secret', createdBy: seed.userIds.reg001 });
    const teacher = loadUserForTest(seed.userIds.teacher001);
    assert.equal(canUserSeeDocument(teacher, getDocRow(secret.id)), false);
    for (const fy of ['all', String(fiscalYearRange(todayInBangkok()).yearBe)]) {
      const csv = await dispatchGet(teacher, '/reports/export.csv', { fy });
      assert.ok(!csv.body.includes('ลับมากที่ต้องไม่โผล่ในรายงานของครู'), `fy=${fy} ทำให้หนังสือลับหลุด`);
    }
  });
});

describe('แดชบอร์ด: ตัวเลขและรายการต้องนับเฉพาะที่ผู้ใช้มีสิทธิ์เห็น', () => {
  const SECRET_TITLE = 'ลับมากเรื่องที่ครูคนนี้ไม่เกี่ยวข้องเลย';
  let secretDoc;
  before(() => {
    secretDoc = makeDoc({ title: SECRET_TITLE, secretLevel: 'top_secret', createdBy: seed.userIds.reg001 });
  });

  test('ชื่อเรื่องหนังสือลับต้องไม่โผล่ในรายการ "เอกสารล่าสุด" ของคนที่ไม่มีสิทธิ์', async () => {
    const outsider = loadUserForTest(seed.userIds.teacher001);
    assert.equal(canUserSeeDocument(outsider, getDocRow(secretDoc.id)), false, 'ตั้งต้นต้องเป็นหนังสือที่ครูคนนี้เห็นไม่ได้');
    const res = await dispatchGet(outsider, '/', {});
    assert.equal(res.status, 200);
    assert.ok(!res.body.includes(SECRET_TITLE), 'ชื่อเรื่องหนังสือลับหลุดมาอยู่บนหน้าแรกของครู');

    // และผู้ที่มีสิทธิ์ต้องยังเห็น ไม่ใช่ซ่อนหมดทุกคนแล้วเทสต์ผ่านแบบไม่ได้ตรวจอะไร
    const owner = loadUserForTest(seed.userIds.reg001);
    assert.ok((await dispatchGet(owner, '/', {})).body.includes(SECRET_TITLE), 'ผู้บันทึกเองต้องยังเห็นหนังสือของตัวเอง');
  });

  test('ตัวเลข KPI ต้องนับเฉพาะที่ผู้ใช้เห็นได้ ไม่ใช่ทั้งระบบ', async () => {
    const kpiOf = (body) => {
      const values = [...body.matchAll(/<div class="kpi-value">([\d,.-]+)<\/div>/g)].map((m) => m[1]);
      const labels = [...body.matchAll(/<div class="kpi-label">([^<]*)<\/div>/g)].map((m) => m[1]);
      return Object.fromEntries(labels.map((l, i) => [l, values[i]]));
    };
    const outsider = kpiOf((await dispatchGet(loadUserForTest(seed.userIds.teacher001), '/', {})).body);
    const owner = kpiOf((await dispatchGet(loadUserForTest(seed.userIds.reg001), '/', {})).body);
    const key = 'หนังสือเข้าวันนี้';
    assert.ok(key in outsider && key in owner, `หา KPI "${key}" ไม่เจอ: ${JSON.stringify(outsider)}`);
    assert.ok(Number(outsider[key]) < Number(owner[key]),
      `ครูต้องนับได้น้อยกว่าธุรการ เพราะมีหนังสือลับที่เห็นไม่ได้ (ครู=${outsider[key]} ธุรการ=${owner[key]})`);
  });

  // ทุกหน้าที่แสดงรายการเอกสารต้องกรองสิทธิ์เหมือนกันหมด ไม่ใช่จำได้เฉพาะหน้าที่เคยมีคนทัก
  test('ไม่มีหน้าไหนแสดงชื่อเรื่องหนังสือลับให้คนที่ไม่มีสิทธิ์', async () => {
    const outsider = loadUserForTest(seed.userIds.teacher001);
    const leaked = [];
    for (const pathname of ['/', '/tasks', '/summary', '/daily-summary', '/documents', '/reports', '/notifications', '/my-tasks']) {
      const res = await dispatchGet(outsider, pathname, {});
      if (res.status !== 200) continue;
      if (res.body.includes(SECRET_TITLE)) leaked.push(pathname);
    }
    assert.deepEqual(leaked, [], `หน้าที่ทำหนังสือลับหลุด: ${leaked.join(', ')}`);
  });
});

// แถบค้นหาด้านบนสุดกับความปลอดภัยของหน้าโปรไฟล์
describe('ค้นหาจากแถบบนสุด และหน้าโปรไฟล์', () => {
  const reg = () => loadUserForTest(seed.userIds.reg001);
  const teacher = () => loadUserForTest(seed.userIds.teacher001);

  // เดิมแถบค้นหาส่งแต่ q ไปที่ /documents ซึ่ง default เป็น incoming เสมอ ผลคือค้นเลขหนังสือ "ออก"
  // จากแถบบนสุดแล้วไม่เจออะไรเลย ทั้งที่หนังสือฉบับนั้นมีอยู่จริง (ทดสอบยืนยันแล้วก่อนแก้)
  test('ค้นจากแถบบนสุดต้องเจอทั้งหนังสือเข้าและหนังสือออก', async () => {
    const KEY = 'คำค้นเฉพาะสำหรับเทสต์';
    makeDoc({ direction: 'incoming', title: `หนังสือเข้า${KEY}` });
    makeDoc({ direction: 'outgoing', title: `หนังสือออก${KEY}` });

    // อ่าน URL ที่ฟอร์มค้นหาส่งจริง ไม่ใช่เดาเอง — ถ้าวันหลังมีคนถอด direction ออกจากฟอร์ม เทสต์ต้องล้ม
    const home = (await dispatchGet(reg(), '/', {})).body;
    const form = home.match(/<div class="topbar-search">[\s\S]*?<\/form>/)[0];
    const hidden = Object.fromEntries([...form.matchAll(/<input type="hidden" name="(\w+)" value="([^"]*)"/g)].map((m) => [m[1], m[2]]));
    assert.equal(hidden.direction, 'all', 'แถบค้นหาต้องส่ง direction=all ไม่งั้นจะค้นเจอแต่หนังสือเข้า');

    const res = await dispatchGet(reg(), '/documents', { ...hidden, q: KEY });
    assert.equal(res.status, 200);
    assert.match(res.body, new RegExp(`หนังสือเข้า${KEY}`), 'ต้องเจอหนังสือเข้า');
    assert.match(res.body, new RegExp(`หนังสือออก${KEY}`), 'ต้องเจอหนังสือออก');
    assert.match(res.body, /<th>ประเภท<\/th>/, 'โหมดค้นหารวมต้องมีคอลัมน์บอกว่าแถวไหนเป็นเข้าหรือออก');
  });

  test('ทะเบียนแยกทิศทางยังแยกกันเหมือนเดิม', async () => {
    const KEY = 'คำค้นแยกทิศทาง';
    makeDoc({ direction: 'incoming', title: `เข้า${KEY}` });
    makeDoc({ direction: 'outgoing', title: `ออก${KEY}` });
    const inc = await dispatchGet(reg(), '/documents', { direction: 'incoming', q: KEY });
    assert.match(inc.body, new RegExp(`เข้า${KEY}`));
    assert.doesNotMatch(inc.body, new RegExp(`ออก${KEY}`), 'ทะเบียนหนังสือเข้าต้องไม่มีหนังสือออกปน');
    const out = await dispatchGet(reg(), '/documents', { direction: 'outgoing', q: KEY });
    assert.match(out.body, new RegExp(`ออก${KEY}`));
    assert.doesNotMatch(out.body, new RegExp(`(^|[^อ])เข้า${KEY}`), 'ทะเบียนหนังสือออกต้องไม่มีหนังสือเข้าปน');
  });

  test('ไฟล์ที่ส่งออกจากโหมดค้นหารวม ต้องบอกได้ว่าแถวไหนเป็นเข้าหรือออก', async () => {
    const res = await dispatchGet(reg(), '/documents/export.xlsx', { direction: 'all' });
    assert.equal(res.status, 200);
    const sheet = readWorkbook(res.buffer)[0];
    assert.ok(sheet.rows[0].includes('ประเภท'), `หัวตารางไม่มีคอลัมน์ประเภท: ${sheet.rows[0].join(' | ')}`);
  });

  // PIN ใช้แทนการลงลายมือชื่อ ถ้าหน้าโปรไฟล์ยอมให้ตั้ง 111111 ได้ การบังคับตั้ง PIN ที่เดายากตอน
  // เข้าใช้ครั้งแรกก็ไม่มีความหมาย เพราะเปลี่ยนกลับได้ทันทีในหน้าถัดไป
  test('เปลี่ยน PIN ในหน้าโปรไฟล์ ต้องใช้เกณฑ์เดียวกับตอนตั้งครั้งแรก', async () => {
    const user = teacher();
    const pass = pw('teacher001');
    for (const weak of ['111111', '123456', '654321', '000000']) {
      const res = await dispatchPost(user, '/profile/pin', { currentPassword: pass, newPin: weak });
      assert.equal(res.status, 400, `ควรปฏิเสธ PIN ${weak}`);
      assert.match(res.json.error || '', /เดาง่าย/);
    }
    assert.equal((await dispatchPost(user, '/profile/pin', { currentPassword: pass, newPin: '739184' })).status, 200,
      'PIN ที่เดายากต้องยังตั้งได้');
  });

  test('เปลี่ยนรหัสผ่านเป็นรหัสเดิมไม่ได้', async () => {
    const user = teacher();
    const pass = pw('teacher001');
    const res = await dispatchPost(user, '/profile/password', { currentPassword: pass, newPassword: pass });
    assert.equal(res.status, 400, 'ตั้งรหัสเดิมซ้ำไม่ได้เปลี่ยนอะไรเลย แต่หน้าจอจะขึ้นว่าเปลี่ยนเรียบร้อย');
    assert.match(res.json.error || '', /ไม่ซ้ำกับรหัสผ่านเดิม/);
  });

  test('ข้อมูลส่วนตัว: จำกัดความยาวและตรวจรูปแบบอีเมล', async () => {
    const user = teacher();
    for (const [label, body] of [
      ['ชื่อยาวเกินกำหนด', { firstName: 'ก'.repeat(50000), lastName: 'ข' }],
      ['ตำแหน่งยาวเกินกำหนด', { firstName: 'ก', lastName: 'ข', position: 'ก'.repeat(50000) }],
      ['อีเมลรูปแบบผิด', { firstName: 'ก', lastName: 'ข', email: 'ไม่ใช่อีเมล' }],
    ]) {
      assert.equal((await dispatchPost(user, '/profile/info', body)).status, 400, `ควรปฏิเสธ: ${label}`);
    }
    assert.equal((await dispatchPost(user, '/profile/info', { firstName: 'ครูใหญ่', lastName: 'สอนดี', email: 'teacher@school.local' })).status, 200,
      'ข้อมูลปกติต้องยังบันทึกได้');
  });

  // ลายเซ็นถูกฝังลงในไฟล์ PDF ที่ประทับตราและแสดงบนหน้าเว็บ ไฟล์ที่ไม่ใช่รูปจริงจึงต้องไม่หลุดเข้าไป
  test('ลายเซ็นรับเฉพาะ PNG/JPG จริงเท่านั้น', async () => {
    const user = teacher();
    const png = `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(40)]).toString('base64')}`;
    for (const [label, dataUrl] of [
      ['SVG ที่มีสคริปต์', `data:image/svg+xml;base64,${Buffer.from('<svg onload="alert(1)"/>').toString('base64')}`],
      ['อ้างว่าเป็น PNG แต่ข้างในเป็นข้อความ', `data:image/png;base64,${Buffer.from('ไม่ใช่รูป').toString('base64')}`],
      ['ไฟล์ใหญ่เกิน 1MB', `data:image/png;base64,${Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(1200000)]).toString('base64')}`],
    ]) {
      assert.ok((await dispatchPost(user, '/profile/signature', { dataUrl })).status >= 400, `ควรปฏิเสธ: ${label}`);
    }
    assert.equal((await dispatchPost(user, '/profile/signature', { dataUrl: png })).status, 200, 'PNG จริงต้องอัปโหลดได้');
  });
});

// แก้ไขข้อมูลผู้ใช้ — เดิมทำได้แค่เพิ่มกับลบ ครูย้ายฝ่าย/เปลี่ยนตำแหน่ง/ชื่อพิมพ์ผิดตอนนำเข้าจาก Excel
// แก้ไม่ได้เลย ต้องลบทิ้งแล้วสร้างใหม่ ซึ่งทำให้ประวัติเอกสารและลายเซ็นเดิมผูกกับบัญชีที่ถูกระงับไปแล้ว
describe('แก้ไขข้อมูลผู้ใช้', () => {
  const admin = () => loadUserForTest(seed.userIds.admin);
  const roleId = (name) => db.prepare('SELECT id FROM roles WHERE name = ?').get(name).id;
  function makeUser(code) {
    const id = `edit-${code}`;
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.prepare(`
      INSERT INTO users (id, employee_code, first_name, last_name, department_id, password_hash, status, created_at, updated_at)
      VALUES (?, ?, 'ก่อนแก้', 'นามสกุลเดิม', ?, ?, 'active', ?, ?)
    `).run(id, code, deptId, hashSecret('Welcome@2569'), nowIso(), nowIso());
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(id, roleId('teacher'));
    return id;
  }
  const roleOf = (id) => db.prepare('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?').get(id)?.name;

  test('แก้ชื่อ ฝ่าย ตำแหน่ง และบทบาทได้จริง', async () => {
    const id = makeUser('edituser01');
    const dept2 = db.prepare('SELECT id FROM departments WHERE id != ? LIMIT 1').get(deptId).id;
    const res = await dispatchPost(admin(), `/admin/users/${id}/edit`, {
      prefix: 'นาง', firstName: 'หลังแก้', lastName: 'นามสกุลใหม่', position: 'หัวหน้าฝ่ายวิชาการ',
      departmentId: dept2, roleId: roleId('head'), status: 'active',
    });
    assert.equal(res.status, 302, res.body.slice(0, 200));
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    assert.equal(row.first_name, 'หลังแก้');
    assert.equal(row.department_id, dept2);
    assert.equal(row.position, 'หัวหน้าฝ่ายวิชาการ');
    assert.equal(roleOf(id), 'head', 'บทบาทต้องเปลี่ยนตามที่เลือก และต้องเหลือบทบาทเดียว');
    assert.equal(db.prepare('SELECT COUNT(*) c FROM user_roles WHERE user_id = ?').get(id).c, 1);
  });

  test('ระงับบัญชีแล้วต้องหลุดออกจากระบบทันที ไม่ใช่ใช้ต่อจนเซสชันหมดอายุเอง', async () => {
    const id = makeUser('edituser02');
    assert.equal(login('edituser02', 'Welcome@2569', '127.0.0.1').ok, true);
    assert.ok(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(id).c > 0);

    await dispatchPost(admin(), `/admin/users/${id}/edit`, { firstName: 'ก', lastName: 'ข', roleId: roleId('teacher'), status: 'suspended' });
    assert.equal(db.prepare('SELECT COUNT(*) c FROM sessions WHERE user_id = ?').get(id).c, 0, 'เซสชันที่ค้างอยู่ต้องถูกเตะออก');
    assert.equal(login('edituser02', 'Welcome@2569', '127.0.0.1').ok, false, 'บัญชีที่ระงับต้องล็อกอินไม่ได้');
  });

  test('ปฏิเสธค่าที่ไม่ถูกต้อง และไม่บันทึกอะไรเลย', async () => {
    const id = makeUser('edituser03');
    for (const [label, body] of [
      ['ไม่กรอกชื่อ', { firstName: '', lastName: 'ข', roleId: roleId('teacher') }],
      ['ฝ่ายที่ไม่มีอยู่จริง', { firstName: 'ก', lastName: 'ข', departmentId: 'ไม่มีจริง', roleId: roleId('teacher') }],
      ['บทบาทที่ไม่มีอยู่จริง', { firstName: 'ก', lastName: 'ข', roleId: 'ไม่มีจริง' }],
      ['ชื่อยาวเกินกำหนด', { firstName: 'ก'.repeat(50000), lastName: 'ข', roleId: roleId('teacher') }],
    ]) {
      const res = await dispatchPost(admin(), `/admin/users/${id}/edit`, body);
      assert.equal(res.status, 400, `ควรปฏิเสธ: ${label}`);
    }
    assert.equal(db.prepare('SELECT first_name FROM users WHERE id = ?').get(id).first_name, 'ก่อนแก้',
      'ข้อมูลต้องไม่ถูกแก้เมื่อค่าที่ส่งมาไม่ผ่าน');
  });

  // ถ้าปล่อยให้ผู้ดูแลคนสุดท้ายถอดบทบาทตัวเองหรือระงับตัวเองได้ จะไม่เหลือใครเข้าหน้าจัดการผู้ใช้ได้อีกเลย
  // ต้องไปกู้คืนผ่าน environment variable บนเซิร์ฟเวอร์อย่างเดียว
  test('ผู้ดูแลระบบคนสุดท้ายถอดบทบาทตัวเองหรือระงับตัวเองไม่ได้', async () => {
    const a = admin();
    for (const [label, body] of [
      ['เปลี่ยนบทบาทตัวเองเป็นครู', { firstName: a.first_name || 'ก', lastName: a.last_name || 'ข', roleId: roleId('teacher'), status: 'active' }],
      ['ระงับบัญชีตัวเอง', { firstName: a.first_name || 'ก', lastName: a.last_name || 'ข', roleId: roleId('admin'), status: 'suspended' }],
    ]) {
      const res = await dispatchPost(a, `/admin/users/${a.id}/edit`, body);
      assert.equal(res.status, 400, `ควรปฏิเสธ: ${label}`);
      assert.match(res.body, /อย่างน้อย 1 คน/);
    }
    assert.equal(roleOf(a.id), 'admin', 'ต้องยังเป็นผู้ดูแลระบบอยู่');
    assert.equal(db.prepare('SELECT status FROM users WHERE id = ?').get(a.id).status, 'active');
  });

  test('คนที่ไม่ใช่ผู้ดูแลระบบแก้ไขผู้ใช้ไม่ได้', async () => {
    const id = makeUser('edituser04');
    const teacher = loadUserForTest(seed.userIds.teacher001);
    assert.equal((await dispatchGet(teacher, `/admin/users/${id}/edit`, {})).status, 403);
    const res = await dispatchPost(teacher, `/admin/users/${id}/edit`, { firstName: 'แฮก', lastName: 'ระบบ', roleId: roleId('admin') });
    assert.equal(res.status, 403);
    assert.equal(db.prepare('SELECT first_name FROM users WHERE id = ?').get(id).first_name, 'ก่อนแก้');
    assert.equal(roleOf(id), 'teacher', 'ต้องเลื่อนตัวเองเป็นผู้ดูแลระบบไม่ได้');
  });
});

// พบตอนไล่เส้นทางการใช้งานจริงครบวงจร (ธุรการลงรับ → เสนอ ผอ. → ผอ. สั่งการ → หัวหน้าฝ่ายรับทราบ →
// ปิดเรื่อง → พิมพ์ออกมาเก็บเข้าแฟ้ม) ทุกขั้นตอนผ่านหมด แต่กระดาษที่พิมพ์ออกมาตอนท้าย — ซึ่งคือของจริง
// ที่โรงเรียนเก็บไว้เป็นหลักฐาน — กลับผิด 2 เรื่อง
describe('หน้าพิมพ์ "บันทึกข้อความ": ผู้ลงนามต้องครบและตรงกับวันที่ลงนามจริง', () => {
  const printPage = async (docId, user) => (await dispatchGet(user, `/documents/${docId}/print`, {})).body;

  // โรงเรียนส่วนใหญ่ไม่ได้สแกนลายเซ็นเก็บไว้ในระบบ — ผอ. ยืนยันด้วย PIN ในระบบ แล้วเซ็นด้วยปากกาบน
  // กระดาษที่พิมพ์ออกมา ซึ่งใช้ไม่ได้เลยถ้ากระดาษไม่มีทั้งชื่อผู้อนุมัติและเส้นให้เซ็น
  test('ลงนามด้วย PIN โดยไม่มีรูปลายเซ็น หน้าพิมพ์ต้องยังขึ้นชื่อ+ตำแหน่ง+ที่ว่างให้เซ็น', async () => {
    const doc = makeDoc({ title: 'ขออนุมัติเดินทางไปราชการ' });
    const stepId = assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, actorUser: registrarUser });
    db.prepare('UPDATE users SET signature_image = NULL WHERE id = ?').run(seed.userIds.director01);
    acknowledgeAndComplete({ stepId, actorUser: loadUserForTest(seed.userIds.director01) });

    const body = await printPage(doc.id, registrarUser);
    assert.doesNotMatch(body, /ยังไม่มีผู้ลงนามในขั้นตอนใดเลย/,
      'ลงนามด้วย PIN ครบแล้ว หน้าพิมพ์ต้องไม่บอกว่ายังไม่มีใครลงนาม');
    const signer = db.prepare('SELECT signer_name, signer_position FROM workflow_steps WHERE id = ?').get(stepId);
    assert.ok(body.includes(signer.signer_name), 'ต้องขึ้นชื่อผู้ลงนามบนกระดาษ');
    assert.ok(body.includes(signer.signer_position), 'ต้องขึ้นตำแหน่งผู้ลงนามบนกระดาษ');
    assert.match(body, /sig-space/, 'ผู้ที่ไม่มีรูปลายเซ็น ต้องเว้นที่ว่างไว้ให้เซ็นด้วยปากกา');
  });

  // ครูเลื่อนวิทยฐานะ (ครูผู้ช่วย → ครู คศ.1) และเปลี่ยนนามสกุลกันเป็นปกติทุกปี ถ้าหน้าพิมพ์ดึงชื่อ/ตำแหน่ง
  // ปัจจุบันมาแสดง หนังสือเก่าที่ลงนามและเก็บเข้าแฟ้มไปแล้วทุกฉบับจะเปลี่ยนตามย้อนหลัง ใช้อ้างอิงไม่ได้
  test('เจ้าตัวเปลี่ยนชื่อ/ตำแหน่งภายหลัง หน้าพิมพ์ต้องคงชื่อ ณ วันที่ลงนามไว้เหมือนเดิม', async () => {
    const doc = makeDoc({ title: 'ขอความอนุเคราะห์วิทยากร' });
    const stepId = assignStep({ documentId: doc.id, assigneeId: seed.userIds.head_acad, actorUser: registrarUser });
    acknowledgeAndComplete({ stepId, actorUser: loadUserForTest(seed.userIds.head_acad) });
    const atSigning = db.prepare('SELECT signer_name, signer_position FROM workflow_steps WHERE id = ?').get(stepId);

    db.prepare("UPDATE users SET last_name = 'นามสกุลใหม่หลังลงนาม', position = 'ย้ายไปโรงเรียนอื่นแล้ว' WHERE id = ?")
      .run(seed.userIds.head_acad);

    const body = await printPage(doc.id, registrarUser);
    assert.ok(body.includes(atSigning.signer_name), 'ต้องคงชื่อ ณ วันที่ลงนามไว้');
    assert.ok(body.includes(atSigning.signer_position), 'ต้องคงตำแหน่ง ณ วันที่ลงนามไว้');
    assert.ok(!body.includes('นามสกุลใหม่หลังลงนาม') && !body.includes('ย้ายไปโรงเรียนอื่นแล้ว'),
      'ต้องไม่เอาชื่อ/ตำแหน่งปัจจุบันมาแทนที่หลักฐานบนหนังสือที่ลงนามไปแล้ว');

    // ไทม์ไลน์บนหน้าเอกสารเป็นหลักฐานชุดเดียวกัน จึงต้องยึดสำเนา ณ ขณะลงนามเหมือนกัน
    const detail = (await dispatchGet(registrarUser, `/documents/${doc.id}`, {})).body;
    assert.ok(detail.includes(atSigning.signer_name), 'ไทม์ไลน์ต้องแสดงชื่อ ณ วันที่ลงนามด้วย');
  });
});

// ประวัติการดำเนินการเป็นหลักฐานว่าใครสั่งการหนังสือฉบับไหนเมื่อไหร่ — แต่แถวของงาน workflow เก็บ
// record_id เป็น id ของ "ขั้นตอน" ไม่ใช่ของหนังสือ พอหน้า audit เทแถวล่าสุดออกมาเฉยๆ จึงตอบคำถามที่
// ต้องใช้จริง ("ฉบับนี้ใครสั่งการ") ไม่ได้เลย และของเก่าหลุดพ้นเพดานไปเรื่อยๆ โดยไม่มีหน้าถัดไป
describe('ประวัติการดำเนินการ (audit): ต้องสืบย้อนรายฉบับได้ ไม่ใช่เทแถวล่าสุดออกมาเฉยๆ', () => {
  const adminUser = () => loadUserForTest(seed.userIds.admin);

  async function journeyDoc() {
    const doc = makeDoc({ title: 'หนังสือสำหรับตรวจประวัติการดำเนินการ' });
    const step1 = assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, actorUser: registrarUser });
    approveAndForward({
      stepId: step1, nextAssigneeId: seed.userIds.head_acad, comment: 'มอบฝ่ายวิชาการ',
      actorUser: loadUserForTest(seed.userIds.director01),
    });
    const step2 = db.prepare('SELECT id FROM workflow_steps WHERE document_id = ? ORDER BY step_order DESC LIMIT 1').get(doc.id).id;
    acknowledgeAndComplete({ stepId: step2, actorUser: loadUserForTest(seed.userIds.head_acad) });
    return doc;
  }

  // นับแถวจริงในตาราง ไม่ใช่แค่หาข้อความ — หน้าที่เทแถวล่าสุดของทั้งระบบออกมาโดยไม่สนใจตัวกรอง
  // ก็ "มีข้อความนั้นอยู่" เหมือนกัน ทั้งที่ตอบคำถามว่าฉบับนี้ใครสั่งการไม่ได้เลย
  const rowCount = (body) => (body.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1].match(/<tr>/g) || []).length;

  test('กรองตาม id หนังสือ แล้วต้องได้ครบทุกขั้นตั้งแต่ลงรับจนปิดเรื่อง และเฉพาะของฉบับนั้น', async () => {
    const doc = await journeyDoc();
    const res = await dispatchGet(adminUser(), '/admin/audit', { document: doc.id });
    assert.equal(res.status, 200);
    const expected = ['document_received', 'workflow_assigned', 'workflow_approved_forward', 'workflow_acknowledged_completed'];
    for (const action of expected) {
      assert.ok(res.body.includes(action), `ประวัติของหนังสือฉบับนี้ต้องมี ${action}`);
    }
    assert.equal(rowCount(res.body), expected.length,
      'ต้องได้เฉพาะแถวของหนังสือฉบับนี้เท่านั้น ไม่ใช่เทแถวล่าสุดของทั้งระบบออกมา');
  });

  test('กรองด้วยเลขที่หนังสือที่อ่านจากกระดาษได้ด้วย ไม่ใช่ต้องรู้ id ในระบบ', async () => {
    const doc = await journeyDoc();
    const number = db.prepare('SELECT doc_number_display d FROM documents WHERE id = ?').get(doc.id).d;
    const res = await dispatchGet(adminUser(), '/admin/audit', { document: number });
    assert.equal(res.status, 200);
    assert.ok(res.body.includes('workflow_acknowledged_completed'), `ค้นด้วยเลขที่ ${number} ต้องเจอประวัติของฉบับนั้น`);
    assert.equal(rowCount(res.body), 4, `ค้นด้วยเลขที่ ${number} ต้องได้เฉพาะของฉบับนั้น`);
  });

  test('ตัวกรองต้องคัดของฉบับอื่นออกจริง ไม่ใช่แสดงทั้งหมดเหมือนเดิม', async () => {
    const mine = await journeyDoc();
    const other = makeDoc({ title: 'หนังสือคนละฉบับที่ต้องไม่ปนเข้ามา' });
    assignStep({ documentId: other.id, assigneeId: seed.userIds.director01, actorUser: registrarUser });

    const res = await dispatchGet(adminUser(), '/admin/audit', { document: mine.id });
    assert.ok(!res.body.includes(other.id), 'ประวัติของหนังสือฉบับอื่นต้องไม่ปนเข้ามาในผลลัพธ์');
    assert.ok(!res.body.includes('หนังสือคนละฉบับที่ต้องไม่ปนเข้ามา'), 'ชื่อเรื่องของฉบับอื่นต้องไม่โผล่มาด้วย');
    assert.equal(rowCount(res.body), 4);
  });

  test('ทุกแถวต้องบอกได้ว่าเป็นของหนังสือฉบับไหน พร้อมลิงก์เปิดฉบับนั้น', async () => {
    const doc = await journeyDoc();
    const number = db.prepare('SELECT doc_number_display d FROM documents WHERE id = ?').get(doc.id).d;
    const res = await dispatchGet(adminUser(), '/admin/audit', { document: doc.id });
    assert.ok(res.body.includes(`/documents/${doc.id}`), 'ต้องลิงก์กลับไปที่หนังสือฉบับนั้นได้');
    assert.ok(res.body.includes(number), 'ต้องแสดงเลขที่หนังสือให้เทียบกับกระดาษได้');
    assert.equal((res.body.match(new RegExp(`/documents/${doc.id}`, 'g')) || []).length, 4,
      'ทุกแถวของฉบับนี้ต้องมีลิงก์ไปหนังสือ ไม่ใช่แค่บางแถว');
  });

  test('แสดงชื่อการกระทำเป็นภาษาไทยควบคู่รหัสเดิม', async () => {
    const doc = await journeyDoc();
    const res = await dispatchGet(adminUser(), '/admin/audit', { document: doc.id });
    for (const th of ['ลงรับหนังสือ', 'เสนอ/มอบหมายงาน', 'อนุมัติและส่งต่อ', 'รับทราบและปิดเรื่อง']) {
      assert.ok(res.body.includes(th), `ต้องอ่านออกว่า "${th}" ไม่ใช่มีแต่รหัสอังกฤษ`);
    }
  });

  test('มีหน้าถัดไป — ของเก่าต้องไม่หลุดหายไปเมื่อบันทึกสะสมมากขึ้น', async () => {
    const before = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c;
    for (let i = 0; i < 120; i++) makeDoc({ title: `หนังสือถมประวัติ ${i}` });
    assert.ok(db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c > before + 100);

    const page1 = await dispatchGet(adminUser(), '/admin/audit', {});
    assert.match(page1.body, /หน้า 1 จาก \d+/, 'ต้องบอกว่าอยู่หน้าไหนจากทั้งหมดกี่หน้า');
    assert.ok(page1.body.includes('/admin/audit?page=2'), 'ต้องมีลิงก์ไปหน้าถัดไป');
    const page2 = await dispatchGet(adminUser(), '/admin/audit', { page: '2' });
    assert.equal(page2.status, 200);
    assert.match(page2.body, /หน้า 2 จาก \d+/);
  });

  test('หน้าเกินจำนวนจริง/ค่าที่ไม่ใช่ตัวเลข ต้องไม่พังและไม่ขึ้นหน้าว่าง', async () => {
    for (const page of ['999999', 'abc', '-3', '0']) {
      const res = await dispatchGet(adminUser(), '/admin/audit', { page });
      assert.equal(res.status, 200, `page=${page} ต้องไม่พัง`);
      assert.ok(!res.body.includes('ยังไม่มีบันทึก'), `page=${page} ต้องเด้งกลับไปหน้าที่มีข้อมูลจริง`);
    }
  });

  test('เฉพาะแอดมินเท่านั้นที่เปิดประวัติการดำเนินการได้', async () => {
    for (const code of ['teacher001', 'reg001', 'director01']) {
      const res = await dispatchGet(loadUserForTest(seed.userIds[code]), '/admin/audit', {});
      assert.equal(res.status, 403, `${code} ต้องเปิดหน้า audit ไม่ได้`);
    }
  });
});

// เพดานความยาวของทุกช่องข้อความที่ผู้ใช้กรอกเองได้
//
// ไล่ยิงทุกช่องด้วยข้อความ 50,000 ตัวอักษร พบว่าหลายช่องรับเข้าไปเก็บทั้งอย่างนั้น ที่หนักที่สุดคือ
// ความเห็นที่จะถูก "ประทับลงบนไฟล์ PDF จริง" — วัดด้วย chromium แล้วพบว่ากล่องความเห็นล้นออกหน้า 2
// ตั้งแต่ประมาณ 700 ตัวอักษร (แม้ระบบจะเลื่อนกล่องขึ้นให้ครบ 8 ครั้งตาม fit-retry loop แล้วก็ตาม)
// ซึ่ง qpdf --overlay --to=1 ทับให้แค่หน้าแรก = ตราประทับหายทั้งกล่อง
describe('เพดานความยาวของช่องข้อความ', () => {
  const reg = () => loadUserForTest(seed.userIds.reg001);
  const LONG = 'ก'.repeat(50000);

  test('ข้อความในขั้นตอน workflow ทุกจุดมีเพดาน', () => {
    const doc = makeDoc({ title: 'ทดสอบเพดานข้อความ' });
    assert.throws(() => assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, instruction: LONG, actorUser: reg() }), /ยาวเกินไป/);
    assert.throws(() => voidDocument({ documentId: doc.id, reason: LONG, actorUser: reg() }), /ยาวเกินไป/);

    assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, instruction: 'เสนอ', actorUser: reg() });
    const step = currentStep(doc.id);
    const director = loadUserForTest(seed.userIds.director01);
    assert.throws(() => approveAndForward({ stepId: step.id, nextAssigneeId: seed.userIds.head_acad, comment: LONG, actorUser: director }), /ยาวเกินไป/);
    assert.throws(() => acknowledgeAndComplete({ stepId: step.id, comment: LONG, actorUser: director }), /ยาวเกินไป/);
    assert.throws(() => rejectStep({ stepId: step.id, reason: LONG, actorUser: director }), /ยาวเกินไป/);
    assert.throws(() => returnStep({ stepId: step.id, reason: LONG, actorUser: director }), /ยาวเกินไป/);
    // ข้อความความยาวปกติต้องยังผ่าน ไม่ใช่ปิดตายไปเลย
    acknowledgeAndComplete({ stepId: step.id, comment: 'รับทราบแล้ว ดำเนินการต่อได้', actorUser: director });
    assert.equal(getDocRow(doc.id).status, 'completed');
  });

  // ตรวจ "ก่อน" ที่การตัดสินใจจะถูกบันทึก ไม่ใช่ตอนประทับตรา — ถ้าตรวจทีหลัง ผลจะเป็น: เรื่องถูกอนุมัติ
  // และส่งต่อไปคนถัดไปเรียบร้อยแล้ว แต่ความเห็นของ ผอ. ไม่ได้ขึ้นบนหนังสือ และย้อนกลับไปแก้ไม่ได้อีก
  test('ความเห็นที่จะประทับลงหนังสือ ถูกปฏิเสธก่อนขั้นตอนจะถูกบันทึก', async () => {
    const doc = makeDoc({ title: 'ทดสอบความเห็นยาวเกินกล่องตราประทับ' });
    assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, instruction: 'เสนอ', actorUser: reg() });
    const step = currentStep(doc.id);
    const director = loadUserForTest(seed.userIds.director01);

    const res = await dispatchPost(director, `/documents/${doc.id}/workflow/${step.id}/acknowledge`, {
      pin: userPin('director01'), comment: 'ok', decisionNote: 'ก'.repeat(MAX_STAMP_TEXT + 1),
    });
    assert.equal(res.status, 400, `ควรถูกปฏิเสธ แต่ได้ ${res.status} ${res.body.slice(0, 120)}`);
    assert.match(res.json.error || '', /ประทับลงหนังสือ/);
    // และที่สำคัญที่สุด: ขั้นตอนต้องยังไม่ถูกบันทึก เรื่องต้องยังค้างอยู่ที่เดิม
    assert.equal(db.prepare('SELECT status FROM workflow_steps WHERE id = ?').get(step.id).status, 'waiting',
      'ขั้นตอนถูกบันทึกไปแล้วทั้งที่ความเห็นยาวเกิน — ความเห็นจะหายจากหนังสือโดยแก้ย้อนหลังไม่ได้');
    assert.notEqual(getDocRow(doc.id).status, 'completed');
  });

  test('เพดานตราประทับตั้งจากค่าที่วัดจริง ไม่ใช่ตัวเลขที่เดาเอา', () => {
    // 500 ตัวอักษรยังพอดีหน้าเดียวตอนวัด, 700 ล้น — ตั้งไว้ต่ำกว่านั้นเผื่อฟอนต์ไทยจริงที่กว้างกว่า
    assert.ok(MAX_STAMP_TEXT > 0 && MAX_STAMP_TEXT <= 500,
      `เพดานตราประทับควรอยู่ในช่วงที่วัดแล้วว่าพอดีหน้าเดียว แต่ตั้งไว้ ${MAX_STAMP_TEXT}`);
  });

  test('บัญชีทำลายหนังสือมีเพดาน และไม่ 500 เมื่อส่งค่าผิดชนิด', () => {
    const actor = reg();
    assert.throws(() => createDestructionBatch({ documentIds: 'ไม่ใช่อาเรย์', committeeNames: 'ก ข ค', actorUser: actor }),
      (err) => {
        assert.ok(!/is not a function/.test(err.message), `ข้อความ JavaScript ดิบหลุดถึงผู้ใช้: ${err.message}`);
        return true;
      });
    assert.throws(() => createDestructionBatch({ documentIds: ['x'], committeeNames: LONG, actorUser: actor }), /ยาวเกินไป/);
    assert.throws(() => createDestructionBatch({ documentIds: ['x', 'x'], committeeNames: 'ก ข ค', actorUser: actor }), /ซ้ำกัน/);
  });
});

// วันที่ของใบลาและการมอบหมายรักษาการแทน
//
// เดิมสองโมดูลนี้ตรวจวันที่กันเอง คนละแบบกับฝั่งหนังสือ และตรวจแค่ "วันสิ้นสุดต้องไม่ก่อนวันเริ่ม"
// ด้วยการเทียบสตริง ผลที่ทดสอบยืนยันแล้วว่าเกิดขึ้นจริงก่อนแก้:
//   - การมอบหมายที่ end_date = "ไม่ใช่วันที่" ถูกบันทึก แล้ว "มีผลตลอดไป" (อีก 100 ปีก็ยังมีผล)
//     เพราะ SQL เทียบสตริง และอักษรไทยมากกว่าตัวเลขทุกตัว = มอบอำนาจลงนามแทน ผอ. แบบถาวร
//   - ใบลาที่พิมพ์ปีผิดหนึ่งหลัก (2126) ถูกบันทึกเป็น 36,526 วัน
//   - วันที่แบบ พ.ศ. และวันที่ที่ไม่มีอยู่จริง (2026-02-30) ผ่านทั้งคู่
describe('วันที่ของใบลาและการมอบหมายรักษาการแทน', () => {
  const approver = () => seed.userIds.director01;
  const mkLeave = (over = {}) => createLeaveRequest({
    requesterId: teacherUser.id, leaveType: 'sick', ...nextLeaveWindow(2),
    reason: 'ทดสอบ', approverId: approver(), ...over,
  });
  // ช่วงวันที่ไม่ซ้ำกับใบอื่น แต่คุมความยาวได้ตามที่เทสต์ต้องการ
  const spanDays = (days) => nextLeaveWindow(days);
  const mkDelegation = (over = {}) => createDelegation({
    delegatorId: seed.userIds.director01, delegateId: seed.userIds.vicedir01,
    startDate: '2026-10-01', endDate: '2026-10-05', reason: 'ทดสอบ', createdBy: seed.userIds.director01, ...over,
  });

  test('ค่าที่ไม่ใช่วันที่ต้องถูกปฏิเสธ ไม่ใช่บันทึกแล้วมีผลตลอดไป', () => {
    for (const [label, over] of [
      ['วันสิ้นสุดเป็นข้อความไทย', { endDate: 'ไม่ใช่วันที่' }],
      ['วันสิ้นสุดเป็นตัวอักษรอังกฤษ', { endDate: 'zzzz' }],
      ['วันเริ่มเป็นข้อความ', { startDate: 'ไม่ใช่วันที่' }],
      ['วันที่แบบ พ.ศ.', { startDate: '2569-10-01', endDate: '2569-10-05' }],
      ['วันที่ที่ไม่มีอยู่จริง', { startDate: '2026-02-30', endDate: '2026-02-30' }],
      ['เว้นว่าง', { endDate: '' }],
    ]) {
      assert.throws(() => mkDelegation(over), undefined, `การมอบหมายควรปฏิเสธ: ${label}`);
      assert.throws(() => mkLeave(over), undefined, `ใบลาควรปฏิเสธ: ${label}`);
    }
  });

  // เทสต์ข้อนี้คือหัวใจของเรื่อง — ถ้าค่าที่ไม่ใช่วันที่หลุดเข้าฐานข้อมูลได้ ผู้รักษาการแทนจะถืออำนาจ
  // ลงนามแทนผู้อำนวยการไปตลอดกาล โดยหน้าจอไม่มีอะไรบอกว่าทำไม
  test('ไม่มีการมอบหมายที่ยังมีผลอยู่ในอีก 100 ปีข้างหน้า', () => {
    mkDelegation({ startDate: '2026-10-01', endDate: '2026-10-05' });
    const farFuture = '2126-08-23';
    const stillActive = db.prepare(`
      SELECT start_date, end_date FROM user_delegations
      WHERE cancelled_at IS NULL AND start_date <= ? AND end_date >= ?
    `).all(farFuture, farFuture);
    assert.deepEqual(stillActive, [], `มีการมอบหมายที่ไม่มีวันหมดอายุ: ${JSON.stringify(stillActive)}`);
  });

  test('ช่วงเวลาที่ยาวผิดปกติต้องถูกปฏิเสธ (พิมพ์ปีผิดหนึ่งหลัก)', () => {
    assert.throws(() => mkLeave({ startDate: '2026-10-01', endDate: '2126-10-02' }), /ยาวผิดปกติ/);
    assert.throws(() => mkDelegation({ startDate: '2026-10-01', endDate: '2126-10-02' }), /ยาวผิดปกติ/);
    // ช่วงที่สมเหตุสมผลต้องยังผ่าน ไม่ใช่ปิดตายไปเลย
    assert.ok(mkLeave(spanDays(88)).id, 'ลา ~3 เดือนต้องยังทำได้');
  });

  test('ข้อความยาวเกินกำหนดต้องถูกปฏิเสธ', () => {
    assert.throws(() => mkLeave({ reason: 'ก'.repeat(50000) }), /ยาวเกินไป/);
    assert.throws(() => mkDelegation({ reason: 'ก'.repeat(50000) }), /ยาวเกินไป/);
  });

  test('ผู้รักษาการแทนที่ไม่มีอยู่จริง ต้องได้ข้อความที่อ่านรู้เรื่อง ไม่ใช่ error ของ SQLite', () => {
    assert.throws(() => mkDelegation({ delegateId: 'ไม่มีคนนี้' }), (err) => {
      assert.ok(!/FOREIGN KEY/i.test(err.message), `ข้อความดิบของ SQLite หลุดถึงผู้ใช้: ${err.message}`);
      assert.match(err.message, /ไม่พบผู้รักษาการแทน/);
      return true;
    });
  });

  test('จำนวนวันลาคำนวณถูกต้อง นับรวมวันแรกและวันสุดท้าย', () => {
    assert.equal(mkLeave(spanDays(1)).daysCount, 1);
    assert.equal(mkLeave(spanDays(3)).daysCount, 3);
    // ข้ามเดือนและปีอธิกสุรทิน
    assert.equal(mkLeave({ startDate: '2028-02-27', endDate: '2028-03-01' }).daysCount, 4);
  });

  // ทั้งสามโมดูลต้องเรียกตัวตรวจตัวเดียวกัน ไม่ใช่ก๊อปโค้ดไปคนละชุดแล้วค่อยๆ เลื่อนจากกันอีกรอบ
  test('หนังสือ/ใบลา/การมอบหมาย ใช้ตัวตรวจวันที่ชุดเดียวกัน', () => {
    const srcDir = new URL('../src/services/', import.meta.url).pathname;
    for (const file of ['workflow.js', 'leave.js', 'delegation.js']) {
      const src = fs.readFileSync(path.join(srcDir, file), 'utf8');
      assert.match(src, /from '\.\/validate\.js'/, `${file} ไม่ได้ใช้ตัวตรวจกลาง`);
      assert.ok(!/^function normalizeDate\(/m.test(src), `${file} ยังมี normalizeDate เป็นของตัวเองอยู่`);
    }
  });
});

// ด่านบังคับตั้งรหัสผ่านเองตอนเข้าใช้ครั้งแรก
//
// เดิมหน้าเข้าสู่ระบบพิมพ์รหัสผ่านของทุกบัญชีไว้ให้เห็น (admin / Admin@2569 ...) ใครเปิดเว็บเจอก็
// ล็อกอินเป็นผู้อำนวยการแล้วลงนาม "ทราบ" แทนได้ทันที ตอนนี้รหัสตั้งต้นถูกสุ่มและบังคับเปลี่ยนก่อนใช้งาน
describe('ด่านบังคับตั้งรหัสผ่านเองตอนเข้าใช้ครั้งแรก', () => {
  // ผู้ใช้เฉพาะกิจของ describe นี้ จะได้ไม่ไปรบกวนเทสต์อื่นที่จำลองระบบที่ใช้งานอยู่จริง
  function freshUser(code, { password = 'TempPass1234', pin = '482913' } = {}) {
    const id = `first-login-${code}`;
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    db.prepare(`
      INSERT INTO users (id, employee_code, first_name, last_name, department_id, password_hash, pin_hash,
        status, must_change_password, created_at, updated_at)
      VALUES (?, ?, 'ทดสอบ', 'ครั้งแรก', ?, ?, ?, 'active', 1, ?, ?)
    `).run(id, code, deptId, hashSecret(password), hashSecret(pin), nowIso(), nowIso());
    db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(id, seed.roleIds.teacher);
    return { id, code, password, pin, roleCodes: ['teacher'], department_id: deptId, must_change_password: 1 };
  }
  const post = dispatchPost;

  test('ทุกหน้าถูกเด้งไปหน้าตั้งรหัสผ่าน จนกว่าจะตั้งเสร็จ', async () => {
    const user = freshUser('firstlogin01');
    for (const path of ['/', '/documents', '/leave', '/profile', '/notifications']) {
      const res = await dispatchGet(user, path, {});
      assert.equal(res.status, 302, `${path} ต้องเด้งไปหน้าตั้งรหัสผ่าน`);
      assert.equal(res.headers.Location, '/first-login', `${path} เด้งผิดที่: ${res.headers.Location}`);
    }
    // หน้าตั้งรหัสผ่านเองต้องเปิดได้ ไม่งั้นจะติดอยู่ในวงวนเด้งไม่รู้จบ
    assert.equal((await dispatchGet(user, '/first-login', {})).status, 200);
  });

  test('API ต้องถูกปฏิเสธด้วย ไม่ใช่กันแค่หน้าเว็บ', async () => {
    const user = freshUser('firstlogin02');
    const res = await post(user, '/documents', { title: 'ก', correspondentName: 'ข', departmentId: deptId });
    assert.equal(res.status, 403, 'ต้องกันที่ฝั่งเซิร์ฟเวอร์ ไม่ใช่พึ่งการเด้งหน้าเว็บอย่างเดียว');
    assert.match(res.body, /ตั้งรหัสผ่าน/);
  });

  test('ตั้งรหัสผ่านและ PIN ใหม่แล้วใช้งานได้ตามปกติ', async () => {
    const user = freshUser('firstlogin03');
    const res = await post(user, '/first-login', { newPassword: 'RhatMaiPloxy99', confirmPassword: 'RhatMaiPloxy99', newPin: '739184' });
    assert.equal(res.status, 302);
    const row = db.prepare('SELECT must_change_password FROM users WHERE id = ?').get(user.id);
    assert.equal(row.must_change_password, 0, 'ธงต้องถูกลบหลังตั้งรหัสเสร็จ');
    assert.equal(login('firstlogin03', 'RhatMaiPloxy99', '127.0.0.1').ok, true, 'ต้องล็อกอินด้วยรหัสใหม่ได้');
    assert.equal(login('firstlogin03', user.password, '127.0.0.1').ok, false, 'รหัสชั่วคราวต้องใช้ไม่ได้อีก');
    assert.equal(verifyPin(user.id, '739184'), true, 'ต้องใช้ PIN ใหม่ได้');
    assert.equal((await dispatchGet({ ...user, must_change_password: 0 }, '/documents', { direction: 'incoming' })).status, 200);
  });

  test('ปฏิเสธรหัสผ่าน/PIN ที่ยังไม่ปลอดภัยพอ', async () => {
    const user = freshUser('firstlogin04');
    const cases = [
      ['สั้นเกินไป', { newPassword: 'Sun123', confirmPassword: 'Sun123', newPin: '739184' }, /อย่างน้อย 8/],
      ['พิมพ์ยืนยันไม่ตรง', { newPassword: 'RhatMaiPloxy99', confirmPassword: 'RhatMaiPloxy98', newPin: '739184' }, /ไม่ตรงกัน/],
      ['ซ้ำรหัสชั่วคราว', { newPassword: user.password, confirmPassword: user.password, newPin: '739184' }, /ไม่ซ้ำกับรหัสผ่านชั่วคราว/],
      ['PIN ไม่ใช่ 6 หลัก', { newPassword: 'RhatMaiPloxy99', confirmPassword: 'RhatMaiPloxy99', newPin: '12ก4' }, /6 หลัก/],
      ['PIN เลขซ้ำ', { newPassword: 'RhatMaiPloxy99', confirmPassword: 'RhatMaiPloxy99', newPin: '111111' }, /เดาง่าย/],
      ['PIN เลขเรียง', { newPassword: 'RhatMaiPloxy99', confirmPassword: 'RhatMaiPloxy99', newPin: '123456' }, /เดาง่าย/],
      ['PIN ซ้ำของเดิม', { newPassword: 'RhatMaiPloxy99', confirmPassword: 'RhatMaiPloxy99', newPin: user.pin }, /ไม่ซ้ำกับ PIN ชั่วคราว/],
    ];
    for (const [label, body, expected] of cases) {
      const res = await post(user, '/first-login', body);
      assert.equal(res.status, 400, `ควรปฏิเสธ: ${label}`);
      assert.match(res.body, expected, `ข้อความไม่ตรงกรณี: ${label}`);
    }
    assert.equal(db.prepare('SELECT must_change_password m FROM users WHERE id = ?').get(user.id).m, 1,
      'ธงต้องยังอยู่เมื่อยังตั้งรหัสไม่สำเร็จ');
  });

  // ตรวจจาก HTML ที่ผู้ใช้ได้รับจริง ไม่ใช่จากซอร์ส — สิ่งที่ต้องกันคือ "หน้าที่คนยังไม่ล็อกอินเปิดดูได้
  // แล้วมีรหัสผ่านติดมาด้วย" ไม่ว่ารหัสนั้นจะมาจากตรงไหนในโค้ด
  test('หน้าเข้าสู่ระบบต้องไม่มีรหัสผ่านของบัญชีใดๆ ติดมาด้วย', async () => {
    const page = (await dispatchGet(null, '/login', {})).body;
    assert.match(page, /ลงชื่อเข้าใช้งาน/, 'ต้องได้หน้าเข้าสู่ระบบจริง ไม่งั้นเทสต์นี้ไม่ได้ตรวจอะไร');
    const forbidden = [
      'Admin@2569', 'Director@2569', 'Vice@2569', 'Head@2569', 'Reg@2569', 'Teacher@2569',
      ...Object.values(seed.passwords).flatMap((c) => [c.password, c.pin]),
    ];
    for (const leaked of forbidden) {
      assert.ok(!page.includes(leaked), `หน้าเข้าสู่ระบบยังมี "${leaked}" อยู่`);
    }
  });

  test('รหัสผ่านของบัญชีตั้งต้นต้องสุ่มใหม่ ไม่ใช่ค่าตายตัวเดิม', () => {
    for (const [code, creds] of Object.entries(seed.passwords)) {
      assert.ok(creds.password.length >= 12, `รหัสผ่านของ ${code} สั้นเกินไป`);
      assert.ok(!['Admin@2569', 'Director@2569', 'Vice@2569', 'Head@2569', 'Reg@2569', 'Teacher@2569'].includes(creds.password),
        `${code} ยังใช้รหัสผ่านตั้งต้นชุดเดิมที่เคยเปิดเผยไว้`);
      assert.equal(isWeakPin(creds.pin), false, `PIN ของ ${code} เดาง่ายเกินไป`);
    }
    const all = Object.values(seed.passwords).map((c) => c.password);
    assert.equal(new Set(all).size, all.length, 'ทุกบัญชีต้องได้รหัสผ่านคนละอัน');
  });

  test('บัญชีที่นำเข้าจาก Excel ก็ต้องตั้งรหัสเองก่อนใช้งาน', () => {
    const src = fs.readFileSync(new URL('../src/services/userImport.js', import.meta.url), 'utf8');
    assert.match(src, /must_change_password/,
      'บัญชีที่นำเข้าได้รหัสผ่านจากผู้ดูแล จึงต้องถูกบังคับให้ตั้งเองเหมือนบัญชีตั้งต้น');
  });

  // อาการที่ผู้ใช้เจอจริง: "เปลี่ยนรหัสแล้วใช้รหัสใหม่ไม่ได้" — ตัวล็อกบัญชี 15 นาทีไม่ได้ดูรหัสผ่านเลย
  // ตราบใดที่ locked_until ยังไม่หมด รหัสที่ถูกต้องก็เข้าไม่ได้ การให้รหัสใหม่จึงไม่ช่วยอะไรถ้าไม่ปลดล็อกด้วย
  // และผู้ดูแลก็ไม่มีปุ่มปลดล็อกให้กดเลย
  test('ตั้งรหัสใหม่เองแล้ว ต้องใช้ได้ทันทีแม้บัญชีเคยถูกล็อกอยู่', async () => {
    const user = freshUser('firstlogin05');
    db.prepare("UPDATE users SET locked_until = '2099-01-01T00:00:00.000Z', failed_login_count = 5 WHERE id = ?").run(user.id);
    const res = await post(user, '/first-login', { newPassword: 'RhatMaiPloxy99', confirmPassword: 'RhatMaiPloxy99', newPin: '739184' });
    assert.equal(res.status, 302);
    const row = db.prepare('SELECT locked_until, failed_login_count FROM users WHERE id = ?').get(user.id);
    assert.equal(row.locked_until, null, 'ต้องปลดล็อกให้ด้วย ไม่งั้นรหัสที่เพิ่งตั้งจะใช้ไม่ได้อีก 15 นาที');
    assert.equal(row.failed_login_count, 0);
    assert.equal(login('firstlogin05', 'RhatMaiPloxy99', '127.0.0.1').ok, true, 'ต้องล็อกอินด้วยรหัสใหม่ได้ทันที');
  });

  test('ผู้ดูแลรีเซ็ตรหัสให้ ต้องปลดล็อกบัญชีให้ด้วย', async () => {
    const user = freshUser('firstlogin06');
    db.prepare("UPDATE users SET locked_until = '2099-01-01T00:00:00.000Z', failed_login_count = 5 WHERE id = ?").run(user.id);
    const admin = loadUserForTest(seed.userIds.admin);
    const res = await post(admin, `/admin/users/${user.id}/reset-password`, {});
    assert.equal(res.status, 200, res.body.slice(0, 150));
    assert.equal(db.prepare('SELECT locked_until FROM users WHERE id = ?').get(user.id).locked_until, null,
      'รีเซ็ตรหัสแล้วยังล็อกอยู่ — เจ้าตัวจะยังเข้าไม่ได้ และผู้ดูแลไม่มีทางปลดล็อกให้เลย');
    assert.equal(login('firstlogin06', res.json.password, '127.0.0.1').ok, true, 'ต้องเข้าด้วยรหัสชั่วคราวได้ทันที');
  });

  // ระบบนี้ไม่มีการรีเซ็ตรหัสผ่านทางอีเมล ถ้าผู้ดูแลเข้าไม่ได้จะไม่เหลือทางเข้าเลยแม้แต่ทางเดียว
  // นอกจากรื้อฐานข้อมูลทิ้ง ซึ่งแปลว่าทะเบียนหนังสือทั้งเล่มหายไปด้วย
  test('กู้คืนบัญชีผู้ดูแลผ่าน environment variable ได้ แม้บัญชีถูกล็อกอยู่', () => {
    const src = fs.readFileSync(new URL('../src/db.js', import.meta.url), 'utf8');
    assert.match(src, /ADMIN_RESET_PASSWORD/, 'ต้องมีทางกู้คืนผ่าน environment variable');
    // ต้องกู้แล้วบังคับตั้งรหัสใหม่เสมอ ไม่ใช่ปล่อยให้รหัสจาก env กลายเป็นรหัสถาวรที่ค้างอยู่ในหน้าตั้งค่า
    const fn = src.slice(src.indexOf('function applyEmergencyAdminReset'), src.indexOf('migrate();'));
    assert.match(fn, /must_change_password = 1/, 'รหัสจาก env ต้องเป็นรหัสชั่วคราวเสมอ');
    assert.match(fn, /locked_until = NULL/, 'ต้องปลดล็อกให้ด้วย ไม่งั้นกู้คืนแล้วก็ยังเข้าไม่ได้');
    assert.match(fn, /DELETE FROM sessions/, 'ต้องเตะเซสชันที่ค้างอยู่ออก');
    assert.match(fn, /length < 8/, 'ต้องปฏิเสธรหัสกู้คืนที่สั้นเกินไป');
  });

  test('isWeakPin จับ PIN ที่เดาง่ายได้ครบ', () => {
    for (const weak of ['111111', '000000', '999999', '123456', '654321', '12345', 'abcdef', '', null]) {
      assert.equal(isWeakPin(weak), true, `ควรถือว่าอ่อน: ${weak}`);
    }
    for (const ok of ['739184', '482913', '135790', '112233']) {
      assert.equal(isWeakPin(ok), false, `ไม่ควรถือว่าอ่อน: ${ok}`);
    }
  });
});

// ส่งออกทะเบียนหนังสือเป็น Excel / หน้าพิมพ์
//
// ความเสี่ยงที่แท้จริงของฟีเจอร์ส่งออกคือ "ไฟล์ที่ออกไปแล้วเรียกคืนไม่ได้" — ถ้าไฟล์มีหนังสือลับที่คน
// ดาวน์โหลดไม่มีสิทธิ์เห็นติดไปด้วย แล้วไฟล์นั้นถูกส่งต่อทางไลน์/อีเมล จะไม่มีทางแก้ย้อนหลังเลย
// (เคยรั่วจริงมาแล้วที่ /reports/export.csv ซึ่งดัมป์ทุกฉบับในฐานข้อมูลให้ใครก็ตามที่ล็อกอินได้)
describe('ส่งออกทะเบียนหนังสือ', () => {
  const reg = () => loadUserForTest(seed.userIds.reg001);
  const outsider = () => loadUserForTest(seed.userIds.teacher001);
  const sheetOf = (buffer) => readWorkbook(buffer)[0];

  test('ไฟล์ Excel ที่ได้ อ่านกลับได้จริงและมีหัวตารางแบบทะเบียนหนังสือรับ', async () => {
    makeDoc({ title: 'หนังสือสำหรับทดสอบการส่งออก' });
    const res = await dispatchGet(reg(), '/documents/export.xlsx', { direction: 'incoming' });
    assert.equal(res.status, 200);
    assert.match(res.headers['Content-Type'], /spreadsheetml\.sheet/);
    assert.match(res.headers['Content-Disposition'], /attachment/);

    const sheet = sheetOf(res.buffer);
    assert.equal(sheet.name, 'ทะเบียนหนังสือรับ');
    assert.deepEqual(sheet.rows[0].slice(0, 5),
      ['ทะเบียนรับที่', 'ที่ (หนังสือต้นทาง)', 'ลงวันที่', 'จาก', 'เรื่อง']);
    assert.ok(sheet.rows.length > 1, 'ต้องมีข้อมูลอย่างน้อยหนึ่งแถว ไม่งั้นเทสต์นี้ไม่ได้ตรวจอะไร');
    assert.ok(sheet.rows.every((r) => r.length === sheet.rows[0].length), 'ทุกแถวต้องมีจำนวนคอลัมน์เท่ากัน');
  });

  test('จำนวนแถวในไฟล์ต้องตรงกับที่หน้าเว็บกรองไว้เป๊ะ', async () => {
    makeDoc({ title: 'หนังสือด่วนที่สุดสำหรับทดสอบส่งออก', priority: 'most_urgent' });
    for (const query of [
      { direction: 'incoming' },
      { direction: 'incoming', priority: 'most_urgent' },
      { direction: 'incoming', q: 'ทดสอบส่งออก' },
      { direction: 'outgoing' },
    ]) {
      const page = await dispatchGet(reg(), '/documents', query);
      const shown = Number((page.body.match(/(?:ทั้งหมด|ตรงตามเงื่อนไข) ([\d,]+) ฉบับ/) || [, '0'])[1].replace(/,/g, ''));
      const sheet = sheetOf((await dispatchGet(reg(), '/documents/export.xlsx', query)).buffer);
      const inFile = Math.max(0, sheet.rows.length - 1);
      const print = await dispatchGet(reg(), '/documents/register', query);
      const inPrint = (print.body.match(/<td class="num">\d+<\/td>/g) || []).length;
      assert.equal(inFile, shown, `Excel ไม่ตรงกับหน้าเว็บที่เงื่อนไข ${JSON.stringify(query)}`);
      assert.equal(inPrint, shown, `หน้าพิมพ์ไม่ตรงกับหน้าเว็บที่เงื่อนไข ${JSON.stringify(query)}`);
    }
  });

  test('หนังสือลับต้องไม่หลุดไปกับไฟล์ที่คนไม่มีสิทธิ์ดาวน์โหลด', async () => {
    const secret = makeDoc({ title: 'หนังสือลับมากที่ต้องไม่หลุดออกไปกับไฟล์', secretLevel: 'top_secret', createdBy: seed.userIds.reg001 });
    assert.equal(canUserSeeDocument(outsider(), getDocRow(secret.id)), false, 'ตั้งต้นต้องเป็นหนังสือที่ครูคนนี้เห็นไม่ได้');

    for (const [label, path] of [['Excel', '/documents/export.xlsx'], ['หน้าพิมพ์', '/documents/register'], ['CSV รายงาน', '/reports/export.csv']]) {
      const res = await dispatchGet(outsider(), path, { direction: 'incoming' });
      assert.equal(res.status, 200, `${label} ต้องดาวน์โหลดได้ปกติ`);
      const text = path.endsWith('.xlsx') ? JSON.stringify(sheetOf(res.buffer)) : res.body;
      assert.ok(!text.includes('หนังสือลับมากที่ต้องไม่หลุดออกไปกับไฟล์'), `${label} มีหนังสือลับหลุดออกไป`);
    }
    // และผู้ที่มีสิทธิ์ต้องยังได้รับข้อมูลครบ ไม่ใช่ซ่อนหมดทุกคนแล้วเทสต์ผ่านแบบไม่ได้ตรวจอะไร
    const ownerSheet = sheetOf((await dispatchGet(reg(), '/documents/export.xlsx', { direction: 'incoming' })).buffer);
    assert.ok(JSON.stringify(ownerSheet).includes('หนังสือลับมากที่ต้องไม่หลุดออกไปกับไฟล์'),
      'ผู้บันทึกเองต้องยังเห็นหนังสือลับของตัวเองในไฟล์');
  });

  test('หน้าพิมพ์บอกเงื่อนไขที่กรองไว้ เพื่อไม่ให้เข้าใจผิดว่าเป็นทะเบียนทั้งเล่ม', async () => {
    const res = await dispatchGet(reg(), '/documents/register', { direction: 'incoming', priority: 'urgent', from: '2026-08-01' });
    assert.match(res.body, /เงื่อนไข:/);
    assert.match(res.body, /ความเร็ว ด่วน/);
    assert.match(res.body, /ตั้งแต่ 1 สิงหาคม 2569/);
    // ทะเบียนที่ไม่ได้กรองต้องไม่ขึ้นบรรทัดเงื่อนไข ไม่งั้นจะดูเหมือนเป็นทะเบียนบางส่วนทั้งที่ครบ
    const all = await dispatchGet(reg(), '/documents/register', { direction: 'incoming' });
    assert.doesNotMatch(all.body, /เงื่อนไข:/);
  });
});

// ตัวเขียนไฟล์ .xlsx เอง (zero-dependency) — ถ้าโครงไฟล์ผิดแม้นิดเดียว Excel จะขึ้นว่า "ไฟล์เสียหาย"
// แล้วธุรการจะเปิดไม่ได้เลยโดยที่ฝั่งเซิร์ฟเวอร์ไม่มีอะไรฟ้อง
describe('เขียนไฟล์ Excel', () => {
  test('เขียนแล้วอ่านกลับได้ค่าเดิมทุกช่อง', () => {
    const buf = buildXlsx({
      sheetName: 'ทะเบียนทดสอบ',
      header: ['เลขที่', 'เรื่อง', 'จำนวน'],
      rows: [
        ['0001/2569', 'เครื่องหมายที่ต้อง escape: & < > " \'', 5],
        ['0002/2569', '', null],
        ['0003/2569', 'ช่องว่างสองช่อง  กลางข้อความ', 0],
      ],
      widths: [14, 50, 8],
    });
    const sheet = readWorkbook(buf)[0];
    assert.equal(sheet.name, 'ทะเบียนทดสอบ');
    assert.deepEqual(sheet.rows, [
      ['เลขที่', 'เรื่อง', 'จำนวน'],
      ['0001/2569', 'เครื่องหมายที่ต้อง escape: & < > " \'', '5'],
      ['0002/2569', '', ''],
      ['0003/2569', 'ช่องว่างสองช่อง  กลางข้อความ', '0'],
    ]);
  });

  // แกะ XML ของชีตออกมาดูตรงๆ — เทียบผ่าน readWorkbook อย่างเดียวไม่พอ เพราะฝั่งอ่านตัดช่องว่าง
  // หัวท้ายทิ้ง (ตั้งใจ ใช้ตอนนำเข้า) ถ้าฝั่งเขียนลืม xml:space="preserve" ช่องว่างจะหายจริงใน Excel
  // โดยเทสต์ round-trip ไม่มีทางจับได้เลย
  function sheetXmlOf(buf) {
    // อ่านจาก local header ของไฟล์ย่อยตัวสุดท้าย (xl/worksheets/sheet1.xml ถูกเขียนเป็นตัวสุดท้าย)
    const marker = Buffer.from('xl/worksheets/sheet1.xml', 'utf8');
    const at = buf.indexOf(marker);
    assert.ok(at > 0, 'หา worksheet ในไฟล์ไม่เจอ');
    const local = at - 30;
    assert.equal(buf.readUInt32LE(local), 0x04034b50, 'ตำแหน่งที่เจอไม่ใช่ local header ของ ZIP');
    const compSize = buf.readUInt32LE(local + 18);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    return zlib.inflateRawSync(buf.subarray(start, start + compSize)).toString('utf8');
  }

  test('รักษาช่องว่างหัวท้ายไว้ในไฟล์ (xml:space="preserve")', () => {
    const xml = sheetXmlOf(buildXlsx({ header: ['ก'], rows: [['  เว้นหน้าและหลัง  ']] }));
    assert.match(xml, /xml:space="preserve"/);
    assert.ok(xml.includes('>  เว้นหน้าและหลัง  <'), `ช่องว่างหัวท้ายหายไปจากไฟล์: ${xml.slice(0, 400)}`);
  });

  test('escape อักขระ XML ไม่ให้ไฟล์เสีย', () => {
    const xml = sheetXmlOf(buildXlsx({ header: ['ก'], rows: [['<tag> & "ก" \'ข\'']] }));
    assert.ok(!/<t[^>]*>[^<]*<tag>/.test(xml), 'แท็กดิบหลุดเข้าไปใน XML');
    assert.match(xml, /&lt;tag&gt; &amp; &quot;ก&quot;/);
  });

  // อักขระควบคุมทำให้ Excel ปฏิเสธ "ทั้งไฟล์" ไม่ใช่แค่ช่องนั้น — และมันปนมาได้ง่ายมากเวลาผู้ใช้
  // ก๊อปข้อความมาจากไฟล์ PDF/Word
  test('ตัดอักขระควบคุมทิ้ง ไม่ปล่อยให้ทั้งไฟล์เสีย', () => {
    const sheet = readWorkbook(buildXlsx({ header: ['ก'], rows: [['ก่อนหลัง']] }))[0];
    assert.equal(sheet.rows[1][0], 'ก่อนหลัง');
  });

  test('ชื่อชีตที่ยาวเกินหรือมีอักขระต้องห้าม ต้องถูกปรับให้ Excel รับได้', () => {
    assert.equal(readWorkbook(buildXlsx({ sheetName: 'a'.repeat(50), rows: [['x']] }))[0].name.length, 31);
    assert.doesNotMatch(readWorkbook(buildXlsx({ sheetName: 'ทะเบียน/รับ[2569]', rows: [['x']] }))[0].name, /[/[\]]/);
  });

  test('เป็นไฟล์ ZIP ที่มีชิ้นส่วนครบตามที่ Excel ต้องการ', () => {
    const buf = buildXlsx({ header: ['ก'], rows: [['ข']] });
    assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'ต้องขึ้นต้นด้วยลายเซ็นของไฟล์ ZIP');
    const text = buf.toString('latin1');
    for (const part of ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml']) {
      assert.ok(text.includes(part), `ขาดชิ้นส่วน ${part}`);
    }
  });
});

// Google บังคับให้กรอก Privacy policy URL ที่เปิดดูได้โดยไม่ต้องล็อกอิน ก่อนจะกด PUBLISH APP ได้
// ถ้าหน้านี้กลายเป็นต้องล็อกอินเมื่อไหร่ Google จะตรวจไม่ผ่าน แล้วแอปจะตกกลับไปสถานะ Testing
// ซึ่งโทเคนหมดอายุทุก 7 วัน — ไฟล์แนบและการสำรองฐานข้อมูลจะหยุดทำงานทั้งระบบ
describe('หน้านโยบายความเป็นส่วนตัว ต้องเปิดดูได้โดยไม่ต้องล็อกอิน', () => {
  test('/privacy ไม่ถูกห่อด้วย requirePage และมีลิงก์จากหน้าเข้าสู่ระบบ', () => {
    const privacySrc = fs.readFileSync(new URL('../src/routes/privacy.js', import.meta.url), 'utf8');
    assert.match(privacySrc, /router\.get\('\/privacy'/);
    assert.ok(!/router\.get\('\/privacy',\s*require(Page|Role|Api)/.test(privacySrc),
      '/privacy ต้องเป็นหน้าสาธารณะ ห้ามห่อด้วย requirePage/requireRole — Google ต้องเข้ามาตรวจได้เอง');
    // ต้องมีทางเข้าถึงจริงจากหน้าแรกด้วย ไม่ใช่ URL ลอยๆ ที่ไม่มีใครลิงก์ถึง
    const authSrc = fs.readFileSync(new URL('../src/routes/auth.js', import.meta.url), 'utf8');
    assert.match(authSrc, /href="\/privacy"/, 'หน้าเข้าสู่ระบบต้องมีลิงก์ไปนโยบายความเป็นส่วนตัว');
    // และต้องถูก import เข้า router จริง ไม่งั้น route ไม่ถูกลงทะเบียน
    assert.match(fs.readFileSync(new URL('../src/routes/index.js', import.meta.url), 'utf8'), /import '\.\/privacy\.js';/);
  });
});

// แถบล่างของเอกสารมี 3 ช่องเรียงกัน (ทราบ / กรอบตราปั๊ม ผอ. / ความเห็นธุรการ) ขอบบนตรงกันทั้งสามช่อง
// ถ้าใครไปแก้ตำแหน่งหรือความกว้างของช่องใดช่องหนึ่ง แล้วช่องมาทับกันหรือล้นออกนอกหน้ากระดาษ จะไม่มี
// อะไรฟ้องเลยจนกว่าจะมีคนพิมพ์เอกสารจริงออกมาแล้วอ่านความเห็นทับกันไม่ออก — เทสต์นี้กันไว้ตรงนั้น
describe('ตราประทับ: สามช่องแถบล่างต้องไม่ทับกันและไม่ล้นหน้ากระดาษ', () => {
  const PAGE_W = 595; // A4 กว้าง (pt) ต้องตรงกับ PAGE_WIDTH_PT ใน pdfStamp.js
  const BORDER_AND_PADDING = 18; // กรอบ 2pt + padding 7pt ทั้งสองด้านของกล่อง ผอ.

  test('ความเห็นธุรการ → ทราบ → ตรา ผอ. เรียงจากซ้ายไปขวา ไม่ทับกัน และอยู่ในหน้ากระดาษ', async () => {
    const s = await import('../src/services/pdfStamp.js');
    const slots = [
      { name: 'ความเห็นธุรการ', left: s.DEFAULT_REGISTRAR_X_PERCENT / 100 * PAGE_W, width: s.REGISTRAR_BOX_WIDTH_PT },
      { name: 'ทราบ', left: s.DEFAULT_ACK_MARK_X_PERCENT / 100 * PAGE_W, width: s.ACK_MARK_WIDTH_PT },
      { name: 'ตรา ผอ.', left: s.DEFAULT_DECISION_X_PERCENT / 100 * PAGE_W, width: s.DECISION_BOX_WIDTH_PT + BORDER_AND_PADDING },
    ];
    for (let i = 0; i < slots.length; i++) {
      const a = slots[i];
      assert.ok(a.left >= 0, `${a.name} ล้นออกนอกขอบซ้าย`);
      assert.ok(a.left + a.width <= PAGE_W, `${a.name} ล้นออกนอกขอบขวา (ถึง ${Math.round(a.left + a.width)}pt จากหน้ากว้าง ${PAGE_W}pt)`);
      if (i > 0) {
        const prev = slots[i - 1];
        assert.ok(prev.left + prev.width <= a.left,
          `${prev.name} ทับ ${a.name} (${prev.name} จบที่ ${Math.round(prev.left + prev.width)}pt แต่ ${a.name} เริ่มที่ ${Math.round(a.left)}pt)`);
      }
    }
    // ต้องชิดมุมจริงๆ ตามที่โรงเรียนขอ ไม่ใช่ลอยอยู่กลางหน้า — ธุรการซ้ายล่าง ผอ. ขวาล่าง
    assert.ok(slots[0].left <= PAGE_W * 0.06, 'ความเห็นธุรการต้องชิดขอบซ้ายของหน้า');
    assert.ok(slots[2].left + slots[2].width >= PAGE_W * 0.86, 'กรอบตราปั๊ม ผอ. ต้องชิดขอบขวาของหน้า');
  });

  test('ขอบบนของทั้งสามช่องเป็นค่าเดียวกัน (บรรทัดบนสุดของความเห็นธุรการตรงกับกรอบตราปั๊ม ผอ.)', async () => {
    const { DECISION_MAX_TOP_PERCENT } = await import('../src/services/pdfStamp.js');
    const documentsSrc = fs.readFileSync(new URL('../src/routes/documents.js', import.meta.url), 'utf8');
    // ตำแหน่งเริ่มต้นของตรา "ทราบ" ต้องผูกกับค่าเดียวกัน ไม่ใช่ตัวเลขที่พิมพ์ทิ้งไว้แยกกัน
    assert.match(documentsSrc, /const MARK_BASE_Y = DECISION_MAX_TOP_PERCENT;/,
      'MARK_BASE_Y ต้องอ้างอิง DECISION_MAX_TOP_PERCENT ไม่ใช่ตัวเลขคงที่แยกของตัวเอง');
    assert.equal(typeof DECISION_MAX_TOP_PERCENT, 'number');
  });

  test('คำว่า "ทราบ" มีคำเดียวต่อหนังสือ และลายเซ็นเรียงต่อกันไม่ทับกัน', async () => {
    const s = await import('../src/services/pdfStamp.js');
    const base = s.DECISION_MAX_TOP_PERCENT;
    // คนแรกได้กล่องที่มีคำว่า "ทราบ" อยู่ด้วย จึงเริ่มที่ขอบบนสุดพอดี
    assert.equal(s.ackSlotTopPercent(0, base), base);
    // คนถัดไปต้องเริ่ม "ใต้" บล็อกของคนก่อนหน้าพอดี ไม่ทับและไม่มีช่องโหว่
    for (let i = 1; i < 4; i++) {
      const prevBottom = s.ackSlotTopPercent(i - 1, base)
        + (i === 1 ? s.ACK_WORD_HEIGHT_PERCENT : 0) + s.ACK_ENTRY_HEIGHT_PERCENT;
      assert.ok(Math.abs(s.ackSlotTopPercent(i, base) - prevBottom) < 0.01,
        `คนที่ ${i + 1} ต้องเริ่มที่ ${prevBottom}% แต่ได้ ${s.ackSlotTopPercent(i, base)}%`);
    }
    // ลายเซ็นคนที่ 4 ต้องยังอยู่ในหน้ากระดาษ (บล็อกสูง ACK_ENTRY_HEIGHT_PERCENT)
    assert.ok(s.ackSlotTopPercent(3, base) + s.ACK_ENTRY_HEIGHT_PERCENT <= 100, 'ต้องรองรับผู้ลงนามอย่างน้อย 4 คน');
    // ไม่ว่ามีกี่คน ต้องไม่หลุดออกนอกหน้า
    assert.ok(s.ackSlotTopPercent(99, base) <= s.ACK_MAX_TOP_PERCENT);

    // ต้องมีสวิตช์ปิดคำว่า "ทราบ" จริงๆ ไม่ใช่พิมพ์ทุกครั้ง
    const src = fs.readFileSync(new URL('../src/services/pdfStamp.js', import.meta.url), 'utf8');
    assert.match(src, /showWord \? '<div class="word">ทราบ<\/div>' : ''/,
      'คำว่า "ทราบ" ต้องขึ้นเฉพาะคนแรก');
  });

  test('ธุรการ/ผอ. ไม่ได้ตรา "ทราบ" ซ้ำ เพราะมีที่ลงนามของตัวเองอยู่แล้ว', () => {
    const src = fs.readFileSync(new URL('../src/routes/documents.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('async function stampAcknowledgeMarkIfApplicable'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /directorTitleMode\(stepId, actorUser\) !== 'generic'\) return;/,
      'ผอ./ผู้รักษาการแทนมีลายเซ็นในกรอบตราปั๊มอยู่แล้ว');
    assert.match(body, /roleCodes\.includes\('registrar'\)\) return;/,
      'ธุรการมีลายเซ็นในกล่องความเห็นอยู่แล้ว ไม่ต้องมีตรา "ทราบ" อีก');
  });

  test('เก็บเฉพาะไฟล์ประทับตราฉบับล่าสุด ไม่ทิ้งไฟล์เก่าค้างไว้', () => {
    // หนังสือฉบับเดียวถูกประทับซ้อนหลายชั้น (ความเห็นธุรการ -> ทราบ -> ตราปั๊ม ผอ.) ถ้าไม่ลบของเดิม
    // จะเหลือไฟล์ขยะบน Drive ชั้นละไฟล์ กินโควตา และธุรการที่เปิด Drive ดูจะแยกไม่ออกว่าอันไหนฉบับจริง
    const src = fs.readFileSync(new URL('../src/routes/documents.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('async function saveStampedCopy'), src.indexOf('async function deletePreviousStampedCopy'));
    assert.match(fn, /await deletePreviousStampedCopy\(prev, att\.id\);/, 'ต้องลบสำเนาชั้นก่อนหน้า');
    // ต้องอ่านค่าเดิมจากฐานข้อมูล ไม่ใช่จาก att ที่ส่งเข้ามา ซึ่งเก่าไปแล้วตั้งแต่การประทับชั้นที่สอง
    assert.match(fn, /const prev = db\.prepare\('SELECT stamped_storage_provider/,
      'ต้องอ่านสำเนาเดิมจากฐานข้อมูล ไม่ใช่จาก att ที่ค้างอยู่ในหน่วยความจำ');
    const prevAt = fn.indexOf('const prev =');
    const deleteAt = fn.indexOf('await deletePreviousStampedCopy');
    const updateAt = fn.indexOf('stamped_at = ?');
    assert.ok(prevAt < updateAt && updateAt < deleteAt,
      'ต้องอ่านของเดิม -> บันทึกตัวใหม่ -> ค่อยลบของเดิม (ลบก่อนบันทึกสำเร็จ = เสี่ยงไม่เหลือไฟล์เลย)');
  });

  test('ล้างไฟล์ที่ไม่มีเจ้าของ ต้องไม่แตะโฟลเดอร์สำเนาฐานข้อมูล', () => {
    // ไฟล์ในโฟลเดอร์สำเนาฐานข้อมูลไม่ได้ผูกกับตาราง attachments จึงเข้าข่าย "ไม่มีเจ้าของ" ทั้งหมด
    // ถ้าเผลอกวาดรวมไปด้วย = ลบสำเนาที่ใช้กู้ทะเบียนหนังสือทั้งเล่มกลับมา ซึ่งเรียกคืนไม่ได้อีกเลย
    const src = fs.readFileSync(new URL('../src/services/googleDrive.js', import.meta.url), 'utf8');
    const fn = src.slice(src.indexOf('export async function listAllAttachmentFiles'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /if \(year\.name === BACKUP_FOLDER_NAME\) continue;/,
      'listAllAttachmentFiles ต้องข้ามโฟลเดอร์สำเนาฐานข้อมูลเสมอ');
    // และต้องหาโฟลเดอร์หลักแบบไม่สร้างใหม่ ไม่งั้นการ "ตรวจ" จะไปสร้างโฟลเดอร์เปล่าทิ้งไว้
    assert.match(body, /await findFolder\(ROOT_FOLDER_NAME, 'root'\)/,
      'ต้องใช้ findFolder ที่ไม่สร้างโฟลเดอร์ใหม่');
  });

  test('ล้างไฟล์ที่ไม่มีเจ้าของ ต้องเทียบจาก id และตรวจใหม่ตอนลบ ไม่เชื่อรายการจากฝั่งเว็บ', () => {
    const src = fs.readFileSync(new URL('../src/routes/admin.js', import.meta.url), 'utf8');
    const finder = src.slice(src.indexOf('async function findOrphanDriveFiles'));
    const body = finder.slice(0, finder.indexOf('\n}\n'));
    // เทียบจาก id เท่านั้น — ชื่อไฟล์ซ้ำกันได้ และเดาผิดแปลว่าลบไฟล์แนบของจริงทิ้ง
    assert.match(body, /referenced\.add\(row\.drive_file_id\)/);
    assert.match(body, /referenced\.add\(row\.stamped_drive_file_id\)/);
    assert.match(body, /files\.filter\(\(f\) => !referenced\.has\(f\.id\)\)/);

    // endpoint ลบต้องตรวจหาใหม่เองฝั่งเซิร์ฟเวอร์ ไม่รับ id จากฝั่งเว็บ (ไม่งั้นสั่งลบไฟล์อะไรก็ได้)
    const del = src.slice(src.indexOf("router.post('/admin/google-drive/orphans/delete'"));
    const delBody = del.slice(0, del.indexOf('\n})));'));
    assert.match(delBody, /const files = await findOrphanDriveFiles\(\);/,
      'ต้องตรวจหาใหม่ตอนลบ ไม่ใช้รายการที่ฝั่งเว็บส่งมา');
    assert.ok(!/ctx\.body\.(ids|files|fileIds)/.test(delBody), 'ห้ามรับรายการไฟล์ที่จะลบจากฝั่งเว็บ');
    assert.match(delBody, /verifyPin\(ctx\.user\.id, ctx\.body\.pin\)/, 'ต้องยืนยัน PIN ก่อนลบ');
  });

  test('ความเห็นธุรการรอบที่สองต้องไม่ทับรอบแรก และเก็บไว้ในระบบให้ ผอ. เห็นในเว็บด้วย', () => {
    const src = fs.readFileSync(new URL('../src/routes/documents.js', import.meta.url), 'utf8');
    // ระยะเลื่อนขึ้นต้องมากกว่าความสูงกล่อง (~160pt ≈ 19% ของหน้า) ไม่งั้นรอบที่ 2 ยังทับรอบแรก
    const step = Number((src.match(/const REGISTRAR_BOX_STEP_Y = (\d+);/) || [])[1]);
    assert.ok(step >= 19, `ระยะเลื่อนขึ้นต้องมากกว่าความสูงกล่อง แต่ได้ ${step}%`);
    assert.match(src, /yPercent: registrarY \?\? registrarBoxYPercent\(att\.id\)/,
      'ต้องคำนวณตำแหน่งจากจำนวนครั้งที่เคยลงความเห็นบนไฟล์นี้');
    // ความเห็นต้องถูกเก็บในระบบด้วย ไม่ใช่พิมพ์ลง PDF อย่างเดียว — ผอ. จะได้เห็นโดยไม่ต้องเปิดไฟล์แนบ
    assert.match(src, /INSERT INTO comments \(id, document_id, user_id, message, created_at\)[\s\S]{0,200}เรียนผู้อำนวยการโรงเรียน/,
      'ความเห็นธุรการต้องถูกบันทึกเป็นความคิดเห็นในระบบด้วย');
  });

  test('หน้าตัวอย่างไม่มีกล่องให้ลากแล้ว และไม่ส่งตำแหน่งไปกับคำขอ', () => {
    const src = fs.readFileSync(new URL('../src/routes/documents.js', import.meta.url), 'utf8');
    for (const gone of ['makeDraggable', 'makeStampDraggable', 'window.markPos', 'window.decisionPos', 'window.registrarPos', 'cursor:move']) {
      assert.ok(!src.includes(gone), `ยังเหลือโค้ดลากวางอยู่: ${gone}`);
    }
    // ทุกกล่องต้องติดป้ายไว้ ให้เอาเมาส์ชี้แล้วรู้ว่าคือกล่องอะไร (บนจอย่อส่วน ตัวหนังสือทับกันจนอ่านไม่ออก)
    for (const id of ['docStamp', 'ackMark', 'decisionBox', 'registrarBox']) {
      const at = src.indexOf(`id="${id}"`);
      assert.ok(at > 0, `ไม่พบกล่อง ${id}`);
      assert.match(src.slice(at, at + 200), /data-label="/, `กล่อง ${id} ต้องมี data-label ไว้แสดงตอนเอาเมาส์ชี้`);
      assert.ok(src.slice(Math.max(0, at - 120), at).includes('doc-overlay-box'), `กล่อง ${id} ต้องมีคลาส doc-overlay-box`);
    }
    const css = fs.readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
    assert.match(css, /\.doc-overlay-box:hover::after \{ opacity: 1; \}/, 'ต้องมีป้ายโผล่ตอนเอาเมาส์ชี้');
  });

  test('กล่องตัวอย่างบนเว็บต้องได้ตำแหน่งจริง ไม่ใช่ top:undefined%', () => {
    // var ถูก hoist ขึ้นบนสุดของสโคปก็จริง แต่ "ค่า" ยังเป็น undefined จนกว่าจะรันบรรทัดที่กำหนดค่า
    // ถ้า var DECISION_MAX_TOP อยู่ทีหลังบรรทัดที่เอาไปต่อสตริง จะได้ style="top:undefined%" ซึ่ง
    // เบราว์เซอร์ทิ้งทั้งบรรทัด กล่องจะไปกองท้ายพื้นที่ตัวอย่างแทนตำแหน่งที่จะประทับจริง แล้วผู้ใช้จะ
    // เห็นตัวอย่างไม่ตรงกับไฟล์ที่ออกมา โดยไม่มีอะไรฟ้องเลย (บั๊กนี้เคยหลุดมาแล้วกับกล่องความเห็น ผอ.)
    const src = fs.readFileSync(new URL('../src/routes/documents.js', import.meta.url), 'utf8');
    const declaredAt = src.indexOf('var DECISION_MAX_TOP =');
    assert.ok(declaredAt > 0, 'ไม่พบการประกาศ var DECISION_MAX_TOP');
    for (const name of ['MARK_HTML', 'DECISION_HTML', 'REGISTRAR_HTML']) {
      const usedAt = src.indexOf(`var ${name} =`);
      assert.ok(usedAt > 0, `ไม่พบ ${name}`);
      assert.ok(declaredAt < usedAt,
        `ต้องประกาศ var DECISION_MAX_TOP ก่อน ${name} ไม่งั้น ${name} จะได้ top:undefined%`);
    }
  });

  test('ทุกกล่องส่งฟังก์ชัน build ให้ตัวเลื่อนขึ้นอัตโนมัติ ไม่ใช่ HTML ตายตัว', () => {
    // overlayHtmlOnFirstPage เรียก buildHtml(shiftUpPt) เพื่อ render ใหม่เมื่อกล่องล้นไปหน้า 2 —
    // ถ้ากล่องไหนส่ง string ตายตัวมาแทน ตัวเลื่อนจะไม่ทำงาน แล้วลายเซ็นจะหายจากเอกสารจริงแบบเงียบๆ
    const src = fs.readFileSync(new URL('../src/services/pdfStamp.js', import.meta.url), 'utf8');
    const calls = src.match(/overlayHtmlOnFirstPage\([^)]*\)/g) || [];
    assert.ok(calls.length >= 4, `คาดว่ามีกล่องอย่างน้อย 4 แบบ แต่พบ ${calls.length}`);
    for (const call of calls) {
      if (call.includes('originalBuffer, buildHtml')) continue; // นิยามฟังก์ชันเอง
      assert.ok(call.includes('originalBuffer, build'), `เรียก overlayHtmlOnFirstPage โดยไม่ส่งฟังก์ชัน build: ${call}`);
    }
    // และทุก build ต้องใช้ shiftUpPt จริง ไม่ใช่รับพารามิเตอร์มาแล้วทิ้ง
    const builds = src.match(/const build = \(shiftUpPt\) =>[\s\S]*?<\/html>`/g) || [];
    assert.equal(builds.length, 4, `คาดว่ามี build 4 ตัว แต่พบ ${builds.length}`);
    for (const b of builds) {
      assert.ok(b.includes('topPt - shiftUpPt'), 'build ตัวหนึ่งรับ shiftUpPt มาแล้วไม่ได้ใช้เลื่อนกล่องขึ้น');
    }
  });
});

// โฮสต์ฟรีทุกเจ้าใช้ดิสก์ชั่วคราว ฐานข้อมูลจึงหายทุกครั้งที่ deploy — ระบบสำรองขึ้น Google Drive
// คือสิ่งเดียวที่กันทะเบียนหนังสือทั้งเล่มหาย ถ้าสำเนาที่สร้างขึ้นมาใช้กู้คืนไม่ได้จริง จะไม่มีใครรู้
// จนถึงวันที่ต้องใช้มันจริงๆ
describe('สำรองฐานข้อมูล: สำเนาต้องกู้คืนได้จริงและครบถ้วน', () => {
  test('VACUUM INTO ได้ไฟล์ฐานข้อมูลที่เปิดอ่านได้และข้อมูลครบ แม้เปิดโหมด WAL อยู่', () => {
    // ห้ามคัดลอกไฟล์ .db ตรงๆ เพราะโหมด WAL เก็บข้อมูลที่เพิ่งเขียนไว้ในไฟล์ -wal แยกต่างหาก
    const doc = makeDoc({ title: 'เอกสารที่ต้องอยู่ในสำเนาสำรอง' });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esaraban-backup-test-'));
    const snapPath = path.join(tmpDir, 'snapshot.db');
    try {
      db.exec(`VACUUM INTO '${snapPath}'`);
      assert.ok(fs.existsSync(snapPath), 'ต้องได้ไฟล์สำเนาออกมา');

      // เปิดสำเนาเป็นฐานข้อมูลอิสระ แล้วต้องอ่านเอกสารที่เพิ่งสร้างเจอ
      const { DatabaseSync } = sqliteModule;
      const copy = new DatabaseSync(snapPath);
      try {
        const row = copy.prepare('SELECT title, doc_number_display FROM documents WHERE id = ?').get(doc.id);
        assert.ok(row, 'เอกสารที่เพิ่งบันทึกต้องอยู่ในสำเนา ไม่ใช่ค้างอยู่ในไฟล์ WAL');
        assert.equal(row.title, 'เอกสารที่ต้องอยู่ในสำเนาสำรอง');
        assert.equal(row.doc_number_display, doc.docNumberDisplay);
        // ตัวนับเลขทะเบียนต้องติดไปด้วย ไม่งั้นกู้คืนแล้วจะออกเลขซ้ำของเดิม
        assert.ok(copy.prepare('SELECT COUNT(*) c FROM document_number_counters').get().c > 0);
        assert.ok(copy.prepare('SELECT COUNT(*) c FROM users').get().c > 0);
      } finally {
        copy.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // สำรองทุก 5 นาที ถ้าเก็บแบบ "N ชุดล่าสุด" อย่างเดียวจะย้อนหลังได้แค่ราวชั่วโมงเดียว —
  // ไม่พอเลยกับกรณีที่เพิ่งมารู้ตัววันรุ่งขึ้นว่าลบผิด/แก้ผิด แล้วอยากได้ข้อมูลของเมื่อวานคืน
  describe('เก็บสำเนาย้อนหลังวันละชุด แยกเป็นโฟลเดอร์รายวัน 1 ปี', () => {
    // จำลองโฟลเดอร์รายวัน N วัน วันละ perDay ชุด เรียงใหม่ไปเก่าทั้งชั้นวันและชั้นไฟล์
    // (ตรงกับที่ readBackupTree() คืนมาหลังเรียงแล้ว)
    function fakeDays(days, perDay = 12, endDay = '2569-08-21') {
      const base = Date.UTC(Number(endDay.slice(0, 4)) - 543, Number(endDay.slice(5, 7)) - 1, Number(endDay.slice(8, 10)));
      return Array.from({ length: days }, (_, d) => {
        const iso = new Date(base - d * 86400000).toISOString().slice(0, 10);
        const name = `${Number(iso.slice(0, 4)) + 543}${iso.slice(4)}`;
        return {
          id: `day-${name}`,
          name,
          files: Array.from({ length: perDay }, (_, i) => {
            const hhmm = `${String(23 - Math.floor(i / 2)).padStart(2, '0')}${i % 2 ? '30' : '00'}`;
            return { id: `${name}-${hhmm}`, name: `esaraban-${hhmm}.db` };
          }),
        };
      });
    }

    test('ชื่อโฟลเดอร์เป็น พ.ศ. ตามเวลาไทย เพื่อให้ธุรการเปิดหาเองใน Drive ได้', () => {
      // 21 ส.ค. 2026 เวลา 23:30 UTC = 22 ส.ค. 2026 06:30 ตามเวลาไทย -> ต้องลงโฟลเดอร์ของวันที่ 22
      const p = thaiDateParts(new Date('2026-08-21T23:30:00Z'));
      assert.equal(p.year, '2569');
      assert.equal(p.month, '2569-08');
      assert.equal(p.day, '2569-08-22', 'ต้องใช้วันตามเวลาไทย ไม่ใช่ UTC');
      assert.equal(p.time, '0630');
      // เรียงตามตัวอักษรแล้วต้องได้ลำดับเวลาพอดี ไม่งั้นการหา "สำเนาล่าสุด" ตอนกู้คืนจะหยิบผิดวัน
      assert.ok('2569-08-22' > '2569-08-09' && '2569-08-09' > '2569-07-31');
    });

    test('วันนี้เก็บหลายชุด วันที่ผ่านไปแล้วเหลือวันละชุด (ชุดสุดท้ายของวันนั้น)', () => {
      const days = fakeDays(10);
      const { deleteFolderIds, deleteFileIds } = planBackupCleanup(days, {
        today: '2569-08-21', keepRecent: 6, keepDailyDays: 7,
      });
      assert.deepEqual(deleteFolderIds, ['day-2569-08-14', 'day-2569-08-13', 'day-2569-08-12'],
        'วันที่เกิน 7 วันย้อนหลังต้องถูกลบทั้งโฟลเดอร์');

      const gone = new Set(deleteFileIds);
      const kept = days.slice(0, 7).map((d) => ({ name: d.name, files: d.files.filter((f) => !gone.has(f.id)) }));
      assert.equal(kept[0].files.length, 6, 'วันนี้ต้องเก็บ 6 ชุดล่าสุด');
      for (const day of kept.slice(1)) {
        assert.equal(day.files.length, 1, `วัน ${day.name} ต้องเหลือชุดเดียว`);
        assert.equal(day.files[0].id, `${day.name}-2300`, `วัน ${day.name} ต้องเก็บชุดล่าสุดของวันนั้น ไม่ใช่ชุดแรกของวัน`);
      }
    });

    test('ไม่ลบไฟล์ในโฟลเดอร์ที่กำลังจะถูกลบทั้งโฟลเดอร์ (ยิงซ้ำเปล่าๆ)', () => {
      const { deleteFolderIds, deleteFileIds } = planBackupCleanup(fakeDays(3), {
        today: '2569-08-21', keepRecent: 12, keepDailyDays: 1,
      });
      assert.deepEqual(deleteFolderIds, ['day-2569-08-20', 'day-2569-08-19']);
      assert.deepEqual(deleteFileIds, [], 'ลบทั้งโฟลเดอร์แล้ว ไม่ต้องสั่งลบไฟล์ข้างในทีละไฟล์อีก');
    });

    test('เก็บครบ 1 ปีตามค่าเริ่มต้น — ไม่ตัดวันทิ้งก่อนครบปี', () => {
      // ค่าเริ่มต้น 365 วัน: 365 วันแรกต้องอยู่ครบ วันที่ 366 เป็นต้นไปถึงถูกลบ
      const { deleteFolderIds } = planBackupCleanup(fakeDays(400, 2), { today: '2569-08-21' });
      assert.equal(deleteFolderIds.length, 35);
      assert.ok(!deleteFolderIds.includes('day-2568-08-22'), 'วันที่ 365 ย้อนหลังต้องยังอยู่');
    });

    test('วันนี้ยังไม่มีในรายการ ก็ต้องไม่ทำให้วันอื่นถูกเก็บเกิน', () => {
      // เช่นเพิ่งข้ามเที่ยงคืนมาแล้วยังไม่ได้สำรองรอบแรกของวันใหม่
      const { deleteFileIds } = planBackupCleanup(fakeDays(2, 4, '2569-08-20'), {
        today: '2569-08-21', keepRecent: 12, keepDailyDays: 365,
      });
      assert.equal(deleteFileIds.length, 6, 'ทั้งสองวันเป็นวันที่ผ่านไปแล้ว ต้องเหลือวันละชุด');
    });

    test('ไม่มีสำเนาเลย ต้องไม่สั่งลบอะไร', () => {
      assert.deepEqual(planBackupCleanup([], { today: '2569-08-21' }), { deleteFolderIds: [], deleteFileIds: [] });
    });

    test('ตัดของเก่าโดยดูจากชื่อโฟลเดอร์ ไม่ต้องเปิดดูข้างในทุกวัน', async () => {
      const { splitByCutoff } = await import('../src/services/dbBackup.js');
      // เส้นตาย 2568-08-22 = วันเก่าสุดที่ยังเก็บไว้
      const years = [{ id: 'y69', name: '2569' }, { id: 'y68', name: '2568' }, { id: 'y67', name: '2567' }];
      const y = splitByCutoff(years, '2568');
      assert.deepEqual(y.deleteIds, ['y67'], 'ปีที่เก่ากว่าเส้นตายลบทั้งปีได้เลย ไม่ต้องเปิดดู');
      assert.deepEqual(y.descendIds, ['y68'], 'มีแค่ปีที่คร่อมเส้นตายที่ต้องเปิดดูต่อ');
      // ปี 2569 ใหม่กว่าเส้นตาย ต้องไม่ถูกแตะและไม่ต้องเปิดดู — นี่คือจุดที่ประหยัดคำขอได้มากที่สุด
      assert.ok(!y.deleteIds.includes('y69') && !y.descendIds.includes('y69'));

      const m = splitByCutoff([{ id: 'm09', name: '2568-09' }, { id: 'm08', name: '2568-08' }, { id: 'm07', name: '2568-07' }], '2568-08');
      assert.deepEqual(m.deleteIds, ['m07']);
      assert.deepEqual(m.descendIds, ['m08']);

      const d = splitByCutoff([{ id: 'd23', name: '2568-08-23' }, { id: 'd22', name: '2568-08-22' }, { id: 'd21', name: '2568-08-21' }], '2568-08-22');
      assert.deepEqual(d.deleteIds, ['d21'], 'วันที่เก่ากว่าเส้นตายเท่านั้นที่ถูกลบ');
      assert.ok(!d.deleteIds.includes('d22'), 'วันที่ตรงเส้นตายพอดีคือวันเก่าสุดที่ยังเก็บไว้ ห้ามลบ');
    });

    test('นับวันย้อนหลังข้ามเดือน/ข้ามปี พ.ศ. ได้ถูกต้อง', async () => {
      const { shiftThaiDay } = await import('../src/services/dbBackup.js');
      assert.equal(shiftThaiDay('2569-08-21', -1), '2569-08-20');
      assert.equal(shiftThaiDay('2569-08-01', -1), '2569-07-31', 'ข้ามเดือน');
      assert.equal(shiftThaiDay('2569-01-01', -1), '2568-12-31', 'ข้ามปี พ.ศ.');
      assert.equal(shiftThaiDay('2567-03-01', -1), '2567-02-29', 'ปีอธิกสุรทิน (ค.ศ. 2024)');
      // เก็บ 365 วัน "รวมวันนี้ด้วย" จึงย้อนไป 364 วัน — ช่วง 2568-08-22 ถึง 2569-08-21 คือ 365 วันพอดี
      assert.equal(shiftThaiDay('2569-08-21', -364), '2568-08-22', 'วันเก่าสุดที่ยังเก็บไว้ตามค่าเริ่มต้น 365 วัน');
      const span = (Date.UTC(2026, 7, 21) - Date.UTC(2025, 7, 22)) / 86400000 + 1;
      assert.equal(span, 365, 'ยืนยันว่าช่วงที่เก็บคือ 365 วันจริง');
    });

    test('อ่านโครงสร้างโฟลเดอร์ต้องไม่ยิงคำขออ่านไฟล์ของทุกวัน', () => {
      // เก็บครบ 1 ปี = 365 โฟลเดอร์รายวัน ถ้าอ่านไฟล์ของทุกวันจะเป็น ~380 คำขอต่อการเรียกหนึ่งครั้ง
      // ซึ่งถูกเรียกทั้งตอนเปิดหน้าจัดการ ตอนกู้คืน และ (เดิม) ตอนตัดของเก่าทุก 5 นาที = แสนกว่าคำขอ/วัน
      const src = fs.readFileSync(new URL('../src/services/dbBackup.js', import.meta.url), 'utf8');
      const body = src.slice(src.indexOf('export async function readBackupFolders'));
      const fn = body.slice(0, body.indexOf('\n}\n') + 2);
      assert.ok(!/listFilesInFolder|readBackupDayFiles/.test(fn),
        'readBackupFolders ต้องอ่านแค่โครงสร้างโฟลเดอร์ ห้ามอ่านไฟล์ในแต่ละวัน');
      // และตัวตัดของเก่าที่ทำงานทุก 5 นาที ต้องไม่ไปเรียกตัวที่ไล่ทั้งต้นไม้
      assert.match(src, /async function pruneOldBackups\(root, today, todayFolderId\)/);
      assert.match(src, /if \(lastFullPruneDay === today\) return;/,
        'งานหนักต้องทำวันละครั้ง ไม่ใช่ทุกรอบสำรอง');
    });

    test('การเก็บกวาดต้องไม่ถือล็อกการสำรอง (ไม่งั้นการสำรองรอบสุดท้ายก่อนปิดเครื่องจะถูกข้าม)', () => {
      // รอบเก็บกวาดวันละครั้งใช้เวลาเป็นนาที ถ้ายังถือ backingUp อยู่แล้วโฮสต์สั่งปิดเครื่องช่วงนั้นพอดี
      // backupNow('ก่อนปิดเซิร์ฟเวอร์') จะคืน false ทันที แล้วงานช่วงท้ายหายไปทั้งที่กันได้
      const src = fs.readFileSync(new URL('../src/services/dbBackup.js', import.meta.url), 'utf8');
      const fn = src.slice(src.indexOf('export async function backupNow'), src.indexOf('export async function readBackupFolders'));
      const releaseAt = fn.indexOf('backingUp = false;');
      const pruneAt = fn.indexOf('await pruneOldBackups(');
      assert.ok(releaseAt > 0 && pruneAt > 0);
      assert.ok(releaseAt < pruneAt, 'ต้องปลดล็อก backingUp ก่อนเรียก pruneOldBackups');
      // และเมื่อไม่ได้ถือล็อกร่วมกันแล้ว ตัวเก็บกวาดต้องมีล็อกของตัวเองกันทำงานซ้อนกัน
      assert.match(src, /if \(pruning\) return;/, 'pruneOldBackups ต้องมีล็อกของตัวเอง');
    });

    test('หน้าจัดการมีปุ่มลบครบทุกชั้น และโหลดไฟล์รายวันตอนกดเปิดเท่านั้น', async () => {
      const { backupTreeHtml } = await import('../src/routes/backups.js');
      const html = backupTreeHtml([{
        id: 'y', name: '2569',
        months: [{ id: 'm', name: '2569-08', days: [{ id: 'd', name: '2569-08-21' }] }],
      }]);
      for (const [id, what] of [['y', 'ทั้งปี'], ['m', 'ทั้งเดือน'], ['d', 'ทั้งวัน']]) {
        assert.ok(html.includes(`removeBackup('${id}'`), `ต้องมีปุ่มลบของ ${what}`);
        assert.ok(html.includes(`ลบ${what}`), `ปุ่มต้องบอกว่าลบ${what}`);
      }
      // รายชื่อไฟล์ต้องไม่ถูก render มาพร้อมหน้า — ต้องผูก loadBackupDay ไว้ให้ไปโหลดตอนกดเปิดวันนั้น
      // (ถ้า render มาพร้อมหน้า พอเก็บครบ 1 ปีจะเป็น ~380 คำขอไป Google Drive ต่อการเปิดหน้าหนึ่งครั้ง)
      assert.match(html, /ontoggle="loadBackupDay\(this, 'd'/, 'วันต้องผูกตัวโหลดไฟล์แบบกดแล้วค่อยโหลด');
      // ชื่อโฟลเดอร์เก็บเป็นตัวเลขล้วนเพื่อให้เรียงถูก แต่ต้องแสดงเป็นคำอ่านให้ธุรการเข้าใจ
      assert.ok(html.includes('สิงหาคม 2569'), 'เดือนต้องแสดงเป็นชื่อเดือนไทย');
      assert.ok(html.includes('21 สิงหาคม 2569'), 'วันต้องแสดงเป็นวันที่อ่านออก');
    });

    test('ไม่มีสำเนาเลย ต้อง render ได้โดยไม่พัง', async () => {
      const { backupTreeHtml } = await import('../src/routes/backups.js');
      assert.equal(backupTreeHtml([]), '');
      assert.ok(backupTreeHtml([{ id: 'y', name: '2569', months: [] }]).includes('ปี 2569'));
    });
  });

  test('ไม่เขียนทับฐานข้อมูลที่มีอยู่แล้ว (เครื่องที่ดิสก์ไม่หายต้องไม่โดนกู้คืนทับ)', async () => {
    const before = { STORAGE_PROVIDER: process.env.STORAGE_PROVIDER, GOOGLE_OAUTH_REFRESH_TOKEN: process.env.GOOGLE_OAUTH_REFRESH_TOKEN };
    try {
      process.env.STORAGE_PROVIDER = 'google_drive';
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'สมมติว่าเชื่อมต่อแล้ว';
      assert.equal(isBackupEnabled(), true, 'ต้องถือว่าเปิดใช้การสำรองแล้ว');
      // ไฟล์ฐานข้อมูลของเทสต์นี้มีอยู่จริง จึงต้องคืน false ทันทีโดยไม่แตะเครือข่ายเลย
      assert.equal(await restoreDatabaseIfMissing(), false);
      assert.ok(fs.existsSync(tmpDb), 'ไฟล์ฐานข้อมูลเดิมต้องยังอยู่');
    } finally {
      if (before.STORAGE_PROVIDER === undefined) delete process.env.STORAGE_PROVIDER;
      else process.env.STORAGE_PROVIDER = before.STORAGE_PROVIDER;
      if (before.GOOGLE_OAUTH_REFRESH_TOKEN === undefined) delete process.env.GOOGLE_OAUTH_REFRESH_TOKEN;
      else process.env.GOOGLE_OAUTH_REFRESH_TOKEN = before.GOOGLE_OAUTH_REFRESH_TOKEN;
    }
  });

  test('ยังไม่ได้เชื่อมต่อ Drive ต้องไม่พังและไม่ทำอะไรเลย', async () => {
    assert.equal(isBackupEnabled(), false);
    assert.equal(await restoreDatabaseIfMissing(), false);
    assert.equal(await backupNow('ทดสอบ'), false);
  });

  // server.js ต้องกู้คืนก่อนโหลด db.js เสมอ — ถ้าเผลอเปลี่ยนกลับไปเป็น import ปกติ ESM จะยกขึ้นไป
  // เปิดฐานข้อมูลก่อน แล้วสำเนาที่กู้มาจะไม่มีผล กลายเป็นเริ่มจากศูนย์ทุกครั้งโดยไม่มีอะไรฟ้อง
  test('server.js กู้คืนฐานข้อมูลก่อนเปิดฐานข้อมูลเสมอ', () => {
    const src = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    assert.doesNotMatch(src, /^import \{[^}]*\} from '\.\/src\/db\.js';/m,
      "server.js ต้องไม่ import db.js แบบปกติ (ESM จะเปิดฐานข้อมูลก่อนกู้คืน) — ให้ใช้ await import()");
    const restoreAt = src.indexOf('restoreDatabaseIfMissing()');
    const dbAt = src.indexOf("await import('./src/db.js')");
    assert.ok(restoreAt > 0 && dbAt > 0, 'หาบรรทัดกู้คืน/โหลด db.js ไม่เจอ');
    assert.ok(restoreAt < dbAt, 'ต้องกู้คืนก่อนโหลด db.js');
  });
});

test('cleanup: remove the throwaway test database file', () => {
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`${tmpDb}-wal`, { force: true });
  fs.rmSync(`${tmpDb}-shm`, { force: true });
});
