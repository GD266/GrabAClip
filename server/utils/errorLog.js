// Small in-memory ring buffer of unexpected server errors.
//
// Deployed containers are hard to debug: a process crash shows up as a plain
// 502 from the host and the stack trace is only in the host's logs. Keeping the
// last errors here lets /api/health?diagnostics=1 expose them, so a failing
// deployment can be diagnosed with a single request.
const MAX_ENTRIES = 20;
const entries = [];

export function recordError(scope, error) {
  const err = error instanceof Error ? error : new Error(String(error));
  const entry = {
    at: new Date().toISOString(),
    scope: String(scope || "unknown"),
    name: err.name || "Error",
    message: String(err.message || err).slice(0, 500),
    stack: String(err.stack || "").split("\n").slice(0, 4).join(" | ").slice(0, 800),
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  return entry;
}

export function getRecentErrors() {
  return entries.slice();
}
