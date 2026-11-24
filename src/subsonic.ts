/**
 * Subsonic / OpenSubsonic API for the Music library (adapter key "subsonic").
 *
 * Ether mounts this adapter at /subsonic, authenticates every request with
 * the viewer's app login (query credentials u + p or t/s, which never reach
 * the plugin), applies library visibility, and calls
 * /ether/v1/frontend/subsonic/rest/<method>. Everything here reads Ether's
 * stored catalogue for that viewer through the host (kinds.browse/get), and
 * stars, plays, ratings and playlists go to Ether's shared per-viewer stores
 * (the same likes, history and playlists Vela and every other app show).
 * Media and cover art bytes never pass through the plugin: stream/download
 * answer a {media} descriptor and getCoverArt an {art} descriptor, and Ether
 * serves the bytes (with ranges) itself.
 */
import type { EtherResponse, HostEnv, KindItem, LyricsResult } from "./types.ts";
import { rethrowHostFault } from "./kv.ts";

export const SUBSONIC_PREFIX = "/ether/v1/frontend/subsonic";
const UNAUTHENTICATED = "/.unauthenticated";
const KIND = "music";
const PLUGIN_ID = "ether.music";
const API_VERSION = "1.16.1";
const SERVER_TYPE = "ether";
const FOLDER_ID = 1;
const IGNORED_ARTICLES = "The El La Los Las Le Les Die Das Der";
const MAX_BROWSE = 500;
const MAX_ARTISTS = 3000;
const NOW_PLAYING_KEY = "ss:np:v1";
const NOW_PLAYING_TTL_MS = 15 * 60 * 1000;
const CURSOR_KEY_PREFIX = "ss:cur:v1:";
const MAX_CURSORS = 64;
const LIVE_SEARCH_KEY = "ss:live:v1";
const LIVE_SEARCH_TTL_MS = 30 * 60 * 1000;
const GENRES_KEY = "ss:genres:v1";
const GENRES_TTL_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Host surface

export interface ItemState {
  id: string;
  playCount: number;
  lastPlayedAt?: number;
  favorite: boolean;
  rating?: number;
}

export interface Favorite {
  id: string;
  level: string;
  addedAt: number;
}

export interface Playlist {
  id: string;
  title: string;
  summary?: string;
  createdAt: number;
  updatedAt: number;
  total: number;
  items?: string[];
  indexes?: number[];
}

export interface BrowseQuery {
  parentId?: string;
  level?: string;
  cursor?: string;
  limit?: number;
  sort?: string;
  desc?: boolean;
  facets?: Record<string, string[]>;
  query?: string;
  total?: "none" | "cheap" | "exact";
}

export interface BrowsePage {
  items: KindItem[];
  nextCursor?: string;
  total?: number;
}

export interface SubsonicHost {
  browse(q: BrowseQuery): BrowsePage;
  get(ids: string[]): KindItem[];
  upsert(items: KindItem[]): void;
  state(ids: string[]): ItemState[];
  favorite(ids: string[], on: boolean): void;
  played(id: string): void;
  rate(id: string, rating: number): void;
  favorites(level: string, limit: number): Favorite[];
  playlists(): Playlist[];
  playlist(id: string): Playlist;
  playlistCreate(title: string, ids: string[]): Playlist;
  playlistUpdate(id: string, update: { title?: string; summary?: string; add?: string[]; remove?: number[] }): Playlist;
  playlistDelete(id: string): void;
}

/** The catalogue and lyrics operations the adapter borrows from the plugin. */
export interface SubsonicCatalog {
  expand(req: { parentId: string; level: string }): { items?: KindItem[] };
  search(query: string, limit: number): { items: KindItem[] };
  lyrics(q: { artistName: string; trackTitle: string; albumTitle?: string; durationSec?: number }): LyricsResult | null;
}

export function hostedSubsonicHost(): SubsonicHost {
  const g = (globalThis as any).ether;
  const k = g?.kinds;
  if (!k) throw new Error("ether host global is unavailable");
  return {
    browse: (q) => k.browse(KIND, q),
    get: (ids) => (ids.length ? k.get(KIND, ids) : []),
    upsert: (items) => {
      if (items.length) k.upsert(KIND, items);
    },
    state: (ids) => (ids.length ? k.state(KIND, ids) : []),
    favorite: (ids, on) => {
      if (ids.length) k.favorite(KIND, ids, on);
    },
    played: (id) => k.played(KIND, id),
    rate: (id, rating) => k.rate(KIND, id, rating),
    favorites: (level, limit) => k.favorites(KIND, { level, limit }),
    playlists: () => k.playlists(KIND),
    playlist: (id) => k.playlist(KIND, id),
    playlistCreate: (title, ids) => k.playlistCreate(KIND, title, ids),
    playlistUpdate: (id, update) => k.playlistUpdate(KIND, id, update),
    playlistDelete: (id) => k.playlistDelete(KIND, id),
  };
}

// ---------------------------------------------------------------------------
// Errors and response rendering

export const ERR_GENERIC = 0;
export const ERR_MISSING = 10;
export const ERR_AUTH = 40;
export const ERR_DENIED = 50;
export const ERR_NOT_FOUND = 70;

class SubsonicError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

type Format = "xml" | "json" | "jsonp";

interface Output {
  format: Format;
  callback: string;
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
}

function scalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/**
 * Serialize one element. Scalars on an object become attributes, objects and
 * arrays become child elements, and a "value" key becomes the element text
 * (lyrics lines). An array of scalars becomes repeated text elements.
 */
function toXml(name: string, value: unknown): string {
  if (value === undefined || value === null) return "";
  if (Array.isArray(value)) return value.map((v) => toXml(name, v)).join("");
  if (scalar(value)) return `<${name}>${xmlEscape(String(value))}</${name}>`;
  const obj = value as Record<string, unknown>;
  let attrs = "";
  let children = "";
  let text = "";
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    if (k === "value" && scalar(v)) {
      text = xmlEscape(String(v));
    } else if (scalar(v)) {
      attrs += ` ${k}="${xmlEscape(String(v))}"`;
    } else {
      children += toXml(k, v);
    }
  }
  if (!children && !text) return `<${name}${attrs}/>`;
  return `<${name}${attrs}>${text}${children}</${name}>`;
}

function stripUndefined(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripUndefined);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (x !== undefined && x !== null) out[k] = stripUndefined(x);
    }
    return out;
  }
  return v;
}

function envelope(status: "ok" | "failed", payload: Record<string, unknown>): Record<string, unknown> {
  return {
    status,
    version: API_VERSION,
    type: SERVER_TYPE,
    serverVersion: SERVER_VERSION,
    openSubsonic: true,
    ...payload,
  };
}

export let SERVER_VERSION = "0.3.0";
export function setServerVersion(v: string): void {
  SERVER_VERSION = v;
}

function render(out: Output, status: "ok" | "failed", payload: Record<string, unknown>): EtherResponse {
  const root = envelope(status, payload);
  if (out.format === "xml") {
    const inner = toXml("subsonic-response", root).replace(
      /^<subsonic-response/,
      '<subsonic-response xmlns="http://subsonic.org/restapi"'
    );
    return {
      status: 200,
      headers: { "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "no-store" },
      body: `<?xml version="1.0" encoding="UTF-8"?>${inner}`,
    };
  }
  const json = JSON.stringify({ "subsonic-response": stripUndefined(root) });
  if (out.format === "jsonp") {
    return {
      status: 200,
      headers: { "Content-Type": "application/javascript; charset=utf-8", "Cache-Control": "no-store" },
      body: `${out.callback}(${json});`,
    };
  }
  return {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: json,
  };
}

function failure(out: Output, code: number, message: string): EtherResponse {
  return render(out, "failed", { error: { code, message } });
}

// ---------------------------------------------------------------------------
// Request parameters

export class Params {
  private q: Record<string, string | string[]>;
  constructor(q: Record<string, string | string[]> | undefined) {
    this.q = q || {};
  }
  get(key: string): string {
    const v = this.q[key];
    if (Array.isArray(v)) return String(v[0] ?? "");
    return v === undefined || v === null ? "" : String(v);
  }
  all(key: string): string[] {
    const v = this.q[key];
    if (Array.isArray(v)) return v.map(String).filter((s) => s !== "");
    return v === undefined || v === null || v === "" ? [] : [String(v)];
  }
  require(key: string): string {
    const v = this.get(key);
    if (!v) throw new SubsonicError(ERR_MISSING, `Required parameter is missing: ${key}`);
    return v;
  }
  int(key: string, def: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
    const raw = this.get(key);
    if (!raw) return def;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n)) return def;
    return Math.max(min, Math.min(max, n));
  }
}

function outputOf(p: Params): Output {
  const f = p.get("f").toLowerCase();
  const callback = p.get("callback");
  if (f === "jsonp" && /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/.test(callback)) {
    return { format: "jsonp", callback };
  }
  if (f === "json") return { format: "json", callback: "" };
  return { format: "xml", callback: "" };
}

function methodOf(path: string): string {
  const last = path.split("?")[0].split("/").filter(Boolean).pop() || "";
  return last.replace(/\.view$/i, "");
}

// ---------------------------------------------------------------------------
// Entity projection

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]{0,127}$/;

function checkId(id: string): string {
  if (!ID_RE.test(id)) throw new SubsonicError(ERR_NOT_FOUND, "Item not found");
  return id;
}

function itemRef(id: string): string {
  return `pk:${PLUGIN_ID}:${KIND}:${id}`;
}

function field<T = unknown>(it: KindItem, key: string): T | undefined {
  return it.fields ? (it.fields[key] as T | undefined) : undefined;
}

function hint<T = unknown>(it: KindItem, key: string): T | undefined {
  return it.hints ? (it.hints[key] as T | undefined) : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function iso(ms: number | undefined): string | undefined {
  if (!ms || ms <= 0) return undefined;
  return new Date(ms).toISOString();
}

function releasedIso(it: KindItem): string | undefined {
  return it.released && it.released > 0 ? iso(it.released * 1000) : undefined;
}

function genresOf(it: KindItem): string[] {
  const g = field<unknown>(it, "genres");
  return Array.isArray(g) ? g.map(str).filter(Boolean) : [];
}

function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function artistIdOf(it: KindItem): string {
  if (it.level === "artist") return it.id;
  const dz = num(hint(it, "deezerArtistId"));
  if (dz > 0) return `ar-${dz}`;
  return it.level === "album" ? str(it.parentId) : "";
}

function safePath(s: string): string {
  return s.replace(/[\\/:*?"<>|]/g, "_").trim() || "Unknown";
}

function userRating(st: ItemState | undefined): number | undefined {
  if (!st || !st.rating) return undefined;
  return Math.max(1, Math.min(5, Math.round(st.rating / 2)));
}

function stateFields(st: ItemState | undefined): Record<string, unknown> {
  if (!st) return {};
  return {
    // Ether keeps when a like was added only in the favourites listing; any
    // timestamp marks the item starred for clients.
    starred: st.favorite ? new Date().toISOString() : undefined,
    playCount: st.playCount || undefined,
    played: iso(st.lastPlayedAt),
    userRating: userRating(st),
  };
}

export function songOf(it: KindItem, st?: ItemState): Record<string, unknown> {
  const artist = str(field(it, "artistName")) || str(hint(it, "trackArtistName")) || str(hint(it, "artistName"));
  const albumArtist = str(hint(it, "artistName")) || artist;
  const album = str(field(it, "albumTitle")) || str(hint(it, "albumTitle"));
  const track = num(hint(it, "trackNumber")) || it.index || 0;
  const disc = num(field(it, "disc")) || num(hint(it, "disc")) || 1;
  const duration = Math.round(num(field(it, "duration")) || num(hint(it, "durationSec")));
  const genres = genresOf(it);
  const artistId = artistIdOf(it);
  const isrc = str(field(it, "isrc"));
  const explicit = field<boolean>(it, "explicit");
  return {
    id: it.id,
    parent: it.parentId || undefined,
    isDir: false,
    title: it.title,
    album: album || undefined,
    artist: artist || undefined,
    track: track || undefined,
    year: it.year || undefined,
    genre: genres[0],
    coverArt: it.parentId || it.id,
    contentType: "audio/flac",
    suffix: "flac",
    duration: duration || undefined,
    path: `${safePath(albumArtist)}/${safePath(album)}/${String(track).padStart(2, "0")} - ${safePath(it.title)}.flac`,
    discNumber: disc,
    created: releasedIso(it),
    albumId: it.parentId || undefined,
    artistId: artistId || undefined,
    type: "music",
    mediaType: "song",
    isVideo: false,
    bpm: 0,
    comment: "",
    sortName: it.sortTitle || it.title,
    musicBrainzId: str(field(it, "recordingMbid")),
    isrc: isrc ? [isrc] : [],
    genres: genres.map((name) => ({ name })),
    artists: artistId ? [{ id: artistId, name: artist }] : [],
    displayArtist: artist,
    albumArtists: artistId ? [{ id: artistId, name: albumArtist }] : [],
    displayAlbumArtist: albumArtist,
    // Deezer's explicit flag is false for most tracks that are simply not
    // explicit, not edited "clean" versions; only flag explicit ones.
    explicitStatus: explicit === true ? "explicit" : "",
    ...stateFields(st),
  };
}

export function albumOf(it: KindItem, st?: ItemState): Record<string, unknown> {
  const artist = str(field(it, "artistName")) || str(hint(it, "artistName"));
  const artistId = artistIdOf(it);
  const genres = genresOf(it);
  const releaseType = str(field(it, "releaseType")) || str(hint(it, "releaseType"));
  const label = str(field(it, "label"));
  const songCount = num(field(it, "trackCount")) || it.childCount || it.leafCount || 0;
  const released = it.released && it.released > 0 ? new Date(it.released * 1000) : undefined;
  return {
    id: it.id,
    name: it.title,
    artist: artist || undefined,
    artistId: artistId || undefined,
    coverArt: it.id,
    songCount,
    duration: Math.round(num(field(it, "duration"))),
    created: releasedIso(it) || new Date(0).toISOString(),
    year: it.year || undefined,
    genre: genres[0],
    musicBrainzId: str(field(it, "releaseMbid")),
    genres: genres.map((name) => ({ name })),
    artists: artistId ? [{ id: artistId, name: artist }] : [],
    displayArtist: artist,
    releaseTypes: releaseType ? [capitalize(releaseType)] : [],
    isCompilation: releaseType === "compilation",
    sortName: it.sortTitle || it.title,
    recordLabels: label ? [{ name: label }] : [],
    originalReleaseDate: released
      ? { year: released.getUTCFullYear(), month: released.getUTCMonth() + 1, day: released.getUTCDate() }
      : undefined,
    explicitStatus: "",
    ...stateFields(st),
  };
}

/** A legacy (folder-style) album entry: a directory Child. */
function albumDirOf(it: KindItem, st?: ItemState): Record<string, unknown> {
  const artist = str(field(it, "artistName")) || str(hint(it, "artistName"));
  return {
    id: it.id,
    parent: it.parentId || undefined,
    isDir: true,
    title: it.title,
    name: it.title,
    album: it.title,
    artist: artist || undefined,
    year: it.year || undefined,
    genre: genresOf(it)[0],
    coverArt: it.id,
    songCount: num(field(it, "trackCount")) || it.childCount || undefined,
    duration: Math.round(num(field(it, "duration"))) || undefined,
    created: releasedIso(it),
    albumId: it.id,
    artistId: artistIdOf(it) || undefined,
    mediaType: "album",
    ...stateFields(st),
  };
}

export function artistOf(it: KindItem, st?: ItemState): Record<string, unknown> {
  const image = (it.art || []).find((a) => a.role === "poster") || (it.art || [])[0];
  return {
    id: it.id,
    name: it.title,
    coverArt: it.id,
    albumCount: it.childCount || 0,
    artistImageUrl: image?.url || undefined,
    starred: st?.favorite ? new Date().toISOString() : undefined,
    userRating: userRating(st),
    musicBrainzId: str(field(it, "artistMbid")),
    sortName: sortKey(it.title),
    roles: ["albumartist"],
  };
}

const ARTICLES = IGNORED_ARTICLES.split(" ").map((a) => a.toLowerCase());

function sortKey(name: string): string {
  const lower = name.trim();
  for (const a of ARTICLES) {
    if (lower.toLowerCase().startsWith(a + " ")) return lower.slice(a.length + 1).trim();
  }
  return lower;
}

function indexLetter(name: string): string {
  const c = sortKey(name).charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

// ---------------------------------------------------------------------------
// Adapter

export class SubsonicAdapter {
  private host: SubsonicHost;
  private catalog: SubsonicCatalog;
  private env: HostEnv;
  private viewer: string;
  private viewerName: string;

  constructor(host: SubsonicHost, catalog: SubsonicCatalog, env: HostEnv, headers: Record<string, string>) {
    this.host = host;
    this.catalog = catalog;
    this.env = env;
    const h = (name: string) => {
      for (const [k, v] of Object.entries(headers || {})) if (k.toLowerCase() === name) return String(v);
      return "";
    };
    this.viewer = h("x-ether-viewer");
    this.viewerName = h("x-ether-viewer-name");
    this.timed();
  }

  handle(method: string, subPath: string, query: Record<string, string | string[]> | undefined): EtherResponse {
    const started = this.env.now();
    const res = this.handleInner(method, subPath, query);
    const took = this.env.now() - started;
    if (took > 1500) {
      const calls = this.timings
        .sort((a, b) => b[1] - a[1])
        .slice(0, 6)
        .map(([n, ms]) => `${n}=${ms}ms`)
        .join(" ");
      this.env.log("info", `subsonic slow ${methodOf(subPath)} ${took}ms host: ${calls}`);
    }
    return res;
  }

  private timings: Array<[string, number]> = [];

  private timed(): void {
    const host = this.host as unknown as Record<string, (...a: unknown[]) => unknown>;
    const wrapped: Record<string, (...a: unknown[]) => unknown> = {};
    for (const name of Object.keys(host)) {
      const fn = host[name];
      wrapped[name] = (...args: unknown[]) => {
        const t0 = this.env.now();
        try {
          return fn(...args);
        } finally {
          this.timings.push([name, this.env.now() - t0]);
        }
      };
    }
    this.host = wrapped as unknown as SubsonicHost;
  }

  private handleInner(method: string, subPath: string, query: Record<string, string | string[]> | undefined): EtherResponse {
    const p = new Params(query);
    const out = outputOf(p);
    if (subPath.startsWith(UNAUTHENTICATED + "/") || subPath === UNAUTHENTICATED) {
      const name = methodOf(subPath.slice(UNAUTHENTICATED.length));
      if (name === "getOpenSubsonicExtensions") return render(out, "ok", this.extensions());
      if (!p.get("u")) return failure(out, ERR_MISSING, "Required parameter is missing: u");
      return failure(out, ERR_AUTH, "Wrong username or password");
    }
    if (!this.viewer) return failure(out, ERR_AUTH, "Wrong username or password");
    const name = methodOf(subPath);
    try {
      return this.dispatch(name, method, p, out);
    } catch (err) {
      rethrowHostFault(err);
      if (err instanceof SubsonicError) return failure(out, err.code, err.message);
      const code = String((err as { code?: unknown })?.code || "");
      const msg = err instanceof Error ? err.message : String(err);
      if (code === "not_found" || /not found/i.test(msg)) return failure(out, ERR_NOT_FOUND, "Item not found");
      if (code === "forbidden" || code === "permission_denied") return failure(out, ERR_DENIED, "Not authorized");
      this.env.log("warn", `subsonic ${name}: ${msg}`);
      return failure(out, ERR_GENERIC, "The server could not complete the request");
    }
  }

  private dispatch(name: string, method: string, p: Params, out: Output): EtherResponse {
    switch (name) {
      case "ping":
        return render(out, "ok", {});
      case "getLicense":
        return render(out, "ok", { license: { valid: true, email: "", licenseExpires: undefined } });
      case "getOpenSubsonicExtensions":
        return render(out, "ok", this.extensions());
      case "getMusicFolders":
        return render(out, "ok", { musicFolders: { musicFolder: [{ id: FOLDER_ID, name: "Music" }] } });
      case "getScanStatus":
        return render(out, "ok", { scanStatus: { scanning: false, count: 0 } });
      case "startScan":
        return render(out, "ok", { scanStatus: { scanning: false, count: 0 } });
      case "getUser":
        return render(out, "ok", { user: this.user(p.get("username") || p.get("u")) });
      case "getUsers":
        return render(out, "ok", { users: { user: [this.user(p.get("u"))] } });
      case "getArtists":
        return render(out, "ok", { artists: this.artistIndex() });
      case "getIndexes":
        return render(out, "ok", { indexes: { lastModified: this.env.now(), ...this.artistIndex() } });
      case "getArtist":
        return render(out, "ok", { artist: this.artist(p.require("id")) });
      case "getAlbum":
        return render(out, "ok", { album: this.album(p.require("id")) });
      case "getSong":
        return render(out, "ok", { song: this.song(p.require("id")) });
      case "getMusicDirectory":
        return render(out, "ok", { directory: this.directory(p.require("id")) });
      case "getAlbumList":
        return render(out, "ok", { albumList: { album: this.albumList(p).map((x) => albumDirOf(x.item, x.state)) } });
      case "getAlbumList2":
        return render(out, "ok", { albumList2: { album: this.albumList(p).map((x) => albumOf(x.item, x.state)) } });
      case "getRandomSongs":
        return render(out, "ok", { randomSongs: { song: this.randomSongs(p) } });
      case "getSongsByGenre":
        return render(out, "ok", { songsByGenre: { song: this.songsByGenre(p) } });
      case "getGenres":
        return render(out, "ok", { genres: { genre: this.genres() } });
      case "getTopSongs":
        return render(out, "ok", { topSongs: { song: this.topSongs(p.get("artist"), p.int("count", 50, 1, 200)) } });
      case "getSimilarSongs":
      case "getSimilarSongs2": {
        const key = name === "getSimilarSongs" ? "similarSongs" : "similarSongs2";
        return render(out, "ok", { [key]: { song: this.similarSongs(p.require("id"), p.int("count", 50, 1, 200)) } });
      }
      case "getArtistInfo":
      case "getArtistInfo2": {
        const key = name === "getArtistInfo" ? "artistInfo" : "artistInfo2";
        return render(out, "ok", { [key]: this.artistInfo(p.require("id")) });
      }
      case "getAlbumInfo":
      case "getAlbumInfo2":
        return render(out, "ok", { albumInfo: this.albumInfo(p.require("id")) });
      case "search2":
      case "search3":
        return render(out, "ok", { [name === "search2" ? "searchResult2" : "searchResult3"]: this.search(p, name === "search3") });
      case "search": {
        const r = this.search(p, true) as { song?: unknown[] };
        return render(out, "ok", { searchResult: { offset: 0, totalHits: (r.song || []).length, match: r.song || [] } });
      }
      case "getStarred":
      case "getStarred2":
        return render(out, "ok", { [name === "getStarred" ? "starred" : "starred2"]: this.starred(name === "getStarred2") });
      case "star":
      case "unstar":
        this.star(p, name === "star");
        return render(out, "ok", {});
      case "setRating": {
        const id = checkId(p.require("id"));
        const rating = p.int("rating", 0, 0, 5);
        this.host.rate(id, rating * 2);
        return render(out, "ok", {});
      }
      case "scrobble":
        this.scrobble(p);
        return render(out, "ok", {});
      case "getNowPlaying":
        return render(out, "ok", { nowPlaying: { entry: this.nowPlaying() } });
      case "getPlaylists":
        return render(out, "ok", { playlists: { playlist: this.playlists() } });
      case "getPlaylist":
        return render(out, "ok", { playlist: this.playlist(p.require("id")) });
      case "createPlaylist":
        return render(out, "ok", { playlist: this.createPlaylist(p) });
      case "updatePlaylist":
        this.updatePlaylist(p);
        return render(out, "ok", {});
      case "deletePlaylist":
        this.host.playlistDelete(p.require("id"));
        return render(out, "ok", {});
      case "getLyrics":
        return render(out, "ok", { lyrics: this.lyrics(p.get("artist"), p.get("title")) });
      case "getLyricsBySongId":
        return render(out, "ok", { lyricsList: { structuredLyrics: this.structuredLyrics(p.require("id")) } });
      case "getCoverArt":
        return this.coverArt(p);
      case "stream":
      case "download":
        if (method !== "GET" && method !== "HEAD") return failure(out, ERR_GENERIC, "Use GET");
        return { status: 200, media: { itemRef: itemRef(this.trackId(p.require("id"))) } };
      case "getPlayQueue":
        return render(out, "ok", {});
      case "getBookmarks":
        return render(out, "ok", { bookmarks: { bookmark: [] } });
      case "getInternetRadioStations":
        return render(out, "ok", { internetRadioStations: { internetRadioStation: [] } });
      case "getPodcasts":
        return render(out, "ok", { podcasts: { channel: [] } });
      case "getNewestPodcasts":
        return render(out, "ok", { newestPodcasts: { episode: [] } });
      case "getShares":
        return render(out, "ok", { shares: { share: [] } });
      case "getVideos":
        return render(out, "ok", { videos: { video: [] } });
      case "getChatMessages":
        return render(out, "ok", { chatMessages: { chatMessage: [] } });
      default:
        return failure(out, ERR_GENERIC, `Not implemented: ${name || "unknown method"}`);
    }
  }

  private extensions(): Record<string, unknown> {
    return {
      openSubsonicExtensions: [{ name: "songLyrics", versions: [1] }],
    };
  }

  private user(username: string): Record<string, unknown> {
    return {
      username: username || this.viewerName,
      email: "",
      scrobblingEnabled: true,
      adminRole: false,
      settingsRole: false,
      downloadRole: true,
      uploadRole: false,
      playlistRole: true,
      coverArtRole: true,
      commentRole: false,
      podcastRole: false,
      streamRole: true,
      jukeboxRole: false,
      shareRole: false,
      videoConversionRole: false,
      folder: [FOLDER_ID],
    };
  }

  // --- state helpers -------------------------------------------------------

  private states(items: KindItem[]): Map<string, ItemState> {
    const out = new Map<string, ItemState>();
    const ids = items.map((i) => i.id);
    for (let i = 0; i < ids.length; i += MAX_BROWSE) {
      for (const st of this.host.state(ids.slice(i, i + MAX_BROWSE)) || []) out.set(st.id, st);
    }
    return out;
  }

  private getOne(id: string, level?: string): KindItem {
    checkId(id);
    const [it] = this.host.get([id]);
    if (!it || (level && it.level !== level)) throw new SubsonicError(ERR_NOT_FOUND, "Item not found");
    return it;
  }

  private trackId(id: string): string {
    checkId(id);
    if (!id.startsWith("tr-")) throw new SubsonicError(ERR_NOT_FOUND, "Song not found");
    return id;
  }

  // --- browsing -------------------------------------------------------------

  private artistIndex(): Record<string, unknown> {
    const artists: KindItem[] = [];
    let cursor = "";
    while (artists.length < MAX_ARTISTS) {
      const page = this.host.browse({ level: "artist", sort: "title", limit: 1000, cursor, total: "none" });
      artists.push(...(page.items || []));
      if (!page.nextCursor || !(page.items || []).length) break;
      cursor = page.nextCursor;
    }
    // Starred flags come from the viewer's liked artists (one bounded call),
    // not a per-artist state lookup over the whole index.
    const liked = new Set(this.host.favorites("artist", 1000).map((f) => f.id));
    const states = new Map<string, ItemState>();
    for (const a of artists) if (liked.has(a.id)) states.set(a.id, { id: a.id, playCount: 0, favorite: true });
    const groups = new Map<string, Record<string, unknown>[]>();
    const sorted = artists.slice().sort((a, b) => sortKey(a.title).localeCompare(sortKey(b.title)));
    for (const a of sorted) {
      const letter = indexLetter(a.title);
      if (!groups.has(letter)) groups.set(letter, []);
      groups.get(letter)!.push(artistOf(a, states.get(a.id)));
    }
    const letters = [...groups.keys()].sort((a, b) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)));
    return {
      ignoredArticles: IGNORED_ARTICLES,
      index: letters.map((name) => ({ name, artist: groups.get(name) })),
    };
  }

  /** Children of a container; materialises them from the catalogue when Ether has none yet. */
  private children(parent: KindItem, level: "album" | "track"): KindItem[] {
    const q: BrowseQuery = {
      parentId: parent.id,
      level,
      sort: level === "track" ? "index" : "released",
      desc: level === "album",
      limit: MAX_BROWSE,
      total: "none",
    };
    let items = this.host.browse(q).items || [];
    const expected = level === "track" ? num(field(parent, "trackCount")) || parent.childCount || 0 : 0;
    if (items.length === 0 || (expected > 0 && items.length < expected)) {
      try {
        const expanded = this.catalog.expand({ parentId: parent.id, level: parent.level }).items || [];
        const fresh = expanded.filter((x) => x.level === "artist" || x.level === "album" || x.level === "track");
        if (fresh.length) {
          this.host.upsert(fresh);
          items = this.host.browse(q).items || [];
        }
      } catch (err) {
        rethrowHostFault(err);
        this.env.log("warn", `subsonic expand ${parent.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (level === "track") {
      items.sort((a, b) => {
        const da = num(field(a, "disc")) || 1;
        const db = num(field(b, "disc")) || 1;
        if (da !== db) return da - db;
        return (num(hint(a, "trackNumber")) || a.index || 0) - (num(hint(b, "trackNumber")) || b.index || 0);
      });
    }
    return items.filter((x) => x.level === level);
  }

  private artist(id: string): Record<string, unknown> {
    const it = this.getOne(id, "artist");
    const albums = this.children(it, "album");
    const states = this.states([it, ...albums]);
    return {
      ...artistOf(it, states.get(it.id)),
      albumCount: albums.length,
      album: albums.map((a) => albumOf(a, states.get(a.id))),
    };
  }

  private album(id: string): Record<string, unknown> {
    const it = this.getOne(id, "album");
    const tracks = this.children(it, "track");
    const states = this.states([it, ...tracks]);
    const album = albumOf(it, states.get(it.id));
    const duration = tracks.reduce((s, t) => s + Math.round(num(field(t, "duration"))), 0);
    return {
      ...album,
      songCount: tracks.length || album.songCount,
      duration: duration || album.duration,
      song: tracks.map((t) => songOf(t, states.get(t.id))),
    };
  }

  private song(id: string): Record<string, unknown> {
    const it = this.getOne(id, "track");
    const states = this.states([it]);
    return songOf(it, states.get(it.id));
  }

  private directory(id: string): Record<string, unknown> {
    if (id === String(FOLDER_ID) || id === "root") {
      const idx = this.artistIndex() as { index: Array<{ artist: Record<string, unknown>[] }> };
      const child = idx.index.flatMap((g) => g.artist).map((a) => ({ id: a.id, parent: String(FOLDER_ID), isDir: true, title: a.name, artist: a.name, coverArt: a.coverArt }));
      return { id: String(FOLDER_ID), name: "Music", child };
    }
    const it = this.getOne(id);
    if (it.level === "artist") {
      const albums = this.children(it, "album");
      const states = this.states(albums);
      return { id: it.id, parent: String(FOLDER_ID), name: it.title, child: albums.map((a) => albumDirOf(a, states.get(a.id))) };
    }
    if (it.level === "album") {
      const tracks = this.children(it, "track");
      const states = this.states(tracks);
      return {
        id: it.id,
        parent: it.parentId || undefined,
        name: it.title,
        child: tracks.map((t) => songOf(t, states.get(t.id))),
      };
    }
    throw new SubsonicError(ERR_NOT_FOUND, "Directory not found");
  }

  // --- paged lists ------------------------------------------------------------

  /**
   * Offset paging over Ether's cursor browse. Subsonic clients page by offset;
   * the next cursor for each page is remembered per viewer (a small bounded
   * map), so sequential paging never rescans from the start.
   */
  private pagedBrowse(q: BrowseQuery, offset: number, size: number): KindItem[] {
    size = Math.max(0, Math.min(size, MAX_BROWSE));
    if (size === 0) return [];
    const sig = JSON.stringify([q.level, q.parentId, q.sort, q.desc, q.facets, q.query]);
    let cursor = "";
    let at = 0;
    if (offset > 0) {
      const known = this.cursorAt(sig, offset);
      if (known) {
        cursor = known;
        at = offset;
      }
    }
    // Walk from the nearest known position, at most 10 pages.
    let walks = 0;
    while (at < offset && walks < 10) {
      const step = Math.min(MAX_BROWSE, offset - at);
      const page = this.host.browse({ ...q, cursor, limit: step, total: "none" });
      const n = (page.items || []).length;
      walks++;
      if (!page.nextCursor || n === 0) return [];
      at += n;
      cursor = page.nextCursor;
      this.rememberCursor(sig, at, cursor);
    }
    if (at < offset) return [];
    const page = this.host.browse({ ...q, cursor, limit: size, total: "none" });
    const items = page.items || [];
    if (page.nextCursor) this.rememberCursor(sig, offset + items.length, page.nextCursor);
    return items;
  }

  private cursorKey(): string {
    return CURSOR_KEY_PREFIX + this.viewer;
  }

  private cursorAt(sig: string, offset: number): string {
    try {
      const raw = this.env.kv.get(this.cursorKey());
      if (!raw) return "";
      const list = JSON.parse(raw) as Array<[string, number, string]>;
      const hit = list.find((e) => e[0] === sig && e[1] === offset);
      return hit ? hit[2] : "";
    } catch (err) {
      rethrowHostFault(err);
      return "";
    }
  }

  private rememberCursor(sig: string, offset: number, cursor: string): void {
    try {
      const raw = this.env.kv.get(this.cursorKey());
      let list = raw ? (JSON.parse(raw) as Array<[string, number, string]>) : [];
      list = list.filter((e) => !(e[0] === sig && e[1] === offset));
      list.unshift([sig, offset, cursor]);
      this.env.kv.put(this.cursorKey(), JSON.stringify(list.slice(0, MAX_CURSORS)));
    } catch (err) {
      rethrowHostFault(err);
    }
  }

  private albumList(p: Params): Array<{ item: KindItem; state?: ItemState }> {
    const type = p.require("type");
    const size = p.int("size", 10, 1, MAX_BROWSE);
    const offset = p.int("offset", 0, 0);
    let items: KindItem[] = [];
    switch (type) {
      case "random":
        items = this.sample(this.host.browse({ level: "album", sort: "rating", desc: true, limit: Math.min(MAX_BROWSE, Math.max(100, size * 5)), total: "none" }).items || [], size);
        break;
      case "newest":
        items = this.pagedBrowse({ level: "album", sort: "released", desc: true }, offset, size);
        break;
      case "highest":
        items = this.pagedBrowse({ level: "album", sort: "rating", desc: true }, offset, size);
        break;
      case "alphabeticalByName":
      case "alphabeticalByArtist":
        items = this.pagedBrowse({ level: "album", sort: "title" }, offset, size);
        break;
      case "recent":
      case "frequent":
        items = this.recentAlbums(offset, size, type === "frequent");
        break;
      case "starred": {
        const favs = this.host.favorites("album", offset + size);
        items = this.host.get(favs.slice(offset, offset + size).map((f) => f.id));
        break;
      }
      case "byYear": {
        let from = p.int("fromYear", 0, 0, 9999);
        let to = p.int("toYear", 9999, 0, 9999);
        const desc = from > to;
        if (desc) [from, to] = [to, from];
        items = this.pagedBrowse({ level: "album", sort: "year", desc, facets: { year: [`${from}..${to}`] } }, offset, size);
        break;
      }
      case "byGenre":
        items = this.pagedBrowse({ level: "album", sort: "rating", desc: true, facets: { genres: [p.require("genre")] } }, offset, size);
        break;
      default:
        throw new SubsonicError(ERR_GENERIC, `Unknown list type: ${type}`);
    }
    const states = this.states(items);
    return items.map((item) => ({ item, state: states.get(item.id) }));
  }

  /** Albums by the viewer's listening, from the tracks they played most recently (or most). */
  private recentAlbums(offset: number, size: number, byCount: boolean): KindItem[] {
    const tracks = this.host.browse({ level: "track", sort: "lastViewed", desc: true, limit: MAX_BROWSE, total: "none" }).items || [];
    const states = this.states(tracks);
    const played = tracks.filter((t) => (states.get(t.id)?.playCount || 0) > 0 || (states.get(t.id)?.lastPlayedAt || 0) > 0);
    const score = new Map<string, number>();
    const order: string[] = [];
    for (const t of played) {
      const album = t.parentId || "";
      if (!album) continue;
      if (!score.has(album)) order.push(album);
      const st = states.get(t.id);
      score.set(album, (score.get(album) || 0) + (byCount ? st?.playCount || 1 : 0));
    }
    if (byCount) order.sort((a, b) => (score.get(b) || 0) - (score.get(a) || 0));
    return this.host.get(order.slice(offset, offset + size));
  }

  private sample<T>(list: T[], n: number): T[] {
    const copy = list.slice();
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }

  private yearFacets(p: Params): Record<string, string[]> {
    const facets: Record<string, string[]> = {};
    const genre = p.get("genre");
    if (genre) facets.genres = [genre];
    const from = p.int("fromYear", 0, 0, 9999);
    const to = p.int("toYear", 9999, 0, 9999);
    if (p.get("fromYear") || p.get("toYear")) facets.year = [`${Math.min(from, to)}..${Math.max(from, to)}`];
    return facets;
  }

  private randomSongs(p: Params): Record<string, unknown>[] {
    const size = p.int("size", 10, 1, MAX_BROWSE);
    const page = this.host.browse({ level: "track", sort: "rating", desc: true, facets: this.yearFacets(p), limit: MAX_BROWSE, total: "none" });
    const picked = this.sample(page.items || [], size);
    const states = this.states(picked);
    return picked.map((t) => songOf(t, states.get(t.id)));
  }

  private songsByGenre(p: Params): Record<string, unknown>[] {
    const genre = p.require("genre");
    const items = this.pagedBrowse({ level: "track", sort: "rating", desc: true, facets: { genres: [genre] } }, p.int("offset", 0, 0), p.int("count", 10, 1, MAX_BROWSE));
    const states = this.states(items);
    return items.map((t) => songOf(t, states.get(t.id)));
  }

  private genres(): Record<string, unknown>[] {
    try {
      const raw = this.env.kv.get(GENRES_KEY);
      if (raw) {
        const cached = JSON.parse(raw) as { at: number; genres: Record<string, unknown>[] };
        if (cached && this.env.now() - cached.at < GENRES_TTL_MS) return cached.genres;
      }
    } catch (err) {
      rethrowHostFault(err);
    }
    // Genre names come from the stored albums Ether returns (bounded sample),
    // counts from Ether's cheap facet totals.
    const names = new Set<string>();
    for (const a of this.host.browse({ level: "album", sort: "rating", desc: true, limit: 1000, total: "none" }).items || []) {
      for (const g of genresOf(a)) names.add(g);
    }
    const genres = [...names].sort().slice(0, 60).map((name) => {
      const albums = this.host.browse({ level: "album", facets: { genres: [name] }, limit: 1, total: "cheap" });
      const songs = this.host.browse({ level: "track", facets: { genres: [name] }, limit: 1, total: "cheap" });
      return { value: name, songCount: songs.total || 0, albumCount: albums.total || 0 };
    });
    try {
      this.env.kv.put(GENRES_KEY, JSON.stringify({ at: this.env.now(), genres }));
    } catch (err) {
      rethrowHostFault(err);
    }
    return genres;
  }

  private topSongs(artist: string, count: number): Record<string, unknown>[] {
    if (!artist.trim()) return [];
    const tracks = (this.host.browse({ level: "track", query: artist, limit: MAX_BROWSE, total: "none" }).items || [])
      .filter((t) => str(field(t, "artistName")).toLowerCase() === artist.trim().toLowerCase())
      .sort((a, b) => (b.rating || 0) - (a.rating || 0))
      .slice(0, count);
    const states = this.states(tracks);
    return tracks.map((t) => songOf(t, states.get(t.id)));
  }

  private similarSongs(id: string, count: number): Record<string, unknown>[] {
    const it = this.getOne(id);
    const genre = it.level === "artist" ? "" : genresOf(it)[0] || "";
    const facets = genre ? { genres: [genre] } : undefined;
    const pool = this.host.browse({ level: "track", sort: "rating", desc: true, facets, limit: MAX_BROWSE, total: "none" }).items || [];
    const picked = this.sample(pool.filter((t) => t.id !== id), count);
    const states = this.states(picked);
    return picked.map((t) => songOf(t, states.get(t.id)));
  }

  private artistInfo(id: string): Record<string, unknown> {
    const it = this.getOne(id);
    const art = it.art || [];
    const pick = (role: string) => art.find((a) => a.role === role)?.url;
    return {
      biography: it.level === "artist" ? it.summary || "" : "",
      musicBrainzId: str(field(it, "artistMbid")) || undefined,
      smallImageUrl: pick("thumb") || pick("poster"),
      mediumImageUrl: pick("thumb") || pick("poster"),
      largeImageUrl: pick("poster") || pick("thumb"),
    };
  }

  private albumInfo(id: string): Record<string, unknown> {
    const it = this.getOne(id);
    const art = it.art || [];
    const pick = (role: string) => art.find((a) => a.role === role)?.url;
    return {
      notes: it.summary || "",
      musicBrainzId: str(field(it, "releaseMbid")) || undefined,
      smallImageUrl: pick("thumb") || pick("poster"),
      mediumImageUrl: pick("thumb") || pick("poster"),
      largeImageUrl: pick("poster") || pick("thumb"),
    };
  }

  // --- search -------------------------------------------------------------------

  /** Searches the live catalogue once per query (30 min); true when it added items. */
  private liveSearch(query: string): boolean {
    const key = query.toLowerCase();
    try {
      const raw = this.env.kv.get(LIVE_SEARCH_KEY);
      const seen = raw ? (JSON.parse(raw) as Record<string, number>) : {};
      const now = this.env.now();
      if (seen[key] && now - seen[key] < LIVE_SEARCH_TTL_MS) return false;
      const found = (this.catalog.search(query, 40).items || []).filter(
        (x) => x.level === "artist" || x.level === "album" || x.level === "track"
      );
      if (found.length) this.host.upsert(found);
      const kept: Record<string, number> = { [key]: now };
      for (const [k, at] of Object.entries(seen)) {
        if (now - at < LIVE_SEARCH_TTL_MS && Object.keys(kept).length < 200) kept[k] = at;
      }
      this.env.kv.put(LIVE_SEARCH_KEY, JSON.stringify(kept));
      return found.length > 0;
    } catch (err) {
      rethrowHostFault(err);
      this.env.log("warn", `subsonic live search: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  private search(p: Params, id3: boolean): Record<string, unknown> {
    let query = p.get("query").trim();
    // Clients send "", '""' or a trailing * to mean "everything" / prefix.
    query = query.replace(/^"+|"+$/g, "").replace(/\*+$/g, "").trim();
    const artistCount = p.int("artistCount", 20, 0, MAX_BROWSE);
    const albumCount = p.int("albumCount", 20, 0, MAX_BROWSE);
    const songCount = p.int("songCount", 20, 0, MAX_BROWSE);
    const artistOffset = p.int("artistOffset", 0, 0);
    const albumOffset = p.int("albumOffset", 0, 0);
    const songOffset = p.int("songOffset", 0, 0);
    const level = (lv: string, offset: number, count: number): KindItem[] => {
      if (count === 0) return [];
      if (!query) return this.pagedBrowse({ level: lv, sort: "title" }, offset, count);
      if (offset + count > MAX_BROWSE) return [];
      return (this.host.browse({ level: lv, query, limit: offset + count, total: "none" }).items || []).slice(offset, offset + count);
    };
    let artists = level("artist", artistOffset, artistCount);
    let albums = level("album", albumOffset, albumCount);
    let songs = level("track", songOffset, songCount);
    // Ether's library holds what has been browsed or searched before; when it
    // has little for this query, search the live catalogue once and add it.
    const wanted = Math.min(artistCount, 1) + Math.min(albumCount, 3) + Math.min(songCount, 5);
    const have = Math.min(artists.length, 1) + Math.min(albums.length, 3) + Math.min(songs.length, 5);
    if (query && artistOffset === 0 && albumOffset === 0 && songOffset === 0 && have < wanted && this.liveSearch(query)) {
      artists = level("artist", artistOffset, artistCount);
      albums = level("album", albumOffset, albumCount);
      songs = level("track", songOffset, songCount);
    }
    const states = this.states([...artists, ...albums, ...songs]);
    const albumCounts = this.albumCounts(artists);
    return {
      artist: artists.map((a) => (id3 ? { ...artistOf(a, states.get(a.id)), albumCount: albumCounts.get(a.id) ?? 0 } : { id: a.id, name: a.title, coverArt: a.id, starred: artistOf(a, states.get(a.id)).starred })),
      album: albums.map((a) => (id3 ? albumOf(a, states.get(a.id)) : albumDirOf(a, states.get(a.id)))),
      song: songs.map((s) => songOf(s, states.get(s.id))),
    };
  }

  /** Album counts for a few artists, from Ether's cheap per-parent totals. */
  private albumCounts(artists: KindItem[]): Map<string, number> {
    const out = new Map<string, number>();
    for (const a of artists.slice(0, 20)) {
      if (a.childCount) {
        out.set(a.id, a.childCount);
        continue;
      }
      const page = this.host.browse({ parentId: a.id, level: "album", limit: 1, total: "cheap" });
      out.set(a.id, page.total ?? (page.items || []).length);
    }
    return out;
  }

  // --- stars, ratings, plays --------------------------------------------------

  private starred(id3: boolean): Record<string, unknown> {
    const pick = (level: string) => {
      const favs = this.host.favorites(level, 1000);
      const items: KindItem[] = [];
      for (let i = 0; i < favs.length; i += MAX_BROWSE) items.push(...this.host.get(favs.slice(i, i + MAX_BROWSE).map((f) => f.id)));
      return { items, added: new Map(favs.map((f) => [f.id, f.addedAt])) };
    };
    const ar = pick("artist");
    const al = pick("album");
    const tr = pick("track");
    const states = this.states([...ar.items, ...al.items, ...tr.items]);
    const stamp = (added: Map<string, number>, id: string) => iso(added.get(id)) || new Date(0).toISOString();
    return {
      artist: ar.items.map((a) => ({ ...artistOf(a, states.get(a.id)), starred: stamp(ar.added, a.id) })),
      album: al.items.map((a) => ({ ...(id3 ? albumOf(a, states.get(a.id)) : albumDirOf(a, states.get(a.id))), starred: stamp(al.added, a.id) })),
      song: tr.items.map((s) => ({ ...songOf(s, states.get(s.id)), starred: stamp(tr.added, s.id) })),
    };
  }

  private star(p: Params, on: boolean): void {
    const ids = [...p.all("id"), ...p.all("albumId"), ...p.all("artistId")].map(checkId);
    if (!ids.length) throw new SubsonicError(ERR_MISSING, "Required parameter is missing: id");
    this.host.favorite(ids.slice(0, MAX_BROWSE), on);
  }

  private scrobble(p: Params): void {
    const ids = p.all("id").map(checkId);
    if (!ids.length) throw new SubsonicError(ERR_MISSING, "Required parameter is missing: id");
    const submission = p.get("submission").toLowerCase() !== "false";
    if (submission) {
      for (const id of ids.slice(0, 50)) this.host.played(this.trackId(id));
      return;
    }
    this.setNowPlaying(this.trackId(ids[ids.length - 1]), p.get("c"));
  }

  private nowPlayingMap(): Record<string, { id: string; at: number; name: string; player: string }> {
    try {
      const raw = this.env.kv.get(NOW_PLAYING_KEY);
      const all = raw ? (JSON.parse(raw) as Record<string, { id: string; at: number; name: string; player: string }>) : {};
      const now = this.env.now();
      for (const [k, v] of Object.entries(all)) if (!v || now - v.at > NOW_PLAYING_TTL_MS) delete all[k];
      return all;
    } catch (err) {
      rethrowHostFault(err);
      return {};
    }
  }

  private setNowPlaying(id: string, player: string): void {
    const all = this.nowPlayingMap();
    all[this.viewer] = { id, at: this.env.now(), name: this.viewerName, player: player.slice(0, 64) };
    try {
      this.env.kv.put(NOW_PLAYING_KEY, JSON.stringify(all));
    } catch (err) {
      rethrowHostFault(err);
    }
  }

  private nowPlaying(): Record<string, unknown>[] {
    const all = Object.values(this.nowPlayingMap()).slice(0, 50);
    if (!all.length) return [];
    const items = new Map(this.host.get([...new Set(all.map((e) => e.id))]).map((i) => [i.id, i]));
    const now = this.env.now();
    const out: Record<string, unknown>[] = [];
    for (const e of all) {
      const it = items.get(e.id);
      if (!it) continue;
      out.push({
        ...songOf(it),
        username: e.name,
        minutesAgo: Math.floor((now - e.at) / 60000),
        playerId: 0,
        playerName: e.player || undefined,
      });
    }
    return out;
  }

  // --- playlists --------------------------------------------------------------

  private playlistHeader(pl: Playlist, items: KindItem[]): Record<string, unknown> {
    const duration = items.reduce((s, t) => s + Math.round(num(field(t, "duration"))), 0);
    const first = items[0];
    return {
      id: pl.id,
      name: pl.title,
      comment: pl.summary || undefined,
      owner: this.viewerName,
      public: false,
      songCount: (pl.items || []).length,
      duration,
      created: iso(pl.createdAt) || iso(pl.updatedAt) || new Date(0).toISOString(),
      changed: iso(pl.updatedAt) || iso(pl.createdAt) || new Date(0).toISOString(),
      coverArt: first ? first.parentId || first.id : undefined,
    };
  }

  private playlistItems(pl: Playlist): KindItem[] {
    const ids = pl.items || [];
    const unique = [...new Set(ids)];
    const byId = new Map<string, KindItem>();
    for (let i = 0; i < unique.length; i += MAX_BROWSE) {
      for (const it of this.host.get(unique.slice(i, i + MAX_BROWSE))) byId.set(it.id, it);
    }
    return ids.map((id) => byId.get(id)).filter((x): x is KindItem => Boolean(x));
  }

  private playlists(): Record<string, unknown>[] {
    return this.host.playlists().map((pl) => {
      const firstIds = (pl.items || []).slice(0, MAX_BROWSE);
      const items = this.playlistItems({ ...pl, items: firstIds });
      return this.playlistHeader(pl, items);
    });
  }

  private playlist(id: string): Record<string, unknown> {
    const pl = this.host.playlist(id);
    const items = this.playlistItems(pl);
    const states = this.states(items);
    return { ...this.playlistHeader(pl, items), entry: items.map((t) => songOf(t, states.get(t.id))) };
  }

  private createPlaylist(p: Params): Record<string, unknown> {
    const songs = p.all("songId").map((id) => this.trackId(id));
    const existing = p.get("playlistId");
    if (existing) {
      // Per spec, createPlaylist with playlistId replaces the playlist's songs.
      const pl = this.host.playlist(existing);
      const update: { title?: string; add?: string[]; remove?: number[] } = { remove: pl.indexes || [], add: songs };
      const name = p.get("name");
      if (name) update.title = name;
      this.host.playlistUpdate(existing, update);
      return this.playlist(existing);
    }
    const name = p.require("name");
    const pl = this.host.playlistCreate(name, songs);
    return this.playlist(pl.id);
  }

  private updatePlaylist(p: Params): void {
    const id = p.require("playlistId");
    const pl = this.host.playlist(id);
    const indexes = pl.indexes || [];
    const update: { title?: string; summary?: string; add?: string[]; remove?: number[] } = {};
    if (p.get("name")) update.title = p.get("name");
    if (p.all("comment").length) update.summary = p.get("comment");
    const remove = p
      .all("songIndexToRemove")
      .map((s) => Number.parseInt(s, 10))
      .filter((n) => Number.isInteger(n) && n >= 0 && n < indexes.length)
      .map((n) => indexes[n]);
    if (remove.length) update.remove = remove;
    const add = p.all("songIdToAdd").map((s) => this.trackId(s));
    if (add.length) update.add = add;
    if (Object.keys(update).length) this.host.playlistUpdate(id, update);
  }

  // --- lyrics -----------------------------------------------------------------

  private lyrics(artist: string, title: string): Record<string, unknown> {
    if (!artist.trim() || !title.trim()) return {};
    const res = this.catalog.lyrics({ artistName: artist, trackTitle: title });
    const text = res?.plainLyrics || (res?.syncedLyrics ? stripTimestamps(res.syncedLyrics) : "");
    if (!text) return {};
    return { artist, title, value: text };
  }

  private structuredLyrics(id: string): Record<string, unknown>[] {
    const it = this.getOne(this.trackId(id), "track");
    const artist = str(field(it, "artistName")) || str(hint(it, "artistName"));
    const res = this.catalog.lyrics({
      artistName: artist,
      trackTitle: it.title,
      albumTitle: str(field(it, "albumTitle")),
      durationSec: num(field(it, "duration")),
    });
    if (!res) return [];
    if (res.syncedLyrics) {
      const line = parseLrc(res.syncedLyrics);
      if (line.length) return [{ displayArtist: artist, displayTitle: it.title, lang: "xxx", synced: true, offset: 0, line }];
    }
    if (res.plainLyrics) {
      return [
        {
          displayArtist: artist,
          displayTitle: it.title,
          lang: "xxx",
          synced: false,
          offset: 0,
          line: res.plainLyrics.split(/\r?\n/).map((value) => ({ value })),
        },
      ];
    }
    return [];
  }

  // --- media ------------------------------------------------------------------

  private coverArt(p: Params): EtherResponse {
    let id = p.require("id");
    // Some clients prefix cover ids ("al-…", "mf-…"); playlists use their first album.
    id = id.replace(/^(?:mf|pl)-(?=(?:ar|al|tr|co)-)/, "");
    checkId(id);
    const size = p.int("size", 0, 0, 4000);
    if (id.startsWith("ar-")) {
      // Many artists have no picture of their own; use their newest album's cover.
      const [artist] = this.host.get([id]);
      if (artist && !(artist.art || []).some((a) => a.url)) {
        const [album] = this.host.browse({ parentId: id, level: "album", sort: "released", desc: true, limit: 1, total: "none" }).items || [];
        if (album) id = album.id;
      }
    }
    return { status: 200, art: { itemRef: itemRef(id), role: size > 0 && size <= 500 ? "thumb" : "poster" } };
  }
}

const LRC_LINE = /^\s*((?:\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\])+)(.*)$/;

export function parseLrc(lrc: string): Array<{ start: number; value: string }> {
  const out: Array<{ start: number; value: string }> = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const m = LRC_LINE.exec(raw);
    if (!m) continue;
    const text = m[2].trim();
    for (const stamp of m[1].match(/\[[^\]]+\]/g) || []) {
      const t = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/.exec(stamp);
      if (!t) continue;
      const frac = t[3] ? Number(t[3].padEnd(3, "0").slice(0, 3)) : 0;
      out.push({ start: Number(t[1]) * 60000 + Number(t[2]) * 1000 + frac, value: text });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

function stripTimestamps(lrc: string): string {
  return lrc
    .split(/\r?\n/)
    .map((l) => l.replace(/^(\s*\[[^\]]*\])+/, "").trim())
    .join("\n")
    .trim();
}
