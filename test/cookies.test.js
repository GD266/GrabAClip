import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The cookies env vars are read when ytdlp.js is first imported, so this file
// sets them before the dynamic import (node:test runs each file in its own
// process, so other test files are unaffected).
test("yt-dlp cookies can be supplied base64-encoded", async () => {
  const netscape =
    "# Netscape HTTP Cookie File\n" +
    ".youtube.com\tTRUE\t/\tTRUE\t0\tSID\ttest-session-value\n";
  process.env.YTDLP_COOKIES_B64 = Buffer.from(netscape, "utf8").toString("base64");

  const { getCookiesInfo } = await import("../server/services/ytdlp.js");
  const info = getCookiesInfo();
  assert.equal(info.configured, true);
  assert.equal(info.source, "base64");

  const written = fs.readFileSync(path.join(os.tmpdir(), "grabaclip", "cookies.txt"), "utf8");
  assert.match(written, /SID\ttest-session-value/);
});
