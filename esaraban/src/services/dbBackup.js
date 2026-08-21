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
const BACKUP_PREFIX = 'esaraban-';

// เก็บสำเนาแบบ 2 ชั้น:
//   ชั้นที่ 1 — สำเนาล่าสุดไม่กี่ชุด กันกรณีเซิร์ฟเวอร์ดับกะทันหัน (ย้อนกลับไปไม่กี่นาทีที่แล้ว)
//   ชั้นที่ 2 — วันละ 1 ชุด (ชุดสุดท้ายของวันนั้น) ย้อนหลังได้เป็นเดือน
// ถ้าเก็บแบบ "20 ชุดล่าสุด" อย่างเดียว จะย้อนหลังได้แค่ราวชั่วโมงเดียว (เพราะสำรองทุก 5 นาที) —
// ซึ่งไม่พอเลยกับกรณีที่ธุรการเพิ่งมารู้ตัววันรุ่งขึ้นว่าลบผิด/แก้ผิด แล้วอยากได้ข้อมูลของเมื่อวานคืน
const KEEP_RECENT = Math.max(3, Number(process.env.BACKUP_KEEP_RECENT) || 12);
const KEEP_DAILY_DAYS = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 90);

// ชื่อไฟล์อิงวันเวลาไทย เรียงตามตัวอักษรแล้วได้ลำดับเวลาพอดี และธุรการอ่านออกเองว่าเป็นสำเนาของวันไหน
// เช่น esaraban-2026-08-21-1530.db
function backupFilename(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, p) => ({ ...acc, [p.type]: p.value }), {});
  return `${BACKUP_PREFIX}${parts.year}-${parts.month}-${parts.day}-${parts.hour}${parts.minute}.db`;
}

// วันที่ (ตามเวลาไทย) ของสำเนาหนึ่งชุด — อ่านจากชื่อไฟล์ก่อน ถ้าเป็นชื่อรูปแบบเก่าค่อยใช้เวลาที่ Drive บันทึกไว้
function backupDay(file) {
  const fromName = file.name?.match(/^esaraban-(\d{4}-\d{2}-\d{2})/);
  if (fromName) return fromName[1];
  if (file.createdTime) return new Date(file.createdTime).toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
  return null;
}

/**
 * เลือกว่าสำเนาชุดไหนต้องลบทิ้ง — แยกออกมาเป็นฟังก์ชันล้วนๆ เพื่อทดสอบได้โดยไม่ต้องต่อ Google Drive
 * @param files รายการไฟล์เรียงใหม่สุดก่อน (ตามที่ listFilesInFolder คืนมา)
 */
export function selectBackupsToDelete(files, { keepRecent = KEEP_RECENT, keepDailyDays = KEEP_DAILY_DAYS } = {}) {
  const keep = new Set();
  files.slice(0, keepRecent).forEach((f) => keep.add(f.id));

  const daysKept = new Set();
  for (const f of files) {
    const day = backupDay(f);
    if (!day) { keep.add(f.id); continue; } // อ่านวันไม่ออก อย่าเสี่ยงลบทิ้ง
    if (daysKept.has(day)) continue;
    if (daysKept.size >= keepDailyDays) break;
    daysKept.add(day);
    keep.add(f.id); // ไฟล์แรกที่เจอของวันนั้น = ชุดล่าสุดของวันนั้น (เพราะเรียงใหม่สุดมาก่อน)
  }
  return files.filter((f) => !keep.has(f.id));
}

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

// สถานะการสำรองล่าสุด — ใช้ขึ้นแถบเตือนในหน้าเว็บ ไม่ใช่แค่บรรทัดใน log ที่ไม่มีใครเปิดดู
// (กรณีที่ต้องกันให้ได้: token ของ Google หมดอายุแล้วการสำรองหยุดเงียบๆ กว่าจะรู้ก็ตอนข้อมูลหายไปแล้ว)
const status = { lastOkAt: null, lastError: null, lastAttemptAt: null };

/**
 * สถานะการสำรองข้อมูลสำหรับแสดงในหน้าเว็บ
 * ok = ปกติ, warn = เปิดใช้แล้วแต่ยังสำรองไม่สำเร็จสักครั้ง/ล่าสุดล้มเหลว, off = ยังไม่ได้เปิดใช้
 */
export function getBackupStatus() {
  if (!isBackupEnabled()) return { state: 'off', ...status };
  // ให้เวลาตั้งตัวหนึ่งรอบหลังเพิ่งเปิดเซิร์ฟเวอร์ ยังไม่ต้องเตือนทันที
  const staleAfterMs = BACKUP_INTERVAL_MS * 3;
  if (status.lastError && (!status.lastOkAt || status.lastError.at > status.lastOkAt)) {
    return { state: 'warn', ...status };
  }
  if (status.lastOkAt && Date.now() - status.lastOkAt > staleAfterMs) return { state: 'warn', ...status };
  return { state: status.lastOkAt ? 'ok' : 'pending', ...status };
}

let backingUp = false;
/** สำรองฐานข้อมูลขึ้น Drive หนึ่งครั้ง — คืน true ถ้าสำรองจริง, false ถ้าข้าม (ยังไม่ได้เปิดใช้/กำลังทำอยู่) */
export async function backupNow(reason = 'manual') {
  if (!isBackupEnabled() || backingUp) return false;
  backingUp = true;
  status.lastAttemptAt = Date.now();
  try {
    const buffer = await snapshotBuffer();
    const folderId = await ensureBackupFolder();
    await uploadFile({ buffer, filename: backupFilename(), mimeType: 'application/x-sqlite3', folderId });
    log(`สำรองข้อมูลขึ้น Google Drive แล้ว (${reason}, ${(buffer.length / 1048576).toFixed(2)} MB)`);
    status.lastOkAt = Date.now();
    status.lastError = null;
    await pruneOldBackups(folderId);
    return true;
  } catch (err) {
    // สำรองไม่สำเร็จต้องไม่ทำให้ระบบล่ม — ผู้ใช้ยังต้องทำงานต่อได้ แต่ต้องเห็นชัดว่ากำลังไม่ถูกสำรอง
    log(`สำรองข้อมูลไม่สำเร็จ (${reason}): ${err.message}`);
    status.lastError = { message: err.message, at: Date.now() };
    return false;
  } finally {
    backingUp = false;
  }
}

async function pruneOldBackups(folderId) {
  // ต้องดึงมาให้พอครอบคลุมทั้งชุดล่าสุดและชุดรายวันย้อนหลัง ไม่งั้นไฟล์ที่อยู่นอกหน้าแรกจะไม่ถูกพิจารณา
  // แล้วค้างสะสมอยู่บน Drive ไปเรื่อยๆ โดยไม่มีใครรู้
  const limit = Math.min(1000, (KEEP_RECENT + KEEP_DAILY_DAYS) * 3);
  const files = (await listFilesInFolder(folderId, { limit })).filter((f) => f.name.startsWith(BACKUP_PREFIX));
  for (const old of selectBackupsToDelete(files)) {
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

  // สำรองรอบแรกหลังเปิดเซิร์ฟเวอร์ไม่นาน เพื่อให้รู้เร็วว่าการเชื่อมต่อ Drive ใช้ได้จริงไหม —
  // ไม่ต้องรอครบรอบแรกของ interval ถึงจะเห็นว่า token ใช้ไม่ได้แล้ว
  const first = setTimeout(() => { backupNow('รอบแรกหลังเปิดระบบ'); }, 30_000);
  first.unref();

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
