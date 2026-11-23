# Music (`ether.music`)

Ether content plugin for a full music library. It covers artists, albums and tracks, with Deezer and MusicBrainz metadata, cover art, charts, genres, eras and new releases. Concerts appear on artist pages. Playback is album-first through your own Usenet, torrent and debrid sources, with FLAC preferred, and lyrics where available.

Install it from **Plugins › Marketplace** in Ether.

## Releasing

1. Bump `version` in `manifest.json`. Set `MIN_ETHER` to the oldest Ether release the new version needs. Optionally add a `## <version>` section to `CHANGELOG.md`.
2. Commit, then tag it: `git tag v<version> && git push origin v<version>`.
3. CI checks, tests and packs the plugin, and attaches `<id>-<version>.etherpkg` to a GitHub release.
4. The [ether-plugins](https://github.com/braedonsaunders/ether-plugins) marketplace picks up the release within the hour and opens a PR adding the version. Merge it, and Ether offers the update to every server that has the plugin installed.
