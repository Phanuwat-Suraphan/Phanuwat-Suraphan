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

export function redirect(ctx, location, extraHeaders) {
  ctx.res.writeHead(302, { Location: location, ...(extraHeaders || {}) });
  ctx.res.end();
}
