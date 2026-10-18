# AGENTS.md

Grab a Clip — single-package Node.js (ESM) Express app: YouTube downloader backend (`server/`) + vanilla JS frontend (`public/`). No build step, no bundler, not a monorepo.

## Commands

- `npm run dev` — server with reload (`node --watch server/index.js`) at http://localhost:3000
- `npm start` — run server
- `npm test` — `node --test test/*.test.js` (Node's built-in runner). **There is currently no `test/` directory: a green run means 0 tests, not passing tests.**
- Single test: `node --test test/<file>.test.js`; filter: `node --test --test-name-pattern="name" test/<file>.test.js`
- No lint / format / typecheck is configured — do not invent commands. Syntax check: `node --check <file>`.
- Smoke test: `npm run dev`, then `GET http://localhost:3000/api/health` → `{ status: "ok", ytDlp: ... }` (also confirms the yt-dlp binary resolves).

## Runtime prerequisites

- `yt-dlp` on PATH (override: `YTDLP_BIN`) — required for all API features.
- `ffmpeg` on PATH (override: `FFMPEG_BIN`) — required for audio downloads. Not mentioned in `.env.example`.
- Copy `.env.example` → `.env`. With no `OPENAI_API_KEY`, the AI provider silently falls back to `MockProvider` (responses flagged `isFallback: true`).

## Status: done vs. remaining (assessed 2026-10-15)

Shipped — 5 phases across 6 commits (last commit 2026-08-26):
- Video info + quality picker + streamed MP4 download with friendly yt-dlp error mapping (`server/routes/download.js`).
- Intelligence: English transcript + AI summary (OpenAI-compatible or mock provider).
- Audio: `mp3`/`m4a`/`aac`/`best` all route through HLS (`91/92/...`) + ffmpeg; `opus` is the only native (no-ffmpeg) path (`server/services/ytdlp.js`).
- Reliability: client disconnect → process-tree kill, duplicate-download 429, 30s info / 5min download timeouts, abortable info fetch, in-memory status polled by the UI.
- Premium dark UI with byte-level progress + cancel (`public/`).

Remaining work to consider "complete" (no roadmap file exists — derived from repo gaps plus live verification on 2026-10-15 with yt-dlp 2026.07.04, ffmpeg 9.0, running `npm start`):

Verified bugs (reproduced live):
1. **Audio `format=high` always 400s.** The route's allowed set includes `"high"` but `createAudioDownloadStream`'s does not, so it rejects after a full info fetch (~11s). The service's `"high"` branch is unreachable dead code. The UI offers "High" whenever best-m4a differs from best — those clicks fail.
2. **Audio `wav` mislabels output.** Route ignores the service's returned `outputExt` (service produces m4a for `wav`) and sends `.wav` / `audio/wav` headers around m4a bytes. Fix: honor `result.outputExt`, or drop `wav` from both allowed sets.

Environment / upstream (checked before blaming app code):
3. **Media-data 403s are YouTube-side, not the app.** Plain `yt-dlp` on this machine also fails `unable to download video data: HTTP Error 403` (formats 18 and 401) while `--dump-json` info works; one default download 403'd after 61MB. Suspects: IP/bot blocking, need `--extractor-args "youtube:player_client=..."` or cookies. Log shows yt-dlp solving JS challenges via **deno** (`[jsc:deno]`) — deno is a soft runtime dependency here.
4. **Rapid repeated info fetches get throttled** — successive `/api/info` calls slowed 3.7s→30s+ until `INFO_TIMEOUT_MS` produced route-level 504s. Don't treat a 504 under test load as a regression without a cool-down retry.

Other gaps:
5. **Tests** — none exist; `npm test` passes vacuously. Best first targets: `shared/validator.js`, `sanitizeFilename`/`validateDownloadQuery` (`server/utils/validation.js`), `normalizeTranscriptContent` (`server/services/transcript.js`) — all already exported; error mapping and `buildFormats` in `ytdlp.js` would need exporting first.
6. **README** — none. `.env.example` also omits `FFMPEG_BIN`.
7. **Stale metadata** — `package.json` `description` still says "Phase 1: Core Downloader".
8. **Abuse protection** — no rate limiting anywhere; the server proxies YouTube fetches for any client. Required before any public deploy (plus: `downloadStatus` Map is lost on restart).
9. **Verify `Content-Length`** — set from the selected format's `filesize`, but the stream is `formatId+bestaudio` merged, so the real byte count can differ (`X-Expected-Size` only drives the progress bar). Unverified live — downloads 403'd (item 3).
10. **Transcript gaps** — `--sub-langs en` only; the any-language fallback pass exists only as comments, unimplemented (`server/services/transcript.js`); `isAuto` is hardcoded `true`.
11. **No CI / lint** (see Commands — none configured).

## Layout

- `server/index.js` — entrypoint; mounts `/api/*` routes, serves `public/` statically, SPA fallback for other paths (Express **4** syntax `app.get("*")`).
- `server/routes/` — HTTP layer; `server/services/` — yt-dlp, transcript, AI logic; `server/utils/` — validation + download status.
- `shared/validator.js` — canonical URL validation (re-exported by `server/utils/validation.js`).

## Gotchas

- `public/app.js` contains an **inline duplicate** of `shared/validator.js` (comment says "mirrors shared/validator.js"). Validation changes must be made in both files; nothing enforces sync.
- Services signal HTTP status via an `err.status` property; routes respond `e.status || 500`. New service errors without `.status` surface as generic 500s.
- Audio downloads intentionally use HLS video formats (`91/92/...`) piped through ffmpeg instead of `bestaudio` — direct bestaudio hits SABR/403 errors. Do not "simplify" this.
- Download status (`server/utils/downloadStatus.js`) is an in-memory Map — resets on server restart; concurrent duplicate downloads for the same video+type return HTTP 429.
- Downloads stream yt-dlp stdout straight to the response (no temp files); client disconnects kill the process tree (`taskkill /T /F` on Windows).
- yt-dlp stderr is pattern-matched into friendly errors in `classifyYtDlpError` (`server/services/ytdlp.js`) **and again** in the `download.js` close handler — keep both in sync when changing error messages.
- Timeouts: info fetch 30s, download 5min (`server/services/ytdlp.js`).
- `.env` and media artifacts (`*.mp4`, `*.part`, `*.vtt`, `*.srt`) are gitignored — never commit them.
- Commits follow conventional style (`feat: ...`, `fix: ...`).
