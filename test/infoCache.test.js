import test from "node:test";
import assert from "node:assert/strict";

import {
  getVideoInfoCached,
  getCachedInfo,
  setCachedInfo,
  clearInfoCache,
  getInfoCacheSize,
} from "../server/utils/infoCache.js";

test("getVideoInfoCached loads once and serves the cached object after", async () => {
  clearInfoCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    return { title: "A", formats: [] };
  };

  const first = await getVideoInfoCached("https://youtu.be/aaa", loader);
  const second = await getVideoInfoCached("https://youtu.be/aaa", loader);

  assert.equal(calls, 1);
  assert.equal(first, second);
  assert.equal(getCachedInfo("https://youtu.be/aaa"), first);
});

test("getVideoInfoCached dedupes concurrent loads for the same URL", async () => {
  clearInfoCache();
  let calls = 0;
  const loader = async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return { title: "B" };
  };

  const [a, b] = await Promise.all([
    getVideoInfoCached("https://youtu.be/bbb", loader),
    getVideoInfoCached("https://youtu.be/bbb", loader),
  ]);

  assert.equal(calls, 1);
  assert.equal(a, b);
  assert.equal(a.title, "B");
});

test("failed loads are not cached and can be retried", async () => {
  clearInfoCache();
  let calls = 0;
  const failing = async () => {
    calls += 1;
    throw new Error("boom");
  };

  await assert.rejects(() => getVideoInfoCached("https://youtu.be/ccc", failing));
  assert.equal(getCachedInfo("https://youtu.be/ccc"), null);

  const info = await getVideoInfoCached("https://youtu.be/ccc", async () => ({ title: "recovered" }));
  assert.equal(calls, 1);
  assert.equal(info.title, "recovered");
});

test("cache is keyed per URL and can be cleared", () => {
  clearInfoCache();
  setCachedInfo("https://youtu.be/x", { title: "X" });
  setCachedInfo("https://youtu.be/y", { title: "Y" });

  assert.equal(getInfoCacheSize(), 2);
  assert.equal(getCachedInfo("https://youtu.be/y").title, "Y");

  clearInfoCache();
  assert.equal(getInfoCacheSize(), 0);
  assert.equal(getCachedInfo("https://youtu.be/x"), null);
});
