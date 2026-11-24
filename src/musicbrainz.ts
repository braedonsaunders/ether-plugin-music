import type { HostEnv } from "./types.ts";
import { KVCache, DAY_MS, rethrowHostFault } from "./kv.ts";
import { normalizeText, stripEditionSuffix, textSimilarity } from "./normalize.ts";

const MB_BASE = "https://musicbrainz.org/ws/2";
const CAA_BASE = "https://coverartarchive.org";
const MB_USER_AGENT = "EtherMusic/0.1.0 (https://ether.media)";
const MB_RATE_BUCKET = "rl:musicbrainz";

export interface MBReleaseGroupInfo {
  releaseGroupMbid: string;
  title: string;
  primaryType: string;
  secondaryTypes: string[];
  firstReleaseDate?: string;
  artistMbid?: string;
}

export interface CoverArtUrls {
  front1200?: string;
  front500?: string;
}

/** One official release carrying a recording (MusicBrainz). */
export interface MBRecordingRelease {
  title: string;
  artistName: string;
  year: number;
  primaryType: string;
  secondaryTypes: string[];
  trackCount: number;
}

export class MusicBrainzClient {
  private env: HostEnv;
  private cache: KVCache;

  constructor(env: HostEnv, cache: KVCache) {
    this.env = env;
    this.cache = cache;
  }

  /**
   * Look up a canonical MusicBrainz release-group for (artist, album).
   * Strictly enforces <= 1 req/s via KV interval gate and caches results for 30 days.
   * Never blocks/sleeps; if the 1 req/s slot isn't free right now, returns null cleanly.
   */
  lookupReleaseGroup(artistName: string, albumTitle: string): MBReleaseGroupInfo | null {
    const cleanTitle = stripEditionSuffix(albumTitle);
    const cacheKey = `mb:rg:${normalizeText(artistName)}::${normalizeText(cleanTitle)}`;
    const cached = this.cache.get<MBReleaseGroupInfo | { miss: true }>(cacheKey);
    if (cached !== null) {
      return "miss" in cached ? null : cached;
    }

    if (!this.cache.tryAcquireInterval(MB_RATE_BUCKET, 1100)) {
      return null;
    }

    const esc = (s: string) => s.replace(/["\\]/g, " ").trim();
    const q = `artist:"${esc(artistName)}" AND releasegroup:"${esc(cleanTitle)}"`;
    const url = `${MB_BASE}/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=5`;

    try {
      const resp = this.env.http.fetch({
        method: "GET",
        url,
        headers: {
          "Accept": "application/json",
          "User-Agent": MB_USER_AGENT,
        },
        timeoutMs: 3500,
      });
      if (resp.status === 503 || resp.status === 429) {
        this.cache.setCooldown(MB_RATE_BUCKET, 10_000);
        return null;
      }
      if (resp.status < 200 || resp.status >= 300 || !resp.body) {
        return null;
      }
      const data = JSON.parse(resp.body) as {
        "release-groups"?: Array<{
          id?: string;
          title?: string;
          score?: number;
          "primary-type"?: string;
          "secondary-types"?: string[];
          "first-release-date"?: string;
          "artist-credit"?: Array<{ name?: string; artist?: { id?: string; name?: string } }>;
        }>;
      };
      const list = data?.["release-groups"] || [];
      let best: MBReleaseGroupInfo | null = null;
      let bestScore = 0;

      for (const rg of list) {
        if (!rg.id || !rg.title) continue;
        const tSim = textSimilarity(cleanTitle, stripEditionSuffix(rg.title));
        const acName = rg["artist-credit"]?.map((a) => a.name || a.artist?.name || "").join(" ") || "";
        const aSim = textSimilarity(artistName, acName);
        if (tSim < 0.65 || aSim < 0.55) continue;

        const sec = Array.isArray(rg["secondary-types"]) ? rg["secondary-types"] : [];
        // Prefer canonical studio Album/EP/Single over compilations/remixes when titles tie.
        const studioBonus = sec.length === 0 ? 0.15 : 0;
        const total = tSim * 0.55 + aSim * 0.35 + studioBonus;
        if (total > bestScore) {
          bestScore = total;
          best = {
            releaseGroupMbid: rg.id,
            title: rg.title,
            primaryType: rg["primary-type"] || "Album",
            secondaryTypes: sec,
            firstReleaseDate: rg["first-release-date"] || undefined,
            artistMbid: rg["artist-credit"]?.[0]?.artist?.id || undefined,
          };
        }
      }

      if (best) {
        this.cache.set(cacheKey, best, 30 * DAY_MS);
        return best;
      }
      this.cache.set(cacheKey, { miss: true }, 7 * DAY_MS);
      return null;
    } catch (err) {
      rethrowHostFault(err);
      return null;
    }
  }

  /**
   * Every official release that carries a recording, by its ISRC: the album it came from,
   * singles, EPs, deluxe editions, soundtracks and compilations. Same 1 req/s gate as above;
   * "busy" means the slot was taken (ask again shortly). Cached 30 days (misses 7).
   */
  lookupRecordingReleases(isrc: string): { status: "ok"; releases: MBRecordingRelease[] } | { status: "busy" | "miss" } {
    const code = isrc.trim().toUpperCase();
    const cacheKey = `mb:isrc:${code}`;
    const cached = this.cache.get<MBRecordingRelease[] | { miss: true }>(cacheKey);
    if (cached !== null) {
      return Array.isArray(cached) ? { status: "ok", releases: cached } : { status: "miss" };
    }
    if (!this.cache.tryAcquireInterval(MB_RATE_BUCKET, 1100)) {
      return { status: "busy" };
    }
    try {
      const resp = this.env.http.fetch({
        method: "GET",
        url: `${MB_BASE}/recording?query=${encodeURIComponent(`isrc:${code}`)}&fmt=json&limit=5`,
        headers: { "Accept": "application/json", "User-Agent": MB_USER_AGENT },
        timeoutMs: 3500,
      });
      if (resp.status === 503 || resp.status === 429) {
        this.cache.setCooldown(MB_RATE_BUCKET, 10_000);
        return { status: "busy" };
      }
      if (resp.status < 200 || resp.status >= 300 || !resp.body) {
        return { status: "miss" };
      }
      const data = JSON.parse(resp.body) as {
        recordings?: Array<{
          "artist-credit"?: Array<{ name?: string }>;
          releases?: Array<{
            title?: string;
            date?: string;
            status?: string;
            "track-count"?: number;
            "artist-credit"?: Array<{ name?: string }>;
            "release-group"?: { "primary-type"?: string; "secondary-types"?: string[] };
          }>;
        }>;
      };
      const out: MBRecordingRelease[] = [];
      for (const rec of data.recordings || []) {
        const recArtist = (rec["artist-credit"] || []).map((a) => a.name || "").join(" ").trim();
        for (const rel of rec.releases || []) {
          if (!rel.title || (rel.status && rel.status !== "Official")) continue;
          const rg = rel["release-group"] || {};
          out.push({
            title: rel.title,
            artistName: (rel["artist-credit"] || []).map((a) => a.name || "").join(" ").trim() || recArtist,
            year: Number(String(rel.date || "").slice(0, 4)) || 0,
            primaryType: rg["primary-type"] || "Album",
            secondaryTypes: Array.isArray(rg["secondary-types"]) ? rg["secondary-types"] : [],
            trackCount: Number(rel["track-count"]) || 0,
          });
        }
      }
      if (out.length === 0) {
        this.cache.set(cacheKey, { miss: true }, 7 * DAY_MS);
        return { status: "miss" };
      }
      this.cache.set(cacheKey, out.slice(0, 60), 30 * DAY_MS);
      return { status: "ok", releases: out.slice(0, 60) };
    } catch (err) {
      rethrowHostFault(err);
      return { status: "miss" };
    }
  }

  /**
   * Look up Cover Art Archive front cover thumbnails for a release-group MBID.
   * Cached for 30 days (misses 7 days).
   */
  getCoverArt(releaseGroupMbid: string): CoverArtUrls | null {
    if (!releaseGroupMbid) return null;
    const cacheKey = `caa:rg:${releaseGroupMbid}`;
    const cached = this.cache.get<CoverArtUrls | { miss: true }>(cacheKey);
    if (cached !== null) {
      return "miss" in cached ? null : cached;
    }

    try {
      const resp = this.env.http.fetch({
        method: "GET",
        url: `${CAA_BASE}/release-group/${encodeURIComponent(releaseGroupMbid)}`,
        headers: {
          "Accept": "application/json",
          "User-Agent": MB_USER_AGENT,
        },
        timeoutMs: 3000,
      });
      if (resp.status === 404) {
        this.cache.set(cacheKey, { miss: true }, 7 * DAY_MS);
        return null;
      }
      if (resp.status < 200 || resp.status >= 300 || !resp.body) {
        return null;
      }
      const parsed = JSON.parse(resp.body) as {
        images?: Array<{
          front?: boolean;
          image?: string;
          thumbnails?: Record<string, string>;
        }>;
      };
      const front = (parsed.images || []).find((i) => i.front) || (parsed.images || [])[0];
      if (!front) {
        this.cache.set(cacheKey, { miss: true }, 7 * DAY_MS);
        return null;
      }
      const urls: CoverArtUrls = {
        front1200: front.thumbnails?.["1200"] || front.thumbnails?.large || front.image,
        front500: front.thumbnails?.["500"] || front.thumbnails?.large || front.image,
      };
      this.cache.set(cacheKey, urls, 30 * DAY_MS);
      return urls;
    } catch (err) {
      rethrowHostFault(err);
      return null;
    }
  }
}
