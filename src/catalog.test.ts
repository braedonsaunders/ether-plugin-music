import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import type { HostEnv, HttpFetchRequest, HttpFetchResponse, KindItem } from "./types.ts";
import { createHandler } from "./index.ts";
import {
  baseTitle,
  BACKFILL_QUEUE_KEY,
  BACKFILL_TRIED_KEY,
  MAX_BACKFILL_QUEUE,
  MAX_BACKFILL_TRIED,
  MusicCatalog,
  type StubBackfillEntry,
} from "./catalog.ts";
import { KVCache } from "./kv.ts";
import { DeezerClient } from "./deezer.ts";
import { MusicBrainzClient } from "./musicbrainz.ts";
import { computeAlbumOrderIndex } from "./normalize.ts";

function makeMockCatalogHost(): {
  env: HostEnv;
  httpCalls: string[];
  advanceTime: (ms: number) => void;
} {
  const kvMap = new Map<string, string>();
  const httpCalls: string[] = [];
  let now = 1_760_000_000_000; // ~2025-10-09

  const fakeHttp = (req: HttpFetchRequest): HttpFetchResponse => {
    httpCalls.push(req.url);
    if (req.url.includes("/chart/0/playlists")) {
      return { status: 200, body: JSON.stringify({ data: [{ id: 3155776842, title: "Top Worldwide", nb_tracks: 2, fans: 878_000, picture_xl: "https://cdn.test/top-xl.jpg" }] }) };
    }
    if (req.url.endsWith("/playlist/3155776842")) {
      return { status: 200, body: JSON.stringify({ id: 3155776842, title: "Top Worldwide", description: "", nb_tracks: 2, fans: 878_000, picture_xl: "https://cdn.test/top-xl.jpg", creator: { name: "Alex - Deezer Editor" }, tracks: { data: [
        { id: 3135554, title: "Aerodynamic", duration: 212, artist: { id: 27, name: "Daft Punk" }, album: { id: 302127, title: "Discovery", cover_xl: "https://cdn.test/disc-xl.jpg" } },
        { id: 501, title: "Newcomer", duration: 180, artist: { id: 9001, name: "Someone New" }, album: { id: 7001, title: "Debut", cover_xl: "https://cdn.test/debut-xl.jpg" } },
      ] } }) };
    }
    if (req.url.includes("/artist/27/related")) {
      return { status: 200, body: JSON.stringify({ data: [
        { id: 1069, name: "Portishead", picture_xl: "https://cdn.test/ph-xl.jpg" },
        { id: 4050205, name: "Justice", picture_big: "https://cdn.test/ju-big.jpg" },
      ] }) };
    }
    if (req.url.includes("/artist/27/radio")) {
      return { status: 200, body: JSON.stringify({ data: [
        { id: 3135553, title: "One More Time", duration: 320, artist: { id: 27, name: "Daft Punk" }, album: { id: 302127, title: "Discovery" } },
        { id: 3135554, title: "Aerodynamic", duration: 212, artist: { id: 27, name: "Daft Punk" }, album: { id: 302127, title: "Discovery" } },
        { id: 999, title: "Gone", duration: 100, artist: { id: 5, name: "Missing" }, album: { id: 77, title: "Unavailable" } },
      ] }) };
    }
    if (req.url.includes("/chart/0/artists")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 27, name: "Daft Punk", nb_fan: 5_200_000, nb_album: 12, picture_xl: "https://cdn.test/dp-xl.jpg", picture_big: "https://cdn.test/dp-big.jpg" },
          ],
        }),
      };
    }
    if (req.url.includes("/chart/0/tracks")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 3135553, title: "One More Time", duration: 320, artist: { id: 27, name: "Daft Punk" }, album: { id: 302127, title: "Discovery" } },
          ],
        }),
      };
    }
    if (req.url.includes("/chart/") && req.url.includes("/tracks")) {
      return { status: 200, body: JSON.stringify({ data: [] }) };
    }
    if (req.url.includes("/editorial/")) {
      return { status: 200, body: JSON.stringify({ data: [] }) };
    }
    if (req.url.includes("/artist/27/albums")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 302129, title: "Random Access Memories (Drumless Edition)", release_date: "2023-11-17", record_type: "album", fans: 45_000 },
            { id: 302130, title: "Random Access Memories (10th Anniversary Edition)", release_date: "2023-05-12", record_type: "album", fans: 95_000 },
            { id: 302131, title: "Random Access Memories", release_date: "2013-05-17", record_type: "album", fans: 1_200_000 },
            { id: 302127, title: "Discovery", release_date: "2001-03-07", record_type: "album", fans: 345_000, cover_xl: "https://cdn.test/disc-xl.jpg" },
            { id: 302128, title: "Discovery (Deluxe Edition)", release_date: "2001-03-07", record_type: "album", fans: 12_000 },
          ],
        }),
      };
    }
    if (req.url.endsWith("/album/302131")) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 302131,
          title: "Random Access Memories",
          label: "Columbia",
          release_date: "2013-05-17",
          record_type: "album",
          nb_tracks: 1,
          duration: 369,
          fans: 1_200_000,
          cover_xl: "https://cdn.test/ram-xl.jpg",
          genres: { data: [{ id: 106, name: "Electro" }] },
          artist: { id: 27, name: "Daft Punk" },
          tracks: {
            data: [{ id: 67238735, title: "Get Lucky", duration: 369, rank: 950_000, explicit_lyrics: false, artist: { id: 27, name: "Daft Punk" } }],
          },
        }),
      };
    }
    if (req.url.endsWith("/album/302127")) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 302127,
          title: "Discovery",
          upc: "724384960650",
          label: "Daft Life Ltd.",
          release_date: "2001-03-07",
          record_type: "album",
          nb_tracks: 2,
          duration: 532,
          fans: 345_000,
          cover_xl: "https://cdn.test/disc-xl.jpg",
          cover_big: "https://cdn.test/disc-big.jpg",
          genres: { data: [{ id: 106, name: "Electro" }] },
          artist: { id: 27, name: "Daft Punk" },
          tracks: {
            data: [
              { id: 3135553, title: "One More Time", duration: 320, rank: 900_000, explicit_lyrics: false, artist: { id: 27, name: "Daft Punk" } },
              { id: 3135554, title: "Aerodynamic", duration: 212, rank: 700_000, explicit_lyrics: false, artist: { id: 27, name: "Daft Punk" } },
            ],
          },
        }),
      };
    }
    if (req.url.includes("/search/artist")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [{ id: 27, name: "Daft Punk", nb_fan: 5_200_000, picture_xl: "https://cdn.test/dp-xl.jpg" }],
        }),
      };
    }
    if (req.url.includes("/search/album")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [{ id: 302127, title: "Discovery", release_date: "2001-03-07", artist: { id: 27, name: "Daft Punk" }, cover_xl: "https://cdn.test/disc-xl.jpg" }],
        }),
      };
    }
    if (req.url.includes("/search/track")) {
      return { status: 200, body: JSON.stringify({ data: [] }) };
    }
    if (req.url.includes("musicbrainz.org/ws/2/release-group")) {
      return {
        status: 200,
        body: JSON.stringify({
          "release-groups": [
            {
              id: "48117b90-a16e-34ca-a514-19c702df1158",
              title: "Discovery",
              "primary-type": "Album",
              "secondary-types": [],
              "first-release-date": "2001-02-26",
              "artist-credit": [{ name: "Daft Punk", artist: { id: "056e4f3e-d505-4dad-8ec1-d04f521cbb56", name: "Daft Punk" } }],
            },
          ],
        }),
      };
    }
    if (req.url.includes("lrclib.net/api/get")) {
      return {
        status: 200,
        body: JSON.stringify({
          syncedLyrics: "[00:00.00] One more time",
          plainLyrics: "One more time",
          instrumental: false,
        }),
      };
    }
    if (req.url.includes("/artist/")) {
      const m = req.url.match(/\/artist\/(\d+)/);
      const id = m ? Number(m[1]) : 999;
      return {
        status: 200,
        body: JSON.stringify({
          id,
          name: `Artist ${id}`,
          nb_fan: 100_000,
          nb_album: 5,
          picture_xl: `https://cdn.test/a-${id}.jpg`,
        }),
      };
    }
    return { status: 404, body: "" };
  };

  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => kvMap.get(k) ?? null,
      put: (k, v) => { kvMap.set(k, v); },
      delete: (k) => { kvMap.delete(k); },
      list: (prefix = "") => Array.from(kvMap.keys()).filter((k) => k.startsWith(prefix)),
    },
    http: { fetch: fakeHttp },
    settings: { get: () => ({ curatedSize: "compact", enrichMusicBrainz: true }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
  return { env, httpCalls, advanceTime: (ms) => { now += ms; } };
}

test("3-level browse walks artist -> album -> track with deduplicated editions, MusicBrainz MBIDs, and zero extra HTTP on track wave", () => {
  const { env, httpCalls } = makeMockCatalogHost();
  const handle = createHandler(env);

  // Wave 0: artists
  const r0 = handle({ method: "POST", path: "/ether/v1/kinds/music/browse", body: { level: "artist", limit: 200 } });
  assert.equal(r0.status, 200);
  const artists = (r0.body as { items: KindItem[] }).items;
  assert.ok(artists.length > 0);
  const dp = artists.find((a) => a.id === "ar-27");
  assert.ok(dp);
  assert.equal(dp!.level, "artist");
  assert.equal(dp!.parentId, undefined);
  assert.ok(dp!.art && dp!.art.length >= 2);

  // Wave 1: albums for Daft Punk (should filter Drumless Edition, dedupe Deluxe & 10th Anniversary!)
  const r1 = handle({ method: "POST", path: "/ether/v1/kinds/music/browse", body: { level: "album", parentId: "ar-27", limit: 50 } });
  assert.equal(r1.status, 200);
  const albums = (r1.body as { items: KindItem[] }).items;
  assert.equal(albums.length, 2);
  assert.deepEqual(albums.map((a) => a.id), ["al-302127", "al-302131"]);
  assert.ok(!albums.some((a) => /drumless|anniversary|deluxe/i.test(a.title)));
  assert.equal(albums[0].parentId, "ar-27");
  assert.deepEqual(albums[0].fields?.genres, ["Electronic"]);
  assert.equal(albums[0].childCount, 2);

  // Wave 2: tracks for Discovery (hits KV cache -> ZERO extra HTTP calls!)
  const callsBeforeTracks = httpCalls.length;
  const r2 = handle({ method: "POST", path: "/ether/v1/kinds/music/browse", body: { level: "track", parentId: "al-302127", limit: 50 } });
  assert.equal(r2.status, 200);
  const tracks = (r2.body as { items: KindItem[] }).items;
  assert.equal(tracks.length, 2);
  assert.equal(tracks[0].id, "tr-3135553");
  assert.equal(tracks[0].playable, true);
  assert.equal(tracks[0].parentId, "al-302127");
  assert.equal(tracks[0].fields?.duration, 320);
  assert.equal(httpCalls.length, callsBeforeTracks);
});

test("direct album lookup enriches with MusicBrainz releaseGroupMbid", () => {
  const { env } = makeMockCatalogHost();
  const handle = createHandler(env);
  const res = handle({ method: "GET", path: "/ether/v1/kinds/music/items/al-302127" });
  assert.equal(res.status, 200);
  const item = res.body as KindItem;
  assert.equal(item.id, "al-302127");
  assert.equal(item.fields?.releaseGroupMbid, "48117b90-a16e-34ca-a514-19c702df1158");
});

test("changes returns baseline cursor cleanly and never deletes live-searched/played items", () => {
  const { env } = makeMockCatalogHost();
  const handle = createHandler(env);

  const probe = handle({ method: "POST", path: "/ether/v1/kinds/music/changes", body: { since: "" } });
  assert.equal(probe.status, 200);
  const body = probe.body as { upserts: KindItem[]; deletes: string[]; nextCursor: string; complete: boolean };
  assert.equal(body.complete, true);
  assert.deepEqual(body.deletes, []);
  assert.ok(body.nextCursor.startsWith("v6-"));
});

test("live search returns parent artist + hydrated album + playable tracks", () => {
  const { env } = makeMockCatalogHost();
  const handle = createHandler(env);

  const res = handle({ method: "POST", path: "/ether/v1/kinds/music/search", body: { query: "Daft Punk Discovery", limit: 40 } });
  assert.equal(res.status, 200);
  const items = (res.body as { items: KindItem[] }).items;
  assert.ok(items.some((i) => i.id === "ar-27" && i.level === "artist"));
  assert.ok(items.some((i) => i.id === "al-302127" && i.level === "album"));
  assert.ok(items.some((i) => i.id === "tr-3135553" && i.level === "track" && i.playable));
});

test("lyrics route fetches and caches synced LRC from LRCLIB", () => {
  const { env, httpCalls } = makeMockCatalogHost();
  const handle = createHandler(env);

  const first = handle({
    method: "POST",
    path: "/ether/v1/kinds/music/lyrics",
    body: { artistName: "Daft Punk", trackTitle: "One More Time", albumTitle: "Discovery", durationSec: 320 },
  });
  assert.equal(first.status, 200);
  assert.match((first.body as any).syncedLyrics, /\[00:00\.00\]/);
  const count1 = httpCalls.length;

  // Second call hits KV cache with zero HTTP calls
  const second = handle({
    method: "POST",
    path: "/ether/v1/kinds/music/lyrics",
    body: { artistName: "Daft Punk", trackTitle: "One More Time", albumTitle: "Discovery", durationSec: 320 },
  });
  assert.equal(second.status, 200);
  assert.equal(httpCalls.length, count1);
});

test("manifest marks internal/redundant music fields as fact: false", () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const fields = manifest.ether.contributes.mediaKinds[0].fields as Array<{ key: string; fact?: boolean }>;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  for (const key of [
    "decade",
    "curation",
    "popularity",
    "artistName",
    "albumTitle",
    "disc",
    "trackCount",
    "discCount",
    "upc",
    "isrc",
    "artistMbid",
    "releaseGroupMbid",
    "releaseMbid",
    "recordingMbid",
  ]) {
    assert.equal(byKey.get(key)?.fact, false, `expected ${key} to have fact: false`);
  }
  for (const key of ["label", "country", "releaseType", "explicit"]) {
    assert.notEqual(byKey.get(key)?.fact, false, `expected ${key} to remain a human-facing fact`);
  }
});

test("computeAlbumOrderIndex orders studio albums before deluxe, EPs, live, compilations, and remixes/singles", () => {
  const studioTop = computeAlbumOrderIndex({ releaseType: "album", title: "Back To Black", fans: 259_000 });
  const studioSecond = computeAlbumOrderIndex({ releaseType: "album", title: "Lioness: Hidden Treasures", fans: 124_000 });
  const deluxe = computeAlbumOrderIndex({ releaseType: "album", title: "Back To Black (Deluxe Edition)", fans: 151_000 });
  const ep = computeAlbumOrderIndex({ releaseType: "ep", title: "Sessions EP", fans: 40_000 });
  const live = computeAlbumOrderIndex({ releaseType: "live", title: "At The BBC", fans: 18_000 });
  const comp = computeAlbumOrderIndex({ releaseType: "compilation", title: "Greatest Hits", fans: 90_000 });
  const remix = computeAlbumOrderIndex({ releaseType: "ep", title: "Rehab (Remixes & B Sides)", fans: 7_200 });
  const single = computeAlbumOrderIndex({ releaseType: "single", title: "Rehab (Remix) (Edited Version)", fans: 200 });

  assert.ok(studioTop >= 1);
  assert.ok(studioTop < studioSecond && studioSecond < deluxe && deluxe < ep && ep < live && live < comp && comp < remix && remix < single);
});

test("search for 'Back In Black' surfaces AC/DC album + hydrated artist and suppresses tribute/cover stubs", () => {
  const kvMap = new Map<string, string>();
  let now = 1_760_000_000_000;
  const fakeHttp = (req: HttpFetchRequest): HttpFetchResponse => {
    if (req.url.includes("/search/artist")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 307211, name: "Back In Black", nb_fan: 3591, nb_album: 25 },
            { id: 4209804, name: "The Back In Black DCAC Band", nb_fan: 1662, nb_album: 4 },
          ],
        }),
      };
    }
    if (req.url.includes("/search/album")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 9410100, title: "Back In Black", record_type: "album", artist: { id: 115, name: "AC/DC" } },
            { id: 80974642, title: "Rock n Roll Train (A Salute to Ac/Dc)", record_type: "single", artist: { id: 307211, name: "Back In Black" } },
            { id: 312995717, title: "Back In Black", record_type: "single", artist: { id: 9991, name: "Tony & the Kiki" } },
            { id: 119814452, title: "Back in Black", record_type: "single", artist: { id: 9992, name: "Sershen&Zaritskaya" } },
          ],
        }),
      };
    }
    if (req.url.endsWith("/album/9410100")) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 9410100,
          title: "Back In Black",
          label: "Columbia",
          release_date: "1980-07-25",
          record_type: "album",
          nb_tracks: 2,
          duration: 623,
          fans: 331_817,
          cover_xl: "https://cdn.test/bib.jpg",
          genres: { data: [{ id: 152, name: "Rock" }] },
          artist: { id: 115, name: "AC/DC" },
          tracks: {
            data: [
              { id: 92720041, title: "Hells Bells", duration: 309, rank: 871_564, artist: { id: 115, name: "AC/DC" } },
              { id: 92720046, title: "Back In Black", duration: 255, rank: 920_000, artist: { id: 115, name: "AC/DC" } },
            ],
          },
        }),
      };
    }
    if (req.url.endsWith("/artist/115")) {
      return {
        status: 200,
        body: JSON.stringify({ id: 115, name: "AC/DC", nb_fan: 9_981_367, nb_album: 25, picture_xl: "https://cdn.test/acdc.jpg" }),
      };
    }
    if (req.url.includes("/search/track")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 92720046, title: "Back In Black", duration: 255, artist: { id: 115, name: "AC/DC" }, album: { id: 9410100, title: "Back In Black" } },
            { id: 1447864142, title: "Back in Black", duration: 187, artist: { id: 8881, name: "Apollinare Rossi" }, album: { id: 247755002, title: "Back in Black" } },
            { id: 2800764522, title: "Back in Black", duration: 220, artist: { id: 8882, name: "Berceuses de TraxLab" }, album: { id: 555, title: "Musique Douce" } },
          ],
        }),
      };
    }
    return { status: 404, body: "" };
  };
  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => kvMap.get(k) ?? null,
      put: (k, v) => { kvMap.set(k, v); },
      delete: (k) => { kvMap.delete(k); },
      list: (prefix = "") => Array.from(kvMap.keys()).filter((k) => k.startsWith(prefix)),
    },
    http: { fetch: fakeHttp },
    settings: { get: () => ({ curatedSize: "compact", enrichMusicBrainz: false }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
  const handle = createHandler(env);
  const res = handle({ method: "POST", path: "/ether/v1/kinds/music/search", body: { query: "Back In Black", limit: 40 } });
  assert.equal(res.status, 200);
  const items = (res.body as { items: KindItem[] }).items;
  const acdc = items.find((i) => i.id === "ar-115");
  const bibAlbum = items.find((i) => i.id === "al-9410100");
  assert.ok(acdc, "expected AC/DC artist in search results");
  assert.ok((acdc!.rating || 0) >= 9.0, `expected hydrated AC/DC rating >= 9.0, got ${acdc!.rating}`);
  assert.ok(bibAlbum, "expected AC/DC Back In Black album in search results");
  assert.ok((bibAlbum!.index || 0) >= 1, "expected positive album index");
  assert.ok(!items.some((i) => i.id === "ar-307211"), "tribute band 'Back In Black' should be suppressed");
  assert.ok(!items.some((i) => i.id === "ar-4209804"), "DCAC tribute band should be suppressed");
  assert.ok(!items.some((i) => i.id === "al-312995717" || i.id === "al-119814452" || i.id === "al-247755002"), "cover single stubs should be suppressed");
});

test("video concerts: browse, changes v4 migration, search, getItem, and shelf coverage", () => {
  const kvMap = new Map<string, string>();
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
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
      fetch: (req) => {
        if (req.url.includes("/chart/")) return { status: 200, body: JSON.stringify({ data: [] }) };
        if (req.url.includes("/editorial/")) return { status: 200, body: JSON.stringify({ data: [] }) };
        if (req.url.includes("/artist/")) return { status: 200, body: JSON.stringify({ id: 860, name: "Pink Floyd", nb_fan: 5000000, nb_album: 30, picture_xl: "https://cdn.test/pf.jpg" }) };
        if (req.url.includes("/search/")) return { status: 200, body: JSON.stringify({ data: [] }) };
        return { status: 404, body: "" };
      },
    },
    settings: { get: () => ({ curatedSize: "standard", enrichMusicBrainz: false }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
  const handle = createHandler(env);

  // 1. /browse?level=concert&parentId=ar-860 returns Pink Floyd's video concerts cleanly.
  const pfRes = handle({
    method: "POST",
    path: "/ether/v1/kinds/music/browse",
    body: { level: "concert", parentId: "ar-860" },
  });
  assert.equal(pfRes.status, 200);
  const pfConcerts = (pfRes.body as { items: KindItem[] }).items;
  assert.ok(pfConcerts.length >= 2, `expected >= 2 Pink Floyd concerts, got ${pfConcerts.length}`);
  assert.ok(pfConcerts.every((c) => c.level === "concert" && c.playable === true && c.parentId === "ar-860"));
  assert.ok(pfConcerts.some((c) => c.id === "co-pink-floyd-pulse"));
  assert.ok(pfConcerts.some((c) => c.id === "co-pink-floyd-live-at-pompeii"));
  assert.ok(pfConcerts[0].art?.some((a) => a.role === "poster" && a.url.startsWith("https://")));
  assert.ok(typeof pfConcerts[0].fields?.venue === "string" && (pfConcerts[0].fields!.venue as string).length > 0);

  // 2. /changes from legacy v5 cursor migrates all 82 curated concerts with deletes: [] and unique release-only artwork.
  const migRes = handle({
    method: "POST",
    path: "/ether/v1/kinds/music/changes",
    body: { since: "v5-12345" },
  });
  assert.equal(migRes.status, 200);
  const migBody = migRes.body as { upserts: KindItem[]; deletes: string[]; nextCursor: string; complete: boolean };
  assert.equal(migBody.deletes.length, 0);
  assert.ok(migBody.nextCursor.startsWith("v6-"));
  const migratedConcerts = migBody.upserts.filter((i) => i.level === "concert");
  assert.equal(migratedConcerts.length, 82, `expected all 82 curated concerts in v5 migration, got ${migratedConcerts.length}`);
  const artistPhotoUrls = new Set(
    migBody.upserts
      .filter((i) => i.level === "artist")
      .flatMap((a) => (a.art || []).map((x) => x.url))
      .filter(Boolean)
  );
  const seenConcertUrls = new Map<string, string>();
  for (const c of migratedConcerts) {
    const poster = c.art?.find((a) => a.role === "poster");
    const backdrop = c.art?.find((a) => a.role === "backdrop");
    assert.ok(poster && poster.url.startsWith("https://"), `concert ${c.id} missing poster`);
    assert.equal(artistPhotoUrls.has(poster.url), false, `concert ${c.id} poster must not reuse artist photo`);
    assert.equal(seenConcertUrls.has(poster.url), false, `concert ${c.id} shares poster URL with ${seenConcertUrls.get(poster.url)}`);
    seenConcertUrls.set(poster.url, c.id);
    if (backdrop) {
      assert.equal(artistPhotoUrls.has(backdrop.url), false, `concert ${c.id} backdrop must not reuse artist photo`);
      assert.ok((backdrop.width || 0) > (backdrop.height || 0), `concert ${c.id} backdrop must be landscape`);
    }
  }
  // Portrait concert (e.g. Pink Floyd P.U.L.S.E. and AC/DC concerts) omits backdrop rather than using artist photo.
  const pulse = migratedConcerts.find((c) => c.id === "co-pink-floyd-pulse");
  assert.ok(pulse);
  assert.equal(pulse.art?.some((a) => a.role === "backdrop"), false);
  const acdc = migratedConcerts.filter((c) => c.parentId === "ar-115");
  assert.equal(acdc.length, 2);
  assert.notEqual(acdc[0].art?.[0]?.url, acdc[1].art?.[0]?.url);
  assert.ok(acdc.every((c) => !c.art?.some((a) => a.role === "backdrop")));

  // 3. /search finds curated concerts + parent artist instantaneously.
  const searchRes = handle({
    method: "POST",
    path: "/ether/v1/kinds/music/search",
    body: { query: "Stop Making Sense", limit: 20 },
  });
  assert.equal(searchRes.status, 200);
  const sItems = (searchRes.body as { items: KindItem[] }).items;
  assert.ok(sItems.some((i) => i.id === "co-talking-heads-stop-making-sense" && i.level === "concert"));
  assert.ok(sItems.some((i) => i.id === "ar-181" && i.level === "artist"));

  // 4. Direct GET /items/co-talking-heads-stop-making-sense returns the concert item.
  const itemRes = handle({
    method: "GET",
    path: "/ether/v1/kinds/music/items/co-talking-heads-stop-making-sense",
  });
  assert.equal(itemRes.status, 200);
  assert.equal((itemRes.body as KindItem).level, "concert");
  assert.equal((itemRes.body as KindItem).parentId, "ar-181");
});

test("manifest declares author, license, least-privilege sources='search', and omits invalid permissions.kv", () => {
  const manifestPath = new URL("../manifest.json", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.ether.author?.name, "Ether");
  assert.equal(manifest.ether.license, "MIT");
  assert.equal(manifest.ether.permissions.sources, "search");
  assert.equal("kv" in manifest.ether.permissions, false);
});

test("stub backfill: search records stub artists/albums in bounded KV queue and same-bucket changes drains them without scanning", () => {
  const kvMap = new Map<string, string>();
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  let httpCalls = 0;

  const fakeHttp: HostEnv["http"]["fetch"] = (req) => {
    httpCalls++;
    if (req.url.includes("/search/artist")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 901, name: "Hydrated Artist", nb_fan: 500_000, nb_album: 5 },
            { id: 902, name: "Stub Artist", nb_fan: 200_000, nb_album: 3 },
          ],
        }),
      };
    }
    if (req.url.includes("/search/album")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            { id: 8001, title: "Full Album", record_type: "album", artist: { id: 901, name: "Hydrated Artist" } },
          ],
        }),
      };
    }
    if (req.url.endsWith("/album/8001")) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 8001,
          title: "Full Album",
          release_date: "2020-01-01",
          record_type: "album",
          nb_tracks: 1,
          duration: 210,
          fans: 100_000,
          artist: { id: 901, name: "Hydrated Artist" },
          tracks: { data: [{ id: 7001, title: "Track One", duration: 210, artist: { id: 901, name: "Hydrated Artist" } }] },
        }),
      };
    }
    if (req.url.includes("/artist/901/albums")) {
      return { status: 200, body: JSON.stringify({ data: [] }) };
    }
    if (req.url.endsWith("/artist/901")) {
      return { status: 200, body: JSON.stringify({ id: 901, name: "Hydrated Artist", nb_fan: 500_000, nb_album: 5 }) };
    }
    if (req.url.includes("/search/track")) {
      return { status: 200, body: JSON.stringify({ data: [] }) };
    }
    if (req.url.includes("/artist/902/albums")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [{ id: 8002, title: "Backfilled Album", record_type: "album", release_date: "2022-05-01", fans: 80_000 }],
        }),
      };
    }
    if (req.url.endsWith("/album/8002")) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 8002,
          title: "Backfilled Album",
          release_date: "2022-05-01",
          record_type: "album",
          nb_tracks: 2,
          duration: 420,
          fans: 80_000,
          artist: { id: 902, name: "Stub Artist" },
          tracks: {
            data: [
              { id: 7002, title: "Song A", duration: 200, artist: { id: 902, name: "Stub Artist" } },
              { id: 7003, title: "Song B", duration: 220, artist: { id: 902, name: "Stub Artist" } },
            ],
          },
        }),
      };
    }
    if (req.url.includes("/chart/") || req.url.includes("/editorial/")) {
      return { status: 200, body: JSON.stringify({ data: [] }) };
    }
    return { status: 404, body: "" };
  };

  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => kvMap.get(k) ?? null,
      put: (k, v) => { kvMap.set(k, v); },
      delete: (k) => { kvMap.delete(k); },
      list: (prefix = "") => Array.from(kvMap.keys()).filter((k) => k.startsWith(prefix)),
    },
    http: { fetch: fakeHttp },
    settings: { get: () => ({ curatedSize: "compact", enrichMusicBrainz: false }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
  const handle = createHandler(env);

  // 1. Live search hydrates ar-901 + al-8001, leaving ar-902 as an albumless stub -> queued in KV.
  const searchRes = handle({ method: "POST", path: "/ether/v1/kinds/music/search", body: { query: "Artist", limit: 20 } });
  assert.equal(searchRes.status, 200);
  const rawQ = kvMap.get(BACKFILL_QUEUE_KEY);
  assert.ok(rawQ, "expected stub backfill queue in KV after search");
  const queued: StubBackfillEntry[] = JSON.parse(rawQ!).v;
  assert.deepEqual(
    queued.map((e) => e.id),
    ["ar-902"],
    "only albumless stub artist ar-902 should be queued (not already-hydrated ar-901)"
  );

  // 2. Get baseline cursor and run same-bucket /changes -> drains ar-902 -> upserts al-8002 + its 2 tracks!
  const baseRes = handle({ method: "POST", path: "/ether/v1/kinds/music/changes", body: { since: "" } });
  const bucket = (baseRes.body as { nextCursor: string }).nextCursor;
  const drainRes = handle({ method: "POST", path: "/ether/v1/kinds/music/changes", body: { since: bucket } });
  assert.equal(drainRes.status, 200);
  const upserts = (drainRes.body as { upserts: KindItem[] }).upserts;
  assert.ok(upserts.some((i) => i.id === "al-8002" && i.level === "album"));
  assert.ok(upserts.some((i) => i.id === "tr-7002" && i.level === "track"));
  assert.ok(upserts.some((i) => i.id === "tr-7003" && i.level === "track"));
  assert.equal(kvMap.has(BACKFILL_QUEUE_KEY), false, "queue key should be cleared once drained");

  // 3. Subsequent same-bucket /changes with empty queue performs ZERO HTTP requests.
  const callsBeforeIdle = httpCalls;
  const idleRes = handle({ method: "POST", path: "/ether/v1/kinds/music/changes", body: { since: bucket } });
  assert.equal(idleRes.status, 200);
  assert.equal((idleRes.body as { upserts: KindItem[] }).upserts.length, 0);
  assert.equal(httpCalls, callsBeforeIdle, "same-bucket /changes with empty queue must perform zero HTTP calls");
});

test("stub backfill caps queue & tried-set sizes and propagates __ETHER_FAULT__ and abort errors", () => {
  const kvMap = new Map<string, string>();
  const now = Date.UTC(2026, 10, 22, 12, 0, 0);
  let throwKind: "none" | "fault" | "abort" = "none";

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
      fetch: () => {
        if (throwKind === "fault") {
          throw new Error('__ETHER_FAULT__{"code":"deadline_exceeded","message":"host deadline"}');
        }
        if (throwKind === "abort") {
          const e = new Error("aborted by host") as Error & { code?: string };
          e.code = "aborted";
          throw e;
        }
        return { status: 404, body: "" };
      },
    },
    settings: { get: () => ({ curatedSize: "compact", enrichMusicBrainz: false }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
  const cache = new KVCache(env);
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "compact" as const,
    enrichMusicBrainz: false,
  };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);

  // 1. Queue cap: recording 260 stub albums keeps queue <= MAX_BACKFILL_QUEUE (200).
  const manyStubs: KindItem[] = Array.from({ length: 260 }, (_, idx) => ({
    id: `al-${10000 + idx}`,
    level: "album",
    parentId: "ar-1",
    title: `Stub ${idx}`,
  }));
  catalog.recordStubsFromItems(manyStubs);
  const q = cache.get<StubBackfillEntry[]>(BACKFILL_QUEUE_KEY) || [];
  assert.equal(q.length, MAX_BACKFILL_QUEUE);
  assert.equal(q[q.length - 1].id, "al-10259");

  // 2. Tried-set cap: pre-seeding 550 tried entries and draining caps tried-set at <= MAX_BACKFILL_TRIED (400).
  const hugeTried: Record<string, number> = {};
  for (let i = 0; i < 550; i++) {
    hugeTried[`al-${50000 + i}`] = now - i * 1000;
  }
  cache.set(BACKFILL_TRIED_KEY, hugeTried, 7 * 24 * 3600 * 1000);
  cache.set(BACKFILL_QUEUE_KEY, [{ kind: "album", id: "al-99999", queuedAt: now }], 7 * 24 * 3600 * 1000);
  catalog.drainStubBackfill(10_000);
  const cappedTried = cache.get<Record<string, number>>(BACKFILL_TRIED_KEY) || {};
  assert.ok(
    Object.keys(cappedTried).length <= MAX_BACKFILL_TRIED,
    `tried set must be capped at <= ${MAX_BACKFILL_TRIED}, got ${Object.keys(cappedTried).length}`
  );

  // 3. __ETHER_FAULT__ MUST propagate out of drainStubBackfill (never swallowed by bare catch).
  cache.set(BACKFILL_QUEUE_KEY, [{ kind: "album", id: "al-88881", queuedAt: now }], 7 * 24 * 3600 * 1000);
  throwKind = "fault";
  assert.throws(() => catalog.drainStubBackfill(10_000), /__ETHER_FAULT__/);

  // 4. Abort error MUST propagate out of drainStubBackfill (never swallowed).
  cache.set(BACKFILL_QUEUE_KEY, [{ kind: "album", id: "al-88882", queuedAt: now }], 7 * 24 * 3600 * 1000);
  throwKind = "abort";
  assert.throws(() => catalog.drainStubBackfill(10_000), /aborted by host/);
});

test("container expand on open: manifest declares browse.expand.levels, artist expand fetches full discography + concerts in 1 call, and album expand hydrates tracks + metadata", () => {
  const manifestPath = new URL("../manifest.json", import.meta.url);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert.deepEqual(manifest.ether.contributes.mediaKinds[0].browse.expand.levels, ["artist", "album"]);

  const kvMap = new Map<string, string>();
  const fetchedUrls: string[] = [];
  const env: HostEnv = {
    now: () => Date.UTC(2026, 10, 22, 19, 30, 0),
    log: () => {},
    kv: {
      get: (k) => kvMap.get(k) ?? null,
      put: (k, v) => { kvMap.set(k, v); },
      delete: (k) => { kvMap.delete(k); },
      list: (p = "") => Array.from(kvMap.keys()).filter((k) => k.startsWith(p)),
    },
    http: {
      fetch: (req) => {
        fetchedUrls.push(req.url);
        if (req.url.includes("/artist/245/albums?limit=100")) {
          return {
            status: 200,
            body: JSON.stringify({
              total: 102,
              next: "https://api.deezer.com/artist/245/albums?index=100&limit=100",
              data: [
                { id: 708673, title: "Crash", record_type: "album", release_date: "1996-04-26", fans: 9791, genre_id: 152, cover_xl: "https://cdn.test/crash.jpg" },
                { id: 8247674, title: "Under The Table And Dreaming", record_type: "album", release_date: "1994-09-27", fans: 484, genre_id: 152, cover_xl: "https://cdn.test/uttd.jpg" },
                { id: 9132787, title: "Under the Table and Dreaming (Expanded Edition)", record_type: "album", release_date: "2014-11-24", fans: 1965, genre_id: 152, cover_xl: "https://cdn.test/uttd-exp.jpg" },
                { id: 438202967, title: "Walk Around The Moon", record_type: "album", release_date: "2023-05-19", fans: 323, genre_id: 152, cover_xl: "https://cdn.test/watm.jpg" },
                { id: 438206187, title: "Walk Around the Moon", record_type: "single", release_date: "2023-05-17", fans: 6, genre_id: 152, cover_xl: "https://cdn.test/watm-s.jpg" },
                { id: 1421263, title: "Live At Red Rocks 8.15.95", record_type: "album", release_date: "1997-10-28", fans: 948, genre_id: 152, cover_xl: "https://cdn.test/rr.jpg" },
                { id: 290538882, title: "Live Trax Vol. 40: Madison Square Garden (Live)", record_type: "album", release_date: "2016-12-09", fans: 250, genre_id: 152, cover_xl: "https://cdn.test/lt40.jpg" },
                { id: 594146422, title: "Live Trax Vol. 50: Hersheypark Stadium", record_type: "album", release_date: "2019-12-18", fans: 93, genre_id: 152, cover_xl: "https://cdn.test/lt50.jpg" },
                { id: 705748251, title: "Where Are You Going: The Singles", record_type: "album", release_date: "2025-02-07", fans: 135, genre_id: 152, cover_xl: "https://cdn.test/singles.jpg" },
                { id: 428637907, title: "Monsters", record_type: "single", release_date: "2025-01-27", fans: 39, genre_id: 152, cover_xl: "https://cdn.test/monsters.jpg" },
              ],
            }),
          };
        }
        if (req.url.includes("/artist/245/albums?index=100&limit=100")) {
          return {
            status: 200,
            body: JSON.stringify({
              total: 102,
              data: [
                { id: 1422036, title: "Busted Stuff", record_type: "album", release_date: "2002-07-15", fans: 1897, genre_id: 152, cover_xl: "https://cdn.test/bs.jpg" },
                // Duplicate of page 1 album should be filtered out via priorKeys.
                { id: 70867399, title: "Crash (Remastered)", record_type: "album", release_date: "2016-01-01", fans: 120, genre_id: 152, cover_xl: "https://cdn.test/crash-r.jpg" },
              ],
            }),
          };
        }
        if (req.url.endsWith("/artist/245")) {
          return {
            status: 200,
            body: JSON.stringify({
              id: 245,
              name: "Dave Matthews Band",
              nb_fan: 154042,
              nb_album: 81,
              picture_xl: "https://cdn.test/dmb.jpg",
            }),
          };
        }
        if (req.url.endsWith("/album/708673")) {
          return {
            status: 200,
            body: JSON.stringify({
              id: 708673,
              title: "Crash",
              record_type: "album",
              release_date: "1996-04-26",
              label: "RCA Records Label",
              fans: 9791,
              duration: 4126,
              nb_tracks: 2,
              cover_xl: "https://cdn.test/crash.jpg",
              artist: { id: 245, name: "Dave Matthews Band" },
              genres: { data: [{ id: 152, name: "Rock" }] },
              tracks: {
                data: [
                  { id: 111, title: "So Much to Say", duration: 246, track_position: 1, disk_number: 1, artist: { id: 245, name: "Dave Matthews Band" } },
                  { id: 112, title: "Two Step", duration: 387, track_position: 2, disk_number: 1, artist: { id: 245, name: "Dave Matthews Band" } },
                ],
              },
            }),
          };
        }
        return { status: 404, body: "" };
      },
    },
    settings: { get: () => ({ curatedSize: "compact", enrichMusicBrainz: false }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };

  const handle = createHandler(env);

  // 1. Artist container expand page 1: returns refreshed artist (NO nb_album childCount!) + deduplicated discography + cursor "100".
  const p1Res = handle({
    method: "POST",
    path: "/ether/v1/kinds/music/expand",
    body: { parentId: "ar-245", level: "artist", cursor: "" },
  });
  assert.equal(p1Res.status, 200);
  const p1 = p1Res.body as { items: KindItem[]; cursor: string };
  assert.equal(p1.cursor, "100");
  // Must NOT make per-album /album/{id} calls during artist expand!
  assert.equal(fetchedUrls.some((u) => u.includes("/album/")), false);

  const artistItem = p1.items.find((i) => i.level === "artist");
  assert.ok(artistItem);
  assert.equal(artistItem.id, "ar-245");
  assert.equal(artistItem.childCount, undefined, "artist must never emit upstream nb_album as childCount");
  assert.deepEqual(artistItem.fields?.genres, ["Rock"]);

  const p1Albums = p1.items.filter((i) => i.level === "album");
  // Deduplicated: Crash, Under The Table (original, not Expanded), Walk Around The Moon (album, not single),
  // Live At Red Rocks, Live Trax 40, Live Trax 50, Where Are You Going (compilation), Monsters (single) = 8 unique albums.
  assert.equal(p1Albums.length, 8);
  assert.ok(p1Albums.some((a) => a.id === "al-8247674"), "prefers original Under The Table And Dreaming");
  assert.ok(!p1Albums.some((a) => a.id === "al-9132787"), "deduplicates Expanded Edition");
  assert.ok(p1Albums.some((a) => a.id === "al-438202967"), "keeps Walk Around The Moon album");
  assert.ok(!p1Albums.some((a) => a.id === "al-438206187"), "drops same-title Walk Around the Moon single");
  assert.ok(p1Albums.every((a) => a.parentId === "ar-245" && a.childCount === undefined));
  // Studio albums sort ahead of live albums, compilations, and singles.
  const crashIdx = p1Albums.find((a) => a.id === "al-708673")!.index!;
  const redRocksIdx = p1Albums.find((a) => a.id === "al-1421263")!.index!;
  const compIdx = p1Albums.find((a) => a.id === "al-705748251")!.index!;
  const singleIdx = p1Albums.find((a) => a.id === "al-428637907")!.index!;
  assert.ok(crashIdx < redRocksIdx && redRocksIdx < compIdx && compIdx < singleIdx);

  // 2. Artist container expand page 2 (background continuation): returns Busted Stuff, skips duplicate Crash (Remastered), ends with cursor "".
  const p2Res = handle({
    method: "POST",
    path: "/ether/v1/kinds/music/expand",
    body: { parentId: "ar-245", level: "artist", cursor: "100" },
  });
  assert.equal(p2Res.status, 200);
  const p2 = p2Res.body as { items: KindItem[]; cursor: string };
  assert.equal(p2.cursor, "");
  assert.equal(p2.items.length, 1);
  assert.equal(p2.items[0].id, "al-1422036");

  // 3. Album container expand: clicking Crash fetches full metadata + all tracks in 1 HTTP call.
  const callsBeforeAlbum = fetchedUrls.length;
  const albRes = handle({
    method: "POST",
    path: "/ether/v1/kinds/music/expand",
    body: { parentId: "al-708673", level: "album", cursor: "" },
  });
  assert.equal(albRes.status, 200);
  assert.equal(fetchedUrls.length - callsBeforeAlbum, 1, "standard album expand uses 1 HTTP call");
  const albBody = albRes.body as { items: KindItem[]; cursor: string };
  assert.equal(albBody.cursor, "");
  const hydratedAlbum = albBody.items.find((i) => i.level === "album");
  const tracks = albBody.items.filter((i) => i.level === "track");
  assert.ok(hydratedAlbum);
  assert.equal(hydratedAlbum.fields?.label, "RCA Records Label");
  assert.equal(hydratedAlbum.fields?.duration, 4126);
  assert.equal(tracks.length, 2);
  assert.ok(tracks.every((t) => t.parentId === "al-708673" && t.playable === true));
});

test("0.2.5: bulky Deezer album/discography/search responses stay memory-only in KV and collab parent overrides skip solo albums", () => {
  const kvMap = new Map<string, string>();
  const now = Date.UTC(2026, 10, 23, 12, 0, 0);

  const fakeHttp: HostEnv["http"]["fetch"] = (req) => {
    if (req.url.includes("/artist/27/albums")) {
      return {
        status: 200,
        body: JSON.stringify({
          data: [
            {
              id: 302127,
              title: "Discovery",
              release_date: "2001-03-07",
              record_type: "album",
              cover_xl: "https://cdn-images.dzcdn.net/images/cover/disc/1000x1000.jpg",
              md5_image: "unused_bloat_md5",
              link: "https://www.deezer.com/album/302127",
              artist: { id: 27, name: "Daft Punk" },
            },
            {
              id: 302999,
              title: "Split Collab LP",
              release_date: "2010-05-01",
              record_type: "album",
              cover_xl: "https://cdn-images.dzcdn.net/images/cover/collab/1000x1000.jpg",
              artist: { id: 999, name: "Collaborator" },
            },
          ],
          total: 2,
        }),
      };
    }
    if (req.url.includes("/artist/27")) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 27,
          name: "Daft Punk",
          nb_fan: 5_000_000,
          picture_xl: "https://cdn-images.dzcdn.net/images/artist/dp/1000x1000.jpg",
          picture_small: "https://unused.example/s.jpg",
          tracklist: "https://api.deezer.com/artist/27/top",
        }),
      };
    }
    if (req.url.includes("/album/302127")) {
      return {
        status: 200,
        body: JSON.stringify({
          id: 302127,
          title: "Discovery",
          release_date: "2001-03-07",
          record_type: "album",
          nb_tracks: 1,
          duration: 320,
          fans: 1_500_000,
          artist: { id: 27, name: "Daft Punk" },
          tracks: {
            data: [{ id: 3135556, title: "One More Time", duration: 320, artist: { id: 27, name: "Daft Punk" } }],
          },
        }),
      };
    }
    if (req.url.includes("/search/")) {
      return { status: 200, body: JSON.stringify({ data: [] }) };
    }
    return { status: 404, body: "" };
  };

  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => kvMap.get(k) ?? null,
      put: (k, v) => { kvMap.set(k, v); },
      delete: (k) => { kvMap.delete(k); },
      list: (prefix = "") => Array.from(kvMap.keys()).filter((k) => k.startsWith(prefix)),
    },
    http: { fetch: fakeHttp },
    settings: { get: () => ({ curatedSize: "compact", enrichMusicBrainz: false }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
  const handle = createHandler(env);

  handle({ method: "POST", path: "/ether/v1/kinds/music/expand", body: { parentId: "ar-27", level: "artist", cursor: "" } });
  handle({ method: "POST", path: "/ether/v1/kinds/music/expand", body: { parentId: "al-302127", level: "album", cursor: "" } });
  handle({ method: "POST", path: "/ether/v1/kinds/music/search", body: { query: "Daft Punk", limit: 10 } });

  const keys = Array.from(kvMap.keys());
  assert.ok(!keys.some((k) => k.startsWith("dz:album:")), "raw dz:album:* must NOT be persisted in KV");
  assert.ok(!keys.some((k) => k.includes(":albums:p:")), "paginated dz:artist:*:albums:p:* must NOT be persisted in KV");
  assert.ok(!keys.some((k) => k.startsWith("dz:search:")), "ephemeral dz:search:* must NOT be persisted in KV");

  const rawArtist = kvMap.get("dz:artist:27");
  assert.ok(rawArtist, "slimmed dz:artist:27 should still be persisted");
  assert.ok(!rawArtist!.includes("picture_small") && !rawArtist!.includes("tracklist"), "slimArtist must strip redundant URLs");

  const rawParentMap = kvMap.get("exp:alb_parent:v1");
  assert.ok(rawParentMap, "collab album parent override should be recorded");
  const parentMap = JSON.parse(rawParentMap!).v as Record<string, number>;
  assert.equal(parentMap["302999"], 27, "collab album should record artist override");
  assert.equal(parentMap["302127"], undefined, "solo album owned by artist must not bloat exp:alb_parent:v1");
});

test("related: similar artists and a radio continuation that brings its albums", () => {
  const { env } = makeMockCatalogHost();
  const handle = createHandler(env);
  const similar = handle({ method: "POST", path: "/ether/v1/kinds/music/related", body: { item: { id: "ar-27", level: "artist" }, purpose: "similar", limit: 10 } });
  assert.equal(similar.status, 200);
  const sim = similar.body as { label: string; items: KindItem[] };
  assert.equal(sim.label, "Fans also like");
  assert.deepEqual(sim.items.map((a) => a.id), ["ar-1069", "ar-4050205"]);
  assert.ok(sim.items.every((a) => a.level === "artist" && a.art && a.art.length > 0));

  // From a track: radio by its artist, the seed track left out, unloadable albums skipped.
  const next = handle({ method: "POST", path: "/ether/v1/kinds/music/related", body: { item: { id: "tr-3135553", level: "track", hints: { deezerArtistId: 27 } }, purpose: "continuation", limit: 10 } });
  assert.equal(next.status, 200);
  const cont = next.body as { items: KindItem[]; order: string[] };
  assert.deepEqual(cont.order, ["tr-3135554"]);
  assert.ok(cont.items.some((i) => i.id === "al-302127" && i.level === "album"));
  assert.ok(cont.items.some((i) => i.id === "tr-3135554" && i.playable));
});

test("playlist level: an editorial playlist with its members and the albums and artists they need", () => {
  const { env } = makeMockCatalogHost();
  const handle = createHandler(env);
  // Discovery is canonical in the cache once its album has been read.
  handle({ method: "POST", path: "/ether/v1/kinds/music/browse", body: { level: "track", parentId: "al-302127", limit: 50 } });
  const res = handle({ method: "POST", path: "/ether/v1/kinds/music/browse", body: { level: "playlist", limit: 200 } });
  assert.equal(res.status, 200);
  const items = (res.body as { items: KindItem[] }).items;
  const playlist = items[items.length - 1] as KindItem & { members: string[] };
  assert.equal(playlist.level, "playlist");
  assert.equal(playlist.id, "pl-3155776842");
  assert.equal(playlist.parentId, undefined);
  assert.deepEqual(playlist.members, ["tr-3135554", "tr-501"]);
  // Parents come before what they parent; the unknown album is described by the playlist.
  const at = (id: string) => items.findIndex((i) => i.id === id);
  assert.ok(at("ar-9001") >= 0 && at("ar-9001") < at("al-7001") && at("al-7001") < at("tr-501"));
  assert.ok(at("al-302127") >= 0 && at("al-302127") < at("tr-3135554"));
  assert.equal(items.find((i) => i.id === "tr-501")?.playable, true);
});

test("changes brings in chart playlists once per bucket, even mid-bucket after an upgrade", () => {
  const { env } = makeMockCatalogHost();
  const handle = createHandler(env);
  const probe = handle({ method: "POST", path: "/ether/v1/kinds/music/changes", body: { since: "" } });
  const bucket = (probe.body as { nextCursor: string }).nextCursor;
  const first = handle({ method: "POST", path: "/ether/v1/kinds/music/changes", body: { since: bucket } });
  const ups = (first.body as { upserts: KindItem[] }).upserts;
  const playlist = ups.find((i) => i.id === "pl-3155776842") as KindItem & { members: string[] };
  assert.ok(playlist && playlist.level === "playlist");
  assert.deepEqual(playlist.members, ["tr-3135554", "tr-501"]);
  assert.ok(ups.findIndex((i) => i.id === "tr-501") < ups.findIndex((i) => i.id === "pl-3155776842"));
  const again = handle({ method: "POST", path: "/ether/v1/kinds/music/changes", body: { since: bucket } });
  assert.ok(!(again.body as { upserts: KindItem[] }).upserts.some((i) => i.level === "playlist"));
});

test("an artist expand never stores a placeholder name when Deezer's artist lookup fails", () => {
  const { env } = makeMockCatalogHost();
  const fetch = env.http.fetch;
  const failing: HostEnv = { ...env, http: { ...env.http, fetch: (req) => (/\/artist\/\d+(\?|$)/.test(req.url) ? { status: 500, body: "" } : fetch(req)) } };
  const handle = createHandler(failing);
  const res = handle({ method: "POST", path: "/ether/v1/kinds/music/expand", body: { parentId: "ar-27", level: "artist", cursor: "" } });
  assert.equal(res.status, 200);
  const items = (res.body as { items: KindItem[] }).items;
  assert.ok(items.length > 0);
  assert.ok(!items.some((i) => /^Artist \d+$/.test(i.title)));
});

test("tracks carry their recording identity from the ISRC", async () => {
  const { recordingOf } = await import("./catalog.ts");
  assert.equal(recordingOf("gbduw0000053"), "isrc:GBDUW0000053");
  assert.equal(recordingOf("GB-DUW-00-00053"), "isrc:GBDUW0000053");
  assert.equal(recordingOf(""), undefined);
  assert.equal(recordingOf("not-an-isrc"), undefined);
});

function importHost(routes: Record<string, unknown>): HostEnv {
  const kv = new Map<string, string>();
  return {
    now: () => 1_760_000_000_000,
    log: () => {},
    kv: { get: (k) => kv.get(k) ?? null, put: (k, v) => { kv.set(k, v); }, delete: (k) => { kv.delete(k); }, list: (p = "") => [...kv.keys()].filter((k) => k.startsWith(p)) },
    http: {
      fetch: (req) => {
        for (const [frag, body] of Object.entries(routes)) {
          if (req.url.includes(frag)) return { status: 200, body: typeof body === "string" ? body : JSON.stringify(body) };
        }
        return { status: 404, body: "" };
      },
    },
    settings: { get: () => ({ curatedSize: "compact", enrichMusicBrainz: false }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
}

const dzTrack = (id: number, title: string, isrc: string, albumId: number, albumTitle: string, duration = 320) =>
  ({ id, title, isrc, duration, artist: { id: 27, name: "Daft Punk" }, album: { id: albumId, title: albumTitle, cover_xl: "https://cdn.test/c.jpg" } });

test("import reads Deezer playlist links; other links are not ours", () => {
  const handle = createHandler(importHost({
    "/playlist/908622995/tracks": { data: [dzTrack(3135556, "One More Time", "GBDUW0000053", 302127, "Discovery")], total: 1 },
    "/playlist/908622995": { id: 908622995, title: "Road Trip", description: "Driving", nb_tracks: 3, tracks: { data: [] } },
  }));
  const dz = handle({ method: "POST", path: "/ether/v1/kinds/music/import", body: { url: "https://www.deezer.com/en/playlist/908622995" } });
  const dzBody = dz.body as { name: string; tracks: Array<{ title: string; isrc?: string }>; total?: number; truncated?: boolean };
  assert.equal(dz.status, 200);
  assert.equal(dzBody.name, "Road Trip");
  assert.equal(dzBody.tracks[0].isrc, "GBDUW0000053");
  assert.equal(dzBody.total, 3);
  assert.equal(dzBody.truncated, true, "fewer tracks than the playlist has is reported");
  assert.equal(handle({ method: "POST", path: "/ether/v1/kinds/music/import", body: { url: "https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M" } }).status, 404);
  assert.equal(handle({ method: "POST", path: "/ether/v1/kinds/music/import", body: { url: "https://example.com/playlist/1" } }).status, 404);
});

test("identify matches by ISRC, then by artist and title; equal releases come back as candidates", () => {
  const handle = createHandler(importHost({
    "/track/isrc:GBDUW0000053": dzTrack(3135556, "One More Time", "GBDUW0000053", 302127, "Discovery"),
    "track%3A%22Digital%20Love%22": { data: [dzTrack(3135557, "Digital Love", "GBDUW0000054", 302127, "Discovery", 301)] },
    "track%3A%22Aerodynamic%22": { data: [dzTrack(3135555, "Aerodynamic", "GBDUW0000052", 302127, "Discovery", 212), dzTrack(9000001, "Aerodynamic", "GBDUW0000099", 900001, "Alive 1997", 212)] },
  }));
  const res = handle({ method: "POST", path: "/ether/v1/kinds/music/identify", body: { tracks: [
    { title: "One More Time", artist: "Daft Punk", isrc: "GBDUW0000053" },
    { title: "Digital Love", artist: "Daft Punk", durationSec: 300 },
    { title: "Aerodynamic", artist: "Daft Punk" },
    { title: "Unknown Song", artist: "Nobody" },
  ] } });
  const body = res.body as { items: KindItem[]; matches: Array<{ index: number; id?: string; by?: string; candidates?: string[] }> };
  assert.equal(res.status, 200);
  assert.deepEqual(body.matches[0], { index: 0, id: "tr-3135556", by: "isrc" });
  assert.deepEqual(body.matches[1], { index: 1, id: "tr-3135557", by: "title" });
  assert.deepEqual(body.matches[2].candidates, ["tr-3135555", "tr-9000001"]);
  assert.deepEqual(body.matches[3], { index: 3 });
  // Every matched track arrives with its album and artist, parents first.
  const at = (id: string) => body.items.findIndex((i) => i.id === id);
  assert.ok(at("ar-27") >= 0 && at("ar-27") < at("al-302127") && at("al-302127") < at("tr-3135556"));
});

test("identify picks the release a playlist means: its album, the studio take, the one people play", () => {
  const fm = { id: 158, name: "Fleetwood Mac" };
  const cp = { id: 892, name: "Coldplay" };
  const tr = (id: number, title: string, version: string, albumId: number, albumTitle: string, rank: number, isrc: string, artist = fm) =>
    ({ id, title: title + version, title_short: title, title_version: version, isrc, duration: 257, rank, artist, album: { id: albumId, title: albumTitle, cover_xl: "https://cdn.test/c.jpg" } });
  const dreams = [
    tr(1, "Dreams", " (2004 Remaster)", 11, "Rumours", 907653, "USWB10400049"),
    tr(2, "Dreams", "", 12, "Greatest Hits", 734774, "USWB18800001"),
    tr(3, "Dreams", " (2004 Remaster)", 13, "Rumours (Super Deluxe)", 656216, "USWB11300001"),
    tr(4, "Dreams", " (Sessions, Roughs & Outtakes)", 13, "Rumours (Super Deluxe)", 474333, "USWB11300002"),
    tr(5, "Dreams", " (Live at Warner Brothers Studios in Burbank, CA 5/23/97)", 14, "The Dance", 309963, "USWB19700001"),
  ];
  const landslide = [
    tr(21, "Landslide", " (Live at Warner Brothers Studios in Burbank, CA 5/23/97)", 14, "The Dance", 950000, "USWB19700002"),
    tr(22, "Landslide", "", 15, "Fleetwood Mac", 700000, "USWB17500001"),
  ];
  const handle = createHandler(importHost({
    "track%3A%22Dreams%22": { data: dreams },
    "track%3A%22Landslide%22": { data: landslide },
    "track%3A%22Yellow%22": { data: [] },
    "Coldplay%20Yellow": { data: [
      tr(31, "Yellow", "", 41, "Parachutes", 971942, "GBAYE0000351", cp),
      tr(32, "Yellow", " (Live)", 42, "Live 2012", 478612, "GBAYE1200001", cp),
    ] },
  }));
  const res = handle({ method: "POST", path: "/ether/v1/kinds/music/identify", body: { tracks: [
    { title: "Dreams", artist: "Fleetwood Mac", album: "Rumours" },
    { title: "Dreams", artist: "Fleetwood Mac" },
    { title: "Yellow", artist: "Coldplay", album: "Parachutes" },
    { title: "Landslide", artist: "Fleetwood Mac" },
    { title: "Landslide (Live)", artist: "Fleetwood Mac" },
  ] } });
  const m = (res.body as { matches: Array<{ index: number; id?: string; candidates?: string[] }> }).matches;
  assert.equal(m[0].id, "tr-1", "the album the source names, not its deluxe edition");
  assert.equal(m[1].id, "tr-1", "no album: the original album, ahead of a compilation and live takes");
  assert.equal(m[2].id, "tr-31", "a title Deezer's fielded search misses is found by a plain search");
  assert.equal(m[3].id, "tr-22", "the studio take, though the live one is played more");
  assert.equal(m[4].id, "tr-21", "a source that asks for the live take gets it");
});

test("a version tag is not part of the song title", () => {
  assert.equal(baseTitle("Landslide (Live)"), "Landslide");
  assert.equal(baseTitle("Dreams - 2004 Remaster"), "Dreams");
  assert.equal(baseTitle("Live Forever"), "Live Forever");
  assert.equal(baseTitle("Song 2 (Mono Version) [Live]"), "Song 2");
  assert.equal(baseTitle("(I Can't Get No) Satisfaction"), "(I Can't Get No) Satisfaction");
});

test("an artist whose discography Deezer did not answer is not expanded as complete", () => {
  const { env } = makeMockCatalogHost();
  const fetch = env.http.fetch;
  const failing: HostEnv = { ...env, http: { ...env.http, fetch: (req) => (/\/artist\/27\/albums/.test(req.url) ? { status: 503, body: "" } : fetch(req)) } };
  const handle = createHandler(failing);
  const res = handle({ method: "POST", path: "/ether/v1/kinds/music/expand", body: { parentId: "ar-27", level: "artist", cursor: "" } });
  assert.equal(res.status, 503);
});

// ---- Transient provider failures must not become stub albums or cached negatives ----

function makeFlakyCatalog(handler: (url: string, n: number) => HttpFetchResponse) {
  const kvMap = new Map<string, string>();
  const httpCalls: string[] = [];
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
      fetch: (req) => {
        httpCalls.push(req.url);
        return handler(req.url, httpCalls.length);
      },
    },
    settings: { get: () => ({ enrichMusicBrainz: false }) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
  const settings = {
    qualityPreference: "flac_preferred" as const,
    newznabCategories: "3000,3010,3040",
    videoQualityPreference: "uhd_preferred" as const,
    concertNewznabCategories: "2000,2040,2045,3020,5000",
    curatedSize: "compact" as const,
    enrichMusicBrainz: false,
  };
  // One KVCache per "request", as the plugin does, so the in-memory layer never hides a failure.
  const fresh = () => {
    const cache = new KVCache(env);
    return new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  };
  return { fresh, kvMap, httpCalls, advance: (ms: number) => { now += ms; } };
}

const FLAKY_ALBUM = JSON.stringify({
  id: 555, title: "Flaky", release_date: "2010-01-01", record_type: "album", nb_tracks: 2, duration: 400, fans: 10,
  artist: { id: 9, name: "Some Band" }, genres: { data: [] },
  tracks: { data: [
    { id: 1, title: "One", duration: 200, artist: { id: 9, name: "Some Band" } },
    { id: 2, title: "Two", duration: 200, artist: { id: 9, name: "Some Band" } },
  ] },
});
const FLAKY_TRACKS = JSON.stringify({ data: [
  { id: 1, title: "One", duration: 200, isrc: "GBAAA1000001", track_position: 1, artist: { id: 9, name: "Some Band" } },
  { id: 2, title: "Two", duration: 200, isrc: "GBAAA1000002", track_position: 2, artist: { id: 9, name: "Some Band" } },
] });
const isTracksUrl = (u: string) => u.includes("/album/555/tracks");
const isAlbumUrl = (u: string) => u.endsWith("/album/555");

test("defect A: one failed album fetch is retried once and the album loads; no stub is cached", () => {
  const h = makeFlakyCatalog((url, n) => {
    if (isAlbumUrl(url)) {
      if (n === 1) throw new Error("network down");
      return { status: 200, body: FLAKY_ALBUM };
    }
    return { status: 200, body: FLAKY_TRACKS };
  });
  const res = h.fresh().loadCanonicalAlbumResult(555, { requireTrackDetails: true });
  assert.equal(res.status, "ok");
  assert.equal(res.album?.tracks.length, 2);
  assert.equal(res.album?.incomplete, undefined);
  assert.equal(h.httpCalls.filter(isAlbumUrl).length, 2, "exactly one retry");
  const stored = JSON.parse(h.kvMap.get("album_v2:al-555")!);
  assert.equal(stored.v.tracks.length, 2);
});

test("defect A: 5xx on the album with no cached copy reports failed and stores nothing under the album key", () => {
  const h = makeFlakyCatalog(() => ({ status: 503, body: "" }));
  const cat = h.fresh();
  const res = cat.loadCanonicalAlbumResult(555, { requireTrackDetails: true });
  assert.equal(res.status, "failed");
  assert.equal(res.album, null);
  assert.equal(h.httpCalls.filter(isAlbumUrl).length, 2, "one retry, no more");
  assert.equal(h.kvMap.has("album_v2:al-555"), false);
  assert.equal([...h.kvMap.keys()].some((k) => k.startsWith("dz:album:")), false, "failure is not cached either");
  assert.equal(cat.loadCanonicalAlbum(555, { requireTrackDetails: true }), null);
});

test("defect A: failing track list is marked incomplete and never cached as the album", () => {
  const h = makeFlakyCatalog((url) => isTracksUrl(url) ? { status: 500, body: "" } : { status: 200, body: FLAKY_ALBUM });
  const res = h.fresh().loadCanonicalAlbumResult(555, { requireTrackDetails: true });
  assert.equal(res.status, "failed");
  assert.equal(res.album?.incomplete, true);
  assert.equal(h.kvMap.has("album_v2:al-555"), false);
  // The browse-style entry point refuses the partial album.
  assert.equal(h.fresh().loadCanonicalAlbum(555, { requireTrackDetails: true }), null);
});

test("defect A: a failed refresh serves the expired good copy instead of a stub", () => {
  let broken = false;
  const h = makeFlakyCatalog((url) => {
    if (broken) return { status: 502, body: "" };
    return isTracksUrl(url) ? { status: 200, body: FLAKY_TRACKS } : { status: 200, body: FLAKY_ALBUM };
  });
  assert.equal(h.fresh().loadCanonicalAlbumResult(555, { requireTrackDetails: true }).status, "ok");
  const before = h.kvMap.get("album_v2:al-555");
  h.advance(8 * 24 * 60 * 60 * 1000); // copy expired (TTL 7 days)
  broken = true;
  const res = h.fresh().loadCanonicalAlbumResult(555, { requireTrackDetails: true });
  assert.equal(res.status, "stale");
  assert.equal(res.album?.tracks.length, 2);
  assert.equal(res.album?.stale, true);
  assert.equal(h.kvMap.get("album_v2:al-555"), before, "stored copy untouched");
  assert.ok(h.fresh().loadCanonicalAlbum(555, { requireTrackDetails: true }), "compat entry point also serves it");
});

test("defect A: a quota answer is a failure (no retry), not an album without tracks", () => {
  const quota = JSON.stringify({ error: { type: "Exception", message: "Quota limit exceeded", code: 4 } });
  const h = makeFlakyCatalog(() => ({ status: 200, body: quota }));
  const res = h.fresh().loadCanonicalAlbumResult(555, { requireTrackDetails: true });
  assert.equal(res.status, "failed");
  assert.equal(res.album, null);
  assert.equal(h.httpCalls.length, 1, "no retry on a quota answer");
  assert.equal(h.kvMap.has("album_v2:al-555"), false);

  // Quota on the track list only: the album is incomplete, not "empty".
  const h2 = makeFlakyCatalog((url) => isTracksUrl(url) ? { status: 200, body: quota } : { status: 200, body: FLAKY_ALBUM });
  const res2 = h2.fresh().loadCanonicalAlbumResult(555, { requireTrackDetails: true });
  assert.equal(res2.status, "failed");
  assert.equal(res2.album?.incomplete, true);
  assert.equal(h2.httpCalls.filter(isTracksUrl).length, 1);
  assert.equal(h2.kvMap.has("album_v2:al-555"), false);
});

test("defect A: Deezer saying the album does not exist is not_found, a real negative", () => {
  const gone = JSON.stringify({ error: { type: "DataException", message: "no data", code: 800 } });
  const h = makeFlakyCatalog(() => ({ status: 200, body: gone }));
  const res = h.fresh().loadCanonicalAlbumResult(555, { requireTrackDetails: true });
  assert.equal(res.status, "not_found");
  assert.equal(res.album, null);
  assert.equal(h.httpCalls.length, 1);
});

test("defect A: a MusicBrainz failure does not degrade the Deezer album", () => {
  const h = makeFlakyCatalog((url) => {
    if (url.includes("musicbrainz.org")) throw new Error("mb down");
    return isTracksUrl(url) ? { status: 200, body: FLAKY_TRACKS } : { status: 200, body: FLAKY_ALBUM };
  });
  const res = h.fresh().loadCanonicalAlbumResult(555, { requireTrackDetails: true, allowMusicBrainz: true });
  assert.equal(res.status, "ok");
  assert.equal(res.album?.tracks.length, 2);
});

test("PLUGIN_VERSION matches manifest.json", async () => {
  const manifest = JSON.parse(fs.readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
  const { PLUGIN_VERSION } = await import("./index.ts");
  assert.equal(PLUGIN_VERSION, manifest.version);
});

// ---- Review 3: a bad answer from the track-list endpoint never caches a truncated album ----

function bigAlbumCatalog(tracksResp: (url: string, calls: string[]) => HttpFetchResponse, nbTracks = 60) {
  const kv = new Map<string, string>();
  const now = 1_760_000_000_000;
  const calls: string[] = [];
  const emb = Array.from({ length: 25 }, (_, i) => ({ id: 1000 + i, title: `T${i}`, duration: 200, track_position: i + 1, disk_number: 1, artist: { id: 1, name: "A" }, isrc: `X${i}` }));
  const env: HostEnv = {
    now: () => now,
    log: () => {},
    kv: {
      get: (k) => kv.get(k) ?? null,
      put: (k, v) => { kv.set(k, v); },
      delete: (k) => { kv.delete(k); },
      list: (p = "") => [...kv.keys()].filter((k) => k.startsWith(p)),
    },
    settings: { get: () => ({}) },
    sources: { resolve: () => ({}) },
    http: {
      fetch: (r) => {
        calls.push(r.url);
        if (r.url.includes("/tracks")) return tracksResp(r.url, calls);
        return { status: 200, body: JSON.stringify({ id: 5, title: "Big", nb_tracks: nbTracks, artist: { id: 1, name: "A" }, release_date: "2000-01-01", record_type: "album", tracks: { data: emb } }) };
      },
    },
  };
  const cache = new KVCache(env);
  const settings: any = { enrichMusicBrainz: false, qualityPreference: "flac_preferred" };
  const catalog = new MusicCatalog(env, cache, new DeezerClient(env, cache), new MusicBrainzClient(env, cache), settings);
  return { catalog, kv, calls };
}
const bigTracks = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ id: 2000 + from + i, title: `U${from + i}`, duration: 200, track_position: from + i + 1, disk_number: 1, artist: { id: 1, name: "A" }, isrc: `Y${from + i}` }));

test("defect 6: a track endpoint that answers 404, empty, DataException or a short page leaves the album incomplete and uncached", () => {
  const answers: Record<string, (u: string) => HttpFetchResponse> = {
    "HTTP 404": () => ({ status: 404, body: "" }),
    "empty data": () => ({ status: 200, body: JSON.stringify({ data: [], total: 0 }) }),
    "DataException 800": () => ({ status: 200, body: JSON.stringify({ error: { type: "DataException", code: 800 } }) }),
    "HTTP 500": () => ({ status: 500, body: "" }),
    "short page, same page again": () => ({ status: 200, body: JSON.stringify({ data: bigTracks(0, 30), total: 60, next: "x" }) }),
    "a second page that fails": (u) => u.includes("index=")
      ? { status: 500, body: "" }
      : { status: 200, body: JSON.stringify({ data: bigTracks(0, 30), total: 60, next: "x" }) },
    "no next, total 60, only 30": () => ({ status: 200, body: JSON.stringify({ data: bigTracks(0, 30), total: 60 }) }),
  };
  for (const [label, resp] of Object.entries(answers)) {
    const h = bigAlbumCatalog((u) => resp(u));
    const r = h.catalog.loadCanonicalAlbumResult(5, { allowMusicBrainz: true, requireTrackDetails: true });
    assert.equal(r.status, "failed", label);
    assert.equal(r.album?.incomplete, true, label);
    assert.equal(h.kv.has("album_v2:al-5"), false, `${label}: nothing cached`);
    // Asked again, the track endpoint is asked again (a bad answer is not remembered either).
    const before = h.calls.filter((u) => u.includes("/tracks")).length;
    h.catalog.loadCanonicalAlbumResult(5, { allowMusicBrainz: true, requireTrackDetails: true });
    assert.ok(h.calls.filter((u) => u.includes("/tracks")).length > before, `${label}: fetched again`);
  }
});

test("defect 6: pages are followed and a listing within one track of the stated count is a complete album", () => {
  // 150 tracks in pages of 100 and 50
  const paged = bigAlbumCatalog((u) => u.includes("index=100")
    ? { status: 200, body: JSON.stringify({ data: bigTracks(100, 50), total: 150 }) }
    : { status: 200, body: JSON.stringify({ data: bigTracks(0, 100), total: 150, next: "https://api.deezer.com/album/5/tracks?index=100" }) }, 150);
  const r = paged.catalog.loadCanonicalAlbumResult(5, { requireTrackDetails: true });
  assert.equal(r.status, "ok");
  assert.equal(r.album?.tracks.length, 150);
  assert.ok(paged.kv.has("album_v2:al-5"));

  // 59 of 60: one off is allowed (a stated count can include an unavailable track)
  const off1 = bigAlbumCatalog(() => ({ status: 200, body: JSON.stringify({ data: bigTracks(0, 59), total: 59 }) }));
  const r1 = off1.catalog.loadCanonicalAlbumResult(5, { requireTrackDetails: true });
  assert.equal(r1.status, "ok");
  assert.equal(r1.album?.tracks.length, 59);

  // 58 of 60 is not
  const off2 = bigAlbumCatalog(() => ({ status: 200, body: JSON.stringify({ data: bigTracks(0, 58), total: 58 }) }));
  assert.equal(off2.catalog.loadCanonicalAlbumResult(5, { requireTrackDetails: true }).status, "failed");

  // The whole listing in one page
  const full = bigAlbumCatalog(() => ({ status: 200, body: JSON.stringify({ data: bigTracks(0, 60), total: 60 }) }));
  const rf = full.catalog.loadCanonicalAlbumResult(5, { requireTrackDetails: true });
  assert.equal(rf.status, "ok");
  assert.equal(rf.album?.tracks.length, 60);
});
