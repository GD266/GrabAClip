import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shared temp workspace for Grab a Clip. Cookie files and media jobs live
 * below it; keep it private even on multi-user hosts.
 */
export const COOKIE_TEMP_ROOT = path.join(os.tmpdir(), "grabaclip");

// Cookie names that indicate a signed-in YouTube session. Only the presence of
// these names is reported; values are never logged or returned by the API.
const YOUTUBE_AUTH_COOKIE_NAMES = new Set([
  "SID",
  "HSID",
  "SSID",
  "APISID",
  "SAPISID",
  "LOGIN_INFO",
  "__Secure-1PSID",
  "__Secure-1PAPISID",
  "__Secure-1PSIDTS",
  "__Secure-3PSID",
  "__Secure-3PAPISID",
  "__Secure-3PSIDTS",
]);

function normalizeContent(content) {
  return String(content ?? "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

function normalizeDomain(raw) {
  return String(raw || "")
    .trim()
    .replace(/^#HttpOnly_/i, "")
    .replace(/^\./, "")
    .toLowerCase();
}

function isYouTubeDomain(domain) {
  return domain === "youtube.com" || domain.endsWith(".youtube.com");
}

/**
 * Validate and summarize a Netscape cookies.txt file.
 *
 * Returns metadata only (cookie count / domains / whether a signed-in YouTube
 * session is present). Cookie names and values must never be logged or exposed
 * through diagnostics.
 */
export function parseNetscapeCookies(content) {
  const text = normalizeContent(content);
  const domains = new Set();
  let count = 0;
  let hasYouTube = false;
  let hasYouTubeAuth = false;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;

    // "#HttpOnly_" prefixes a real cookie line; all other # lines are comments.
    if (line.trimStart().startsWith("#") && !/^\s*#HttpOnly_/i.test(line)) continue;

    const fields = line.split("\t");
    if (fields.length < 7) continue;

    const domain = normalizeDomain(fields[0]);
    const name = String(fields[5] || "").trim();
    if (!domain || !name) continue;

    count += 1;
    domains.add(domain);

    if (isYouTubeDomain(domain)) {
      hasYouTube = true;
      if (YOUTUBE_AUTH_COOKIE_NAMES.has(name)) hasYouTubeAuth = true;
    }
  }

  return {
    valid: count > 0,
    count,
    domains: [...domains],
    hasYouTube,
    hasYouTubeAuth,
  };
}

/**
 * Decode YTDLP_COOKIES_B64 without ever echoing the contents in an error.
 * Accepts standard base64 (with optional whitespace/padding) and base64url.
 */
export function decodeCookiesBase64(encoded) {
  const raw = String(encoded ?? "").trim();
  if (!raw) return { error: "YTDLP_COOKIES_B64 is empty." };

  const compact = raw.replace(/\s+/g, "").replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(compact) || compact.length % 4 === 1) {
    return { error: "YTDLP_COOKIES_B64 is not valid base64." };
  }

  let content;
  try {
    content = Buffer.from(compact, "base64").toString("utf8");
  } catch {
    return { error: "YTDLP_COOKIES_B64 could not be decoded." };
  }

  if (!content || content.includes("\uFFFD")) {
    return { error: "YTDLP_COOKIES_B64 did not decode to valid UTF-8 text." };
  }

  const meta = parseNetscapeCookies(content);
  if (!meta.valid) {
    return {
      error:
        "YTDLP_COOKIES_B64 did not decode to a Netscape cookie file (expected tab-separated cookie lines).",
    };
  }

  return { content, meta };
}

/**
 * Resolve the configured cookie source.
 *
 * YTDLP_COOKIES_FILE wins when it points at a valid Netscape file. Otherwise a
 * decoded YTDLP_COOKIES_B64 is written to a private (0600) temp file for this
 * process and removed on exit. Cookies are credentials: error messages contain
 * paths/status only, never file contents.
 */
export function resolveCookies(env = process.env, options = {}) {
  const tempRoot = options.tempRoot || COOKIE_TEMP_ROOT;
  const cleanupOnExit = options.cleanupOnExit !== false;
  let warning = null;

  const explicitPath = String(env.YTDLP_COOKIES_FILE || "").trim();
  if (explicitPath) {
    try {
      const stat = fs.statSync(explicitPath);
      if (!stat.isFile()) {
        warning = "YTDLP_COOKIES_FILE does not point to a regular file.";
      } else {
        const content = fs.readFileSync(explicitPath, "utf8");
        const meta = parseNetscapeCookies(content);
        if (meta.valid) {
          const mode = stat.mode & 0o777;
          // POSIX only: Windows reports synthesized permission bits that would
          // make this warning fire for every file.
          if (process.platform !== "win32" && (mode & 0o077) !== 0) {
            warning = `YTDLP_COOKIES_FILE is readable by other users (mode ${mode.toString(8)}); run chmod 600 on it.`;
          }
          return {
            configured: true,
            source: "file",
            path: explicitPath,
            ...meta,
            mode,
            size: stat.size,
            warning,
            error: null,
          };
        }
        warning = "YTDLP_COOKIES_FILE is not a valid Netscape cookie file.";
      }
    } catch (e) {
      warning = `YTDLP_COOKIES_FILE could not be read (${e.code || "error"}).`;
    }
  }

  const encoded = String(env.YTDLP_COOKIES_B64 || "").trim();
  if (!encoded) {
    return {
      configured: false,
      source: null,
      path: null,
      count: 0,
      domains: [],
      hasYouTube: false,
      hasYouTubeAuth: false,
      mode: null,
      size: null,
      warning,
      error: null,
    };
  }

  const decoded = decodeCookiesBase64(encoded);
  if (decoded.error) {
    return {
      configured: false,
      source: null,
      path: null,
      count: 0,
      domains: [],
      hasYouTube: false,
      hasYouTubeAuth: false,
      mode: null,
      size: null,
      warning,
      error: warning ? `${warning} ${decoded.error}` : decoded.error,
    };
  }

  try {
    fs.mkdirSync(tempRoot, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(tempRoot, 0o700);
    } catch {}

    const target = path.join(tempRoot, `cookies-${process.pid}.txt`);
    fs.writeFileSync(target, decoded.content, { mode: 0o600 });
    try {
      fs.chmodSync(target, 0o600);
    } catch {}

    if (cleanupOnExit) {
      process.once("exit", () => {
        try {
          fs.rmSync(target, { force: true });
        } catch {}
      });
    }

    const stat = fs.statSync(target);
    return {
      configured: true,
      source: "base64",
      path: target,
      ...decoded.meta,
      mode: stat.mode & 0o777,
      size: stat.size,
      warning,
      error: null,
    };
  } catch (e) {
    return {
      configured: false,
      source: null,
      path: null,
      count: 0,
      domains: [],
      hasYouTube: false,
      hasYouTubeAuth: false,
      mode: null,
      size: null,
      warning,
      error: `Could not write the decoded cookie file (${e.code || "error"}).`,
    };
  }
}
