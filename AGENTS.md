# AGENTS.md

Grab a Clip — single-package Node.js (ESM) Express app: YouTube downloader backend (`server/`) + vanilla JS frontend (`public/`). No build step, no bundler, not a monorepo.

## Commands

- `npm run dev` — server with reload (`node --watch server/index.js`) at http://localhost:3000
- `npm start` — run server
- `npm test` — `node --test test/*.test.js`; pure unit tests (validator, format planner, progress parser, error classifier, download status, transcript normalizer). No network required.
- Single test: `node --test test/<file>.test.js`; filter: `node --test --test-name-pattern="name" test/<file>.test.js`
- No lint / format / typecheck / CI is configured — do not invent commands. Syntax check: `node --check <file>`.
- Smoke test: `npm start`, then `GET http://localhost:3000/api/health` → `{ status: "ok", ytDlp: <configured name>, ytDlpVersion: <version|null> }` (it only reports settings/version; it does not check that the binary path exists).

## Runtime prerequisites

- `yt-dlp` on PATH (override: `YTDLP_BIN`) — required for all API features. `YTDLP_BIN` is read at module import in `ytdlp.js`/`transcript.js` (set it before importing in tests); `FFMPEG_BIN` is read per call.
- **Keep yt-dlp current** (`python -m pip install -U yt-dlp`, or `yt-dlp -U` for standalone builds). Verified 2026-10-19: yt-dlp **2026.07.04 was rejected by YouTube with HTTP 403 on every DASH media URL**; installing 2026.08.19 fixed it with no app change. `/api/health` and the startup log report the version — a stale yt-dlp is the first thing to check when downloads start failing.
- `ffmpeg` on PATH (override: `FFMPEG_BIN`) — required for every audio download (`-x --audio-format …`) and for merging MP4 video. Both overrides are documented in `.env.example` (a missing `.env` is fine; defaults are the bare binary names).
- Copy `.env.example` → `.env`. Without `OPENAI_API_KEY`/`AI_API_KEY`, the AI provider silently falls back to `MockProvider` (intelligence responses flagged `isFallback: true`) — `server/services/ai/factory.js`.
- yt-dlp runs with `--remote-components ejs:github`; JS challenges resolve via **deno** (`[jsc:deno]` in logs) — a soft runtime dependency.

## Layout

- `server/index.js` — entrypoint; mounts `/api/*`, serves `public/` statically (including `/shared/validator.js`), SPA fallback for other paths (Express **4** syntax `app.get("*")`). CORS is open by default or restricted with `CORS_ORIGIN`.
- Endpoints: POST `/api/info`, POST `/api/intelligence`, GET `/api/download` (video), GET `/api/download/audio`, GET `/api/downloads/status`, GET `/api/health`.
- `server/routes/` — HTTP layer; `server/services/` — yt-dlp jobs, transcript, AI logic; `server/utils/` — validation + download status; `test/` — `node:test` unit tests.
- `public/shared/validator.js` — canonical URL validation. It lives under `public/` so the browser can import it as `/shared/validator.js` from both Express (local) and static hosts (Vercel); `server/utils/validation.js` imports the same file.

## How downloads work (rewritten 2026-10-19)

1. `GET /api/download?url=…&height=720` (legacy `formatId=` still accepted) resolves a per-height **plan** (`buildVideoFormats` in `server/services/ytdlp.js`) and starts a yt-dlp job for video **with audio**.
   - **Two plan sets come from one extraction**: `formats` is size-optimised (AV1 > VP9 > H.264, lowest-bitrate variant per height; roughly half the size) and `formatsCompatible` keeps H.264 for older players. The UI's “Smaller file” toggle (checked by default) swaps the sets; `&codec=h264` on the download URL selects the compatibility set.
   - Plan preference per height: size mode → merge an AV1/VP9 source first; compatibility mode → muxed **HLS** variant → **merge** (DASH/HLS video-only + best m4a audio) → progressive (last resort). Plans carry `videoSize`/`audioSize` estimates (used for progress weighting and the UI size hints).
   - **Audio is mandatory**: every selector chain ends with an explicit video+audio merge, the legacy `formatId` path never falls back to the bare video-only id, and `runMediaJob({ requireAudio: true })` runs `ffprobe` on the finished file. A silent file is rejected and the next source is tried.
   - Every plan carries an ordered `selectors` list; `buildVideoAttempts` turns it into a fallback chain: preferred source → fresh retry (new media URLs) → safer selectors → alternate YouTube players (`youtube:player_client=web_safari` / `tv`). `buildAudioAttempts` does the same for audio (HLS ladder → audio-only → smallest muxed variant via alternate players).
   - `runMediaJob` executes the chain: non-fatal failures (403, network, missing format, no output file) move to the next attempt; `isFatalDownloadError` (unavailable/private/age/region/live) stops immediately. Abort (client disconnect) kills the running process tree.
   - **Merge plans download video and audio concurrently** (`startMergeDownload`): two yt-dlp processes, then `ffmpeg -c copy -movflags +faststart`. yt-dlp's own merge downloads the streams sequentially; concurrent streams win on connections where YouTube throttles each connection separately. It is bandwidth-neutral on connections with a hard aggregate cap.
   - Jobs use `--concurrent-fragments 8`, so HLS/DASH fragments download in parallel.
   - Heights are capped at 1080p (UI list: 1080/720/480/360/240/144).
2. `GET /api/download/audio?url=…&format=m4a|mp3|wav|opus&quality=320|192|128` starts an audio-only job; UI offers M4A / MP3 320/192/128 / WAV. Source: HLS ladder `93/94/95/96/92/91` (AAC-LC 128k preferred over HE-AAC), falling back to `bestaudio`. `best`/`high`/`aac` are aliases for `m4a`.
3. Jobs are **file based**: yt-dlp writes into a temp dir (`os.tmpdir()/grabaclip/job-*`, deleted afterwards) so it can run its own postprocessing — TS→MP4 fixup for HLS, `--merge-output-format mp4`, `-x --audio-format …` via ffmpeg. Piping to stdout is what used to produce MPEG-TS files named `.mp4` and extradata-less M4A — do not go back to piping.
4. When yt-dlp exits 0 the finished file is streamed to the client with an exact `Content-Length`; the temp dir is removed once the response (or a client abort) finishes.
5. Progress: `--progress-template "download:GACDL %(progress._percent_str)s"` (the `download:` prefix is the template TYPE and is not printed) is parsed from stdout into `/api/downloads/status` (`progress`, `detail`). Phases: `preparing → fetching → processing → downloading → complete|failed`; the UI polls this while waiting for response headers. Retry attempts show up in `detail` as `… (attempt n/N)`.
6. **Info cache** (`server/utils/infoCache.js`, 10 min TTL, dedupes concurrent loads): `/api/info` populates it and both download routes read through it, so clicking Download starts the job immediately instead of paying for another `--dump-json` round trip. Format *ids* are stable; media URLs are re-extracted per job anyway, so cached entries are safe to reuse.
7. The UI shows server-side progress by polling `/api/downloads/status`. **All status URLs are canonical** (`normalizeYouTubeUrl`), so the frontend must normalize the pasted URL before downloading/polling (`public/app.js` keeps `currentUrl = normalizeYouTubeUrl(input)` and also matches entries by video id). Without that, `youtu.be`/mobile/parameterised links never match a status entry and the UI looks frozen at "Starting download…".

## Gotchas

- Services signal HTTP status via an `err.status` property; routes respond `e.status || 500`. New service errors without `.status` surface as generic 500s.
- Media-data 403s are YouTube-side (bot/IP checks / stale extraction); the retry chain exists for them — a **stale yt-dlp is the most common root cause** (see Runtime prerequisites). `classifyYtDlpError` maps a final failure to 502. Compare against a plain yt-dlp run before blaming app code.
- Download status (`server/utils/downloadStatus.js`) is an in-memory Map — lost on restart; duplicate downloads for the same video+type return 429 while a job runs. Entries linger (complete/failed) for up to 10 min (`cleanupStale`).
- Cancelling: a client disconnect kills the yt-dlp process tree with `taskkill /T /F` — **Windows only** in practice: `spawn` is not `detached`, so the POSIX `kill(-pid)` branch degrades to killing just the direct child.
- `cleanupJobDir` retries (3×, 250 ms) because Windows keeps the media file locked briefly after the process exits.
- `classifyYtDlpError` (`server/services/ytdlp.js`) is the **single** source of friendly error strings — routes call it, they do not re-implement matching. Covered by `test/ytdlp.test.js`.
- Timeouts: info 30s, transcript 30s, download jobs 20 min (`DOWNLOAD_TIMEOUT_MS` in `ytdlp.js` / `transcript.js`).
- `.env` and media artifacts (`*.mp4`, `*.part`, `*.vtt`, `*.srt`) are gitignored — never commit them. Commits use conventional style (`feat: ...`, `fix: ...`).

## Deployment (Vercel + backend)

- **Vercel can only host the static frontend.** `yt-dlp`/`ffmpeg` are native binaries and jobs are long-running/large, so Vercel Functions cannot run the API. Deploy the backend with the included `Dockerfile` (Render/Railway/Fly/VPS) and point the frontend at it.
- `vercel.json` sets `outputDirectory: "public"` and runs `scripts/vercel-build.js`. Set `GAC_API_BASE` in the Vercel project (no trailing slash, no `/api`) to write the backend URL into `public/config.js`; if unset, the committed `public/config.js` is kept. Locally the value is empty and API calls are same-origin.
- `public/index.html` loads `/config.js` before the `app.js` module; `public/app.js` routes every API call through `apiUrl()`.
- The backend exposes `Content-Disposition`/`Content-Length` through CORS. `CORS_ORIGIN` (comma-separated) restricts origins; the default is `*`.
- Full steps and host notes: `DEPLOY.md`.

## Known issues (verified 2026-10-19)

- Download speed is bounded by YouTube/network throughput: this machine measured ~0.5–0.8 MB/s aggregate, so a 40-minute video is ~60–90 MB (144p) and takes minutes regardless of app-side tuning. `--concurrent-fragments` helps single-connection throttling; parallel video+audio helps per-connection throttling.
- A first `/api/info` still runs a full extraction (~7 s here); only follow-up calls within the 10 min TTL are instant. Rapid repeated *uncached* `/api/info` calls get throttled and can 504 at the 30s info timeout — cool down before treating as a regression.
- Failed attempts each pay their own extraction cost (a few seconds), so a fully-blocked download can spend ~30-40 s trying 5-7 sources before reporting 502.
- The default “Smaller file” plans use AV1 (MP4) or VP9 (in MP4) sources. They play in current browsers, VLC and modern Windows players; very old players may need the H.264 option (uncheck the toggle).
- Transcripts: `--sub-langs en` only; the any-language fallback exists only as comments; `isAuto` is hardcoded `true` (`server/services/transcript.js`).
- Large downloads are written to disk twice (YouTube → temp file, temp file → client); an aborted job may briefly leave a `grabaclip/job-*` dir behind until cleanup retries.
- No rate limiting anywhere; the server proxies YouTube fetches for any client — required before public deploy.
- The frontend buffers the whole file in memory (blob) before saving, so very large 1080p downloads cost RAM on the client.
