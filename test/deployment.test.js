import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

// ---------------------------------------------------------------------------
// Static frontend / deployment layout
// ---------------------------------------------------------------------------

test("the validator is served from public/ so static hosts keep the import working", () => {
  const app = read("public/app.js");
  assert.match(app, /from "\/shared\/validator\.js"/);

  const validator = read("public/shared/validator.js");
  assert.match(validator, /export function extractVideoId/);
  assert.match(validator, /export function isYouTubeUrl/);
  assert.match(validator, /export function normalizeYouTubeUrl/);
});

test("index.html loads config.js before the app module", () => {
  const html = read("public/index.html");
  const configIndex = html.indexOf("config.js");
  const appIndex = html.indexOf("app.js");

  assert.notEqual(configIndex, -1, "config.js script tag is missing");
  assert.notEqual(appIndex, -1, "app.js script tag is missing");
  assert.ok(configIndex < appIndex, "config.js must load before app.js");
});

test("index.html points at the Grab a Clip favicon", () => {
  const html = read("public/index.html");
  assert.match(html, /<link[^>]+rel="icon"[^>]+href="\/favicon\.svg"[^>]+type="image\/svg\+xml"/);
  assert.match(read("public/favicon.svg"), /<svg[^>]+viewBox="0 0 64 64"/);
});

test("config.js exposes the API base global", () => {
  assert.match(read("public/config.js"), /window\.GAC_API_BASE\s*=/);
});

test("the frontend sends API calls through the configurable base", () => {
  const app = read("public/app.js");
  assert.match(app, /const API_BASE = String/);
  assert.match(app, /function apiUrl\(path\)/);
  assert.match(app, /fetch\(apiUrl\("\/api\/info"\)/);
  assert.match(app, /apiUrl\(`\/api\/download\?/);
  assert.match(app, /apiUrl\(`\/api\/download\/audio\?/);
  assert.match(app, /fetch\(apiUrl\("\/api\/downloads\/status"\)\)/);
  assert.match(app, /fetch\(apiUrl\("\/api\/intelligence"\)/);

  // No bare API fetches should remain (they would ignore API_BASE).
  assert.doesNotMatch(app, /fetch\("\/api\//);
});

test("vercel.json deploys the public directory", () => {
  const config = JSON.parse(read("vercel.json"));
  assert.equal(config.outputDirectory, "public");
  assert.equal(config.buildCommand, "node scripts/vercel-build.js");
});
