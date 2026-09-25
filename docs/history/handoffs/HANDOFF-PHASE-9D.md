# Handoff — Phase 9e (next development run)

**Written:** September 12, 2026, at the Phase 9d checkpoint. `HANDOFF-PHASE-9C.md` still describes the 9b/9c Rust that also awaits its first compile; this file covers 9d.

## 1. Rust written in 9d (uncompiled)
- `connectors/musicbrainz.rs` — `enrich_catalogue(db, n)`: `recording?artist=<mbid>&limit=1` → `recording-count` → `artists.catalogue_tracks`; refresh after 180 d; `api_calls` marker `cat:<mbid>`. `enrich_credits(db, n)`: `recording?query=isrc:<isrc>&limit=1` → `recordings[0]["artist-credit"]` → one `track_credits` row per credit, `credit_order` = position; resolves names to a known `artist_id` via `artists.name` / `mbid` / `artist_aliases`; marker `isrc:<isrc>`. Both use the existing `Mb` client (1.1 s politeness) and `set_state` on error.
- `scheduler.rs` — the MusicBrainz tick also runs `enrich_catalogue(8)` and `enrich_credits(12)`.
- `commands.rs` — `sync_now('musicbrainz')` runs both; MusicBrainz connector extras gained `catalogueArtists`, `creditedTracks`.
- `sql/schema.sql` — `sessions.chaos`, `sessions.chaos_pairs`, `artists.catalogue_tracks`, `artists.catalogue_fetched_at`, table `track_credits`. `sql/compute_sessions.sql` — the `INSERT INTO sessions SELECT …` now ends with `NULL AS chaos, NULL AS chaos_pairs` (positional insert — keep it in step with the table), then `_tagv/_tagn/_pairs/_pair_dist` compute chaos and `UPDATE sessions`. **Bump `PIPELINE_REV`** so existing records recompute sessions once with chaos populated — otherwise chaos stays NULL until the nightly rebuild.

Things to eyeball at compile time: `c["name"].as_str().or(c["artist"]["name"].as_str())` (both `Option<&str>`), `json!(resolved)` with `resolved: Option<String>`, and the `UNION … LIMIT 1` name-resolution query (DuckDB applies LIMIT to the union).

## 2. Verify on the owner's machine
1. After the rebuild, Sessions cards show a chaos word/dot; overview Chaos card has album rides low and shuffle wanders high. If everything reads 0.0, tags weren't present at rebuild time — rebuild again after Last.fm has run.
2. In Review → any year → Superlatives at the bottom. *Best Supporting Artist* and *The Deep Cuts Award* say "not available" until MusicBrainz credit/catalogue enrichment has run for a while (12 tracks / 8 artists per 5 min).
3. Artist page → Dig Deeper: penetration appears once `catalogue_tracks` is set for that artist. The never-played list only knows tracks that exist locally (liked / playlists / albums) — on a fresh record it will be short.
4. Not for me: expect a short list on a record with low skip rates; the thresholds are in `skipHallQueries.ts` (8 shown / 85 %) and would be natural Tuning additions.

## 3. Open decisions
- Chaos uses raw tags, so two artists sharing 'indie rock' + 'indie pop' look close even when they sound different; scene families (`artist_scene`) would be coarser but more robust. The transition chain already colours by scene — if the numbers and the colours disagree often, switch the vector.
- The skip-spree exclusion is a proxy (10+ skips and ≥70 % skip rate per session); the exact "10 consecutive" run is computed in `_plays.skip_island` but not persisted. Persisting `longest_skip_run` on sessions would make it exact.
- `catalogue_tracks` counts recordings, not songs; live/remix duplicates inflate it. MusicBrainz *works* (`work?artist=`) would be closer to "songs" but is sparser. Left as recording-count with "~" in the UI.

## 4. Next from the roadmap
Forecast (summary §3.2, distribution mode + `forecast_log`), obscurity trajectory UI (`artist_popularity_history` has been accumulating since 9b), Daily Dig on the dashboard, then the un-started 9b menu (FreqBlog audio features, dynamic playlists, world map, Liner Notes calendar). Consider exposing the Skip Hall and chaos thresholds in Settings → Tuning.
