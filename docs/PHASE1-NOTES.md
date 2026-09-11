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
