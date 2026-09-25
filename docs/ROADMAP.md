# Deep Cuts — Roadmap

**The one living plan.** Updated every build; nothing else in `docs/` tracks status. Last update: September 25, 2026 (Phase 10b).
Where things came from: `recommendations/` (four external reviews, kept verbatim — their item-by-item status is in
`recommendations/STATUS.md`), owner feedback (handoffs in `history/handoffs/`), and the phase log (`history/PHASE-LOG.md`).

---

## Phase 10c (Sep 25, 2026) — UI foundations + lineage

| Item | Status |
|---|---|
| Command palette (Ctrl/⌘+K, `/`) — pages, Settings tabs, actions, artists/albums/songs | ✅ 10c |
| Themed confirm dialog + toasts (`Overlay.tsx`); all `window.confirm` gone | ✅ 10c |
| "On this page" jump menu on pages with 5+ sections; Card titles are anchors | ✅ 10c |
| Visible keyboard focus (`:focus-visible`), `outline-none` removed | ✅ 10c |
| Chart memoisation (11 components) | ✅ 10c |
| ISRC version merge (Tuning `merge_isrc_versions`, default on; album credit kept; owner ISRCs honoured) | ✅ 10c |
| Song lineage from MusicBrainz (`enrich_lineage`, Lineage card) | ✅ 10c |
| Next UI: Button component (28 styles → 1), banners → toasts (18), real empty states (16 "—"), header on Atlas/Review/Dashboard/Explore/Moods, theme tokens for 28 hex colours, table twins for charts, high-contrast skin | ○ 10d candidates |
| Discogs connector | ○ next roadmap item |

## 1. What exists today (by area)

| Area | Built |
|---|---|
| **Record** | Extended-history import (dedupe on exact key; exports supersede polled plays whether the poll stamps start or end), Spotify polling with inferred skips, Last.fm / ListenBrainz / stats.fm import, **Stylus** ListenBrainz-compatible receiver (S1), move bundle between computers, export everything (CSV / Parquet), watermark-based rebuilds (background after upgrades) |
| **Enrichment** | Spotify, MusicBrainz (ISRC-verified matching, origins, relations, credits, catalogue size), Last.fm (tags, similar artists, artist + album listeners), Cover Art Archive, Wikipedia (via verified MusicBrainz → Wikidata), LRCLIB lyric features (per-language keywords, themes, valence, optional local-model themes), FreqBlog audio features, Open-Meteo weather |
| **Correction** | Metadata panels on Artist / Album / Song (origin, MusicBrainz match, tags with permanent removal, scene, release date, ISRC, artwork); scene vocabulary editor; Record Hygiene (outliers, sessions, merges, ISRC duplicates) |
| **Understanding** | Dashboard, Sessions (activity labels, energy arc), Eras (bands, threads, weather), Moods & Forecast (7-day outlook with real weather, backtest), The Newness, Insights (Sound, lyrics, velocity, silence, device hand-off, rising & fading), Atlas (origins + listening abroad), Connections (co-listening network, playlist overlap), Taste drift |
| **Stories** | Liner Notes, In Review + Superlatives, Compare, Achievements (27), Roast Me |
| **Act** | Discover (inbox, genre browse, blind spots, bubble score, anti-recommendations), The Crate (album + artist obscurity), Heard in the Wild, Blend, dynamic playlists (7 rules + words, weather gates, in-place Spotify sync), playlist from words, queue / playlist tools, smooth order, mix into next |
| **Library** | Songs, albums, playlists (health, affinity %, dead weight, gems), earworms, To revisit, Prune, Dynamic |
| **App** | Collapsible nav, display density, one scroller, skins, Tuning (sessions, discovery, threads, scenes, eras), Services, Activity log, demo record with every feature |

---

## 2. Phase 10 — the owner's focus (September 25, 2026)

Status: ✅ done in 10a · ◐ started · ○ next.

### 10.1 Stabilise
| Item | Source | Status |
|---|---|---|
| Compiled, tested releases — CI runs `cargo test --lib` before packaging (guard, envelope, FreqBlog fixture tests) | Kimi T1 follow-up | ✅ CI step · ○ local compile loop |
| Structured `{code, message}` error envelope at the Rust boundary | Kimi T2 | ✅ `err()` + `errors.ts` + ErrorBox |
| Loading skeletons (`Loading`, `ChartSkeleton`) | Kimi T3 | ✅ skeletons · ○ chart memoisation |
| Connector parse fixtures — one real reply per connector, parsed in tests | Kimi T5 | ✅ FreqBlog (`src-tauri/tests/fixtures/freqblog-bulk.json`) · ○ Last.fm, MusicBrainz, Wikipedia, Open-Meteo |
| ISRC duplicate detection (report in Hygiene) | synthesis §1.4 | ✅ report · ○ merge versions into one entry |
| Stylus S2 privacy — per-device retention, Settings → Privacy page listing what each device keeps | STYLUS-SPEC §5 | ✅ |

### 10.2 Connectors
| Connector | Reality check (Sept 2026) | Plan |
|---|---|---|
| **Discogs** | Official API, free personal access token, ~60 requests/min | ○ Build: label, format (vinyl/CD/cassette), pressing year and country per release → a label dimension in The Crate and album pages |
| **WhoSampled** | No public API (academic licence only, 1,000 calls/month); acquired by Spotify Nov 2025; scraping breaks its terms | ✅ 10c: MusicBrainz lineage instead — samples, sampled-by, remixes, covers and other versions (`track_lineage`, Lineage card on song pages) |
| **Every Noise at Once** | Frozen since Dec 2023 (no longer maintained) | ○ One-time, opt-in import of its genre map coordinates if the owner wants the map view; no ongoing connector |
| **AcousticBrainz** | Shut down Feb 2022; 7.5 M-track dump remains | ○ Skip as a connector — FreqBlog already folds several AcousticBrainz low-level fields into its replies; a dump import only for tracks FreqBlog misses, if coverage proves thin |

### 10.3 Graph & connection views (DeepSeek §2.13, sequencing §5.1)
| Item | Status |
|---|---|
| Co-listening network (Kimi R1) — Connections page | ✅ |
| Playlist overlap / genealogy, incl. near-copies | ✅ |
| Artist family tree (MusicBrainz member-of / collaboration relations) | ✅ 10b |
| Seed-based neighbourhood graph; containment pack | later |

### 10.4 Discovery depth (DeepSeek §2.3 / §2.4 / §2.6)
| Item | Where | Status |
|---|---|---|
| Blind spots (never-played similar artists, doorstep scenes, empty regions, thin decades) | Bubble & blind spots page (10b) | ✅ |
| Bubble score (scene entropy + effective artists, per year) | Bubble & blind spots page | ✅ (log-of-zero fixed 10b) |
| Anti-recommendations (should like, but skip; tags you skip) | Bubble & blind spots page | ✅ |
| Activity inference (focus / commute / workout / party / wind-down) | Sessions | ✅ |
| Duration preference | Insights → Sound | ✅ |

### 10.6 Owner feedback folded into 10b
FreqBlog key names canonical from `key_int` + `mode` (the real reply spells one key both `A#-Major` and `Bb-Major`); Discover split into **Discover** / **Bubble & blind spots** / **Mixtape**; the activity card moved under the Sessions banner; Best finds (The Newness) and By country (Atlas) no longer end halfway down a stretched box.

### 10.5 Owner feedback folded into 10a
FreqBlog parser (features were billed but read as misses), album obscurity (Last.fm steps no longer chained), obscurity on Artist and Album pages, nameless followed playlists, playlist affinity %, Atlas country names from ISO codes, **The Newness** page.

---

## 3. Deferred backlog (not scheduled)

Pulled from the review catalogue; see `recommendations/STATUS.md` for the source section of each.

- **Power user**: command palette (Kimi R2), read-only query console, saved views / custom dashboards, local API, CLI, plugins.
- **Memory & sharing**: life events / chapters, session surgery (split / merge), Year-in-Review microsite, taste profile card, year-mosaic poster, local notification digest, collaborative playlists via file.
- **Gamification**: listening goals, quests, streak calendar and longest streaks.
- **Accessibility**: full keyboard audit, table twin for every chart (R6), high-contrast skin, reduced-motion audit, string externalisation (i18n).
- **Operational**: auto-update, scheduled markdown reports, system notifications, portable-mode sync, multi-record.
- **Stylus**: S3 relay container, S4 replacement mode.
- **Other**: multi-friend Blend, temporal Sankey, Setlist.fm (owner chose audio features in 9b), journal / notes (owner deprioritised in 9a — could now live in the metadata panels).

## 4. Dropped, with reasons
- Last.fm "obsessions" — not in Last.fm's API (read or write); scrape-only.
- Rate Your Music, Apple Music API — wrong access model (synthesis §3).
- React Query migration — the custom hook + memoisation does the job (Kimi).
