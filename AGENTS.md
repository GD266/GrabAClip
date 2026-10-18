# AGENTS.md

Grab a Clip — single-package Node.js (ESM) Express app: YouTube downloader backend (`server/`) + vanilla JS frontend (`public/`). No build step, no bundler, not a monorepo.

## Commands

- `npm run dev` — server with reload (`node --watch server/index.js`) at http://localhost:3000
- `npm start` — run server
- `npm test` — `node --test test/*.test.js`; pure unit tests (validator, format planner, progress parser, error classifier, download status, transcript normalizer). No network required.
- Single test: `node --test test/<file>.test.js`; filter: `node --test --test-name-pattern="name" test/<file>.test.js`
- No lint / format / typecheck / CI is configured — do not invent commands. Syntax check: `node --check <file>`.
- Smoke test: `npm start`, then `GET http://localhost:3000/api/health` → `{ status: "ok", ytDlp: <configured name> }` (it only echoes the setting; it does not check that the binary exists).

## Runtime prerequisites

- `yt-dlp` on PATH (override: `YTDLP_BIN`) — required for all API features. `YTDLP_BIN` is read at module import in `ytdlp.js`/`transcript.js` (set it before importing in tests); `FFMPEG_BIN` is read per call.
- `ffmpeg` on PATH (override: `FFMPEG_BIN`) — required for every audio download (`-x --audio-format …`) and for merging MP4 video. Both overrides are documented in `.env.example` (a missing `.env` is fine; defaults are the bare binary names).
- Copy `.env.example` → `.env`. Without `OPENAI_API_KEY`/`AI_API_KEY`, the AI provider silently falls back to `MockProvider` (intelligence responses flagged `isFallback: true`) — `server/services/ai/factory.js`.
- yt-dlp runs with `--remote-components ejs:github`; JS challenges resolve via **deno** (`[jsc:deno]` in logs) — a soft runtime dependency.

## Layout

- `server/index.js` — entrypoint; mounts `/api/*`, serves `public/` and `/shared` statically, SPA fallback for other paths (Express **4** syntax `app.get("*")`).
- Endpoints: POST `/api/info`, POST `/api/intelligence`, GET `/api/download` (video), GET `/api/download/audio`, GET `/api/downloads/status`, GET `/api/health`.
- `server/routes/` — HTTP layer; `server/services/` — yt-dlp jobs, transcript, AI logic; `server/utils/` — validation + download status; `test/` — `node:test` unit tests.
- `shared/validator.js` — canonical URL validation (re-exported by `server/utils/validation.js`) and imported directly by `public/app.js` as `/shared/validator.js` (mounted in `server/index.js`).

## How downloads work (rewritten 2026-10-19)

1. `GET /api/download?url=…&height=720` (legacy `formatId=` still accepted) fetches info, resolves a per-height **plan** (`buildVideoFormats` in `server/services/ytdlp.js`) and starts a yt-dlp job for video **with audio**.
   - Plan preference per height: muxed **HLS** variant → **merge** (DASH video-only + best m4a audio) → progressive (last resort; the most 403-prone).
   - Heights are capped at 1080p (UI list: 1080/720/480/360/240/144).
2. `GET /api/download/audio?url=…&format=m4a|mp3|wav|opus&quality=320|192|128` starts an audio-only job; UI offers M4A / MP3 320/192/128 / WAV. Source: HLS ladder `93/94/95/96/92/91` (AAC-LC 128k preferred over HE-AAC), falling back to `bestaudio`. `best`/`high`/`aac` are aliases for `m4a`.
3. Jobs are **file based**: yt-dlp writes into a temp dir (`os.tmpdir()/grabaclip/job-*`, deleted afterwards) so it can run its own postprocessing — TS→MP4 fixup for HLS, `--merge-output-format mp4`, `-x --audio-format …` via ffmpeg. Piping to stdout is what used to produce MPEG-TS files named `.mp4` and extradata-less M4A — do not go back to piping.
4. When yt-dlp exits 0 the finished file is streamed to the client with an exact `Content-Length`; the temp dir is removed once the response (or a client abort) finishes.
5. Progress: `--progress-template "download:GACDL %(progress._percent_str)s"` (the `download:` prefix is the template TYPE and is not printed) is parsed from stdout into `/api/downloads/status` (`progress`, `detail`). Phases: `preparing → fetching → processing → downloading → complete|failed`; the UI polls this while waiting for response headers.

## Gotchas

- Services signal HTTP status via an `err.status` property; routes respond `e.status || 500`. New service errors without `.status` surface as generic 500s.
- Media-data 403s are YouTube-side (bot/IP checks), per-video; HLS usually keeps working while DASH/progressive formats 403. `classifyYtDlpError` maps them to 502 with a retry message. Compare against a plain yt-dlp run before blaming app code.
- Download status (`server/utils/downloadStatus.js`) is an in-memory Map — lost on restart; duplicate downloads for the same video+type return 429 while a job runs. Entries linger (complete/failed) for up to 10 min (`cleanupStale`).
- Cancelling: a client disconnect kills the yt-dlp process tree with `taskkill /T /F` — **Windows only** in practice: `spawn` is not `detached`, so the POSIX `kill(-pid)` branch degrades to killing just the direct child.
- `cleanupJobDir` retries (3×, 250 ms) because Windows keeps the media file locked briefly after the process exits.
- `classifyYtDlpError` (`server/services/ytdlp.js`) is the **single** source of friendly error strings — routes call it, they do not re-implement matching. Covered by `test/ytdlp.test.js`.
- Timeouts: info 30s, transcript 30s, download jobs 20 min (`DOWNLOAD_TIMEOUT_MS` in `ytdlp.js` / `transcript.js`).
- `.env` and media artifacts (`*.mp4`, `*.part`, `*.vtt`, `*.srt`) are gitignored — never commit them. Commits use conventional style (`feat: ...`, `fix: ...`).

## Known issues (verified 2026-10-19)

- Each download also performs an info (`--dump-json`) fetch, so a job takes one extra yt-dlp round trip before it starts.
- Rapid repeated `/api/info` calls get throttled and can 504 at the 30s info timeout — cool down before treating as a regression.
- Transcripts: `--sub-langs en` only; the any-language fallback exists only as comments; `isAuto` is hardcoded `true` (`server/services/transcript.js`).
- Large downloads are written to disk twice (YouTube → temp file, temp file → client); an aborted job may briefly leave a `grabaclip/job-*` dir behind until cleanup retries.
- No rate limiting anywhere; the server proxies YouTube fetches for any client — required before public deploy.
- The frontend buffers the whole file in memory (blob) before saving, so very large 1080p downloads cost RAM on the client.
