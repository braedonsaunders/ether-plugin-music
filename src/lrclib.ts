import type { HostEnv, LyricsResult } from "./types.ts";
import { KVCache, DAY_MS, rethrowHostFault } from "./kv.ts";
import { normalizeText, stripFeaturing } from "./normalize.ts";

const LRCLIB_BASE = "https://lrclib.net/api/get";
const USER_AGENT = "EtherMusic/0.1.0 (https://ether.media)";

export interface LyricsQuery {
  artistName: string;
  trackTitle: string;
  albumTitle?: string;
  durationSec?: number;
}

export class LrclibClient {
  private env: HostEnv;
  private cache: KVCache;

  constructor(env: HostEnv, cache: KVCache) {
    this.env = env;
    this.cache = cache;
  }

  getLyrics(q: LyricsQuery): LyricsResult | null {
    const artist = String(q.artistName || "").trim();
    const track = stripFeaturing(String(q.trackTitle || "").trim());
    const album = String(q.albumTitle || "").trim();
    const dur = Math.round(Number(q.durationSec) || 0);
    if (!artist || !track) return null;

    const cacheKey = `lrc:${normalizeText(artist)}::${normalizeText(track)}::${dur}`;
    const cached = this.cache.get<LyricsResult | { miss: true }>(cacheKey);
    if (cached !== null) {
      return "miss" in cached ? null : cached;
    }

    const params: string[] = [
      `artist_name=${encodeURIComponent(artist)}`,
      `track_name=${encodeURIComponent(track)}`,
    ];
    if (album) params.push(`album_name=${encodeURIComponent(album)}`);
    if (dur > 0) params.push(`duration=${dur}`);

    try {
      const resp = this.env.http.fetch({
        method: "GET",
        url: `${LRCLIB_BASE}?${params.join("&")}`,
        headers: {
          "Accept": "application/json",
          "User-Agent": USER_AGENT,
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
      const data = JSON.parse(resp.body) as {
        syncedLyrics?: string | null;
        plainLyrics?: string | null;
        instrumental?: boolean;
      };
      const result: LyricsResult = {
        syncedLyrics: data.syncedLyrics || undefined,
        plainLyrics: data.plainLyrics || undefined,
        instrumental: Boolean(data.instrumental),
        source: "lrclib",
      };
      if (!result.syncedLyrics && !result.plainLyrics && !result.instrumental) {
        this.cache.set(cacheKey, { miss: true }, 7 * DAY_MS);
        return null;
      }
      this.cache.set(cacheKey, result, 30 * DAY_MS);
      return result;
    } catch (err) {
      rethrowHostFault(err);
      return null;
    }
  }
}
