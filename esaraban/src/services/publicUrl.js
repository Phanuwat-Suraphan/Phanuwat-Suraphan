// ที่อยู่เว็บของระบบแบบเต็ม (https://ชื่อเว็บ) สำหรับใส่ในข้อความที่ส่งออกไปนอกระบบ
//
// ลิงก์ภายในหน้าเว็บใช้เส้นทางสั้นๆ อย่าง /documents/xxx ได้ เพราะเบราว์เซอร์เติมชื่อเว็บให้เอง
// แต่ข้อความที่ส่งไป LINE ไม่มีอะไรมาเติมให้ — ต้องเป็นที่อยู่เต็มไม่งั้นกดไม่ได้เลย
//
// ปัญหาคือจุดที่สร้างข้อความแจ้งเตือน (notifyUser) ไม่ได้อยู่ในเส้นทางที่มี request อยู่ในมือเสมอ
// เช่น ตัวส่งคิวที่ทำงานเป็นรอบๆ จึงต้องจำที่อยู่ที่เห็นจาก request ล่าสุดไว้ให้ใช้ต่อ
let remembered = '';

/** อ่านจากหัว request แล้วจำไว้ — เรียกจาก server.js ทุก request (ราคาถูกมาก แค่ต่อสตริง) */
export function rememberBaseUrl(headers) {
  const host = headers?.host;
  if (!host) return;
  // Render/Nginx ส่ง x-forwarded-proto มาบอกว่าผู้ใช้เข้ามาด้วย https จริงหรือไม่ — ถ้าดูแค่ที่ขา
  // ภายในจะเห็นเป็น http เสมอ แล้วลิงก์ที่ส่งไป LINE จะเป็น http:// ซึ่งเบราว์เซอร์มือถือเตือนว่าไม่ปลอดภัย
  const proto = String(headers['x-forwarded-proto'] || '').split(',')[0].trim()
    || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  remembered = `${proto}://${host}`;
}

/** ที่อยู่เว็บแบบเต็ม ไม่มี / ปิดท้าย — คืนค่าว่างถ้ายังไม่เคยเห็น request เลยและไม่ได้ตั้ง env ไว้
 *
 *  PUBLIC_BASE_URL ชนะค่าที่จำไว้เสมอ เผื่อกรณีที่โรงเรียนใช้ชื่อโดเมนของตัวเองวางหน้า Render อีกที
 *  (ผู้ใช้เข้าผ่านโดเมนโรงเรียน แต่หัว host ที่มาถึงเป็นชื่อภายในของผู้ให้บริการ)
 */
export function publicBaseUrl() {
  const fromEnv = String(process.env.PUBLIC_BASE_URL || '').trim().replace(/\/+$/, '');
  if (fromEnv) return fromEnv;
  return remembered;
}

/** ต่อเส้นทางภายในเข้ากับที่อยู่เว็บ — ถ้ายังไม่รู้ที่อยู่เว็บ คืนเส้นทางเดิมไปตรงๆ */
export function absoluteUrl(pathname) {
  const base = publicBaseUrl();
  const p = String(pathname || '/');
  if (/^https?:\/\//i.test(p)) return p;
  return base ? `${base}${p.startsWith('/') ? '' : '/'}${p}` : p;
}

// สำหรับเทสต์ — ล้างค่าที่จำไว้ เพื่อให้แต่ละเทสต์เริ่มจากสภาพเดียวกัน
export function _resetRememberedBaseUrl() { remembered = ''; }
