import type {
  HostEnv,
  PluginSettings,
  QualityPreference,
  VideoQualityPreference,
  CuratedSize,
} from "./types.ts";

const FATAL_FAULT_CODES = new Set([
  "aborted",
  "cancelled",
  "canceled",
  "deadline_exceeded",
  "timeout",
  "governance",
]);

function extractFaultCode(err: unknown, msg: string): string {
  const rec = err as { code?: unknown; Code?: unknown };
  const direct = String(rec?.code || rec?.Code || "").trim().toLowerCase();
  if (direct) return direct;
  const at = msg.indexOf("__ETHER_FAULT__");
  if (at >= 0) {
    try {
      const parsed = JSON.parse(msg.slice(at + "__ETHER_FAULT__".length));
      const c = String(parsed?.code || parsed?.Code || "").trim().toLowerCase();
      if (c) return c;
    } catch {
      // Bare __ETHER_FAULT__ string without JSON payload.
    }
  }
  return "";
}

/**
 * Returns true only for fatal host lifecycle faults (timeout, deadline_exceeded,
 * governance, aborted/cancelled) so callers propagate them immediately instead of
 * swallowing them. Non-fatal structured host faults (invalid_input, rate_limited,
 * host_error, upstream, unavailable, check_dependency) remain catchable so optional
 * features (e.g. usenet_check on older Ether builds, optional enrichment) degrade cleanly.
 */
export function isHostFaultOrAbort(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : String((err as { message?: unknown }).message || err);
  const code = extractFaultCode(err, msg);
  if (code) {
    return FATAL_FAULT_CODES.has(code);
  }
  if (msg.includes("__ETHER_FAULT__")) return true;
  const rec = err as { name?: unknown };
  return String(rec?.name || "") === "AbortError";
}

export function rethrowHostFault(err: unknown): void {
  if (isHostFaultOrAbort(err)) {
    throw err;
  }
}

export function defaultHostEnv(): HostEnv {
  const g = (globalThis as any).ether;
  if (!g) {
    throw new Error("ether host global is unavailable");
  }
  return {
    now: () => Date.now(),
    log: (...args: unknown[]) => {
      try { g.log(...args); } catch { /* ignore */ }
    },
    kv: {
      get: (k: string) => {
        const v = g.kv.get(k);
        return typeof v === "string" ? v : null;
      },
      put: (k: string, v: string) => { g.kv.put(k, v); },
      delete: (k: string) => { g.kv.delete(k); },
      list: (prefix = "") => {
        const res = g.kv.list(prefix);
        return Array.isArray(res) ? res : [];
      },
    },
    http: {
      fetch: (req) => g.http.fetch(req),
    },
    settings: {
      get: () => {
        try { return g.settings.get() || {}; } catch { return {}; }
      },
    },
    sources: {
      resolve: (q) => g.sources.resolve(q) || { candidates: [] },
    },
  };
}

export function readSettings(env: HostEnv, reqSettings?: Record<string, unknown>): PluginSettings {
  const base = reqSettings && Object.keys(reqSettings).length > 0
    ? reqSettings
    : env.settings.get();
  const qp = String(base?.qualityPreference || "flac_preferred");
  const qualityPreference: QualityPreference =
    qp === "lossless_only" || qp === "high_bitrate" ? qp : "flac_preferred";
  const vqp = String(base?.videoQualityPreference || "uhd_preferred");
  const videoQualityPreference: VideoQualityPreference =
    vqp === "1080p_preferred" || vqp === "balanced" ? vqp : "uhd_preferred";
  const cs = String(base?.curatedSize || "standard");
  const curatedSize: CuratedSize =
    cs === "compact" || cs === "large" ? cs : "standard";
  const cats = String(base?.newznabCategories || "3000,3010,3040").trim() || "3000,3010,3040";
  const concertCats =
    String(base?.concertNewznabCategories || "2000,2040,2045,3020,5000").trim() ||
    "2000,2040,2045,3020,5000";
  const enrichMusicBrainz = base?.enrichMusicBrainz !== false;
  return {
    qualityPreference,
    newznabCategories: cats,
    videoQualityPreference,
    concertNewznabCategories: concertCats,
    curatedSize,
    enrichMusicBrainz,
  };
}

interface CacheEnvelope<T> {
  v: T;
  exp: number;
}

const LEGACY_BLOAT_PREFIXES = [
  "album_meta:",
  "alb_rel:",
  "alb_rel_v2:",
  "alb_rel_v3:",
  "alb_rel_v4:",
  "alb_rel_v5:",
  "alb_stage:",
  "alb_stage_v4:",
  "concert_rel_v1:",
];

const BULKY_RAW_DEEZER_PREFIXES = [
  "dz:album:",
  "dz:search:",
  "dz:artist:",
];

const BLOAT_SWEPT_KEY = "kv:bloat_swept:v1";

function isQuotaError(err: unknown): boolean {
  if (!err) return false;
  const msg = typeof err === "string" ? err : String((err as { message?: unknown }).message || err);
  const code = extractFaultCode(err, msg);
  return code === "quota_exceeded" || /quota/i.test(msg);
}

function isBulkyArtistAlbumsPageKey(k: string): boolean {
  return k.startsWith("dz:artist:") && k.includes(":albums:p:");
}

/**
 * Host limits (ether-src internal/plugins/store.go): 10 000 keys and 50 MiB per plugin, where each
 * key is charged its value bytes plus 256. A put that would cross either limit fails with
 * quota_exceeded; nothing is evicted by the host and expired entries are never reaped.
 */
const KEY_CHARGE_BYTES = 256;
/** Reads one eviction round may spend inspecting entries (each read is a host call). */
const EVICT_READ_BUDGET = 150;
const WRITE_FAIL_LOG_INTERVAL_MS = 60_000;

/**
 * Eviction class of a key, derived from its prefix. Lower classes are given up first.
 *   -1 never evicted: rate gates and small control keys (rl:, ss:, kv:)
 *    0 dead legacy prefixes
 *    1 search memos and probe/retry counters (sq_v1:, search_retry:, exp:artist:keys:, imdb_concert_v1:,
 *      dz:search:, playlists_bucket)
 *    2 rebuildable provider data (dz:*, mb:, caa:, lrc:, artist_art_v1:, curated:, rec_plan_v1:)
 *    3 catalogue data (album_v2:, concert_meta_v1:, backfill:, exp:alb_parent:) and unknown prefixes
 *    4 verified results and in-progress stage state (alb_rel_v12:, concert_rel_v2:, alb_stage_v6:, concert_stage_v2:)
 */
export function kvKeyClass(key: string): number {
  if (key.startsWith("rl:") || key.startsWith("ss:") || key.startsWith("kv:")) return -1;
  for (const p of LEGACY_BLOAT_PREFIXES) if (key.startsWith(p)) return 0;
  if (
    key.startsWith("sq_v1:") || key.startsWith("search_retry:") || key.startsWith("exp:artist:keys:") ||
    key.startsWith("imdb_concert_v1:") || key.startsWith("dz:search:") || key === "playlists_bucket"
  ) return 1;
  if (
    key.startsWith("dz:") || key.startsWith("mb:") || key.startsWith("caa:") || key.startsWith("lrc:") ||
    key.startsWith("artist_art_v1:") || key.startsWith("curated:") || key.startsWith("rec_plan_v1:")
  ) return 2;
  if (
    key.startsWith("alb_rel_v12:") || key.startsWith("concert_rel_v2:") ||
    key.startsWith("alb_stage_v6:") || key.startsWith("concert_stage_v2:")
  ) return 4;
  return 3;
}

function keyPrefixForLog(key: string): string {
  const at = key.indexOf(":");
  return at > 0 ? key.slice(0, at + 1) : key.slice(0, 12);
}

/** Last "write failed" log time per host kv object, so the limit holds across KVCache instances. */
const lastWriteFailLog = new WeakMap<object, number>();

export class KVCache {
  private env: HostEnv;
  private mem = new Map<string, { v: unknown; exp: number }>();

  constructor(env: HostEnv) {
    this.env = env;
  }

  get<T>(key: string, options?: { memOnly?: boolean; fresh?: boolean }): T | null {
    const now = this.env.now();
    if (!options?.fresh) {
      const hit = this.mem.get(key);
      if (hit) {
        if (hit.exp > now) return hit.v as T;
        this.mem.delete(key);
      }
    }
    if (options?.memOnly) return null;
    try {
      const raw = this.env.kv.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CacheEnvelope<T>;
      if (!parsed || typeof parsed.exp !== "number") return null;
      if (parsed.exp <= now) return null;
      if (!options?.fresh) {
        this.mem.set(key, parsed);
      }
      return parsed.v;
    } catch (err) {
      rethrowHostFault(err);
      return null;
    }
  }

  getStale<T>(key: string, options?: { memOnly?: boolean }): T | null {
    const hit = this.mem.get(key);
    if (hit) return hit.v as T;
    if (options?.memOnly) return null;
    try {
      const raw = this.env.kv.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CacheEnvelope<T>;
      return parsed && "v" in parsed ? parsed.v : null;
    } catch (err) {
      rethrowHostFault(err);
      return null;
    }
  }

  set<T>(key: string, value: T, ttlMs: number, options?: { persist?: boolean }): void {
    const exp = this.env.now() + ttlMs;
    const envObj: CacheEnvelope<T> = { v: value, exp };
    this.mem.set(key, envObj);
    if (options?.persist === false) return;
    this.putPersisted(key, JSON.stringify(envObj));
  }

  /**
   * Write to the host store. On quota_exceeded, evict (expired first, then low-value classes by
   * oldest expiry) and retry; a write that still fails is logged at most once a minute with the
   * key prefix and size (never the value). The in-memory copy stays for this call either way.
   */
  private putPersisted(key: string, payload: string): boolean {
    let lastErr: unknown;
    try {
      this.env.kv.put(key, payload);
      return true;
    } catch (err) {
      rethrowHostFault(err);
      lastErr = err;
    }
    if (isQuotaError(lastErr)) {
      const need = payload.length;
      for (const factor of [1, 6]) {
        const evicted = this.evictForWrite(key, need * factor);
        if (evicted === 0) break;
        try {
          this.env.kv.put(key, payload);
          this.env.log("info", `kv: evicted ${evicted} entries to store ${keyPrefixForLog(key)} (${payload.length} bytes)`);
          return true;
        } catch (retryErr) {
          rethrowHostFault(retryErr);
          lastErr = retryErr;
        }
      }
    }
    this.logWriteFailure(key, payload.length, lastErr);
    return false;
  }

  private logWriteFailure(key: string, size: number, err: unknown): void {
    const now = this.env.now();
    const last = lastWriteFailLog.get(this.env.kv);
    if (last !== undefined && now - last < WRITE_FAIL_LOG_INTERVAL_MS) return;
    lastWriteFailLog.set(this.env.kv, now);
    const msg = typeof err === "string" ? err : String((err as { message?: unknown })?.message || err);
    const code = extractFaultCode(err, msg) || "error";
    try {
      this.env.log("warn", `kv: write failed prefix=${keyPrefixForLog(key)} bytes=${size} code=${code}`);
    } catch { /* logging must never fail a write */ }
  }

  /**
   * Make room for one write of about `needBytes` (value bytes; each freed key also frees its 256-byte charge). Called only
   * after the host refused a put, so the full key listing costs nothing on normal writes.
   * Order: dead legacy prefixes; then expired entries of any class (found by reading at most
   * EVICT_READ_BUDGET entries, lowest class first); then live entries of the lowest class first,
   * oldest expiry first (expiry minus a fixed per-prefix TTL is the write time, so this is
   * least-recently-written). Rate gates and control keys are never touched. Returns deletions.
   */
  evictForWrite(keepKey: string, needBytes: number): number {
    let keys: string[];
    try {
      keys = this.env.kv.list("");
    } catch (err) {
      rethrowHostFault(err);
      return 0;
    }
    const now = this.env.now();
    const byClass: string[][] = [[], [], [], [], []];
    for (const k of keys) {
      if (!k || k === keepKey) continue;
      const c = kvKeyClass(k);
      if (c >= 0) byClass[c].push(k);
    }
    let deleted = 0;
    let freed = 0;
    const enough = () => deleted > 0 && freed >= needBytes;
    const drop = (k: string, size: number): void => {
      try {
        this.env.kv.delete(k);
        this.mem.delete(k);
        deleted++;
        freed += size + KEY_CHARGE_BYTES;
      } catch (err) {
        rethrowHostFault(err);
      }
    };

    for (const k of byClass[0]) {
      if (enough()) return deleted;
      drop(k, 0);
    }

    // Expired entries first, whatever their class; remember expiry of the live ones we read.
    let reads = EVICT_READ_BUDGET;
    const live: Array<Array<{ k: string; exp: number; size: number }>> = [[], [], [], [], []];
    const unread: string[][] = [[], [], [], [], []];
    for (let c = 1; c <= 4; c++) {
      for (const k of byClass[c]) {
        if (enough()) return deleted;
        if (reads <= 0) { unread[c].push(k); continue; }
        reads--;
        let raw: string | null = null;
        try {
          raw = this.env.kv.get(k);
        } catch (err) {
          rethrowHostFault(err);
        }
        if (!raw) continue;
        let exp = Number.POSITIVE_INFINITY;
        try {
          const parsed = JSON.parse(raw) as { exp?: unknown };
          if (typeof parsed?.exp === "number") exp = parsed.exp;
        } catch { /* unreadable entry: treat as live, unknown expiry */ }
        if (exp <= now) drop(k, raw.length);
        else live[c].push({ k, exp, size: raw.length });
      }
    }

    for (let c = 1; c <= 4; c++) {
      live[c].sort((a, b) => a.exp - b.exp);
      for (const e of live[c]) {
        if (enough()) return deleted;
        drop(e.k, e.size);
      }
      for (const k of unread[c]) {
        if (enough()) return deleted;
        drop(k, 0);
      }
    }
    return deleted;
  }

  delete(key: string): void {
    this.mem.delete(key);
    try {
      this.env.kv.delete(key);
    } catch (err) {
      rethrowHostFault(err);
      // ignore
    }
  }

  /**
   * Reclaim space when plugins_kv hits Ether's 50 MiB quota (e.g. legacy 0.2.4 installs
   * that persisted raw 86 KB Deezer responses). Deletes legacy versioned prefixes first,
   * then bulky raw dz:* entries, then expired/oldest album_v2:* entries.
   */
  evictForSpace(maxDeletes = 64, keepKey = ""): number {
    let deleted = 0;
    const tryDelete = (k: string): boolean => {
      if (!k || k === keepKey || k.startsWith("rl:")) return false;
      try {
        this.env.kv.delete(k);
        this.mem.delete(k);
        deleted++;
        return true;
      } catch (err) {
        rethrowHostFault(err);
        return false;
      }
    };

    const listSafe = (prefix: string): string[] => {
      try {
        return this.env.kv.list(prefix);
      } catch (err) {
        rethrowHostFault(err);
        return [];
      }
    };

    // 1. Dead legacy versioned prefixes (zero live readers).
    for (const prefix of LEGACY_BLOAT_PREFIXES) {
      if (deleted >= maxDeletes) return deleted;
      for (const k of listSafe(prefix)) {
        if (deleted >= maxDeletes) return deleted;
        tryDelete(k);
      }
    }

    // 1b. Short-lived search dedup memos (rebuilt safely after 5 min window).
    for (const k of listSafe("sq_v1:")) {
      if (deleted >= maxDeletes) return deleted;
      tryDelete(k);
    }

    // 2. Bulky raw Deezer payloads (rebuilt on demand / already stored compactly in album_v2:*).
    for (const prefix of BULKY_RAW_DEEZER_PREFIXES) {
      if (deleted >= maxDeletes) return deleted;
      const keys = listSafe(prefix);
      // Prioritize 86 KB paginated artist-albums payloads first when listing dz:artist:
      if (prefix === "dz:artist:") {
        for (const k of keys) {
          if (deleted >= maxDeletes) return deleted;
          if (isBulkyArtistAlbumsPageKey(k)) tryDelete(k);
        }
      }
      for (const k of keys) {
        if (deleted >= maxDeletes) return deleted;
        if (prefix === "dz:artist:" && isBulkyArtistAlbumsPageKey(k)) continue;
        tryDelete(k);
      }
    }

    // 3. Fallback: evict oldest/expired album_v2:* entries if still tight.
    if (deleted < maxDeletes) {
      const now = this.env.now();
      const albumKeys = listSafe("album_v2:");
      for (const k of albumKeys) {
        if (deleted >= maxDeletes) return deleted;
        try {
          const raw = this.env.kv.get(k);
          if (raw) {
            const parsed = JSON.parse(raw) as CacheEnvelope<unknown>;
            if (typeof parsed?.exp === "number" && parsed.exp <= now) {
              tryDelete(k);
            }
          }
        } catch (err) {
          rethrowHostFault(err);
        }
      }
      for (const k of albumKeys) {
        if (deleted >= maxDeletes) return deleted;
        tryDelete(k);
      }
    }

    return deleted;
  }

  /**
   * Bounded incremental sweep run on background sync / resolve to clean up legacy
   * versioned prefixes and bulky raw Deezer payloads left by <=0.2.4 installs so
   * existing deployments automatically recover well below Ether's 50 MiB KV quota.
   */
  sweepLegacyBloat(maxDeletes = 120): number {
    if (this.get<boolean>(BLOAT_SWEPT_KEY)) return 0;

    let deleted = 0;
    const listSafe = (prefix: string): string[] => {
      try {
        return this.env.kv.list(prefix);
      } catch (err) {
        rethrowHostFault(err);
        return [];
      }
    };

    const deleteKey = (k: string): void => {
      try {
        this.env.kv.delete(k);
        this.mem.delete(k);
        deleted++;
      } catch (err) {
        rethrowHostFault(err);
      }
    };

    let moreRemains = false;
    for (const prefix of [...LEGACY_BLOAT_PREFIXES, "dz:album:", "dz:search:"]) {
      const keys = listSafe(prefix);
      for (const k of keys) {
        if (deleted >= maxDeletes) {
          moreRemains = true;
          break;
        }
        deleteKey(k);
      }
      if (moreRemains) break;
    }

    if (!moreRemains) {
      const artistKeys = listSafe("dz:artist:");
      for (const k of artistKeys) {
        if (!isBulkyArtistAlbumsPageKey(k)) continue;
        if (deleted >= maxDeletes) {
          moreRemains = true;
          break;
        }
        deleteKey(k);
      }
    }

    if (deleted > 0) {
      this.env.log("info", `kv: swept ${deleted} legacy/bulky cache keys${moreRemains ? " (more remaining)" : " (clean)"}`);
    }
    if (!moreRemains) {
      this.set(BLOAT_SWEPT_KEY, true, 24 * HOUR_MS);
    }
    return deleted;
  }

  /**
   * Sliding-window rate gate stored in KV so concurrent hosted instances respect upstream limits.
   * Returns true if a request may proceed right now, false if the caller should defer or use cache.
   */
  tryAcquireRateSlot(bucketKey: string, maxInWindow: number, windowMs: number): boolean {
    const now = this.env.now();
    const cooldownUntil = this.getNumber(bucketKey + ":cooldown");
    if (cooldownUntil > now) return false;

    const raw = this.env.kv.get(bucketKey + ":win");
    let stamps: number[] = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          stamps = parsed.filter((t) => typeof t === "number" && now - t < windowMs);
        }
      } catch {
        stamps = [];
      }
    }
    if (stamps.length >= maxInWindow) {
      return false;
    }
    stamps.push(now);
    this.putPersisted(bucketKey + ":win", JSON.stringify(stamps));
    return true;
  }

  /**
   * Strict interval gate (e.g. MusicBrainz <= 1 req/sec). Returns true if the slot was claimed.
   */
  tryAcquireInterval(bucketKey: string, minIntervalMs: number): boolean {
    const now = this.env.now();
    const nextAt = this.getNumber(bucketKey + ":nextAt");
    if (now < nextAt) return false;
    this.putPersisted(bucketKey + ":nextAt", String(now + minIntervalMs));
    return true;
  }

  setCooldown(bucketKey: string, durationMs: number): void {
    this.putPersisted(bucketKey + ":cooldown", String(this.env.now() + durationMs));
  }

  private getNumber(key: string): number {
    try {
      const raw = this.env.kv.get(key);
      if (!raw) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    } catch (err) {
      rethrowHostFault(err);
      return 0;
    }
  }
}

export const HOUR_MS = 60 * 60 * 1000;
export const DAY_MS = 24 * HOUR_MS;
