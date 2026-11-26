import test from "node:test";
import assert from "node:assert/strict";
import type { HostEnv } from "./types.ts";
import { KVCache, kvKeyClass } from "./kv.ts";

const QUOTA_ERR = '__ETHER_FAULT__{"code":"quota_exceeded","message":"plugins: storage quota exceeded"}';

/** Fake host store with the real rules: a key cap and a byte cap (value bytes + 256 per key). */
function makeCappedHost(maxKeys: number, maxBytes = Number.MAX_SAFE_INTEGER) {
  const store = new Map<string, string>();
  const logs: string[] = [];
  let now = 1_760_000_000_000;
  let failAll: string | null = null;
  const used = () => {
    let b = 0;
    for (const v of store.values()) b += v.length + 256;
    return b;
  };
  const env: HostEnv = {
    now: () => now,
    log: (...a: unknown[]) => { logs.push(a.join(" ")); },
    kv: {
      get: (k) => store.get(k) ?? null,
      put: (k, v) => {
        if (failAll) throw new Error(failAll);
        const had = store.get(k);
        const keys = store.size + (had === undefined ? 1 : 0);
        const bytes = used() - (had === undefined ? 0 : had.length + 256) + v.length + 256;
        if (keys > maxKeys || bytes > maxBytes) throw new Error(QUOTA_ERR);
        store.set(k, v);
      },
      delete: (k) => { store.delete(k); },
      list: (prefix = "") => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
    },
    http: { fetch: () => ({ status: 404, body: "" }) },
    settings: { get: () => ({}) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
  return { env, store, logs, advance: (ms: number) => { now += ms; }, failAll: (m: string | null) => { failAll = m; } };
}

const HOUR = 3_600_000;

test("defect B: at the key cap a high-value write evicts a low-value entry instead of being dropped", () => {
  const h = makeCappedHost(10);
  const cache = new KVCache(h.env);
  for (let i = 0; i < 10; i++) cache.set(`sq_v1:al-${i}:q`, { i }, HOUR);
  assert.equal(h.store.size, 10);
  const other = new KVCache(h.env); // a later request: nothing in memory
  other.set("alb_rel_v12:al-new", { releases: [] }, 24 * HOUR);
  assert.ok(h.store.has("alb_rel_v12:al-new"), "high-value entry stored");
  assert.equal(h.store.size, 10);
  assert.equal([...h.store.keys()].filter((k) => k.startsWith("sq_v1:")).length, 9, "one memo was evicted");
});

test("defect B: expired entries go before live ones, whatever their class", () => {
  const h = makeCappedHost(6);
  const cache = new KVCache(h.env);
  cache.set("album_v2:al-expired", { a: 1 }, HOUR); // high-ish class but about to expire
  for (let i = 0; i < 5; i++) cache.set(`sq_v1:live-${i}`, { i }, 24 * HOUR);
  h.advance(2 * HOUR);
  new KVCache(h.env).set("alb_rel_v12:al-new", { r: 1 }, HOUR);
  assert.ok(h.store.has("alb_rel_v12:al-new"));
  assert.equal(h.store.has("album_v2:al-expired"), false, "expired entry evicted first");
  assert.equal([...h.store.keys()].filter((k) => k.startsWith("sq_v1:")).length, 5, "live memos untouched");
});

test("defect B: lowest class and oldest write go first; rate gates and verified results survive", () => {
  const h = makeCappedHost(6);
  const cache = new KVCache(h.env);
  cache.set("alb_rel_v12:al-1", { r: 1 }, 24 * HOUR);
  cache.set("album_v2:al-1", { a: 1 }, 24 * HOUR);
  cache.set("dz:artist:1", { n: 1 }, 24 * HOUR);
  h.env.kv.put("rl:deezer:win", "[1]");
  cache.set("sq_v1:old", { q: 1 }, 2 * HOUR);
  cache.set("sq_v1:newer", { q: 2 }, 20 * HOUR);
  new KVCache(h.env).set("alb_stage_v6:al-2", { s: 1 }, HOUR);
  assert.ok(h.store.has("alb_stage_v6:al-2"));
  assert.equal(h.store.has("sq_v1:old"), false, "oldest memo evicted");
  for (const k of ["sq_v1:newer", "alb_rel_v12:al-1", "album_v2:al-1", "dz:artist:1", "rl:deezer:win"]) {
    assert.ok(h.store.has(k), `${k} kept`);
  }
});

test("defect B: the byte cap evicts too", () => {
  const h = makeCappedHost(1000, 3000);
  const cache = new KVCache(h.env);
  for (let i = 0; i < 3; i++) cache.set(`sq_v1:${i}`, { pad: "x".repeat(600) }, HOUR);
  new KVCache(h.env).set("alb_rel_v12:big", { pad: "y".repeat(1200) }, HOUR);
  assert.ok(h.store.has("alb_rel_v12:big"));
});

test("defect B: normal writes never list or scan the store", () => {
  const h = makeCappedHost(100);
  let lists = 0;
  const origList = h.env.kv.list;
  h.env.kv.list = (p) => { lists++; return origList(p); };
  const cache = new KVCache(h.env);
  for (let i = 0; i < 20; i++) cache.set(`sq_v1:${i}`, { i }, HOUR);
  assert.equal(lists, 0);
});

test("defect B: a host write error is logged once a minute with prefix and size, never the value", () => {
  const h = makeCappedHost(100);
  h.failAll("host_error: disk on fire");
  const cache = new KVCache(h.env);
  for (let i = 0; i < 25; i++) cache.set(`album_v2:al-${i}`, { secret: "VALUE-DO-NOT-LOG" }, HOUR);
  const warns = h.logs.filter((l) => l.includes("write failed"));
  assert.equal(warns.length, 1);
  assert.match(warns[0], /prefix=album_v2:/);
  assert.match(warns[0], /bytes=\d+/);
  assert.equal(h.logs.some((l) => l.includes("VALUE-DO-NOT-LOG")), false);
  h.advance(61_000);
  cache.set("album_v2:later", { x: 1 }, HOUR);
  assert.equal(h.logs.filter((l) => l.includes("write failed")).length, 2, "logs again after a minute");
});

test("defect B: unevictable full store logs once and keeps the in-memory copy", () => {
  const h = makeCappedHost(2);
  h.env.kv.put("rl:a", "1");
  h.env.kv.put("rl:b", "1");
  const cache = new KVCache(h.env);
  for (let i = 0; i < 5; i++) cache.set(`sq_v1:${i}`, { i }, HOUR);
  assert.equal(h.logs.filter((l) => l.includes("write failed")).length, 1);
  assert.deepEqual(cache.get("sq_v1:3"), { i: 3 });
  assert.ok(h.store.has("rl:a") && h.store.has("rl:b"));
});

test("kvKeyClass: priority table", () => {
  assert.equal(kvKeyClass("rl:deezer:win"), -1);
  assert.equal(kvKeyClass("alb_rel_v5:x"), 0);
  assert.equal(kvKeyClass("sq_v1:x"), 1);
  assert.equal(kvKeyClass("dz:artist:1"), 2);
  assert.equal(kvKeyClass("mb:rg:x"), 2);
  assert.equal(kvKeyClass("album_v2:al-1"), 3);
  assert.equal(kvKeyClass("alb_rel_v12:al-1"), 4);
});
