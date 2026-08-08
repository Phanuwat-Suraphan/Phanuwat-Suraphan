# Deploying to Render (free, easiest option)

Fastest way to get a working link to click around. **Read the caveat at the bottom first** —
this is for demoing the app, not for storing real documents long-term.

## Steps (no code changes needed)

1. Go to <https://dashboard.render.com> and sign up / log in (GitHub login is easiest)
2. **New +** → **Web Service**
3. Connect your GitHub account and pick the `Phanuwat-Suraphan/Phanuwat-Suraphan` repo
   (grant Render access to it if asked)
4. Fill in the form:
   - **Root Directory**: `esaraban`
   - **Runtime**: Node
   - **Build Command**: leave blank (or `true`) — no dependencies to install
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. Under **Environment Variables**, add:
   - `SESSION_SECRET` = click "Generate" (or paste output of `openssl rand -hex 32`)
   - `NODE_ENV` = `production`
6. **Create Web Service** — first deploy takes ~1-2 minutes. Render gives you a URL like
   `https://esaraban.onrender.com` — that's your live link.

A `render.yaml` file is also included in this folder's parent
(`esaraban/render.yaml`) if you'd rather use Render's **Blueprint** flow (New + → Blueprint) —
it pre-fills the same settings above, including auto-generating `SESSION_SECRET`. If Render
doesn't auto-detect it, point the "Blueprint config file path" field at `esaraban/render.yaml`.

## The caveat: data does not persist here

Render's **free** web services have no persistent disk:

- Every redeploy (including ones you didn't trigger — Render occasionally rebuilds free
  services) wipes the filesystem back to the built image, **deleting the SQLite database and
  any uploaded PDFs**
- The service also **spins down after ~15 minutes with no traffic**, and the next visitor waits
  ~30-60 seconds for it to wake back up

[`GOOGLE_DRIVE.md`](./GOOGLE_DRIVE.md) moves the **PDF files** off Render's disk and into Google
Drive, so those survive a redeploy. **This is only half the fix** — the SQLite database (every
document's title, เลขที่, status, workflow history, user accounts... everything except the PDF
binary itself) still lives on Render's ephemeral disk and still gets wiped. Google Drive alone
does not make Render safe for real use; it only stops the PDFs specifically from being lost.

For the database to survive too, there's no way around leaving Render — see
[`../DEPLOY.md`](../DEPLOY.md) (any VPS, persistent disk) or
[`ORACLE_CLOUD.md`](./ORACLE_CLOUD.md) (free VPS with a real persistent disk, no Google Drive
integration needed at all since the whole disk is already persistent).

## OCR auto-fill doesn't work here either

The "อ่านข้อมูลจากไฟล์อัตโนมัติ (OCR)" button needs the `tesseract` and `pdftoppm` system
programs installed on the server. Render's free **Node** runtime doesn't allow installing system
packages (`apt install`), so that button will show a "ไม่พบโปรแกรม" error here — it works once
you're on a real VPS (see `DEPLOY.md`, step 2), where those packages are just an `apt install`
away.

### Making OCR work on Render anyway (Docker runtime)

If you want to stay on Render specifically (not move to a VPS yet), Render also supports
**Docker** as a runtime, which *can* install system packages via a `Dockerfile` — this repo
includes one (`esaraban/Dockerfile`) that installs `tesseract-ocr`, `tesseract-ocr-tha`, and
`poppler-utils` (same packages as the VPS path above) before starting the app.

1. On Render, Docker runtime is chosen when you **create** a service — you can't flip an
   existing Node-runtime service to Docker in place. Easiest path: create a brand new Web
   Service (**New + → Web Service**, same repo), and this time under the runtime dropdown pick
   **Docker** instead of **Node**. Set **Root Directory** to `esaraban` (where `Dockerfile`
   lives) — leave Build/Start Command blank, Render uses the Dockerfile for both.
2. Add the same environment variables as the Node service (`SESSION_SECRET`, `NODE_ENV=production`,
   and `GOOGLE_*` ones if you're using Google Drive) under this new service.
3. Once it deploys, delete the old Node-runtime service (or keep both running temporarily to
   compare) and point people at the new service's URL instead — note this **is** a new URL,
   different from your old `*.onrender.com` link, unless you set up a custom domain.
4. The [data-persistence caveat above](#the-caveat-data-does-not-persist-here) still applies
   exactly the same on the Docker runtime — this only fixes OCR, not the database/upload wipe on
   redeploy.

⚠️ I wrote and reasoned through this Dockerfile carefully (same apt package names as the
already-documented, working VPS instructions), but **could not actually run `docker build` to
verify it end-to-end** — the sandbox this was developed in doesn't have a working Docker daemon
available. Please treat the first real deploy as the actual test, and report back if the build
or the OCR button itself doesn't work as expected so it can be debugged with real output in hand.
