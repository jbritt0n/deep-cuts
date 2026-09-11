# Deep Cuts v3 — Project Summary & Roadmap
**Handoff document — September 11, 2026 (updated for Phase 8, same day)**

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

### Phase 1 — Foundation
Tauri shell, DuckDB with bundled JSON/Parquet extensions, in-app import (drag-and-drop the Spotify export zip, dedupe on ts+uri+ms_played), entity resolution (canonical artist/track/album IDs, alias merging for renamed artists), sessions v2 (adaptive gap detection: 30/45/60 min; ten session shapes; SES-01–10 metrics), demo mode, portable mode, single-instance lock. Dashboard, Explore/search, Artist/Track/Album/Day/Month pages.

**Verified on owner's real data:** 99,822 plays, 5,704 hours, 11,293 canonical artists, 42,942 tracks, Feb 2016–Sep 2026. Import completes in ~4–9s; full rebuild ~2s.

### Phase 2 — Live & connected
Spotify PKCE OAuth (loopback `127.0.0.1:8888`), quota-aware client (honors `Retry-After`, backs off, pauses on `QUOTA_EXCEEDED` until midnight), recently-played poller (every 20 min, from system tray), liked-songs and playlist sync, lazy enrichment (release dates, real durations, ISRCs). Last.fm connector (tags + similar-artist graph). MusicBrainz connector (MBID resolution + tags, no key, 1 req/sec). Services screen with per-connector cards.

### Phase 3 — Insights, Discovery, Playlists
Behavior-only insight detectors: eras, obsessions (with half-life), artist lifecycle/comebacks, skip forensics, seasonality, weekday/weekend personas + commute signature, 3AM canon, Year-in-Review (now generalized — see Phase 3b). Recommendation engines (REC-01–05): adjacency (Last.fm graph), tag affinity, structural gaps (album loyalty, underserved taste, forgotten favorites, one-track wonders), side projects (MusicBrainz relations), release radar. Discovery inbox with accept/dismiss feedback (90-day suppression). Playlist creation via Spotify API (private by default, visibility toggle), "Make playlist" on every list in the app, Radar auto-playlist. HTML export for Year-in-Review.

### Phase 3b — Custom time periods, top-N, curated lists
Unified "In Review" page: any year, any month, last-30-days, or custom date range — replaces the single Year-in-Review page. Expandable top-5/10/25/50/100 everywhere. Playlist maker got a suggestion/replacement flow and an "add more" search pane. Curated playlists (Rediscover, B-sides, Never-skip-rarely-played, Played-once, Openers). Era names generated from behavior (mood + season + lead artist).

### Phase 4 — Achievements, moods, drift, library, blend
Achievement badges (bronze/silver/gold, 11 total). Album completeness detector (configurable threshold, day/session scope). Mood-of-day map (10 weekday/weekend × day-part "stations" with lift-based artist ranking). Taste-drift map (cosine similarity + classical MDS layout of years). Half-life explorer. Compare-two-periods page. Library section (liked songs/albums/artists with play stats, playlists with in-playlist play counts, prune lists for dead weight). Blend feature (import a friend's export, aggregated separately, overlap + mutual recommendations + blend playlist). Share-card PNG export (canvas-rendered, local only). Lyric themes via LRCLIB (derived keywords/themes only — **full lyric text is never stored**, by design, for copyright reasons).

### Phase 5 — Themes, Liner Notes, hygiene
Ten visual skins (CSS variables + a mutable JS color object `C` that SVG charts read directly, since SVG can't use `var()` in all contexts). Liner Notes — a weekly digest composed entirely from computed facts (no LLM yet; this is the seam for one later). Milestones (INS-11: play-count/hour thresholds, anniversaries, records broken, streaks) recomputed on every rebuild. Artist merge tool (fold duplicate artist IDs together, reversible). Nightly job (03:30 local): full rebuild + Parquet backup, keeps 14 days. Monthly Radar playlist refresh from accepted recommendations.

### Phase 6 — Album art, tests, CI polish
Cover Art Archive integration (via MusicBrainz release-group lookup) + Spotify's own art URLs feed album collages and a "Record shelf" on the dashboard. **SQL fixture test suite** (`scripts/test_sql_fixtures.py`) — this caught two real bugs before the owner ever saw them (album-ride and discovery-run shape rules were both satisfiable by pure skip-mashing with no actual listening). GitHub Actions release job (tag `v*` → attaches all installers to a GitHub Release). `docs/SETUP.md` written.

### Phase 7 — Scenes, earworms, travel, mixtapes, library depth
**This is the phase where real compilation and real-world testing began**, surfacing several bugs (see §2).

- Multi-timezone support: Spotify's per-play `conn_country` field maps to IANA zones (single-zone countries only) so the owner's Istanbul summers get Istanbul local time automatically; manual date-range overrides in Settings for anything else.
- Scenes: tag-family clustering (afrobeat/Ethio-jazz/zamrock → "afro", Turkish, Japanese, post-punk, etc.) plus artist-origin-based fallback. Scene phases detected the same way as obsessions (weekly spike vs 52-week baseline).
- Earworms: calibrated against the owner's actual "Earwormz" Spotify playlist (26 known songs). Key insight from calibration: earworms are **not** burst-listening — they're modest play counts (7+) recurring across many distinct months over multiple years, played standalone (not inside album rides), almost never skipped. Feedback loop (accept/dismiss) reuses the recommendation_feedback table.
- Nightly insights cache (`insights` table) — obsessions, scene phases, comebacks, earworms all precomputed, feeding a "Fresh insights" row on the dashboard.
- Mixtape builder (Discover page): slider-based blend of adjacency/tag-affinity/ListenBrainz/library-gap engines, builds a preview playlist.
- ListenBrainz connector (free, open, collaborative-filtering similar artists) and MusicBrainz-based artist-origin lookup.
- Library expanded: Followed playlists (surfaces "lost" playlists you rarely revisit, with your personal "gems" highlighted), Made-by-Deep-Cuts tab (so Radar is actually findable), richer liked-song filters (year liked, tag, decade, artist, never-in-a-playlist, min plays) and sorts (longest-since-played, momentum).
- Error boundary added around every page (a crash on one page no longer blanks the whole app — this was a real bug the owner hit).
- **Auto-rebuild on version upgrade**: the core now stamps the record with a `PIPELINE_REV` constant; when a newer build opens an older record, it automatically reloads timezone data and reruns the full rebuild (entities → sessions → milestones → insights) rather than silently leaving caches stale. This was added specifically because the owner hit three separate "feature X shows nothing" bugs that all traced back to the same root cause: new tables/logic existing in code but never having been populated on an existing record.

### Phase 7c (this handoff) — bug fixes from live testing
- **Playlist sync bug, found and fixed**: `sync_now("spotify")` never called `sync_playlists` — it only ran in the daily background tick, so the owner's own Spotify playlists never appeared in Library even though liked songs (same button, different function) did. Fixed; followed playlists now also fetch up to 300 tracks each.
- **Services page crash, found and fixed**: an unrecognized connector row (or missing `extra` field) threw during render with no error boundary, blanking the entire app and blocking navigation. Fixed with (a) an `ErrorBoundary` component now wrapping every route, and (b) defensive fallbacks in the Services page for unknown connectors.
- **Attention-detection bug, found and fixed**: this is the most important fix in this drop. A play's `start_reason` of `"unknown"` (which is Spotify's normal label for ordinary autoplay in exported data) was being counted as a genuine user interaction. This meant a short track looping to natural completion for hours (owner's real example: **B.B. King – "So Excited", 229 plays, 226 of them in one 112-minute unattended session** on Dec 29, 2024) read as fully "attended" listening. Root cause fixed: the interaction whitelist is now an explicit allow-list of real actions (`clickrow`, `clickside`, `remote`, `appload`, `backbtn`, `fwdbtn`, `playbtn`, `trackerror`) rather than "anything not literally `trackdone`". **Also added:** a `stuck_repeat` flag on sessions — 8+ consecutive natural completions of the *same track* with zero real clicks among them — surfaced for exactly this class of outlier, deliberately excluding genuine repeat-button mashing (which has real clicks) so it doesn't false-positive. New regression test `test_stuck_repeat_short_track` covers both cases. **This needs a full rebuild to take effect on the owner's existing record** — the auto-rebuild-on-upgrade mechanism should handle it, but confirm after the next install.

### Phase 8 — Heard in the Wild, owner's fixes, tests & CI gating
Built against the four advisory documents in `docs/recommendations/` plus two owner ideas (Shazam/Now Playing capture; discovery by genre). SQL + TS validated end-to-end here; **Rust additions are uncompiled** (see §2.1 — same status as every previous phase's Rust).

- **Heard in the Wild** (owner idea, reshaped). Neither Shazam nor Google's Pixel *Now Playing* has a history API, but both scrobble to Last.fm through a phone-side scrobbler (owner uses **Pano Scrobbler**). A new connector (`connectors/lastfm_wild.rs`, reusing the Last.fm key) imports those scrobbles every 30 min as a **separate event class** `event_type = 'wild_play'`. Every core view filters `event_type = 'play'`, so captures are invisible to sessions, streaks, insights, totals and records *by construction* — verified by the fixture `test_wild_never_touches_core_record` and the smoke invariant `plays_resolved = events − wild_plays`. **Dedup against the owner's own Spotify playback** happens at ingest (`sql/wild_insert.sql`): a capture is dropped if a primary play of the same artist was running when it was stamped — same song within ±120 s of the play interval (title match is loose so Google's "(feat. …)" titles still match), or any same-artist capture strictly inside the interval. Handles the export's END-of-play stamps and the poller's START stamps correctly; idempotent on re-import. A `since` date (defaults to setup day) stops an old main-account history being mistaken for captures. New page `/wild` (never-streamed vs already-yours, hour/weekday shape, month trend with "new" highlighting, artists you keep running into, pin/hide/Add-to-Radar), Services card with Pano setup steps. Per-app origin (Shazam vs Now Playing) is **not recoverable** from Last.fm; both land in one bucket. Design note: `docs/HEARD-IN-THE-WILD.md`.
- **Owner's §3 items delivered**: Earworms moved from Discovery to a Library tab (§3.3); session cards now show the date and top two artists, the explorer has *Oldest first* and an artist/track-in-session search (§3.4); the dashboard heatmap has a scope picker — last 12 months or any calendar year (§3.5); a **Review outliers** panel in Settings lists stuck-repeat sessions with one-click *Mark unattended*, short tracks with disproportionate single-day spikes, plays longer than their song, and a six-number integrity strip (§3.6).
- **Discovery by genre** (owner idea): a *Browse by genre* card on Discover — every tag your artists carry, sized by your hours; pick one to see your library in it and, via similar-artist edges seeded from those artists, artists you don't own in the same genre (`genreQueries.ts`). Coverage of the second lens is bounded by the similar-artist graph, since tags are only fetched for owned artists.
- **Code health**: `vitest` added (13 tests; the `PLATFORM_FAMILY` test **immediately caught a real bug** — PlayStation strings arrive as `Partner playstation4 …` and were bucketed as TV/speaker; fixed by reordering the CASE). `likedSongs()` filters now use `$n` binding instead of manual quote-escaping (§1.1 of the synthesis). `Db::assert_read_only`'s substring-matching limitation is documented in `db.rs` ahead of the LLM phase (§1.2). Three new SQL fixtures (10 total, all green).
- **CI**: `build.yml` now has a ~2-minute `test` job (tsc + vitest + SQL fixtures + all four smoke scripts against the demo-seeded dev DB) on every push and PR; the 40-minute Rust builds run only for `v*` tags and manual dispatch, gated on tests (Kimi T1). `PIPELINE_REV` bumped to 8.

**Not done from the §3 list** (carried into §3 below): album art plumbing (§3.1) and the Library playlist split by owner (§3.2) — both need Rust-side changes (Spotify artist images are fetched and discarded; owner IDs need real-data verification) and were deprioritised behind items that could be verified here.

---

## 2. Known issues — read this before doing anything else

1. **Everything in the Rust layer is undertested.** It was written against library documentation/source and validated by type-checking + the borrow checker, but the actual runtime behavior of Spotify OAuth, playlist creation, and every connector has only been exercised once, briefly, by the owner. Expect bugs. When the owner reports "X doesn't work," the first two hypotheses should always be: (a) the record is stale and needs a rebuild (should now self-heal per the Phase 7 fix, but verify), or (b) a genuine Rust bug in the specific connector/command involved.
2. **stats.fm has no public API.** The connector exists and is marked "experimental" in the UI, but it will likely never work as built. Either wait for stats.fm to publish something, or drop it.
3. **Album-ride / discovery-run shape rules were buggy until Phase 6's fixture tests caught them** (both were satisfiable by skip-heavy sessions with no real listening). Fixed, but this is a signal that the ten session-shape rules deserve more fixture coverage — there are likely more edge cases like this.
4. **The "So Excited" class of bug (stuck-repeat) is fixed for the single-track-looping case, but the broader "unattended time misclassified as attended" problem may have other unhandled variants** — e.g., a short *playlist* (not a single track) looping. Worth a targeted fixture test.
5. **Recent eras/insights appearing empty is very likely the stale-record symptom**, not a real absence of data — confirmed in the dev/test database that eras compute correctly through March 2026. If the owner still sees this after Phase 7c's auto-rebuild fix takes effect, treat it as a fresh bug, not a repeat of the known one.
6. **The browser dev harness (`dev-server.mjs`) has no keyring, no OAuth listener, and no real HTTP connectors** — anything involving Spotify sign-in, Last.fm/MusicBrainz/ListenBrainz calls, or playlist creation can only be tested in the actual compiled desktop app. Don't waste time trying to make these work in the harness; stub them clearly (as already done) and move on.
7. **GitHub Actions build minutes**: each full build (Linux + Windows) uses roughly 40 minutes of the free 2,000/month private-repo allowance. Not urgent, but worth knowing if release cadence increases.
8. **Phase 8 Rust is uncompiled.** `connectors/lastfm_wild.rs`, the `lastfm_wild_*` commands, the `get_connectors` extras and the scheduler tick follow the stats.fm/Last.fm patterns line-for-line but have never been through `cargo`. First build will be the real check; report errors verbatim. Two spots most likely to need a touch: `chrono::NaiveDate::and_hms_opt(..).unwrap().and_utc()` (needs chrono ≥ 0.4.31 — Cargo says `"0.4"`, fine) and the `IndexMut` writes into the `detail` JSON (`d["backfillDone"] = …` — safe because `detail()` always returns an object).
9. **Heard in the Wild has no real-data pass yet.** The dedup rule is proven on fixtures and the demo record, not on the owner's account. Two things to watch after the first real sync: (a) the *dropped* counter on the Services card should be low if Pano has Spotify turned off, and high if it doesn't — a quick way to confirm the phone-side setup; (b) a *genuine* ambient capture of an artist you happened to be streaming at that exact moment will be dropped (by design — one speaker, one song). Deliberate false negatives are the safe direction for the metrics.
10. **Local Rust compilation needs 10–15 GB free disk** for the bundled DuckDB build; the owner hit "no space left on device" once already. `docs/SETUP.md` documents the prebuilt-DuckDB shortcut and `CARGO_TARGET_DIR` relocation as workarounds. GitHub Actions sidesteps this entirely and should remain the primary build path.

---

## 3. Immediate next steps (start here)

Two owner-requested items from the last round remain, plus the verification pass Phase 8 needs:

1. **Verify Phase 8 in the compiled app** — first real `cargo` build of `lastfm_wild.rs`; then Services → Heard in the Wild → Set up → Sync now, and check the *dropped* counter and the `/wild` page against what the phone actually captured (see §2.9). Confirm the auto-rebuild ran (`PIPELINE_REV` 7 → 8) so the `wild_plays` view and the `lastfm_wild` connector row exist on the owner's record.
2. **More album art / artist photos throughout the app** (carried from Phase 7c §3.1). Wire `albums.image_url` and add `artists.image_url` fed by the Spotify artist objects enrichment already fetches but discards, into artist/track/album headers, Library lists, session cards, era cards, mood stations. Mostly plumbing; Rust touch is small (keep the artist image in `enrich_track_from_json`).
3. **Library: split Playlists into by me / by Spotify / by others** (carried from §3.2). `playlists.owner_is_me` exists; Spotify-editorial detection needs the `owner.display_name === "Spotify"` pattern verified against real sync data first.
4. **Genre browse, second half**: the *new to you* lens is only as wide as the similar-artist graph. Once Last.fm/ListenBrainz have synced more seeds it fills in on its own; if it still looks thin, fetch tags for the *related* artists too (a small extension of `lastfm::enrich_tags` to `artist_relations.related_name`) so tag-carrying non-owned artists become first-class candidates.

---

## 4. Phase 9 candidates (from `docs/recommendations/NEXT-DROP-RECOMMENDATIONS.md`, not yet started)

The four advisory documents in `docs/recommendations/` were reviewed and synthesised on Sep 11 2026; Phase 8 took the items that could be verified without a Rust toolchain. Remaining menu, roughly by value-to-effort. Section numbers refer to that synthesis.

**Foundation (do these first — cheap, and the LLM phase depends on two of them)**
- **Attended-only aggregate lens** (Kimi T4, synthesis §1.6) — the Attentive lens exists as a *filter*; make `is_interaction` a first-class filter in `sessionQueries.ts` and recompute streaks/records both ways (Kimi R3). Biggest analytical payoff still outstanding from the "So Excited" fix.
- **Structured `{code, message}` error envelope** at the Rust boundary (Kimi T2) — `CmdResult<T> = Result<T, String>` today; the LLM phase must distinguish token-expired / Ollama-unreachable / quota / DB-busy. Retrofit cost grows with every command added.
- **Chart memoization + loading skeletons** (Kimi T3) — no `useMemo` in `components/charts/`, no skeletons anywhere; `useAsync` re-runs on every 20-min poll tick.
- **Rust connector parse-test fixtures** (Kimi T5) — record one real JSON response per endpoint (now including `user.getRecentTracks`) and unit-test the parsers. Targets the least-proven layer with zero network.
- **Replace `Db::assert_read_only`'s substring check** with a real statement classifier *before* the LLM "Ask" phase feeds model-written SQL through it (documented limitation in `db.rs`).
- **One documented restore drill** for the nightly Parquet backups (Kimi T7).

**Features (highest value, not yet built)**
- **Record Hygiene page** (synthesis §2.1.1) — Phase 8's *Review outliers* panel is the first slice. Remaining: session surgery (split/merge, bulk attention edits), import diffing, **ISRC-based duplicate-recording detection** (`tracks.isrc` is populated by enrichment and read by nothing).
- **Listening journal / notes** keyed by `(entity_type, entity_id)`, feeding Liner Notes (§2.1.2). Cheap, additive.
- **Blind spots + bubble score** (§2.1.3) — what you've *never* touched: countries, decades, tags, labels.
- **Playlist health** (§2.1.4) and **playlist overlap graph** (§2.1.6) — the latter is the smallest, highest-value piece of the graph initiative and should ship *before* any force-directed work.
- **Query console / local API** (§2.1.5) — gated on the `assert_read_only` replacement above.
- **Setlist.fm connector** (§2.2.7) — fills the existing `concerts` table; lowest-effort connector left.
- **Artist family tree** (§2.2.8) over `artist_relations` — new presentation, no new data.
- **Audio features** via FreqBlog *or* a one-time AcousticBrainz dump (§2.2.9); Discogs for a label dimension (§2.2.10). Verify current API surface before committing (Kimi R5).
- **Command palette (Ctrl+K)** (Kimi R2) — ~21 pages now; search SQL exists.
- **Heard in the Wild, next**: a "heard near a show" join once Setlist.fm lands; a Day-page strip using `wildOnDay()` (query exists, UI not wired); optional monthly "new to you" digest through the Liner Notes composer.
- New in the synthesis and still open: aggregated album-loyalty timeline, silence report, device hand-off patterns, explicit-content ratio over time, generative year-mosaic poster, local notification digest, passphrase-protected export (§2.3).

**Still gated**
- **LLM layer**: unchanged — do not start until the owner confirms Ollama is reachable at `http://127.0.0.1:11434`. `llm.rs` stub and `Provider` trait exist behind `--features llm`.
- **Auto-update**: needs a signing-key custody decision.
- **Open design decisions** in `docs/PHASE1-NOTES.md` §1 (attention-gap default, comfort-loop minimum, eras' 0.3 cosine threshold, …) are still marked "say the word to revert" — an owner pass confirming each would let the hedge comments come out of the SQL (synthesis §1.5).

**Explicitly rejected** (see the recommendations docs for why): rusqlite/WAL pragmas (wrong engine — DuckDB), React Query migration, Rate Your Music, Apple Music API, any cloud sync, storing lyric text, a single "everything" graph view.

---

## 5. Operational notes for whoever continues this

- **Always validate SQL changes against the real record before touching Rust.** The workflow that worked throughout this project: edit `.sql` files → run `python3 scripts/validate_sql.py` (real export) or `python3 scripts/seed_dev_db.py` (demo seed) → run `python3 scripts/test_sql_fixtures.py` → only then update the mirrored Rust `include_str!` constants (no rebuild needed, they're just re-read) and the TypeScript query files → `npm test` (vitest) → smoke-test via `npm run dev:browser` against `dev-server.mjs` (`npx tsx scripts/smoke-*.ts`). **CI now runs exactly this on every push** (`test` job in `build.yml`), so a red check means one of those steps regressed.
- **The fixture test suite is cheap insurance.** It already caught two real logic bugs before the owner ever saw them, and one more during Phase 7c (the stuck-repeat detector's first draft flagged deliberate repeat-clicking as a false positive — the fixture caught it in seconds). Phase 8's vitest suite caught the PlayStation bucketing bug on its very first run. Add a fixture test for every new session-shape or attention-detection rule, and a vitest for any pure TS logic.
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
| Add a hygiene/outlier detector | `src/lib/hygieneQueries.ts` + the *Review outliers* panel in `src/pages/Settings.tsx` |
| Add a genre lens | `src/lib/genreQueries.ts` + `GenreBrowser` in `src/pages/Discovery.tsx` |
| Add a unit test for TS logic | `src/lib/__tests__/*.test.ts` (`npm test`); use `@duckdb/node-api` in-memory for SQL fragments as `platformFamily.test.ts` does |
| Change what counts as "attended" | `src-tauri/sql/compute_sessions.sql` (`is_interaction` definition) — **be very careful here, this is the most-tested and most-bug-prone piece of logic in the app** |

---

*End of handoff document. Good luck.*
