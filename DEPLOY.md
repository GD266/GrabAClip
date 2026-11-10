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

### YouTube: "The page needs to be reloaded."

yt-dlp **2026.10.21** is the minimum supported release. Older binaries use
YouTube's `tv_downgraded` client by default for signed-in playback, which
YouTube now rejects with this exact error (yt-dlp issue #17389). The fix landed
in 2026.10.21; the current stable at the time of writing is **2026.10.26**.

The `Dockerfile` pins `yt-dlp[default]==2026.10.26` and fails the build unless
`yt-dlp --version` matches. After deploying:

1. `GET https://<backend>/api/health` must show
   `"ytDlpVersion": "2026.10.26"` and `"ytDlpSupported": true`.
2. If it still shows an older version, use **Manual Deploy → Clear build
   cache & deploy** on Render. A normal redeploy can reuse the cached pip
   layer and keep the old binary.
3. `ytDlpSupported: false` (or a `warning` field) means the container is still
   running an outdated binary. Fix that before debugging YouTube further.

For local development, install or update the same extra:

```bash
python -m pip install -U "yt-dlp[default]"
yt-dlp --version   # must be >= 2026.10.21
```

A stale yt-dlp is also the most common cause of YouTube media URLs failing
with HTTP 403 after the info step succeeds.

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

## Posts that require sign-in (cookies)

Cloud/datacenter IPs (Render, Railway, Fly, VPS) are routinely challenged by
YouTube with **"Sign in to confirm you're not a bot"** on some videos while
others work fine. X/Twitter and Instagram can also require a signed-in session
or rate-limit anonymous requests. The backend passes one cookie file to all
info/download calls, so you can include several sites in the same cookie export.

1. Sign in to the platform in a desktop browser. For YouTube, do **not** export
   from a normal tab you keep open — see [YouTube cookie rotation](#youtube-cookie-rotation)
   below.
2. Export a **Netscape-format** `cookies.txt` for `youtube.com`, `x.com` /
   `twitter.com`, or `instagram.com` (e.g. with a "Get cookies.txt LOCALLY"
   style browser extension). Multiple domains can live in one file.
3. Base64-encode the file:
   - Windows PowerShell:
     `[Convert]::ToBase64String([IO.File]::ReadAllBytes("cookies.txt"))`
   - macOS/Linux: `base64 -w0 cookies.txt`
4. On the backend host set `YTDLP_COOKIES_B64` to the encoded value (Render:
   Environment → Add Environment Variable → mark it secret).
   `YTDLP_COOKIES_FILE` pointing at a mounted `cookies.txt` also works and wins
   when it points at a valid file. Use one source, not both.
5. Redeploy/restart, then verify `GET /api/health?diagnostics=1` (and the
   startup log) reports the cookie metadata:
   - `cookies.configured: true` and `cookies.source: "base64" | "file"`
   - `cookies.count` and `cookies.domains` (for example `youtube.com`, `x.com`)
   - `cookies.hasYouTubeAuth: true` when a signed-in YouTube cookie is present
   - `cookies.mode` / `cookies.size` (a `YTDLP_COOKIES_FILE` should be `0600`)
   - `cookies.warning` / `cookies.error` if the file is missing, malformed,
     not Netscape format, or unreadable

Cookie values are never logged or returned by the API. Only counts, domains and
presence flags are exposed.

Notes:

- Use throwaway accounts; cookies are credentials. Never commit them.
- Use a **Netscape-format** export (tab-separated lines), not a JSON export.
  `#HttpOnly_` lines are supported.
- Cookies expire and can be rotated by the browser. Re-export when
  `hasYouTubeAuth` is missing or requests start failing again.
  `hasYouTubeAuth: true` only means the auth cookie names are present, not that
  YouTube still accepts the session.
- `YTDLP_COOKIES_FILE` that is group/world readable triggers a diagnostics
  warning; run `chmod 600 cookies.txt` on the server.
- YouTube `getVideoInfo` retries with the `web_safari`, `web_embedded` and
  `tv_samsung` player clients before giving up. It no longer uses the broken
  `tv`/`tv_downgraded` clients. X/Instagram have no equivalent player flag;
  they get one fresh extraction retry, and a public post that returns "login
  required" needs cookies.
- Instagram often rejects anonymous extraction from datacenter IPs even when
  the post is public. Cookies help, but accounts can still be challenged.

### YouTube cookie rotation

YouTube rotates account cookies while a YouTube tab is open, so an export from
a normal browser session can stop working within minutes. Export from an
isolated private/incognito window instead:

1. Open a new private/incognito window and sign in to YouTube.
2. In that same tab, open `https://www.youtube.com/robots.txt` and keep it as
   the only private tab.
3. Export the `youtube.com` cookies in Netscape format.
4. Close the private window immediately and do not reopen YouTube in it.

Do not use yt-dlp's `--cookies-from-browser` to create the file; it copies the
regular browser session, not the isolated private one. The app always passes
the exported file with `--cookies`.

## Troubleshooting a deployed backend

- **`ERROR: [youtube] ... The page needs to be reloaded.`** — the container is
  running yt-dlp older than 2026.10.21. Check `/api/health`: if
  `ytDlpSupported` is `false`, clear the Render build cache and redeploy (see
  the section above). If the version is current, the error usually means the
  cookie export was rejected; re-export it and check `cookies.hasYouTubeAuth`.
- `GET https://<backend>/api/health` — `ytDlpVersion: null` means yt-dlp is not
  runnable in the container (missing binary, wrong architecture, permission).
  `ytDlpSupported: false` means the binary is runnable but too old for
  YouTube's current clients.
- `GET https://<backend>/api/health?diagnostics=1` — shows the resolved path,
  exit code and stderr for yt-dlp, ffmpeg and deno, the container memory limit,
  `lowMemoryHost`/`sequentialMerge`, cookie metadata, `warnings`,
  `uptimeSeconds` and `recentErrors`.
- **`POST /api/info` fails within ~60 seconds instead of hanging.** Each
  player/extraction attempt is capped at 60 seconds and the whole lookup at 60
  seconds; a timeout returns **504** with `code: "TIMEOUT"`. The budget is this
  high because signed-in YouTube extraction runs a Deno JavaScript challenge
  that takes 5–12 s on a normal machine and much longer on a 0.1-CPU Render
  instance. Per-attempt durations are logged as
  `[info] youtube extraction failed via <client> after <n>ms`, so the service
  log shows whether the challenge or the network is the bottleneck. Other API
  errors include a `code` field (for example `YOUTUBE_PAGE_RELOAD`,
  `COOKIES_INVALID`, `BOT_CHECK`, `MEDIA_403`), which makes the cause visible
  without reading server logs.
- A download that dies with a bare 502 from the host (no CORS headers, status
  polling suddenly returns invalid JSON) usually means the container was
  killed. On a 512 MB instance the likely cause is memory: the image
  automatically switches to a single yt-dlp process and 2 fragments. Check
  `lowMemoryHost` in the diagnostics; force it with `GAC_LOW_MEMORY=1`.
- "The source platform is asking this server to verify it isn't a bot" means
  the platform demands a signed-in session from a datacenter IP. Configure
  cookies (see the section above); other posts keep working without them.
  `/api/health` returning 200 only proves the Node process is alive — it does
  not mean YouTube accepts the host's IP. IP reputation is outside the app's
  control; cookies from a signed-in account are the supported workaround.
- "The source platform is still asking this server to verify it isn't a bot,
  even though cookies are configured" means yt-dlp could read the cookie file
  but YouTube did not accept the session. `hasYouTubeAuth: true` only proves
  the cookie names exist; it does not prove the session is still valid.
  Re-export a fresh Netscape cookie file from a signed-in browser, update
  `YTDLP_COOKIES_B64`, restart, and retry. If it still fails, the account or
  the host IP is flagged.
- "The configured cookies were rejected or have expired" means the export is
  stale or was rotated by the browser. The app keeps yt-dlp warnings enabled so
  this is detected from yt-dlp's rotated-cookie warning; re-export and update
  the secret.
- Rebuild the image after pulling new commits: the Dockerfile verifies the
  binaries and the pinned yt-dlp version during the build. On Render use
  **Manual Deploy → Clear build cache & deploy** if an old cached layer still
  contains an older yt-dlp.

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
