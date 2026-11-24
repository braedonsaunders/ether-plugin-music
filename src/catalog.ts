import type {
  CanonicalAlbum,
  CanonicalTrack,
  HostEnv,
  KindArtRef,
  KindBrowseRequest,
  KindChangePage,
  KindExpandRequest,
  KindExpandResponse,
  KindItem,
  KindPage,
  PluginSettings,
  ReleaseType,
  ImportTrack,
} from "./types.ts";
import { KVCache, HOUR_MS, DAY_MS, rethrowHostFault } from "./kv.ts";
import {
  DeezerClient,
  RateLimitError,
  type DeezerAlbumDetail,
  type DeezerAlbumSummary,
  type DeezerArtist,
  type DeezerTrack,
} from "./deezer.ts";
import { MusicBrainzClient } from "./musicbrainz.ts";
import { GENRE_CHARTS, GENRE_TO_DEEZER_ID, ICONIC_ARTISTS, DECADE_QUERIES } from "./curated.ts";
import {
  CURATED_CONCERTS,
  buildConcertItem,
  getCuratedConcertArtistSeeds,
  getCuratedConcertById,
  getCuratedConcertsForArtist,
  searchCuratedConcerts,
  searchLiveConcerts,
  type CuratedConcert,
} from "./concerts.ts";
import {
  canonicalizeGenre,
  classifyReleaseType,
  computeAlbumOrderIndex,
  decadeOfYear,
  extractFeaturedFromTitle,
  formatCount,
  formatDuration,
  isDerivativeAlbumEdition,
  isReissueEdition,
  isRemixOrBSideEdition,
  isTributeOrNoveltyRelease,
  normalizeText,
  parseReleaseDate,
  popularityToRating,
  stripEditionSuffix,
  stripFeaturing,
  textSimilarity,
} from "./normalize.ts";

interface ArtistSeedEntry {
  deezerId: number;
  name: string;
  pictureXL: string;
  pictureBig: string;
  fans: number;
  nbAlbum: number;
  genres: string[];
  curation: string[];
  chartAlbumIds: number[];
  newReleaseAlbumIds: number[];
  classic: boolean;
  hasConcert?: boolean;
  era: string;
  chartBonus: number;
  latestReleaseSec: number;
  latestYear: number;
}

interface CuratedSeedPlan {
  builtAt: number;
  bucket: string;
  artists: ArtistSeedEntry[];
}

export function artistExternalId(deezerId: number): string {
  return `ar-${deezerId}`;
}

export function albumExternalId(deezerId: number): string {
  return `al-${deezerId}`;
}

export function trackExternalId(deezerId: number): string {
  return `tr-${deezerId}`;
}

export function parseNumericId(extId: string, prefix: string): number {
  if (!extId.startsWith(prefix)) return 0;
  const n = Number(extId.slice(prefix.length));
  return Number.isInteger(n) && n > 0 ? n : 0;
}

function sizeCaps(size: PluginSettings["curatedSize"]): {
  artistLimit: number;
  albumsPerArtist: number;
  genreChartCount: number;
  chartArtistLimit: number;
} {
  switch (size) {
    case "compact":
      return { artistLimit: 76, albumsPerArtist: 2, genreChartCount: 7, chartArtistLimit: 15 };
    case "large":
      return { artistLimit: 140, albumsPerArtist: 5, genreChartCount: GENRE_CHARTS.length, chartArtistLimit: 32 };
    case "standard":
    default:
      return { artistLimit: 105, albumsPerArtist: 3, genreChartCount: 8, chartArtistLimit: 20 };
  }
}

function cleanArtUrl(url?: string): string {
  const s = String(url || "").trim();
  if (!s) return "";
  // Filter Deezer blank avatar/cover placeholders (double-slash hash or MD5 of empty string).
  if (/\/images\/(?:artist|cover)\/\//.test(s)) return "";
  if (s.includes("d41d8cd98f00b204e9800998ecf8427e")) return "";
  return s;
}

function makeArt(xl?: string, big?: string): KindArtRef[] {
  const art: KindArtRef[] = [];
  const cxl = cleanArtUrl(xl);
  const cbig = cleanArtUrl(big);
  const main = cxl || cbig || "";
  const thumb = cbig || cxl || "";
  if (main) {
    art.push({ role: "poster", url: main, width: 1000, height: 1000 });
    art.push({ role: "backdrop", url: main, width: 1000, height: 1000 });
  }
  if (thumb) {
    art.push({ role: "thumb", url: thumb, width: 500, height: 500 });
  }
  return art;
}

function uniqueStrings(list: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const clean = String(s || "").trim();
    if (clean && !seen.has(clean)) {
      seen.add(clean);
      out.push(clean);
    }
  }
  return out;
}

export const BACKFILL_QUEUE_KEY = "backfill:queue:v1";
export const BACKFILL_TRIED_KEY = "backfill:tried:v1";
export const MAX_BACKFILL_QUEUE = 200;
export const ARTIST_ART_KEY = "artist_art_v1:";
/** Editorial playlists the library offers, and how many of each one's songs. */
/** A track's recording identity: the same song on every release that carries it. */
export function recordingOf(isrc?: string): string | undefined {
  const code = (isrc || "").trim().toUpperCase().replace(/-/g, "");
  return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(code) ? `isrc:${code}` : undefined;
}

export const PLAYLIST_PICKS = 10;
/** At most this many tracks are read from one imported link. */
const IMPORT_MAX_TRACKS = 500;
/** One /identify call stops starting new lookups after this long (its deadline is 10 s). */
const IDENTIFY_BUDGET_MS = 6500;

/** A Deezer track as an imported playlist entry. */
function importTrackOf(t: DeezerTrack): ImportTrack {
  return {
    title: t.title || "",
    artist: t.artist?.name || "",
    album: t.album?.title || undefined,
    isrc: t.isrc || undefined,
    durationSec: t.duration || undefined,
  };
}
export const PLAYLIST_MEMBERS = 50;
const PLAYLISTS_BUCKET_KEY = "playlists_bucket";
export const MAX_BACKFILL_TRIED = 400;
const BACKFILL_RETRY_MS = 3 * DAY_MS;
const BACKFILL_QUEUE_TTL_MS = 14 * DAY_MS;

export interface StubBackfillEntry {
  /** artistArt: a curated artist stored without a portrait; one Deezer read fetches it. */
  kind: "artist" | "album" | "artistArt";
  id: string;
  queuedAt: number;
}

function pruneAndCapTried(raw: unknown, nowMs: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  const entries: Array<[string, number]> = [];
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const ts = Number(v);
    if (Number.isFinite(ts) && ts > 0 && nowMs - ts < BACKFILL_RETRY_MS) {
      entries.push([k, ts]);
    }
  }
  if (entries.length > MAX_BACKFILL_TRIED) {
    // Keep the most recently tried entries and evict the oldest to bound KV size.
    entries.sort((a, b) => b[1] - a[1]);
    entries.length = MAX_BACKFILL_TRIED;
  }
  for (const [k, ts] of entries) {
    out[k] = ts;
  }
  return out;
}

const DEEZER_GENRE_ID_TO_NAME: Record<number, string> = {};
for (const [name, id] of Object.entries(GENRE_TO_DEEZER_ID)) {
  DEEZER_GENRE_ID_TO_NAME[id] = name;
}

const RELEASE_TYPE_LABEL: Record<ReleaseType, string> = {
  album: "Album",
  ep: "EP",
  live: "Live album",
  compilation: "Compilation",
  single: "Single",
};

function discographyBaseKey(title: string): string {
  // Normalize title while stripping edition suffixes ("Expanded Edition", "Remastered", "(Live)")
  // so duplicate editions collapse cleanly while distinct Live Trax volumes remain distinct.
  const stripped = stripEditionSuffix(title).replace(/\s*\(\s*live\s*\)\s*$/i, "").trim();
  return normalizeText(stripped) || normalizeText(title);
}

/**
 * Deduplicate an artist's full Deezer discography while preserving ALL genuine studio albums,
 * EPs, live albums, compilations, and non-duplicate singles.
 */
export function deduplicateDiscographyAlbums(
  raw: DeezerAlbumSummary[],
  artistName: string,
  priorKeys?: Set<string>
): DeezerAlbumSummary[] {
  interface RankedSummary {
    album: DeezerAlbumSummary;
    baseKey: string;
    isAlbumLike: boolean;
    isStandard: boolean;
    fans: number;
  }

  const byKey = new Map<string, RankedSummary>();
  const order: string[] = [];

  for (const al of raw) {
    if (!al || !al.id || !al.title) continue;
    if (isTributeOrNoveltyRelease(artistName, al.title)) continue;
    if (isDerivativeAlbumEdition(al.title)) continue;

    const rt = classifyReleaseType(al.record_type, al.title);
    const baseKey = discographyBaseKey(al.title);
    if (!baseKey) continue;
    if (priorKeys && priorKeys.has(baseKey)) continue;

    const cand: RankedSummary = {
      album: al,
      baseKey,
      isAlbumLike: rt !== "single",
      isStandard: !isReissueEdition(al.title),
      fans: al.fans || 0,
    };

    const existing = byKey.get(baseKey);
    if (!existing) {
      byKey.set(baseKey, cand);
      order.push(baseKey);
      continue;
    }

    // 1. Album/EP/Live/Compilation always beats a same-title Single.
    if (cand.isAlbumLike !== existing.isAlbumLike) {
      if (cand.isAlbumLike) byKey.set(baseKey, cand);
      continue;
    }
    // 2. Standard original edition beats a reissue/expanded/deluxe edition unless the reissue
    //    overwhelmingly dominates a near-zero-fan entry.
    if (cand.isStandard !== existing.isStandard) {
      if (cand.isStandard) {
        if (!(existing.fans > cand.fans * 10 && cand.fans < 50)) {
          byKey.set(baseKey, cand);
        }
      } else if (cand.fans > existing.fans * 10 && existing.fans < 50) {
        byKey.set(baseKey, cand);
      }
      continue;
    }
    // 3. Same tier: keep the higher-fan edition.
    if (cand.fans > existing.fans) {
      byKey.set(baseKey, cand);
    }
  }

  return order.map((k) => byKey.get(k)!.album);
}

export class MusicCatalog {
  private env: HostEnv;
  private cache: KVCache;
  private dz: DeezerClient;
  private mb: MusicBrainzClient;
  private settings: PluginSettings;

  constructor(env: HostEnv, cache: KVCache, dz: DeezerClient, mb: MusicBrainzClient, settings: PluginSettings) {
    this.env = env;
    this.cache = cache;
    this.dz = dz;
    this.mb = mb;
    this.settings = settings;
  }

  private currentBucket(): string {
    // 6-hour change bucket matching sync.refresh: "6h"
    // v6: container expand on open (artist/album) + drop upstream nb_album childCount on artists.
    const sixHours = Math.floor(this.env.now() / (6 * HOUR_MS));
    return `v6-${sixHours}`;
  }

  private isRecentRelease(unixSec: number): boolean {
    if (!unixSec) return false;
    const nowSec = Math.floor(this.env.now() / 1000);
    // Releases within the last 365 days qualify for New Releases (with newest sorted first).
    return nowSec - unixSec <= 365 * 86400 && unixSec <= nowSec + 30 * 86400;
  }

  /**
   * Build (or read cached) curated seed plan across global charts, genre charts,
   * editorial picks, iconic classics, and curated video concert artists.
   */
  getCuratedSeed(forceRefresh = false): CuratedSeedPlan {
    const key = `curated:v3:seed:${this.settings.curatedSize}`;
    if (!forceRefresh) {
      const cached = this.cache.get<CuratedSeedPlan>(key);
      if (cached && cached.artists.length > 0) return cached;
    }

    const caps = sizeCaps(this.settings.curatedSize);
    const byId = new Map<number, ArtistSeedEntry>();

    const upsertArtist = (
      id: number,
      name: string,
      opts: Partial<ArtistSeedEntry> & {
        addGenres?: string[];
        addCuration?: string[];
        addChartAlbumId?: number;
        addNewReleaseAlbumId?: number;
      } = {}
    ) => {
      if (!id || !name) return;
      let entry = byId.get(id);
      if (!entry) {
        entry = {
          deezerId: id,
          name,
          pictureXL: opts.pictureXL || "",
          pictureBig: opts.pictureBig || "",
          fans: opts.fans || 0,
          nbAlbum: opts.nbAlbum || 0,
          genres: [],
          curation: [],
          chartAlbumIds: [],
          newReleaseAlbumIds: [],
          classic: Boolean(opts.classic),
          era: opts.era || "2020s",
          chartBonus: opts.chartBonus || 0,
          latestReleaseSec: opts.latestReleaseSec || 0,
          latestYear: opts.latestYear || 0,
        };
        byId.set(id, entry);
      }
      if (opts.pictureXL && !entry.pictureXL) entry.pictureXL = opts.pictureXL;
      if (opts.pictureBig && !entry.pictureBig) entry.pictureBig = opts.pictureBig;
      if ((opts.fans || 0) > entry.fans) entry.fans = opts.fans!;
      if ((opts.nbAlbum || 0) > entry.nbAlbum) entry.nbAlbum = opts.nbAlbum!;
      if (opts.classic) entry.classic = true;
      if (opts.hasConcert) entry.hasConcert = true;
      if (opts.era && entry.era === "2020s") entry.era = opts.era;
      if ((opts.chartBonus || 0) > entry.chartBonus) entry.chartBonus = opts.chartBonus!;
      if ((opts.latestReleaseSec || 0) > entry.latestReleaseSec) {
        entry.latestReleaseSec = opts.latestReleaseSec!;
        if (opts.latestYear) entry.latestYear = opts.latestYear;
      }
      if (opts.addGenres) {
        entry.genres = uniqueStrings([...entry.genres, ...opts.addGenres]);
      }
      if (opts.addCuration) {
        entry.curation = uniqueStrings([...entry.curation, ...opts.addCuration]);
      }
      if (opts.addChartAlbumId && !entry.chartAlbumIds.includes(opts.addChartAlbumId)) {
        entry.chartAlbumIds.push(opts.addChartAlbumId);
      }
      if (opts.addNewReleaseAlbumId && !entry.newReleaseAlbumIds.includes(opts.addNewReleaseAlbumId)) {
        entry.newReleaseAlbumIds.push(opts.addNewReleaseAlbumId);
      }
    };

    // 1. Global trending artists
    const topArtists = this.dz.getGlobalChartArtists(caps.chartArtistLimit);
    for (let i = 0; i < topArtists.length; i++) {
      const a = topArtists[i];
      const bonus = Math.max(0.2, 0.85 - i * 0.025);
      upsertArtist(a.id, a.name, {
        pictureXL: a.picture_xl || "",
        pictureBig: a.picture_big || a.picture_medium || "",
        fans: a.nb_fan || 0,
        nbAlbum: a.nb_album || 0,
        addCuration: ["Trending", "Charting"],
        chartBonus: bonus,
      });
    }

    // 2. Global charting tracks -> extract artists & albums
    const globalTracks = this.dz.getGlobalChartTracks(20);
    for (let i = 0; i < globalTracks.length; i++) {
      const tr = globalTracks[i];
      if (!tr.artist?.id || !tr.artist?.name) continue;
      const bonus = Math.max(0.15, 0.75 - i * 0.03);
      upsertArtist(tr.artist.id, tr.artist.name, {
        addCuration: ["Charting", "Trending", "New Release"],
        addChartAlbumId: tr.album?.id,
        addNewReleaseAlbumId: tr.album?.id,
        chartBonus: bonus,
      });
    }

    // 3. Per-genre charts so every core genre shelf has authentic charting artists & albums
    const genresToFetch = GENRE_CHARTS.slice(0, caps.genreChartCount);
    for (const gc of genresToFetch) {
      const tracks = this.dz.getGenreChartTracks(gc.deezerGenreId, 10);
      for (let i = 0; i < Math.min(tracks.length, 6); i++) {
        const tr = tracks[i];
        if (!tr.artist?.id || !tr.artist?.name) continue;
        upsertArtist(tr.artist.id, tr.artist.name, {
          addGenres: [gc.label],
          addCuration: i < 3 ? ["Charting"] : [],
          addChartAlbumId: tr.album?.id,
          chartBonus: Math.max(0.1, 0.55 - i * 0.06),
        });
      }
    }

    // 4. Editorial picks (fresh highlights)
    const editorial = this.dz.getEditorialSelection(0, 10);
    for (const al of editorial.slice(0, 6)) {
      if (!al.artist?.id || !al.artist?.name) continue;
      upsertArtist(al.artist.id, al.artist.name, {
        pictureXL: al.artist.picture_xl || "",
        pictureBig: al.artist.picture_big || "",
        addCuration: ["New Release", "Charting"],
        addChartAlbumId: al.id,
        addNewReleaseAlbumId: al.id,
        chartBonus: 0.4,
      });
    }

    // 5. Iconic cross-era artists (ensures Classic Albums, Jazz, Electronic, Rock, Hip-Hop, Eras look great)
    for (const ic of ICONIC_ARTISTS) {
      upsertArtist(ic.deezerId, ic.name, {
        addGenres: ic.genres,
        addCuration: ic.classic ? ["Classic"] : [],
        classic: Boolean(ic.classic),
        era: ic.era,
        chartBonus: ic.classic ? 0.35 : 0.25,
      });
    }

    // 5b. Curated video concert artists so every concert in the Concerts tab has its parent Artist synced.
    for (const ca of getCuratedConcertArtistSeeds()) {
      upsertArtist(ca.deezerId, ca.name, {
        addGenres: ca.genres,
        addCuration: ca.classic ? ["Classic"] : [],
        classic: ca.classic,
        hasConcert: true,
        era: ca.era,
        chartBonus: 0.3,
      });
    }

    // Rank & pick a balanced set up to artistLimit, ensuring concert artists + iconic + trending are included.
    const all = Array.from(byId.values());
    // Fill missing portraits / fan counts for top candidates from Deezer /artist/{id}
    all.sort((a, b) => {
      const scoreA = (a.hasConcert ? 55 : 0) + (a.classic ? 40 : 0) + a.chartBonus * 100 + Math.log10(a.fans + 10) * 5;
      const scoreB = (b.hasConcert ? 55 : 0) + (b.classic ? 40 : 0) + b.chartBonus * 100 + Math.log10(b.fans + 10) * 5;
      return scoreB - scoreA;
    });

    const selected = all.slice(0, caps.artistLimit);
    for (const entry of selected) {
      if (entry.genres.length === 0) {
        entry.genres = ["Pop"];
      }
    }

    const plan: CuratedSeedPlan = {
      builtAt: this.env.now(),
      bucket: this.currentBucket(),
      artists: selected,
    };
    this.cache.set(key, plan, 6 * HOUR_MS);
    return plan;
  }

  private enrichArtistSeedEntry(entry: ArtistSeedEntry): ArtistSeedEntry {
    if (entry.pictureXL && entry.fans > 0) return entry;
    const full = this.dz.getArtist(entry.deezerId);
    if (!full) return entry;
    return {
      ...entry,
      name: full.name || entry.name,
      pictureXL: full.picture_xl || full.picture_big || entry.pictureXL,
      pictureBig: full.picture_big || full.picture_medium || entry.pictureBig,
      fans: full.nb_fan || entry.fans,
      nbAlbum: full.nb_album || entry.nbAlbum,
    };
  }

  /** An artist's portrait: the seed's, else one an earlier backfill found. */
  private artistArt(seed: ArtistSeedEntry): KindArtRef[] {
    const own = makeArt(seed.pictureXL, seed.pictureBig);
    if (own.length > 0) return own;
    const found = this.cache.get<{ xl: string; big: string }>(`${ARTIST_ART_KEY}${seed.deezerId}`);
    return found ? makeArt(found.xl, found.big) : own;
  }

  /**
   * Queue curated artists emitted without a portrait for a bounded backfill in changes():
   * one Deezer artist read each, remembered so later refreshes keep the art.
   */
  recordArtlessArtists(items: KindItem[]): void {
    const artless = items.filter((it) => it && it.level === "artist" && (!it.art || it.art.length === 0)).map((it) => it.id);
    if (artless.length === 0) return;
    const nowMs = this.env.now();
    const tried = pruneAndCapTried(this.cache.get<Record<string, number>>(BACKFILL_TRIED_KEY), nowMs);
    const existingRaw = this.cache.get<StubBackfillEntry[]>(BACKFILL_QUEUE_KEY);
    const queue: StubBackfillEntry[] = Array.isArray(existingRaw) ? existingRaw.filter((e) => e && typeof e.id === "string") : [];
    const queued = new Set(queue.filter((e) => e.kind === "artistArt").map((e) => e.id));
    let added = 0;
    for (const id of artless) {
      if (queued.has(id) || tried[`art:${id}`]) continue;
      queued.add(id);
      queue.push({ kind: "artistArt", id, queuedAt: nowMs });
      added++;
    }
    if (added === 0) return;
    const bounded = queue.length > MAX_BACKFILL_QUEUE ? queue.slice(queue.length - MAX_BACKFILL_QUEUE) : queue;
    this.cache.set(BACKFILL_QUEUE_KEY, bounded, BACKFILL_QUEUE_TTL_MS);
  }

  /**
   * Build a canonical artist KindItem.
   */
  buildArtistItem(seed: ArtistSeedEntry): KindItem {
    const id = artistExternalId(seed.deezerId);
    const genres = seed.genres.length > 0 ? seed.genres : ["Pop"];
    const rating = popularityToRating(seed.fans, seed.chartBonus);
    const parts: string[] = [];
    if (genres.length > 0) parts.push(genres.slice(0, 2).join(" / "));
    if (seed.fans > 0) parts.push(`${formatCount(seed.fans)} fans`);

    const released = seed.latestReleaseSec || Math.floor(this.env.now() / 1000) - (seed.classic ? 15 * 365 * 86400 : 120 * 86400);
    const year = seed.latestYear || (seed.era === "2020s" ? 2025 : Number(seed.era.slice(0, 4)) || 2024);

    const fields: Record<string, unknown> = {
      genres,
      decade: seed.era || decadeOfYear(year),
      curation: uniqueStrings(seed.curation),
      artistName: seed.name,
    };
    if (seed.fans > 0) {
      fields.popularity = seed.fans;
    }

    return {
      id,
      level: "artist",
      title: seed.name,
      summary: parts.join(" · ") || "Music artist",
      year,
      released,
      rating,
      art: this.artistArt(seed),
      fields,
      hints: {
        deezerArtistId: seed.deezerId,
        artistName: seed.name,
        chartAlbumIds: seed.chartAlbumIds.slice(0, 6),
        newReleaseAlbumIds: seed.newReleaseAlbumIds.slice(0, 4),
        classic: seed.classic,
      },
      etag: `ar5-${seed.deezerId}-${seed.fans}-${seed.curation.length}`,
    };
  }

  /**
   * Fetch and canonicalize an album (with full tracklist) from Deezer + optional MusicBrainz,
   * caching CanonicalAlbum in KV so Wave 2 (/browse tracks) and /resolve hit KV instantly.
   */
  /** Official releases carrying a recording (MusicBrainz, by ISRC). */
  recordingReleases(isrc: string) {
    return this.mb.lookupRecordingReleases(isrc);
  }

  loadCanonicalAlbum(
    deezerAlbumId: number,
    extra: {
      artistGenres?: string[];
      extraCuration?: string[];
      isClassicArtist?: boolean;
      allowMusicBrainz?: boolean;
      requireTrackDetails?: boolean;
      timeoutMs?: number;
    } = {}
  ): CanonicalAlbum | null {
    const albumId = albumExternalId(deezerAlbumId);
    const metaKey = `album_v2:${albumId}`;
    const existing = this.cache.get<CanonicalAlbum>(metaKey);
    if (existing && existing.tracks.length > 0 && (!extra.requireTrackDetails || existing.tracks.some((t) => Boolean(t.isrc)))) {
      // Merge any newly discovered curation tags without refetching upstream.
      if (extra.extraCuration && extra.extraCuration.length > 0) {
        const merged = uniqueStrings([...existing.curation, ...extra.extraCuration]);
        if (merged.length !== existing.curation.length) {
          existing.curation = merged;
          this.cache.set(metaKey, existing, 7 * DAY_MS);
        }
      }
      return existing;
    }

    const startMs = this.env.now();
    const albumTimeout = extra.timeoutMs && extra.timeoutMs > 0 ? extra.timeoutMs : 4000;
    const detail = this.dz.getAlbum(deezerAlbumId, albumTimeout);
    if (!detail || !detail.title || !detail.artist?.id) return null;

    // Embedded tracks.data avoids a 2nd API call for standard albums (Deezer embeds up to 25);
    // fetch /album/{id}/tracks for larger/multi-disc albums or when exact disc/ISRC is requested.
    const embedded = detail.tracks?.data || [];
    const needTrackEndpoint =
      Boolean(extra.requireTrackDetails) ||
      embedded.length === 0 ||
      (detail.nb_tracks || 0) > 25 ||
      ((detail.nb_tracks || 0) > embedded.length);
    const elapsed = this.env.now() - startMs;
    const trackTimeout = extra.timeoutMs && extra.timeoutMs > 0
      ? Math.max(350, extra.timeoutMs - elapsed)
      : 4000;
    const detailedTracks = needTrackEndpoint ? this.dz.getAlbumTracks(deezerAlbumId, 100, trackTimeout) : [];
    const rawTracks: DeezerTrack[] = detailedTracks.length > 0 ? detailedTracks : embedded;
    if (rawTracks.length === 0) return null;

    const artistId = artistExternalId(detail.artist.id);
    const artistName = detail.artist.name || "Unknown Artist";
    let releaseDate = detail.release_date || "";
    let { year, unixSec } = parseReleaseDate(releaseDate);

    // Optional non-blocking MusicBrainz enrichment (respects <= 1 req/s KV gate).
    let releaseGroupMbid: string | undefined;
    let mbPrimary: string | undefined;
    let mbSecondary: string[] | undefined;
    let coverXL = detail.cover_xl || detail.cover_big || "";
    let coverBig = detail.cover_big || detail.cover_medium || coverXL;

    if (extra.allowMusicBrainz && this.settings.enrichMusicBrainz) {
      const mbInfo = this.mb.lookupReleaseGroup(artistName, detail.title);
      if (mbInfo) {
        releaseGroupMbid = mbInfo.releaseGroupMbid;
        mbPrimary = mbInfo.primaryType;
        mbSecondary = mbInfo.secondaryTypes;
        // Prefer MusicBrainz's original first-release-date when Deezer has a remaster reissue date.
        if (mbInfo.firstReleaseDate) {
          const mbParsed = parseReleaseDate(mbInfo.firstReleaseDate);
          if (mbParsed.year > 0 && (year === 0 || mbParsed.year < year)) {
            year = mbParsed.year;
            releaseDate = mbInfo.firstReleaseDate;
            unixSec = mbParsed.unixSec;
          }
        }
        if (!coverXL) {
          const caa = this.mb.getCoverArt(mbInfo.releaseGroupMbid);
          if (caa?.front1200) coverXL = caa.front1200;
          if (caa?.front500) coverBig = caa.front500;
        }
      }
    }

    const releaseType: ReleaseType = classifyReleaseType(
      detail.record_type,
      detail.title,
      mbPrimary,
      mbSecondary
    );

    // Derive canonical genres from Deezer album genres + artist seed genres.
    const rawGenres: Array<string | null> = [];
    for (const g of detail.genres?.data || []) {
      rawGenres.push(canonicalizeGenre(g.name));
    }
    for (const g of extra.artistGenres || []) {
      rawGenres.push(g);
    }
    const genres = uniqueStrings(rawGenres);
    if (genres.length === 0) genres.push("Pop");

    // Build canonical tracklist with accurate disc and track numbers.
    const tracks: CanonicalTrack[] = [];
    let maxDisc = 1;
    for (let i = 0; i < rawTracks.length; i++) {
      const t = rawTracks[i];
      if (!t || !t.id || !t.title) continue;
      const disc = t.disk_number && t.disk_number > 0 ? t.disk_number : 1;
      if (disc > maxDisc) maxDisc = disc;
      const trackNumber = t.track_position && t.track_position > 0 ? t.track_position : i + 1;
      const featured = uniqueStrings([
        ...extractFeaturedFromTitle(t.title),
        ...(t.contributors || [])
          .filter((c) => c.name && normalizeText(c.name) !== normalizeText(artistName))
          .map((c) => c.name),
      ]);
      tracks.push({
        id: trackExternalId(t.id),
        deezerTrackId: t.id,
        title: t.title,
        disc,
        trackNumber,
        durationSec: Math.max(0, Math.round(t.duration || 0)),
        explicit: Boolean(t.explicit_lyrics),
        isrc: t.isrc || undefined,
        rank: t.rank || undefined,
        artistName: t.artist?.name || artistName,
        featuredArtists: featured.length > 0 ? featured : undefined,
      });
    }

    // Sort tracks cleanly by (disc, trackNumber).
    tracks.sort((a, b) => (a.disc - b.disc) || (a.trackNumber - b.trackNumber));

    const curation: string[] = [...(extra.extraCuration || [])].filter((tag) => {
      // Never tag compilations as "New Release" (e.g. posthumous Legacy greatest-hits packages).
      if (tag === "New Release" && releaseType === "compilation") return false;
      return true;
    });
    if (this.isRecentRelease(unixSec) && (releaseType === "album" || releaseType === "ep")) {
      curation.push("New Release");
    }
    if (
      releaseType === "album" &&
      year > 0 &&
      year <= 2016 &&
      (extra.isClassicArtist || (detail.fans || 0) >= 80_000)
    ) {
      curation.push("Classic");
    }

    const totalDuration =
      detail.duration && detail.duration > 0
        ? detail.duration
        : tracks.reduce((acc, t) => acc + t.durationSec, 0);

    const canonical: CanonicalAlbum = {
      id: albumId,
      deezerAlbumId,
      artistId,
      deezerArtistId: detail.artist.id,
      artistName,
      title: detail.title,
      releaseDate,
      year,
      releaseType,
      genres,
      label: detail.label || "",
      upc: detail.upc || undefined,
      fans: detail.fans || 0,
      durationSec: totalDuration,
      trackCount: tracks.length,
      discCount: maxDisc,
      coverXL,
      coverBig,
      releaseGroupMbid,
      curation: uniqueStrings(curation),
      tracks,
    };

    this.cache.set(metaKey, canonical, 7 * DAY_MS);
    return canonical;
  }

  buildAlbumItem(album: CanonicalAlbum, chartBonus = 0): KindItem {
    const safeIndex = computeAlbumOrderIndex(album);
    const { year, unixSec } = parseReleaseDate(album.releaseDate);
    const effectiveYear = album.year || year;
    const decade = decadeOfYear(effectiveYear);
    const rating = popularityToRating(album.fans, chartBonus + (album.curation.includes("Charting") ? 0.5 : 0));

    const summaryParts: string[] = [];
    summaryParts.push(album.artistName);
    if (effectiveYear > 0) summaryParts.push(String(effectiveYear));
    if (album.genres[0]) summaryParts.push(album.genres[0]);
    summaryParts.push(`${album.trackCount} track${album.trackCount === 1 ? "" : "s"}`);
    if (album.durationSec > 0) summaryParts.push(formatDuration(album.durationSec));
    if (album.label) summaryParts.push(album.label);

    const fields: Record<string, unknown> = {
      genres: album.genres,
      decade,
      curation: album.curation,
      releaseType: album.releaseType,
      popularity: album.fans,
      artistName: album.artistName,
      albumTitle: album.title,
      duration: album.durationSec,
      trackCount: album.trackCount,
      discCount: album.discCount,
    };
    if (album.label) fields.label = album.label;
    if (album.upc) fields.upc = album.upc;
    if (album.releaseGroupMbid) fields.releaseGroupMbid = album.releaseGroupMbid;

    return {
      id: album.id,
      level: "album",
      parentId: album.artistId,
      index: safeIndex,
      title: album.title,
      summary: summaryParts.join(" · "),
      year: effectiveYear || undefined,
      released: unixSec || undefined,
      rating,
      childCount: album.trackCount,
      leafCount: album.trackCount,
      art: makeArt(album.coverXL, album.coverBig),
      fields,
      hints: {
        albumId: album.id,
        deezerAlbumId: album.deezerAlbumId,
        deezerArtistId: album.deezerArtistId,
        artistName: album.artistName,
        albumTitle: album.title,
        year: effectiveYear,
        releaseType: album.releaseType,
        trackCount: album.trackCount,
        discCount: album.discCount,
        upc: album.upc,
        releaseGroupMbid: album.releaseGroupMbid,
      },
      etag: `al4-${album.deezerAlbumId}-${album.trackCount}-${album.curation.length}-${safeIndex}`,
    };
  }

  buildTrackItems(album: CanonicalAlbum): KindItem[] {
    const { year, unixSec } = parseReleaseDate(album.releaseDate);
    const effectiveYear = album.year || year;
    const decade = decadeOfYear(effectiveYear);
    const art = makeArt(album.coverXL, album.coverBig);

    return album.tracks.map((tr, idx) => {
      const rankRating = tr.rank
        ? Math.min(9.9, Math.max(5.5, 5.5 + (Math.min(tr.rank, 1_000_000) / 1_000_000) * 4.2))
        : popularityToRating(album.fans, 0);

      const fields: Record<string, unknown> = {
        genres: album.genres,
        decade,
        releaseType: album.releaseType,
        artistName: tr.artistName || album.artistName,
        albumTitle: album.title,
        disc: tr.disc,
        duration: tr.durationSec,
        explicit: tr.explicit,
        popularity: tr.rank || album.fans,
      };
      if (tr.isrc) fields.isrc = tr.isrc;
      if (tr.featuredArtists && tr.featuredArtists.length > 0) {
        fields.featuredArtists = tr.featuredArtists;
      }

      return {
        id: tr.id,
        level: "track",
        parentId: album.id,
        index: idx + 1,
        title: tr.title,
        summary: `${tr.artistName || album.artistName} · ${album.title} · ${formatDuration(tr.durationSec)}`,
        year: effectiveYear || undefined,
        released: unixSec || undefined,
        rating: Math.round(rankRating * 10) / 10,
        playable: true,
        art,
        fields,
        recording: recordingOf(tr.isrc),
        hints: {
          albumId: album.id,
          deezerAlbumId: album.deezerAlbumId,
          deezerTrackId: tr.deezerTrackId,
          deezerArtistId: album.deezerArtistId,
          artistName: album.artistName,
          trackArtistName: tr.artistName || album.artistName,
          albumTitle: album.title,
          year: effectiveYear,
          releaseType: album.releaseType,
          disc: tr.disc,
          trackNumber: tr.trackNumber,
          trackCount: album.trackCount,
          discCount: album.discCount,
          durationSec: tr.durationSec,
          isrc: tr.isrc,
          upc: album.upc,
        },
        etag: `tr5-${tr.deezerTrackId}-${tr.disc}-${idx + 1}-${tr.durationSec}`,
      };
    });
  }

  /**
   * Choose the best non-duplicate albums for an artist (charting/new releases + highest-fan studio albums).
   */
  selectArtistAlbums(
    deezerArtistId: number,
    seedEntry?: ArtistSeedEntry,
    maxAlbums = 4
  ): Array<{ albumId: number; extraCuration: string[] }> {
    const rawAlbums = this.dz.getArtistAlbums(deezerArtistId, 30);
    const chosen: Array<{ albumId: number; extraCuration: string[] }> = [];
    const seenIds = new Set<number>();
    const seenTitleKeys = new Set<string>();

    const addAlbum = (albumId: number, title: string, extraCuration: string[]) => {
      if (!albumId || seenIds.has(albumId)) return false;
      const tKey = normalizeText(stripEditionSuffix(title));
      if (tKey && seenTitleKeys.has(tKey)) return false;
      seenIds.add(albumId);
      if (tKey) seenTitleKeys.add(tKey);
      chosen.push({ albumId, extraCuration: uniqueStrings(extraCuration) });
      return true;
    };

    const byId = new Map<number, DeezerAlbumSummary>();
    for (const a of rawAlbums) {
      if (a && a.id) byId.set(a.id, a);
    }

    // 1. Seed charting / new-release albums first
    if (seedEntry) {
      for (const cid of seedEntry.chartAlbumIds) {
        if (chosen.length >= maxAlbums) break;
        const known = byId.get(cid);
        const cur: string[] = ["Charting"];
        if (seedEntry.newReleaseAlbumIds.includes(cid)) cur.push("New Release");
        addAlbum(cid, known?.title || String(cid), cur);
      }
    }

    // Filter artist's discography: prefer clean studio albums & EPs over remixes/B-sides/live/compilations/variants
    const studioAlbums = rawAlbums.filter((a) => {
      if (isDerivativeAlbumEdition(a.title) || isRemixOrBSideEdition(a.title)) return false;
      const rt = classifyReleaseType(a.record_type, a.title);
      return rt === "album" || rt === "ep";
    });
    const nonDerivative = rawAlbums.filter(
      (a) => !isDerivativeAlbumEdition(a.title) && !isRemixOrBSideEdition(a.title)
    );
    const pool = studioAlbums.length > 0 ? studioAlbums : nonDerivative.length > 0 ? nonDerivative : rawAlbums;

    // 2. For non-classic artists (or genuinely popular recent studio releases), include newest original album
    const originalByDate = pool
      .filter((a) => !isReissueEdition(a.title) && classifyReleaseType(a.record_type, a.title) === "album")
      .sort((a, b) => {
        const da = parseReleaseDate(a.release_date).unixSec;
        const db = parseReleaseDate(b.release_date).unixSec;
        return db - da;
      });
    const newest = originalByDate[0];
    if (newest && chosen.length < maxAlbums) {
      const { unixSec } = parseReleaseDate(newest.release_date);
      // Avoid putting low-fan vault/archival drops ahead of a classic artist's iconic studio albums.
      const isStrongRecent = this.isRecentRelease(unixSec) && (!seedEntry?.classic || (newest.fans || 0) >= 25_000);
      if (isStrongRecent || !seedEntry?.classic) {
        const cur = this.isRecentRelease(unixSec) ? ["New Release"] : [];
        addAlbum(newest.id, newest.title, cur);
      }
    }

    // 3. Highest-fan studio albums (the artist's essential / classic albums)
    const byFans = [...pool].sort((a, b) => {
      const aIsAlbum = classifyReleaseType(a.record_type, a.title) === "album" ? 1 : 0;
      const bIsAlbum = classifyReleaseType(b.record_type, b.title) === "album" ? 1 : 0;
      if (aIsAlbum !== bIsAlbum) return bIsAlbum - aIsAlbum;
      const aReissue = isReissueEdition(a.title) ? 1 : 0;
      const bReissue = isReissueEdition(b.title) ? 1 : 0;
      // Prefer canonical original release over an equally popular reissue
      const aScore = (a.fans || 0) * (aReissue ? 0.65 : 1);
      const bScore = (b.fans || 0) * (bReissue ? 0.65 : 1);
      return bScore - aScore;
    });
    for (const al of byFans) {
      if (chosen.length >= maxAlbums) break;
      const cur: string[] = [];
      if (seedEntry?.classic) cur.push("Classic");
      addAlbum(al.id, al.title, cur);
    }

    return chosen;
  }

  /**
   * POST /ether/v1/kinds/music/browse
   * Walks artist -> album -> track and artist -> concert cleanly with cursor pagination.
   */
  browse(req: KindBrowseRequest): KindPage {
    if (req.level === "playlist") return this.browsePlaylists(String(req.cursor || ""));
    const level = (req.level || "artist") as "artist" | "album" | "track" | "concert";
    const limit = Math.max(1, Math.min(200, Number(req.limit || 200)));
    const offset = Math.max(0, Number(req.cursor || 0) || 0);
    const caps = sizeCaps(this.settings.curatedSize);

    if (level === "artist") {
      if (offset === 0) {
        this.cache.sweepLegacyBloat(120);
      }
      const seed = this.getCuratedSeed(false);
      // Paginate artist hydration in chunks of <= 18 per page so Wave 0 stays well under Deezer's 50/5s window.
      const pageSize = Math.min(limit, 18);
      const rawSlice = seed.artists.slice(offset, offset + pageSize);
      const enriched: KindItem[] = [];
      let consecutiveMisses = 0;
      for (const entry of rawSlice) {
        if (!entry.pictureXL && consecutiveMisses >= 3) {
          enriched.push(this.buildArtistItem(entry));
          continue;
        }
        const hydrated = this.enrichArtistSeedEntry(entry);
        if (!hydrated.pictureXL) consecutiveMisses++;
        else consecutiveMisses = 0;
        enriched.push(this.buildArtistItem(hydrated));
      }
      this.recordArtlessArtists(enriched);
      const nextCursor = offset + rawSlice.length < seed.artists.length ? String(offset + rawSlice.length) : undefined;
      return { items: enriched, nextCursor, total: seed.artists.length };
    }

    if (level === "album") {
      const deezerArtistId = parseNumericId(String(req.parentId || ""), "ar-");
      if (!deezerArtistId) return { items: [] };
      const seed = this.getCuratedSeed(false);
      const seedEntry = seed.artists.find((a) => a.deezerId === deezerArtistId);
      const chosen = this.selectArtistAlbums(deezerArtistId, seedEntry, caps.albumsPerArtist);

      const albums: KindItem[] = [];
      for (let i = 0; i < chosen.length; i++) {
        const canonical = this.loadCanonicalAlbum(chosen[i].albumId, {
          artistGenres: seedEntry?.genres,
          extraCuration: chosen[i].extraCuration,
          isClassicArtist: seedEntry?.classic,
          // Keep initial bulk sync fast; MusicBrainz enriches on /resolve, /items/:id, and /changes.
          allowMusicBrainz: false,
        });
        if (!canonical) continue;
        // Ensure parentId matches requested artist (for collab/featured albums that credit another primary artist)
        const item = this.buildAlbumItem(canonical, seedEntry?.chartBonus || 0);
        if (canonical.deezerArtistId && canonical.deezerArtistId !== deezerArtistId) {
          this.recordAlbumParentOverrides([[canonical.deezerAlbumId, deezerArtistId]]);
        }
        item.parentId = artistExternalId(deezerArtistId);
        albums.push(item);
      }

      const slice = albums.slice(offset, offset + limit);
      const nextCursor = offset + slice.length < albums.length ? String(offset + slice.length) : undefined;
      return { items: slice, nextCursor, total: albums.length };
    }

    if (level === "track") {
      const deezerAlbumId = parseNumericId(String(req.parentId || ""), "al-");
      if (!deezerAlbumId) return { items: [] };
      const canonical = this.loadCanonicalAlbum(deezerAlbumId, { allowMusicBrainz: false });
      if (!canonical) return { items: [] };
      const tracks = this.buildTrackItems(canonical);
      const slice = tracks.slice(offset, offset + limit);
      const nextCursor = offset + slice.length < tracks.length ? String(offset + slice.length) : undefined;
      return { items: slice, nextCursor, total: tracks.length };
    }

    if (level === "concert") {
      const parentRaw = String(req.parentId || "").trim();
      let list: CuratedConcert[];
      if (parentRaw) {
        const deezerArtistId = parseNumericId(parentRaw, "ar-");
        if (!deezerArtistId) return { items: [] };
        list = getCuratedConcertsForArtist(deezerArtistId);
      } else {
        list = CURATED_CONCERTS;
      }
      const items = list.map((c, idx) => buildConcertItem(c, idx + 1));
      const slice = items.slice(offset, offset + limit);
      const nextCursor = offset + slice.length < items.length ? String(offset + slice.length) : undefined;
      return { items: slice, nextCursor, total: items.length };
    }

    return { items: [] };
  }

  /**
   * Record any stub artists (0 albums in batch) and stub albums (0 tracks in batch)
   * created by live search() or expand() into a small bounded KV queue for later
   * draining in changes(), avoiding O(N) full-library scans.
   */
  recordStubsFromItems(items: KindItem[]): void {
    if (!items || items.length === 0) return;

    const artistsWithAlbums = new Set<string>();
    const albumsWithTracks = new Set<string>();
    const stubAlbums: string[] = [];
    const stubArtists: string[] = [];

    for (const it of items) {
      if (!it || !it.id) continue;
      if (it.level === "album" && it.parentId) artistsWithAlbums.add(it.parentId);
      if (it.level === "track" && it.parentId) albumsWithTracks.add(it.parentId);
    }
    for (const it of items) {
      if (!it || !it.id) continue;
      if (it.level === "album" && !albumsWithTracks.has(it.id)) {
        stubAlbums.push(it.id);
      } else if (it.level === "artist" && !artistsWithAlbums.has(it.id)) {
        stubArtists.push(it.id);
      }
    }
    if (stubAlbums.length === 0 && stubArtists.length === 0) return;

    const nowMs = this.env.now();
    const tried = pruneAndCapTried(this.cache.get<Record<string, number>>(BACKFILL_TRIED_KEY), nowMs);
    const existingRaw = this.cache.get<StubBackfillEntry[]>(BACKFILL_QUEUE_KEY);
    const queue: StubBackfillEntry[] = Array.isArray(existingRaw)
      ? existingRaw.filter((e) => e && (e.kind === "artist" || e.kind === "album" || e.kind === "artistArt") && typeof e.id === "string")
      : [];
    const queuedIds = new Set(queue.map((e) => e.id));

    let added = 0;
    // Queue stub albums ahead of stub artists (cheaper and immediately makes albums playable).
    for (const id of stubAlbums) {
      if (queuedIds.has(id) || tried[id]) continue;
      queuedIds.add(id);
      queue.push({ kind: "album", id, queuedAt: nowMs });
      added++;
    }
    for (const id of stubArtists) {
      if (queuedIds.has(id) || tried[id]) continue;
      queuedIds.add(id);
      queue.push({ kind: "artist", id, queuedAt: nowMs });
      added++;
    }
    if (added === 0) return;

    // Enforce bounded queue cap (drop oldest entries if over limit).
    const bounded = queue.length > MAX_BACKFILL_QUEUE ? queue.slice(queue.length - MAX_BACKFILL_QUEUE) : queue;
    this.cache.set(BACKFILL_QUEUE_KEY, bounded, BACKFILL_QUEUE_TTL_MS);
  }

  /**
   * Drain queued stub artists and stub albums within a strict time budget.
   * Zero-cost instant no-op when the queue is empty; never scans the whole library.
   * Propagates __ETHER_FAULT__ and abort errors instead of swallowing them.
   */
  drainStubBackfill(budgetMs: number): KindItem[] {
    if (!(budgetMs > 1500)) return [];

    const existingRaw = this.cache.get<StubBackfillEntry[]>(BACKFILL_QUEUE_KEY);
    const queue: StubBackfillEntry[] = Array.isArray(existingRaw)
      ? existingRaw.filter((e) => e && (e.kind === "artist" || e.kind === "album" || e.kind === "artistArt") && typeof e.id === "string")
      : [];
    if (queue.length === 0) return [];

    const startMs = this.env.now();
    const left = () => budgetMs - (this.env.now() - startMs);
    const nowMs = this.env.now();
    const tried = pruneAndCapTried(this.cache.get<Record<string, number>>(BACKFILL_TRIED_KEY), nowMs);

    const out: KindItem[] = [];
    const seenOut = new Set<string>();
    const pushOut = (it: KindItem) => {
      if (!it || !it.id || seenOut.has(it.id)) return;
      seenOut.add(it.id);
      out.push(it);
    };

    const remaining: StubBackfillEntry[] = [];
    const deferredAlbums: StubBackfillEntry[] = [];
    let completedAlbums = 0;
    let completedArtists = 0;
    let hitRateLimit = false;

    // Portraits first: one cheap read each, and they are what a viewer sees first.
    queue.sort((a, b) => Number(b.kind === "artistArt") - Number(a.kind === "artistArt"));
    const seedArtists = queue.some((e) => e.kind === "artistArt") ? this.getCuratedSeed(false).artists : [];
    for (let i = 0; i < queue.length; i++) {
      const entry = queue[i];
      if (entry.kind === "artistArt") {
        if (tried[`art:${entry.id}`]) continue;
        if (hitRateLimit || left() < 600) {
          remaining.push(entry);
          continue;
        }
        const deezerId = parseNumericId(entry.id, "ar-");
        const seedEntry = seedArtists.find((a) => a.deezerId === deezerId);
        tried[`art:${entry.id}`] = this.env.now();
        if (!deezerId || !seedEntry) continue;
        try {
          const hydrated = this.enrichArtistSeedEntry(seedEntry);
          const xl = cleanArtUrl(hydrated.pictureXL);
          const big = cleanArtUrl(hydrated.pictureBig);
          if (xl || big) {
            this.cache.set(`${ARTIST_ART_KEY}${deezerId}`, { xl, big }, 30 * DAY_MS);
            pushOut(this.buildArtistItem(hydrated));
            completedArtists++;
          }
        } catch (err) {
          rethrowHostFault(err);
          if (err instanceof RateLimitError) {
            hitRateLimit = true;
            delete tried[`art:${entry.id}`];
            remaining.push(entry);
          }
        }
        continue;
      }
      if (tried[entry.id]) continue;

      const minNeeded = entry.kind === "artist" ? 2500 : 1200;
      if (hitRateLimit || left() < minNeeded) {
        remaining.push(entry);
        continue;
      }

      if (entry.kind === "album") {
        try {
          const tracks = this.browse({ level: "track", parentId: entry.id, limit: 200 }).items || [];
          tried[entry.id] = this.env.now();
          if (tracks.length > 0) {
            const cachedCanonical = this.cache.get<CanonicalAlbum>(`album_v2:${entry.id}`);
            if (cachedCanonical) pushOut(this.buildAlbumItem(cachedCanonical));
            for (const tr of tracks) pushOut(tr);
            completedAlbums++;
          }
        } catch (err) {
          rethrowHostFault(err);
          if (err instanceof RateLimitError) {
            hitRateLimit = true;
            remaining.push(entry);
          } else {
            tried[entry.id] = this.env.now();
            this.env.log("warn", `backfill: failed album ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        continue;
      }

      // entry.kind === "artist"
      try {
        const albums = this.browse({ level: "album", parentId: entry.id, limit: 50 }).items || [];
        const concerts = this.browse({ level: "concert", parentId: entry.id, limit: 20 }).items || [];
        tried[entry.id] = this.env.now();
        for (const co of concerts) pushOut(co);
        for (const alb of albums) {
          pushOut(alb);
          if (left() < 1200) {
            deferredAlbums.push({ kind: "album", id: alb.id, queuedAt: nowMs });
            continue;
          }
          try {
            const tracks = this.browse({ level: "track", parentId: alb.id, limit: 200 }).items || [];
            tried[alb.id] = this.env.now();
            for (const tr of tracks) pushOut(tr);
          } catch (trackErr) {
            rethrowHostFault(trackErr);
            if (trackErr instanceof RateLimitError) {
              hitRateLimit = true;
              deferredAlbums.push({ kind: "album", id: alb.id, queuedAt: nowMs });
            } else {
              tried[alb.id] = this.env.now();
              this.env.log("warn", `backfill: failed tracks for ${alb.id}: ${trackErr instanceof Error ? trackErr.message : String(trackErr)}`);
            }
          }
        }
        if (albums.length > 0 || concerts.length > 0) completedArtists++;
      } catch (err) {
        rethrowHostFault(err);
        if (err instanceof RateLimitError) {
          hitRateLimit = true;
          remaining.push(entry);
        } else {
          tried[entry.id] = this.env.now();
          this.env.log("warn", `backfill: failed artist ${entry.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    const nextQueue = [...deferredAlbums, ...remaining].slice(0, MAX_BACKFILL_QUEUE);
    if (nextQueue.length > 0) {
      this.cache.set(BACKFILL_QUEUE_KEY, nextQueue, BACKFILL_QUEUE_TTL_MS);
    } else {
      this.cache.delete(BACKFILL_QUEUE_KEY);
    }
    this.cache.set(BACKFILL_TRIED_KEY, pruneAndCapTried(tried, this.env.now()), 7 * DAY_MS);

    if (out.length > 0) {
      this.env.log(
        "info",
        `backfill: completed ${completedArtists} artists and ${completedAlbums} albums (${out.length} items, ${nextQueue.length} queued)`
      );
    }
    return out;
  }

  /**
   * POST /ether/v1/kinds/music/changes
   * Incremental 6h chart/new-release refresh with deletes: [] so viewer-searched,
   * expanded, saved, and played items are NEVER wiped out by a full rewalk diff.
   */
  changes(since: string): KindChangePage {
    this.cache.sweepLegacyBloat(120);
    const bucket = this.currentBucket();
    // Initial probe after /browse walk: record baseline cursor without duplicating work.
    if (!since) {
      return { upserts: [], deletes: [], nextCursor: bucket, complete: true };
    }
    if (since === bucket) {
      const sameStart = this.env.now();
      const upserts: KindItem[] = [];
      const seen = new Set<string>();
      this.refreshPlaylists(bucket, 12_000, (it) => {
        if (it?.id && !seen.has(it.id)) {
          seen.add(it.id);
          upserts.push(it);
        }
      });
      for (const it of this.drainStubBackfill(18_000 - (this.env.now() - sameStart))) {
        if (!seen.has(it.id)) upserts.push(it);
      }
      return { upserts, deletes: [], nextCursor: bucket, complete: true };
    }

    // Refresh curated artists, video concerts & top albums cleanly (broader refresh on v6 migration).
    const isMigration = !since.startsWith("v6-");
    const seed = this.getCuratedSeed(true);
    const upserts: KindItem[] = [];
    const seenIds = new Set<string>();
    const pushItem = (it: KindItem) => {
      if (!it || !it.id || seenIds.has(it.id)) return;
      seenIds.add(it.id);
      upserts.push(it);
    };
    const startMs = this.env.now();

    // On v5 migration, re-emit all curated video concert artists + all 82 concerts so an
    // incremental sync immediately refreshes concert artwork & metadata without fullWalk
    // (bounded Deezer artist hydrations so we never trip 429).
    if (isMigration) {
      const concertArtists = seed.artists.filter((a) => a.hasConcert);
      let hydratedCount = 0;
      for (const ar of concertArtists) {
        let current = ar;
        if (!current.pictureXL && hydratedCount < 14 && this.env.now() - startMs < 10000) {
          try {
            current = this.enrichArtistSeedEntry(ar);
            hydratedCount++;
          } catch (err) {
            rethrowHostFault(err);
            // Respect Deezer rate limit gracefully; artist portrait fills on next refresh/browse.
            hydratedCount = 14;
          }
        }
        pushItem(this.buildArtistItem(current));
        const concerts = getCuratedConcertsForArtist(current.deezerId);
        for (let ci = 0; ci < concerts.length; ci++) {
          pushItem(buildConcertItem(concerts[ci], ci + 1));
        }
      }
      // Guarantee every curated concert is emitted even if its artist wasn't in the capped slice.
      for (const c of CURATED_CONCERTS) {
        const cid = `co-${c.slug}`;
        if (!seenIds.has(cid)) {
          pushItem(buildConcertItem(c, 1));
        }
      }
    }

    const maxArtists = isMigration ? Math.min(seed.artists.length, 16) : 20;
    const albumsPerArtist = isMigration ? 1 : 2;
    const refreshedArtists = seed.artists.slice(0, maxArtists);
    for (const ar of refreshedArtists) {
      if (this.env.now() - startMs > 22000) break;
      pushItem(this.buildArtistItem(ar));
      const concerts = getCuratedConcertsForArtist(ar.deezerId);
      for (let ci = 0; ci < concerts.length; ci++) {
        pushItem(buildConcertItem(concerts[ci], ci + 1));
      }
      try {
        const topAlbs = this.selectArtistAlbums(ar.deezerId, ar, albumsPerArtist);
        for (let i = 0; i < topAlbs.length; i++) {
          const canonical = this.loadCanonicalAlbum(topAlbs[i].albumId, {
            artistGenres: ar.genres,
            extraCuration: topAlbs[i].extraCuration,
            isClassicArtist: ar.classic,
            allowMusicBrainz: !isMigration && i === 0,
          });
          if (!canonical) continue;
          const albItem = this.buildAlbumItem(canonical, ar.chartBonus);
          albItem.parentId = artistExternalId(ar.deezerId);
          pushItem(albItem);
          for (const tr of this.buildTrackItems(canonical)) {
            pushItem(tr);
          }
        }
      } catch (err) {
        rethrowHostFault(err);
        // If Deezer rate limit is reached mid-migration, keep all already-collected upserts cleanly.
        break;
      }
    }

    this.refreshPlaylists(bucket, 20_000 - (this.env.now() - startMs), pushItem);
    this.recordArtlessArtists(upserts);
    // Drain any queued stub artists/albums from prior search()/expand() calls within remaining budget.
    const remainingBudget = 26_000 - (this.env.now() - startMs);
    for (const bf of this.drainStubBackfill(remainingBudget)) {
      pushItem(bf);
    }

    return { upserts, deletes: [], nextCursor: bucket, complete: true };
  }

  /**
   * POST /ether/v1/kinds/music/search
   * Live search across Deezer artists, albums, and tracks within interactive budget (~1.6s).
   * Always includes parent artists for matched albums and hydrates top album tracklists
   * so matched albums are immediately playable.
   */
  search(query: string, limit = 40): KindPage {
    const q = String(query || "").trim();
    if (!q) return { items: [] };

    const startMs = this.env.now();
    const wantsNovelty = /\b(?:tribute|karaoke|lullab(?:y|ies)|remix(?:es)?|tabata|8-?bit|salute|cover)\b/i.test(q);
    const out: KindItem[] = [];
    const emittedIds = new Set<string>();
    const artistIdxById = new Map<string, number>();
    const pushUnique = (item: KindItem) => {
      if (!item || !item.id || emittedIds.has(item.id)) return;
      emittedIds.add(item.id);
      if (item.level === "artist") {
        artistIdxById.set(item.id, out.length);
      }
      out.push(item);
    };

    const ensureArtist = (
      ar: { id: number; name: string; picture_xl?: string; picture_big?: string; nb_fan?: number; nb_album?: number },
      hydrateIfSparse = false
    ) => {
      const extId = artistExternalId(ar.id);
      const existingIdx = artistIdxById.get(extId);
      let data = ar;
      if (hydrateIfSparse && !(data.nb_fan && data.nb_fan > 0) && this.env.now() - startMs < 950) {
        const full = this.dz.getArtist(ar.id);
        if (full) {
          data = {
            id: full.id || ar.id,
            name: full.name || ar.name,
            picture_xl: full.picture_xl || ar.picture_xl,
            picture_big: full.picture_big || ar.picture_big,
            nb_fan: full.nb_fan || ar.nb_fan,
            nb_album: full.nb_album || ar.nb_album,
          };
        }
      }
      const built = this.buildArtistItem({
        deezerId: data.id,
        name: data.name,
        pictureXL: data.picture_xl || "",
        pictureBig: data.picture_big || "",
        fans: data.nb_fan || 0,
        nbAlbum: data.nb_album || 0,
        genres: [],
        curation: [],
        chartAlbumIds: [],
        newReleaseAlbumIds: [],
        classic: false,
        era: "2020s",
        chartBonus: 0,
        latestReleaseSec: 0,
        latestYear: 0,
      });
      if (existingIdx !== undefined) {
        // Upgrade sparse artist stub if we now have fan count / artwork.
        if ((data.nb_fan || 0) > 0) {
          out[existingIdx] = built;
        }
        return;
      }
      pushUnique(built);
    };

    // 0. Instant curated concert matches (0ms, zero network calls)
    const matchedCuratedConcerts = searchCuratedConcerts(q, 6);
    for (let ci = 0; ci < matchedCuratedConcerts.length; ci++) {
      const c = matchedCuratedConcerts[ci];
      ensureArtist({ id: c.deezerArtistId, name: c.artistName }, ci === 0);
      pushUnique(buildConcertItem(c, ci + 1));
    }

    // 1. Live search artists and albums within Ether's 2.0s interactive liveSearch budget.
    const rawArtists = this.dz.searchArtists(q, 6, 650);
    // Skip 0-album ghost duplicates and deduplicate by normalized name (keeping highest fan count).
    const artistsByName = new Map<string, (typeof rawArtists)[number]>();
    for (const a of rawArtists) {
      if (!a?.id || !a.name) continue;
      if (typeof a.nb_album === "number" && a.nb_album <= 0) continue;
      if (!wantsNovelty && isTributeOrNoveltyRelease(a.name)) continue;
      const key = normalizeText(a.name);
      const prev = artistsByName.get(key);
      if (!prev || (a.nb_fan || 0) > (prev.nb_fan || 0)) {
        artistsByName.set(key, a);
      }
    }
    const artists = Array.from(artistsByName.values())
      .sort((a, b) => (b.nb_fan || 0) - (a.nb_fan || 0))
      .slice(0, 4);

    const rawAlbums = this.dz.searchAlbums(q, 8, 650);
    // Prioritize canonical full albums over EPs/singles and drop derivative/tribute spam.
    const filteredAlbums = rawAlbums.filter((al) => {
      if (!al?.id || !al.artist?.id) return false;
      if (isDerivativeAlbumEdition(al.title)) return false;
      if (!wantsNovelty && isRemixOrBSideEdition(al.title)) return false;
      if (!wantsNovelty && isTributeOrNoveltyRelease(al.artist.name || "", al.title)) return false;
      return true;
    });
    const studioAlbumMatches = filteredAlbums.filter((al) => {
      const rt = classifyReleaseType(al.record_type, al.title);
      return rt === "album" || rt === "ep";
    });
    const candidateAlbums = studioAlbumMatches.length > 0 ? studioAlbumMatches : filteredAlbums;

    const albumsToHydrate: number[] = [];
    for (const al of candidateAlbums) {
      if (albumsToHydrate.length < 3 && !albumsToHydrate.includes(al.id)) {
        albumsToHydrate.push(al.id);
      }
    }

    // 2. If album search had fewer than 2 hits, pull top studio albums for the #1 matched artist
    if (artists[0] && albumsToHydrate.length < 2 && this.env.now() - startMs < 750) {
      const topArtistAlbums = this.dz.getArtistAlbums(artists[0].id, 8);
      for (const al of topArtistAlbums) {
        if (
          al.id &&
          !isDerivativeAlbumEdition(al.title) &&
          !isRemixOrBSideEdition(al.title) &&
          !albumsToHydrate.includes(al.id) &&
          albumsToHydrate.length < 2
        ) {
          albumsToHydrate.push(al.id);
        }
      }
    }

    // 3. Hydrate top albums + their primary artists & tracks FIRST so real studio releases
    //    (e.g. AC/DC - Back In Black) always have full metadata, rating, and tracks before
    //    any minor artist matches or cover singles.
    const artistGenresSeen = new Map<string, string[]>();
    const hydratedAlbums: CanonicalAlbum[] = [];
    for (let i = 0; i < albumsToHydrate.length; i++) {
      if (this.env.now() - startMs > 1200) break;
      const canonical = this.loadCanonicalAlbum(albumsToHydrate[i], { allowMusicBrainz: false });
      if (!canonical) continue;
      hydratedAlbums.push(canonical);
      // Hydrate the #1 album's artist with real fan count & portrait so e.g. AC/DC ranks authentically.
      ensureArtist({ id: canonical.deezerArtistId, name: canonical.artistName }, i === 0);
      if (canonical.genres.length > 0) {
        const prev = artistGenresSeen.get(canonical.artistId) || [];
        artistGenresSeen.set(canonical.artistId, uniqueStrings([...prev, ...canonical.genres]));
      }
      pushUnique(this.buildAlbumItem(canonical));
      for (const trItem of this.buildTrackItems(canonical)) {
        pushUnique(trItem);
      }
    }

    // Emit matched artists (skipping tiny namesake tribute acts when a famous album dominated the query).
    const maxHydratedAlbumFans = hydratedAlbums.reduce((m, a) => Math.max(m, a.fans || 0), 0);
    const normQuery = normalizeText(q);
    for (const a of artists) {
      const exactTitleCollision =
        !wantsNovelty &&
        maxHydratedAlbumFans >= 50_000 &&
        (a.nb_fan || 0) < 25_000 &&
        hydratedAlbums.some((ha) => normalizeText(ha.title) === normQuery && normalizeText(a.name) === normQuery);
      if (exactTitleCollision) continue;
      ensureArtist(a);
    }

    // Backfill real genres onto searched artists whose genre list defaulted to ["Pop"]
    // and attach any curated video concerts for matched artists.
    const matchedArtistIdsForConcerts: Array<{ deezerArtistId: number; artistName: string; genres: string[] }> = [];
    for (const item of out) {
      if (item.level === "artist") {
        const inferred = artistGenresSeen.get(item.id);
        if (inferred && inferred.length > 0 && item.fields) {
          item.fields.genres = inferred;
          if (typeof item.summary === "string" && item.summary.startsWith("Pop · ")) {
            item.summary = `${inferred.slice(0, 2).join(" / ")} · ${item.summary.slice("Pop · ".length)}`;
          }
        }
        const dzId = parseNumericId(item.id, "ar-");
        if (dzId > 0) {
          const genres = Array.isArray(item.fields?.genres) ? (item.fields!.genres as string[]) : [];
          matchedArtistIdsForConcerts.push({ deezerArtistId: dzId, artistName: item.title, genres });
        }
      }
    }
    for (const ma of matchedArtistIdsForConcerts) {
      const artistConcerts = getCuratedConcertsForArtist(ma.deezerArtistId);
      for (let ci = 0; ci < artistConcerts.length; ci++) {
        pushUnique(buildConcertItem(artistConcerts[ci], ci + 1));
      }
    }

    // Dynamic zero-auth concert film discovery when the query explicitly asks for live/concert
    // footage and curated matches were sparse.
    const looksConcertQuery = /\b(?:concert|live|unplugged|tour|stadium|wembley|pompeii|festival|montreux|basement|show|film)\b/i.test(q);
    if (looksConcertQuery && matchedCuratedConcerts.length < 2 && this.env.now() - startMs < 1300) {
      const topArtist = matchedArtistIdsForConcerts[0];
      if (topArtist) {
        const liveHits = searchLiveConcerts(this.env, this.cache, q, topArtist, 550);
        for (let li = 0; li < liveHits.length; li++) {
          pushUnique(buildConcertItem(liveHits[li], li + 1));
        }
      }
    }

    // 4. Direct track search results (when searching by song title and budget remains)
    if (this.env.now() - startMs < 1200) {
      const tracks = this.dz.searchTracks(q, 6, 550);
      for (const tr of tracks) {
        if (!tr.id || !tr.album?.id || !tr.artist?.id) continue;
        if (!wantsNovelty && isTributeOrNoveltyRelease(tr.artist.name || "", tr.album.title || tr.title)) continue;
        if (!wantsNovelty && (isDerivativeAlbumEdition(tr.album.title || "") || isRemixOrBSideEdition(tr.album.title || ""))) continue;
        const extTrId = trackExternalId(tr.id);
        if (emittedIds.has(extTrId)) continue;
        const extAlbId = albumExternalId(tr.album.id);

        // Prefer cached or freshly hydrated canonical album so bare search stubs NEVER
        // clobber an existing full album record (summary, duration, childCount, year) or
        // pollute the library with 0-track / idx=0 cover singles.
        let canonical = this.cache.get<CanonicalAlbum>(`album_v2:${extAlbId}`);
        if (!canonical && this.env.now() - startMs < 1350) {
          canonical = this.loadCanonicalAlbum(tr.album.id, { allowMusicBrainz: false, timeoutMs: 450 });
        }
        if (canonical) {
          ensureArtist({ id: canonical.deezerArtistId, name: canonical.artistName });
          if (!emittedIds.has(extAlbId)) {
            pushUnique(this.buildAlbumItem(canonical));
          }
          const builtTracks = this.buildTrackItems(canonical);
          const matched = builtTracks.find((t) => t.id === extTrId);
          if (matched) {
            pushUnique(matched);
            continue;
          }
          // Skip emitting an orphaned/duplicate track ID that isn't part of the canonical album tracklist.
          if (builtTracks.some((t) => t.title.toLowerCase() === String(tr.title || "").toLowerCase())) {
            continue;
          }
        } else if (hydratedAlbums.length > 0) {
          // Already returned hydrated canonical albums for this query; don't inject bare cover stubs.
          continue;
        } else {
          ensureArtist({ id: tr.artist.id, name: tr.artist.name });
          if (!emittedIds.has(extAlbId)) {
            const rt = classifyReleaseType(undefined, tr.album.title);
            const fallbackIndex = computeAlbumOrderIndex({ releaseType: rt, title: tr.album.title, fans: 0 });
            pushUnique({
              id: extAlbId,
              level: "album",
              parentId: artistExternalId(tr.artist.id),
              index: fallbackIndex,
              title: tr.album.title,
              summary: tr.artist.name,
              rating: popularityToRating(tr.rank || 0),
              art: makeArt(tr.album.cover_xl, tr.album.cover_big),
              fields: {
                genres: ["Pop"],
                artistName: tr.artist.name,
                albumTitle: tr.album.title,
                releaseType: rt,
              },
              hints: {
                albumId: extAlbId,
                deezerAlbumId: tr.album.id,
                deezerArtistId: tr.artist.id,
                artistName: tr.artist.name,
                albumTitle: tr.album.title,
              },
            });
          }
          pushUnique({
            id: extTrId,
            level: "track",
            parentId: extAlbId,
            index: tr.track_position || 1,
            title: tr.title,
            summary: `${tr.artist.name} · ${tr.album.title} · ${formatDuration(tr.duration)}`,
            rating: tr.rank ? Math.round(Math.min(9.9, Math.max(5.5, 5.5 + (Math.min(tr.rank, 1_000_000) / 1_000_000) * 4.2)) * 10) / 10 : 5.5,
            playable: true,
            art: makeArt(tr.album.cover_xl, tr.album.cover_big),
            fields: {
              genres: ["Pop"],
              artistName: tr.artist.name,
              albumTitle: tr.album.title,
              duration: tr.duration,
              explicit: Boolean(tr.explicit_lyrics),
              disc: tr.disk_number || 1,
            },
            hints: {
              albumId: extAlbId,
              deezerAlbumId: tr.album.id,
              deezerTrackId: tr.id,
              deezerArtistId: tr.artist.id,
              artistName: tr.artist.name,
              albumTitle: tr.album.title,
              durationSec: tr.duration,
              disc: tr.disk_number || 1,
              trackNumber: tr.track_position || 1,
            },
          });
        }
      }
    }

    const capped = limit > 0 ? out.slice(0, Math.max(limit, 80)) : out;
    this.recordStubsFromItems(capped);
    return { items: capped, total: capped.length };
  }

  /**
   * Build a lightweight album KindItem directly from a Deezer /artist/{id}/albums summary
   * (zero extra HTTP calls). Tracks & full metadata hydrate on demand when the viewer opens the album.
   */
  buildAlbumSummaryItem(
    al: DeezerAlbumSummary,
    artist: { deezerId: number; name: string; genres: string[]; classic?: boolean; chartBonus?: number }
  ): KindItem {
    const albumId = albumExternalId(al.id);
    const releaseType = classifyReleaseType(al.record_type, al.title);
    const { year, unixSec } = parseReleaseDate(al.release_date);
    const decade = decadeOfYear(year);
    const safeIndex = computeAlbumOrderIndex({ releaseType, title: al.title, fans: al.fans || 0 });
    const rating = popularityToRating(al.fans || 0, artist.chartBonus || 0);

    const mappedGenre = al.genre_id ? DEEZER_GENRE_ID_TO_NAME[al.genre_id] : undefined;
    const genres = uniqueStrings([mappedGenre, ...artist.genres]);
    if (genres.length === 0) genres.push("Pop");

    const curation: string[] = [];
    if (this.isRecentRelease(unixSec) && (releaseType === "album" || releaseType === "ep")) {
      curation.push("New Release");
    }
    if (releaseType === "album" && year > 0 && year <= 2016 && (artist.classic || (al.fans || 0) >= 80_000)) {
      curation.push("Classic");
    }

    const summaryParts: string[] = [artist.name];
    if (year > 0) summaryParts.push(String(year));
    if (releaseType !== "album") {
      summaryParts.push(RELEASE_TYPE_LABEL[releaseType]);
    } else if (genres[0]) {
      summaryParts.push(genres[0]);
    }

    const coverXL = al.cover_xl || al.cover_big || "";
    const coverBig = al.cover_big || al.cover_medium || coverXL;

    const fields: Record<string, unknown> = {
      genres,
      decade,
      curation,
      releaseType,
      popularity: al.fans || 0,
      artistName: artist.name,
      albumTitle: al.title,
    };
    if (al.explicit_lyrics) fields.explicit = true;

    return {
      id: albumId,
      level: "album",
      parentId: artistExternalId(artist.deezerId),
      index: safeIndex,
      title: al.title,
      summary: summaryParts.join(" · "),
      year: year || undefined,
      released: unixSec || undefined,
      rating,
      art: makeArt(coverXL, coverBig),
      fields,
      hints: {
        albumId,
        deezerAlbumId: al.id,
        deezerArtistId: artist.deezerId,
        artistName: artist.name,
        albumTitle: al.title,
        year,
        releaseType,
        hydrated: false,
      },
      etag: `al4s-${al.id}-${al.fans || 0}-${safeIndex}`,
    };
  }

  /**
   * On-demand Artist container expansion: fetches the artist's full discography
   * (1 Deezer call for up to 100 releases on page 1, well inside Ether's 1.8s firstOpenWait)
   * plus curated concerts, paginating mega-discographies (>100 releases) via cursor.
   */
  private expandArtist(parentId: string, cursor?: string): KindExpandResponse {
    const startMs = this.env.now();
    const deezerArtistId = parseNumericId(parentId, "ar-");
    if (!deezerArtistId) return { items: [], cursor: "" };

    const offset = Math.max(0, Number(cursor || 0) || 0);
    if (offset >= 400) return { items: [], cursor: "" };

    const page = this.dz.getArtistAlbumsPage(deezerArtistId, offset, 100, offset === 0 ? 1150 : 4000);
    const seed = this.cache.get<CuratedSeedPlan>("curated:seed:v2");
    const seedEntry = seed?.artists.find((a) => a.deezerId === deezerArtistId);

    // Resolve artist metadata from KV cache first; only make an extra HTTP call on page 1 if budget allows.
    let dzArtist = this.dz.getCachedArtist(deezerArtistId);
    if (!dzArtist && !seedEntry && offset === 0 && this.env.now() - startMs < 750) {
      dzArtist = this.dz.getArtist(deezerArtistId, 450);
    }

    // Only a real name refreshes the stored artist: a placeholder would overwrite the name a
    // playlist, search or chart already stored when Deezer's artist lookup misses its budget.
    const knownName = dzArtist?.name || seedEntry?.name || page.data.find((a) => a.artist?.name)?.artist?.name || "";
    const artistName = knownName || `Artist ${deezerArtistId}`;

    // Infer canonical genres from seed + discography genre_ids.
    const inferredGenres: string[] = [...(seedEntry?.genres || [])];
    for (const al of page.data) {
      if (al.genre_id && DEEZER_GENRE_ID_TO_NAME[al.genre_id]) {
        inferredGenres.push(DEEZER_GENRE_ID_TO_NAME[al.genre_id]);
      }
    }
    const genres = uniqueStrings(inferredGenres);
    if (genres.length === 0) genres.push("Pop");

    // Track base keys across pages for mega-discography artists (>100 releases).
    const seenKeysCacheKey = `exp:artist:keys:${deezerArtistId}`;
    const priorList = offset > 0 ? this.cache.get<string[]>(seenKeysCacheKey) || [] : [];
    const priorKeys = new Set<string>(priorList);
    const deduped = deduplicateDiscographyAlbums(page.data, artistName, priorKeys);

    const items: KindItem[] = [];
    const seenIds = new Set<string>();
    const add = (it: KindItem) => {
      if (it && it.id && !seenIds.has(it.id)) {
        seenIds.add(it.id);
        items.push(it);
      }
    };

    // On page 1, include the refreshed artist container metadata + curated video concerts.
    if (offset === 0) {
      let latestSec = seedEntry?.latestReleaseSec || 0;
      let latestYear = seedEntry?.latestYear || 0;
      for (const al of deduped) {
        const parsed = parseReleaseDate(al.release_date);
        if (parsed.unixSec > latestSec) {
          latestSec = parsed.unixSec;
          latestYear = parsed.year;
        }
      }
      if (seedEntry) {
        add(
          this.buildArtistItem({
            ...seedEntry,
            name: dzArtist?.name || seedEntry.name,
            pictureXL: dzArtist?.picture_xl || seedEntry.pictureXL,
            pictureBig: dzArtist?.picture_big || seedEntry.pictureBig,
            fans: dzArtist?.nb_fan || seedEntry.fans,
            genres,
            latestReleaseSec: latestSec || seedEntry.latestReleaseSec,
            latestYear: latestYear || seedEntry.latestYear,
          })
        );
      } else if (knownName) {
        add(
          this.buildArtistItem({
            deezerId: deezerArtistId,
            name: artistName,
            pictureXL: dzArtist?.picture_xl || "",
            pictureBig: dzArtist?.picture_big || dzArtist?.picture_medium || "",
            fans: dzArtist?.nb_fan || 0,
            nbAlbum: 0,
            genres,
            curation: [],
            chartAlbumIds: [],
            newReleaseAlbumIds: [],
            classic: false,
            era: decadeOfYear(latestYear || 2024),
            chartBonus: 0,
            latestReleaseSec: latestSec,
            latestYear,
          })
        );
      }

      const concerts = getCuratedConcertsForArtist(deezerArtistId);
      for (let ci = 0; ci < concerts.length; ci++) {
        add(buildConcertItem(concerts[ci], ci + 1));
      }
    }

    for (const al of deduped) {
      priorKeys.add(discographyBaseKey(al.title));
      // Preserve full hydrated metadata if this album was already expanded earlier.
      const cachedFull = this.cache.get<CanonicalAlbum>(`album_v2:${albumExternalId(al.id)}`);
      if (cachedFull && cachedFull.tracks.length > 0) {
        const fullItem = this.buildAlbumItem(cachedFull, seedEntry?.chartBonus || 0);
        fullItem.parentId = artistExternalId(deezerArtistId);
        add(fullItem);
      } else {
        add(
          this.buildAlbumSummaryItem(al, {
            deezerId: deezerArtistId,
            name: artistName,
            genres,
            classic: seedEntry?.classic,
            chartBonus: seedEntry?.chartBonus,
          })
        );
      }
    }

    // Record expanded album -> artist parent overrides in one bounded KV map so clicking
    // a collab/split album from an artist page never re-parents it away from that artist.
    if (deduped.length > 0) {
      const overrides: Array<[number, number]> = [];
      for (const al of deduped) {
        if (al.artist?.id && al.artist.id === deezerArtistId) continue;
        overrides.push([al.id, deezerArtistId]);
      }
      this.recordAlbumParentOverrides(overrides);
    }

    const nextOffset = offset + 100;
    const hasMore = page.hasNext && nextOffset < 400 && page.data.length > 0;
    if (hasMore) {
      this.cache.set(seenKeysCacheKey, Array.from(priorKeys), 10 * 60 * 1000);
    } else if (offset > 0) {
      this.cache.delete(seenKeysCacheKey);
    }

    return {
      items,
      cursor: hasMore ? String(nextOffset) : "",
    };
  }

  private recordAlbumParentOverrides(pairs: Array<[number, number]>): void {
    if (!pairs.length) return;
    const parentMap = this.cache.get<Record<string, number>>("exp:alb_parent:v1") || {};
    let changed = false;
    for (const [albumId, artistId] of pairs) {
      if (!albumId || !artistId) continue;
      const key = String(albumId);
      if (parentMap[key] !== artistId) {
        parentMap[key] = artistId;
        changed = true;
      }
    }
    if (!changed) return;
    const keys = Object.keys(parentMap);
    if (keys.length > 500) {
      for (const oldKey of keys.slice(0, keys.length - 500)) {
        delete parentMap[oldKey];
      }
    }
    this.cache.set("exp:alb_parent:v1", parentMap, 7 * DAY_MS);
  }

  /**
   * On-demand Album container expansion: fetches the album's full metadata and complete
   * tracklist in 1 Deezer call (2 for 26+ track / multi-disc albums), well inside 1.8s.
   */
  private expandAlbum(parentId: string, cursor?: string): KindExpandResponse {
    if (cursor) return { items: [], cursor: "" };
    const deezerAlbumId = parseNumericId(parentId, "al-");
    if (!deezerAlbumId) return { items: [], cursor: "" };

    const canonical = this.loadCanonicalAlbum(deezerAlbumId, {
      allowMusicBrainz: false,
      requireTrackDetails: false,
      timeoutMs: 1150,
    });
    if (!canonical) return { items: [], cursor: "" };

    const albumItem = this.buildAlbumItem(canonical);
    const parentMap = this.cache.get<Record<string, number>>("exp:alb_parent:v1");
    const preferredArtistId = parentMap?.[String(deezerAlbumId)];
    if (preferredArtistId && preferredArtistId > 0) {
      albumItem.parentId = artistExternalId(preferredArtistId);
    }
    const trackItems = this.buildTrackItems(canonical);
    return {
      items: [albumItem, ...trackItems],
      cursor: "",
    };
  }

  /**
   * POST /ether/v1/kinds/music/expand
   * On-demand expansion for:
   * 1. Containers (artist -> full discography + concerts, album -> full metadata + tracks)
   * 2. Facets (Genre, Era/Decade, Featured Artist)
   */
  expand(req: KindExpandRequest): KindExpandResponse {
    const parentId = String(req.parentId || "").trim();
    const level = String(req.level || "").trim();
    const cursor = req.cursor ? String(req.cursor).trim() : "";

    if (parentId) {
      if (level === "artist" || (!level && parentId.startsWith("ar-"))) {
        return this.expandArtist(parentId, cursor);
      }
      if (level === "album" || (!level && parentId.startsWith("al-"))) {
        return this.expandAlbum(parentId, cursor);
      }
      return { items: [], cursor: "" };
    }

    const facet = String(req.facet || "").trim();
    const value = String(req.value || "").trim();
    const pageIdx = Math.max(0, Number(cursor || 0) || 0);
    if (!facet || !value) return { items: [] };
    if (pageIdx > 0) return { items: [] };

    const items: KindItem[] = [];
    const seen = new Set<string>();
    const add = (it: KindItem) => {
      if (!seen.has(it.id)) {
        seen.add(it.id);
        items.push(it);
      }
    };

    if (facet === "genres") {
      const genreId = GENRE_TO_DEEZER_ID[value];
      const tracks = genreId ? this.dz.getGenreChartTracks(genreId, 20) : this.dz.searchTracks(value, 15, 2500);
      const artistAlbums = new Map<number, { name: string; albumIds: number[] }>();
      for (const tr of tracks) {
        if (!tr.artist?.id || !tr.album?.id) continue;
        let rec = artistAlbums.get(tr.artist.id);
        if (!rec) {
          rec = { name: tr.artist.name, albumIds: [] };
          artistAlbums.set(tr.artist.id, rec);
        }
        if (!rec.albumIds.includes(tr.album.id) && rec.albumIds.length < 2) {
          rec.albumIds.push(tr.album.id);
        }
      }
      let count = 0;
      for (const [aid, info] of artistAlbums.entries()) {
        if (count >= 12) break;
        const fullArtist = this.dz.getArtist(aid);
        add(
          this.buildArtistItem({
            deezerId: aid,
            name: fullArtist?.name || info.name,
            pictureXL: fullArtist?.picture_xl || "",
            pictureBig: fullArtist?.picture_big || "",
            fans: fullArtist?.nb_fan || 0,
            nbAlbum: fullArtist?.nb_album || 0,
            genres: [value],
            curation: [],
            chartAlbumIds: info.albumIds,
            newReleaseAlbumIds: [],
            classic: false,
            era: "2020s",
            chartBonus: 0.3,
            latestReleaseSec: 0,
            latestYear: 0,
          })
        );
        for (const alId of info.albumIds) {
          const canonical = this.loadCanonicalAlbum(alId, { artistGenres: [value], allowMusicBrainz: false });
          if (!canonical) continue;
          const albItem = this.buildAlbumItem(canonical);
          albItem.parentId = artistExternalId(aid);
          add(albItem);
          for (const trItem of this.buildTrackItems(canonical)) add(trItem);
        }
        count++;
      }
      this.recordStubsFromItems(items);
      return { items };
    }

    if (facet === "decade") {
      const queries = DECADE_QUERIES[value] || [value];
      for (const q of queries.slice(0, 4)) {
        const found = this.search(q, 25);
        for (const it of found.items) add(it);
      }
      this.recordStubsFromItems(items);
      return { items };
    }

    if (facet === "featuredArtists") {
      const found = this.search(value, 30);
      for (const it of found.items) add(it);
      this.recordStubsFromItems(items);
      return { items };
    }

    return { items };
  }

  /** The Deezer artist a stored item belongs to (an artist, an album or a track). */
  private seedArtistId(item: { id?: string; level?: string; hints?: Record<string, unknown> }): number {
    const id = String(item?.id || "");
    if (id.startsWith("ar-")) return parseNumericId(id, "ar-");
    const hinted = Number(item?.hints?.deezerArtistId || 0);
    return Number.isInteger(hinted) && hinted > 0 ? hinted : 0;
  }

  /** A minimal artist item, or the curated one when the artist is curated. */
  private artistItemFor(deezerId: number, name: string): KindItem {
    const curated = this.getCuratedSeed(false).artists.find((a) => a.deezerId === deezerId);
    if (curated) return this.buildArtistItem(curated);
    const cached = this.dz.getCachedArtist(deezerId);
    return this.buildArtistItem({
      deezerId,
      name: cached?.name || name,
      pictureXL: cached?.picture_xl || "",
      pictureBig: cached?.picture_big || cached?.picture_medium || "",
      fans: cached?.nb_fan || 0,
      nbAlbum: 0,
      genres: [],
      curation: [],
      chartAlbumIds: [],
      newReleaseAlbumIds: [],
      classic: false,
      era: "2020s",
      chartBonus: 0,
      latestReleaseSec: 0,
      latestYear: 0,
    });
  }

  /** The editorial playlists the library offers: Deezer's worldwide chart playlists. */
  private playlistPicks(): Array<{ id: number }> {
    return this.dz.getChartPlaylists(0, PLAYLIST_PICKS).filter((p) => p && p.id);
  }

  /** A playlist's tracks as stored items: the canonical album and its tracks when cached, else
   * the album and track as the playlist describes them (the album is filled in when opened). */
  private playlistTrackItems(tr: DeezerTrack, artists: Set<number>, albums: Set<number>, out: KindItem[]): string | null {
    const albumId = tr.album?.id;
    const artistId = tr.artist?.id;
    if (!tr.id || !albumId || !artistId) return null;
    const canonical = this.cache.get<CanonicalAlbum>(`album_v2:${albumExternalId(albumId)}`);
    const parentArtist = canonical?.deezerArtistId || artistId;
    if (!artists.has(parentArtist)) {
      artists.add(parentArtist);
      out.push(this.artistItemFor(parentArtist, canonical?.artistName || tr.artist?.name || ""));
    }
    if (canonical && canonical.tracks.some((t) => t.id === trackExternalId(tr.id))) {
      if (!albums.has(albumId)) {
        albums.add(albumId);
        out.push(this.buildAlbumItem(canonical), ...this.buildTrackItems(canonical));
      }
      return trackExternalId(tr.id);
    }
    if (!albums.has(albumId)) {
      albums.add(albumId);
      const art = makeArt(tr.album?.cover_xl, tr.album?.cover_big);
      out.push({
        id: albumExternalId(albumId),
        level: "album",
        parentId: artistExternalId(parentArtist),
        title: tr.album?.title || tr.title,
        art,
        fields: { artistName: tr.artist?.name || "", albumTitle: tr.album?.title || "" },
        hints: { albumId: albumExternalId(albumId), deezerAlbumId: albumId, deezerArtistId: parentArtist, artistName: tr.artist?.name || "", albumTitle: tr.album?.title || "" },
      });
    }
    out.push({
      id: trackExternalId(tr.id),
      level: "track",
      parentId: albumExternalId(albumId),
      title: tr.title,
      playable: true,
      art: makeArt(tr.album?.cover_xl, tr.album?.cover_big),
      fields: { artistName: tr.artist?.name || "", albumTitle: tr.album?.title || "", duration: tr.duration, explicit: Boolean(tr.explicit_lyrics) },
      recording: recordingOf(tr.isrc),
      hints: {
        albumId: albumExternalId(albumId), deezerAlbumId: albumId, deezerTrackId: tr.id, deezerArtistId: parentArtist,
        artistName: tr.album ? tr.artist?.name || "" : "", trackArtistName: tr.artist?.name || "", albumTitle: tr.album?.title || "",
        durationSec: tr.duration, isrc: tr.isrc,
      },
    });
    return trackExternalId(tr.id);
  }

  /**
   * Browse the playlist level: one editorial playlist per page, its tracks first (with the albums
   * and artists they need) and the playlist with its members last. Cursor: the playlist's place.
   */
  private browsePlaylists(cursor: string): KindPage {
    const picks = this.playlistPicks();
    const at = Math.max(0, Number(cursor || 0) || 0);
    const pick = picks[at];
    if (!pick) return { items: [] };
    const next = at + 1 < picks.length ? String(at + 1) : undefined;
    return { items: this.playlistItems(pick.id), nextCursor: next };
  }

  /** One chart playlist as stored items: its tracks (with their albums and artists) first,
   * then the playlist itself listing them as members. */
  private playlistItems(id: number): KindItem[] {
    const playlist = this.dz.getPlaylist(id, 4000);
    if (!playlist || playlist.tracks.length === 0) return [];
    const out: KindItem[] = [];
    const members: string[] = [];
    const artists = new Set<number>();
    const albums = new Set<number>();
    for (const tr of playlist.tracks.slice(0, PLAYLIST_MEMBERS)) {
      const id = this.playlistTrackItems(tr, artists, albums, out);
      if (id && !members.includes(id)) members.push(id);
    }
    const by = playlist.user?.name ? playlist.user.name.replace(/\s*-\s*Deezer\s+/i, " · ") : "";
    out.push({
      id: `pl-${playlist.id}`,
      level: "playlist",
      title: playlist.title,
      summary: [playlist.description, by].filter(Boolean).join(" · ") || `${members.length} songs`,
      rating: popularityToRating(playlist.fans || 0, 0),
      art: makeArt(playlist.picture_xl, playlist.picture_big),
      childCount: members.length,
      leafCount: members.length,
      fields: { curation: ["Editorial Playlist"], popularity: playlist.fans || 0 },
      members,
    } as KindItem);
    return out;
  }

  /** Chart playlists once per change bucket (charts move; a plugin upgrade mid-bucket still
   * brings them in without a full walk), within the time left of this /changes call. */
  private refreshPlaylists(bucket: string, budgetMs: number, push: (it: KindItem) => void): void {
    if (budgetMs <= 0 || this.cache.get<string>(PLAYLISTS_BUCKET_KEY) === bucket) return;
    const startMs = this.env.now();
    try {
      for (const pick of this.playlistPicks()) {
        if (this.env.now() - startMs > budgetMs) return;
        for (const it of this.playlistItems(pick.id)) push(it);
      }
    } catch (err) {
      rethrowHostFault(err);
      return;
    }
    this.cache.set(PLAYLISTS_BUCKET_KEY, bucket, 12 * HOUR_MS);
  }

  /**
   * POST /ether/v1/kinds/music/import
   * A Deezer playlist or album link (keyless API, with ISRCs) or a Spotify playlist or album link
   * (its public embed page: titles, artists and durations) as a track list. 404 for anything else.
   */
  importLink(url: string): { status: number; body?: unknown } {
    const link = String(url || "").trim();
    const dz = link.match(/^https?:\/\/(?:www\.)?deezer\.com\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album)\/(\d+)/i);
    if (dz) {
      const id = Number(dz[2]);
      return dz[1].toLowerCase() === "playlist" ? this.importDeezerPlaylist(id) : this.importDeezerAlbum(id);
    }
    const sp = link.match(/^https?:\/\/open\.spotify\.com\/(?:intl-[a-z-]+\/)?(playlist|album)\/([A-Za-z0-9]{10,40})/i);
    if (sp) return this.importSpotify(sp[1].toLowerCase(), sp[2]);
    return { status: 404 };
  }

  private importDeezerPlaylist(id: number): { status: number; body?: unknown } {
    const pl = this.dz.getPlaylist(id, 4000);
    if (!pl) return { status: 404 };
    const tracks: ImportTrack[] = [];
    const startMs = this.env.now();
    for (let index = 0; tracks.length < IMPORT_MAX_TRACKS && this.env.now() - startMs < 7000; index += 100) {
      const page = this.dz.getPlaylistTracksPage(id, index, 100, 3000);
      for (const t of page.tracks) tracks.push(importTrackOf(t));
      if (page.tracks.length < 100 || index + 100 >= page.total) break;
    }
    return { status: 200, body: { name: pl.title, description: pl.description || undefined, tracks: tracks.slice(0, IMPORT_MAX_TRACKS) } };
  }

  private importDeezerAlbum(id: number): { status: number; body?: unknown } {
    const album = this.dz.getAlbum(id, 4000);
    if (!album) return { status: 404 };
    const tracks = this.dz.getAlbumTracks(id, 200, 4000).map((t) => importTrackOf({ ...t, album: { id, title: album.title } as DeezerTrack["album"] }));
    return { status: 200, body: { name: album.title, tracks } };
  }

  private importSpotify(type: string, id: string): { status: number; body?: unknown } {
    let html = "";
    try {
      const resp = this.env.http.fetch({ method: "GET", url: `https://open.spotify.com/embed/${type}/${id}`, headers: { "User-Agent": "Mozilla/5.0 (compatible; Ether)", "Accept": "text/html" }, timeoutMs: 6000 });
      if (resp.status !== 200 || !resp.body) return { status: 404 };
      html = resp.body;
    } catch (err) {
      rethrowHostFault(err);
      return { status: 404 };
    }
    const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
    if (!m) return { status: 404 };
    let data: any;
    try {
      data = JSON.parse(m[1]);
    } catch {
      return { status: 404 };
    }
    const entity = data?.props?.pageProps?.state?.data?.entity || {};
    const list: any[] = Array.isArray(entity.trackList) ? entity.trackList : [];
    const tracks: ImportTrack[] = list
      .filter((t) => t && t.title)
      .slice(0, IMPORT_MAX_TRACKS)
      .map((t) => ({
        title: String(t.title),
        artist: String(t.subtitle || "").split(/,\s*/)[0] || "",
        durationSec: Number(t.duration) > 0 ? Math.round(Number(t.duration) / 1000) : undefined,
      }));
    if (tracks.length === 0) return { status: 404 };
    return { status: 200, body: { name: String(entity.name || entity.title || "Imported playlist"), tracks } };
  }

  /**
   * POST /ether/v1/kinds/music/identify
   * Finds the stored-to-be items for imported tracks: by ISRC first (Deezer /track/isrc:), then by
   * artist and title with a duration check. Several releases fitting equally come back as
   * candidates. Tracks not reached within the time budget are left out (Ether asks again).
   */
  identify(req: { tracks?: ImportTrack[] }): { items: KindItem[]; matches: Array<{ index: number; id?: string; by?: string; candidates?: string[] }> } {
    const tracks = Array.isArray(req.tracks) ? req.tracks.slice(0, 50) : [];
    const items: KindItem[] = [];
    const artists = new Set<number>();
    const albums = new Set<number>();
    const matches: Array<{ index: number; id?: string; by?: string; candidates?: string[] }> = [];
    const startMs = this.env.now();
    for (let index = 0; index < tracks.length; index++) {
      if (this.env.now() - startMs > IDENTIFY_BUDGET_MS) break;
      const t = tracks[index];
      try {
        if (t.isrc) {
          const hit = this.dz.getTrackByIsrc(t.isrc);
          if (hit) {
            const id = this.playlistTrackItems(hit, artists, albums, items);
            if (id) {
              matches.push({ index, id, by: "isrc" });
              continue;
            }
          }
        }
        const found = this.findTrackByTitle(t);
        if (found.length === 1) {
          const id = this.playlistTrackItems(found[0], artists, albums, items);
          matches.push(id ? { index, id, by: "title" } : { index });
        } else if (found.length > 1) {
          const candidates = found.map((f) => this.playlistTrackItems(f, artists, albums, items)).filter((x): x is string => Boolean(x));
          matches.push({ index, candidates });
        } else {
          matches.push({ index });
        }
      } catch (err) {
        rethrowHostFault(err);
        break; // rate-limited: leave the rest for the next ask
      }
    }
    return { items, matches };
  }

  /**
   * Deezer tracks matching an imported track's artist and title (duration within 3 s when known),
   * best first. One when a single release clearly fits; several when distinct releases fit equally.
   */
  private findTrackByTitle(t: ImportTrack): DeezerTrack[] {
    const title = stripFeaturing(String(t.title || "")).trim();
    if (!title) return [];
    const artist = String(t.artist || "").trim();
    const q = artist ? `artist:"${artist.replace(/"/g, "")}" track:"${title.replace(/"/g, "")}"` : title;
    const scored = this.dz.searchTracks(q, 15, 2500)
      .map((tr) => {
        const tSim = textSimilarity(title, stripFeaturing(tr.title_short || tr.title || ""));
        const aSim = artist ? textSimilarity(artist, tr.artist?.name || "") : 1;
        const durOk = !t.durationSec || !tr.duration || Math.abs(tr.duration - t.durationSec) <= 3;
        return { tr, score: tSim * 0.6 + aSim * 0.4, ok: tSim >= 0.85 && aSim >= 0.75 && durOk };
      })
      .filter((x) => x.ok)
      .sort((a, b) => b.score - a.score);
    if (scored.length === 0) return [];
    const best = scored[0].score;
    const tied = scored.filter((x) => best - x.score < 0.02);
    // The same recording on several albums: one when they share an ISRC (it is one song), else candidates.
    const isrcs = new Set(tied.map((x) => x.tr.isrc || `id:${x.tr.id}`));
    if (tied.length === 1 || isrcs.size === 1) return [tied[0].tr];
    return tied.slice(0, 8).map((x) => x.tr);
  }

  /**
   * POST /ether/v1/kinds/music/related
   * similar: artists fans of this one also like (Deezer related artists).
   * continuation: a radio of tracks by and like the seed's artist (Deezer artist radio),
   * with the albums and artists they need, in radio order.
   */
  related(req: { item?: any; purpose?: string; limit?: number }): { label?: string; items: KindItem[]; order?: string[] } {
    const item = req.item || {};
    const artistId = this.seedArtistId(item);
    if (!artistId) return { items: [] };
    const limit = Math.max(1, Math.min(50, Number(req.limit) || 20));
    if (req.purpose === "similar") {
      const related = this.dz.getArtistRelated(artistId, Math.min(limit, 20));
      const items = related
        .filter((a) => a && a.id && a.name)
        .map((a) => {
          const built = this.artistItemFor(a.id, a.name);
          if ((!built.art || built.art.length === 0) && (a.picture_xl || a.picture_big)) {
            built.art = makeArt(a.picture_xl, a.picture_big);
          }
          return built;
        });
      return { label: "Fans also like", items };
    }
    if (req.purpose !== "continuation") return { items: [] };

    const startMs = this.env.now();
    const radio = this.dz.getArtistRadio(artistId, 40, 3500);
    const seedTrack = String(item.id || "");
    const out: KindItem[] = [];
    const order: string[] = [];
    const albums = new Map<number, ReturnType<MusicCatalog["loadCanonicalAlbum"]>>();
    const artists = new Set<number>();
    for (const tr of radio) {
      if (order.length >= limit || this.env.now() - startMs > 6500) break;
      const albumId = tr?.album?.id;
      if (!tr?.id || !albumId || trackExternalId(tr.id) === seedTrack) continue;
      if (!albums.has(albumId)) {
        if (albums.size >= 12) continue;
        let canonical = null;
        try {
          canonical = this.loadCanonicalAlbum(albumId, { allowMusicBrainz: false, timeoutMs: 1500 });
        } catch (err) {
          rethrowHostFault(err);
          if (err instanceof RateLimitError) break;
        }
        albums.set(albumId, canonical);
        if (canonical) {
          if (!artists.has(canonical.deezerArtistId)) {
            artists.add(canonical.deezerArtistId);
            out.push(this.artistItemFor(canonical.deezerArtistId, canonical.artistName));
          }
          out.push(this.buildAlbumItem(canonical));
          out.push(...this.buildTrackItems(canonical));
        }
      }
      const canonical = albums.get(albumId);
      const id = trackExternalId(tr.id);
      if (canonical && canonical.tracks.some((t) => t.id === id)) order.push(id);
    }
    return { items: out, order };
  }

  /**
   * GET /ether/v1/kinds/music/items/:id
   * Directly fetches any artist, album, or track item by external ID.
   */
  getItem(externalId: string): KindItem | null {
    const arId = parseNumericId(externalId, "ar-");
    if (arId) {
      const ar = this.dz.getArtist(arId);
      if (!ar) return null;
      return this.buildArtistItem({
        deezerId: ar.id,
        name: ar.name,
        pictureXL: ar.picture_xl || "",
        pictureBig: ar.picture_big || ar.picture_medium || "",
        fans: ar.nb_fan || 0,
        nbAlbum: ar.nb_album || 0,
        genres: [],
        curation: [],
        chartAlbumIds: [],
        newReleaseAlbumIds: [],
        classic: false,
        era: "2020s",
        chartBonus: 0,
        latestReleaseSec: 0,
        latestYear: 0,
      });
    }

    const alId = parseNumericId(externalId, "al-");
    if (alId) {
      const canonical = this.loadCanonicalAlbum(alId, { allowMusicBrainz: true });
      return canonical ? this.buildAlbumItem(canonical) : null;
    }

    if (externalId.startsWith("co-")) {
      const curated = getCuratedConcertById(externalId) || this.cache.get<CuratedConcert>(`concert_meta_v1:${externalId}`);
      if (curated) {
        return buildConcertItem(curated);
      }
    }

    return null;
  }
}
