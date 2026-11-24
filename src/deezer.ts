import type { HostEnv } from "./types.ts";
import { KVCache, HOUR_MS, DAY_MS, rethrowHostFault } from "./kv.ts";

const DEEZER_BASE = "https://api.deezer.com";
const USER_AGENT = "EtherMusic/0.2.6 (https://ether.media)";
const RATE_BUCKET = "rl:deezer";

function slimArtist(a: DeezerArtist): DeezerArtist {
  const out: DeezerArtist = { id: a.id, name: a.name };
  if (a.picture_xl) out.picture_xl = a.picture_xl;
  else if (a.picture_big) out.picture_big = a.picture_big;
  if (a.picture_big && a.picture_big !== out.picture_xl) out.picture_big = a.picture_big;
  if (typeof a.nb_album === "number") out.nb_album = a.nb_album;
  if (typeof a.nb_fan === "number") out.nb_fan = a.nb_fan;
  return out;
}

function slimAlbumSummary(al: DeezerAlbumSummary): DeezerAlbumSummary {
  const out: DeezerAlbumSummary = { id: al.id, title: al.title };
  if (al.cover_xl) out.cover_xl = al.cover_xl;
  if (al.cover_big) out.cover_big = al.cover_big;
  if (typeof al.genre_id === "number") out.genre_id = al.genre_id;
  if (typeof al.fans === "number") out.fans = al.fans;
  if (al.release_date) out.release_date = al.release_date;
  if (al.record_type) out.record_type = al.record_type;
  if (al.explicit_lyrics) out.explicit_lyrics = true;
  if (al.artist && al.artist.id) {
    out.artist = {
      id: al.artist.id,
      name: al.artist.name,
      ...(al.artist.picture_xl ? { picture_xl: al.artist.picture_xl } : {}),
      ...(al.artist.picture_big ? { picture_big: al.artist.picture_big } : {}),
    };
  }
  return out;
}

function slimTrack(t: DeezerTrack, includeAlbum = true): DeezerTrack {
  const out: DeezerTrack = {
    id: t.id,
    title: t.title,
    duration: t.duration,
  };
  if (t.title_short && t.title_short !== t.title) out.title_short = t.title_short;
  if (typeof t.rank === "number") out.rank = t.rank;
  if (typeof t.track_position === "number") out.track_position = t.track_position;
  if (typeof t.disk_number === "number") out.disk_number = t.disk_number;
  if (t.explicit_lyrics) out.explicit_lyrics = true;
  if (t.isrc) out.isrc = t.isrc;
  if (t.artist && t.artist.id) out.artist = { id: t.artist.id, name: t.artist.name };
  if (Array.isArray(t.contributors) && t.contributors.length > 0) {
    out.contributors = t.contributors.slice(0, 6).map((c) => ({
      id: c.id,
      name: c.name,
      ...(c.role ? { role: c.role } : {}),
    }));
  }
  if (includeAlbum && t.album && t.album.id) {
    out.album = slimAlbumSummary(t.album);
  }
  return out;
}

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

export interface DeezerPlaylist {
  id: number;
  title: string;
  description?: string;
  nb_tracks?: number;
  fans?: number;
  picture_xl?: string;
  picture_big?: string;
  user?: { name?: string };
  tracks: DeezerTrack[];
}

export interface DeezerTrack {
  id: number;
  title: string;
  title_short?: string;
  /** The version tag, such as " (Live)" or " (2004 Remaster)". */
  title_version?: string;
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

  private getJson<T>(
    path: string,
    cacheKey: string,
    ttlMs: number,
    timeoutMs = 4000,
    options?: { persist?: boolean; compact?: (raw: T) => T }
  ): T | null {
    const memOnly = options?.persist === false;
    const cached = this.cache.get<T>(cacheKey, { memOnly });
    if (cached !== null) return cached;

    // Respect Deezer's 50 req / 5s public rate limit (stay safely under at 38 / 5s).
    if (!this.cache.tryAcquireRateSlot(RATE_BUCKET, 38, 5000)) {
      const stale = this.cache.getStale<T>(cacheKey, { memOnly });
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
        const stale = this.cache.getStale<T>(cacheKey, { memOnly });
        if (stale !== null) return stale;
        if (this.strictRateLimit) {
          throw new RateLimitError(12, `Deezer returned HTTP ${resp.status}`);
        }
        return null;
      }
      if (resp.status < 200 || resp.status >= 300 || !resp.body) {
        return this.cache.getStale<T>(cacheKey, { memOnly });
      }

      const parsed = JSON.parse(resp.body) as any;
      if (parsed && parsed.error) {
        // Deezer quota error code 4 -> cool down cleanly.
        if (parsed.error.code === 4) {
          this.cache.setCooldown(RATE_BUCKET, 8_000);
          const stale = this.cache.getStale<T>(cacheKey, { memOnly });
          if (stale !== null) return stale;
          if (this.strictRateLimit) {
            throw new RateLimitError(8, "Deezer quota limit reached");
          }
        }
        return this.cache.getStale<T>(cacheKey, { memOnly });
      }

      const value = options?.compact ? options.compact(parsed as T) : (parsed as T);
      this.cache.set(cacheKey, value, ttlMs, { persist: options?.persist });
      return value;
    } catch (err) {
      rethrowHostFault(err);
      if (err instanceof RateLimitError) throw err;
      return this.cache.getStale<T>(cacheKey, { memOnly });
    }
  }

  getGlobalChartArtists(limit = 30): DeezerArtist[] {
    const res = this.getJson<{ data?: DeezerArtist[] }>(
      `/chart/0/artists?limit=${limit}`,
      `dz:chart:0:artists:${limit}`,
      6 * HOUR_MS,
      4000,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map(slimArtist) : [] }) }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getGlobalChartTracks(limit = 30): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/chart/0/tracks?limit=${limit}`,
      `dz:chart:0:tracks:${limit}`,
      6 * HOUR_MS,
      4000,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map((t) => slimTrack(t, true)) : [] }) }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getGenreChartTracks(genreId: number, limit = 15): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/chart/${genreId}/tracks?limit=${limit}`,
      `dz:chart:${genreId}:tracks:${limit}`,
      6 * HOUR_MS,
      4000,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map((t) => slimTrack(t, true)) : [] }) }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getEditorialSelection(genreId = 0, limit = 15): DeezerAlbumSummary[] {
    const res = this.getJson<{ data?: DeezerAlbumSummary[] }>(
      `/editorial/${genreId}/selection?limit=${limit}`,
      `dz:ed:${genreId}:sel:${limit}`,
      6 * HOUR_MS,
      4000,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map(slimAlbumSummary) : [] }) }
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
      timeoutMs,
      { compact: slimArtist }
    );
  }

  getArtistAlbums(artistId: number, limit = 30, timeoutMs = 4000): DeezerAlbumSummary[] {
    const res = this.getJson<{ data?: DeezerAlbumSummary[] }>(
      `/artist/${artistId}/albums?limit=${limit}`,
      `dz:artist:${artistId}:albums:${limit}`,
      2 * DAY_MS,
      timeoutMs,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map(slimAlbumSummary) : [] }) }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getArtistAlbumsPage(
    artistId: number,
    index = 0,
    limit = 100,
    timeoutMs = 1150
  ): { data: DeezerAlbumSummary[]; total: number; hasNext: boolean; failed: boolean } {
    const safeIdx = Math.max(0, Math.floor(index));
    const safeLim = Math.max(1, Math.min(100, Math.floor(limit)));
    const path = safeIdx > 0
      ? `/artist/${artistId}/albums?index=${safeIdx}&limit=${safeLim}`
      : `/artist/${artistId}/albums?limit=${safeLim}`;
    // Paginated artist discography responses can exceed 80 KB raw and are already stored
    // in Ether's plugin_items catalog after expand; keep them in-memory only to protect KV quota.
    const res = this.getJson<{ data?: DeezerAlbumSummary[]; total?: number; next?: string }>(
      path,
      `dz:artist:${artistId}:albums:p:${safeIdx}:${safeLim}`,
      10 * 60 * 1000,
      timeoutMs,
      {
        persist: false,
        compact: (r) => ({
          data: Array.isArray(r?.data) ? r.data.map(slimAlbumSummary) : [],
          total: r?.total,
          next: r?.next,
        }),
      }
    );
    const data = Array.isArray(res?.data) ? res!.data : [];
    const total = typeof res?.total === "number" ? res.total : safeIdx + data.length;
    const hasNext = Boolean(res?.next) || (data.length >= safeLim && safeIdx + data.length < total);
    // No answer at all (timeout, rate limit, upstream error) is not "no albums".
    return { data, total, hasNext, failed: res == null };
  }

  getArtistTopTracks(artistId: number, limit = 10): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/artist/${artistId}/top?limit=${limit}`,
      `dz:artist:${artistId}:top:${limit}`,
      2 * DAY_MS,
      4000,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map((t) => slimTrack(t, true)) : [] }) }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getArtistRelated(artistId: number, limit = 10): DeezerArtist[] {
    const res = this.getJson<{ data?: DeezerArtist[] }>(
      `/artist/${artistId}/related?limit=${limit}`,
      `dz:artist:${artistId}:rel:${limit}`,
      7 * DAY_MS,
      4000,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map(slimArtist) : [] }) }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  /** Keyless chart playlists (genre 0: worldwide). */
  getChartPlaylists(genreId = 0, limit = 10): Array<Omit<DeezerPlaylist, "tracks">> {
    const res = this.getJson<{ data?: Array<Omit<DeezerPlaylist, "tracks">> }>(
      `/chart/${genreId}/playlists?limit=${limit}`,
      `dz:chart:${genreId}:playlists:${limit}`,
      6 * HOUR_MS,
      4000,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map((p) => ({ id: p.id, title: p.title, nb_tracks: p.nb_tracks, fans: p.fans, picture_xl: p.picture_xl, picture_big: p.picture_big, user: p.user ? { name: p.user.name } : undefined })) : [] }) }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  /** A public playlist and its first tracks (keyless). */
  getPlaylist(playlistId: number, timeoutMs = 4000): DeezerPlaylist | null {
    const res = this.getJson<any>(
      `/playlist/${playlistId}`,
      `dz:playlist:${playlistId}`,
      6 * HOUR_MS,
      timeoutMs,
      {
        compact: (r) => ({
          id: r?.id, title: r?.title, description: r?.description || "", nb_tracks: r?.nb_tracks, fans: r?.fans,
          picture_xl: r?.picture_xl, picture_big: r?.picture_big, user: r?.creator ? { name: r.creator.name } : undefined,
          tracks: Array.isArray(r?.tracks?.data) ? r.tracks.data.slice(0, 100).map((t: DeezerTrack) => slimTrack(t, true)) : [],
        }),
      }
    );
    return res && res.id ? (res as DeezerPlaylist) : null;
  }

  /** Deezer's keyless artist radio: tracks by the artist and artists like them. */
  getArtistRadio(artistId: number, limit = 40, timeoutMs = 4000): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/artist/${artistId}/radio?limit=${limit}`,
      `dz:artist:${artistId}:radio:${limit}`,
      6 * HOUR_MS,
      timeoutMs,
      { compact: (r) => ({ data: Array.isArray(r?.data) ? r.data.map((t) => slimTrack(t, true)) : [] }) }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  getAlbum(albumId: number, timeoutMs = 4000): DeezerAlbumDetail | null {
    // MusicCatalog caches the compact CanonicalAlbum under album_v2:al-{id}; persisting raw
    // 20 KB Deezer album payloads alongside it would double-cache and exhaust the 50 MiB KV quota.
    return this.getJson<DeezerAlbumDetail>(
      `/album/${albumId}`,
      `dz:album:${albumId}`,
      30 * 60 * 1000,
      timeoutMs,
      { persist: false }
    );
  }

  /**
   * Fetch /album/{id}/tracks which includes exact disk_number, track_position, duration, and ISRC.
   */
  getAlbumTracks(albumId: number, limit = 100, timeoutMs = 4000): DeezerTrack[] {
    const res = this.getJson<{ data?: DeezerTrack[] }>(
      `/album/${albumId}/tracks?limit=${limit}`,
      `dz:album:${albumId}:tracks:${limit}`,
      30 * 60 * 1000,
      timeoutMs,
      { persist: false }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }

  /** One track by its ISRC (keyless); null when Deezer has none. */
  getTrackByIsrc(isrc: string, timeoutMs = 2500): DeezerTrack | null {
    const code = isrc.trim().toUpperCase();
    if (!/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code)) return null;
    const res = this.getJson<any>(`/track/isrc:${code}`, `dz:isrc:${code}`, 7 * 24 * HOUR_MS, timeoutMs, {
      compact: (r) => (r && r.id ? slimTrack(r as DeezerTrack, true) : { miss: true }),
    });
    return res && res.id ? (res as DeezerTrack) : null;
  }

  /** One page of a public playlist's tracks (keyless), for imports. */
  getPlaylistTracksPage(playlistId: number, index: number, limit = 100, timeoutMs = 4000): { tracks: DeezerTrack[]; total: number } {
    const res = this.getJson<any>(`/playlist/${playlistId}/tracks?index=${index}&limit=${limit}`, `dz:playlist:${playlistId}:tracks:${index}:${limit}`, HOUR_MS, timeoutMs, { persist: false });
    return {
      tracks: Array.isArray(res?.data) ? res.data.map((t: DeezerTrack) => slimTrack(t, true)) : [],
      total: Number(res?.total) || 0,
    };
  }

  searchArtists(query: string, limit = 8, timeoutMs = 1500): DeezerArtist[] {
    const q = encodeURIComponent(query.trim());
    if (!q) return [];
    const res = this.getJson<{ data?: DeezerArtist[] }>(
      `/search/artist?q=${q}&limit=${limit}`,
      `dz:search:ar:${query.trim().toLowerCase()}:${limit}`,
      15 * 60 * 1000,
      timeoutMs,
      { persist: false }
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
      timeoutMs,
      { persist: false }
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
      timeoutMs,
      { persist: false }
    );
    return Array.isArray(res?.data) ? res!.data : [];
  }
}
