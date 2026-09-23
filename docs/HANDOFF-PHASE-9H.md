# Handoff — Phase 9i (next development run)

**Written:** September 23, 2026, at the Phase 9h checkpoint. Rust from 9c–9h is uncompiled; compile everything together (9f §1 and 9g §1 list earlier files).

## 0. The 9g feedback and what shipped
| Feedback | Cause | Fix |
|---|---|---|
| Sidebar too long; move Not for me; collapsible sections | 21 flat entries | 4 pinned + collapsible Understand (6) / Stories (4) / Act (3) / App (3, collapsed); state persists; Not for me → Settings tab; `/notforme` redirects |
| Two scrollbars; tops of Liner Notes / Settings cut off | Shell grid row grew with content → body *and* main scrolled; `scrollIntoView` could move the hidden body | `overflow: clip` on html/body/#root, `grid-rows-[minmax(0,1fr)]`, single `main` scroller, scroll-to-top on route change |
| Explore lists hard to reach; header search should go there | 9e moved `/explore` to Ask | header → `/explore/lists?q=`; `ExploreSearch` atop Ask (works without Ollama) |
| Pages too big on the Toshiba (Eras, Library › Playlists) | Fixed 16 px root + pixel charts + unbounded lists | Display size (Auto/Compact/…); EraChart height from viewport; list heights capped in vh; playlist panes bounded side by side |
| Rising and fading only a note | Listener counts re-fetched every **90** days → no second snapshot until December | 30-day refresh (`lastfm.rs`); `listenerLandscape()` shows audience-size split + "small rooms" + due date meanwhile |
| "disallowed keyword: LOAD" | Rust guard substring-matched `LOAD ` inside `payload ` | Word tokenizer ignoring literals/comments (`db.rs::sql_words`) + unit tests |
| Lyric keywords mostly Russian/Turkish | Whole-corpus IDF made minority-language words look rare | IDF per language; English / other / per-language chips |
| Forecast page, weather/radio themed, merged with Moods | — | **Moods & Forecast**: broadcast, hourly radar, likely artists/songs + station playlist, 7-day outlook, fronts, 28-day backtest, logged accuracy, the ten stations (FM frequencies) |
| Atlas: what I play abroad | — | **Listening abroad**: trips, souvenir song, local-artist share vs home, scenes that travel, "where you listened" map mode, home override |

## 1. Rust (uncompiled)
- `db.rs`: `assert_read_only` now uses `sql_words()`; list gained DETACH, SET, CHECKPOINT, VACUUM. `#[cfg(test)] mod guard_tests` — run `cargo test guard`. A Python port passed the same cases and found no app query that trips the list.
- `connectors/lastfm.rs`: popularity refresh 90 → 30 days.
- `commands.rs`: `set_setting` whitelist + `home_country`.
No schema bump; `track_lyric_keywords` view is recreated on open (adds a `lang` column).

## 2. Verify on the owner's machine
1. The Toshiba (Linux MX, 1366×768): Settings → Appearance should read "Auto — 13 px chosen for this 1366×6xx window". Eras' areas chart and Library › Playlists fit without page scroll.
2. Trackpad scrolling on Liner Notes / Settings: one scrollbar, top always reachable.
3. Insights → *How predictable are you?* moved to Moods & Forecast → Verification; it should load. Rising and fading shows the audience-size view with a date in mid-October.
4. Atlas → Listening abroad: the Italy trip with Raffaella Carrà and the Turkey trips with Duman should appear **if** those plays came from the extended export (conn_country). Polled plays need a travel range in Settings → Record to count.
5. Moods & Forecast → Verification: hit rate vs baseline. On a varied record expect a lift; "about as good as your biggest artists" means your days are very regular.

## 3. Open questions for the owner
- Stories group collapsed by default — right call? (Liner Notes / In Review are occasional reads.)
- Should the Dashboard forecast card stay now the full page exists? (Kept, with "full forecast →".)
- Souvenir weighting (1.5× for artists from the country you were in) — too strong, too weak?

## 4. Next from the roadmap
Dynamic playlists (a forecast-driven "DCFM today" playlist that refreshes each morning is a natural first spec), Ask v2, weather for the forecast (Open-Meteo, keyless — would make the weather theme literal: "rainy Sundays"), Atlas click-through to Explore and origin corrections, per-kind thread caps, Sound on artist/album pages, `{code, message}` error envelope, connector parse fixtures (FreqBlog reply).
