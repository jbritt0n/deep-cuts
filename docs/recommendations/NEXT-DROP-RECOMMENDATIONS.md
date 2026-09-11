# Deep Cuts v3 — Recommendations for the Next Development Run

**Compiled:** September 11, 2026
**Inputs:** Full source review of `deep-cuts-v3-phase7d` (schema, SQL pipeline, Rust
connectors, React/TS layer) + three prior advisory documents (`deepseek...d17ea2.md`
connector review, `deepseek...eca849.md` feature review, `kimi-recommendations.md`
review-of-reviews). This document **synthesizes** all of it, drops the redundant
parts, and adds findings none of the three caught.

Everything here is a suggestion for the owner to triage — nothing is scoped or
committed.

---

## 0. What this doc does differently from the three it's built on

- DeepSeek's two docs and Kimi's doc are all still valid and don't need restating in
  full — they're referenced by section number below instead of copied.
- Kimi already corrected Gemini's doc's wrong-stack claims (SQLite pragmas, React
  Query) — that correction stands and isn't repeated here.
- This doc adds a fourth pass: an independent read of the actual `src/` and
  `src-tauri/` code, which surfaced a few concrete things none of the three mentioned
  (§1.4, §1.5, §2.6, §3.9).

---

## 1. Code health — new findings from this review

### 1.1 SQL parameter binding is inconsistent (minor, but worth fixing)
Most of `queries.ts` / `phase4Queries.ts` uses `$1`/`$2` parameter binding correctly.
But `likedSongs()` in `phase4Queries.ts` builds several filter clauses by manually
escaping single quotes and interpolating straight into the SQL string:
```ts
if (f.tag) conds.push(`... tg.tag = '${f.tag.replace(/'/g, "''")}'`);
if (f.artistQuery) conds.push(`a.name ILIKE '%${f.artistQuery.replace(/'/g, "''")}%'`);
```
This is a single-user local app, so the practical risk is low, but it's an
inconsistent pattern next to the parameterized style used everywhere else, and manual
quote-escaping is exactly the kind of thing that silently breaks (a value containing
a backslash-quote sequence, or a future contributor copying the pattern into a
higher-stakes spot). Worth a small pass to route every user-supplied filter value
through `$n` parameters, matching the rest of the codebase.

### 1.2 `Db::assert_read_only` is substring matching, not a parser
It uppercases the trimmed SQL and checks for banned keywords as substrings. This can
false-positive (a track or note field containing the word "drop" inside a `WHERE …
LIKE` string would trip it) and, more importantly, gives a false sense of rigor since
it isn't a real SQL parser. Low priority to replace outright, but worth a comment
in `db.rs` acknowledging the limitation, since this is the same validator the LLM
"Ask" phase is planned to reuse (`PHASE1-NOTES.md` says so explicitly) — it deserves
more scrutiny before that phase starts, not after.

### 1.3 No frontend test framework exists at all
`package.json` has no `vitest`/`jest`/`@testing-library` anywhere. The only automated
tests are Python SQL fixtures (`test_sql_fixtures.py`) and manual smoke scripts run by
hand. That's reasonable for SQL-heavy logic, but a fair amount of pure, easily-tested
TS logic has zero coverage: `lib/format.ts` (date/duration formatting, session-shape
labels), `lib/filter.ts` (the listening lens SQL-fragment builder — the thing every
page depends on), and `sessionQueries.ts`'s `PLATFORM_FAMILY` bucketing. A minimal
`vitest` setup covering just those three files would catch regressions cheaply,
without needing a DB or a browser.

### 1.4 Enriched columns that nothing reads yet
`tracks.explicit`, `tracks.isrc`, and `tracks.release_precision` are populated by
Spotify enrichment (`enrich_track_from_json` in `sync.rs`) but no query in
`src/lib/*` ever selects them. Two small, cheap wins sitting on data you already
collect:
- **Explicit-content ratio** over time (a one-card addition to Insights or Drift).
- **ISRC-based duplicate detection** — the same recording released as a single, an
  album track, and a deluxe-reissue track often gets three different `track_id`s
  today (Spotify track ids differ per release) but shares one ISRC. A "these are
  probably the same recording" merge-suggestion feeds directly into the Record
  Hygiene page recommended in §2.1, and reuses the existing `artist_merges` pattern.

### 1.5 Open design decisions still marked "say the word to revert"
`docs/PHASE1-NOTES.md` §1 has a numbered list of judgment calls the implementer made
where the spec was silent (attention-gap default of 120 min, comfort-loop's 3-play
minimum, eras' 0.3 cosine threshold instead of the spec's 0.6, etc.) — several are
explicitly flagged "owner to confirm" in the SQL comments too (`compute_sessions.sql`,
`insightQueries.ts`). None of the three advisory docs mention this, but it's worth
closing out before more features get layered on top of behavior that might change:
a quick owner pass confirming or adjusting each of the ~9 items, then removing the
hedge language from the code comments.

### 1.6 Everything from Kimi's Part 2 (T1–T7) still applies
CI test job before full builds, structured `{code, message}` error envelope ahead of
the LLM phase, chart memoization + loading skeletons, the attended-only aggregate
lens, connector JSON-fixture parse tests, quota transparency on Services, and one
documented restore drill. No changes to that list — see `kimi-recommendations.md`
Part 2 for detail. Priority order suggestion in that doc (T1 → T3 → T2 → T4 → T5) is
sound and doesn't need revising.

---

## 2. Feature recommendations — organized, de-duplicated, prioritized

### 2.1 Highest value, not yet built (agreement across all sources + this review)

1. **Record Hygiene page** (DeepSeek features §1/§2.1, Kimi context). Outlier review
   (stuck-repeat sessions, `ms_played` exceeding track duration, impossible daily
   totals), session-surgery UI beyond the one-session-at-a-time page, import diffing,
   an integrity report card. **Extend it with §1.4's ISRC duplicate-recording
   detector** — that's new in this review and belongs on the same page.
2. **Listening journal / personal annotations** (DeepSeek features §2.2). A `notes`
   table keyed by `(entity_type, entity_id)`, feeding Liner Notes with human context
   your behavioral data can't capture ("first heard this at…", "saw them live").
   Cheap, additive, non-destructive — good next-drop size.
3. **Blind spots + bubble score** (DeepSeek features §2.3). A genuinely different
   lens from the existing discovery engines: what you've *never* touched (countries,
   decades, tags, labels) rather than what's adjacent to what you already like.
4. **Playlist health analysis** (DeepSeek features §2.5). Per-playlist play/skip/
   redundancy/dead-weight stats — you sync playlist data already and do nothing
   analytical with it yet.
5. **Query console / local API** (DeepSeek features §2.8). `Db::assert_read_only`
   already exists as the validator (see §1.2 above for the caveat to fix alongside
   this); `dev-server.mjs`'s command surface is most of a local API already.
6. **Playlist overlap graph** (DeepSeek features §2.13-D + §5.1 sequencing). Smallest
   and most self-contained piece of the graph-views initiative, and per that doc's own
   sequencing note, the single highest-value standalone graph feature — which of your
   followed/owned playlists share tracks, and whose curation taste actually overlaps
   yours. Build this **before** committing to the larger artist-family-tree or
   force-graph work; it validates the shared `graph_edges` abstraction cheaply.

### 2.2 Second tier — strong value, more effort or more dependent on connectors

7. **Setlist.fm connector** (DeepSeek connectors §3.1, Kimi R4). The `concerts` table
   and `concertsFor()` query already exist; only the connector and an entry UI remain.
   Lowest-effort connector with real payoff — concert-adjacent listening bumps.
8. **Artist family tree** (DeepSeek features §2.13-A). Reuses `artist_relations`
   (already populated by the MusicBrainz connector) — a new *presentation*, not new
   data collection. Deterministic layout, no physics, low risk.
9. **Audio features connector** (FreqBlog or a one-time AcousticBrainz dump — DeepSeek
   connectors §3.1/§3.2). Unlocks tempo drift, key/mode analysis, harmonic diversity —
   an entire category (DeepSeek features §2.6) with zero coverage today. Pick one
   source and accept its limits rather than chasing a perfect replacement for
   Spotify's deprecated audio-features endpoint.
10. **Discogs connector** (DeepSeek connectors §3.1). Adds a label/format dimension
    the record has no concept of at all right now.
11. **Artist co-listening network** (Kimi R1). The one visual the original spec
    promised (D3 force graph) that still doesn't exist; `session_transitions` and
    per-session co-occurrence are already computed, so this is a rendering project
    more than a data project. Sequence it *after* item 6 above, per the graph-views
    build order in DeepSeek features §5.1.
12. **Command palette (Ctrl+K)** (Kimi R2). Cheap — search SQL already exists — and
    the app has grown to ~20 pages, so the payoff compounds daily.

### 2.3 New feature ideas from this review (not in any of the three prior docs)

13. **Loyalty timeline, aggregated.** The artist page already computes "you're a
    *this-album* person more than a *this-artist* person" (`albumLoyalty` in
    `getArtistDetail`). Nobody has rolled that up across artists into a single view —
    "here are the 12 artists where one album dominates your listening with them, and
    here's how that share has moved over time." Small SQL addition, no new tables.
14. **Silence report.** You already compute streaks (`daily_minutes_attended`) and
    dormancy per artist (`lifecycle()` in `insightQueries.ts`), but there's no
    equivalent "quietest stretches" view of the record as a whole — longest gap with
    zero plays, total dark days per year, whether gaps cluster (travel? life events?
    ties nicely into the `life_events` idea already proposed in DeepSeek features
    §2.2 — a silence report becomes far more interesting once that table exists).
15. **Session hand-off / device-switch patterns.** `platform` already drives session
    stitching (a device change within 5 minutes stays in one session per
    `compute_sessions.sql`). That's currently pure plumbing; it could also be a
    first-class insight — "you start on phone, finish on desktop, 40% of long
    sessions" — using data that's already computed and just not surfaced.
16. **Explicit-content ratio over time.** See §1.4 — the column exists, nothing reads
    it. A one-chart addition, probably to Drift or Insights.
17. **Generative year-mosaic poster.** The Share Cards infrastructure
    (`ShareCard.tsx`) already renders locally on canvas with the bundled fonts. A
    calendar-grid poster where each day's cell color/intensity comes from that day's
    dominant scene or top artist is a natural extension of both the existing
    `CalendarHeatmap` and the Share Card renderer — no new data, just a new render
    target for data you already have (scenes, daily minutes).
18. **Local notification digest.** Liner Notes already composes a deterministic
    weekly note (`composeNotes`). Tauri's notification API could surface "your
    Liner Notes for last week are ready" without needing any new analytics — purely
    a delivery-layer addition, and it's the cheapest item on this whole list.
19. **Passphrase-protected export option.** The Parquet backup and "export all
    plays" feature currently write plaintext to disk. For data this personal, an
    optional encrypted-export mode (even a simple age/gpg-style passphrase wrapper
    around the existing Parquet output) would be a low-effort trust-building addition
    that fits the local-first ethos already documented in `docs/SETUP.md` §D.

### 2.4 Everything else from the DeepSeek features doc
Sections §2.4 (time/context enrichment), §2.7 (social/sharing without cloud), §2.9
(accessibility), §2.10 (gamification), §2.11 (operational QoL), and §2.12 (the LLM
capstone, gated on Ollama per the roadmap) are all still reasonable menu items and
don't need re-ranking here — see that document directly for the full list and its
codebase cross-reference table (its §3).

---

## 3. Connector recommendations — condensed

Full detail, tiers, and the build contract (files to touch, DB patterns, rate limits,
error surfacing, verification protocol) are in `deepseek_markdown_...d17ea2.md` — that
document is thorough and doesn't need duplicating. Condensed priority, folding in this
review's additions:

| Priority | Connector | Note |
|---|---|---|
| Build | Setlist.fm | Fills an existing table; lowest effort in the whole list (§2.2.7) |
| Build | Discogs | New label/format dimension |
| Build | FreqBlog or a one-time AcousticBrainz dump | Pick one; verify current API surface before committing, per Kimi R5's warning about shrinking public APIs (applies here too, not just Deezer) |
| Consider | WhoSampled | High value, unofficial API only — mark experimental, opt-in |
| Consider | Every Noise at Once / AcousticBrainz | One-time imports, no ongoing API risk |
| Skip | Rate Your Music, Apple Music API | Wrong access model for this project (see original doc §3.4 for why) |

---

## 4. Suggested order of work

Merges Kimi's Part 4 table with the feature priorities above:

| Order | Item | Why here |
|---|---|---|
| 1 | Kimi T1 — CI test job + build gating | Immediate cost/regression payoff |
| 2 | §1.3 — minimal vitest coverage for format/filter logic | Cheap, catches regressions in code every page depends on |
| 3 | Kimi T3 — skeletons + chart memoization | User-visible, no new deps |
| 4 | §1.1 — parameterize the remaining manual-escape SQL | Small, closes a consistency gap before more filter UIs get added |
| 5 | Kimi T2 — error envelope | Cheapest before the LLM phase needs it |
| 6 | Kimi T4 — attended-only aggregate lens | Biggest analytical payoff remaining from the "So Excited" fix |
| 7 | §2.1 items 1–2 (Record Hygiene + Journal) | Highest-value net-new features, moderate effort |
| 8 | §2.2 item 7 (Setlist.fm) | Lowest-effort connector, immediate payoff |
| 9 | §2.1 items 3–6 (Blind spots, Playlist health, Query console, Playlist-overlap graph) | Round out the top tier |
| 10 | Kimi T5 — connector parse-test fixtures | Targets the least-proven layer (Rust connectors) |
| 11 | Everything else in §2.2/§2.3/§2.4 as appetite allows | — |

---

*This document supersedes nothing — `deepseek_markdown_20260911_d17ea2.md`,
`deepseek_markdown_20260911_eca849.md`, and `kimi-recommendations.md` remain the
detailed references for anything condensed above.*
