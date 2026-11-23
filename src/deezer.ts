import type { HostEnv } from "./types.ts";
import { KVCache, HOUR_MS, DAY_MS, rethrowHostFault } from "./kv.ts";

const DEEZER_BASE = "https://api.deezer.com";
const USER_AGENT = "EtherMusic/0.2.4 (https://ether.media)";
const RATE_BUCKET = "rl:deezer";

export class RateLimitError extends Error {
  retryAfterSeconds: number;
  constructor(retryAfterSeconds: number, message = "Upstream rate limit reached") {
    super(message);
    this.name = "RateLimitError";
    this.retryAfterSeconds = Math.max(1, Math.min(60, Math.ceil(retryAfterSeconds)));
  }
}

export interface DeezerArtist {
  id: number;
  name: string;
  picture_medium?: string;
  picture_big?: string;
  picture_xl?: string;
  nb_album?: number;
  nb_fan?: number;
}

export interface DeezerAlbumSummary {
  id: number;
  title: string;
  cover_medium?: string;
  cover_big?: string;
  cover_xl?: string;
  genre_id?: number;
  fans?: number;
  release_date?: string;
  record_type?: string;
  explicit_lyrics?: boolean;
  artist?: { id: number; name: string; picture_xl?: string; picture_big?: string };
}

export interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  duration: number;
  rank?: number;
  track_position?: number;
  disk_number?: number;
  explicit_lyrics?: boolean;
  isrc?: string;
  artist?: { id: number; name: string };
  contributors?: Array<{ id: number; name: string; role?: string }>;
  album?: DeezerAlbumSummary;
}

export interface DeezerAlbumDetail extends DeezerAlbumSummary {
  upc?: string;
  label?: string;
  nb_tracks?: number;
  duration?: number;
  genres?: { data?: Array<{ id: number; name: string }> };
  contributors?: Array<{ id: number; name: string; role?: string }>;
  tracks?: { data?: DeezerTrack[] };
}

export class DeezerClient {
  private env: HostEnv;
  private cache: KVCache;
  private strictRateLimit: boolean;

  constructor(env: HostEnv, cache: KVCache, strictRateLimit = false) {
    this.env = env;
    this.cache = cache;
    this.strictRateLimit = strictRateLimit;
  }

  private getJson<T>(path: string, cacheKey: string, ttlMs: number, timeoutMs = 4000): T | null {
    const cached = this.cache.get<T>(cacheKey);
    if (cached !== null) return cached;

    // Respect Deezer's 50 req / 5s public rate limit (stay safely under at 38 / 5s).
    if (!this.cache.tryAcquireRateSlot(RATE_BUCKET, 38, 5000)) {
      const stale = this.cache.getStale<T>(cacheKey);
      if (stale !== null) return stale;
      if (this.strictRateLimit) {
        throw new RateLimitError(5, "Deezer rate window reached; retry shortly");
      }
      return null;
    }

    try {
      const resp = this.env.http.fetch({
        method: "GET",
        url: `${DEEZER_BASE}${path}`,
        headers: {
          "Accept": "application/json",
          "User-Agent": USER_AGENT,
        },
        timeoutMs,
      });

      if (resp.status === 403 || resp.status === 429) {
        this.cache.setCooldown(RATE_BUCKET, 12_000);
        const stale = this.cache.getStale<T>(cacheKey);
        if (stale !== null) return stale;
        if (this.strictRateLimit) {
          throw new RateLimitError(12, `Deezer returned HTTP ${resp.status}`);
        }
        return null;
      }
      if (resp.status < 200 || resp.status >= 300 || !resp.body) {
        return this.cache.getStale<T>(cacheKey);
      }

      const parsed = JSON.parse(resp.body) as any;
      if (parsed && parsed.error) {
        // Deezer quota error code 4 -> cool down cleanly.
        if (parsed.error.code === 4) {
          this.cache.setCooldown(RATE_BUCKET, 8_000);
          const stale = this.cache.getStale<T>(cacheKey);
          if (stale !== null) return stale;
          if (this.strictRateLimit) {
            throw new RateLimitError(8, "Deezer quota limit reached");
          }
        }
        return this.cache.getStale<T>(cacheKey);
      }

      this.cache.set(cacheKey, parsed as T, ttlMs);
      return parsed as T;
    } catch (err) {
      rethrowHostFault(err);
      if (err instanceof RateLimitError) throw err;
      return this.cache.getStale<T>(cacheKey);
    }
  }

  getGlobalChartArtists(limit = 30): DeezerArtist[] {
    const res = this.getJson<{ data?: DeezerArtist[] }>(
      `/chart/0/artists?limit=${limit}`,
      `dz:chart:0:artists:${limit}`,
      6 * HOUR_MS
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getGlobalChartTracks(limit = 30): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/chart/0/tracks?limit=${limit}`,
      `dz:chart:0:tracks:${limit}`,
      6 * HOUR_MS
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getGenreChartTracks(genreId: number, limit = 15): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/chart/${genreId}/tracks?limit=${limit}`,
      `dz:chart:${genreId}:tracks:${limit}`,
      6 * HOUR_MS
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getEditorialSelection(genreId = 0, limit = 15): DeezerAlbumSummary[] {
    const res = this.getJson<{ data?: DeezerAlbumSummary[] }>(
      `/editorial/${genreId}/selection?limit=${limit}`,
      `dz:ed:${genreId}:sel:${limit}`,
      6 * HOUR_MS
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getCachedArtist(artistId: number): DeezerArtist | null {
    return this.cache.get<DeezerArtist>(`dz:artist:${artistId}`);
  }

  getArtist(artistId: number, timeoutMs = 4000): DeezerArtist | null {
    return this.getJson<DeezerArtist>(
      `/artist/${artistId}`,
      `dz:artist:${artistId}`,
      7 * DAY_MS,
      timeoutMs
    );
  }

  getArtistAlbums(artistId: number, limit = 30, timeoutMs = 4000): DeezerAlbumSummary[] {
    const res = this.getJson<{ data?: DeezerAlbumSummary[] }>(
      `/artist/${artistId}/albums?limit=${limit}`,
      `dz:artist:${artistId}:albums:${limit}`,
      2 * DAY_MS,
      timeoutMs
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getArtistAlbumsPage(
    artistId: number,
    index = 0,
    limit = 100,
    timeoutMs = 1150
  ): { data: DeezerAlbumSummary[]; total: number; hasNext: boolean } {
    const safeIdx = Math.max(0, Math.floor(index));
    const safeLim = Math.max(1, Math.min(100, Math.floor(limit)));
    const path = safeIdx > 0
      ? `/artist/${artistId}/albums?index=${safeIdx}&limit=${safeLim}`
      : `/artist/${artistId}/albums?limit=${safeLim}`;
    const res = this.getJson<{ data?: DeezerAlbumSummary[]; total?: number; next?: string }>(
      path,
      `dz:artist:${artistId}:albums:p:${safeIdx}:${safeLim}`,
      2 * DAY_MS,
      timeoutMs
    );
    const data = Array.isArray(res?.data) ? res!.data : [];
    const total = typeof res?.total === "number" ? res.total : safeIdx + data.length;
    const hasNext = Boolean(res?.next) || (data.length >= safeLim && safeIdx + data.length < total);
    return { data, total, hasNext };
  }

  getArtistTopTracks(artistId: number, limit = 10): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/artist/${artistId}/top?limit=${limit}`,
      `dz:artist:${artistId}:top:${limit}`,
      2 * DAY_MS
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getArtistRelated(artistId: number, limit = 10): DeezerArtist[] {
    const res = this.getJson<{ data?: DeezerArtist[] }>(
      `/artist/${artistId}/related?limit=${limit}`,
      `dz:artist:${artistId}:rel:${limit}`,
      7 * DAY_MS
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getAlbum(albumId: number, timeoutMs = 4000): DeezerAlbumDetail | null {
    return this.getJson<DeezerAlbumDetail>(
      `/album/${albumId}`,
      `dz:album:${albumId}`,
      7 * DAY_MS,
      timeoutMs
    );
  }

  /**
   * Fetch /album/{id}/tracks which includes exact disk_number, track_position, duration, and ISRC.
   */
  getAlbumTracks(albumId: number, limit = 100, timeoutMs = 4000): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/album/${albumId}/tracks?limit=${limit}`,
      `dz:album:${albumId}:tracks:${limit}`,
      7 * DAY_MS,
      timeoutMs
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  searchArtists(query: string, limit = 8, timeoutMs = 1500): DeezerArtist[] {
    const q = encodeURIComponent(query.trim());
    if (!q) return [];
    const res = this.getJson<{ data?: DeezerArtist[] }>(
      `/search/artist?q=${q}&limit=${limit}`,
      `dz:search:ar:${query.trim().toLowerCase()}:${limit}`,
      15 * 60 * 1000,
      timeoutMs
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  searchAlbums(query: string, limit = 10, timeoutMs = 1500): DeezerAlbumSummary[] {
    const q = encodeURIComponent(query.trim());
    if (!q) return [];
    const res = this.getJson<{ data?: DeezerAlbumSummary[] }>(
      `/search/album?q=${q}&limit=${limit}`,
      `dz:search:al:${query.trim().toLowerCase()}:${limit}`,
      15 * 60 * 1000,
      timeoutMs
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  searchTracks(query: string, limit = 12, timeoutMs = 1500): DeezerTrack[] {
    const q = encodeURIComponent(query.trim());
    if (!q) return [];
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/search/track?q=${q}&limit=${limit}`,
      `dz:search:tr:${query.trim().toLowerCase()}:${limit}`,
      15 * 60 * 1000,
      timeoutMs
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }
}
