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

This is fine for showing someone what the system looks and feels like. It is **not** suitable
for the school to actually use to store real documents — for that, see
[`../DEPLOY.md`](../DEPLOY.md) (any VPS, persistent disk) or
[`ORACLE_CLOUD.md`](./ORACLE_CLOUD.md) (free VPS with a real persistent disk).
