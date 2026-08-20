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

const { db, computeRetentionUntil, beYear } = await import('../src/db.js');
const { login } = await import('../src/auth.js');
const {
  createDocument, getDocument, canUserSeeDocument, currentStep,
  assignStep, approveAndForward, acknowledgeAndComplete, rejectStep, returnStep, voidDocument,
  assertStepBelongsToDocument,
} = await import('../src/services/workflow.js');
const { nextRunningNumber } = await import('../src/numbering.js');

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
    createdBy: adminUser.id, ...overrides,
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

describe('numbering: atomic, sequential, gap-free', () => {
  test('running numbers increment sequentially within the same year/department/type/direction', () => {
    const year = beYear();
    const a = nextRunningNumber({ departmentId: deptId, docTypeId: typeId, direction: 'incoming', year });
    const b = nextRunningNumber({ departmentId: deptId, docTypeId: typeId, direction: 'incoming', year });
    assert.equal(b.runningNumber, a.runningNumber + 1);
  });

  test('incoming and outgoing counters are independent', () => {
    const year = beYear();
    const inNum = nextRunningNumber({ departmentId: deptId, docTypeId: typeId, direction: 'incoming', year });
    const outNum = nextRunningNumber({ departmentId: deptId, docTypeId: typeId, direction: 'outgoing', year });
    // both start counting from 1 independently — an outgoing number should not be shifted by incoming activity
    assert.ok(outNum.runningNumber <= inNum.runningNumber);
  });

  test('created documents get the display format 0000/YYYY', () => {
    const doc = makeDoc({ title: 'ตรวจสอบเลขที่เอกสาร' });
    assert.match(doc.docNumberDisplay, /^\d{4}\/\d{4}$/);
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

test('cleanup: remove the throwaway test database file', () => {
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`${tmpDb}-wal`, { force: true });
  fs.rmSync(`${tmpDb}-shm`, { force: true });
});
