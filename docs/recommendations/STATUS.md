# Status of every recommendation (as of Phase 10a, September 25, 2026)

The four reviews in this folder are kept verbatim; this file is the ledger. ✅ built · ◐ partly · ○ open (in `../ROADMAP.md`) · ✗ dropped.

## Kimi (`kimi-recommendations.md`)
| Item | Status | Where / note |
|---|---|---|
| T1 CI test job + build gating | ✅ | `.github/workflows/build.yml` (tsc, vitest, SQL fixtures, 18 smoke scripts); `cargo test` still to add (Phase 10.1) |
| T2 `{code, message}` error envelope | ✅ | 10b: `commands.rs::err`, `src/lib/errors.ts`, ErrorBox |
| T3 Chart memoisation + skeletons | ✅ | skeletons 10a; all 11 chart components `React.memo` in 10c |
| T4 Global "attended only" lens | ✅ | filter lens (Phase 8) |
| T5 Connector parse fixtures | ◐ | 10b: FreqBlog bulk reply (`src-tauri/tests/fixtures/`); others open |
| T6 Quota transparency on Services | ◐ | Spotify pause note, FreqBlog units; no per-service daily budget view |
| T7 One restore drill | ✅ | move-bundle export → restore round trip (9f) |
| R1 Artist co-listening network | ✅ | Connections (10a) |
| R2 Command palette | ✅ | 10c: `CommandPalette.tsx` — Ctrl/⌘+K or `/`; pages, Settings tabs, actions, record search (fuzzy) |
| R3 Attention-adjusted streaks & records | ◐ | attended lens applies to streaks; no separate records view |
| R4 Setlist.fm | ✗ | owner chose audio features (9b) |
| R5 Deezer energy/BPM | ✅ | replaced by FreqBlog (9g, parser fixed 10a) |
| R6 Accessibility data tables | ◐ | Atlas table twin; not every chart |
| R7 LLM phase gate | ✅ | Ask the archive local-only (9e) |

## Synthesis (`NEXT-DROP-RECOMMENDATIONS.md`)
| § | Item | Status |
|---|---|---|
| 1.1 | Parameterised SQL | ✅ Phase 8 |
| 1.2 | `assert_read_only` substring matching | ◐ word tokenizer 9h; not a parser |
| 1.3 | Frontend tests | ✅ vitest (46 tests) |
| 1.4 | Unread columns: explicit ratio / ISRC duplicates | ✅ explicit ratio · ✅ ISRC report (10a) |
| 1.5 | "Say the word to revert" decisions | ○ review with owner |
| 2.1.1 | Record Hygiene | ✅ |
| 2.1.2 | Journal / annotations | ✗ owner deprioritised (9a) |
| 2.1.3 | Blind spots + bubble score | ✅ 10a |
| 2.1.4 | Playlist health | ✅ 9a (+ affinity 10a) |
| 2.1.5 | Query console / local API | ○ deferred |
| 2.1.6 | Playlist overlap graph | ✅ 10a |
| 2.2.7 | Setlist.fm | ✗ |
| 2.2.8 | Artist family tree | ✅ 10b (Connections) |
| 2.2.9 | Audio features | ✅ FreqBlog |
| 2.2.10 | Discogs | ○ Phase 10.2 |
| 2.2.11 | Co-listening network | ✅ |
| 2.2.12 | Command palette | ○ deferred |
| 2.3.13–16 | Loyalty timeline, silence report, device hand-off, explicit ratio | ✅ |
| 2.3.17 | Year-mosaic poster | ○ deferred |
| 2.3.18 | Local notification digest | ○ deferred |
| 2.3.19 | Passphrase-protected export | ✅ move bundle (9f) |
| 3 | Connectors: Discogs build · WhoSampled consider · Every Noise / AcousticBrainz one-time | see ROADMAP §10.2 (WhoSampled → MusicBrainz relationships) |

## DeepSeek features (`deepseek_markdown_20260911_eca849.md`)
| § | Items | Status |
|---|---|---|
| 2.1 | Outlier panel ✅ · session surgery ○ · import diffing ◐ (Polled vs exported) · integrity card ✅ |
| 2.2 | Notes ✗ · On this day ✅ · life events / chapters ○ · concert memory ○ |
| 2.3 | Blind spots ✅ · bubble score ✅ · rediscovery engine ✅ (Crate, Daily Dig, dynamic rule) · anti-recommendations ✅ · import from other services ◐ (Last.fm, stats.fm, ListenBrainz, Stylus) |
| 2.4 | Weather ✅ · activity inference ✅ · velocity ✅ · temporal Sankey ○ |
| 2.5 | Playlist health ✅ · genealogy ✅ · auto-curation ◐ (dynamic playlists) · Blend v2 multi-friend ○ |
| 2.6 | Tempo drift ✅ · key/mode ✅ · harmonic diversity ✅ · duration preference ✅ |
| 2.7 | YIR microsite ○ · taste profile card ○ · collaborative playlists via file ○ |
| 2.8 | Query console ○ · local API ○ · CLI ○ · saved views ○ · plugins ○ |
| 2.9 | Keyboard ◐ · data tables ◐ · i18n ○ · high contrast ○ · reduced motion ◐ (global media query) |
| 2.10 | Goals ○ · quests ○ · yearly wrapped ✅ (In Review) · streaks ◐ |
| 2.11 | Auto-update ○ · scheduled exports ◐ (Parquet backups; no markdown report) · notifications ○ · portable sync ○ · multi-record ○ |
| 2.12 | Ask the archive ✅ (+ playlist from words 9l) |
| 2.13 | Family tree ✅ · containment pack ○ · neighbourhood graph ○ · playlists-I-follow graph ✅ (overlap) |

## DeepSeek connectors (`deepseek_markdown_20260911_d17ea2.md`)
Built: Spotify, Last.fm, MusicBrainz, Cover Art Archive, LRCLIB, stats.fm, ListenBrainz, Wikipedia, FreqBlog, Open-Meteo. Planned: Discogs. Replaced: WhoSampled → MusicBrainz relationships; AcousticBrainz → FreqBlog. Skipped: Rate Your Music, Apple Music API, Deezer.
