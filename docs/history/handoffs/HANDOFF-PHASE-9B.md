# Handoff — Phase 9b (next development run)

**Written:** September 11, 2026, at the Phase 9a checkpoint. **Read first**, then `PROJECT-STATUS-AND-ROADMAP.md` for the project summary and `PHASE1-NOTES.md` for the "why" behind decisions.

## 0. Where things stand
Phase 9a shipped the data-integrity half of the owner's Phase 9 notes: eras fixed (with a diagnostic), retention drill-down, playlist intelligence, Heard in the Wild reset + guard, poll-over-enrichment scheduling. All SQL/TS verified (tsc, 13 vitest, 10 fixtures, 45 smoke queries, `vite build`). **Two Rust edits are uncompiled**: `scheduler.rs` (enrichment offset + `is_paused()` skip) and `lastfm_wild_reset` (`lastfm_wild.rs`, `commands.rs`, `lib.rs`). First `cargo` build of 9a is the first task.

The owner has a **Pano-only Last.fm account** ready. After installing 9a: Services → Heard in the Wild → *Purge & re-point to another account…* → enter it → Sync now. The guard on the card should no longer fire.

## 1. Verify 9a on the owner's machine (do before building 9b)
1. Build compiles; app opens; `PIPELINE_REV` 8 → 9 triggers the auto-rebuild.
2. Insights → Eras now reaches Sep 2026 with an *in progress* badge. Open *how the boundaries were drawn* and note the real per-month hours/similarity for 2025–26. If eras still look wrong, tune `ERA_MONTH_FLOOR_H` (1 h) or the 0.3 cosine in `insightQueries.ts` — the panel is the evidence.
3. Library → Playlists shows the totals strip. If *partial* playlists remain, press *Finish syncing playlists* when quota is fresh (morning). If the sync still stops early, lower `budget::ENRICH_PER_HOUR` in `spotify/endpoints.rs` or add a `sync_playlists_full` command that loops with `Retry-After` until done.
4. Settings → Activity: polls should now precede enrichment each 20-min cycle.

## 2. Committed 9b scope (owner said "take it all")
Ordered so SQL/TS-verifiable work lands before Rust, per the project workflow.

### 2.1 Audio-features connector — **FreqBlog** (owner chose audio features over Setlist.fm)
Verified live on 2026-09-11 (`https://freqblog.com`, OpenAPI at `https://api.freqblog.com/docs`): free tier **1,000 requests/month, no card**; header `X-Api-Key`; `GET /lookup?track=&artist=` or `?isrc=`; **`POST /bulk` — 50 tracks per call, quota-only**, ideal; `202` = queued backfill (retry or `?wait=N`); `429` carries `Retry-After`; **CORS is deliberately blocked — server-side only**, which is fine (Rust). Clears the connector contract (`docs/recommendations/deepseek_markdown_20260911_d17ea2.md` §1): keyed → keyring, read-only, derived features only, degrades to empty state.
- **Schema:** `track_features (track_id PK, isrc, bpm, bpm_alt, bpm_confidence, key_name, key_int, mode, camelot, energy, loudness_db, danceability, valence, mood, time_signature, acousticness, instrumentalness, liveness, speechiness, genre, feature_source, fetched_at)` appended to `schema.sql`; seed `connector_state` row `freqblog`.
- **Connector** `connectors/freqblog.rs` on the Last.fm/`lastfm_wild` template: `connect(key)` validates via one `/lookup`; `enrich(db, n)` picks the most-played un-featured tracks (**ISRC first** — `tracks.isrc` is populated by Spotify enrichment — name fallback), calls `/bulk` in batches of 25 (site recommends ~15–25 for miss-heavy batches), writes rows, honours `Retry-After`, counts monthly usage in `connector_state.detail` and **stops at ~900/month** to leave headroom. Scheduler: one tick per 6 h (bulk = 25 tracks/call, so ~100 tracks/day fits the free tier over a month). Services card: key entry, tracks featured / total, monthly quota bar.
- **Features (TS, new `featureQueries.ts` + a "Sound" section on Insights or its own page):** tempo drift by year/month/day-part; key & mode by season ("minor keys in winter"); energy by hour of day; an *adventurousness* number = spread across key×tempo bins; duration-preference trend. **Lean on the 100 %-coverage fields (bpm, key, energy, loudness); label valence/mood as directional** — FreqBlog itself says the perceptual fields are coarse.
- **Tests:** a JSON fixture of one real `/bulk` response for a parser test (Kimi T5 pattern); a fixture test for the "most-played un-featured first" selection SQL.

### 2.2 Dynamic auto-updating playlists (owner request)
Generalise the monthly Radar refresh: `created_playlists` gains `refresh_cadence` ('none' | 'weekly' | 'monthly') and `refresh_spec` (JSON: the kind + parameters used to build it — period, engine mix, curated list id). Nightly job: for each due playlist, rebuild the track list with the same spec, **diff, then replace items** via the existing Spotify playlist API (`playlists.rs`), log the change to `activity_log`, never delete the playlist. UI: a cadence toggle in `PlaylistMaker` and on the *Made by Deep Cuts* tab, with "last refreshed" and "next refresh". Suggest-only mode (log what *would* change) is a good first step if the owner is nervous about silent edits.

### 2.3 World map of artist origins (owner request)
Data exists: MusicBrainz origin per artist (Phase 7, feeds scenes). Build `originQueries.ts` → hours/plays/artists per ISO country, then an inline SVG world map (bundle a small Natural-Earth-derived country path set as a static asset — no map library) shaded by hours, hover → top artists there, click → Explore filtered to that country. Respect the listening lens. Add a data-table alternative (accessibility, Kimi R6).

### 2.4 Weekly review + Liner Notes redesign (owner request)
Liner Notes already composes a weekly note (`notesQueries.composeNotes`). Add: a **calendar strip of the year's weeks** (one cell per week, intensity = hours, click → that week's note); richer layout (pull-quote fact, a mini chart, the week's cover collage from `albums.image_url`); and surface *Weekly review* as a mode on In Review (period = ISO week) so the two share one data path.

### 2.5 Remaining owner items from the Phase 8 review
- Album art / artist photos throughout (keep the Spotify artist image in `enrich_track_from_json`; `artists.image_url`).
- Library playlists split by owner (me / Spotify editorial / others) — verify `owner.display_name === "Spotify"` on real sync data first.
- Genre browse "new to you" lens is bounded by the similar-artist graph — fetch tags for related artists if it stays thin.
- Heard in the Wild: Day-page strip (`wildOnDay()` exists), monthly *new to you* digest.

### 2.6 Foundation items that should ride along (from `docs/recommendations/`)
- **Structured `{code, message}` error envelope** at the Rust boundary (Kimi T2) — now three connectors deep; do it before FreqBlog adds a fourth.
- **Chart memoization + skeletons** (Kimi T3) — the Playlists tab and Insights are getting heavy.
- **Rust connector parse-test fixtures** (Kimi T5) — record one real response per endpoint incl. `user.getRecentTracks` and FreqBlog `/bulk`.
- Bump `actions/*` to Node 24 majors in `build.yml` (deprecation is cosmetic until Sep 16 2026).

## 3. After 9b (menu, not commitments)
Record Hygiene page (ISRC duplicate detection; session surgery; import diffing) · Blind spots + bubble score · Playlist overlap graph (then artist family tree; force graph last) · Query console (after replacing `assert_read_only`) · Setlist.fm (still the cheapest connector; pairs with the world map) · Discogs · Command palette · Attended-only aggregate lens + attention-adjusted streaks · Restore drill · The LLM layer, **still gated** on Ollama at `http://127.0.0.1:11434`.

**Explicitly not doing:** Last.fm obsessions export (not in their API), journal/notes (deprioritised by owner), Rate Your Music, Apple Music API, cloud sync, storing lyric text, an "everything" graph.

## 4. Working notes for the next agent
- Workflow: edit `.sql` → `python3 scripts/seed_dev_db.py` (or `validate_sql.py` with a real export) → `python3 scripts/test_sql_fixtures.py` → mirror TS → `npm test` → `npm run dev:browser` + `npx tsx scripts/smoke-*.ts` → only then Rust. CI runs exactly this on every push; Rust builds only on `v*` tags / manual dispatch.
- The dev server dies when the shell that started it exits — start it in the same command as the smoke script.
- `assert_read_only` rejects any `;`, including inside SQL comments. Keep explanations in TS comments.
- Heard in the Wild rows are `event_type = 'wild_play'`; join `wild_plays` **to** the record, never the reverse.
- Ask the owner for exact `cargo` / Actions output, not paraphrases — it's been the primary Rust feedback loop.
