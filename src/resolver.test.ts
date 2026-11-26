import test from "node:test";
import assert from "node:assert/strict";
import type {
  CanonicalAlbum,
  HostEnv,
  KindItem,
  KindResolveRequest,
  SourceCandidate,
  SourceQuery,
  VerifiedAlbumRelease,
} from "./types.ts";
import { KVCache, isHostFaultOrAbort } from "./kv.ts";
import { DeezerClient } from "./deezer.ts";
import { MusicBrainzClient } from "./musicbrainz.ts";
import { MusicCatalog } from "./catalog.ts";
import {
  stripEditionSuffix,
  normalizeText,
  indexerQueryText,
  joinedArtistSpelling,
  coreReleaseTitle,
} from "./normalize.ts";
import {
  AlbumResolver,
  albumCacheKey,
  archiveMembersContradictAlbum,
  buildArchiveTrackHint,
  classifyReleaseQuality,
  classifyVideoQuality,
  durationToleranceFor,
  expandReleaseFiles,
  formatDroppedAtNameRanking,
  isReleaseExcluded,
  isStrictlyNarrowerQuery,
  isUsenetCandidate,
  matchAlbumReleaseFiles,
  matchTracksInRelease,
  pickRecordingReleases,
  matchConcertReleaseFiles,
  preScoreAlbumCandidate,
  preScoreConcertCandidate,
  searchIncomplete,
  searchMemoKey,
} from "./resolver.ts";
import { buildConcertItem, getCuratedConcertById } from "./concerts.ts";
import { isRejectedReleaseForRequest, isWrongVersionRelease, parseTrackFilename } from "./normalize.ts";

function makeFakeHost(opts: {
  onResolve?: (q: SourceQuery) => { candidates?: SourceCandidate[] };
  settings?: Record<string, unknown>;
} = {}): { env: HostEnv; kvMap: Map<string, string>; calls: SourceQuery[] } {
  const kvMap = new Map<string, string>();
  const calls: SourceQuery[] = [];
  let now = 1_760_000_000_000;
  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => kvMap.get(k) ?? null,
      put: (k, v) => { kvMap.set(k, v); },
      delete: (k) => { kvMap.delete(k); },
      list: (prefix = "") => Array.from(kvMap.keys()).filter((k) => k.startsWith(prefix)),
    },
    http: {
      fetch: () => ({ status: 404, body: "" }),
    },
    settings: {
      get: () => opts.settings || {},
    },
    sources: {
      resolve: (q) => {
        calls.push(q);
        return opts.onResolve ? opts.onResolve(q) : { candidates: [] };
      },
    },
  };
  return { env, kvMap, calls };
}

function sampleDiscoveryAlbum(): CanonicalAlbum {
  return {
    id: "al-302127",
    deezerAlbumId: 302127,
    artistId: "ar-27",
    deezerArtistId: 27,
    artistName: "Daft Punk",
    title: "Discovery",
    releaseDate: "2001-03-07",
    year: 2001,
    releaseType: "album",
    genres: ["Electronic"],
    label: "Daft Life Ltd.",
    fans: 345823,
    durationSec: 1200,
    trackCount: 4,
    discCount: 1,
    coverXL: "https://example.test/cover.jpg",
    coverBig: "https://example.test/cover500.jpg",
    curation: ["classic-album"],
    tracks: [
      { id: "tr-1", deezerTrackId: 1, title: "One More Time", disc: 1, trackNumber: 1, durationSec: 320, explicit: false, artistName: "Daft Punk" },
      { id: "tr-2", deezerTrackId: 2, title: "Aerodynamic", disc: 1, trackNumber: 2, durationSec: 212, explicit: false, artistName: "Daft Punk" },
      { id: "tr-3", deezerTrackId: 3, title: "Digital Love", disc: 1, trackNumber: 3, durationSec: 301, explicit: false, artistName: "Daft Punk" },
      { id: "tr-4", deezerTrackId: 4, title: "Harder, Better, Faster, Stronger", disc: 1, trackNumber: 4, durationSec: 224, explicit: false, artistName: "Daft Punk" },
    ],
  };
}

function trackItemFor(album: CanonicalAlbum, trackIdx: number): KindItem {
  const tr = album.tracks[trackIdx];
  return {
    id: tr.id,
    level: "track",
    parentId: album.id,
    index: trackIdx + 1,
    title: tr.title,
    playable: true,
    year: album.year,
    fields: {
      artistName: album.artistName,
      albumTitle: album.title,
      duration: tr.durationSec,
      disc: tr.disc,
    },
    hints: {
      albumId: album.id,
      deezerAlbumId: album.deezerAlbumId,
      deezerTrackId: tr.deezerTrackId,
      artistName: album.artistName,
      albumTitle: album.title,
      year: album.year,
      releaseType: album.releaseType,
      disc: tr.disc,
      trackNumber: tr.trackNumber,
      durationSec: tr.durationSec,
    },
  };
}

test("rejects compilations, discographies, live bootlegs, and tributes for studio albums", () => {
  assert.equal(isRejectedReleaseForRequest("Daft Punk - Greatest Hits (2010) FLAC", "Discovery", "album").rejected, true);
  assert.equal(isRejectedReleaseForRequest("Daft Punk - Complete Discography 1997-2013 FLAC", "Discovery", "album").rejected, true);
  assert.equal(isRejectedReleaseForRequest("Daft Punk - Live at Bercy (2007) FLAC", "Discovery", "album").rejected, true);
  assert.equal(isRejectedReleaseForRequest("Piano Tribute to Daft Punk - Discovery (2015) MP3", "Discovery", "album").rejected, true);
  assert.equal(isRejectedReleaseForRequest("Daft Punk - Discovery (2001) [WEB FLAC]", "Discovery", "album").rejected, false);
  // Genuine live album request should NOT reject live recordings
  assert.equal(isRejectedReleaseForRequest("Daft Punk - Alive 2007 (Live at Bercy) FLAC", "Alive 2007 (Live)", "live").rejected, false);
});

test("quality preference ranks FLAC > ALAC/WAV > MP3 320 > lower lossy and obeys lossless_only", () => {
  const flac = classifyReleaseQuality("Daft Punk - Discovery (2001) [WEB FLAC]", undefined, "flac_preferred");
  const alac = classifyReleaseQuality("Daft Punk - Discovery (2001) [ALAC]", undefined, "flac_preferred");
  const mp3 = classifyReleaseQuality("Daft Punk - Discovery (2001) [MP3 320]", undefined, "flac_preferred");
  const low = classifyReleaseQuality("Daft Punk - Discovery (2001) [MP3 128]", undefined, "flac_preferred");
  assert.ok(flac.points > alac.points);
  assert.ok(alac.points > mp3.points);
  assert.ok(mp3.points > low.points);

  const mp3LosslessOnly = classifyReleaseQuality("Daft Punk - Discovery (2001) [MP3 320]", undefined, "lossless_only");
  assert.ok(mp3LosslessOnly.points < 0);
});

test("parses single-disc and multi-disc track filenames cleanly", () => {
  assert.deepEqual(
    { disc: parseTrackFilename("01 - One More Time.flac").disc, track: parseTrackFilename("01 - One More Time.flac").track, title: parseTrackFilename("01 - One More Time.flac").titleGuess },
    { disc: null, track: 1, title: "One More Time" }
  );
  const d2 = parseTrackFilename("CD2/2-03. Daft Punk - Digital Love.flac", 2);
  assert.equal(d2.disc, 2);
  assert.equal(d2.track, 3);
  assert.equal(d2.titleGuess, "Digital Love");

  const compact = parseTrackFilename("204 - Harder Better Faster Stronger.flac", 2);
  assert.equal(compact.disc, 2);
  assert.equal(compact.track, 4);
});

test("matchAlbumReleaseFiles maps tracks uniquely, ignores artwork/log/cue, and rejects mismatched track counts", () => {
  const album = sampleDiscoveryAlbum();

  // Exact album + non-audio extras (cover.jpg, album.log, album.cue, par2)
  const goodFiles = [
    { index: 0, path: "Discovery/cover.jpg", size: 120_000 },
    { index: 1, path: "Discovery/01 - One More Time.flac", size: 36_800_000 },
    { index: 2, path: "Discovery/02 - Aerodynamic.flac", size: 24_400_000 },
    { index: 3, path: "Discovery/03 - Digital Love.flac", size: 34_600_000 },
    { index: 4, path: "Discovery/04 - Harder, Better, Faster, Stronger.flac", size: 25_700_000 },
    { index: 5, path: "Discovery/Discovery.cue", size: 2_048 },
    { index: 6, path: "Discovery/Discovery.log", size: 4_096 },
  ];
  const res = matchAlbumReleaseFiles(album, "Daft Punk - Discovery (2001) [FLAC]", goodFiles, "flac_preferred");
  assert.equal(res.matched, true);
  assert.equal(res.tracks["tr-1"].fileIndex, 1);
  assert.equal(res.tracks["tr-1"].mime, "audio/flac");
  assert.equal(res.tracks["tr-3"].fileIndex, 3);
  assert.equal(res.tracks["tr-4"].file, "Discovery/04 - Harder, Better, Faster, Stronger.flac");

  // Incomplete release (missing track 4) must be rejected
  const incomplete = matchAlbumReleaseFiles(album, "Daft Punk - Discovery (2001) FLAC", goodFiles.slice(0, 4), "flac_preferred");
  assert.equal(incomplete.matched, false);
  assert.match(incomplete.reason || "", /incomplete/i);

  // Huge multi-album pack (20 files vs 4 expected) must be rejected
  const hugePack = Array.from({ length: 20 }, (_, i) => ({
    index: i,
    path: `Discography/${String(i + 1).padStart(2, "0")} - Track ${i + 1}.flac`,
    size: 25_000_000,
  }));
  const tooMany = matchAlbumReleaseFiles(album, "Daft Punk - Discovery FLAC", hugePack, "flac_preferred");
  assert.equal(tooMany.matched, false);
  assert.match(tooMany.reason || "", /mismatched track count/i);
});

test("matchAlbumReleaseFiles handles multi-disc albums accurately", () => {
  const multi: CanonicalAlbum = {
    ...sampleDiscoveryAlbum(),
    id: "al-multi",
    title: "The Wall",
    artistName: "Pink Floyd",
    year: 1979,
    trackCount: 4,
    discCount: 2,
    tracks: [
      { id: "tr-d1-1", deezerTrackId: 101, title: "In the Flesh?", disc: 1, trackNumber: 1, durationSec: 199, explicit: false, artistName: "Pink Floyd" },
      { id: "tr-d1-2", deezerTrackId: 102, title: "The Thin Ice", disc: 1, trackNumber: 2, durationSec: 147, explicit: false, artistName: "Pink Floyd" },
      { id: "tr-d2-1", deezerTrackId: 201, title: "Hey You", disc: 2, trackNumber: 1, durationSec: 280, explicit: false, artistName: "Pink Floyd" },
      { id: "tr-d2-2", deezerTrackId: 202, title: "Comfortably Numb", disc: 2, trackNumber: 2, durationSec: 382, explicit: false, artistName: "Pink Floyd" },
    ],
  };

  const files = [
    { index: 0, path: "CD1/01 - In the Flesh.flac", size: 22_000_000 },
    { index: 1, path: "CD1/02 - The Thin Ice.flac", size: 17_000_000 },
    { index: 2, path: "CD2/01 - Hey You.flac", size: 32_000_000 },
    { index: 3, path: "CD2/02 - Comfortably Numb.flac", size: 44_000_000 },
  ];
  const res = matchAlbumReleaseFiles(multi, "Pink Floyd - The Wall (1979) [2CD FLAC]", files, "flac_preferred");
  assert.equal(res.matched, true);
  assert.equal(res.tracks["tr-d1-1"].fileIndex, 0);
  assert.equal(res.tracks["tr-d2-1"].fileIndex, 2);
  assert.equal(res.tracks["tr-d2-2"].fileIndex, 3);
});

test("album-unit resolution resolves ONCE for track 1, prefers FLAC over MP3 320, and serves track 2..4 instantaneously from KV with failover", () => {
  const album = sampleDiscoveryAlbum();
  const flacCand: SourceCandidate = {
    infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    title: "Daft Punk - Discovery (2001) [WEB FLAC]",
    size: 130_000_000,
    indexer: "Redacted",
  };
  const mp3Cand: SourceCandidate = {
    nzbUrl: "https://nzb.test/discovery-mp3.nzb",
    title: "Daft Punk - Discovery (2001) [MP3 320]",
    size: 42_000_000,
    indexer: "NZBgeek",
  };
  const compCand: SourceCandidate = {
    infoHash: "cccccccccccccccccccccccccccccccccccccccc",
    title: "Daft Punk - Greatest Hits (2010) [FLAC]",
    size: 200_000_000,
    indexer: "Tracker",
  };

  const { env, calls } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") {
        assert.equal(q.category, "3000,3010,3040");
        return { candidates: [compCand, mp3Cand, flacCand] };
      }
      if (q.kind === "debrid_check") {
        return {
          candidates: (q.infoHashes || []).map((h) => ({ infoHash: h, cached: h === flacCand.infoHash })),
        };
      }
      if (q.kind === "release_files") {
        if (q.candidate?.infoHash === flacCand.infoHash) {
          return {
            candidates: [{
              ...flacCand,
              cached: true,
              files: [
                { index: 0, path: "01 - One More Time.flac", size: 36_800_000 },
                { index: 1, path: "02 - Aerodynamic.flac", size: 24_400_000 },
                { index: 2, path: "03 - Digital Love.flac", size: 34_600_000 },
                { index: 3, path: "04 - Harder, Better, Faster, Stronger.flac", size: 25_700_000 },
              ],
            }],
          };
        }
        if (q.candidate?.nzbUrl === mp3Cand.nzbUrl) {
          return {
            candidates: [{
              ...mp3Cand,
              files: [
                { index: 0, path: "01. One More Time.mp3", size: 12_800_000 },
                { index: 1, path: "02. Aerodynamic.mp3", size: 8_400_000 },
                { index: 2, path: "03. Digital Love.mp3", size: 12_000_000 },
                { index: 3, path: "04. Harder Better Faster Stronger.mp3", size: 8_900_000 },
              ],
            }],
          };
        }
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  // 1. Track 1 cold resolve completes album-unit resolution on first call when fast (preferring FLAC!)
  const req1: KindResolveRequest = { item: trackItemFor(album, 0) };
  const hot1 = resolver.resolve(req1);
  assert.equal(hot1.pending, undefined);
  assert.ok(hot1.sources.length >= 1);
  assert.equal(hot1.sources[0].mime, "audio/flac");
  assert.equal(hot1.sources[0].release?.fileIndex, 0);
  assert.equal(hot1.sources[0].release?.file, "01 - One More Time.flac");
  const callsAfterCold = calls.length;

  // 2. Track 3 plays immediately from the SAME cached album release with ZERO source queries!
  const hot3 = resolver.resolve({ item: trackItemFor(album, 2) });
  assert.equal(hot3.pending, undefined);
  assert.equal(hot3.sources[0].mime, "audio/flac");
  assert.equal(hot3.sources[0].release?.fileIndex, 2);
  assert.equal(hot3.sources[0].release?.file, "03 - Digital Love.flac");
  assert.equal(calls.length, callsAfterCold);

  // 3. Failover: if FLAC release is excluded by client, automatically yields MP3 320 release!
  const failover = resolver.resolve({
    item: trackItemFor(album, 2),
    client: { exclude: [hot3.sources[0].id] },
  });
  assert.equal(failover.sources.length, 1);
  assert.equal(failover.sources[0].mime, "audio/mpeg");
  assert.equal(failover.sources[0].size, undefined);
  assert.equal(failover.sources[0].release?.fileIndex, 2);
  assert.equal(failover.sources[0].release?.file, "03. Digital Love.mp3");
});

test("preScoreAlbumCandidate rejects uncached torrents & honors compilation guard", () => {
  const album = { artistName: "Daft Punk", title: "Discovery", year: 2001, releaseType: "album" as const, durationSec: 3662 };
  const good = preScoreAlbumCandidate(
    { title: "Daft Punk - Discovery (2001) [WEB FLAC]", cached: true, infoHash: "abc", size: 420_000_000 },
    album,
    "flac_preferred"
  );
  assert.equal(good.accepted, true);

  const wrongArtist = preScoreAlbumCandidate(
    { title: "Mike Oldfield - Discovery (1984) [FLAC]", cached: true, infoHash: "def", size: 300_000_000 },
    album,
    "flac_preferred"
  );
  assert.equal(wrongArtist.accepted, false);
});

test("isUsenetCandidate accepts real NZB candidates and rejects Cardigann torrent URLs", () => {
  assert.equal(
    isUsenetCandidate({
      nzbUrl: "https://api.nzbgeek.info/api?t=get&id=abc123",
      indexer: "NZBgeek",
      title: "Miles Davis - Kind of Blue (1959) [FLAC]",
    }),
    true
  );
  assert.equal(
    isUsenetCandidate({
      nzbUrl: "https://www.limetorrents.fun/Miles-Davis-torrent-19999846.html",
      indexer: "LimeTorrents",
      seeders: 12,
      title: "Miles Davis - Kind of Blue (1959) [FLAC]",
    }),
    false
  );
  assert.equal(
    isUsenetCandidate({
      nzbUrl: "https://example.org/download.torrent",
      indexer: "SomeIndexer",
      seeders: 4,
      title: "Daft Punk - Discovery (2001) [FLAC]",
    }),
    false
  );
});

test("stripEditionSuffix strips ordinal anniversary and reissue tags", () => {
  assert.equal(stripEditionSuffix("Back To Black (20th Anniversary Edition)"), "Back To Black");
  assert.equal(stripEditionSuffix("OK Computer (25th Anniversary Super Deluxe)"), "OK Computer");
  assert.equal(stripEditionSuffix("1 (Remastered 2015)"), "1");
  assert.equal(stripEditionSuffix("Rumours - 35th Anniversary Deluxe Edition"), "Rumours");
  assert.equal(stripEditionSuffix("72 Seasons"), "72 Seasons");
  assert.equal(normalizeText("Lux Æterna"), "lux aeterna");
  assert.equal(normalizeText("Tool - Ænima"), "tool aenima");
});

test("matchAlbumReleaseFiles allows standard edition FLAC for expanded Anniversary editions", () => {
  const expanded: CanonicalAlbum = {
    id: "al-1122870082",
    deezerAlbumId: 1122870082,
    artistId: "ar-9052",
    deezerArtistId: 9052,
    artistName: "Amy Winehouse",
    title: "Back To Black (20th Anniversary Edition)",
    releaseDate: "2026-10-30",
    year: 2026,
    releaseType: "album",
    genres: ["Soul"],
    label: "Island",
    fans: 100000,
    durationSec: 6000,
    trackCount: 16,
    discCount: 2,
    coverXL: "",
    coverBig: "",
    curation: [],
    tracks: [
      { id: "tr-1", deezerTrackId: 1, disc: 1, trackNumber: 1, title: "Rehab", artistName: "Amy Winehouse", durationSec: 214, explicit: false, rank: 900000 },
      { id: "tr-2", deezerTrackId: 2, disc: 1, trackNumber: 2, title: "You Know I'm No Good", artistName: "Amy Winehouse", durationSec: 257, explicit: false, rank: 800000 },
      { id: "tr-3", deezerTrackId: 3, disc: 1, trackNumber: 3, title: "Me & Mr Jones", artistName: "Amy Winehouse", durationSec: 153, explicit: false, rank: 700000 },
      { id: "tr-4", deezerTrackId: 4, disc: 1, trackNumber: 4, title: "Just Friends", artistName: "Amy Winehouse", durationSec: 193, explicit: false, rank: 600000 },
      { id: "tr-5", deezerTrackId: 5, disc: 1, trackNumber: 5, title: "Back To Black", artistName: "Amy Winehouse", durationSec: 241, explicit: false, rank: 950000 },
      { id: "tr-6", deezerTrackId: 6, disc: 1, trackNumber: 6, title: "Love Is A Losing Game", artistName: "Amy Winehouse", durationSec: 155, explicit: false, rank: 850000 },
      { id: "tr-7", deezerTrackId: 7, disc: 1, trackNumber: 7, title: "Tears Dry On Their Own", artistName: "Amy Winehouse", durationSec: 186, explicit: false, rank: 820000 },
      { id: "tr-8", deezerTrackId: 8, disc: 1, trackNumber: 8, title: "Wake Up Alone", artistName: "Amy Winehouse", durationSec: 222, explicit: false, rank: 650000 },
      { id: "tr-9", deezerTrackId: 9, disc: 1, trackNumber: 9, title: "Some Unholy War", artistName: "Amy Winehouse", durationSec: 142, explicit: false, rank: 610000 },
      { id: "tr-10", deezerTrackId: 10, disc: 1, trackNumber: 10, title: "He Can Only Hold Her", artistName: "Amy Winehouse", durationSec: 166, explicit: false, rank: 600000 },
      { id: "tr-11", deezerTrackId: 11, disc: 2, trackNumber: 1, title: "Rehab (Demo Version)", artistName: "Amy Winehouse", durationSec: 210, explicit: false, rank: 300000 },
      { id: "tr-12", deezerTrackId: 12, disc: 2, trackNumber: 2, title: "Back To Black (Demo)", artistName: "Amy Winehouse", durationSec: 240, explicit: false, rank: 300000 },
      { id: "tr-13", deezerTrackId: 13, disc: 2, trackNumber: 3, title: "Love Is A Losing Game (Live)", artistName: "Amy Winehouse", durationSec: 160, explicit: false, rank: 300000 },
      { id: "tr-14", deezerTrackId: 14, disc: 2, trackNumber: 4, title: "Tears Dry (Live)", artistName: "Amy Winehouse", durationSec: 190, explicit: false, rank: 300000 },
      { id: "tr-15", deezerTrackId: 15, disc: 2, trackNumber: 5, title: "Valerie (Live)", artistName: "Amy Winehouse", durationSec: 220, explicit: false, rank: 300000 },
      { id: "tr-16", deezerTrackId: 16, disc: 2, trackNumber: 6, title: "Monkey Man", artistName: "Amy Winehouse", durationSec: 175, explicit: false, rank: 300000 },
    ],
  };

  const standardFiles = expanded.tracks.slice(0, 10).map((t, i) => ({
    index: i,
    path: `Amy Winehouse - Back To Black/${String(i + 1).padStart(2, "0")} - ${t.title}.flac`,
    size: 25_000_000,
  }));
  const res = matchAlbumReleaseFiles(expanded, "Amy Winehouse - Back To Black (2006) [FLAC]", standardFiles);
  assert.equal(res.matched, true);
  assert.equal(res.partial, true);
  assert.equal(res.tracks["tr-1"].fileIndex, 0);
  assert.equal(res.tracks["tr-5"].fileIndex, 4);

  // Tiny 3-track sample is STILL rejected even on an Anniversary edition.
  const tiny = matchAlbumReleaseFiles(expanded, "Amy Winehouse - Back To Black [FLAC]", standardFiles.slice(0, 3));
  assert.equal(tiny.matched, false);
});

test("AlbumResolver probes cached Debrid FLAC before 6 Usenet RAR posts", () => {
  const album = sampleDiscoveryAlbum();
  const rarPosts: SourceCandidate[] = Array.from({ length: 6 }, (_, i) => ({
    title: `Daft Punk - Discovery (2001) [24BIT-96kHz WEB-FLAC] Release${i}`,
    indexer: "NinjaCentral",
    nzbUrl: `https://ninjacentral.co.za/getnzb/rar-${i}.nzb`,
    size: 1_200_000_000,
  }));
  const debridFlac: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [16bit FLAC]",
    indexer: "TorrentGalaxy",
    infoHash: "feedface1234567890abcdef1234567890abcdef",
    size: 420_000_000,
  };

  const probedRefs: string[] = [];
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [...rarPosts, debridFlac] };
      if (q.kind === "debrid_check") {
        return {
          candidates: (q.infoHashes || []).map((h) => ({ infoHash: h, cached: h === debridFlac.infoHash })),
        };
      }
      if (q.kind === "release_files") {
        const cand = q.candidate!;
        probedRefs.push(cand.infoHash || cand.nzbUrl || "");
        if (cand.infoHash === debridFlac.infoHash) {
          return {
            candidates: [
              {
                ...debridFlac,
                cached: true,
                files: album.tracks.map((t, idx) => ({
                  index: idx,
                  path: `${String(idx + 1).padStart(2, "0")} - ${t.title}.flac`,
                  size: 30_000_000,
                })),
              },
            ],
          };
        }
        return {
          candidates: [
            {
              ...cand,
              files: [{ index: 0, path: "Daft.Punk.part01.rar", size: 50_000_000 }],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 1) });
  assert.equal(res.pending, undefined);
  assert.ok(res.sources.length >= 1);
  assert.equal(res.sources[0].release?.candidate?.infoHash, debridFlac.infoHash);
  assert.equal(probedRefs[0], debridFlac.infoHash);
});

test("AlbumResolver deduplicates scene Usenet reposts and prefers unpacked P2P FLAC", () => {
  const album = sampleDiscoveryAlbum();
  const dupScene: SourceCandidate[] = Array.from({ length: 4 }, (_, i) => ({
    title: "Daft Punk-Discovery-24BIT-WEB-FLAC-2001-MOONBLOOD",
    indexer: "NinjaCentral",
    nzbUrl: `https://ninjacentral.co.za/getnzb/scene-${i}.nzb`,
    size: 1_200_000_000 + i * 1000,
  }));
  const p2pFlac: SourceCandidate = {
    title: "Daft Punk - Discovery 2001 [24Bit-48kHz] FLAC [PMEDIA]",
    indexer: "NinjaCentral",
    nzbUrl: "https://ninjacentral.co.za/getnzb/pmedia-unpacked.nzb",
    size: 900_000_000,
  };

  const probedUrls: string[] = [];
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [...dupScene, p2pFlac] };
      if (q.kind === "release_files") {
        const cand = q.candidate!;
        probedUrls.push(cand.nzbUrl || "");
        if (cand.nzbUrl === p2pFlac.nzbUrl) {
          return {
            candidates: [
              {
                ...p2pFlac,
                files: album.tracks.map((t, idx) => ({
                  index: idx,
                  path: `${String(idx + 1).padStart(2, "0")}. ${t.title}.flac`,
                  size: 32_000_000,
                })),
              },
            ],
          };
        }
        return {
          candidates: [
            {
              ...cand,
              files: [{ index: 0, path: "release.part01.rar", size: 50_000_000 }],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(res.pending, undefined);
  assert.equal(probedUrls[0], p2pFlac.nzbUrl);
  assert.equal(res.sources[0].release?.candidate?.nzbUrl, p2pFlac.nzbUrl);
  // All 4 identical scene titles deduplicated to at most 1 probe.
  assert.ok(probedUrls.filter((u) => u.includes("scene-")).length <= 1);
});

test("AlbumResolver uses usenet_check to drop dead and playbackFailed NZBs before offering", () => {
  const album = sampleDiscoveryAlbum();
  const deadFlac: SourceCandidate = {
    title: "Daft Punk - Discovery 2001 [24Bit-96kHz] FLAC [PMEDIA]",
    indexer: "NinjaCentral",
    nzbUrl: "https://ninjacentral.co.za/getnzb/dead-articles.nzb",
    size: 1_100_000_000,
  };
  const failedRar: SourceCandidate = {
    title: "Daft Punk-Discovery-24BIT-WEB-FLAC-2001-MOONBLOOD",
    indexer: "NinjaCentral",
    nzbUrl: "https://ninjacentral.co.za/getnzb/failed-rar.nzb",
    size: 1_200_000_000,
  };
  const healthyFlac: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC]",
    indexer: "NZBgeek",
    nzbUrl: "https://api.nzbgeek.info/api?t=get&id=healthy123",
    size: 430_000_000,
  };

  const checkedUrls: string[] = [];
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [deadFlac, failedRar, healthyFlac] };
      if (q.kind === "release_files") {
        const cand = q.candidate!;
        if (cand.nzbUrl === failedRar.nzbUrl) {
          return { candidates: [{ ...cand, files: [{ index: 0, path: "album.part01.rar", size: 50_000_000 }] }] };
        }
        return {
          candidates: [
            {
              ...cand,
              files: album.tracks.map((t, idx) => ({
                index: idx,
                path: `${String(idx + 1).padStart(2, "0")} - ${t.title}.flac`,
                size: 30_000_000,
              })),
            },
          ],
        };
      }
      if (q.kind === "usenet_check") {
        const u = q.nzbUrl || q.candidate?.nzbUrl || "";
        checkedUrls.push(u);
        if (u === deadFlac.nzbUrl) {
          return {
            candidates: [
              {
                ...deadFlac,
                usenetCheck: { available: false, checked: 32, missing: 12, reason: "articles_missing" },
              },
            ],
          };
        }
        if (u === failedRar.nzbUrl) {
          return {
            candidates: [
              {
                ...failedRar,
                usenetCheck: {
                  available: false,
                  checked: 0,
                  missing: 1,
                  cached: true,
                  playbackFailed: true,
                  reason: "playback_article_missing",
                },
              },
            ],
          };
        }
        return {
          candidates: [
            {
              ...healthyFlac,
              usenetCheck: { available: true, checked: 32, missing: 0, cached: false },
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(res.pending, undefined);
  assert.equal(res.sources.length, 1);
  assert.equal(res.sources[0].release?.candidate?.nzbUrl, healthyFlac.nzbUrl);
  assert.ok(checkedUrls.includes(deadFlac.nzbUrl!));
  assert.ok(checkedUrls.includes(healthyFlac.nzbUrl!));
});

test("AlbumResolver degrades gracefully when usenet_check is unavailable or rate-limited and skips it in background jobs", () => {
  const album = sampleDiscoveryAlbum();
  const nzbFlac: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC]",
    indexer: "NZBgeek",
    nzbUrl: "https://api.nzbgeek.info/api?t=get&id=compat123",
    size: 430_000_000,
  };

  let checkCalls = 0;
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [nzbFlac] };
      if (q.kind === "release_files") {
        return {
          candidates: [
            {
              ...nzbFlac,
              files: album.tracks.map((t, idx) => ({
                index: idx,
                path: `${String(idx + 1).padStart(2, "0")} - ${t.title}.flac`,
                size: 30_000_000,
              })),
            },
          ],
        };
      }
      if (q.kind === "usenet_check") {
        checkCalls++;
        throw new Error("rate_limited: 429");
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  // 1. Background job must never invoke usenet_check.
  const jobRes = resolver.runAlbumResolveJob({ item: trackItemFor(album, 0) });
  assert.equal(jobRes.verifiedCount, 1);
  assert.equal(checkCalls, 0);

  // 2. Interactive resolve tolerates host error/429 and still offers the verified release.
  cache.delete(albumCacheKey("al-302127"));
  const liveRes = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(liveRes.sources.length, 1);
  assert.equal(liveRes.sources[0].release?.candidate?.nzbUrl, nzbFlac.nzbUrl);
  assert.equal(checkCalls, 1);
});

test("classifyVideoQuality ranks 4K HDR > 1080p BluRay > 720p > DVD and respects 1080p_preferred", () => {
  const uhd = classifyVideoQuality("Stop.Making.Sense.1984.2160p.UHD.BluRay.HDR10.Atmos.x265", undefined, "uhd_preferred");
  const hd = classifyVideoQuality("Stop.Making.Sense.1984.1080p.BluRay.DTS-HD.MA.5.1.x264", undefined, "uhd_preferred");
  const p720 = classifyVideoQuality("Stop.Making.Sense.1984.720p.WEB-DL.x264", undefined, "uhd_preferred");
  const dvd = classifyVideoQuality("Stop.Making.Sense.1984.DVDRip.x264", undefined, "uhd_preferred");
  assert.equal(uhd.tier, "uhd");
  assert.equal(hd.tier, "1080p");
  assert.ok(uhd.points > hd.points && hd.points > p720.points && p720.points > dvd.points);

  const hdPref = classifyVideoQuality("Stop.Making.Sense.1984.1080p.BluRay.x264", undefined, "1080p_preferred");
  const uhdUnder1080 = classifyVideoQuality("Stop.Making.Sense.1984.2160p.BluRay.x265", undefined, "1080p_preferred");
  assert.ok(hdPref.points > uhdUnder1080.points);
});

test("preScoreConcertCandidate rejects audio-only rips, accepts acronym/BluRay+FLAC, and matches standalone titles", () => {
  const pulse = {
    artistName: "Pink Floyd",
    title: "P.U.L.S.E. Live at Earls Court",
    year: 1995,
    filmedYear: 1994,
    standaloneTitle: false,
  };
  // Audio-only FLAC must be rejected for video concerts!
  const audioOnly = preScoreConcertCandidate(
    { title: "Pink Floyd - P.U.L.S.E. (1995) [FLAC]", cached: true, size: 950_000_000 },
    pulse
  );
  assert.equal(audioOnly.accepted, false);

  // Blu-ray video release with FLAC 5.1 audio track must be ACCEPTED (and acronym P.U.L.S.E. == PULSE).
  const blurayWithFlac = preScoreConcertCandidate(
    { title: "Pink.Floyd.PULSE.1995.1080p.BluRay.FLAC.5.1.x264-GROUP", cached: true, size: 12_000_000_000 },
    pulse
  );
  assert.equal(blurayWithFlac.accepted, true);
  assert.ok(blurayWithFlac.score > 90);

  // Standalone theatrical concert film without artist name in release title must match!
  const sms = {
    artistName: "Talking Heads",
    title: "Stop Making Sense",
    year: 1984,
    filmedYear: 1983,
    standaloneTitle: true,
  };
  const smsUhd = preScoreConcertCandidate(
    { title: "Stop.Making.Sense.1984.2160p.UHD.BluRay.HDR.Atmos.x265", cached: true, size: 18_500_000_000 },
    sms
  );
  assert.equal(smsUhd.accepted, true);

  // Generic concert title without matching artist must be rejected!
  const wembley = {
    artistName: "Queen",
    title: "Live at Wembley Stadium",
    year: 1986,
    filmedYear: 1986,
    standaloneTitle: false,
  };
  const wrongArtist = preScoreConcertCandidate(
    { title: "Foo.Fighters.Live.at.Wembley.Stadium.2008.1080p.BluRay.x264", cached: true, size: 9_000_000_000 },
    wembley
  );
  assert.equal(wrongArtist.accepted, false);
});

test("matchConcertReleaseFiles picks main feature video and ignores samples, extras, and audio-only packs", () => {
  const mixed = matchConcertReleaseFiles("Stop.Making.Sense.1984.2160p.BluRay.x265", [
    { index: 0, path: "Stop Making Sense/Sample/sample.mkv", size: 80_000_000 },
    { index: 1, path: "Stop Making Sense/Extras/Bonus Interview.mkv", size: 650_000_000 },
    { index: 2, path: "Stop Making Sense/Stop.Making.Sense.1984.2160p.mkv", size: 16_400_000_000 },
    { index: 3, path: "Stop Making Sense/soundtrack.flac", size: 420_000_000 },
  ]);
  assert.equal(mixed.matched, true);
  assert.equal(mixed.file?.index, 2);
  assert.equal(mixed.quality.mime, "video/x-matroska");

  const audioPack = matchConcertReleaseFiles("Pink Floyd - Pulse", [
    { index: 0, path: "01 - Shine On.flac", size: 70_000_000 },
    { index: 1, path: "02 - Learning to Fly.flac", size: 55_000_000 },
  ]);
  assert.equal(audioPack.matched, false);
});

test("AlbumResolver resolves video concerts via concertNewznabCategories, drops dead Usenet, and caches verified MKV", () => {
  const curated = getCuratedConcertById("co-talking-heads-stop-making-sense")!;
  assert.ok(curated);
  const concertItem = buildConcertItem(curated);

  const audioDecoy: SourceCandidate = {
    title: "Talking Heads - Stop Making Sense (1984) [FLAC]",
    infoHash: "aaaa1111aaaa1111aaaa1111aaaa1111aaaa1111",
    size: 520_000_000,
    cached: true,
  };
  const deadUsenet: SourceCandidate = {
    title: "Stop.Making.Sense.1984.2160p.UHD.BluRay.x265",
    indexer: "NZBgeek",
    nzbUrl: "https://api.nzbgeek.info/api?t=get&id=dead-concert",
    size: 19_000_000_000,
  };
  const cachedDebrid: SourceCandidate = {
    title: "Stop.Making.Sense.1984.1080p.BluRay.DTS-HD.MA.5.1.x264",
    infoHash: "bbbb2222bbbb2222bbbb2222bbbb2222bbbb2222",
    size: 11_200_000_000,
  };

  let searchCalls = 0;
  let lastCategory = "";
  let firstSearchQuery: SourceQuery | null = null;
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") {
        searchCalls++;
        if (!firstSearchQuery) firstSearchQuery = q;
        lastCategory = q.category || "";
        return { candidates: [audioDecoy, deadUsenet, cachedDebrid] };
      }
      if (q.kind === "debrid_check") {
        return { candidates: [{ infoHash: cachedDebrid.infoHash, cached: true }] };
      }
      if (q.kind === "release_files") {
        if (q.infoHash === cachedDebrid.infoHash) {
          return {
            candidates: [
              {
                ...cachedDebrid,
                cached: true,
                files: [
                  { index: 0, path: "Sample/sample.mkv", size: 60_000_000 },
                  { index: 1, path: "Stop.Making.Sense.1984.1080p.BluRay.mkv", size: 11_100_000_000 },
                ],
              },
            ],
          };
        }
        return {
          candidates: [
            {
              ...deadUsenet,
              files: [{ index: 0, path: "Stop.Making.Sense.1984.2160p.mkv", size: 18_900_000_000 }],
            },
          ],
        };
      }
      if (q.kind === "usenet_check") {
        return {
          candidates: [
            { ...deadUsenet, usenetCheck: { available: false, checked: 32, missing: 32, reason: "dmca" } },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const first = resolver.resolve({ item: concertItem });
  assert.equal(first.pending, undefined);
  assert.equal(lastCategory, "2000,2040,2045,3020,5000");
  assert.equal(firstSearchQuery?.firstResults, true);
  assert.equal(firstSearchQuery?.settleMs, 300);
  assert.equal(firstSearchQuery?.timeoutMs, 2500);
  assert.equal(first.sources.length, 1);
  assert.equal(first.sources[0].mime, "video/x-matroska");
  assert.equal(first.sources[0].release?.fileIndex, 1);
  assert.match(first.sources[0].label || "", /1080p.*Debrid/);

  // Second call hits KV cache with zero indexer searches.
  const callsAfterFirst = searchCalls;
  const second = resolver.resolve({ item: concertItem });
  assert.equal(second.sources.length, 1);
  assert.equal(searchCalls, callsAfterFirst);
});

test("isHostFaultOrAbort propagates fatal lifecycle faults and allows non-fatal structured faults (like usenet_check invalid_input) to degrade cleanly", () => {
  // Fatal faults MUST propagate.
  assert.equal(isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"timeout","message":"timed out"}')), true);
  assert.equal(isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"governance","message":"budget"}')), true);
  assert.equal(isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"aborted","message":"stop"}')), true);
  assert.equal(isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"deadline_exceeded","message":"deadline"}')), true);
  assert.equal(isHostFaultOrAbort(new Error("__ETHER_FAULT__")), true);
  assert.equal(isHostFaultOrAbort(Object.assign(new Error("aborted"), { name: "AbortError" })), true);

  // Non-fatal host faults MUST be catchable so optional queries (usenet_check, enrichment) degrade gracefully.
  assert.equal(
    isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"invalid_input","message":"unknown source query kind \\"usenet_check\\""}')),
    false
  );
  assert.equal(isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"rate_limited","message":"429"}')), false);
  assert.equal(isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"host_error","message":"dns failed"}')), false);
  assert.equal(isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"upstream","message":"503"}')), false);
  assert.equal(isHostFaultOrAbort(new Error('__ETHER_FAULT__{"code":"check_dependency","message":"offline"}')), false);

  // End-to-end check: concert Usenet resolve survives Ether throwing __ETHER_FAULT__ invalid_input on usenet_check.
  const kv = new Map<string, string>();
  const env: HostEnv = {
    now: () => 20_000,
    log: () => {},
    kv: {
      get: (k) => kv.get(k) ?? null,
      put: (k, v) => { kv.set(k, v); },
      delete: (k) => { kv.delete(k); },
      list: (p = "") => Array.from(kv.keys()).filter((k) => k.startsWith(p)),
    },
    http: { fetch: () => ({ status: 200, headers: {}, body: "{}" }) },
    settings: { get: () => ({}) },
    sources: {
      resolve: (q: SourceQuery) => {
        if (q.kind === "indexer_search") {
          return {
            candidates: [
              {
                id: "nzb-c1",
                title: "Talking.Heads.Stop.Making.Sense.1984.1080p.BluRay.x264-GRP",
                protocol: "usenet",
                nzbUrl: "https://indexer.example/nzb/c1",
                indexer: "NZBgeek",
                size: 8_200_000_000,
                seeders: 0,
                cached: false,
              },
            ],
          };
        }
        if (q.kind === "usenet_check") {
          const e = new Error('__ETHER_FAULT__{"code":"invalid_input","message":"unknown source query kind \\"usenet_check\\""}');
          (e as { code?: string }).code = "invalid_input";
          throw e;
        }
        if (q.kind === "release_files") {
          return {
            candidates: [
              {
                id: "nzb-c1",
                nzbUrl: "https://indexer.example/nzb/c1",
                files: [
                  { index: 0, path: "Talking.Heads.Stop.Making.Sense.1984.1080p.BluRay.mkv", size: 8_100_000_000 },
                ],
              },
            ],
          };
        }
        return { candidates: [] };
      },
    },
  };
  const cache = new KVCache(env);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({
    item: {
      id: "co-talking-heads-stop-making-sense-1984",
      level: "concert",
      parent: "ar-230",
      title: "Stop Making Sense",
      year: 1984,
      fields: { artist: "Talking Heads", venue: "Pantages Theatre, Hollywood", imdbId: "tt0088178" },
    },
  });
  assert.equal(res.sources.length, 1);
  assert.equal(res.sources[0].mime, "video/x-matroska");
  assert.equal(res.sources[0].release?.candidate?.nzbUrl, "https://indexer.example/nzb/c1");
});

test("Issue #753: RAR/ZIP archive with release_files.members expands exact inner member path into fileHint only", () => {
  const album: CanonicalAlbum = {
    id: "al-753001",
    deezerAlbumId: 753001,
    artistId: "ar-259",
    deezerArtistId: 259,
    artistName: "Michael Jackson",
    title: "HIStory: Past, Present and Future, Book I",
    releaseDate: "1995-06-16",
    year: 1995,
    releaseType: "album",
    genres: ["Pop"],
    label: "Epic",
    fans: 1_200_000,
    durationSec: 1200,
    trackCount: 4,
    discCount: 2,
    coverXL: "",
    coverBig: "",
    curation: [],
    tracks: [
      { id: "tr-7531", deezerTrackId: 7531, title: "Billie Jean", disc: 1, trackNumber: 1, durationSec: 294, explicit: false, artistName: "Michael Jackson" },
      { id: "tr-7532", deezerTrackId: 7532, title: "Beat It", disc: 1, trackNumber: 2, durationSec: 258, explicit: false, artistName: "Michael Jackson" },
      { id: "tr-7533", deezerTrackId: 7533, title: "Scream (feat. Janet Jackson)", disc: 2, trackNumber: 1, durationSec: 278, explicit: false, artistName: "Michael Jackson" },
      { id: "tr-7534", deezerTrackId: 7534, title: "They Don't Care About Us", disc: 2, trackNumber: 2, durationSec: 284, explicit: false, artistName: "Michael Jackson" },
    ],
  };

  const rarCand: SourceCandidate = {
    title: "Michael.Jackson-HIStory.Past.Present.and.Future.Book.I-1995-FLAC-GRP",
    nzbUrl: "https://indexer.example/nzb/mj-rar",
    indexer: "NZBgeek",
    size: 160_000_000,
  };

  const zipCand: SourceCandidate = {
    title: "Michael.Jackson-HIStory.Past.Present.and.Future.Book.I-1995-MP3-320-GRP",
    nzbUrl: "https://indexer.example/nzb/mj-zip",
    indexer: "NZBgeek",
    size: 48_000_000,
  };

  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") {
        return { candidates: [rarCand, zipCand] };
      }
      if (q.kind === "usenet_check") {
        return { candidates: [{ nzbUrl: q.nzbUrl, usenetCheck: { available: true, checked: 4, missing: 0 } }] };
      }
      if (q.kind === "release_files") {
        if (q.candidate?.nzbUrl === rarCand.nzbUrl) {
          return {
            candidates: [
              {
                ...rarCand,
                files: [
                  { index: 0, path: "release.nfo", size: 1200 },
                  {
                    index: 1,
                    path: "mj-history.part01.rar",
                    size: 80_000_000,
                    members: [
                      { index: 0, path: "CD1/01 - Michael Jackson - Billie Jean.flac", size: 32_000_000, stored: true },
                      { index: 1, path: "CD1/02 - Michael Jackson - Beat It.flac", size: 28_000_000, stored: true },
                      { index: 2, path: "CD2/01 - Michael Jackson - Scream.flac", size: 31_000_000, stored: true },
                      { index: 3, path: "CD2/02 - Michael Jackson - They Don't Care About Us.flac", size: 33_000_000, stored: true },
                      { index: 4, path: "cover.jpg", size: 250_000, stored: true },
                    ],
                  },
                  { index: 2, path: "mj-history.part02.rar", size: 80_000_000 },
                ],
              },
            ],
          };
        }
        return {
          candidates: [
            {
              ...zipCand,
              files: [
                {
                  index: 0,
                  path: "mj-history-mp3.zip",
                  size: 48_000_000,
                  members: [
                    { index: 0, path: "Disc 1/01. Billie Jean.mp3", size: 11_700_000, stored: false },
                    { index: 1, path: "Disc 1/02. Beat It.mp3", size: 10_300_000, stored: false },
                    { index: 2, path: "Disc 2/01. Scream.mp3", size: 11_100_000, stored: false },
                    { index: 3, path: "Disc 2/02. They Don't Care About Us.mp3", size: 11_400_000, stored: false },
                  ],
                },
              ],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-753001", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 3) });
  assert.equal(res.sources.length, 1, "fast-finishes after verifying full-coverage lossless Usenet archive");

  // First source: FLAC RAR expanded archive member -> exact inner member path as fileHint ONLY.
  const s0 = res.sources[0];
  assert.equal(s0.mime, "audio/flac");
  assert.match(s0.label || "", /FLAC.*Usenet Archive/);
  assert.equal(s0.release?.fileHint, "CD2/02 - Michael Jackson - They Don't Care About Us.flac");
  assert.equal(s0.release?.fileIndex, undefined, "archive member must NOT set outer fileIndex");
  assert.equal(s0.release?.file, undefined, "archive member must NOT set outer file");
  assert.equal(s0.release?.track, undefined, "exact member match uses fileHint, not fallback track");

  // Failover to second source: MP3 ZIP expanded archive member -> exact inner member path as fileHint ONLY.
  const failover = resolver.resolve({
    item: trackItemFor(album, 3),
    client: { exclude: [s0.id] },
  });
  assert.equal(failover.sources.length, 1);
  const s1 = failover.sources[0];
  assert.equal(s1.mime, "audio/mpeg");
  assert.equal(s1.release?.fileHint, "Disc 2/02. They Don't Care About Us.mp3");
  assert.equal(s1.release?.fileIndex, undefined);
  assert.equal(s1.release?.file, undefined);
});

test("Issue #753: archive fallback without release_files.members sends structured release.track and omits synthetic fileHint", () => {
  const album: CanonicalAlbum = {
    id: "al-753002",
    deezerAlbumId: 753002,
    artistId: "ar-259",
    deezerArtistId: 259,
    artistName: "Michael Jackson",
    title: "HIStory: Past, Present and Future, Book I",
    releaseDate: "1995-06-16",
    year: 1995,
    releaseType: "album",
    genres: ["Pop"],
    label: "Epic",
    fans: 1_200_000,
    durationSec: 1200,
    trackCount: 3,
    discCount: 2,
    coverXL: "",
    coverBig: "",
    curation: [],
    tracks: [
      { id: "tr-7541", deezerTrackId: 7541, title: "Billie Jean", disc: 1, trackNumber: 1, durationSec: 294, explicit: false, artistName: "Michael Jackson" },
      { id: "tr-7542", deezerTrackId: 7542, title: "Scream (feat. Janet Jackson)", disc: 2, trackNumber: 1, durationSec: 278, explicit: false, artistName: "Michael Jackson" },
      { id: "tr-7543", deezerTrackId: 7543, title: "They Don't Care About Us (2011 Remastered)", disc: 2, trackNumber: 3, durationSec: 284, explicit: false, artistName: "Michael Jackson" },
    ],
  };

  const unexpandedRar: SourceCandidate = {
    title: "Michael.Jackson-HIStory.Past.Present.and.Future.Book.I-1995-FLAC-FALLBACK",
    nzbUrl: "https://indexer.example/nzb/mj-rar-nomembers",
    indexer: "NZBgeek",
    size: 150_000_000,
  };

  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [unexpandedRar] };
      if (q.kind === "usenet_check") {
        return { candidates: [{ nzbUrl: q.nzbUrl, usenetCheck: { available: true, checked: 3, missing: 0 } }] };
      }
      if (q.kind === "release_files") {
        return {
          candidates: [
            {
              ...unexpandedRar,
              files: [
                { index: 0, path: "mj-history.part01.rar", size: 75_000_000 },
                { index: 1, path: "mj-history.part02.rar", size: 75_000_000 },
              ],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-753002", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 2) });
  assert.equal(res.sources.length, 1);
  const rel = res.sources[0].release;
  assert.ok(rel);
  assert.equal(rel.fileHint, undefined, "archive fallback must NOT send synthetic fileHint");
  assert.equal(rel.fileIndex, undefined, "archive fallback must NOT send fileIndex");
  assert.equal(rel.file, undefined, "archive fallback must NOT send file");
  assert.deepEqual(rel.track, {
    disc: 2,
    number: 3,
    title: "They Don't Care About Us",
  });
});

test("Issue #753: archive with expanded audio members of a wrong album is rejected without archive fallback", () => {
  const album: CanonicalAlbum = {
    id: "al-753003",
    deezerAlbumId: 753003,
    artistId: "ar-27",
    deezerArtistId: 27,
    artistName: "Daft Punk",
    title: "Discovery",
    releaseDate: "2001-03-12",
    year: 2001,
    releaseType: "album",
    genres: ["Electronic"],
    label: "Virgin",
    fans: 1_500_000,
    durationSec: 1200,
    trackCount: 3,
    discCount: 1,
    coverXL: "",
    coverBig: "",
    curation: [],
    tracks: [
      { id: "tr-7551", deezerTrackId: 7551, title: "One More Time", disc: 1, trackNumber: 1, durationSec: 320, explicit: false, artistName: "Daft Punk" },
      { id: "tr-7552", deezerTrackId: 7552, title: "Aerodynamic", disc: 1, trackNumber: 2, durationSec: 212, explicit: false, artistName: "Daft Punk" },
      { id: "tr-7553", deezerTrackId: 7553, title: "Digital Love", disc: 1, trackNumber: 3, durationSec: 298, explicit: false, artistName: "Daft Punk" },
    ],
  };

  const wrongArchive: SourceCandidate = {
    title: "Daft.Punk-Discovery-2001-FLAC-MISLABELED",
    nzbUrl: "https://indexer.example/nzb/dp-wrong-rar",
    indexer: "NZBgeek",
    size: 140_000_000,
  };

  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [wrongArchive] };
      if (q.kind === "release_files") {
        return {
          candidates: [
            {
              ...wrongArchive,
              files: [
                {
                  index: 0,
                  path: "dp.part01.rar",
                  size: 70_000_000,
                  members: [
                    { index: 0, path: "01 - Completely Different Song A.flac", size: 30_000_000 },
                    { index: 1, path: "02 - Unrelated Track B.flac", size: 28_000_000 },
                    { index: 2, path: "03 - Another Artist Song C.flac", size: 29_000_000 },
                    { index: 3, path: "04 - Fourth Track D.flac", size: 31_000_000 },
                    { index: 4, path: "05 - Fifth Track E.flac", size: 30_000_000 },
                    { index: 5, path: "06 - Sixth Track F.flac", size: 30_000_000 },
                  ],
                },
                { index: 1, path: "dp.part02.rar", size: 70_000_000 },
              ],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-753003", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(res.sources.length, 0, "mislabeled archive whose expanded members failed matching must not fall back");
});

test("Issue #753: expandReleaseFiles handles split archives and matchConcertReleaseFiles expands RAR video members", () => {
  const expanded = expandReleaseFiles([
    { index: 0, path: "concert.nfo", size: 900 },
    {
      index: 1,
      path: "concert.part01.rar",
      size: 4_000_000_000,
      members: [
        { index: 0, path: "Stop.Making.Sense.1984.1080p.BluRay.mkv", size: 8_200_000_000, stored: true },
        { index: 1, path: "sample.mkv", size: 60_000_000, stored: true },
      ],
    },
    { index: 2, path: "concert.part02.rar", size: 4_200_000_000 },
  ]);
  assert.equal(expanded.length, 4);
  assert.equal(expanded[1].isArchiveMember, true);
  assert.equal(expanded[1].path, "Stop.Making.Sense.1984.1080p.BluRay.mkv");

  const match = matchConcertReleaseFiles(
    "Stop.Making.Sense.1984.1080p.BluRay.x264-GRP",
    [
      {
        index: 0,
        path: "concert.part01.rar",
        size: 4_000_000_000,
        members: [
          { index: 0, path: "Stop.Making.Sense.1984.1080p.BluRay.mkv", size: 8_200_000_000, stored: true },
        ],
      },
    ],
    "uhd_preferred"
  );
  assert.equal(match.matched, true);
  assert.equal(match.file?.isArchiveMember, true);
  assert.equal(match.file?.path, "Stop.Making.Sense.1984.1080p.BluRay.mkv");

  const th = buildArchiveTrackHint({
    id: "tr-1",
    deezerTrackId: 1,
    title: "Song Name (2020 Remaster) (feat. Guest)",
    disc: 1,
    trackNumber: 5,
    durationSec: 210,
    explicit: false,
    artistName: "Artist",
  });
  assert.deepEqual(th, { disc: 1, number: 5, title: "Song Name" });
});

test("Issue #753: multi-volume RAR with partial volume-1 members falls back to structured release.track", () => {
  const album: CanonicalAlbum = {
    id: "al-753004",
    deezerAlbumId: 753004,
    artistId: "ar-27",
    deezerArtistId: 27,
    artistName: "Daft Punk",
    title: "Discovery",
    releaseDate: "2001-03-12",
    year: 2001,
    releaseType: "album",
    genres: ["Electronic"],
    label: "Virgin",
    fans: 1_500_000,
    durationSec: 1200,
    trackCount: 4,
    discCount: 1,
    coverXL: "",
    coverBig: "",
    curation: [],
    tracks: [
      { id: "tr-7561", deezerTrackId: 7561, title: "One More Time", disc: 1, trackNumber: 1, durationSec: 320, explicit: false, artistName: "Daft Punk" },
      { id: "tr-7562", deezerTrackId: 7562, title: "Aerodynamic", disc: 1, trackNumber: 2, durationSec: 212, explicit: false, artistName: "Daft Punk" },
      { id: "tr-7563", deezerTrackId: 7563, title: "Digital Love", disc: 1, trackNumber: 3, durationSec: 298, explicit: false, artistName: "Daft Punk" },
      { id: "tr-7564", deezerTrackId: 7564, title: "Harder, Better, Faster, Stronger", disc: 1, trackNumber: 4, durationSec: 224, explicit: false, artistName: "Daft Punk" },
    ],
  };

  const multiRar: SourceCandidate = {
    title: "Daft.Punk-Discovery-2001-FLAC-MULTIVOL",
    nzbUrl: "https://indexer.example/nzb/dp-multivol-rar",
    indexer: "NZBgeek",
    size: 160_000_000,
  };

  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [multiRar] };
      if (q.kind === "usenet_check") {
        return { candidates: [{ nzbUrl: q.nzbUrl, usenetCheck: { available: true, checked: 6, missing: 0 } }] };
      }
      if (q.kind === "release_files") {
        return {
          candidates: [
            {
              ...multiRar,
              files: [
                {
                  index: 0,
                  path: "dp.part01.rar",
                  size: 50_000_000,
                  members: [
                    // Only first 2 tracks visible in volume 1 (partialRARMembers)
                    { index: 0, path: "01 - One More Time.flac", size: 32_000_000, stored: true },
                    { index: 1, path: "02 - Aerodynamic.flac", size: 22_000_000, stored: true },
                  ],
                },
                { index: 1, path: "dp.part02.rar", size: 50_000_000 },
                { index: 2, path: "dp.part03.rar", size: 60_000_000 },
              ],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-753004", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  // Track 4 lives in part03.rar -> must fall back cleanly to structured release.track (not drop release!)
  const res = resolver.resolve({ item: trackItemFor(album, 3) });
  assert.equal(res.sources.length, 1);
  assert.equal(res.sources[0].release?.fileHint, undefined);
  assert.deepEqual(res.sources[0].release?.track, {
    disc: 1,
    number: 4,
    title: "Harder, Better, Faster, Stronger",
  });
});

test("0.2.5: Real-Debrid/AllDebrid unconfirmed torrent (debrid_check cached=false) still probes release_files and verifies album tracks", () => {
  const album: CanonicalAlbum = {
    id: "al-900101",
    deezerAlbumId: 900101,
    deezerArtistId: 27,
    artistName: "Daft Punk",
    title: "Discovery",
    year: 2001,
    releaseDate: "2001-03-07",
    releaseType: "album",
    genres: ["Electronic"],
    durationSec: 600,
    fans: 1_500_000,
    discCount: 1,
    tracks: [
      { id: "tr-9001", deezerTrackId: 9001, title: "One More Time", disc: 1, trackNumber: 1, durationSec: 320, explicit: false, artistName: "Daft Punk" },
      { id: "tr-9002", deezerTrackId: 9002, title: "Aerodynamic", disc: 1, trackNumber: 2, durationSec: 212, explicit: false, artistName: "Daft Punk" },
    ],
  };

  const torrentCand: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC]",
    infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    magnet: "magnet:?xt=urn:btih:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    indexer: "The Pirate Bay",
    seeders: 42,
    size: 420_000_000,
  };

  let releaseFilesCalled = 0;
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [torrentCand] };
      // Simulate Real-Debrid / AllDebrid / Debrid-Link: bulk CheckCached unsupported -> cached=false.
      if (q.kind === "debrid_check") {
        return { candidates: [{ infoHash: torrentCand.infoHash, cached: false }] };
      }
      if (q.kind === "release_files") {
        releaseFilesCalled++;
        // Ether 0.3.19 ListReleaseFiles acquires on-demand and returns cached=true + complete files.
        return {
          candidates: [
            {
              ...torrentCand,
              cached: true,
              files: [
                { index: 0, path: "Daft Punk - Discovery/01 - One More Time.flac", size: 36_000_000 },
                { index: 1, path: "Daft Punk - Discovery/02 - Aerodynamic.flac", size: 24_000_000 },
              ],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-900101", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 1) });
  assert.equal(releaseFilesCalled, 1, "must probe release_files on top unconfirmed torrent when debrid_check has 0 hits");
  assert.equal(res.sources.length, 1);
  assert.equal(res.sources[0].mime, "audio/flac");
  assert.equal(res.sources[0].release?.fileIndex, 1);
  assert.equal(res.sources[0].release?.file, "Daft Punk - Discovery/02 - Aerodynamic.flac");
  assert.equal(res.sources[0].release?.candidate?.cached, true);
});

test("0.2.5: cached Debrid torrent with empty file listing falls back to structured release.track; confirmed uncached is dropped", () => {
  const album: CanonicalAlbum = {
    id: "al-900102",
    deezerAlbumId: 900102,
    deezerArtistId: 27,
    artistName: "Daft Punk",
    title: "Discovery",
    year: 2001,
    releaseDate: "2001-03-07",
    releaseType: "album",
    genres: ["Electronic"],
    durationSec: 600,
    fans: 1_500_000,
    discCount: 1,
    tracks: [
      { id: "tr-9011", deezerTrackId: 9011, title: "One More Time", disc: 1, trackNumber: 1, durationSec: 320, explicit: false, artistName: "Daft Punk" },
      { id: "tr-9012", deezerTrackId: 9012, title: "Aerodynamic", disc: 1, trackNumber: 2, durationSec: 212, explicit: false, artistName: "Daft Punk" },
    ],
  };

  const cachedNoFiles: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC]",
    infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    magnet: "magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    indexer: "1337x",
    seeders: 30,
    size: 400_000_000,
  };
  const trulyUncached: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [MP3 320]",
    infoHash: "cccccccccccccccccccccccccccccccccccccccc",
    magnet: "magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc",
    indexer: "1337x",
    seeders: 15,
    size: 130_000_000,
  };

  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [cachedNoFiles, trulyUncached] };
      if (q.kind === "debrid_check") {
        return {
          candidates: [
            { infoHash: cachedNoFiles.infoHash, cached: false },
            { infoHash: trulyUncached.infoHash, cached: false },
          ],
        };
      }
      if (q.kind === "release_files") {
        if (q.infoHash === cachedNoFiles.infoHash) {
          return { candidates: [{ ...cachedNoFiles, cached: true, files: [] }] };
        }
        return { candidates: [{ ...trulyUncached, cached: false, files: [] }] };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-900102", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(res.sources.length, 1, "only cached Debrid fallback should be emitted; confirmed uncached dropped");
  assert.equal(res.sources[0].release?.candidate?.infoHash, cachedNoFiles.infoHash);
  assert.equal(res.sources[0].release?.fileHint, undefined);
  assert.deepEqual(res.sources[0].release?.track, { disc: 1, number: 1, title: "One More Time" });
});

test("0.2.5: Real-Debrid/AllDebrid unconfirmed concert torrent probes release_files and verifies MKV", () => {
  const concertCand: SourceCandidate = {
    title: "Daft Punk - Alive 2007 (2007) 1080p BluRay x264",
    infoHash: "dddddddddddddddddddddddddddddddddddddddd",
    magnet: "magnet:?xt=urn:btih:dddddddddddddddddddddddddddddddddddddddd",
    indexer: "1337x",
    seeders: 25,
    size: 8_500_000_000,
  };
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [concertCand] };
      if (q.kind === "debrid_check") return { candidates: [{ infoHash: concertCand.infoHash, cached: false }] };
      if (q.kind === "release_files") {
        return {
          candidates: [
            {
              ...concertCand,
              cached: true,
              files: [{ index: 0, path: "Daft.Punk.Alive.2007.1080p.BluRay.mkv", size: 8_400_000_000 }],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({
    item: {
      id: "co-daft-punk-alive-2007",
      level: "concert",
      parentId: "ar-27",
      title: "Alive 2007",
      year: 2007,
      playable: true,
      fields: { artistName: "Daft Punk", duration: 5100 },
      hints: { artistName: "Daft Punk", durationSec: 5100 },
    },
  });
  assert.equal(res.sources.length, 1);
  assert.equal(res.sources[0].release?.file, "Daft.Punk.Alive.2007.1080p.BluRay.mkv");
  assert.equal(res.sources[0].release?.candidate?.cached, true);
});

test("0.2.5: single-volume archive with inspected non-audio members is rejected without archive fallback", () => {
  const album: CanonicalAlbum = {
    id: "al-900103",
    deezerAlbumId: 900103,
    deezerArtistId: 27,
    artistName: "Daft Punk",
    title: "Discovery",
    year: 2001,
    releaseDate: "2001-03-07",
    releaseType: "album",
    genres: ["Electronic"],
    durationSec: 600,
    fans: 1_500_000,
    discCount: 1,
    tracks: [
      { id: "tr-9021", deezerTrackId: 9021, title: "One More Time", disc: 1, trackNumber: 1, durationSec: 320, explicit: false, artistName: "Daft Punk" },
    ],
  };

  const scansOnlyZip: SourceCandidate = {
    title: "Daft.Punk-Discovery-2001-FLAC-SCANS",
    nzbUrl: "https://indexer.example/nzb/dp-scans",
    indexer: "NZBgeek",
    size: 80_000_000,
  };

  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: [scansOnlyZip] };
      if (q.kind === "release_files") {
        return {
          candidates: [
            {
              ...scansOnlyZip,
              files: [
                {
                  index: 0,
                  path: "booklet.zip",
                  size: 80_000_000,
                  members: [
                    { index: 0, path: "Booklet/Page01.jpg", size: 40_000_000, stored: true },
                    { index: 1, path: "Booklet/Page02.jpg", size: 40_000_000, stored: true },
                  ],
                },
              ],
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-900103", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(res.sources.length, 0, "single-volume archive with inspected non-audio members must be rejected");
});

test("0.2.5: KVCache auto-evicts low-priority dz:* entries on quota_exceeded and sweepLegacyBloat purges <=0.2.4 bloat", () => {
  const store = new Map<string, string>();
  const now = 1_700_000_000_000;
  let maxKeys = 5;

  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => store.get(k) ?? null,
      put: (k, v) => {
        if (!store.has(k) && store.size >= maxKeys) {
          throw new Error('__ETHER_FAULT__{"code":"quota_exceeded","message":"kv quota exceeded"}');
        }
        store.set(k, v);
      },
      delete: (k) => { store.delete(k); },
      list: (prefix = "") => Array.from(store.keys()).filter((k) => k.startsWith(prefix)),
    },
    http: { fetch: () => ({ status: 404, body: "" }) },
    settings: { get: () => ({}) },
    sources: { resolve: () => ({ candidates: [] }) },
  };

  // Fill store to quota with legacy & bulky dz:* entries + 1 protected alb_rel_v6 key.
  store.set("alb_rel_v5:al-1", JSON.stringify({ v: {}, e: now + 60_000 }));
  store.set("dz:album:123", JSON.stringify({ v: { big: "x".repeat(500) }, e: now + 60_000 }));
  store.set("dz:artist:27:albums:p:0:100", JSON.stringify({ v: { data: [] }, e: now + 60_000 }));
  store.set("dz:search:ar:daft:8", JSON.stringify({ v: { data: [] }, e: now + 60_000 }));
  store.set("alb_rel_v6:al-keep", JSON.stringify({ v: { keep: true }, e: now + 60_000 }));

  const cache = new KVCache(env);
  // 1. Writing a new alb_rel_v6 key while at quota must auto-evict low-priority bloat and succeed!
  cache.set("alb_rel_v6:al-new", { ok: true }, 60_000);
  assert.ok(store.has("alb_rel_v6:al-new"), "new alb_rel_v6 write must succeed after quota auto-eviction");
  assert.ok(store.has("alb_rel_v6:al-keep"), "existing alb_rel_v6 entry must be preserved");

  // 2. sweepLegacyBloat cleans remaining legacy prefixes + bulky dz:* keys while keeping album_v2 & alb_rel_v6.
  maxKeys = 50;
  store.set("album_meta:al-old", JSON.stringify({ v: {}, e: now + 60_000 }));
  store.set("alb_stage_v4:al-old", JSON.stringify({ v: {}, e: now + 60_000 }));
  store.set("concert_rel_v1:co-old", JSON.stringify({ v: {}, e: now + 60_000 }));
  store.set("dz:album:999", JSON.stringify({ v: {}, e: now + 60_000 }));
  store.set("dz:artist:27:albums:p:100:100", JSON.stringify({ v: {}, e: now + 60_000 }));
  store.set("album_v2:al-keep", JSON.stringify({ v: { keep: true }, e: now + 60_000 }));

  const deleted = cache.sweepLegacyBloat(50);
  assert.ok(deleted >= 5, `expected >= 5 legacy/bloat keys swept, got ${deleted}`);
  assert.equal(store.has("album_meta:al-old"), false);
  assert.equal(store.has("alb_stage_v4:al-old"), false);
  assert.equal(store.has("concert_rel_v1:co-old"), false);
  assert.equal(store.has("dz:album:999"), false);
  assert.equal(store.has("dz:artist:27:albums:p:100:100"), false);
  assert.equal(store.has("album_v2:al-keep"), true);
  assert.equal(store.has("alb_rel_v6:al-keep"), true);
  assert.equal(store.has("alb_rel_v6:al-new"), true);
});

test("0.2.6: stops at the first query that yields a well-matched release and skips strictly narrower variants on 0 results", () => {
  assert.equal(isStrictlyNarrowerQuery("Daft Punk Discovery", "Daft Punk Discovery 2001"), true);
  assert.equal(isStrictlyNarrowerQuery("Stop Making Sense 1984", "Talking Heads Stop Making Sense"), false);

  const album = sampleDiscoveryAlbum();
  const singleFlac: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC]",
    nzbUrl: "https://althub.test/api?t=get&id=1",
    indexer: "altHUB",
    size: 130_000_000,
  };
  const backupFlac: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [WEB FLAC] Alt",
    nzbUrl: "https://althub.test/api?t=get&id=2",
    indexer: "altHUB",
    size: 135_000_000,
  };

  // 1. Even a SINGLE well-matched release on query #1 stops immediately (no year variant #2)
  //    AND Usenet fast-finishes after verifying 1 full-coverage FLAC (no 2nd FetchNZB).
  const searchQueries: string[] = [];
  const probedNzbs: string[] = [];
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") {
        searchQueries.push(q.query || "");
        return { candidates: [singleFlac, backupFlac] };
      }
      if (q.kind === "release_files") {
        probedNzbs.push(q.candidate?.nzbUrl || "");
        return {
          candidates: [
            {
              ...q.candidate!,
              files: album.tracks.map((t, i) => ({
                index: i,
                path: `${String(i + 1).padStart(2, "0")} - ${t.title}.flac`,
                size: 30_000_000,
              })),
            },
          ],
        };
      }
      if (q.kind === "usenet_check") {
        return { candidates: [{ nzbUrl: q.nzbUrl, usenetCheck: { available: true, checked: 4, missing: 0 } }] };
      }
      return { candidates: [] };
    },
  });

  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const res = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(res.sources.length, 1);
  assert.deepEqual(searchQueries, ["Daft Punk Discovery"], "must stop after query #1 when well-matched release found");
  assert.equal(probedNzbs.length, 1, "Usenet-only user must stop after 1 verified full-coverage FLAC FetchNZB");

  // 2. When query #1 returns 0 results, strictly narrower year variant #2 must be skipped.
  const emptyQueries: string[] = [];
  const { env: envEmpty } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") {
        emptyQueries.push(q.query || "");
        return { candidates: [] };
      }
      return { candidates: [] };
    },
  });
  const cacheEmpty = new KVCache(envEmpty);
  cacheEmpty.set("album_v2:al-302127", album, 60_000);
  const resEmpty = new AlbumResolver(
    envEmpty,
    cacheEmpty,
    new MusicCatalog(envEmpty, cacheEmpty, new DeezerClient(envEmpty, cacheEmpty), new MusicBrainzClient(envEmpty, cacheEmpty), settings),
    settings
  ).resolve({ item: trackItemFor(album, 0) });
  assert.equal(resEmpty.sources.length, 0);
  assert.deepEqual(emptyQueries, ["Daft Punk Discovery"], "must not run narrower year variant when broader query returned 0 results");

  // 3. When query #1 returns ONLY noisy non-matching releases, sequentially fall back to year variant #2.
  const noisyQueries: string[] = [];
  const { env: envNoisy } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") {
        noisyQueries.push(q.query || "");
        if (q.query === "Daft Punk Discovery") {
          return {
            candidates: [
              { title: "Daft Punk - Greatest Hits (2010) [FLAC]", nzbUrl: "https://althub.test/gh.nzb", indexer: "altHUB", size: 200_000_000 },
            ],
          };
        }
        return { candidates: [singleFlac] };
      }
      if (q.kind === "release_files") {
        return {
          candidates: [
            {
              ...singleFlac,
              files: album.tracks.map((t, i) => ({
                index: i,
                path: `${String(i + 1).padStart(2, "0")} - ${t.title}.flac`,
                size: 30_000_000,
              })),
            },
          ],
        };
      }
      return { candidates: [] };
    },
  });
  const cacheNoisy = new KVCache(envNoisy);
  cacheNoisy.set("album_v2:al-302127", album, 60_000);
  const resNoisy = new AlbumResolver(
    envNoisy,
    cacheNoisy,
    new MusicCatalog(envNoisy, cacheNoisy, new DeezerClient(envNoisy, cacheNoisy), new MusicBrainzClient(envNoisy, cacheNoisy), settings),
    settings
  ).resolve({ item: trackItemFor(album, 0) });
  assert.equal(resNoisy.sources.length, 1);
  assert.deepEqual(noisyQueries, ["Daft Punk Discovery", "Daft Punk Discovery 2001"]);
});

test("0.2.6: negative results are cached per album for 30m (empty) / 60m (unmatched) and survive exclude retries", () => {
  const album = sampleDiscoveryAlbum();
  let now = 1_760_000_000_000;
  let emptySearches = 0;
  const kvMap = new Map<string, string>();
  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => kvMap.get(k) ?? null,
      put: (k, v) => { kvMap.set(k, v); },
      delete: (k) => { kvMap.delete(k); },
      list: (p = "") => Array.from(kvMap.keys()).filter((k) => k.startsWith(p)),
    },
    http: { fetch: () => ({ status: 404, body: "" }) },
    settings: { get: () => ({}) },
    sources: {
      resolve: (q) => {
        if (q.kind === "indexer_search") {
          emptySearches++;
          return { candidates: [] };
        }
        return { candidates: [] };
      },
    },
  };
  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 24 * 60 * 60 * 1000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  const r1 = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(r1.sources.length, 0);
  assert.ok((r1.ttlSec || 0) >= 600, `expected negative ttlSec >= 600, got ${r1.ttlSec}`);
  assert.equal(emptySearches, 1);

  // 15 minutes later (other track AND with client.exclude): MUST stay cached with 0 extra searches.
  now += 15 * 60 * 1000;
  const r2 = resolver.resolve({ item: trackItemFor(album, 2), client: { exclude: ["nzb:old"] } });
  assert.equal(r2.sources.length, 0);
  assert.equal(emptySearches, 1, "negative cache must not re-search within 30m even with exclude");

  // 31 minutes later: negative cache expired -> allowed to re-search once.
  now += 16 * 60 * 1000;
  resolver.resolve({ item: trackItemFor(album, 1) });
  assert.equal(emptySearches, 2);

  // Unmatched case (indexer answered cleanly with non-matching results) -> 60m negative cache.
  let unmatchedSearches = 0;
  const kvMap2 = new Map<string, string>();
  let now2 = 1_760_000_000_000;
  const env2: HostEnv = {
    ...env,
    now: () => now2,
    kv: {
      get: (k) => kvMap2.get(k) ?? null,
      put: (k, v) => { kvMap2.set(k, v); },
      delete: (k) => { kvMap2.delete(k); },
      list: (p = "") => Array.from(kvMap2.keys()).filter((k) => k.startsWith(p)),
    },
    sources: {
      resolve: (q) => {
        if (q.kind === "indexer_search") {
          unmatchedSearches++;
          return {
            candidates: [
              { title: "Daft Punk - Greatest Hits (2010) [FLAC]", nzbUrl: "https://althub.test/gh.nzb", indexer: "altHUB", size: 200_000_000 },
            ],
          };
        }
        return { candidates: [] };
      },
    },
  };
  const cache2 = new KVCache(env2);
  cache2.set("album_v2:al-302127", album, 24 * 60 * 60 * 1000);
  const resolver2 = new AlbumResolver(
    env2,
    cache2,
    new MusicCatalog(env2, cache2, new DeezerClient(env2, cache2), new MusicBrainzClient(env2, cache2), settings),
    settings
  );
  const u1 = resolver2.resolve({ item: trackItemFor(album, 0) });
  assert.equal(u1.sources.length, 0);
  assert.ok((u1.ttlSec || 0) >= 900, `expected unmatched negative ttlSec >= 900, got ${u1.ttlSec}`);
  const initialCount = unmatchedSearches;
  now2 += 45 * 60 * 1000;
  resolver2.resolve({ item: trackItemFor(album, 1) });
  assert.equal(unmatchedSearches, initialCount, "unmatched negative cache must hold for 60 minutes");
});

test("0.2.6: never repeats the same (album, query) within the short dedup window (failover, concurrent in-flight, and timed-out retries)", () => {
  const album = sampleDiscoveryAlbum();
  const nzb1: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC] ReleaseA",
    nzbUrl: "https://althub.test/a.nzb",
    indexer: "altHUB",
    size: 130_000_000,
  };
  const nzb2: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC] ReleaseB",
    nzbUrl: "https://althub.test/b.nzb",
    indexer: "altHUB",
    size: 132_000_000,
  };

  let now = 1_760_000_000_000;
  let searchCount = 0;
  const kvMap = new Map<string, string>();
  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => kvMap.get(k) ?? null,
      put: (k, v) => { kvMap.set(k, v); },
      delete: (k) => { kvMap.delete(k); },
      list: (p = "") => Array.from(kvMap.keys()).filter((k) => k.startsWith(p)),
    },
    http: { fetch: () => ({ status: 404, body: "" }) },
    settings: { get: () => ({}) },
    sources: {
      resolve: (q) => {
        if (q.kind === "indexer_search") {
          searchCount++;
          return { candidates: [nzb1, nzb2] };
        }
        if (q.kind === "release_files") {
          return {
            candidates: [
              {
                ...q.candidate!,
                files: album.tracks.map((t, i) => ({
                  index: i,
                  path: `${String(i + 1).padStart(2, "0")} - ${t.title}.flac`,
                  size: 30_000_000,
                })),
              },
            ],
          };
        }
        return { candidates: [] };
      },
    },
  };
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 24 * 60 * 60 * 1000);
  const resolver = new AlbumResolver(
    env,
    cache,
    new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings),
    settings
  );

  // 1. Initial resolve searches once; failover (exclude nzb1) reuses sq_v1 memo with ZERO new searches!
  const first = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(first.sources.length, 1);
  assert.equal(searchCount, 1);

  now += 20_000;
  const failover = resolver.resolve({ item: trackItemFor(album, 0), client: { exclude: [first.sources[0].id] } });
  assert.equal(failover.sources.length, 1);
  assert.notEqual(failover.sources[0].id, first.sources[0].id);
  assert.equal(searchCount, 1, "failover within 5m must reuse cached query candidates without re-searching indexer");

  // 2. Concurrent worker guard: if another worker started the same (album, query) <6s ago,
  //    yield pending without firing a parallel search or caching a premature negative result.
  const kvInflight = new Map<string, string>();
  let nowInfl = 1_760_000_000_000;
  let inflSearches = 0;
  const envInfl: HostEnv = {
    ...env,
    now: () => nowInfl,
    kv: {
      get: (k) => kvInflight.get(k) ?? null,
      put: (k, v) => { kvInflight.set(k, v); },
      delete: (k) => { kvInflight.delete(k); },
      list: (p = "") => Array.from(kvInflight.keys()).filter((k) => k.startsWith(p)),
    },
    sources: {
      resolve: (q) => {
        if (q.kind === "indexer_search") {
          inflSearches++;
          return { candidates: [nzb1] };
        }
        return { candidates: [] };
      },
    },
  };
  const cacheInfl = new KVCache(envInfl);
  cacheInfl.set("album_v2:al-302127", album, 24 * 60 * 60 * 1000);
  // Simulate Worker 1 having written inflight 500ms ago (still running).
  cacheInfl.set(
    searchMemoKey(album.id, "Daft Punk Discovery"),
    { status: "inflight", at: nowInfl - 500, rawCount: 0 },
    5 * 60 * 1000
  );
  const resolverInfl = new AlbumResolver(
    envInfl,
    cacheInfl,
    new MusicCatalog(envInfl, cacheInfl, new DeezerClient(envInfl, cacheInfl), new MusicBrainzClient(envInfl, cacheInfl), settings),
    settings
  );

  const concurrent = resolverInfl.resolve({ item: trackItemFor(album, 1) });
  assert.equal(concurrent.pending, true, "concurrent worker must yield pending while primary search is in-flight");
  assert.equal(inflSearches, 0, "concurrent worker must NOT launch parallel duplicate search");
  assert.equal(cacheInfl.get(albumCacheKey(album.id)), null, "must not write negative cache while primary search is in-flight");

  // 3. If Worker 1 timed out / died (>6s ago without updating memo), its attempt said nothing
  //    about the album (W348): the next call searches again, exactly once. (Whatever that fresh,
  //    complete search finds decides the album; pending indexers are covered by the W348 test.)
  nowInfl += 10_000;
  resolverInfl.resolve({ item: trackItemFor(album, 1) });
  assert.equal(inflSearches, 1, "a dead in-flight attempt is searched again after the wait window");
  resolverInfl.resolve({ item: trackItemFor(album, 1) });
  assert.equal(inflSearches, 1, "and that new answer is reused, not searched again");
});

test("W348: indexers still searching never turn an album negative; the resolver keeps answering pending", () => {
  const album = sampleDiscoveryAlbum();
  const late: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC]",
    indexer: "SlowIndexer",
    nzbUrl: "https://slow.test/discovery.nzb",
    size: 430_000_000,
  };
  let clock = 1_760_000_000_000;
  let searches = 0;
  const { env } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") {
        searches++;
        // First answers: nothing yet, one indexer still running; then it answers.
        return searches < 3
          ? { candidates: [], pending: [{ indexerId: "slow", indexer: "SlowIndexer" }], indexers: [{ indexerId: "slow", status: "pending" }] }
          : { candidates: [late], indexers: [{ indexerId: "slow", status: "answered", results: 1 }] };
      }
      if (q.kind === "release_files") {
        return { candidates: [{ ...q.candidate!, files: album.tracks.map((t, i) => ({ index: i, path: `${String(i + 1).padStart(2, "0")} - ${t.title}.flac`, size: 30_000_000 })) }] };
      }
      if (q.kind === "usenet_check") return { candidates: [{ ...late, usenetCheck: { available: true, checked: 8, missing: 0 } }] };
      return { candidates: [] };
    },
  });
  env.now = () => clock;
  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 24 * 60 * 60 * 1000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const resolver = new AlbumResolver(env, cache, new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings), settings);

  const first = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(first.pending, true, "an empty answer with indexers pending is not a verdict");
  assert.equal(cache.get(albumCacheKey(album.id)), null, "no negative album while indexers are pending");
  // Every track of the album asks meanwhile; none gets a cached empty answer.
  assert.equal(resolver.resolve({ item: trackItemFor(album, 3) }).pending, true);

  let res = first;
  for (let i = 0; res.pending && i < 10; i++) {
    clock += 7_000; // past the in-flight wait window
    res = resolver.resolve({ item: trackItemFor(album, 0) });
  }
  assert.equal(res.pending, undefined);
  assert.equal(res.sources[0]?.release?.candidate?.nzbUrl, late.nzbUrl);
  assert.equal(searches, 3);
});

test("#781: a usenet_check that would not fit the 5 s /resolve deadline is deferred to the next slice without re-listing", () => {
  const album = sampleDiscoveryAlbum();
  const flac: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC]",
    indexer: "NZBgeek",
    nzbUrl: "https://api.nzbgeek.info/api?t=get&id=slow-archive",
    size: 430_000_000,
  };
  let clock = 1_760_000_000_000;
  // Host timings from the issue: a quick search, a slow multi-volume listing, a slow check.
  const cost: Record<string, number> = { indexer_search: 300, release_files: 2000, usenet_check: 3000 };
  const { env, calls } = makeFakeHost({
    onResolve: (q) => {
      clock += cost[q.kind] || 0;
      if (q.kind === "indexer_search") return { candidates: [flac] };
      if (q.kind === "release_files") {
        return {
          candidates: [{
            ...q.candidate!,
            files: album.tracks.map((t, idx) => ({ index: idx, path: `${String(idx + 1).padStart(2, "0")} - ${t.title}.flac`, size: 30_000_000 })),
          }],
        };
      }
      if (q.kind === "usenet_check") {
        return { candidates: [{ ...flac, usenetCheck: { available: true, checked: 32, missing: 0, cached: false } }] };
      }
      return { candidates: [] };
    },
  });
  env.now = () => clock;
  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);

  let res: ReturnType<typeof resolver.resolve> = { sources: [], pending: true };
  let slices = 0;
  while (res.pending && slices < 8) {
    const before = clock;
    res = resolver.resolve({ item: trackItemFor(album, 0) });
    slices++;
    assert.ok(clock - before < 5000, `slice ${slices} took ${clock - before} ms`);
  }
  assert.equal(res.pending, undefined);
  assert.equal(res.sources[0]?.release?.candidate?.nzbUrl, flac.nzbUrl);
  assert.equal(calls.filter((q) => q.kind === "release_files").length, 1);
  assert.equal(calls.filter((q) => q.kind === "usenet_check").length, 1);
  assert.equal(slices, 2);
});

test("a song its album could not play is found on a single carrying the same recording (ISRC)", () => {
  const album = sampleDiscoveryAlbum();
  const single: SourceCandidate = {
    title: "Daft Punk - One More Time (2000) [FLAC]",
    indexer: "NZBgeek",
    nzbUrl: "https://api.nzbgeek.info/api?t=get&id=omt-single",
    size: 90_000_000,
  };
  const { env, calls } = makeFakeHost({
    onResolve: (q) => {
      if (q.kind === "indexer_search") return { candidates: /one more time/i.test(q.query || "") ? [single] : [] };
      if (q.kind === "release_files") {
        return { candidates: [{ ...q.candidate!, files: [
          { index: 0, path: "01 - One More Time.flac", size: 40_000_000 },
          { index: 1, path: "02 - One More Time (Radio Edit).flac", size: 25_000_000 },
        ] }] };
      }
      if (q.kind === "usenet_check") return { candidates: [{ ...single, usenetCheck: { available: true, checked: 8, missing: 0 } }] };
      return { candidates: [] };
    },
  });
  env.http.fetch = (req) => req.url.includes("musicbrainz.org/ws/2/recording")
    ? { status: 200, body: JSON.stringify({ recordings: [{ "artist-credit": [{ name: "Daft Punk" }], releases: [
        { title: "Discovery", status: "Official", "track-count": 14, "release-group": { "primary-type": "Album" } },
        { title: "One More Time", status: "Official", "track-count": 2, "release-group": { "primary-type": "Single" } },
        { title: "Club Hits 2001", status: "Official", "track-count": 30, "release-group": { "primary-type": "Album", "secondary-types": ["Compilation"] } },
      ] }] }) }
    : { status: 404, body: "" };
  const cache = new KVCache(env);
  cache.set("album_v2:al-302127", album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);
  const item = trackItemFor(album, 0);
  item.hints = { ...(item.hints || {}), isrc: "GBDUW0000053" };

  let res = resolver.resolve({ item });
  for (let i = 0; res.pending && i < 12; i++) res = resolver.resolve({ item });
  assert.equal(res.pending, undefined);
  assert.equal(res.sources[0]?.release?.candidate?.nzbUrl, single.nzbUrl);
  assert.equal(res.sources[0]?.release?.fileHint, "01 - One More Time.flac");
  // The single was searched; the album itself and the compilation were not tried after it matched.
  assert.ok(calls.some((q) => q.kind === "indexer_search" && /one more time/i.test(q.query || "")));
  assert.ok(!calls.some((q) => q.kind === "indexer_search" && /club hits/i.test(q.query || "")));
  // Any album's copy of the same recording now plays from the remembered answer at once.
  const other = { ...item, id: "tr-999", parentId: "al-999", hints: { ...(item.hints || {}), albumId: "al-999", albumTitle: "Club Hits 2001" } };
  cache.set(albumCacheKey("al-999"), { albumId: "al-999", resolvedAt: 0, expiresAt: Date.now() + 60_000, releases: [], negative: true }, 60_000);
  const again = resolver.resolve({ item: other });
  assert.equal(again.sources[0]?.release?.candidate?.nzbUrl, single.nzbUrl);
});

function resolverFor(album: CanonicalAlbum, onResolve: (q: SourceQuery) => { candidates: SourceCandidate[] }) {
  const { env } = makeFakeHost({ onResolve });
  const cache = new KVCache(env);
  cache.set(`album_v2:${album.id}`, album, 60_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  return new AlbumResolver(env, cache, catalog, settings);
}

test("search text: punctuation and accents in names, and tags a release name never carries", () => {
  assert.equal(indexerQueryText("AC/DC"), "AC DC");
  assert.equal(indexerQueryText("Beyoncé"), "Beyonce");
  assert.equal(indexerQueryText("Guns N' Roses"), "Guns N Roses");
  assert.equal(indexerQueryText("Simon & Garfunkel"), "Simon Garfunkel");
  assert.equal(indexerQueryText("A$AP Rocky"), "ASAP Rocky");
  assert.equal(indexerQueryText("Кино"), "Кино", "letters of other scripts are kept");
  assert.equal(indexerQueryText("Кайно"), "Кайно", "only Latin accents are folded");

  assert.equal(joinedArtistSpelling("AC/DC"), "ACDC");
  assert.equal(joinedArtistSpelling("R.E.M."), "REM");
  assert.equal(joinedArtistSpelling("blink-182"), "blink182");
  assert.equal(joinedArtistSpelling("Daft Punk"), "");

  assert.equal(
    coreReleaseTitle("Flower In A Hurricane (feat. Tame Impala, SZA, King Gizzard & the Lizard Wizard) [From GTAVI: Original Score]"),
    "Flower In A Hurricane"
  );
  assert.equal(coreReleaseTitle("Interstellar (Original Motion Picture Soundtrack)"), "Interstellar");
  assert.equal(coreReleaseTitle("Metallica (Remastered 2021)"), "Metallica");
  assert.equal(coreReleaseTitle("Discovery"), "Discovery");
});

test("an artist name with punctuation is searched as words, then as one word", () => {
  const album: CanonicalAlbum = { ...sampleDiscoveryAlbum(), id: "al-9410086", artistName: "AC/DC", title: "Highway to Hell", year: 1979 };
  const queries: string[] = [];
  const resolver = resolverFor(album, (q) => {
    if (q.kind === "indexer_search") queries.push(q.query || "");
    return { candidates: [] };
  });
  resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(queries[0], "AC DC Highway to Hell");
  assert.ok(queries.includes("ACDC Highway to Hell"), `joined spelling is searched too: ${queries.join(" | ")}`);
});

test("a single is searched and matched by its title alone", () => {
  const album: CanonicalAlbum = {
    ...sampleDiscoveryAlbum(),
    id: "al-1119445672",
    artistName: "Justice",
    title: "Flower In A Hurricane (feat. Tame Impala, SZA, King Gizzard & the Lizard Wizard) [From GTAVI: Original Score]",
    year: 2026,
  };
  const queries: string[] = [];
  const resolver = resolverFor(album, (q) => {
    if (q.kind === "indexer_search") queries.push(q.query || "");
    return { candidates: [] };
  });
  resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(queries[0], "Justice Flower In A Hurricane");

  const pre = preScoreAlbumCandidate(
    { title: "Justice-Flower_In_A_Hurricane-SINGLE-WEB-FLAC-2026-GRP", nzbUrl: "https://x.test/1", indexer: "x" },
    { artistName: album.artistName, title: album.title, year: 2026, releaseType: "single", durationSec: 200 },
    "flac_preferred"
  );
  assert.equal(pre.accepted, true, pre.reasons.join(", "));
});

test("a self-titled album does not match the artist's other releases", () => {
  const album = { artistName: "Metallica", title: "Metallica (Remastered 2021)", year: 1991, releaseType: "album" as const, durationSec: 3750 };
  const score = (title: string) =>
    preScoreAlbumCandidate({ title, nzbUrl: "https://x.test/1", indexer: "x" }, album, "flac_preferred");

  for (const other of [
    "Metallica - Nothing Else Matters CDM (Wav + Mp3)",
    "Metallica-ReLoad-REMASTERED-24BIT-WEB-FLAC-2026-ENTiTLED",
    "Metallica - Reload (1997) [FLAC 24bit-96kHz]-NICFEIN",
    "Metallica - Master of Puppets (1986) [FLAC]",
    "Metallica.-.S&M.(1999).[FLAC].88",
    "Metallica - (1991) The Unforgiven (CDS)",
    '[2/6] "6711_Disc 2/Disc 2/Metallica - Mandatory Metallica (US Promo CD, Disc 2).flac"',
    '[2/10] "Metallica - One 1989 UK Vertigo METCD5/Metallica - One (Vertigo METCD5).flac"',
  ]) {
    const pre = score(other);
    assert.equal(pre.accepted, false, `${other} is another title`);
    assert.match(pre.reasons.join(" "), /self-titled/);
  }
  for (const same of [
    "Metallica-Metallica-REMASTERED-24BIT-WEB-FLAC-2021-ENTiTLED",
    "Metallica - Metallica (1991) [FLAC]",
    "Metallica (1991) [FLAC]",
    "Metallica 1991 Vertigo FLAC",
    "Metallica - The Black Album (1991) FLAC",
    "Metallica.-.Metallica.[1991].[MP3.320].88 [54d0d6b31]",
    "Metallica - 1991 - Metallica (The Black Album) (2001) 96-24 - Metallica - 1991 - Metallica",
  ]) {
    assert.equal(score(same).accepted, true, `${same} is the album`);
  }
  // An album that is not self-titled is unaffected.
  assert.equal(
    preScoreAlbumCandidate(
      { title: "Metallica - Reload (1997) [FLAC]", nzbUrl: "https://x.test/1", indexer: "x" },
      { ...album, title: "Reload", year: 1997 },
      "flac_preferred"
    ).accepted,
    true
  );
});

test("archive members that are not the album stop the archive fallback", () => {
  const album = sampleDiscoveryAlbum();
  const t = album.tracks.map((x) => x.title);
  // A single packed as WAV and MP3: one album title, twice.
  assert.equal(
    archiveMembersContradictAlbum(album, [
      { path: `wav/01 - ${t[0]}.wav` },
      { path: `mp3/01 - ${t[0]}.mp3` },
    ]),
    true
  );
  // Another release: most members name no track of the album.
  assert.equal(
    archiveMembersContradictAlbum(album, [
      { path: "01 - Some Other Song.flac" },
      { path: "02 - And Another.flac" },
      { path: `03 - ${t[0]}.flac` },
    ]),
    true
  );
  // The first volume of the right album: its first tracks, once each.
  assert.equal(
    archiveMembersContradictAlbum(album, [
      { path: `01 - ${t[0]}.flac` },
      { path: `02 - ${t[1]}.flac` },
      { path: `03 - ${t[2]}.flac` },
    ]),
    false
  );
  assert.equal(archiveMembersContradictAlbum(album, []), false, "nothing listed says nothing");
  // Scene file names carry the artist and underscores: they still name the album's tracks.
  assert.equal(
    archiveMembersContradictAlbum(album, [
      { path: "01-daft_punk-one_more_time.flac" },
      { path: "02-daft_punk-aerodynamic.flac" },
      { path: "03-daft_punk-digital_love.flac" },
      { path: "00-daft_punk-discovery-cd-flac-2001.nfo.flac" },
    ]),
    false
  );

  // End to end: a multi-volume release whose listed members are a single in two formats is not
  // offered as the album, whatever its Usenet health.
  const single: SourceCandidate = {
    title: "Daft Punk - Discovery CDM (Wav + Mp3)",
    nzbUrl: "https://althub.test/api?t=get&id=9",
    indexer: "altHUB",
    size: 90_000_000,
  };
  let checks = 0;
  const resolver = resolverFor(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: [single] };
    if (q.kind === "release_files") {
      return {
        candidates: [
          {
            ...q.candidate!,
            files: [
              {
                index: 0,
                path: "dp-cdm.part01.rar",
                size: 50_000_000,
                members: [
                  { index: 0, path: `wav/01 - ${t[0]}.wav`, size: 40_000_000 },
                  { index: 1, path: `mp3/01 - ${t[0]}.mp3`, size: 8_000_000 },
                ],
              },
              { index: 1, path: "dp-cdm.part02.rar", size: 40_000_000 },
            ],
          },
        ],
      };
    }
    if (q.kind === "usenet_check") {
      checks++;
      return { candidates: [{ nzbUrl: q.nzbUrl, usenetCheck: { available: true, checked: 4, missing: 0 } }] };
    }
    return { candidates: [] };
  });
  let res = resolver.resolve({ item: trackItemFor(album, 0) });
  for (let i = 0; i < 6 && res.pending; i++) res = resolver.resolve({ item: trackItemFor(album, 0) });
  assert.equal(res.sources.length, 0, "the single must not be offered for the album");
  assert.equal(checks, 0, "no Usenet check is spent on it");
});

test("ranking a long result list stops when the slice is out of time instead of being cut off", () => {
  const album = sampleDiscoveryAlbum();
  const many: SourceCandidate[] = Array.from({ length: 300 }, (_, i) => ({
    title: `Daft Punk - Discovery (2001) [FLAC] repost ${i}`,
    nzbUrl: `https://althub.test/api?t=get&id=${i}`,
    indexer: "altHUB",
    size: 130_000_000,
  }));
  const { env } = makeFakeHost({
    onResolve: (q) => (q.kind === "indexer_search" ? { candidates: many } : { candidates: [] }),
  });
  // A slow engine: every look at the clock is 120 ms later.
  let now = 1_760_000_000_000;
  env.now = () => (now += 120);
  const logs: string[] = [];
  env.log = (_level, line) => { logs.push(line); };
  const cache = new KVCache(env);
  cache.set(`album_v2:${album.id}`, album, 600_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);
  resolver.resolve({ item: trackItemFor(album, 0) });
  const ranked = logs.find((l) => /raw=300/.test(l)) || "";
  assert.match(ranked, /unscored=\d+/, `the names not reached are counted: ${ranked}`);
  assert.match(ranked, /usenet=[1-9]/, "the names scored in time are still used");
});

test("a 24-bit tag without a format word is read as lossless, in either order", () => {
  const q = (title: string) => classifyReleaseQuality(title, undefined, "flac_preferred");
  for (const title of [
    "Metallica - 1991 - Metallica (The Black Album) (2001) 96-24",
    "Artist - Album (1977) 24-96 vinyl",
    "Artist - Album [24-192]",
  ]) {
    assert.equal(q(title).lossless, true, title);
    assert.equal(q(title).tier, "flac24", title);
  }
  assert.equal(q("Artist - Album (1977) MP3 320").lossless, false);
  assert.equal(q("Artist - Album 24-96 MP3").lossless, false, "a lossy format beside the tag wins");
  // The files decide once they are listed.
  assert.equal(q("Artist - Album 96-24").lossless, true);
  assert.equal(
    classifyReleaseQuality("Artist - Album 96-24", [{ index: 0, path: "01 - Song.mp3", size: 9_000_000 }], "flac_preferred").lossless,
    false
  );
});

test("an indexer that only errors does not keep a search open once the others have answered", () => {
  const st = (...statuses: string[]) => ({ candidates: [], indexers: statuses.map((status) => ({ status })) });
  assert.equal(searchIncomplete(st("answered", "answered", "error")), false);
  assert.equal(searchIncomplete(st("answered", "skipped")), false);
  assert.equal(searchIncomplete(st("answered", "pending")), true, "an indexer still searching keeps it open");
  assert.equal(searchIncomplete(st("answered", "timed_out")), true);
  assert.equal(searchIncomplete(st("error", "error")), true, "nobody answered: no verdict");
  assert.equal(searchIncomplete({ candidates: [], pending: [{ id: "x" }] }), true);
  assert.equal(searchIncomplete(null), true);
});

test("a release answered by a source plugin plays when nothing else has the album, and only then", () => {
  const album = sampleDiscoveryAlbum();
  const fromPlugin: SourceCandidate = {
    title: "Daft Punk - Discovery (2001) [FLAC]",
    indexer: "SlskSource",
    size: 130_000_000,
    pluginRelease: { plugin: "community.slsksource", id: "abc123" },
  };
  const files = album.tracks.map((t, i) => ({ index: i, path: `${String(i + 1).padStart(2, "0")} - ${t.title}.flac`, size: 30_000_000 }));

  // 1. The plugin's release is the only candidate: it is listed through Ether and offered.
  const listed: SourceCandidate[] = [];
  const resolver = resolverFor(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: [fromPlugin] };
    if (q.kind === "release_files") {
      listed.push(q.candidate!);
      return { candidates: [{ ...q.candidate!, files }] };
    }
    return { candidates: [] };
  });
  let res = resolver.resolve({ item: trackItemFor(album, 1) });
  for (let i = 0; i < 6 && res.pending; i++) res = resolver.resolve({ item: trackItemFor(album, 1) });
  assert.equal(res.sources.length, 1, "the plugin's release is offered");
  const src = res.sources[0];
  assert.equal(src.pattern, "release");
  assert.deepEqual(src.release?.candidate?.pluginRelease, { plugin: "community.slsksource", id: "abc123" }, "Ether opens it through the plugin");
  assert.equal(src.release?.fileIndex, 1, "by the file's place in the plugin's listing");
  assert.match(src.label || "", /SlskSource/);
  assert.equal(listed[0]?.pluginRelease?.id, "abc123", "release_files is asked with the plugin release");

  // 2. With a Usenet release that verifies, the plugin's release is never asked for its files.
  const usenet: SourceCandidate = { title: "Daft Punk - Discovery (2001) [FLAC]", nzbUrl: "https://althub.test/api?t=get&id=1", indexer: "altHUB", size: 130_000_000 };
  const asked: string[] = [];
  const both = resolverFor({ ...album, id: "al-302128" }, (q) => {
    if (q.kind === "indexer_search") return { candidates: [fromPlugin, usenet] };
    if (q.kind === "release_files") {
      asked.push(q.candidate?.pluginRelease ? "plugin" : "usenet");
      return { candidates: [{ ...q.candidate!, files }] };
    }
    if (q.kind === "usenet_check") return { candidates: [{ nzbUrl: q.nzbUrl, usenetCheck: { available: true, checked: 4, missing: 0 } }] };
    return { candidates: [] };
  });
  const item = { ...trackItemFor(album, 0), parentId: "al-302128" };
  let r2 = both.resolve({ item });
  for (let i = 0; i < 6 && r2.pending; i++) r2 = both.resolve({ item });
  assert.equal(r2.sources.length, 1);
  assert.ok(r2.sources[0].release?.candidate?.nzbUrl, "the Usenet release is the one offered");
  assert.deepEqual(asked, ["usenet"], "the last resort is not touched");
});

test("a source plugin's folder with only some of the album serves the tracks it has", () => {
  const album = sampleDiscoveryAlbum();
  const folder = (id: string, idxs: number[]): { cand: SourceCandidate; files: Array<{ index: number; path: string; size: number }> } => ({
    cand: { title: "Daft Punk - Discovery (2001) [FLAC]", indexer: "SlskSource", size: 60_000_000, pluginRelease: { plugin: "community.slsksource", id } },
    files: idxs.map((ti, i) => ({ index: i, path: `${String(ti + 1).padStart(2, "0")} - ${album.tracks[ti].title}.flac`, size: 30_000_000 })),
  });
  const a = folder("first", [0, 1, 2]);
  const b = folder("second", [3]);
  const resolver = resolverFor(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: [a.cand, b.cand] };
    if (q.kind === "release_files") {
      const f = q.candidate?.pluginRelease?.id === "first" ? a.files : b.files;
      return { candidates: [{ ...q.candidate!, files: f }] };
    }
    return { candidates: [] };
  });
  const play = (ti: number) => {
    let r = resolver.resolve({ item: trackItemFor(album, ti) });
    for (let i = 0; i < 8 && r.pending; i++) r = resolver.resolve({ item: trackItemFor(album, ti) });
    return r;
  };
  const second = play(1);
  assert.equal(second.sources.length, 1, "a track the first folder has");
  assert.equal(second.sources[0].release?.candidate?.pluginRelease?.id, "first");
  assert.equal(second.sources[0].release?.fileIndex, 1);
  const fourth = play(3);
  assert.equal(fourth.sources[0]?.release?.candidate?.pluginRelease?.id, "second", "a track only the other folder has");
  assert.equal(fourth.sources[0]?.release?.fileIndex, 0);

  // A Usenet release still has to be the whole album.
  const part = matchAlbumReleaseFiles(album, "Daft Punk - Discovery (2001) [FLAC]", a.files, "flac_preferred");
  assert.equal(part.matched, false);
  assert.equal(matchAlbumReleaseFiles(album, "Daft Punk - Discovery (2001) [FLAC]", a.files, "flac_preferred", { allowPartial: true }).matched, true);
  // A folder of other songs is not this album, however partial it may be.
  const other = [0, 1, 2].map((i) => ({ index: i, path: `0${i + 1} - Some Other Song ${i}.flac`, size: 30_000_000 }));
  assert.equal(matchAlbumReleaseFiles(album, "Daft Punk - Discovery (2001) [FLAC]", other, "flac_preferred", { allowPartial: true }).matched, false);
});

test("a partial folder serves only the tracks it names exactly", () => {
  const titles = ["I Want You", "I Want You (JUNGWON Ver.)", "I Want You (JAY Ver.)", "I Want You (JAKE Ver.)"];
  const album: CanonicalAlbum = {
    ...sampleDiscoveryAlbum(),
    id: "al-1148845481",
    artistName: "ENHYPEN",
    title: "I Want You (ENHYPEN Remix)",
    year: 2026,
    trackCount: titles.length,
    tracks: titles.map((title, i) => ({ id: `tr-${i + 1}`, deezerTrackId: i + 1, title, disc: 1, trackNumber: i + 1, durationSec: 197, explicit: false, artistName: "ENHYPEN" })),
  };
  const file = (name: string, i: number) => ({ index: i, path: name, size: 44_000_000 });
  // The folder of the remix release: every version but the plain song.
  const own = ["01-02. I Want You (JUNGWON Ver.).flac", "01-03. I Want You (JAY Ver.).flac", "01-04. I Want You (JAKE Ver.).flac"].map(file);
  const m = matchAlbumReleaseFiles(album, "(2026) I Want You (ENHYPEN Remix) [FLAC]", own, "flac_preferred", { allowPartial: true });
  assert.equal(m.matched, true);
  assert.deepEqual(Object.keys(m.tracks).sort(), ["tr-2", "tr-3", "tr-4"], "the plain song is not in it");
  assert.equal(m.tracks["tr-2"].file, "01-02. I Want You (JUNGWON Ver.).flac");
  // Another remix set with the same numbering is other recordings.
  const others = ["01-02. I Want You (Holiday Ver.).flac", "01-03. I Want You (Sped Up Ver.).flac", "01-04. I Want You (Slowed Ver.).flac"].map(file);
  assert.equal(matchAlbumReleaseFiles(album, "ENHYPEN - (2026) I Want You (Remix) [FLAC]", others, "flac_preferred", { allowPartial: true }).matched, false);
  // The single holds the plain song and only that.
  const single = matchAlbumReleaseFiles(album, "ENHYPEN - I Want You [FLAC]", [file("01 - I Want You.flac", 0)], "flac_preferred", { allowPartial: true });
  assert.equal(single.matched, true);
  assert.deepEqual(Object.keys(single.tracks), ["tr-1"]);
});


function clockedResolverFor(album: CanonicalAlbum, onResolve: (q: SourceQuery) => { candidates: SourceCandidate[]; indexers?: Array<{ status: string }> }) {
  const { env } = makeFakeHost({ onResolve });
  let now = 1_760_000_000_000;
  env.now = () => now;
  const cache = new KVCache(env);
  cache.set(`album_v2:${album.id}`, album, 600_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  return { resolver: new AlbumResolver(env, cache, catalog, settings), advance: (ms: number) => { now += ms; } };
}

test("an incomplete search is asked again so a late source is picked up", () => {
  const album = sampleDiscoveryAlbum();
  const title = "Daft Punk - Discovery (2001) [FLAC]";
  const usenet: SourceCandidate = { title, nzbUrl: "https://althub.test/api?t=get&id=1", indexer: "altHUB", size: 300_000_000 };
  const slsk: SourceCandidate = { title, indexer: "SlskSource", size: 300_000_000, pluginRelease: { plugin: "community.slsksource", id: "x" } };
  const goodFiles = album.tracks.map((t, i) => ({ index: i, path: `${String(i + 1).padStart(2, "0")} - ${t.title}.flac`, size: 30_000_000 }));
  const badFiles = [{ index: 0, path: "01 - Unrelated Song.flac", size: 30_000_000 }];
  let searches = 0;
  const { resolver, advance } = clockedResolverFor(album, (q) => {
    if (q.kind === "indexer_search") {
      searches++;
      if (searches === 1) return { candidates: [usenet], indexers: [{ status: "answered" }, { status: "pending" }] };
      return { candidates: [usenet, slsk], indexers: [{ status: "answered" }, { status: "answered" }] };
    }
    if (q.kind === "release_files") {
      const files = q.candidate?.pluginRelease?.id === "x" ? goodFiles : badFiles;
      return { candidates: [{ ...q.candidate!, files }] };
    }
    return { candidates: [] };
  });
  let res = resolver.resolve({ item: trackItemFor(album, 0) });
  for (let i = 0; i < 8 && res.sources.length === 0; i++) {
    advance(1500);
    res = resolver.resolve({ item: trackItemFor(album, 0) });
  }
  assert.equal(res.sources[0]?.release?.candidate?.pluginRelease?.id, "x");
  assert.ok(searches >= 2 && searches <= 4, `searches=${searches}`);
});

test("a complete search answer is not searched again within 5 minutes", () => {
  const album = sampleDiscoveryAlbum();
  let searches = 0;
  const { resolver, advance } = clockedResolverFor(album, (q) => {
    if (q.kind === "indexer_search") {
      searches++;
      return { candidates: [], indexers: [{ status: "answered" }, { status: "answered" }] };
    }
    return { candidates: [] };
  });
  resolver.resolve({ item: trackItemFor(album, 0) });
  const afterFirst = searches;
  assert.ok(afterFirst >= 1);
  for (let i = 0; i < 12; i++) {
    advance(20_000);
    resolver.resolve({ item: trackItemFor(album, 0) });
  }
  assert.equal(searches, afterFirst, "a complete answer is reused for 5 minutes");
});

test("a refresh that comes back empty or fails keeps the earlier incomplete answer", () => {
  const album = sampleDiscoveryAlbum();
  let searches = 0;
  const seenLists: number[] = [];
  const { resolver, advance: tick } = clockedResolverFor(album, (req: any) => {
    if (req.kind === "indexer_search") {
      searches++;
      if (searches === 1) {
        return { candidates: [{ title: "Daft Punk - Discovery (2001) [FLAC]", nzbUrl: "https://x.test/1", indexer: "altHUB", size: 400_000_000 }], indexers: [{ status: "answered" }, { status: "pending" }] };
      }
      if (searches === 2) return { candidates: [], indexers: [{ status: "pending" }, { status: "pending" }] };
      throw new Error("indexer search failed");
    }
    if (req.kind === "release_files") {
      seenLists.push(searches);
      return { files: [{ path: "unrelated.flac", size: 1 }] };
    }
    return null;
  });
  const item = trackItemFor(album, 0);
  for (let i = 0; i < 6; i++) {
    resolver.resolve({ item });
    tick(3000);
  }
  assert(searches >= 3, `expected refreshes, got ${searches}`);
  // The first answer's candidate was still probed after the empty and the failed refresh.
  assert(seenLists.some((n) => n >= 2), `candidate lost after refresh: ${JSON.stringify(seenLists)}`);
});


test("dropped-at-name-ranking line: grouping, order, caps, source suffix, null case", () => {
  assert.equal(formatDroppedAtNameRanking("al-1", [], 5), null);
  const dropped = [
    { name: "A1", reason: "album title mismatch" },
    { name: "B1", indexer: "SlskSource", reason: "artist name mismatch" },
    { name: "B2", reason: "artist name mismatch" },
    { name: "B3", reason: "artist name mismatch" },
    { name: "B4 " + "x".repeat(100), reason: "artist name mismatch" },
    { name: "C1", reason: "size outside plausible album range" },
    { name: "C2", reason: "size outside plausible album range" },
    { name: "D1", reason: "uncached torrent" },
    { name: "E1", reason: "" },
  ];
  const line = formatDroppedAtNameRanking("al-1", dropped, 12)!;
  console.log(line);
  assert.match(line, /^resolve-album: al-1 dropped 9 of 12 at name ranking: artist name mismatch x4 \[/);
  assert.ok(line.indexOf("artist name mismatch x4") < line.indexOf("size outside plausible album range x2"));
  assert.match(line, /"B1" \(SlskSource\)/);
  assert.ok(!line.includes('"B4'), "only three examples per reason");
  assert.ok(!line.includes("no reason"), "only the 4 most frequent reasons");
  const longName = formatDroppedAtNameRanking("al-1", [{ name: "y".repeat(200), reason: "r" }], 1)!;
  assert.ok(longName.includes(`"${"y".repeat(70)}..."`));
  assert.ok(!longName.includes("y".repeat(71)));
  const many = Array.from({ length: 40 }, (_, i) => ({ name: "n".repeat(70) + i, indexer: "Src", reason: `reason ${i % 4} ` + "z".repeat(60) }));
  const capped = formatDroppedAtNameRanking("al-1", many, 40)!;
  assert.ok(capped.length <= 900 && capped.endsWith("..."));
});

test("names dropped at ranking are logged once per shortlist build, not per poll", () => {
  const album = sampleDiscoveryAlbum();
  const bad: SourceCandidate[] = [
    { title: "Other Band - Discovery (2001) [FLAC]", nzbUrl: "https://althub.test/1", indexer: "altHUB", size: 130_000_000 },
    { title: "Other Band - Discovery (2001) [FLAC] repost", nzbUrl: "https://althub.test/2", indexer: "altHUB", size: 130_000_000 },
    { title: "Other Band - Discovery [MP3]", nzbUrl: "https://althub.test/3", indexer: "altHUB", size: 130_000_000 },
    { title: "Daft Punk - Homework (1997) [FLAC]", nzbUrl: "https://althub.test/4", indexer: "altHUB", size: 130_000_000 },
  ];
  const resolver = resolverFor(album, (q) => (q.kind === "indexer_search" ? { candidates: bad } : { candidates: [] }));
  const logs: string[] = [];
  (resolver as unknown as { env: HostEnv }).env.log = (_l: string, line: string) => { logs.push(line); };
  resolver.resolve({ item: trackItemFor(album, 0) });
  const first = logs.filter((l) => /dropped \d+ of \d+ at name ranking/.test(l));
  assert.equal(first.length, 1, logs.join("\n"));
  console.log(first[0]);
  assert.match(first[0], /dropped 4 of 4/);
  assert.match(first[0], /artist name mismatch x3/);
  assert.match(first[0], /album title mismatch x1/);
  assert.match(first[0], /Other Band - Discovery/);
  for (let i = 0; i < 5; i++) resolver.resolve({ item: trackItemFor(album, 0) });
  const raws = logs.filter((l) => /raw=\d+/.test(l)).length;
  const drops = logs.filter((l) => /at name ranking/.test(l)).length;
  assert.ok(raws >= 1 && drops <= raws, `raw=${raws} dropped=${drops}`);
});


test("indexerQueryText keeps combining marks of non-Latin scripts and still folds Latin accents", () => {
  assert.equal(indexerQueryText("ทุกคืน"), "ทุกคืน");
  assert.equal(indexerQueryText("The Studio Project ทุกคืน"), "The Studio Project ทุกคืน");
  assert.equal(indexerQueryText("हिंदी"), "हिंदी");
  assert.equal(indexerQueryText("שָׁלוֹם"), "שָׁלוֹם");
  assert.equal(indexerQueryText("مَرْحَبًا"), "مَرْحَبًا");
  assert.equal(indexerQueryText("Beyoncé"), "Beyonce");
  assert.equal(indexerQueryText("Beyoncé"), "Beyonce");
  assert.equal(indexerQueryText("AC/DC"), "AC DC");
  assert.equal(indexerQueryText("Rock & Roll!"), "Rock Roll");
});

test("a track artist that differs from the album credit is searched after the primary query", () => {
  const base = sampleDiscoveryAlbum();
  const album: CanonicalAlbum = {
    ...base,
    id: "al-case-lang-veirs",
    artistName: "case/lang/veirs",
    title: "Accidental Tattoo",
    year: 2026,
    tracks: base.tracks.map((t) => ({ ...t, artistName: "k.d. lang" })),
  };
  const queries: string[] = [];
  const resolver = resolverFor(album, (q) => {
    if (q.kind === "indexer_search") queries.push(q.query || "");
    return { candidates: [] };
  });
  resolver.resolve({ item: trackItemFor(album, 0) });
  const alt = `${indexerQueryText("k.d. lang")} Accidental Tattoo`;
  assert.equal(queries[0], "case lang veirs Accidental Tattoo");
  assert.ok(queries.includes(alt), `alternate artist query sent: ${queries.join(" | ")}`);
  assert.ok(queries.indexOf(alt) >= 1);

  const cand = { title: "k.d. lang - Accidental Tattoo (2026) [FLAC]", nzbUrl: "https://x.test/1", indexer: "x" };
  const args = { artistName: album.artistName, title: album.title, year: 2026, releaseType: "album" as const, durationSec: 1200 };
  assert.equal(preScoreAlbumCandidate(cand, args, "flac_preferred").accepted, false);
  const withAlt = preScoreAlbumCandidate(cand, { ...args, altArtistName: "k.d. lang" }, "flac_preferred");
  assert.equal(withAlt.accepted, true, withAlt.reasons.join(", "));
});

test("a compilation with different track artists gets no extra artist query", () => {
  const base = sampleDiscoveryAlbum();
  const album: CanonicalAlbum = {
    ...base,
    id: "al-comp",
    artistName: "Various Artists",
    title: "Summer Hits",
    tracks: base.tracks.map((t, i) => ({ ...t, artistName: i % 2 ? "Artist B" : "Artist A" })),
  };
  const queries: string[] = [];
  const resolver = resolverFor(album, (q) => {
    if (q.kind === "indexer_search") queries.push(q.query || "");
    return { candidates: [] };
  });
  resolver.resolve({ item: trackItemFor(album, 0) });
  assert.ok(queries.length > 0);
  assert.ok(queries.every((q) => !q.includes("Artist A") && !q.includes("Artist B")), queries.join(" | "));
});

test("an album whose tracks share the album artist sends the same queries as before", () => {
  const album: CanonicalAlbum = {
    ...sampleDiscoveryAlbum(),
    id: "al-9410087",
    artistName: "AC/DC",
    title: "Highway to Hell",
    year: 1979,
    tracks: sampleDiscoveryAlbum().tracks.map((t) => ({ ...t, artistName: "AC/DC" })),
  };
  const queries: string[] = [];
  const resolver = resolverFor(album, (q) => {
    if (q.kind === "indexer_search") queries.push(q.query || "");
    return { candidates: [] };
  });
  resolver.resolve({ item: trackItemFor(album, 0) });
  assert.deepEqual(queries.slice(0, 2), ["AC DC Highway to Hell", "ACDC Highway to Hell"]);
});


type VersionAlbum = { artistName: string; title: string; year: number; releaseType: "album" | "single"; durationSec: number };
const versionCheck = (release: string, album: VersionAlbum) =>
  preScoreAlbumCandidate({ title: release, nzbUrl: "https://x.test/1", indexer: "x" } as never, album, "flac_preferred");
const va = (artistName: string, title: string, year = 2000, releaseType: "album" | "single" = "album"): VersionAlbum =>
  ({ artistName, title, year, releaseType, durationSec: 2400 });

test("name gate rejects releases that declare a version the request does not", () => {
  const cases: Array<[string, VersionAlbum, RegExp]> = [
    ["U2.-.Atomic.City.(Tiësto.Remix).(2024).[24Bit-48kHz].FLAC", va("U2", "Atomic City", 2023, "single"), /remix/],
    ["Buena.Vista.Social.Club-Buena.Vista.Social.Club.At.Carnegie.Hall.Live", va("Buena Vista Social Club", "Buena Vista Social Club", 1997), /live/],
    ["Delaney Davidson & Marlon Williams - Sad But True: Volume 1 (2012) MP3", va("Delaney Davidson", "Sad But True", 2020), /volume/],
    ["Pink Floyd-1974-Dark Side Of The Moon (Alan Parson's 4.1 Mix) (2496 FLAC)", va("Pink Floyd", "The Dark Side of the Moon", 1973), /alternate mix/],
  ];
  for (const [rel, album, re] of cases) {
    const r = versionCheck(rel, album);
    assert.equal(r.accepted, false, rel);
    assert.match(r.reasons.join(","), re, rel);
  }
});

test("name gate keeps the requested version and ordinary edition words", () => {
  const cases: Array<[string, VersionAlbum]> = [
    ["U2-Atomic_City-SINGLE-WEB-FLAC-2023-GRP", va("U2", "Atomic City", 2023, "single")],
    ["Buena Vista Social Club - Buena Vista Social Club (1997) [FLAC]", va("Buena Vista Social Club", "Buena Vista Social Club", 1997)],
    ["Pink Floyd - The Dark Side Of The Moon (1973) [2011 Remaster] [FLAC 24-96]", va("Pink Floyd", "The Dark Side of the Moon", 1973)],
    ["Nirvana - MTV Unplugged in New York (1994) FLAC", va("Nirvana", "MTV Unplugged in New York", 1994)],
    ["Hole - Live Through This (1994) [FLAC]", va("Hole", "Live Through This", 1994)],
    ["Live - Throwing Copper (1994) FLAC", va("Live", "Throwing Copper", 1994)],
    ["Daft Punk - Alive 2007 (2007) [FLAC]", va("Daft Punk", "Alive 2007", 2007)],
    ["Linkin Park - Reanimation (2002) FLAC", va("Linkin Park", "Reanimation", 2002)],
    ["Daft Punk - Random Access Memories (Drumless Edition) FLAC", va("Daft Punk", "Random Access Memories (Drumless Edition)", 2013)],
    ["Nirvana - Nevermind (30th Anniversary Super Deluxe) (2021) [FLAC]", va("Nirvana", "Nevermind (Remastered)", 1991)],
    ["Linkin Park - Hybrid Theory (Live Around The World) FLAC", va("Linkin Park", "Hybrid Theory (Live Around the World)", 2000)],
    ["Artist - Album Remixes (2021) FLAC", va("Artist", "Album (Remixes)", 2021)],
    ["Artist - Volume 2 (2005) FLAC", va("Artist", "Volume 2", 2005)],
  ];
  for (const [rel, album] of cases) {
    const r = versionCheck(rel, album);
    assert.equal(r.accepted, true, `${rel}: ${r.reasons.join(",")}`);
  }
  const v1 = versionCheck("Artist - Volume 1 (2004) FLAC", va("Artist", "Volume 2", 2005));
  assert.equal(v1.accepted, false);
  assert.match(v1.reasons.join(","), /volume/);
});

test("name gate: notes about extras, bare live tags and radio edits are not a different version", () => {
  const keep: Array<[string, string, string]> = [
    ["Artist - Album (Deluxe Edition incl. Live Bonus Disc) FLAC", "Album", "Artist"],
    ["Artist.-.Album.Deluxe.Edition.Incl.Live.Bonus.Disc.FLAC", "Album", "Artist"],
    ["Radiohead - Kid A Mnesia (Live Bonus)", "Kid A Mnesia", "Radiohead"],
    ["Artist - Album (Remastered + Demos) FLAC", "Album", "Artist"],
    ["Artist - Album (Deluxe Edition with Demos)", "Album", "Artist"],
    ["Artist - Album (Deluxe) [Bonus Tracks: Acoustic Version]", "Album", "Artist"],
    ["Artist - Song (Radio Edit) (2010) Single", "Song", "Artist"],
    ["Artist - Album (Remixed & Remastered)", "Album", "Artist"],
    ["DJ Shadow - Endtroducing (Mixed By DJ Shadow)", "Endtroducing", "DJ Shadow"],
    ["Various - Now That's What I Call Music! Vol 5", "Now That's What I Call Music! 5", "Various Artists"],
    ["Peter Frampton - Frampton Comes Alive! (Live 1976)", "Frampton Comes Alive!", "Peter Frampton"],
    ["Johnny Cash - At Folsom Prison (Live) [FLAC]", "At Folsom Prison", "Johnny Cash"],
    ["The Band - The Last Waltz [Live]", "The Last Waltz", "The Band"],
    ["Artist - Album v4.1", "Album", "Artist"],
  ];
  for (const [rel, album, artist] of keep) {
    assert.equal(isWrongVersionRelease(rel, album, artist).rejected, false, rel);
  }
  const drop: Array<[string, string, string, RegExp]> = [
    ["Jay-Z - The Black Album (Acapella)", "The Black Album", "Jay-Z", /alternate mix/],
    ["Buena.Vista.Social.Club-Buena.Vista.Social.Club.At.Carnegie.Hall.Live", "Buena Vista Social Club", "Buena Vista Social Club", /live/],
    ["Fleetwood Mac-Fleetwood Mac Live 1975-24BIT-96KHZ-WEB-FLAC-2", "Fleetwood Mac (Deluxe Edition)", "Fleetwood Mac", /live/],
    ["U2.-.Atomic.City.(Tiësto.Remix).(2024).[24Bit-48kHz].FLAC", "Atomic City", "U2", /remix/],
    ["bjork - homogenic (surrounded) [5.1 dts rip] (1997) FLAC", "Homogenic", "Björk", /alternate mix/],
    ["Various - Now That's What I Call Music! Vol 6", "Now That's What I Call Music! 5", "Various Artists", /volume/],
    ["Artist - Album (Live at Wembley 1986)", "Album", "Artist", /live/],
  ];
  for (const [rel, album, artist, why] of drop) {
    const v = isWrongVersionRelease(rel, album, artist);
    assert.equal(v.rejected, true, rel);
    assert.match(v.reason || "", why, rel);
  }
});

test("an incomplete answer is asked again about 3 seconds later, and only once per window", () => {
  const album = sampleDiscoveryAlbum();
  const cand: SourceCandidate = { title: "Daft Punk - Discovery (2001) [FLAC]", nzbUrl: "https://althub.test/api?t=get&id=1", indexer: "altHUB", size: 300_000_000 };
  let elapsed = 0;
  const searchedAt: number[] = [];
  const { resolver, advance } = clockedResolverFor(album, (req: any) => {
    if (req.kind === "indexer_search") {
      searchedAt.push(elapsed);
      return { candidates: [cand], indexers: [{ status: "answered" }, { status: "pending" }] } as any;
    }
    if (req.kind === "release_files") return { files: [{ path: "unrelated.flac", size: 1 }] } as any;
    return null as any;
  });
  const item = trackItemFor(album, 0);
  // Polls every 500 ms for 7 seconds, as a waiting client does.
  for (let i = 0; i <= 14; i++) {
    resolver.resolve({ item });
    advance(500);
    elapsed += 500;
  }
  assert.equal(searchedAt[0], 0);
  assert.ok(searchedAt.length >= 2, `no second search: ${JSON.stringify(searchedAt)}`);
  assert.ok(searchedAt[1] <= 3000, `second search too late: ${JSON.stringify(searchedAt)}`);
  for (let i = 1; i < searchedAt.length; i++) {
    assert.ok(searchedAt[i] - searchedAt[i - 1] >= 2500, `searches too close: ${JSON.stringify(searchedAt)}`);
  }
});

// ---------------------------------------------------------------------------------------------
// Track-first acceptance: which of the album's tracks does a release verifiably hold?
// ---------------------------------------------------------------------------------------------

function albumOf(
  id: string,
  artistName: string,
  title: string,
  year: number,
  titles: string[],
  extra: Partial<CanonicalAlbum> = {},
  durationSec = 240
): CanonicalAlbum {
  const n = Number(id.replace(/\D/g, "")) || 1;
  return {
    ...sampleDiscoveryAlbum(),
    id,
    deezerAlbumId: n,
    artistName,
    title,
    year,
    releaseDate: `${year}-01-01`,
    durationSec: titles.length * durationSec,
    trackCount: titles.length,
    discCount: 1,
    tracks: titles.map((t, i) => ({
      id: `tr-${n}${String(i + 1).padStart(2, "0")}`,
      deezerTrackId: n * 1000 + i,
      title: t,
      disc: 1,
      trackNumber: i + 1,
      durationSec,
      explicit: false,
      artistName,
    })),
    ...extra,
  };
}

const trackTitles = (prefix: string, n: number, from = 1) => Array.from({ length: n }, (_, i) => `${prefix} ${from + i}`);
const pad2 = (n: number) => String(n).padStart(2, "0");

function harness(
  album: CanonicalAlbum,
  onResolve: (q: SourceQuery) => { candidates?: SourceCandidate[] },
  extra: { mbBody?: string } = {}
) {
  const { env, calls } = makeFakeHost({ onResolve: onResolve as never });
  const logs: string[] = [];
  env.log = (...args: unknown[]) => { logs.push(String(args[1])); };
  if (extra.mbBody) {
    env.http.fetch = (req) => req.url.includes("musicbrainz.org/ws/2/recording")
      ? { status: 200, body: extra.mbBody! }
      : { status: 404, body: "" };
  }
  const cache = new KVCache(env);
  cache.set(`album_v2:${album.id}`, album, 600_000);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  const resolver = new AlbumResolver(env, cache, catalog, settings);
  const play = (item: KindItem, exclude?: string[]) => {
    const req = (): KindResolveRequest => ({ item, ...(exclude ? { client: { exclude } } : {}) });
    let r = resolver.resolve(req());
    for (let i = 0; i < 14 && r.pending; i++) r = resolver.resolve(req());
    return r;
  };
  return { resolver, env, calls, logs, cache, play };
}

const usenetOk = (cand: SourceCandidate) => ({ candidates: [{ ...cand, usenetCheck: { available: true, checked: 8, missing: 0 } }] });
const filesOf = (names: string[], size = 30_000_000) => names.map((path, index) => ({ index, path, size }));

test("Kick 25 (Deluxe Edition): the 12-track standard release serves the tracks it holds, not the bonus tracks", () => {
  const titles = [...trackTitles("Standard Song", 12), ...trackTitles("Bonus Song", 13)];
  const album = albumOf("al-9025", "INXS", "Kick 25 (Deluxe Edition)", 2012, titles);
  const cand: SourceCandidate = { title: "INXS - Kick 25 (2012) FLAC", indexer: "NZBgeek", nzbUrl: "https://nzb.test/kick25", size: 360_000_000 };
  const h = harness(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: [cand] };
    if (q.kind === "release_files") return { candidates: [{ ...cand, files: filesOf(titles.slice(0, 12).map((t, i) => `INXS - Kick 25/${pad2(i + 1)} - ${t}.flac`)) }] };
    if (q.kind === "usenet_check") return usenetOk(cand);
    return { candidates: [] };
  });
  const held = h.play(trackItemFor(album, 4));
  assert.equal(held.sources.length, 1, "a track the release holds");
  assert.equal(held.sources[0].release?.fileIndex, 4);
  assert.match(held.sources[0].label || "", /partial/);
  const bonus = h.play(trackItemFor(album, 20));
  assert.equal(bonus.sources.length, 0, "a bonus track the release does not hold");
  assert.ok(h.logs.some((l) => /resolve-album: partial al-9025 \[usenet\] "INXS - Kick 25 \(2012\) FLAC" serves=12\/25 tracks requested=yes/.test(l)), h.logs.join("\n"));
  // Asking again for the bonus track does not search again and again.
  const searches = h.calls.filter((q) => q.kind === "indexer_search").length;
  h.play(trackItemFor(album, 20));
  h.play(trackItemFor(album, 21));
  assert.equal(h.calls.filter((q) => q.kind === "indexer_search").length, searches);
});

test("B'Day (14 tracks): a 19-track deluxe release serves every standard track", () => {
  const titles = trackTitles("Standard Song", 14);
  const album = albumOf("al-9014", "Beyoncé", "B'Day", 2006, titles);
  const deluxe = [...titles, ...trackTitles("Deluxe Extra", 5)];
  const cand: SourceCandidate = { title: "Beyonce - B'Day (Deluxe Edition) (2007) FLAC", indexer: "NZBgeek", nzbUrl: "https://nzb.test/bday", size: 570_000_000 };
  const h = harness(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: [cand] };
    if (q.kind === "release_files") return { candidates: [{ ...cand, files: filesOf(deluxe.map((t, i) => `${pad2(i + 1)}. ${t}.flac`)) }] };
    if (q.kind === "usenet_check") return usenetOk(cand);
    return { candidates: [] };
  });
  for (const ti of [0, 6, 13]) {
    const r = h.play(trackItemFor(album, ti));
    assert.equal(r.sources.length, 1, `track ${ti + 1}`);
    assert.equal(r.sources[0].release?.fileIndex, ti);
  }
  // The same release is also a 31-file one: more files than the album has tracks never rejects it.
  const wide = [...deluxe, ...trackTitles("Remix Extra", 12)];
  assert.equal(matchTracksInRelease(album, cand.title!, filesOf(wide.map((t, i) => `${pad2(i + 1)} ${t}.flac`)), "flac_preferred").tracks[album.tracks[3].id]?.fileIndex, 3);
});

test("The Studio Album Collection (68 tracks): a release of one constituent album serves that album's tracks", () => {
  const titles = [
    ...trackTitles("Chic Song", 20),
    ...["Take It Off", "Burn", "Baby Doll", "Stage Fright", "Your Love", "Loving Feeling", "Mind Games", "Rapture", "Hard Times", "Closer"],
    ...trackTitles("Later Song", 38, 31),
  ];
  const album = albumOf("al-9068", "Chic", "The Studio Album Collection 1977-1992", 2018, titles, {}, 240);
  const cand: SourceCandidate = { title: "Chic - Take It Off (1981) FLAC", indexer: "NZBgeek", nzbUrl: "https://nzb.test/takeitoff", size: 300_000_000 };
  const own = titles.slice(20, 30);
  const h = harness(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: [cand] };
    if (q.kind === "release_files") return { candidates: [{ ...cand, files: filesOf(own.map((t, i) => `Chic - Take It Off/${pad2(i + 1)} ${t}.flac`)) }] };
    if (q.kind === "usenet_check") return usenetOk(cand);
    return { candidates: [] };
  });
  const r = h.play(trackItemFor(album, 22));
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].release?.fileIndex, 2);
  assert.ok(h.calls.some((q) => q.kind === "indexer_search" && /chic baby doll/i.test(q.query || "")), "the song itself is searched for a box set");
  // A track of another album of the box set is not in it.
  assert.equal(h.play(trackItemFor(album, 5)).sources.length, 0);
  // One file shared on its own, named "Artist - Album Year - Number - Title".
  const lone = matchTracksInRelease(album, "Chic - Take It Off 1981 - 10 - Baby Doll", filesOf(["Chic - Take It Off 1981 - 10 - Baby Doll.flac"]), "flac_preferred");
  assert.deepEqual(Object.keys(lone.tracks), [album.tracks[22].id]);
  // The name check does not drop one album of a box set for lacking the box set's title.
  assert.equal(preScoreAlbumCandidate(cand, { ...album, trackCount: 68 }, "flac_preferred").accepted, true);
});

test("Atlas (From the Hunger Games soundtrack): a one-file Soulseek folder and a 6-file scene release serve the single", () => {
  const album = albumOf("al-9001", "Coldplay", "Atlas (From “The Hunger Games: Catching Fire” Soundtrack)", 2013, ["Atlas (From “The Hunger Games: Catching Fire” Soundtrack)"], { releaseType: "single" }, 270);
  const plugin: SourceCandidate = { title: "Coldplay - Atlas (2013) [FLAC]", indexer: "SlskSource", size: 30_000_000, pluginRelease: { plugin: "community.slsksource", id: "folder1" } };
  const scene: SourceCandidate = { title: "Coldplay-Atlas-WEB-2013-BPM", indexer: "NZBgeek", nzbUrl: "https://nzb.test/atlas", size: 54_000_000 };
  const h = harness(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: [plugin, scene] };
    if (q.kind === "release_files") {
      if (q.candidate?.pluginRelease) return { candidates: [{ ...plugin, files: [{ index: 0, path: "01 Atlas.flac", size: 30_000_000 }] }] };
      return { candidates: [{ ...scene, files: filesOf([
        "01-coldplay-atlas.mp3",
        "02-coldplay-atlas_(instrumental).mp3",
        "03-coldplay-atlas_(acapella).mp3",
        "04-coldplay-atlas_(live).mp3",
        "05-coldplay-atlas_(radio_edit).mp3",
        "00-coldplay-atlas-web-2013-bpm.nfo.mp3",
      ], 9_000_000) }] };
    }
    if (q.kind === "usenet_check") return usenetOk(scene);
    return { candidates: [] };
  });
  const r = h.play(trackItemFor(album, 0));
  const byKind = new Map(r.sources.map((s) => [s.release?.candidate?.pluginRelease ? "plugin" : "usenet", s]));
  assert.equal(r.sources.length, 2, h.logs.join("\n"));
  assert.equal(byKind.get("plugin")?.release?.fileIndex, 0);
  assert.equal(byKind.get("usenet")?.release?.fileHint, "01-coldplay-atlas.mp3", "not the instrumental, live or radio edit");
  // Unnumbered, artist-less file names serve it too.
  const bare = matchTracksInRelease(album, "Coldplay - Atlas [FLAC]", filesOf(["Atlas.flac"]), "flac_preferred");
  assert.equal(bare.matched, true);
});

test("First in Line on a 29-track various-artists soundtrack: the single-track fallback serves it", () => {
  const album = albumOf("al-9100", "Some Band", "Some Album", 2010, trackTitles("Album Song", 10));
  const own = album.tracks[3];
  const item = trackItemFor(album, 3);
  item.hints = { ...(item.hints || {}), isrc: "USABC1200004", trackArtistName: "Some Band" };
  own.title = "First in Line";
  item.title = "First in Line";
  const folder: SourceCandidate = { title: "VA - Original Motion Picture Soundtrack (2012) [FLAC]", indexer: "SlskSource", size: 870_000_000, pluginRelease: { plugin: "community.slsksource", id: "ost" } };
  const soundtrack = [...trackTitles("OST Cue", 13), "First in Line", ...trackTitles("OST Cue", 15, 14)];
  const h = harness(album, (q) => {
    // Only the query for the song itself finds the folder.
    if (q.kind === "indexer_search") return { candidates: /first in line/i.test(q.query || "") ? [folder] : [] };
    if (q.kind === "release_files") return { candidates: [{ ...folder, files: filesOf(soundtrack.map((t, i) => `VA - OST/${pad2(i + 1)} - ${t}.flac`)) }] };
    return { candidates: [] };
  }, { mbBody: JSON.stringify({ recordings: [{ "artist-credit": [{ name: "Some Band" }], releases: [
    { title: "Original Motion Picture Soundtrack", status: "Official", "track-count": 29, "artist-credit": [{ name: "Various Artists" }], "release-group": { "primary-type": "Album", "secondary-types": ["Soundtrack"] } },
  ] }] }) });
  const r = h.play(item);
  assert.equal(r.sources.length, 1, h.logs.join("\n"));
  assert.equal(r.sources[0].release?.fileIndex, 13);
  assert.ok(h.calls.some((q) => q.kind === "indexer_search" && /some band first in line/i.test(q.query || "")), "the song itself is among the queries");
});

test("version safety: a live, early or remix file is not the studio song; a remaster is", () => {
  const album = albumOf("al-9200", "Pink Floyd", "Wish You Were Here", 1975, ["Money", "World Turning (Early Version)", "Time", "Us and Them (feat. Someone)"]);
  const serve = (name: string, files = [name], count = 4) =>
    matchTracksInRelease(album, "Pink Floyd - Wish You Were Here FLAC", filesOf(files).concat([]).slice(0, count), "flac_preferred").tracks;
  assert.deepEqual(Object.keys(serve("05 Money (Live).flac")), [], "Money (Live) is not Money");
  assert.deepEqual(Object.keys(serve("Money - Live.flac")), []);
  assert.deepEqual(Object.keys(serve("Money (Demo).flac")), []);
  assert.deepEqual(Object.keys(serve("Money (Radio Edit).flac")), []);
  assert.deepEqual(Object.keys(serve("Pink Floyd - Money (Mono).flac")), []);
  assert.deepEqual(Object.keys(serve("World Turning.flac")), [], "World Turning is not World Turning (Early Version)");
  assert.deepEqual(Object.keys(serve("World Turning (Early Version).flac")), [album.tracks[1].id]);
  for (const ok of ["Money (2011 Remaster).flac", "Money - Remastered 2011.flac", "Money (Album Version).flac", "Money.flac", "Pink Floyd - Money.flac", "money-(remastered).flac"]) {
    assert.deepEqual(Object.keys(serve(ok)), [album.tracks[0].id], ok);
  }
  assert.deepEqual(Object.keys(serve("Us and Them.flac")), [album.tracks[3].id], "a credit on one side only");
  assert.deepEqual(Object.keys(serve("Us and Them (with Someone Else).flac")), [album.tracks[3].id]);
  // Same edition (4 files for 4 tracks): a track number that disagrees is another song.
  const same = matchTracksInRelease(album, "Pink Floyd - Wish You Were Here FLAC", filesOf(["03 Money.flac", "03 Time.flac", "04 Filler.flac", "01 Filler Two.flac"]), "flac_preferred");
  assert.deepEqual(Object.keys(same.tracks), [album.tracks[2].id], "Time is track 3 and agrees; Money is track 1, not 3");
  // A different edition ignores numbers.
  const other = matchTracksInRelease(album, "Pink Floyd - Wish You Were Here FLAC", filesOf(["07 Money.flac", "08 Filler.flac"]), "flac_preferred");
  assert.deepEqual(Object.keys(other.tracks), [album.tracks[0].id]);
  // A file of the wrong size for the track's length is not it (a 3 s sample, a 20 minute mix).
  assert.deepEqual(Object.keys(matchTracksInRelease(album, "x FLAC", [{ index: 0, path: "Money.flac", size: 900_000_000 }], "flac_preferred").tracks), []);
  // Two files for one track: the lowest disc, then the first.
  const two = matchTracksInRelease(album, "x FLAC", filesOf(["CD2/01 Money.flac", "CD1/05 Money.flac", "Money.flac"]), "flac_preferred");
  assert.equal(two.tracks[album.tracks[0].id].file, "CD1/05 Money.flac");
  assert.equal(Object.keys(two.tracks).length, 1, "one file never serves two tracks");
});

test("sources: every verified release for a track is returned, whole albums first, each verified by duration on open", () => {
  assert.equal(durationToleranceFor(240), 7);
  assert.equal(durationToleranceFor(400), 12);
  assert.equal(durationToleranceFor(1000), 30);
  const titles = trackTitles("Disc Song", 5);
  const album = albumOf("al-9300", "Test Band", "Test Album", 2001, titles, {}, 400);
  const mk = (id: string, partial: boolean, kind: "usenet" | "plugin", score: number): VerifiedAlbumRelease => ({
    releaseId: kind === "usenet" ? `nzb:https://nzb.test/${id}` : `plg:community.slsksource:${id}`,
    sourceKind: kind,
    qualityTier: "flac",
    codec: "FLAC",
    mime: "audio/flac",
    label: `FLAC ${id}`,
    score,
    candidate: kind === "usenet" ? { title: id, nzbUrl: `https://nzb.test/${id}` } : { title: id, pluginRelease: { plugin: "community.slsksource", id } },
    ...(partial ? { partial: true } : {}),
    tracks: { [album.tracks[0].id]: { fileIndex: 0, file: "01.flac", fileHint: "01.flac", size: 40_000_000, mime: "audio/flac", confidence: 0.95 } },
  });
  const h = harness(album, () => ({ candidates: [] }));
  h.cache.set(albumCacheKey(album.id), {
    albumId: album.id, resolvedAt: 0, expiresAt: Date.now() + 3_600_000, exhausted: true,
    releases: [mk("partial-a", true, "usenet", 190), mk("whole-d", false, "usenet", 160), mk("whole-b", false, "plugin", 120), mk("partial-c", true, "plugin", 150)],
  }, 3_600_000);
  const r = h.play(trackItemFor(album, 0));
  assert.deepEqual(r.sources.map((s) => s.label?.replace(" · partial", "")), ["FLAC whole-d", "FLAC whole-b", "FLAC partial-a", "FLAC partial-c"], "whole albums first, then partial, each by rank");
  for (const s of r.sources) {
    assert.equal(s.durationSec, 400);
    assert.equal(s.durationToleranceSec, 12);
  }
  // No tolerance for a track whose length is unknown or under 30 s.
  const unknown = trackItemFor(album, 0);
  unknown.hints = { ...(unknown.hints || {}), durationSec: 0 };
  unknown.fields = { ...(unknown.fields || {}), duration: 0 };
  assert.equal(h.play(unknown).sources[0].durationToleranceSec, undefined);
  const brief = trackItemFor(album, 0);
  brief.hints = { ...(brief.hints || {}), durationSec: 25 };
  assert.equal(h.play(brief).sources[0].durationToleranceSec, undefined);
  // Not for a single-file image of the whole album.
  const imageRel = mk("image", false, "usenet", 100);
  imageRel.candidate.title = "Test Band - Test Album (image + cue) FLAC";
  h.cache.set(albumCacheKey(album.id), { albumId: album.id, resolvedAt: 0, expiresAt: Date.now() + 3_600_000, exhausted: true, releases: [imageRel] }, 3_600_000);
  assert.equal(h.play(trackItemFor(album, 0)).sources[0].durationToleranceSec, undefined);
  // The cap.
  const many = Array.from({ length: 8 }, (_, i) => mk(`rel-${i}`, false, "usenet", 100 - i));
  h.cache.set(albumCacheKey(album.id), { albumId: album.id, resolvedAt: 0, expiresAt: Date.now() + 3_600_000, exhausted: true, releases: many }, 3_600_000);
  assert.equal(h.play(trackItemFor(album, 0)).sources.length, 5);
});

test("client.exclude in the host's id form removes that source from the answer", () => {
  const album = albumOf("al-9400", "Test Band", "Test Album", 2001, trackTitles("Disc Song", 5));
  const usenet: VerifiedAlbumRelease = {
    releaseId: "nzb:https://nzb.test/one", sourceKind: "usenet", qualityTier: "flac", codec: "FLAC", mime: "audio/flac", label: "usenet", score: 150,
    candidate: { title: "one", nzbUrl: "https://nzb.test/one" },
    tracks: { [album.tracks[0].id]: { fileIndex: 0, file: "01.flac", fileHint: "01.flac", size: 1, mime: "audio/flac", confidence: 1 } },
  };
  const plugin: VerifiedAlbumRelease = {
    ...usenet, releaseId: "plg:community.slsksource:abc", sourceKind: "plugin", label: "plugin", score: 140,
    candidate: { title: "two", pluginRelease: { plugin: "community.slsksource", id: "abc" } },
  };
  const torrent: VerifiedAlbumRelease = {
    ...usenet, releaseId: "ih:aabbccddeeff00112233445566778899aabbccdd", sourceKind: "debrid", label: "torrent", score: 130,
    candidate: { title: "three", infoHash: "AABBCCDDEEFF00112233445566778899AABBCCDD", cached: true },
  };
  const h = harness(album, () => ({ candidates: [] }));
  h.cache.set(albumCacheKey(album.id), { albumId: album.id, resolvedAt: 0, expiresAt: Date.now() + 3_600_000, exhausted: true, releases: [usenet, plugin, torrent] }, 3_600_000);
  const item = trackItemFor(album, 0);
  const labels = (exclude?: string[]) => h.play(item, exclude).sources.map((s) => s.label);
  assert.deepEqual(labels(), ["usenet", "plugin", "torrent"]);
  assert.deepEqual(labels(["kind:https://nzb.test/one:file:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"]), ["plugin", "torrent"]);
  assert.deepEqual(labels(["kind:plugin:community.slsksource:lazy:abc"]), ["usenet", "torrent"]);
  assert.deepEqual(labels(["kind:plugin:community.slsksource:lazy:abc:file:1234"]), ["usenet", "torrent"]);
  assert.deepEqual(labels(["kind:aabbccddeeff00112233445566778899aabbccdd"]), ["usenet", "plugin"]);
  // The plugin's own refs still work, and an unrelated host id removes nothing.
  assert.deepEqual(labels(["plg:community.slsksource:abc"]), ["usenet", "torrent"]);
  assert.deepEqual(labels(["kind:https://nzb.test/other"]), ["usenet", "plugin", "torrent"]);
  assert.equal(isReleaseExcluded(new Set(["kind:https://nzb.test/one-more"]), usenet.releaseId, usenet.candidate), false, "a longer url is another release");
});

test("a source plugin's folder without the artist in its name reaches the file stage when the album title is in it", () => {
  const titles = trackTitles("Hunt Theme", 6);
  const album = albumOf("al-9500", "Capcom Sound Team", "Monster Hunter Tri Original Soundtrack", 2009, titles);
  const folder: SourceCandidate = { title: "Monster Hunter Tri Original Soundtrack - FLAC (16bit-44.1kHz)", indexer: "SlskSource", size: 180_000_000, pluginRelease: { plugin: "community.slsksource", id: "mh" } };
  const asNzb: SourceCandidate = { ...folder, pluginRelease: undefined, nzbUrl: "https://nzb.test/mh" };
  assert.equal(preScoreAlbumCandidate(asNzb, album, "flac_preferred").reasons[0], "artist name mismatch", "Usenet keeps the rule");
  const pre = preScoreAlbumCandidate(folder, album, "flac_preferred");
  assert.equal(pre.accepted, true);
  const withArtist = preScoreAlbumCandidate({ ...folder, title: `Capcom Sound Team - ${folder.title}` }, album, "flac_preferred");
  assert.ok(withArtist.score > pre.score, "a name that carries the artist scores higher");
  // A short title is not enough to take an artist-less name.
  const short = { ...album, title: "Discovery" };
  assert.equal(preScoreAlbumCandidate({ ...folder, title: "Discovery [FLAC]" }, short, "flac_preferred").accepted, false);
  // Letters of other scripts count: a Japanese soundtrack named by its own title.
  const jp = { ...album, artistName: "Capcom", title: "モンスターハンター3 (tri-) オリジナル・サウンドトラック" };
  assert.equal(preScoreAlbumCandidate({ ...folder, title: "モンスターハンター3 (tri-) オリジナル・サウンドトラック - FLAC (16bit-44.1kHz)" }, jp, "flac_preferred").accepted, true);

  const h = harness(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: [folder] };
    if (q.kind === "release_files") return { candidates: [{ ...folder, files: filesOf(titles.map((t, i) => `${pad2(i + 1)} ${t}.flac`)) }] };
    return { candidates: [] };
  });
  const r = h.play(trackItemFor(album, 2));
  assert.equal(r.sources.length, 1);
  assert.equal(r.sources[0].release?.fileIndex, 2);
});

test("a later play of another track re-uses the listed releases and goes on only with the rest of the shortlist", () => {
  const titles = trackTitles("Shared Song", 6);
  const album = albumOf("al-9600", "Test Band", "Test Album", 2001, titles);
  const mk = (i: number, flac: boolean): SourceCandidate => ({
    title: flac ? `Test Band - Test Album (2001) FLAC repost ${i}` : `Test Band - Test Album (2001) MP3 320 repost ${i}`,
    indexer: "NZBgeek", nzbUrl: `https://nzb.test/r${i}`, size: flac ? 150_000_000 : 60_000_000,
  });
  const cands = [mk(1, true), mk(2, true), mk(3, true), mk(4, false)];
  const listed: string[] = [];
  const h = harness(album, (q) => {
    if (q.kind === "indexer_search") return { candidates: cands };
    if (q.kind === "release_files") {
      listed.push(q.candidate!.nzbUrl!);
      // The first three hold tracks 1-3; the last one is the only one with track 6.
      const names = q.candidate!.nzbUrl === "https://nzb.test/r4" ? [5] : [0, 1, 2];
      return { candidates: [{ ...q.candidate!, files: filesOf(names.map((ti) => `${pad2(ti + 1)} ${titles[ti]}.${q.candidate!.nzbUrl === "https://nzb.test/r4" ? "mp3" : "flac"}`), q.candidate!.nzbUrl === "https://nzb.test/r4" ? 9_000_000 : 30_000_000) }] };
    }
    if (q.kind === "usenet_check") return usenetOk(q.candidate!);
    return { candidates: [] };
  });
  assert.equal(h.play(trackItemFor(album, 0)).sources.length, 3);
  assert.equal(listed.length, 3, "the last candidate was not needed yet");
  const sixth = h.play(trackItemFor(album, 5));
  assert.equal(sixth.sources.length, 1, h.logs.join("\n"));
  assert.equal(sixth.sources[0].release?.candidate?.nzbUrl, "https://nzb.test/r4");
  assert.deepEqual(listed, ["https://nzb.test/r1", "https://nzb.test/r2", "https://nzb.test/r3", "https://nzb.test/r4"], "nothing listed twice");
  // The earlier releases still answer for their tracks.
  assert.equal(h.play(trackItemFor(album, 1)).sources.length, 3);
  // A track nothing holds ends: the shortlist is used up, no further searching or listing.
  const searches = h.calls.length;
  assert.equal(h.play(trackItemFor(album, 4)).sources.length, 0);
  assert.equal(h.play(trackItemFor(album, 4)).sources.length, 0);
  assert.equal(h.calls.length, searches, "no loop");
});

test("an edition of the library album is tried by the single-track fallback, after the other releases", () => {
  const releases = [
    { title: "Kick", year: 1987, primaryType: "Album", secondaryTypes: [], trackCount: 12, artistName: "INXS" },
    { title: "Kick (Deluxe Edition)", year: 2012, primaryType: "Album", secondaryTypes: [], trackCount: 25, artistName: "INXS" },
    { title: "Need You Tonight", year: 1987, primaryType: "Single", secondaryTypes: [], trackCount: 2, artistName: "INXS" },
    { title: "Kick 25", year: 2012, primaryType: "Album", secondaryTypes: [], trackCount: 25, artistName: "INXS" },
  ];
  const picked = pickRecordingReleases(releases, "Kick 25");
  assert.deepEqual(picked.map((p) => p.title), ["Need You Tonight", "Kick"], "the single first; one edition last; the library's own title is not repeated");
});

test("a requested box set is not rejected for being a box set; dotted SACD.5.1 names are a surround mix", () => {
  assert.equal(isRejectedReleaseForRequest("Chic - The Studio Album Collection 1977-1992 (2014) [FLAC]", "The Studio Album Collection 1977-1992", "album").rejected, false);
  assert.equal(isRejectedReleaseForRequest("Chic - Discography 1977-1992 FLAC", "Risqué", "album").rejected, true);
  assert.equal(isWrongVersionRelease("Pink.Floyd.-.The.Dark.Side.Of.The.Moon.(1973.Prog.Rock).[Flac.24-88.SACD.5.1]", "The Dark Side of the Moon", "Pink Floyd").rejected, true);
  assert.equal(isWrongVersionRelease("Pink Floyd - The Dark Side Of The Moon [FLAC 24-44.1]", "The Dark Side of the Moon", "Pink Floyd").rejected, false);
  assert.equal(isWrongVersionRelease("Artist - Album v4.1", "Album", "Artist").rejected, false);
});

// ---------------------------------------------------------------------------------------------
// Review 3 fixes
// ---------------------------------------------------------------------------------------------

function review3Settings() {
  return {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "standard" as const,
    enrichMusicBrainz: false,
  };
}

test("defect 7: a MusicBrainz failure is not remembered as 'no such recording'", () => {
  const album = sampleDiscoveryAlbum();
  const single: SourceCandidate = {
    title: "Daft Punk - One More Time (2000) [FLAC]",
    indexer: "NZBgeek",
    nzbUrl: "https://api.nzbgeek.info/api?t=get&id=omt-single7",
    size: 90_000_000,
  };
  const mbOk = JSON.stringify({ recordings: [{ "artist-credit": [{ name: "Daft Punk" }], releases: [
    { title: "One More Time", status: "Official", "track-count": 2, "release-group": { "primary-type": "Single" } },
  ] }] });
  const failures: Array<() => { status: number; body: string }> = [
    () => ({ status: 500, body: "" }),
    () => ({ status: 502, body: "bad gateway" }),
    () => { throw new Error("network down"); },
    () => ({ status: 200, body: "<html>not json" }),
    () => ({ status: 200, body: JSON.stringify({ error: "oops" }) }),
  ];
  for (const fail of failures) {
    let mbMode: "fail" | "ok" = "fail";
    const { env, kvMap } = makeFakeHost({
      onResolve: (q) => {
        if (q.kind === "indexer_search") return { candidates: /one more time/i.test(q.query || "") ? [single] : [] };
        if (q.kind === "release_files") return { candidates: [{ ...q.candidate!, files: [{ index: 0, path: "01 - One More Time.flac", size: 40_000_000 }] }] };
        if (q.kind === "usenet_check") return { candidates: [{ ...single, usenetCheck: { available: true, checked: 8, missing: 0 } }] };
        return { candidates: [] };
      },
    });
    env.http.fetch = (req) => {
      if (!req.url.includes("musicbrainz.org/ws/2/recording")) return { status: 404, body: "" };
      return mbMode === "ok" ? { status: 200, body: mbOk } : fail();
    };
    const cache = new KVCache(env);
    cache.set("album_v2:al-302127", album, 60_000);
    const settings = review3Settings();
    const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
    const resolver = new AlbumResolver(env, cache, catalog, settings);
    const item = trackItemFor(album, 0);
    item.hints = { ...(item.hints || {}), isrc: "GBDUW0000053" };
    // The album itself is known not to hold the song: straight to the recording path.
    cache.set(albumCacheKey("al-302127"), { albumId: "al-302127", resolvedAt: 0, expiresAt: Date.now() + 3_600_000, releases: [], negative: true }, 3_600_000);

    const first = resolver.resolve({ item });
    assert.equal(first.sources.length, 0);
    assert.ok((first.ttlSec ?? 0) > 0 && (first.ttlSec ?? 0) <= 60, `short ttl, got ${first.ttlSec}`);
    assert.equal(cache.get(albumCacheKey("rec-GBDUW0000053")), null);
    assert.equal(cache.get("mb:isrc:GBDUW0000053"), null, "the failure is not cached as a miss");

    // MusicBrainz is back: the recording is found.
    mbMode = "ok";
    cache.delete("rl:musicbrainz");
    for (const k of kvMap.keys()) if (k.includes("rl:musicbrainz")) kvMap.delete(k);
    let res = resolver.resolve({ item });
    for (let i = 0; res.pending && i < 12; i++) res = resolver.resolve({ item });
    assert.equal(res.sources[0]?.release?.candidate?.nzbUrl, single.nzbUrl);
  }
});

function resumeHarness(opts: { searchAnswer: (n: number) => { candidates: SourceCandidate[]; pending?: unknown[] } }) {
  const titles = ["Song 1", "Song 2", "Song 3", "Song 4", "Song 5", "Bonus Song"];
  const album: CanonicalAlbum = {
    ...sampleDiscoveryAlbum(),
    id: "al-777", deezerAlbumId: 777, artistName: "Test Band", title: "Test Album", year: 2001, trackCount: titles.length,
    tracks: titles.map((t, i) => ({ id: `tr-77${i}`, deezerTrackId: 7700 + i, title: t, disc: 1, trackNumber: i + 1, durationSec: 240, explicit: false, artistName: "Test Band" })),
  };
  const cand = (i: number): SourceCandidate => ({ title: `Test Band - Test Album (2001) FLAC r${i}`, indexer: "NZBgeek", nzbUrl: `https://nzb.test/r${i}`, size: 150_000_000 });
  let clock = 1_760_000_000_000;
  let searches = 0;
  const { env, kvMap, calls } = makeFakeHost({
    onResolve: (q) => {
      clock += 300;
      if (q.kind === "indexer_search") return opts.searchAnswer(++searches);
      if (q.kind === "release_files") {
        return { candidates: [{ ...q.candidate!, files: titles.slice(0, 5).map((t, i) => ({ index: i, path: `${String(i + 1).padStart(2, "0")} ${t}.flac`, size: 30_000_000 })) }] };
      }
      if (q.kind === "usenet_check") return { candidates: [{ ...q.candidate!, usenetCheck: { available: true, checked: 8, missing: 0 } }] };
      return { candidates: [] };
    },
  });
  env.now = () => clock;
  const cache = new KVCache(env);
  cache.set(`album_v2:${album.id}`, album, 24 * 3_600_000);
  const settings = review3Settings();
  const resolver = new AlbumResolver(env, cache, new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings), settings);
  const poll = (idx: number, max = 30) => {
    let res = resolver.resolve({ item: trackItemFor(album, idx) });
    for (let i = 0; res.pending && i < max; i++) {
      clock += 400;
      res = resolver.resolve({ item: trackItemFor(album, idx) });
    }
    return res;
  };
  return { album, cand, cache, resolver, poll, advance: (ms: number) => { clock += ms; }, kvMap, calls, searches: () => searches };
}

test("defect 5: a resumed search that was incomplete never records the album as exhausted or a long-lived miss", () => {
  const pendingNote = [{ indexerId: "slow", indexer: "Slow" }];
  let complete = false;
  const c1: SourceCandidate = { title: "Test Band - Test Album (2001) FLAC r1", indexer: "NZBgeek", nzbUrl: "https://nzb.test/r1", size: 150_000_000 };
  const c2: SourceCandidate = { ...c1, title: "Test Band - Test Album (2001) FLAC r2", nzbUrl: "https://nzb.test/r2" };
  let n = 0;
  // Search 1: both candidates, one indexer still running. Later searches: only the second.
  const h2 = resumeHarness({
    searchAnswer: () => {
      n++;
      return n === 1 ? { candidates: [c1, c2], pending: pendingNote } : (complete ? { candidates: [c2] } : { candidates: [c2], pending: pendingNote });
    },
  });
  const first = h2.poll(0);
  assert.equal(first.sources.length, 1, "the partial release plays track 1");
  // The bonus track: no cached release serves it, the second search is incomplete too.
  h2.advance(10_000);
  const bonus = h2.poll(5);
  assert.equal(bonus.sources.length, 0);
  assert.ok((bonus.ttlSec ?? 0) <= 60, `short ttl while the search was incomplete, got ${bonus.ttlSec}`);
  const rec = h2.cache.get<{ exhausted?: boolean; negative?: boolean }>(albumCacheKey("al-777"));
  assert.ok(rec, "the releases found so far stay cached");
  assert.notEqual(rec!.exhausted, true, "not exhausted after an incomplete search");
  assert.notEqual(rec!.negative, true);
  // The next play searches again; the indexer has finished now: only then is the album exhausted.
  complete = true;
  h2.advance(60_000);
  const again = h2.poll(5);
  assert.equal(again.sources.length, 0);
  const rec2 = h2.cache.get<{ exhausted?: boolean }>(albumCacheKey("al-777"));
  assert.equal(rec2?.exhausted, true, "a complete search with nothing more does exhaust it");
});

test("defect 5: an incomplete resumed search with nothing to list answers pending, then briefly empty; nothing remembered", () => {
  const pendingNote = [{ indexerId: "slow", indexer: "Slow" }];
  const c1 = (() => ({ title: "Test Band - Test Album (2001) FLAC r1", indexer: "NZBgeek", nzbUrl: "https://nzb.test/r1", size: 150_000_000 }))();
  let n = 0;
  const h = resumeHarness({
    searchAnswer: () => (++n === 1 ? { candidates: [c1], pending: pendingNote } : { candidates: [], pending: pendingNote }),
  });
  assert.equal(h.poll(0).sources.length, 1);
  h.advance(10_000);
  let res = h.resolver.resolve({ item: trackItemFor(h.album, 5) });
  assert.equal(res.pending, true, "an unfinished search is asked again, not answered");
  let pendings = 1;
  for (; res.pending && pendings < 30; pendings++) {
    h.advance(1_500);
    res = h.resolver.resolve({ item: trackItemFor(h.album, 5) });
  }
  assert.ok(pendings <= 10, `bounded by the inconclusive budget, took ${pendings}`);
  assert.equal(res.sources.length, 0);
  assert.ok((res.ttlSec ?? 0) > 0 && (res.ttlSec ?? 0) <= 60, `short ttl, got ${res.ttlSec}`);
  const rec = h.cache.get<{ exhausted?: boolean; negative?: boolean }>(albumCacheKey("al-777"));
  assert.notEqual(rec?.exhausted, true);
  assert.notEqual(rec?.negative, true);
});

// ---- Review 3: file-name matching (defects 1-4, 8), exclusions (9, 10), folder guard (11) ----
import { isPlausibleTrackSize, isGenericAlbumTitle } from "./resolver.ts";
import { isBenignTitleNote, titleSignature, fileTitleRuns } from "./normalize.ts";

const R3MB = 1_000_000;

interface R3Opts {
  artist?: string;
  albumTitle?: string;
  dur?: number;
  size?: number;
  others?: string[];
  trackNo?: number;
  trackArtists?: string[];
  release?: string;
  recording?: boolean;
  /** Titles of the album's other tracks (default: two fillers, the files hold them). */
  tracks?: string[];
}

function r3Album(titles: string[], o: R3Opts = {}): CanonicalAlbum {
  const artist = o.artist ?? "Coldplay";
  return {
    ...sampleDiscoveryAlbum(),
    id: "al-r3",
    artistName: artist,
    title: o.albumTitle ?? "Alb",
    trackCount: titles.length,
    discCount: 1,
    tracks: titles.map((t, i) => ({
      id: `t${i}`, deezerTrackId: i, title: t, disc: 1, trackNumber: i + 1, durationSec: o.dur ?? 240, explicit: false,
      artistName: o.trackArtists?.[i] ?? artist,
    })),
    ...(o.recording ? { recordingTarget: { releaseTrackCount: 12 } } : {}),
  };
}

/** Whether `file` (alone among two filler files of the same edition) serves a track titled `trackTitle`. */
function r3Serves(file: string, trackTitle: string, o: R3Opts = {}): boolean {
  const others = o.others ?? ["Other A", "Other B"];
  const album = r3Album([trackTitle, ...others], o);
  const m = file.match(/^(\d+)[ -]/);
  album.tracks[0].trackNumber = o.trackNo ?? (m ? Number(m[1]) : 1);
  const files = [{ index: 0, path: file, size: o.size ?? 30 * R3MB }];
  others.forEach((t, i) => files.push({ index: i + 1, path: `${String(i + 2).padStart(2, "0")} ${t}.flac`, size: 30 * R3MB }));
  const r = matchTracksInRelease(album, o.release ?? "Coldplay - Alb [FLAC]", files, "flac_preferred");
  return Boolean(r.tracks["t0"]);
}

/** The same, in a dump of 30 unrelated files (so no file count or number settles it). */
function r3ServesInDump(file: string, trackTitle: string, o: R3Opts = {}): boolean {
  const filler = Array.from({ length: 30 }, (_, i) => `Filler ${i}`);
  const album = r3Album([trackTitle, ...filler.slice(0, 10)], o);
  const files = [{ index: 0, path: file, size: o.size ?? 30 * R3MB }, ...filler.map((f, i) => ({ index: i + 1, path: `${String(i + 20).padStart(2, "0")} ${f}x.flac`, size: 30 * R3MB }))];
  return Boolean(matchTracksInRelease(album, o.release ?? "Coldplay - Alb [FLAC]", files, "flac_preferred").tracks["t0"]);
}

function r3Single(file: string, release: string, albumTracks = 1, extra: Partial<R3Opts> = {}): boolean {
  const album = r3Album(["Atlas", ...Array.from({ length: albumTracks - 1 }, (_, i) => `Other ${i + 1}`)], { albumTitle: "Atlas", dur: 270, ...extra });
  const r = matchTracksInRelease(album, release, [{ index: 0, path: file, size: 30 * R3MB }], "flac_preferred");
  return Boolean(r.tracks["t0"]);
}

test("defect 1: a one-file release named for the song takes its title from the release only when the file has none", () => {
  const rel = "Coldplay - Atlas [FLAC]";
  for (const albumTracks of [1, 3]) {
    // The file's own title decides, version notes and all.
    for (const f of ["01 Atlas (Demo).flac", "01 Atlas (Live at Wembley).flac", "01 Atlas - Acoustic.flac", "01 Atlas (Tiësto Remix).flac", "01 Something Else Entirely.flac", "01 Intro.flac"]) {
      assert.equal(r3Single(f, rel, albumTracks), false, `${f} (${albumTracks}-track album)`);
    }
    // No title of its own: the release name stands in.
    for (const f of ["01.flac", "track01.flac", "audio.flac", "Track 01.flac"]) {
      assert.equal(r3Single(f, rel, albumTracks), true, `${f} (${albumTracks}-track album)`);
    }
    for (const f of ["01 Atlas.flac", "Coldplay - Atlas.flac", "01-coldplay-atlas.flac"]) {
      assert.equal(r3Single(f, rel, albumTracks), true, `${f} has the title itself`);
    }
    // A name that is just the release name.
    assert.equal(r3Single("Coldplay - Atlas [FLAC].flac", rel, albumTracks), true);
    assert.equal(r3Single("Coldplay - Atlas (2013) [FLAC].flac", "Coldplay - Atlas (2013) [FLAC]", albumTracks), true);
  }
  // The release name's own brackets are read for version notes.
  for (const release of ["Coldplay - Atlas (Radio Edit) [FLAC]", "Coldplay - Atlas (Demo)", "Coldplay - Atlas (Tiësto Remix) [FLAC]", "Coldplay - Atlas - Acoustic [FLAC]"]) {
    for (const f of ["01.flac", "track01.flac", `${release}.flac`]) assert.equal(r3Single(f, release), false, `${release} / ${f}`);
  }
  // Format and edition brackets are ignored.
  for (const release of ["Coldplay - Atlas [FLAC]", "Coldplay - Atlas (2013)", "Coldplay - Atlas [single]", "Coldplay - Atlas (Deluxe)", "Coldplay - Atlas (2013) [FLAC 24-96]", "Coldplay - Atlas (Remastered) [WEB]"]) {
    assert.equal(r3Single("01.flac", release), true, release);
  }
  // A bare "(Live)" on the release name is read as isWrongVersionRelease reads it at the name stage: ignored.
  assert.equal(isWrongVersionRelease("Coldplay - Atlas (Live)", "Atlas", "Coldplay").rejected, false);
  assert.equal(r3Single("01.flac", "Coldplay - Atlas (Live)"), true);
  // Another artist's release does not serve the song.
  assert.equal(r3Single("01.flac", "Other Artist - Atlas [FLAC]"), false);
});

test("defect 2: the artist in a file name is checked", () => {
  const O = { others: ["Other A", "Other B"] };
  for (const f of ["03 - Other Artist - Atlas.flac", "Other Artist - Atlas.flac", "03-other_artist-atlas.mp3", "Other Artist - Alb - 03 - Atlas.flac", "04. Someone Else - Atlas.flac"]) {
    assert.equal(r3Serves(f, "Atlas", { ...O, size: 9 * R3MB, trackNo: 3 }), false, f);
    assert.equal(r3ServesInDump(f, "Atlas", { size: 9 * R3MB }), false, `${f} (dump)`);
  }
  // Still served.
  for (const f of ["01 Atlas.flac", "01-coldplay-atlas.mp3", "Coldplay - Atlas.flac", "Coldplay - Alb - 03 - Atlas.flac", "01 - Coldplay - Atlas.flac",
    "Coldplay feat. Rihanna - Atlas.flac", "COLDPLAY - ATLAS.flac", "coldplay_-_atlas.flac", "2013 - Coldplay - Atlas.flac", "Coldplay - Alb 2013 - 01 - Atlas.flac"]) {
    assert.equal(r3Serves(f, "Atlas", { ...O, size: 9 * R3MB }), true, f);
  }
  // The album named in the file; the release's own segments.
  assert.equal(r3Serves("Coldplay - Ghost Stories - 03 - Atlas.flac", "Atlas", { albumTitle: "Ghost Stories", trackNo: 3 }), true);
  assert.equal(r3Serves("Coldplay - Ghost Stories 2014 - 03 - Atlas.flac", "Atlas", { albumTitle: "Ghost Stories", trackNo: 3 }), true);
  assert.equal(r3Serves("Ghost Stories - Atlas.flac", "Atlas", { albumTitle: "Ghost Stories (Deluxe Edition)" }), true);
  assert.equal(r3Serves("Other Artist - Ghost Stories - 03 - Atlas.flac", "Atlas", { albumTitle: "Ghost Stories", trackNo: 3 }), false);
  // Artist spellings: "The", joined names, a name with a credit.
  assert.equal(r3Serves("Beatles - Hey Jude.flac", "Hey Jude", { artist: "The Beatles" }), true);
  assert.equal(r3Serves("ACDC - Thunderstruck.flac", "Thunderstruck", { artist: "AC/DC" }), true);
  assert.equal(r3Serves("Coldplay - Atlas.flac", "Atlas", { artist: "Coldplay feat. Someone" }), true);
  assert.equal(r3Serves("Simon and Garfunkel - America.flac", "America", { artist: "Simon & Garfunkel" }), true);
  assert.equal(r3Serves("Other Artist - America.flac", "America", { artist: "Simon & Garfunkel" }), false);
  // Various-artists album: each track has its own artist.
  const va = { artist: "Various Artists", trackArtists: ["Coldplay", "Other A Artist", "Other B Artist"] };
  assert.equal(r3Serves("Coldplay - Atlas.flac", "Atlas", va), true);
  assert.equal(r3Serves("Other Artist - Atlas.flac", "Atlas", va), false);
  assert.equal(r3Serves("Various Artists - Atlas.flac", "Atlas", va), true);
  assert.equal(r3Serves("Atlas.flac", "Atlas", va), true);
  // The track's artist is unknown: nothing is judged, as before.
  assert.equal(r3Serves("Other Artist - Atlas.flac", "Atlas", { artist: "", trackArtists: ["", "", ""], size: 9 * R3MB }), true);
  assert.equal(r3Serves("Other Artist - Atlas.flac", "Atlas", { artist: "Various Artists", trackArtists: ["Various Artists", "x", "y"] }), true);
  // The recording path (a song looked for on another release, compilations allowed).
  assert.equal(r3Serves("Other Artist - Atlas.flac", "Atlas", { recording: true, others: [] }), false);
  assert.equal(r3Serves("Coldplay - Atlas.flac", "Atlas", { recording: true, others: [] }), true);
});

test("defect 3: durations under 60 s are checked with a tight tolerance; short tracks and oversized files", () => {
  assert.equal(durationToleranceFor(10), 3);
  assert.equal(durationToleranceFor(20), 3);
  assert.equal(durationToleranceFor(30), 3);
  assert.equal(durationToleranceFor(45), 5);
  assert.equal(durationToleranceFor(59), 6);
  assert.equal(durationToleranceFor(60), 7);
  assert.equal(durationToleranceFor(240), 7);
  assert.equal(durationToleranceFor(400), 12);
  assert.equal(durationToleranceFor(1000), 30);

  // Size window: lossless 0.25x-3x of 920 kbps (4 min: 27.6 MB), lossy 0.35x-2.5x, hi-res up to 6x.
  const flac = 920, mp3 = 320;
  assert.equal(isPlausibleTrackSize(80 * R3MB, 240, flac, { lossless: true }), true);
  assert.equal(isPlausibleTrackSize(84 * R3MB, 240, flac, { lossless: true }), false);
  assert.equal(isPlausibleTrackSize(84 * R3MB, 240, flac, { lossless: true, hiRes: true }), true);
  assert.equal(isPlausibleTrackSize(160 * R3MB, 240, flac, { lossless: true, hiRes: true }), true);
  assert.equal(isPlausibleTrackSize(170 * R3MB, 240, flac, { lossless: true, hiRes: true }), false);
  assert.equal(isPlausibleTrackSize(7 * R3MB, 240, flac, { lossless: true }), true);
  assert.equal(isPlausibleTrackSize(6 * R3MB, 240, flac, { lossless: true }), false);
  assert.equal(isPlausibleTrackSize(23 * R3MB, 240, mp3, { lossless: false }), true);
  assert.equal(isPlausibleTrackSize(25 * R3MB, 240, mp3, { lossless: false }), false);
  assert.equal(isPlausibleTrackSize(3.3 * R3MB, 240, mp3, { lossless: false }), false);
  assert.equal(isPlausibleTrackSize(3.5 * R3MB, 240, mp3, { lossless: false }), true);
  // Under 45 s: 1.5 MB on the upper bound, the ratio is the same. A 20 s FLAC is 2.3 MB typical.
  assert.equal(isPlausibleTrackSize(8 * R3MB, 20, flac, { lossless: true }), true);
  assert.equal(isPlausibleTrackSize(9 * R3MB, 20, flac, { lossless: true }), false);
  assert.equal(isPlausibleTrackSize(0.5 * R3MB, 20, flac, { lossless: true }), false, "the lower bound has no allowance");
  assert.equal(isPlausibleTrackSize(0, 20, flac), true, "unknown size passes");
  assert.equal(isPlausibleTrackSize(9 * R3MB, 0, flac), true, "unknown length passes");

  // A 20 s "Intro" does not take a 9 MB "Intro.flac" out of a 300-file dump.
  const album = r3Album(["Intro", "Other"], { dur: 240 });
  album.tracks[0].durationSec = 20;
  const dump = (introSize: number, name = "Dump/Intro.flac") =>
    Array.from({ length: 300 }, (_, i) => ({ index: i, path: i === 150 ? name : `Dump/Filler ${i}.flac`, size: i === 150 ? introSize : 30 * R3MB }));
  assert.equal(Boolean(matchTracksInRelease(album, "Dump", dump(9 * R3MB, "Coldplay - Intro.flac"), "flac_preferred").tracks["t0"]), false, "oversized");
  assert.equal(Boolean(matchTracksInRelease(album, "Dump", dump(2.5 * R3MB, "Coldplay - Intro.flac"), "flac_preferred").tracks["t0"]), true, "right size, artist named");
  // Hi-res release: the same file is possible.
  assert.equal(Boolean(matchTracksInRelease(album, "Coldplay - Dump [FLAC 24-96]", dump(9 * R3MB, "Coldplay - Intro.flac"), "flac_preferred").tracks["t0"]), true, "a release labelled hi-res may hold up to 6x");
});

test("defect 3: a generic title matches in a partial release only with its number or a named artist/album", () => {
  const album = r3Album(["Intro", "Song Two", "Song Three", "Outro"], { albumTitle: "Ghost Stories" });
  for (const i of [0, 1, 3]) album.tracks[i].durationSec = 60;
  const dump = (name: string, n = 40) => [{ index: 0, path: name, size: 6 * R3MB }, ...Array.from({ length: n }, (_, i) => ({ index: i + 1, path: `Filler ${i}.flac`, size: 30 * R3MB }))];
  const serves = (name: string, track = "t0") => Boolean(matchTracksInRelease(album, "Misc Dump", dump(name), "flac_preferred").tracks[track]);
  assert.equal(serves("Intro.flac"), false, "bare title in a dump");
  assert.equal(serves("Some Folder - Intro.flac"), false, "foreign text before it (rule 2)");
  assert.equal(serves("07 Intro.flac"), false, "a number that is not the track's");
  assert.equal(serves("01 Intro.flac"), true, "the number agrees");
  assert.equal(serves("Coldplay - Intro.flac"), true, "artist named");
  assert.equal(serves("Ghost Stories - Intro.flac"), true, "album named");
  assert.equal(serves("Outro.flac", "t3"), false);
  assert.equal(serves("04 Outro.flac", "t3"), true);
  // A whole-album match is unchanged.
  const whole = [{ index: 0, path: "Intro.flac", size: 6 * R3MB }, { index: 1, path: "Song Two.flac", size: 6 * R3MB }, { index: 2, path: "Song Three.flac", size: 30 * R3MB }, { index: 3, path: "Outro.flac", size: 6 * R3MB }];
  const res = matchTracksInRelease(album, "Coldplay - Ghost Stories [FLAC]", whole, "flac_preferred");
  assert.equal(res.partial, false);
  assert.ok(res.tracks["t0"] && res.tracks["t3"]);
  // Generic words are never matched to another song, and a specific title is not held back.
  assert.equal(serves("Song Two.flac", "t1"), true);
});

test("defect 4: credit and version notes, and hyphens inside words", () => {
  const Q = ["Song (feat. Drake Remix).flac", "Song (feat. X Live).flac", "Song (From Live at Wembley).flac", "Song (New Version).flac", "Song (Special Version).flac", "Song (With Orchestra).flac",
    "Song (Single Version).flac", "Song (Clean Version).flac", "Song (Early Version).flac", "Song (Late Version).flac", "Song (Alternate Version).flac", "Song (ft. Y Acoustic).flac",
    "Song (with X) (Live).flac", "Song feat. X Remix.flac", "Song feat. X (Live).flac", "Song (Mono Version).flac", "Song (Version 2).flac"];
  for (const f of Q) {
    assert.equal(r3ServesInDump(f, "Song"), false, `${f} must not serve "Song"`);
    assert.equal(r3Serves(`05 ${f}`, "Song"), false, `05 ${f}`);
  }
  // Credits, sources, standard versions: harmless.
  const B = ["Song (feat. X & Z).flac", "Song (feat. Jay-Z).flac", "Song (with Y).flac", "Song (From the Motion Picture X).flac", "Song (From \"X\" Soundtrack).flac",
    "Song (Album Version).flac", "Song (Original Version).flac", "Song (Explicit Version).flac", "Song (Remastered Version).flac", "Song (Stereo Version).flac",
    "Song (2011 Remaster).flac", "Song - Remastered 2011.flac", "Song (Explicit).flac", "Song feat. X.flac", "Song ft. X.flac", "Song (Bonus Track).flac", "Song (Deluxe Edition).flac", "Song (prod. by Z).flac"];
  for (const f of B) assert.equal(r3ServesInDump(f, "Song"), true, `${f} serves "Song"`);
  assert.equal(r3ServesInDump("Song.flac", "Song (feat. Drake) (Album Version)"), true);
  assert.equal(r3ServesInDump("Song (feat. Drake Remix).flac", "Song (feat. Drake Remix)"), true, "the same note on both sides");
  assert.equal(r3ServesInDump("Song.flac", "Song (feat. Drake Remix)"), false);
  // isBenignTitleNote, listed.
  const benign = ["feat. X", "ft. X & Y", "featuring Jay-Z", "with Y", "prod. Z", "From the Motion Picture X", "From \"X\" Soundtrack", "Album Version", "Original Version", "Explicit Version", "Remastered Version",
    "Stereo Version", "2011 Remaster", "Remastered 2011", "Explicit", "Clean", "Bonus Track", "Deluxe Edition", "Digital Remaster", "Original Soundtrack", "LP Version"];
  const notBenign = ["feat. Drake Remix", "feat. X Live", "From Live at Wembley", "With Orchestra", "New Version", "Special Version", "Single Version", "Clean Version", "Early Version", "Late Version",
    "Alternate Version", "Version", "Version 2", "Mono Version", "Live", "Remix", "Radio Edit", "Demo", "Acoustic", "Instrumental", "with strings", "feat. DJ Mix", "prod. X (Remix)", "Taylor's Version", "Original Mix"];
  for (const n of benign) assert.equal(isBenignTitleNote(n), true, `benign: ${n}`);
  for (const n of notBenign) assert.equal(isBenignTitleNote(n), false, `not benign: ${n}`);
  for (const w of ["live", "remix", "mix", "edit", "demo", "acoustic", "instrumental", "karaoke", "version", "session", "orchestra", "orchestral", "mono", "stereo", "unplugged", "cover", "rework", "bootleg", "extended", "radio", "club", "dub", "a cappella", "acapella", "piano", "strings", "stripped", "alternate", "alt", "take", "rehearsal", "concert", "tour"]) {
    assert.equal(isBenignTitleNote(`feat. X ${w}`), false, `a credit holding "${w}"`);
  }
  // Hyphens inside a word never split a title.
  assert.deepEqual(fileTitleRuns("Spider-Man"), ["Spider-Man"]);
  assert.equal(r3ServesInDump("Spider-Man.flac", "Man"), false);
  assert.equal(r3ServesInDump("05 Time-Out.flac", "Out"), false);
  assert.equal(r3ServesInDump("05 Ex-Girlfriend.flac", "Girlfriend"), false);
  assert.equal(r3ServesInDump("Spider-Man.flac", "Spider-Man"), true);
  assert.equal(r3ServesInDump("05 Time-Out.flac", "Time-Out"), true);
  assert.equal(r3Serves("Spider-Man.flac", "Spider-Man"), true);
  // " - " (spaces) and the scene style "nn-artist-title" still split; there the title is the last segment(s).
  assert.deepEqual(fileTitleRuns("Coldplay - Atlas"), ["Coldplay - Atlas", "Atlas"]);
  assert.equal(r3ServesInDump("01-coldplay-atlas.mp3", "Atlas", { size: 9 * R3MB }), true);
  assert.equal(r3ServesInDump("01-other_artist-atlas.mp3", "Atlas", { size: 9 * R3MB }), false);
  assert.equal(r3ServesInDump("05-Time-Out.mp3", "Time-Out", { size: 9 * R3MB }), true);
  assert.equal(r3ServesInDump("05-Time-Out.mp3", "Out", { size: 9 * R3MB }), false);
  assert.equal(r3ServesInDump("05-coldplay-spider-man.mp3", "Spider-Man", { size: 9 * R3MB }), true);
  // The versions that must stay distinct.
  assert.equal(r3Serves("Money (Live).flac", "Money"), false);
  assert.equal(r3Serves("World Turning.flac", "World Turning (Early Version)"), false);
  assert.equal(r3Serves("05 - Money (2011 Remaster).flac", "Money"), true);
  assert.equal(r3Serves("05 Money - Remastered 2011.flac", "Money"), true);
  assert.equal(r3Serves("1-05 Money.flac", "Money", { trackNo: 5 }), true);
  assert.equal(r3Serves("Deja Vu (feat. Jay-Z).flac", "Deja Vu (feat. JAŸ-Z) (Album Version)"), true);
  assert.equal(r3Serves("ギルドからの招待状.flac", "ギルドからの招待状"), true);
  assert.equal(r3Serves("ทุกคืน.flac", "ทุกคืน"), true);
  assert.equal(r3Serves("Senorita.flac", "Señorita"), true);
  assert.equal(r3Serves("Señorita.flac", "Senorita"), true);
  assert.equal(r3Serves("Dont Stop.flac", "Don't Stop"), true);
  assert.equal(r3Serves("Don’t Stop.flac", "Dont Stop"), true);
  assert.equal(r3Serves("Rock and Roll.flac", "Rock & Roll"), true);
  assert.equal(r3Serves("Rock & Roll.flac", "Rock and Roll"), true);
  assert.equal(r3Serves("01 Atlas.flac", "Atlas"), true);
  assert.equal(titleSignature("Song (feat. Drake Remix)")?.sig, "song|feat drake remix");
});

test("defect 8: version notes every track carries are album-level; the release name's notes count for a recording", () => {
  const caravan = (n: string) => `${n} (feat. Van Morrison) (Concert Version)`;
  const titles = ["Caravan", "Moondance", "Brown Eyed Girl", "Gloria", "Madame George"].map(caravan);
  const live = r3Album(titles, { albumTitle: "A Night in San Francisco" });
  const files = (names: string[]) => names.map((n, i) => ({ index: i, path: `${String(i + 1).padStart(2, "0")} ${n}.flac`, size: 30 * R3MB }));
  const plain = ["Caravan", "Moondance", "Brown Eyed Girl", "Gloria", "Madame George"];
  let r = matchTracksInRelease(live, "Van Morrison - A Night in San Francisco [FLAC]", files(plain), "flac_preferred");
  assert.equal(Object.keys(r.tracks).length, 5, "files without the note serve every track");
  assert.equal(r.partial, false);
  r = matchTracksInRelease(live, "Van Morrison - A Night in San Francisco [FLAC]", files(plain.map((n) => `${n} (Concert Version)`)), "flac_preferred");
  assert.equal(Object.keys(r.tracks).length, 5, "files with the note too");
  // "(Live)" on every track.
  const liveAll = r3Album(["Alpha (Live)", "Beta (Live)", "Gamma (Live)", "Delta (Live)"]);
  r = matchTracksInRelease(liveAll, "Coldplay - Alb [FLAC]", files(["Alpha", "Beta", "Gamma", "Delta"]), "flac_preferred");
  assert.equal(Object.keys(r.tracks).length, 4);
  // A different note on a file is still a different version.
  r = matchTracksInRelease(liveAll, "Coldplay - Alb [FLAC]", files(["Alpha (Acoustic)", "Beta", "Gamma", "Delta"]), "flac_preferred");
  assert.equal(r.tracks["t0"], undefined);
  assert.ok(r.tracks["t1"]);
  // A note on only some tracks stays strict (2 of 5), and under 4 tracks nothing is album-level.
  const some = r3Album(["Alpha (Live)", "Beta (Live)", "Gamma", "Delta", "Epsilon"]);
  r = matchTracksInRelease(some, "Coldplay - Alb [FLAC]", files(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]), "flac_preferred");
  assert.equal(r.tracks["t0"], undefined);
  assert.equal(r.tracks["t1"], undefined);
  assert.ok(r.tracks["t2"]);
  const three = r3Album(["Alpha (Live)", "Beta (Live)", "Gamma (Live)"]);
  assert.equal(matchTracksInRelease(three, "Coldplay - Alb [FLAC]", files(["Alpha", "Beta", "Gamma"]), "flac_preferred").matched, false);
  // 3 of 5 is under 80 %.
  const sixty = r3Album(["Alpha (Live)", "Beta (Live)", "Gamma (Live)", "Delta", "Epsilon"]);
  assert.equal(matchTracksInRelease(sixty, "Coldplay - Alb [FLAC]", files(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]), "flac_preferred").tracks["t0"], undefined);
  // 4 of 5 is 80 %.
  const eighty = r3Album(["Alpha (Live)", "Beta (Live)", "Gamma (Live)", "Delta (Live)", "Epsilon"]);
  assert.ok(matchTracksInRelease(eighty, "Coldplay - Alb [FLAC]", files(["Alpha", "Beta", "Gamma", "Delta", "Epsilon"]), "flac_preferred").tracks["t0"]);
  // A note the release name and the album title both carry.
  const wembley = r3Album(["Alpha (Live at Wembley)", "Beta", "Gamma"], { albumTitle: "Live at Wembley" });
  r = matchTracksInRelease(wembley, "Coldplay - Live at Wembley [FLAC]", files(["Alpha", "Beta", "Gamma"]), "flac_preferred");
  assert.ok(r.tracks["t0"], "release name and album title both say it");
  const studio = r3Album(["Alpha (Live at Wembley)", "Beta", "Gamma"], { albumTitle: "Greatest Hits" });
  assert.equal(matchTracksInRelease(studio, "Coldplay - Greatest Hits [FLAC]", files(["Alpha", "Beta", "Gamma"]), "flac_preferred").tracks["t0"], undefined);
  // The recording path: a note in the song's title that the release name carries is satisfied.
  const rec = r3Album(["Alpha (Live at Wembley)"], { albumTitle: "Live at Wembley", recording: true });
  const one = (p: string, rel: string) => matchTracksInRelease(rec, rel, [{ index: 0, path: p, size: 30 * R3MB }], "flac_preferred");
  assert.ok(one("Alpha.flac", "Coldplay - Live at Wembley [FLAC]").tracks["t0"]);
  assert.equal(one("Alpha.flac", "Coldplay - Greatest Hits [FLAC]").tracks["t0"], undefined);
  assert.equal(one("Alpha (Acoustic).flac", "Coldplay - Live at Wembley [FLAC]").tracks["t0"], undefined);
  // Still strict on the plain cases the reviewer listed.
  assert.equal(r3Serves("Caravan.flac", "Caravan (Live)"), false);
  assert.equal(r3Serves("Money (Live).flac", "Money"), false);
});

test("defect 9: an exclude id's hash is compared in lower case, URLs keep the case of path and query", () => {
  const hash = "ab12cd34ef56ab12cd34ef56ab12cd34ef56ab12";
  const cand = { title: "x", indexer: "i", infoHash: hash, size: 1 } as SourceCandidate;
  assert.equal(isReleaseExcluded(new Set([`kind:${hash}`]), "ih:1", cand), true);
  assert.equal(isReleaseExcluded(new Set([`kind:${hash.toUpperCase()}`]), "ih:1", cand), true);
  assert.equal(isReleaseExcluded(new Set([`kind:${hash.toUpperCase()}:file:${"AB".repeat(32)}`]), "ih:1", cand), true);
  assert.equal(isReleaseExcluded(new Set([`kind:${hash}:file:${"ab".repeat(32)}`]), "ih:1", cand), true);
  assert.equal(isReleaseExcluded(new Set([`kind:${"0".repeat(40)}`]), "ih:1", cand), false);
  const magnetCand = { title: "m", indexer: "i", magnet: `magnet:?xt=urn:btih:${hash.toUpperCase()}&dn=x`, size: 1 } as SourceCandidate;
  assert.equal(isReleaseExcluded(new Set([`kind:${hash.toUpperCase()}`]), "mg:1", magnetCand), true);
  const nzb = { title: "n", indexer: "i", nzbUrl: "https://Nzb.Test/get?id=AbC", size: 1 } as SourceCandidate;
  assert.equal(isReleaseExcluded(new Set(["kind:https://nzb.test/get?id=AbC"]), "nzb:1", nzb), true, "host case");
  assert.equal(isReleaseExcluded(new Set(["kind:HTTPS://NZB.TEST/get?id=AbC"]), "nzb:1", nzb), true, "scheme and host case");
  assert.equal(isReleaseExcluded(new Set(["kind:https://nzb.test/get?id=abc"]), "nzb:1", nzb), false, "query is case-sensitive");
  assert.equal(isReleaseExcluded(new Set(["kind:https://nzb.test/GET?id=AbC"]), "nzb:1", nzb), false, "path is case-sensitive");
});

test("defect 10: the album is resolved again once per distinct exclude set during the recording fallback", () => {
  const T = Array.from({ length: 10 }, (_, i) => `Song ${i + 1}`);
  const album = albumOf("al-700", "Test Band", "Test Album", 2001, [...T, "Bonus Song"]);
  const mb = JSON.stringify({ recordings: [{ "artist-credit": [{ name: "Test Band" }], releases: [
    { title: "Bonus Single", date: "2001", status: "Official", "track-count": 2, "release-group": { "primary-type": "Single" } },
    { title: "Other Album", date: "2003", status: "Official", "track-count": 12, "release-group": { "primary-type": "Album" } },
    { title: "Third", date: "2004", status: "Official", "track-count": 1, "release-group": { "primary-type": "Single" } },
  ] }] });
  const run = (exclude: string[] | undefined) => {
    let clock = 1_760_000_000_000;
    const cands = [1, 2, 3, 4].map((i): SourceCandidate => ({ title: `Test Band - Test Album (2001) ${i < 3 ? "FLAC" : "MP3 320"} r${i}`, indexer: "NZBgeek", nzbUrl: `https://nzb.test/r${i}`, size: 150_000_000 }));
    const { env, calls } = makeFakeHost({
      onResolve: (q) => {
        clock += q.kind === "release_files" ? 400 : 200;
        if (q.kind === "indexer_search") return { candidates: cands };
        if (q.kind === "release_files") return { candidates: [{ ...q.candidate!, files: T.map((t, i) => ({ index: i, path: `${pad2(i + 1)} ${t}.flac`, size: 30_000_000 })) }] };
        if (q.kind === "usenet_check") return usenetOk(q.candidate!);
        return { candidates: [] };
      },
    });
    env.now = () => clock;
    env.http.fetch = (req) => (req.url.includes("musicbrainz.org/ws/2/recording") ? { status: 200, body: mb } : { status: 404, body: "" });
    const cache = new KVCache(env);
    cache.set(`album_v2:${album.id}`, album, 24 * 3_600_000);
    const settings = review3Settings();
    const resolver = new AlbumResolver(env, cache, new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings), settings);
    const item = trackItemFor(album, 10);
    item.hints = { ...(item.hints || {}), isrc: "USXXX0000001" };
    let res = resolver.resolve({ item, ...(exclude ? { client: { exclude } } : {}) });
    for (let i = 0; res.pending && i < 40; i++) {
      clock += 250;
      res = resolver.resolve({ item, ...(exclude ? { client: { exclude } } : {}) });
    }
    return { res, listed: calls.filter((q) => q.kind === "release_files").length };
  };
  const plain = run(undefined);
  const excluded = run(["kind:https://nzb.test/unrelated"]);
  assert.equal(plain.res.sources.length, 0);
  assert.equal(excluded.res.sources.length, 0);
  assert.equal(excluded.listed, plain.listed, `exclude run listed ${excluded.listed}, plain ${plain.listed}`);
});

test("defect 11: a source plugin's folder without the artist needs a title that names one release", () => {
  const cand = (title: string): SourceCandidate => ({ title, indexer: "SlskSource", size: 60_000_000, pluginRelease: { plugin: "community.slsksource", id: "x" } });
  const mk = (title: string): CanonicalAlbum => ({ ...sampleDiscoveryAlbum(), title, artistName: "Daft Punk" });
  const score = (albumTitle: string, folder: string) => preScoreAlbumCandidate(cand(folder), mk(albumTitle), "flac_preferred").accepted;
  assert.equal(score("Random Access Memories", "Random Access Memories [FLAC]"), true, "distinctive title: still let through");
  assert.equal(score("Homework Sessions Unlimited", "Homework Sessions Unlimited [FLAC]"), true);
  for (const t of ["Greatest Hits", "The Best Of", "Live", "Unplugged", "Original Soundtrack", "The Collection", "Singles", "The Very Best Of", "Greatest Hits Vol. 2", "Best Of 2004", "Original Motion Picture Soundtrack", "The Essential Collection"]) {
    assert.equal(isGenericAlbumTitle(t), true, t);
    assert.equal(score(t, `${t} [FLAC]`), false, `folder "${t}" without the artist`);
  }
  assert.equal(isGenericAlbumTitle("Random Access Memories"), false);
  assert.equal(isGenericAlbumTitle("Discovery"), false);
  // With the artist in the name nothing changes.
  assert.equal(score("Greatest Hits", "Daft Punk - Greatest Hits [FLAC]"), true);
});
