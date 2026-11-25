import test from "node:test";
import assert from "node:assert/strict";
import type {
  CanonicalAlbum,
  HostEnv,
  KindItem,
  KindResolveRequest,
  SourceCandidate,
  SourceQuery,
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
  expandReleaseFiles,
  isStrictlyNarrowerQuery,
  isUsenetCandidate,
  matchAlbumReleaseFiles,
  matchConcertReleaseFiles,
  preScoreAlbumCandidate,
  preScoreConcertCandidate,
  searchMemoKey,
} from "./resolver.ts";
import { buildConcertItem, getCuratedConcertById } from "./concerts.ts";
import { isRejectedReleaseForRequest, parseTrackFilename } from "./normalize.ts";

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
