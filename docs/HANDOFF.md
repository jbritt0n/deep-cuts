# Handoff — current (Phase 10d → 10e)

**Written:** September 30, 2026. Replaced each build; past handoffs are in `history/handoffs/` (10c's is `HANDOFF-PHASE-10C.md`).

## What 10d changed (owner's 10c feedback)
| | |
|---|---|
| Local-model controller | `llm.rs`: `LlmConfig` read on every call — `llm_timeout_s` (default 900, was a fixed 240), `llm_num_ctx` (4096, was 8192), `llm_keep_alive_min`, `llm_num_thread`, `llm_num_predict`, `llm_structured`. `chat_ex` / `chat_structured` (JSON-schema `format`, falls back to JSON mode on older Ollama). Every call logged to `llm_calls`. Timeouts → new error code `slow_model` (Rust `error_code` + `errors.ts`). `Foreground` guard: page calls mark themselves busy and background tagging yields. |
| Settings → Local model | `src/components/LocalModelPanel.tsx`: address, model picker, **Test** (`llm_test`), presets, knobs, background-tagging pace + queue, "how long it really takes" (median / p90 / max per purpose). Old Ollama card on Connectors now links here. |
| Lyric tagging v2 (`llm_rev` 2) | `connectors/lyrics.rs`: fixed `MOODS` (38) and `THEME_VOCAB` (57, first 35 = the lexicon themes) sent as a schema; `coerce_mood` / `coerce_theme` map legacy/free answers; keywords grounded in the text; `clean_title` strips "(Radio Edit)" etc. (also a second LRCLIB try with the cleaned title); summary kept only if no 5-word run matches the lyrics. **Tagging left the LRCLIB batch** — own queue `llm_batch` in `scheduler.rs` (`llm_lyrics_per_tick`, `llm_lyrics_tick_min`), re-fetches text transiently. Schema cleanup nulls the 9f instruction echoes. Vocab lists mirrored in `src/lib/lyricVocab.ts` (vitest compares them). |
| Lyric hygiene | Tables `lyric_overrides`, `lyric_term_blocklist`; views `track_lyrics_effective` and a re-created `track_lyric_keywords` honour corrections. Commands `lyrics_override_set` / `_clear`, `lyrics_blocklist`, `lyrics_requeue`, `lyrics_llm_track`, `lyrics_refetch_track` (mirrored in dev-server.mjs except the two network ones). |
| Lyrics page (`/lyrics`) | `src/pages/Lyrics.tsx` + `src/lib/lyricQueries.ts`: five clouds, mood map, lyrical weather, theme drift × year and × day part, wordiness, valence vs skips, languages, Hygiene (filters incl. *suspicious*), song editor with every term + scores + lyrical neighbours. `/lyrics?song=<id>` opens one song (linked from the song page). Insights card now points here. `WordCloud` is responsive, rank-coloured, up to 180 words. |
| Liner Notes | Calendar + year strip, `weekExtras` / `notesPrompt` in `notesQueries.ts`, model writing saved to `llm_writings` (`writing_save` / `_delete` / `_pin`); jobs survive leaving the page (`src/lib/llm.ts` `writeWithModel`). |
| Roast Me | `Period` (all / year / month / week), 16 new receipts (`nicheReceipts`), `roastDossier` + `roastMessages` for the model, routines saved. Fixed: the longest-session receipt used non-existent `started_at/ended_at` and never showed. |

## Rust (uncompiled) — compile first
- `llm.rs` rewritten (closure with explicit `-> Result<ChatReply>`, `reqwest::Error::is_timeout/is_connect`); its test calls `crate::commands::error_code`.
- `connectors/lyrics.rs`: v2 block, `fetch_text`, `llm_batch`, `retag_track`, `refetch_track`, `llm_pending`, `mod llm_v2_tests` (4 tests incl. the owner's Radio Edit / "1 to 2 words" / Hypercolour cases). The inline `llm_theme` is gone.
- `commands.rs`: `llm_chat` gains `purpose`, `num_predict`; new commands listed above; allow-list keys; `writing_pin` uses `UPDATE … FROM` (DuckDB has no row-value subquery compare — caught by smoke-10d).
- `scheduler.rs`: the `lyrics-llm` loop. `lib.rs`: 10 new commands registered.

## Verify on the owner's machine
1. Settings → Local model → pick qwen2.5:0.5b → **Test**; choose *Old or slow PC*; turn on background tagging.
2. After a few ticks: Lyrics → Moods shows only palette moods; Hygiene → *Suspicious tags* lists the old 9f tags (Big Bad Wolf's "radio edit" is already cleared); **Ask the model again** on one song.
3. Liner Notes → pick a week → *Write with your local model*; leave and return — it finishes and the calendar shows ✎.
4. Roast Me → *A month* → *Roast me*. The call log shows each job's time.

## Tests
`npm test` → 52; `npx tsx scripts/smoke-10d.ts` (dev-server with `OLLAMA_MOCK=1`) → `10d smoke OK`; all earlier smoke scripts and `test_sql_fixtures.py` still pass.

## Next (10e) — ideas from the lyric work
Mood/theme rules for dynamic playlists; lyric-mood band on Eras; "sounds happy, reads bleak" (lyric valence vs FreqBlog energy); feed lyric themes into Daily Dig; streaming replies for the model on slow machines.
