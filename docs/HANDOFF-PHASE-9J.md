# Handoff — Phase 9k (next development run)

**Written:** September 24, 2026, at the Phase 9j checkpoint. 9i.1 built on GitHub; the Rust below is new since then and uncompiled.

## 0. The 9i.1 feedback and what shipped
| Feedback | Cause | Fix |
|---|---|---|
| Skips 0 % everywhere; long sessions flagged inattentive | Spotify's recently-played API has no skip reason or ms played; polls stored every play as full, never skipped → no interactions → 120-min idle rule fired | `plays_normalized` infers ms played from the next polled start and a skip when you moved on > 15 s early and < 85 % heard; inferred skips are interactions. Fixture covers a 3-hour polled evening. **Owner: run Settings → Record → Rebuild once.** |
| Edit scene and tags on Artist / Song pages (Ljupka Dimitrovska "german") | tags were read-only; removing one would be re-added by the next enrichment pass | `TagSceneEditor`; removal writes `tag_blocks`, enforced after each tag-writing pass and in compute_scenes.sql; scene set / unsorted / automatic |
| Connect Wiki for pictures/descriptions | — | Wikipedia via verified MusicBrainz → Wikidata chain; About card; CC BY-SA credit |
| What can we do with FreqBlog features | only year/hour/season charts existed | Sounds like this · How X sounds · Smooth order (Camelot + tempo + energy, greedy + 2-opt) |
| More and better roasts | 10 receipt types | 21 types, openers, kind closer |
| More achievements | 11 | 27 |

Ideas for the features not built yet: tempo/energy stations on Moods & Forecast ("run at 165 bpm"), an energy arc on each session's detail, key/tempo on Eras hover cards, "mix into" suggestions (next track in a compatible key) on the queue.

## 1. Rust written in 9j (uncompiled)
- `connectors/wikipedia.rs` (new; `pub mod wikipedia` in mod.rs): uses `Mb::get`, `urlencoding`, `Option::unzip`, `serde_json::Value` indexing with `String`/`&String`.
- `commands.rs`: `artist_tag_edit`, `artist_scene_auto` (registered in lib.rs); `set_setting` whitelist + `wiki_lang`.
- `db.rs`: `Db::apply_tag_blocks`; called at the end of `lastfm::enrich_tags` (before `Ok(n)`) and `musicbrainz::fetch_tags`.
- `scheduler.rs`: `wikipedia::enrich_batch(&st.real, 8)` after `verify_batch` in the MusicBrainz tick (errors ignored).
No `PIPELINE_REV` bump: the skip inference is in a view; the next rebuild applies it.

## 2. Next
Stylus S1, dynamic playlists, the feature ideas above, Ask v2, Open-Meteo weather for the forecast, background first-launch rebuild, `{code, message}` error envelope.
