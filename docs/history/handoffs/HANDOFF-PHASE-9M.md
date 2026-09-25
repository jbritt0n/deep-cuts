# Handoff — Phase 9n (next development run)

**Written:** September 24, 2026, at the Phase 9m checkpoint.

## 0. What shipped
| Item | Where |
|---|---|
| **Stylus S1** — ListenBrainz-compatible scrobble receiver, device tokens, per-device privacy, pause/revoke, now playing; dedupe both ways against Spotify | `src-tauri/src/stylus.rs`, `src-tauri/sql/stylus_process.sql`, `entity_resolution.sql` (Stylus-gives-way rule), `src/components/StylusCard.tsx`, Services |
| Era weather on hover | `rangeWeather` in `weatherQueries.ts`, `EraWeather` in `EraChart.tsx` |
| Per-kind thread caps | `thread_max_scene`, `thread_max_decade` (Tuning), `threadQueries.ts` |
| Weather-gated dynamic playlists | `DynamicPlaylist.weatherGate`, Library → Dynamic "Only on" |

## 1. Rust (uncompiled) — compile first
- **New dependency** `tiny_http = "0.12"` (Cargo.toml).
- **`stylus.rs`** (new; `mod stylus;` in lib.rs): uses `tiny_http::{Header, Method, Request, Response, Server, StatusCode}`; `Server::http(&str)`, `server.incoming_requests()`, `server.unblock()`; `req.url()`, `req.method()`, `req.headers()` with `h.field.equiv("Authorization")` and `h.value.as_str()`, `req.as_reader().take(n).read_to_string(..)`, `req.respond(Response::from_string(..).with_status_code(StatusCode(code)).with_header(..))`. Token hash via `sha2`, random via `rand::RngCore`. Statics: `Mutex<Option<(Arc<Server>, String)>>`, two `AtomicBool`s.
- `commands.rs`: `stylus_status`, `stylus_configure`, `stylus_add_device`, `stylus_update_device`, `stylus_remove_device` (registered in lib.rs); whitelist + `thread_max_scene`, `thread_max_decade`.
- `db.rs`: `STYLUS_PROCESS_SQL`. `lib.rs` setup: starts Stylus when `app_meta.stylus_enabled = 'true'`.
Likely compile snags, if any: `Header::from_bytes` argument types (`&[u8]` for both), `HeaderField::equiv` taking `&'static str`, and moving `req` into `reply` while it's borrowed in a match — each is a one-line fix.

## 2. Verify on the owner's machine
1. Services → Stylus → on → add a device → Web Scrobbler with the token → a Bandcamp play appears within a minute.
2. Phone on the same network (LAN on) with Pano scrobbling the Spotify app → one play, not two, after the next Spotify poll.
3. Linux firewall (ufw) may block port 4749 from other devices — allow it on the LAN only if needed.

## 3. Next
Stylus S2 (per-device retention, Settings → Privacy page listing exactly what each device keeps), S3 relay container (store-and-forward, pull model) with docker-compose, S4 replacement mode; `{code, message}` error envelope; words-playlist vocabulary tuned from the owner's real phrasing.
