// ไฟล์ manifest ของ PWA — สร้างแบบ dynamic เพราะต้องใส่ชื่อโรงเรียนที่แอดมินตั้งไว้ลงไป
//
// เดิมเป็นไฟล์นิ่งใน public/ ที่ฝังชื่อโรงเรียนเดิมไว้ ทำให้ตอนติดตั้งแอปลงหน้าจอมือถือ ชื่อที่ขึ้นใต้ไอคอน
// เป็นชื่อโรงเรียนอื่น — จุดที่ครูเห็นทุกวันและแก้เองไม่ได้ ตอนนี้อ่านชื่อจากค่าตั้งค่าเหมือนที่อื่นทั้งระบบ
//
// เป็นหน้าสาธารณะโดยตั้งใจ (ไม่ต้องล็อกอิน) — เบราว์เซอร์ต้องโหลด manifest ได้ตั้งแต่หน้าเข้าสู่ระบบ
// ถึงจะเสนอให้ "เพิ่มลงในหน้าจอโฮม" ได้ และไม่มีข้อมูลส่วนบุคคลอยู่ในไฟล์นี้
import { router } from '../router.js';
import { schoolName, appShortName, schoolInitials } from '../services/settings.js';
import { esc } from '../render.js';

router.get('/manifest.webmanifest', (ctx) => {
  const name = schoolName();
  const manifest = {
    name: `ระบบสารบรรณอิเล็กทรอนิกส์ ${name}`,
    // ชื่อนี้คือชื่อที่โผล่ในเมนู "แชร์" ของ LINE ด้วย — คำแนะนำวิธีใช้บนหน้าแรกอ้างค่าเดียวกันนี้
    short_name: appShortName(),
    description: `รับ-ส่ง เสนอ และลงนามหนังสือราชการของ${name}`,
    lang: 'th',
    dir: 'ltr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait-primary',
    background_color: '#f4f6f9',
    theme_color: '#2059c9',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'รับหนังสือใหม่', url: '/documents/new?direction=incoming' },
      { name: 'งานของฉัน', url: '/tasks' },
    ],
    // รับไฟล์ PDF ที่แชร์มาจากแอปอื่น (เช่น LINE) เข้าหน้าลงทะเบียนหนังสือได้เลย
    share_target: {
      action: '/share-target',
      method: 'POST',
      enctype: 'multipart/form-data',
      params: {
        title: 'title', text: 'text', url: 'url',
        files: [{ name: 'file', accept: ['application/pdf', '.pdf'] }],
      },
    },
  };
  const body = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
  ctx.res.writeHead(200, {
    'Content-Type': 'application/manifest+json; charset=utf-8',
    'Content-Length': body.length,
    // ชื่อโรงเรียนเปลี่ยนได้จากหน้าตั้งค่า จึงห้ามให้เบราว์เซอร์แคชยาว ไม่งั้นชื่อเก่าค้างบนมือถือครู
    'Cache-Control': 'no-cache',
  });
  ctx.res.end(body);
});

// ไอคอนบนแท็บเบราว์เซอร์ — สร้างจากตัวย่อของโรงเรียนที่ตั้งไว้จริง เช่นเดียวกับ manifest
//
// เดิมเป็นไฟล์นิ่ง public/favicon.svg ที่เขียนตัวอักษร "จพ" ฝังไว้ตายตัว ซึ่งเป็นตัวย่อของโรงเรียนอื่น
// ทำให้ทุกโรงเรียนที่เอาระบบนี้ไปใช้ได้ไอคอนผิดเหมือนกันหมด และแอดมินแก้เองจากในระบบไม่ได้เลย
// ตอนนี้อ่านจาก schoolInitials() ซึ่งถอดตัวย่อจากชื่อโรงเรียนให้เอง (ตั้งทับเองได้ที่ school_initials)
//
// ส่วนไอคอนบนหน้าจอโฮมของมือถือเป็นไฟล์ PNG (ดู /icon-192.png) ซึ่งสร้างสดไม่ได้เพราะต้องใช้
// โปรแกรมวาดรูป จึงเป็นไฟล์นิ่งที่สร้างไว้ล่วงหน้า — ถ้าเปลี่ยนชื่อโรงเรียน ต้องสร้างไฟล์ชุดนั้นใหม่
// (ขั้นตอนอยู่ใน deploy/คู่มือผู้ดูแลระบบ.md) แต่ไอคอนบนแท็บจะเปลี่ยนตามให้ทันทีโดยไม่ต้องทำอะไร
router.get('/favicon.svg', (ctx) => {
  const initials = schoolInitials();
  // ตัวย่อยาวกว่า 2 ตัวจะล้นกรอบ จึงย่อขนาดตัวอักษรลงตามความยาวแทนที่จะปล่อยให้ตกขอบ
  const fontSize = initials.length <= 2 ? 14 : initials.length === 3 ? 10 : 8;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">`
    + `<rect width="32" height="32" rx="7" fill="#2059c9"/>`
    + `<text x="16" y="22" font-size="${fontSize}" font-family="sans-serif" font-weight="700" fill="#fff" text-anchor="middle">${esc(initials)}</text>`
    + `</svg>`;
  const body = Buffer.from(svg, 'utf8');
  ctx.res.writeHead(200, {
    'Content-Type': 'image/svg+xml; charset=utf-8',
    'Content-Length': body.length,
    // ชื่อโรงเรียนเปลี่ยนได้จากหน้าตั้งค่า ห้ามให้เบราว์เซอร์แคชยาว ไม่งั้นตัวย่อเก่าค้างบนแท็บ
    'Cache-Control': 'no-cache',
  });
  ctx.res.end(body);
});
