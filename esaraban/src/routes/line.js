// เส้นทางที่เกี่ยวกับ LINE — ตัวรับ webhook, การเชื่อมบัญชีของแต่ละคน และหน้าตั้งค่าของผู้ดูแล
import { router, html, json } from '../router.js';
import { layout, esc } from '../render.js';
import { requireApi, requireRole, requirePage } from '../middleware.js';
import { audit } from '../db.js';
import {
  verifyLineSignature, handleLineEvents, isLineWebhookConfigured, isLineNotifyConfigured,
  createLinkCode, unlinkLineAccount, setLineNotifyEnabled, lineNotifyStatus,
  flushLineOutbox, LINK_KEYWORD,
} from '../services/lineNotify.js';

// ───────────────────────────── ตัวรับ webhook จาก LINE ─────────────────────────────
//
// เส้นทางนี้เปิดสาธารณะโดยตั้งใจ (ไม่ห่อด้วย requireApi) เพราะ LINE ยิงเข้ามาเอง ไม่มีคุกกี้ผู้ใช้
// สิ่งที่กั้นคือลายเซ็น HMAC ที่คิดจาก Channel Secret ซึ่งมีแต่ LINE กับเซิร์ฟเวอร์เรารู้
//
// ต้องตอบ 200 ให้ได้เร็วและเกือบทุกกรณี — LINE ตัดสินว่า webhook ใช้การได้หรือไม่จากรหัสตอบกลับ
// ถ้าตอบพลาดบ่อยๆ ระบบจะปิด webhook ให้เอง แล้วการเชื่อมบัญชีจะเงียบหายไปทั้งโรงเรียนโดยไม่มีอะไรฟ้อง
// ข้อยกเว้นเดียวคือลายเซ็นไม่ผ่าน ซึ่งต้องตอบ 401 เพื่อให้เห็นชัดว่ามีคนยิงของปลอมเข้ามา
router.post('/line/webhook', async (ctx) => {
  if (!isLineWebhookConfigured()) {
    // ยังไม่ได้ตั้ง Channel Secret = ตรวจลายเซ็นไม่ได้ จึงต้องไม่รับอะไรทั้งสิ้น
    // (ถ้ารับไว้เฉยๆ ใครก็ปลอมเหตุการณ์ "ส่งรหัสเชื่อมบัญชี" มาเดารหัสรัวๆ ได้)
    return json(ctx, 503, { error: 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET' });
  }
  const signature = ctx.req.headers['x-line-signature'];
  if (!verifyLineSignature(ctx.rawBody, signature)) {
    return json(ctx, 401, { error: 'ลายเซ็นไม่ถูกต้อง' });
  }
  // ตอบ 200 ก่อน แล้วค่อยทำงานต่อ — งานที่เหลือมีการยิงข้อความตอบกลับไปหา LINE ซึ่งใช้เวลาข้ามเน็ต
  // ถ้ารอให้เสร็จก่อนค่อยตอบ LINE จะนับว่า webhook ช้าและอาจตัดสายไปก่อน
  json(ctx, 200, { ok: true });
  try {
    await handleLineEvents(ctx.body?.events);
  } catch (err) {
    console.error('[line] webhook ล้มเหลวหลังตอบกลับแล้ว:', err?.message || err);
  }
});

// ───────────────────────────── เชื่อมบัญชีของแต่ละคน ─────────────────────────────

router.post('/profile/line/code', requireApi((ctx) => {
  if (!isLineNotifyConfigured()) {
    return json(ctx, 400, { error: 'ยังไม่ได้เชื่อมระบบเข้ากับบัญชีทางการของ LINE — แจ้งผู้ดูแลระบบให้ตั้งค่าที่หน้า "แจ้งเตือนเข้าไลน์"' });
  }
  const info = createLinkCode(ctx.user.id);
  audit({ userId: ctx.user.id, action: 'line_link_code_issued', tableName: 'users', recordId: ctx.user.id, detail: {} });
  // ไม่ส่งรหัสลงใน audit detail โดยตั้งใจ — ผู้ดูแลอ่าน audit log ได้ ถ้ารหัสอยู่ในนั้นก็เท่ากับ
  // ผู้ดูแลผูกบัญชีไลน์ของตัวเองเข้ากับบัญชีครูคนไหนก็ได้โดยที่เจ้าตัวไม่รู้
  json(ctx, 200, info);
}));

router.post('/profile/line/unlink', requireApi((ctx) => {
  unlinkLineAccount(ctx.user.id);
  json(ctx, 200, { ok: true });
}));

router.post('/profile/line/toggle', requireApi((ctx) => {
  setLineNotifyEnabled(ctx.user.id, ctx.body?.enabled !== false);
  json(ctx, 200, { ok: true, enabled: ctx.body?.enabled !== false });
}));

// ───────────────────────────── หน้าตั้งค่าของผู้ดูแล ─────────────────────────────

const ADMIN_ONLY = requireRole('admin');

function statusRow(label, ok, detail) {
  return `<tr>
    <td class="text-muted" style="white-space:nowrap">${esc(label)}</td>
    <td>${ok ? '<span class="badge badge-success">พร้อมใช้งาน</span>' : '<span class="badge badge-warning">ยังไม่ได้ตั้งค่า</span>'}
      ${detail ? `<div class="text-muted" style="font-size:.82rem;margin-top:.2rem">${detail}</div>` : ''}</td>
  </tr>`;
}

router.get('/admin/line', ADMIN_ONLY(requirePage((ctx) => {
  const s = lineNotifyStatus();
  const webhookUrl = `${ctx.req.headers['x-forwarded-proto'] || 'https'}://${ctx.req.headers.host || 'ชื่อเว็บของโรงเรียน'}/line/webhook`;
  const content = `
    <h2>💬 แจ้งเตือนเข้าไลน์</h2>
    <p class="text-muted" style="margin-top:-.5rem">
      ให้การแจ้งเตือนของระบบ (หนังสือใหม่ที่ต้องดำเนินการ, ผลการอนุมัติ, ประชาสัมพันธ์) เด้งเข้าไลน์ของแต่ละคนอัตโนมัติ
    </p>

    <div class="card">
      <h3 class="mt-0">สถานะตอนนี้</h3>
      <table class="table-plain">
        ${statusRow('ส่งข้อความเข้าไลน์', s.configured, s.configured ? '' : 'ตั้งตัวแปร <code>LINE_CHANNEL_ACCESS_TOKEN</code> บนเซิร์ฟเวอร์')}
        ${statusRow('รับการเชื่อมบัญชี', s.webhookReady, s.webhookReady ? '' : 'ตั้งตัวแปร <code>LINE_CHANNEL_SECRET</code> บนเซิร์ฟเวอร์')}
        ${statusRow('ลิงก์เพิ่มเพื่อน', Boolean(s.basicId), s.basicId ? esc(s.basicId) : 'ตั้งตัวแปร <code>LINE_OA_BASIC_ID</code> เช่น <code>@123abcde</code> — ไม่ตั้งก็ยังใช้ได้ แต่ครูต้องหาบัญชีทางการเอง')}
        <tr><td class="text-muted">เชื่อมบัญชีแล้ว</td><td><strong>${s.linked}</strong> คน (เปิดรับแจ้งเตือนอยู่ ${s.active} คน)</td></tr>
        <tr><td class="text-muted">คิวที่รอส่ง</td><td>${s.pending} ฉบับ${s.givenUp ? ` · <span style="color:var(--danger)">เลิกส่งแล้ว ${s.givenUp} ฉบับ</span>` : ''}</td></tr>
        ${s.lastError ? `<tr><td class="text-muted">ข้อผิดพลาดล่าสุด</td><td style="color:var(--danger);font-size:.85rem">${esc(s.lastError)}</td></tr>` : ''}
      </table>
      ${s.configured ? `<div class="chip-row" style="margin-top:.8rem">
        <button class="btn btn-outline btn-sm" onclick="flushLineQueue(this)">📤 ส่งคิวที่ค้างเดี๋ยวนี้</button>
      </div>` : ''}
    </div>

    <div class="card">
      <h3 class="mt-0">ที่อยู่ Webhook ที่ต้องกรอกใน LINE Developers</h3>
      <p class="text-muted" style="font-size:.88rem">คัดลอกบรรทัดนี้ไปวางในช่อง Webhook URL แล้วกดเปิด "Use webhook"</p>
      <div class="flex gap-2 items-center">
        <input type="text" id="webhookUrl" readonly value="${esc(webhookUrl)}" style="flex:1" />
        <button class="btn btn-outline btn-sm" type="button" onclick="copyWebhook()">คัดลอก</button>
      </div>
    </div>

    <div class="card">
      <h3 class="mt-0">ขั้นตอนตั้งค่า (ทำครั้งเดียว)</h3>
      <ol style="line-height:2;padding-left:1.2rem">
        <li>สร้าง <strong>LINE Official Account</strong> ของโรงเรียนที่ <code>manager.line.biz</code> (ฟรี)</li>
        <li>เข้า <code>developers.line.biz</code> → เลือกบัญชีทางการนั้น → แท็บ <strong>Messaging API</strong></li>
        <li>คัดลอก <strong>Channel secret</strong> และกด Issue เพื่อออก <strong>Channel access token</strong></li>
        <li>เอาสองค่านั้นไปตั้งเป็นตัวแปรบนเซิร์ฟเวอร์ ชื่อ <code>LINE_CHANNEL_SECRET</code> และ
            <code>LINE_CHANNEL_ACCESS_TOKEN</code> แล้ว restart ระบบ
            <div class="text-muted" style="font-size:.82rem">ห้ามส่งค่าสองอันนี้ให้ใครทางแชท — ใครถือค่านี้ส่งข้อความในนามโรงเรียนได้ทันที</div></li>
        <li>กรอก Webhook URL ข้างบนในหน้า Messaging API แล้วเปิด "Use webhook"</li>
        <li>ปิด "Auto-reply messages" และ "Greeting messages" ในหน้า LINE Official Account Manager
            ไม่งั้นครูจะได้ข้อความตอบอัตโนมัติทับข้อความของระบบ</li>
        <li>บอกครูให้เข้า <a href="/profile">โปรไฟล์ของฉัน</a> → "แจ้งเตือนเข้าไลน์" → กดขอรหัส แล้วกดลิงก์ที่ขึ้นมา</li>
      </ol>
    </div>

    <div class="card">
      <h3 class="mt-0">ครูต้องทำอะไร</h3>
      <p>เข้าหน้า <a href="/profile">โปรไฟล์ของฉัน</a> → กดขอรหัส → กดลิงก์ที่ขึ้นมา (เพิ่มเพื่อนแล้วส่งข้อความให้อัตโนมัติ)
        หรือพิมพ์เอง <code>${esc(LINK_KEYWORD)} ตามด้วยรหัส</code> ส่งเข้าแชทบัญชีทางการของโรงเรียน</p>
      <p class="text-muted" style="font-size:.85rem">
        หนังสือชั้นความลับจะไม่ส่งเลขที่และชื่อเรื่องเข้าไลน์ ส่งแค่ว่า "มีหนังสือลับรอดำเนินการ" พร้อมลิงก์ให้เข้ามาอ่านในระบบ
      </p>
    </div>

    <script>
      function copyWebhook() {
        var el = document.getElementById('webhookUrl');
        el.select(); el.setSelectionRange(0, 99999);
        navigator.clipboard ? navigator.clipboard.writeText(el.value).then(function(){ toast('คัดลอกแล้ว', 'success'); })
          : toast('กด Ctrl+C เพื่อคัดลอก', 'info');
      }
      function flushLineQueue(btn) {
        btn.disabled = true;
        fetch('/admin/line/flush', { method: 'POST' })
          .then(function(r){ return r.json(); })
          .then(function(d){ toast('ส่งสำเร็จ ' + d.sent + ' ฉบับ · ไม่สำเร็จ ' + d.failed + ' ฉบับ', d.failed ? 'warning' : 'success');
            setTimeout(function(){ location.reload(); }, 900); })
          .catch(function(e){ toast(e.message, 'danger'); btn.disabled = false; });
      }
    </script>`;
  html(ctx, 200, layout({ user: ctx.user, title: 'แจ้งเตือนเข้าไลน์', path: '/admin/line', content }));
})));

router.post('/admin/line/flush', ADMIN_ONLY(requireApi(async (ctx) => {
  json(ctx, 200, await flushLineOutbox({ limit: 100 }));
})));
