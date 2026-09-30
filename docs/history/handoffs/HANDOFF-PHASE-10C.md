# Handoff — current (Phase 10c → 10d)

## What 10c changed
UI foundations: command palette (`src/components/CommandPalette.tsx`, `src/lib/fuzzy.ts`), overlays (`src/components/Overlay.tsx`: confirmDialog, toast, OnThisPage), Card anchors (`id="c-<slug>"`), global focus-visible (`src/index.css`), `React.memo` on all chart components, `deepcuts:refresh` re-runs `useAsync`. Data: ISRC version merge in `entity_resolution.sql` (setting `merge_isrc_versions`); `track_lineage` + `enrich_lineage` in `connectors/musicbrainz.rs` (scheduler 8/tick, manual sync 40), `LineageCard` on Track. Tests: `smoke-10c.ts`, fuzzy unit tests, ISRC fixture; smoke-9i made rerunnable.

**Uncompiled Rust to watch in CI:** `musicbrainz::enrich_lineage` (closures `put`/`stop`, `dedup_by`), its calls in `scheduler.rs` and `commands.rs`, and the `merge_isrc_versions` allow-list entry.

---
# Previous handoff (Phase 10b → 10c)

**Written:** September 25, 2026. Replaced each build; past handoffs are in `history/handoffs/`. The plan lives in `ROADMAP.md`.

## What 10b changed
| | |
|---|---|
| FreqBlog | The owner's real `/bulk` reply confirmed the 10a diagnosis (features under `result`) and is now `src-tauri/tests/fixtures/freqblog-bulk.json`, parsed by three Rust tests. Key names come from `key_int` + `mode` (`canonical_key`) because the reply spells one key as both `A#-Major` and `Bb-Major`. |
| Discover | Split: **Discover** (recommendations, release radar, genre browse), **Bubble & blind spots** (`/depth`), **Mixtape** (`/mixtape`: builder, curated, Made by Deep Cuts). Bubble's LOG2(0) fixed (zero-length plays). |
| Layout | Activity card under the Sessions banner; Best finds and Atlas "By country" no longer stretched with a half-height scroll list. |
| Error envelope (Kimi T2) | `commands.rs::err` → `{code, message}`; `error_code` + tests; `src/lib/errors.ts` (`classify`, `DeepCutsError`, `describeError`) + tests; bridge converts every failure; ErrorBox shows a plain explanation with details. |
| CI | `cargo test --lib --locked` on Linux before packaging (with a placeholder `dist/`). |
| Family tree | Connections → Family tree: two rings of MusicBrainz relationships, yours highlighted, click to re-centre. Demo gains a few real relationships. |
| Stylus S2 | `stylus_devices.retention_days`; details (player, service, device name) dropped after N days, plays kept; Settings → **Privacy** tab. |

## Rust (uncompiled) — compile first
- `commands.rs`: new `err` body + `error_code` + `mod envelope_tests`; `stylus_update_device` gains `retention_days: Option<i64>` and runs `STYLUS_PROCESS_SQL`.
- `connectors/freqblog.rs`: `canonical_key`, key/mode block, `mod fixture_tests` (uses `include_str!("../../tests/fixtures/freqblog-bulk.json")` — path relative to `src/connectors/`).
- The first CI run of `cargo test` also compiles the 9h guard tests for the first time.

## Verify on the owner's machine
1. Services → FreqBlog climbs; Insights → Sound and Moods → Tempo dial fill in; the key wheel shows one entry per key.
2. Act → Bubble & blind spots loads without an error.
3. Any error now reads as a sentence with "details" underneath.

## Next (10c) — ROADMAP §2
Discogs connector (label / format / pressing); MusicBrainz samples & covers card on song pages; more connector fixtures (Last.fm, MusicBrainz); chart memoisation; merge ISRC versions into one entry.
