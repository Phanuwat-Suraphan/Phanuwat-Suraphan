// Zero-dependency test suite (node:test, built into Node 22 — no npm packages needed).
// Uses a throwaway SQLite file per run (DB_PATH) so it never touches data/esaraban.db.
// Run with: node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpDb = path.join(os.tmpdir(), `esaraban-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.DB_PATH = tmpDb;
process.env.SESSION_SECRET = 'test-secret-not-for-production';

const { db, computeRetentionUntil, beYear, todayInBangkok, hashSecret, verifySecret } = await import('../src/db.js');
const { login, getSessionUser, revokeOtherSessions, verifyPin } = await import('../src/auth.js');
const { contentDispositionHeader } = await import('../src/router.js');
const { daysUntil, fmtDate, fmtThaiDateShort, fmtThaiDateLong, stampDateThai, stampTimeThai, bangkokHour } = await import('../src/render.js');
const {
  createDocument, getDocument, canUserSeeDocument, currentStep,
  assignStep, approveAndForward, acknowledgeAndComplete, rejectStep, returnStep, voidDocument, archiveDocument,
  assertStepBelongsToDocument, forceDeleteDocument,
} = await import('../src/services/workflow.js');
const { nextRunningNumber } = await import('../src/numbering.js');
const { readWorkbook } = await import('../src/services/xlsx.js');
const { parseUploadedWorkbook, looksLikeHeader } = await import('../src/services/dailySummaryParse.js');
const {
  createLeaveRequest, approveLeaveRequest, rejectLeaveRequest, canSeeLeaveRequest, getLeaveRequest,
} = await import('../src/services/leave.js');
const { createDelegation } = await import('../src/services/delegation.js');
const { isBackupEnabled, restoreDatabaseIfMissing, backupNow, planBackupCleanup, thaiDateParts } = await import('../src/services/dbBackup.js');
const sqliteModule = await import('node:sqlite');
const { createDestructionBatch, approveDestructionBatch } = await import('../src/services/retention.js');
const zlib = await import('node:zlib');

const seed = db._seed;
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

describe('auth: login + rate limiting', () => {
  test('rejects unknown user with a generic error', () => {
    const result = login('nonexistent', 'whatever', '127.0.0.1');
    assert.equal(result.ok, false);
  });

  test('accepts correct credentials', () => {
    const result = login('teacher001', 'Teacher@2569', '127.0.0.1');
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

    const blockedEvenCorrect = login('reg001', 'Reg@2569', '127.0.0.1');
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
    assert.equal(verifyPin(teacherUser.id, 666666), false, 'ตัวเลขต้องไม่ผ่าน (ต้องเป็นข้อความ)');
    assert.equal(verifyPin(teacherUser.id, '666666'), true);
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

  test('พบรายการหน้าจาก router (กันกรณี filter ผิดแล้วเทสต์ผ่านเพราะไม่ได้ยิงอะไรเลย)', () => {
    assert.ok(pages.length >= 15, `ควรเจอหน้ามากกว่านี้ แต่เจอ ${pages.length}: ${pages.join(', ')}`);
    assert.ok(pages.includes('/tasks') && pages.includes('/'), pages.join(', '));
  });

  for (const code of ['admin', 'director01', 'reg001', 'teacher001']) {
    test(`เปิดทุกหน้าในบทบาทของ ${code} ได้โดยไม่ระเบิด`, async () => {
      const user = userAs(code);
      const broken = [];
      for (const pathname of pages) {
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

  // ทั้งระบบใช้ปีพุทธศักราชและชื่อเดือนไทย ถ้าที่ไหนลืมแปลง วันที่ดิบจากฐานข้อมูล (2026-08-25) จะโผล่มา
  // ให้ครูอ่านเอง ซึ่งเป็น ค.ศ. และเรียงคนละแบบ — เคยหลุดมาแล้วทั้งหน้ารายละเอียดเอกสาร หน้าลา
  // หน้ามอบหมายรักษาการแทน และหน้าอายุการเก็บ เพราะไม่มีอะไรคอยจับ
  test('ไม่มีวันที่ดิบแบบ 2026-08-25 หลุดออกมาให้ผู้ใช้เห็น', async () => {
    // ต้องสร้างข้อมูลที่มีวันที่ในทุกโมดูลที่แสดงวันที่ก่อน ไม่งั้นหน้าที่ยังไม่มีรายการจะผ่านไปเฉยๆ
    // ทั้งที่ไม่ได้ตรวจอะไรเลย (ลองแล้ว: ใส่บั๊กกลับเข้าหน้า /leave แต่เทสต์ยังเขียว เพราะไม่มีใบลาสักใบ)
    const doc = makeDoc({ title: 'เอกสารตรวจรูปแบบวันที่', dueDate: '2026-08-25' });
    assignStep({ documentId: doc.id, assigneeId: seed.userIds.director01, instruction: 'เพื่อพิจารณา', actorUser: registrarUser });
    createLeaveRequest({
      requesterId: teacherUser.id, leaveType: 'sick', startDate: '2026-08-24', endDate: '2026-08-26',
      reason: 'ไม่สบาย', approverId: seed.userIds.director01,
    });
    createDelegation({
      delegatorId: seed.userIds.director01, delegateId: teacherUser.id,
      startDate: '2026-08-24', endDate: '2026-08-26', reason: 'ผอ. ไปราชการ', createdBy: seed.userIds.director01,
    });

    // Audit Log แสดง detail ดิบของแต่ละเหตุการณ์ตามที่บันทึกไว้ เพื่อใช้สอบทานย้อนหลัง — ตรงนั้น
    // ต้องเป็นค่าดิบจริงๆ ไม่ใช่ค่าที่จัดรูปแบบใหม่ ไม่งั้นหลักฐานไม่ตรงกับที่เก็บ
    const RAW_OK = new Set(['/admin/audit']);
    const offenders = [];
    for (const code of ['admin', 'director01', 'reg001']) {
      const user = userAs(code);
      for (const pathname of pages.filter((p) => !RAW_OK.has(p))) {
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
    db.prepare("UPDATE documents SET status = 'completed', retention_until = '2020-01-01' WHERE id = ?").run(doc.id);
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
    const [other, current] = twoSessions('vicedir01', 'Vice@2569');
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
    const s = login('head_acad', 'Head@2569', '127.0.0.1', 'เครื่องเดิม');
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
      requesterId: teacherUser.id, leaveType: 'personal', startDate: '2026-10-01', endDate: '2026-10-02',
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

    test('หน้าจัดการมีปุ่มลบครบทุกชั้น — ทั้งปี ทั้งเดือน ทั้งวัน และรายไฟล์', async () => {
      const { backupTreeHtml } = await import('../src/routes/backups.js');
      const html = backupTreeHtml([{
        id: 'y', name: '2569',
        months: [{
          id: 'm', name: '2569-08',
          days: [{ id: 'd', name: '2569-08-21', files: [{ id: 'f', name: 'esaraban-1530.db', size: 2097152 }] }],
        }],
      }]);
      for (const [id, what] of [['y', 'ทั้งปี'], ['m', 'ทั้งเดือน'], ['d', 'ทั้งวัน'], ['f', 'ไฟล์นี้']]) {
        assert.ok(html.includes(`removeBackup('${id}'`), `ต้องมีปุ่มลบของ ${what}`);
        assert.ok(html.includes(`ลบ${what}`), `ปุ่มต้องบอกว่าลบ${what}`);
      }
      // ชื่อโฟลเดอร์เก็บเป็นตัวเลขล้วนเพื่อให้เรียงถูก แต่ต้องแสดงเป็นคำอ่านให้ธุรการเข้าใจ
      assert.ok(html.includes('สิงหาคม 2569'), 'เดือนต้องแสดงเป็นชื่อเดือนไทย');
      assert.ok(html.includes('21 สิงหาคม 2569'), 'วันต้องแสดงเป็นวันที่อ่านออก');
      assert.ok(html.includes('15:30 น.'), 'ไฟล์ต้องแสดงเป็นเวลาที่สำรอง');
      assert.ok(html.includes('2.00 MB'), 'ต้องบอกขนาดไฟล์');
    });

    test('ไม่มีไฟล์ในวันนั้น ต้องไม่พังและบอกให้รู้', async () => {
      const { backupTreeHtml } = await import('../src/routes/backups.js');
      const html = backupTreeHtml([{ id: 'y', name: '2569', months: [{ id: 'm', name: '2569-08', days: [{ id: 'd', name: '2569-08-21', files: [] }] }] }]);
      assert.ok(html.includes('ไม่มีไฟล์ในวันนี้'));
      assert.equal(backupTreeHtml([]), '');
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
