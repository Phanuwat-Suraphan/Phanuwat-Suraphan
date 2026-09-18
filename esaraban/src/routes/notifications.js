import { router, html, json } from '../router.js';
import { layout, esc, fmtDate, emptyState } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db, audit, nowIso } from '../db.js';
import { httpError } from '../services/validate.js';

const PRIORITY_ICON = { info: 'ℹ️', success: '✅', warning: '⚠️', urgent: '🔴', critical: '🚨' };

// ข้อความแจ้งเตือนบางรายการยาวมาก (เช่น เหตุผลที่ไม่อนุมัติซึ่งผู้ใช้พิมพ์เอง) หน้านี้แสดง 100 รายการ
// ต่อครั้ง ถ้าไม่ตัดจะหนักได้ถึงหลักแสนไบต์ทั้งที่จำนวนรายการมีเพดานอยู่แล้ว — รายละเอียดเต็มอ่านได้ที่
// หน้าของเรื่องนั้นซึ่งลิงก์ไปอยู่แล้ว
const MESSAGE_PREVIEW_CHARS = 200;
const preview = (msg) => {
  const s = String(msg || '');
  return s.length > MESSAGE_PREVIEW_CHARS ? `${s.slice(0, MESSAGE_PREVIEW_CHARS)}…` : s;
};

// ช่วงอายุที่ผู้ดูแลเลือกได้ตอนเก็บกวาดของทั้งระบบ — จงใจไม่มี "0 วัน" เพราะการลบของที่เพิ่งส่งไปเมื่อกี้
// ของทุกคนพร้อมกัน แทบไม่มีเหตุผลรองรับ และเป็นสิ่งที่กดพลาดแล้วตามคืนไม่ได้
const PURGE_DAY_OPTIONS = [30, 90, 180, 365];

// คั่นหลักพันเอง ไม่ใช้ toLocaleString — ทั้งโปรเจกต์มีด่านกวาดห้ามเรียก API ตระกูล locale โดยไม่ระบุ
// timeZone (กันวันที่เพี้ยนตามเครื่องเซิร์ฟเวอร์) ตัวเลขล้วนไม่ได้เสี่ยงเรื่องนั้น แต่ไม่ควรมีข้อยกเว้น
// ที่ต้องมานั่งแยกแยะทีหลังว่าอันไหนปลอดภัยอันไหนไม่
const groupDigits = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

router.get('/notifications', requirePage((ctx) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(ctx.user.id);
  const readCount = db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 1').get(ctx.user.id).c;
  const isAdmin = ctx.user.roleCodes.includes('admin');
  const systemTotal = isAdmin ? db.prepare('SELECT COUNT(*) c FROM notifications').get().c : 0;

  const content = `
    <div class="card-header">
      <h2 class="mt-0">🔔 การแจ้งเตือน</h2>
      <div class="chip-row">
        <button class="btn btn-outline btn-sm" onclick="markAllRead(this)">อ่านทั้งหมดแล้ว</button>
        ${readCount ? `<button class="btn btn-outline btn-sm" onclick="clearRead(this)">🗑️ ลบที่อ่านแล้ว (${readCount})</button>` : ''}
      </div>
    </div>
    <div class="card">
      ${rows.length ? rows.map((n) => `
        <div class="flex items-center justify-between" id="notif-${esc(n.id)}" style="padding:.7rem 0;border-bottom:1px solid var(--border);${n.is_read ? 'opacity:.6' : ''}">
          <div>
            <div style="font-weight:700">${PRIORITY_ICON[n.priority] || 'ℹ️'} ${esc(n.title)}</div>
            <div class="text-muted" style="font-size:.85rem">${esc(preview(n.message))}</div>
            <div class="text-muted" style="font-size:.75rem">${fmtDate(n.created_at)}</div>
          </div>
          <div class="chip-row">
            ${
              // link_url ต้องเป็น path ภายในระบบเท่านั้น — ค่านี้มาจากโค้ดฝั่งเซิร์ฟเวอร์อยู่แล้ว แต่กันไว้
              // ไม่ให้กลายเป็นทางเปิด redirect ออกนอกเว็บถ้าวันหลังมีใครส่งค่าจากผู้ใช้เข้ามา
              n.document_id ? `<a class="btn btn-sm btn-outline" href="/documents/${n.document_id}">เปิด</a>`
                : /^\/[A-Za-z0-9/_-]*$/.test(n.link_url || '') ? `<a class="btn btn-sm btn-outline" href="${esc(n.link_url)}">เปิด</a>` : ''
            }
            ${!n.is_read ? `<button class="btn btn-sm btn-outline" onclick="markRead('${esc(n.id)}', this)">อ่านแล้ว</button>` : ''}
            <button class="btn btn-sm btn-outline" title="ลบการแจ้งเตือนนี้"
              onclick="removeOne('${esc(n.id)}', this)">🗑️</button>
          </div>
        </div>`).join('') : emptyState('🔕', 'ไม่มีการแจ้งเตือน')}
    </div>

    ${isAdmin ? `
    <div class="card" style="border-color:var(--warning)">
      <h3 class="mt-0">🧹 ผู้ดูแล: เก็บกวาดการแจ้งเตือนของทั้งระบบ</h3>
      <p class="help-text" style="margin-top:-.3rem">
        ตอนนี้มีการแจ้งเตือนในระบบทั้งหมด <strong>${groupDigits(systemTotal)}</strong> รายการ
        (ของทุกคนรวมกัน) รายการเก่าที่ทุกคนอ่านไปแล้วไม่มีใครย้อนกลับมาดูอีก แต่ยังกินพื้นที่และติดไปกับ
        สำเนาสำรองทุกชุด
      </p>
      <div class="form-grid cols-2">
        <div class="field">
          <label>ลบรายการที่เก่ากว่า</label>
          <select id="purgeDays">
            ${PURGE_DAY_OPTIONS.map((d) => `<option value="${d}"${d === 90 ? ' selected' : ''}>${d} วัน</option>`).join('')}
          </select>
        </div>
        <div class="field">
          <label class="label-spacer" aria-hidden="true">&nbsp;</label>
          <label class="check-inline">
            <input type="checkbox" id="purgeUnread" />
            <span>รวมรายการที่ยังไม่ได้อ่านด้วย</span>
          </label>
        </div>
      </div>
      <div class="alert alert-warning" style="font-size:.85rem">
        ⚠️ ปกติระบบลบให้เฉพาะรายการที่<strong>อ่านแล้ว</strong> — รายการที่ยังไม่ได้อ่านคือ “งานที่เจ้าตัวยังไม่เห็น”
        การลบทิ้งเท่ากับทำให้เขาไม่รู้ว่ามีเรื่องรออยู่ ติ๊กช่องนั้นเฉพาะตอนที่ตั้งใจจริงๆ เช่นส่งแจ้งเตือนผิดไปทั้งโรงเรียน
        <br/>ตัวหนังสือในระบบไม่ได้ถูกลบไปด้วย — ลบเฉพาะข้อความแจ้งเตือน งานทุกอย่างยังอยู่ที่เดิม
      </div>
      <div class="chip-row">
        <button class="btn btn-outline btn-sm" onclick="previewPurge(this)">ดูก่อนว่าจะลบกี่รายการ</button>
        <button class="btn btn-outline btn-sm" style="color:var(--danger);border-color:var(--danger)"
          onclick="doPurge(this)">🗑️ ลบตามเงื่อนไขนี้</button>
      </div>
      <div id="purgeResult" class="help-text"></div>
    </div>
    <!-- สคริปต์ส่วนนี้อยู่ในบล็อกของผู้ดูแล ไม่ใช่ในสคริปต์รวม — ครูไม่ควรได้รับโค้ดที่ตัวเองเรียกไม่ได้
         ติดไปทุกครั้งที่เปิดหน้า และการมีชื่อเส้นทางของผู้ดูแลอยู่ในหน้าของครูก็ไม่มีประโยชน์อะไร -->
    <script>
      function purgeBody(){
        return {
          days: Number(document.getElementById('purgeDays').value),
          includeUnread: document.getElementById('purgeUnread').checked,
        };
      }
      function previewPurge(btn){
        window.setBtnLoading(btn, 'กำลังนับ...');
        window.postJson('/notifications/admin/purge-preview', purgeBody())
          .then(function(d){
            document.getElementById('purgeResult').textContent =
              'จะลบ ' + d.count + ' รายการ (อ่านแล้ว ' + d.read + ' / ยังไม่ได้อ่าน ' + d.unread + ')';
            window.restoreBtn(btn);
          })
          .catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
      }
      function doPurge(btn){
        var b = purgeBody();
        var msg = 'ลบการแจ้งเตือนของทุกคนที่เก่ากว่า ' + b.days + ' วัน'
          + (b.includeUnread ? ' รวมรายการที่ยังไม่ได้อ่านด้วย' : ' (เฉพาะที่อ่านแล้ว)') + '?\\n\\nลบแล้วกู้คืนไม่ได้';
        if (!confirm(msg)) return;
        window.setBtnLoading(btn, 'กำลังลบ...');
        window.postJson('/notifications/admin/purge', b)
          .then(function(d){ toast('ลบแล้ว ' + d.deleted + ' รายการ', 'success'); reloadSoon(); })
          .catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
      }
    </script>` : ''}

    <script>
      function reloadSoon(){ setTimeout(function(){ location.reload(); }, 400); }
      function markRead(id, btn){
        window.setBtnLoading(btn, '...');
        window.postJson('/notifications/' + id + '/read', {})
          .then(reloadSoon).catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
      }
      function markAllRead(btn){
        window.setBtnLoading(btn, 'กำลังบันทึก...');
        window.postJson('/notifications/read-all', {})
          .then(reloadSoon).catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
      }
      function removeOne(id, btn){
        window.setBtnLoading(btn, '...');
        window.postJson('/notifications/' + id + '/delete', {})
          .then(function(){
            // เอาแถวออกทันทีแทนการรีโหลดทั้งหน้า — กดลบทีละรายการหลายอันติดกันเป็นเรื่องปกติ
            var row = document.getElementById('notif-' + id);
            if (row) row.remove(); else location.reload();
          })
          .catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
      }
      function clearRead(btn){
        if (!confirm('ลบการแจ้งเตือนที่คุณอ่านแล้วทั้งหมด? (รายการที่ยังไม่ได้อ่านจะไม่ถูกลบ)')) return;
        window.setBtnLoading(btn, 'กำลังลบ...');
        window.postJson('/notifications/clear-read', {})
          .then(function(d){ toast('ลบแล้ว ' + d.deleted + ' รายการ', 'success'); reloadSoon(); })
          .catch(function(e){ toast(e.message, 'danger'); window.restoreBtn(btn); });
      }
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'การแจ้งเตือน', path: '/notifications', content }));
}));

router.post('/notifications/:id/read', requireApi(async (ctx) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?').run(ctx.params.id, ctx.user.id);
  json(ctx, 200, { ok: true });
}));

router.post('/notifications/read-all', requireApi(async (ctx) => {
  db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(ctx.user.id);
  json(ctx, 200, { ok: true });
}));

// ───────────────────────────── ลบการแจ้งเตือน ─────────────────────────────
//
// การแจ้งเตือนเป็น "สำเนาเพื่อบอกให้รู้" ไม่ใช่ตัวงาน — ลบทิ้งแล้วหนังสือ ใบลา และขั้นตอนทุกอย่าง
// ยังอยู่ครบเหมือนเดิม จึงให้ลบได้โดยไม่ต้องยืนยัน PIN ต่างจากการกระทำที่แตะตัวงานจริง

/** ทุกคนลบของตัวเองได้ — ผูก user_id ไว้ในคำสั่งเสมอ ไม่ใช่ตรวจก่อนแล้วค่อยลบ */
router.post('/notifications/:id/delete', requireApi((ctx) => {
  const changes = db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?')
    .run(ctx.params.id, ctx.user.id).changes;
  if (!changes) throw httpError(404, 'ไม่พบการแจ้งเตือนนี้ หรือไม่ใช่ของคุณ');
  json(ctx, 200, { ok: true });
}));

/** ลบเฉพาะที่ตัวเองอ่านแล้ว — ที่ยังไม่ได้อ่านคืองานที่ยังไม่เห็น ไม่ลบให้โดยไม่ได้สั่งเฉพาะเจาะจง */
router.post('/notifications/clear-read', requireApi((ctx) => {
  const deleted = db.prepare('DELETE FROM notifications WHERE user_id = ? AND is_read = 1').run(ctx.user.id).changes;
  json(ctx, 200, { ok: true, deleted });
}));

function purgeWhere(ctx) {
  const days = Number(ctx.body?.days);
  if (!PURGE_DAY_OPTIONS.includes(days)) {
    throw httpError(400, `ช่วงเวลาที่เลือกไม่ถูกต้อง — เลือกได้เฉพาะ ${PURGE_DAY_OPTIONS.join(', ')} วัน`);
  }
  const cutoff = new Date(Date.now() - days * 86400000).toISOString();
  const includeUnread = ctx.body?.includeUnread === true;
  return { days, cutoff, includeUnread };
}

/** นับก่อนลบ — ผู้ดูแลต้องเห็นตัวเลขจริงก่อนกดสิ่งที่กู้คืนไม่ได้ ไม่ใช่กดแล้วค่อยรู้ว่าโดนไปเท่าไหร่ */
router.post('/notifications/admin/purge-preview', requireApi((ctx) => {
  if (!ctx.user.roleCodes.includes('admin')) throw httpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น');
  const { cutoff } = purgeWhere(ctx);
  const row = db.prepare(`
    SELECT COUNT(*) total, SUM(is_read = 1) read_c, SUM(is_read = 0) unread_c
    FROM notifications WHERE created_at < ?
  `).get(cutoff);
  const read = row.read_c || 0;
  const unread = row.unread_c || 0;
  json(ctx, 200, { ok: true, count: ctx.body?.includeUnread === true ? read + unread : read, read, unread });
}));

router.post('/notifications/admin/purge', requireApi((ctx) => {
  if (!ctx.user.roleCodes.includes('admin')) throw httpError(403, 'เฉพาะผู้ดูแลระบบเท่านั้น');
  const { days, cutoff, includeUnread } = purgeWhere(ctx);
  const deleted = includeUnread
    ? db.prepare('DELETE FROM notifications WHERE created_at < ?').run(cutoff).changes
    : db.prepare('DELETE FROM notifications WHERE created_at < ? AND is_read = 1').run(cutoff).changes;
  // ลบของทุกคนพร้อมกันเป็นการกระทำที่กู้คืนไม่ได้และกระทบคนอื่น — ต้องมีร่องรอยว่าใครสั่ง เมื่อไหร่
  // ด้วยเงื่อนไขอะไร ไม่งั้นครูที่แจ้งว่า "การแจ้งเตือนหายไป" จะไม่มีใครตอบได้ว่าเกิดอะไรขึ้น
  audit({
    userId: ctx.user.id, action: 'notifications_purged', tableName: 'notifications', recordId: null,
    detail: { days, includeUnread, deleted, cutoff, at: nowIso() },
  });
  json(ctx, 200, { ok: true, deleted });
}));
