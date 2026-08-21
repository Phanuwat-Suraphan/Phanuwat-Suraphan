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

const { db, computeRetentionUntil, beYear, todayInBangkok } = await import('../src/db.js');
const { login } = await import('../src/auth.js');
const { daysUntil } = await import('../src/render.js');
const {
  createDocument, getDocument, canUserSeeDocument, currentStep,
  assignStep, approveAndForward, acknowledgeAndComplete, rejectStep, returnStep, voidDocument, archiveDocument,
  assertStepBelongsToDocument,
} = await import('../src/services/workflow.js');
const { nextRunningNumber } = await import('../src/numbering.js');
const { readWorkbook } = await import('../src/services/xlsx.js');
const { parseUploadedWorkbook, looksLikeHeader } = await import('../src/services/dailySummaryParse.js');
const {
  createLeaveRequest, approveLeaveRequest, rejectLeaveRequest, canSeeLeaveRequest, getLeaveRequest,
} = await import('../src/services/leave.js');
const { createDelegation } = await import('../src/services/delegation.js');
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

test('cleanup: remove the throwaway test database file', () => {
  fs.rmSync(tmpDb, { force: true });
  fs.rmSync(`${tmpDb}-wal`, { force: true });
  fs.rmSync(`${tmpDb}-shm`, { force: true });
});
