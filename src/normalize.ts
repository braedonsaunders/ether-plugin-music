import type { ReleaseType } from "./types.ts";

/**
 * Fold diacritics, normalize unicode punctuation, and collapse whitespace.
 */
export function normalizeText(input: string): string {
  return String(input || "")
    .replace(/[Ææ]/g, "ae")
    .replace(/[Œœ]/g, "oe")
    .replace(/[Øø]/g, "o")
    .replace(/[ß]/g, "ss")
    .replace(/[Ðð]/g, "d")
    .replace(/[Þþ]/g, "th")
    .replace(/[Łł]/g, "l")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/['’`´]/g, "")
    .replace(/[&+]/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Strip common edition/remaster/parenthetical suffixes from album or track titles
 * so queries and comparisons match canonical studio editions cleanly.
 */
export function stripEditionSuffix(title: string): string {
  let out = String(title || "").trim();
  // Remove trailing bracketed/parenthesized edition tags (including ordinals like "20th Anniversary Edition").
  const editionPattern =
    /\s*[\(\[]\s*(?:(?:\d{1,2}(?:st|nd|rd|th)|\d{4})\s+)?(?:deluxe|super\s+deluxe|expanded|remaster(?:ed)?|anniversary|special|collector'?s?|bonus\s+track|explicit|clean|standard|limited|reissue|mono|stereo|digital|target|international|japanese|uk|us|complete|edition|version|legacy|ultimate|platinum|gold|archive|box\s*set|the\s+encore)[^\)\]]*[\)\]]\s*$/i;
  let prev = "";
  while (out !== prev) {
    prev = out;
    out = out.replace(editionPattern, "").trim();
  }
  // Remove "- Remastered 2011", ": 20th Anniversary Edition", or "- Deluxe Edition" trailing clauses.
  out = out
    .replace(/\s+(?:-|:)\s+(?:(?:\d{1,2}(?:st|nd|rd|th)|\d{4})\s+)?(?:remaster(?:ed)?|deluxe|super\s+deluxe|expanded|anniversary|special|bonus|explicit|clean|reissue|the\s+encore).*$/i, "")
    .trim();
  return out || String(title || "").trim();
}

/**
 * Strip "(feat. ...)" / "(ft. ...)" / "(with ...)" from track titles for matching against release filenames.
 */
export function stripFeaturing(title: string): string {
  return String(title || "")
    .replace(/\s*[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+[^\)\]]+[\)\]]/gi, "")
    .replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, "")
    .trim();
}

/**
 * Extract featured artist names from a track title like "Song (feat. Artist A & Artist B)".
 */
export function extractFeaturedFromTitle(title: string): string[] {
  const m = String(title || "").match(/[\(\[]\s*(?:feat\.?|ft\.?|featuring|with)\s+([^\)\]]+)[\)\]]/i);
  if (!m) return [];
  return m[1]
    .split(/\s*(?:,|&|\band\b|\bx\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= 80);
}

/**
 * Tokenize normalized text into meaningful words.
 */
export function tokensOf(input: string): string[] {
  return normalizeText(input)
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Dice / Jaccard hybrid token similarity in [0, 1], with exact-containment boost.
 */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  return similarityOfNormalized(na, tokenSetOfNormalized(na), nb, tokenSetOfNormalized(nb));
}

/** The words of a text that normalizeText has already been through. */
export function tokenSetOfNormalized(norm: string): Set<string> {
  return new Set(norm.split(" ").filter((t) => t.length > 0));
}

/**
 * textSimilarity for texts already normalized and split: comparing every track with every file
 * of a release would otherwise normalize the same strings thousands of times.
 */
export function similarityOfNormalized(na: string, setA: Set<string>, nb: string, setB: Set<string>): number {
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let inter = 0;
  for (const t of setA) {
    if (setB.has(t)) inter++;
  }
  const dice = (2 * inter) / (setA.size + setB.size);

  // Character-level Levenshtein ratio for short single-word titles.
  if (setA.size <= 2 && setB.size <= 2) {
    const lev = levenshteinRatio(na, nb);
    return Math.max(dice, lev);
  }
  return dice;
}

export function levenshteinRatio(a: string, b: string): number {
  const la = a.length;
  const lb = b.length;
  if (la === 0 && lb === 0) return 1;
  if (la === 0 || lb === 0) return 0;
  const prev = new Array<number>(lb + 1);
  const curr = new Array<number>(lb + 1);
  for (let j = 0; j <= lb; j++) prev[j] = j;
  for (let i = 1; i <= la; i++) {
    curr[0] = i;
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= lb; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= lb; j++) prev[j] = curr[j];
  }
  return 1 - prev[lb] / Math.max(la, lb);
}

/**
 * Parse a YYYY-MM-DD (or YYYY) release date into { year, unixSec }.
 */
export function parseReleaseDate(dateStr?: string): { year: number; unixSec: number } {
  const s = String(dateStr || "").trim();
  const m = s.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?/);
  if (!m) return { year: 0, unixSec: 0 };
  const year = Number(m[1]);
  const month = m[2] ? Math.max(1, Math.min(12, Number(m[2]))) : 1;
  const day = m[3] ? Math.max(1, Math.min(31, Number(m[3]))) : 1;
  if (!Number.isFinite(year) || year < 1900 || year > 2100) {
    return { year: 0, unixSec: 0 };
  }
  const ms = Date.UTC(year, month - 1, day);
  return { year, unixSec: Math.floor(ms / 1000) };
}

/**
 * Derive an enum decade label matching manifest.fields.decade.
 */
export function decadeOfYear(year: number): string {
  if (!year || year < 1960) return "Classic";
  if (year >= 2020) return "2020s";
  if (year >= 2010) return "2010s";
  if (year >= 2000) return "2000s";
  if (year >= 1990) return "1990s";
  if (year >= 1980) return "1980s";
  if (year >= 1970) return "1970s";
  return "1960s";
}

/**
 * Map a Deezer/MusicBrainz fan count or chart rank to a smooth [5.0, 9.9] rating
 * so Ether's built-in `sort: "rating"` genuinely ranks by popularity and chart status.
 */
export function popularityToRating(fans: number, chartBonus = 0): number {
  const safeFans = Math.max(0, Number(fans) || 0);
  // log10(1) = 0, log10(10_000) = 4, log10(1_000_000) = 6, log10(15_000_000) = 7.18
  const base = safeFans > 0 ? 5.0 + Math.min(4.2, (Math.log10(safeFans + 10) / 7.2) * 4.2) : 5.5;
  const total = Math.min(9.9, Math.max(5.0, base + chartBonus));
  return Math.round(total * 10) / 10;
}

/**
 * Format large fan counts cleanly for artist/album summaries (e.g. "5.2M fans").
 */
export function formatCount(n: number): string {
  if (!n || n <= 0) return "";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return String(Math.round(n));
}

export function formatDuration(sec: number): string {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rem = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${rem < 10 ? "0" : ""}${rem}s`;
  return `${rem}s`;
}

/**
 * Canonicalize Deezer / MusicBrainz genre strings into clean, consistent library facets.
 */
export function canonicalizeGenre(raw?: string): string | null {
  const g = String(raw || "").trim().toLowerCase();
  if (!g || g === "all" || g === "various" || g === "music") return null;
  if (g.includes("hip hop") || g.includes("hip-hop") || g.includes("rap") || g.includes("trap")) return "Hip-Hop";
  if (g.includes("r&b") || g.includes("rnb") || g.includes("soul") || g.includes("funk") || g.includes("motown")) return "R&B & Soul";
  if (g.includes("electro") || g.includes("dance") || g.includes("house") || g.includes("techno") || g.includes("ambient") || g.includes("trance") || g.includes("dubstep") || g.includes("drum & bass") || g.includes("trip hop") || g.includes("idm")) return "Electronic";
  if (g.includes("indie") || g.includes("alternative") || g.includes("shoegaze") || g.includes("post-punk") || g.includes("grunge")) return "Indie & Alternative";
  if (g.includes("metal") || g.includes("hardcore") || g.includes("doom") || g.includes("thrash")) return "Metal";
  if (g.includes("punk") || g.includes("rock") || g.includes("classic rock") || g.includes("prog") || g.includes("psychedelic")) return "Rock";
  if (g.includes("jazz") || g.includes("bebop") || g.includes("swing") || g.includes("fusion") || g.includes("blues")) return "Jazz";
  if (g.includes("country") || g.includes("folk") || g.includes("americana") || g.includes("singer") || g.includes("bluegrass")) return "Country & Folk";
  if (g.includes("classical") || g.includes("orchestra") || g.includes("baroque") || g.includes("opera") || g.includes("chamber")) return "Classical";
  if (g.includes("latin") || g.includes("reggaeton") || g.includes("salsa") || g.includes("bossa") || g.includes("mpb")) return "Latin";
  if (g.includes("reggae") || g.includes("dub") || g.includes("ska") || g.includes("dancehall")) return "Reggae";
  if (g.includes("film") || g.includes("soundtrack") || g.includes("score") || g.includes("game") || g.includes("anime")) return "Soundtracks";
  if (g.includes("pop") || g.includes("chanson") || g.includes("k-pop") || g.includes("synthpop")) return "Pop";
  return null;
}

/**
 * Normalize Deezer record_type + MusicBrainz primary/secondary types into manifest enum.
 */
export function classifyReleaseType(
  recordType?: string,
  title?: string,
  mbPrimaryType?: string,
  mbSecondaryTypes?: string[]
): ReleaseType {
  const sec = (mbSecondaryTypes || []).map((s) => s.toLowerCase());
  const prim = String(mbPrimaryType || "").toLowerCase();
  const rt = String(recordType || "").toLowerCase();
  const t = String(title || "").toLowerCase();

  if (sec.includes("compilation")) return "compilation";
  if (sec.includes("live")) return "live";
  if (rt === "compile" || rt === "compilation") return "compilation";
  if (/\b(?:greatest\s+hits|best\s+of|the\s+very\s+best|anthology|complete\s+collection|essential\s+collection|hits\s+collection|discography|platinum\s+collection|singles\s+collection)\b/i.test(t) || /:\s*the\s+singles\b/i.test(t)) {
    return "compilation";
  }
  if (
    /\b(?:live\s+at|live\s+in|live\s+from|live\s+trax|unplugged|in\s+concert|concert\b|at\s+the\s+bbc|bbc\s+sessions)\b/i.test(t) ||
    /^live\b/i.test(t) ||
    /\(\s*live\b/i.test(t)
  ) {
    return "live";
  }
  if (prim === "ep" || rt === "ep") return "ep";
  if (prim === "single" || rt === "single") return "single";
  return "album";
}

/**
 * Detect remix packs, B-side EPs, edited singles, and demo-only releases that
 * should never sort ahead of canonical studio albums on an artist page.
 */
export function isRemixOrBSideEdition(title: string): boolean {
  return /\b(?:remix(?:es)?|b[\s-]?sides?|singles\s+remixes|edited\s+version|alternative\s+demo|original\s+demo|demo\s+version)\b/i.test(
    String(title || "")
  );
}

/**
 * Detect tribute bands, lullaby/karaoke factories, and novelty cover acts so
 * authentic studio artists and albums aren't buried by tribute spam in search.
 */
export function isTributeOrNoveltyRelease(artistName: string, title = ""): boolean {
  const combined = `${artistName || ""} ${title || ""}`;
  return /\b(?:tribute|salute\s+to|in\s+the\s+style\s+of|originally\s+performed\s+by|karaoke|lullab(?:y|ies)|berceuses|tabata|music\s+box|8-?bit|piano\s+tribute|orchestral\s+ensemble|dcac\s+band)\b/i.test(
    combined
  );
}

/**
 * Detect derivative/novelty album variants (drumless, acapella, instrumental, commentary,
 * karaoke, sped-up, slowed, remix packs) that should not displace an artist's canonical studio albums.
 */
export function isDerivativeAlbumEdition(title: string): boolean {
  return /\b(?:drumless|a\s*capp?ella|instrumental(?:\s+(?:edition|version|album))?|commentary|track\s+by\s+track|karaoke|sped\s+up|slowed(?:\s*\+?\s*reverb)?|8-?bit|lullab(?:y|ies)|music\s+box|stems|singles\s+remixes|remixes\s*(?:&|and)\s*b[\s-]?sides?|frank\s*-\s*remixes)\b/i.test(
    String(title || "")
  );
}

/**
 * Detect reissue / anniversary / remaster / deluxe titles so classic-catalog reissues
 * don't crowd out genuinely new original releases in the New Releases shelf.
 */
export function isReissueEdition(title: string): boolean {
  return /\b(?:anniversary|reissue|remaster(?:ed)?|deluxe|super\s+deluxe|collector'?s?\s+edition|expanded\s+edition)\b/i.test(
    String(title || "")
  );
}

/**
 * Compute a deterministic, idempotent positive album sort index for Ether's child ordering
 * (ORDER BY idx ASC, sort_title ASC) so canonical studio albums ALWAYS sort ahead of
 * reissues/deluxe editions, EPs, live albums, compilations, and singles/remixes —
 * regardless of whether the album was synced via /browse, /changes, or /search.
 */
export function computeAlbumOrderIndex(
  album: { releaseType: ReleaseType; title: string; fans?: number }
): number {
  const remixOrBSide = isRemixOrBSideEdition(album.title);
  const reissue = isReissueEdition(album.title);
  let tierBase = 0;
  if (remixOrBSide || album.releaseType === "single") {
    tierBase = 500;
  } else if (album.releaseType === "compilation") {
    tierBase = 400;
  } else if (album.releaseType === "live") {
    tierBase = 300;
  } else if (album.releaseType === "ep") {
    tierBase = 200;
  } else if (reissue) {
    tierBase = 100;
  } else {
    tierBase = 0;
  }
  const fans = Math.max(0, Number(album.fans) || 0);
  // Higher fan count -> lower offset within [1..99] so popular albums lead their tier.
  const popOffset = Math.max(1, Math.round(99 - Math.min(98, Math.log10(fans + 10) * 14)));
  return tierBase + popOffset;
}

/**
 * Determine whether a candidate release name from an indexer looks like a compilation,
 * discography, box set, live bootleg, tribute, karaoke, or non-studio pack that must be
 * rejected when the requested item is a studio album.
 */
export function isRejectedReleaseForRequest(
  releaseTitle: string,
  requestedAlbumTitle: string,
  requestedReleaseType: ReleaseType
): { rejected: boolean; reason?: string } {
  const rel = String(releaseTitle || "");
  const reqNorm = normalizeText(requestedAlbumTitle);

  // Always reject obvious non-audio or wrong-media releases.
  if (/\b(?:bluray|blu-ray|bdrip|dvdrip|1080p|2160p|720p|x264|x265|hevc|audiobook|m4b|ebook|epub|pdf|karaoke|instrumental\s+version|midi|sheet\s+music|stems?\s+pack|acapella)\b/i.test(rel)) {
    return { rejected: true, reason: "non-album media or karaoke/instrumental" };
  }

  // Discography / multi-album packs always fail album-unit matching.
  if (/\b(?:discography|complete\s+studio\s+albums|complete\s+albums|studio\s+albums\s+collection|all\s+albums|box\s*set|\d+\s*cd\s*box|\b\d{4}\s*-\s*\d{4}\b)\b/i.test(rel)) {
    if (!/\b(?:box|complete|anthology)\b/i.test(reqNorm)) {
      return { rejected: true, reason: "discography or multi-album box set" };
    }
  }

  // When requesting a studio album/EP/single, reject compilations & greatest hits unless requested.
  if (requestedReleaseType === "album" || requestedReleaseType === "ep" || requestedReleaseType === "single") {
    if (
      /\b(?:greatest\s+hits|best\s+of|the\s+very\s+best|anthology|compilation|various\s+artists|\bva\s+-|\bva\b|essential\s+collection|hits\s+collection|ultimate\s+collection|now\s+thats\s+what\s+i\s+call)\b/i.test(rel) &&
      !/\b(?:greatest\s+hits|best\s+of|anthology|compilation|essential|ultimate)\b/i.test(reqNorm)
    ) {
      return { rejected: true, reason: "compilation rejected for studio album request" };
    }
    if (
      /\b(?:tribute\s+to|in\s+the\s+style\s+of|cover\s+version|piano\s+tribute|lullaby\s+renditions)\b/i.test(rel) &&
      !/\btribute\b/i.test(reqNorm)
    ) {
      return { rejected: true, reason: "tribute or cover release" };
    }
    if (
      /\b(?:live\s+at|live\s+in|live\s+from|bootleg|soundboard|fm\s+broadcast|bbc\s+sessions)\b/i.test(rel) &&
      !/\b(?:live|unplugged|concert|sessions|bbc)\b/i.test(reqNorm)
    ) {
      return { rejected: true, reason: "live recording rejected for studio album request" };
    }
  }

  return { rejected: false };
}

const VERSION_REMIX_RE =
  /\b(?:remix(?:es|ed)?|rmx|mixed by|dj mix|club mix|extended mix|radio edit|radio mix|dub mix|vip mix)\b/;
const VERSION_LIVE_RE = /\b(?:live|in concert|unplugged|bootleg|soundboard|broadcast)\b/;
// Alternate mixes. "5.1"/"4.1" are matched on the raw text because normalizeText splits them.
const VERSION_ALT_RE =
  /\b(?:quad|quadraphonic|surround|atmos|instrumentals?|karaoke|a ?cappella|demos?|acoustic|drumless|mono mix|stereo mix)\b/g;
const VERSION_SURROUND_RE = /(?<![\d.])[457]\.1(?:ch)?(?![\d])/g;
const VERSION_VOLUME_RE = /\b(volume|vol|part|pt) (\d{1,2})\b/g;

/**
 * Name-level gate for a different VERSION of the requested recording: a release name that
 * declares a remix, live recording, alternate mix, or another volume/part which the requested
 * album title (full, with its edition suffix) does not declare. Markers in the artist name
 * (the band "Live") are ignored. Cheap: a handful of precompiled regexes per call.
 */
export function isWrongVersionRelease(
  releaseTitle: string,
  requestedAlbumTitle: string,
  artistName = ""
): { rejected: boolean; reason?: string } {
  const rawRel = String(releaseTitle || "").toLowerCase();
  const rawReq = String(requestedAlbumTitle || "").toLowerCase();
  let rel = normalizeText(releaseTitle);
  const req = normalizeText(requestedAlbumTitle);

  // Drop the artist's own name (first occurrence) so "Live", "Broadcast" etc. as artists don't count.
  const artist = normalizeText(artistName);
  if (artist) {
    const padded = ` ${rel} `;
    const at = padded.indexOf(` ${artist} `);
    if (at >= 0) rel = (padded.slice(0, at) + " " + padded.slice(at + artist.length + 1)).trim();
  }

  if (VERSION_REMIX_RE.test(rel) && !VERSION_REMIX_RE.test(req)) {
    return { rejected: true, reason: "remix, not requested" };
  }

  if (VERSION_LIVE_RE.test(rel) && !VERSION_LIVE_RE.test(req)) {
    return { rejected: true, reason: "live recording, not requested" };
  }

  const altOf = (norm: string, raw: string): Set<string> => {
    const out = new Set<string>();
    for (const m of norm.matchAll(VERSION_ALT_RE)) out.add(m[0].replace(/s$/, "").replace(/ /g, ""));
    for (const m of raw.matchAll(VERSION_SURROUND_RE)) out.add("surround");
    return out;
  };
  const relAlt = altOf(rel, rawRel);
  if (relAlt.size > 0) {
    const reqAlt = altOf(req, rawReq);
    for (const a of relAlt) {
      if (!reqAlt.has(a)) {
        return { rejected: true, reason: "alternate mix, not requested" };
      }
    }
  }

  const volOf = (norm: string): Map<string, Set<string>> => {
    const out = new Map<string, Set<string>>();
    for (const m of norm.matchAll(VERSION_VOLUME_RE)) {
      const fam = m[1] === "part" || m[1] === "pt" ? "part" : "volume";
      const n = String(Number(m[2]));
      (out.get(fam) || out.set(fam, new Set()).get(fam)!).add(n);
    }
    return out;
  };
  const relVol = volOf(rel);
  if (relVol.size > 0) {
    const reqVol = volOf(req);
    for (const [fam, nums] of relVol) {
      const want = reqVol.get(fam);
      if (!want) {
        // The request has no marker of this kind; a request with the other kind (vol vs part) counts as declared.
        if (reqVol.size === 0) return { rejected: true, reason: "different volume" };
        continue;
      }
      if (![...nums].some((n) => want.has(n))) return { rejected: true, reason: "different volume" };
    }
  }

  return { rejected: false };
}

export interface AudioFormatInfo {
  ext: string;
  mime: string;
  codec: string;
  lossless: boolean;
  /** Approximate typical kilobits per second for duration/size sanity checks. */
  typicalKbps: number;
}

const AUDIO_EXT_MAP: Record<string, AudioFormatInfo> = {
  flac: { ext: "flac", mime: "audio/flac", codec: "FLAC", lossless: true, typicalKbps: 920 },
  alac: { ext: "alac", mime: "audio/mp4", codec: "ALAC", lossless: true, typicalKbps: 900 },
  wav: { ext: "wav", mime: "audio/wav", codec: "WAV", lossless: true, typicalKbps: 1411 },
  aiff: { ext: "aiff", mime: "audio/aiff", codec: "AIFF", lossless: true, typicalKbps: 1411 },
  aif: { ext: "aif", mime: "audio/aiff", codec: "AIFF", lossless: true, typicalKbps: 1411 },
  wv: { ext: "wv", mime: "audio/wavpack", codec: "WavPack", lossless: true, typicalKbps: 900 },
  ape: { ext: "ape", mime: "audio/ape", codec: "APE", lossless: true, typicalKbps: 880 },
  mp3: { ext: "mp3", mime: "audio/mpeg", codec: "MP3", lossless: false, typicalKbps: 320 },
  m4a: { ext: "m4a", mime: "audio/mp4", codec: "AAC", lossless: false, typicalKbps: 256 },
  aac: { ext: "aac", mime: "audio/aac", codec: "AAC", lossless: false, typicalKbps: 256 },
  opus: { ext: "opus", mime: "audio/opus", codec: "Opus", lossless: false, typicalKbps: 160 },
  ogg: { ext: "ogg", mime: "audio/ogg", codec: "Vorbis", lossless: false, typicalKbps: 224 },
  oga: { ext: "oga", mime: "audio/ogg", codec: "Vorbis", lossless: false, typicalKbps: 224 },
  wma: { ext: "wma", mime: "audio/x-ms-wma", codec: "WMA", lossless: false, typicalKbps: 192 },
};

export function audioFormatOfPath(filePath: string): AudioFormatInfo | null {
  const clean = String(filePath || "").trim().toLowerCase();
  const dot = clean.lastIndexOf(".");
  if (dot < 0 || dot === clean.length - 1) return null;
  const ext = clean.slice(dot + 1);
  return AUDIO_EXT_MAP[ext] || null;
}

export function isArchivePath(filePath: string): boolean {
  const clean = String(filePath || "").trim().toLowerCase();
  return /\.(?:rar|zip|7z|r\d{2}|z\d{2}|part\d+\.rar|(?:7z|zip|rar)\.\d{3})$/.test(clean);
}

export interface VideoFormatInfo {
  ext: string;
  mime: string;
  container: string;
}

const VIDEO_EXT_MAP: Record<string, VideoFormatInfo> = {
  mkv: { ext: "mkv", mime: "video/x-matroska", container: "MKV" },
  mp4: { ext: "mp4", mime: "video/mp4", container: "MP4" },
  m4v: { ext: "m4v", mime: "video/mp4", container: "MP4" },
  mov: { ext: "mov", mime: "video/quicktime", container: "MOV" },
  ts: { ext: "ts", mime: "video/mp2t", container: "TS" },
  m2ts: { ext: "m2ts", mime: "video/mp2t", container: "M2TS" },
  mts: { ext: "mts", mime: "video/mp2t", container: "MTS" },
  avi: { ext: "avi", mime: "video/x-msvideo", container: "AVI" },
  webm: { ext: "webm", mime: "video/webm", container: "WebM" },
  mpg: { ext: "mpg", mime: "video/mpeg", container: "MPEG" },
  mpeg: { ext: "mpeg", mime: "video/mpeg", container: "MPEG" },
  vob: { ext: "vob", mime: "video/mpeg", container: "VOB" },
};

export function videoFormatOfPath(filePath: string): VideoFormatInfo | null {
  const clean = String(filePath || "").trim().toLowerCase();
  const dot = clean.lastIndexOf(".");
  if (dot < 0 || dot === clean.length - 1) return null;
  const ext = clean.slice(dot + 1);
  return VIDEO_EXT_MAP[ext] || null;
}

export function isConcertExtraOrSamplePath(filePath: string): boolean {
  const norm = String(filePath || "").replace(/\\/g, "/").toLowerCase();
  const base = norm.split("/").pop() || norm;
  if (base.startsWith("._")) return true;
  return /(?:^|[\/._\-\s])(?:sample|trailer|teaser|preview|bonus|extras?|featurette|interview|making[\s._-]?of|behind[\s._-]?the[\s._-]?scenes|deleted|credits|menu|promo|rarbg)(?:$|[\/._\-\s])/.test(
    norm
  );
}

const VIDEO_TAG_RE =
  /\b(?:2160p|4k|uhd|1080p|1080i|720p|576p|480p|blu-?ray|bdrip|bdremux|remux|web-?dl|webrip|dvdrip|dvd9|dvd5|dvd-?r|hdtv|pdtv|satrip|x264|x265|h\.?264|h\.?265|hevc|avc|av1|xvid|divx|mkv|mp4|mpeg2|vc-?1|hdr10|dolby\s*vision|dv|imax)\b/i;

/**
 * Reject audio-only rips, CAM/TS, trailers, ebooks, and discographies when resolving a video concert.
 */
export function isRejectedConcertVideoRelease(
  releaseTitle: string
): { rejected: boolean; reason?: string } {
  const rel = String(releaseTitle || "");
  if (!rel.trim()) return { rejected: true, reason: "empty release title" };

  if (/\b(?:camrip|hdcam|hd-?ts|telesync|telecine|workprint|screener|dvdscr|audiobook|m4b|ebook|epub|pdf|sheet\s+music|karaoke|subpack|ost|original\s+soundtrack)\b/i.test(rel)) {
    return { rejected: true, reason: "non-concert or low-quality cam/book/soundtrack release" };
  }

  // Reject pure audio releases (e.g. "Pink Floyd - Pulse (1995) [FLAC]" or "MP3 320") that lack any video tag.
  const looksAudioOnly =
    /\b(?:mp3|320\s*kbps|cbr\s*320|v0|24\s*-?\s*bit|24bit|16\s*-?\s*bit|16bit|web-?flac|cdrip|cd-?rip|vinyl\s*rip|eac|alac|wavpack|lossless\s+audio|flac)\b/i.test(
      rel
    ) && !VIDEO_TAG_RE.test(rel);
  if (looksAudioOnly) {
    return { rejected: true, reason: "audio-only release rejected for video concert" };
  }

  if (/\b(?:discography|complete\s+studio\s+albums|all\s+albums|studio\s+albums)\b/i.test(rel)) {
    return { rejected: true, reason: "audio discography rejected for video concert" };
  }

  return { rejected: false };
}

export interface ParsedTrackFilename {
  disc: number | null;
  track: number | null;
  titleGuess: string;
  baseName: string;
}

/**
 * Parse disc number, track number, and song title from a release file path like:
 * - "CD1/01 - One More Time.flac"
 * - "Disc 2/2-04. Digital Love.flac"
 * - "03. Daft Punk - Harder, Better, Faster, Stronger.mp3"
 * - "102 - Aerodynamic.flac" (only when multi-disc)
 */
export function parseTrackFilename(filePath: string, totalDiscs = 1): ParsedTrackFilename {
  const normalized = String(filePath || "").replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const fileName = segments[segments.length - 1] || normalized;
  const dirPath = segments.slice(0, -1).join("/");

  const baseName = fileName.replace(/\.[^.]+$/, "").trim();
  let disc: number | null = null;
  let track: number | null = null;
  let rest = baseName;

  // 1. Check directory names for CD/Disc marker ("CD 2", "Disc_02", "D2").
  const dirDisc = dirPath.match(/(?:^|[\s._\-\/])(?:cd|disc|disk|d)\s*[._\-]?\s*0?([1-9])(?=$|[\s._\-\/])/i);
  if (dirDisc) {
    disc = Number(dirDisc[1]);
  }

  // 2. Check filename prefix for explicit disc-track pattern: "1-01 ...", "2.04 - ...", "D1T02 ...".
  let m = rest.match(/^(?:d|cd|disc)?0?([1-9])\s*[-._x]\s*(\d{1,3})(?:\s*[-._)\]]+\s*|\s+)(.*)$/i);
  if (m) {
    disc = Number(m[1]);
    track = Number(m[2]);
    rest = m[3].trim();
  } else if (totalDiscs > 1 && /^[1-9]\d{2}(?:\s*[-._)\]]+\s*|\s+)/.test(rest)) {
    // Multi-disc compact 3-digit prefix like "101 - Title" or "205. Title".
    m = rest.match(/^([1-9])(\d{2})(?:\s*[-._)\]]+\s*|\s+)(.*)$/);
    if (m) {
      disc = Number(m[1]);
      track = Number(m[2]);
      rest = m[3].trim();
    }
  } else {
    // 3. Standard leading track number: "01 - Title", "01. Title", "1 Title", "(01) Title".
    m = rest.match(/^[\(\[]?\s*(\d{1,3})\s*[\)\]]?(?:\s*[-._]+\s*|\s+)(.*)$/);
    if (m) {
      const n = Number(m[1]);
      // Guard against years like "1999 - Title" being parsed as track 1999.
      if (n >= 1 && n <= 199) {
        track = n;
        rest = m[2].trim();
      }
    }
  }

  // Strip leading "Artist - " if still present and there is a clear separator.
  // Keep full rest as well by only stripping if there's a " - " and right side is non-empty.
  let titleGuess = rest.replace(/_/g, " ").trim();
  const dashIdx = titleGuess.indexOf(" - ");
  if (dashIdx > 0 && dashIdx < titleGuess.length - 3) {
    // Often "Artist - Song Title"; keep the right-hand part for title similarity.
    const rhs = titleGuess.slice(dashIdx + 3).trim();
    if (rhs.length >= 2) {
      titleGuess = rhs;
    }
  }

  return { disc, track, titleGuess, baseName };
}

export function validExternalId(id: string): string {
  const cleaned = String(id || "")
    .replace(/[^A-Za-z0-9._~-]/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "m")
    .slice(0, 120);
  return cleaned || "m-unknown";
}

/**
 * Text an indexer's full-text search can match: Latin accents folded, punctuation turned into
 * spaces ("AC/DC" -> "AC DC", "Beyoncé" -> "Beyonce"). Letters of other scripts are kept.
 */
export function indexerQueryText(input: string): string {
  return String(input || "")
    // A Latin letter followed by combining marks (decomposed "é") is the plain letter. Marks after
    // letters of other scripts (Thai, Devanagari, Hebrew points...) are part of the word and stay.
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .replace(/[Ææ]/g, "ae")
    .replace(/[Œœ]/g, "oe")
    .replace(/[Øø]/g, "o")
    .replace(/[ß]/g, "ss")
    .replace(/[Łł]/g, "l")
    .replace(/[À-ɏ]/g, (ch) => ch.normalize("NFD").replace(/[̀-ͯ]/g, ""))
    .replace(/(?<=\p{L})\$(?=\p{L})/gu, "S")
    .replace(/(?<=\p{L})!(?=\p{L})/gu, "i")
    .replace(/['’`´]/g, "")
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, " ")
    // A mark with no letter before it (after a space or symbol) belongs to nothing.
    .replace(/(?<![\p{L}\p{N}\p{M}])\p{M}+/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * The spelling release names use when an artist's name is split by punctuation and written as
 * one word ("AC/DC" -> "ACDC", "R.E.M." -> "REM", "blink-182" -> "blink182"). Empty when the
 * name has no such word.
 */
export function joinedArtistSpelling(artist: string): string {
  const words = String(artist || "").trim().split(/\s+/).filter(Boolean);
  let changed = false;
  const out = words.map((w) => {
    if (!/[\p{L}\p{N}\p{M}][\/.\-][\p{L}\p{N}]/u.test(w)) return w;
    changed = true;
    return w.replace(/[\/.\-]/g, "");
  });
  if (!changed) return "";
  const joined = indexerQueryText(out.join(" "));
  return joined && joined !== indexerQueryText(artist) ? joined : "";
}

/**
 * An album or single title without "(feat. ...)", "[From ...]" and edition tags: what release
 * names carry, used for searching and for comparing titles.
 */
export function coreReleaseTitle(title: string): string {
  const original = String(title || "").trim();
  let out = original;
  let prev = "";
  while (out !== prev) {
    prev = out;
    out = stripFeaturing(out)
      .replace(/\s*[\(\[]\s*(?:from|music\s+from|original|soundtrack|ost)\b[^\)\]]*[\)\]]\s*$/i, "")
      .trim();
    out = stripEditionSuffix(out);
  }
  return out || original;
}
