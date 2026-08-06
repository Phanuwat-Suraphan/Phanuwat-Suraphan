import { redirect, json } from './router.js';

export function requirePage(handler) {
  return (ctx) => {
    if (!ctx.user) return redirect(ctx, '/login');
    return handler(ctx);
  };
}

export function requireApi(handler) {
  return async (ctx) => {
    if (!ctx.user) return json(ctx, 401, { error: 'กรุณาเข้าสู่ระบบ' });
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
    if (!ctx.user.roleCodes.some((r) => roles.includes(r))) {
      ctx.res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
      return ctx.res.end('<h1>403</h1><p>คุณไม่มีสิทธิ์เข้าถึงหน้านี้</p><a href="/">กลับหน้าแรก</a>');
    }
    return handler(ctx);
  };
}
