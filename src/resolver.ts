import type {
  CachedAlbumResolution,
  CachedConcertResolution,
  CanonicalAlbum,
  CanonicalTrack,
  HostEnv,
  KindItem,
  KindMatchRequest,
  KindMatchScore,
  KindResolveRequest,
  KindResolveResponse,
  PlayableSource,
  PluginSettings,
  QualityPreference,
  ReleaseFile,
  ReleaseType,
  SourceCandidate,
  TrackFileMapping,
  TrackHint,
  VerifiedAlbumRelease,
  VerifiedConcertRelease,
  VideoQualityPreference,
} from "./types.ts";
import { KVCache, HOUR_MS, rethrowHostFault } from "./kv.ts";
import { MusicCatalog, parseNumericId, albumExternalId, recordingOf } from "./catalog.ts";
import type { MBRecordingRelease } from "./musicbrainz.ts";
import { getCuratedConcertById, type CuratedConcert } from "./concerts.ts";
import {
  audioFormatOfPath,
  coreReleaseTitle,
  indexerQueryText,
  isArchivePath,
  isConcertExtraOrSamplePath,
  isRejectedConcertVideoRelease,
  isRejectedReleaseForRequest,
  joinedArtistSpelling,
  normalizeText,
  parseTrackFilename,
  similarityOfNormalized,
  stripEditionSuffix,
  stripFeaturing,
  textSimilarity,
  tokenSetOfNormalized,
  videoFormatOfPath,
} from "./normalize.ts";

const ALBUM_CACHE_TTL_MS = 24 * HOUR_MS;
const NEGATIVE_EMPTY_CACHE_TTL_MS = 30 * 60 * 1000;
const NEGATIVE_UNMATCHED_CACHE_TTL_MS = 60 * 60 * 1000;
const NEGATIVE_RESPONSE_EMPTY_TTL_SEC = 600;
const NEGATIVE_RESPONSE_UNMATCHED_TTL_SEC = 900;
const STAGE_CACHE_TTL_MS = 2 * 60 * 1000;
const SEARCH_DEDUP_WINDOW_MS = 5 * 60 * 1000;
const SEARCH_INFLIGHT_WAIT_MS = 6_000;
const SEARCH_MEMO_MAX_CANDIDATES = 25;
const RESOLVE_STEP_BUDGET_MS = 1400;
/**
 * Latest point in a /resolve slice at which a usenet_check may start. Ether kills a /resolve
 * call at 5 s; a usenet_check of a multi-volume release takes up to ~3 s, so a later check is
 * deferred to the next slice (with the release_files answer kept) instead of being killed.
 */
const USENET_CHECK_START_CUTOFF_MS = 1800;
const MAX_CACHED_RELEASES = 3;
const MAX_USENET_PROBES = 10;
const MAX_PLUGIN_PROBES = 4;
// Room for every kind the shortlist can hold: 6 Debrid, the Usenet ones, 4 unconfirmed, the plugin ones.
const MAX_FILE_LIST_PROBES = 6 + MAX_USENET_PROBES + 4 + MAX_PLUGIN_PROBES;
const MAX_USENET_CHECKS_PER_ALBUM = 4;

export function albumCacheKey(albumId: string): string {
  return `alb_rel_v10:${albumId}`;
}

function recordingPlanKey(isrc: string): string {
  return `rec_plan_v1:${isrc}`;
}

/** At most this many other releases of a song are searched for it. */
const MAX_RECORDING_RELEASES = 4;

interface RecordingPlan {
  candidates: Array<{ title: string; artistName: string; year: number; releaseType: ReleaseType; trackCount: number }>;
  idx: number;
}

/**
 * The other releases worth searching for one song, best first: singles and EPs (small, fast to
 * verify), other albums and editions, soundtracks, then compilations. The song's own album and
 * repeats of one title are left out.
 */
/** A recording's verified releases, mapped onto the song asking (any album's copy of it). */
function releasesForItem(releases: VerifiedAlbumRelease[], itemId: string): VerifiedAlbumRelease[] {
  return releases.map((rel) => {
    const mapping = rel.tracks[itemId] || Object.values(rel.tracks)[0];
    return mapping ? { ...rel, tracks: { [itemId]: mapping } } : rel;
  });
}

export function pickRecordingReleases(releases: MBRecordingRelease[], ownAlbumTitle: string): RecordingPlan["candidates"] {
  const own = normalizeText(stripEditionSuffix(ownAlbumTitle || ""));
  const seen = new Set<string>();
  const rank = (r: MBRecordingRelease): number => {
    const sec = r.secondaryTypes.map((t) => t.toLowerCase());
    if (sec.includes("compilation")) return 4;
    if (sec.length > 0) return 3;
    const p = r.primaryType.toLowerCase();
    return p === "single" ? 0 : p === "ep" ? 1 : 2;
  };
  const typeOf = (r: MBRecordingRelease): ReleaseType => {
    const sec = r.secondaryTypes.map((t) => t.toLowerCase());
    if (sec.includes("compilation")) return "compilation";
    if (sec.includes("live")) return "live";
    const p = r.primaryType.toLowerCase();
    return p === "single" ? "single" : p === "ep" ? "ep" : "album";
  };
  const out: RecordingPlan["candidates"] = [];
  for (const r of [...releases].sort((a, b) => rank(a) - rank(b))) {
    const key = normalizeText(stripEditionSuffix(r.title));
    if (!key || key === own || seen.has(key)) continue;
    seen.add(key);
    out.push({ title: r.title, artistName: r.artistName, year: r.year, releaseType: typeOf(r), trackCount: r.trackCount });
    if (out.length >= MAX_RECORDING_RELEASES) break;
  }
  return out;
}

function albumStageKey(albumId: string): string {
  return `alb_stage_v6:${albumId}`;
}

export function concertCacheKey(concertId: string): string {
  return `concert_rel_v2:${concertId}`;
}

function concertStageKey(concertId: string): string {
  return `concert_stage_v2:${concertId}`;
}

export function searchMemoKey(entityId: string, query: string): string {
  const norm = normalizeText(query).slice(0, 96) || query.trim().toLowerCase().slice(0, 96);
  return `sq_v1:${entityId}:${norm}`;
}

interface SearchQueryMemo {
  status: "inflight" | "done";
  at: number;
  rawCount: number;
  candidates?: SourceCandidate[];
  errored?: boolean;
  /** Some indexers were still running, timed out or failed: the answer may grow. */
  incomplete?: boolean;
}

/** How many times one album's or concert's inconclusive search is tried again in a few minutes. */
const MAX_INCONCLUSIVE_SEARCHES = 8;
const INCONCLUSIVE_WINDOW_MS = 3 * 60 * 1000;
/** An answer some indexers did not finish is reused only briefly. */
const INCOMPLETE_MEMO_TTL_MS = 30 * 1000;

/** Whether an indexer_search answer is final: every indexer answered or was skipped. */
export function searchIncomplete(res: { pending?: unknown[]; indexers?: Array<{ status?: string }> } | null | undefined): boolean {
  if (!res) return true;
  if (Array.isArray(res.pending) && res.pending.length > 0) return true;
  const statuses = res.indexers || [];
  if (statuses.some((s) => s.status === "pending" || s.status === "timed_out")) return true;
  // An indexer that answers every music search with an error (one with no audio category, a
  // source that only knows films) would otherwise keep each search open for good: when the
  // others have answered, the search is as complete as it will get.
  const answered = statuses.some((s) => s.status === "answered");
  return !answered && statuses.some((s) => s.status === "error");
}

function compactCandidateForMemo(c: SourceCandidate): SourceCandidate {
  const out: SourceCandidate = {};
  if (c.infoHash) out.infoHash = c.infoHash;
  if (c.magnet) out.magnet = c.magnet;
  if (c.nzbUrl) out.nzbUrl = c.nzbUrl;
  if (c.title) out.title = c.title;
  if (typeof c.size === "number") out.size = c.size;
  if (typeof c.seeders === "number") out.seeders = c.seeders;
  if (typeof c.cached === "boolean") out.cached = c.cached;
  if (c.indexer) out.indexer = c.indexer;
  if (c.indexerId) out.indexerId = c.indexerId;
  if (typeof c.score === "number") out.score = c.score;
  if (typeof c.resolution === "number") out.resolution = c.resolution;
  if (c.source) out.source = c.source;
  if (c.codec) out.codec = c.codec;
  if (c.pluginRelease) out.pluginRelease = { plugin: c.pluginRelease.plugin, id: c.pluginRelease.id };
  return out;
}

/**
 * Returns true when `narrower` contains every normalized token of `broader` (plus extra
 * terms such as a release year). On Newznab/Torznab AND-searches, a strictly narrower query
 * cannot match anything when the broader query already returned 0 results.
 */
export function isStrictlyNarrowerQuery(broader: string, narrower: string): boolean {
  const bToks = normalizeText(broader).split(/\s+/).filter(Boolean);
  const nToks = new Set(normalizeText(narrower).split(/\s+/).filter(Boolean));
  if (bToks.length === 0 || nToks.size <= bToks.length) return false;
  return bToks.every((t) => nToks.has(t));
}

interface ConcertResolveTarget {
  id: string;
  artistName: string;
  title: string;
  year: number;
  filmedYear: number;
  durationSec: number;
  imdbId?: string;
  standaloneTitle?: boolean;
}

interface ListedCandidate {
  ref: string;
  files: ReleaseFile[];
  cached: boolean;
}

interface ConcertResolveStage {
  concert: ConcertResolveTarget;
  preRanked: Array<{ cand: SourceCandidate; score: number }>;
  nextIdx: number;
  verified: VerifiedConcertRelease[];
  archiveFallbacks: VerifiedConcertRelease[];
  debridFallbacks: VerifiedConcertRelease[];
  excludedSig: string;
  rawCandidateCount?: number;
  usenetChecksUsed?: number;
  usenetCheckDisabled?: boolean;
  /** release_files of the candidate at nextIdx whose usenet_check was deferred to this slice. */
  listed?: ListedCandidate;
  /** The search behind this stage had indexers still running, timed out or failed. */
  searchIncomplete?: boolean;
}

interface ResolveStage {
  album: CanonicalAlbum;
  preRanked: Array<{ cand: SourceCandidate; score: number }>;
  nextIdx: number;
  verified: VerifiedAlbumRelease[];
  archiveFallbacks: VerifiedAlbumRelease[];
  debridFallbacks: VerifiedAlbumRelease[];
  excludedSig: string;
  rawCandidateCount?: number;
  usenetChecksUsed?: number;
  usenetCheckDisabled?: boolean;
  /** release_files of the candidate at nextIdx whose usenet_check was deferred to this slice. */
  listed?: ListedCandidate;
  /** The search behind this stage had indexers still running, timed out or failed. */
  searchIncomplete?: boolean;
}

/** A release a source plugin answered the search with: Ether lists and opens it through that plugin. */
export function isPluginCandidate(c: SourceCandidate): boolean {
  return Boolean(c.pluginRelease?.plugin && c.pluginRelease?.id) && !c.infoHash && !c.magnet && !c.nzbUrl;
}

export function candidateRefOf(c: SourceCandidate): string {
  if (isPluginCandidate(c)) return `plg:${c.pluginRelease!.plugin}:${c.pluginRelease!.id}`;
  if (c.infoHash) return `ih:${c.infoHash.toLowerCase()}`;
  if (c.nzbUrl) return `nzb:${c.nzbUrl}`;
  if (c.magnet) return `mag:${c.magnet.slice(0, 80)}`;
  return `title:${normalizeText(c.title || "")}`;
}

/**
 * Identify true Usenet NZB candidates while rejecting Cardigann torrent-site URLs
 * (e.g., LimeTorrents HTML/.torrent links placed in nzbUrl when infoHash is absent).
 */
export function isUsenetCandidate(c: SourceCandidate): boolean {
  if (!c.nzbUrl || c.infoHash || c.magnet) return false;
  if (typeof c.seeders === "number" && c.seeders > 0) return false;
  const idx = String(c.indexer || "").toLowerCase();
  if (/torrent|pirate|1337x|nyaa|rarbg|yts|eztv|rutracker|kickass|magnet/i.test(idx)) {
    return false;
  }
  const url = String(c.nzbUrl).toLowerCase();
  if (/(?:^|\/|-)torrent(?:\b|\/|\.|$)|limetorrents|1337x|thepiratebay/i.test(url)) {
    return false;
  }
  return true;
}

export interface QualityClassification {
  tier: VerifiedAlbumRelease["qualityTier"];
  codec: string;
  mime: string;
  label: string;
  /** Preference score where higher is better. */
  points: number;
  lossless: boolean;
}

/**
 * Classify release quality from candidate title (and verified audio file extensions when known).
 * Enforces owner priority: FLAC > ALAC/WAV > MP3 320 / V0 / AAC 256+ / Opus > lower lossy.
 */
export function classifyReleaseQuality(
  title: string,
  files?: ReleaseFile[],
  pref: QualityPreference = "flac_preferred"
): QualityClassification {
  const t = String(title || "");
  const audioExts = (files || [])
    .map((f) => audioFormatOfPath(f.path))
    .filter((info): info is NonNullable<typeof info> => info !== null);

  const hasFlacFile = audioExts.some((a) => a.ext === "flac");
  const hasLosslessFile = audioExts.some((a) => a.lossless);
  const firstFile = audioExts[0];

  const is24Bit = /\b(?:24\s*-?\s*bit|24bit|24[-_/ ]?(?:44|48|88|96|176|192)|(?:44|48|88|96|176|192)[-_/ ]24|hi-?res)\b/i.test(t);
  // A 24-bit tag with no lossy format beside it ("96-24", "24-96") is a lossless rip whose name
  // leaves the format out; the files decide once they are listed.
  const isLossyTitle = /\b(?:mp3|aac|m4a|ogg|opus|wma|320|256|192\s*k(?:bps)?|v0|v2)\b/i.test(t);
  const isFlacTitle = /\bflac\b/i.test(t) || (is24Bit && !isLossyTitle);
  const isVinyl = /\b(?:vinyl|lp\s*rip|pbthal)\b/i.test(t);
  const isWebOrCd = /\b(?:web|cd|qobuz|tidal|bandcamp|cdrip|eac)\b/i.test(t);

  if (hasFlacFile || (!firstFile && isFlacTitle)) {
    const tier: VerifiedAlbumRelease["qualityTier"] = is24Bit ? "flac24" : "flac";
    const sourceDetail = is24Bit ? "24-bit Lossless" : isWebOrCd ? "WEB/CD Lossless" : isVinyl ? "Vinyl Lossless" : "Lossless";
    // Slightly prefer clean WEB/CD FLAC over noisy vinyl rips unless 24-bit.
    let points = is24Bit ? 105 : 100;
    if (isVinyl && !is24Bit) points -= 6;
    if (pref === "high_bitrate") points = 92;
    return {
      tier,
      codec: "FLAC",
      mime: "audio/flac",
      label: `FLAC · ${sourceDetail}`,
      points,
      lossless: true,
    };
  }

  if (hasLosslessFile || (!firstFile && /\b(?:alac|wav|aiff|wavpack|lossless)\b/i.test(t))) {
    const codec = firstFile?.codec || (/\balac\b/i.test(t) ? "ALAC" : "WAV");
    const mime = firstFile?.mime || (codec === "ALAC" ? "audio/mp4" : "audio/wav");
    return {
      tier: "lossless",
      codec,
      mime,
      label: `${codec} · Lossless`,
      points: pref === "high_bitrate" ? 88 : 92,
      lossless: true,
    };
  }

  const is320OrHigh =
    /\b(?:320|cbr\s*320|v0|aac\s*256|m4a\s*256|itunes\s*plus|opus)\b/i.test(t) ||
    firstFile?.ext === "opus" ||
    firstFile?.ext === "m4a" ||
    firstFile?.ext === "aac";

  if (is320OrHigh) {
    const codec = firstFile?.codec || (/\baac|m4a\b/i.test(t) ? "AAC" : /\bopus\b/i.test(t) ? "Opus" : "MP3");
    const mime = firstFile?.mime || (codec === "AAC" ? "audio/mp4" : codec === "Opus" ? "audio/opus" : "audio/mpeg");
    const bitTag = codec === "MP3" ? (/\bv0\b/i.test(t) ? "V0" : "320") : "High";
    return {
      tier: "lossy_high",
      codec,
      mime,
      label: `${codec} ${bitTag}`,
      points: pref === "lossless_only" ? -1000 : pref === "high_bitrate" ? 96 : 70,
      lossless: false,
    };
  }

  const codec = firstFile?.codec || "MP3";
  const mime = firstFile?.mime || "audio/mpeg";
  return {
    tier: "lossy",
    codec,
    mime,
    label: codec,
    points: pref === "lossless_only" ? -1000 : 45,
    lossless: false,
  };
}

/**
 * Score how well an indexer candidate title matches the canonical album BEFORE fetching file lists.
 */
/** Words in a release name that describe the release, not its title. */
const RELEASE_DESCRIPTION_WORDS = new Set(
  (
    "flac mp3 wav alac aac ogg opus ape wma dsd sacd mqa web cd cds cdm cdr vinyl lp rip remaster remastered " +
    "deluxe edition expanded anniversary special limited reissue lossless album self titled the and " +
    "retail proper repack real read nfo scene digital stereo mono hdtracks qobuz tidal bit khz kbps " +
    "vbr cbr disc discs box set bonus tracks track japan japanese usa germany europe import version"
  ).split(" ")
);

/**
 * A self-titled album ("Metallica" by Metallica) matches every release of the artist by name
 * alone. Tells apart the ones that name another title: the album's name appears once only, and
 * the rest of the release name carries title words (or one such word without the album's year).
 */
export function isOtherTitleForSelfTitledAlbum(
  relTitle: string,
  _normRel: string,
  normArtist: string,
  normAlbum: string,
  albumYear: number
): boolean {
  if (!normAlbum || normAlbum !== normArtist) return false;
  // A post named after a file ('[2/6] "Folder/Artist - Title.flac"') repeats the artist in its
  // path: judge the first part of the path that names the artist.
  let folder = relTitle.trim();
  if (folder.includes("/")) {
    const segments = folder
      .replace(/^\[\d+\/\d+\]\s*/, "")
      .replace(/^["']/, "")
      .split("/");
    folder = segments.find((seg) => normalizeText(seg).includes(normArtist)) ?? folder;
  }
  // A scene name ends in "-GROUP": the group is not a title word.
  const named = /^[^\s]+-[^\s]+-[^\s]+$/.test(folder) ? folder.replace(/-[A-Za-z0-9]{2,14}$/, "") : folder;
  const own = new Set(normArtist.split(/\s+/));
  const isTitleWord = (w: string) => /^[a-z]{3,}$/.test(w) && !own.has(w) && !RELEASE_DESCRIPTION_WORDS.has(w);
  const norm = normalizeText(named);
  const parts = norm.split(normAlbum);
  if (parts.length - 1 >= 2) {
    // "Artist - Artist" and "Artist - 1991 - Artist" name the album; "Artist - Mandatory Artist" does not.
    const between = parts[1].split(/\s+/).filter(Boolean);
    if (!between.some(isTitleWord)) return false;
  }
  const extra = norm.split(/\s+/).filter(isTitleWord);
  if (extra.length >= 2) return true;
  const years = Array.from(named.matchAll(/\b(19\d{2}|20\d{2})\b/g)).map((m) => Number(m[1]));
  const yearNamed = albumYear > 0 && years.includes(albumYear);
  // One other word beside the album's year is a label or a pressing, unless the release is a single.
  if (extra.length === 1) return !yearNamed || /\b(?:cds|cdm|cd\s*single|single|maxi)\b/i.test(named);
  // No other title word: still another release when it is dated to another year and is not a remaster.
  return years.length > 0 && albumYear > 0 && !yearNamed && !/remaster|reissue|anniversary/i.test(named);
}

/**
 * Whether the audio members listed inside a release's archives show it is not this album, so a
 * track picked from it by name would be the wrong file or ambiguous: a title the album has once
 * is there more than once (a single packed as WAV and MP3), or most members name no album track.
 */
export function archiveMembersContradictAlbum(
  album: { tracks: Array<{ title: string }> },
  members: Array<{ path: string }>
): boolean {
  if (members.length === 0) return false;
  const titles = new Map<string, number>();
  for (const tr of album.tracks) {
    const k = normalizeText(coreReleaseTitle(tr.title));
    if (k) titles.set(k, (titles.get(k) || 0) + 1);
  }
  // A member names a track when its file name carries the track's title, whatever else is in
  // it ("01-artist-track_title", "Artist - Track Title (Live)").
  const copies = new Map<string, number>();
  let named = 0;
  for (const m of members) {
    const base = (m.path.replace(/\\/g, "/").split("/").pop() || m.path).replace(/\.[^.]+$/, "");
    const name = ` ${normalizeText(base)} `;
    let title = "";
    for (const k of titles.keys()) {
      if (k.length > title.length && name.includes(` ${k} `)) title = k;
    }
    if (!title) continue;
    named++;
    // The same file name in two formats or folders is the same recording twice.
    const key = `${title}|${name}`;
    copies.set(key, (copies.get(key) || 0) + 1);
  }
  for (const [key, n] of copies) {
    if (n > (titles.get(key.split("|")[0]) || 0)) return true;
  }
  return members.length >= 3 && named * 2 < members.length;
}

export function preScoreAlbumCandidate(
  candidate: SourceCandidate,
  album: {
    artistName: string;
    title: string;
    year: number;
    releaseType: ReleaseType;
    durationSec: number;
  },
  pref: QualityPreference,
  options?: { allowUnconfirmedTorrent?: boolean }
): { accepted: boolean; score: number; reasons: string[] } {
  const relTitle = String(candidate.title || "").trim();
  if (!relTitle) return { accepted: false, score: 0, reasons: ["empty candidate title"] };

  const rej = isRejectedReleaseForRequest(relTitle, album.title, album.releaseType);
  if (rej.rejected) {
    return { accepted: false, score: 0, reasons: [rej.reason || "rejected release type"] };
  }

  const qual = classifyReleaseQuality(relTitle, undefined, pref);
  if (qual.points < 0) {
    return { accepted: false, score: 0, reasons: ["lossy release rejected by lossless_only setting"] };
  }

  const normRel = normalizeText(relTitle);
  const normArtist = normalizeText(album.artistName);
  const cleanAlbum = coreReleaseTitle(album.title);
  const normAlbum = normalizeText(cleanAlbum);

  const reasons: string[] = [];

  if (isOtherTitleForSelfTitledAlbum(relTitle, normRel, normArtist, normAlbum, album.year)) {
    return { accepted: false, score: 0.2, reasons: ["self-titled album: release names another title"] };
  }

  // Artist match check (all significant artist tokens or strong similarity)
  const artistTokens = normArtist.split(/\s+/).filter((t) => t.length >= 2 && t !== "the");
  const relWords = new Set(normRel.split(/\s+/));
  let artistHits = 0;
  for (const tok of artistTokens) {
    if (relWords.has(tok) || normRel.includes(tok)) artistHits++;
  }
  const artistRatio = artistTokens.length > 0 ? artistHits / artistTokens.length : 1;

  // Album title match check
  const albumTokens = normAlbum.split(/\s+/).filter((t) => t.length >= 2 && t !== "the" && t !== "and");
  let albumHits = 0;
  for (const tok of albumTokens) {
    if (relWords.has(tok) || normRel.includes(tok)) albumHits++;
  }
  const albumRatio = albumTokens.length > 0 ? albumHits / albumTokens.length : (normRel.includes(normAlbum) ? 1 : 0);

  if (artistRatio < 0.6) {
    return { accepted: false, score: 0.1, reasons: ["artist name mismatch"] };
  }
  if (albumRatio < 0.65) {
    return { accepted: false, score: 0.2, reasons: ["album title mismatch"] };
  }

  let score = qual.points * 0.45 + artistRatio * 20 + albumRatio * 25;
  reasons.push(qual.label);

  // Exact contiguous album phrase boost
  if (normAlbum.length >= 3 && normRel.includes(normAlbum)) {
    score += 8;
    reasons.push("exact album title");
  }

  // Year match bonus/penalty
  if (album.year > 0) {
    const years = Array.from(relTitle.matchAll(/\b(19\d{2}|20\d{2})\b/g)).map((m) => Number(m[1]));
    if (years.includes(album.year)) {
      score += 8;
      reasons.push(`year ${album.year}`);
    } else if (years.length > 0) {
      const closest = Math.min(...years.map((y) => Math.abs(y - album.year)));
      if (closest <= 1) score += 4;
      else if (closest > 15 && !/\bremaster|reissue|anniversary\b/i.test(relTitle)) score -= 6;
    }
  }

  // Availability / source signals:
  // Strongly prefer cached Debrid releases because release_files returns exact inner audio paths
  // in ~150ms (unlike RAR-packed Usenet posts whose inner members cannot be inspected before download).
  const isUsenet = isUsenetCandidate(candidate);
  if (isPluginCandidate(candidate)) {
    // A source plugin's release lists its real files and opens on demand.
    score += 4;
    reasons.push("Source plugin");
  } else if (candidate.cached && !isUsenet) {
    score += 22;
    reasons.push("Debrid cached");
  } else if (isUsenet) {
    score += 6;
    reasons.push("Usenet");
    // On Usenet, classic scene releases (e.g. "Artist-Album-WEB-FLAC-2023-GROUP") are almost
    // always multi-part RAR archives (often DMCA'd or with scene-renamed inner files), whereas
    // P2P/unpacked posts ("[PMEDIA]", "(flac)", "[FLAC]") usually contain direct .flac/.mp3 files.
    const candTitle = String(candidate.title || "");
    const looksSceneRar = /(?:^|[\s._-])(?:WEB|CD|VINYL|24BIT|16BIT|FLAC)[\s._-]+(?:19\d\d|20\d\d)-[A-Za-z0-9]{2,14}$/i.test(candTitle.trim());
    const looksUnpackedP2P = /\[PMEDIA\]|\(flac\)|\[FLAC\]|\(24bit[- ]?\d+khz\)|\[24Bit-\d+kHz\]/i.test(candTitle);
    if (looksUnpackedP2P && !looksSceneRar) {
      score += 8;
      reasons.push("P2P unpacked likely");
    } else if (looksSceneRar) {
      score -= 14;
      reasons.push("scene RAR likely");
    }
  } else if (options?.allowUnconfirmedTorrent && (candidate.infoHash || candidate.magnet)) {
    // Providers without a bulk cache-check API (Real-Debrid, AllDebrid, Debrid-Link)
    // return cached=false on debrid_check and verify cache at acquire time.
    const seeders = typeof candidate.seeders === "number" ? candidate.seeders : 0;
    if (seeders >= 20) {
      score += 10;
      reasons.push("Debrid fallback (well-seeded)");
    } else if (seeders >= 5) {
      score += 6;
      reasons.push("Debrid fallback (seeded)");
    } else if (seeders >= 1) {
      score += 3;
      reasons.push("Debrid fallback");
    } else {
      score -= 8;
      reasons.push("Debrid fallback (unconfirmed seeders)");
    }
  } else {
    // Uncached torrents cannot have release_files inspected and won't play instantly.
    score -= 40;
  }

  // Single-file image+.cue rips cannot serve individual tracks via fileIndex.
  if (/\bimage\s*\+?\s*\.?\s*cue\b/i.test(String(candidate.title || ""))) {
    score -= 35;
    reasons.push("single-file cue image");
  }

  // Size sanity check against album duration
  if (candidate.size && candidate.size > 0 && album.durationSec > 60) {
    const expectedBytes = (album.durationSec * (qual.lossless ? 950 : 280) * 1000) / 8;
    const ratio = candidate.size / expectedBytes;
    // Reject absurdly tiny (<15% of expected) or gigantic (>8x expected, likely discography/video)
    if (ratio < 0.12 || ratio > 9.0) {
      return { accepted: false, score: 0.1, reasons: ["size outside plausible album range"] };
    }
  }

  return { accepted: true, score, reasons };
}

export interface ExpandedReleaseFile {
  index: number;
  path: string;
  size: number;
  isArchiveMember: boolean;
  archivePath?: string;
  stored?: boolean;
}

/**
 * Expand archive inner members returned by Ether's release_files (f.members) into
 * selectable file entries while preserving each member's exact inner path verbatim.
 */
export function expandReleaseFiles(files: ReleaseFile[]): ExpandedReleaseFile[] {
  const out: ExpandedReleaseFile[] = [];
  for (const f of files) {
    if (Array.isArray(f.members) && f.members.length > 0) {
      for (const m of f.members) {
        if (!m || typeof m.path !== "string" || !m.path.trim()) continue;
        out.push({
          index: typeof m.index === "number" ? m.index : 0,
          path: m.path,
          size: typeof m.size === "number" ? m.size : 0,
          isArchiveMember: true,
          archivePath: f.path,
          stored: m.stored,
        });
      }
    } else {
      out.push({
        index: f.index,
        path: f.path,
        size: f.size,
        isArchiveMember: false,
      });
    }
  }
  return out;
}

export interface AlbumFileMatchResult {
  matched: boolean;
  partial?: boolean;
  isArchive?: boolean;
  reason?: string;
  averageConfidence: number;
  audioFileCount: number;
  tracks: Record<string, TrackFileMapping>;
  quality: QualityClassification;
}

/**
 * Verify a candidate release's file list against the canonical album tracklist.
 * - Expands archive inner members (f.members) when returned by release_files.
 * - Filters to audio files (ignoring .jpg/.cue/.log/.nfo/.par2).
 * - Enforces strict track-count guard (rejects missing tracks & multi-album packs).
 * - Maps every canonical track 1-to-1 to its exact file/member by disc/track number, title, and duration/size.
 */
export function matchAlbumReleaseFiles(
  album: CanonicalAlbum,
  releaseTitle: string,
  files: ReleaseFile[],
  pref: QualityPreference,
  // allowPartial: a folder that holds only some of the album's tracks still serves those tracks,
  // provided its own files are the album's. For a last-resort source, where what one person
  // shares is all there is.
  opts?: { allowPartial?: boolean }
): AlbumFileMatchResult {
  const expanded = expandReleaseFiles(files);
  const emptyFail = (reason: string): AlbumFileMatchResult => ({
    matched: false,
    reason,
    averageConfidence: 0,
    audioFileCount: 0,
    tracks: {},
    quality: classifyReleaseQuality(releaseTitle, expanded, pref),
  });

  const audioFiles = expanded
    .map((f) => ({ file: f, fmt: audioFormatOfPath(f.path) }))
    .filter((x): x is { file: ExpandedReleaseFile; fmt: NonNullable<ReturnType<typeof audioFormatOfPath>> } => {
      if (!x.fmt) return false;
      // Ignore tiny sample/preview/macOS resource-fork files like "._01.flac"
      const base = x.file.path.replace(/\\/g, "/").split("/").pop() || "";
      if (base.startsWith("._")) return false;
      if (x.file.size > 0 && x.file.size < 40_000) return false;
      return true;
    });

  const quality = classifyReleaseQuality(
    releaseTitle,
    audioFiles.map((a) => a.file),
    pref
  );

  if (quality.points < 0) {
    return emptyFail("lossy files rejected by lossless_only setting");
  }

  const canonicalCount = album.tracks.length;
  if (canonicalCount === 0) return emptyFail("canonical album has no tracks");
  if (audioFiles.length === 0) return emptyFail("release contains no audio files");

  // Track-count guard:
  // - Reject multi-album packs / discographies (too many tracks).
  // - Reject tiny/broken releases with far fewer audio files than the album.
  // - Allow standard studio editions (e.g. 10-12 tracks) to serve core tracks of Deluxe /
  //   Anniversary / Expanded editions (e.g. 16-30 tracks) when >=80% of the release's OWN audio
  //   files map cleanly to canonical tracks with strong confidence (full editions still outrank them).
  const isExpandedCanonical =
    stripEditionSuffix(album.title).toLowerCase() !== album.title.trim().toLowerCase() ||
    /\b(?:deluxe|anniversary|expanded|complete|special|super|bonus|encore|remaster|legacy|ultimate|edition)\b/i.test(album.title);
  const minRequiredFiles = opts?.allowPartial ? 1 : isExpandedCanonical ? Math.min(canonicalCount, 5) : canonicalCount;
  if (audioFiles.length < minRequiredFiles) {
    return emptyFail(`incomplete release: ${audioFiles.length} audio files < ${minRequiredFiles} tracks`);
  }
  // One song on another release: the release's own size bounds the files, not the target's.
  const sizeBasis = album.recordingTarget ? Math.max(album.recordingTarget.releaseTrackCount, canonicalCount) : canonicalCount;
  const maxAllowedFiles = sizeBasis + Math.min(4, Math.max(2, Math.floor(sizeBasis * 0.25)));
  if (audioFiles.length > maxAllowedFiles) {
    return emptyFail(`mismatched track count: ${audioFiles.length} audio files vs ${canonicalCount} expected`);
  }

  // Precompute normalized title forms ONCE per file & track (critical for 40-80 track box sets in WASM).
  const parsedFiles = audioFiles.map((af) => {
    const parsed = parseTrackFilename(af.file.path, album.discCount);
    // If an archive member has no disc directory/prefix of its own (e.g. "01 - Track.flac" inside "CD2.rar"),
    // infer the disc number from the parent archive volume filename for scoring only — never mutate af.file.path.
    if (af.file.isArchiveMember && parsed.disc === null && af.file.archivePath) {
      const archDisc = af.file.archivePath.match(
        /(?:^|[\s._\-\/])(?:cd|disc|disk|d)\s*[._\-]?\s*0?([1-9])(?=$|[\s._\-\/])/i
      );
      if (archDisc) {
        parsed.disc = Number(archDisc[1]);
      }
    }
    const cleanGuess = stripFeaturing(stripEditionSuffix(parsed.titleGuess));
    const cleanBase = stripFeaturing(parsed.baseName);
    const guessNorm = normalizeText(parsed.titleGuess);
    const cleanGuessNorm = normalizeText(cleanGuess);
    const cleanBaseNorm = normalizeText(cleanBase);
    return {
      ...af,
      parsed,
      guessNorm,
      guessWords: tokenSetOfNormalized(guessNorm),
      cleanGuess,
      cleanGuessNorm,
      cleanGuessWords: tokenSetOfNormalized(cleanGuessNorm),
      cleanBase,
      cleanBaseNorm,
      cleanBaseWords: tokenSetOfNormalized(cleanBaseNorm),
    };
  });

  const preparedTracks = album.tracks.map((tr) => {
    const cleanTitle = stripFeaturing(stripEditionSuffix(tr.title));
    const titleNorm = normalizeText(tr.title);
    const cleanTitleNorm = normalizeText(cleanTitle);
    return {
      tr,
      titleNorm,
      titleWords: tokenSetOfNormalized(titleNorm),
      cleanTitle,
      cleanTitleNorm,
      cleanTitleWords: tokenSetOfNormalized(cleanTitleNorm),
    };
  });

  // Compute pairwise match scores between every canonical track and every audio file.
  type Pair = { trackIdx: number; fileIdx: number; score: number };
  const pairs: Pair[] = [];

  for (let ti = 0; ti < preparedTracks.length; ti++) {
    const { tr, titleNorm, titleWords, cleanTitleNorm, cleanTitleWords } = preparedTracks[ti];

    for (let fi = 0; fi < parsedFiles.length; fi++) {
      const pf = parsedFiles[fi];
      let score = 0;

      // 1. Title similarity (primary signal, 0..0.55) with O(1) exact-match fast path.
      let titleSim: number;
      if (
        (titleNorm && (titleNorm === pf.guessNorm || titleNorm === pf.cleanGuessNorm)) ||
        (cleanTitleNorm && (cleanTitleNorm === pf.cleanGuessNorm || cleanTitleNorm === pf.guessNorm))
      ) {
        titleSim = 1.0;
      } else {
        // Same result as textSimilarity on the raw strings, without normalizing them again per pair:
        // a 100-track box set against its 100 files is 10,000 pairs.
        const simDirect = similarityOfNormalized(titleNorm, titleWords, pf.guessNorm, pf.guessWords);
        const simClean = similarityOfNormalized(cleanTitleNorm, cleanTitleWords, pf.cleanGuessNorm, pf.cleanGuessWords);
        const simBase =
          pf.cleanBaseNorm === pf.cleanGuessNorm
            ? simClean
            : similarityOfNormalized(cleanTitleNorm, cleanTitleWords, pf.cleanBaseNorm, pf.cleanBaseWords);
        titleSim = Math.max(simDirect, simClean, simBase * 0.9);
      }
      score += titleSim * 0.55;

      // 2. Disc + track number alignment (0..0.35)
      const fileDisc = pf.parsed.disc ?? 1;
      const discMatches = album.discCount <= 1 || pf.parsed.disc === null || fileDisc === tr.disc;
      const trackNumMatches = pf.parsed.track !== null && pf.parsed.track === tr.trackNumber;
      const flatIndexMatches = pf.parsed.track !== null && pf.parsed.track === ti + 1;

      if (discMatches && trackNumMatches) {
        score += 0.35;
      } else if (album.discCount > 1 && pf.parsed.disc === null && flatIndexMatches) {
        // Multi-disc release numbered sequentially 01..24 in one folder.
        score += 0.30;
      } else if (pf.parsed.track !== null && !trackNumMatches && !flatIndexMatches) {
        // Track number actively disagrees -> penalize unless title is nearly identical.
        score -= titleSim >= 0.9 ? 0.05 : 0.22;
      }
      if (album.discCount > 1 && pf.parsed.disc !== null && fileDisc !== tr.disc) {
        score -= 0.25;
      }

      // 3. Duration vs file byte size sanity (0..0.10)
      if (tr.durationSec > 15 && pf.file.size > 0) {
        const approxBytes = (tr.durationSec * pf.fmt.typicalKbps * 1000) / 8;
        const sizeRatio = pf.file.size / approxBytes;
        if (sizeRatio >= 0.25 && sizeRatio <= 3.5) {
          score += 0.10;
        } else if (sizeRatio < 0.08 || sizeRatio > 8.0) {
          score -= 0.18;
        }
      } else {
        score += 0.05;
      }

      // A pair below the assignment floor is never used: leaving it out keeps the sort short.
      if (score >= 0.42) pairs.push({ trackIdx: ti, fileIdx: fi, score });
    }
  }

  // Unique 1-to-1 greedy optimal assignment by highest confidence pair.
  pairs.sort((a, b) => b.score - a.score);
  const usedTracks = new Set<number>();
  const usedFiles = new Set<number>();
  const mapping: Record<string, TrackFileMapping> = {};
  let confidenceSum = 0;
  let usedArchiveMember = false;

  for (const p of pairs) {
    if (usedTracks.has(p.trackIdx) || usedFiles.has(p.fileIdx)) continue;
    if (p.score < 0.42) continue;

    usedTracks.add(p.trackIdx);
    usedFiles.add(p.fileIdx);
    const tr = album.tracks[p.trackIdx];
    const pf = parsedFiles[p.fileIdx];
    const clamped = Math.max(0, Math.min(1, Math.round(p.score * 100) / 100));
    confidenceSum += clamped;

    if (pf.file.isArchiveMember) {
      usedArchiveMember = true;
      mapping[tr.id] = {
        fileHint: pf.file.path,
        isArchiveMember: true,
        size: pf.file.size,
        mime: pf.fmt.mime,
        confidence: clamped,
      };
    } else {
      mapping[tr.id] = {
        fileIndex: pf.file.index,
        file: pf.file.path,
        fileHint: pf.file.path,
        isArchiveMember: false,
        size: pf.file.size,
        mime: pf.fmt.mime,
        confidence: clamped,
      };
    }
  }

  const fullCoverage = usedTracks.size >= canonicalCount;
  const partialEditionAllowed =
    (isExpandedCanonical || Boolean(opts?.allowPartial)) &&
    usedTracks.size >= minRequiredFiles &&
    usedTracks.size >= Math.ceil(audioFiles.length * 0.8);

  if (!fullCoverage && !partialEditionAllowed) {
    return emptyFail(`only mapped ${usedTracks.size}/${canonicalCount} tracks cleanly`);
  }

  const averageConfidence = Math.round((confidenceSum / usedTracks.size) * 100) / 100;
  const minConf = fullCoverage ? 0.58 : 0.7;
  if (averageConfidence < minConf) {
    return emptyFail(`low average track mapping confidence (${averageConfidence})`);
  }

  return {
    matched: true,
    partial: !fullCoverage,
    isArchive: usedArchiveMember,
    averageConfidence,
    audioFileCount: audioFiles.length,
    tracks: mapping,
    quality,
  };
}

/**
 * Build a structured TrackHint ({disc, number, title}) for archive-packed Usenet fallback
 * releases when release_files does not include expanded inner members (Issue #753).
 * Ether's archive engine uses release.track for fuzzy scene-track matching (nzb.MatchTrackIndex),
 * whereas release.fileHint requires an exact inner member path or basename.
 */
export function buildArchiveTrackHint(tr: CanonicalTrack): TrackHint {
  const cleaned = stripFeaturing(stripEditionSuffix(stripFeaturing(tr.title)))
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
  return {
    disc: tr.disc > 0 ? tr.disc : 1,
    number: tr.trackNumber,
    title: cleaned || tr.title.trim(),
  };
}

function buildTrackHintFromItem(item: KindItem): TrackHint | undefined {
  const fields = (item.fields || {}) as Record<string, unknown>;
  const hints = (item.hints || {}) as Record<string, unknown>;
  const disc = Number(fields.discNumber || hints.disc || 1) || 1;
  const number = Number(item.index || fields.trackNumber || hints.trackNumber || 0) || undefined;
  const rawTitle = String(item.title || "").trim();
  const cleaned = stripFeaturing(stripEditionSuffix(stripFeaturing(rawTitle)))
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .trim();
  const title = cleaned || rawTitle;
  if (!number && !title) return undefined;
  return { disc, number, title };
}

function normalizeConcertText(input: string): string {
  // Collapse dotted acronyms like "P.U.L.S.E." or "P. U. L. S. E." -> "PULSE" and "AC/DC" -> "ACDC"
  const collapsed = String(input || "")
    .replace(/\b(?:[A-Za-z]\.\s*){2,}[A-Za-z]\.?/g, (m) => m.replace(/[.\s]+/g, ""))
    .replace(/\bAC\s*\/\s*DC\b/gi, "ACDC")
    .replace(/\bS\s*&\s*M\b/gi, "SM");
  return normalizeText(collapsed);
}

export interface VideoQualityClassification {
  tier: VerifiedConcertRelease["qualityTier"];
  codec: string;
  mime: string;
  label: string;
  points: number;
}

/**
 * Classify video concert release quality from release title and verified video file extension.
 */
export function classifyVideoQuality(
  title: string,
  file?: ReleaseFile,
  pref: VideoQualityPreference = "uhd_preferred"
): VideoQualityClassification {
  const t = String(title || "");
  const fmt = file ? videoFormatOfPath(file.path) : null;
  const mime = fmt?.mime || (/\bmp4\b/i.test(t) ? "video/mp4" : "video/x-matroska");
  const codec =
    /\b(?:x265|h\.?265|hevc)\b/i.test(t)
      ? "HEVC"
      : /\bav1\b/i.test(t)
      ? "AV1"
      : /\b(?:x264|h\.?264|avc)\b/i.test(t)
      ? "H.264"
      : fmt?.container || "Video";

  const isUhd = /\b(?:2160p|4k|uhd)\b/i.test(t);
  const is1080 = /\b(?:1080p|1080i)\b/i.test(t);
  const is720 = /\b720p\b/i.test(t);
  const isRemux = /\b(?:bd)?remux\b/i.test(t);
  const isBluRay = /\b(?:blu-?ray|bdrip|brrip|bdmv)\b/i.test(t);
  const isWeb = /\b(?:web-?dl|webrip)\b/i.test(t);
  const isHdr = /\b(?:hdr10\+?|hdr|dolby\s*vision|\bdv\b)\b/i.test(t);
  const hasPremiumAudio = /\b(?:atmos|truehd|dts-?hd|ma\.?5\.1|lpcm|pcm|flac|5\.1)\b/i.test(t);

  let tier: VerifiedConcertRelease["qualityTier"];
  let resLabel: string;
  let points: number;

  if (isUhd) {
    tier = "uhd";
    resLabel = isHdr ? "4K HDR" : "4K";
    points = pref === "uhd_preferred" ? 108 : pref === "1080p_preferred" ? 96 : 94;
  } else if (is1080) {
    tier = "1080p";
    resLabel = "1080p";
    points = pref === "1080p_preferred" ? 104 : pref === "balanced" ? 102 : 96;
  } else if (is720) {
    tier = "720p";
    resLabel = "720p";
    points = pref === "balanced" ? 80 : 74;
  } else {
    tier = "sd";
    resLabel = /\bdvd\b/i.test(t) ? "DVD" : "SD";
    points = 52;
  }

  let srcLabel = "";
  if (isRemux) {
    srcLabel = "Remux";
    points += pref === "balanced" ? 2 : 7;
  } else if (isBluRay) {
    srcLabel = "BluRay";
    points += 5;
  } else if (isWeb) {
    srcLabel = "WEB-DL";
    points += pref === "balanced" ? 5 : 3;
  } else if (/\bhdtv\b/i.test(t)) {
    srcLabel = "HDTV";
  }

  if (isHdr && isUhd) points += 4;
  if (hasPremiumAudio) points += 4;

  const audioTag = /\batmos\b/i.test(t)
    ? "Atmos"
    : /\btruehd\b/i.test(t)
    ? "TrueHD"
    : /\bdts-?hd\b/i.test(t)
    ? "DTS-HD"
    : /\blpcm\b/i.test(t)
    ? "LPCM"
    : "";

  const labelParts = [resLabel, srcLabel, audioTag].filter(Boolean);
  return {
    tier,
    codec,
    mime,
    label: labelParts.join(" · ") || resLabel,
    points,
  };
}

const CONCERT_STOP_WORDS = new Set([
  "the",
  "and",
  "at",
  "in",
  "on",
  "of",
  "to",
  "a",
  "an",
  "by",
  "for",
  "film",
  "movie",
  "concert",
  "world",
  "extended",
  "cut",
  "edition",
]);

/**
 * Score how well a video indexer candidate matches a canonical concert film BEFORE probing file lists.
 */
export function preScoreConcertCandidate(
  candidate: SourceCandidate,
  concert: {
    artistName: string;
    title: string;
    year: number;
    filmedYear?: number;
    durationSec?: number;
    standaloneTitle?: boolean;
  },
  pref: VideoQualityPreference = "uhd_preferred",
  options?: { allowUnconfirmedTorrent?: boolean }
): { accepted: boolean; score: number; reasons: string[] } {
  const relTitle = String(candidate.title || "").trim();
  if (!relTitle) return { accepted: false, score: 0, reasons: ["empty candidate title"] };

  const rej = isRejectedConcertVideoRelease(relTitle);
  if (rej.rejected) {
    return { accepted: false, score: 0, reasons: [rej.reason || "rejected release"] };
  }

  const qual = classifyVideoQuality(relTitle, undefined, pref);
  const normRel = normalizeConcertText(relTitle);
  const relWords = new Set(normRel.split(/\s+/));

  const normArtist = normalizeConcertText(concert.artistName);
  const artistTokens = normArtist.split(/\s+/).filter((t) => t.length >= 2 && t !== "the" && t !== "and");
  let artistHits = 0;
  for (const tok of artistTokens) {
    if (relWords.has(tok) || normRel.includes(tok)) artistHits++;
  }
  const artistRatio = artistTokens.length > 0 ? artistHits / artistTokens.length : 1;

  // Build title variants: full title, primary clause before ":"/"-", prefix before "Live at/in/from",
  // and venue-suffix stripped form (e.g. "Live at Wembley Stadium" -> "live at wembley",
  // "P.U.L.S.E. Live at Earls Court" -> "pulse", "MTV Unplugged in New York" -> "mtv unplugged").
  const strippedTitle = stripEditionSuffix(concert.title);
  const titleCandidateSet = new Set<string>();
  const addVariant = (s: string) => {
    const n = normalizeConcertText(s);
    if (n.length >= 3) titleCandidateSet.add(n);
  };
  addVariant(strippedTitle);
  addVariant(strippedTitle.split(/[:\-–—]/)[0]);
  const beforeLive = strippedTitle.replace(/\s+\blive\s+(?:at|in|from)\b.*$/i, "").trim();
  if (beforeLive && beforeLive !== strippedTitle) addVariant(beforeLive);
  const beforeInCity = strippedTitle.replace(/\s+\bin\s+(?:new\s+york|london|paris|berlin|los\s+angeles|cinemas)\b.*$/i, "").trim();
  if (beforeInCity && beforeInCity !== strippedTitle) addVariant(beforeInCity);
  const noVenueType = strippedTitle.replace(/\s+\b(?:stadium|arena|theatre|theater|hall|ballroom|amphitheatre|park|festival|tour)\b$/i, "").trim();
  if (noVenueType && noVenueType !== strippedTitle) addVariant(noVenueType);
  const titleCandidates = Array.from(titleCandidateSet);

  let bestTitleRatio = 0;
  let exactPhraseHit = false;
  for (const candNorm of titleCandidates) {
    const rawToks = candNorm.split(/\s+/).filter((t) => t.length >= 2);
    const sigToks = rawToks.filter((t) => !CONCERT_STOP_WORDS.has(t));
    const toks = sigToks.length > 0 ? sigToks : rawToks;
    if (toks.length === 0) continue;
    let hits = 0;
    for (const tok of toks) {
      if (relWords.has(tok) || normRel.includes(tok)) hits++;
    }
    const r = hits / toks.length;
    if (r > bestTitleRatio) bestTitleRatio = r;
    if (candNorm.length >= 4 && normRel.includes(candNorm)) exactPhraseHit = true;
  }

  const reasons: string[] = [qual.label];

  // Distinctive standalone films (e.g. "Stop Making Sense 1984 2160p", "The Last Waltz 1978 1080p")
  // are frequently indexed without repeating the artist name in the release title.
  const standaloneMatched = Boolean(concert.standaloneTitle) && bestTitleRatio >= 0.85 && exactPhraseHit;
  if (!standaloneMatched) {
    if (artistRatio < 0.6) {
      return { accepted: false, score: 0.1, reasons: ["artist name mismatch"] };
    }
    if (bestTitleRatio < 0.55) {
      return { accepted: false, score: 0.2, reasons: ["concert title mismatch"] };
    }
  }

  let score = qual.points * 0.48 + (standaloneMatched ? 18 : artistRatio * 20) + bestTitleRatio * 26;
  if (exactPhraseHit) {
    score += 10;
    reasons.push("exact concert title");
  }

  // Year check against both release year and filmed year (±1 year tolerance).
  const targetYears = [concert.year, concert.filmedYear || 0].filter((y) => y > 1950);
  if (targetYears.length > 0) {
    const relYears = Array.from(relTitle.matchAll(/\b(19\d{2}|20\d{2})\b/g)).map((m) => Number(m[1]));
    if (relYears.length > 0) {
      let minDiff = 999;
      for (const ry of relYears) {
        for (const ty of targetYears) {
          minDiff = Math.min(minDiff, Math.abs(ry - ty));
        }
      }
      if (minDiff === 0) {
        score += 10;
        reasons.push("exact year");
      } else if (minDiff === 1) {
        score += 6;
      } else if (minDiff > 10 && !/\b(?:remaster|restored|imax|4k|uhd|anniversary|reissue)\b/i.test(relTitle)) {
        score -= 14;
      }
    }
  }

  // Size sanity check for full-length video concerts (120 MB .. 100 GB).
  if (candidate.size && candidate.size > 0) {
    const minBytes = 120 * 1024 * 1024;
    const maxBytes = 100 * 1024 * 1024 * 1024;
    if (candidate.size < minBytes || candidate.size > maxBytes) {
      return { accepted: false, score: 0.1, reasons: ["file size outside concert film range"] };
    }
  }

  const isUsenet = isUsenetCandidate(candidate);
  if (candidate.cached && !isUsenet) {
    score += 24;
    reasons.push("Debrid cached");
  } else if (isUsenet) {
    score += 6;
    reasons.push("Usenet");
  } else if (options?.allowUnconfirmedTorrent && (candidate.infoHash || candidate.magnet)) {
    const seeders = typeof candidate.seeders === "number" ? candidate.seeders : 0;
    if (seeders >= 20) {
      score += 10;
      reasons.push("Debrid fallback (well-seeded)");
    } else if (seeders >= 5) {
      score += 6;
      reasons.push("Debrid fallback (seeded)");
    } else if (seeders >= 1) {
      score += 3;
      reasons.push("Debrid fallback");
    } else {
      score -= 8;
      reasons.push("Debrid fallback (unconfirmed seeders)");
    }
  } else {
    score -= 40;
  }

  // Deprioritize raw disc ISO images when MKV/MP4 releases are available.
  if (/\b(?:iso|dvd-?r|bd-?r)\b/i.test(relTitle) && !/\b(?:mkv|mp4|x264|x265|hevc|remux)\b/i.test(relTitle)) {
    score -= 18;
  }

  return { accepted: true, score, reasons };
}

export interface ConcertFileMatchResult {
  matched: boolean;
  reason?: string;
  file?: ExpandedReleaseFile;
  quality: VideoQualityClassification;
}

/**
 * Pick the main playable video feature file from a candidate concert release's file list.
 * Expands archive inner members (f.members) when returned by release_files.
 * Rejects audio-only packs, ISO-only images, samples/extras, and multi-film anthologies.
 */
export function matchConcertReleaseFiles(
  releaseTitle: string,
  files: ReleaseFile[],
  pref: VideoQualityPreference = "uhd_preferred"
): ConcertFileMatchResult {
  const expanded = expandReleaseFiles(files);
  const baseQuality = classifyVideoQuality(releaseTitle, undefined, pref);
  const videoFiles = expanded
    .map((f) => ({ file: f, fmt: videoFormatOfPath(f.path) }))
    .filter((x): x is { file: ExpandedReleaseFile; fmt: NonNullable<ReturnType<typeof videoFormatOfPath>> } => {
      if (!x.fmt) return false;
      if (isConcertExtraOrSamplePath(x.file.path)) return false;
      if (x.file.size > 0 && x.file.size < 50 * 1024 * 1024) return false;
      return true;
    });

  if (videoFiles.length === 0) {
    return { matched: false, reason: "no playable video files in release", quality: baseQuality };
  }

  videoFiles.sort((a, b) => (b.file.size || 0) - (a.file.size || 0));
  const main = videoFiles[0];
  const totalBytes = videoFiles.reduce((acc, v) => acc + (v.file.size || 0), 0);
  const largeVideos = videoFiles.filter((v) => (v.file.size || 0) >= 250 * 1024 * 1024);

  // Reject multi-concert / TV season packs where no single main feature dominates.
  if (largeVideos.length >= 5 && totalBytes > 0 && (main.file.size || 0) / totalBytes < 0.45) {
    return { matched: false, reason: "multi-video pack with no single concert feature", quality: baseQuality };
  }

  const quality = classifyVideoQuality(releaseTitle, main.file, pref);
  return {
    matched: true,
    file: main.file,
    quality,
  };
}

export class AlbumResolver {
  private env: HostEnv;
  private cache: KVCache;
  private catalog: MusicCatalog;
  private settings: PluginSettings;

  constructor(env: HostEnv, cache: KVCache, catalog: MusicCatalog, settings: PluginSettings) {
    this.env = env;
    this.cache = cache;
    this.catalog = catalog;
    this.settings = settings;
  }

  /**
   * POST /ether/v1/kinds/music/resolve
   * Fast path: read cached verified album release from KV and emit this track's exact file (<2ms).
   * Cold path: run KV-checkpointed album resolution in bounded <=2.4s slices within Ether's 5s
   * interactive route budget (emitting { pending: true, retryInMs: 250 } only if additional file
   * probes are still needed). Never blocks on background WaitBackground gates.
   */
  resolve(req: KindResolveRequest): KindResolveResponse {
    const item = req.item;
    if (!item || !item.id) return { sources: [] };

    if (item.level === "concert" || item.id.startsWith("co-")) {
      return this.resolveConcert(req);
    }

    const hints = (item.hints || {}) as Record<string, unknown>;
    const albumId = String(item.parentId || hints.albumId || "");
    if (!albumId) return { sources: [] };

    const excluded = new Set(
      (Array.isArray(req.client?.exclude) ? req.client!.exclude : []).map((s) => String(s))
    );

    const cached = this.cache.get<CachedAlbumResolution>(albumCacheKey(albumId));
    if (cached) {
      if (cached.negative) {
        return this.resolveRecording(item, excluded, this.negativeResponseTtlSec(cached));
      }
      const sources = this.buildTrackSources(item, cached.releases, excluded);
      if (sources.length > 0) {
        return { sources, ttlSec: 3600 };
      }
      // If every cached release was excluded on failover, invalidate & re-resolve.
      if (excluded.size > 0) {
        this.cache.delete(albumCacheKey(albumId));
        this.cache.delete(albumStageKey(albumId));
      } else {
        // The album was found but not this song on it: look for the song on its other releases.
        return this.resolveRecording(item, excluded, NEGATIVE_RESPONSE_EMPTY_TTL_SEC);
      }
    }

    const step = this.stepResolveAlbum(albumId, item, excluded, RESOLVE_STEP_BUDGET_MS, true);
    if (!step.done) {
      return {
        pending: true,
        retryInMs: step.retryInMs ?? 250,
        sources: [],
      };
    }
    if (step.inconclusive) return { sources: [], ttlSec: 30 };

    const fresh = this.cache.get<CachedAlbumResolution>(albumCacheKey(albumId));
    if (!fresh || fresh.releases.length === 0) {
      return this.resolveRecording(item, excluded, fresh ? this.negativeResponseTtlSec(fresh) : NEGATIVE_RESPONSE_EMPTY_TTL_SEC);
    }
    const sources = this.buildTrackSources(item, fresh.releases, excluded);
    if (sources.length === 0) return this.resolveRecording(item, excluded, NEGATIVE_RESPONSE_EMPTY_TTL_SEC);
    return { sources, ttlSec: 3600 };
  }

  /**
   * One song whose album gave no playable copy of it: find it on another release that carries
   * the same recording (by ISRC: a single, an EP, another edition, a compilation), one release per
   * slice through the same staged album resolver, and remember the answer per recording so every
   * album holding that song plays it. Without an ISRC the album's answer stands.
   */
  private resolveRecording(item: KindItem, excluded: Set<string>, emptyTtlSec: number): KindResolveResponse {
    const hints = (item.hints || {}) as Record<string, unknown>;
    const recording = recordingOf(String(hints.isrc || ""));
    if (!recording) return { sources: [], ttlSec: emptyTtlSec };
    const isrc = recording.slice("isrc:".length);
    const recId = `rec-${isrc}`;
    const done = this.cache.get<CachedAlbumResolution>(albumCacheKey(recId));
    if (done) {
      if (done.negative) return { sources: [], ttlSec: Math.min(emptyTtlSec, this.negativeResponseTtlSec(done)) };
      const sources = this.buildTrackSources(item, releasesForItem(done.releases, item.id), excluded);
      if (sources.length > 0) return { sources, ttlSec: 3600 };
      if (excluded.size === 0) return { sources: [], ttlSec: emptyTtlSec };
      this.cache.delete(albumCacheKey(recId));
    }
    let plan = this.cache.get<RecordingPlan>(recordingPlanKey(isrc));
    if (!plan) {
      const looked = this.catalog.recordingReleases(isrc);
      if (looked.status === "busy") return { pending: true, retryInMs: 1200, sources: [] };
      const candidates = looked.status === "ok" ? pickRecordingReleases(looked.releases, String(hints.albumTitle || "")) : [];
      if (candidates.length === 0) {
        this.rememberRecordingMiss(recId);
        return { sources: [], ttlSec: emptyTtlSec };
      }
      plan = { candidates, idx: 0 };
      this.cache.set(recordingPlanKey(isrc), plan, ALBUM_CACHE_TTL_MS);
    }
    const cand = plan.candidates[plan.idx];
    const synthId = `${recId}-${plan.idx}`;
    if (!this.cache.get<CanonicalAlbum>(`album_v2:${synthId}`)) {
      this.cache.set(`album_v2:${synthId}`, this.recordingAlbum(synthId, item, cand), ALBUM_CACHE_TTL_MS);
      // Said once per release tried, not on every poll: Ether keeps a plugin's last 200 lines,
      // and a waiting app polls several times a second.
      this.env.log("info", `resolve-recording: ${recording} "${item.title}" try ${plan.idx + 1}/${plan.candidates.length} "${cand.artistName} - ${cand.title}" (${cand.releaseType})`);
    }
    const step = this.stepResolveAlbum(synthId, item, excluded, RESOLVE_STEP_BUDGET_MS, true);
    if (!step.done) return { pending: true, retryInMs: step.retryInMs ?? 250, sources: [] };
    if (step.inconclusive) return { sources: [], ttlSec: 30 };
    const fresh = this.cache.get<CachedAlbumResolution>(albumCacheKey(synthId));
    if (fresh && !fresh.negative && fresh.releases.length > 0) {
      this.cache.set(albumCacheKey(recId), fresh, ALBUM_CACHE_TTL_MS);
      this.cache.delete(recordingPlanKey(isrc));
      const sources = this.buildTrackSources(item, releasesForItem(fresh.releases, item.id), excluded);
      if (sources.length > 0) return { sources, ttlSec: 3600 };
    }
    plan.idx++;
    if (plan.idx >= plan.candidates.length) {
      this.cache.delete(recordingPlanKey(isrc));
      this.rememberRecordingMiss(recId);
      return { sources: [], ttlSec: emptyTtlSec };
    }
    this.cache.set(recordingPlanKey(isrc), plan, ALBUM_CACHE_TTL_MS);
    return { pending: true, retryInMs: 250, sources: [] };
  }

  private rememberRecordingMiss(recId: string): void {
    const now = this.env.now();
    const record: CachedAlbumResolution = { albumId: recId, resolvedAt: now, expiresAt: now + NEGATIVE_UNMATCHED_CACHE_TTL_MS, releases: [], negative: true };
    this.cache.set(albumCacheKey(recId), record, NEGATIVE_UNMATCHED_CACHE_TTL_MS);
  }

  /** The one-song "album" searched for on another release of its recording. */
  private recordingAlbum(id: string, item: KindItem, cand: RecordingPlan["candidates"][number]): CanonicalAlbum {
    const hints = (item.hints || {}) as Record<string, unknown>;
    const artistName = cand.artistName || String(hints.trackArtistName || hints.artistName || "");
    return {
      id,
      deezerAlbumId: 0,
      artistId: `ar-${Number(hints.deezerArtistId) || 0}`,
      deezerArtistId: Number(hints.deezerArtistId) || 0,
      artistName,
      title: cand.title,
      releaseDate: "",
      year: cand.year,
      releaseType: cand.releaseType,
      genres: [],
      label: "",
      fans: 0,
      durationSec: Number(hints.durationSec || 0),
      trackCount: 1,
      discCount: 1,
      coverXL: "",
      coverBig: "",
      curation: [],
      tracks: [{
        id: item.id,
        deezerTrackId: Number(hints.deezerTrackId) || 0,
        title: item.title,
        disc: 1,
        trackNumber: 0,
        durationSec: Number(hints.durationSec || item.fields?.duration || 0),
        explicit: false,
        isrc: String(hints.isrc || "") || undefined,
        artistName: String(hints.trackArtistName || artistName),
      }],
      recordingTarget: { releaseTrackCount: cand.trackCount },
    };
  }

  /**
   * POST /ether/job/resolve-album
   * Completes album resolution in one pass when invoked as a job.
   */
  runAlbumResolveJob(req: KindResolveRequest): { done: boolean; albumId?: string; verifiedCount: number } {
    const item = req.item;
    if (!item) return { done: true, verifiedCount: 0 };

    const hints = (item.hints || {}) as Record<string, unknown>;
    const albumId = String(item.parentId || hints.albumId || "");
    if (!albumId) return { done: true, verifiedCount: 0 };

    const excluded = new Set(
      (Array.isArray(req.client?.exclude) ? req.client!.exclude : []).map((s) => String(s))
    );

    const existing = this.cache.get<CachedAlbumResolution>(albumCacheKey(albumId));
    if (existing && (existing.negative || excluded.size === 0)) {
      return { done: true, albumId, verifiedCount: existing.releases.length };
    }

    // Never run usenet_check during background/scheduled jobs (Ether enforces on-demand only).
    const step = this.stepResolveAlbum(albumId, item, excluded, 60_000, false);
    return { done: step.done, albumId, verifiedCount: step.verifiedCount };
  }

  private negativeResponseTtlSec(cached: { expiresAt: number }): number {
    const remainingSec = Math.floor((cached.expiresAt - this.env.now()) / 1000);
    if (remainingSec <= 0) return NEGATIVE_RESPONSE_EMPTY_TTL_SEC;
    return Math.max(60, Math.min(NEGATIVE_RESPONSE_UNMATCHED_TTL_SEC, remainingSec));
  }

  private runMemoizedIndexerSearch(
    entityId: string,
    query: string,
    category: string,
    timeoutMs: number,
    interactive: boolean,
    prioritize?: (cands: SourceCandidate[]) => SourceCandidate[]
  ): {
    candidates: SourceCandidate[];
    rawCount: number;
    fromCache: boolean;
    errored: boolean;
    deferredInFlight: boolean;
    elapsedMs: number;
    incomplete: boolean;
  } {
    const memoKey = searchMemoKey(entityId, query);
    const memo = this.cache.get<SearchQueryMemo>(memoKey, { fresh: true });
    if (memo) {
      if (memo.status === "done") {
        return {
          candidates: (memo.candidates || []).map((c) => ({ ...c })),
          rawCount: memo.rawCount,
          fromCache: true,
          errored: Boolean(memo.errored),
          deferredInFlight: false,
          elapsedMs: 0,
          incomplete: Boolean(memo.incomplete || memo.errored),
        };
      }
      if (this.env.now() - memo.at < SEARCH_INFLIGHT_WAIT_MS) {
        return {
          candidates: [],
          rawCount: 0,
          fromCache: true,
          errored: false,
          deferredInFlight: true,
          elapsedMs: 0,
          incomplete: true,
        };
      }
      // The previous attempt never finished (a host timeout cut it off): it says nothing about
      // the album, so search again rather than calling it an error.
      this.cache.delete(memoKey);
    }

    const reqAt = this.env.now();
    this.cache.set<SearchQueryMemo>(
      memoKey,
      { status: "inflight", at: reqAt, rawCount: 0 },
      SEARCH_DEDUP_WINDOW_MS
    );

    try {
      const res = this.env.sources.resolve({
        kind: "indexer_search",
        query,
        category,
        firstResults: true,
        settleMs: interactive ? 300 : 500,
        timeoutMs,
      });
      const list = Array.isArray(res?.candidates) ? res.candidates : [];
      const elapsedMs = Math.max(0, this.env.now() - reqAt);
      const incomplete = searchIncomplete(res);
      const statusCounts: Record<string, number> = {};
      for (const st of ((res as { indexers?: Array<{ status?: string }> } | null)?.indexers || [])) {
        const k = st.status || "unknown";
        statusCounts[k] = (statusCounts[k] || 0) + 1;
      }
      const statusText = Object.keys(statusCounts).map((k) => `${k}:${statusCounts[k]}`).join(",") || "none";
      this.env.log(
        "debug",
        `indexer_search ${entityId} "${query}" returned=${list.length} in ${elapsedMs}ms (timeout ${timeoutMs}ms) indexers=${statusText}`
      );
      if (incomplete && list.length === 0) {
        // Indexers still running (or cut off) and nothing yet: not an answer. Keep it marked in
        // flight so concurrent tracks wait, and search again after the wait window.
        this.cache.set<SearchQueryMemo>(memoKey, { status: "inflight", at: this.env.now(), rawCount: 0 }, SEARCH_DEDUP_WINDOW_MS);
        return { candidates: [], rawCount: 0, fromCache: false, errored: false, deferredInFlight: false, elapsedMs, incomplete: true };
      }
      const rankAt = this.env.now();
      const ordered = prioritize ? prioritize(list) : list;
      const compacted = ordered.slice(0, SEARCH_MEMO_MAX_CANDIDATES).map(compactCandidateForMemo);
      this.env.log("debug", `indexer_search ${entityId} ranked ${list.length} in ${this.env.now() - rankAt}ms`);
      this.cache.set<SearchQueryMemo>(
        memoKey,
        { status: "done", at: this.env.now(), rawCount: list.length, candidates: compacted, incomplete: incomplete || undefined },
        incomplete ? INCOMPLETE_MEMO_TTL_MS : SEARCH_DEDUP_WINDOW_MS
      );
      return {
        candidates: list,
        rawCount: list.length,
        fromCache: false,
        errored: false,
        deferredInFlight: false,
        elapsedMs,
        incomplete,
      };
    } catch (err) {
      rethrowHostFault(err);
      const elapsedMs = Math.max(0, this.env.now() - reqAt);
      // A failed search says nothing about the album: keep it in flight for the wait window
      // (concurrent tracks wait), then search again.
      this.cache.set<SearchQueryMemo>(memoKey, { status: "inflight", at: this.env.now(), rawCount: 0 }, SEARCH_DEDUP_WINDOW_MS);
      this.env.log("debug", `indexer_search failed ${entityId} "${query}": ${String(err).slice(0, 120)}`);
      return {
        candidates: [],
        rawCount: 0,
        fromCache: false,
        errored: true,
        deferredInFlight: false,
        elapsedMs,
        incomplete: true,
      };
    }
  }

  private isSatisfiedAlbumRelease(v: VerifiedAlbumRelease, trackCount: number): boolean {
    if (v.isArchiveFallback || v.isUnconfirmedDebridFallback) return false;
    if (Object.keys(v.tracks).length < trackCount) return false;
    if (this.settings.qualityPreference === "high_bitrate") {
      return (
        v.qualityTier === "flac" ||
        v.qualityTier === "flac24" ||
        v.qualityTier === "lossless" ||
        v.qualityTier === "lossy_high"
      );
    }
    return v.qualityTier === "flac" || v.qualityTier === "flac24";
  }

  private stepResolveAlbum(
    albumId: string,
    item: KindItem,
    excluded: Set<string>,
    budgetMs: number,
    allowUsenetCheck: boolean
  ): { done: boolean; verifiedCount: number; retryInMs?: number; inconclusive?: boolean } {
    const startMs = this.env.now();
    const excludedSig = Array.from(excluded).sort().join("|");
    let stage = this.cache.get<ResolveStage>(albumStageKey(albumId));
    if (stage && stage.excludedSig !== excludedSig) {
      stage = null;
    }

    if (!stage) {
      // Self-heal legacy KV bloat from <=0.2.4 installs before persisting stage/release entries.
      this.cache.sweepLegacyBloat(64);
      const album = this.loadAlbumForResolve(albumId, item);
      if (!album) {
        this.env.log("warn", `resolve-album: could not load metadata for ${albumId}`);
        return { done: true, verifiedCount: 0 };
      }

      const searched = this.searchAndRankCandidates(album, excluded, startMs, budgetMs);
      if (searched.deferredInFlight) {
        // Another worker is currently running the same album search; yield briefly without
        // firing a duplicate parallel search or caching a premature negative result.
        return { done: false, verifiedCount: 0, retryInMs: 350 };
      }
      // Logged for a search that ran, not for each poll that waited on one.
      this.env.log(
        "info",
        `resolve-album: search ${album.id} "${album.artistName} - ${album.title}" (${album.year}, ${album.tracks.length} tracks)`
      );
      if (searched.incomplete && searched.ordered.length === 0) {
        return this.inconclusive(albumId);
      }
      stage = {
        album,
        preRanked: searched.ordered.slice(0, MAX_FILE_LIST_PROBES),
        nextIdx: 0,
        verified: [],
        archiveFallbacks: [],
        debridFallbacks: [],
        excludedSig,
        rawCandidateCount: searched.rawCount,
        searchIncomplete: searched.incomplete || undefined,
        usenetChecksUsed: 0,
        usenetCheckDisabled: false,
      };
      this.cache.set(albumStageKey(albumId), stage, STAGE_CACHE_TTL_MS);

      if (stage.preRanked.length === 0) {
        return this.finalizeAlbumResolution(albumId, stage);
      }
      // If search + debrid_check already spent most of the 5s route budget, pause cleanly
      // and probe release_files on the very next 250ms poll with a fresh 5s deadline.
      if (this.env.now() - startMs >= budgetMs) {
        return { done: false, verifiedCount: 0 };
      }
    }

    // Probe candidate file lists within remaining step budget.
    while (stage.nextIdx < stage.preRanked.length) {
      const hasLossless = stage.verified.some((v) => v.qualityTier === "flac" || v.qualityTier === "flac24");
      if (stage.verified.length >= MAX_CACHED_RELEASES && hasLossless) {
        break;
      }
      // Always allow at least 1 probe on a fresh continuation call; stop before blowing budget.
      if (stage.nextIdx > 0 && this.env.now() - startMs >= budgetMs) {
        if (stage.verified.length > 0) {
          // We already have a verified match — return it immediately rather than waiting!
          break;
        }
        this.cache.set(albumStageKey(albumId), stage, STAGE_CACHE_TTL_MS);
        return { done: false, verifiedCount: 0 };
      }

      const { cand, score: preScore } = stage.preRanked[stage.nextIdx];
      // Usenet release_files fetches an NZB over HTTP (1-3s), and unconfirmed Debrid probes
      // (Real-Debrid / AllDebrid / Debrid-Link) may invoke acquireOn (~0.5-1.5s); yield
      // cleanly if we already consumed part of the 5s route budget.
      if (isUsenetCandidate(cand) && this.env.now() - startMs >= 900) {
        if (stage.verified.length > 0) break;
        this.cache.set(albumStageKey(albumId), stage, STAGE_CACHE_TTL_MS);
        return { done: false, verifiedCount: 0 };
      }
      if (!isUsenetCandidate(cand) && !cand.cached && this.env.now() - startMs >= 1500) {
        if (stage.verified.length > 0) break;
        this.cache.set(albumStageKey(albumId), stage, STAGE_CACHE_TTL_MS);
        return { done: false, verifiedCount: 0 };
      }
      stage.nextIdx++;
      if (this.probeSingleCandidate(stage, cand, preScore, allowUsenetCheck, startMs)) {
        // Its usenet_check did not fit this slice: it runs first in the next one.
        if (stage.verified.length > 0) break;
        this.cache.set(albumStageKey(albumId), stage, STAGE_CACHE_TTL_MS);
        return { done: false, verifiedCount: 0 };
      }

      // Fast-finish as soon as we have a FULL-coverage verified release matching quality preference
      // (or any full-coverage verified release when no lossless candidates remain to probe).
      // Debrid is always probed first; for Usenet-only setups this avoids redundant FetchNZB hits.
      const hasFullVerified = stage.verified.some(
        (v) =>
          !v.isArchiveFallback &&
          !v.isUnconfirmedDebridFallback &&
          Object.keys(v.tracks).length >= stage.album.tracks.length
      );
      const hasRemainingLossless =
        hasFullVerified &&
        stage.preRanked
          .slice(stage.nextIdx)
          .some((x) =>
            classifyReleaseQuality(x.cand.title || "", undefined, this.settings.qualityPreference).lossless
          );
      if (
        stage.verified.some((v) => this.isSatisfiedAlbumRelease(v, stage.album.tracks.length)) ||
        (hasFullVerified && !hasRemainingLossless)
      ) {
        break;
      }
    }

    return this.finalizeAlbumResolution(albumId, stage);
  }

  /**
   * A search whose indexers had not all answered (still running, timed out or failed) gave no
   * verdict. Ask again shortly while the budget lasts; after that answer nothing for now, still
   * without remembering a negative, so the next play searches afresh.
   */
  private inconclusive(entityId: string): { done: boolean; verifiedCount: number; retryInMs?: number; inconclusive?: boolean } {
    const key = `search_retry:${entityId}`;
    const tries = (this.cache.get<number>(key) || 0) + 1;
    this.cache.set(key, tries, INCONCLUSIVE_WINDOW_MS);
    if (tries <= MAX_INCONCLUSIVE_SEARCHES) {
      return { done: false, verifiedCount: 0, retryInMs: 1000 };
    }
    this.env.log("info", `resolve: ${entityId} search still inconclusive after ${MAX_INCONCLUSIVE_SEARCHES} tries; not caching a negative`);
    return { done: true, verifiedCount: 0, inconclusive: true };
  }

  private finalizeAlbumResolution(albumId: string, stage: ResolveStage): { done: boolean; verifiedCount: number; retryInMs?: number; inconclusive?: boolean } {
    stage.verified.sort((a, b) => b.score - a.score);
    let finalReleases: VerifiedAlbumRelease[];
    if (stage.verified.length > 0) {
      finalReleases = stage.verified.slice(0, MAX_CACHED_RELEASES);
    } else {
      const archiveFallbacks = [...(stage.archiveFallbacks || [])].sort((a, b) => b.score - a.score);
      const debridFallbacks = [...(stage.debridFallbacks || [])].sort((a, b) => b.score - a.score);
      finalReleases = [...archiveFallbacks.slice(0, 2), ...debridFallbacks.slice(0, 2)].slice(0, 3);
    }
    if (finalReleases.length === 0 && stage.searchIncomplete) {
      // Nothing playable among what the indexers had answered so far: no verdict yet.
      this.cache.delete(albumStageKey(albumId));
      return this.inconclusive(albumId);
    }

    const now = this.env.now();
    const negTtlMs =
      (stage.rawCandidateCount || 0) > 0
        ? NEGATIVE_UNMATCHED_CACHE_TTL_MS
        : NEGATIVE_EMPTY_CACHE_TTL_MS;
    const ttlMs = finalReleases.length > 0 ? ALBUM_CACHE_TTL_MS : negTtlMs;
    const record: CachedAlbumResolution = {
      albumId,
      resolvedAt: now,
      expiresAt: now + ttlMs,
      releases: finalReleases,
      negative: finalReleases.length === 0,
    };
    this.cache.set(albumCacheKey(albumId), record, ttlMs);
    this.cache.delete(albumStageKey(albumId));

    this.env.log(
      "info",
      `resolve-album: done ${albumId} verified=${finalReleases.length} labels=${finalReleases.map((v) => v.label).join(", ")}`
    );
    return { done: true, verifiedCount: finalReleases.length };
  }

  private loadAlbumForResolve(albumId: string, item: KindItem): CanonicalAlbum | null {
    const cachedMeta = this.cache.get<CanonicalAlbum>(`album_v2:${albumId}`);
    if (cachedMeta && cachedMeta.tracks.length > 0) return cachedMeta;

    const hints = (item.hints || {}) as Record<string, unknown>;
    const dzAlbId = Number(hints.deezerAlbumId) || parseNumericId(albumId, "al-");
    if (dzAlbId > 0) {
      const loaded = this.catalog.loadCanonicalAlbum(dzAlbId, {
        allowMusicBrainz: true,
        requireTrackDetails: true,
      });
      if (loaded) return loaded;
    }

    // Minimal fallback when resolving a synthetic/single item without Deezer album ID.
    const artistName = String(hints.artistName || item.fields?.artistName || "").trim();
    const albumTitle = String(hints.albumTitle || item.fields?.albumTitle || "").trim();
    if (!artistName || !albumTitle) return null;

    return {
      id: albumId || albumExternalId(dzAlbId || 1),
      deezerAlbumId: dzAlbId,
      artistId: `ar-${Number(hints.deezerArtistId) || 0}`,
      deezerArtistId: Number(hints.deezerArtistId) || 0,
      artistName,
      title: albumTitle,
      releaseDate: "",
      year: Number(hints.year || item.year || 0),
      releaseType: (String(hints.releaseType || "album") as ReleaseType),
      genres: [],
      label: "",
      fans: 0,
      durationSec: Number(hints.durationSec || 0),
      trackCount: 1,
      discCount: 1,
      coverXL: "",
      coverBig: "",
      curation: [],
      tracks: [
        {
          id: item.id,
          deezerTrackId: Number(hints.deezerTrackId) || 0,
          title: item.title,
          disc: Number(hints.disc || 1),
          trackNumber: Number(hints.trackNumber || item.index || 1),
          durationSec: Number(hints.durationSec || item.fields?.duration || 0),
          explicit: false,
          artistName,
        },
      ],
    };
  }

  private searchAndRankCandidates(
    album: CanonicalAlbum,
    excluded: Set<string>,
    startMs: number,
    budgetMs: number
  ): {
    ordered: Array<{ cand: SourceCandidate; score: number }>;
    rawCount: number;
    deferredInFlight: boolean;
    incomplete?: boolean;
  } {
    // Indexers match words: punctuation and accents in a name ("AC/DC", "Beyoncé") and tags a
    // release name never carries ("(feat. ...)", "[From ...]") make a query match little or nothing.
    const cleanArtist = indexerQueryText(album.artistName) || album.artistName.trim();
    const cleanAlbum = indexerQueryText(coreReleaseTitle(album.title)) || stripEditionSuffix(album.title).trim();
    // Primary query without year captures both "(2001)" and undated album packs in ONE search;
    // only fall back sequentially to the other variants when the primary returned noisy
    // non-matching results and no well-matched release has been found yet.
    const queries: string[] = [`${cleanArtist} ${cleanAlbum}`];
    // "ACDC" beside "AC DC": some indexers only match the spelling a release name uses.
    const joinedArtist = joinedArtistSpelling(album.artistName);
    if (joinedArtist) {
      queries.push(`${joinedArtist} ${cleanAlbum}`);
    }
    if (album.year > 0) {
      queries.push(`${cleanArtist} ${cleanAlbum} ${album.year}`);
    }

    const interactive = budgetMs <= RESOLVE_STEP_BUDGET_MS;
    const byRef = new Map<string, SourceCandidate>();
    const rawCandidates: SourceCandidate[] = [];
    const emptyQueries: string[] = [];
    let hasWellMatched = false;
    let totalRawFromIndexer = 0;
    let incomplete = false;

    // A candidate is scored once per search, however often ranking asks: scoring a hundred
    // release names inside a sort is most of the 5 s a /resolve call is given.
    const scored = new Map<string, { accepted: boolean; score: number; reasons: string[] }>();
    // Scoring stops when the slice has used its time: a /resolve call cut off at 5 s keeps
    // nothing, so the names not reached are left out of this search rather than losing them all.
    const SCORING_DEADLINE_MS = 2600;
    let scoringStopped = false;
    let unscored = 0;
    const scoreOf = (cand: SourceCandidate, allowUnconfirmedTorrent: boolean) => {
      const usenet = isUsenetCandidate(cand);
      // The torrent option changes nothing for a Usenet release: one entry serves both askers.
      const key = usenet
        ? `u:${cand.title || ""}`
        : isPluginCandidate(cand)
        ? `p:${cand.title || ""}`
        : `${allowUnconfirmedTorrent ? 1 : 0}${cand.cached ? 1 : 0}${cand.infoHash || cand.magnet ? 1 : 0}:${cand.seeders ?? ""}:${cand.title || ""}`;
      let pre = scored.get(key);
      if (!pre) {
        if (!scoringStopped && scored.size % 8 === 0 && this.env.now() - startMs >= SCORING_DEADLINE_MS) {
          scoringStopped = true;
        }
        if (scoringStopped) {
          unscored++;
          return { accepted: false, score: 0, reasons: ["not scored: out of time"] };
        }
        pre = preScoreAlbumCandidate(
          cand,
          album,
          this.settings.qualityPreference,
          allowUnconfirmedTorrent ? { allowUnconfirmedTorrent: true } : undefined
        );
        scored.set(key, pre);
      }
      return pre;
    };

    const isWellMatched = (cand: SourceCandidate): boolean => {
      if (!isUsenetCandidate(cand) && !isPluginCandidate(cand) && !cand.cached && !cand.infoHash && !cand.magnet) return false;
      const pre = scoreOf(cand, true);
      return pre.accepted && pre.score >= 55;
    };

    const prioritizeForMemo = (cands: SourceCandidate[]): SourceCandidate[] => {
      if (cands.length <= SEARCH_MEMO_MAX_CANDIDATES) return cands;
      return cands
        .map((cand) => ({ cand, pre: scoreOf(cand, true) }))
        .sort((a, b) => {
          if (a.pre.accepted !== b.pre.accepted) return a.pre.accepted ? -1 : 1;
          return b.pre.score - a.pre.score;
        })
        .map((x) => x.cand);
    };

    // Always run query variants strictly sequentially; stop at the first query that yields
    // a well-matched release, and skip strictly narrower variants after a 0-result broader query.
    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      if (emptyQueries.some((prev) => isStrictlyNarrowerQuery(prev, q))) {
        continue;
      }
      const elapsed = this.env.now() - startMs;
      if (qi > 0 && interactive) {
        // A /resolve call is killed at 5 s and nothing it found is kept: a second search starts
        // only while there is clearly room for it and for ranking what it returns.
        if (elapsed >= 900) break;
      }
      const timeoutMs = interactive
        ? (qi === 0 ? 2500 : Math.max(800, Math.min(1500, 2400 - elapsed)))
        : 5000;
      const res = this.runMemoizedIndexerSearch(
        album.id,
        q,
        this.settings.newznabCategories,
        timeoutMs,
        interactive,
        prioritizeForMemo
      );
      if (res.deferredInFlight) {
        if (rawCandidates.length === 0) {
          return { ordered: [], rawCount: 0, deferredInFlight: true };
        }
        break;
      }
      totalRawFromIndexer += res.rawCount;
      this.env.log(
        "debug",
        `resolve-album: query ${album.id} "${q}" results=${res.rawCount} cached=${res.fromCache} incomplete=${res.incomplete} took=${res.elapsedMs}ms at=${this.env.now() - startMs}ms`
      );
      if (res.incomplete) incomplete = true;
      if (res.rawCount === 0) {
        emptyQueries.push(q);
      }
      for (const c of res.candidates) {
        const ref = candidateRefOf(c);
        if (excluded.has(ref)) continue;
        if (!byRef.has(ref)) {
          byRef.set(ref, c);
          rawCandidates.push(c);
          if (!hasWellMatched && isWellMatched(c)) {
            hasWellMatched = true;
          }
        }
      }
      if (hasWellMatched) break;
      if (res.errored) break;
      if (!res.fromCache && interactive && res.elapsedMs >= 1400) break;
    }

    if (rawCandidates.length === 0) {
      return { ordered: [], rawCount: totalRawFromIndexer, deferredInFlight: false, incomplete };
    }

    // Batch debrid_check for top torrent infoHashes (capped at 25, prioritizing lossless + seeders)
    // so popular albums never burn the 5s route budget checking 80+ obscure torrents.
    const torrentCands = rawCandidates
      .filter((c) => Boolean(c.infoHash) && !c.cached)
      .sort((a, b) => {
        const qa = classifyReleaseQuality(a.title || "").points;
        const qb = classifyReleaseQuality(b.title || "").points;
        if (qb !== qa) return qb - qa;
        return (b.seeders || 0) - (a.seeders || 0);
      });
    const hashesToCheck: string[] = [];
    const seenHash = new Set<string>();
    for (const c of torrentCands) {
      const h = c.infoHash!.toLowerCase();
      if (seenHash.has(h)) continue;
      seenHash.add(h);
      hashesToCheck.push(h);
      if (hashesToCheck.length >= 25) break;
    }
    if (hashesToCheck.length > 0) {
      const checkRes = this.env.sources.resolve({
        kind: "debrid_check",
        infoHashes: hashesToCheck,
      });
      const cachedSet = new Set<string>();
      for (const hit of checkRes?.candidates || []) {
        if (hit.infoHash && hit.cached) cachedSet.add(hit.infoHash.toLowerCase());
      }
      for (const c of rawCandidates) {
        if (c.infoHash && cachedSet.has(c.infoHash.toLowerCase())) {
          c.cached = true;
        }
      }
    }

    // Pre-rank candidates (rejecting compilations, discographies, live bootlegs, lossy if lossless_only).
    const preRanked: Array<{ cand: SourceCandidate; score: number }> = [];
    for (const cand of rawCandidates) {
      const isUsenet = isUsenetCandidate(cand);
      if (!isUsenet && !cand.cached && !isPluginCandidate(cand)) continue;

      const pre = scoreOf(cand, false);
      if (!pre.accepted) continue;
      preRanked.push({ cand, score: pre.score });
    }

    preRanked.sort((a, b) => b.score - a.score);
    // Guarantee cached Debrid candidates are probed first (up to 6) before Usenet NZB fetches,
    // and deduplicate Usenet candidates by normalized release title so 4 identical scene RAR reposts
    // never burn all probe slots ahead of unpacked P2P releases.
    const debridRanked = preRanked.filter((x) => !isUsenetCandidate(x.cand) && !isPluginCandidate(x.cand));
    // Source-plugin releases (a peer-to-peer network behind a plugin) are the last resort:
    // they are asked only after everything Usenet and Debrid offered.
    const pluginRanked = preRanked.filter((x) => isPluginCandidate(x.cand));
    const usenetAll = preRanked.filter((x) => isUsenetCandidate(x.cand));
    const usenetDedup: Array<{ cand: SourceCandidate; score: number }> = [];
    const seenUsenetTitle = new Set<string>();
    for (const u of usenetAll) {
      const tk = normalizeText(u.cand.title || "");
      if (tk && seenUsenetTitle.has(tk)) continue;
      if (tk) seenUsenetTitle.add(tk);
      usenetDedup.push(u);
    }

    // Real-Debrid, AllDebrid, and Debrid-Link return ErrUnsupported from bulk debrid_check,
    // so debrid_check reports cached=false for every hash even when torrents are cached.
    // When bulk debrid_check confirmed 0 cached torrents, pass the top 4 well-matched torrents
    // to release_files so Ether's ListReleaseFiles can probe cache & file lists on demand.
    const unconfirmedDebrid: Array<{ cand: SourceCandidate; score: number }> = [];
    if (debridRanked.length === 0) {
      for (const cand of rawCandidates) {
        if (isUsenetCandidate(cand) || cand.cached) continue;
        if (!cand.infoHash && !cand.magnet) continue;
        const pre = scoreOf(cand, true);
        if (!pre.accepted || pre.score < 45) continue;
        unconfirmedDebrid.push({ cand, score: pre.score });
      }
      unconfirmedDebrid.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.cand.seeders || 0) - (a.cand.seeders || 0);
      });
    }

    const ordered = [
      ...debridRanked.slice(0, 6),
      ...usenetDedup.slice(0, MAX_USENET_PROBES),
      ...unconfirmedDebrid.slice(0, 4),
      ...pluginRanked.slice(0, MAX_PLUGIN_PROBES),
    ];
    this.env.log(
      "info",
      `resolve-album: ${album.id} raw=${rawCandidates.length} debridChecked=${hashesToCheck.length} preRanked=${preRanked.length} debrid=${debridRanked.length} usenet=${usenetDedup.length} unconfirmedDebrid=${Math.min(4, unconfirmedDebrid.length)} plugin=${pluginRanked.length}${unscored > 0 ? ` unscored=${unscored}` : ""} took=${this.env.now() - startMs}ms`
    );
    return { ordered, rawCount: totalRawFromIndexer, deferredInFlight: false, incomplete };
  }

  /**
   * On-demand sampled NNTP availability check (#665) for a matched Usenet NZB candidate.
   * Respects the 20/min/plugin rate limit (capped per album), refuses background execution,
   * and gracefully degrades to "unknown" on older hosts or transient/429 errors.
   */
  private checkUsenetAvailability(
    albumId: string,
    cand: SourceCandidate,
    stage: ResolveStage,
    allowUsenetCheck: boolean,
    startMs: number
  ): "available" | "dead" | "unknown" | "defer" {
    if (!allowUsenetCheck || stage.usenetCheckDisabled || !cand.nzbUrl) return "unknown";
    const used = stage.usenetChecksUsed || 0;
    if (used >= MAX_USENET_CHECKS_PER_ALBUM) return "unknown";
    // Too late in this slice to fit inside Ether's 5 s deadline: check first thing next slice.
    if (this.env.now() - startMs >= USENET_CHECK_START_CUTOFF_MS) return "defer";

    stage.usenetChecksUsed = used + 1;
    try {
      const res = this.env.sources.resolve({
        kind: "usenet_check",
        candidate: cand,
        nzbUrl: cand.nzbUrl,
      });
      const verdict = res?.candidates?.[0]?.usenetCheck;
      if (!verdict || typeof verdict.available !== "boolean") {
        return "unknown";
      }
      if (!verdict.available) {
        this.env.log(
          "info",
          `resolve-album: drop dead usenet ${albumId} "${(cand.title || "").slice(0, 60)}" reason=${verdict.reason || "unavailable"} missing=${verdict.missing}/${verdict.checked} cached=${Boolean(verdict.cached)} playbackFailed=${Boolean(verdict.playbackFailed)}`
        );
        return "dead";
      }
      this.env.log(
        "info",
        `resolve-album: usenet_check ok ${albumId} "${(cand.title || "").slice(0, 60)}" checked=${verdict.checked} missing=${verdict.missing} cached=${Boolean(verdict.cached)}`
      );
      return "available";
    } catch (err) {
      rethrowHostFault(err);
      // Older Ether versions without usenet_check or rate_limited (429): disable for the
      // remainder of this resolve and keep the candidate rather than failing playback.
      stage.usenetCheckDisabled = true;
      this.env.log("debug", `resolve-album: usenet_check skipped (${String(err).slice(0, 120)})`);
      return "unknown";
    }
  }

  /** A candidate's release_files: the answer kept from the slice that deferred its usenet_check,
   * else asked now. Null when listing failed. */
  private listReleaseFiles(stage: { listed?: ListedCandidate }, cand: SourceCandidate): ListedCandidate | null {
    const ref = candidateRefOf(cand);
    const kept = stage.listed;
    stage.listed = undefined;
    if (kept && kept.ref === ref) return kept;
    let files: ReleaseFile[] = [];
    let cached = Boolean(cand.cached);
    try {
      const res = this.env.sources.resolve({
        kind: "release_files",
        candidate: cand,
        infoHash: cand.infoHash,
        magnet: cand.magnet,
      });
      const first = res?.candidates?.[0];
      if (first?.files && Array.isArray(first.files)) {
        files = first.files;
      }
      if (typeof first?.cached === "boolean") {
        cached = first.cached;
      } else if (files.length > 0) {
        cached = true;
      }
    } catch (err) {
      rethrowHostFault(err);
      return null;
    }
    return { ref, files, cached };
  }

  /** Keeps a candidate's listing and rewinds to it: its usenet_check runs first next slice. */
  private deferProbe(stage: { listed?: ListedCandidate; nextIdx: number }, listed: ListedCandidate): true {
    stage.listed = listed;
    stage.nextIdx--;
    return true;
  }

  private probeSingleCandidate(
    stage: ResolveStage,
    cand: SourceCandidate,
    preScore: number,
    allowUsenetCheck: boolean,
    startMs: number
  ): boolean {
    const album = stage.album;
    const verified = stage.verified;
    const archiveFallbacks = stage.archiveFallbacks;
    const debridFallbacks = stage.debridFallbacks || (stage.debridFallbacks = []);

    const listAt = this.env.now();
    const listed = this.listReleaseFiles(stage, cand);
    if (!listed) return false;
    const files = listed.files;
    const isCached = listed.cached;
    const listedMs = this.env.now() - listAt;

    const isUsenet = isUsenetCandidate(cand);
    if (!isUsenet && !isCached) return false;
    if (files.length === 0) {
      // Cached Debrid torrent whose provider did not return a file list: keep a structured
      // release.track fallback so Ether's debrid.ChooseFile can select the track at acquire time.
      if (!isUsenet && isCached && preScore >= 55) {
        const qual = classifyReleaseQuality(cand.title || "", undefined, this.settings.qualityPreference);
        if (qual.points >= 0) {
          const trackMap: Record<string, TrackFileMapping> = {};
          for (const tr of album.tracks) {
            trackMap[tr.id] = {
              track: buildArchiveTrackHint(tr),
              size: 0,
              mime: qual.mime,
              confidence: 0.65,
            };
          }
          debridFallbacks.push({
            releaseId: candidateRefOf(cand),
            sourceKind: "debrid",
            qualityTier: qual.tier,
            codec: qual.codec,
            mime: qual.mime,
            label: `${qual.label} · Debrid`,
            score: Math.round(preScore * 0.65 * 10) / 10,
            candidate: { ...cand, cached: true },
            isUnconfirmedDebridFallback: true,
            tracks: trackMap,
          });
        }
      }
      return false;
    }

    const matchAt = this.env.now();
    const match = matchAlbumReleaseFiles(album, cand.title || "", files, this.settings.qualityPreference, {
      allowPartial: isPluginCandidate(cand),
    });
    this.env.log(
      "debug",
      `resolve-album: probe ${album.id} "${(cand.title || "").slice(0, 60)}" files=${files.length} listed in ${listedMs}ms matched in ${this.env.now() - matchAt}ms at=${this.env.now() - startMs}ms`
    );
    const archiveFiles = files.filter((f) => isArchivePath(f.path));
    const expandedAudioFiles = files.flatMap((f) =>
      Array.isArray(f.members)
        ? f.members.filter((m) => Boolean(m?.path && audioFormatOfPath(m.path)))
        : []
    );
    const totalMembers = files.reduce((n, f) => n + (Array.isArray(f.members) ? f.members.length : 0), 0);
    if (archiveFiles.length > 0) {
      const archExts = Array.from(
        new Set(archiveFiles.map((f) => f.path.split(".").pop()?.toLowerCase() || ""))
      ).join(",");
      this.env.log(
        "debug",
        `resolve-album: archive ${album.id} "${(cand.title || "").slice(0, 60)}" exts=${archExts} vols=${archiveFiles.length} members=${totalMembers} audioMembers=${expandedAudioFiles.length} matched=${match.matched} reason=${match.reason || "ok"}`
      );
    }

    if (match.matched) {
      let healthBonus = 0;
      if (isUsenet) {
        const health = this.checkUsenetAvailability(album.id, cand, stage, allowUsenetCheck, startMs);
        if (health === "defer") return this.deferProbe(stage, listed);
        if (health === "dead") {
          return false;
        }
        if (health === "available") {
          healthBonus = 8;
        }
      }
      const isPlugin = isPluginCandidate(cand);
      const srcTag = isUsenet ? (match.isArchive ? "Usenet Archive" : "Usenet") : isPlugin ? (cand.indexer || "Source plugin") : "Debrid";
      const coverageBonus = match.partial ? 0 : 35;
      const archivePenalty = match.isArchive ? -3 : 0;
      verified.push({
        releaseId: candidateRefOf(cand),
        sourceKind: isUsenet ? "usenet" : isPlugin ? "plugin" : "debrid",
        qualityTier: match.quality.tier,
        codec: match.quality.codec,
        mime: match.quality.mime,
        label: `${match.quality.label} · ${srcTag}`,
        score: Math.round((preScore + coverageBonus + healthBonus + archivePenalty + match.averageConfidence * 40 + match.quality.points * 0.5) * 10) / 10,
        candidate: isUsenet || isPlugin ? cand : { ...cand, cached: true },
        tracks: match.tracks,
      });
      return false;
    }

    // Complete expanded member listing (single-volume archive — including inspected archives
    // with zero audio members — or multi-volume listing covering >= canonical track count)
    // already revealed the real members and failed album matching. Multi-volume RARs where only
    // volume 1 was peeked still qualify for the structured release.track fallback unless quality
    // itself was rejected.
    const expandedCompleteListing =
      (expandedAudioFiles.length > 0 &&
        (archiveFiles.length <= 1 || expandedAudioFiles.length >= album.tracks.length)) ||
      (archiveFiles.length <= 1 && totalMembers > 0 && expandedAudioFiles.length === 0);
    const expandedQualityRejected =
      expandedAudioFiles.length > 0 &&
      classifyReleaseQuality(cand.title || "", expandedAudioFiles, this.settings.qualityPreference).points < 0;

    if (!isUsenet || archiveFiles.length === 0 || expandedCompleteListing) {
      this.env.log(
        "debug",
        `resolve-album: reject ${album.id} [${isUsenet ? "usenet" : isPluginCandidate(cand) ? "plugin" : "debrid"}] "${(cand.title || "").slice(0, 60)}" files=${files.length} reason=${match.reason || "unmatched"}`
      );
    }

    // Archive-packed Usenet fallback when NZB lists .rar/.zip/.7z volumes without a complete
    // expanded audio listing (e.g. uninspected archive or partial multi-volume RAR peek).
    // A partial listing can still show the release is something else (a single packed twice,
    // another album): a track picked from it by name would be wrong or ambiguous.
    const expandedContradictsAlbum = archiveMembersContradictAlbum(album, expandedAudioFiles);
    if (expandedContradictsAlbum && isUsenet && archiveFiles.length > 0 && !expandedCompleteListing) {
      this.env.log(
        "debug",
        `resolve-album: reject ${album.id} [usenet] "${(cand.title || "").slice(0, 60)}" files=${files.length} reason=archive members are not this album`
      );
    }
    if (
      verified.length === 0 &&
      !expandedCompleteListing &&
      !expandedQualityRejected &&
      !expandedContradictsAlbum &&
      isUsenet &&
      archiveFiles.length > 0 &&
      preScore >= 60
    ) {
      const qual = classifyReleaseQuality(cand.title || "", undefined, this.settings.qualityPreference);
      if (qual.points >= 0) {
        const health = this.checkUsenetAvailability(album.id, cand, stage, allowUsenetCheck, startMs);
        if (health === "defer") return this.deferProbe(stage, listed);
        if (health === "dead") {
          return false;
        }
        const healthBonus = health === "available" ? 8 : 0;
        const trackMap: Record<string, TrackFileMapping> = {};
        for (const tr of album.tracks) {
          trackMap[tr.id] = {
            track: buildArchiveTrackHint(tr),
            size: 0,
            mime: qual.mime,
            confidence: 0.65,
          };
        }
        archiveFallbacks.push({
          releaseId: candidateRefOf(cand),
          sourceKind: "usenet",
          qualityTier: qual.tier,
          codec: qual.codec,
          mime: qual.mime,
          label: `${qual.label} · Usenet Archive`,
          score: Math.round((preScore * 0.65 + healthBonus) * 10) / 10,
          candidate: cand,
          isArchiveFallback: true,
          tracks: trackMap,
        });
      }
    }
    return false;
  }

  private buildTrackSources(
    item: KindItem,
    releases: VerifiedAlbumRelease[],
    excluded: Set<string>
  ): PlayableSource[] {
    const hints = (item.hints || {}) as Record<string, unknown>;
    const durationSec = Number(hints.durationSec || item.fields?.duration || 0) || undefined;
    const sources: PlayableSource[] = [];

    for (let i = 0; i < releases.length; i++) {
      const rel = releases[i];
      if (excluded.has(rel.releaseId) || excluded.has(`src-${i}-${rel.releaseId}`)) continue;
      const trackMap = rel.tracks[item.id];
      if (!trackMap) continue;

      const releaseHint: PlayableSource["release"] = {
        candidate: rel.candidate,
      };
      if (rel.isArchiveFallback || rel.isUnconfirmedDebridFallback) {
        // Archive or file-list-less Debrid fallback: send structured release.track
        // for fuzzy scene-track matching instead of a synthetic fileHint (Issue #753).
        const trackHint = trackMap.track || buildTrackHintFromItem(item);
        if (trackHint) {
          releaseHint.track = trackHint;
        }
      } else if (trackMap.isArchiveMember) {
        // Expanded archive member from release_files[].members: pass exact inner member
        // path as release.fileHint only (never fileIndex/file, which select outer NZB files).
        releaseHint.fileHint = trackMap.fileHint || trackMap.file;
      } else {
        if (typeof trackMap.fileIndex === "number") {
          releaseHint.fileIndex = trackMap.fileIndex;
        }
        if (trackMap.file) {
          releaseHint.file = trackMap.file;
        }
        releaseHint.fileHint = trackMap.fileHint || trackMap.file;
      }

      sources.push({
        id: rel.releaseId,
        label: rel.label,
        pattern: "release",
        mime: trackMap.mime || rel.mime,
        // NZB release_files sizes are yEnc-encoded article sums (~2-3% larger than decoded
        // payload bytes), which would trip kindstream's exact-size digest check on Usenet.
        size: rel.sourceKind === "usenet" ? undefined : (trackMap.size > 0 ? trackMap.size : undefined),
        durationSec,
        release: releaseHint,
      });
    }

    return sources;
  }

  /**
   * Resolve a playable video concert (level: "concert", id: "co-*") across video/music-video
   * Newznab categories (2000,2040,2045,3020,5000), Debrid cache check, release_files main-video
   * verification, and on-demand usenet_check — bounded per step like resolveAlbum().
   */
  private resolveConcert(req: KindResolveRequest): KindResolveResponse {
    const item = req.item;
    const concertId = item.id;
    const excluded = new Set(
      (Array.isArray(req.client?.exclude) ? req.client!.exclude : []).map((s) => String(s))
    );

    const cached = this.cache.get<CachedConcertResolution>(concertCacheKey(concertId));
    if (cached) {
      if (cached.negative) {
        return { sources: [], ttlSec: this.negativeResponseTtlSec(cached) };
      }
      const sources = this.buildConcertSources(item, cached.releases, excluded);
      if (sources.length > 0) {
        return { sources, ttlSec: 3600 };
      }
      if (excluded.size > 0) {
        this.cache.delete(concertCacheKey(concertId));
        this.cache.delete(concertStageKey(concertId));
      } else {
        return { sources: [], ttlSec: NEGATIVE_RESPONSE_EMPTY_TTL_SEC };
      }
    }

    const step = this.stepResolveConcert(concertId, item, excluded, RESOLVE_STEP_BUDGET_MS, true);
    if (!step.done) {
      return {
        pending: true,
        retryInMs: step.retryInMs ?? 250,
        sources: [],
      };
    }
    if (step.inconclusive) return { sources: [], ttlSec: 30 };

    const fresh = this.cache.get<CachedConcertResolution>(concertCacheKey(concertId));
    if (!fresh || fresh.releases.length === 0) {
      return {
        sources: [],
        ttlSec: fresh ? this.negativeResponseTtlSec(fresh) : NEGATIVE_RESPONSE_EMPTY_TTL_SEC,
      };
    }
    return { sources: this.buildConcertSources(item, fresh.releases, excluded), ttlSec: 3600 };
  }

  private loadConcertTarget(concertId: string, item: KindItem): ConcertResolveTarget | null {
    const curated =
      getCuratedConcertById(concertId) ||
      this.cache.get<CuratedConcert>(`concert_meta_v1:${concertId}`);
    if (curated) {
      return {
        id: concertId,
        artistName: curated.artistName,
        title: curated.title,
        year: curated.year,
        filmedYear: curated.filmedYear,
        durationSec: curated.durationSec,
        imdbId: curated.imdbId,
        standaloneTitle: curated.standaloneTitle,
      };
    }
    const hints = (item.hints || {}) as Record<string, unknown>;
    const artistName = String(hints.artistName || item.fields?.artistName || "").trim();
    const title = String(hints.concertTitle || item.title || "").trim();
    if (!title) return null;
    return {
      id: concertId,
      artistName,
      title,
      year: Number(hints.year || item.year || 0),
      filmedYear: Number(hints.filmedYear || hints.year || item.year || 0),
      durationSec: Number(hints.durationSec || item.fields?.duration || 0),
      imdbId: hints.imdbId ? String(hints.imdbId) : undefined,
      standaloneTitle: Boolean(hints.standaloneTitle),
    };
  }

  private searchAndRankConcertCandidates(
    concert: ConcertResolveTarget,
    excluded: Set<string>,
    startMs: number,
    budgetMs: number
  ): {
    ordered: Array<{ cand: SourceCandidate; score: number }>;
    rawCount: number;
    deferredInFlight: boolean;
    incomplete?: boolean;
  } {
    const cleanArtist = concert.artistName.trim();
    const cleanTitle = stripEditionSuffix(concert.title).trim();
    const shortTitle = cleanTitle.split(/[:\-–—]/)[0].trim() || cleanTitle;

    const queries: string[] = [];
    const addQuery = (q: string) => {
      const cleaned = q.replace(/\s+/g, " ").trim();
      if (cleaned && !queries.includes(cleaned)) queries.push(cleaned);
    };

    if (concert.standaloneTitle) {
      // Standalone theatrical concert films (e.g. "Stop Making Sense 1984", "The Last Waltz 1978")
      addQuery(concert.year > 0 ? `${shortTitle} ${concert.year}` : shortTitle);
      if (cleanArtist) addQuery(`${cleanArtist} ${shortTitle}`);
    } else {
      if (cleanArtist) {
        addQuery(`${cleanArtist} ${shortTitle}`);
        if (cleanTitle !== shortTitle) addQuery(`${cleanArtist} ${cleanTitle}`);
        if (concert.year > 0) addQuery(`${cleanArtist} ${shortTitle} ${concert.year}`);
      } else {
        addQuery(concert.year > 0 ? `${cleanTitle} ${concert.year}` : cleanTitle);
      }
    }

    const interactive = budgetMs <= RESOLVE_STEP_BUDGET_MS;
    const byRef = new Map<string, SourceCandidate>();
    const rawCandidates: SourceCandidate[] = [];
    const emptyQueries: string[] = [];
    let hasWellMatched = false;
    let totalRawFromIndexer = 0;
    let incomplete = false;

    const isWellMatched = (cand: SourceCandidate): boolean => {
      if (!isUsenetCandidate(cand) && !cand.cached && !cand.infoHash && !cand.magnet) return false;
      const pre = preScoreConcertCandidate(cand, concert, this.settings.videoQualityPreference, {
        allowUnconfirmedTorrent: true,
      });
      return pre.accepted && pre.score >= 55;
    };

    const prioritizeForMemo = (cands: SourceCandidate[]): SourceCandidate[] => {
      if (cands.length <= SEARCH_MEMO_MAX_CANDIDATES) return cands;
      return [...cands].sort((a, b) => {
        const pa = preScoreConcertCandidate(a, concert, this.settings.videoQualityPreference, { allowUnconfirmedTorrent: true });
        const pb = preScoreConcertCandidate(b, concert, this.settings.videoQualityPreference, { allowUnconfirmedTorrent: true });
        if (pa.accepted !== pb.accepted) return pa.accepted ? -1 : 1;
        return pb.score - pa.score;
      });
    };

    for (let qi = 0; qi < queries.length; qi++) {
      const q = queries[qi];
      if (emptyQueries.some((prev) => isStrictlyNarrowerQuery(prev, q))) {
        continue;
      }
      const elapsed = this.env.now() - startMs;
      if (qi > 0 && interactive) {
        if (elapsed >= 1400) break;
      }
      const timeoutMs = interactive
        ? (qi === 0 ? 2500 : Math.max(800, Math.min(1800, 3200 - elapsed)))
        : 5000;
      const res = this.runMemoizedIndexerSearch(
        concert.id,
        q,
        this.settings.concertNewznabCategories,
        timeoutMs,
        interactive,
        prioritizeForMemo
      );
      if (res.deferredInFlight) {
        if (rawCandidates.length === 0) {
          return { ordered: [], rawCount: 0, deferredInFlight: true };
        }
        break;
      }
      totalRawFromIndexer += res.rawCount;
      if (res.incomplete) incomplete = true;
      if (res.rawCount === 0) {
        emptyQueries.push(q);
      }
      for (const c of res.candidates) {
        const ref = candidateRefOf(c);
        if (excluded.has(ref)) continue;
        if (!byRef.has(ref)) {
          byRef.set(ref, c);
          rawCandidates.push(c);
          if (!hasWellMatched && isWellMatched(c)) {
            hasWellMatched = true;
          }
        }
      }
      if (hasWellMatched) break;
      if (res.errored) break;
      if (!res.fromCache && interactive && res.elapsedMs >= 1400) break;
    }

    if (rawCandidates.length === 0) {
      return { ordered: [], rawCount: totalRawFromIndexer, deferredInFlight: false, incomplete };
    }

    // Batch debrid_check for top 25 video torrent infoHashes sorted by video quality + seeders.
    const torrentCands = rawCandidates
      .filter((c) => Boolean(c.infoHash) && !c.cached)
      .sort((a, b) => {
        const qa = classifyVideoQuality(a.title || "", undefined, this.settings.videoQualityPreference).points;
        const qb = classifyVideoQuality(b.title || "", undefined, this.settings.videoQualityPreference).points;
        if (qb !== qa) return qb - qa;
        return (b.seeders || 0) - (a.seeders || 0);
      });
    const hashesToCheck: string[] = [];
    const seenHash = new Set<string>();
    for (const c of torrentCands) {
      const h = c.infoHash!.toLowerCase();
      if (seenHash.has(h)) continue;
      seenHash.add(h);
      hashesToCheck.push(h);
      if (hashesToCheck.length >= 25) break;
    }
    if (hashesToCheck.length > 0) {
      const checkRes = this.env.sources.resolve({
        kind: "debrid_check",
        infoHashes: hashesToCheck,
      });
      const cachedSet = new Set<string>();
      for (const hit of checkRes?.candidates || []) {
        if (hit.infoHash && hit.cached) cachedSet.add(hit.infoHash.toLowerCase());
      }
      for (const c of rawCandidates) {
        if (c.infoHash && cachedSet.has(c.infoHash.toLowerCase())) {
          c.cached = true;
        }
      }
    }

    const preRanked: Array<{ cand: SourceCandidate; score: number }> = [];
    for (const cand of rawCandidates) {
      const isUsenet = isUsenetCandidate(cand);
      if (!isUsenet && !cand.cached) continue;
      const pre = preScoreConcertCandidate(cand, concert, this.settings.videoQualityPreference);
      if (!pre.accepted) continue;
      preRanked.push({ cand, score: pre.score });
    }

    preRanked.sort((a, b) => b.score - a.score);
    const debridRanked = preRanked.filter((x) => !isUsenetCandidate(x.cand));
    const usenetAll = preRanked.filter((x) => isUsenetCandidate(x.cand));
    const usenetDedup: Array<{ cand: SourceCandidate; score: number }> = [];
    const seenTitle = new Set<string>();
    for (const u of usenetAll) {
      const tk = normalizeText(u.cand.title || "");
      if (tk && seenTitle.has(tk)) continue;
      if (tk) seenTitle.add(tk);
      usenetDedup.push(u);
    }

    const orderedDebrid = debridRanked.slice(0, 6);
    const unconfirmedDebrid: Array<{ cand: SourceCandidate; score: number }> = [];
    if (orderedDebrid.length === 0) {
      for (const cand of rawCandidates) {
        if (isUsenetCandidate(cand) || cand.cached) continue;
        if (!cand.infoHash && !cand.magnet) continue;
        const pre = preScoreConcertCandidate(cand, concert, this.settings.videoQualityPreference, {
          allowUnconfirmedTorrent: true,
        });
        if (!pre.accepted || pre.score < 55) continue;
        unconfirmedDebrid.push({ cand, score: pre.score });
      }
      unconfirmedDebrid.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (b.cand.seeders || 0) - (a.cand.seeders || 0);
      });
    }

    const ordered = [
      ...orderedDebrid,
      ...usenetDedup.slice(0, MAX_USENET_PROBES),
      ...unconfirmedDebrid.slice(0, 4),
    ];
    this.env.log(
      "info",
      `resolve-concert: ${concert.id} raw=${rawCandidates.length} debridChecked=${hashesToCheck.length} preRanked=${preRanked.length} debrid=${debridRanked.length} usenet=${usenetDedup.length} unconfirmedDebrid=${Math.min(4, unconfirmedDebrid.length)}`
    );
    return { ordered, rawCount: totalRawFromIndexer, deferredInFlight: false, incomplete };
  }

  private stepResolveConcert(
    concertId: string,
    item: KindItem,
    excluded: Set<string>,
    budgetMs: number,
    allowUsenetCheck: boolean
  ): { done: boolean; verifiedCount: number; retryInMs?: number; inconclusive?: boolean } {
    const startMs = this.env.now();
    const excludedSig = Array.from(excluded).sort().join("|");
    let stage = this.cache.get<ConcertResolveStage>(concertStageKey(concertId));
    if (stage && stage.excludedSig !== excludedSig) {
      stage = null;
    }

    if (!stage) {
      this.cache.sweepLegacyBloat(64);
      const concert = this.loadConcertTarget(concertId, item);
      if (!concert) {
        this.env.log("warn", `resolve-concert: could not load metadata for ${concertId}`);
        return { done: true, verifiedCount: 0 };
      }

      this.env.log(
        "info",
        `resolve-concert: search ${concert.id} "${concert.artistName} - ${concert.title}" (${concert.year})`
      );
      const searched = this.searchAndRankConcertCandidates(concert, excluded, startMs, budgetMs);
      if (searched.deferredInFlight) {
        return { done: false, verifiedCount: 0, retryInMs: 350 };
      }
      if (searched.incomplete && searched.ordered.length === 0) {
        return this.inconclusive(concertId);
      }
      stage = {
        concert,
        preRanked: searched.ordered.slice(0, MAX_FILE_LIST_PROBES),
        nextIdx: 0,
        verified: [],
        archiveFallbacks: [],
        debridFallbacks: [],
        excludedSig,
        rawCandidateCount: searched.rawCount,
        searchIncomplete: searched.incomplete || undefined,
        usenetChecksUsed: 0,
        usenetCheckDisabled: false,
      };
      this.cache.set(concertStageKey(concertId), stage, STAGE_CACHE_TTL_MS);

      if (stage.preRanked.length === 0) {
        return this.finalizeConcertResolution(concertId, stage);
      }
      if (this.env.now() - startMs >= budgetMs) {
        return { done: false, verifiedCount: 0 };
      }
    }

    while (stage.nextIdx < stage.preRanked.length) {
      const hasHd = stage.verified.some((v) => v.qualityTier === "uhd" || v.qualityTier === "1080p");
      if (stage.verified.length >= MAX_CACHED_RELEASES && hasHd) {
        break;
      }
      if (stage.nextIdx > 0 && this.env.now() - startMs >= budgetMs) {
        if (stage.verified.length > 0) break;
        this.cache.set(concertStageKey(concertId), stage, STAGE_CACHE_TTL_MS);
        return { done: false, verifiedCount: 0 };
      }

      const { cand, score: preScore } = stage.preRanked[stage.nextIdx];
      if (isUsenetCandidate(cand) && this.env.now() - startMs >= 900) {
        if (stage.verified.length > 0) break;
        this.cache.set(concertStageKey(concertId), stage, STAGE_CACHE_TTL_MS);
        return { done: false, verifiedCount: 0 };
      }
      if (!isUsenetCandidate(cand) && !cand.cached && this.env.now() - startMs >= 1500) {
        if (stage.verified.length > 0) break;
        this.cache.set(concertStageKey(concertId), stage, STAGE_CACHE_TTL_MS);
        return { done: false, verifiedCount: 0 };
      }
      stage.nextIdx++;
      if (this.probeSingleConcertCandidate(stage, cand, preScore, allowUsenetCheck, startMs)) {
        if (stage.verified.length > 0) break;
        this.cache.set(concertStageKey(concertId), stage, STAGE_CACHE_TTL_MS);
        return { done: false, verifiedCount: 0 };
      }

      // Fast-finish on first verified HD/4K concert film (Debrid or Usenet).
      if (
        stage.verified.some(
          (v) =>
            !v.isArchiveFallback &&
            !v.isUnconfirmedDebridFallback &&
            (v.qualityTier === "uhd" || v.qualityTier === "1080p")
        )
      ) {
        break;
      }
    }

    return this.finalizeConcertResolution(concertId, stage);
  }

  private probeSingleConcertCandidate(
    stage: ConcertResolveStage,
    cand: SourceCandidate,
    preScore: number,
    allowUsenetCheck: boolean,
    startMs: number
  ): boolean {
    const listed = this.listReleaseFiles(stage, cand);
    if (!listed) return false;
    const files = listed.files;
    const isCached = listed.cached;

    const isUsenet = isUsenetCandidate(cand);
    if (!isUsenet && !isCached) return false;
    if (files.length === 0) {
      if (!isUsenet && isCached && preScore >= 60) {
        const qual = classifyVideoQuality(cand.title || "", undefined, this.settings.videoQualityPreference);
        const debridFallbacks = stage.debridFallbacks || (stage.debridFallbacks = []);
        debridFallbacks.push({
          releaseId: candidateRefOf(cand),
          sourceKind: "debrid",
          qualityTier: qual.tier,
          codec: qual.codec,
          mime: qual.mime,
          label: `${qual.label} · Debrid`,
          score: Math.round(preScore * 0.65 * 10) / 10,
          candidate: { ...cand, cached: true },
          isUnconfirmedDebridFallback: true,
          size: 0,
        });
      }
      return false;
    }

    const match = matchConcertReleaseFiles(cand.title || "", files, this.settings.videoQualityPreference);
    if (match.matched && match.file) {
      let healthBonus = 0;
      if (isUsenet) {
        const health = this.checkUsenetAvailability(
          stage.concert.id,
          cand,
          stage as unknown as ResolveStage,
          allowUsenetCheck,
          startMs
        );
        if (health === "defer") return this.deferProbe(stage, listed);
        if (health === "dead") return false;
        if (health === "available") healthBonus = 8;
      }
      const srcTag = isUsenet ? (match.file.isArchiveMember ? "Usenet Archive" : "Usenet") : "Debrid";
      const archivePenalty = match.file.isArchiveMember ? -3 : 0;
      stage.verified.push({
        releaseId: candidateRefOf(cand),
        sourceKind: isUsenet ? "usenet" : "debrid",
        qualityTier: match.quality.tier,
        codec: match.quality.codec,
        mime: match.quality.mime,
        label: `${match.quality.label} · ${srcTag}`,
        score: Math.round((preScore + healthBonus + archivePenalty + match.quality.points * 0.5) * 10) / 10,
        candidate: isUsenet ? cand : { ...cand, cached: true },
        isArchiveMember: match.file.isArchiveMember,
        fileIndex: match.file.isArchiveMember ? undefined : match.file.index,
        file: match.file.isArchiveMember ? undefined : match.file.path,
        fileHint: match.file.path,
        size: match.file.size,
      });
      return false;
    }

    const expandedHasVideo = files.some(
      (f) =>
        Array.isArray(f.members) &&
        f.members.some((m) => Boolean(m?.path && videoFormatOfPath(m.path)))
    );
    // Archive-packed Usenet fallback when NZB lists RAR volumes without expanded video members.
    if (
      stage.verified.length === 0 &&
      !expandedHasVideo &&
      isUsenet &&
      files.some((f) => isArchivePath(f.path)) &&
      preScore >= 65
    ) {
      const health = this.checkUsenetAvailability(
        stage.concert.id,
        cand,
        stage as unknown as ResolveStage,
        allowUsenetCheck,
        startMs
      );
      if (health === "defer") return this.deferProbe(stage, listed);
        if (health === "dead") return false;
      const healthBonus = health === "available" ? 8 : 0;
      const qual = classifyVideoQuality(cand.title || "", undefined, this.settings.videoQualityPreference);
      stage.archiveFallbacks.push({
        releaseId: candidateRefOf(cand),
        sourceKind: "usenet",
        qualityTier: qual.tier,
        codec: qual.codec,
        mime: qual.mime,
        label: `${qual.label} · Usenet Archive`,
        score: Math.round((preScore * 0.65 + healthBonus) * 10) / 10,
        candidate: cand,
        isArchiveFallback: true,
        size: 0,
      });
    }
    return false;
  }

  private finalizeConcertResolution(
    concertId: string,
    stage: ConcertResolveStage
  ): { done: boolean; verifiedCount: number; retryInMs?: number; inconclusive?: boolean } {
    stage.verified.sort((a, b) => b.score - a.score);
    let finalReleases: VerifiedConcertRelease[];
    if (stage.verified.length > 0) {
      finalReleases = stage.verified.slice(0, MAX_CACHED_RELEASES);
    } else {
      const archiveFallbacks = [...(stage.archiveFallbacks || [])].sort((a, b) => b.score - a.score);
      const debridFallbacks = [...(stage.debridFallbacks || [])].sort((a, b) => b.score - a.score);
      finalReleases = [...archiveFallbacks.slice(0, 2), ...debridFallbacks.slice(0, 2)].slice(0, 3);
    }
    if (finalReleases.length === 0 && stage.searchIncomplete) {
      // Nothing playable among what the indexers had answered so far: no verdict yet.
      this.cache.delete(concertStageKey(concertId));
      return this.inconclusive(concertId);
    }

    const now = this.env.now();
    const negTtlMs =
      (stage.rawCandidateCount || 0) > 0
        ? NEGATIVE_UNMATCHED_CACHE_TTL_MS
        : NEGATIVE_EMPTY_CACHE_TTL_MS;
    const ttlMs = finalReleases.length > 0 ? ALBUM_CACHE_TTL_MS : negTtlMs;
    const record: CachedConcertResolution = {
      concertId,
      resolvedAt: now,
      expiresAt: now + ttlMs,
      releases: finalReleases,
      negative: finalReleases.length === 0,
    };
    this.cache.set(concertCacheKey(concertId), record, ttlMs);
    this.cache.delete(concertStageKey(concertId));

    this.env.log(
      "info",
      `resolve-concert: done ${concertId} verified=${finalReleases.length} labels=${finalReleases.map((v) => v.label).join(", ")}`
    );
    return { done: true, verifiedCount: finalReleases.length };
  }

  private buildConcertSources(
    item: KindItem,
    releases: VerifiedConcertRelease[],
    excluded: Set<string>
  ): PlayableSource[] {
    const hints = (item.hints || {}) as Record<string, unknown>;
    const durationSec = Number(hints.durationSec || item.fields?.duration || 0) || undefined;
    const sources: PlayableSource[] = [];

    for (let i = 0; i < releases.length; i++) {
      const rel = releases[i];
      if (excluded.has(rel.releaseId) || excluded.has(`src-${i}-${rel.releaseId}`)) continue;
      const releaseHint: PlayableSource["release"] = {
        candidate: rel.candidate,
      };
      if (rel.isArchiveFallback || rel.isUnconfirmedDebridFallback) {
        // Video archive or file-list-less Debrid fallback: omit synthetic fileHint so Ether's
        // video selection engine picks the main concert video file automatically.
      } else if (rel.isArchiveMember) {
        releaseHint.fileHint = rel.fileHint || rel.file;
      } else {
        if (typeof rel.fileIndex === "number") {
          releaseHint.fileIndex = rel.fileIndex;
        }
        if (rel.file) {
          releaseHint.file = rel.file;
        }
        releaseHint.fileHint = rel.fileHint || rel.file;
      }

      sources.push({
        id: rel.releaseId,
        label: rel.label,
        pattern: "release",
        mime: rel.mime || "video/x-matroska",
        size: rel.sourceKind === "usenet" ? undefined : (rel.size > 0 ? rel.size : undefined),
        durationSec,
        release: releaseHint,
      });
    }

    return sources;
  }

  /**
   * POST /ether/v1/kinds/music/match
   * Scores candidate releases against an album, track, or video concert item (matcher capability).
   */
  matchCandidates(req: KindMatchRequest): { matches: KindMatchScore[] } {
    const item = req.item;
    const hints = (item?.hints || {}) as Record<string, unknown>;

    if (item?.level === "concert" || String(item?.id || "").startsWith("co-")) {
      const target = this.loadConcertTarget(item.id, item) || {
        id: item.id,
        artistName: String(hints.artistName || item.fields?.artistName || "").trim(),
        title: String(hints.concertTitle || item.title || "").trim(),
        year: Number(hints.year || item.year || 0),
        filmedYear: Number(hints.filmedYear || hints.year || item.year || 0),
        durationSec: Number(hints.durationSec || item.fields?.duration || 0),
        standaloneTitle: Boolean(hints.standaloneTitle),
      };
      const matches: KindMatchScore[] = [];
      for (const cand of req.candidates || []) {
        const pre = preScoreConcertCandidate(cand, target, this.settings.videoQualityPreference);
        const normScore = pre.accepted ? Math.max(0.05, Math.min(1, pre.score / 120)) : 0.05;
        matches.push({
          candidateRef: candidateRefOf(cand),
          score: Math.round(normScore * 100) / 100,
          reasons: pre.reasons,
        });
      }
      matches.sort((a, b) => b.score - a.score);
      return { matches };
    }

    const artistName = String(hints.artistName || item?.fields?.artistName || "").trim();
    const albumTitle = String(hints.albumTitle || item?.fields?.albumTitle || item?.title || "").trim();
    const year = Number(hints.year || item?.year || 0);
    const releaseType = String(hints.releaseType || item?.fields?.releaseType || "album") as ReleaseType;
    const durationSec = Number(hints.durationSec || item?.fields?.duration || 0);

    const matches: KindMatchScore[] = [];
    for (const cand of req.candidates || []) {
      const pre = preScoreAlbumCandidate(
        cand,
        { artistName, title: albumTitle, year, releaseType, durationSec },
        this.settings.qualityPreference
      );
      const normScore = pre.accepted ? Math.max(0.05, Math.min(1, pre.score / 115)) : 0.05;
      matches.push({
        candidateRef: candidateRefOf(cand),
        score: Math.round(normScore * 100) / 100,
        reasons: pre.reasons,
      });
    }
    matches.sort((a, b) => b.score - a.score);
    return { matches };
  }
}
