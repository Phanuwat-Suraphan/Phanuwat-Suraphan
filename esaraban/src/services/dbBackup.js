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
  isGoogleDriveEnabled, isGoogleDriveConnected, ensureBackupFolder, ensureFolderPath, listSubfolders,
  listFilesInFolder, uploadFile, downloadFileStream, deleteFile,
} from './googleDrive.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'esaraban.db');

// ค่าเริ่มต้น 5 นาที — Render free tier หลับหลังไม่มีคนใช้ราว 15 นาที ช่วงนี้จึงกันข้อมูลหายได้พอสมควร
// โดยไม่ยิงขึ้น Drive ถี่จนเปลืองโควตา ปรับได้ด้วย env var BACKUP_INTERVAL_MINUTES
const BACKUP_INTERVAL_MS = Math.max(1, Number(process.env.BACKUP_INTERVAL_MINUTES) || 5) * 60_000;
const BACKUP_PREFIX = 'esaraban-';

// เก็บสำเนาแบบ 2 ชั้น:
//   วันปัจจุบัน — เก็บหลายชุด (ทุกรอบที่สำรอง) กันกรณีเซิร์ฟเวอร์ดับกะทันหัน ย้อนกลับได้ไม่กี่นาที
//   วันก่อนๆ  — เก็บวันละ 1 ชุด (ชุดสุดท้ายของวันนั้น) ย้อนหลังได้ 1 ปี
//
// ทำไมวันเก่าต้องเหลือวันละชุด: ถ้าเก็บทุกชุดที่สำรองทุก 5 นาทีตลอดปี จะเป็นแสนไฟล์ ~51GB
// ซึ่งเกินโควตาฟรี 15GB ของบัญชี Google ไปสามเท่า — เก็บวันละชุดใช้แค่ราว 0.2GB
const KEEP_RECENT = Math.max(3, Number(process.env.BACKUP_KEEP_RECENT) || 12);
const KEEP_DAILY_DAYS = Math.max(1, Number(process.env.BACKUP_KEEP_DAYS) || 365);

/**
 * วัน/เดือน/ปี ตามปฏิทินไทย (พ.ศ.) ของจุดเวลาหนึ่ง — ใช้ตั้งชื่อโฟลเดอร์และไฟล์
 * ใช้ พ.ศ. เพราะธุรการต้องเปิดหาเองใน Google Drive ได้โดยไม่ต้องแปลงปีในหัว
 * รูปแบบ 2569-08-21 เรียงตามตัวอักษรแล้วได้ลำดับเวลาพอดี
 */
export function thaiDateParts(date = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(date).reduce((acc, x) => ({ ...acc, [x.type]: x.value }), {});
  const year = String(Number(p.year) + 543); // ค.ศ. -> พ.ศ.
  return { year, month: `${year}-${p.month}`, day: `${year}-${p.month}-${p.day}`, time: `${p.hour}${p.minute}` };
}

// ชื่อไฟล์: เวลาไทยของวันนั้น เช่น esaraban-1530.db (วันอยู่ที่ชื่อโฟลเดอร์แล้ว ไม่ต้องซ้ำในชื่อไฟล์)
function backupFilename(date = new Date()) {
  return `${BACKUP_PREFIX}${thaiDateParts(date).time}.db`;
}

/**
 * วางแผนว่าจะลบอะไรบ้าง — แยกเป็นฟังก์ชันล้วนๆ เพื่อทดสอบได้โดยไม่ต้องต่อ Google Drive
 * (ลบสำเนาสำรองผิดพลาดแล้วเรียกคืนไม่ได้ ตรรกะตรงนี้จึงต้องมีเทสต์คุมแน่นๆ)
 *
 * @param dayFolders รายการโฟลเดอร์รายวัน เรียงใหม่ไปเก่า: [{ id, name: '2569-08-21', files: [{id,name}] }]
 *                   files ในแต่ละวันเรียงใหม่ไปเก่าเช่นกัน
 * @param today      ชื่อโฟลเดอร์ของวันนี้ (ไม่ต้องลดเหลือชุดเดียว เพราะยังเขียนเพิ่มอยู่)
 */
export function planBackupCleanup(dayFolders, { today, keepRecent = KEEP_RECENT, keepDailyDays = KEEP_DAILY_DAYS } = {}) {
  const deleteFolderIds = [];
  const deleteFileIds = [];

  dayFolders.forEach((folder, index) => {
    // เกินจำนวนวันที่ขอเก็บ — ลบทั้งโฟลเดอร์ของวันนั้น
    if (index >= keepDailyDays) { deleteFolderIds.push(folder.id); return; }
    const files = folder.files || [];
    // วันนี้ยังสำรองเพิ่มอยู่เรื่อยๆ จึงเก็บหลายชุด ส่วนวันที่ผ่านไปแล้วเหลือชุดสุดท้ายของวันพอ
    const keep = folder.name === today ? keepRecent : 1;
    files.slice(keep).forEach((f) => deleteFileIds.push(f.id));
  });

  return { deleteFolderIds, deleteFileIds };
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
    const root = await ensureBackupFolder();
    const at = thaiDateParts();
    // เก็บแยกเป็นโฟลเดอร์ ปี / เดือน / วัน เพื่อให้ธุรการเปิดหาสำเนาของวันที่ต้องการเองได้ใน Drive
    // และเพื่อให้ลบทั้งวัน/ทั้งเดือน/ทั้งปีได้ในคลิกเดียวจากหน้าจัดการสำเนาสำรอง
    const dayFolder = await ensureFolderPath(root, [at.year, at.month, at.day]);
    await uploadFile({ buffer, filename: backupFilename(), mimeType: 'application/x-sqlite3', folderId: dayFolder });
    log(`สำรองข้อมูลขึ้น Google Drive แล้ว (${reason}, ${(buffer.length / 1048576).toFixed(2)} MB) → ${at.day}`);
    status.lastOkAt = Date.now();
    status.lastError = null;
    await pruneOldBackups(root, at.day);
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

/** อ่านโครงสร้างสำเนาสำรองทั้งหมดจาก Drive: ปี → เดือน → วัน → ไฟล์ (เรียงใหม่ไปเก่าทุกชั้น) */
export async function readBackupTree() {
  const root = await ensureBackupFolder();
  const years = [];
  for (const year of await listSubfolders(root)) {
    const months = [];
    for (const month of await listSubfolders(year.id)) {
      const days = [];
      for (const day of await listSubfolders(month.id)) {
        const files = (await listFilesInFolder(day.id, { limit: 1000 }))
          .filter((f) => f.name.startsWith(BACKUP_PREFIX))
          .sort((a, b) => b.name.localeCompare(a.name));
        days.push({ ...day, files });
      }
      months.push({ ...month, days });
    }
    years.push({ ...year, months });
  }
  return years;
}

/** โฟลเดอร์รายวันทั้งหมด เรียงใหม่ไปเก่า — ใช้ทั้งตอนตัดของเก่าทิ้งและตอนหาสำเนาล่าสุดเพื่อกู้คืน */
function flattenDays(years) {
  return years.flatMap((y) => y.months.flatMap((m) => m.days))
    .sort((a, b) => b.name.localeCompare(a.name));
}

async function pruneOldBackups(root, today) {
  const days = flattenDays(await readBackupTree());
  const { deleteFolderIds, deleteFileIds } = planBackupCleanup(days, { today });
  for (const id of [...deleteFileIds, ...deleteFolderIds]) {
    try {
      await deleteFile(id); // Drive มองโฟลเดอร์เป็นไฟล์ชนิดหนึ่ง ลบด้วยคำสั่งเดียวกันและลบของข้างในตามไปด้วย
    } catch (err) {
      log(`ลบสำเนาเก่าไม่สำเร็จ (${id}): ${err.message}`);
    }
  }
  // เก็บกวาดโฟลเดอร์เดือน/ปีที่ไม่เหลืออะไรข้างในแล้ว ไม่ให้รกสะสมไปเรื่อยๆ
  for (const year of await listSubfolders(root)) {
    for (const month of await listSubfolders(year.id)) {
      if (!(await listSubfolders(month.id)).length) await deleteFile(month.id).catch(() => {});
    }
    if (!(await listSubfolders(year.id)).length) await deleteFile(year.id).catch(() => {});
  }
}

/**
 * ลบสำเนาสำรองตามที่ผู้ใช้เลือก — ทีละไฟล์ ทั้งวัน ทั้งเดือน หรือทั้งปี
 * รับเป็น Drive file/folder id ตรงๆ แต่ต้องยืนยันก่อนว่า id นั้นอยู่ใต้โฟลเดอร์สำเนาสำรองจริง
 * ไม่งั้นใครที่ยิงคำขอเองจะสั่งลบไฟล์อะไรก็ได้ในบัญชี Drive ที่แอปสร้างไว้ รวมถึงไฟล์แนบหนังสือ
 */
export async function deleteBackupNode(nodeId) {
  if (!isBackupEnabled()) throw new Error('ยังไม่ได้เปิดใช้การสำรองขึ้น Google Drive');
  const years = await readBackupTree();
  const allowed = new Set();
  for (const y of years) {
    allowed.add(y.id);
    for (const m of y.months) {
      allowed.add(m.id);
      for (const d of m.days) {
        allowed.add(d.id);
        d.files.forEach((f) => allowed.add(f.id));
      }
    }
  }
  if (!allowed.has(nodeId)) throw new Error('ไม่พบรายการสำเนาสำรองนี้');
  await deleteFile(nodeId);
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
    // ไล่จากโฟลเดอร์วันล่าสุดลงไป — วันล่าสุดอาจมีแต่โฟลเดอร์เปล่า (เช่นลบไฟล์ทิ้งไปเอง) จึงต้องหาต่อ
    const days = flattenDays(await readBackupTree());
    const latest = days.find((d) => d.files.length)?.files[0];
    if (!latest) {
      log('ไม่พบสำเนาฐานข้อมูลบน Google Drive — เริ่มต้นด้วยฐานข้อมูลใหม่');
      return false;
    }
    const stream = await downloadFileStream(latest.id);
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
    log(`กู้คืนฐานข้อมูลจากสำเนา ${latest.name} เรียบร้อย`);
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
