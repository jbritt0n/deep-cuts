# Deep Cuts v3 — Phase 8

A local-first desktop app that turns years of Spotify listening into an explorable record. Tauri 2 + React + DuckDB. Everything stays on your machine.

**Phase 8 (this drop) adds:** **Heard in the Wild** — songs your phone recognised out in the world (Pixel *Now Playing* and *Shazam*, scrobbled to Last.fm by Pano Scrobbler) imported every 30 minutes as a *separate event class* that can never touch your hours, streaks or records; anything it overheard from your own Spotify speakers is dropped on the way in (same artist, same moment). New `/wild` page: what you've never streamed vs what's already yours, where and when the world plays you music, pin/hide/Add to Radar. Owner's fixes: **Earworms** moved to Library; **session cards** show the date and top artists, the explorer gets *Oldest first* and an artist/track-in-session search; the dashboard **heatmap** can show any calendar year; a **Review outliers** panel in Settings lists stuck-repeat sessions with one-click *Mark unattended*, spiky short tracks, and plays longer than their song, under a six-number integrity strip. **Browse by genre** on Discover: every tag your artists carry, sized by your hours — pick one for your library in it and the artists just outside it. Under the hood: `vitest` (13 tests — the first run caught a real device-bucketing bug), 3 new SQL fixtures (10 total), CI now tests every push and only builds installers on version tags, `likedSongs` filters are parameterised. Rust additions (the wild connector) are written to the existing pattern but await their first `cargo` build. See **docs/PROJECT-STATUS-AND-ROADMAP.md** (updated) and **docs/HEARD-IN-THE-WILD.md**.

**Phase 7c fixes:** playlist sync (Sync now was never calling the playlist sync — fixed, followed playlists now sync too); a Services-page crash that blanked the whole app (an ErrorBoundary now wraps every route, plus defensive fallbacks); and the real bug behind an outlier the owner found — B.B. King's "So Excited" at 229 plays, 226 of them a 30-second track looping unattended for 112 minutes that the attention detector misread as genuine listening because Spotify's `unknown` start_reason (normal for autoplay) was being treated as a user click. The interaction rule is now an explicit allow-list of real actions, and a new `stuck_repeat` flag catches this class of outlier directly (while correctly ignoring deliberate repeat-button mashing, which has real clicks). See **docs/PROJECT-STATUS-AND-ROADMAP.md** for the full project summary and roadmap.

**Phase 7 adds:** fixes from the first desktop run — playlists now sync on *Sync now* (followed playlists get items too), After-midnight falls back to counts, Radar is visible under *Made by Deep Cuts* (Discover and Library); **travel time zones** from Spotify's per-play country (Istanbul plays keep Istanbul time) plus manual date-range overrides in Settings; **scenes** (tag/origin clusters → scene phases, scene exports) and "also in rotation" on eras; **earworms**, calibrated against your Earwormz list, with learn-from-feedback; **Mixtape builder** with engine sliders; Library gains Followed playlists (lost gems), Made by Deep Cuts, and richer liked-song filters (year liked, tag, decade, artist, not-in-any-playlist, min plays) and sorts (longest since played, momentum); nightly **insights cache** feeding a "Fresh insights" dashboard row; mark sessions unattended by hand; concerts (lite) table; **ListenBrainz** similar artists and **artist origin** (MusicBrainz) connectors; stats.fm marked experimental.

**Phase 6 adds:** album art from Spotify and the Cover Art Archive (via MusicBrainz release groups) feeding the collages and a new Record shelf on the dashboard; SQL fixture tests (`scripts/test_sql_fixtures.py`) which already caught two shape-rule bugs (album rides now require unskipped plays; discovery runs require actual listening); a keyboard skip-link; a release job in CI (tag `v*` → GitHub Release with all installers); and **docs/SETUP.md** — the complete setup guide for both the GitHub and local routes.

**Phase 5 adds:** ten skins in Settings (Ink & amber, Lagoon — teal water with lemon type —, Darkroom, Paper sleeve and Rosewater light modes, Neon arcade, Forest floor, Sunset drive, Monochrome, Terminal) applied to every surface and chart; Liner Notes — a weekly digest composed from the numbers with its fact sheet alongside; milestones (INS-11) rebuilt nightly and shown on the dashboard; merge/unmerge artists in Settings (reversible, raw plays untouched); nightly rebuild + Parquet backup keeping 14 days; monthly Radar refresh from accepted recommendations.

**Phase 4 adds:** Achievements shelf (bronze/silver/gold) + "Albums heard whole" with a completeness slider (day or session scope); Moods — your ten weekday/weekend × day-part stations, each tune-in-able as a playlist; Taste drift map (years placed by artist-share similarity, MDS) with year-to-year pivots; Half-life explorer; Listening age & decade mix (needs enrichment); Compare any two periods side by side; Library — liked songs/albums/artists with your numbers, playlists with plays-within and dead weight, prune lists; Blend — import a friend's export (aggregated, separate) for overlap, "you'd like", and a blend playlist; Share cards (1080×1350 PNG rendered locally) for top-N; album-art collage (real art once enrichment runs); lyric themes via LRCLIB — derived keywords/themes only, full text never stored — searchable ("songs about rain") and exportable, toggled in Settings.

**Phase 3b adds:** *In Review* for any period — year, month (pick a year, then a month), last 30 days, or a custom date range — with expandable top 5/10/25/50/100 and HTML/playlist export; top-N controls on the dashboard; named eras with one-click era playlists; the playlist maker now suggests a replacement when you remove a song and lets you add more from the same period or by searching your archive; Discover gains forgotten favourites, one-track wonders, and five curated playlists built from your own archive; the Sessions page explains every shape rule.

**Phase 3 adds:** the Discover page — five recommendation engines (Last.fm adjacency, tag affinity, structural gaps in your own library, MusicBrainz side projects, release radar) with reasons, confidence, Good call / Not for me feedback (90-day memory) and one-click Add to Radar playlist; the playlist export primitive on Year in Review, artist, album and month pages (private by default, visibility toggle); Year in Review export to a standalone HTML; stats.fm import; MusicBrainz relationships + release groups.

**Phase 2 adds:** Spotify sign-in (PKCE, loopback 127.0.0.1:8888), a recently-played poller every 20 min from the tray, liked-songs and playlist sync, quota-aware lazy enrichment (release dates, real lengths, ISRCs), Last.fm tags + similar-artist graph, MusicBrainz identity resolution + tags, a working Services screen, one-command setup and CI builds for both platforms. stats.fm and the recommendation engines are the next drop.

**Phase 1 delivers:** in-app import of the Spotify Extended Streaming History (drag the zip in), entity resolution, sessions v2 with attention detection, the dashboard, artist / track / album / day / month pages, search, a full Sessions analytics page, an Insights page (eras, obsessions, comebacks, skip forensics, 3 AM canon, weekday/weekend personas, seasons), Year in Review for any year, the global *listening lens* (attentive-only + year range), demo mode, portable mode, Linux + Windows builds.

## Start here: docs/SETUP.md

The complete guide (GitHub route for installers, local route for development, connecting each service, how refresh works) is **docs/SETUP.md**. The rest of this file is the detailed test plan.

## Run / test plan (Linux Mint first)

> If `sudo apt update` complains about `repository.spotify.com` and key `5384CE82BA52C83A`, that's the Spotify desktop app's repo, not this project. Fix: `curl -sS https://download.spotify.com/debian/pubkey_5384CE82BA52C83A.gpg | sudo gpg --dearmor --yes -o /etc/apt/trusted.gpg.d/spotify.gpg`, or remove `/etc/apt/sources.list.d/spotify.list`.

### 0. One-time setup — one command
```bash
cd deep-cuts-v3 && ./setup-linux.sh
```
It installs the WebKitGTK/DuckDB system libraries, Rust (≥ 1.85), Node 20 and the npm packages, and disables a broken Spotify apt repo key if it finds one. Re-run any time.

### Getting installers without building locally
Push this folder to a GitHub repository. `.github/workflows/build.yml` builds **Linux AppImage + .deb** and **Windows NSIS installer + portable `DeepCuts-portable-windows.zip`** on every push; download them from the Actions tab. Locally: `./build-linux.sh` on Mint, `build-windows.ps1` on Windows.

### 1. Verify the SQL against your real export — no Rust needed (2 minutes)
```bash
pip install duckdb pytz
python3 scripts/validate_sql.py "/path/to/Spotify Extended Streaming History"
```
Expected for the export you sent (Sept 2026):

| Metric | Value |
|---|---|
| Plays after dedupe | **99,822** |
| Hours (everything) | **5,704** |
| Canonical artists | **11,293** (5 case-variant spellings merged) |
| Distinct tracks | **42,942** |
| Podcast/video rows skipped | 130 |
| Duplicate rows collapsed | 2,117 (Spotify's own 2020–22 export duplicates) |
| Sessions | 5,491 · attention: 4,830 active / 528 drifting / 133 unattended |
| Attentive hours | 3,672 (2017 drops 828 → 266; Beach House 82 h → 27 h) |
| First / last play | 2016-02-09 16:05 → 2026-09-08 19:00 (America/Detroit) |
| Pipeline time | import ≈ 4–9 s · entity ≈ 2 s · sessions ≈ 1 s |

Re-running the script is idempotent — plays stay at 99,822.

### 2. Try the UI in a browser against that database (no Rust needed)
```bash
npm run dev:browser        # dev-server.mjs on :4747 + Vite on :1420
```
Open http://localhost:1420. This is the same React app the desktop shell hosts; only drag-drop and the native file picker are Tauri-only (paste a path instead).

### 3. Build and run the desktop app
```bash
npm run tauri dev          # first compile of DuckDB takes 5–15 min; later runs are seconds
./build-linux.sh           # AppImage + .deb → dist-packages/
```
**Windows portable:** `build-windows.ps1` (or the GitHub workflow) produces `DeepCuts-portable-windows.zip`: unzip anywhere, run `DeepCuts.exe`, no installation, no admin. `portable.flag` beside it keeps all data in `data\`. WebView2 is preinstalled on Windows 10/11; the NSIS installer bundles a bootstrapper for older machines.

### 4. Click-through checklist
1. First launch shows the **demo record**. Sidebar says "Demo record · import yours".
2. Drop `my_spotify_data.zip` on the welcome screen → preview shows 12 files, **99,822 new plays**, date range, 130 skipped, 2,117 duplicates. Import → progress → "Your record is ready".
3. Dashboard totals match the table above with the lens on **Everything**; flip to **Attentive** and hours drop to ≈3,672 and the top artist changes.
4. Set the year range to 2020– : the "Side A" line reflects it; every page follows.
5. Open the loudest day; open a session; check the run-through shows skips (red) and unattended plays (violet).
6. Insights page: eras timeline, obsessions cards, comebacks/retention, skip forensics, personas with two dials, seasons. Year in Review: switch years with the pills.
7. Sessions page: heatmap, length distribution, shapes by year, attention by year, skip forensics, gateways/closers. Click a shape → explorer filters.
8. Search "beach" → artists / tracks / albums; open Beach House → album loyalty line if ≥60%.
9. Settings → set attention gap to 45 → Apply → sessions rebuild; unattended hours grow. Set back to 90.
10. Settings → drop the same zip again → "Nothing new to import". Data folder opens. Parquet export lands in `backups/`.
11. RAM: `ps -o rss -p $(pgrep -f deep-cuts)` while idle on the dashboard — target < 250 MB.
12. Portable mode: copy the AppImage to a folder with an empty `portable.flag` → a `data/` folder appears beside it.
13. Launch a second copy → the first window is focused instead (single instance).

### Phase 2 checks
14. Services → Spotify: paste your Client ID (create the app at developer.spotify.com/dashboard with redirect `http://127.0.0.1:8888/callback`), Connect → browser → "Deep Cuts is connected". Sync now → liked songs count appears.
15. Play a track on your phone; within 20 min it shows in Recent plays with source `recently_played_poll`. Play it again: no duplicate.
16. Close the window → tray icon stays; right-click → Check Spotify now / Open / Quit.
17. Services → Last.fm: username + key → Connect. Within minutes Settings → Activity shows "Tagged N artists". MusicBrainz → Connect → "Resolved N artists".
18. Discover: with Last.fm + MusicBrainz connected, suggestions appear with reasons; "Not for me" hides one for 90 days; "Add to Radar playlist" creates a private *Deep Cuts Radar* playlist on first use and it appears in the Spotify app.
19. Year in Review → Make playlist → preview → toggle stays private → Create → opens in Spotify. Export as HTML → opens offline in a browser.
20. Services → stats.fm: paste key → Connect; Sync now reports "+N plays" (0 if Spotify already had them all).
21. Enrichment: after 24 h, Services shows enriched track count; a 429 never shows as an error — Activity logs "quota exceeded, paused until midnight" at worst.

### Phase 8 checks
22. `npm test` → 13 vitest tests pass; `python3 scripts/test_sql_fixtures.py` → 10 fixtures pass; `python3 scripts/seed_dev_db.py && npm run dev:browser` then `npx tsx scripts/smoke-wild.ts` → ends with `invariant … OK`.
23. Library → **Earworms** tab shows what used to be on Discover; Discover no longer has the card.
24. Sessions → explorer: cards show a date and up to two artists; sort **Oldest first** puts your first-ever session at the top; type an artist into the search box → only sessions containing them remain; *clear* resets.
25. Dashboard → heatmap picker → choose 2024 → the grid re-renders for that year (366 cells) and the *loudest day* link follows.
26. Settings → **Review outliers**: the So-Excited session appears under *Stuck on repeat* → **Mark unattended** → totals recompute, the row flips to `unattended (by hand)`, the Attentive lens hides it. *it was me* reverts.
27. Discover → **Browse by genre**: with Last.fm/MusicBrainz tags synced, chips appear sized by hours; click one → your artists in it on the left, *new to you* candidates with "next to …" reasons on the right; **Add to Radar** works; **not for me** hides for 90 days.
28. Phone: Pano Scrobbler → Now Playing + Shazam on, **Spotify off** (or a dedicated Last.fm account). Deep Cuts: Services → **Heard in the Wild** → Set up → Sync now. Play a song on Spotify through a speaker while the phone listens → it must **not** appear on `/wild` (the card's *dropped* counter rises). Shazam something in a café → it appears within 30 min tagged *never streamed*; totals, streak and records are unchanged.
29. `/wild` with nothing captured shows the setup explainer, not an empty chart.

## Where things live
```
src-tauri/sql/            all analytics: schema, import_*, entity_resolution, compute_sessions, demo_seed
src-tauri/src/            thin Rust: paths, db (DuckDB + tz_offsets), importer, commands, events, llm (seam)
src/lib/queries.ts        every dashboard/entity metric (SQL in TS)
src/lib/sessionQueries.ts session analytics
src/lib/insightQueries.ts insight detectors + year in review (live SQL, §7)
src/lib/recQueries.ts     recommendation engines REC-01…05 + inbox (SQL over cached graphs/tags)
src/lib/exportHtml.ts     In Review → standalone HTML
src/lib/phase4Queries.ts  achievements, completeness, moods, half-life, drift, compare, library, blend, lyric search
src/lib/notesQueries.ts   Liner Notes facts + composer
src/lib/theme.ts          skins (CSS vars + live chart colours)
src-tauri/sql/compute_milestones.sql  INS-11
src-tauri/src/connectors/lyrics.rs  LRCLIB → derived features only
src-tauri/src/playlists.rs  PLY-07/10, DIS-02 (POST /me/playlists, /playlists/{id}/items ≤100)
src/lib/wildQueries.ts    Heard in the Wild (Phase 8) — reads wild_plays, joins onto your record
src/lib/hygieneQueries.ts Review outliers panel (Phase 8)
src/lib/genreQueries.ts   Browse by genre (Phase 8)
src/lib/__tests__/        vitest unit tests (npm test)
src-tauri/sql/wild_insert.sql          dedup-aware capture insert (Phase 8) — see docs/HEARD-IN-THE-WILD.md
src-tauri/src/connectors/lastfm_wild.rs Heard in the Wild connector (Phase 8, uncompiled)
src/lib/filter.ts         the listening lens
dev-server.mjs            browser dev harness (same commands over HTTP)
scripts/validate_sql.py   pipeline check against a real export
scripts/smoke-*.ts        run every TS query against the dev server (CI runs all four)
scripts/seed_dev_db.py    demo-seeded dev database, no export needed
docs/PHASE1-NOTES.md      decisions, deviations, per-phase notes
docs/recommendations/     the four external reviews that shaped Phase 8 and the Phase 9 menu
```
Data: `~/.local/share/deep-cuts/` (Linux), `%APPDATA%\DeepCuts` (Windows), or `./data/` in portable mode. `deep-cuts.duckdb` is your record; `demo.duckdb` is the demo.
