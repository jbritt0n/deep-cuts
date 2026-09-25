# Handoff — Phase 9j (next development run)

**Written:** September 24, 2026, at the Phase 9i checkpoint. Rust from 9c–9i is uncompiled; compile together (9f–9h handoffs list earlier files).

## 0. The 9h.1 feedback and what shipped
| Feedback | Cause | Fix |
|---|---|---|
| Paul Banks → Denmark, Rodriguez → Cuba | MusicBrainz matched by name alone (first exact hit of 3); origin/tags/relations inherited the wrong entity; city = birthplace | ISRC-first matching, album-overlap tie-break, refuse to guess; `verify_batch` corrects old matches; city from `area`; metadata panel to fix by hand |
| Display/edit metadata on Artist/Album/Song pages | — | "What Deep Cuts knows" panel with sources; origin, MB match, image, album year/cover, track ISRC/date; survive rebuilds |
| FreqBlog HTTP 422 | 9g sent `{"tracks": […]}`; `/bulk` wants a bare array | bare array; per-item units; `RateLimit-Remaining`; queued items; sample reply saved |
| Songs played but not liked | — | Library → To revisit (regulars / on the fence / heard once by liked artists) |
| Yearly extended export + polling | import deduped only against exports; poll→export double-counted | supersede polled plays in resolution (track + start ±10 s); fixture |
| Eras: snap-back, gaps, colours, legibility, height, hover, no new threads since Apr 6 | Scroller reset on every render; threads = top 12 by lifetime hours | reset on width only; two bands; prefs card; hover card; recent + per-year thread slots |
| Demo shows every feature, no first-load errors | demo ran 2 of 5 pipeline steps, no enrichment | shared demo SQL, full pipeline, `DEMO_REV` regeneration |
| Export more of the record | export wrote events only | Export everything: every table + `plays_enriched` |
| Stylus scrobbler | — | spec: `docs/STYLUS-SPEC.md` (build order S1–S4) |
| Roast Me | — | Stories → Roast Me: receipts + local-model routine |
| Crate: album vs artist obscurity | only artist listeners existed | `album_popularity` + both on the card |

## 1. Rust (uncompiled) — compile first
- `connectors/musicbrainz.rs`: new `resolve_batch`, `verify_batch`, `candidates`, `set_owner_mbid`, `apply_mbid`, helpers `norm`, `record_match`, `mbid_from_isrc`, `namesakes`, `pick_by_albums`, `fetch_tags`. Uses `urlencoding`, `api_calls.called_at`.
- `connectors/wikidata.rs`: `enrich_origin` now calls `pub fn origin_for(mb, db, artist_id, mbid)` (used by `apply_mbid`).
- `connectors/freqblog.rs`: body `Value::Array(body.clone())`, 400/422 branch, `remaining`, `set_remaining`, `detail`, `save_sample` (uses `crate::paths::resolve`).
- `connectors/lastfm.rs`: `enrich_album_popularity`.
- `commands.rs`: `meta_set`, `artist_set_origin`, `artist_mb_candidates`, `artist_set_mbid`, `export_record`; whitelist + `thread_max`, `thread_per_year`; FreqBlog status `remaining`; Last.fm sync counts albums.
- `lib.rs`: demo built with the full pipeline + `DEMO_REV` regeneration (uses `quarantine` from 9h.1). `db.rs`: `DEMO_EVENTS_SQL`, `DEMO_ENRICH_SQL`, `DEMO_REV`.
- `migrate.rs`: `export_record`. `scheduler.rs`: `verify_batch(20)` in the MusicBrainz tick, `enrich_album_popularity(15)` in the Last.fm tick.
No `PIPELINE_REV` bump needed for correctness, but the dedupe fix only takes effect on the next rebuild — the owner can run Settings → Record → Rebuild, or it happens on the next import.

## 2. Verify on the owner's machine
1. Paul Banks / Rodriguez: within a few MusicBrainz ticks Activity logs "Corrected N MusicBrainz matches…". If not (no ISRC evidence yet), use the artist page picker.
2. FreqBlog: Activity "Audio features for N tracks"; send `logs/freqblog-sample.json` so the parser's field names can be pinned exactly.
3. Before importing a new extended history, note the play count; after, it should rise only by plays polling never saw.
4. Eras on the Toshiba: default height should still fit; Settings → Appearance → Eras chart → height 80 % if not.

## 3. Next
Stylus S1 (receiver + device tokens + Services card), dynamic playlists, Ask v2, Open-Meteo weather for the forecast, Atlas click-through, a Roast Me refinement pass with the owner's favourite lines, `{code, message}` error envelope, background (windowed) first-launch rebuild.
