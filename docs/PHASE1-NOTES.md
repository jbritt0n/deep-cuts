# Phase 1 — decisions, deviations, seams

## Decisions I made that the spec left open (say the word to revert)
1. **Attention detection (new).** A play is *attended* when you interacted (click / skip / back / app open / stop) within the last `attention_gap_min` minutes (default 120, Settings). Sessions carry `attended_ms / unattended_ms / attention ∈ {active, drifting, unattended}`. The UI's default lens is **Attentive**; "Everything" is one click away. This is what fixes the 2016–17 all-night skew.
2. **Comfort loop needs ≥ 3 plays.** Single plays trivially matched "one track ≥ 40%" (2,162 → 99 sessions).
3. **Completion fallback ladder** (SES-01): real `duration_ms` → longest natural-finish play of that track (`duration_ms_est`, covers 87% of tracks before any enrichment) → `1 − skip_rate`. Each session records which one it used.
4. **No ICU extension.** Local time comes from a `tz_offsets` table Rust fills from the IANA database (`chrono-tz`), joined in SQL. Avoids a 30–60 min cmake build of DuckDB. One zone per record (Settings); DST-correct.
5. **Importer is SQL.** DuckDB reads the export JSON directly (`read_json`); Rust only unzips and loops with progress. Two bugs the real data caught: `read_json` drops the `Z` on timestamps (everything shifted +5 h), and Spotify's 2020–22 exports contain 2,117 exact duplicate rows.
6. **Demo lives in its own file** (`demo.duckdb`), so `events` in the real record is truly append-only.
7. **Left-rail navigation and a persistent "listening lens"** in the header instead of v1's top nav — a desktop app, not a website. v1's tokens, dial, heatmap and voice are kept.
8. **Insights + Year in Review shipped early** as live queries (no nightly `insights` cache yet — that table stays for Phase 3 when the scheduler exists). Eras use cosine ≥ 0.3 over top-40 artist shares (spec's 0.6 produced one era on this record); obsession lift uses a trailing 13-week baseline; comebacks need 180 days of silence.
9. **Sessions page shipped in Phase 1** (spec had SES-11…14 in Phase 3) because the owner asked for more session analytics; the pure-SQL part was cheap once sessions v2 existed.

## Deviations from the build prompt
- `sessions.start_at/end_at` and `plays_resolved.played_at` are naive **local** TIMESTAMPs; `events.occurred_at` / `plays_resolved.played_at_utc` are the instants. Documented in schema.sql.
- Search matches artist aliases, so "chvrches" finds the merged identity.

## Seams left for later phases
- `artists.mbid`, `artist_aliases`, `artist_tags(source, weight)`, `artist_relations` — CON-06/07/12.
- `tracks.track_number` — SES-07 Spearman version once album track lists exist.
- `created_playlists.rationale / llm_model`, `recommendation_feedback` — Phase 3/4.
- `src-tauri/src/llm.rs` behind `--features llm`.
- `Db::assert_read_only` is the validator the Ask feature will reuse.
- `plays_normalized` normalises start-of-play sources by adding `ms_played` — the poller / Last.fm / stats.fm just need a `source` value.

## Known limits
- Windows build must happen on Windows (no cross-compile).
- The browser dev harness can't drag-drop real paths; paste a path.
- Session detail after a rebuild: ids change, so old deep links 404 gracefully.

## Phase 2 notes
- **Spotify client ID is yours** (development-mode apps are per developer account). The Services card walks through creating it. Stored in the keyring, never in the DB.
- **Poller dedupe** compares end-of-play instants in `plays_normalized` with ±2 s tolerance (`sql/poll_insert.sql`), so a phone play that later arrives in a new export isn't counted twice.
- **Enrichment budget**: ≤ 200 calls/hour, 25 per 10-minute tick, most-played tracks first; liked-songs sync enriches for free (full track objects); `QUOTA_EXCEEDED` pauses until midnight.
- **Last.fm similar artists** are cached in `artist_relations` as `relation_type='similar'` with `related_mbid = '<mbid or name:x>|<match>'` — the REC-01 adjacency engine reads this directly.
- **MusicBrainz** resolves MBIDs (score ≥ 90 and exact name, or ≥ 95) into `artists.mbid`; entity resolution keeps them across rebuilds via `enriched_at`.
- **Tray**: closing the window hides it; Quit is in the tray menu. This is what keeps the poller alive.
- Untested here: the Rust in `spotify/`, `connectors/`, `scheduler.rs`, `tray.rs` was written against the crate APIs but not compiled in this environment — expect a first-build fix pass.

## Phase 3 notes
- **Engines are SQL** in `recQueries.ts`, so they run against whatever the connectors have cached; each degrades to "unavailable — connect in Services" independently (DIS-04). Structural gaps work with zero services.
- **Scoring**: adjacency = Σ match × log(1+hours) over seeds, ×(1 + 0.5·accepts); tag affinity routes through similar-artist edges whose seed carries a tag you over-index on; dismissed keys hidden 90 days (DIS-03).
- **Radar** adds the top 3 Spotify search hits for the recommended artist (API-06 caps search at 10). Private playlist created on first use.
- **Playlist visibility** is a toggle in the preview, default private (owner decision 3).
- **stats.fm** API isn't formally versioned; `statsfm.rs` reads fields defensively and stops paging when a whole page is already known. Verify against your account on first sync.
- **HTML export** is rendered in TypeScript from the same data as the page; Rust only writes the file where you choose.
- Verified here: every engine on real data with seeded synthetic graph/tag rows; HTML export; feedback round-trip. Not compiled: the new Rust (`playlists.rs`, `statsfm.rs`, MB relations).

## Phase 3b notes
- Era names are deterministic from behaviour: late-night share ≥ 10% → "Late nights with X"; skip ≥ 18% → "Restless"; novelty ≥ 55% → "Wide-eyed"; dominant non-steady shape otherwise; else a seasonal template. The top tag appears when tags exist.
- Review periods: `to` is exclusive; ≤ 62-day spans chart by day, longer by month. Custom ranges come from the URL (`#/review?from=…&to=…`) so they're shareable/bookmarkable.
- Playlist suggestions are the next-best tracks by hours from the same period (or curated pool); search adds anything from the archive.
- Album art: Cover Art Archive (by release-group MBID) and Spotify `albums.image_url` are both available once connectors run; collage components come with the desktop build.

## Phase 4 notes
- **Lyrics**: LRCLIB (free, no key). Text is featurised on-device (top-40 keywords, ~20 literal theme dictionaries, colours, word count) and discarded; only derived features persist in `track_lyric_features`. Off by default (Settings → Lyric themes). This is the input the Phase 6 LLM will use for theme playlists — never raw lyrics.
- **Blend** stays in `blend_plays` (aggregates only); it never enters `events`, so your record stays yours. Blend playlist = harmonic mean of both play counts.
- **Album completeness** uses Spotify `total_tracks` when enriched, else distinct tracks ever played — early numbers lean generous, as the page says.
- **Mood map** ranks artists by lift (share in slot ÷ overall share) and picks each slot's shape the same way, so "discovery run" doesn't win everywhere just by being common.
- **Taste drift**: cosine over top-200 artist share vectors per year; 2-D layout is classical MDS via power iteration in TS.
- **Share cards** render on a canvas with the bundled fonts; saved via a dialog in the app, downloaded in the browser harness.
- **Achievements** are computed live; the `milestones` table is still the seam for a nightly cache + first-earned dates.

## Phase 5 notes
- **Skins**: Tailwind colours are CSS variables; SVG charts read the mutable `C` object from `lib/theme.ts` (SVG presentation attributes can't take `var()`). Theme id lives in the filter context so pages rerender on change. Light themes flip `color-scheme`.
- **Liner Notes** is rules-only prose; each sentence maps to a fact-sheet row. The LLM seam: rewrite `composeNotes` output with the facts as the only source, then verify every number appears in the facts (spec INS-13 post-check).
- **Milestones** are recomputed from scratch on every rebuild; `seen` survives via a temp table keyed on (type, subject, value). Anniversaries only for artists played in the last 180 days.
- **Merges** live in `artist_merges` and are applied in entity resolution; album and local-track keys are re-derived under the surviving id so albums/tracks merge too.
- **Nightly job** at 03:30 local: rebuild, Parquet snapshot to `backups/`, keep 14. **Radar refresh**: monthly, adds two tracks per accepted recommendation not already handled.

## First compile (GitHub Actions, Sep 11 2026)
Three errors, all fixed: `Mb::get` visibility; `urlencoding::encode(&format!(..))` borrowing a temporary (musicbrainz.rs, coverart.rs); non-exhaustive match on `duckdb::types::Value` (db.rs). No errors elsewhere in the crate.

## Phase 7 notes
- **Playlist sync bug**: `sync_now("spotify")` never called `sync_playlists`; it does now, and followed playlists fetch up to 300 items each.
- **Travel zones**: `country_zones` maps single-zone countries → IANA zone; `tz_overrides` holds manual ranges; `load_tz_offsets` now materialises offsets for every zone the record needs; entity resolution picks override → country → home and ASOF-joins by zone. Migrations (`ALTER TABLE … ADD COLUMN IF NOT EXISTS`) upgrade existing records in place.
- **Earworms** are not bursts. Calibrated on the owner's list: modest plays (8–40), many distinct months across years, played alone (outside album rides), ≤ 15% skips. Score in `compute_insights.sql`; 11 of 21 labelled earworms land in the top 250 of 1,221 candidates. Feedback via `recommendation_feedback` (engine 'earworm').
- **Scenes** use a fixed tag-family vocabulary plus artist origin country; `compute_insights.sql` writes `artist_scene` and detects weekly scene phases.
- **Insights cache** now real: obsession, scene_phase, comeback, earworm rows nightly; `surfaced` survives rebuilds.
- **ListenBrainz** uses the labs similar-artists endpoint (no key); relations stored as `lb_similar`. **Origin** comes from MusicBrainz artist `area`/`country`.
- Session overrides match on local start ±5 min so they survive rebuilds.

## Phase 8 notes (Sep 11 2026)
- **Heard in the Wild is its own event class.** `event_type = 'wild_play'`, never `'play'`. Considered and rejected: a `source`-class column with filters everywhere (invasive, one missed query leaks captures into totals). With a separate type, every existing `WHERE event_type = 'play'` does the isolation for free. Proven by `test_wild_never_touches_core_record` and the smoke invariant `plays_resolved = events − wild`.
- **Dedup is temporal, not textual.** Last.fm exposes no scrobbling client, so "was this my Spotify?" can only be answered by asking whether a primary play of the same artist was running at that instant. ±120 s tolerance around the interval; title match loose (parenthetical / " - Remaster" suffixes stripped, containment allowed); a same-artist capture strictly inside the interval is dropped even if titles disagree. False negatives (a genuine capture during your own stream of that artist) are accepted as the safe direction. See `docs/HEARD-IN-THE-WILD.md`.
- **Clock semantics matter twice.** The export stamps END of play, everything else START; `wild_insert.sql` derives the play interval per source, and the fixture `test_wild_start_stamped_sources_and_idempotency` guards the poller case.
- **`since` defaults to setup day.** An owner's main Last.fm account has years of Spotify scrobbles; without the floor, the backfill would classify all of it as "overheard". Backfill is bounded `[since, oldest capture)` and runs a few pages per tick.
- **Per-app origin is unrecoverable** (Shazam vs Now Playing) — one bucket, stated in the UI rather than faked with a heuristic.
- **Owner §3 items** 3.3–3.6 done as specified; 3.1/3.2 deferred (Rust-side).
- **Genre browse**: two lenses over one tag; the "new to you" lens routes through similar-artist edges because tags exist only for owned artists (same constraint `tagAffinity` already works around). Fallback text says so rather than showing an empty card.
- **vitest caught a real bug on first run**: `PLATFORM_FAMILY` bucketed `Partner playstation4 …` as TV/speaker because `partner%` preceded the console rule. Reordered. This is the argument for testing SQL fragments through an in-memory DuckDB rather than by string inspection.
- **CI**: tests on every push, Rust builds only on tags / manual dispatch, gated on tests. `scripts/seed_dev_db.py` exists so CI has a database without the owner's export.
- **Session cards**: top artists are computed only for the 40 rows on the current page (CTE over `page`), not for all sessions, so the list stays fast on the 99k-play record.
- **`likedSongs` filters** now bind `$n`; the manual `replace(/'/g, "''")` pattern is gone from the codebase.

## Phase 9a notes (Sep 11 2026)
- **Eras: dropping ≠ absorbing.** `HAVING COUNT(month) >= minMonths` silently erased every restless month; on the owner's varied 2025–26 the timeline ended at 2024. Runs of short eras now become their own era (LAST_VALUE/FIRST_VALUE IGNORE NULLS carry-forward, no monotonic-id assumption). DuckDB won't nest a window inside a CASE inside another window — compute the run-start flag in its own CTE.
- **`assert_read_only` bit us**: a `;` inside a `--` comment in a query string. Rule: no prose in SQL strings.
- **Playlist "within"** = play after the item's `added_at`; the export doesn't record which playlist a play came from, so this is the honest proxy. **Gem** = 15+ total plays, ≤20 % skips, ≤1 play within. **Dead** = ≥3 plays within with ≥60 % skips, or unplayed 90+ days after adding.
- **Poll priority**: enrichment now runs 5 min after each poll and skips while `is_paused()`. Enough for the owner's symptom; a hard reservation in the budget module is the next step if quota stays tight.
- **Wild reset** deletes only `wild_play` events + `engine='wild'` feedback; the core record is untouched by construction.
- **Obsessions**: not in Last.fm's API (confirmed) — dropped rather than scraped.

## Phase 9f (Sep 22, 2026) — decisions
- **Playlist sync root cause was Spotify policy, not quota.** Spotify-owned playlists 403/404 for third-party apps since Nov 2024; the 9e loop aborted on the first one, and since `/me/playlists` lists newest first, older playlists were unreachable in principle. Two-pass, error-isolated, snapshot-aware sync. Followed-playlist item cap raised 300 → 500.
- **Scenes moved from SQL literals to tables** with ON-CONFLICT seeding, so upgrades add built-ins without touching owner rows (`builtin = FALSE`). The 18 original keys are preserved verbatim; specific African tags moved to four regional families, umbrella tags stay under `afro`.
- **Lyric keywords are corpus-relative.** TF-IDF over the owner's own songs, with a 35 % document-frequency ceiling; frequency-only keywords were ~always "love/night/baby". Themes require ≥ 2 distinct cues or ≥ 3 hits and score by weighted density; a single trigger word no longer files a song. Lexicons are English-only by design — wrong themes are worse than none.
- **Move bundle is Parquet, not the DuckDB file**, because DuckDB's on-disk format is not guaranteed readable across versions; Parquet is. Restore intersects columns by name and always rebuilds, so bundles work in both version directions.
- **Crate deck is uncapped.** 400 was an arbitrary safety cap that hid the last (unsorted) divider on the owner's record.

## Phase 9g (Sep 22, 2026) — decisions
- **Atlas map is a baked asset, not a library.** Natural Earth 110m → Natural Earth I projection → per-country path strings keyed by ISO alpha-2 (123 KB JSON). No d3 at runtime; hover/click are plain React. Countries with no placed artist stay grey rather than being hidden, so "unplaced" is visible.
- **The Forecast is a distribution and logs itself write-once.** Same-weekday base rate over 26 weeks; a named call needs ≥ 85 % over ≥ 8 exposures (summary §3.2's floor) — most days it stays quiet. Accuracy is Brier vs climatology so a "skill" of 0 means "no better than your averages"; no verdict is offered under seven scored days. Forecasts are not logged while a year filter is on.
- **FreqBlog before Setlist.fm** (owner's 9b choice). Only bpm / key / energy / loudness are charted; perceptual fields are stored but labelled coarse, per the service's own caveat. Monthly hard stop at 900 of 1,000.
- **Scene threads are exempt from the coverage ceiling.** A family covering half your artists is what an era is made of; the ceiling exists to keep *tag* threads niche.
- **Tuning knobs are numeric only**, so the scene-thread switch is a 0/1 slider rather than a checkbox — one control type in `TuningGroup` keeps Settings honest about what a value does.

## Phase 9h (Sep 23, 2026) — decisions
- **Nav groups**: Understand (analysis of your own listening), Stories (narratives you read or share), Act (things that change what you hear), App (plumbing, collapsed by default). The four daily destinations stay pinned. A group holding the current page can't collapse — hiding where you are is disorienting.
- **Display size is one root font size**, not per-page tweaks, because Tailwind is rem-based; charts drawn in pixels read `useViewport()`. Auto uses the tighter of width and height so a short, wide window still gets compact.
- **Forecast blends habit and trend 50/50** and verifies itself by replay (no look-ahead: each day only sees earlier data). The baseline is deliberately strong — "your ten biggest artists" — so a lift over it means the weekday/recency signal is real.
- **Abroad uses where you were, not artist origin.** conn_country only exists in the extended export; polled plays fall back to travel time zones. Home is detected (most plays) but overridable, for people who moved.
- **Per-language IDF**: comparing a Turkish word against English songs is meaningless; each language is its own corpus, and the cloud separates English from the rest.
