# ระบบสารบรรณอิเล็กทรอนิกส์ โรงเรียนเจ้าพ่อหลวงอุปถัมภ์ 1 — MVP Prototype

Working prototype covering the Phase 1 (MVP) loop end-to-end: **login → รับ/ส่งหนังสือ →
มอบหมาย/เกษียณ → อนุมัติ/ส่งต่อ → รับทราบด้วย PIN → เสร็จสิ้น → รายงาน**, responsive on both
PC and mobile. Built to be a runnable, testable first cut of the 11-part SRS discussed earlier
in this project — not the final production system.

## Why this stack (and not the one in Part 8/9 of the spec)

This sandbox's network policy blocks `npm install` (registry + all CDNs are unreachable — only
git/GitHub works). React, Express, Prisma, Tailwind, and PostgreSQL drivers could not be
installed, so the prototype uses **zero external dependencies**:

- **Server**: Node.js 22 built-in `http` module (no Express)
- **Database**: Node 22's built-in `node:sqlite` (no `pg`/Prisma — PostgreSQL 17 is what the
  full spec calls for; this is a drop-in-shaped substitute: TEXT UUID PKs, ISO timestamps,
  same table/column names, so porting to Postgres later is mostly a driver swap, not a redesign)
- **Frontend**: server-rendered HTML via template literals + hand-written responsive CSS
  (design tokens, mobile-first, light/dark via `prefers-color-scheme` + toggle) + vanilla JS
  (no React/bundler needed)
- **Auth**: `crypto.scrypt` password/PIN hashing, HMAC-signed session cookies (no
  bcrypt/jsonwebtoken packages needed)

If/when this environment (or the real deployment target) has npm registry access, porting to
the Part 8/9 stack (React + Express + Prisma + Postgres) is the natural next step — the
route handlers here map cleanly to REST endpoints, and the SQL schema maps to a Prisma schema.

## Deploying to a real server

See [`DEPLOY.md`](./DEPLOY.md) for a step-by-step cloud VPS runbook (Ubuntu + systemd + Nginx +
Let's Encrypt, matching the Part 10 deployment architecture from the spec). `deploy/` contains
ready-to-use `esaraban.service` (systemd unit), `nginx.conf` (reverse proxy), and `backup.sh`.

## Run it

```bash
cd esaraban
node server.js         # http://localhost:3000
# or: npm start / npm run dev (auto-restart on change)
```

Requires Node.js ≥ 22.5 (for `node:sqlite`). No `npm install` step — there is nothing to install.
The SQLite DB is created and seeded automatically on first run at `data/esaraban.db` (gitignored).

### Test accounts (seeded automatically)

| Username | Password | PIN | Role |
|---|---|---|---|
| admin | Admin@2569 | 111111 | ผู้ดูแลระบบ |
| director01 | Director@2569 | 222222 | ผู้อำนวยการ |
| vicedir01 | Vice@2569 | 333333 | รองผู้อำนวยการ |
| head_acad | Head@2569 | 444444 | หัวหน้าฝ่ายวิชาการ |
| reg001 | Reg@2569 | 555555 | ธุรการ |
| teacher001 | Teacher@2569 | 666666 | ครู |

## What's implemented (Phase 1 scope)

- Login/session (HMAC-signed cookie), RBAC via many-to-many `user_roles`
- รับหนังสือเข้า / สร้างหนังสือส่ง, with **atomic** running-number generation
  (`0001/2569` style, scoped by year+department+type+direction, transaction-wrapped —
  closes the concurrency gap flagged during the spec review)
- PDF attachment upload (base64 over JSON — no multipart parser needed), with file-signature
  (`%PDF-`) validation, SHA-256 hash + duplicate detection, and **ACL-checked** serving
  (`/files/:id` checks secret-level + department/assignee access before streaming — a plain
  static file URL was explicitly ruled out during the spec review)
- Sequential workflow: assign → approve-and-forward / acknowledge-and-complete / reject / return
  for revision, each a distinct status (not conflated, per the Part 5 review)
- **PIN-gated** approve/acknowledge actions (rejection only needs a reason — matches the
  resolved decision that PIN suffices for lower-stakes acknowledgement while higher-stakes
  actions get a dedicated confirm step)
- Append-only audit log (`audit_logs` — no `updated_at`/`deleted_at`, matches the "ห้ามลบ
  ข้อมูลเด็ดขาด" requirement) recording login, document, workflow, attachment, and export events
- Void (not delete) for draft/registered documents only, with mandatory reason — documents
  already in workflow cannot be voided, and running numbers are never reused
- Dashboard (role-aware KPIs), "งานของฉัน" task list, in-app notifications, CSV report export
- Responsive layout: fixed sidebar on desktop ≥900px, bottom nav + slide-out drawer on mobile,
  light/dark theme

## Explicitly deferred (documented, not built)

These were flagged throughout the spec review as later-phase items; the schema/routes don't
block adding them, but they are **not implemented** here:

- OCR, Thai full-text search, AI features (Part 4, 11)
- PDF annotation/stamp layer, cryptographic signature engine, PKI/digital certificates (Part 6)
- Email/LINE notifications (only in-app notifications exist)
- Multi-tenant `school_id` scoping, Docker/CI-CD/monitoring stack (Part 9, 10)
- Delegation/"รักษาการแทน" automation (the `user_delegations` table exists in the schema but
  no UI/automatic routing uses it yet)

## Project layout

```
esaraban/
  server.js              # HTTP entry point, body parsing, static + ACL-checked file serving
  src/
    db.js                 # node:sqlite schema + seed data
    router.js              # tiny path-param router
    auth.js                 # session cookies, password/PIN hashing
    numbering.js             # atomic running-number allocation
    middleware.js             # requirePage / requireApi / requireRole
    render.js                  # shared HTML layout + badges/formatting helpers
    services/
      workflow.js               # document + workflow state transitions, business rules
      notify.js                  # in-app notification helper
    routes/                       # one file per feature area
  public/                          # style.css, app.js (vanilla), favicon.svg
  data/                             # sqlite db (gitignored)
  uploads/                           # uploaded PDFs (gitignored)
```
