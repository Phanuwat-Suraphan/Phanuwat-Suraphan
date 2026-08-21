// สำรอง/กู้คืนฐานข้อมูลขึ้น Google Drive
//
// ทำไมต้องมี: โฮสต์ฟรีทุกเจ้า (Render, Koyeb, Hugging Face Spaces ฯลฯ) ใช้ดิสก์แบบชั่วคราว —
// ทุกครั้งที่ deploy โค้ดใหม่ หรือเซิร์ฟเวอร์หลับแล้วตื่น ดิสก์จะถูกล้างใหม่หมด ทะเบียนหนังสือทั้งเล่ม
// จึงหายกลายเป็นเว็บเปล่าทุกครั้ง การเปลี่ยนโฮสต์ฟรีไปเจ้าอื่นไม่ได้แก้ปัญหานี้ เพราะเป็นเหมือนกันหมด
// (โฮสต์ที่มีดิสก์ถาวรล้วนต้องผูกบัตรเครดิต) ทางออกคือเก็บข้อมูลไว้นอกเซิร์ฟเวอร์ — ไฟล์แนบเก็บบน
// Google Drive อยู่แล้ว (ดู googleDrive.js) ไฟล์นี้เติมส่วนที่ขาดคือตัวฐานข้อมูล
//
// วิธีทำงาน:
//   ตอนเปิดระบบ  — ถ้าไม่มีไฟล์ฐานข้อมูลในเครื่อง (แปลว่าเพิ่งถูกล้าง) ให้ดาวน์โหลดสำเนาล่าสุดจาก Drive มาใช้
//   ระหว่างใช้งาน — สำรองขึ้น Drive ทุก BACKUP_INTERVAL_MS และตอนเซิร์ฟเวอร์กำลังจะปิด (SIGTERM)
//
// ข้อจำกัดที่ต้องรู้: ข้อมูลที่บันทึกหลังสำเนาล่าสุดจะหายถ้าเซิร์ฟเวอร์ถูกล้างกะทันหันโดยไม่ทันสำรอง
// (อย่างมากเท่ากับช่วงห่างของการสำรอง) — ถ้าโรงเรียนรับความเสี่ยงนี้ไม่ได้ ต้องใช้โฮสต์ที่มีดิสก์ถาวรจริง
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import {
  isGoogleDriveEnabled, isGoogleDriveConnected, ensureBackupFolder,
  listFilesInFolder, uploadFile, downloadFileStream, deleteFile,
} from './googleDrive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'esaraban.db');

// ค่าเริ่มต้น 5 นาที — Render free tier หลับหลังไม่มีคนใช้ราว 15 นาที ช่วงนี้จึงกันข้อมูลหายได้พอสมควร
// โดยไม่ยิงขึ้น Drive ถี่จนเปลืองโควตา ปรับได้ด้วย env var BACKUP_INTERVAL_MINUTES
const BACKUP_INTERVAL_MS = Math.max(1, Number(process.env.BACKUP_INTERVAL_MINUTES) || 5) * 60_000;
const KEEP_BACKUPS = Math.max(3, Number(process.env.BACKUP_KEEP) || 20);
const BACKUP_PREFIX = 'esaraban-';

export function isBackupEnabled() {
  return isGoogleDriveEnabled() && isGoogleDriveConnected();
}

function log(msg) {
  console.log(`[db-backup] ${msg}`);
}

/**
 * สร้างสำเนาฐานข้อมูลแบบสอดคล้องกันทั้งไฟล์
 *
 * ห้ามคัดลอกไฟล์ .db ตรงๆ — ระบบเปิดโหมด WAL ไว้ ข้อมูลที่เพิ่งเขียนอาจยังอยู่ในไฟล์ -wal ที่ยังไม่ถูก
 * รวมเข้าไฟล์หลัก สำเนาที่ได้จะขาดข้อมูลช่วงท้ายหรือเสียหายไปเลย — VACUUM INTO ให้ SQLite เขียนไฟล์
 * ใหม่ที่สมบูรณ์ในตัวเองจากภาพ ณ ขณะนั้น (และบีบขนาดให้เล็กลงด้วย) โดยไม่ต้องหยุดรับงาน
 */
async function snapshotBuffer() {
  const { db } = await import('../db.js'); // import ตอนใช้จริง ไม่ใช่ตอนโหลดไฟล์ เพราะตอนกู้คืนยังห้ามเปิดฐานข้อมูล
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'esaraban-backup-'));
  const snapPath = path.join(tmpDir, 'snapshot.db');
  try {
    db.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
    return fs.readFileSync(snapPath);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

let backingUp = false;
/** สำรองฐานข้อมูลขึ้น Drive หนึ่งครั้ง — คืน true ถ้าสำรองจริง, false ถ้าข้าม (ยังไม่ได้เปิดใช้/กำลังทำอยู่) */
export async function backupNow(reason = 'manual') {
  if (!isBackupEnabled() || backingUp) return false;
  backingUp = true;
  try {
    const buffer = await snapshotBuffer();
    const folderId = await ensureBackupFolder();
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await uploadFile({ buffer, filename: `${BACKUP_PREFIX}${stamp}.db`, mimeType: 'application/x-sqlite3', folderId });
    log(`สำรองข้อมูลขึ้น Google Drive แล้ว (${reason}, ${(buffer.length / 1048576).toFixed(2)} MB)`);
    await pruneOldBackups(folderId);
    return true;
  } catch (err) {
    // สำรองไม่สำเร็จต้องไม่ทำให้ระบบล่ม — ผู้ใช้ยังต้องทำงานต่อได้ แค่บันทึกไว้ให้เห็นใน log
    log(`สำรองข้อมูลไม่สำเร็จ (${reason}): ${err.message}`);
    return false;
  } finally {
    backingUp = false;
  }
}

async function pruneOldBackups(folderId) {
  const files = (await listFilesInFolder(folderId)).filter((f) => f.name.startsWith(BACKUP_PREFIX));
  for (const old of files.slice(KEEP_BACKUPS)) {
    try {
      await deleteFile(old.id);
    } catch (err) {
      log(`ลบสำเนาเก่า ${old.name} ไม่สำเร็จ: ${err.message}`);
    }
  }
}

/**
 * กู้คืนฐานข้อมูลจากสำเนาล่าสุดบน Drive — เรียก "ก่อน" โหลด src/db.js เท่านั้น
 *
 * ทำงานเฉพาะเมื่อยังไม่มีไฟล์ฐานข้อมูลในเครื่อง เพื่อไม่ให้ไปทับข้อมูลที่ใช้งานอยู่จริง (เช่นบนเครื่อง
 * ที่มีดิสก์ถาวร ซึ่งไฟล์ยังอยู่ครบ) — ถ้าไม่มีสำเนาบน Drive เลยก็ปล่อยให้ db.js สร้างฐานข้อมูลใหม่ตามปกติ
 */
export async function restoreDatabaseIfMissing() {
  if (!isBackupEnabled()) return false;
  if (fs.existsSync(DB_PATH)) return false;

  try {
    const folderId = await ensureBackupFolder();
    const files = (await listFilesInFolder(folderId)).filter((f) => f.name.startsWith(BACKUP_PREFIX));
    if (!files.length) {
      log('ไม่พบสำเนาฐานข้อมูลบน Google Drive — เริ่มต้นด้วยฐานข้อมูลใหม่');
      return false;
    }
    const stream = await downloadFileStream(files[0].id); // listFilesInFolder เรียงใหม่สุดไว้ก่อนแล้ว
    if (!stream) {
      log('เปิดสำเนาล่าสุดบน Google Drive ไม่ได้ — เริ่มต้นด้วยฐานข้อมูลใหม่');
      return false;
    }
    const chunks = [];
    for await (const chunk of Readable.fromWeb(stream)) chunks.push(chunk);

    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    // เขียนลงไฟล์ชั่วคราวก่อนแล้วค่อย rename — ถ้าดาวน์โหลดขาดกลางคัน จะไม่เหลือไฟล์ฐานข้อมูลพังๆ ไว้
    const tmp = `${DB_PATH}.restoring`;
    fs.writeFileSync(tmp, Buffer.concat(chunks));
    fs.renameSync(tmp, DB_PATH);
    log(`กู้คืนฐานข้อมูลจากสำเนา ${files[0].name} เรียบร้อย`);
    return true;
  } catch (err) {
    // กู้คืนไม่สำเร็จต้องไม่ทำให้เปิดระบบไม่ได้ — ให้เริ่มด้วยฐานข้อมูลใหม่แล้วบันทึกไว้ใน log
    log(`กู้คืนฐานข้อมูลไม่สำเร็จ: ${err.message} — เริ่มต้นด้วยฐานข้อมูลใหม่`);
    return false;
  }
}

/** ตั้งเวลาสำรองอัตโนมัติ + สำรองอีกครั้งตอนเซิร์ฟเวอร์กำลังจะปิด (deploy ใหม่/สั่งหยุด) */
export function startAutoBackup() {
  if (!isBackupEnabled()) {
    log('ยังไม่ได้เปิดใช้การสำรองขึ้น Google Drive (ต้องตั้ง STORAGE_PROVIDER=google_drive และเชื่อมต่อบัญชีที่ /admin/google-drive)');
    return;
  }
  const timer = setInterval(() => { backupNow('ตามเวลา'); }, BACKUP_INTERVAL_MS);
  timer.unref(); // อย่าให้ timer ค้างจนโปรเซสปิดตัวไม่ได้
  log(`เปิดการสำรองอัตโนมัติทุก ${BACKUP_INTERVAL_MS / 60000} นาที`);

  // Render/systemd ส่ง SIGTERM ก่อนปิดเสมอ — สำรองรอบสุดท้ายตรงนี้กันข้อมูลช่วงท้ายหาย
  let closing = false;
  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, async () => {
      if (closing) return;
      closing = true;
      log(`ได้รับสัญญาณ ${sig} — สำรองข้อมูลรอบสุดท้ายก่อนปิด`);
      await backupNow('ก่อนปิดเซิร์ฟเวอร์');
      process.exit(0);
    });
  }
}
