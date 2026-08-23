import { redirect, json } from './router.js';

// เส้นทางที่ยังเข้าได้ทั้งที่ยังไม่ได้ตั้งรหัสผ่านใหม่ — ต้องมีหน้าตั้งรหัสเองกับทางออกจากระบบ ไม่งั้น
// ผู้ใช้จะติดอยู่ในวงวนที่ทุกหน้าเด้งไปหน้าเดิมแต่หน้านั้นก็เด้งตัวเอง
const FIRST_LOGIN_ALLOWED = new Set(['/first-login', '/logout', '/privacy']);

/**
 * บัญชีที่ยังใช้รหัสผ่านที่คนอื่นตั้งให้ ต้องตั้งรหัสผ่านและ PIN ใหม่ก่อนใช้งานอย่างอื่นทั้งหมด
 *
 * ตรวจตรงนี้ที่เดียว ไม่ใช่ไปแปะทีละหน้า เพราะทุกหน้า/ทุก API ผ่าน requirePage/requireApi อยู่แล้ว
 * ถ้าปล่อยให้แต่ละหน้าตรวจเอง หน้าที่เพิ่มใหม่ในอนาคตจะกลายเป็นช่องโหว่โดยไม่มีใครรู้ตัว
 */
function mustSetOwnPassword(ctx) {
  return Boolean(ctx.user?.must_change_password) && !FIRST_LOGIN_ALLOWED.has(ctx.url?.pathname);
}

export function requirePage(handler) {
  return (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login');
    if (mustSetOwnPassword(ctx)) return redirect(ctx, '/first-login');
    return handler(ctx);
  };
}

export function requireApi(handler) {
  return async (ctx) => {
    if (!ctx.user) return json(ctx, 401, { error: 'กรุณาเข้าสู่ระบบ' });
    if (mustSetOwnPassword(ctx)) {
      return json(ctx, 403, { error: 'กรุณาตั้งรหัสผ่านและ PIN ของตัวเองก่อนใช้งาน', redirect: '/first-login' });
    }
    try {
      await handler(ctx);
    } catch (err) {
      json(ctx, err.statusCode || 500, { error: err.message || 'เกิดข้อผิดพลาด' });
    }
  };
}

export function requireRole(...roles) {
  return (handler) => (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login');
    if (mustSetOwnPassword(ctx)) return redirect(ctx, '/first-login');
    if (!ctx.user.roleCodes.some((r) => roles.includes(r))) {
      ctx.res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return ctx.res.end('<h1>403</h1><p>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p><a href="/">กลับหน้าแรก</a>');
    }
    return handler(ctx);
  };
}
