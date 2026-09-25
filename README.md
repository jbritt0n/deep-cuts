# Deep Cuts v3 — Phase 10a

A local-first desktop app that turns years of Spotify listening into an explorable record. Tauri 2 + React + DuckDB. Everything stays on your machine.

**Phase 10a (this drop).** FreqBlog features now actually land (billed hits were being read as misses); album obscurity fills in (and shows on album and artist pages); nameless followed playlists get their names; every playlist gets an **affinity %** — how much it suits you; Atlas names countries properly; new page **The Newness** (your discoveries by week, month or season). Phase 10 starts: **Discovery depth** (bubble score, blind spots, "should like but don't" on Discover; activity labels on Sessions; song-length preference), a **Connections** page (co-listening network, playlist overlap), ISRC duplicate report, loading skeletons. **Docs reorganised** — start at `docs/README.md`; the plan is `docs/ROADMAP.md`.

**Phase 9m — Stylus S1.** Deep Cuts now has its own scrobbler: a ListenBrainz-compatible receiver (Services → Stylus) that Pano Scrobbler, Web Scrobbler, multi-scrobbler, Navidrome, Jellyfin and most ListenBrainz plugins can point at with a per-device token. Listening Spotify never sees (Bandcamp, YouTube Music, local files) joins your record; Spotify plays it also scrobbles are recognised and never counted twice, even when the scrobble arrives before Spotify's poll. Per-device privacy: time kept exact / to the minute / to the hour, player, service and device name each optional, pause, revoke. Also: era hover cards say which weather an era was listened in, per-kind thread caps in Tuning, and dynamic playlists that refresh only on rainy (or sunny, snowy…) days. See **docs/history/handoffs/HANDOFF-PHASE-9M.md** and **docs/STYLUS-SPEC.md**.

**Phase 9l.** **Exports enrich polls, never duplicate** — now whether Spotify's live feed stamps a play at its start or its end (both are matched, within 15 s), and a song played twice in a row stays two plays; Settings → Record → *Polled vs exported* shows what each export replaced. **No more rebuild on every launch**: after an export, the old "events ≠ plays" check was always true; a resolution watermark replaces it, and a needed rebuild now runs in the background after the window opens (a banner says so) instead of freezing startup. **Playlist from words** on Ask the archive: "rainy late-night songs I've forgotten" → a playlist from your own record with the reason for every pick; works without a local model, sharper with one; *Keep it fresh* makes it a dynamic playlist. See **docs/history/handoffs/HANDOFF-PHASE-9L.md**.

**Phase 9k — roadmap.** **Weather**: set your city (Settings → Record → Weather) and Open-Meteo fills in the weather for your whole record plus the 7-day forecast — Moods & Forecast shows the real weather each day, adjusts expected listening by how you behave in it, and a *Your weather* card shows what rain, sun, snow and temperature do to your minutes, skips, tempo and scenes. **Dynamic playlists** (Library → Dynamic): rules — today's forecast, heavy rotation, rediscoveries, a scene, a tempo band, To revisit, sounds-like — rebuilt daily or weekly and, once linked, kept in sync on Spotify in place. **Sound tools**: the tempo dial (stations by bpm and energy), the energy curve of every session, and *Mix into next* on each song. Also fixes the 9j Wikipedia pictures, which the app's security policy was blocking. See **docs/history/handoffs/HANDOFF-PHASE-9K.md**.

**Phase 9j answers the 9i.1 feedback.** **Skips are back**: Spotify's recently-played list never says a song was skipped, so polled plays all looked fully heard — and with no interactions, long sessions timed out as inattentive. Deep Cuts now infers skips and real listening time from when the next track started (Settings → Record → Rebuild once to apply to your history). **Edit tags and scene** on Artist and Song pages; a removed tag stays removed. **Wikipedia**: an About card (picture + intro) found through the artist's verified MusicBrainz match. **Audio features put to work**: *Sounds like this* on every song, *How X sounds* on every artist, *Smooth order* for any playlist (harmonic key + tempo flow). **Roast Me**: 11 more receipt types, openers, a kind closer. **16 new achievements**. See **docs/history/handoffs/HANDOFF-PHASE-9J.md**.

**Phase 9i answers the 9h.1 feedback.** **Metadata you can correct**: a "What Deep Cuts knows" panel on every Artist, Album and Song page shows each value and its source; fix an artist's origin, pick the right MusicBrainz match from every namesake (or paste a link), correct an album's original year or cover, a song's ISRC. Corrections survive every rebuild. **Better matching**: artists are now matched to MusicBrainz by your own tracks' ISRCs, not name alone — the cause of Paul Banks → Denmark and Rodriguez → Cuba — and existing matches are re-checked and corrected in the background. **FreqBlog** fixed (the 422 was a request-format bug; billing is per track, now read from FreqBlog's own counter). **Eras**: eras and threads in separate bands, a readable hover card, taller, no more snapping back when you hover; gap, palette, fill and height in Settings → Appearance; recent threads always get a place. **The Crate** shows album and artist obscurity separately. **Library → To revisit**: songs you keep choosing and never saved. **Roast Me** (Stories). **Export everything** (CSV/Parquet, plus one flat file of every play with its enrichment). **Re-importing an extended history** no longer double-counts plays already polled. The **demo record** now shows every feature. **Stylus** scrobbler designed: docs/STYLUS-SPEC.md. See **docs/history/handoffs/HANDOFF-PHASE-9I.md**.

**Phase 9h answers the 9g feedback.** **Navigation**: four pinned pages, then collapsible *Understand / Stories / Act / App* groups that remember their state (the group holding the current page always opens); *Not for me* moved to Settings → Not for me. **One scrollbar**: the shell is pinned to the window and only the page scrolls, so tops can't get stuck off-screen. **Fits the screen**: Settings → Appearance → *Display size* (Auto follows the window — a 1366×768 laptop lands on Compact); Eras' chart and Library › Playlists are sized to the window. **Search**: the header box lands on the Explore lists again, and the same search heads *Ask the archive*. **Moods & Forecast** (was Moods): today's broadcast with an hour-by-hour radar, likely artists and a "Tune in" station playlist, a 7-day outlook, warm and cold fronts, and a four-week backtest that shows how well it predicts you from day one. **Atlas → Listening abroad**: trips detected from where you listened, each with its souvenir song, local-artist share vs home, and which scenes travel with you; plus a "where you listened" map mode. Fixes: *How predictable are you?* ("disallowed keyword: LOAD"), *Rising and fading* (listener counts now refresh monthly; shows audience-size analytics until then), lyric keywords scored per language with English / other-language views. See **docs/history/handoffs/HANDOFF-PHASE-9H.md**.

**Phase 9g — five roadmap items.** **Atlas** (new page): a world map of where your artists come from, shaded by hours, hover for the top names, click for the list, with the accessible table twin and a "how the map widened" year line — Natural Earth paths baked to a 123 KB static asset, no map library. **The Forecast** (dashboard): a probability spread over scene families and day-parts from your last 26 same-weekdays, a high-confidence call only above 85 % / 8 exposures, logged once a day and scored on Insights as a Brier line ("how predictable are you?"). **FreqBlog audio features**: new connector (free tier, ISRC-first bulk lookups, 900/month cap) → a **Sound** section on Insights: tempo by year, energy through the day, minor keys by season, your key wheel, an adventurousness score, extremes. **Scene-family threads** on Eras: the broad "what kind of music ruled these weeks" line above the niche tag threads, labelled with family names. **Settings → Tuning → Genre threads and Not for me**: thread length / share floor / coverage ceiling / scene threads on-off, and the Not-for-me exposure and skip-rate bars, all live. See **docs/history/handoffs/HANDOFF-PHASE-9G.md**.

**Phase 9f answers the 9e feedback:** **Move to another computer** — one zip carries the whole record (every table as Parquet + manifest, sign-ins optionally encrypted with a passphrase); restore on any newer build and it rebuilds itself (`docs/MOVING.md`). **Lyrics v2** — keywords are now scored against your own lyric corpus (TF-IDF: a word in every song is nobody's keyword), themes need several cues and are scored, plus valence / repetition / language and optional theming by your local Ollama model; old rows re-analyse gradually. **Scenes are data** — 66 families (West/East/Southern/North African, Arabic, Persian, South Asian, Korean, Chinese, Southeast Asian, Greek, Balkan, Brazilian… and niche styles: library & exotica, dub techno, UK bass, emo, extreme metal, minimalism, sophisti-pop, hyperpop), 1,087 tag mappings, 180 origin countries, all editable in Settings → Tuning → **Scenes** with an *unfiled tags* queue. **Crate**: the unsorted section is reachable and filterable. **Playlists**: the sync is two-pass and no longer dies on Spotify-made playlists (closed to apps since late 2024) — your old playlists finally appear, unreadable ones are labelled. Roadmap: **Daily Dig** on the dashboard, **popularity trajectory** on artist pages and *Rising and fading* on Insights. See **docs/history/handoffs/HANDOFF-PHASE-9F.md**.

**Phase 9a fixes and adds:** **Eras reach the present** — restless stretches become their own era instead of vanishing, the current one is marked *in progress*, and a *how the boundaries were drawn* panel shows the per-month numbers; **retention drill-down** — click a year to see who went quiet; **Playlist intelligence** in Library — completion bars, partial-sync detection with *Finish syncing*, sort by most/least played, fewest heard, most complete, hidden gems, dead weight, longest untouched; every track classified (gem / dead weight / core / unheard); *Worth revisiting* suggestions; **Heard in the Wild** gets *Purge & re-point to another account* plus a guard that spots when captures are really your own Spotify; **polling now outranks enrichment** in the scheduler so a quota-tight day can't lose plays. See **docs/history/handoffs/HANDOFF-PHASE-9B.md** for what's next.

**Phase 8 adds:** **Heard in the Wild** — songs your phone recognised out in the world (Pixel *Now Playing* and *Shazam*, scrobbled to Last.fm by Pano Scrobbler) imported every 30 minutes as a *separate event class* that can never touch your hours, streaks or records; anything it overheard from your own Spotify speakers is dropped on the way in (same artist, same moment). New `/wild` page: what you've never streamed vs what's already yours, where and when the world plays you music, pin/hide/Add to Radar. Owner's fixes: **Earworms** moved to Library; **session cards** show the date and top artists, the explorer gets *Oldest first* and an artist/track-in-session search; the dashboard **heatmap** can show any calendar year; a **Review outliers** panel in Settings lists stuck-repeat sessions with one-click *Mark unattended*, spiky short tracks, and plays longer than their song, under a six-number integrity strip. **Browse by genre** on Discover: every tag your artists carry, sized by your hours — pick one for your library in it and the artists just outside it. Under the hood: `vitest` (13 tests — the first run caught a real device-bucketing bug), 3 new SQL fixtures (10 total), CI now tests every push and only builds installers on version tags, `likedSongs` filters are parameterised. Rust additions (the wild connector) are written to the existing pattern but await their first `cargo` build. See **docs/history/PHASE-LOG.md** (updated) and **docs/HEARD-IN-THE-WILD.md**.

**Phase 7c fixes:** playlist sync (Sync now was never calling the playlist sync — fixed, followed playlists now sync too); a Services-page crash that blanked the whole app (an ErrorBoundary now wraps every route, plus defensive fallbacks); and the real bug behind an outlier the owner found — B.B. King's "So Excited" at 229 plays, 226 of them a 30-second track looping unattended for 112 minutes that the attention detector misread as genuine listening because Spotify's `unknown` start_reason (normal for autoplay) was being treated as a user click. The interaction rule is now an explicit allow-list of real actions, and a new `stuck_repeat` flag catches this class of outlier directly (while correctly ignoring deliberate repeat-button mashing, which has real clicks). See **docs/history/PHASE-LOG.md** for the full project summary and roadmap.

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

### Phase 9m checks
81. Services → Stylus → Receiver on → "listening on 127.0.0.1:4749". Add device "Laptop browser" → copy the token → Web Scrobbler → Accounts → ListenBrainz, custom API URL `http://127.0.0.1:4749/1/submit-listens` + token → play something on Bandcamp → a minute later it's in your record (Explore / the song's page).
82. Scrobble a song on the Spotify app with Pano on your phone (allow other devices on your network first) → it appears once, not twice, after the next Spotify poll.
83. Pause a device → its counter shows "discarded while paused"; revoke → the scrobbler reports an invalid token.
84. Eras → hover an era → "listened most on rainy days…" when weather is set and one kind of day stands out. Settings → Tuning → scene / decade thread caps. Library → Dynamic → "Only on rain days".
85. `python3 scripts/test_sql_fixtures.py` → 30; `npx tsx scripts/smoke-9m.ts` → `9m smoke OK`.

### Phase 9l checks
77. Settings → Record → Polled vs exported: after importing a new extended-history file, "replaced" rises by the overlapping polled plays; the dashboard's play count rises only by plays polling missed; skip rates for that period come from the export.
78. Quit and reopen twice: the second launch is instant (no "rebuilding" in `logs/deep-cuts.log`). After an upgrade, the window opens at once with an amber "Rebuilding your record…" strip that disappears when done.
79. Ask the archive → Playlist from words → try the examples; each pick lists why it fits; *Make playlist* and *Keep it fresh* work.
80. `python3 scripts/test_sql_fixtures.py` → 28; `npx tsx scripts/smoke-9l.ts` → `9l smoke OK`.

### Phase 9k checks
72. Settings → Record → Weather → search your city → *use this* → "Stored N days of weather". Moods & Forecast: the 7-day outlook shows the weather and temperature for each day; the broadcast says what that weather does to your listening; *Your weather* lists each kind of day.
73. Library → Dynamic → add "Today's forecast · daily" → Preview → *Create on Spotify & keep in sync* → the playlist appears on Spotify. Tomorrow, after Deep Cuts opens, the same playlist (same link) has new songs.
74. Moods & Forecast → The tempo dial → pick a band → *Make this station*. A session page shows *The session as sound*. A song page shows *Mix into next* and *Keep it fresh*.
75. An artist's About card now shows the Wikipedia picture (the CSP now allows upload.wikimedia.org).
76. `npm test` → 39; `npx tsx scripts/smoke-9k.ts` → `9k smoke OK`.

### Phase 9j checks
66. Settings → Record → Rebuild, then Insights / Sessions: skip rates are no longer 0 %, and long evenings with skips stay attended.
67. Artist page → What Deep Cuts knows → Edit: ✕ a tag (e.g. "german" on Ljupka Dimitrovska) → it's listed under "Removed" and doesn't return after the next Last.fm pass; set the scene to Balkan; "Automatic" undoes it. Song page → Edit shows the artist's tags too.
68. Artist page → About card appears once the Wikipedia pass reaches the artist (only for verified MusicBrainz matches).
69. Song page → Sounds like this; Artist page → How X sounds; Library → a playlist → Smooth order → "N % smoother" → Save as new playlist.
70. Stories → Roast Me: an opener, up to 10 receipts, a kind closer. Achievements: 27, including Musical passport, Polyglot ear, All twenty-four, Ahead of the curve.
71. `python3 scripts/test_sql_fixtures.py` → 26; `npm test` → 36; `npx tsx scripts/smoke-9j.ts` → `9j smoke OK`.

### Phase 9i checks
57. Artist page (Paul Banks / Rodriguez) → *What Deep Cuts knows*: the MusicBrainz line says how the match was made. *Edit* → *Show every "…" on MusicBrainz* → pick the right one → origin and tags refresh. Or set the origin by hand; it shows "you" and survives Settings → Record → Rebuild.
58. Services → FreqBlog: no 422; the card shows units used and FreqBlog's own "left" figure. `~/.local/share/deep-cuts/logs/freqblog-sample.json` appears after the first successful batch.
59. Eras: scroll left, hover an era — it stays put and a detail card opens. Settings → Appearance → Eras chart: change gap / palette / fill / height and watch the chart follow. Threads from this spring appear.
60. The Crate → a record card shows "album … · artist …" separately.
61. Library → To revisit: three shelves; *keep* / *let go* hide a song for a year; *Review as a playlist* works.
62. Stories → Roast Me: receipts at each heat; *Roast me* with Ollama running writes a routine from the receipts only.
63. Settings → Record → *Export everything (CSV)* → a folder with plays_enriched.csv and tables/.
64. Import an extended history that overlaps polled months: the dashboard's play count rises only by plays polling missed.
65. `python3 scripts/test_sql_fixtures.py` → 25; `npx tsx scripts/smoke-9i.ts` → `9i smoke OK`.

### Phase 9h checks
48. Sidebar: Dashboard / Ask the archive / Library / The Crate always shown; Understand, Stories, Act, App collapse on click and stay that way after a restart; opening Settings forces App open. `#/notforme` lands on Settings → Not for me.
49. Scroll to the bottom of Liner Notes or Settings, then scroll up with the trackpad — one scrollbar, the top is reachable. Switch pages: each opens at its top.
50. Settings → Appearance → Display size → *Compact*: everything shrinks together; *Auto* on a 1366×768 screen should fit Eras' chart and Library › Playlists (list and open playlist side by side) without page scrolling.
51. Type in the header search box, press Enter → Explore lists with results. Ask the archive shows the same search at the top, working with Ollama off.
52. Insights → *Rising and fading* shows audience-size bars and "small rooms" with the date first movements are due. *How predictable are you?* (now on Moods & Forecast) loads without the LOAD error.
53. Insights → Lyric keywords → language chips: *English* shows English words; *All other languages* / *Turkish* / *Russian* show theirs.
54. Moods & Forecast: broadcast headline + radar + likely artists; *Tune in* makes a playlist; 7-day outlook; fronts; verification shows hit rate vs baseline for 28 days; the ten stations below carry FM frequencies.
55. Atlas → Listening abroad: trips with flag, dates, souvenir and local share; *where you listened* map mode; set Home to another code and back to auto.
56. `python3 scripts/test_sql_fixtures.py` → 22; `npm test` → 33; `npx tsx scripts/smoke-9h.ts` → `9h smoke OK`.

### Phase 9g checks
42. **Atlas** (nav → Understand): the map colours the countries your artists come from; hovering a coloured country shows hours, artist count and top names; clicking fills the right-hand list with links to artist pages; the table sorts by hours or artists and matches the map. Grey = no artist placed there.
43. Dashboard → **Today's forecast**: shows "N% chance you listen at all", the likeliest day-part and a scene spread; the note under it reads "Logged for today". Open the dashboard again → the same forecast. Insights → **How predictable are you?** starts scoring the day after.
44. Services → **FreqBlog**: paste a free key → Connect → Activity: "Connected". After a tick (or *Sync now*): "Audio features for N tracks (M of 900 requests used this month)"; the card shows the monthly bar. Insights → **Sound** fills in: tempo by year, energy by hour, keys by season, adventurousness, extremes.
45. Eras → threads list shows entries badged **scene** (e.g. "West African thread") alongside tag threads; Settings → Tuning → *Scene-family threads* set to 0 removes them without a rebuild.
46. Settings → Tuning → *Not for me · minimum exposures* lowered from 8 to 4 → Not for me lists more songs immediately.
47. `python3 scripts/test_sql_fixtures.py` → 21 fixtures; `npx tsx scripts/smoke-9g.ts` → ends `9g sound OK`.

### Phase 9f checks
35. Settings → Tuning → **Scenes**: 66 families listed with artist counts; the right column lists unfiled tags your artists carry → pick a family for one → *Re-file now* → The Crate gains that section. Add a family ("Thai funk & molam", region) → file tags under it → it appears in the Crate picker and on Eras → Scenes.
36. The Crate → section strip → click **unsorted** → the deck jumps to its divider; ⊙ next to it shows only unfiled records. Re-file one from the record card → it leaves the section on the next reload.
37. Services → Spotify → *Sync now* → Activity: "Playlists: N known", then "items refreshed for M". Library → Playlists: playlists made before Deep Cuts existed are listed; Spotify-made ones carry *unreadable*; a second sync refreshes ~0 items.
38. Settings → Connectors → Lyric themes shows the re-analysis count; *Fetch a batch now*; Insights → Lyric keywords → *keywords* are song-specific, *themes* plausible; with Ollama + the toggle on, *model themes* and *moods* fill.
39. Settings → Record → Move → export with a passphrase → restore on another machine (or a renamed data folder) → identical dashboard, Spotify still connected. Wrong passphrase → refused, nothing changed.
40. Dashboard → **Daily dig** shows one record with a reason; same record all day; *Put away 90 days* removes it here and in The Crate. Artist page → *Popularity trajectory* once Last.fm has ≥ 2 snapshots; Insights → *Rising and fading*.
41. `npm test` → 29 vitest; `python3 scripts/test_sql_fixtures.py` → 18 fixtures; `npx tsx scripts/smoke-9f.ts` → ends `9f smoke OK`.

### Phase 9a checks
30. Insights → Eras: the newest era ends this month and carries an *in progress* badge; *how the boundaries were drawn* opens a table of months with hours, similarity and ⟵ on break months.
31. Insights → Retention: click 2019 → a list of artists from 2019 you haven't played in a year, biggest first, with months silent; *all N* expands.
32. Library → Playlists: totals strip shows synced/expected and flags partly synced playlists; *Finish syncing playlists* runs the Spotify sync; sort by *Fewest songs heard* puts the least-explored first; open one → chips for Gems / Dead weight / Unheard / Core filter the list.
33. Services → Heard in the Wild (connected): if most captured songs are already in your record, a red guard explains why; *Purge & re-point to another account…* → enter the Pano-only account → captures reset to 0 and *Sync now* pulls from the new account.
34. Settings → Activity: after a fresh launch, `poll` runs before `enrich`, and `enrich` does not run while a quota pause is logged.

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
src/lib/sceneQueries.ts   scene vocabulary as data (Phase 9f) — families, tag map, origin map, unfiled-tag queue
src-tauri/sql/compute_scenes.sql  artist_scene from scene_families / scene_tag_map / scene_origin_map (Phase 9f)
src-tauri/src/migrate.rs  move bundle export / restore (Phase 9f) — docs/MOVING.md
src/lib/originQueries.ts  Atlas (Phase 9g) — hours / artists per origin country; src/assets/world-110m.json is the baked map
src/lib/forecastQueries.ts  the Forecast (Phase 9g) — distribution, high-confidence calls, Brier scoring of forecast_log
src/lib/display.ts        display size (Phase 9h) — root font size from the window, useViewport() for pixel charts
src/pages/MoodsForecast.tsx  Moods & Forecast (Phase 9h) — dayForecast / weekOutlook / fronts / backtest in forecastQueries.ts
src/lib/featureQueries.ts   Sound (Phase 9g) — FreqBlog audio features read against plays; connector in src-tauri/src/connectors/freqblog.rs
src/lib/__tests__/        vitest unit tests (npm test)
src-tauri/sql/wild_insert.sql          dedup-aware capture insert (Phase 8) — see docs/HEARD-IN-THE-WILD.md
src-tauri/src/connectors/lastfm_wild.rs Heard in the Wild connector (Phase 8, uncompiled)
src/lib/filter.ts         the listening lens
dev-server.mjs            browser dev harness (same commands over HTTP)
scripts/validate_sql.py   pipeline check against a real export
scripts/smoke-*.ts        run every TS query against the dev server (CI runs all four)
scripts/seed_dev_db.py    demo-seeded dev database, no export needed
docs/DECISIONS.md      decisions, deviations, per-phase notes
docs/recommendations/     the four external reviews that shaped Phase 8 and the Phase 9 menu
```
Data: `~/.local/share/deep-cuts/` (Linux), `%APPDATA%\DeepCuts` (Windows), or `./data/` in portable mode. `deep-cuts.duckdb` is your record; `demo.duckdb` is the demo.
