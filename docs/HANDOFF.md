# Handoff — current (Phase 10a → 10b)

**Written:** September 25, 2026. This file is replaced each build; past handoffs are in `history/handoffs/`. The plan lives in `ROADMAP.md`.

## What 10a changed
| | |
|---|---|
| FreqBlog "0 of N have features, 100 not in catalogue, 115 units used" | Billed hits were read as misses: the /bulk reply nests each track's features under a key 9g never saw. `freqblog.rs` now finds the feature object at any depth (`feature_obj`), matches replies by ISRC → names → position, builds "B minor" from `key` + `mode`, and a one-time schema step forgets the false misses so they're looked up again. |
| Crate shows only artist obscurity | Album listener lookups ran last in a `?`-chained Last.fm tick, so any earlier error skipped them. Each step is now independent (scheduler + Sync now). Services → Last.fm shows the album count. |
| Obscurity on Artist and Album pages | `ObscurityPanel` (album page shows album + artist + "deep cut in their catalogue"). |
| Blank followed playlists | Pass 1 keeps a known name when a listing omits it; nameless rows get one `/playlists/{id}` details call; the UI falls back to "Untitled playlist · by owner". |
| Playlist affinity % | View `playlist_affinity`; items now store artist + title (a one-time re-sync of items rotates within quota). Library rows, detail header, two new sorts. |
| Atlas city names | Countries named from the ISO code (`countryName`); stale area names cleared. |
| The Newness | New page (Understand): week / month / season, best finds with keepers, where the new came from, discovery timeline. |
| Phase 10 | Discovery depth (bubble, blind spots, anti-recommendations on Discover; activity labels on Sessions; song length in Sound), Connections page (co-listening network, playlist overlap), ISRC duplicates report (Hygiene), loading skeletons, docs reorganised (`docs/README.md`). |

## Rust (uncompiled) — compile first
- `connectors/freqblog.rs`: `feature_obj`, new matching block (closures `norm`, `isrc_of`, `names_of`), key/mode join, `found` from features.
- `scheduler.rs` Last.fm tick: array of `(&str, Result<()>)` built from four calls — each `enrich_*` returns `Result<usize>`, mapped with `.map(|_| ())`.
- `commands.rs`: Last.fm "Sync now" uses `unwrap_or(0)`; services status adds `albumListeners`.
- `spotify/sync.rs`: pass-1 upsert gains `owner_name`; nameless-playlist details loop; item insert stores `track_name`, `artist_name` (`t` is the item's track object).
- `spotify/endpoints.rs`: `playlist_meta`.

## Verify on the owner's machine
1. Services → FreqBlog: after the next tick, "N of … played tracks have features" rises; please share `~/.local/share/deep-cuts/logs/freqblog-sample.json` so the fixture test (Phase 10.1) uses a real reply.
2. Services → Last.fm: "albums with listener counts" climbs; The Crate and album pages show album obscurity.
3. Library → Playlists: no blank rows; affinity % on each readable playlist (followed playlists sharpen as their items re-sync with artist names).

## Next (10b) — from ROADMAP §2
Error envelope, connector fixtures (FreqBlog first), `cargo test` in CI, Stylus S2; Discogs connector; MusicBrainz samples/covers card; artist family tree.
