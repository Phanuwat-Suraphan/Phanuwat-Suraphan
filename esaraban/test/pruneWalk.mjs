// เดินตัวเก็บกวาดสำเนาสำรองจริงๆ บน Google Drive จำลอง แล้วรายงานว่าอะไรรอดอะไรถูกลบ
//
// ทำไมต้องทดสอบทั้งเส้น ทั้งที่ planBackupCleanup/splitByCutoff มีเทสต์แบบฟังก์ชันบริสุทธิ์แล้ว:
// สองตัวนั้นคือ "การตัดสินใจ" ส่วนตัวที่ลบของจริงคือการเดินโฟลเดอร์ ปี → เดือน → วัน → ไฟล์
// ซึ่งถ้าเดินผิดชั้นหรือคิด cutoff ผิด จะลบสำเนาที่ยังต้องเก็บทิ้งไปโดยไม่มีอะไรฟ้อง และเรียกคืนไม่ได้
//
// รับจำนวนวันที่ขอเก็บทาง argv[2] (BACKUP_KEEP_DAYS)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFakeDrive } from './fakeDrive.js';

const keepDays = process.argv[2] || '3';
const keepRecent = process.argv[3] || '3';
const dbPath = path.join(os.tmpdir(), `esaraban-prune-${process.pid}-${Date.now()}.db`);

process.env.DB_PATH = dbPath;
process.env.STORAGE_PROVIDER = 'google_drive';
process.env.GOOGLE_OAUTH_CLIENT_ID = 'fake-client';
process.env.GOOGLE_OAUTH_CLIENT_SECRET = 'fake-secret';
process.env.GOOGLE_OAUTH_REFRESH_TOKEN = 'fake-refresh';
process.env.SESSION_SECRET = 'prune-test-secret';
process.env.BACKUP_KEEP_DAYS = keepDays;
process.env.BACKUP_KEEP_RECENT = keepRecent;
delete process.env.TEST_MODE_PASSWORD;

const out = { keepDays: Number(keepDays), keepRecent: Number(keepRecent) };

try {
  const drive = createFakeDrive();
  const { _setDriveFetchForTest, ensureBackupFolder, ensureFolderPath, uploadFile } =
    await import('../src/services/googleDrive.js');
  _setDriveFetchForTest(drive.fetch);

  const backupMod = await import('../src/services/dbBackup.js');
  const today = backupMod.thaiDateParts().day;

  // ฐานข้อมูลจริงเล็กๆ ไว้ให้ backupNow มีอะไรสำรอง
  await import('../src/db.js');

  // วางสำเนาย้อนหลังหลายวัน ข้ามเดือน/ข้ามปี วันละหลายชุด
  const root = await ensureBackupFolder();
  const days = [today, ...[1, 2, 3, 5, 40, 400].map((n) => backupMod.shiftThaiDay(today, -n))];
  for (const day of days) {
    const folder = await ensureFolderPath(root, [day.slice(0, 4), day.slice(0, 7), day]);
    for (const t of ['0800', '1200', '1600', '2000']) {
      await uploadFile({
        buffer: Buffer.from(`สำเนาของ ${day} เวลา ${t}`),
        filename: `esaraban-${t}.db`, mimeType: 'application/x-sqlite3', folderId: folder,
      });
    }
  }

  const snapshot = () => {
    const all = drive.backupFiles();
    const byDay = {};
    for (const f of all) {
      // หาโฟลเดอร์วันของไฟล์นี้จาก parents
      const parent = f.parents?.[0];
      byDay[parent] = (byDay[parent] || 0) + 1;
    }
    return { total: all.length, folders: drive.folderNames().slice().sort() };
  };

  out.daysPlaced = days;
  out.before = snapshot();

  // สำรองหนึ่งครั้ง — backupNow จะเรียกตัวเก็บกวาดต่อท้ายให้เอง (เส้นทางจริงทุกประการ)
  out.backupOk = await backupMod.backupNow('ทดสอบตัวเก็บกวาด');
  // ให้ตัวเก็บกวาดที่ทำงานแบบไม่รอผล (fire-and-forget) เดินจนจบ
  await new Promise((r) => setTimeout(r, 400));

  out.after = snapshot();
  out.foldersGone = out.before.folders.filter((f) => !out.after.folders.includes(f));
  out.foldersKept = out.after.folders;
} catch (err) {
  out.fatal = err?.message || String(err);
  out.stack = err?.stack;
} finally {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try { fs.rmSync(p, { force: true }); } catch { /* ไม่เป็นไร */ }
  }
}

console.log(JSON.stringify(out));
