import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  decodeCookiesBase64,
  parseNetscapeCookies,
  resolveCookies,
} from "../server/utils/cookies.js";

const NETSCAPE =
  "# Netscape HTTP Cookie File\n" +
  "# This is a comment and must be ignored\n" +
  ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\tsecret-sid\n" +
  "#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t0\t__Secure-1PSID\tsecret-psid\n" +
  ".x.com\tTRUE\t/\tTRUE\t0\tauth_token\tsecret-x\n" +
  ".instagram.com\tTRUE\t/\tTRUE\t0\tsessionid\tsecret-ig\n";

function base64url(text) {
  return Buffer.from(text, "utf8")
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

test("parseNetscapeCookies counts real cookie lines and detects YouTube auth", () => {
  const meta = parseNetscapeCookies(NETSCAPE);

  assert.equal(meta.valid, true);
  assert.equal(meta.count, 4);
  assert.deepEqual(meta.domains, ["youtube.com", "x.com", "instagram.com"]);
  assert.equal(meta.hasYouTube, true);
  assert.equal(meta.hasYouTubeAuth, true);

  // Comments and malformed lines are ignored, not treated as cookies.
  const malformed = parseNetscapeCookies("# comment\nnot-a-cookie\n");
  assert.equal(malformed.valid, false);
  assert.equal(malformed.count, 0);
});

test("parseNetscapeCookies does not mark public-only YouTube cookies as signed in", () => {
  const anonymous =
    ".youtube.com\tTRUE\t/\tTRUE\t0\tPREF\ttest-preference\n" +
    ".youtube.com\tTRUE\t/\tTRUE\t0\tVISITOR_INFO1_LIVE\tvisitor\n";
  const meta = parseNetscapeCookies(anonymous);

  assert.equal(meta.valid, true);
  assert.equal(meta.hasYouTube, true);
  assert.equal(meta.hasYouTubeAuth, false);
});

test("decodeCookiesBase64 accepts standard and base64url encodings", () => {
  const standard = Buffer.from(NETSCAPE, "utf8").toString("base64");
  const decoded = decodeCookiesBase64(standard);
  assert.equal(decoded.error, undefined);
  assert.equal(decoded.content, NETSCAPE);
  assert.equal(decoded.meta.count, 4);

  const urlSafe = decodeCookiesBase64(base64url(NETSCAPE));
  assert.equal(urlSafe.error, undefined);
  assert.equal(urlSafe.content, NETSCAPE);

  // Line-wrapped base64 (some secret stores insert whitespace) is fine too.
  const wrapped = standard.replace(/(.{40})/g, "$1\n");
  assert.equal(decodeCookiesBase64(wrapped).error, undefined);
});

test("decodeCookiesBase64 rejects malformed data without echoing it", () => {
  const invalid = decodeCookiesBase64("!!! not base64 !!!");
  assert.match(invalid.error, /valid base64/i);

  const notNetscape = decodeCookiesBase64(Buffer.from("hello world").toString("base64"));
  assert.match(notNetscape.error, /Netscape/i);
  assert.doesNotMatch(notNetscape.error, /hello world/);

  assert.match(decodeCookiesBase64("").error, /empty/i);
});

test("resolveCookies writes a private temp file for base64 cookies", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gac-cookies-"));
  try {
    const resolved = resolveCookies(
      { YTDLP_COOKIES_B64: Buffer.from(NETSCAPE, "utf8").toString("base64") },
      { tempRoot, cleanupOnExit: false }
    );

    assert.equal(resolved.configured, true);
    assert.equal(resolved.source, "base64");
    assert.ok(resolved.path.startsWith(tempRoot));
    assert.equal(resolved.count, 4);
    assert.equal(resolved.hasYouTubeAuth, true);
    assert.equal(resolved.error, null);
    assert.equal(fs.readFileSync(resolved.path, "utf8"), NETSCAPE);

    if (process.platform !== "win32") {
      assert.equal(resolved.mode & 0o077, 0, "cookie temp file must not be group/world readable");
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCookies prefers a valid YTDLP_COOKIES_FILE over base64", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gac-cookies-"));
  try {
    const filePath = path.join(tempRoot, "cookies.txt");
    fs.writeFileSync(filePath, NETSCAPE, { mode: 0o600 });

    const resolved = resolveCookies(
      {
        YTDLP_COOKIES_FILE: filePath,
        YTDLP_COOKIES_B64: Buffer.from(NETSCAPE, "utf8").toString("base64"),
      },
      { tempRoot, cleanupOnExit: false }
    );

    assert.equal(resolved.configured, true);
    assert.equal(resolved.source, "file");
    assert.equal(resolved.path, filePath);
    assert.equal(resolved.count, 4);
    assert.equal(resolved.hasYouTubeAuth, true);
    assert.equal(resolved.error, null);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCookies falls back to base64 when the configured file is missing", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gac-cookies-"));
  try {
    const resolved = resolveCookies(
      {
        YTDLP_COOKIES_FILE: path.join(tempRoot, "missing.txt"),
        YTDLP_COOKIES_B64: Buffer.from(NETSCAPE, "utf8").toString("base64"),
      },
      { tempRoot, cleanupOnExit: false }
    );

    assert.equal(resolved.configured, true);
    assert.equal(resolved.source, "base64");
    assert.match(resolved.warning, /could not be read/i);
    assert.equal(resolved.error, null);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCookies reports invalid base64 without creating a cookie file", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gac-cookies-"));
  try {
    const resolved = resolveCookies(
      { YTDLP_COOKIES_B64: "definitely-not-base64!" },
      { tempRoot, cleanupOnExit: false }
    );

    assert.equal(resolved.configured, false);
    assert.equal(resolved.path, null);
    assert.match(resolved.error, /base64/i);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("resolveCookies removes the decoded cookie file on normal process exit", () => {
  const moduleUrl = new URL("../server/utils/cookies.js", import.meta.url).href;
  const script = `
    import { resolveCookies } from ${JSON.stringify(moduleUrl)};
    const resolved = resolveCookies();
    if (!resolved.configured) process.exit(2);
    process.stdout.write(resolved.path);
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: {
      ...process.env,
      YTDLP_COOKIES_B64: Buffer.from(NETSCAPE, "utf8").toString("base64"),
      YTDLP_COOKIES_FILE: "",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const cookiePath = result.stdout.trim();
  assert.ok(cookiePath, "child process should report the cookie path");
  assert.equal(fs.existsSync(cookiePath), false, "cookie temp file should be removed on exit");
});

// The cookies env vars are read when ytdlp.js is first imported, so this test
// sets them before the dynamic import (node:test runs each file in its own
// process, so other test files are unaffected). Keep this test last.
test("yt-dlp receives the decoded cookie file", async () => {
  const netscape =
    "# Netscape HTTP Cookie File\n" +
    ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\ttest-session-value\n";
  process.env.YTDLP_COOKIES_B64 = Buffer.from(netscape, "utf8").toString("base64");
  delete process.env.YTDLP_COOKIES_FILE;

  const { getCookiesInfo, getCookiesArgs } = await import("../server/services/ytdlp.js");
  const info = getCookiesInfo();
  assert.equal(info.configured, true);
  assert.equal(info.source, "base64");
  assert.equal(info.hasYouTubeAuth, true);
  assert.equal(info.count, 1);
  assert.ok(info.path, "the decoded cookies must be written to a temp file");
  assert.equal(fs.readFileSync(info.path, "utf8"), netscape);
  assert.deepEqual(getCookiesArgs(), ["--cookies", info.path]);
});
