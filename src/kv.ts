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

export class KVCache {
  private env: HostEnv;
  private mem = new Map<string, { v: unknown; exp: number }>();

  constructor(env: HostEnv) {
    this.env = env;
  }

  get<T>(key: string, options?: { memOnly?: boolean }): T | null {
    const now = this.env.now();
    const hit = this.mem.get(key);
    if (hit) {
      if (hit.exp > now) return hit.v as T;
      this.mem.delete(key);
    }
    if (options?.memOnly) return null;
    try {
      const raw = this.env.kv.get(key);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as CacheEnvelope<T>;
      if (!parsed || typeof parsed.exp !== "number") return null;
      if (parsed.exp <= now) return null;
      this.mem.set(key, parsed);
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
    const payload = JSON.stringify(envObj);
    try {
      this.env.kv.put(key, payload);
    } catch (err) {
      rethrowHostFault(err);
      if (isQuotaError(err)) {
        const evicted = this.evictForSpace(64, key);
        if (evicted > 0) {
          try {
            this.env.kv.put(key, payload);
            this.env.log("info", `kv: reclaimed ${evicted} stale/bulky keys after quota_exceeded`);
            return;
          } catch (retryErr) {
            rethrowHostFault(retryErr);
          }
        }
      }
      // Transient write fault or exhausted quota: keep in-memory cache for this call.
    }
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
    try {
      this.env.kv.put(bucketKey + ":win", JSON.stringify(stamps));
    } catch (err) {
      rethrowHostFault(err);
    }
    return true;
  }

  /**
   * Strict interval gate (e.g. MusicBrainz <= 1 req/sec). Returns true if the slot was claimed.
   */
  tryAcquireInterval(bucketKey: string, minIntervalMs: number): boolean {
    const now = this.env.now();
    const nextAt = this.getNumber(bucketKey + ":nextAt");
    if (now < nextAt) return false;
    try {
      this.env.kv.put(bucketKey + ":nextAt", String(now + minIntervalMs));
    } catch (err) {
      rethrowHostFault(err);
    }
    return true;
  }

  setCooldown(bucketKey: string, durationMs: number): void {
    try {
      this.env.kv.put(bucketKey + ":cooldown", String(this.env.now() + durationMs));
    } catch (err) {
      rethrowHostFault(err);
    }
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
