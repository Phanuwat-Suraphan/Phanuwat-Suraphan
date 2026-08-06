import { router, html, json } from '../router.js';
import { layout, esc, fmtDate, emptyState } from '../render.js';
import { requirePage, requireApi } from '../middleware.js';
import { db } from '../db.js';

const PRIORITY_ICON = { info: 'ℹ️', success: '✅', warning: '⚠️', urgent: '🔴', critical: '🚨' };

router.get('/notifications', requirePage((ctx) => {
  const rows = db.prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100').all(ctx.user.id);
  const content = `
    <div class="card-header">
      <h2 class="mt-0">🔔 การแจ้งเตือน</h2>
      <button class="btn btn-outline btn-sm" onclick="fetch('/notifications/read-all',{method:'POST'}).then(()=>location.reload())">อ่านทั้งหมดแล้ว</button>
    </div>
    <div class="card">
      ${rows.length ? rows.map((n) => `
        <div class="flex items-center justify-between" style="padding:.7rem 0;border-bottom:1px solid var(--border);${n.is_read ? 'opacity:.6' : ''}">
          <div>
            <div style="font-weight:700">${PRIORITY_ICON[n.priority] || 'ℹ️'} ${esc(n.title)}</div>
            <div class="text-muted" style="font-size:.85rem">${esc(n.message)}</div>
            <div class="text-muted" style="font-size:.75rem">${fmtDate(n.created_at)}</div>
          </div>
          <div class="chip-row">
            ${n.document_id ? `<a class="btn btn-sm btn-outline" href="/documents/${n.document_id}">เปิด</a>` : ''}
            ${!n.is_read ? `<button class="btn btn-sm btn-outline" onclick="fetch('/notifications/${n.id}/read',{method:'POST'}).then(()=>location.reload())">อ่านแล้ว</button>` : ''}
          </div>
        </div>`).join('') : emptyState('🔕', 'ไม่มีการแจ้งเตือน')}
    </div>`;
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
