# Deep Cuts v3 — Project Summary & Roadmap
**Handoff document — September 11, 2026 (current through Phase 9a)**

> For what to build next, read **`docs/HANDOFF-PHASE-9B.md`** — it is the working handoff. This file is the durable project summary.

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

### Phase 9a — data integrity, eras, playlists (this build)
SQL/TS verified end-to-end here; **Rust changes uncompiled** (scheduler, `lastfm_wild_reset`).
- **Eras fixed.** Root cause: the detector *dropped* eras shorter than 2 months, so on a record whose recent months are varied (adjacent cosine < 0.3) every month became a 1-month era and was filtered out — the timeline ended before 2025. Now a run of consecutive short eras that spans 2+ months becomes its own ("restless") era, an isolated short era is absorbed into its neighbour, the month floor dropped 3 h → 1 h, the current era is flagged **in progress**, and an **"how the boundaries were drawn"** panel under Eras shows per-month hours + similarity so the owner can tune on real data. Reproduced and verified against a synthetic varied 2025–26 tail (`insightQueries.eras`, `eraDiagnostic`).
- **Retention drill-down.** Click any year's retention bar → the artists you found that year who **went quiet** (biggest first, months silent) and who stayed (`retentionDetail`).
- **Playlist intelligence** (`src/lib/playlistQueries.ts`, Library → Playlists rebuilt): totals strip (synced vs expected, **partial-sync detection** with a *Finish syncing playlists* button), sort lenses (most/least played, fewest songs heard, most complete, most gems, most dead weight, longest untouched, biggest, newest), scope (mine/followed) + search, per-playlist completion bars, **per-track classification** — *gem* (a song you love with 15+ plays that this playlist never gets you to), *dead weight* (skipped ≥60 % inside or unplayed 90+ days), *core*, *unheard* — with filter chips, and **"Worth revisiting"** suggestions with plain-English reasons.
- **Heard in the Wild hardening.** `lastfm_wild_reset` purges every capture (and pins/hides) and re-points at a Pano-only account; Services card shows the account and a **misconfiguration guard** — if ≥60 % of captured songs are already in the record, it says so and points to the fix. Setup text now leads with the dedicated-account advice. Feedback messages quote titles (a song called "Shit Talker" produced the message *Hidden shit talker.* — now *Hidden "Shit Talker".*).
- **Poll priority over enrichment** (`scheduler.rs`): enrichment starts only after the first poll, runs on the poll's 20-min cadence offset 5 min *after* it, and skips its tick while the quota pause is active. A missed poll is a permanently lost play; enrichment is retryable forever.
- `PIPELINE_REV` → 9.

**Pivoted / dropped this phase:** Last.fm obsessions export (the obsession isn't in Last.fm's API — read or write; scrape-only, rejected); journal/notes (owner deprioritised); Setlist.fm as next connector (owner chose an audio-features source — see 9b).

---

## 2. Known issues — read this before doing anything else

1. **Everything in the Rust layer is undertested.** Phase 8's `lastfm_wild.rs` compiled and ran on the owner's machine (first real cycle). Phase 9a's Rust — the scheduler reordering and `lastfm_wild_reset` — is **uncompiled**. When the owner reports "X doesn't work", the first hypotheses remain: (a) stale record (should self-heal on `PIPELINE_REV` bump — verify), (b) a genuine Rust bug in that connector/command.
2. **Spotify quota is the binding constraint on the owner's account.** Playlist sync stopped at 7 playlists; polls were being crowded out by enrichment. 9a reorders the scheduler; the *Finish syncing playlists* button re-runs the sync deliberately. If quota is still exhausted daily, the next lever is lowering `budget::ENRICH_PER_HOUR`.
3. **Heard in the Wild's dedup can only match plays that reached the record.** With quota-starved polling, the owner's own plays were missing from the record, so the temporal check had nothing to catch them against. The dedicated Pano-only Last.fm account is the real defence; the desktop check is the safety net. The Services guard now flags the misconfigured state.
4. **Eras are tuned on synthetic data.** The 9a fix is verified against a synthetic varied tail that reproduces the symptom; the owner's real 2025–26 months should be checked with the new diagnostic panel, and `ERA_MONTH_FLOOR_H` / the 0.3 cosine adjusted from what it shows.
5. **stats.fm has no public API.** Marked experimental; will likely never work as built.
6. **Session-shape rules deserve more fixture coverage** (two were satisfiable by skip-mashing until Phase 6). The short-*playlist*-looping variant of the stuck-repeat class is still unhandled.
7. **The browser harness has no keyring/OAuth/HTTP connectors.** Anything involving sign-in or connector calls is desktop-only; stubs exist.
8. **`Db::assert_read_only` is substring matching.** It tripped in 9a on a semicolon inside a SQL *comment* — do not put prose in query strings. Must be replaced before the LLM "Ask" phase.
9. **Local Rust builds need 10–15 GB free disk**; GitHub Actions is the primary build path. Node 20 deprecation warnings from `actions/*@v4` are cosmetic until Sep 16 2026 — bump to the Node 24 majors when convenient.

---

## 3. What's next

**Read `docs/HANDOFF-PHASE-9B.md`.** It carries the committed 9b scope (audio-features connector, dynamic playlists, world map, weekly review + Liner Notes redesign, remaining owner items) and the longer menu after that. Nothing is duplicated here so the two files can't drift.

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
| Add a unit test for TS logic | `src/lib/__tests__/*.test.ts` (`npm test`); use `@duckdb/node-api` in-memory for SQL fragments as `platformFamily.test.ts` does |
| Change what counts as "attended" | `src-tauri/sql/compute_sessions.sql` (`is_interaction` definition) — **be very careful here, this is the most-tested and most-bug-prone piece of logic in the app** |

---

*End of handoff document. Good luck.*
