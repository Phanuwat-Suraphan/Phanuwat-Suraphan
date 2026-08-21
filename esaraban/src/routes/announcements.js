import { router, html, json, contentDispositionHeader } from '../router.js';
import { layout, esc, fmtDate, emptyState } from '../render.js';
import { requirePage, requireApi, requireRole } from '../middleware.js';
import { db, uuid, nowIso, beYear, audit } from '../db.js';
import { isGoogleDriveEnabled, ensureCategoryFolder, uploadFile, downloadFileStream, deleteFile as deleteDriveFile } from '../services/googleDrive.js';
import { Readable } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ALLOWED_MIME = new Set(['application/pdf']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const CATEGORIES = ['ประกาศ', 'ประชาสัมพันธ์'];

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

router.get('/announcements', requirePage((ctx) => {
  const isAdmin = ctx.user.roleCodes.includes('admin');
  const rows = db.prepare(`
    SELECT a.*, u.first_name, u.last_name FROM announcements a JOIN users u ON u.id = a.created_by
    WHERE a.deleted_at IS NULL ORDER BY a.created_at DESC
  `).all();
  const grouped = CATEGORIES.map((cat) => ({ cat, items: rows.filter((r) => r.category === cat) }));

  const content = `
    <div class="card-header">
      <h2 class="mt-0">📢 ประกาศ/ประชาสัมพันธ์</h2>
      ${isAdmin ? `<a class="btn btn-primary btn-sm" href="/announcements/new">+ เพิ่มประกาศ</a>` : ''}
    </div>
    <div class="grid-2">
      ${grouped.map(({ cat, items }) => `
        <div class="card">
          <h3 class="mt-0">${cat === 'ประกาศ' ? '📣' : '📌'} ${esc(cat)}ล่าสุด</h3>
          ${items.length ? items.map((a) => `
            <div style="padding:.6rem 0;border-bottom:1px solid var(--border)">
              <div class="flex items-center justify-between" style="gap:.5rem">
                <strong>${esc(a.title)}</strong>
                ${isAdmin ? `<button type="button" class="btn btn-sm btn-outline" onclick="deleteAnnouncement('${a.id}')" title="ลบ">🗑️</button>` : ''}
              </div>
              ${a.body ? `<p class="text-muted" style="font-size:.85rem;margin:.3rem 0">${esc(a.body)}</p>` : ''}
              <div class="text-muted" style="font-size:.78rem">
                ผู้ลงประกาศ ${esc(a.first_name)} ${esc(a.last_name)} · วันที่ ${fmtDate(a.created_at)}
                ${a.file_name ? ` · <a href="/announcement-files/${a.id}" target="_blank" rel="noopener">📄 ${esc(a.file_name)}</a>` : ''}
              </div>
            </div>`).join('') : emptyState('📭', `ยังไม่มี${cat}`)}
        </div>`).join('')}
    </div>
    ${isAdmin ? `<script>
      window.deleteAnnouncement = function(id){
        if (!confirm('ยืนยันลบประกาศนี้?')) return;
        fetch('/announcements/' + id + '/delete', {method:'POST'})
          .then(r => r.json().then(d => ({ok:r.ok,d})))
          .then(({ok,d}) => { if(!ok) throw new Error(d.error); location.reload(); })
          .catch(e => toast(e.message, 'danger'));
      };
    </script>` : ''}`;
  html(ctx, 200, layout({ user: ctx.user, title: 'ประกาศ/ประชาสัมพันธ์', path: '/announcements', content }));
}));

router.get('/announcements/new', requireRole('admin')(requirePage((ctx) => {
  const content = `
    <h2>📢 เพิ่มประกาศ/ประชาสัมพันธ์</h2>
    <div class="card">
      <form id="annForm" class="stack">
        <div class="field">
          <label>ประเภท *</label>
          <select name="category">${CATEGORIES.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')}</select>
        </div>
        <div class="field"><label>หัวข้อ *</label><input type="text" name="title" required /></div>
        <div class="field"><label>รายละเอียด</label><textarea name="body" placeholder="รายละเอียดประกาศ (ถ้ามี)"></textarea></div>
        <div class="field">
          <label>แนบไฟล์ PDF (ถ้ามี)</label>
          <input type="file" id="fileInput" accept="application/pdf" onchange="attachFilePreview(this,'filePreview')" />
          <div id="filePreview" class="help-text"></div>
          <div class="help-text">รองรับเฉพาะไฟล์ PDF ขนาดไม่เกิน 10MB</div>
        </div>
        <button class="btn btn-primary" type="submit">บันทึกประกาศ</button>
        <a class="btn btn-outline" href="/announcements">ยกเลิก</a>
      </form>
    </div>
    <script>
      document.getElementById('annForm').addEventListener('submit', function(e){
        e.preventDefault();
        submitWithFile(this, 'fileInput', '/announcements', { submitLabel: 'บันทึก' });
      });
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'เพิ่มประกาศ', path: '/announcements/new', content }));
})));

router.post('/announcements', requireRole('admin')(requireApi(async (ctx) => {
  const b = ctx.body;
  if (!b.category || !CATEGORIES.includes(b.category)) throw httpError(400, 'กรุณาเลือกประเภทให้ถูกต้อง');
  if (!b.title?.trim()) throw httpError(400, 'กรุณากรอกหัวข้อ');

  let fileFields = {};
  if (b.fileDataBase64) {
    if (!ALLOWED_MIME.has(b.fileType)) throw httpError(400, 'อนุญาตเฉพาะไฟล์ PDF เท่านั้น');
    const buf = Buffer.from(b.fileDataBase64, 'base64');
    if (buf.length > MAX_FILE_BYTES) throw httpError(413, 'ไฟล์มีขนาดใหญ่เกิน 10MB');
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'ไฟล์ไม่ใช่ PDF ที่ถูกต้อง (ตรวจสอบ file signature ไม่ผ่าน)');

    const id = uuid();
    if (isGoogleDriveEnabled()) {
      const folderId = await ensureCategoryFolder({ yearBe: beYear(), typeName: 'ประกาศ-ประชาสัมพันธ์' });
      const driveFileId = await uploadFile({ buffer: buf, filename: `${id}__${b.fileName || 'announcement.pdf'}`, mimeType: b.fileType, folderId });
      fileFields = { file_storage_provider: 'google_drive', file_drive_id: driveFileId, file_path: null };
    } else {
      const safeName = `${id}.pdf`;
      fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buf);
      fileFields = { file_storage_provider: 'local', file_path: safeName, file_drive_id: null };
    }
    fileFields.file_name = b.fileName || 'announcement.pdf';
    fileFields.file_size = buf.length;
    fileFields.file_mime = b.fileType;
  }

  const id = uuid();
  const now = nowIso();
  db.prepare(`
    INSERT INTO announcements (id, category, title, body, file_storage_provider, file_path, file_drive_id, file_name, file_size, file_mime, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, b.category, b.title.trim(), b.body?.trim() || null,
    fileFields.file_storage_provider || null, fileFields.file_path || null, fileFields.file_drive_id || null,
    fileFields.file_name || null, fileFields.file_size || null, fileFields.file_mime || null,
    ctx.user.id, now, now);
  audit({ userId: ctx.user.id, action: 'announcement_created', tableName: 'announcements', recordId: id, detail: { category: b.category, title: b.title } });
  json(ctx, 201, { redirect: '/announcements' });
})));

router.post('/announcements/:id/delete', requireRole('admin')(requireApi(async (ctx) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(ctx.params.id);
  if (!ann) throw httpError(404, 'ไม่พบประกาศนี้');
  if (ann.file_storage_provider === 'google_drive' && ann.file_drive_id) {
    await deleteDriveFile(ann.file_drive_id).catch(() => {}); // ลบเอกสารเมทาดาต้าต่อได้แม้ลบไฟล์บน Drive ไม่สำเร็จ
  } else if (ann.file_path) {
    const filePath = path.join(UPLOAD_DIR, ann.file_path);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
  db.prepare('UPDATE announcements SET deleted_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), ann.id);
  audit({ userId: ctx.user.id, action: 'announcement_deleted', tableName: 'announcements', recordId: ann.id });
  json(ctx, 200, { ok: true });
})));

// ---------------- file serving — เข้าถึงได้ทุกคนที่ login แล้ว (ประกาศเป็นของเปิดเผยทั้งโรงเรียนโดยธรรมชาติ) ----------------
router.get('/announcement-files/:id', requirePage(async (ctx) => {
  const ann = db.prepare('SELECT * FROM announcements WHERE id = ? AND deleted_at IS NULL').get(ctx.params.id);
  if (!ann || !ann.file_name) return html(ctx, 404, '<h1>ไม่พบไฟล์</h1>');

  if (ann.file_storage_provider === 'google_drive') {
    let stream;
    try {
      stream = await downloadFileStream(ann.file_drive_id);
    } catch (err) {
      return html(ctx, err.statusCode || 502, `<h1>เกิดข้อผิดพลาด</h1><p>${esc(err.message)}</p>`);
    }
    if (!stream) return html(ctx, 404, '<h1>ไม่พบไฟล์บน Google Drive</h1>');
    ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDispositionHeader(ann.file_name, 'announcement.pdf'), 'X-Content-Type-Options': 'nosniff' });
    Readable.fromWeb(stream).pipe(ctx.res);
    return;
  }

  const filePath = path.join(UPLOAD_DIR, ann.file_path);
  if (!fs.existsSync(filePath)) return html(ctx, 404, '<h1>ไม่พบไฟล์</h1>');
  ctx.res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': contentDispositionHeader(ann.file_name, 'announcement.pdf'), 'X-Content-Type-Options': 'nosniff' });
  fs.createReadStream(filePath).pipe(ctx.res);
}));
