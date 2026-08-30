import { router, html, json, redirect, contentDispositionHeader, truncateFilename } from '../router.js';
import { layout, esc, fmtDate, fmtThaiDateLong, fmtThaiDateShort, daysUntil, dueCell, stampDateThai, stampTimeThai, priorityBadge, secretBadge, statusBadge, emptyState, fmtCount, LABELS, SCHOOL_NAME } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, uuid, nowIso, audit, todayInBangkok, RETENTION_LABEL } from '../db.js';
import {
  createDocument, createDocumentsBulk, MAX_BULK_DOCUMENTS,
  getDocument, canUserSeeDocument, visibleDocumentsSqlFilter, getWorkflowSteps, currentStep,
  assignStep, approveAndForward, acknowledgeAndComplete, rejectStep, returnStep,
  voidDocument, archiveDocument, forceDeleteDocument, httpError, assertStepBelongsToDocument,
  isSignedStep, signerIdentity, inactiveStepHolder, reassignStuckStep,
} from '../services/workflow.js';
import { renderPdfFirstPageImage } from '../services/pdfPreview.js';
import { isGoogleDriveEnabled, ensureCategoryFolder, uploadFile, downloadFileStream, deleteFile } from '../services/googleDrive.js';
import {
  stampPdf, stampDirectorDecision, stampAcknowledgeMark, stampRegistrarComment,
  DECISION_MAX_TOP_PERCENT, DEFAULT_ACK_MARK_X_PERCENT, DEFAULT_DECISION_X_PERCENT, DEFAULT_REGISTRAR_X_PERCENT,
  ackSlotTopPercent, ACK_WORD_HEIGHT_PERCENT, ACK_ENTRY_HEIGHT_PERCENT, MAX_STAMP_TEXT,
} from '../services/pdfStamp.js';
import { assertMaxLength } from '../services/validate.js';
import { getActiveDelegateFor } from '../services/delegation.js';
import {
  buildDocumentQuery, countDocuments, listDocuments, describeFilters, listRegisterYears, CLOSED_STATUSES,
} from '../services/documentQuery.js';
import { buildXlsx } from '../services/xlsxWrite.js';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, '..', '..', 'uploads');
const ALLOWED_MIME = new Set(['application/pdf']);
const MAX_FILE_BYTES = 10 * 1024 * 1024;
// checkbox บนตราประทับความเห็นของ ผอ./ผู้รักษาการแทน — ถ้อยคำตรงกับตรายางจริงของโรงเรียน (ยืนยันจาก
// ภาพถ่ายตราจริงและจากผู้ใช้โดยตรง) เลือกได้หลายอันพร้อมกัน ไม่ผูกกับปุ่ม workflow ที่กดส่ง (ปุ่มนั้นแค่
// ปิด/ส่งต่อขั้นตอนเท่านั้น) ผู้ตัดสินใจติ๊กเองว่าอันไหนตรงกับความเห็นจริง
// fillable: ช่อง "แจ้งให้ .......... ทราบ" มีจุดไข่ปลาให้เติมชื่อผู้ที่ต้องแจ้งเองบนตรายางจริง
// ถ้อยคำบนตราประทับความเห็นของ ผอ. — รวมของตรายาง 2 แบบที่โรงเรียนใช้จริงเข้าด้วยกัน:
// แบบเก่ามี ทราบ / อนุญาต-ไม่อนุญาต / อนุมัติ-ไม่อนุมัติ / "เห็นควรให้..."
// แบบใหม่มี ทราบ / เก็บรวมเรื่อง / แจ้งคณะครูทราบ / แจ้งให้...ทราบ / ดำเนินการ
// จึงรวมเป็นชุดเดียวที่มีครบทั้งหมด แล้วให้ผู้เซ็นติ๊กเฉพาะอันที่ต้องการ (ติ๊กได้หลายอัน)
// อนุญาต/ไม่อนุญาต และ อนุมัติ/ไม่อนุมัติ จับคู่อยู่บรรทัดเดียวกันเหมือนตรายางจริง
const DECISION_MARK_OPTIONS = [
  { value: 'ทราบ', label: 'ทราบ' },
  { value: 'อนุญาต', label: 'อนุญาต', pairWith: 'ไม่อนุญาต' },
  { value: 'ไม่อนุญาต', label: 'ไม่อนุญาต', pairedInto: 'อนุญาต' },
  { value: 'อนุมัติ', label: 'อนุมัติ', pairWith: 'ไม่อนุมัติ' },
  { value: 'ไม่อนุมัติ', label: 'ไม่อนุมัติ', pairedInto: 'อนุมัติ' },
  { value: 'เก็บรวมเรื่อง', label: 'เก็บรวมเรื่อง' },
  { value: 'แจ้งคณะครูทราบ', label: 'แจ้งคณะครูทราบ' },
  { value: 'แจ้งให้ทราบ', label: 'แจ้งให้ ........ ทราบ', fillable: true },
  { value: 'ดำเนินการ', label: 'ดำเนินการ' },
];
const DECISION_MARK_VALUES = DECISION_MARK_OPTIONS.map((m) => m.value);

function listDeptOptions(selected) {
  return db.prepare('SELECT * FROM departments ORDER BY name').all()
    .map((d) => `<option value="${d.id}" ${d.id === selected ? 'selected' : ''}>${esc(d.name)}</option>`).join('');
}
// ประเภทเอกสารตัดออกจากฟอร์มแล้วตามคำขอ — เอกสารใหม่ทุกฉบับใช้ประเภทนี้เป็นค่าเริ่มต้นเดียวกันหมด
// (คอลัมน์/ตาราง document_types ยังอยู่เผื่ออนาคต แค่ไม่ให้ผู้ใช้เลือกเองแล้ว)
function defaultDocTypeId() {
  const row = db.prepare("SELECT id FROM document_types WHERE name = 'หนังสือภายนอก'").get()
    || db.prepare('SELECT id FROM document_types ORDER BY name LIMIT 1').get();
  if (!row) throw httpError(500, 'ไม่พบประเภทเอกสารเริ่มต้นในระบบ (ตาราง document_types ว่างเปล่า)');
  return row.id;
}
function listUserOptions(excludeId) {
  return db.prepare(`
    SELECT u.*, GROUP_CONCAT(r.name_th) as role_names FROM users u
    LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id
    WHERE u.deleted_at IS NULL AND u.status = 'active' GROUP BY u.id ORDER BY u.first_name
  `).all()
    .filter((u) => u.id !== excludeId)
    .map((u) => `<option value="${u.id}">${esc(u.prefix || '')}${esc(u.first_name)} ${esc(u.last_name)} — ${esc(u.role_names || u.position || '')}</option>`).join('');
}

// ---------------- list ----------------
// จำนวนต่อหน้าของทะเบียนหนังสือ — 50 พอดีกับการกวาดสายตาหาเลขที่ในหน้าเดียว และโหลดเร็วบนมือถือ
const PAGE_SIZE = 50;

// direction=all คือโหมดค้นหารวมจากแถบค้นหาด้านบนสุด ไม่ใช่ทะเบียนของทิศทางใดทิศทางหนึ่ง
const DIRECTION_TITLE = { incoming: '📥 หนังสือเข้า', outgoing: '📤 หนังสือออก', all: '🔎 ผลการค้นหา (หนังสือเข้าและออก)' };
const DIRECTION_NOUN = { incoming: 'หนังสือเข้า', outgoing: 'หนังสือออก', all: 'หนังสือ' };

router.get('/documents', requirePage((ctx) => {
  // เงื่อนไขค้นหา/กรอง/สิทธิ์ อยู่ที่ documentQuery.js ที่เดียว — หน้านี้ ไฟล์ Excel และหน้าพิมพ์ทะเบียน
  // ใช้ตัวเดียวกันหมด ไม่งั้นสามที่จะค่อยๆ เลื่อนจากกันจนกรองบนเว็บได้ 40 ฉบับ แต่ Excel ออกมา 63 ฉบับ
  const query = buildDocumentQuery(ctx.user, ctx.query);
  const { direction, q, statusFilter, f, params, whereSql, activeFilters, filtering } = query;

  const total = countDocuments(query);
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(totalPages, Math.max(1, Math.floor(Number(ctx.query.page) || 1)));
  const offset = (page - 1) * PAGE_SIZE;

  // ยังเรียก canUserSeeDocument ซ้ำอีกชั้น เผื่อเงื่อนไข SQL กับตัวตรวจรายฉบับเลื่อนจากกันในอนาคต
  // (มีเทสต์เทียบผลของทั้งสองไว้แล้ว แต่การเปิดเผยหนังสือลับเป็นความผิดพลาดที่ยอมเสี่ยงไม่ได้)
  const rows = listDocuments(query, { limit: PAGE_SIZE, offset }).filter((d) => canUserSeeDocument(ctx.user, d));

  // เรื่องที่ยังไม่ปิดถือว่ายัง "นับเวลาอยู่" — เรื่องที่ปิดแล้วไม่ต้องขึ้นเตือนว่าเลยกำหนดอีก
  const stillOpen = (d) => !CLOSED_STATUSES.includes(d.status);
  const overdueCount = rows.filter((d) => stillOpen(d) && daysUntil(d.due_date) < 0).length;

  const rowsHtml = rows.map((d) => {
    const n = stillOpen(d) ? daysUntil(d.due_date) : null;
    return `
    <tr onclick="location.href='/documents/${d.id}'" style="cursor:pointer${n !== null && n < 0 ? ';background:rgba(220,38,38,.06)' : ''}">
      <td style="white-space:nowrap"><strong style="color:var(--primary)">${esc(d.doc_number_display)}</strong></td>
      ${direction === 'all' ? `<td style="white-space:nowrap">${d.direction === 'incoming' ? '📥 เข้า' : '📤 ออก'}</td>` : ''}
      <td class="wrap">${esc(d.title)}${d.secret_level !== 'normal' ? ' 🔒' : ''}</td>
      <td>${esc(d.dept_name)}</td>
      <td>${priorityBadge(d.priority)}</td>
      <td>${statusBadge(d.status)}</td>
      <td style="white-space:nowrap">${d.due_date ? (n === null ? esc(fmtThaiDateShort(d.due_date)) : dueCell(d.due_date)) : '<span class="text-muted">—</span>'}</td>
      <td class="text-muted" style="white-space:nowrap">${fmtDate(d.created_at)}</td>
    </tr>`;
  }).join('');

  // แถบเลื่อนหน้า — ทะเบียนหนังสือของโรงเรียนหนึ่งปีมีหลายร้อยถึงหลักพันฉบับ ถ้าไม่มีตรงนี้ ฉบับที่เก่ากว่า
  // หน้าแรกจะเปิดดูไม่ได้เลยนอกจากจะรู้คำค้นล่วงหน้า ซึ่งขัดกับการใช้งานทะเบียนที่ต้องไล่ดูย้อนหลังได้
  // ต้องหอบตัวกรองทุกตัวไปกับลิงก์เปลี่ยนหน้าด้วย ไม่งั้นกดหน้า 2 แล้วตัวกรองหลุดหมด กลายเป็นดูคนละชุด
  const filterQs = () => {
    const qs = new URLSearchParams({ direction });
    if (q) qs.set('q', q);
    if (statusFilter) qs.set('status', statusFilter);
    for (const [k, v] of Object.entries(f)) if (v) qs.set(k, v === true ? '1' : v);
    return qs;
  };
  const pageLink = (n) => {
    const qs = filterQs();
    if (n > 1) qs.set('page', String(n));
    return `/documents?${qs.toString()}`;
  };
  // ไฟล์ที่ส่งออกต้องเป็น "ชุดเดียวกับที่เห็นอยู่ตรงหน้า" ไม่ใช่ทั้งฐานข้อมูล จึงหอบตัวกรองไปด้วยเสมอ
  const exportLink = (path) => `${path}?${filterQs().toString()}`;
  const pager = totalPages > 1 ? `
    <div class="flex items-center justify-between gap-2 flex-wrap" style="margin-top:1rem">
      ${page > 1 ? `<a class="btn btn-outline btn-sm" href="${pageLink(page - 1)}">← ใหม่กว่า</a>` : '<span></span>'}
      <span class="text-muted" style="font-size:.85rem">
        แสดงฉบับที่ ${fmtCount(offset + 1)}–${fmtCount(Math.min(offset + PAGE_SIZE, total))}
        จาก ${fmtCount(total)} ฉบับ
      </span>
      ${page < totalPages ? `<a class="btn btn-outline btn-sm" href="${pageLink(page + 1)}">เก่ากว่า →</a>` : '<span></span>'}
    </div>` : '';

  // ฟอร์มค้นหา: แถวบนคือของที่ใช้บ่อยที่สุด (คำค้น + สถานะ) เห็นตลอด ส่วนตัวกรองละเอียดพับไว้ใน <details>
  // เพื่อไม่ให้หน้าจอมือถือรก แต่จะกางเองอัตโนมัติเมื่อมีตัวกรองทำงานอยู่ ไม่งั้นผู้ใช้จะงงว่าทำไมรายการหาย
  const opt = (value, label, selected) => `<option value="${esc(value)}" ${value === selected ? 'selected' : ''}>${esc(label)}</option>`;
  const filterForm = `
    <form method="get" style="margin-bottom:1rem">
      <input type="hidden" name="direction" value="${direction}" />
      <div class="flex gap-2 flex-wrap items-center">
        <input type="text" name="q" value="${esc(q)}" placeholder="ค้นหาเลขหนังสือ/ชื่อเรื่อง/หน่วยงาน" style="max-width:280px" />
        <select name="status" style="max-width:180px">
          <option value="">ทุกสถานะ</option>
          ${Object.entries(LABELS.STATUS_LABEL).map(([k, v]) => opt(k, v, statusFilter)).join('')}
        </select>
        <button class="btn btn-outline" type="submit">ค้นหา</button>
        ${activeFilters || q || statusFilter
          ? `<a class="btn btn-outline btn-sm" href="/documents?direction=${direction}">✕ ล้างตัวกรอง</a>` : ''}
      </div>
      <details class="field-more" style="margin-top:.75rem" ${activeFilters ? 'open' : ''}>
        <summary>ตัวกรองละเอียด${activeFilters ? ` <span class="badge badge-info">${activeFilters}</span>` : ''}</summary>
        <div class="form-grid cols-3" style="margin-top:.75rem">
          <div class="field">
            <!-- ทะเบียนหนังสือรับ/ส่งเป็นเล่มต่อปี เลขรับเริ่มที่ 1 ใหม่ทุกวันที่ 1 ม.ค. — ธุรการที่ต้องพิมพ์
                 "ทะเบียนประจำปี ๒๕๖๙" เข้าแฟ้มจึงต้องเลือกปีได้ตรงๆ ไม่ใช่ไปคำนวณช่วงวันที่แบบ ค.ศ. เอง -->
            <label>ทะเบียนประจำปี (พ.ศ.)</label>
            <select name="year"><option value="">ทุกปี</option>
              ${listRegisterYears(ctx.user, direction).map((y) => opt(String(y), String(y), f.year ? String(f.year) : '')).join('')}</select>
          </div>
          <div class="field">
            <label>ฝ่ายที่รับผิดชอบ</label>
            <select name="dept"><option value="">ทุกฝ่าย</option>${listDeptOptions(f.dept)}</select>
          </div>
          <div class="field">
            <label>ความเร็ว</label>
            <select name="priority"><option value="">ทุกระดับ</option>
              ${Object.entries(LABELS.PRIORITY_LABEL).map(([k, v]) => opt(k, v, f.priority)).join('')}</select>
          </div>
          <div class="field">
            <label>ชั้นความลับ</label>
            <select name="secret"><option value="">ทุกชั้น</option>
              ${Object.entries(LABELS.SECRET_LABEL).map(([k, v]) => opt(k, v, f.secret)).join('')}</select>
          </div>
          <div class="field">
            <label>ลงทะเบียนตั้งแต่วันที่</label>
            <input type="date" name="from" value="${esc(f.from)}" />
          </div>
          <div class="field">
            <label>ถึงวันที่</label>
            <input type="date" name="to" value="${esc(f.to)}" />
          </div>
          <div class="field">
            <!-- label เปล่าไว้ดันช่องติ๊กให้อยู่ระดับเดียวกับช่องวันที่ข้างๆ บนจอกว้าง (จอแคบจะเรียงลงล่างอยู่แล้ว) -->
            <label aria-hidden="true" class="label-spacer">&nbsp;</label>
            <label class="check-inline">
              <input type="checkbox" name="overdue" value="1" ${f.overdue ? 'checked' : ''} />
              เฉพาะที่เลยกำหนดและยังไม่ปิด
            </label>
          </div>
        </div>
        <button class="btn btn-primary btn-sm" type="submit">กรองตามเงื่อนไข</button>
      </details>
    </form>
    <div class="flex gap-2 flex-wrap items-center" style="margin:-.4rem 0 1rem">
      <span class="text-muted" style="font-size:.85rem">ส่งออก${filtering ? 'เฉพาะรายการที่กรองไว้' : 'ทั้งทะเบียน'}:</span>
      <a class="btn btn-outline btn-sm" href="${exportLink('/documents/export.xlsx')}">📊 Excel</a>
      <a class="btn btn-outline btn-sm" href="${exportLink('/documents/register')}" target="_blank" rel="noopener">🖨️ พิมพ์ทะเบียน / PDF</a>
    </div>`;

  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">${DIRECTION_TITLE[direction]}</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          ${total ? `${filtering ? 'ตรงตามเงื่อนไข' : 'ทั้งหมด'} ${fmtCount(total)} ฉบับ${totalPages > 1 ? ` · หน้า ${page} จาก ${totalPages}` : ''}${overdueCount ? ` · <strong style="color:var(--danger)">เลยกำหนดในหน้านี้ ${overdueCount}</strong>` : ''}`
            : 'ยังไม่มีรายการ'}
        </p>
      </div>
      ${direction === 'all' ? `
      <div class="flex gap-2 flex-wrap">
        <a class="btn btn-outline" href="/documents?direction=incoming">📥 ทะเบียนหนังสือเข้า</a>
        <a class="btn btn-outline" href="/documents?direction=outgoing">📤 ทะเบียนหนังสือออก</a>
      </div>` : `
      <div class="flex gap-2 flex-wrap">
        <a class="btn btn-outline" href="/documents/bulk?direction=${direction}">📎 ลงหลายฉบับรวดเดียว</a>
        <a class="btn btn-primary" href="/documents/new?direction=${direction}">+ ${direction === 'incoming' ? 'รับหนังสือใหม่' : 'สร้างหนังสือส่ง'}</a>
      </div>`}
    </div>
    <div class="card">
      ${filterForm}
      ${rows.length ? `<div class="table-wrap"><table>
        <thead><tr><th>เลขที่</th>${direction === 'all' ? '<th>ประเภท</th>' : ''}<th>เรื่อง</th><th>ฝ่าย</th><th>ความเร็ว</th><th>สถานะ</th><th>ครบกำหนด</th><th>วันที่ลงทะเบียน</th></tr></thead>
        <tbody>${rowsHtml}</tbody></table></div>${pager}`
      : emptyState('📭', filtering
        ? 'ไม่พบหนังสือที่ตรงกับเงื่อนไขที่เลือก — ลองลดเงื่อนไขลงหรือกด "ล้างตัวกรอง"'
        : `ไม่มี${DIRECTION_NOUN[direction]}ในรายการนี้`)}
    </div>`;

  html(ctx, 200, layout({ user: ctx.user, title: DIRECTION_NOUN[direction] === 'หนังสือ' ? 'ผลการค้นหา' : DIRECTION_NOUN[direction], path: '/documents', content }));
}));

// ---------------- new form ----------------
// Web Share Target — ปกติ service worker (public/sw.js) จะดักคำขอนี้ไว้เองตั้งแต่ในเครื่องผู้ใช้ แล้วพา
// ไฟล์เข้าฟอร์มให้เลย ไม่วิ่งมาถึงเซิร์ฟเวอร์ เส้นทางนี้เป็นทางสำรองเผื่อ SW ยังไม่ทันทำงาน (เช่น เพิ่งติดตั้ง
// แอปครั้งแรก) — กู้ไฟล์คืนไม่ได้เพราะเป็น multipart ที่ระบบนี้ไม่ได้ parse ไว้ จึงพาไปฟอร์มพร้อมบอกให้แนบเอง
router.post('/share-target', requirePage((ctx) => {
  redirect(ctx, '/documents/new?direction=incoming&shareerr=sw');
}));

router.get('/documents/new', requirePage((ctx) => {
  const direction = ctx.query.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const content = `
    <h2>${direction === 'incoming' ? '📥 รับหนังสือใหม่' : '📤 สร้างหนังสือส่ง'}</h2>
    <div class="card">
      <form id="docForm">
        <input type="hidden" name="direction" value="${direction}" />
        <div class="form-grid cols-2">
          <div class="field">
            <label>ชื่อเรื่อง *</label>
            <input type="text" name="title" required placeholder="เช่น ขออนุมัติจัดโครงการ..." />
          </div>
          <div class="field">
            <label>${direction === 'incoming' ? 'หน่วยงาน/บุคคลต้นทาง' : 'หน่วยงาน/บุคคลปลายทาง'} *</label>
            <input type="text" name="correspondentName" required placeholder="เช่น สพฐ., ผู้ปกครอง..." />
          </div>
          <div class="field">
            <label>ฝ่ายที่รับผิดชอบ *</label>
            <select name="departmentId" required>${listDeptOptions(ctx.user.department_id)}</select>
          </div>
          <div class="field">
            <label>ความเร็ว</label>
            <select name="priority">
              <option value="normal">ปกติ</option><option value="urgent">ด่วน</option>
              <option value="very_urgent">ด่วนมาก</option><option value="most_urgent">ด่วนที่สุด</option>
            </select>
          </div>
        </div>
        <div class="field">
          <label>สาระสำคัญ / หมายเหตุ</label>
          <textarea name="subject" placeholder="สรุปใจความสำคัญของหนังสือ"></textarea>
        </div>
        <details class="field-more">
          <summary>⚙️ ตัวเลือกเพิ่มเติม (ไม่บังคับ — ไม่กรอกก็ใช้ค่าเริ่มต้นได้เลย)</summary>
          <div class="form-grid cols-2" style="margin-top:.8rem">
            <div class="field">
              <label>เลขที่หนังสือ (กำหนดเอง)</label>
              <input type="text" name="customDocNumber" placeholder="เว้นว่างให้ระบบออกเลขอัตโนมัติ (เช่น 0001/2569)" />
              <div class="help-text">พิมพ์เลขที่เองได้ถ้าเลขที่ต้องการไม่ใช่เลขเรียงอัตโนมัติของระบบ — ระบบจะใช้เลขที่พิมพ์นี้แสดงแทนทุกที่ (ทะเบียน/ตราประทับ/พิมพ์เอกสาร)</div>
            </div>
            <div class="field">
              <label>เลขหนังสือ${direction === 'incoming' ? 'จากต้นทาง (ถ้ามี)' : 'อ้างอิง (ถ้ามี)'}</label>
              <input type="text" name="externalDocNumber" placeholder="เช่น ศธ 04123/55 หรือเว้นว่างถ้าไม่มี" />
            </div>
            <div class="field">
              <label>ลงวันที่ (วันที่ในหนังสือต้นฉบับ)</label>
              <input type="date" name="externalDocDate" />
            </div>
            <div class="field">
              <label>ชั้นความลับ</label>
              <select name="secretLevel">
                <option value="normal">ปกติ</option><option value="internal">ภายใน</option>
                <option value="secret">ลับ</option><option value="top_secret">ลับมาก</option>
              </select>
            </div>
            <div class="field">
              <label>กำหนดเสร็จ (ถ้ามี)</label>
              <input type="date" name="dueDate" />
            </div>
            <div class="field">
              <label>อายุการเก็บ</label>
              <select name="retentionClass">
                ${Object.entries(RETENTION_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'normal_10y' ? 'selected' : ''}>${esc(v)}</option>`).join('')}
              </select>
            </div>
          </div>
        </details>
        <div class="field">
          <label>ไฟล์แนบ 1 (ไฟล์หลัก)</label>
          <input type="file" id="fileInput" accept="application/pdf" onchange="attachFilePreview(this,'filePreview')" />
          <div id="filePreview" class="help-text"></div>
          <div class="help-text">รองรับเฉพาะไฟล์ PDF ขนาดไม่เกิน 10MB (ระบบจะตรวจ magic number และคำนวณ SHA-256 hash)</div>
        </div>
        <div class="form-grid cols-2">
          <div class="field">
            <label>ไฟล์แนบ 2 (ถ้ามี)</label>
            <input type="file" id="fileInput2" accept="application/pdf" onchange="attachFilePreview(this,'filePreview2')" />
            <div id="filePreview2" class="help-text"></div>
          </div>
          <div class="field">
            <label>ไฟล์แนบ 3 (ถ้ามี)</label>
            <input type="file" id="fileInput3" accept="application/pdf" onchange="attachFilePreview(this,'filePreview3')" />
            <div id="filePreview3" class="help-text"></div>
          </div>
        </div>
        <button class="btn btn-primary" type="submit">บันทึกและออกเลข${direction === 'incoming' ? 'รับ' : 'ส่ง'}อัตโนมัติ</button>
        <a class="btn btn-outline" href="/documents?direction=${direction}">ยกเลิก</a>
      </form>
    </div>
    <script>
      // รับไฟล์ที่ผู้ใช้แชร์มาจากแอปอื่น (LINE ฯลฯ) — service worker พักไฟล์ไว้ใน Cache Storage แล้วพามาที่
      // หน้านี้พร้อม ?shared=1 ตรงนี้ทำหน้าที่หยิบไฟล์ออกมาใส่ช่อง "ไฟล์แนบ 1" ให้อัตโนมัติ ผู้ใช้แค่กรอก
      // ชื่อเรื่องกับหน่วยงานต้นทางแล้วกดบันทึกได้เลย ไม่ต้องดาวน์โหลดไฟล์ลงเครื่องแล้วไล่หาเองอีก
      // รอ load ก่อน เพราะ /app.js (เจ้าของ window.toast / window.attachFilePreview) ถูกโหลดท้าย body
      window.addEventListener('load', async function pickUpSharedFile(){
        var params = new URLSearchParams(location.search);
        if (params.get('shareerr')) {
          window.toast(params.get('shareerr') === 'sw'
            ? 'เปิดแอปครั้งแรกยังรับไฟล์ที่แชร์มาอัตโนมัติไม่ได้ กรุณาแนบไฟล์เองครั้งนี้ ครั้งต่อไปจะเข้าให้เองอัตโนมัติ'
            : 'รับไฟล์ที่แชร์มาไม่สำเร็จ กรุณาแนบไฟล์เองครับ', 'warning');
        }
        // ตั้งใจไม่เช็ค ?shared=1 เป็นเงื่อนไขบังคับ — ถ้าเซสชันหมดอายุพอดี ระบบจะเด้งไปหน้า login ก่อน
        // แล้ว query string หายไป พอ login เสร็จกลับมาที่ฟอร์มนี้จะไม่มี ?shared=1 ติดมาด้วย ถ้าเช็คแบบตายตัว
        // ไฟล์ที่ผู้ใช้อุตส่าห์แชร์มาจะค้างใน cache เฉยๆ ไม่มีใครหยิบไปใช้ — เช็คจาก cache ตรงๆ ครอบคลุมกว่า
        if (!('caches' in window)) return;
        try {
          var cache = await caches.open('esaraban-shared-inbox');
          var res = await cache.match('/__shared-file__');
          if (!res) return;
          var blob = await res.blob();
          var name = decodeURIComponent(res.headers.get('X-Shared-Filename') || 'shared.pdf');
          await cache.delete('/__shared-file__'); // ใช้ครั้งเดียวแล้วลบ กันไฟล์เก่าค้างมาโผล่รอบหน้า
          if (blob.size > 10 * 1024 * 1024) { window.toast('ไฟล์ที่แชร์มาใหญ่เกิน 10MB', 'warning'); return; }

          var input = document.getElementById('fileInput');
          var dt = new DataTransfer();
          // บางแอป (รวมถึง LINE บางรุ่น) แชร์ไฟล์มาเป็น application/octet-stream ทั้งที่เป็น PDF —
          // ถ้าปล่อยไว้จะไปตกตอนกดบันทึก (เซิร์ฟเวอร์รับเฉพาะ application/pdf) หลังผู้ใช้กรอกฟอร์มจนเสร็จ
          // แล้ว เสียเวลาเปล่า จึงตั้ง type ให้ถูกตั้งแต่ตรงนี้ (เซิร์ฟเวอร์ยังตรวจ magic number ซ้ำอยู่ดี)
          var sharedType = /\.pdf$/i.test(name) ? 'application/pdf' : (blob.type || 'application/pdf');
          dt.items.add(new File([blob], name, { type: sharedType }));
          input.files = dt.files;
          window.attachFilePreview(input, 'filePreview');
          window.toast('รับไฟล์ "' + name + '" จากแอปที่แชร์มาแล้ว — กรอกชื่อเรื่องแล้วบันทึกได้เลย', 'success');
          var titleEl = document.querySelector('input[name="title"]');
          if (titleEl) titleEl.focus();
        } catch (err) {
          window.toast('รับไฟล์ที่แชร์มาไม่สำเร็จ กรุณาแนบไฟล์เองครับ', 'warning');
        }
      });
      document.getElementById('docForm').addEventListener('submit', async function(e){
        e.preventDefault();
        var formEl = this;
        var btn = formEl.querySelector('[type=submit]');
        var extraFiles = [document.getElementById('fileInput2').files[0], document.getElementById('fileInput3').files[0]].filter(Boolean);
        for (var f of extraFiles) {
          if (f.size > 10 * 1024 * 1024) { window.toast('ไฟล์ "' + f.name + '" ใหญ่เกิน 10MB — เอาออกหรือแนบทีหลังแทน', 'warning'); return; }
        }
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        try {
          var formData = new FormData(formEl);
          var payload = {};
          for (var pair of formData.entries()) payload[pair[0]] = pair[1];
          var mainFile = document.getElementById('fileInput').files[0];
          if (mainFile) {
            if (mainFile.size > 10 * 1024 * 1024) { window.toast('ไฟล์หลักใหญ่เกิน 10MB', 'warning'); window.restoreBtn(btn); return; }
            payload.fileName = mainFile.name;
            payload.fileType = mainFile.type || 'application/octet-stream';
            payload.fileDataBase64 = await window.fileToBase64(mainFile);
          }
          var res = await fetch('/documents', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'เกิดข้อผิดพลาด');

          // แนบไฟล์ 2 และ 3 ต่อทันที (ใช้ endpoint แนบไฟล์เพิ่มเดิมที่มีอยู่แล้ว — ไม่ต้องเพิ่ม backend ใหม่)
          var docIdMatch = data.redirect.match(/documents\\/([a-f0-9-]+)/);
          var docId = docIdMatch && docIdMatch[1];
          var failedExtras = [];
          for (var ef of extraFiles) {
            try {
              var b64 = await window.fileToBase64(ef);
              var r2 = await fetch('/documents/' + docId + '/attachments', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ fileName: ef.name, fileType: ef.type || 'application/octet-stream', fileDataBase64: b64 }) });
              if (!r2.ok) failedExtras.push(ef.name);
            } catch (e) { failedExtras.push(ef.name); }
          }
          if (failedExtras.length) window.toast('บันทึกเอกสารสำเร็จ แต่แนบไม่สำเร็จ: ' + failedExtras.join(', '), 'warning');
          window.location.href = data.redirect;
        } catch (err) {
          window.toast(err.message || 'เกิดข้อผิดพลาด', 'danger');
          window.restoreBtn(btn);
        }
      });
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'สร้างเอกสารใหม่', path: '/documents/new', content }));
}));

// ผู้ใช้เลือกไฟล์มาแล้ว แต่ไฟล์นั้นไม่มีข้อมูลเลย (0 ไบต์) — เกิดขึ้นจริงเวลาสแกนค้างกลางคัน ไฟล์เสีย
// หรือคัดลอกจากมือถือ/แฟลชไดรฟ์ไม่จบ เดิมเงื่อนไข `if (!fileDataBase64)` กลืนกรณีนี้รวมกับ "ไม่ได้แนบ
// ไฟล์มาเลย" ซึ่งเป็นคนละเรื่องกัน ผลคือผู้ใช้กด "แนบไฟล์เพิ่ม" แล้วได้หน้าเดิมกลับมาเหมือนสำเร็จ
// โดยไม่มีไฟล์แนบจริงและไม่มีข้อความอะไรบอกเลย (ทดสอบผ่านฟอร์มจริงยืนยันแล้ว) กว่าจะรู้ว่าหนังสือ
// ฉบับนั้นไม่มีไฟล์สแกนก็ตอนต้องหยิบมาใช้ ซึ่งอาจเป็นเดือนถัดไป
const EMPTY_UPLOAD_MESSAGE = 'ไฟล์ที่แนบมาไม่มีข้อมูล (0 ไบต์) — อาจสแกนไม่สำเร็จหรือไฟล์เสียหาย กรุณาตรวจสอบไฟล์แล้วแนบใหม่อีกครั้ง';

// "เลือกไฟล์มาแล้วแต่ไฟล์ว่าง" ต่างจาก "ไม่ได้เลือกไฟล์" — หน้าเว็บส่ง fileName/fileType/fileDataBase64
// มาพร้อมกันทั้งชุดเฉพาะตอนที่ผู้ใช้เลือกไฟล์จริงเท่านั้น จึงใช้ตรงนี้แยกสองกรณีออกจากกันได้
function isEmptyUpload(b) {
  const supplied = typeof b?.fileDataBase64 === 'string' || b?.fileName != null || b?.fileType != null;
  return supplied && !(typeof b?.fileDataBase64 === 'string' && b.fileDataBase64.trim());
}

async function saveAttachment({ documentId, fileName, fileType, fileDataBase64, uploader }) {
  if (!fileDataBase64) return null;
  // ตัดชื่อไฟล์ตั้งแต่ตอนบันทึก ไม่ใช่ตอนส่งออกอย่างเดียว — ผู้ใช้จะได้เห็นชื่อเดียวกันทั้งในหน้าเว็บและ
  // ตอนดาวน์โหลด (ชื่อยาวเกินทำให้หัว HTTP ล้นจนดาวน์โหลดไม่ได้เลย ดู truncateFilename ใน router.js)
  fileName = truncateFilename(fileName);
  if (!ALLOWED_MIME.has(fileType)) throw httpError(400, 'อนุญาตเฉพาะไฟล์ PDF เท่านั้น');
  const buf = Buffer.from(fileDataBase64, 'base64');
  if (buf.length > MAX_FILE_BYTES) throw httpError(413, 'ไฟล์มีขนาดใหญ่เกิน 10MB');
  // magic-number check (file signature), not just declared MIME type
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw httpError(400, 'ไฟล์ไม่ใช่ PDF ที่ถูกต้อง (ตรวจสอบ file signature ไม่ผ่าน)');
  const hash = createHash('sha256').update(buf).digest('hex');
  // คำเตือน "ไฟล์นี้ซ้ำกับเอกสาร 0042/2569" ต้องบอกได้เฉพาะเลขของหนังสือที่ผู้อัปโหลดมีสิทธิ์เห็น —
  // เดิมค้นทั้งฐานข้อมูล ครูที่บังเอิญอัปโหลดไฟล์เดียวกับที่แนบอยู่กับหนังสือ "ลับมาก" จึงได้เลขที่หนังสือ
  // ฉบับนั้นมาฟรีๆ ทั้งที่เปิดอ่านไม่ได้ (ยืนยันแล้วว่าเกิดขึ้นจริง)
  const dupVisible = visibleDocumentsSqlFilter(uploader);
  const dup = db.prepare(`
    SELECT a.*, d.doc_number_display FROM attachments a JOIN documents d ON d.id = a.document_id
    WHERE a.hash_sha256 = :hash AND d.deleted_at IS NULL AND ${dupVisible.sql}
  `).get({ ...dupVisible.params, hash });
  const id = uuid();
  const safeName = `${id}.pdf`;

  let storageProvider = 'local';
  let filepath = null;
  let driveFileId = null;

  if (isGoogleDriveEnabled()) {
    const doc = db.prepare(`
      SELECT d.year_be, dt.name as type_name FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id WHERE d.id = ?
    `).get(documentId);
    const folderId = await ensureCategoryFolder({ yearBe: doc.year_be, typeName: doc.type_name });
    driveFileId = await uploadFile({ buffer: buf, filename: `${safeName}__${fileName || 'document.pdf'}`, mimeType: fileType, folderId });
    storageProvider = 'google_drive';
  } else {
    fs.writeFileSync(path.join(UPLOAD_DIR, safeName), buf);
    filepath = safeName;
  }

  db.prepare(`
    INSERT INTO attachments (id, document_id, filename, storage_provider, filepath, drive_file_id, filesize, mime_type, hash_sha256, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, documentId, fileName || 'document.pdf', storageProvider, filepath, driveFileId, buf.length, fileType, hash, uploader.id, nowIso());
  audit({ userId: uploader.id, action: 'attachment_uploaded', tableName: 'attachments', recordId: id, detail: { documentId, hash, storageProvider, duplicateOf: dup ? dup.doc_number_display : null } });
  return { id, duplicateWarning: dup ? `พบไฟล์นี้ซ้ำกับเอกสาร ${dup.doc_number_display} (Hash ตรงกัน)` : null };
}

// ---------------- create ----------------
router.post('/documents', requireApi(async (ctx) => {
  const b = ctx.body;
  if (!b.title || !b.correspondentName || !b.departmentId) {
    throw httpError(400, 'กรุณากรอกข้อมูลที่จำเป็นให้ครบถ้วน (ชื่อเรื่อง, หน่วยงาน, ฝ่าย)');
  }
  const doc = createDocument({
    direction: b.direction === 'outgoing' ? 'outgoing' : 'incoming',
    title: b.title.trim(), subject: b.subject?.trim(), docTypeId: defaultDocTypeId(), departmentId: b.departmentId,
    priority: b.priority, secretLevel: b.secretLevel, correspondentName: b.correspondentName.trim(),
    externalDocNumber: b.externalDocNumber?.trim(), externalDocDate: b.externalDocDate || null, dueDate: b.dueDate || null,
    retentionClass: b.retentionClass, customDocNumber: b.customDocNumber?.trim() || null, createdBy: ctx.user.id,
  });
  const warnParts = [];
  if (doc.duplicateDocNumberWarning) warnParts.push(doc.duplicateDocNumberWarning);
  // ตรงนี้เลขที่หนังสือถูกออกไปแล้วและใช้ซ้ำไม่ได้ตามหลักงานสารบรรณ จึงไม่โยน error ทิ้งทั้งฟอร์ม
  // แต่เตือนผ่าน ?warn= ให้ธุรการรู้ทันทีว่าต้องแนบไฟล์ใหม่ที่หน้ารายละเอียด
  if (isEmptyUpload(b)) {
    warnParts.push(EMPTY_UPLOAD_MESSAGE);
  } else if (b.fileDataBase64) {
    const att = await saveAttachment({ documentId: doc.id, fileName: b.fileName, fileType: b.fileType, fileDataBase64: b.fileDataBase64, uploader: ctx.user });
    if (att?.duplicateWarning) warnParts.push(att.duplicateWarning);
  }
  const warn = warnParts.length ? `&warn=${encodeURIComponent(warnParts.join(' / '))}` : '';
  json(ctx, 201, { redirect: `/documents/${doc.id}?created=1${warn}` });
}));

// ---------------- ลงรับหลายฉบับรวดเดียว ----------------
// ซองหนังสือมาถึงโรงเรียนเป็นปึกในรอบเดียว ธุรการต้องเปิดฟอร์มใหม่ทีละฉบับ กรอกหน่วยงานต้นทาง/ฝ่าย/
// ความเร็วซ้ำเดิมทุกครั้ง แล้วรอหน้าโหลดใหม่ก่อนเริ่มฉบับถัดไป — หน้านี้ยุบให้เหลือรอบเดียว โดยเลือกไฟล์ PDF
// ทั้งกองพร้อมกันแล้วระบบตั้งแถวให้เอง เหลือแค่แก้ชื่อเรื่องกับกดบันทึก
//
// ไม่ได้ตั้งสิทธิ์เข้มกว่า /documents/new เพราะหน้านี้ไม่ได้ให้อำนาจอะไรใหม่เลย — ใครที่ลงทะเบียนหนังสือ
// ทีละฉบับได้อยู่แล้วก็ทำแบบเดียวกัน 20 รอบได้ การกันหน้านี้ไว้จึงกันได้แค่ความสะดวก ไม่ได้กันสิทธิ์
router.get('/documents/bulk', requirePage((ctx) => {
  const direction = ctx.query.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const isIn = direction === 'incoming';
  const content = `
    <div class="card-header">
      <div>
        <h2 class="mt-0">${isIn ? '📥 ลงรับหลายฉบับรวดเดียว' : '📤 ออกเลขส่งหลายฉบับรวดเดียว'}</h2>
        <p class="text-muted" style="margin:-.3rem 0 0;font-size:.85rem">
          เลือกไฟล์ PDF ทั้งกองพร้อมกัน ระบบจะตั้งแถวให้ไฟล์ละ 1 ฉบับ แล้วออกเลข${isIn ? 'รับ' : 'ส่ง'}เรียงให้ทั้งชุดในครั้งเดียว
        </p>
      </div>
      <a class="btn btn-outline" href="/documents/new?direction=${direction}">ลงทีละฉบับแทน</a>
    </div>

    <div class="card">
      <h3 style="margin-top:0">1. ค่าเริ่มต้นของทั้งชุด</h3>
      <p class="help-text" style="margin-top:-.4rem">
        หนังสือที่มาพร้อมกันมักมาจากหน่วยงานเดียวกัน กรอกตรงนี้ครั้งเดียวแล้วทุกแถวที่เพิ่มใหม่จะได้ค่านี้ไปเลย
        (แก้รายแถวทีหลังได้)
      </p>
      <div class="form-grid cols-3">
        <div class="field">
          <label>${isIn ? 'หน่วยงาน/บุคคลต้นทาง' : 'หน่วยงาน/บุคคลปลายทาง'}</label>
          <input type="text" id="defCorrespondent" placeholder="เช่น สพป.เชียงใหม่ เขต 1" />
        </div>
        <div class="field">
          <label>ฝ่ายที่รับผิดชอบ</label>
          <select id="defDept">${listDeptOptions(ctx.user.department_id)}</select>
        </div>
        <div class="field">
          <label>ความเร็ว</label>
          <select id="defPriority">
            ${Object.entries(LABELS.PRIORITY_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>ชั้นความลับ</label>
          <select id="defSecret">
            ${Object.entries(LABELS.SECRET_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label>กำหนดเสร็จ (ถ้ามี)</label>
          <input type="date" id="defDue" />
        </div>
        <div class="field">
          <label>อายุการเก็บ</label>
          <select id="defRetention">
            ${Object.entries(RETENTION_LABEL).map(([k, v]) => `<option value="${k}" ${k === 'normal_10y' ? 'selected' : ''}>${esc(v)}</option>`).join('')}
          </select>
        </div>
      </div>
      <button class="btn btn-outline btn-sm" type="button" id="applyDefaults">ใช้ค่าข้างบนกับทุกแถวที่มีอยู่แล้ว</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">2. รายการหนังสือ</h3>
      <div class="flex gap-2 flex-wrap items-center" style="margin-bottom:.9rem">
        <input type="file" id="bulkFiles" accept="application/pdf" multiple hidden />
        <button class="btn btn-primary" type="button" id="pickFiles">📎 เลือกไฟล์ PDF (เลือกได้หลายไฟล์)</button>
        <button class="btn btn-outline" type="button" id="addRow">+ เพิ่มแถวว่าง (ไม่มีไฟล์)</button>
        <span class="text-muted" style="font-size:.85rem" id="rowCount"></span>
      </div>
      <div id="rows"></div>
      <div id="emptyRows">${emptyState('📥', 'ยังไม่มีรายการ — กด "เลือกไฟล์ PDF" หรือ "เพิ่มแถวว่าง" เพื่อเริ่ม')}</div>
    </div>

    <div class="card" id="submitCard" style="display:none">
      <h3 style="margin-top:0">3. บันทึก</h3>
      <div id="progress" class="help-text"></div>
      <button class="btn btn-primary" type="button" id="submitAll">บันทึกและออกเลข${isIn ? 'รับ' : 'ส่ง'}ทั้งหมด</button>
      <a class="btn btn-outline" href="/documents?direction=${direction}">ยกเลิก</a>
    </div>

    <div class="card" id="resultCard" style="display:none">
      <h3 style="margin-top:0">✅ ผลการลงรับ</h3>
      <div id="result"></div>
    </div>

    <script>
    (function(){
      var DIRECTION = ${JSON.stringify(direction)};
      var MAX_ROWS = ${MAX_BULK_DOCUMENTS};
      var MAX_BYTES = 10 * 1024 * 1024;
      var rows = [];          // {file: File|null, title, correspondentName, departmentId, priority, secretLevel, dueDate, retentionClass}
      var deptHtml = ${JSON.stringify(listDeptOptions(ctx.user.department_id))};
      var priorityHtml = ${JSON.stringify(Object.entries(LABELS.PRIORITY_LABEL).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join(''))};
      var byId = function(id){ return document.getElementById(id); };
      var esc = function(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; };

      function defaults(){
        return {
          correspondentName: byId('defCorrespondent').value.trim(),
          departmentId: byId('defDept').value,
          priority: byId('defPriority').value,
          secretLevel: byId('defSecret').value,
          dueDate: byId('defDue').value,
          retentionClass: byId('defRetention').value,
        };
      }
      // ชื่อไฟล์สแกนมักเป็นชื่อเรื่องอยู่แล้ว (เช่น "ขอเชิญประชุมผู้บริหาร.pdf") ตั้งเป็นชื่อเรื่องให้เลย
      // ธุรการจะได้แค่แก้คำ ไม่ต้องพิมพ์ใหม่ทั้งหมด — ถ้าเป็นชื่อจากเครื่องสแกน (scan0001.pdf) ก็ลบทิ้งง่าย
      function titleFromFile(name){ return name.replace(/\\.pdf$/i, '').replace(/[_-]+/g, ' ').trim(); }

      function addRows(newRows){
        var room = MAX_ROWS - rows.length;
        if (newRows.length > room) {
          window.toast('เพิ่มได้อีก ' + room + ' แถวเท่านั้น (ครั้งละไม่เกิน ' + MAX_ROWS + ' ฉบับ) — ส่วนที่เกินไม่ได้เพิ่มให้', 'warning');
          newRows = newRows.slice(0, Math.max(0, room));
        }
        newRows.forEach(function(r){ rows.push(r); });
        render();
      }

      function render(){
        var box = byId('rows');
        box.innerHTML = rows.map(function(r, i){
          return '<div class="bulk-row" data-i="' + i + '">'
            + '<div class="bulk-row-head">'
            +   '<strong>ฉบับที่ ' + (i + 1) + '</strong>'
            +   (r.file ? '<span class="badge badge-info">📎 ' + esc(r.file.name) + '</span>'
                        : '<span class="text-muted" style="font-size:.82rem">ไม่มีไฟล์แนบ</span>')
            +   '<button type="button" class="btn btn-outline btn-sm rm" data-i="' + i + '">ลบแถวนี้</button>'
            + '</div>'
            + '<div class="form-grid cols-3">'
            +   '<div class="field"><label>ชื่อเรื่อง *</label>'
            +     '<input type="text" data-f="title" data-i="' + i + '" value="' + esc(r.title) + '" placeholder="ชื่อเรื่องของหนังสือฉบับนี้" /></div>'
            +   '<div class="field"><label>' + (DIRECTION === 'incoming' ? 'หน่วยงานต้นทาง *' : 'หน่วยงานปลายทาง *') + '</label>'
            +     '<input type="text" data-f="correspondentName" data-i="' + i + '" value="' + esc(r.correspondentName) + '" /></div>'
            +   '<div class="field"><label>ฝ่ายที่รับผิดชอบ</label>'
            +     '<select data-f="departmentId" data-i="' + i + '">' + deptHtml + '</select></div>'
            +   '<div class="field"><label>ความเร็ว</label>'
            +     '<select data-f="priority" data-i="' + i + '">' + priorityHtml + '</select></div>'
            +   '<div class="field"><label>กำหนดเสร็จ (ถ้ามี)</label>'
            +     '<input type="date" data-f="dueDate" data-i="' + i + '" value="' + esc(r.dueDate) + '" /></div>'
            + '</div></div>';
        }).join('');
        // ค่า <select> ตั้งผ่าน .value หลังใส่ HTML ไม่ใช่ประกอบ selected ลงไปในสตริง — ปลอดภัยกว่าและ
        // ไม่ต้องกังวลเรื่อง escape ค่าที่ผู้ใช้เลือก
        rows.forEach(function(r, i){
          var d = box.querySelector('[data-f="departmentId"][data-i="' + i + '"]');
          if (d) d.value = r.departmentId;
          var p = box.querySelector('[data-f="priority"][data-i="' + i + '"]');
          if (p) p.value = r.priority;
        });
        byId('emptyRows').style.display = rows.length ? 'none' : '';
        byId('submitCard').style.display = rows.length ? '' : 'none';
        byId('rowCount').textContent = rows.length ? 'รวม ' + rows.length + ' ฉบับ' : '';
      }

      byId('rows').addEventListener('input', function(e){
        var t = e.target, i = t.getAttribute('data-i'), f = t.getAttribute('data-f');
        if (i === null || !f) return;
        rows[Number(i)][f] = t.value;
      });
      byId('rows').addEventListener('change', function(e){
        var t = e.target, i = t.getAttribute('data-i'), f = t.getAttribute('data-f');
        if (i === null || !f) return;
        rows[Number(i)][f] = t.value;
      });
      byId('rows').addEventListener('click', function(e){
        var btn = e.target.closest('.rm');
        if (!btn) return;
        rows.splice(Number(btn.getAttribute('data-i')), 1);
        render();
      });

      byId('pickFiles').addEventListener('click', function(){ byId('bulkFiles').click(); });
      byId('bulkFiles').addEventListener('change', function(){
        var d = defaults();
        var picked = [], tooBig = [];
        Array.prototype.forEach.call(this.files, function(f){
          if (f.size > MAX_BYTES) { tooBig.push(f.name); return; }
          picked.push({ file: f, title: titleFromFile(f.name), correspondentName: d.correspondentName,
            departmentId: d.departmentId, priority: d.priority, secretLevel: d.secretLevel,
            dueDate: d.dueDate, retentionClass: d.retentionClass });
        });
        if (tooBig.length) window.toast('ไฟล์ใหญ่เกิน 10MB ไม่ได้เพิ่มให้: ' + tooBig.join(', '), 'warning');
        this.value = ''; // เคลียร์เพื่อให้เลือกไฟล์ชุดเดิมซ้ำได้ถ้าเผลอลบแถวไป
        addRows(picked);
      });
      byId('addRow').addEventListener('click', function(){
        var d = defaults();
        addRows([{ file: null, title: '', correspondentName: d.correspondentName, departmentId: d.departmentId,
          priority: d.priority, secretLevel: d.secretLevel, dueDate: d.dueDate, retentionClass: d.retentionClass }]);
      });
      byId('applyDefaults').addEventListener('click', function(){
        if (!rows.length) { window.toast('ยังไม่มีแถวให้ปรับ', 'warning'); return; }
        var d = defaults();
        rows.forEach(function(r){
          if (d.correspondentName) r.correspondentName = d.correspondentName;
          r.departmentId = d.departmentId; r.priority = d.priority;
          r.secretLevel = d.secretLevel; r.retentionClass = d.retentionClass;
          if (d.dueDate) r.dueDate = d.dueDate;
        });
        render();
        window.toast('ใช้ค่าเริ่มต้นกับทั้ง ' + rows.length + ' แถวแล้ว', 'success');
      });

      byId('submitAll').addEventListener('click', async function(){
        var btn = this;
        // ตรวจฝั่งหน้าเว็บก่อนเพื่อบอกตำแหน่งที่ผิดได้ทันที เซิร์ฟเวอร์ยังตรวจซ้ำทั้งหมดอยู่ดี
        for (var i = 0; i < rows.length; i++) {
          if (!rows[i].title.trim()) { window.toast('ฉบับที่ ' + (i + 1) + ' ยังไม่ได้กรอกชื่อเรื่อง', 'warning'); return; }
          if (!rows[i].correspondentName.trim()) { window.toast('ฉบับที่ ' + (i + 1) + ' ยังไม่ได้กรอกหน่วยงาน', 'warning'); return; }
        }
        window.setBtnLoading(btn, 'กำลังออกเลข...');
        var prog = byId('progress');
        try {
          // ขั้นที่ 1 — ออกเลขทั้งชุดในคำขอเดียว (ไม่ส่งไฟล์ไปด้วย เพราะไฟล์ 20 ไฟล์รวมกันเกินขนาด
          // คำขอที่เซิร์ฟเวอร์รับได้ และถ้าล้มกลางทางจะได้เลขขาดเป็นรูโหว่ในทะเบียน)
          prog.textContent = 'กำลังออกเลขทะเบียนทั้ง ' + rows.length + ' ฉบับ...';
          var res = await fetch('/documents/bulk', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ direction: DIRECTION, items: rows.map(function(r){
              return { title: r.title, correspondentName: r.correspondentName, departmentId: r.departmentId,
                priority: r.priority, secretLevel: r.secretLevel, dueDate: r.dueDate, retentionClass: r.retentionClass };
            }) }),
          });
          var data = await res.json();
          if (!res.ok) throw new Error(data.error || 'ออกเลขไม่สำเร็จ');

          // ขั้นที่ 2 — แนบไฟล์ทีละฉบับ ถ้าฉบับไหนแนบไม่สำเร็จ เลขรับยังอยู่ ธุรการเข้าไปแนบเองทีหลังได้
          // เก็บผลเป็นรายแถว ไม่ใช่รายชื่อไฟล์ — ไฟล์สแกนชื่อซ้ำกัน (scan0001.pdf) เกิดขึ้นบ่อยมาก
          // ถ้าเทียบด้วยชื่อ แถวที่แนบสำเร็จจะถูกรายงานว่าล้มเหลวไปด้วย
          var failedIdx = {}, failedNames = [];
          for (var j = 0; j < data.documents.length; j++) {
            var row = rows[j];
            if (!row.file) continue;
            prog.textContent = 'กำลังแนบไฟล์ ' + (j + 1) + '/' + data.documents.length + ' — ' + row.file.name;
            try {
              var b64 = await window.fileToBase64(row.file);
              var r2 = await fetch('/documents/' + data.documents[j].id + '/attachments', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileName: row.file.name, fileType: row.file.type || 'application/pdf', fileDataBase64: b64 }),
              });
              if (!r2.ok) {
                var e2 = await r2.json().catch(function(){ return {}; });
                failedIdx[j] = true; failedNames.push(row.file.name + ' (' + (e2.error || r2.status) + ')');
              }
            } catch (err) { failedIdx[j] = true; failedNames.push(row.file.name); }
          }
          var failed = failedNames;

          prog.textContent = '';
          byId('resultCard').style.display = '';
          byId('result').innerHTML =
            '<p>ออกเลขให้แล้ว <strong>' + data.documents.length + ' ฉบับ</strong></p>'
            + '<div class="table-wrap"><table><thead><tr><th>เลขที่</th><th>ชื่อเรื่อง</th><th>ไฟล์แนบ</th></tr></thead><tbody>'
            + data.documents.map(function(d, k){
                var f = rows[k].file;
                var attached = !f ? '<span class="text-muted">—</span>'
                  : (failedIdx[k] ? '<span style="color:var(--danger)">แนบไม่สำเร็จ</span>' : '✅');
                return '<tr><td><a href="/documents/' + d.id + '"><strong>' + esc(d.docNumberDisplay) + '</strong></a></td>'
                  + '<td class="wrap">' + esc(rows[k].title) + '</td><td>' + attached + '</td></tr>';
              }).join('')
            + '</tbody></table></div>'
            + (failed.length ? '<p style="color:var(--danger);margin-top:.8rem">แนบไฟล์ไม่สำเร็จ ' + failed.length
                + ' ไฟล์: ' + esc(failed.join(', ')) + ' — เลขทะเบียนออกให้แล้ว เข้าไปแนบไฟล์เพิ่มในหน้าเอกสารได้เลย</p>' : '')
            + '<a class="btn btn-primary" href="/documents?direction=' + DIRECTION + '">ไปที่ทะเบียนหนังสือ</a>';
          byId('resultCard').scrollIntoView({ behavior: 'smooth' });
          rows = [];
          render();
          window.restoreBtn(btn);
          window.toast(failed.length ? 'บันทึกครบแล้ว แต่มีไฟล์แนบไม่สำเร็จ ' + failed.length + ' ไฟล์' : 'ลงรับครบทุกฉบับแล้ว',
            failed.length ? 'warning' : 'success');
        } catch (err) {
          prog.textContent = '';
          window.toast(err.message || 'เกิดข้อผิดพลาด', 'danger');
          window.restoreBtn(btn);
        }
      });
    })();
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'ลงรับหลายฉบับ', path: '/documents/bulk', content }));
}));

router.post('/documents/bulk', requireApi((ctx) => {
  const direction = ctx.body.direction === 'outgoing' ? 'outgoing' : 'incoming';
  const items = Array.isArray(ctx.body.items) ? ctx.body.items : [];
  const docTypeId = defaultDocTypeId();
  // เลขที่กำหนดเองตั้งใจไม่รับในโหมดนี้ — ทั้งชุดใช้เลขเรียงอัตโนมัติของระบบเสมอ ถ้าต้องพิมพ์เลขเองให้ลงทีละฉบับ
  const docs = createDocumentsBulk(items.map((it) => ({
    direction, docTypeId,
    title: it.title, correspondentName: it.correspondentName, departmentId: it.departmentId,
    priority: it.priority, secretLevel: it.secretLevel, dueDate: it.dueDate, retentionClass: it.retentionClass,
  })), ctx.user.id);
  json(ctx, 201, {
    documents: docs.map((d) => ({ id: d.id, docNumberDisplay: d.docNumberDisplay })),
  });
}));


// ข้อความที่จะถูกประทับลงบนไฟล์ PDF ต้องตรวจความยาว "ก่อน" ที่ขั้นตอน workflow จะถูกบันทึก —
// ถ้าปล่อยไปตรวจตอนประทับตรา (ซึ่งเกิดหลัง approveAndForward ไปแล้ว) ผลจะเป็น: เรื่องถูกอนุมัติและ
// ส่งต่อไปคนถัดไปเรียบร้อย แต่ความเห็นของ ผอ. ไม่ได้ขึ้นบนหนังสือเลย ผู้ใช้เห็นแค่ข้อความเตือนเล็กๆ
// แล้วย้อนกลับไปแก้ไม่ได้อีก เพราะขั้นตอนนั้นปิดไปแล้ว
function assertStampTextFits({ decisionNote, registrarNote }) {
  assertMaxLength(decisionNote, MAX_STAMP_TEXT, 'ความเห็นที่จะประทับลงหนังสือ');
  assertMaxLength(registrarNote, MAX_STAMP_TEXT, 'ความเห็นธุรการที่จะประทับลงหนังสือ');
}

// ---------------- ส่งออกทะเบียนหนังสือ ----------------
// รูปแบบคอลัมน์อ้างอิงทะเบียนหนังสือรับ/ทะเบียนหนังสือส่งตามระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ
// พ.ศ. 2526 (แบบที่ 13 และ 14) เพื่อให้พิมพ์ออกมาแล้วใช้แทนสมุดทะเบียนกระดาษได้จริง ไม่ใช่ตารางทั่วไป
function registerColumns(direction) {
  const isIn = direction === 'incoming';
  const isAll = direction === 'all';
  return [
    { head: isAll ? 'เลขทะเบียน' : (isIn ? 'ทะเบียนรับที่' : 'ทะเบียนส่งที่'), width: 13, get: (d) => d.doc_number_display },
    // โหมดค้นหารวมมีทั้งหนังสือเข้าและออกปนกัน ต้องมีคอลัมน์บอกว่าแถวไหนเป็นอะไร ไม่งั้นอ่านไม่รู้เรื่อง
    ...(isAll ? [{ head: 'ประเภท', width: 10, get: (d) => (d.direction === 'incoming' ? 'หนังสือเข้า' : 'หนังสือออก') }] : []),
    { head: 'ที่ (หนังสือต้นทาง)', width: 18, get: (d) => d.external_doc_number || '' },
    { head: 'ลงวันที่', width: 13, get: (d) => (d.external_doc_date ? fmtThaiDateShort(d.external_doc_date) : '') },
    { head: isAll ? 'จาก/ถึง' : (isIn ? 'จาก' : 'ถึง'), width: 24, get: (d) => d.correspondent_name || '' },
    { head: 'เรื่อง', width: 46, get: (d) => d.title },
    { head: 'ฝ่ายที่รับผิดชอบ', width: 20, get: (d) => d.dept_name },
    { head: 'ความเร็ว', width: 11, get: (d) => LABELS.PRIORITY_LABEL[d.priority] || d.priority },
    { head: 'ชั้นความลับ', width: 12, get: (d) => LABELS.SECRET_LABEL[d.secret_level] || d.secret_level },
    { head: 'การปฏิบัติ', width: 16, get: (d) => LABELS.STATUS_LABEL[d.status] || d.status },
    { head: 'ครบกำหนด', width: 13, get: (d) => (d.due_date ? fmtThaiDateShort(d.due_date) : '') },
    { head: 'วันที่ลงทะเบียน', width: 15, get: (d) => fmtThaiDateShort(d.created_at) },
  ];
}

// ชื่อไฟล์บอกให้ครบว่าเป็นทะเบียนอะไร ช่วงไหน ส่งออกวันไหน — ธุรการเก็บไฟล์หลายรอบไว้ในโฟลเดอร์เดียวกัน
// ถ้าชื่อเหมือนกันหมดจะกลายเป็น documents(1).xlsx, documents(2).xlsx ที่แยกไม่ออกว่าอันไหนคืออันไหน
function exportFilename(query, ext) {
  const kind = { incoming: 'ทะเบียนหนังสือรับ', outgoing: 'ทะเบียนหนังสือส่ง', all: 'ผลการค้นหาทะเบียนหนังสือ' }[query.direction];
  const range = query.f.from || query.f.to ? `_${query.f.from || 'เริ่มต้น'}_ถึง_${query.f.to || 'ปัจจุบัน'}` : '';
  return `${kind}${range}_ณ_${todayInBangkok()}.${ext}`;
}

router.get('/documents/export.xlsx', requirePage((ctx) => {
  const query = buildDocumentQuery(ctx.user, ctx.query);
  // กรองซ้ำด้วยตัวตรวจรายฉบับอีกชั้นเหมือนหน้ารายการ — ไฟล์ที่ส่งออกไปแล้วเรียกคืนไม่ได้ ถ้าหนังสือลับ
  // หลุดติดไปในไฟล์ที่ถูกส่งต่อทางไลน์/อีเมล จะไม่มีทางแก้ย้อนหลังได้เลย
  const rows = listDocuments(query).filter((d) => canUserSeeDocument(ctx.user, d));
  const cols = registerColumns(query.direction);
  const buf = buildXlsx({
    sheetName: { incoming: 'ทะเบียนหนังสือรับ', outgoing: 'ทะเบียนหนังสือส่ง', all: 'ผลการค้นหา' }[query.direction],
    header: cols.map((c) => c.head),
    widths: cols.map((c) => c.width),
    rows: rows.map((d) => cols.map((c) => c.get(d))),
  });
  audit({
    userId: ctx.user.id, action: 'register_exported',
    detail: { format: 'xlsx', direction: query.direction, rows: rows.length, filters: describeFilters(query) || null },
    ip: ctx.ip,
  });
  ctx.res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buf.length,
    'Content-Disposition': contentDispositionHeader(exportFilename(query, 'xlsx'), 'document-register.xlsx', 'attachment'),
  });
  ctx.res.end(buf);
}));

// หน้าพิมพ์ทะเบียน — ไม่ได้สร้าง PDF ฝั่งเซิร์ฟเวอร์โดยตั้งใจ ให้เบราว์เซอร์สั่งพิมพ์แล้วเลือก
// "บันทึกเป็น PDF" แทน เพราะ (1) ทุกเบราว์เซอร์ทำได้อยู่แล้วทั้งบนเครื่องและมือถือ (2) ฟอนต์ไทยที่ใช้
// เป็นฟอนต์ในเครื่องผู้ใช้เอง ไม่ต้องพึ่ง chromium บนเซิร์ฟเวอร์ที่อาจไม่มีฟอนต์ไทยติดตั้ง และ
// (3) ทะเบียนพันแถวไม่ต้องไปเบียดเวลาประมวลผลกับการประทับตราลงไฟล์ PDF ซึ่งใช้ chromium ตัวเดียวกัน
router.get('/documents/register', requirePage((ctx) => {
  const query = buildDocumentQuery(ctx.user, ctx.query);
  const rows = listDocuments(query).filter((d) => canUserSeeDocument(ctx.user, d));
  const cols = registerColumns(query.direction);
  const filterNote = describeFilters(query);
  const title = { incoming: 'ทะเบียนหนังสือรับ', outgoing: 'ทะเบียนหนังสือส่ง', all: 'ผลการค้นหาทะเบียนหนังสือ' }[query.direction];

  // ตั้งความกว้างคอลัมน์ตายตัว โดยเทียบสัดส่วนจากความกว้างชุดเดียวกับที่ใช้ในไฟล์ Excel — ถ้าปล่อยให้
  // เบราว์เซอร์จัดเอง คอลัมน์ที่บังเอิญว่างทั้งแถบ (เช่น "ลงวันที่" ตอนที่ยังไม่มีใครกรอก) จะถูกบีบจน
  // หัวตารางแตกเป็นตัวอักษรเรียงลงมาแนวตั้ง อ่านไม่ออก
  const SEQ_WEIGHT = 8;
  const weightSum = SEQ_WEIGHT + cols.reduce((s, c) => s + c.width, 0);
  const colWidths = [SEQ_WEIGHT, ...cols.map((c) => c.width)].map((w) => ((w / weightSum) * 100).toFixed(2));

  audit({
    userId: ctx.user.id, action: 'register_exported',
    detail: { format: 'print', direction: query.direction, rows: rows.length, filters: filterNote || null },
    ip: ctx.ip,
  });

  const body = `<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<style>
  /* แนวนอนเพราะทะเบียนมี 11 คอลัมน์ ถ้าพิมพ์แนวตั้งช่อง "เรื่อง" จะแคบจนอ่านไม่ออก */
  @page { size: A4 landscape; margin: 12mm 10mm; }
  body { font-family: "Sarabun", "TH SarabunPSK", "Noto Sans Thai", sans-serif; font-size: 12px; line-height: 1.5; color: #000; margin: 0; padding: 1rem; }
  .sheet-head { text-align: center; margin-bottom: .8rem; }
  .sheet-head h1 { font-size: 17px; margin: 0 0 .15rem; }
  .sheet-head .sub { font-size: 13px; }
  .sheet-head .meta { font-size: 11px; color: #333; margin-top: .3rem; }
  table { border-collapse: collapse; width: 100%; table-layout: fixed; }
  th, td { border: 1px solid #000; padding: 3px 5px; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #eee; font-weight: 700; text-align: center; }
  /* ให้หัวตารางซ้ำทุกหน้าเวลาพิมพ์ และไม่ให้แถวถูกตัดครึ่งคาบหน้ากระดาษ */
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  td.num { text-align: center; white-space: nowrap; }
  .sign { margin-top: 1.6rem; display: flex; justify-content: flex-end; }
  .sign .box { text-align: center; font-size: 12px; min-width: 240px; }
  .sign .line { margin-top: 2.2rem; }
  .toolbar { margin-bottom: 1rem; display: flex; gap: .5rem; }
  .toolbar button, .toolbar a {
    font: inherit; padding: .45rem .9rem; border-radius: 8px; border: 1px solid #888;
    background: #f3f3f3; color: #000; cursor: pointer; text-decoration: none;
  }
  .empty { padding: 2rem; text-align: center; color: #555; }
  @media print { .toolbar { display: none; } body { padding: 0; } }
</style></head>
<body>
  <div class="toolbar">
    <button type="button" onclick="window.print()">🖨️ พิมพ์ / บันทึกเป็น PDF</button>
    <a href="/documents?direction=${query.direction}">← กลับทะเบียนในระบบ</a>
  </div>
  <div class="sheet-head">
    <h1>${esc(title)}</h1>
    <div class="sub">${esc(SCHOOL_NAME)}</div>
    <div class="meta">
      รวม ${rows.length} ฉบับ · พิมพ์เมื่อ ${esc(fmtThaiDateLong(todayInBangkok()))}
      ${filterNote ? ` · เงื่อนไข: ${esc(filterNote)}` : ''}
    </div>
  </div>
  ${rows.length ? `<table>
    <colgroup>${colWidths.map((w) => `<col style="width:${w}%" />`).join('')}</colgroup>
    <thead><tr><th>ลำดับ</th>${cols.map((c) => `<th>${esc(c.head)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((d, i) => `<tr>
      <td class="num">${i + 1}</td>
      ${cols.map((c, ci) => `<td${ci === 4 ? '' : ' class="num"'}>${esc(c.get(d))}</td>`).join('')}
    </tr>`).join('')}</tbody>
  </table>
  <div class="sign"><div class="box">
    <div class="line">ลงชื่อ ................................................ ผู้จัดทำ</div>
    <div>( ................................................ )</div>
    <div>ตำแหน่ง ................................................</div>
  </div></div>`
  : '<div class="empty">ไม่มีรายการตามเงื่อนไขที่เลือก</div>'}
</body></html>`;
  html(ctx, 200, body);
}));

router.post('/documents/:id/attachments', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  // ที่นี่ยังไม่ได้บันทึกอะไรเลย ปฏิเสธไปตรงๆ ได้ ไม่มีอะไรเสียหาย
  if (isEmptyUpload(ctx.body)) throw httpError(400, EMPTY_UPLOAD_MESSAGE);
  const att = await saveAttachment({ documentId: doc.id, fileName: ctx.body.fileName, fileType: ctx.body.fileType, fileDataBase64: ctx.body.fileDataBase64, uploader: ctx.user });
  json(ctx, 200, { redirect: `/documents/${doc.id}${att?.duplicateWarning ? '?warn=' + encodeURIComponent(att.duplicateWarning) : ''}` });
}));

// ---------------- print view: หนังสือ/บันทึกข้อความรูปแบบทางการ พร้อมลายเซ็นทุกขั้นตอน ----------------
// รูปแบบอ้างอิงระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ พ.ศ. 2526 ภาคผนวก 4 (บันทึกข้อความ):
// ส่วนราชการ / ที่ / วันที่ / เรื่อง / เรียน ตามลำดับ ตามด้วยเนื้อความ แล้วจบด้วยบล็อกลงชื่อ-ตำแหน่ง
router.get('/documents/:id/print', requirePage((ctx) => {
  const doc = db.prepare(`
    SELECT d.*, dt.name as type_name, dep.name as dept_name, u.first_name as creator_first, u.last_name as creator_last
    FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id JOIN departments dep ON dep.id = d.department_id
    JOIN users u ON u.id = d.created_by WHERE d.id = ? AND d.deleted_at IS NULL
  `).get(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) {
    return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบเอกสาร', path: '/documents',
      content: emptyState('🔍', 'ไม่พบเอกสารนี้ หรือคุณไม่มีสิทธิ์เข้าถึง') }));
  }
  const steps = getWorkflowSteps(doc.id);
  // เดิมกรอง `&& s.signature_image` ด้วย ทำให้หนังสือที่ ผอ. กับหัวหน้าฝ่ายลงนามด้วย PIN ครบแล้ว แต่ยังไม่มี
  // ใครอัปโหลดรูปลายเซ็นไว้ในโปรไฟล์ พิมพ์ออกมาแล้วขึ้นว่า "ยังไม่มีผู้ลงนามในขั้นตอนใดเลย" — ไม่มีทั้งชื่อ
  // ผู้อนุมัติและเส้นให้เซ็นด้วยปากกา ซึ่งเป็นวิธีที่โรงเรียนใช้จริงเป็นหลัก (ส่วนใหญ่ไม่ได้สแกนลายเซ็นเก็บไว้)
  // ตอนนี้ขึ้นบล็อกผู้ลงนามทุกขั้นที่ลงนามแล้ว มีรูปก็ใส่รูป ไม่มีก็เว้นที่ว่างไว้ให้เซ็นสด
  const signedSteps = steps.filter(isSignedStep);

  // เรียน: หนังสือส่ง -> หน่วยงาน/บุคคลปลายทางจริง; หนังสือรับ -> ผู้รับขั้นแรกในสายงาน (คนที่บันทึกนี้
  // ถูกเสนอให้ภายในโรงเรียน) เพราะ correspondent_name ของหนังสือรับคือ "ผู้ส่งจากภายนอก" ไม่ใช่ผู้รับ
  //
  // ใช้ signerIdentity เหมือนบล็อกลายเซ็น เพื่อให้บรรทัด "เรียน" ของหนังสือที่ดำเนินการจบไปแล้วคงเดิม
  // แม้เจ้าตัวจะเปลี่ยนชื่อ/ย้ายโรงเรียนภายหลัง (ถ้าขั้นนั้นยังไม่ได้ลงนาม ก็ยังเป็นชื่อปัจจุบันตามเดิม)
  const addressee = doc.direction === 'outgoing'
    ? doc.correspondent_name
    : (steps[0] ? signerIdentity(steps[0]).name : 'ผู้เกี่ยวข้อง');

  const referenceLine = doc.direction === 'incoming'
    ? `<p>อ้างถึง หนังสือจาก ${esc(doc.correspondent_name)}${doc.external_doc_number ? ` ที่ ${esc(doc.external_doc_number)}` : ''}${doc.external_doc_date ? ` ลงวันที่ ${fmtThaiDateLong(doc.external_doc_date)}` : ''}</p>`
    : '';

  const signatureBlocksHtml = signedSteps.length ? signedSteps.map((s) => {
    const who = signerIdentity(s);
    return `
    <div class="sig-block">
      ${s.signature_image
        ? `<img src="${esc(s.signature_image)}" alt="ลายเซ็น ${esc(who.name)}" />`
        : '<div class="sig-space"></div>'}
      <div class="sig-line">(${esc(who.name)})</div>
      ${who.position ? `<div class="sig-line">${esc(who.position)}</div>` : ''}
      <div class="sig-line">${fmtThaiDateLong(s.decided_at)}</div>
    </div>`;
  }).join('') : '<p class="text-muted" style="text-align:center;padding:1rem 0">ยังไม่มีผู้ลงนามในขั้นตอนใดเลย</p>';

  const content = `<!doctype html>
<html lang="th"><head><meta charset="utf-8" />
<title>${esc(doc.doc_number_display)} — พิมพ์เอกสาร</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Noto Sans Thai", "TH Sarabun New", "Sarabun", sans-serif; font-size: 16pt; line-height: 1.7; max-width: 210mm; margin: 0 auto; padding: 20mm 20mm; color: #111; }
  .toolbar { display: flex; justify-content: flex-end; gap: .5rem; margin-bottom: 1.5rem; }
  .toolbar button, .toolbar a { font-family: inherit; font-size: 11pt; padding: .5rem 1rem; border-radius: 8px; border: 1px solid #ccc; background: #f4f4f4; cursor: pointer; text-decoration: none; color: #111; }
  h1 { text-align: center; font-size: 22pt; margin: 0 0 1.2rem; }
  .header-row { display: flex; justify-content: space-between; gap: 1rem; }
  .field-label { font-weight: 700; }
  p { margin: .3rem 0; }
  .body-text { margin: 1.2rem 0; text-indent: 2.5em; white-space: pre-wrap; }
  .sig-block { text-align: center; margin: 0 0 0 auto; width: 220px; margin-top: 2.5rem; }
  .sig-block img { max-height: 70px; max-width: 200px; }
  /* ผู้ลงนามที่ไม่ได้เก็บรูปลายเซ็นไว้ในโปรไฟล์ — เว้นช่องสูงเท่ารูปไว้ให้เซ็นด้วยปากกาบนกระดาษที่พิมพ์ออกมา */
  .sig-block .sig-space { height: 70px; }
  .sig-line { border-top: 1px dotted #111; margin-top: .3rem; padding-top: .2rem; font-size: 14pt; }
  .sig-block .sig-line:first-of-type { border-top: none; margin-top: 0; padding-top: 0; }
  @media print {
    .toolbar { display: none; }
    body { padding: 0; }
  }
</style>
</head>
<body>
  <div class="toolbar">
    <a href="/documents/${doc.id}">← กลับหน้าเอกสาร</a>
    <button onclick="window.print()">🖨️ พิมพ์ / บันทึกเป็น PDF</button>
  </div>
  <h1>บันทึกข้อความ</h1>
  <p><span class="field-label">ส่วนราชการ</span> ${esc(doc.dept_name)} ${esc(SCHOOL_NAME)}</p>
  <div class="header-row">
    <p><span class="field-label">ที่</span> ${esc(doc.doc_number_display)}</p>
    <p><span class="field-label">วันที่</span> ${fmtThaiDateLong(doc.created_at)}</p>
  </div>
  <p><span class="field-label">เรื่อง</span> ${esc(doc.title)}</p>
  <p><span class="field-label">เรียน</span> ${esc(addressee)}</p>
  ${referenceLine}
  <div class="body-text">${esc(doc.subject || doc.title)}</div>
  ${signatureBlocksHtml}
</body></html>`;
  html(ctx, 200, content);
}));

// ---------------- detail ----------------
router.get('/documents/:id', requirePage((ctx) => {
  const doc = db.prepare(`
    SELECT d.*, dt.name as type_name, dep.name as dept_name, u.first_name as creator_first, u.last_name as creator_last
    FROM documents d JOIN document_types dt ON dt.id = d.doc_type_id JOIN departments dep ON dep.id = d.department_id
    JOIN users u ON u.id = d.created_by WHERE d.id = ? AND d.deleted_at IS NULL
  `).get(ctx.params.id);

  if (!doc || !canUserSeeDocument(ctx.user, doc)) {
    return html(ctx, 404, layout({ user: ctx.user, title: 'ไม่พบเอกสาร', path: '/documents',
      content: emptyState('🔍', 'ไม่พบเอกสารนี้ หรือคุณไม่มีสิทธิ์เข้าถึง') }));
  }

  const attachments = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at').all(doc.id);
  const steps = getWorkflowSteps(doc.id);
  const step = currentStep(doc.id);
  const comments = db.prepare(`
    SELECT c.*, u.first_name, u.last_name FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.document_id = ? ORDER BY c.created_at`).all(doc.id);

  const isDirectAssignee = step && step.assignee_id === ctx.user.id;
  // "รักษาการแทน" — ถ้าไม่ใช่ผู้ถูกมอบหมายโดยตรง เช็คว่าเป็นผู้รักษาการแทนคนที่ถือขั้นตอนนี้อยู่หรือไม่
  const delegationForStep = !isDirectAssignee && step ? getActiveDelegateFor(step.assignee_id) : null;
  const isDelegateForStep = !!(delegationForStep && delegationForStep.delegate_id === ctx.user.id);
  const isCurrentAssignee = isDirectAssignee || isDelegateForStep;
  const stepAssignee = step ? db.prepare('SELECT prefix, first_name, last_name FROM users WHERE id = ?').get(step.assignee_id) : null;
  // ข้อความหัวกล่องความเห็นในตัวอย่างบนเว็บ ต้องตรงกับที่จะฝังจริงตอนกดปุ่ม (ดู stampDirectorDecisionIfApplicable)
  const decisionBoxMode = step ? directorTitleMode(step.id, ctx.user) : 'generic';
  const decisionBoxTitleHtml = decisionBoxMode === 'director' ? esc(`ผู้อำนวยการ${SCHOOL_NAME}`)
    : decisionBoxMode === 'acting_director' ? esc('รักษาการในตำแหน่งผู้อำนวยการสถานศึกษา') + '<br/>' + esc(SCHOOL_NAME)
    : esc(SCHOOL_NAME);
  // เฉพาะ ผอ. ตัวจริง/ผู้รักษาการแทน ผอ. เท่านั้นที่มีเมนูตัดสินใจแบบเต็ม (checkbox ตราประทับ, ความเห็น,
  // อนุมัติ/ไม่อนุมัติ/ส่งกลับแก้ไข) — คนอื่นในสาย workflow มีแค่ "ทราบ" กับ "มอบหมายให้" พอ เพราะตราประทับ
  // ความเห็นทางการเป็นของ ผอ. คนเดียว ไม่ใช่ของทุกคนที่ผ่านเรื่อง
  const isDirectorDecision = decisionBoxMode === 'director' || decisionBoxMode === 'acting_director';
  // ธุรการต้องเขียนความเห็นเสนอ ผอ. ด้วย — เงื่อนไขเดียวกับที่บังคับฝั่งเซิร์ฟเวอร์ใน
  // canWriteRegistrarComment() เพื่อไม่ให้ช่องกรอกโผล่มาแล้วกดไปเงียบๆ โดยไม่มีอะไรติดลงไฟล์
  const isRegistrarComment = !!step && !isDirectorDecision && ctx.user.roleCodes.includes('registrar');
  const isCreatorOrAdmin = doc.created_by === ctx.user.id || ctx.user.roleCodes.includes('admin');
  const canAssign = ['registered', 'returned'].includes(doc.status) && isCreatorOrAdmin;
  const canVoid = ['draft', 'registered'].includes(doc.status) && isCreatorOrAdmin;
  const canArchive = doc.status === 'completed' && isCreatorOrAdmin;
  const canForceDelete = ctx.user.roleCodes.includes('admin');

  const timelineHtml = steps.length ? `<ul class="timeline">
    ${steps.map((s) => {
      const cls = s.status === 'waiting' ? '' : (s.status === 'rejected' || s.status === 'returned' ? 'rejected' : 'done');
      const statusText = { waiting: 'รอดำเนินการ', approved: 'อนุมัติ ส่งต่อแล้ว', acknowledged: 'รับทราบ/เสร็จสิ้น', rejected: 'ไม่อนุมัติ', returned: 'ส่งกลับแก้ไข' }[s.status];
      // ขั้นที่ลงนามแล้วต้องขึ้นบล็อกหลักฐานเสมอ ไม่ใช่เฉพาะคนที่มีรูปลายเซ็น — คนที่ยืนยันด้วย PIN
      // อย่างเดียวก็ลงนามโดยสมบูรณ์เท่ากัน และชื่อ/ตำแหน่งต้องเป็นสำเนา ณ วันที่ลงนาม (ดู signerIdentity)
      const signed = isSignedStep(s);
      const who = signerIdentity(s);
      return `<li class="${cls}">
        <div class="t-title">ขั้นที่ ${s.step_order}: ${esc(s.prefix || '')}${esc(s.first_name)} ${esc(s.last_name)} — ${statusText}</div>
        <div class="t-meta">มอบหมาย ${fmtDate(s.created_at)}${s.decided_at ? ' · ดำเนินการ ' + fmtDate(s.decided_at) : ''}</div>
        ${s.instruction ? `<div class="t-note">${esc(s.instruction).replace(/\n/g, '<br/>')}</div>` : ''}
        ${signed ? `
        <div class="t-note" style="text-align:center;max-width:220px;margin-top:.4rem;color:var(--primary)">
          ${s.signature_image
            ? `<img src="${esc(s.signature_image)}" alt="ลายเซ็น ${esc(who.name)}" style="max-height:60px;max-width:180px" />`
            : '<div style="font-size:.78rem;opacity:.75">🔐 ลงนามด้วย PIN</div>'}
          <div style="border-top:1px solid var(--primary);padding-top:.25rem;font-size:.82rem">
            <div>(${esc(who.name)})</div>
            ${who.position ? `<div>${esc(who.position)}</div>` : ''}
            <div>${fmtThaiDateLong(s.decided_at)}</div>
          </div>
        </div>` : ''}
      </li>`;
    }).join('')}
  </ul>` : emptyState('🕒', 'ยังไม่มีการมอบหมายงาน (Workflow)');

  const actionBox = isCurrentAssignee ? `
    <div class="card" style="border-color:var(--primary)">
      <h3>ดำเนินการ (ขั้นที่ ${step.step_order} — มอบหมายให้คุณ)</h3>
      ${isDelegateForStep ? `<div class="alert alert-warning" style="margin-bottom:.8rem">
        🪪 คุณกำลังดำเนินการแทน <strong>${esc(stepAssignee?.prefix || '')}${esc(stepAssignee?.first_name)} ${esc(stepAssignee?.last_name)}</strong>
        ในฐานะผู้รักษาการแทน (${esc(fmtThaiDateShort(delegationForStep.start_date))} — ${esc(fmtThaiDateShort(delegationForStep.end_date))}${delegationForStep.reason ? ' · ' + esc(delegationForStep.reason) : ''})
      </div>` : ''}
      <div class="stack">
        <div>
          <label><span class="step-num">1</span> ${isDirectorDecision ? 'ส่งต่อ/อนุมัติไปยัง' : 'มอบหมายให้'} <span class="text-muted" style="font-weight:400">(ไม่เลือกก็ได้ ถ้าจบที่คุณ)</span></label>
          <select id="nextAssignee"><option value="">— ไม่ส่งต่อ จบเรื่องที่ฉัน —</option>${listUserOptions(ctx.user.id)}</select>
        </div>
        ${attachments.length && isRegistrarComment ? `
        <div class="field">
          <div class="flex items-center justify-between gap-2" style="flex-wrap:nowrap">
            <label style="margin-bottom:0"><span class="step-num">2</span> ความเห็นธุรการ เสนอ ผอ. <span class="text-muted" style="font-weight:400">(เว้นว่างได้)</span></label>
            <button type="button" class="btn btn-outline btn-sm" style="flex:0 0 auto;white-space:nowrap" onclick="window.clearRegistrarNote()">🗑️ ล้างค่า</button>
          </div>
          <div class="chip-row" style="margin:.4rem 0">
            <button type="button" class="btn btn-outline btn-sm" onclick="insertRegistrarPhrase('เพื่อโปรดทราบ')">เพื่อโปรดทราบ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertRegistrarPhrase('เพื่อโปรดพิจารณา')">เพื่อโปรดพิจารณา</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertRegistrarPhrase('เห็นควรมอบ', 'ดำเนินการ')">เห็นควรมอบ...ดำเนินการ</button>
            <button type="button" class="btn btn-outline btn-sm" onclick="insertRegistrarPhrase('เห็นควรแจ้งคณะครูทราบโดยทั่วกัน')">แจ้งคณะครูทราบ</button>
          </div>
          <textarea id="registrarNote" placeholder="พิมพ์ความเห็นที่จะเสนอ ผอ. — จะขึ้นบนไฟล์ PDF จริงมุมขวาล่าง"
                    oninput="window.updateRegistrarPreview && window.updateRegistrarPreview()"></textarea>
          <div class="callout-tip">
            ✍️ ระบบจะพิมพ์ลงไฟล์ PDF จริงให้เป็น 3 ส่วน — บรรทัดแรก <strong>“เรียนผู้อำนวยการโรงเรียน”</strong>
            บรรทัดถัดมาคือความเห็นที่พิมพ์ไว้ แล้วปิดท้ายด้วย<strong>ลายเซ็นและตำแหน่งของคุณ</strong>
            ${ctx.user.signature_image ? '' : '<br/><span style="color:var(--danger)">⚠️ คุณยังไม่ได้บันทึกลายเซ็นในโปรไฟล์ — ความเห็นจะขึ้นแต่จะไม่มีลายเซ็น</span>'}
          </div>
        </div>` : ''}
        ${attachments.length && isDirectorDecision ? `
        <div class="field">
          <label><span class="step-num">2</span> เครื่องหมายบนตราประทับ <span class="text-muted" style="font-weight:400">(ติ๊กได้หลายอัน — เฉพาะอันที่ติ๊กจะขึ้นบนตราใน PDF จริง)</span></label>
          <div class="stack" style="gap:.35rem">
            ${(() => {
              const tick = (m) => `<input type="checkbox" class="decisionMark" value="${esc(m.value)}" onchange="window.updateDecisionMarksPreview && window.updateDecisionMarksPreview()" />`;
              const body = (m) => (m.fillable
                ? `<span>แจ้งให้</span>
                   <input type="text" id="decisionNotify" placeholder="ระบุชื่อ/ฝ่าย" style="max-width:180px"
                          oninput="window.updateDecisionMarksPreview && window.updateDecisionMarksPreview()" />
                   <span>ทราบ</span>`
                : esc(m.label));
              // อนุญาต/ไม่อนุญาต และ อนุมัติ/ไม่อนุมัติ วางคู่กันในบรรทัดเดียวเหมือนตรายางจริง —
              // ตัวที่ถูกจับคู่เข้าไปแล้ว (pairedInto) ไม่ต้องขึ้นเป็นบรรทัดของตัวเองซ้ำอีก
              return DECISION_MARK_OPTIONS.filter((m) => !m.pairedInto).map((m) => {
                const pair = m.pairWith && DECISION_MARK_OPTIONS.find((x) => x.value === m.pairWith);
                return `<label style="display:flex;align-items:center;gap:.4rem;font-weight:400;cursor:pointer">
                  ${tick(m)}${body(m)}
                  ${pair ? `<span style="width:.9rem"></span>${tick(pair)}${esc(pair.label)}` : ''}
                </label>`;
              }).join('');
            })()}
          </div>
        </div>
        <div class="field">
          <div class="flex items-center justify-between gap-2" style="flex-wrap:nowrap">
            <label style="margin-bottom:0"><span class="step-num">3</span> ข้อความบนตราประทับ "เห็นควรให้..." <span class="text-muted" style="font-weight:400">(เว้นว่างได้)</span></label>
            <button type="button" class="btn btn-outline btn-sm" style="flex:0 0 auto;white-space:nowrap" onclick="window.clearDecisionInputs()">🗑️ ล้างค่า</button>
          </div>
          <textarea id="decisionNote" placeholder="พิมพ์ข้อความที่จะแสดงบนตราประทับในไฟล์ PDF จริง" oninput="window.updateDecisionMarksPreview && window.updateDecisionMarksPreview()"></textarea>
          <div class="callout-tip">
            💡 กด <strong>👁️ ดูตัวอย่าง</strong> ที่ไฟล์แนบไฟล์แรก เพื่อดูว่าตราประทับจะออกมาหน้าตาแบบไหนก่อนกดยืนยัน
          </div>
          <div class="help-text">ติ๊กผิด/พิมพ์ผิดกด "ล้างค่า" ได้ทุกเมื่อ ยังไม่มีผลจนกว่าจะกดปุ่มด้านล่าง</div>
        </div>` : ''}
        <div class="action-buttons">
          ${isDirectorDecision ? `
          <button class="btn btn-success btn-lg" data-pin-title="ยืนยัน PIN เพื่ออนุมัติและส่งต่อ" onclick="doApprove(this)">✅ อนุมัติและส่งต่อ</button>
          <button class="btn btn-primary btn-lg" data-pin-title="ยืนยัน PIN เพื่อรับทราบและปิดเรื่อง" onclick="doAcknowledge(this)">✔️ รับทราบ/ปิดเรื่อง</button>
          <div class="action-buttons-secondary">
            <button class="btn btn-outline btn-sm" onclick="actionWithReason(this, '/documents/${doc.id}/workflow/${step.id}/return', 'ระบุเหตุผลที่ส่งกลับแก้ไข')">↩️ ส่งกลับแก้ไข</button>
            <button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)" onclick="doReject(this)">✖️ ไม่อนุมัติ</button>
          </div>` : `
          <button class="btn btn-success btn-lg" data-pin-title="ยืนยัน PIN เพื่อมอบหมายให้" onclick="doApprove(this)">➡️ มอบหมายให้</button>
          <button class="btn btn-primary btn-lg" data-pin-title="ยืนยัน PIN เพื่อทราบ" onclick="doAcknowledge(this)">✔️ ทราบ</button>`}
        </div>
        <div class="help-text" style="text-align:center">ทุกปุ่มต้องยืนยันด้วย PIN 6 หลักก่อนเสมอ</div>
      </div>
    </div>
    <script>
      // ตำแหน่งกล่องทุกอันเป็นค่าตายตัวฝั่งเซิร์ฟเวอร์แล้ว ที่นี่ส่งไปแค่เนื้อหาที่ผู้ใช้พิมพ์/ติ๊กเอง
      function stampPositionFields(){
        var f = {};
        var noteEl = document.getElementById('decisionNote');
        if (noteEl && noteEl.value.trim()) f.decisionNote = noteEl.value.trim();
        var checkedMarks = Array.prototype.slice.call(document.querySelectorAll('.decisionMark:checked')).map(function (el) { return el.value; });
        if (checkedMarks.length) f.decisionMarks = checkedMarks;
        var notifyEl = document.getElementById('decisionNotify');
        if (notifyEl && notifyEl.value.trim()) f.decisionNotify = notifyEl.value.trim();
        var regEl = document.getElementById('registrarNote');
        if (regEl && regEl.value.trim()) f.registrarNote = regEl.value.trim();
        return f;
      }
      // แทรกคำที่ธุรการใช้บ่อยลงในช่องความเห็นเสนอ ผอ. ไม่ทับของเดิม เพิ่มขึ้นบรรทัดใหม่ พิมพ์ต่อได้ตามปกติ
      function insertRegistrarPhrase(head, tail){
        var el = document.getElementById('registrarNote');
        var sep = el.value.trim() ? '\\n' : '';
        var insertPos = el.value.length + sep.length + head.length;
        el.value = el.value + sep + head + (tail || '');
        el.focus();
        el.setSelectionRange(insertPos, insertPos);
        if (window.updateRegistrarPreview) window.updateRegistrarPreview();
      }
      // เตือนถ้าเป็น ผอ. (มี checkbox ให้ติ๊ก) แต่ยังไม่ได้ติ๊กอะไรเลย — เผื่อลืมติ๊กเพราะเป็นคนละจุดกับปุ่ม
      // ดำเนินการ ไม่บล็อก แค่ถามยืนยันอีกที ถ้าไม่ใช่ ผอ. (ไม่มี checkbox ในหน้าเลย) ผ่านไปได้ปกติ
      function confirmIfNoMarksChecked(){
        var allMarks = document.querySelectorAll('.decisionMark');
        if (!allMarks.length || document.querySelectorAll('.decisionMark:checked').length) return true;
        return confirm('คุณยังไม่ได้ติ๊กเครื่องหมายใดๆ บนตราประทับเลย ต้องการดำเนินการต่อโดยไม่ติ๊กเครื่องหมายหรือไม่?');
      }
      function doApprove(btn){
        var next = document.getElementById('nextAssignee').value;
        if (!next) { toast('กรุณาเลือกผู้รับที่จะส่งต่อ ก่อนกดอนุมัติ (ถ้าเป็นผู้รับคนสุดท้ายให้กด "รับทราบ/ปิดเรื่อง" แทน)', 'warning'); return; }
        if (!confirmIfNoMarksChecked()) return;
        actionWithPin(btn, '/documents/${doc.id}/workflow/${step.id}/approve', Object.assign({ nextAssigneeId: next }, stampPositionFields()));
      }
      function doAcknowledge(btn){
        if (!confirmIfNoMarksChecked()) return;
        actionWithPin(btn, '/documents/${doc.id}/workflow/${step.id}/acknowledge', stampPositionFields(), '/?celebrate=1');
      }
      function doReject(btn){
        if (!confirmIfNoMarksChecked()) return;
        actionWithReason(btn, '/documents/${doc.id}/workflow/${step.id}/reject', 'ระบุเหตุผลที่ไม่อนุมัติ', stampPositionFields());
      }
    </script>` : '';

  // หนังสือค้างอยู่กับคนที่ปิดบัญชีไปแล้ว (ครูย้ายโรงเรียน/ลาออก) — เดิมไม่มีทางออกจากหน้าเว็บเลย
  // ไม่ว่าจะเป็นแอดมินหรือธุรการผู้บันทึก และหน้าเว็บก็ไม่บอกด้วยว่าทำไมเรื่องไม่เดิน
  const stuckHolder = step ? inactiveStepHolder(step) : null;
  const stuckHolderName = stuckHolder ? `${stuckHolder.prefix || ''}${stuckHolder.first_name} ${stuckHolder.last_name}`.trim() : '';
  const stuckBox = stuckHolder ? `
    <div class="card">
      <h3 class="mt-0">⚠️ เรื่องนี้ค้างอยู่</h3>
      <p style="margin-top:0">หนังสือฉบับนี้รออยู่ที่ <strong>${esc(stuckHolderName)}</strong>
        ซึ่ง<strong>ปิดบัญชีไปแล้ว</strong> (ย้าย/ลาออก/ถูกระงับ) จึงไม่มีใครกดดำเนินการต่อได้
        ${isCreatorOrAdmin ? 'เลือกผู้รับผิดชอบคนใหม่ด้านล่างเพื่อให้เรื่องเดินต่อ' : 'กรุณาแจ้งธุรการผู้บันทึกเรื่องนี้หรือผู้ดูแลระบบให้มอบหมายผู้รับผิดชอบคนใหม่'}
      </p>
      ${isCreatorOrAdmin ? `
      <div class="stack">
        <div class="field">
          <label>มอบหมายให้คนใหม่แทน</label>
          <select id="reassignTo">${listUserOptions(stuckHolder.id)}</select>
        </div>
        <button class="btn btn-primary" onclick="doReassign(this)">มอบหมายใหม่</button>
        <div class="help-text">ขั้นตอนเดิมยังอยู่ที่เดิม ไม่เสียลำดับการเดินหนังสือ และระบบบันทึกไว้ว่าเดิมเป็นของใคร</div>
      </div>
      <script>
        function doReassign(btn){
          var to = document.getElementById('reassignTo').value;
          if (!to) { toast('กรุณาเลือกผู้รับผิดชอบคนใหม่', 'warning'); return; }
          window.setBtnLoading(btn, 'กำลังบันทึก...');
          fetch('/documents/${doc.id}/workflow/${step.id}/reassign', {
            method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ assigneeId: to }),
          })
            .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
            .then(function(res){ if(!res.ok) throw new Error(res.d.error); location.reload(); })
            .catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
        }
      </script>` : ''}
    </div>` : '';

  const assignBox = canAssign ? `
    <div class="card">
      <h3>${doc.status === 'returned' ? 'แก้ไขแล้วเสนอใหม่' : 'เสนอ / มอบหมายงาน'}</h3>
      <div class="stack">
        <div>
          <label>มอบหมายให้</label>
          <select id="assignTo">${listUserOptions(ctx.user.id)}</select>
        </div>
        <div class="field">
          <label>ข้อความ/คำสั่ง</label>
          <textarea id="assignInstruction" placeholder="เช่น เพื่อโปรดพิจารณา"></textarea>
        </div>
        ${attachments.length && ctx.user.roleCodes.includes('registrar') ? `
        <div class="field">
          <label>ความเห็นธุรการ เสนอ ผอ. <span class="text-muted" style="font-weight:400">(เว้นว่างได้)</span></label>
          <textarea id="assignRegistrarNote" placeholder="พิมพ์ความเห็นที่จะขึ้นบนตัวหนังสือ ให้ ผอ. เห็นพร้อมกับเอกสาร"></textarea>
          <div class="callout-tip">
            ✍️ ระบบจะพิมพ์ลงไฟล์ PDF จริงที่มุมซ้ายล่าง เป็น 3 ส่วน — บรรทัดแรก <strong>“เรียนผู้อำนวยการโรงเรียน”</strong>
            บรรทัดถัดมาคือความเห็น แล้วปิดท้ายด้วย<strong>ลายเซ็นและตำแหน่งของคุณ</strong>
            ${ctx.user.signature_image ? '' : '<br/><span style="color:var(--danger)">⚠️ คุณยังไม่ได้บันทึกลายเซ็นในโปรไฟล์ — ความเห็นจะขึ้นแต่จะไม่มีลายเซ็น</span>'}
            <br/>เพราะมีลายเซ็นติดไปด้วย จึงต้องยืนยัน PIN ก่อน (ถ้าไม่เขียนความเห็น เสนอได้เลยไม่ต้องใส่ PIN)
          </div>
        </div>` : ''}
        <button class="btn btn-primary" onclick="doAssign(this)">เสนอ</button>
      </div>
    </div>
    <script>
      async function doAssign(btn){
        var assigneeId = document.getElementById('assignTo').value;
        var instruction = document.getElementById('assignInstruction').value;
        var noteEl = document.getElementById('assignRegistrarNote');
        var registrarNote = noteEl ? noteEl.value.trim() : '';
        var body = { assigneeId: assigneeId, instruction: instruction };
        // ความเห็นธุรการมีลายเซ็นติดไปลงบนตัวหนังสือ จึงต้องยืนยันตัวตนเหมือนการลงนามจุดอื่นในระบบ
        if (registrarNote) {
          var pin = await window.askPin('ยืนยัน PIN เพื่อลงความเห็นและเสนอ ผอ.');
          if (!pin) return;
          body.registrarNote = registrarNote;
          body.pin = pin;
        }
        btn.disabled = true;
        fetch('/documents/${doc.id}/assign', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) })
          .then(r => r.json().then(d => ({ok: r.ok, d})))
          .then(({ok, d}) => {
            if(!ok) throw new Error(d.error);
            if (d.warning) { window.toast(d.warning, 'warning'); setTimeout(function(){ location.reload(); }, 2500); return; }
            location.reload();
          })
          .catch(e => { toast(e.message, 'danger'); btn.disabled = false; });
      }
    </script>` : '';

  // ป้าย "เลยกำหนด/อีกกี่วัน" ขึ้นไปอยู่บนหัวเรื่องเลย เพราะเป็นข้อมูลที่ตัดสินใจว่าจะทำก่อนหรือหลัง —
  // เดิมวันครบกำหนดซ่อนอยู่กลางตารางรายละเอียด และแสดงเป็นวันที่ดิบ (2026-08-25) ไม่มีบอกว่าเหลือกี่วัน
  const docStillOpen = !['completed', 'archived', 'voided', 'destroyed', 'rejected'].includes(doc.status);
  const dueSummaryChip = doc.due_date && docStillOpen
    ? `<span class="badge ${daysUntil(doc.due_date) < 0 ? 'badge-danger' : daysUntil(doc.due_date) <= 3 ? 'badge-warning' : 'badge-muted'}">⏰ ครบกำหนด ${esc(fmtThaiDateShort(doc.due_date))}${
        daysUntil(doc.due_date) < 0 ? ` (เลยมาแล้ว ${Math.abs(daysUntil(doc.due_date))} วัน)`
          : daysUntil(doc.due_date) === 0 ? ' (วันนี้)' : ` (อีก ${daysUntil(doc.due_date)} วัน)`}</span>`
    : '';

  const content = `
    ${ctx.query.created ? '<div class="alert alert-success">✅ บันทึกและออกเลขเอกสารเรียบร้อยแล้ว</div>' : ''}
    ${ctx.query.warn ? `<div class="alert alert-warning">⚠️ ${esc(ctx.query.warn)}</div>` : ''}
    <div class="card-header">
      <div>
        <h2 class="mt-0"><span style="color:var(--primary)">${esc(doc.doc_number_display)}</span> — ${esc(doc.title)}</h2>
        <div class="chip-row">${statusBadge(doc.status)}${priorityBadge(doc.priority)}${
          // แสดงป้ายชั้นความลับเฉพาะตอนที่ "ไม่ปกติ" — เดิมขึ้น "ปกติ" ต่อท้าย "ด่วน" เสมอ
          // อ่านแล้วขัดกันเอง (ด่วน ปกติ?) ทั้งที่คนละเรื่องกัน และเป็นค่าที่ไม่ได้บอกอะไรเลย
          doc.secret_level !== 'normal' ? secretBadge(doc.secret_level) : ''
        }${dueSummaryChip}</div>
      </div>
      <div class="chip-row">
        <a class="btn btn-outline btn-sm" href="${attachments.length ? `/files/${attachments[0].id}` : `/documents/${doc.id}/print`}" target="_blank" rel="noopener">🖨️ พิมพ์เอกสาร${attachments.length ? ' (PDF ที่บันทึกไว้)' : ''}</a>
        ${attachments.length ? `<a class="btn btn-outline btn-sm" href="/documents/${doc.id}/print" target="_blank" rel="noopener">📝 บันทึกข้อความ/สรุปลายเซ็น</a>` : ''}
        ${canVoid ? `<button class="btn btn-outline btn-sm" onclick="actionWithReason(this, '/documents/${doc.id}/void', 'ระบุเหตุผลที่ยกเลิกเอกสาร (เลขที่จะยังคงอยู่ในลำดับ ไม่ถูกนำไปใช้ซ้ำ)')">ยกเลิกเอกสาร</button>` : ''}
        ${canArchive ? `<button class="btn btn-outline btn-sm" onclick="fetch('/documents/${doc.id}/archive',{method:'POST'}).then(()=>location.reload())">📦 จัดเก็บเข้าแฟ้ม</button>` : ''}
        ${canForceDelete ? `<a class="btn btn-outline btn-sm" href="/admin/audit?document=${esc(doc.id)}">🧾 ประวัติการดำเนินการ (audit)</a>` : ''}
        ${canForceDelete ? `<button class="btn btn-danger btn-sm" onclick="forceDeleteThisDoc(this)">🗑️ ลบเอกสาร (แอดมิน)</button>` : ''}
      </div>
    </div>
    ${canForceDelete ? `<script>
      function forceDeleteThisDoc(btn){
        var reason = prompt('สำหรับผู้ดูแลระบบเท่านั้น: ระบุเหตุผลที่ลบเอกสารนี้ถาวร (ใช้กับเอกสารที่ผิดพลาด/ค้างจากบั๊กเท่านั้น เอกสารจริงควรใช้ปุ่มยกเลิก/ทำลายตามขั้นตอนปกติแทน)');
        if (reason === null) return;
        if (!confirm('ยืนยันลบเอกสารนี้ถาวร? การกระทำนี้ย้อนกลับไม่ได้')) return;
        btn.disabled = true;
        fetch('/documents/${doc.id}/force-delete', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({reason: reason}) })
          .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, d:d}; }); })
          .then(function(res){ if(!res.ok) throw new Error(res.d.error); window.location.href = '/documents'; })
          .catch(function(e){ toast(e.message, 'danger'); btn.disabled = false; });
      }
    </script>` : ''}

    <div class="grid-2 doc-detail-grid">
      <div class="doc-main">
        <div class="card">
          <h3>รายละเอียด</h3>
          <table class="table-plain" style="min-width:0">
            <tbody>
              <tr><td class="text-muted">${doc.direction === 'incoming' ? 'หน่วยงานต้นทาง' : 'หน่วยงานปลายทาง'}</td><td>${esc(doc.correspondent_name)}</td></tr>
              ${doc.external_doc_number ? `<tr><td class="text-muted">เลขหนังสืออ้างอิง</td><td>${esc(doc.external_doc_number)}</td></tr>` : ''}
              ${doc.external_doc_date ? `<tr><td class="text-muted">ลงวันที่</td><td>${esc(fmtThaiDateLong(doc.external_doc_date))}</td></tr>` : ''}
              <tr><td class="text-muted">ฝ่าย</td><td>${esc(doc.dept_name)}</td></tr>
              ${doc.due_date ? `<tr><td class="text-muted">กำหนดเสร็จ</td><td>${docStillOpen ? dueCell(doc.due_date, { long: true }) : esc(fmtThaiDateLong(doc.due_date))}</td></tr>` : ''}
              <tr><td class="text-muted">อายุการเก็บ</td><td>${esc(RETENTION_LABEL[doc.retention_class] || doc.retention_class)}${doc.retention_until ? ` (ครบกำหนด ${esc(fmtThaiDateLong(doc.retention_until))})` : ''}</td></tr>
              <tr><td class="text-muted">ผู้บันทึก</td><td>${esc(doc.creator_first)} ${esc(doc.creator_last)}</td></tr>
              <tr><td class="text-muted">วันที่บันทึก</td><td>${fmtDate(doc.created_at)}</td></tr>
            </tbody>
          </table>
          ${doc.subject ? `<p style="margin-top:.75rem"><strong>สาระสำคัญ:</strong><br/>${esc(doc.subject).replace(/\n/g, '<br/>')}</p>` : ''}
          ${doc.void_reason ? `<div class="alert alert-danger">ยกเลิกแล้ว: ${esc(doc.void_reason)}</div>` : ''}
          ${doc.status === 'destroyed' ? `<div class="alert alert-danger">🗄️ ทำลายแล้วตามมติคณะกรรมการทำลายหนังสือ เมื่อ ${fmtDate(doc.destroyed_at)} (ไฟล์แนบถูกลบออกจากระบบถาวร รายการทะเบียน/เลขที่ยังคงอยู่เป็นหลักฐาน)</div>` : ''}
        </div>

        <div class="card">
          <div class="card-header"><h3 class="mt-0">ไฟล์แนบ (${attachments.length})</h3></div>
          ${attachments.length ? attachments.map((a, i) => `
            <div style="padding:.5rem 0;border-bottom:1px solid var(--border)">
              <div class="flex items-center justify-between flex-wrap gap-2">
                <div>📄 ${esc(a.filename)} <span class="text-muted" style="font-size:.78rem">(${Math.round(a.filesize / 1024)} KB)</span>
                  ${a.stamped_storage_provider ? '<span class="badge badge-success" style="margin-left:.4rem">✅ ประทับตราแล้ว</span>' : ''}
                </div>
                <div class="chip-row">
                  ${i === 0 && doc.direction === 'incoming' && isCreatorOrAdmin ? `<button type="button" class="btn btn-sm btn-primary" onclick="applyStamp('${a.id}', this)">🖋️ ประทับตราลงไฟล์ PDF จริง</button>` : ''}
                  <button type="button" class="btn btn-sm btn-outline" onclick="togglePreview('${a.id}')">👁️ ดูตัวอย่าง</button>
                  <a class="btn btn-sm btn-outline" href="/files/${a.id}" target="_blank" rel="noopener">เปิดแท็บใหม่</a>
                  ${a.stamped_storage_provider ? `<a class="btn btn-sm btn-outline" href="/files/${a.id}?original=1" target="_blank" rel="noopener">ดูต้นฉบับ (ไม่มีตรา)</a>` : ''}
                </div>
              </div>
              <div id="preview-${a.id}" style="display:none;margin-top:.6rem"></div>
            </div>`).join('') : emptyState('📎', 'ยังไม่มีไฟล์แนบ')}
          <script>
            // ตราประทับ "ลงรับ" ซ้อนบนตัวอย่าง PDF ของไฟล์แรกเท่านั้น (แนวทางเดียวกับที่โปรแกรมสารบรรณ
            // ทั่วไปทำ — ปั๊มตราบนเอกสารต้นฉบับ) เฉพาะหนังสือรับเท่านั้น ลากวางตำแหน่งได้ (บันทึกอัตโนมัติ
            // ตอนปล่อยเมาส์) — หมายเหตุ: นี่คือการซ้อนแสดงตอนดูในแอปเท่านั้น ไม่ได้ฝังลงในไฟล์ PDF จริง
            var STAMP_DIRECTION = ${JSON.stringify(doc.direction)};

            var STAMP_X = ${doc.stamp_x != null ? doc.stamp_x : 70};
            var STAMP_Y = ${doc.stamp_y != null ? doc.stamp_y : 3};
            var STAMP_HTML = '<div class="doc-stamp doc-overlay-box" id="docStamp" data-label="ตราลงรับของธุรการ" style="left:' + STAMP_X + '%;top:' + STAMP_Y + '%">' +
              '<div class="stamp-title">${esc(SCHOOL_NAME)}</div>' +
              '<div>เลขรับ......${esc(doc.doc_number_display)}......</div>' +
              '<div>วันที่......${stampDateThai(new Date(doc.created_at))}......</div>' +
              '<div>เวลา......${stampTimeThai(new Date(doc.created_at))}......</div>' +
            '</div>';
            // ต้องประกาศก่อนสร้าง MARK_HTML/DECISION_HTML/REGISTRAR_HTML ที่เอาค่านี้ไปใส่ใน style="top:..%"
            // — var ถูก hoist ขึ้นไปด้านบนก็จริง แต่ "ค่า" ยังเป็น undefined จนกว่าจะรันบรรทัดนี้ ถ้าอยู่ทีหลัง
            // จะได้ top:undefined% ซึ่งเป็น CSS ที่ใช้ไม่ได้ เบราว์เซอร์จะทิ้งทั้งบรรทัด แล้วกล่องจะไปกองอยู่
            // ท้ายพื้นที่ตัวอย่างแทนตำแหน่งจริงที่จะประทับ — ตัวอย่างกับของจริงต้องตรงกันเสมอ
            var DECISION_MAX_TOP = ${DECISION_MAX_TOP_PERCENT};
            // ทุกกล่องอยู่ตำแหน่งตายตัวตามผังแถบล่าง (ดู pdfStamp.js) ลากย้ายเองไม่ได้แล้ว — โรงเรียนแจ้งว่า
            // ไม่ได้ใช้การลากเลย และการลากเปิดช่องให้วางทับกันเองจนอ่านไม่ออก หน้าตัวอย่างยังมีไว้ให้ดูว่า
            // ของจริงจะออกมาหน้าตาแบบไหน และเอาเมาส์ชี้กล่องไหนก็อ่านกล่องนั้นชัดๆ ได้ (ดู .doc-overlay-*)
            // ตัวอย่างช่อง "ทราบ" ต้องแสดงตรงกับที่จะประทับจริง — คำว่า "ทราบ" มีคำเดียวต่อหนังสือหนึ่งฉบับ
            // ถ้าเรามาทีหลัง จะเห็นเฉพาะช่องลายเซ็นของเราต่อจากคนก่อนหน้า ไม่มีคำว่าทราบซ้ำอีกอัน
            var CAN_MARK = ${(isCurrentAssignee && ctx.user.signature_image && !isDirectorDecision && !isRegistrarComment) ? 'true' : 'false'};
            var ACK_SIGNER_INDEX = ${attachments.length ? ackSignerIndex(attachments[0].id) : 0};
            var MARK_HTML = '<div class="doc-mark doc-overlay-box" id="ackMark" data-label="ทราบ (ลายเซ็นผู้ได้รับเอกสาร)" style="left:${DEFAULT_ACK_MARK_X_PERCENT}%;top:${attachments.length ? ackSlotTopPercent(ackSignerIndex(attachments[0].id), MARK_BASE_Y) : MARK_BASE_Y}%">' +
              (ACK_SIGNER_INDEX === 0 ? '<div class="mark-word">ทราบ</div>' : '') +
              '<div class="mark-entry">' +
                ${ctx.user.signature_image ? `'<div class="mark-sig"><img src="${esc(ctx.user.signature_image)}" /></div>' +` : "'<div class=\"mark-sig\"></div>' +"}
                '<div class="mark-name">(${esc(ctx.user.prefix || '')}${esc(ctx.user.first_name)} ${esc(ctx.user.last_name)})</div>' +
              '</div>' +
            '</div>';
            // ความเห็นธุรการเสนอ ผอ. — มุมขวาล่าง ขอบบนตรงกับกรอบตราปั๊ม ผอ. (ใช้ DECISION_MAX_TOP ตัวเดียวกัน)
            var CAN_REGISTRAR = ${(isCurrentAssignee && isRegistrarComment) ? 'true' : 'false'};
            var REGISTRAR_HTML = '<div class="doc-registrar-note doc-overlay-box" id="registrarBox" data-label="ความเห็นธุรการ เสนอ ผอ." style="left:${DEFAULT_REGISTRAR_X_PERCENT}%;top:' + DECISION_MAX_TOP + '%">' +
              '<div class="reg-lead">เรียนผู้อำนวยการโรงเรียน</div>' +
              '<div class="reg-body" id="registrarNotePreview"></div>' +
              ${ctx.user.signature_image ? `'<div class="sig"><img src="${esc(ctx.user.signature_image)}" /></div>' +` : "''+"}
              '<div class="reg-name">(${esc(ctx.user.prefix || '')}${esc(ctx.user.first_name)} ${esc(ctx.user.last_name)})</div>' +
              '<div class="reg-name">ตำแหน่ง<span class="fill">${esc(ctx.user.position || '')}</span></div>' +
            '</div>';
            // ให้ตัวอย่างบนเว็บตรงกับที่จะพิมพ์ลง PDF จริงเป๊ะ ผู้ใช้จะได้เห็นว่าความเห็นยาวเกินกรอบหรือยัง
            window.updateRegistrarPreview = function () {
              var el = document.getElementById('registrarNotePreview');
              if (!el) return;
              var input = document.getElementById('registrarNote');
              el.textContent = (input && input.value.trim()) || '(ยังไม่ได้พิมพ์ความเห็น)';
            };
            window.clearRegistrarNote = function () {
              var input = document.getElementById('registrarNote');
              if (input) input.value = '';
              window.updateRegistrarPreview();
            };
            var DECISION_HTML = '<div class="doc-decision-box doc-overlay-box" id="decisionBox" data-label="กรอบตราปั๊ม ผอ." style="left:${DEFAULT_DECISION_X_PERCENT}%;top:' + DECISION_MAX_TOP + '%">' +
              '<div class="box-title">${decisionBoxTitleHtml}</div>' +
              '<div id="decisionMarksPreview"></div>' +
              '<div class="box-note" id="decisionNotePreview">ความเห็น ...</div>' +
              ${ctx.user.signature_image ? `'<div class="sig"><img src="${esc(ctx.user.signature_image)}" /></div>' +` : "''+"}
              '<div style="margin-top:.3rem">(${esc(ctx.user.prefix || '')}${esc(ctx.user.first_name)} ${esc(ctx.user.last_name)})</div>' +
            '</div>';
            // แสดงช่องติ๊กตามที่ผู้ใช้ติ๊กไว้จริงในกล่องด้านขวา ให้ตรงกับที่จะฝังลง PDF จริงเป๊ะ (ถ้อยคำและ
            // ลำดับต้องตรงกับ DECISION_MARK_OPTIONS และ stampDirectorDecision เสมอ) — เรียกทั้งตอนเปิด
            // "ดูตัวอย่าง" ครั้งแรก และทุกครั้งที่ติ๊ก/พิมพ์ (ถ้ายังไม่เปิดกล่อง ฟังก์ชันนี้จะไม่ทำอะไรเลย)
            window.updateDecisionMarksPreview = function () {
              var el = document.getElementById('decisionMarksPreview');
              if (!el) return;
              function cb(v) {
                var box = document.querySelector('.decisionMark[value="' + v + '"]');
                return '<span class="cb' + (box && box.checked ? ' on' : '') + '"></span>';
              }
              var notifyInput = document.getElementById('decisionNotify');
              var notify = (notifyInput && notifyInput.value.trim()) || '';
              el.innerHTML =
                '<div class="opt">' + cb('ทราบ') + 'ทราบ</div>' +
                '<div class="opt">' + cb('อนุญาต') + 'อนุญาต <span class="gap"></span>' + cb('ไม่อนุญาต') + 'ไม่อนุญาต</div>' +
                '<div class="opt">' + cb('อนุมัติ') + 'อนุมัติ <span class="gap"></span>' + cb('ไม่อนุมัติ') + 'ไม่อนุมัติ</div>' +
                '<div class="opt">' + cb('เก็บรวมเรื่อง') + 'เก็บรวมเรื่อง</div>' +
                '<div class="opt">' + cb('แจ้งคณะครูทราบ') + 'แจ้งคณะครูทราบ</div>' +
                '<div class="opt">' + cb('แจ้งให้ทราบ') + 'แจ้งให้ <span class="fill">' +
                  notify.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</span> ทราบ</div>' +
                '<div class="opt">' + cb('ดำเนินการ') + 'ดำเนินการ</div>';
              var noteEl = document.getElementById('decisionNotePreview');
              var noteInput = document.getElementById('decisionNote');
              if (noteEl) noteEl.textContent = 'เห็นควรให้ ' + ((noteInput && noteInput.value.trim()) || '...');
            };
            // ล้างเครื่องหมาย/ข้อความที่ติ๊ก/พิมพ์ไว้ทั้งหมด เผื่อกดหรือพิมพ์ผิด
            window.clearDecisionInputs = function () {
              document.querySelectorAll('.decisionMark:checked').forEach(function (el) { el.checked = false; });
              var noteInput = document.getElementById('decisionNote');
              if (noteInput) noteInput.value = '';
              var notifyInput = document.getElementById('decisionNotify');
              if (notifyInput) notifyInput.value = '';
              window.updateDecisionMarksPreview();
            };
            // เดิมตรงนี้เป็นโค้ดลากกล่องไปวางเอง ถอดออกแล้วตามที่โรงเรียนแจ้งว่าไม่ได้ใช้เลย —
            // ทุกกล่องอยู่ตำแหน่งตายตัวตามผังแถบล่างใน pdfStamp.js ซึ่งคำนวณมาแล้วว่าไม่ทับกันและไม่ล้นหน้า
            window.pdfPreviewError = function(imgEl) {
              if (imgEl.dataset.errored) return;
              imgEl.dataset.errored = '1';
              var note = document.createElement('div');
              note.className = 'pdf-preview-fallback';
              note.style.cssText = 'width:100%;aspect-ratio:595/842;display:flex;align-items:center;justify-content:center;text-align:center;padding:1rem;color:var(--text-muted,#666);background:var(--bg-muted,#f4f4f4);border-radius:6px';
              note.textContent = 'ไม่สามารถแสดงตัวอย่างไฟล์ได้ (เซิร์ฟเวอร์อาจยังไม่ได้ติดตั้ง poppler-utils — ดู DEPLOY.md) — ไม่กระทบการลงนาม/ประทับตราลงไฟล์จริง ซึ่งใช้ตำแหน่งตายตัวอยู่แล้ว';
              imgEl.replaceWith(note);
            };
            window.applyStamp = function(attId, btn){
              // ให้ธุรการแก้ไขเลขรับ/เวลาที่จะแสดงบนตราได้ก่อนกดยืนยันจริง (เผื่อกด/พิมพ์ผิดตอนนี้จะได้แก้ทัน
              // ก่อนที่จะฝังลง PDF จริงแบบแก้ไม่ได้อีก) — เลขรับ default เป็นเลขที่เอกสารนี้ แต่แก้ได้ ส่วนเวลา
              // เว้นว่างได้ถ้าไม่ต้องการระบุ (จะแสดงเป็นบรรทัดว่างบนตราให้เขียนเติมเองทีหลังได้)
              var num = prompt('เลขรับที่จะแสดงบนตราประทับ (แก้ไขได้ถ้าต้องการ)', ${JSON.stringify(doc.doc_number_display)});
              if (num === null) return;
              var defaultTime = ${JSON.stringify(stampTimeThai(new Date(doc.created_at)))};
              var time = prompt('เวลาที่จะแสดงบนตราประทับ (เว้นว่างได้ถ้าไม่ต้องการระบุเวลา)', defaultTime);
              if (time === null) return;
              if (!confirm('ยืนยันประทับตรา "ลงรับ" ลงในไฟล์ PDF จริง ณ ตำแหน่งที่ลากไว้ล่าสุด?\\nระบบจะสร้างไฟล์ใหม่ที่มีตราประทับ โดยเก็บไฟล์ต้นฉบับที่ไม่มีตราไว้เหมือนเดิม')) return;
              window.setBtnLoading(btn);
              fetch('/documents/${doc.id}/attachments/' + attId + '/apply-stamp', {
                method: 'POST', headers: {'Content-Type':'application/json'},
                body: JSON.stringify({ docNumberOverride: num.trim(), timeOverride: time.trim() }),
              })
                .then(r => r.json().then(d => ({ok: r.ok, d})))
                .then(({ok, d}) => {
                  if (ok) { window.toast('ประทับตราลงไฟล์ PDF สำเร็จ', 'success'); location.reload(); }
                  else { window.restoreBtn(btn); window.toast(d.error, 'danger'); }
                })
                .catch(e => { window.restoreBtn(btn); window.toast(e.message, 'danger'); });
            };
            var CAN_DECIDE = ${(isCurrentAssignee && isDirectorDecision) ? 'true' : 'false'};
            window.togglePreview = function(id){
              var el = document.getElementById('preview-' + id);
              if (el.style.display === 'none') {
                el.style.display = '';
                if (!el.dataset.loaded) {
                  var isFirstFile = ${JSON.stringify(attachments.length ? attachments[0].id : null)} === id;
                  var showStamp = isFirstFile && STAMP_DIRECTION === 'incoming';
                  var showMark = isFirstFile && CAN_MARK;
                  var showDecision = isFirstFile && CAN_DECIDE;
                  var showRegistrar = isFirstFile && CAN_REGISTRAR;
                  el.innerHTML = '<div class="pdf-preview-wrap" id="stampWrap">' +
                    '<img class="pdf-frame" src="/files/' + id + '/preview.png" alt="ตัวอย่างไฟล์แนบ" onerror="window.pdfPreviewError(this)" />' +
                    (showStamp ? STAMP_HTML : '') +
                    (showMark ? MARK_HTML : '') +
                    (showDecision ? DECISION_HTML : '') +
                    (showRegistrar ? REGISTRAR_HTML : '') +
                  '</div>' +
                                    (showMark || showDecision || showRegistrar ? '<div class="help-text">นี่คือตัวอย่างว่าไฟล์จริงจะออกมาหน้าตาแบบไหน — เอาเมาส์ชี้กล่องไหนเพื่ออ่านกล่องนั้นชัดๆ ได้</div>' : '');
                  el.dataset.loaded = '1';
                  if (showDecision) window.updateDecisionMarksPreview();
                  if (showRegistrar) window.updateRegistrarPreview();
                }
              } else {
                el.style.display = 'none';
              }
            };
          </script>
          <form id="addAttachForm" style="margin-top:.9rem">
            <input type="file" id="addAttachInput" accept="application/pdf" onchange="attachFilePreview(this,'addAttachPreview')" />
            <div id="addAttachPreview" class="help-text"></div>
            <button class="btn btn-outline btn-sm" style="margin-top:.5rem" type="submit">แนบไฟล์เพิ่ม</button>
          </form>
          <script>
            document.getElementById('addAttachForm').addEventListener('submit', function(e){
              e.preventDefault();
              submitWithFile(this, 'addAttachInput', '/documents/${doc.id}/attachments', {});
            });
          </script>
        </div>

        <div class="card">
          <h3>ความคิดเห็น</h3>
          <div class="stack">
            ${comments.map((c) => `<div style="padding:.5rem;background:var(--surface-2);border-radius:8px">
              <strong>${esc(c.first_name)} ${esc(c.last_name)}</strong> <span class="text-muted" style="font-size:.76rem">${fmtDate(c.created_at)}</span>
              <div>${esc(c.message)}</div></div>`).join('') || '<p class="text-muted">ยังไม่มีความคิดเห็น</p>'}
          </div>
          <form id="commentForm" style="margin-top:.7rem" class="flex gap-2">
            <input type="text" id="commentInput" placeholder="แสดงความคิดเห็น..." style="flex:1" />
            <button class="btn btn-outline" type="submit">ส่ง</button>
          </form>
          <script>
            document.getElementById('commentForm').addEventListener('submit', function(e){
              e.preventDefault();
              var msg = document.getElementById('commentInput').value.trim();
              if(!msg) return;
              fetch('/documents/${doc.id}/comment', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({message: msg})})
                .then(() => location.reload());
            });
          </script>
        </div>
      </div>

      <div class="doc-side">
        ${stuckBox}
        ${actionBox}
        ${assignBox}
        <div class="card">
          <h3>Timeline การเดินหนังสือ</h3>
          ${timelineHtml}
        </div>
      </div>
    </div>`;

  html(ctx, 200, layout({ user: ctx.user, title: doc.doc_number_display, path: '/documents', content }));
}));

// ---------------- workflow actions ----------------
router.post('/documents/:id/assign', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  if (!ctx.body.assigneeId) throw httpError(400, 'กรุณาเลือกผู้รับมอบหมาย');

  // ธุรการเขียนความเห็นเสนอ ผอ. ลงบนตัวหนังสือได้ตั้งแต่ตอนส่งเรื่องขึ้นไปครั้งแรก ไม่ต้องรอให้เรื่องวน
  // กลับมาที่ตัวเอง — ผอ. จะได้เห็นความเห็นพร้อมกับตัวหนังสือตั้งแต่เปิดอ่านครั้งแรกเลย
  //
  // ความเห็นนี้มีลายเซ็นของธุรการติดไปด้วย จึงต้องยืนยัน PIN เหมือนการลงนามทุกจุดในระบบ — แต่บังคับ
  // เฉพาะเมื่อมีการเขียนความเห็นจริงๆ เท่านั้น การเสนอเปล่าๆ ยังทำได้เหมือนเดิมโดยไม่ต้องใส่ PIN
  const registrarNote = typeof ctx.body.registrarNote === 'string' ? ctx.body.registrarNote.trim() : '';
  if (registrarNote) {
    if (!canWriteRegistrarComment(null, ctx.user)) throw httpError(403, 'เฉพาะธุรการเท่านั้นที่เขียนความเห็นเสนอ ผอ. ได้');
    const { verifyPin } = await import('../auth.js');
    if (!verifyPin(ctx.user.id, ctx.body.pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
  }
  assertStampTextFits({ registrarNote });

  assignStep({ documentId: doc.id, assigneeId: ctx.body.assigneeId, instruction: ctx.body.instruction, actorUser: ctx.user });
  const warning = await stampRegistrarCommentIfApplicable({
    documentId: doc.id, stepId: null, actorUser: ctx.user, comment: registrarNote,
    registrarX: parsePercent(ctx.body.registrarX), registrarY: parsePercent(ctx.body.registrarY),
  });
  json(ctx, 200, { ok: true, warning });
}));

// ตำแหน่งลายเซ็น/กล่องความเห็นที่ผู้ใช้ลากเลือกเองในหน้าจอก่อนกดปุ่ม — undefined ถ้าไม่ได้ส่งมา (แปลว่า
// ผู้ใช้ไม่ได้ลาก ให้ pdfStamp.js ใช้ตำแหน่งเริ่มต้นของมันเอง) ไม่ใช่ error เพราะเป็นฟีเจอร์เสริม ไม่บังคับ
function parsePercent(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : undefined;
}

// รายการเครื่องหมายที่ผู้ใช้ติ๊กไว้ในกล่องความเห็น — กรองเฉพาะค่าที่รู้จัก (DECISION_MARK_OPTIONS)
// ทิ้งอย่างอื่นทั้งหมด กันกรณี client ส่งค่าแปลกปลอมมา ไม่ใช่แค่กรอง XSS (esc() จัดการอยู่แล้ว) แต่กันไม่ให้
// ค่าที่ไม่รู้จักหลุดเข้าไปปนกับ logic การเช็คใน stampDirectorDecision
function parseDecisionMarks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter((m) => DECISION_MARK_VALUES.includes(m));
}

// ชื่อผู้ที่ต้องแจ้ง ที่ผู้ใช้พิมพ์เติมในช่อง "แจ้งให้ .......... ทราบ" — จำกัดความยาวไม่ให้ล้นกรอบตรายาง
// (esc() ที่ pdfStamp.js กัน XSS อยู่แล้ว ตรงนี้กันเรื่องหน้าตาของตราที่พิมพ์ออกมาอย่างเดียว)
function parseNotifyTarget(raw) {
  if (typeof raw !== 'string') return '';
  return raw.trim().slice(0, 60);
}


router.post('/documents/:id/workflow/:stepId/approve', requireApi(async (ctx) => {
  const { pin, nextAssigneeId, comment, markX, markY, decisionX, decisionY, decisionNote, decisionMarks, decisionNotify, registrarNote, registrarX, registrarY } = ctx.body;
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
  if (!nextAssigneeId) throw httpError(400, 'กรุณาเลือกผู้รับที่จะส่งต่อ');
  assertStampTextFits({ decisionNote, registrarNote });
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  approveAndForward({ stepId: ctx.params.stepId, nextAssigneeId, comment, actorUser: ctx.user });
  const warning1 = await stampAcknowledgeMarkIfApplicable({ documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, markX: parsePercent(markX), markY: parsePercent(markY) });
  // ผอ./ผู้รักษาการแทน ผอ. ที่กด "อนุมัติและส่งต่อ" ก็ยังใส่ checkbox/ความเห็น ลงตราประทับได้เหมือนกด
  // รับทราบ/ไม่อนุมัติ — เดิม endpoint นี้ไม่เรียก stampDirectorDecisionIfApplicable เลย ทำให้ check/ข้อความ
  // ที่กรอกไว้หายไปเงียบๆ ทั้งที่ฝั่ง client ส่งมาให้อยู่แล้ว (ดู stampPositionFields ในสคริปต์ฝั่งเว็บ)
  const warning2 = await stampDirectorDecisionIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, decision: 'approve', note: decisionNote,
    marks: parseDecisionMarks(decisionMarks), notifyTarget: parseNotifyTarget(decisionNotify), decisionX: parsePercent(decisionX), decisionY: parsePercent(decisionY),
  });
  const warning3 = await stampRegistrarCommentIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, comment: registrarNote,
    registrarX: parsePercent(registrarX), registrarY: parsePercent(registrarY),
  });
  json(ctx, 200, { ok: true, warning: warning1 || warning2 || warning3 });
}));

router.post('/documents/:id/workflow/:stepId/acknowledge', requireApi(async (ctx) => {
  const { pin, comment, markX, markY, decisionX, decisionY, decisionNote, decisionMarks, decisionNotify, registrarNote, registrarX, registrarY } = ctx.body;
  const { verifyPin } = await import('../auth.js');
  if (!verifyPin(ctx.user.id, pin)) throw httpError(401, 'PIN ไม่ถูกต้อง');
  assertStampTextFits({ decisionNote, registrarNote });
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  acknowledgeAndComplete({ stepId: ctx.params.stepId, comment, actorUser: ctx.user });
  const warning1 = await stampAcknowledgeMarkIfApplicable({ documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, markX: parsePercent(markX), markY: parsePercent(markY) });
  const warning2 = await stampDirectorDecisionIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, decision: 'acknowledge', note: decisionNote,
    marks: parseDecisionMarks(decisionMarks), notifyTarget: parseNotifyTarget(decisionNotify), decisionX: parsePercent(decisionX), decisionY: parsePercent(decisionY),
  });
  const warning3 = await stampRegistrarCommentIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, comment: registrarNote,
    registrarX: parsePercent(registrarX), registrarY: parsePercent(registrarY),
  });
  json(ctx, 200, { ok: true, warning: warning1 || warning2 || warning3 });
}));

router.post('/documents/:id/workflow/:stepId/reject', requireApi(async (ctx) => {
  const { reason, markX, markY, decisionX, decisionY, decisionNote, decisionMarks, decisionNotify, registrarNote, registrarX, registrarY } = ctx.body;
  // decisionNote ว่างเปล่าจะใช้ reason แทนตอนประทับ จึงต้องตรวจ reason ตามเพดานของตราประทับด้วย
  assertStampTextFits({ decisionNote: decisionNote || reason, registrarNote });
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  rejectStep({ stepId: ctx.params.stepId, reason, actorUser: ctx.user });
  const warning1 = await stampAcknowledgeMarkIfApplicable({ documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, markX: parsePercent(markX), markY: parsePercent(markY) });
  const warning2 = await stampDirectorDecisionIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, decision: 'reject', note: decisionNote || reason,
    marks: parseDecisionMarks(decisionMarks), notifyTarget: parseNotifyTarget(decisionNotify), decisionX: parsePercent(decisionX), decisionY: parsePercent(decisionY),
  });
  const warning3 = await stampRegistrarCommentIfApplicable({
    documentId: ctx.params.id, stepId: ctx.params.stepId, actorUser: ctx.user, comment: registrarNote,
    registrarX: parsePercent(registrarX), registrarY: parsePercent(registrarY),
  });
  json(ctx, 200, { ok: true, warning: warning1 || warning2 || warning3 });
}));

router.post('/documents/:id/workflow/:stepId/return', requireApi(async (ctx) => {
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  returnStep({ stepId: ctx.params.stepId, reason: ctx.body.reason, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

// กู้หนังสือที่ค้างอยู่กับคนที่ปิดบัญชีไปแล้ว (ครูย้ายโรงเรียน/ลาออก) — ดูเหตุผลเต็มใน workflow.js
router.post('/documents/:id/workflow/:stepId/reassign', requireApi(async (ctx) => {
  assertStepBelongsToDocument(ctx.params.id, ctx.params.stepId);
  reassignStuckStep({ stepId: ctx.params.stepId, newAssigneeId: ctx.body.assigneeId, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/void', requireApi(async (ctx) => {
  voidDocument({ documentId: ctx.params.id, reason: ctx.body.reason, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/force-delete', requireApi(async (ctx) => {
  await forceDeleteDocument({ documentId: ctx.params.id, reason: ctx.body.reason, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

// ตำแหน่งตราประทับ "ลงรับ" ที่ธุรการลากวางเองบนตัวอย่าง PDF (Epic Coding Channel-style stamp) —
// เก็บเป็น % จากมุมบนซ้าย ไม่ผูกกับ pixel เพราะขนาดจอ/ระดับ zoom ของแต่ละคนต่างกัน
router.post('/documents/:id/stamp-position', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  if (doc.created_by !== ctx.user.id && !ctx.user.roleCodes.includes('admin')) {
    throw httpError(403, 'ปรับตำแหน่งตราประทับได้เฉพาะผู้บันทึกเอกสารหรือแอดมินเท่านั้น');
  }
  const x = Number(ctx.body.x);
  const y = Number(ctx.body.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) {
    throw httpError(400, 'ตำแหน่งตราประทับไม่ถูกต้อง');
  }
  db.prepare('UPDATE documents SET stamp_x = ?, stamp_y = ?, updated_at = ? WHERE id = ?').run(x, y, nowIso(), doc.id);
  audit({ userId: ctx.user.id, action: 'stamp_position_updated', tableName: 'documents', recordId: doc.id, detail: { x, y } });
  json(ctx, 200, { ok: true });
}));

// อ่านเนื้อไฟล์ดิบของไฟล์แนบจาก storage provider (ใช้ร่วมกันทั้งตอนประทับตรารับและตอนลงนามผู้อำนวยการ)
async function readAttachmentBytes(att, { preferStamped = false } = {}) {
  const useStamped = preferStamped && att.stamped_storage_provider;
  const provider = useStamped ? att.stamped_storage_provider : att.storage_provider;
  const filepath = useStamped ? att.stamped_filepath : att.filepath;
  const driveFileId = useStamped ? att.stamped_drive_file_id : att.drive_file_id;
  if (provider === 'google_drive') {
    const stream = await downloadFileStream(driveFileId);
    if (!stream) throw httpError(404, 'ไม่พบไฟล์บน Google Drive');
    const chunks = [];
    for await (const chunk of Readable.fromWeb(stream)) chunks.push(chunk);
    return Buffer.concat(chunks);
  }
  const filePath = path.join(UPLOAD_DIR, filepath);
  if (!fs.existsSync(filePath)) throw httpError(404, 'ไม่พบไฟล์');
  return fs.readFileSync(filePath);
}

// บันทึกสำเนาที่ประทับตรา/ลงนามแล้วกลับเข้า storage provider เดียวกับไฟล์ต้นฉบับ แล้วอัปเดตคอลัมน์
// stamped_* ของ attachments (เขียนทับของเดิม เพราะไฟล์ใหม่มีทั้งกล่องเดิม + กล่องใหม่ซ้อนกันอยู่แล้ว)
async function saveStampedCopy(att, stampedBuffer, yearBe) {
  // อ่านสำเนาที่ประทับไว้ก่อนหน้าจากฐานข้อมูลสดๆ ไม่ใช่จาก att ที่ส่งเข้ามา
  //
  // ตอนนี้ผู้เรียกทุกจุดอ่าน att ใหม่ก่อนใช้อยู่แล้ว ค่าจึงตรงกัน แต่ในคำขอเดียวมีการประทับซ้อนกันได้ถึง
  // 3 ชั้น (ความเห็นธุรการ → ทราบ → ตราปั๊ม ผอ.) ถ้าวันหลังมีใครรวบให้อ่าน att ครั้งเดียวแล้วส่งต่อทุกชั้น
  // เพื่อประหยัด query ค่าใน att จะเก่าตั้งแต่ชั้นที่สองทันที แล้วบรรทัดลบข้างล่างจะไปลบไฟล์ผิดตัว —
  // ลบสำเนาผิดตัวแล้วเรียกคืนไม่ได้ จึงไม่ฝากความถูกต้องไว้กับวินัยของผู้เรียก
  const prev = db.prepare('SELECT stamped_storage_provider, stamped_filepath, stamped_drive_file_id FROM attachments WHERE id = ?').get(att.id);

  if (isGoogleDriveEnabled()) {
    const folderId = await ensureCategoryFolder({ yearBe: yearBe || (new Date().getFullYear() + 543), typeName: 'ประทับตราแล้ว' });
    const driveFileId = await uploadFile({ buffer: stampedBuffer, filename: `${att.id}__stamped__${att.filename}`, mimeType: 'application/pdf', folderId });
    db.prepare(`UPDATE attachments SET stamped_storage_provider = 'google_drive', stamped_filepath = NULL, stamped_drive_file_id = ?, stamped_at = ? WHERE id = ?`)
      .run(driveFileId, nowIso(), att.id);
  } else {
    const safeName = `${att.id}-stamped.pdf`;
    fs.writeFileSync(path.join(UPLOAD_DIR, safeName), stampedBuffer);
    db.prepare(`UPDATE attachments SET stamped_storage_provider = 'local', stamped_filepath = ?, stamped_drive_file_id = NULL, stamped_at = ? WHERE id = ?`)
      .run(safeName, nowIso(), att.id);
  }

  // เก็บเฉพาะไฟล์ผลลัพธ์สุดท้าย — ทิ้งสำเนาชั้นก่อนหน้าหลังบันทึกตัวใหม่สำเร็จแล้วเท่านั้น
  //
  // เดิมอัปโหลดไฟล์ใหม่ทุกครั้งแล้วแค่ย้ายตัวชี้ในฐานข้อมูล ไฟล์เก่าจึงค้างอยู่บน Drive ตลอดไปโดยไม่มี
  // อะไรอ้างถึง หนังสือฉบับเดียวที่ผ่านมือ 5 คนก็เหลือขยะ 4 ไฟล์ กินโควตา 15GB ไปเรื่อยๆ และธุรการที่
  // เปิด Drive ดูเองจะเห็นไฟล์ชื่อเหมือนกันเรียงกันหลายอัน แยกไม่ออกว่าอันไหนคือฉบับจริง
  await deletePreviousStampedCopy(prev, att.id);
}

// ลบแบบ best-effort — ถ้าลบไม่สำเร็จก็แค่เหลือไฟล์ค้าง ไม่ควรทำให้การลงนามที่สำเร็จไปแล้วกลายเป็นล้มเหลว
async function deletePreviousStampedCopy(prev, attachmentId) {
  if (!prev) return;
  try {
    if (prev.stamped_storage_provider === 'google_drive' && prev.stamped_drive_file_id) {
      await deleteFile(prev.stamped_drive_file_id);
    } else if (prev.stamped_storage_provider === 'local' && prev.stamped_filepath) {
      // ชื่อไฟล์ local เป็น "<attachmentId>-stamped.pdf" ตัวเดิมเสมอ จึงถูกเขียนทับไปแล้ว ไม่ต้องลบซ้ำ
      const current = db.prepare('SELECT stamped_filepath FROM attachments WHERE id = ?').get(attachmentId);
      if (current?.stamped_filepath !== prev.stamped_filepath) {
        fs.rmSync(path.join(UPLOAD_DIR, prev.stamped_filepath), { force: true });
      }
    }
  } catch (err) {
    console.error(`[stamp] ลบสำเนาที่ประทับชั้นก่อนหน้าไม่สำเร็จ (${attachmentId}): ${err.message}`);
  }
}


// เครื่องหมาย "ทราบ" + ลายเซ็นแบบง่าย — ทุกคนในสาย workflow ที่ตัดสินใจ (อนุมัติ/ส่งต่อ/รับทราบ/ไม่อนุมัติ)
// ได้เครื่องหมายของตัวเองคนละอัน ไม่จำกัดแค่ผู้อำนวยการ (มีกี่คนตอบก็มีลายเซ็นเท่านั้นบนไฟล์) ตำแหน่ง/
// เวลาลากมาจาก markX/markY ที่ผู้ใช้ลากเลือกเองในหน้าจอก่อนกดปุ่ม — ไม่ทำให้คำขอ workflow ล้มเหลวถ้า
// ประทับไม่สำเร็จ (เช่น ยังไม่ติดตั้ง chromium/qpdf) เพราะการดำเนินการ workflow หลักต้องสำเร็จไปก่อนแล้ว
// ถ้า actorUser กำลังดำเนินการขั้นตอนนี้ในฐานะ "รักษาการแทน" (ไม่ใช่ผู้ถูกมอบหมายตัวจริง) คืนชื่อผู้ที่ถูก
// รักษาการแทนไว้ให้ใส่ในตราประทับ — เพื่อให้เห็นในไฟล์ PDF จริงว่าใครลงนามแทนใคร ไม่ใช่แค่ในหน้าเว็บ
function actingForLabel(stepId, actorUser) {
  const step = db.prepare('SELECT assignee_id FROM workflow_steps WHERE id = ?').get(stepId);
  if (!step || step.assignee_id === actorUser.id) return null;
  const delegator = db.prepare('SELECT prefix, first_name, last_name FROM users WHERE id = ?').get(step.assignee_id);
  return delegator ? `${delegator.prefix || ''}${delegator.first_name} ${delegator.last_name}` : null;
}

// เลือกถ้อยคำหัว/ท้ายกล่องความเห็นให้ตรงกับตรายางจริง 2 แบบของโรงเรียน (ดู docs/stamp-reference/) —
// 'director' ถ้าผู้เซ็นเองเป็นผู้อำนวยการตัวจริง, 'acting_director' ถ้าเซ็นแทนในฐานะรักษาการแทนคนที่เป็น
// ผู้อำนวยการ (delegator มี role 'director'), 'generic' ถ้าไม่เข้าเงื่อนไขไหนเลย (เช่น หัวหน้าฝ่ายปิดเรื่องเอง)
function directorTitleMode(stepId, actorUser) {
  if (actorUser.roleCodes.includes('director')) return 'director';
  const step = db.prepare('SELECT assignee_id FROM workflow_steps WHERE id = ?').get(stepId);
  if (!step || step.assignee_id === actorUser.id) return 'generic';
  const delegatorIsDirector = db.prepare(`
    SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = ? AND r.name = 'director'
  `).get(step.assignee_id);
  return delegatorIsDirector ? 'acting_director' : 'generic';
}

// ตำแหน่ง Y เริ่มต้นของช่อง "ทราบ" (ลายเซ็นของผู้ได้รับเอกสาร) — อยู่กลางแถบล่าง ระหว่างความเห็นธุรการ
// กับกรอบตราปั๊ม ผอ. โดยขอบบนตรงกันทั้งสามช่อง (ดูแผนผังใน pdfStamp.js)
// ค่านี้ใช้ร่วมกันทั้งตำแหน่งที่โชว์ในตัวอย่างบนเว็บ (ต้องตรงกันเป๊ะ ไม่งั้นลากดูตัวอย่างแล้วจะไม่ตรงกับ
// ตำแหน่งจริงที่ฝังตอนกดปุ่ม) และตำแหน่งที่ฝังจริงตอนกดปุ่ม
const MARK_BASE_Y = DECISION_MAX_TOP_PERCENT;

/**
 * ลำดับที่ของผู้ลงนาม "ทราบ" บนไฟล์แนบนี้ — นับจากจำนวนครั้งที่ประทับสำเร็จไปแล้วจริงๆ
 *
 * ต้องนับจาก audit log ไม่ใช่นับจากจำนวนขั้นตอน workflow ที่ตัดสินใจไปแล้ว เพราะไม่ใช่ทุกคนที่ได้ตรานี้ —
 * ผอ./ผู้รักษาการแทนมีลายเซ็นในกรอบตราปั๊มของตัวเองอยู่แล้ว ธุรการมีในกล่องความเห็นของตัวเอง และคนที่
 * ยังไม่ได้บันทึกลายเซ็นในโปรไฟล์ก็ถูกข้ามไป ถ้านับจากขั้นตอนจะเกิดช่องว่างกลางแถวลายเซ็น
 */
function ackSignerIndex(attachmentId) {
  const { c } = db.prepare(`
    SELECT COUNT(*) as c FROM audit_logs WHERE action = 'attachment_mark_stamped' AND record_id = ?
  `).get(attachmentId);
  return c;
}

// กันกล่องความเห็น ผอ. ซ้อนทับตัวเองเป๊ะๆ เวลา ผอ. คนเดิม (assignee ช่องเดิม) ต้องตัดสินใจซ้ำบนเอกสาร
// เดียวกันมากกว่า 1 ครั้งโดยไม่ได้ลากตำแหน่งเอง (เช่น ส่งกลับแก้ไข-เสนอใหม่-อนุมัติซ้ำ) — เลื่อนขึ้นทีละ 14%
// จากตำแหน่งฐาน 78% ทุกครั้งที่ assignee ช่องนี้เคยตัดสินใจบนเอกสารนี้มาก่อนแล้ว (นับจาก workflow_steps
// ที่ assignee_id เดียวกัน ไม่ใช่นับทุกคนแบบ markStackYPercent เพราะกล่องนี้เป็นของ ผอ. คนเดียว)
// ระยะเลื่อนขึ้นต่อครั้งต้องมากกว่าความสูงกล่อง (~230pt ≈ 27% ของหน้า) ไม่งั้นกล่องรอบที่ 2 ยังทับรอบแรก
const DECISION_BOX_BASE_Y = DECISION_MAX_TOP_PERCENT;
const DECISION_BOX_STEP_Y = 27;
const DECISION_BOX_MIN_Y = 4;
function decisionBoxStackYPercent(documentId, stepId, assigneeId) {
  const { c } = db.prepare(`
    SELECT COUNT(*) as c FROM workflow_steps
    WHERE document_id = ? AND id != ? AND assignee_id = ? AND status IN ('approved', 'acknowledged', 'rejected')
  `).get(documentId, stepId, assigneeId);
  return Math.max(DECISION_BOX_MIN_Y, DECISION_BOX_BASE_Y - c * DECISION_BOX_STEP_Y);
}

// คืนค่า warning message ถ้าประทับตราไม่สำเร็จ (undefined ถ้าสำเร็จ หรือข้ามเพราะไม่มีลายเซ็น/ไฟล์แนบ —
// นั่นไม่ใช่ความผิดพลาด) เพื่อให้ผู้เรียกส่งกลับไปแจ้งผู้ใช้ต่อ ไม่ใช่กลืนความผิดพลาดแบบเงียบๆ เหมือนเดิม
// ซึ่งทำให้ผู้ใช้ไม่รู้ว่าทำไมข้อความ/ลายเซ็นไม่ติดใน PDF ที่พิมพ์ออกมา
async function stampAcknowledgeMarkIfApplicable({ documentId, stepId, actorUser, markX, markY }) {
  // ผอ./ผู้รักษาการแทน ผอ. มีลายเซ็นอยู่ในกรอบตราปั๊มของตัวเอง (มุมขวาล่าง) อยู่แล้ว ไม่ต้องมีตรา "ทราบ"
  // แยกซ้อนอีกอัน และธุรการก็มีลายเซ็นอยู่ในกล่องความเห็นที่เสนอ ผอ. อยู่แล้วเช่นกัน — ตรา "ทราบ" จึงมี
  // ไว้สำหรับคนอื่นในสาย workflow ที่ไม่มีที่ลงนามเป็นของตัวเอง (ครู หัวหน้าฝ่าย รองผู้อำนวยการ ฯลฯ)
  if (directorTitleMode(stepId, actorUser) !== 'generic') return;
  if (actorUser.roleCodes.includes('registrar')) return;
  if (!actorUser.signature_image) return;
  const att = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at LIMIT 1').get(documentId);
  if (!att) return;
  try {
    const originalBuffer = await readAttachmentBytes(att, { preferStamped: true });
    // คำว่า "ทราบ" มีคำเดียวต่อหนังสือหนึ่งฉบับ — คนแรกเป็นผู้ประทับคำนั้นพร้อมเซ็นชื่อ คนถัดๆ ไปเซ็นชื่อ
    // ต่อกันลงมาใต้คนแรกให้เป็นแถวเดียวกัน (ดู ackSlotTopPercent ใน pdfStamp.js)
    const signerIndex = ackSignerIndex(att.id);
    const stampedBuffer = await stampAcknowledgeMark({
      originalBuffer,
      signatureDataUrl: actorUser.signature_image,
      prefix: actorUser.prefix,
      firstName: actorUser.first_name,
      lastName: actorUser.last_name,
      dateThaiLong: stampDateThai(),
      showWord: signerIndex === 0,
      xPercent: markX ?? DEFAULT_ACK_MARK_X_PERCENT,
      // ถ้าผู้ใช้ลากเลือกตำแหน่งเอง ให้ถือว่านั่นคือขอบบนของ "ทั้งช่อง" แล้วคำนวณช่องของคนนี้ต่อจากนั้น
      // เพื่อให้ยังเรียงต่อกันเป็นระเบียบเหมือนเดิม ไม่ใช่ไปทับลายเซ็นของคนก่อนหน้า
      yPercent: ackSlotTopPercent(signerIndex, markY ?? MARK_BASE_Y),
      actingForLabel: actingForLabel(stepId, actorUser),
    });
    await saveStampedCopy(att, stampedBuffer, getDocument(documentId)?.year_be);
    audit({ userId: actorUser.id, action: 'attachment_mark_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId } });
  } catch (err) {
    audit({ userId: actorUser.id, action: 'attachment_mark_stamp_failed', tableName: 'attachments', recordId: att.id, detail: { documentId, error: err.message } });
    return `บันทึกผลสำเร็จ แต่ลงลายเซ็น "ทราบ" ลงในไฟล์ PDF จริงไม่สำเร็จ: ${err.message}`;
  }
}

// ธุรการเป็นคนกลั่นกรองเรื่องก่อนถึง ผอ. จึงต้องเขียนความเห็นเสนอขึ้นไปด้วย ไม่ใช่แค่ลงรับแล้วส่งต่อเฉยๆ
// เงื่อนไข: ต้องมีบทบาทธุรการ (บังคับฝั่งเซิร์ฟเวอร์ ไม่พึ่งแค่ UI ที่ซ่อนช่องไว้), ต้องไม่ใช่ผู้ที่กำลังลงนาม
// ในฐานะ ผอ./ผู้รักษาการแทน (คนนั้นมีกล่องความเห็นทางการของตัวเองอยู่แล้ว จะได้ไม่มีความเห็นซ้อนสองที่)
// และต้องพิมพ์ความเห็นมาจริง — ไม่พิมพ์ก็ข้ามไป ไม่ถือเป็นความผิดพลาด
// stepId เป็น null ได้ — กรณีธุรการเขียนความเห็นตอน "เสนอ" ครั้งแรก ซึ่งยังไม่มีขั้นตอน workflow ของตัวเอง
// (ตอนนั้นเป็นผู้บันทึกเอกสารที่กำลังส่งเรื่องขึ้นไปให้ ผอ. ไม่ใช่ผู้ถูกมอบหมาย จึงไม่ต้องเช็คโหมด ผอ.)
function canWriteRegistrarComment(stepId, actorUser) {
  if (!actorUser.roleCodes.includes('registrar')) return false;
  return stepId ? directorTitleMode(stepId, actorUser) === 'generic' : true;
}

// ธุรการเขียนความเห็นบนหนังสือฉบับเดิมได้มากกว่าหนึ่งครั้ง (เช่น เสนอไปแล้ว ผอ. ส่งกลับแก้ไข แล้วเสนอใหม่)
// ถ้าไม่ขยับตำแหน่ง ความเห็นรอบที่สองจะทับรอบแรกเป๊ะๆ จนอ่านไม่ออกทั้งคู่ — เลื่อนขึ้นทีละกล่องเหมือน
// กรอบตราปั๊ม ผอ. โดยระยะต้องมากกว่าความสูงกล่อง (~160pt ≈ 19% ของหน้า) ไม่งั้นรอบที่ 2 ยังทับรอบแรก
const REGISTRAR_BOX_STEP_Y = 20;
const REGISTRAR_BOX_MIN_Y = 4;
function registrarBoxYPercent(attachmentId) {
  const { c } = db.prepare(`
    SELECT COUNT(*) as c FROM audit_logs WHERE action = 'attachment_registrar_stamped' AND record_id = ?
  `).get(attachmentId);
  return Math.max(REGISTRAR_BOX_MIN_Y, DECISION_MAX_TOP_PERCENT - c * REGISTRAR_BOX_STEP_Y);
}

async function stampRegistrarCommentIfApplicable({ documentId, stepId, actorUser, comment, registrarX, registrarY }) {
  const text = typeof comment === 'string' ? comment.trim() : '';
  if (!text || !canWriteRegistrarComment(stepId, actorUser)) return;
  const att = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at LIMIT 1').get(documentId);
  if (!att) return;
  try {
    const originalBuffer = await readAttachmentBytes(att, { preferStamped: true });
    const stampedBuffer = await stampRegistrarComment({
      originalBuffer,
      comment: text,
      signatureDataUrl: actorUser.signature_image || null,
      prefix: actorUser.prefix,
      firstName: actorUser.first_name,
      lastName: actorUser.last_name,
      position: actorUser.position,
      dateThaiLong: stampDateThai(),
      xPercent: registrarX,
      yPercent: registrarY ?? registrarBoxYPercent(att.id),
    });
    await saveStampedCopy(att, stampedBuffer, getDocument(documentId)?.year_be);
    audit({ userId: actorUser.id, action: 'attachment_registrar_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId, comment: text } });
    // เก็บความเห็นไว้ในระบบด้วย ไม่ใช่แค่พิมพ์ลงไฟล์ PDF — ผอ. จะได้เห็นตั้งแต่เปิดหน้าเอกสารในเว็บ
    // โดยไม่ต้องเปิดไฟล์แนบก่อน และยังค้นหา/อ้างอิงย้อนหลังได้ (ไฟล์ PDF ค้นข้อความข้างในไม่ได้)
    db.prepare('INSERT INTO comments (id, document_id, user_id, message, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(uuid(), documentId, actorUser.id, `เรียนผู้อำนวยการโรงเรียน\n${text}`, nowIso());
  } catch (err) {
    audit({ userId: actorUser.id, action: 'attachment_registrar_stamp_failed', tableName: 'attachments', recordId: att.id, detail: { documentId, error: err.message } });
    return `บันทึกผลสำเร็จ แต่ลงความเห็นธุรการลงในไฟล์ PDF จริงไม่สำเร็จ: ${err.message}`;
  }
}

// กล่องความเห็น/ลงนามของผู้ตัดสินใจคนสุดท้าย — เรียกจากทั้ง 3 endpoint (อนุมัติและส่งต่อ/รับทราบ/ไม่อนุมัติ)
// ไม่ได้จำกัดแค่ตอนปิดเรื่องแล้ว เพราะ ผอ. อาจอยากบันทึกความเห็น/ติ๊กเครื่องหมายไว้ตั้งแต่ตอนส่งต่อก็ได้ —
// note คือข้อความในช่อง "ความเห็น" ที่ผู้ใช้พิมพ์เอง ไม่ใช่ข้อความเกษียณภายในระบบ (คนละช่องกัน)
// จำกัดเฉพาะ ผอ. ตัวจริง/ผู้รักษาการแทน ผอ. เท่านั้น (titleMode !== 'generic') — คนอื่นในสาย workflow แค่
// "ทราบ" เฉยๆ ไม่มีตราประทับความเห็นทางการ (บังคับฝั่งเซิร์ฟเวอร์ ไม่พึ่งแค่ UI ที่ซ่อนปุ่ม/ช่องไว้แล้ว)
async function stampDirectorDecisionIfApplicable({ documentId, stepId, actorUser, decision, note, marks, notifyTarget, decisionX, decisionY }) {
  const titleMode = directorTitleMode(stepId, actorUser);
  if (titleMode === 'generic') return;
  const att = db.prepare('SELECT * FROM attachments WHERE document_id = ? ORDER BY created_at LIMIT 1').get(documentId);
  if (!att) return;
  const doc = getDocument(documentId);
  const forLabel = actingForLabel(stepId, actorUser);
  const { assignee_id: assigneeId } = db.prepare('SELECT assignee_id FROM workflow_steps WHERE id = ?').get(stepId);
  try {
    const originalBuffer = await readAttachmentBytes(att, { preferStamped: true });
    const stampedBuffer = await stampDirectorDecision({
      originalBuffer,
      schoolName: SCHOOL_NAME,
      decision,
      note,
      marks: marks || [],
      notifyTarget: notifyTarget || '',
      signatureDataUrl: actorUser.signature_image || null,
      prefix: actorUser.prefix,
      firstName: actorUser.first_name,
      lastName: actorUser.last_name,
      position: actorUser.position,
      titleMode,
      actingForLabel: titleMode === 'acting_director' ? forLabel : null,
      dateThaiLong: stampDateThai(),
      xPercent: decisionX,
      yPercent: decisionY ?? decisionBoxStackYPercent(documentId, stepId, assigneeId),
    });
    await saveStampedCopy(att, stampedBuffer, doc?.year_be);
    audit({ userId: actorUser.id, action: 'attachment_director_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId, decision, note, marks: marks || [], notifyTarget: notifyTarget || '' } });
  } catch (err) {
    audit({ userId: actorUser.id, action: 'attachment_director_stamp_failed', tableName: 'attachments', recordId: att.id, detail: { documentId, decision, error: err.message } });
    return `บันทึกผลสำเร็จ แต่ลงตราประทับ/ข้อความ "ความเห็น" ลงในไฟล์ PDF จริงไม่สำเร็จ: ${err.message}`;
  }
}

// ประทับตราลงในเนื้อไฟล์ PDF จริง (เขียนสำเนาใหม่ ไม่แตะไฟล์ต้นฉบับ) — ใช้ตำแหน่งที่บันทึกไว้ล่าสุดจาก
// /stamp-position ต้องติดตั้ง chromium + qpdf บนเซิร์ฟเวอร์ก่อน (ดู DEPLOY.md) ไม่งั้นจะ error 501 ชัดเจน
router.post('/documents/:id/attachments/:attId/apply-stamp', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  if (doc.created_by !== ctx.user.id && !ctx.user.roleCodes.includes('admin')) {
    throw httpError(403, 'สร้าง PDF ที่ประทับตราแล้วได้เฉพาะผู้บันทึกเอกสารหรือแอดมินเท่านั้น');
  }
  const att = db.prepare('SELECT * FROM attachments WHERE id = ? AND document_id = ?').get(ctx.params.attId, doc.id);
  if (!att) throw httpError(404, 'ไม่พบไฟล์แนบนี้');

  const originalBuffer = await readAttachmentBytes(att, { preferStamped: false });

  const now = new Date(doc.created_at);
  // เลขรับ/เวลาที่จะแสดงบนตรา แก้ไขได้จากที่ธุรการพิมพ์ตอนกดยืนยัน (ดู applyStamp ฝั่งเว็บ) — เลขรับถ้าเว้น
  // ว่างไว้ใช้เลขที่เอกสารตามปกติ ส่วนเวลาเว้นว่างได้จริง (แสดงเป็นบรรทัดว่างบนตราให้เขียนเติมเองทีหลังได้)
  const docNumberDisplay = (typeof ctx.body.docNumberOverride === 'string' && ctx.body.docNumberOverride.trim()) || doc.doc_number_display;
  const timeStr = typeof ctx.body.timeOverride === 'string' ? ctx.body.timeOverride.trim() : stampTimeThai(now);
  const stampedBuffer = await stampPdf({
    originalBuffer,
    schoolName: SCHOOL_NAME,
    docNumberDisplay,
    dateThaiLong: stampDateThai(now),
    timeStr,
    xPercent: doc.stamp_x,
    yPercent: doc.stamp_y,
  });

  await saveStampedCopy(att, stampedBuffer, doc.year_be);
  audit({ userId: ctx.user.id, action: 'attachment_stamped', tableName: 'attachments', recordId: att.id, detail: { documentId: doc.id, docNumberDisplay, timeStr } });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/archive', requireApi(async (ctx) => {
  archiveDocument({ documentId: ctx.params.id, actorUser: ctx.user });
  json(ctx, 200, { ok: true });
}));

router.post('/documents/:id/comment', requireApi(async (ctx) => {
  const doc = getDocument(ctx.params.id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(404, 'ไม่พบเอกสาร');
  if (!ctx.body.message?.trim()) throw httpError(400, 'ข้อความว่างเปล่า');
  assertMaxLength(ctx.body.message, 5000, 'ข้อความ');
  db.prepare('INSERT INTO comments (id, document_id, user_id, message, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(uuid(), doc.id, ctx.user.id, ctx.body.message.trim(), nowIso());
  audit({ userId: ctx.user.id, action: 'comment_added', tableName: 'documents', recordId: doc.id });
  json(ctx, 200, { ok: true });
}));


// ---------------- file serving (ACL-checked, not static — proxied even for Google Drive so ACL always applies) ----------------
// ภาพหน้าแรกของ PDF (พื้นหลังกล่องลากตำแหน่งตราประทับ) — ดู renderPdfFirstPageImage สำหรับเหตุผลที่ใช้ภาพ
// แทนการฝัง PDF ตรงๆ ผ่าน iframe
router.get('/files/:attachmentId/preview.png', requirePage(async (ctx) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(ctx.params.attachmentId);
  if (!att) throw httpError(404, 'ไม่พบไฟล์แนบ');
  const doc = getDocument(att.document_id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) throw httpError(403, 'คุณไม่มีสิทธิ์เปิดไฟล์นี้');
  const buf = await readAttachmentBytes(att, { preferStamped: ctx.query.original !== '1' });
  const png = await renderPdfFirstPageImage(buf);
  ctx.res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' });
  ctx.res.end(png);
}));

// ค่าเริ่มต้นเปิดสำเนาที่ประทับตราแล้ว (ถ้ามี) — ต้นฉบับที่ไม่แตะต้องเลยเปิดได้ด้วย ?original=1
router.get('/files/:attachmentId', requirePage(async (ctx) => {
  const att = db.prepare('SELECT * FROM attachments WHERE id = ?').get(ctx.params.attachmentId);
  if (!att) return html(ctx, 404, '<h1>404</h1>');
  const doc = getDocument(att.document_id);
  if (!doc || !canUserSeeDocument(ctx.user, doc)) {
    return html(ctx, 403, '<h1>403</h1><p>คุณไม่มีสิทธิ์เปิดไฟล์นี้</p>');
  }

  const useStamped = ctx.query.original !== '1' && att.stamped_storage_provider;
  const storageProvider = useStamped ? att.stamped_storage_provider : att.storage_provider;
  const filepath = useStamped ? att.stamped_filepath : att.filepath;
  const driveFileId = useStamped ? att.stamped_drive_file_id : att.drive_file_id;

  if (storageProvider === 'google_drive') {
    let stream;
    try {
      stream = await downloadFileStream(driveFileId);
    } catch (err) {
      return html(ctx, err.statusCode || 502, `<h1>เกิดข้อผิดพลาด</h1><p>${esc(err.message)}</p>`);
    }
    if (!stream) return html(ctx, 404, '<h1>ไม่พบไฟล์บน Google Drive</h1>');
    audit({ userId: ctx.user.id, action: 'attachment_opened', tableName: 'attachments', recordId: att.id, ip: ctx.ip, detail: { variant: useStamped ? 'stamped' : 'original' } });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/pdf',
      'Content-Disposition': contentDispositionHeader(att.filename),
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    Readable.fromWeb(stream).pipe(ctx.res);
    return;
  }

  const filePath = path.join(UPLOAD_DIR, filepath);
  if (!fs.existsSync(filePath)) return html(ctx, 404, '<h1>ไม่พบไฟล์</h1>');
  audit({ userId: ctx.user.id, action: 'attachment_opened', tableName: 'attachments', recordId: att.id, ip: ctx.ip, detail: { variant: useStamped ? 'stamped' : 'original' } });
  ctx.res.writeHead(200, {
    'Content-Type': 'application/pdf',
    'Content-Disposition': contentDispositionHeader(att.filename),
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(ctx.res);
}));
