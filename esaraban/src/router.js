class Router {
  constructor() {
    this.routes = []; // { method, regex, keys, handler }
  }

  add(method, pattern, handler) {
    const keys = [];
    const regexStr = pattern
      .replace(/\/:([A-Za-z0-9_]+)/g, (_, key) => {
        keys.push(key);
        return '/([^/]+)';
      });
    const regex = new RegExp(`^${regexStr}$`);
    this.routes.push({ method, regex, keys, handler });
  }

  get(pattern, handler) { this.add('GET', pattern, handler); }
  post(pattern, handler) { this.add('POST', pattern, handler); }

  async dispatch(method, pathname, ctx) {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.regex);
      if (!match) continue;
      ctx.params = {};
      route.keys.forEach((key, i) => { ctx.params[key] = match[i + 1]; });
      await route.handler(ctx);
      return true;
    }
    return false;
  }
}

export const router = new Router();

export function send(res, status, headers, body) {
  res.writeHead(status, headers);
  res.end(body);
}

export function html(ctx, status, htmlStr) {
  ctx.res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  ctx.res.end(htmlStr);
}

export function json(ctx, status, obj) {
  ctx.res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  ctx.res.end(JSON.stringify(obj));
}

// Node ใส่ได้เฉพาะไบต์ Latin-1 ลงในหัว HTTP ดิบ — ชื่อไฟล์ภาษาไทย (ซึ่งเป็นเรื่องปกติที่นี่) ถ้าเอาไปต่อ
// ใส่ Content-Disposition ตรงๆ จะโยน ERR_INVALID_CHAR ทำให้ตอบ 500 และดาวน์โหลดไฟล์ไม่ได้เลย
// (เจอจริงที่ไฟล์แนบของประกาศ ซึ่งเคยประกอบหัวนี้เองแยกจากของหน้าเอกสาร)
// filename* ตาม RFC 5987 เก็บชื่อจริงแบบ UTF-8 ส่วน filename= เหลือไว้เป็นตัวสำรองแบบ ASCII
// อยู่ในไฟล์นี้เพราะเป็น helper ของการตอบ HTTP เหมือน html()/json() ทุกเส้นทางที่ส่งไฟล์ต้องใช้ตัวนี้ตัวเดียว
// disposition: 'inline' ให้เบราว์เซอร์เปิดดูในแท็บ (ไฟล์แนบหนังสือ/หลักฐาน) — 'attachment' บังคับดาวน์โหลด
// ใช้กับไฟล์ที่ผู้ใช้ต้องเอาไปเปิดในโปรแกรมอื่น เช่น ไฟล์ตัวอย่างสำหรับกรอกใน Excel ซึ่งถ้าเปิดในเบราว์เซอร์
// จะกลายเป็นข้อความดิบบนหน้าจอ แล้วผู้ใช้จะไม่รู้ว่าต้องทำอะไรต่อ
// เพดานความยาวชื่อไฟล์ที่ใส่ลงหัว HTTP ได้
//
// อักษรไทยหนึ่งตัวกลายเป็น 9 ไบต์เมื่อเข้ารหัสแบบ percent-encoding (%E0%B8%81) ชื่อไฟล์ไทย 3,000 ตัว
// จึงกลายเป็นหัว Content-Disposition ขนาด 27KB ซึ่งเกินเพดาน 16KB ของ Node — วัดจริงแล้วผลคือ
// การดาวน์โหลดไฟล์นั้น "ล้มที่ระดับโปรโตคอล" (UND_ERR_HEADERS_OVERFLOW) ไม่ใช่ขึ้นข้อความบอกผู้ใช้
// แปลว่าไฟล์แนบฉบับนั้นเปิดไม่ได้อีกเลยตลอดไป และไม่มีอะไรบอกว่าทำไม
//
// ตัดที่ตัวช่วยกลางนี้ด้วย (ไม่ใช่แค่ตอนอัปโหลด) เพราะแถวที่บันทึกไว้ก่อนหน้านี้ยังมีชื่อยาวค้างอยู่
export const MAX_HEADER_FILENAME_CHARS = 120;

export function truncateFilename(name, max = MAX_HEADER_FILENAME_CHARS) {
  const s = String(name || '');
  if (s.length <= max) return s;
  const dot = s.lastIndexOf('.');
  // เก็บนามสกุลไว้เสมอ ไม่งั้นเครื่องผู้ใช้จะเปิดไฟล์ไม่ถูกโปรแกรม (นามสกุลยาวผิดปกติถือว่าไม่ใช่นามสกุล)
  const ext = dot > 0 && s.length - dot <= 10 ? s.slice(dot) : '';
  return s.slice(0, Math.max(1, max - ext.length)) + ext;
}

export function contentDispositionHeader(filename, fallback = 'document.pdf', disposition = 'inline') {
  const name = truncateFilename(String(filename || fallback));
  const stripped = name.replace(/[^\x20-\x7E]/g, '').replace(/"/g, '').trim();
  // ชื่อไทยล้วนอย่าง "ประกาศรับสมัครครู.pdf" พอตัดอักขระที่ไม่ใช่ ASCII ออกจะเหลือแค่ ".pdf" ซึ่งบนเครื่อง
  // ผู้ใช้กลายเป็นไฟล์ซ่อนที่ไม่มีชื่อ — ต้องดูเฉพาะ "ส่วนชื่อ" ไม่รวมนามสกุล เพราะนามสกุลเป็น ASCII อยู่แล้ว
  // จึงผ่านการตรวจเสมอถ้าดูทั้งสตริง
  const stem = stripped.replace(/\.[^.]*$/, '');
  // ต้องเหลือ "ตัวอักษร" ไม่ใช่แค่ตัวเลข — ชื่อไทยที่มีปีอยู่ด้วย เช่น "รายงานหนังสือ-2569.csv" หรือ
  // "ประกาศ2569.pdf" พอตัดอักขระไทยออกจะเหลือ "-2569.csv" / "2569.pdf" ซึ่งผ่านการตรวจแบบเดิม
  // (เพราะมีตัวเลข) แล้วกลายเป็นชื่อไฟล์ที่บอกไม่ได้ว่าเป็นไฟล์อะไร หรือขึ้นต้นด้วยขีดจนดูเหมือนไฟล์เสีย
  const asciiFallback = /[A-Za-z]/.test(stem) ? stripped : fallback;
  return `${disposition}; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

export function redirect(ctx, location, extraHeaders) {
  ctx.res.writeHead(302, { Location: location, ...(extraHeaders || {}) });
  ctx.res.end();
}
