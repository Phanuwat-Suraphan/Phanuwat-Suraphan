import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getSessionUser, parseCookie } from './src/auth.js';
import { db } from './src/db.js';
import { router } from './src/router.js';
import './src/routes/index.js'; // registers all routes onto `router`

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = process.env.PORT || 3000;

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  const filePath = path.join(PUBLIC_DIR, pathname.replace('/', ''));
  if (!filePath.startsWith(PUBLIC_DIR)) return false;
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) return false;
  const ext = path.extname(filePath);
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    const MAX = 15 * 1024 * 1024; // 15MB (base64 file payloads)
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function unreadNotificationCount(userId) {
  return db.prepare('SELECT COUNT(*) c FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).c;
}

// Security Bible §31 — applied via setHeader so every response gets them regardless of which
// route handler eventually calls writeHead(); a route can still override a specific header.
// CSP allows 'unsafe-inline' for script/style because the whole app is server-rendered HTML with
// inline <script> blocks (no build step to inject nonces) — a real weakening of CSP's XSS defense,
// but input is already escaped via esc() everywhere, and a nonce-based rewrite of every inline
// script in the codebase is a much larger change than "add security headers" warrants right now.
function applySecurityHeaders(res) {
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; '));
}

const server = http.createServer(async (req, res) => {
  try {
    applySecurityHeaders(res);
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = decodeURIComponent(url.pathname);

    if (pathname === '/' || !pathname.startsWith('/api') ) {
      if (pathname.startsWith('/style.css') || pathname.startsWith('/app.js') || pathname.match(/\.(css|js|png|svg|ico)$/)) {
        if (serveStatic(req, res, pathname)) return;
      }
    }

    const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString();
    const user = getSessionUser(req.headers.cookie);
    if (user) user.unreadCount = unreadNotificationCount(user.id);

    let body = {};
    if (req.method === 'POST' || req.method === 'PUT') {
      const raw = await readBody(req);
      const ct = req.headers['content-type'] || '';
      if (ct.includes('application/json')) {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } else if (ct.includes('application/x-www-form-urlencoded')) {
        body = Object.fromEntries(new URLSearchParams(raw.toString('utf8')));
      }
    }

    const ctx = { req, res, url, query: Object.fromEntries(url.searchParams), user, body, ip };
    const handled = await router.dispatch(req.method, pathname, ctx);
    if (!handled) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<h1>404</h1><p>ไม่พบหน้านี้ — <a href="/">กลับหน้าแรก</a></p>');
    }
  } catch (err) {
    console.error(err);
    const status = err.statusCode || 500;
    if (!res.headersSent) {
      if (req.headers['content-type']?.includes('application/json') || req.url.startsWith('/api')) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message || 'เกิดข้อผิดพลาดของระบบ' }));
      } else {
        res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<h1>เกิดข้อผิดพลาด</h1><p>${err.message}</p><a href="/">กลับหน้าแรก</a>`);
      }
    }
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`e-Saraban prototype listening on http://0.0.0.0:${PORT}`);
});
