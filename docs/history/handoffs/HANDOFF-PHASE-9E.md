# Handoff — Phase 9f (next development run)

**Written:** September 15, 2026, at the Phase 9e checkpoint. Earlier handoffs (9C, 9D) still list uncompiled Rust from those phases; compile everything together.

## 1. Rust written in 9e (uncompiled)
- `src/llm.rs` — rewritten as a real module (no longer behind `--features llm`): `base_url(db)` from `app_meta.ollama_url`, `status()` (GET `/api/tags`, 4 s timeout), `chat(model, messages, json_mode, temperature)` (POST `/api/chat`, `stream:false`, `format:"json"` when asked, `num_ctx` 8192, 240 s timeout; logs to `api_calls` as service `ollama`). `lib.rs` — `mod llm;` unconditional; commands `llm_status`, `llm_chat` registered. Check: `serde::Serialize` derive on `ChatMsg` is needed because `messages` is serialised straight into the request body.
- `commands.rs` — `set_artist_scene(artist_id, scene: Option<String>)` (writes `scene_overrides`, updates `artist_scene` immediately); whitelist gained `ollama_url`, `ollama_model`.
- `playlists.rs` — `create()` dedupes ids, sleeps 400 ms between chunks, verifies via `ep::playlist(&pid)` (`fields=tracks.total,items.total`) and logs a `warn` when Spotify reports fewer tracks than were sent; `CreatedPlaylist` gained `on_spotify: Option<i64>`, `duplicates_dropped`. `endpoints.rs` — `playlist(id)`.
- `sql/schema.sql` — `scene_overrides`. `sql/compute_insights.sql` — overrides applied after the tag- and origin-derived scenes.

## 1a. First compile (Sep 15) — fixed
The owner's CI build surfaced two errors, both fixed in this package: `set_artist_scene` used `json!` without the
import (`commands.rs` refers to `serde_json::json!` everywhere; now it does here too), and `add_to_radar`'s second
`CreatedPlaylist` constructor in `playlists.rs` lacked the two fields added in 9e (`on_spotify: None`,
`duplicates_dropped: 0`). Name-resolution errors stop the compiler before type-checking, so a second round of
errors is possible; the rest of the 9b–9e Rust was re-read against the actual signatures in `db.rs`, `client.rs`,
`lastfm.rs` and `lib.rs` (`Row = Map<String, Json>`, `err<E: Display>`, `Tokens.scope: String`, `call(db, key,
method, params)`) and matches.

## 2. Verify on the owner's machine
1. Ollama: `ollama serve` running, a model pulled. Ask the Archive header goes green and lists models. Ask "What did I listen to most on Sunday mornings last year?" — expect ~5–20 s on a 7–8B model, a table, and prose. Open ▸ SQL and sanity-check the query the model wrote. If it repeatedly fails on the same construct, add a hint line to `SCHEMA_DOC` in `src/lib/ask.ts` — that's the whole "prompt engineering" surface.
2. Playlist: make a 100+ track playlist. The result line should say "Created with N tracks" and, if Spotify shows fewer, why. Activity gets a `warn` with the counts.
3. Crate: re-file an artist → the card updates, Scenes on Eras follows after the next nightly `compute_insights` (or a rebuild). Section strip highlight follows the front card as you flip.
4. Settings → Record → Stored data: file size should match `ls -l` on the `.duckdb`.
5. Docker (optional now): `docker compose -f docker/docker-compose.yml up -d --build` with `DEEPCUTS_DATA` pointing at a *copy* of the data folder; open `http://host:4747`; Ask works if `OLLAMA_HOST=0.0.0.0` on the host.

## 3. Design decisions worth confirming
- **Ask never sees data except the rows it asked for** (≤ 40 rows go back for narration). It also never writes; SQL passes both the client mirror and `assert_read_only`. If the owner wants the model to *propose* playlists from unseen candidates, that's a second mode (candidate scoring already exists in `recQueries.ts`; the model would only rank and explain — spec §2.12) — not built.
- **Docker is a viewer over a copied/synced record**, not a second collector. The path to "container collects" is a headless core (see `docs/DOCKER.md` option 3); it needs a browserless Spotify OAuth flow and a keyring substitute.
- Thread genericness uses a fixed stop-list *plus* a 20 % coverage rule. The coverage threshold isn't in Settings yet; `THREAD_DEFAULTS.maxCoverage` is the knob.
- Storage per group is an estimate (rows × columns share of the exact file size). DuckDB doesn't expose per-table bytes without `PRAGMA storage_info`, which the read-only guard blocks by design.

## 4. Next from the roadmap
Forecast (summary §3.2), obscurity trajectory UI, Daily Dig on the dashboard, Ask v2 (theme playlists from candidate scoring; Liner Notes rewritten by the model with fact-checking against `composeNotes`), FreqBlog audio features, dynamic playlists, world map. Consider exposing Skip Hall thresholds and the thread coverage rule in Settings → Tuning.
