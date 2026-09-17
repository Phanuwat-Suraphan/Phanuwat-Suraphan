// เดินเส้นทางไฟล์แนบบน Google Drive ให้ครบวง: แนบ → เก็บขึ้น Drive → เปิดกลับมา → เทียบไบต์
//
// ทำไมต้องมี: เครื่องจริงของโรงเรียนตั้ง STORAGE_PROVIDER=google_drive ไฟล์แนบทุกไฟล์จึงอยู่บน Drive
// ไม่ได้อยู่บนดิสก์ แต่เทสต์ทั้งชุดรันในโหมดเก็บลงดิสก์ — แปลว่าเส้นทางที่ใช้งานจริงไม่เคยถูกทดสอบเลย
// และถ้าเส้นนี้พัง หนังสือราชการจะไม่มีไฟล์สแกนให้เปิด ทั้งที่ทะเบียนบอกว่ามีไฟล์แนบอยู่
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createFakeDrive } from './fakeDrive.js';

const dbPath = path.join(os.tmpdir(), `esaraban-driveatt-${process.pid}-${Date.now()}.db`);
process.env.DB_PATH = dbPath;
process.env.STORAGE_PROVIDER = 'google_drive';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-secret';
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'fake-refresh';
process.env.SESSION_SECRET = 'driveatt-test-secret';
delete process.env.TEST_MODE_PASSWORD;

const out = {};
const uploadDir = path.join(new URL('..', import.meta.url).pathname, 'uploads');

try {
  const drive = createFakeDrive();
  const { _setDriveFetchForTest } = await import('../src/services/googleDrive.js');
  _setDriveFetchForTest(drive.fetch);

  const { db } = await import('../src/db.js');
  const { router } = await import('../src/router.js');
  await import('../src/routes/index.js');

  const countPdfs = () => (fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).filter((f) => f.endsWith('.pdf')).length : 0);
  const pdfsBefore = countPdfs();

  const userRow = db.prepare("SELECT id FROM users WHERE employee_code = 'reg001'").get();
  const roleCodes = db.prepare('SELECT r.name FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ?')
    .all(userRow.id).map((r) => r.name);
  const user = { ...db.prepare('SELECT * FROM users WHERE id = ?').get(userRow.id), roleCodes, unreadCount: 0 };
  const deptId = db.prepare('SELECT id FROM departments LIMIT 1').get().id;

  // เนื้อไฟล์ PDF ที่มีลายเซ็นจำเพาะ ไว้เทียบว่าที่เปิดกลับมาเป็นไฟล์เดียวกันจริง
  const pdf = Buffer.concat([
    Buffer.from('%PDF-1.4\n% ไฟล์แนบสำหรับทดสอบ Drive\ntrailer<</Root 1 0 R>>\n%%EOF\n'),
    Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 251)),
  ]);
  const pdfHash = createHash('sha256').update(pdf).digest('hex');

  const dispatch = async (method, p, { body = {}, query = {} } = {}) => {
    let status = 0; const chunks = []; const headers = {};
    const res = {
      headersSent: false, setHeader() {},
      writeHead(c, h) { status = c; Object.assign(headers, h || {}); this.headersSent = true; return this; },
      end(c) { if (c) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); },
      on() {}, once() {}, emit() {}, write(c) { chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))); return true; },
    };
    const ctx = { req: { method, headers: {} }, res, url: new URL(`http://x${p}`), query, user, body, ip: '127.0.0.1' };
    await router.dispatch(method, p, ctx);
    // ไฟล์ถูกส่งด้วย stream.pipe(res) จึงต้องรอให้ไหลจนจบก่อนอ่านผล
    await new Promise((r) => setTimeout(r, 120));
    return { status, headers, buffer: Buffer.concat(chunks) };
  };

  // --- 1) ลงทะเบียนหนังสือพร้อมไฟล์แนบ ---
  const created = await dispatch('POST', '/documents', {
    body: {
      title: 'หนังสือทดสอบไฟล์แนบบน Drive', departmentId: deptId, correspondentName: 'สพป.',
      direction: 'incoming', fileName: 'สแกนหนังสือ.pdf', fileType: 'application/pdf',
      fileDataBase64: pdf.toString('base64'),
    },
  });
  const docId = /documents\/([0-9a-f-]{36})/.exec(created.buffer.toString())?.[1];
  out.created = created.status;
  out.docId = Boolean(docId);

  const att = db.prepare('SELECT * FROM attachments WHERE document_id = ?').get(docId);
  out.storageProvider = att?.storage_provider;
  out.hasDriveId = Boolean(att?.drive_file_id);
  out.filepathIsNull = att?.filepath === null;
  out.hashMatches = att?.hash_sha256 === pdfHash;
  out.filesOnDrive = [...drive.folderNames()];

  // ต้องไม่มีไฟล์หลุดลงดิสก์เลยเมื่อใช้โหมด Drive — ถ้าหลุด แปลว่า deploy ครั้งหน้าไฟล์นั้นหายไปเงียบๆ
  // (นับเฉพาะที่เพิ่มขึ้นระหว่างเทสต์นี้ ไม่นับของเก่าที่ค้างอยู่ในโฟลเดอร์จากการรันครั้งก่อนๆ)
  out.strayFilesOnDisk = countPdfs() - pdfsBefore;

  // --- 2) เปิดไฟล์กลับมาแล้วเทียบไบต์ ---
  const opened = await dispatch('GET', `/files/${att.id}`);
  out.openStatus = opened.status;
  out.openContentType = opened.headers['Content-Type'];
  out.bytesMatch = opened.buffer.equals(pdf);
  out.openedHash = createHash('sha256').update(opened.buffer).digest('hex') === pdfHash;

  // --- 3) Drive ล่มตอนเปิดไฟล์ ต้องบอกให้รู้ ไม่ใช่ส่งไฟล์เปล่าที่ดูเหมือน PDF เสีย ---
  drive.faults.failDownload = true;
  const broken = await dispatch('GET', `/files/${att.id}`);
  out.brokenStatus = broken.status;
  out.brokenIsHtml = String(broken.headers['Content-Type'] || '').includes('text/html');
  out.brokenSaysError = broken.buffer.toString().includes('เกิดข้อผิดพลาด');
  drive.faults.failDownload = false;

  // --- 4) โทเคนหมดอายุ (ปัญหาที่เจอบ่อยที่สุดของ Google Cloud โหมด Testing) ---
  drive.faults.failToken = true;
  const { _setDriveFetchForTest: reset } = await import('../src/services/googleDrive.js');
  reset(drive.fetch); // ล้างโทเคนที่แคชไว้ ไม่งั้นจะใช้ของเดิมที่ยังไม่หมดอายุ
  const expired = await dispatch('GET', `/files/${att.id}`);
  out.expiredStatus = expired.status;
  out.expiredExplains = expired.buffer.toString().includes('PUBLISH APP');
  drive.faults.failToken = false;
} catch (err) {
  out.fatal = err?.message || String(err);
  out.stack = err?.stack;
} finally {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(p, { force: true }); } catch { /* ไม่เป็นไร */ }
  }
}

console.log(JSON.stringify(out));
