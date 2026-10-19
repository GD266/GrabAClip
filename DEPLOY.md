# Deploying Grab a Clip

Grab a Clip has two parts:

- **Frontend** — static HTML/CSS/JS in `public/`.
- **Backend** — Express + `yt-dlp` + `ffmpeg` in `server/`.

## Why Vercel needs a separate backend

Vercel can host the frontend perfectly, but it **cannot run the downloader**:

- `yt-dlp` and `ffmpeg` are native Linux binaries; Vercel Functions don't ship them.
- A download can run for minutes and stream hundreds of MB. Vercel Functions
  have short execution limits and a small response-body limit.
- Jobs need a writable disk for the merged file; serverless filesystems are
  ephemeral and limited.

So use one of these two setups:

1. **One container** (recommended) — frontend + API together. Everything is
   same-origin and behaves exactly like local development.
2. **Split** — Vercel serves the frontend; a container serves the API. The
   frontend calls the backend directly (CORS is enabled).

---

## Local development

```bash
npm install
npm start        # http://localhost:3000
```

Requires `yt-dlp` and `ffmpeg` on `PATH` (override with `YTDLP_BIN` /
`FFMPEG_BIN`). `public/config.js` is empty locally, so API calls go to the same
origin (`/api/...`).

---

## Option 1 — Full app in one container (recommended)

The included `Dockerfile` installs Node, yt-dlp, ffmpeg and Deno.

```bash
docker build -t grabaclip .
docker run --rm -p 3000:3000 grabaclip
# open http://localhost:3000
```

Deploy that image to any container host: **Render**, **Railway**, **Fly.io**, a
VPS, etc.

Quick host notes:

- **Render** — New → Web Service → connect the repo → Runtime: Docker →
  Health Check Path: `/api/health`.
- **Railway** — New Project → Deploy from GitHub; it detects the `Dockerfile`.
- **Fly.io** — `fly launch` with the existing `Dockerfile`, then `fly deploy`.

No `GAC_API_BASE` is needed in this setup: the frontend and API share an origin.

> Keep the image up to date (redeploy/rebuild periodically). A stale `yt-dlp`
> is the most common reason downloads start failing with HTTP 403.

---

## Option 2 — Vercel frontend + container backend

### 1. Deploy the backend

Deploy the `Dockerfile` to Render/Railway/Fly/a VPS as above. Note its public
**HTTPS** origin, for example `https://grabaclip-api.onrender.com`.

### 2. Point the Vercel frontend at it

Choose one:

**A. Vercel environment variable (recommended)**

1. Vercel → your project → **Settings → Environment Variables**
2. Add `GAC_API_BASE = https://grabaclip-api.onrender.com`
   (no trailing slash, no `/api` suffix)
3. **Redeploy** the project.

The build step (`scripts/vercel-build.js`) writes the value into
`public/config.js` during deployment.

**B. Edit the config file**

Edit `public/config.js`:

```js
window.GAC_API_BASE = "https://grabaclip-api.onrender.com";
```

Commit and redeploy. The Vercel build leaves this file untouched when
`GAC_API_BASE` is not set.

### 3. Vercel project settings

- **Root Directory**: repository root (not `public/`). `vercel.json` sets the
  output directory to `public`.
- **Framework Preset**: Other / no framework.
- The `vercel.json` build command is `node scripts/vercel-build.js`.

### 4. CORS (optional)

The API allows any origin by default. To restrict it, set on the **backend**:

```env
CORS_ORIGIN=https://grab-a-clip.vercel.app
```

Multiple origins can be comma-separated. The download routes expose
`Content-Disposition`/`Content-Length`, so filenames and progress work
cross-origin.

## Troubleshooting a deployed backend

- `GET https://<backend>/api/health` — `ytDlpVersion: null` means yt-dlp is not
  runnable in the container (missing binary, wrong architecture, permission).
- `GET https://<backend>/api/health?diagnostics=1` — shows the resolved path,
  exit code and stderr for yt-dlp, ffmpeg and deno.
- `POST /api/info` returning the generic "Failed to retrieve video information.
  Please try again." almost always means yt-dlp failed to start or was blocked
  by YouTube; check the diagnostics first.
- Rebuild the image after pulling new commits: the Dockerfile verifies the
  binaries during the build. On Render use **Manual Deploy → Clear build cache &
  deploy** if an old cached layer still lacks yt-dlp.

---

## Important notes

- **Use HTTPS** for both. An HTTPS Vercel page cannot call an HTTP backend.
- **Free tiers that sleep** (e.g. Render free) can add a cold-start delay and
  may interrupt long downloads. Use an always-on instance for big files.
- The API has **no authentication or rate limiting**. Anyone with the backend
  URL can use it — add auth/rate limiting before making it public.
- Vercel preview deployments also call the backend; set `GAC_API_BASE` for the
  Preview environment too, or the preview UI will show an "API unavailable"
  message.
- Vercel only deploys `public/`; the validator is at
  `public/shared/validator.js`, which is why `/shared/validator.js` works on
  both Express and Vercel.
