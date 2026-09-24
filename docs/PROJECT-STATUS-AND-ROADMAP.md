# Deep Cuts v3 — Project Summary & Roadmap
**Handoff document — September 22, 2026 (current through Phase 9i)**

> For what to build next, read **`docs/HANDOFF-PHASE-9I.md`** — it is the working handoff. This file is the durable project summary.

This file is written for whoever picks up this project next (human or AI agent). It summarizes what exists, how it's built, what's been tested, what's broken, and what's planned. Read this before touching code.

---

## 0. What this project is

Deep Cuts is a local-first desktop app (Windows + Linux) that turns the owner's Spotify listening history into deep, explorable analytics — sessions, insights, recommendations, playlists — with no cloud, no telemetry, no account beyond Spotify itself. Everything runs on the owner's machine in a single DuckDB file.

**Stack:** Tauri 2 (Rust core, thin) + React 18 + TypeScript + Tailwind (frontend) + DuckDB (all analytics in SQL).

**Owner:** Jonathan (GitHub `jbritt0n`). Repo: `github.com/jbritt0n/deep-cuts` (private). Builds via GitHub Actions (`.github/workflows/build.yml`) — this is the primary way installers get made; local compilation on the owner's Mint machine is possible but was disk-space-constrained (see §5).

**Where things are:**
- `src-tauri/sql/` — every analytics query and the schema. **This is the source of truth for behavior.** Read the SQL before assuming what a feature does.
- `src-tauri/src/` — Rust: DB access, importer, Spotify OAuth/sync, connectors (Last.fm, MusicBrainz, ListenBrainz, stats.fm, LRCLIB lyrics, Cover Art Archive), scheduler, commands exposed to the UI.
- `src/lib/*Queries.ts` — TypeScript mirrors of the SQL query patterns (queries.ts, sessionQueries.ts, insightQueries.ts, recQueries.ts, phase4Queries.ts, phase7Queries.ts, notesQueries.ts, and from Phase 8: wildQueries.ts, hygieneQueries.ts, genreQueries.ts). All UI data flows through these.
- `src/lib/__tests__/*.test.ts` — vitest unit tests (Phase 8): formatting, the listening-lens SQL fragments, and `PLATFORM_FAMILY` bucketing run through an in-memory DuckDB. `npm test`.
- `docs/recommendations/` — the four external advisory reviews (DeepSeek ×2, Kimi, and the synthesis `NEXT-DROP-RECOMMENDATIONS.md`) that shaped Phase 8 and the Phase 9 menu in §4.
- `docs/HEARD-IN-THE-WILD.md` — design note for the Phase 8 ambient-capture class and its dedup rule.
- `src/pages/*.tsx`, `src/components/*.tsx` — the React app.
- `dev-server.mjs` — a Node harness that mimics the Rust core's commands over HTTP so the UI can be developed and the SQL validated **without compiling Rust**. This was essential throughout development since Rust couldn't be compiled in the sandbox that built most of this.
- `scripts/validate_sql.py`, `scripts/test_sql_fixtures.py`, `scripts/seed_dev_db.py` — pipeline validation, regression tests, and a demo-seeded dev database (so the browser harness and smoke scripts work without an export), all plain Python + DuckDB (no Rust needed).
- `docs/SETUP.md` — full setup guide (GitHub Actions route + local route + connecting each service).
- `docs/PHASE1-NOTES.md` — a running log of every design decision, deviation, and fix made across all phases. **Read this for the "why" behind non-obvious choices.**
- `README.md` — the click-through test plan, updated every phase.

**Development approach that got us here:** almost everything was built and validated as pure SQL/TypeScript against the owner's real 99,822-play export using `dev-server.mjs`, because the Rust toolchain wasn't available in the building environment. Only after the owner had a working Mint machine did actual `cargo` compilation happen. This means: **the SQL and TS layers are heavily tested; the Rust layer (connectors, OAuth, playlist creation, scheduler) has had exactly one real compile-and-run cycle and is the least proven part of the codebase.**

---

## 1. Current state — what's built and working

### Phases 1–7c (Sep 2026) — condensed
Full per-phase detail lives in `docs/PHASE1-NOTES.md`; only what still matters for orientation is kept here.
- **Foundation (1):** in-app import of the Spotify export, entity resolution, sessions v2 with attention detection, dashboard/entity pages, demo + portable modes. Verified on the owner's record: 99,822 plays, 5,704 h, 11,293 artists, 2016–2026.
- **Live & connected (2):** Spotify PKCE OAuth, quota-aware client, 20-min recently-played poller, liked/playlist sync, lazy enrichment; Last.fm (tags + similar) and MusicBrainz connectors; Services screen.
- **Insights, discovery, playlists (3/3b):** eras, obsessions, lifecycle, skip forensics, personas, seasons; five recommendation engines with feedback; playlist creation; In Review for any period; curated lists.
- **Depth (4/5):** achievements, moods, taste-drift map, half-life, compare periods, Library, Blend, share cards, lyric themes (derived only — full text never stored); ten skins; Liner Notes; milestones; artist merge; nightly rebuild + Parquet backup.
- **Art, tests, CI (6):** cover art; **SQL fixture suite** (caught two shape-rule bugs); release job.
- **Scenes, earworms, travel (7):** multi-timezone from `conn_country`; scenes; earworms calibrated on the owner's list; insights cache; mixtape builder; ListenBrainz; ErrorBoundary per route; **auto-rebuild on `PIPELINE_REV` bump**.
- **Live-testing fixes (7c):** playlist sync on *Sync now*; the "So Excited" attention bug (explicit interaction allow-list) + `stuck_repeat` flag + fixture.

### Phase 8 — Heard in the Wild, owner's fixes, tests & CI gating
Built against the four advisory documents in `docs/recommendations/` plus two owner ideas (Shazam/Now Playing capture; discovery by genre). SQL + TS validated end-to-end here; **Rust additions are uncompiled** (see §2.1 — same status as every previous phase's Rust).

- **Heard in the Wild** (owner idea, reshaped). Neither Shazam nor Google's Pixel *Now Playing* has a history API, but both scrobble to Last.fm through a phone-side scrobbler (owner uses **Pano Scrobbler**). A new connector (`connectors/lastfm_wild.rs`, reusing the Last.fm key) imports those scrobbles every 30 min as a **separate event class** `event_type = 'wild_play'`. Every core view filters `event_type = 'play'`, so captures are invisible to sessions, streaks, insights, totals and records *by construction* — verified by the fixture `test_wild_never_touches_core_record` and the smoke invariant `plays_resolved = events − wild_plays`. **Dedup against the owner's own Spotify playback** happens at ingest (`sql/wild_insert.sql`): a capture is dropped if a primary play of the same artist was running when it was stamped — same song within ±120 s of the play interval (title match is loose so Google's "(feat. …)" titles still match), or any same-artist capture strictly inside the interval. Handles the export's END-of-play stamps and the poller's START stamps correctly; idempotent on re-import. A `since` date (defaults to setup day) stops an old main-account history being mistaken for captures. New page `/wild` (never-streamed vs already-yours, hour/weekday shape, month trend with "new" highlighting, artists you keep running into, pin/hide/Add-to-Radar), Services card with Pano setup steps. Per-app origin (Shazam vs Now Playing) is **not recoverable** from Last.fm; both land in one bucket. Design note: `docs/HEARD-IN-THE-WILD.md`.
- **Owner's §3 items delivered**: Earworms moved from Discovery to a Library tab (§3.3); session cards now show the date and top two artists, the explorer has *Oldest first* and an artist/track-in-session search (§3.4); the dashboard heatmap has a scope picker — last 12 months or any calendar year (§3.5); a **Review outliers** panel in Settings lists stuck-repeat sessions with one-click *Mark unattended*, short tracks with disproportionate single-day spikes, plays longer than their song, and a six-number integrity strip (§3.6).
- **Discovery by genre** (owner idea): a *Browse by genre* card on Discover — every tag your artists carry, sized by your hours; pick one to see your library in it and, via similar-artist edges seeded from those artists, artists you don't own in the same genre (`genreQueries.ts`). Coverage of the second lens is bounded by the similar-artist graph, since tags are only fetched for owned artists.
- **Code health**: `vitest` added (13 tests; the `PLATFORM_FAMILY` test **immediately caught a real bug** — PlayStation strings arrive as `Partner playstation4 …` and were bucketed as TV/speaker; fixed by reordering the CASE). `likedSongs()` filters now use `$n` binding instead of manual quote-escaping (§1.1 of the synthesis). `Db::assert_read_only`'s substring-matching limitation is documented in `db.rs` ahead of the LLM phase (§1.2). Three new SQL fixtures (10 total, all green).
- **CI**: `build.yml` now has a ~2-minute `test` job (tsc + vitest + SQL fixtures + all four smoke scripts against the demo-seeded dev DB) on every push and PR; the 40-minute Rust builds run only for `v*` tags and manual dispatch, gated on tests (Kimi T1). `PIPELINE_REV` bumped to 8.

**Phase 8 real-data findings** (owner tested the installed build): Heard in the Wild's first import was entirely the owner's own Spotify plays — Pano was scrobbling to a Last.fm account Spotify also fed, and those plays had never reached the record (quota), so the desktop dedup had nothing to match. Fixed at the source (owner created a Pano-only Last.fm account) and in 9a below. Eras still empty for 2025–26 (root cause found, fixed in 9a). Only 7 playlists synced — quota, not code. Enrichment observed landing before polls — real, fixed in 9a.

### Phase 9a — data integrity, eras, playlists
SQL/TS verified end-to-end here; **Rust changes uncompiled** (scheduler, `lastfm_wild_reset`).
- **Eras fixed.** Root cause: the detector *dropped* eras shorter than 2 months, so on a record whose recent months are varied (adjacent cosine < 0.3) every month became a 1-month era and was filtered out — the timeline ended before 2025. Now a run of consecutive short eras that spans 2+ months becomes its own ("restless") era, an isolated short era is absorbed into its neighbour, the month floor dropped 3 h → 1 h, the current era is flagged **in progress**, and an **"how the boundaries were drawn"** panel under Eras shows per-month hours + similarity so the owner can tune on real data. Reproduced and verified against a synthetic varied 2025–26 tail (`insightQueries.eras`, `eraDiagnostic`).
- **Retention drill-down.** Click any year's retention bar → the artists you found that year who **went quiet** (biggest first, months silent) and who stayed (`retentionDetail`).
- **Playlist intelligence** (`src/lib/playlistQueries.ts`, Library → Playlists rebuilt): totals strip (synced vs expected, **partial-sync detection** with a *Finish syncing playlists* button), sort lenses (most/least played, fewest songs heard, most complete, most gems, most dead weight, longest untouched, biggest, newest), scope (mine/followed) + search, per-playlist completion bars, **per-track classification** — *gem* (a song you love with 15+ plays that this playlist never gets you to), *dead weight* (skipped ≥60 % inside or unplayed 90+ days), *core*, *unheard* — with filter chips, and **"Worth revisiting"** suggestions with plain-English reasons.
- **Heard in the Wild hardening.** `lastfm_wild_reset` purges every capture (and pins/hides) and re-points at a Pano-only account; Services card shows the account and a **misconfiguration guard** — if ≥60 % of captured songs are already in the record, it says so and points to the fix. Setup text now leads with the dedicated-account advice. Feedback messages quote titles (a song called "Shit Talker" produced the message *Hidden shit talker.* — now *Hidden "Shit Talker".*).
- **Poll priority over enrichment** (`scheduler.rs`): enrichment starts only after the first poll, runs on the poll's 20-min cadence offset 5 min *after* it, and skips its tick while the quota pause is active. A missed poll is a permanently lost play; enrichment is retryable forever.
- `PIPELINE_REV` → 9.

### Phase 9b — weekly eras + genre threads, add-to-queue, quota control, The Crate
SQL/TS verified end-to-end (tsc, 21 vitest, 12 fixtures, 6 smoke scripts incl. a structured eras fixture, `vite build`, screenshots in the browser harness); **Rust changes uncompiled** — see `docs/HANDOFF-PHASE-9C.md` §1.
- **Eras at weekly grain, two layers.** Backbone switched month → ISO week (`insightQueries.eras`); the cosine chain is a reusable `similarityChain()` (norms once per period, inner-join dot product). Defaults 0.04 / 4 wk / 0.5 h / 6 wk from the owner benchmark (`docs/DESIGN-BRIEF-EXPLORATORY-FEATURES.md` §3.2), bounds + presets in `eraParams.ts`, **owner-tunable in Settings with live preview**. **Genre threads** (`threadQueries.ts`): per-tag weekly share ≥ 8 % for ≥ 3 weeks, independent of the backbone, so an "afrobeat thread" can run under three artist-named eras. **Chart** (`charts/EraChart.tsx`): overlapping alpha areas / swimlane toggle, hover-isolate, scroll-to-present, click → list entry.
- **Add to queue** (`spotify/queue.rs`, `QueueButton.tsx`): a per-track icon in every track row (Explore/Dashboard/Review lists, plays tables, Sessions detail, Library playlists, PlaylistMaker, Track page, The Crate). Structured outcome — *queued / no device / needs reconnect* — and a **one-time reconnect prompt** on Services because the new `user-modify-playback-state` scope postdates existing consents.
- **Enrichment quota**: `ENRICH_PER_HOUR` 200 → 100 and read at runtime from `app_meta.enrich_per_hour` (Settings slider, 25–300). Services shows calls-in-the-last-hour.
- **The Crate** (`/crate`, `crateQueries.ts`, `Crate.tsx`): a fanned rolodex of album covers — click/→ flips; **genre dividers** (from `artist_scene`, the same tag-family vocabulary as Scenes) peek up a few flips early; **wear** (log play count) and **abandonment** stamped on the cover; shelves *Whole crate / Fresh crate / Back room / Rediscover*; `CoverTile` fallback shared with `Collage`. **Obscurity** = inverse-log Last.fm listeners on a fixed 10⁷ reference (`artist_obscurity` view) — new `artist_popularity` + `artist_popularity_history` tables, filled by `lastfm::enrich_popularity` (15/tick; history appends every pass so trajectories accumulate).

### Phase 9c — owner feedback on 9b, Settings expansion, new Insights metrics
SQL/TS verified (tsc, 24 vitest, 12 fixtures, 7 smoke scripts, `vite build`, screenshots). **Rust changes uncompiled** — `docs/HANDOFF-PHASE-9C.md` §1 lists them.
- **The Crate, round two.** Record card now lists every track you've played from the album with a queue icon each plus **Queue the album** (in album order, stops at the first failure); **Put away 90 days / Keep up front** write `recommendation_feedback` rows under `engine = 'crate'`; **Nearby in the crate** shows the same artist's barely-opened / saved-but-unplayed albums, unknown neighbours from the similar graph and known-but-dormant neighbours. Section strip is a horizontal scroller whose highlight follows the front card; one click jumps, double-click filters; "skip to next section" searches the whole remaining deck. **Wear is physical now**: desaturation/fade, paper grain, ring wear, spine crease, corner scuffs and stray creases scale with log play count.
- **Queue fix**: the `POST /me/player/queue` 200 arrives with a non-JSON body — `client.rs` now treats any 2xx as success and only GETs demand JSON.
- **Eras page** (`/eras`, the former Insights page): chart 340 px tall, 12 px type, two-line era labels repeated every 50 weeks so one is always in view. **Insights** is a new page of the record's own metrics: deep-cut ratio (+ by year), spread score, one-song relationships, album loyalty rollup, pace (h/week), silence report, device hand-offs, explicit share (`metricQueries.ts`).
- **In Review → Week by week** (`periodForWeek`, ← → navigation, date picker, link to Liner Notes).
- **Settings rebuilt as tabs** (Appearance · Record · Tuning · Connectors · Hygiene); Activity moved to its own page (`/activity`, with level/task filters and import history). **Tuning** exposes the roadmap's hardcoded values through one `TUNING` table (`src/lib/settings.ts`): short-play cutoff and four session-shape thresholds (read by `compute_sessions.sql` / the `plays_normalized` view from `app_meta`, rebuild on apply), Discover feedback memory (one setting where three "90"s lived), forgotten-artist window, tag confidence floor, lyric batch size, playlist default visibility, Mixtape remembers its last mix. TS queries read them synchronously via `setting()` after `loadSettings()` at app start.

### Phase 9d — chaos, Superlatives, Not for me, Dig Deeper
SQL/TS verified (tsc, 24 vitest, 14 fixtures incl. two chaos fixtures, 8 smoke scripts, `vite build`, screenshots). **Rust changes uncompiled** — `docs/HANDOFF-PHASE-9D.md` §1.
- **Session chaos score** (summary §3.7): `sessions.chaos` = mean cosine distance between consecutive plays' artist tag vectors (at the owner's tag floor), computed in `compute_sessions.sql` from `_plays`; NULL until an artist pair is tagged. Fixtures: album ride < 0.05, jazz→metal→ambient > 0.9, untagged → NULL. Surfaced four ways: a coherent→jarring dot on every session card, *Most chaotic / Smoothest* sorts, a colour-per-scene **transition chain** on session detail, and a **Chaos** card on the Sessions overview (by year, by time of day, by shape — album rides low, wanders high, as a live sanity check).
- **Superlatives on In Review** (`awardQueries.ts`): twelve period-scoped awards with runners-up — Most Played, Most Skipped, Best Newcomer, Best Comeback (2+ years), Quietest Obsession, Longest Relationship, Obsessive Day, Most Chaotic / Smoothest Session, Best Supporting Artist (`track_credits`), **The Deep Cuts Award** (catalogue penetration), Record of the Period. Unavailable ones say why.
- **Not for me** (`/notforme`, summary §3.3): shown 8+, skipped 85 %+, skip-spree sessions excluded; *Give it a fair shot* (180 d) / *Confirmed not for me* write `recommendation_feedback` under `engine = 'skip_hall'` — the engines' first explicit negative signal.
- **Dig Deeper on the artist page** (`digQueries.ts`): catalogue penetration ("14 of ~42 recordings"), never-played tracks the record already knows (liked / playlists / enriched albums) with per-track and queue-all actions, barely-played tracks, and feature appearances.
- **Data**: `artists.catalogue_tracks` (MusicBrainz recording-count, one browse call per artist) and `track_credits` (recording by ISRC → artist-credit list, additive — `tracks.artist_id` untouched), both filled by new `musicbrainz.rs` functions on the existing 5-minute tick.

### Phase 9e — Ask the Archive (Ollama), Docker, owner feedback on 9d (this build)
SQL/TS verified (tsc, 29 vitest, 14 fixtures, 9 smoke scripts incl. the Ask pipeline against a mock model, `vite build --mode browser`, screenshots served by the production server). **Rust uncompiled** — `docs/HANDOFF-PHASE-9E.md` §1.
- **Ask the Archive** replaces Explore at `/explore` (old lists at `/explore/lists`). `src-tauri/src/llm.rs` is now a real Ollama provider (`llm_status`, `llm_chat`; URL in Settings → Connectors, default `127.0.0.1:11434`). Pipeline in `src/lib/ask.ts`: schema summary → model writes ONE SELECT as JSON → `isSafeSelect` + server-side `assert_read_only` → run → rows back to the model → 2–5 sentence narration. One repair round on SQL errors; "not answerable" is a first-class reply. Every answer shows SQL, rows, timing; answers listing tracks become a playlist or go to the queue; follow-ups carry the last four turns. `OLLAMA_MOCK=1` on the dev server is a canned model for CI.
- **Docker** (`docker/`, `docs/DOCKER.md`): `dev-server.mjs` grew into the headless server — serves `dist/`, `HOST`/`PORT`, `/_health`, `DEEPCUTS_READONLY` (opens the file read-only and refuses writes politely), `OLLAMA_URL` proxy. The container is the *analyst*; the desktop app stays the *collector* (connectors, tokens, the single DuckDB writer). `bridge.ts` uses same-origin when the UI is served by that server.
- **9d feedback:** Settings → Record → **Stored data** (exact file size, estimated bytes per group, rows per table, sources). Crate sections: wrapped strip (no scrollbar), one-click jump vs ⊙ filter, highlight follows the front card, an explanation of how sections are derived, and **re-filing** an artist from the record card (`scene_overrides`, honoured by `compute_insights.sql`, applied immediately by `set_artist_scene`). Obscurity **tier word** beside the number. **Playlists**: ids deduped, 400 ms between 100-URI chunks, and the count Spotify reports is verified and shown when short; **queueMany** paces 250 ms and continues past one-off refusals. **Threads** exclude umbrella/meta tags and any tag on > 20 % of your artists, and gain **decade threads** from `tracks.release_date`. All background timestamps render in the record's zone (`fmtStamp`). **Lyric keyword cloud** on Insights (own SVG spiral layout; click a word → tracks → playlist).

### Phase 9i — owner feedback on 9h.1: correctable metadata, trustworthy matching, FreqBlog, Eras, dedupe, demo
Verified: tsc, 33 vitest, 25 fixtures (+3: export-after-polling dedupe, owner overrides survive rebuild, full demo build), 13 smoke scripts (`smoke-9i.ts`), `vite build`, guard scan. **Rust uncompiled** — `docs/HANDOFF-PHASE-9I.md` §1.
- **Metadata** (`metaQueries.ts`, `MetadataPanel.tsx`; tables `artist_mb_match`, `metadata_overrides`, re-applied at the end of `entity_resolution.sql`; commands `meta_set`, `artist_set_origin`, `artist_mb_candidates`, `artist_set_mbid`).
- **MusicBrainz matching** (`musicbrainz.rs`): ISRC credit → album-title overlap among namesakes → single exact-name hit → else "ambiguous" (no guess). `verify_batch` re-checks older matches and, on a wrong one, discards origin/tags/relations fetched through it. `wikidata.rs::origin_for`: city = area when it's a city, begin-area marked "(born/formed)"; owner rows never overwritten.
- **FreqBlog** (`freqblog.rs`): bare-array `/bulk` body (the 422), per-item billing, `RateLimit-Remaining`, queued items collected later, first reply saved to logs.
- **Eras** (`EraChart.tsx`, `eraStyle.ts`): two bands, gap/palette/fill/height/zoom prefs, hover card, scroll reset only on width change; threads: recent + per-year slots + scene cap, 24 by default (`thread_max`, `thread_per_year`).
- **Crate**: `album_popularity` (Last.fm album.getInfo) + `album_obscurity`; card shows both and "a deep cut in their catalogue".
- **Library → To revisit** (`revisitQueries.ts`), **Roast Me** (`roastQueries.ts`, `Roast.tsx`), **Export everything** (`plays_enriched` view, `migrate::export_record`).
- **Dedupe**: polled plays superseded by extended-export rows on track + start ±10 s in `entity_resolution.sql`; `poll_insert.sql` compares starts too. Before 9i an export imported after polling double-counted every overlap.
- **Demo record**: `demo_events.sql` + `demo_enrich.sql` shared by the app and the dev seed; the app now runs the full pipeline for the demo and rebuilds an out-of-date demo (`DEMO_REV`).
- **Stylus** designed (`docs/STYLUS-SPEC.md`): ListenBrainz-compatible receiver, per-device privacy masks, Docker relay with a pull model.

### Phase 9h — owner feedback on 9g: navigation, one scroller, display size, search, Moods & Forecast, listening abroad
Verified: tsc, 33 vitest (display), 22 fixtures (per-language IDF), 12 smoke scripts (`smoke-9h.ts`), `vite build`, and a Python port of the new Rust SQL guard against its unit-test cases plus every app query. **Rust uncompiled**: `db.rs` guard + `#[cfg(test)] guard_tests`, `lastfm.rs` 30-day refresh, `set_setting` +`home_country`.
- **Nav** (`Shell.tsx`): `PINNED` + `NAV_GROUPS` (Understand, Stories, Act, App), collapsible, persisted in localStorage `deepcuts.nav`, auto-open on the current page. Not for me → Settings tab (`SkipHallPage embedded`); `/notforme` and `/forecast` redirect. Settings tabs follow `?tab=`.
- **One scroller**: `html, body, #root { overflow: clip }`, shell grid `grid-rows-[minmax(0,1fr)]`, `main` scrolls and resets to top on route change. Root cause: the grid row sized to content so body and main both scrolled; `scrollIntoView` could shift the hidden body.
- **Display size** (`display.ts`): Auto/Compact/Cozy/Comfortable/Large via root font size; `autoPx(w, h)` = min of width and height rules; `useViewport()` for EraChart; `max-h-[NNNpx]` lists capped at vh; Library playlist panes bounded.
- **Search**: header → `/explore/lists?q=`; `ExploreSearch` reused atop Ask the archive.
- **Bugs**: guard matched `LOAD ` inside `payload ` → word tokenizer skipping literals/comments; Rising & fading empty because popularity refreshed every 90 days → 30, plus `listenerLandscape()` interim view; lyric IDF per language (`track_lyric_keywords.lang`) + `lyricLanguages()` chips.
- **Moods & Forecast** (`MoodsForecast.tsx`; `dayForecast`, `weekOutlook`, `fronts`, `backtest` in `forecastQueries.ts`): weekday habit (26 weeks) blended 50/50 with the last 14 days; hourly radar, day-parts, likely artists/tracks (station playlist), 7-day outlook with recent-volume trend, warm/cold fronts (28 d vs prior 84 d), backtest hit@10 vs "your top 10" baseline on the last 28 days; stations keep FM frequencies.
- **Listening abroad** (`abroadSummary`, Atlas): play country = conn_country, else a single-country travel zone; trips = same-country day runs with gaps ≤ 3 days and ≥ 30 min; souvenir = trip plays² / all-time plays × 1.5 for local artists; local-artist share vs home; scene lift abroad; *where you listened* map mode; `home_country` override.

### Phase 9g — roadmap: Atlas, Forecast, FreqBlog audio features, scene threads, tuning knobs
SQL/TS verified (tsc, 29 vitest, 21 fixtures incl. three new, 11 smoke scripts incl. `smoke-9g.ts`, `vite build --mode browser`). **Rust uncompiled** — `docs/HANDOFF-PHASE-9G.md` §1.
- **Atlas** (`/atlas`, `originQueries.ts`, `src/assets/world-110m.json`): world map of artist origins shaded by hours (Natural Earth 110m via world-atlas → Natural Earth I projection → alpha-2-keyed path strings, 175 countries, 123 KB, baked offline — no runtime map library); hover card, click → artist list, table twin, "how the map widened" by year.
- **Forecast** (summary §3.2; `forecastQueries.ts`, `ForecastCard.tsx`, `forecast_log` table, `forecast_log_write` command): base rate = last 26 same-weekdays; scene / day-part probabilities; high-confidence calls only ≥ 85 % over ≥ 8 exposures; logged once per local date (write-once, fixture-tested); accuracy = Brier vs climatology skill, per month, on Insights. Verdict withheld under 7 scored days.
- **FreqBlog** (`connectors/freqblog.rs`, `track_features`, `featureQueries.ts`, `SoundSection.tsx`, Services card): free-tier contract from the 9b handoff; ISRC-first `/bulk` in batches of 25, 202/429 handling, monthly counter in `connector_state.detail`, hard stop at 900. Response parsed defensively (`parse_items`, `parse_feat`) — record a real reply as a fixture at first compile. Sound charts only the full-coverage fields (bpm, key, energy, loudness).
- **Scene-family threads** (`sceneWeekShares`, `kind: 'scene'`, `label`): threads on the strongest family per artist, exempt from the coverage ceiling; Eras badges them; export-as-playlist works through `threadTracks`.
- **Tuning** (`group: 'threads'`): `thread_min_weeks`, `thread_share_floor`, `thread_max_coverage`, `thread_scenes`, `skiphall_min_shown`, `skiphall_min_rate` — read live by `genreThreads()` and `skipHall()`; whitelisted in `set_setting`.

### Phase 9f — owner feedback on 9e: move bundles, lyrics v2, scenes as data, playlist sync, Daily Dig
SQL/TS verified (tsc, 29 vitest, 18 fixtures incl. four new, 10 smoke scripts incl. `smoke-9f.ts`, `vite build --mode browser`, a full export → restore round-trip in the harness). **Rust uncompiled** — `docs/HANDOFF-PHASE-9F.md` §1.
- **Move to another computer** (`migrate.rs`, Settings → Record): every table → Parquet in one zip + `manifest.json`; keyring secrets optionally encrypted (XChaCha20-Poly1305, passphrase-derived key). Restore intersects columns by name, backs up current events first, rebuilds under the receiving pipeline, restores secrets to the keyring. `docs/MOVING.md`.
- **Lyrics v2** (`features_rev 2`): `track_lyric_terms` + `track_lyric_keywords` TF-IDF view (fixture: a word in every song is never a keyword); 34 scored themes with weighted cues; `theme_scores`, `valence`, `repetition`, `vocab`, `lang` (11-language function-word detector; English-only lexicons); optional Ollama theming from the transient text (`llm_themes`, `llm_mood`). Old rows are re-fetched a batch at a time; the Insights cloud excludes them so vocabularies never mix.
- **Scenes as data**: `scene_families` (66: the 18 originals + 22 regions + 26 niche styles), `scene_tag_map` (1,087), `scene_origin_map` (180); `compute_scenes.sql` replaces the `VALUES` list; Settings → Tuning → Scenes editor (`SceneEditor.tsx`, `sceneQueries.ts`) with an unfiled-tag queue weighted by hours; Rust/dev-server commands `scene_*`, `recompute_scenes`. All 9e keys preserved so `scene_overrides` still resolve.
- **Crate**: `unsorted` is a real filter (`section IS NULL`); the 400-record cap that hid the last divider is lifted; labels come from `scene_families`.
- **Playlist sync** (`sync.rs`): two passes (all metadata, then items only where never synced or `snapshot_id` moved), per-playlist error isolation, Spotify-made playlists marked `unreadable` (Spotify closed them to third-party apps in Nov 2024 — the actual reason old playlists never appeared: the abort happened at the first one). New columns `owner_id`, `items_synced_at`, `items_snapshot_id`, `sync_error`, `first_seen_at`; Library distinguishes *unreadable* from *partial*.
- **Roadmap**: Daily Dig (date-seeded pick from rediscover / abandoned / back-room pools, queue album, put away), obscurity trajectory (`popularityTrajectory`, `popularityMovers`; artist-page sparkline, *Rising and fading* on Insights). `PIPELINE_REV` → 10.

**Pivoted / dropped in 9a:** Last.fm obsessions export (the obsession isn't in Last.fm's API — read or write; scrape-only, rejected); journal/notes (owner deprioritised); Setlist.fm as next connector (owner chose an audio-features source — see 9b).

---

## 2. Known issues — read this before doing anything else

1. **Everything in the Rust layer is undertested.** Phase 8's `lastfm_wild.rs` compiled and ran on the owner's machine (first real cycle). Phase 9a's Rust — the scheduler reordering and `lastfm_wild_reset` — is **uncompiled**. When the owner reports "X doesn't work", the first hypotheses remain: (a) stale record (should self-heal on `PIPELINE_REV` bump — verify), (b) a genuine Rust bug in that connector/command.
2. **Spotify quota is the binding constraint on the owner's account.** Playlist sync stopped at 7 playlists; polls were being crowded out by enrichment. 9a reorders the scheduler; the *Finish syncing playlists* button re-runs the sync deliberately. 9b lowered the default enrichment ceiling to 100/h and exposed it in Settings.
3. **Heard in the Wild's dedup can only match plays that reached the record.** With quota-starved polling, the owner's own plays were missing from the record, so the temporal check had nothing to catch them against. The dedicated Pano-only Last.fm account is the real defence; the desktop check is the safety net. The Services guard now flags the misconfigured state.
4. **Era defaults come from one listener's benchmark.** 0.04 / 4 / 0.5 / 6 was tuned on the owner's own weekly history and verified here on a structured fixture; genre-thread thresholds (8 % / 3 weeks) were **not** benchmarked. Both are owner-tunable in Settings (eras) / parameters (threads). Threads are per raw tag, so 'psychedelic' and 'psychedelic rock' can produce twin threads — collapsing to scene families is an open choice.
5. **stats.fm has no public API.** Marked experimental; will likely never work as built.
6. **Session-shape rules deserve more fixture coverage** (two were satisfiable by skip-mashing until Phase 6). The short-*playlist*-looping variant of the stuck-repeat class is still unhandled.
7. **The browser harness has no keyring/OAuth/HTTP connectors.** Anything involving sign-in or connector calls is desktop-only; stubs exist.
8. **`Db::assert_read_only` is substring matching.** It tripped in 9a on a semicolon inside a SQL *comment* — do not put prose in query strings. Must be replaced before the LLM "Ask" phase.
9. **Local Rust builds need 10–15 GB free disk**; GitHub Actions is the primary build path. Node 20 deprecation warnings from `actions/*@v4` are cosmetic until Sep 16 2026 — bump to the Node 24 majors when convenient.

---

## 3. What's next

**Read `docs/HANDOFF-PHASE-9I.md`** first, then `docs/HANDOFF-PHASE-9H.md`, `docs/HANDOFF-PHASE-9G.md`, `docs/HANDOFF-PHASE-9F.md`, `docs/HANDOFF-PHASE-9E.md`, `docs/HANDOFF-PHASE-9D.md`, then `docs/HANDOFF-PHASE-9C.md` for what 9b/9c shipped, what must be compiled first, and what remains. `docs/HANDOFF-PHASE-9B.md` still carries the un-started 9b menu items (audio-features connector, dynamic playlists, world map, weekly review + Liner Notes redesign, remaining owner items) and the longer menu after that. Nothing is duplicated here so the two files can't drift.

---

## 5. Operational notes for whoever continues this

- **Always validate SQL changes against the real record before touching Rust.** The workflow that worked throughout this project: edit `.sql` files → run `python3 scripts/validate_sql.py` (real export) or `python3 scripts/seed_dev_db.py` (demo seed) → run `python3 scripts/test_sql_fixtures.py` → only then update the mirrored Rust `include_str!` constants (no rebuild needed, they're just re-read) and the TypeScript query files → `npm test` (vitest) → smoke-test via `npm run dev:browser` against `dev-server.mjs` (`npx tsx scripts/smoke-*.ts`). **CI now runs exactly this on every push** (`test` job in `build.yml`), so a red check means one of those steps regressed.
- **The fixture test suite is cheap insurance.** It already caught two real logic bugs before the owner ever saw them, and one more during Phase 7c (the stuck-repeat detector's first draft flagged deliberate repeat-clicking as a false positive — the fixture caught it in seconds). Phase 8's vitest suite caught the PlayStation bucketing bug on its very first run. Add a fixture test for every new session-shape or attention-detection rule, and a vitest for any pure TS logic.
- **Never put prose in a SQL string.** `assert_read_only` (and the dev-server mirror) reject a `;` anywhere, including in `--` comments. Explain queries in TS comments above the template literal.
- **Heard in the Wild is a separate event class on purpose.** Never move captures into `event_type = 'play'` and never make a core view read `wild_play` rows — the whole point is that the owner's chosen listening and what the world played at them cannot mix. If a feature needs both, join `wild_plays` *to* the record (as `wildQueries.ts` does), never the reverse.
- **Every SQL file in `src-tauri/sql/` is embedded into the Rust binary via `include_str!`** (see `db.rs`). Changing a `.sql` file requires a Rust rebuild to take effect in the compiled app — it does NOT require touching any Rust source code, just a rebuild.
- **Schema migrations use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`** appended to the end of `schema.sql`, applied on every app open. This is how existing owner records upgrade in place without data loss. Follow this pattern for any new column.
- **The owner is engaged and technical enough to run builds and report Rust compiler errors verbatim** — this has been the primary feedback loop for the Rust layer throughout. Ask for exact `cargo`/Actions output, not paraphrases.
- **Respect the copyright boundary already established**: full lyric text is never stored, only derived features (keywords/themes/colors). Don't relax this if extending the lyrics feature.
- **Respect the privacy/local-first boundary**: no telemetry, no cloud calls except to the explicitly listed free APIs (Spotify, Last.fm, MusicBrainz, ListenBrainz, LRCLIB, Cover Art Archive, stats.fm-if-it-ever-works). Any new connector proposal should be free/keyless or use a user-provided key stored in the OS keyring, never hardcoded.

---

## 6. Quick reference — file locations for common tasks

| Task | File(s) |
|---|---|
| Add/change a session shape rule | `src-tauri/sql/compute_sessions.sql` + fixture in `scripts/test_sql_fixtures.py` |
| Add/change an insight detector | `src-tauri/sql/compute_insights.sql` (nightly cache) or `src/lib/insightQueries.ts` (live) |
| Add a recommendation engine | `src/lib/recQueries.ts` |
| Add a new connector | `src-tauri/src/connectors/*.rs` + `pub mod` in `connectors/mod.rs` + commands in `commands.rs` + `generate_handler!` in `lib.rs` + a scheduler tick + a `connector_state` seed row in `schema.sql` + a card in `src/pages/Services.tsx` + stubs in `dev-server.mjs` (see `lastfm_wild` for the complete template) |
| Change the schema | append to `src-tauri/sql/schema.sql` using `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for existing tables |
| Add a Library filter/sort | `src/lib/phase4Queries.ts` (`likedSongs`, `likedFacets`) |
| Add a page | `src/pages/*.tsx` + route in `src/App.tsx` + nav entry in `src/components/Shell.tsx` |
| Add a skin | `src/lib/theme.ts` (`THEMES` array) |
| Add/change a Heard-in-the-Wild dedup rule | `src-tauri/sql/wild_insert.sql` + fixtures `test_wild_*` in `scripts/test_sql_fixtures.py` + `docs/HEARD-IN-THE-WILD.md` |
| Tune era detection | `src/lib/insightQueries.ts` (`ERA_CTES`, `eras`, `eraDiagnostic`) — check the diagnostic panel on Insights first |
| Add a playlist lens or track class | `src/lib/playlistQueries.ts` (`ORDER`, `HEALTH_SQL`, `playlistTracks` kind rules) |
| Add a hygiene/outlier detector | `src/lib/hygieneQueries.ts` + the *Review outliers* panel in `src/pages/Settings.tsx` |
| Add a genre lens | `src/lib/genreQueries.ts` + `GenreBrowser` in `src/pages/Discovery.tsx` |
| Add / change a scene family or tag mapping | Settings → Tuning → Scenes at runtime; built-ins in the Phase 9f block of `src-tauri/sql/schema.sql`; logic in `src-tauri/sql/compute_scenes.sql` |
| Change lyric themes / stop words | `src-tauri/src/connectors/lyrics.rs` (`themes()`, `STOP`) and bump `FEATURES_REV` so rows re-analyse |
| Add an audio-feature chart | `src/lib/featureQueries.ts` + `src/components/SoundSection.tsx`; connector budget in `connectors/freqblog.rs` (`BATCH`, `MONTHLY_CAP`) |
| Change the forecast's window or call threshold | `WINDOW_WEEKS`, `CALL_MIN_P`, `CALL_MIN_N` in `src/lib/forecastQueries.ts` (old logs keep scoring under the rules they were made with) |
| Re-bake the world map | `world-atlas` + `topojson-client` + `d3-geo` one-off script (see HANDOFF-PHASE-9G §3) → `src/assets/world-110m.json` |
| Change what a move bundle carries | `src-tauri/src/migrate.rs` (`SKIP_TABLES`, `SECRET_KEYS`) + the mirror in `dev-server.mjs` |
| Add a unit test for TS logic | `src/lib/__tests__/*.test.ts` (`npm test`); use `@duckdb/node-api` in-memory for SQL fragments as `platformFamily.test.ts` does |
| Change what counts as "attended" | `src-tauri/sql/compute_sessions.sql` (`is_interaction` definition) — **be very careful here, this is the most-tested and most-bug-prone piece of logic in the app** |

---

*End of handoff document. Good luck.*
