# Handoff — Phase 9d (next development run)

> Written across the 9b and 9c checkpoints (Sep 12, 2026). §0–§1 cover both phases' Rust; §6 lists what 9c added on top.

**Written:** September 12, 2026, at the Phase 9b checkpoint. Read this, then `PROJECT-STATUS-AND-ROADMAP.md` §1 (Phase 9b entry) and `DESIGN-BRIEF-EXPLORATORY-FEATURES.md` §3/§5 for the reasoning behind the eras and queue work.

## 0. What 9b shipped (owner's four items)
1. **Eras refinement** — weekly backbone, genre threads, areas/lanes chart, Settings sliders with presets and live preview.
2. **Add to queue** — one shared `QueueButton` on every track row; Rust command; one-time Spotify reconnect prompt.
3. **Enrichment quota** — default 100/h, owner-configurable, polling untouched.
4. **The Crate** — new page; obscurity score (net-new data, Last.fm listener counts) landed alongside it.

Verified here: `tsc`, 21 vitest, 12 SQL fixtures, six smoke scripts (`smoke-eras.ts` runs against a **structured** fixture too — `scripts/seed_eras_fixture.py`: 5 phases → 5 eras, a noisy week absorbed, an afrobeat thread found), `vite build`, and screenshots of Insights / Settings / Crate in the browser harness (Playwright).

## 1. First task: compile the Rust (uncompiled, as in every phase)
Files touched — review these first if `cargo build` complains:
- `spotify/endpoints.rs` — `SCOPES` gained `user-modify-playback-state`; `SCOPE_QUEUE`; `queue(uri)`; `budget::ENRICH_PER_HOUR` 200 → 100 plus `budget::enrich_per_hour(db)` (reads `app_meta.enrich_per_hour`, clamps 25–300).
- `spotify/client.rs` — `has_scope()`; **new `ApiError::Http { status, body }` variant** replaces the anyhow-string for non-retryable statuses. The only other `match` on `ApiError` (in `sync.rs::enrich_batch`) was updated to `e @ (ApiError::Other(_) | ApiError::Http { .. })`.
- `spotify/queue.rs` (new) + `spotify/mod.rs` — `queue_track()` returns a `QueueOutcome { status, message }` (never `Err`), statuses `queued | no_device | needs_reauth | not_connected | quota | unqueueable | error`.
- `commands.rs` — `queue_track` command (registered in `lib.rs`); `set_setting` whitelist gained `era_similarity`, `era_min_weeks`, `era_floor_h`, `era_max_gap_weeks`, `enrich_per_hour`; Spotify connector extras gained `canQueue`, `callsLastHour`, `enrichPerHour`; Last.fm extras gained `popularityArtists`; `sync_now('lastfm')` also fetches listener counts.
- `connectors/lastfm.rs` — `enrich_popularity(db, n)` (`artist.getInfo` → `stats.listeners/playcount`; upsert `artist_popularity`, append `artist_popularity_history`; refresh after 90 days; `api_calls` endpoint `pop:<artist_id>` as the per-week "we looked" marker).
- `scheduler.rs` — the 5-minute Last.fm tick now also calls `enrich_popularity(15)`.
- `sql/schema.sql` — appended `artist_popularity`, `artist_popularity_history`, view `artist_obscurity`. Additive; no `PIPELINE_REV` bump needed (no derived table changed).

**Added in 9c (also uncompiled):**
- `spotify/client.rs` — 2xx handling: empty body → `Null`; unparsable body → error only for GET, otherwise `warn` + `Null` (fixes the owner's "Spotify returned non-JSON" toast on a queue that actually worked). The unused `Context` import was removed.
- `commands.rs` — `set_setting` whitelist gained the Tuning keys: `short_play_seconds`, `shape_loop_repeat`, `shape_discovery_novelty`, `shape_restless_skip`, `shape_wander_entropy`, `feedback_memory_days`, `forgotten_days`, `tag_floor`, `lyrics_batch`, `playlist_default_public`, `mixtape_last_mix`, `crate_show_related`.
- `scheduler.rs` — lyric tick reads `lyrics_batch` (10–100, default 40).
- `sql/schema.sql` — `plays_normalized.under_30s` reads `short_play_seconds` from `app_meta` (scalar subquery inside the view). `sql/compute_sessions.sql` — new `_tune` temp table feeds the shape CASE. Both need a rebuild after a change; the Tuning card does it. **Consider a `PIPELINE_REV` bump** so existing records recompute `under_30s` once — harmless if not, since the default is unchanged.

Things I checked by eye but can't prove without a compiler: the bind-by-move + guard pattern in `queue.rs` (`Err(ApiError::Http { status: 404, body }) if body.contains(…)`), the `let (Some(listeners), playcount) = … else { continue }` in `lastfm.rs`, and that `db::Row::get` is the `serde_json::Map`-style accessor every other caller uses.

## 2. Verify on the owner's machine
1. **Services → Spotify** shows the amber "One-time reconnect needed for add to queue" box. Reconnect. `canQueue` flips true; the box disappears; queue icons appear on rows (they're hidden entirely while Spotify is disconnected).
2. Open Spotify on any device, play something, press a queue icon: toast *Queued …*. Stop all playback, press again: *Nothing is playing. Open Spotify on a device…* — that is the expected, common failure.
3. **Insights → Eras**: with real data the chart should show 6–12-week eras in 2025–26. If it shows one blob or every week, **Settings → Eras**: the preview updates as you drag; start from the *Balanced* preset. The diagnostic panel's median similarity should be near 0.07 on this record (benchmark) — if it's far off, the lens (Attentive vs Everything) is the first thing to check.
4. **Genre threads** need `artist_tags`; they appear within a few Last.fm ticks. Expect twin threads for near-synonym tags — see §4.
5. **The Crate**: covers arrive as Cover Art Archive / Spotify enrichment fill `albums.image_url`; until then every record is a colour tile (by design). *Back room* stays empty until `artist_popularity` has rows (15 artists per 5-min tick, most-played first — a few hours for the top of the library, days for the long tail). The header states coverage honestly.
6. **Settings → Spotify enrichment budget**: Activity should stop showing daily quota pauses; if it doesn't at 100, drop to 50.

## 3. Not done from the owner's notes / brief (still open)
- **Add-to-queue call sites not yet wired:** Discover cards (candidates there are artists, not tracks — needs a track pick first), Heard in the Wild rows (captures usually lack a Spotify id; `local:` disables the button anyway), Liner Notes, Moods, Blend. All are one `<QueueButton trackId=… />` each; `TrackList` / `PlaysTable` already carry it.
- **Crate ↔ Dig Deeper** share a catalogue-penetration query in the brief; Dig Deeper (artist page) isn't built, and the Crate's "tracks played / total" uses `albums.total_tracks` only. The "Dig deeper into X →" link on the record card goes to the artist page as a placeholder.
- **Obscurity trajectory UI** — the history table is being filled from day one on purpose; no UI reads it yet.
- **Chaos scoring** (summary §3.7) isn't built; the Crate's dividers reuse `artist_scene` directly, which is the same vocabulary chaos would use.
- Everything in `HANDOFF-PHASE-9B.md` §2.1–2.6 (FreqBlog, dynamic playlists, world map, Liner Notes calendar) — none started in this run.

## 4. Design decisions to confirm with the owner
- **Obscurity reference is fixed at 10⁷ listeners**, not this library's max, so a score means the same thing next year and on someone else's record. Radiohead ≈ 0.03, a 100k-listener artist ≈ 0.29, a 1k-listener artist ≈ 0.57. If the owner wants the scale to "fill" 0–1 for *their* crate, renormalise in `crateQueries.ts`, not the view.
- **Threads are per raw tag.** 'psychedelic' + 'psychedelic rock' + 'garage rock' on the same artists produce three overlapping threads. Options: collapse to `_scene_map` families (fewer, cleaner, loses 'city pop' vs 'japanese' nuance) or dedupe threads whose week-sets overlap ≥ 80 % with a stronger one. Both are a few lines in `genreThreads()`.
- **Section sort is alphabetical** (dividers A→Z, like a shop); the chips match. Sorting sections by hours instead is a one-line change in `crateSections` + the deck builder.
- **Abandoned** = ≤ 2 plays on ≤ 2 days, quiet 60+ days. **Rediscover** = ≥ 15 plays, quiet 365+ days. Both in `crateQueries.ts` `flags` CTE and asserted in `test_crate_flags_abandoned_and_rediscover`.
- The Crate hides the queue icon on covers when Spotify is off but shows it (disabled, explained) on the record card — `always` prop.

## 6. What 9c did with the owner's 9b feedback (all shipped; see roadmap §1 Phase 9c)
Crate: tracks list + queue album, put-away/keep (90 d), nearby records, snappy section strip that follows the front card, physical wear. Eras: taller/larger chart, wrapped labels, page renamed; new Insights metrics page. Review: week-by-week. Settings: tabs, Tuning from the roadmap table, Activity page. Still open from the earlier list: Dig Deeper on the artist page (the "Dig deeper →" link still goes to the plain artist page), obscurity trajectory UI, chaos scoring, and the un-started 9b menu (FreqBlog, dynamic playlists, world map, Liner Notes calendar). Next roadmap steps in order: Awards on In Review (summary §3.1), session chaos score (§3.7), Skip Hall of Fame (§3.3), catalogue penetration + Dig Deeper (§3.4/§3.6).

## 5. Working notes
- `scripts/seed_dev_db.py` now seeds **synthetic tags and listener counts** (clearly marked dev-only) so threads and the Crate render in the harness. Don't mistake those numbers for Last.fm's.
- `DEEPCUTS_DB=dev-data/eras-fixture.duckdb node dev-server.mjs` + `npx tsx scripts/smoke-eras.ts` is the fastest way to see the merge logic behave on known input.
- Era settings persist via `set_setting` as the sliders move (debounced 350 ms). Insights re-reads settings on mount; there's no live event between the two pages.
- Screenshots: Playwright is available globally in the sandbox that built this (`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`); the recipe is in this phase's transcript, not checked in.
