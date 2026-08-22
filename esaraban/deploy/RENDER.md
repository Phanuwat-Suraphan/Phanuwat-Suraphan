# Deploying to Render (free, easiest option)

Fastest way to get a working link to click around. **Read the caveat at the bottom first** —
this is for demoing the app, not for storing real documents long-term.

## Steps (no code changes needed)

**Use Docker runtime, not Node.** Two features — the page-1 preview image and burning the "received"
stamp/signatures into the actual PDF — need system programs (`poppler-utils`,
`chromium`, `qpdf`) installed on the server. Render's **Node** runtime can't `apt install`
anything, so those buttons fail there with a "ไม่พบโปรแกรม..." error. **Docker** runtime *can*
install them, via the `Dockerfile` at the **root of this repo** (not inside `esaraban/` — kept
there on purpose so Render's defaults find it with zero extra settings), so use that from the
start:

1. Go to <https://dashboard.render.com> and sign up / log in (GitHub login is easiest)
2. **New +** → **Web Service**
3. Connect your GitHub account and pick the `Phanuwat-Suraphan/Phanuwat-Suraphan` repo
   (grant Render access to it if asked)
4. Fill in the form:
   - **Root Directory**: leave **blank** (don't type `esaraban` here — the Dockerfile needs the
     whole repo as its build context, see above)
   - **Runtime**: **Docker** (not Node — this matters, see above)
   - **Dockerfile Path** / **Docker Build Context Directory**: leave both at their defaults —
     don't type anything in either, Render's default (`./Dockerfile` at repo root) already
     matches where the file actually is
   - **Build/Start Command**: leave both blank — Render uses the Dockerfile automatically once
     Runtime is set to Docker (if the form still marks these "Required" and won't let you leave
     them blank, that means the Runtime dropdown is still on Node — go back and check it first)
   - **Instance Type**: **Free**
5. Under **Environment Variables**, add:
   - `SESSION_SECRET` = click "Generate" (or paste output of `openssl rand -hex 32`)
   - `NODE_ENV` = `production`
6. **Create Web Service** — first deploy takes longer than the Node runtime (has to `apt install`
   inside the image, a few minutes) but only on the first build. Render gives you a URL like
   `https://esaraban.onrender.com` — that's your live link.

A `render.yaml` file is also included in this repo (`esaraban/render.yaml`) if you'd rather use
Render's **Blueprint** flow (New + → Blueprint) — it already specifies Docker runtime and
pre-fills the same settings above, including auto-generating `SESSION_SECRET`. If Render doesn't
auto-detect it, point the "Blueprint config file path" field at `esaraban/render.yaml`.

### Already deployed on the Node runtime and seeing "ไม่พบโปรแกรม chromium"?

That error means your existing service is running on Render's plain Node runtime, which is
exactly the situation described above — it can't have chromium/qpdf/poppler installed on it no
matter what the app code does. Render doesn't let you flip an existing service from Node to
Docker in place, so the fix is to create a **new** service on the Docker runtime (steps 1-6
above, same repo), copy over your environment variables (`SESSION_SECRET`, `GOOGLE_*` if you set
up Google Drive), confirm it works, then delete the old Node-runtime service. This does mean a
new `*.onrender.com` URL unless you're using a custom domain — and remember the
[data-persistence caveat below](#the-caveat-data-does-not-persist-here) applies to the new
service the same as the old one, so back up first if you have real documents in there.

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

## About the Dockerfile

⚠️ I wrote and reasoned through the `Dockerfile` carefully (same apt package names as the
already-documented, working VPS instructions in `DEPLOY.md`), but **could not actually run
`docker build` to verify it end-to-end** — the sandbox this was developed in doesn't have a
working Docker daemon available. Please treat the first real deploy as the actual test, and
report back if the build itself, the attachment preview, or the PDF-stamping buttons don't work as
expected so it can be debugged with real output in hand.

It lives at the **root of the repo**, not inside `esaraban/`, specifically so Render's defaults
(and any other Docker host's defaults) find it without you having to type a Dockerfile
path/context/root-directory anywhere — those extra fields are exactly what caused the "no such
file or directory" build failures during earlier attempts at this.

If you deliberately don't need attachment previews or PDF-stamping and want the simpler/faster Node runtime
instead, that's still fine — just pick **Node** in step 4 above and leave Build Command blank,
Start Command as `npm start`. Everything else in the app works the same either way; you'll just
get a clear "ไม่พบโปรแกรม..." error (not a crash) if anyone clicks those two specific buttons.
