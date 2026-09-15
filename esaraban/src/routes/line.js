// เส้นทางที่เกี่ยวกับ LINE — ตัวรับ webhook, การเชื่อมบัญชีของแต่ละคน และหน้าตั้งค่าของผู้ดูแล
import { router, html, json, redirect } from '../router.js';
import { layout, esc, fmtDate } from '../render.js';
import { requireApi, requireRole, requirePage } from '../middleware.js';
import { audit } from '../db.js';
import { safeNextPath } from '../services/validate.js';
import {
  verifyLineSignature, handleLineEvents, isLineWebhookConfigured, isLineNotifyConfigured,
  createLinkCode, unlinkLineAccount, setLineNotifyEnabled, lineNotifyStatus,
  flushLineOutbox, LINK_KEYWORD, liffId, linkLineAccountByIdToken,
  recordLineWebhook, recentLineWebhooks,
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
    // จุดนี้สำคัญที่สุดที่ต้องบันทึกไว้ — เป็นอาการของ "ออก Channel secret ใหม่แล้วลืมเอาไปแก้บนเซิร์ฟเวอร์"
    // ซึ่งจากฝั่งผู้ใช้เห็นเป็นแค่ "ส่งรหัสไปแล้วเงียบ" เหมือนกับตอนที่ยังไม่ได้เปิดสวิตช์ Use webhook เป๊ะๆ
    // ทั้งที่แก้คนละที่กัน ถ้าไม่บันทึกไว้ก็แยกสองกรณีนี้ออกจากกันไม่ได้เลย
    recordLineWebhook('signature_failed', signature ? null : 'ไม่มีหัว x-line-signature มาด้วย');
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

// ───────────────────────────── เปิดระบบในแอป LINE (LIFF) ─────────────────────────────
//
// LIFF คือการเปิดหน้าเว็บนี้ขึ้นมา "ในแอป LINE" เลย ไม่เด้งออกไปเบราว์เซอร์ภายนอก ซึ่งสำคัญกว่าที่คิด
// บนมือถือ: เบราว์เซอร์ภายนอกมักไม่ได้ล็อกอินค้างไว้ ครูจึงต้องพิมพ์รหัสผ่านใหม่ทุกครั้งที่กดลิงก์
// จากกลุ่มไลน์ ซึ่งบนมือถือคือเหตุผลอันดับหนึ่งที่คนเลิกกดลิงก์
//
// ตั้งเป็น Endpoint URL ของ LIFF app และตั้งเป็นปุ่มในเมนูด้านล่างแชท (rich menu) ของบัญชีโรงเรียน
const LIFF_SDK = 'https://static.line-scdn.net/liff/edge/2/sdk.js';

router.get('/liff', (ctx) => {
  // ปลายทางต้องเป็นเส้นทางภายในเว็บนี้เท่านั้น — ที่อยู่นี้เดินทางผ่านกลุ่มไลน์ ถ้าปล่อยให้ชี้ออกนอกได้
  // จะกลายเป็นลิงก์ที่ขึ้นชื่อเว็บโรงเรียนแต่พาไปเว็บปลอม (ดู services/validate.js)
  const to = safeNextPath(ctx.query.to) || '/';
  const id = liffId();

  // CSP ของทั้งระบบอนุญาตเฉพาะสคริปต์จากเว็บตัวเอง ซึ่งจะบล็อก SDK ของ LIFF เงียบๆ (ไม่มี error
  // ให้เห็นบนหน้าจอด้วย) จึงต้องผ่อนเฉพาะหน้านี้หน้าเดียวให้โหลดจากโดเมนของ LINE ได้
  // ไม่ผ่อนทั้งระบบ เพราะหน้าอื่นไม่มีเหตุผลต้องโหลดสคริปต์จากข้างนอกเลย
  const csp = [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' ${new URL(LIFF_SDK).origin}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    'connect-src \'self\' https://api.line.me',
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');

  if (!id) {
    // ยังไม่ได้ตั้งค่า LIFF — พาเข้าระบบตามปกติ ดีกว่าขึ้นหน้าขาวให้ครูงง
    return redirect(ctx, to);
  }

  const body = `<!doctype html>
<html lang="th"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>กำลังเปิดระบบสารบรรณ</title>
<link rel="stylesheet" href="/style.css" />
<script src="${LIFF_SDK}"></script>
</head><body>
<div style="display:flex;min-height:70vh;align-items:center;justify-content:center;text-align:center;padding:2rem">
  <div>
    <div style="font-size:2.4rem">💬</div>
    <p id="liffMsg">กำลังเปิดระบบสารบรรณ...</p>
    <p><a class="btn btn-outline btn-sm" href="${esc(to)}">เปิดแบบปกติ</a></p>
  </div>
</div>
<script>
  (function () {
    var to = ${JSON.stringify(to)};
    var loggedIn = ${ctx.user ? 'true' : 'false'};
    function go() { window.location.replace(to); }
    function fail(msg) { document.getElementById('liffMsg').textContent = msg; setTimeout(go, 1200); }
    if (typeof liff === 'undefined') return fail('เปิดระบบตามปกติแทน');
    liff.init({ liffId: ${JSON.stringify(id)} }).then(function () {
      // ยังไม่ได้ล็อกอินระบบสารบรรณ — ไปล็อกอินก่อน แล้วค่อยกลับมาผูกบัญชีรอบหน้า
      if (!loggedIn || !liff.isLoggedIn()) return go();
      var token = liff.getIDToken && liff.getIDToken();
      if (!token) return go();
      // ผูกบัญชีไลน์ให้อัตโนมัติ ไม่ต้องให้ครูขอรหัสแล้วพิมพ์ส่งเข้าแชทเอง
      // ล้มเหลวก็แค่ไม่ผูก ไม่ขวางการเข้าใช้งาน (ยังไปวิธีขอรหัสที่หน้าโปรไฟล์ได้)
      fetch('/liff/link', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken: token }) }).then(go).catch(go);
    }).catch(function () { go(); });
  })();
</script>
</body></html>`;
  ctx.res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': csp });
  ctx.res.end(body);
});

router.post('/liff/link', requireApi(async (ctx) => {
  const res = await linkLineAccountByIdToken({ userId: ctx.user.id, idToken: ctx.body?.idToken });
  if (!res.ok) return json(ctx, 400, { error: 'เชื่อมบัญชีอัตโนมัติไม่สำเร็จ', reason: res.reason });
  json(ctx, 200, res);
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

// คำอธิบายของแต่ละร่องรอย — เขียนเป็นภาษาที่คนตั้งค่าอ่านแล้วรู้ว่า "ต้องไปแก้ที่ไหน" ไม่ใช่ชื่อทางเทคนิค
const WEBHOOK_KIND_LABEL = {
  signature_failed: { text: 'ลายเซ็นไม่ตรง — ปฏิเสธไป', cls: 'badge-danger',
    hint: 'ค่า <code>LINE_CHANNEL_SECRET</code> บนเซิร์ฟเวอร์ไม่ตรงกับ Channel secret ที่อยู่ใน LINE Developers ตอนนี้ (เจอบ่อยที่สุดคือกด Issue ออกค่าใหม่แล้วลืมเอามาแก้) — คัดลอกค่าปัจจุบันมาตั้งใหม่แล้ว restart' },
  follow: { text: 'มีคนเพิ่มเพื่อน', cls: 'badge-info', hint: 'เพิ่มเพื่อนแล้วยังไม่ได้เชื่อมบัญชี ต้องส่งรหัสเข้ามาอีกทีถึงจะได้รับแจ้งเตือน' },
  unfollow: { text: 'มีคนบล็อก/ลบบัญชีทางการ', cls: 'badge-muted', hint: '' },
  link_ok: { text: 'เชื่อมบัญชีสำเร็จ', cls: 'badge-success', hint: '' },
  link_expired: { text: 'รหัสหมดอายุ', cls: 'badge-warning', hint: 'รหัสมีอายุ 30 นาที — ให้เจ้าตัวกดขอรหัสใหม่ที่หน้าโปรไฟล์ของฉันแล้วส่งภายในเวลานั้น' },
  link_invalid: { text: 'ไม่พบรหัสนี้', cls: 'badge-warning', hint: 'พิมพ์ผิด หรือรหัสถูกใช้ไปแล้ว — ให้กดขอรหัสใหม่ (ตัวอักษรในรหัสไม่มี I, L, O, 0, 1 เพื่อกันอ่านสลับ)' },
  no_code: { text: 'ข้อความทั่วไป (ไม่มีรหัส)', cls: 'badge-muted', hint: '' },
  ignored: { text: 'ข้อความที่ไม่ใช่ตัวหนังสือ', cls: 'badge-muted', hint: '' },
  error: { text: 'เกิดข้อผิดพลาด', cls: 'badge-danger', hint: '' },
};

// การ์ด "LINE ติดต่อเข้ามาหรือยัง" — ตอบคำถามที่หน้าสถานะด้านบนตอบไม่ได้
//
// หน้าสถานะบอกได้แค่ว่า "เราตั้งค่าครบแล้วหรือยัง" ซึ่งขึ้นเขียวตั้งแต่ตั้งตัวแปรเสร็จ ไม่ได้แปลว่า LINE
// ยิงเข้ามาถึงเครื่องเราได้จริง สองอย่างนี้ต่างกันมาก และตอนติดตั้งจริงคนตั้งค่าจะติดตรงช่องว่างนี้เสมอ:
// เขียวหมดทุกบรรทัดแล้วแต่ส่งรหัสเข้าแชทกลับเงียบ แล้วไม่รู้จะไปดูที่ไหนต่อ
function webhookLogCard(hooks, s) {
  if (!s.webhookReady) return '';
  const body = hooks.length ? `
    <table class="table-plain">
      ${hooks.map((h) => {
        const k = WEBHOOK_KIND_LABEL[h.kind] || { text: h.kind, cls: 'badge-muted', hint: '' };
        return `<tr>
          <td class="text-muted" style="white-space:nowrap;font-size:.85rem">${esc(fmtDate(h.received_at))}</td>
          <td><span class="badge ${k.cls}">${esc(k.text)}</span>
            ${k.hint ? `<div class="text-muted" style="font-size:.82rem;margin-top:.2rem">${k.hint}</div>` : ''}
            ${h.detail ? `<div class="text-muted" style="font-size:.8rem">${esc(h.detail)}</div>` : ''}</td>
        </tr>`;
      }).join('')}
    </table>
    <p class="text-muted" style="font-size:.82rem;margin-bottom:0">
      เก็บไว้ 50 รายการล่าสุดเท่านั้น และไม่เก็บเนื้อข้อความที่ครูพิมพ์เข้ามา
    </p>`
    : `
    <div class="alert alert-warning" style="margin-bottom:.8rem">
      <strong>ยังไม่เคยมีอะไรยิงเข้ามาจาก LINE เลย</strong> — แปลว่าข้อความที่ส่งเข้าแชทยังมาไม่ถึงเซิร์ฟเวอร์นี้
      การตั้งค่าด้านบนขึ้นเขียวหมายถึงเราพร้อมรับแล้วเท่านั้น ไม่ได้แปลว่า LINE รู้ว่าต้องส่งมาที่ไหน
    </div>
    <p style="margin-top:0">ไล่ตามลำดับนี้ที่ <code>developers.line.biz</code> → แท็บ Messaging API:</p>
    <ol style="line-height:2;padding-left:1.2rem;margin-bottom:0">
      <li>ช่อง <strong>Webhook URL</strong> ต้องเป็นที่อยู่ในกรอบถัดไปข้างล่าง และต้อง<strong>กด Update/Save</strong> แล้วจริงๆ</li>
      <li>สวิตช์ <strong>Use webhook</strong> ต้องเปิดอยู่ (เป็นคนละอย่างกับการกรอก URL — กรอกแล้วแต่ไม่เปิดสวิตช์คือไม่ส่งมา)</li>
      <li>กดปุ่ม <strong>Verify</strong> ข้างช่อง Webhook URL — ถ้าขึ้น Success แล้วกลับมาที่หน้านี้จะเห็นรายการโผล่ขึ้นมาทันที</li>
      <li>ถ้า Verify ไม่ผ่าน ให้เปิดเว็บระบบสารบรรณในเบราว์เซอร์ก่อนสัก 1 ครั้งแล้วลองใหม่
        <div class="text-muted" style="font-size:.82rem">เซิร์ฟเวอร์แบบฟรีจะหลับเองเมื่อไม่มีคนใช้ ปลุกให้ตื่นแล้วค่อย Verify</div></li>
    </ol>`;
  return `<div class="card">
    <h3 class="mt-0">📡 LINE ติดต่อเข้ามาหรือยัง</h3>
    <p class="text-muted" style="font-size:.88rem;margin-top:-.3rem">
      ใช้ตอบคำถามว่า "ส่งรหัสเชื่อมบัญชีไปแล้วทำไมเงียบ" — ถ้ามีรายการขึ้นที่นี่แปลว่าข้อความมาถึงเราแล้ว
      ปัญหาอยู่หลังจากนั้น ถ้าไม่มีอะไรเลยแปลว่ายังมาไม่ถึง ต้องไปแก้ที่ฝั่ง LINE
    </p>
    ${body}
  </div>`;
}

router.get('/admin/line', ADMIN_ONLY(requirePage((ctx) => {
  const s = lineNotifyStatus();
  const hooks = recentLineWebhooks(15);
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
        ${statusRow('เปิดระบบในแอป LINE (LIFF)', s.liffReady, s.liffReady ? esc(s.liffId)
          : 'ตั้งตัวแปร <code>LINE_LIFF_ID</code> และ <code>LINE_LOGIN_CHANNEL_ID</code> — ไม่ตั้งก็ใช้ได้ทุกอย่าง แค่เปิดในเบราว์เซอร์ปกติแทน')}
        <tr><td class="text-muted">เชื่อมบัญชีแล้ว</td><td><strong>${s.linked}</strong> คน (เปิดรับแจ้งเตือนอยู่ ${s.active} คน)</td></tr>
        <tr><td class="text-muted">คิวที่รอส่ง</td><td>${s.pending} ฉบับ${s.givenUp ? ` · <span style="color:var(--danger)">เลิกส่งแล้ว ${s.givenUp} ฉบับ</span>` : ''}</td></tr>
        ${s.lastError ? `<tr><td class="text-muted">ข้อผิดพลาดล่าสุด</td><td style="color:var(--danger);font-size:.85rem">${esc(s.lastError)}</td></tr>` : ''}
      </table>
      ${s.configured ? `<div class="chip-row" style="margin-top:.8rem">
        <button class="btn btn-outline btn-sm" onclick="flushLineQueue(this)">📤 ส่งคิวที่ค้างเดี๋ยวนี้</button>
      </div>` : ''}
    </div>

    ${webhookLogCard(hooks, s)}

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
      <h3 class="mt-0">เปิดระบบในแอป LINE เลย (LIFF) — ไม่บังคับ</h3>
      <p class="text-muted" style="font-size:.88rem">
        ปกติครูกดลิงก์จากกลุ่มไลน์แล้วเด้งออกไปเบราว์เซอร์ภายนอก ซึ่งมักไม่ได้ล็อกอินค้างไว้
        ต้องพิมพ์รหัสผ่านใหม่ทุกครั้ง — เปิดใช้ LIFF แล้วระบบจะเปิดขึ้นมาในแอป LINE เลย
        และผูกบัญชีไลน์ให้อัตโนมัติโดยไม่ต้องขอรหัส
      </p>
      <ol style="line-height:2;padding-left:1.2rem">
        <li>ที่ <code>developers.line.biz</code> สร้าง channel แบบ <strong>LINE Login</strong> ไว้ใน
            provider <strong>เดียวกัน</strong>กับ Messaging API channel ข้างบน
            <div class="text-muted" style="font-size:.82rem">ต้องเป็น provider เดียวกันจริงๆ — ไม่งั้นรหัสผู้ใช้ที่ได้จากสองที่จะคนละตัว แล้วข้อความจะส่งไม่ถึง</div></li>
        <li>ในแท็บ LIFF กด Add แล้วตั้ง Endpoint URL เป็น <code>${esc(webhookUrl.replace('/line/webhook', '/liff'))}</code>
            · Size: Full · เปิด Scope <code>profile</code> และ <code>openid</code></li>
        <li>ตั้งตัวแปร <code>LINE_LIFF_ID</code> = LIFF ID ที่ได้ และ
            <code>LINE_LOGIN_CHANNEL_ID</code> = Channel ID ของ LINE Login channel นั้น แล้ว restart</li>
        <li>เอา LIFF URL (<code>https://liff.line.me/&lt;LIFF ID&gt;</code>) ไปตั้งเป็นปุ่มใน
            เมนูด้านล่างแชท (rich menu) ของบัญชีทางการ ครูก็กดเข้าระบบได้จากในไลน์เลย</li>
      </ol>
      <p class="text-muted" style="font-size:.85rem">
        ไม่ตั้งค่าส่วนนี้ก็ใช้งานได้ทุกอย่างตามปกติ แค่เปิดในเบราว์เซอร์ภายนอกแทน
      </p>
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
