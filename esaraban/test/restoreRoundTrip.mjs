// เดินเส้นทาง "สำรอง → ดิสก์ถูกล้าง → กู้คืน" ให้ครบวงในโปรเซสของตัวเอง แล้วรายงานผลเป็น JSON
//
// ต้องแยกโปรเซส เพราะเทสต์ชุดหลักใช้ไฟล์ฐานข้อมูลร่วมกันทั้งชุดและเปิดค้างไว้ตลอด จะลบทิ้งกลางคัน
// เพื่อจำลอง "ดิสก์ถูกล้าง" ไม่ได้ — และการแยกโปรเซสยังได้ทดสอบลำดับการบูตจริงไปด้วยในตัว
//
// รับชื่อสถานการณ์ทาง argv[2]: ok | download-fails | truncated | no-backup
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createFakeDrive } from './fakeDrive.js';

const scenario = process.argv[2] || 'ok';
const dbPath = path.join(os.tmpdir(), `esaraban-roundtrip-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = dbPath;
process.env.STORAGE_PROVIDER = 'google_drive';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-secret';
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'fake-refresh';
process.env.SESSION_SECRET = 'roundtrip-test-secret';
delete process.env.TEST_MODE_PASSWORD;

const out = { scenario };
const cleanupPaths = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.restoring`];

try {
  const drive = createFakeDrive();
  const { _setDriveFetchForTest } = await import('../src/services/googleDrive.js');
  _setDriveFetchForTest(drive.fetch);

  const backupMod = await import('../src/services/dbBackup.js');

  // --- ก่อนมีอะไรเลย: ยังไม่มีสำเนาบน Drive การกู้คืนต้องไม่พัง และต้องบอกว่าไม่ได้กู้ ---
  if (scenario === 'no-backup') {
    out.restoredWithNothingOnDrive = await backupMod.restoreDatabaseIfMissing();
    out.dbExistsAfter = fs.existsSync(dbPath);
    console.log(JSON.stringify(out));
    cleanupPaths.forEach((p) => fs.rmSync(p, { force: true }));
    process.exit(0);
  }

  // --- 1) สร้างฐานข้อมูลจริงแล้วใส่หนังสือที่มีเครื่องหมายจำเพาะไว้ ---
  const { db, uuid, nowIso } = await import('../src/db.js');
  const marker = `หนังสือหลักฐานการกู้คืน-${Date.now()}`;
  const deptId = db.prepare('SELECT id FROM departments LIMIT 1').get().id;
  const typeId = db.prepare('SELECT id FROM document_types LIMIT 1').get().id;
  const userId = db.prepare('SELECT id FROM users LIMIT 1').get().id;
  db.prepare(`INSERT INTO documents (id, direction, running_number, year_be, doc_number_display, title,
      doc_type_id, department_id, status, created_by, created_at, updated_at)
    VALUES (?, 'incoming', 9999, 2569, '9999/2569', ?, ?, ?, 'registered', ?, ?, ?)`)
    .run(uuid(), marker, typeId, deptId, userId, nowIso(), nowIso());
  out.docsBefore = db.prepare('SELECT COUNT(*) c FROM documents').get().c;

  // --- 2) สำรองขึ้น Drive (จำลอง) ---
  out.backupOk = await backupMod.backupNow('ทดสอบวงรอบ');
  if (scenario === 'fallback') {
    // สำรองอีกชุดหลังเพิ่มหนังสืออีกฉบับ เพื่อให้มีสองชุดที่ต่างกันจริงๆ
    db.prepare(`INSERT INTO documents (id, direction, running_number, year_be, doc_number_display, title,
        doc_type_id, department_id, status, created_by, created_at, updated_at)
      VALUES (?, 'incoming', 9998, 2569, '9998/2569', 'หนังสือของสำเนาชุดที่สอง', ?, ?, 'registered', ?, ?, ?)`)
      .run(uuid(), typeId, deptId, userId, nowIso(), nowIso());
    out.secondBackupOk = await backupMod.backupNow('ทดสอบวงรอบ 2');
  }
  out.filesOnDrive = drive.backupFiles().length;
  out.folderNames = drive.folderNames();

  // --- 3) จำลองว่าโฮสต์ล้างดิสก์: ปิดฐานข้อมูลแล้วลบไฟล์ทิ้งให้หมด ---
  db.close();
  cleanupPaths.forEach((p) => fs.rmSync(p, { force: true }));
  out.dbGone = !fs.existsSync(dbPath);

  if (scenario === 'download-fails') drive.faults.failDownload = true;
  if (scenario === 'truncated') drive.faults.truncateDownload = true;
  // สำเนาล่าสุดพัง แต่ของก่อนหน้ายังดี — ต้องถอยไปใช้ของก่อนหน้า ไม่ใช่เริ่มจากศูนย์
  if (scenario === 'fallback') {
    // ทำให้ไฟล์ที่การกู้คืน "จะหยิบเป็นตัวแรก" พังไป แล้วดูว่าถอยไปใช้ตัวถัดไปหรือไม่
    // readBackupDayFiles เรียงตามชื่อจากมากไปน้อย ชื่อเท่ากันก็เรียงตามลำดับที่อัปโหลด (sort เสถียร)
    // ตัวแรกจึงเป็นสำเนาชุดแรกซึ่งมีหนังสือฉบับเดียว ส่วนชุดที่สองมีสองฉบับ — แยกกันได้ด้วยจำนวน
    const first = drive.backupFiles()[0];
    drive.faults.truncateIds.add(first.id);
    out.corruptedId = first.id;
  }

  // --- 4) กู้คืน ---
  out.restored = await backupMod.restoreDatabaseIfMissing();
  out.dbBack = fs.existsSync(dbPath);
  out.leftoverTempFile = fs.existsSync(`${dbPath}.restoring`);

  // --- 5) ตรวจว่าข้อมูลกลับมาจริง โดยเปิดไฟล์ด้วย handle ใหม่ ---
  if (out.dbBack) {
    try {
      const check = new DatabaseSync(dbPath);
      out.docsAfter = check.prepare('SELECT COUNT(*) c FROM documents').get().c;
      out.markerFound = Boolean(check.prepare('SELECT 1 x FROM documents WHERE title = ?').get(marker));
      out.usersAfter = check.prepare('SELECT COUNT(*) c FROM users').get().c;
      check.close();
    } catch (err) {
      out.readBackError = err.message;
    }
  }
  out.restoredName = backupMod.restoredFromBackupAtBoot();
} catch (err) {
  out.fatal = err?.message || String(err);
  out.stack = err?.stack;
} finally {
  cleanupPaths.forEach((p) => { try { fs.rmSync(p, { force: true }); } catch { /* ไม่เป็นไร */ } });
}

console.log(JSON.stringify(out));
