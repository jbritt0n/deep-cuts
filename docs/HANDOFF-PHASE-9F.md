# Handoff — Phase 9g (next development run)

**Written:** September 22, 2026, at the Phase 9f checkpoint. Earlier handoffs (9C–9E) list uncompiled Rust from those phases; compile everything together.

## 0. What 9f answered (owner's 9e feedback)

| Feedback | Root cause found | What shipped |
|---|---|---|
| Export the whole record to another computer | Nothing existed beyond the nightly `events` Parquet | **Move bundle**: `migrate.rs` writes every table as Parquet into one zip + manifest (+ passphrase-encrypted keyring secrets); restore is column-intersecting and rebuilds derived tables under the receiving build. Settings → Record → *Move to another computer*. Round-trip verified in the harness (42 tables, identical counts). `docs/MOVING.md`. |
| Lyric keywords generic, themes off | Raw word frequency + small stop list; a theme fired on one word ("gold" → money) | **Lyrics v2** (`features_rev 2`): per-song term counts → `track_lyric_keywords` TF-IDF view over *your* corpus; 34 scored themes with weighted cues (≥ 2 cues or ≥ 3 hits, density-scored, full map in `theme_scores`); valence, repetition, vocab, language (themes only for English); optional Ollama theming (`lyrics_llm_enabled`). Old rows re-fetched gradually. Insights cloud: keywords / themes / model themes / moods. |
| Only 18 scenes; more geographies + niche scenes | Vocabulary was a `VALUES` list inside `compute_insights.sql` | **Scenes as data**: `scene_families` (66) / `scene_tag_map` (1,087) / `scene_origin_map` (180 countries); `compute_scenes.sql`; Settings → Tuning → **Scenes** editor (add families, file unfiled tags, origin fallbacks, hide built-ins, *Re-file now*). 9e overrides still resolve (all 18 keys kept). |
| Can't navigate to the unsorted crate section | Clicking *unsorted* set the filter to `null` (matched nothing) **and** the deck was capped at 400 records sorted by section, so the unsorted divider (sorted last) fell off the end | `section = 'unsorted'` → `section IS NULL`; ⊙ filter works for it; cap lifted; smoke asserts the count matches `crateSections`. |
| Old playlists never appear in Library | `sync_playlists` fetched items inline, newest playlist first, and **any** failure aborted the loop with `?`. Spotify closed its own playlists to third-party apps (Nov 2024) → a followed *Discover Weekly* near the top returned 403/404 and ended the sync before older playlists were reached | Two-pass sync in `sync.rs`: metadata for all, then items only where never synced or `snapshot_id` moved (own first, oldest-known first); per-playlist errors recorded in `playlists.sync_error`, Spotify-made marked `unreadable` up front; failures no longer abort liked/enrichment. Library shows *unreadable* separately from *partial*. |

Roadmap items delivered: **Daily Dig** (dashboard), **obscurity trajectory** (artist page sparkline + *Rising and fading* on Insights).

## 1. Rust written in 9f (uncompiled) — compile first
- **`src/migrate.rs`** (new): `export_bundle`, `inspect_bundle`, `restore_bundle`, XChaCha20-Poly1305 helpers. New dep **`chacha20poly1305 = "0.10"`** in `Cargo.toml` (pure Rust, no system libs). Uses `zip::write::SimpleFileOptions` (zip 2.x), `tempfile`, `rand::thread_rng`, `sha2`. Things to check on first compile: `zip.start_file(String, opts)` signature; `db.exec_batch("BEGIN TRANSACTION")`/`COMMIT` through the shared connection; `DESCRIBE SELECT * FROM read_parquet(...)` column name `column_name`.
- **`src/connectors/lyrics.rs`** (rewritten): `extract()`, `store()`, `llm_theme()` (calls `crate::llm::chat(db, model, &[ChatMsg], json_mode=true, 0.2)` and `crate::llm::status(db).reachable`), `enrich_batch()`, `pending()`. The `themes()` lexicon builds `Vec<(&str, f64)>` per theme via a closure `w` — if the compiler complains about the closure's array-slice parameter type, replace `w(&[...])` with `vec![...]`.
- **`src/spotify/sync.rs`**: `sync_playlists` → thin wrapper over new `sync_playlists_detailed` (returns `(seen, items_refreshed)`); new `fetch_items`. Uses `ApiError::Http { status, body }` pattern and `ApiError::Other(anyhow)`.
- **`src/commands.rs`**: `lyrics_status`, `scene_family_upsert`, `scene_family_delete`, `scene_tag_set`, `scene_origin_set`, `recompute_scenes`, `export_move_bundle`, `inspect_move_bundle`, `restore_move_bundle`; `sync_now` "spotify" branch tolerates playlist failure; `set_setting` whitelist gained `lyrics_llm_enabled`. All registered in `lib.rs` (`mod migrate;` added). `PIPELINE_REV` → **10** (forces one rebuild on first launch so scenes come from the new tables).
- **`src/db.rs`**: `COMPUTE_SCENES_SQL` embedded; `rebuild_all` runs it before insights. `importer.rs` likewise.
- **`src/scheduler.rs`**: liked/playlist sync errors are logged instead of aborting the tick.

## 2. Verify on the owner's machine
1. **First launch** rebuilds (pipeline 9 → 10). Settings → Tuning → Scenes should list 66 families with artist counts; The Crate's section strip should show far more dividers than before and *unsorted* should be reachable (click its name, or ⊙).
2. **Playlists**: Services → Spotify → *Sync now*. Activity should log "Playlists: N known" (pass 1 — N should be *all* your playlists) then "items refreshed for M". Library → Playlists: totals strip shows "K Spotify-made, unreadable"; older playlists now listed; *Followed* tab fills. A second *Sync now* should refresh ~0 items (snapshots unchanged) — quota is no longer spent re-pulling.
3. **Lyrics**: Settings → Connectors → Lyric themes shows "N songs still carry the old features"; *Fetch a batch now* → Activity: "Lyric features for 40 tracks (40 re-analysed under the v2 rules)". Insights → Lyric keywords: *keywords* should be concrete and song-specific; *themes* should read plausibly. With Ollama running and a model chosen, tick *Let the local model name themes* → *model themes* / *moods* fill in.
4. **Move**: Settings → Record → Move → *Write move bundle* (with a passphrase) → a `deep-cuts-move-….zip` appears. On a second machine (or after renaming the data folder), *Restore* → inspect shows plays/date range → restore → dashboard matches, Services shows Spotify connected (tokens restored). Try restore with the wrong passphrase: it must refuse before touching anything.
5. **Daily Dig** on the dashboard changes daily; *Put away* hides that record for 90 days from both the card and The Crate.

## 3. Design decisions worth confirming
- **Regional split of "afro".** Specific tags (afrobeat, highlife, mbalax…) now file under *West African* etc.; only umbrella tags (african, afropop) stay under *Afro (general)*. Records the owner filed under `afro` by hand in 9e remain there. If the owner prefers one African section, hide the regions in Settings → Scenes and map the tags back (all one-click).
- **Umbrella tags file broadly on purpose** — `rock` → classic-rock, `pop` → nothing. Niche families need niche tags; the *unfiled tags* queue shows what the owner's artists actually carry.
- **Lyric themes are English-only.** A Turkish song gets terms, repetition and `lang = 'tr'` but no lexicon themes. The LLM path works for any language the model reads but is only invoked for English by default (`f.lang == "en"` in `enrich_batch`) — one-line change to widen.
- **Restore replaces, never merges.** The current `events` are written to `backups/events-before-restore-*.parquet` first. A merge mode (union of two records) would need dedup by the export's `end_epoch` logic; not built.
- **Secrets encryption** is XChaCha20-Poly1305 with a 200k-round SHA-256 KDF. Fine for a zip on a USB stick; not Argon2. The passphrase is never stored.
- **Followed playlists cap at 500 items** per sync (was 300). Own playlists are unlimited.

## 4. Next from the roadmap
Forecast (summary §3.2), Ask v2 (theme playlists from candidate scoring; Liner Notes rewritten by the model with fact-checking), FreqBlog audio features, dynamic playlists, **world map** (the origin data is now much richer — `scene_origin_map` + `artist_origin` — so a map of where your artists come from is mostly UI), collapse genre threads onto scene families (now that the vocabulary is data), Skip Hall thresholds and thread coverage in Settings → Tuning.
