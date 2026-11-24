import test from "node:test";
import assert from "node:assert/strict";
import type { HostEnv, KindItem } from "./types.ts";
import { SubsonicAdapter, parseLrc, type SubsonicHost, type Playlist, type BrowseQuery } from "./subsonic.ts";

function env(): HostEnv {
  const kv = new Map<string, string>();
  return {
    now: () => 1_760_000_000_000,
    log: () => {},
    kv: {
      get: (k) => kv.get(k) ?? null,
      put: (k, v) => void kv.set(k, v),
      delete: (k) => void kv.delete(k),
      list: (p = "") => [...kv.keys()].filter((k) => k.startsWith(p)),
    },
    http: { fetch: () => ({ status: 500, headers: {}, body: "" }) },
    settings: { get: () => ({}) },
    sources: { resolve: () => ({ candidates: [] }) },
  };
}

const artist: KindItem = { id: "ar-1", level: "artist", title: "The Band", art: [{ role: "poster", url: "https://img/ar1.jpg" }] };
const album: KindItem = {
  id: "al-10",
  level: "album",
  parentId: "ar-1",
  title: "First & Last",
  year: 2001,
  released: 978307200,
  fields: { artistName: "The Band", trackCount: 2, duration: 400, genres: ["Rock"], releaseType: "album" },
  hints: { deezerArtistId: 1, artistName: "The Band" },
};
const tracks: KindItem[] = [1, 2].map((n) => ({
  id: `tr-10${n}`,
  level: "track",
  parentId: "al-10",
  index: n,
  title: `Song ${n}`,
  playable: true,
  fields: { artistName: "The Band", albumTitle: "First & Last", duration: 200, disc: 1, genres: ["Rock"] },
  hints: { deezerArtistId: 1, trackNumber: n, artistName: "The Band" },
}));

function fakeHost(stored: KindItem[]) {
  const items = new Map(stored.map((i) => [i.id, i]));
  const favs = new Set<string>();
  const plays = new Map<string, number>();
  const lists = new Map<string, string[]>();
  let nextList = 1;
  const calls: string[] = [];
  const pl = (id: string): Playlist => {
    const ids = lists.get(id);
    if (!ids) throw Object.assign(new Error("not found"), { code: "not_found" });
    return { id, title: `List ${id}`, createdAt: 1, updatedAt: 2, total: ids.length, items: ids, indexes: ids.map((_, i) => i) };
  };
  const host: SubsonicHost = {
    browse: (q: BrowseQuery) => {
      calls.push(`browse:${q.level}:${q.parentId || ""}`);
      let list = [...items.values()].filter((i) => (!q.level || i.level === q.level) && (!q.parentId || i.parentId === q.parentId));
      if (q.query) list = list.filter((i) => i.title.toLowerCase().includes(q.query!.toLowerCase()));
      return { items: list.slice(0, q.limit || 200) };
    },
    get: (ids) => ids.map((id) => items.get(id)).filter((x): x is KindItem => Boolean(x)),
    // Ether fetches a container's children from the catalogue and stores them.
    expand: (parentId) => {
      calls.push(`expand:${parentId}`);
      if (parentId === "al-10") [album, ...tracks].forEach((i) => items.set(i.id, i));
      return { pending: false };
    },
    search: (query) => {
      calls.push(`search:${query}`);
      return { found: 0 };
    },
    state: (ids) => ids.map((id) => ({ id, playCount: plays.get(id) || 0, favorite: favs.has(id) })),
    favorite: (ids, on) => ids.forEach((id) => (on ? favs.add(id) : favs.delete(id))),
    played: (id) => void plays.set(id, (plays.get(id) || 0) + 1),
    rate: () => {},
    favorites: (level) => [...favs].filter((id) => items.get(id)?.level === level).map((id) => ({ id, level, addedAt: 5 })),
    playlists: () => [...lists.keys()].map(pl),
    playlist: pl,
    playlistCreate: (title, ids) => {
      const id = String(1000 + nextList++);
      lists.set(id, ids.slice());
      return pl(id);
    },
    playlistUpdate: (id, u) => {
      let ids = lists.get(id)!.slice();
      for (const idx of (u.remove || []).slice().sort((a, b) => b - a)) ids.splice(idx, 1);
      ids = ids.concat(u.add || []);
      lists.set(id, ids);
      return pl(id);
    },
    playlistDelete: (id) => void lists.delete(id),
  };
  return { host, favs, plays, lists, calls, items };
}

const catalog = {
  lyrics: () => ({ syncedLyrics: "[00:01.50]Hello\n[00:03.00]World", source: "lrclib" as const }),
};

const viewer = { "X-Ether-Viewer": "7", "X-Ether-Viewer-Name": "Alice" };

const shared = env();

function call(h: SubsonicHost, method: string, query: Record<string, string | string[]>, headers: Record<string, string> = viewer) {
  const a = new SubsonicAdapter(h, catalog, shared, headers);
  return a.handle("GET", `/rest/${method}.view`, { f: "json", ...query });
}

function json(res: { body?: unknown }) {
  return JSON.parse(String(res.body))["subsonic-response"];
}

test("getAlbum materialises missing tracks and renders songs", () => {
  const f = fakeHost([artist, album]);
  const r = json(call(f.host, "getAlbum", { id: "al-10" }));
  assert.equal(r.status, "ok");
  assert.equal(r.openSubsonic, true);
  assert.equal(r.album.song.length, 2);
  assert.equal(r.album.song[0].id, "tr-101");
  assert.equal(r.album.song[0].artistId, "ar-1");
  assert.equal(r.album.song[0].coverArt, "al-10");
  assert.ok(f.calls.includes("expand:al-10"), "the album is opened through Ether");
});

test("XML output escapes and nests", () => {
  const f = fakeHost([artist, album, ...tracks]);
  const a = new SubsonicAdapter(f.host, catalog, env(), viewer);
  const res = a.handle("GET", "/rest/getAlbum", { id: "al-10" });
  const body = String(res.body);
  assert.match(String(res.headers?.["Content-Type"]), /text\/xml/);
  assert.match(body, /^<\?xml version="1.0" encoding="UTF-8"\?><subsonic-response xmlns="http:\/\/subsonic.org\/restapi" status="ok"/);
  assert.match(body, /<album [^>]*name="First &amp; Last"/);
  assert.match(body, /<song [^>]*id="tr-101"/);
  assert.match(body, /<genres name="Rock"\/>/);
});

test("unauthenticated requests get error 40, extensions stay public", () => {
  const f = fakeHost([]);
  const a = new SubsonicAdapter(f.host, catalog, env(), {});
  const bad = json(a.handle("GET", "/.unauthenticated/rest/ping.view", { u: "x", f: "json" }));
  assert.equal(bad.status, "failed");
  assert.equal(bad.error.code, 40);
  const ext = json(a.handle("GET", "/.unauthenticated/rest/getOpenSubsonicExtensions", { f: "json" }));
  assert.equal(ext.status, "ok");
  assert.equal(ext.openSubsonicExtensions[0].name, "songLyrics");
});

test("star, getStarred2, scrobble and playlists use the host state", () => {
  const f = fakeHost([artist, album, ...tracks]);
  assert.equal(json(call(f.host, "star", { id: ["tr-101", "tr-102"], albumId: "al-10" })).status, "ok");
  assert.deepEqual([...f.favs].sort(), ["al-10", "tr-101", "tr-102"]);
  const starred = json(call(f.host, "getStarred2", {}));
  assert.equal(starred.starred2.song.length, 2);
  assert.equal(starred.starred2.album.length, 1);

  json(call(f.host, "scrobble", { id: "tr-101" }));
  assert.equal(f.plays.get("tr-101"), 1);
  json(call(f.host, "scrobble", { id: "tr-102", submission: "false" }));
  assert.equal(f.plays.get("tr-102"), undefined);
  const np = json(call(f.host, "getNowPlaying", {}));
  assert.equal(np.nowPlaying.entry[0].id, "tr-102");
  assert.equal(np.nowPlaying.entry[0].username, "Alice");

  const created = json(call(f.host, "createPlaylist", { name: "Mix", songId: ["tr-101", "tr-102", "tr-101"] }));
  assert.equal(created.playlist.songCount, 3);
  const id = created.playlist.id;
  json(call(f.host, "updatePlaylist", { playlistId: id, songIndexToRemove: "1", songIdToAdd: "tr-102" }));
  assert.deepEqual(f.lists.get(id), ["tr-101", "tr-101", "tr-102"]);
  const lists = json(call(f.host, "getPlaylists", {}));
  assert.equal(lists.playlists.playlist[0].songCount, 3);
  json(call(f.host, "deletePlaylist", { id }));
  assert.equal(f.lists.size, 0);
});

test("stream and cover art answer host-served descriptors", () => {
  const f = fakeHost([album, ...tracks]);
  const s = call(f.host, "stream", { id: "tr-101" }) as { media?: { itemRef: string } };
  assert.equal(s.media?.itemRef, "pk:ether.music:music:tr-101");
  const c = call(f.host, "getCoverArt", { id: "al-10", size: "300" }) as { art?: { itemRef: string; role?: string } };
  assert.deepEqual(c.art, { itemRef: "pk:ether.music:music:al-10", role: "thumb" });
  const bad = json(call(f.host, "stream", { id: "al-10" }));
  assert.equal(bad.error.code, 70);
});

test("lyrics by song id are structured and synced", () => {
  const f = fakeHost([album, ...tracks]);
  const r = json(call(f.host, "getLyricsBySongId", { id: "tr-101" }));
  const l = r.lyricsList.structuredLyrics[0];
  assert.equal(l.synced, true);
  assert.deepEqual(l.line, [
    { start: 1500, value: "Hello" },
    { start: 3000, value: "World" },
  ]);
  assert.deepEqual(parseLrc("[01:02.3]x"), [{ start: 62300, value: "x" }]);
});

test("missing parameters answer error 10", () => {
  const f = fakeHost([]);
  assert.equal(json(call(f.host, "getAlbum", {})).error.code, 10);
});
