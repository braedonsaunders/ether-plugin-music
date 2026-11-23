import type {
  EtherRequest,
  EtherResponse,
  HostEnv,
  KindBrowseRequest,
  KindExpandRequest,
  KindMatchRequest,
  KindResolveRequest,
} from "./types.ts";
import { defaultHostEnv, KVCache, readSettings, rethrowHostFault } from "./kv.ts";
import { DeezerClient, RateLimitError } from "./deezer.ts";
import { MusicBrainzClient } from "./musicbrainz.ts";
import { LrclibClient } from "./lrclib.ts";
import { MusicCatalog } from "./catalog.ts";
import { AlbumResolver } from "./resolver.ts";

function parseBody(req: EtherRequest): Record<string, any> {
  if (typeof req.body === "string") {
    try {
      return req.body.trim() ? JSON.parse(req.body) : {};
    } catch {
      return {};
    }
  }
  if (req.body && typeof req.body === "object") {
    return req.body as Record<string, any>;
  }
  return {};
}

function queryParam(req: EtherRequest, key: string): string {
  const v = req.query?.[key];
  if (Array.isArray(v)) return String(v[0] || "");
  return v ? String(v) : "";
}

export function createHandler(env?: HostEnv) {
  return function handleRequest(req: EtherRequest): EtherResponse {
    const host = env || defaultHostEnv();
    const settings = readSettings(host, req.settings);
    const cache = new KVCache(host);
    const path = String(req.path || "");
    const isBackgroundSync =
      path === "/ether/v1/kinds/music/browse" || path === "/ether/v1/kinds/music/changes";
    const dz = new DeezerClient(host, cache, isBackgroundSync);
    const mb = new MusicBrainzClient(host, cache);
    const lrc = new LrclibClient(host, cache);
    const catalog = new MusicCatalog(host, cache, dz, mb, settings);
    const resolver = new AlbumResolver(host, cache, catalog, settings);

    const body = parseBody(req);

    try {
      // Health, configure, and test routes (EPP/1)
      if (path === "/health" || path === "/ether/health") {
        return { status: 200, body: { ok: true, status: "ok", plugin: "ether.music", version: "0.2.5" } };
      }
      if (path === "/ether/test") {
        const startMs = host.now();
        const details: string[] = [];
        const chartSample = dz.getGlobalChartArtists(1);
        const deezerOk = chartSample.length > 0;
        details.push(deezerOk ? `Deezer catalog API: reachable (${chartSample[0].name})` : "Deezer catalog API: unreachable");

        let idxCount = 0;
        let usenetCount = 0;
        let torrentCount = 0;
        let cachedCount = 0;
        try {
          const sr = host.sources.resolve({
            kind: "indexer_search",
            query: "Daft Punk Discovery",
            category: settings.newznabCategories,
            firstResults: true,
            settleMs: 300,
            timeoutMs: 2500,
          });
          const cands = Array.isArray(sr?.candidates) ? sr.candidates : [];
          idxCount = cands.length;
          const hashes: string[] = [];
          for (const c of cands) {
            if (c.nzbUrl && !c.infoHash && !c.magnet) usenetCount++;
            else torrentCount++;
            if (c.infoHash && !c.cached) hashes.push(c.infoHash.toLowerCase());
            if (c.cached) cachedCount++;
          }
          if (hashes.length > 0 && host.now() - startMs < 6000) {
            const dc = host.sources.resolve({ kind: "debrid_check", infoHashes: hashes.slice(0, 25) });
            const cachedSet = new Set<string>();
            for (const h of dc?.candidates || []) {
              if (h.infoHash && h.cached) cachedSet.add(h.infoHash.toLowerCase());
            }
            for (const c of cands) {
              if (c.infoHash && cachedSet.has(c.infoHash.toLowerCase()) && !c.cached) {
                c.cached = true;
                cachedCount++;
              }
            }
          }
          details.push(
            `Audio sources (cats ${settings.newznabCategories}): ${idxCount} releases (${usenetCount} Usenet, ${torrentCount} Torrent, ${cachedCount} Debrid bulk-cached)`
          );
          if (idxCount === 0) {
            details.push(
              "No audio releases returned. Stremio addons (e.g. Torrentio) do not support audio category searches; configure a Newznab, Torznab (Prowlarr/Jackett), or audio-capable Cardigann indexer."
            );
          } else if (torrentCount > 0 && cachedCount === 0 && usenetCount === 0) {
            details.push(
              "Bulk debrid cache check returned 0 hits; providers without bulk cache checks (Real-Debrid, AllDebrid, Debrid-Link) are verified on demand during track resolution."
            );
          }
        } catch (err) {
          rethrowHostFault(err);
          details.push(`Audio source check error: ${err instanceof Error ? err.message : String(err)}`);
        }

        return {
          status: 200,
          body: {
            ok: deezerOk,
            message: deezerOk
              ? idxCount > 0
                ? `Music plugin ready (Deezer OK, ${idxCount} audio sample releases found; concert categories ${settings.concertNewznabCategories}).`
                : `Deezer OK, but 0 audio releases found for categories ${settings.newznabCategories} — add a Newznab, Torznab, or audio-capable Cardigann indexer.`
              : "Could not reach Deezer metadata API.",
            details,
          },
        };
      }
      if (path === "/ether/configure") {
        return { status: 200, body: { ok: true } };
      }

      // 1. Browse (3-level artist -> album -> track)
      if (path === "/ether/v1/kinds/music/browse") {
        const browseReq: KindBrowseRequest = {
          parentId: String(body.parentId || queryParam(req, "parentId") || ""),
          level: String(body.level || queryParam(req, "level") || "artist"),
          cursor: String(body.cursor || queryParam(req, "cursor") || ""),
          limit: Number(body.limit || queryParam(req, "limit") || 200),
          sort: body.sort ? String(body.sort) : undefined,
          desc: Boolean(body.desc),
        };
        return { status: 200, body: catalog.browse(browseReq) };
      }

      // 2. Incremental changes (never wipes viewer-searched / expanded / played items)
      if (path === "/ether/v1/kinds/music/changes") {
        const since = String(body.since || body.cursor || queryParam(req, "since") || queryParam(req, "cursor") || "");
        return { status: 200, body: catalog.changes(since) };
      }

      // 3. Live search across artists, albums, and tracks
      if (path === "/ether/v1/kinds/music/search") {
        const query = String(body.query || queryParam(req, "query") || queryParam(req, "q") || "");
        const limit = Number(body.limit || queryParam(req, "limit") || 40);
        return { status: 200, body: catalog.search(query, limit) };
      }

      // 4. On-demand facet expansion (genres, decades, featuredArtists)
      if (path === "/ether/v1/kinds/music/expand") {
        const expandReq: KindExpandRequest = {
          facet: body.facet ? String(body.facet) : undefined,
          value: body.value ? String(body.value) : undefined,
          valueId: typeof body.valueId === "number" ? body.valueId : undefined,
          parentId: body.parentId ? String(body.parentId) : undefined,
          level: body.level ? String(body.level) : undefined,
          cursor: body.cursor ? String(body.cursor) : undefined,
        };
        return { status: 200, body: catalog.expand(expandReq) };
      }

      // 5. Direct item lookup
      if (path.startsWith("/ether/v1/kinds/music/items/")) {
        const rawId = path.slice("/ether/v1/kinds/music/items/".length);
        const id = decodeURIComponent(rawId);
        const item = catalog.getItem(id);
        if (!item) {
          return { status: 404, body: { error: { code: "not_found", message: "Item not found." } } };
        }
        return { status: 200, body: item };
      }

      // 6. Track playback resolution (album-unit cached)
      if (path === "/ether/v1/kinds/music/resolve") {
        const resolveReq = body as KindResolveRequest;
        return { status: 200, body: resolver.resolve(resolveReq) };
      }

      // 7. Async album resolution job (deduplicated by Ether resolver pool)
      if (path === "/ether/job/resolve-album") {
        const resolveReq = body as KindResolveRequest;
        return { status: 200, body: resolver.runAlbumResolveJob(resolveReq) };
      }

      // 8. Candidate matcher
      if (path === "/ether/v1/kinds/music/match") {
        const matchReq = body as KindMatchRequest;
        return { status: 200, body: resolver.matchCandidates(matchReq) };
      }

      // 9. Synced & plain lyrics via LRCLIB (forward-compatible route)
      if (path === "/ether/v1/kinds/music/lyrics") {
        const item = body.item || {};
        const hints = item.hints || {};
        const res = lrc.getLyrics({
          artistName: String(body.artistName || hints.artistName || item.fields?.artistName || ""),
          trackTitle: String(body.trackTitle || item.title || ""),
          albumTitle: String(body.albumTitle || hints.albumTitle || item.fields?.albumTitle || ""),
          durationSec: Number(body.durationSec || hints.durationSec || item.fields?.duration || 0),
        });
        if (!res) {
          return { status: 404, body: { error: { code: "not_found", message: "No lyrics found." } } };
        }
        return { status: 200, body: res };
      }

      return {
        status: 404,
        body: { error: { code: "not_found", message: `Unknown route: ${path}` } },
      };
    } catch (err) {
      if (err instanceof RateLimitError) {
        return {
          status: 429,
          headers: { "Retry-After": String(err.retryAfterSeconds) },
          body: {
            error: "rate_limited",
            message: err.message,
            retryAfterSeconds: err.retryAfterSeconds,
          },
        };
      }
      throw err;
    }
  };
}

export const handle = createHandler();

// Register hosted QuickJS entry point.
(globalThis as any).handle = handle;
