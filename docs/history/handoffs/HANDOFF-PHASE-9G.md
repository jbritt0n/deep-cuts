# Handoff — Phase 9h (next development run)

**Written:** September 22, 2026, at the Phase 9g checkpoint. Rust from 9c–9g is uncompiled; compile everything together (`HANDOFF-PHASE-9F.md` §1 lists the 9f files).

## 0. What 9g delivered (roadmap items, no owner feedback pending)
| Item | Where | Notes |
|---|---|---|
| **Atlas** — world map of artist origins | `src/pages/Atlas.tsx`, `src/lib/originQueries.ts`, `src/assets/world-110m.json`, nav under Understand | Shaded by hours (or artists), hover card, click → artist list, table twin, "how the map widened". 175 countries baked; no runtime map library. |
| **The Forecast** (summary §3.2) | `src/lib/forecastQueries.ts`, `src/components/ForecastCard.tsx`, `forecast_log` table, `forecast_log_write` command (Rust + dev-server) | Distribution over scene families + day-parts from the last 26 same-weekdays; high-confidence call ≥ 85 % / ≥ 8; logged write-once per day; Brier + skill scoring on Insights. |
| **FreqBlog audio features** (9b §2.1) | `src-tauri/src/connectors/freqblog.rs`, `track_features`, `freqblog_connect/_disconnect`, `sync_now "freqblog"`, 6-h scheduler tick, Services card, `src/lib/featureQueries.ts`, `src/components/SoundSection.tsx` | ISRC-first `/bulk` × 25, 202/429 handling, monthly counter, 900 cap. |
| **Scene-family threads** | `threadQueries.ts` (`sceneWeekShares`, `kind`, `label`), Eras badges | Broad line above tag threads; exempt from coverage ceiling. |
| **Tuning knobs** | `settings.ts` group `threads`, Settings → Tuning card, `set_setting` whitelist | Thread length / share floor / coverage / scene switch; Not-for-me exposures / skip rate. |

Verification: tsc clean · 29 vitest · 21 SQL fixtures · 11 smoke scripts (`smoke-9g.ts` new, in CI) · `vite build --mode browser`.

## 1. Rust written in 9g (uncompiled) — compile first
- **`connectors/freqblog.rs`** (new, `pub mod freqblog` in `connectors/mod.rs`): `connect`, `disconnect`, `enrich`, `used_this_month`, `MONTHLY_CAP`. Uses `reqwest::blocking` with `.query(&[("wait","20")]).json(&body)`, `chrono::Utc`. **The response shape is a guess** — `parse_items` accepts an array or `results|tracks|items|data`; `parse_feat` accepts flat fields or `features|audio_features|analysis|data` nesting and both `bpm|tempo`, `key_name|key`, `loudness_db|loudness`. On first live call, log one real `/bulk` reply (redact the key), fix the field names, and drop it in `docs/fixtures/freqblog-bulk.json`.
- **`secrets.rs`**: `FREQBLOG_KEY`. **`migrate.rs`**: added to `SECRET_KEYS` so it travels in move bundles.
- **`commands.rs`**: `forecast_log_write` (returns `bool` = wrote), `freqblog_connect`, `freqblog_disconnect`, `sync_now` "freqblog" branch, `set_setting` whitelist +6 keys, `services_status` extra for `freqblog`. Registered in `lib.rs`.
- **`scheduler.rs`**: FreqBlog task (first tick at 4 min, then every 6 h).
- **Schema** (idempotent): `forecast_log`, `track_features`, `connector_state` row `freqblog`. No `PIPELINE_REV` bump needed — nothing derived changed.

## 2. Verify on the owner's machine
1. Atlas: after MusicBrainz has resolved a good share of artists, the map should be well coloured; Turkey / Japan / West Africa should stand out given the owner's scenes. Unplaced artists count shown in the header.
2. Forecast: the dashboard card appears; next day Insights → *How predictable are you?* shows "Scoring so far: 1 day". A week later a verdict.
3. FreqBlog: connect → *Sync now* → Activity line with request count; Sound section fills. Check the monthly bar climbs by 1 per bulk request, not per track.
4. Eras: scene-badged threads present; toggle off in Tuning removes them live.

## 3. Re-baking the map
```
npm i world-atlas@2 topojson-client@3 i18n-iso-countries@7 d3-geo@3   # in a scratch dir
# feature(topo, objects.countries) → geoNaturalEarth1().fitSize([960,480], Sphere) → geoPath.digits(1)
# key by numericToAlpha2(id); XK/CY/SO by name → { width, height, sphere, paths: {A2: d}, names }
```
The 50m file would triple the size for little gain at this display width.

## 4. Design decisions worth confirming
- **Forecast scene = strongest family per artist**, same as the Crate. Multi-family artists contribute to one line, so probabilities stay a proper spread.
- **No point predictions anywhere.** The card never names a track. Summary §3.2 is followed literally.
- **Sound omits valence/mood on purpose.** They are stored (`track_features.valence`, `mood`) for Ask the Archive; charting them would imply precision FreqBlog disclaims.
- **Threads: scene kind is a third series, not a replacement.** Owner asked in 9e for tag threads to stay niche; scene threads add the broad layer rather than collapsing tags away. If the chart gets busy, `maxThreads` (12) splits evenly by hours regardless of kind — consider a per-kind cap.

## 5. Next from the roadmap
- **Dynamic playlists** (9b §2.2): `created_playlists.refresh_cadence` + `refresh_spec`; the track list is built in TS, so the refresh must run from the frontend on launch (or move the spec builders to SQL). Suggest-only mode first.
- **Ask v2**: theme playlists from candidate scoring; Liner Notes rewritten by the local model with fact-checking against `composeNotes`. `track_features` and `track_lyric_keywords` now give it audio + lyric evidence.
- **Atlas follow-ons**: click-through to Explore filtered by country; city dots for the top cities; origin correction UI (write to `artist_origin` with `source = 'owner'`).
- **Forecast follow-ons**: weather (the summary's "rainy Sundays") needs a weather source — Open-Meteo is free and keyless; seasonal modifier; "unpredictable in March" callouts on Eras once accuracy has months.
- **Per-kind thread caps**; **Sound on the artist and album pages** (mean bpm/key/energy of that artist's catalogue you've played).
- Housekeeping from earlier handoffs: structured `{code, message}` error envelope at the Rust boundary (Kimi T2) — now four connectors deep; connector parse-test fixtures (Kimi T5), starting with the FreqBlog reply above.
