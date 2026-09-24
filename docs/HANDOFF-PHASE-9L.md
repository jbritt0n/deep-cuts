# Handoff — Phase 9m (next development run)

**Written:** September 24, 2026, at the Phase 9l checkpoint.

## 0. What shipped
| Item | Detail |
|---|---|
| Exports enrich polled plays, never duplicate | Poll time may be the start or the end of play (Spotify only says "when it was played") — both are matched within 15 s; the export row wins (real ms, skip reason, device, country). Fixture covers start, end, drift and a back-to-back repeat. Settings → Record → *Polled vs exported*. |
| No rebuild on every launch | Found while doing the above: startup rebuilt whenever `COUNT(events) ≠ COUNT(plays_resolved)`, which is permanently true once an export supersedes polls. Replaced by a watermark (`app_meta.resolved_through`, written by every resolution). |
| Background first-launch rebuild | The window opens first; the rebuild runs on a thread; a banner shows while `app_meta.rebuilding = '1'`; `built_with` is written only on success. |
| Playlist from words (Ask v2) | `src/lib/wordsPlaylist.ts`, `src/components/WordsPlaylist.tsx`; dynamic rule `words`. |

## 1. Rust (uncompiled)
- `lib.rs`: `open_databases` returns a 4-tuple `(real, demo, zone, rebuild)`; the setup hook spawns `std::thread::spawn` with `app.state::<AppState>().real.clone()` and `app.handle().clone()`, then `events::emit(&handle, events::DATA_CHANGED, …)`. Uses `PIPELINE_REV` and `serde_json` already in scope.
- SQL only otherwise: `entity_resolution.sql` (match rule + watermark), `poll_insert.sql` (end-of-play match).
While the background rebuild runs, the scheduler may poll and run entity_resolution concurrently; statements serialise on the connection, so the worst case is a slower rebuild.

## 2. Verify on the owner's machine
1. Import a new extended-history file that overlaps polled months → *Polled vs exported* shows the replacements; skip rates for those months change to the export's.
2. Relaunch twice → no rebuild the second time (check `logs/deep-cuts.log`).

## 3. Next
Stylus S1, per-kind thread caps, weather on Eras, a weather-gated dynamic rule ("rainy-day station" refreshing only on rainy days), `{code, message}` error envelope, words-playlist refinements from real use (the owner's phrasing will show which words the vocabulary misses).
