# Handoff — Phase 9l (next development run)

**Written:** September 24, 2026, at the Phase 9k checkpoint (roadmap items; no owner feedback pending).

## 0. What shipped
| Item | Where |
|---|---|
| Weather (Open-Meteo): history for the record's span + 7-day forecast; listening × weather analysis; weather in the 7-day outlook and today's broadcast | `src/lib/weather.ts`, `src/lib/weatherQueries.ts`, `src/components/WeatherCards.tsx`, Settings → Record → Weather, Moods & Forecast |
| Dynamic playlists: 7 rules, daily/weekly, preview, create-and-link on Spotify, in-place sync, refresh on launch when due | `src/lib/dynamicPlaylists.ts`, `src/components/DynamicPlaylists.tsx`, Library → Dynamic, song page *Keep it fresh* |
| Tempo dial, session energy curve, mix into next | `src/components/SoundTools.tsx`, `src/lib/featureQueries.ts` |
| Fix: Wikipedia images blocked by CSP | `src-tauri/tauri.conf.json` |

## 1. Rust (uncompiled) and config
- `commands.rs`: `weather_store(rows: Vec<Value>)` (skips malformed dates; forecast rows never overwrite observed), `replace_playlist_items(playlist_id, track_ids)`; whitelist + `dynamic_playlists`, `weather_lat`, `weather_lon`, `weather_place`. Both registered in `lib.rs`.
- `spotify/client.rs`: `pub fn put(...)` — same `request` path as `post`.
- `playlists.rs`: `replace_items` — first 100 by PUT `/playlists/{id}/items`, the rest by POST; empty list clears.
- `tauri.conf.json` CSP: `connect-src 'self' ipc: http://ipc.localhost https://api.open-meteo.com https://archive-api.open-meteo.com https://geocoding-api.open-meteo.com`; `img-src` + `https://upload.wikimedia.org`. **Check on first launch** that invoke calls still work (the explicit `ipc:` entries should keep Tauri's IPC allowed) — if every page errors, the connect-src line is the first suspect.

## 2. Verify on the owner's machine
1. Settings → Record → Weather → set the city → history backfills (a few seconds per year of record).
2. Library → Dynamic → a daily playlist linked to Spotify; the next day it has new songs under the same link. Replacing requires the `playlist-modify-private` scope the app already uses for creating playlists.
3. Song page → Mix into next / Sounds like this need FreqBlog features for that song.

## 3. Next
Stylus S1 (receiver + device tokens), background first-launch rebuild with a progress screen, Ask v2 (theme playlists from candidate scoring), per-kind thread caps, weather on Eras (rainy seasons), dynamic playlists driven by weather ("rainy-day station" that only refreshes on rainy days), `{code, message}` error envelope.
