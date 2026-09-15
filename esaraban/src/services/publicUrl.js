// ที่อยู่เว็บของระบบแบบเต็ม (https://ชื่อเว็บ) สำหรับใส่ในข้อความที่ส่งออกไปนอกระบบ
//
// ลิงก์ภายในหน้าเว็บใช้เส้นทางสั้นๆ อย่าง /documents/xxx ได้ เพราะเบราว์เซอร์เติมชื่อเว็บให้เอง
// แต่ข้อความที่ส่งไป LINE ไม่มีอะไรมาเติมให้ — ต้องเป็นที่อยู่เต็มไม่งั้นกดไม่ได้เลย
//
// ปัญหาคือจุดที่สร้างข้อความแจ้งเตือน (notifyUser) ไม่ได้อยู่ในเส้นทางที่มี request อยู่ในมือเสมอ
// เช่น ตัวส่งคิวที่ทำงานเป็นรอบๆ จึงต้องจำที่อยู่ที่เห็นจาก request ล่าสุดไว้ให้ใช้ต่อ
let remembered = '';
// "รู้แน่ๆ ว่าผู้ใช้เข้ามาด้วย https" ต่างจากที่อยู่ที่จำไว้ ซึ่งเป็นการ "เดา" เมื่อไม่มีอะไรบอก
// (ดูเหตุผลที่ต้องแยกกันในคอมเมนต์ของ observedHttps ด้านล่าง)
let sawHttps = false;

/** อ่านจากหัว request แล้วจำไว้ — เรียกจาก server.js ทุก request (ราคาถูกมาก แค่ต่อสตริง) */
export function rememberBaseUrl(headers) {
  const host = headers?.host;
  if (!host) return;
  // Render/Nginx ส่ง x-forwarded-proto มาบอกว่าผู้ใช้เข้ามาด้วย https จริงหรือไม่ — ถ้าดูแค่ที่ขา
  // ภายในจะเห็นเป็น http เสมอ แล้วลิงก์ที่ส่งไป LINE จะเป็น http:// ซึ่งเบราว์เซอร์มือถือเตือนว่าไม่ปลอดภัย
  const forwarded = String(headers['x-forwarded-proto'] || '').split(',')[0].trim();
  if (forwarded === 'https') sawHttps = true;
  const proto = forwarded
    || (host.startsWith('localhost') || host.startsWith('127.0.0.1') ? 'http' : 'https');
  remembered = `${proto}://${host}`;
}

/**
 * ผู้ใช้เข้ามาด้วย https จริงหรือไม่ — ต่างจาก publicBaseUrl() ตรงที่ "ไม่เดา"
 *
 * ทำไมต้องแยก: publicBaseUrl() เดาเป็น https เมื่อไม่มีอะไรบอก เพราะลิงก์ที่เดาผิดเป็น http แล้ว
 * ส่งไปไลน์จะขึ้นคำเตือน "ไม่ปลอดภัย" ซึ่งน่ากลัวกว่า — การเดาแบบนั้นเสียหายน้อย
 *
 * แต่ธง Secure ของคุกกี้เซสชันเดาไม่ได้เด็ดขาด ถ้าเดาผิดเป็น https ทั้งที่จริงเป็น http
 * เบราว์เซอร์จะทิ้งคุกกี้ทิ้งทั้งใบแล้ว "ไม่มีใครล็อกอินได้เลยทั้งโรงเรียน" — กรณีที่เกิดจริงคือ
 * โรงเรียนที่ติดตั้งระบบไว้บนเครื่องในโรงเรียนเอง เข้าผ่าน http://192.168.x.x ซึ่งไม่มี
 * x-forwarded-proto และเบราว์เซอร์ก็ไม่ยกเว้นให้เหมือน localhost
 *
 * จึงคืน true เฉพาะเมื่อมีหลักฐานจริงเท่านั้น: เห็นหัว x-forwarded-proto: https มากับ request
 * หรือผู้ดูแลตั้ง PUBLIC_BASE_URL เป็น https ไว้เอง (ซึ่งถือเป็นการยืนยันด้วยตัวเอง)
 */
export function observedHttps() {
  const fromEnv = String(process.env.PUBLIC_BASE_URL || '').trim();
  if (fromEnv) return fromEnv.startsWith('https://');
  return sawHttps;
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
export function _resetRememberedBaseUrl() { remembered = ''; sawHttps = false; }
