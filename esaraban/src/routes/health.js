import { router, json } from '../router.js';
import { db } from '../db.js';

// DevOps Bible §32 — unauthenticated health check for uptime monitoring / load balancers.
// No session lookups or heavy queries: must stay cheap and fast.
router.get('/health', (ctx) => {
  let dbOk = false;
  try {
    db.prepare('SELECT 1').get();
    dbOk = true;
  } catch (e) {
    dbOk = false;
  }
  json(ctx, dbOk ? 200 : 503, {
    status: dbOk ? 'ok' : 'error',
    database: dbOk ? 'connected' : 'error',
    uptime_seconds: Math.floor(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});
