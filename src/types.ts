// Core types for Ether's Music content plugin.

export interface EtherRequest {
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  headers?: Record<string, string>;
  body?: unknown;
  settings?: Record<string, unknown>;
}

export interface EtherResponse {
  status: number;
  headers?: Record<string, string>;
  body?: unknown;
  /** Frontend adapters: Ether serves this playable item's bytes itself. */
  media?: { itemRef: string; partIndex?: number; source?: string };
  /** Frontend adapters: Ether serves this item's stored artwork itself. */
  art?: { itemRef: string; role?: string };
}

export interface KindArtRef {
  role: "poster" | "backdrop" | "thumb" | "logo" | string;
  url: string;
  width?: number;
  height?: number;
}

export interface KindItem {
  id: string;
  level: "artist" | "album" | "track" | "concert" | "playlist";
  /** A playlist's ordered members (external ids of tracks). */
  members?: string[];
  parentId?: string;
  index?: number;
  title: string;
  sortTitle?: string;
  summary?: string;
  year?: number;
  released?: number;
  rating?: number;
  playable?: boolean;
  childCount?: number;
  leafCount?: number;
  art?: KindArtRef[];
  fields?: Record<string, unknown>;
  hints?: Record<string, unknown>;
  /** The recording this item is a copy of ("isrc:<ISRC>"), the same on every release. */
  recording?: string;
  etag?: string;
}

export interface KindBrowseRequest {
  parentId?: string;
  level?: string;
  cursor?: string;
  limit?: number;
  sort?: string;
  desc?: boolean;
  facets?: Record<string, string[]>;
  query?: string;
}

export interface KindPage {
  items: KindItem[];
  nextCursor?: string;
  total?: number;
}

export interface KindChangePage {
  upserts?: KindItem[];
  deletes?: string[];
  nextCursor?: string;
  complete: boolean;
}

export interface KindExpandRequest {
  facet?: string;
  value?: string;
  valueId?: number;
  parentId?: string;
  level?: string;
  cursor?: string;
}

export interface KindExpandResponse {
  items?: KindItem[];
  cursor?: string;
  nextCursor?: string;
  job?: string;
}

export interface ReleaseMember {
  index: number;
  path: string;
  size: number;
  stored?: boolean;
}

export interface ReleaseFile {
  index: number;
  path: string;
  size: number;
  sizeApproximate?: boolean;
  members?: ReleaseMember[];
}

export interface UsenetCheckResult {
  available: boolean;
  checked: number;
  missing: number;
  cached?: boolean;
  playbackFailed?: boolean;
  reason?: string;
  checkedAt?: number;
}

export interface SourceCandidate {
  infoHash?: string;
  magnet?: string;
  nzbUrl?: string;
  fileIndex?: number;
  title?: string;
  size?: number;
  seeders?: number;
  cached?: boolean;
  indexer?: string;
  indexerId?: string;
  score?: number;
  resolution?: number;
  source?: string;
  codec?: string;
  files?: ReleaseFile[];
  usenetCheck?: UsenetCheckResult;
}

export interface SourceQuery {
  kind: "indexer_search" | "debrid_check" | "debrid_acquire" | "release_files" | "usenet_check";
  query?: string;
  category?: string;
  profile?: string;
  firstResults?: boolean;
  settleMs?: number;
  timeoutMs?: number;
  minResults?: number;
  infoHashes?: string[];
  infoHash?: string;
  magnet?: string;
  torrentUrl?: string;
  nzbUrl?: string;
  candidate?: SourceCandidate;
}

export interface TrackHint {
  disc?: number;
  number?: number;
  title?: string;
}

export interface ReleaseHint {
  fileIndex?: number;
  nzbUrl?: string;
  magnet?: string;
  infoHash?: string;
  torrentUrl?: string;
  candidate?: SourceCandidate;
  file?: string;
  fileHint?: string;
  track?: TrackHint;
  passwordSecret?: string;
  cachedOnly?: boolean;
}

export interface PlayableSource {
  id: string;
  label?: string;
  pattern: "release" | "range" | "direct" | "download" | "container" | "file";
  mime: string;
  size?: number;
  durationSec?: number;
  url?: string;
  headers?: Record<string, string>;
  release?: ReleaseHint;
}

export interface KindResolveRequest {
  libraryKey?: string;
  item: KindItem;
  partIndex?: number;
  client?: {
    exclude?: string[];
    [key: string]: unknown;
  };
}

export interface KindResolveResponse {
  pending?: boolean;
  retryInMs?: number;
  job?: string;
  sources: PlayableSource[];
  ttlSec?: number;
}

export interface KindMatchRequest {
  item: KindItem;
  candidates: SourceCandidate[];
  settings?: Record<string, unknown>;
}

export interface KindMatchScore {
  candidateRef: string;
  score: number;
  reasons?: string[];
}

export interface HttpFetchRequest {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpFetchResponse {
  status: number;
  headers?: Record<string, string>;
  body: string;
}

export interface HostEnv {
  now: () => number;
  log: (...args: unknown[]) => void;
  kv: {
    get: (key: string) => string | null;
    put: (key: string, value: string) => void;
    delete: (key: string) => void;
    list: (prefix?: string) => string[];
  };
  http: {
    fetch: (req: HttpFetchRequest) => HttpFetchResponse;
  };
  settings: {
    get: () => Record<string, unknown>;
  };
  sources: {
    resolve: (q: SourceQuery) => {
      candidates?: SourceCandidate[];
      /** Indexers still searching in the background (early-returning indexer_search). */
      pending?: Array<{ indexerId?: string; indexer?: string }>;
      /** Per-indexer outcome: answered, pending, timed_out, skipped or error. */
      indexers?: Array<{ indexerId?: string; indexer?: string; status?: string; results?: number }>;
    };
  };
}

export type QualityPreference = "flac_preferred" | "lossless_only" | "high_bitrate";
export type VideoQualityPreference = "uhd_preferred" | "1080p_preferred" | "balanced";
export type CuratedSize = "compact" | "standard" | "large";
export type ReleaseType = "album" | "ep" | "single" | "live" | "compilation";

export interface PluginSettings {
  qualityPreference: QualityPreference;
  newznabCategories: string;
  videoQualityPreference: VideoQualityPreference;
  concertNewznabCategories: string;
  curatedSize: CuratedSize;
  enrichMusicBrainz: boolean;
}

export interface CanonicalTrack {
  id: string;
  deezerTrackId: number;
  title: string;
  disc: number;
  trackNumber: number;
  durationSec: number;
  explicit: boolean;
  isrc?: string;
  rank?: number;
  artistName: string;
  featuredArtists?: string[];
}

export interface CanonicalAlbum {
  id: string;
  deezerAlbumId: number;
  artistId: string;
  deezerArtistId: number;
  artistName: string;
  title: string;
  releaseDate: string;
  year: number;
  releaseType: ReleaseType;
  genres: string[];
  label: string;
  upc?: string;
  fans: number;
  durationSec: number;
  trackCount: number;
  discCount: number;
  coverXL: string;
  coverBig: string;
  releaseGroupMbid?: string;
  releaseMbid?: string;
  curation: string[];
  tracks: CanonicalTrack[];
  /** Set when this "album" is one song looked for on another release that carries it (a single,
   * a compilation): only that song must be found, among the release's own track count. */
  recordingTarget?: { releaseTrackCount: number };
}

export interface TrackFileMapping {
  fileIndex?: number;
  file?: string;
  fileHint?: string;
  track?: TrackHint;
  isArchiveMember?: boolean;
  size: number;
  mime: string;
  confidence: number;
}

export interface VerifiedAlbumRelease {
  releaseId: string;
  sourceKind: "usenet" | "debrid";
  qualityTier: "flac24" | "flac" | "lossless" | "lossy_high" | "lossy";
  codec: string;
  mime: string;
  label: string;
  score: number;
  candidate: SourceCandidate;
  isArchiveFallback?: boolean;
  /**
   * True when the torrent was not confirmed cached by bulk debrid_check (e.g.
   * Real-Debrid / AllDebrid / Debrid-Link, which do not support CheckCached)
   * and relies on Ether's acquire-time cache check + release.track selection.
   */
  isUnconfirmedDebridFallback?: boolean;
  /** Map from canonical track ID (e.g. "tr-3135553") -> matched file in release. */
  tracks: Record<string, TrackFileMapping>;
}

export interface CachedAlbumResolution {
  albumId: string;
  resolvedAt: number;
  expiresAt: number;
  releases: VerifiedAlbumRelease[];
  negative?: boolean;
}

export interface VerifiedConcertRelease {
  releaseId: string;
  sourceKind: "usenet" | "debrid";
  qualityTier: "uhd" | "1080p" | "720p" | "sd";
  codec: string;
  mime: string;
  label: string;
  score: number;
  candidate: SourceCandidate;
  isArchiveFallback?: boolean;
  isUnconfirmedDebridFallback?: boolean;
  isArchiveMember?: boolean;
  fileIndex?: number;
  file?: string;
  fileHint?: string;
  size: number;
}

export interface CachedConcertResolution {
  concertId: string;
  resolvedAt: number;
  expiresAt: number;
  releases: VerifiedConcertRelease[];
  negative?: boolean;
}

export interface LyricsResult {
  syncedLyrics?: string;
  plainLyrics?: string;
  instrumental?: boolean;
  source: "lrclib";
}
