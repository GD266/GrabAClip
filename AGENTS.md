# AGENTS.md

Grab a Clip — single-package Node.js (ESM) Express app: a YouTube, X/Twitter and Instagram downloader backend (`server/`) + vanilla JS frontend (`public/`). No bundler or local build step; Vercel only runs `scripts/vercel-build.js`. Not a monorepo. There is no README — `DEPLOY.md` covers hosting.

## Commands

- `npm run dev` — server with reload (`node --watch server/index.js`) at http://localhost:3000
- `npm start` — run server
- `npm test` — `node --test test/*.test.js`; network-free, ~2 s, no yt-dlp/ffmpeg required (job tests use fake process objects). Covers the validator, plan/attempt building, progress parsing, error mapping, download status, info cache, transcript normalizer, cookies, and deployment layout.
- Single test: `node --test test/<file>.test.js`; filter: `node --test --test-name-pattern="name" test/<file>.test.js`
- No lint / format / typecheck / CI is configured — do not invent commands. Syntax check: `node --check <file>`.
- Smoke test: `npm start`, then `GET /api/health` → `{ status: "ok", ytDlp: <name>, ytDlpVersion: <version|null> }`. It runs `yt-dlp --version` but still returns 200 when the version is null; add `?diagnostics=1` to check ffmpeg/deno too.
- `test/deployment.test.js` asserts exact frontend wiring (config.js before app.js, `apiUrl()` usage, `vercel.json`), so frontend refactors can fail it.

## Runtime prerequisites

- `yt-dlp` on PATH (override `YTDLP_BIN`) — required for all API features, and already supports YouTube, X and Instagram. **Keep it current**: on 2026-10-19, yt-dlp 2026.07.04 got HTTP 403 on every YouTube DASH media URL; 2026.08.19 fixed it with no app change. `/api/health` and the startup log report the version — check that first when downloads start failing.
- `ffmpeg` on PATH (override `FFMPEG_BIN`) — required for every audio download (`-x --audio-format …`) and for merging MP4 video. `ffprobe` (`FFPROBE_BIN`) is only used by the post-download audio check; if missing, the check is skipped. The app does not pass `--ffmpeg-location`, so yt-dlp resolves ffmpeg from PATH too.
- `YTDLP_BIN` and `YTDLP_COOKIES_*` are read at module import; tests that change them must set env before a dynamic `import()` (see `test/cookies.test.js`). `FFMPEG_BIN`/`FFPROBE_BIN` are read per call.
- Deno on PATH is a soft dependency: yt-dlp runs with `--remote-components ejs:github`, and JS challenges log `[jsc:deno]`. `DENO_BIN` only affects diagnostics.
- Datacenter IPs get "Sign in to confirm you're not a bot" on some YouTube videos, and X/Instagram may require sign-in or rate-limit anonymous requests. Set `YTDLP_COOKIES_FILE` (wins when the path exists) or `YTDLP_COOKIES_B64` (base64 Netscape cookies; decoded content must contain tabs) to pass `--cookies` to info/download calls for all platforms. The transcript fetcher does not use cookies. `getVideoInfo` retries YouTube default → `web_safari` → `web_embedded` → `tv`; X/Instagram get one extraction per info call.
- Missing `OPENAI_API_KEY`/`AI_API_KEY` falls back to `MockProvider` (`isFallback: true`, warning in the log). Delete the `sk-...` placeholder from the copied `.env` — it is truthy and causes 401s instead of the fallback. `/api/intelligence` degrades to 200 with `transcript.available=false` and/or `intelligence.aiError`; only URL/info failures throw.

## Layout

- `server/index.js` — entrypoint; mounts `/api/*`, serves `public/` (including `/shared/validator.js`), SPA fallback (Express **4** syntax `app.get("*")`). CORS is `*` unless `CORS_ORIGIN` is set.
- Endpoints: POST `/api/info`, POST `/api/intelligence`; GET `/api/download` (video), `/api/download/audio`, `/api/downloads/status`, `/api/health`.
- `server/routes/` — HTTP layer; `server/services/` — yt-dlp jobs, transcript, AI; `server/utils/` — validation, info cache, download status, error log; `test/` — `node:test` unit tests.
- `public/shared/validator.js` is canonical URL validation for YouTube, X/Twitter and Instagram, imported by both the browser (`/shared/validator.js`) and `server/utils/validation.js`. `detectPlatform` / `normalizeMediaUrl` / `extractMediaId` are the cross-platform helpers; the legacy `isYouTubeUrl` / `normalizeYouTubeUrl` exports remain for the intelligence/transcript path. It lives under `public/` so static hosts keep working — do not move it.

## How downloads work

1. `GET /api/download?url=…&height=720` (legacy `formatId=`/`quality=` aliases accepted; legacy ids are always paired with audio; `codec=h264` selects compatibility) builds a per-height **plan** in `server/services/ytdlp.js`.
   - YouTube uses `buildVideoFormats`. One extraction yields two plan sets: `formats` is size-optimised (AV1 > VP9 > H.264, lowest bitrate; UI "Smaller file", checked by default) and `formatsCompatible` is H.264.
   - X/Twitter and Instagram use `buildGenericVideoFormats`: prefer a muxed progressive MP4 (X usually provides one), otherwise merge the best video-only rendition with the best audio-only rendition. A silent post gets a `hasAudio:false` video-only plan instead of a fake audio track.
   - The UI quality key is the **short side** of the frame, so a 720×1280 reel is 720p rather than 1280p. Validation bounds `height` to 144–1080 and the `/api/info` plan list is authoritative, so X (270p) and Instagram (e.g. 504p) can expose their real source resolutions.
   - Every plan has ordered `selectors`; `buildVideoAttempts` adds a fresh-URL retry and, on YouTube only, alternate players (`web_safari`, `web_embedded`, `tv`), capped at 9 attempts. YouTube plan chains end in an explicit video+audio merge, and `runMediaJob({ requireAudio: true })` runs `ffprobe` on the result, rejecting silent files. X/Instagram never receive a YouTube extractor argument.
2. `GET /api/download/audio?url=…&format=m4a|mp3|wav|opus&quality=320|192|128` starts an audio job. `quality` only applies to MP3; `best`/`high`/`aac` are aliases for `m4a`. UI offers M4A / MP3 320/192/128 / WAV; `opus` is API-only. YouTube uses the `93/94/95/96/92/91/bestaudio…` ladder (AAC-LC 128k preferred); X uses its audio-only HLS rendition; Instagram uses its DASH audio rendition. Attempts then fall back to audio-only and small muxed variants; YouTube-only alternates use player clients.
3. Jobs are **file based** in `os.tmpdir()/grabaclip/job-*` so yt-dlp can do its own postprocessing: TS→MP4 fixup for HLS, `--merge-output-format mp4`, and `-x --audio-format …` via ffmpeg. Do not go back to piping media to stdout — that produced MPEG-TS files named `.mp4` and extradata-less M4A.
   - Merge plans run two yt-dlp processes concurrently, then local `ffmpeg -c copy -movflags +faststart`. Hosts with ≤1.5 GB auto-switch to one sequential yt-dlp process (`GAC_LOW_MEMORY=1`/`GAC_SEQUENTIAL_MERGE=1` force it, `=0` disables), and `--concurrent-fragments` drops from 8 to 2 (`GAC_CONCURRENT_FRAGMENTS=n` overrides).
   - On exit 0 the file is streamed with an exact `Content-Length`; the temp dir is removed when the response (or a client abort) finishes.
4. Progress: `--progress-template "download:GACDL %(progress._percent_str)s"` is parsed from stdout into `/api/downloads/status` (`progress`, `detail`). Phases: `preparing → fetching → processing → downloading → complete|failed`; retries show as `… (attempt n/N)`.
5. **Info cache** (`server/utils/infoCache.js`, 10 min TTL, 200 entries, dedupes in-flight): `/api/info` populates it; both download routes read through it. `/api/intelligence` bypasses it and runs a fresh extraction. Format ids are stable; media URLs are re-extracted per job.
6. Status URLs are canonical (`normalizeMediaUrl`): YouTube watch URLs, X `x.com/<user>/status/<id>/video/<n>`, and Instagram `/<kind>/<shortcode>/`. The frontend normalizes before downloading/polling (`public/app.js`) and also matches by platform media id; otherwise `youtu.be`/mobile/parameterised links or X `/video/N` variants never match and the UI looks frozen at "Starting download…".

## Gotchas

- Services signal HTTP status via `err.status`; routes respond `e.status || 500`. New service errors without it surface as generic 500s.
- Media-data 403s are platform-side (YouTube bot/IP checks, stale signatures/extraction; X/Instagram rate limits or login gates). The retry chain exists for them; a **stale yt-dlp is the most common YouTube root cause**. Compare a plain yt-dlp run before blaming app code.
- `classifyYtDlpError` (`server/services/ytdlp.js`) is the **single** source of friendly error strings — routes call it, they do not re-implement matching. It returns 4xx/429/502/504; the fallback is 500. `isFatalDownloadError` decides whether retrying can help.
- Download status (`server/utils/downloadStatus.js`) is an in-memory Map — lost on restart. Same media+type returns 429 while a job is active; complete/failed entries are dropped after 10 min stale (sweep every 5 min).
- X and Instagram multi-media posts: X bare status URLs canonicalize to `/video/1`, so a multi-video tweet downloads its first video. Instagram carousels pick the first entry that has video formats and pass `--playlist-items` to the job. Post types with no video (photo-only posts, Instagram image carousels, `/reels/audio/` pages) are rejected with a friendly 400.
- Intelligence/transcript is YouTube-only. `buildIntelligence` rejects other platforms; the frontend hides the Intelligence tab for X/Instagram rather than showing a broken panel.
- Cancelling: Windows uses `taskkill /T /F`; on POSIX `kill(-pid)` reaches only the direct child because `spawn` is not `detached` — the process tree is not reliably killed there.
- `cleanupJobDir` retries a few times (250 ms apart) because Windows keeps the media file locked briefly after the process exits.
- Timeouts: info/transcript 30 s, download jobs 20 min, local ffmpeg merge 5 min.
- `.env` and media artifacts (`*.mp4`, `*.part`, `*.vtt`, `*.srt`, `*.ytdl`) are gitignored — never commit them. Commits use conventional style (`feat: …`, `fix: …`).

## Deployment (Vercel + backend)

- **Vercel can only host the static frontend.** `yt-dlp`/`ffmpeg` are native binaries and jobs are long-running/large, so Vercel Functions cannot run the API. Deploy the backend with the included `Dockerfile` (Render/Railway/Fly/VPS) and point the frontend at it.
- `vercel.json` sets `outputDirectory: "public"` and runs `scripts/vercel-build.js`. Set `GAC_API_BASE` (no trailing slash, no `/api`) to write `public/config.js`; if unset, the committed file is kept (empty = same origin locally/one-container).
- The `Dockerfile` installs yt-dlp from PyPI, copies Deno from `denoland/deno:bin`, and verifies yt-dlp/deno/ffmpeg at build time, so a broken image fails the deploy. Full steps: `DEPLOY.md`.
- `GET /api/health?diagnostics=1` returns resolved paths, exit codes and stderr for yt-dlp/ffmpeg/deno, cookie status, memory limit, `lowMemoryHost`/`sequentialMerge`/`concurrentFragments`, `uptimeSeconds` (tiny = restart) and `recentErrors`. A host-level 502 usually means the container was killed.
- CORS defaults to `*`; `CORS_ORIGIN` is comma-separated. `Content-Disposition`/`Content-Length` are exposed. `public/index.html` loads `/config.js` before `app.js`, and `public/app.js` routes every API call through `apiUrl()`.

## Limits / known issues

- Download speed is bounded by the source platform/network throughput. `--concurrent-fragments` helps single-connection throttling; parallel video+audio helps per-connection throttling, not a hard aggregate cap. X/Instagram may cap speeds independently.
- A first uncached `/api/info` runs a full extraction (seconds). Rapid repeated *uncached* calls can be throttled and hit the 30 s info timeout — cool down before treating it as a regression.
- X and Instagram are more login/rate-limit prone than YouTube. Public posts usually work anonymously; private, age-gated or heavily rate-limited posts need `YTDLP_COOKIES_FILE`/`YTDLP_COOKIES_B64`. Instagram may still return "login required" even with cookies if the account is challenged.
- A fully blocked download can spend tens of seconds across up to 9 attempts before returning 502; each failed attempt pays extraction + backoff. X/Instagram classify rate-limit/login errors as fatal so they fail fast.
- Transcripts: `--sub-langs en` only; the any-language fallback is commented out; `isAuto` is hardcoded `true` in `server/services/transcript.js`; transcript yt-dlp calls do not use cookies. Intelligence/transcript is intentionally unavailable for X/Instagram.
- Large downloads are written to disk twice (source → temp file → client); an aborted job may briefly leave a `grabaclip/job-*` dir behind until cleanup retries.
- No rate limiting/auth anywhere; the server proxies platform fetches for any client — required before public deploy.
- The frontend buffers the whole file as a Blob before saving, so very large 1080p downloads cost client RAM.
