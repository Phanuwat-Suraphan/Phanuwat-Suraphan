// แจ้งเตือนเข้ากลุ่ม LINE ของโรงเรียน — ใช้ LINE Messaging API ตรงๆ ด้วย fetch ไม่มี npm dependency
//
// ทำไมต้องมี: ระบบแจ้งเตือนเดิมอยู่ในเว็บอย่างเดียว ครูที่ไม่ได้เปิดเว็บจะไม่รู้ว่ามีหนังสือด่วนรออยู่
// เรื่องด่วนที่สุดจึงค้างได้เป็นวันโดยไม่มีใครรู้ ครูไทยทุกโรงเรียนอยู่ในกลุ่ม LINE อยู่แล้ว จึงเป็นช่องทาง
// ที่ถึงตัวจริงที่สุดโดยไม่ต้องให้ใครติดตั้งอะไรเพิ่ม
//
// ⚠️ LINE Notify (ที่ใช้แค่ token เดียวแล้วยิงได้เลย) ปิดให้บริการไปแล้วเมื่อ 31 มีนาคม 2568
// ตอนนี้ต้องใช้ Messaging API ผ่าน LINE Official Account แทน ซึ่งตั้งค่ายุ่งกว่าเดิมนิดหน่อย
// (ดูขั้นตอนใน deploy/LINE.md) และมีโควตาข้อความฟรีต่อเดือนจำกัด — จึงส่งเฉพาะเรื่องที่ "ด่วนจริง"
// ไม่ใช่ทุกการแจ้งเตือน ไม่งั้นโควตาหมดตั้งแต่ต้นเดือนแล้วเรื่องด่วนจริงๆ กลับส่งไม่ออก

const PUSH_URL = 'https://api.line.me/v2/bot/message/push';
const TIMEOUT_MS = 10_000;
const MAX_TEXT = 4900; // เพดานจริงของ LINE คือ 5000 ตัวอักษร เผื่อไว้เล็กน้อย

// ตัดช่องว่าง/ขึ้นบรรทัดใหม่ที่ติดมาตอนคัดลอกวาง — เกิดบ่อยมากเวลาก๊อป token ยาวๆ จากหน้าเว็บ
// ถ้าไม่ตัด ค่าที่มี \n จะทำให้การสร้าง HTTP header พังพร้อม error ภาษาอังกฤษที่อ่านไม่รู้เรื่อง
function envTrimmed(name) {
  const v = process.env[name];
  return typeof v === 'string' ? v.trim() : '';
}

export function isLineEnabled() {
  return !!(envTrimmed('LINE_CHANNEL_ACCESS_TOKEN') && envTrimmed('LINE_TARGET_ID'));
}

// สถานะการส่งล่าสุด — ใช้ขึ้นในหน้าตั้งค่า ไม่ใช่แค่บรรทัดใน log ที่ไม่มีใครเปิดดู
// (กรณีที่ต้องกันให้ได้: โควตาเดือนนี้หมด หรือ token ถูกเพิกถอน แล้วการแจ้งเตือนหยุดเงียบๆ)
const status = { lastOkAt: null, lastError: null, sentCount: 0 };

export function getLineStatus() {
  if (!isLineEnabled()) return { state: 'off', ...status };
  if (status.lastError && (!status.lastOkAt || status.lastError.at > status.lastOkAt)) {
    return { state: 'warn', ...status };
  }
  return { state: status.lastOkAt ? 'ok' : 'pending', ...status };
}

/**
 * ส่งข้อความเข้ากลุ่ม/บัญชีที่ตั้งไว้ — คืน { ok, error }
 *
 * ไม่ throw เด็ดขาด: การแจ้งเตือนเป็นผลพลอยได้ของการบันทึกงาน ถ้า LINE ล่มหรือโควตาหมดแล้วไปทำให้
 * การอนุมัติ/ลงนามที่สำเร็จไปแล้วกลายเป็น error ผู้ใช้จะกดซ้ำจนเกิดรายการซ้ำซ้อน
 */
export async function sendLineMessage(text) {
  if (!isLineEnabled()) return { ok: false, error: 'ยังไม่ได้ตั้งค่า LINE' };
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: 'ข้อความว่างเปล่า' };

  // HTTP header รับได้เฉพาะอักขระ ASCII — ถ้า token ที่คัดลอกมามีอักขระอื่นปน (เช่น ก๊อปเกินมาโดนตัวอักษร
  // ภาษาไทยข้างเคียง) fetch จะโยน error ภาษาอังกฤษที่ไม่มีทางเดาได้ว่าต้องแก้ตรงไหน ดักบอกเป็นภาษาคนก่อน
  const token = envTrimmed('LINE_CHANNEL_ACCESS_TOKEN');
  if (!/^[\x20-\x7E]+$/.test(token)) {
    const message = 'LINE_CHANNEL_ACCESS_TOKEN มีอักขระที่ใช้ไม่ได้ปนอยู่ (ต้องเป็นตัวอักษรอังกฤษ/ตัวเลขเท่านั้น) — น่าจะคัดลอกเกินมา ลองคัดลอกใหม่จากหน้า LINE Developers Console';
    status.lastError = { message, at: Date.now() };
    console.error(`[line] ${message}`);
    return { ok: false, error: message };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(PUSH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        to: envTrimmed('LINE_TARGET_ID'),
        messages: [{ type: 'text', text: body.slice(0, MAX_TEXT) }],
      }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      // 429 = โควตาข้อความฟรีของเดือนนี้หมด ซึ่งเป็นสาเหตุที่พบบ่อยที่สุดและแก้ได้เอง
      const detail = res.status === 429
        ? 'โควตาข้อความฟรีของเดือนนี้หมดแล้ว — รอต้นเดือนหน้า หรืออัปเกรดแพ็กเกจ LINE Official Account'
        : (data.message || res.statusText);
      throw new Error(`LINE ตอบกลับ ${res.status}: ${detail}`);
    }
    status.lastOkAt = Date.now();
    status.lastError = null;
    status.sentCount++;
    return { ok: true };
  } catch (err) {
    const message = err.name === 'AbortError' ? 'ส่งไม่สำเร็จ: LINE ไม่ตอบกลับภายในเวลาที่กำหนด' : err.message;
    status.lastError = { message, at: Date.now() };
    console.error(`[line] ${message}`);
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ที่อยู่เต็มของเว็บ สำหรับใส่ลิงก์ในข้อความ LINE — ต้องเป็น URL เต็มเพราะคนกดจากแอป LINE
 * ตั้งผ่าน PUBLIC_BASE_URL ถ้าไม่ตั้งก็ไม่ต้องมีลิงก์ ดีกว่าใส่ลิงก์ที่กดแล้วไปไม่ถึง
 */
export function publicUrl(path) {
  const base = (process.env.PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  return base ? `${base}${path}` : null;
}
