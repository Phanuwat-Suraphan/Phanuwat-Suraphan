# ระบบสารบรรณอิเล็กทรอนิกส์สำหรับโรงเรียน — MVP Prototype

> 📘 **ผู้ดูแลระบบของโรงเรียน อ่าน [`deploy/คู่มือผู้ดูแลระบบ.md`](./deploy/%E0%B8%84%E0%B8%B9%E0%B9%88%E0%B8%A1%E0%B8%B7%E0%B8%AD%E0%B8%9C%E0%B8%B9%E0%B9%89%E0%B8%94%E0%B8%B9%E0%B9%81%E0%B8%A5%E0%B8%A3%E0%B8%B0%E0%B8%9A%E0%B8%9A.md) เป็นหลัก**
> — ภาษาไทย ครอบคลุมตัวแปรตั้งค่าทั้งหมด งานประจำที่ต้องทำ และวิธีแก้ปัญหาที่เจอจริงตอนติดตั้งใช้งาน
>
> **ระบบนี้ไม่ต้องพึ่งเครื่องมือ AI หรือบริการของผู้พัฒนาใดๆ** — ไม่มี npm dependency แม้แต่ตัวเดียว
> (`"dependencies": {}`) และต่อออกอินเทอร์เน็ตไปแค่ LINE กับ Google ซึ่งเป็นบัญชีของโรงเรียนเอง
> ก๊อปโฟลเดอร์นี้ไปรันบนเครื่องที่มี Node 22 ที่ไหนก็ได้ ได้ระบบเดิมทั้งชุด

> **ติดตั้งให้โรงเรียนใหม่:** ชื่อโรงเรียนไม่ได้ฝังอยู่ในโค้ด — เข้าเมนู **🏫 ตั้งค่าโรงเรียน**
> ด้วยบัญชีแอดมินแล้วพิมพ์ชื่อได้เลย (หรือตั้ง env var `SCHOOL_NAME` ไว้ตอน deploy ครั้งแรก)
> ชื่อนี้จะไปขึ้นบนหัวหนังสือ ตราประทับใน PDF แบบฟอร์มใบลา และชื่อแอปบนหน้าจอมือถือให้เองทั้งหมด

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

## Deploying

- **Quick demo link, no setup**: [`deploy/RENDER.md`](./deploy/RENDER.md) — free, ~2 minutes.
  Render's free tier has an ephemeral disk, so **everything is wiped on every deploy and on every
  wake-from-sleep** (it sleeps after ~15 min idle, so this happens several times a day on its own).
  Connecting [`deploy/GOOGLE_DRIVE.md`](./deploy/GOOGLE_DRIVE.md) (free 15GB) fixes this for real:
  attachments move off the ephemeral disk, *and* the SQLite database is backed up every 5 minutes
  (plus on shutdown) and **restored automatically on the next boot** — so a wipe costs at most the
  last few minutes. Without Drive connected, Render free is a demo link only, not a place for real
  documents. A VPS with a real disk (below) avoids the whole problem.
- **Real deployment**: [`DEPLOY.md`](./DEPLOY.md) — cloud VPS runbook (Ubuntu + systemd + Nginx +
  Let's Encrypt, matching the Part 10 deployment architecture from the spec), with a free-forever
  option at [`deploy/ORACLE_CLOUD.md`](./deploy/ORACLE_CLOUD.md). `deploy/` also has ready-to-use
  `esaraban.service` (systemd unit), `nginx.conf` (reverse proxy), and `backup.sh`.
- **File storage**: local disk by default. [`deploy/GOOGLE_DRIVE.md`](./deploy/GOOGLE_DRIVE.md)
  covers switching attached PDFs to Google Drive instead (`STORAGE_PROVIDER=google_drive`),
  organized into `<ปี>/<ประเภทหนังสือ>` folders automatically.

## Run it

```bash
cd esaraban
node server.js         # http://localhost:3000
# or: npm start / npm run dev (auto-restart on change)
```

Requires Node.js ≥ 22.5 (for `node:sqlite`). No `npm install` step — there is nothing to install.
The SQLite DB is created and seeded automatically on first run at `data/esaraban.db` (gitignored).

Run the test suite with `npm test` (uses a throwaway SQLite file via `DB_PATH`, never touches
`data/esaraban.db`).

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
- Dashboard (role-aware KPIs, plus an executive summary panel for admin/director/vice_director:
  average time-to-completion, pending-document load per department)
- "งานของฉัน" task list, in-app notifications, CSV report export
- Responsive layout: fixed sidebar on desktop ≥900px, bottom nav + slide-out drawer on mobile,
  light/dark theme, keyboard shortcuts (Ctrl/Cmd+K search, Ctrl/Cmd+N new document)
- 6 official document types per ระเบียบสำนักนายกรัฐมนตรีว่าด้วยงานสารบรรณ, plus a ลงวันที่
  (external document date) field matching the standard's ทะเบียนหนังสือรับ/ส่ง register format
- Retention/destruction workflow (หมวด 3 of the same ระเบียบ): retention class + auto-computed
  expiry per document, a destruction-batch proposal/approval flow requiring a named committee
  and a director/admin sign-off distinct from whoever proposed it — never a direct delete
- Page-1 preview image of PDF attachments (pdftoppm, shells out via `child_process` — no npm
  package — see `deploy/*.md` for the system packages it needs) and optional Google
  Drive attachment storage (`STORAGE_PROVIDER=google_drive`) for hosts without persistent disk
- Admin user management: create + soft-delete (self-delete and last-admin-delete both blocked);
  every user (including admin) can edit their own name/email/position and change their password
- ระบบลา/ไปราชการ (leave & official-travel requests): submit → single named approver
  approves/rejects, reusing the same notification/audit plumbing as documents
- Login rate limiting (5 bad attempts locks the account 15 minutes), security response headers
  (HSTS/CSP/X-Frame-Options/etc. on every response), `/health` endpoint for uptime monitoring
- Automated test suite (`npm test` — Node's built-in `node:test`, zero packages) covering auth,
  atomic numbering, the full workflow lifecycle, void rules, ACL, and retention math
- **Installable on phones (PWA), with "share a file straight from LINE"** — see below

## Sharing a document straight from LINE (mobile)

Receiving a PDF in LINE and getting it into this system used to mean: download it → switch to the
browser → tap attach → hunt for the file, which is genuinely painful on a phone. Installing this
app on the home screen removes all of that.

**Install (Android):** open the site in Chrome → ⋮ menu → *Install app* / *Add to Home screen*.
**Then:** in LINE, tap the PDF → Share → pick **สารบรรณ จพ.๑**. The new-document form opens with
the file already attached — just type the subject and save.

Implemented with the [Web Share Target API](https://developer.mozilla.org/en-US/docs/Web/Manifest/share_target):
`public/manifest.webmanifest` declares the target and `public/sw.js` catches the incoming POST,
stashes the file in Cache Storage, and hands it to the form. The service worker deliberately does
**no** offline caching — a document registry showing stale statuses would be worse than useless.

⚠️ **iPhone/iPad:** iOS does not implement Web Share Target, so the one-tap share does not work
there — this is an iOS platform limitation, not something this app can work around. iOS users still
save the file from LINE into the Files app first, then attach it normally. Installing to the home
screen still works and still makes the app faster to open.

Requires HTTPS (Render provides it automatically; so does any proper reverse-proxy setup).

## Explicitly deferred (documented, not built)

These were flagged throughout the spec review as later-phase items; the schema/routes don't
block adding them, but they are **not implemented** here:

- Thai full-text search, LLM-based AI features (summarization, chat, classification)
- OCR auto-fill of the new-document form: was built with Tesseract, then removed — scanned Thai
  official letters are skewed/low-contrast with the Garuda emblem and signatures over the text,
  so it guessed the document number and date wrong more often than right. Staff had to check
  every field anyway, which was slower than just typing it, and a button whose output cannot be
  trusted invites people to trust it
- PDF annotation/stamp layer, cryptographic signature engine, PKI/digital certificates (Part 6)
- Email/LINE notifications (only in-app notifications exist)
- Multi-tenant `school_id` scoping, Docker/CI-CD/monitoring stack (Part 9, 10) — see Part 12-20
  in the project history for the long-term enterprise-platform vision this would grow into
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
