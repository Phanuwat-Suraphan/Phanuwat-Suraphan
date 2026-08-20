// Service worker — มีไว้เพื่อฟีเจอร์ "แชร์ไฟล์จากแอปอื่นเข้าระบบโดยตรง" (Web Share Target) เท่านั้น
// ตั้งใจไม่ทำ offline cache ใดๆ เลย เพราะระบบสารบรรณต้องเห็นสถานะเอกสารสดใหม่เสมอ ถ้า cache ไว้แล้ว
// ผู้ใช้เห็นทะเบียน/สถานะเก่าค้างจะอันตรายกว่าประโยชน์ที่ได้ — ทุก request อื่นปล่อยผ่านไปเครือข่ายตามปกติ
//
// ปัญหาที่ฟีเจอร์นี้แก้: เดิมถ้าได้ไฟล์หนังสือมาทาง LINE บนมือถือ ต้องกดดาวน์โหลดลงเครื่อง → สลับไปเปิด
// เบราว์เซอร์ → เข้าเว็บ → กดแนบไฟล์ → ไล่หาไฟล์ในเครื่อง (ซึ่งหายากมากบนมือถือ) หลายขั้นตอนและพลาดง่าย
// พอมี share target แล้ว: ใน LINE กดแชร์ → เลือก "สารบรรณ จพ.๑" → ไฟล์เข้าฟอร์มรับหนังสือให้ทันที จบ

const SHARED_CACHE = 'esaraban-shared-inbox';
const SHARED_KEY = '/__shared-file__';

self.addEventListener('install', (event) => {
  // ข้าม waiting เพื่อให้ SW เวอร์ชันใหม่มีผลทันทีที่ deploy ไม่ต้องรอผู้ใช้ปิดแท็บทั้งหมดก่อน
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // รับเฉพาะ POST /share-target ที่ระบบปฏิบัติการยิงเข้ามาตอนผู้ใช้เลือกแชร์ไฟล์มาที่แอปนี้
  if (event.request.method === 'POST' && url.pathname === '/share-target') {
    event.respondWith(handleSharedFile(event.request));
    return;
  }
  // request อื่นๆ ไม่แตะเลย (ไม่เรียก respondWith = ปล่อยให้เบราว์เซอร์จัดการตามปกติ)
});

async function handleSharedFile(request) {
  try {
    const formData = await request.formData();
    const file = formData.getAll('file').find((f) => f && f.size > 0);
    if (!file) return Response.redirect('/documents/new?direction=incoming&shareerr=nofile', 303);

    // พักไฟล์ไว้ใน Cache Storage ชั่วคราว แล้วให้หน้าฟอร์มมาหยิบไปใส่ช่องแนบไฟล์เอง — ส่งไฟล์ผ่าน
    // redirect ตรงๆ ไม่ได้ เพราะ redirect พา body ไปด้วยไม่ได้ (นี่เป็นวิธีมาตรฐานของ Web Share Target)
    const cache = await caches.open(SHARED_CACHE);
    await cache.put(SHARED_KEY, new Response(file, {
      headers: {
        'Content-Type': file.type || 'application/pdf',
        'X-Shared-Filename': encodeURIComponent(file.name || 'shared.pdf'),
      },
    }));
    return Response.redirect('/documents/new?direction=incoming&shared=1', 303);
  } catch (err) {
    return Response.redirect('/documents/new?direction=incoming&shareerr=failed', 303);
  }
}
