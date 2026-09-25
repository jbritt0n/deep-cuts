# Design brief — lyric-theme playlists, multi-artist credit, eras overhaul, queue button

**Written:** September 12, 2026, alongside the Phase 9b handoff. Scope this in after `HANDOFF-PHASE-9B.md` §2.4 (Liner Notes calendar) if both land in the same drop — they touch adjacent code (`insightQueries.ts`, `notesQueries.ts`) and share the "week as the unit" theme. Read `PHASE1-NOTES.md` for the "why" behind the existing eras query before touching it.

Four items, each independently shippable:
1. Lyric-theme playlists — stop pre-classifying, start searching.
2. Multi-artist / featured-artist credit — additive `track_credits` table.
3. Eras overhaul — weekly-granularity backbone + independent genre threads, with starting tuning benchmarked against real data.
4. Add-to-queue — a per-track "queue on Spotify" action, wherever a track appears in the app.

A fifth, smaller item is appended at the end: the Liner Notes calendar redesign was asked for by the owner in the same conversation that produced this brief and never got a concrete answer — folding a short concept note in here so it isn't lost.

---

## 1. Lyric-theme playlists — keyword search, not dictionary classification

### The problem with the current shape
`lyrics.rs` already does the right privacy thing (fetch → derive → discard raw text) and stores four things per track: `word_count`, up to 40 `keywords`, a handful of `themes` matched against a **hardcoded 20-entry dictionary**, and `colours`. The dictionary is the bottleneck, not storage — 40 keywords/track across ~43k tracks is on the order of tens of MB, nothing DuckDB notices. The real ceiling: a fixed word list can only ever answer "does this track match one of these 20 preset ideas." It can't answer "make me a playlist about longing" or "songs that mention Lagos" or anything in a language the dictionary wasn't built for, and every theme added is hand-maintained forever.

### The fix: build playlists off the raw `keywords` array directly
`track_lyric_features.keywords` is already a `VARCHAR[]` per track — that's the actual playlist substrate. Themes become a *display* convenience (badges on a track page, a few quick-filter chips), not the playlist mechanism.

**New query, `lyricThemePlaylist(queryWords: string[], limit = 40)` in a new `lyricQueries.ts`:**
```sql
SELECT t.track_id, t.name, a.name AS artist,
       list_intersect(f.keywords, $1) AS matched_keywords,
       len(list_intersect(f.keywords, $1)) AS match_count
FROM track_lyric_features f
JOIN tracks t USING (track_id)
JOIN artists a ON a.artist_id = t.artist_id
WHERE f.found AND len(list_intersect(f.keywords, $1)) > 0
ORDER BY match_count DESC, f.word_count ASC
LIMIT $2
```
`f.word_count ASC` as the tiebreak biases toward songs where the matched words are a larger share of the lyric (a two-verse song mentioning rain twice reads "more about rain" than an 800-word song that mentions it once) — cheap proxy for relevance without new columns.

**A small synonym table makes this fuzzy without touching the schema:**
```sql
CREATE TABLE IF NOT EXISTS keyword_synonyms (
    word      VARCHAR PRIMARY KEY,   -- 'downpour', 'rainy', 'storms'
    canonical VARCHAR                -- 'rain'
);
```
Expand the caller's query terms through this table before the `list_intersect` call (`rain` → also match `downpour`, `rainy`, `storms`, ...). This is the actual lever for "coverage" — grow the synonym table over time (a few hundred rows will cover most everyday themes), rather than growing the fixed 20-theme dictionary in Rust. It's editable data, not a code change, which matters for iterating without a rebuild.

**Where the 20-theme dictionary still earns its keep:** track pages ("themes: night, heartbreak") and a Discover-style "browse by mood" shelf where a *curated, small* set of buttons is genuinely nicer UX than a free-text box. Keep it, just stop treating it as the whole feature.

**UI:** a text input on the Mixtape/PlaylistMaker surface — "build a playlist about..." — free text, split on whitespace, lowercase, run through `keyword_synonyms`, call `lyricThemePlaylist`. Falls back gracefully to an empty state ("nothing matched — try a different word") since coverage is inherently partial (LRCLIB doesn't have every song, and instrumental tracks have no keywords at all).

**Scope:** 1 new table, 1 new query file, no Rust changes, no changes to the existing `lyrics.rs` extraction pipeline. Ship independently of the eras work.

---

## 2. Multi-artist / featured-artist credit — additive, not a rebuild

### Confirming the actual gap
Every play is attributed to exactly one `artist_id`. Two places enforce this: the Spotify Extended Streaming History export itself only reports one `artist_name` per play, and `spotify/sync.rs` explicitly takes `artists[0]` when enriching from the Spotify API — any featured or co-billed artist is silently dropped. A track credited "Artist A feat. Artist B" gives Artist B zero hours, zero tag weight, zero presence in eras/discovery/obscurity — anywhere.

### Why this doesn't require touching the core model
`tracks.isrc` is already populated by Spotify enrichment (`ENR-01`). MusicBrainz can resolve a **recording** by ISRC and return its full artist-credit list, features included, via the same `musicbrainz.rs` connector template already in use for artist identity resolution. That's the seam: add credits **beside** the existing single-artist model, don't replace it.

**New table, appended to `schema.sql`:**
```sql
CREATE TABLE IF NOT EXISTS track_credits (
    track_id      VARCHAR,
    artist_id     VARCHAR,     -- resolved via the existing artist_id scheme where possible
    artist_name   VARCHAR,     -- as MusicBrainz reports it, for names not yet resolved to an artist_id
    credit_order  INTEGER,     -- 0 = primary (should match tracks.artist_id under normal conditions)
    source        VARCHAR DEFAULT 'musicbrainz',
    fetched_at    TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (track_id, credit_order)
);
```

**New connector function**, `musicbrainz.rs::enrich_credits(db, max_tracks)`, on the same shape as `lyrics.rs::enrich_batch`: pick the most-played tracks with an ISRC and no `track_credits` row yet, look up the MusicBrainz recording by ISRC, write one row per credited artist. Politeness matches the existing MusicBrainz rate limit already respected elsewhere in the connector.

**What consumes it, and what doesn't:**
- `tracks.artist_id`, every existing query (hours, sessions, artist pages, the current eras backbone) — **unchanged**. This is the load-bearing wall; don't touch it.
- New/updated consumers that *should* look at `track_credits` when present: the obscurity/diversity work (§3 of the earlier eras conversation — a niche featured artist deserves obscurity credit too), genre threads (a featured afrobeat artist should count toward an afrobeat thread even if they're not the primary credited artist on `tracks`), and eventually an artist page addition ("appears as a feature on N tracks").
- Coverage caveat to log honestly in Activity: MusicBrainz's ISRC coverage isn't total, and not every recording has a clean artist-credit split (some are credited as a single joint string, e.g. "Artist A & Artist B" as one MusicBrainz artist) — this fills in *most* real multi-artist tracks, not all of them.

**Scope:** 1 new table, 1 new connector function on an existing template, a scheduler tick alongside the existing enrichment cadence. No migration of `tracks`/`artists`/`plays_resolved` — this is additive.

---

## 3. Eras overhaul — weekly backbone + independent genre threads

### Chosen direction (confirmed with the owner)
**Option A** from the earlier design conversation: keep the existing artist-driven eras as the sequential narrative backbone (still one era per span — "The year of X" naming logic in `nameEra()` is untouched), and add genre/tag **threads** as an independent second layer that can overlap the backbone and each other freely, because each thread is detected per-tag rather than through the shared month/week partition that makes the backbone sequential. This was chosen over a full rearchitecture to true overlapping peer-eras (Option B) because it delivers the concrete ask (an "afrobeat" thread overlapping the main narrative) without touching code that's already been hard-won correct (see the Phase 9 fix note in `insightQueries.ts` about eras silently disappearing).

### 3.1 Backbone: switch month → week granularity
The whole `ERA_CTES` chain in `insightQueries.ts` is generic over a date-truncated column called `mo` — swapping `DATE_TRUNC('month', played_at)` for `DATE_TRUNC('week', played_at)` (ISO week, Monday start) does not require restructuring the CTEs. `nameEra()` needs **no changes** — it derives season from the calendar date on `e.start`/`e.end`, which works identically regardless of the underlying partition granularity.

Two parameters do need re-tuning, and this is not a formality — the numbers genuinely change shape at weekly resolution, confirmed below against real data.

### 3.2 Benchmark: parameters derived from the owner's actual streaming history

Ran the existing algorithm's logic (top-40 artist share vector, cosine similarity to the previous period, same floor/min-length/gap-merge structure) against the owner's Spotify Extended Streaming History, Dec 2024 – Sep 2026 (~29,100 usable audio plays after dropping podcasts/zero-`ms_played` rows, 88 of 89 possible calendar weeks had listening — this owner listens almost continuously, only one silent week in the whole span).

**Finding — the monthly default (0.3 cosine threshold) does not transfer to weekly data:**

| Granularity | Median week/month-to-previous cosine similarity |
|---|---|
| Monthly (existing) | ~0.3 was tuned as workable for this listener |
| Weekly (this benchmark) | **0.068** |

Weekly top-artist vectors are far noisier than monthly ones — a month smooths over single-day binges that dominate a week's numbers, so week-to-week similarity is roughly an order of magnitude lower across this whole dataset (p10 = 0.009, p25 = 0.029, p50 = 0.068, p75 = 0.141, p90 = 0.210). **Reusing 0.3 at weekly granularity would break on 83 of 87 week-to-week comparisons** — every week becomes its own era, i.e. the exact silent-failure mode the Phase 9 fix was written to prevent, now reintroduced by the granularity change if the threshold isn't dropped with it.

**Recommended starting values**, chosen by simulating the full break-and-merge pipeline (not just raw threshold behaviour) across a parameter grid and checking both the resulting era count/length distribution and whether the top artists per resulting era were qualitatively distinct (they were, cleanly, at the recommended settings — a Duman/Fela Kuti stretch, then a Porridge Radio/Jamie T stretch, then a Beatles/Jakuzi summer stretch, etc., each with genuinely different top-3 artists, not noise):

| Parameter | Current (monthly) | Recommended (weekly) | Basis |
|---|---|---|---|
| `ERA_MONTH_FLOOR_H` → `ERA_WEEK_FLOOR_H` | 1.0 h | **0.5 h** | This owner's lightest week was still 2.1h (p5), so the floor barely engages here — 0.5h is a conservative generalization for lighter listeners: enough to exclude a stray single incidental play from forcing a break, not so high it swallows a genuinely quiet-but-real week. |
| Cosine similarity threshold | 0.3 | **0.04** | At 0.3 the pipeline produces 84 eras (one per week, i.e. broken). At 0.04, 8 eras across the ~90-week span, each qualitatively distinct by top artist. 0.02–0.05 all produced reasonable results in the simulation; 0.04 sits in the middle and produced the cleanest artist-level differentiation. |
| `minMonths` → `minWeeks` | 2 | **4** | At minWeeks=4, a real one-off week (e.g. a Neil Young-heavy week) still surfaces as part of a proper 4-week era rather than vanishing into a neighbor; at minWeeks=6–8 that texture got absorbed and the timeline coarsened back toward monthly-equivalent resolution, defeating the point of the switch. |
| Max-gap forced break | 40 days | **42 days (6 weeks)** | Direct unit conversion, rounded to a whole number of weeks; this owner had only one silent week total so the benchmark can't stress-test this value — treat it as a reasonable carryover, not independently validated. |

**Resulting shape at these settings** (owner's data, for the developer's sanity check against their own eras panel once built): 8 eras over ~21 months, lengths ranging 4–29 weeks, most in the 7–12 week range — a mix of short, sharp stretches and a couple of multi-month arcs, which reads as "textured" rather than either "everything is one blob" (what 0.3 monthly-style thresholds would produce here) or "everything is its own tiny era" (what reusing 0.3 unmodified at weekly grain actually produces).

**Caveat to carry into the handoff, explicitly:** these numbers come from one listener with an unusually wide, fast-rotating taste (recall the Phase 1 validation: 11,293 canonical artists across ~99,800 plays over the full 10-year record) and near-continuous listening. A lighter or more repetitive listener will likely need a different threshold — same as the existing monthly 0.3 carries an "owner to confirm" note in the code today. **Treat 0.04/4/0.5/6 as the same kind of starting point**, not a universal constant, and keep them as function parameters (they already are) rather than hardcoding. If the diagnostic panel pattern from `eraDiagnostic()` is kept for the weekly version — recommended — it becomes the same evidence-gathering tool for retuning that it already is for the monthly version.

### 3.3 Genre threads (new, independent layer)
For each tag in `artist_tags` with meaningful weight (reuse the existing ≥0.2 weight floor from `genreQueries.ts`), compute per-week share of listening carried by artists holding that tag (`tag hours that week / total hours that week`), then find contiguous week-runs where that share crosses a floor — **suggest starting at ≥8% share for ≥3 consecutive weeks**, independently tunable from the backbone parameters above and not benchmarked in this pass (no artist in the owner's own library currently carries an "afrobeat" tag at high enough weight to test this against real data — Fela Kuti appears in the top-3 of two separate backbone eras above, which is suggestive but the tag-share threshold itself needs its own pass once `artist_tags` coverage is checked for this account). Each qualifying run is one thread instance; threads are stored/computed per tag independently, so nothing prevents two threads (or a thread and the backbone) from covering the same week — that's the overlap this whole layer exists to enable.

**New query**, `genreThreads(minWeeks = 3, shareFloor = 0.08)` alongside `eras()` in `insightQueries.ts` (or a new `threadQueries.ts` if `insightQueries.ts` is getting large — it's already 379 lines). Same output shape as `Era` minus the narrative name (threads display as `{tag} thread`, not a generated name — don't reuse `nameEra()` for these, it's tuned for artist-driven narrative naming).

### 3.4 Chart: overlapping transparent areas, with a swimlane toggle
Confirmed direction from the mockup comparison: a **non-stacked**, alpha-filled area chart (each era/thread on its own zero baseline, ~25% fill opacity, Chart.js `fill: 'origin'` per dataset with `stacked: false`) reads the "rising/fading preference" feel the owner wants, and correctly shows two spans crossing in a way a stacked area chart cannot. Pair it with a swimlane/Gantt view (each era or thread as a labeled pill on its own row, positioned by week index) behind a toggle button, since the swimlane is strictly better at showing *exact* boundaries and supports hover-to-isolate more cleanly. Both views read off the same `eras()` + `genreThreads()` data — no separate data path needed. Scroll horizontally for date ranges beyond the visible width; hover on either view dims non-hovered spans (implemented in the mockup via opacity toggling on mouseenter/mouseleave, portable directly to the real component).

### 3.5 Expose the tuning as a Settings control (owner request)
The four backbone parameters (§3.2) are good candidates for an owner-facing control, not just a code default — taste diversity varies enough per account that the benchmarked starting point (0.04 / 4 weeks / 0.5h / 6 weeks) won't be right for everyone, same as `attention_gap_min` already isn't a hardcoded constant today.

**This is simpler to wire up than Attention gap, not harder.** Attention gap needs the existing "change value → Apply → `invoke('rebuild')` → sessions recompute" round-trip because session shapes are materialized into a stored table. Eras are **not** materialized — `eras()` and `eraDiagnostic()` are called live from React with `minMonths`/`similarity` as plain arguments, so there's nothing to rebuild. Persist four new keys (`era_similarity`, `era_min_weeks`, `era_floor_h`, `era_max_gap_weeks`) through the existing generic `get_settings`/`set_setting` Rust commands — zero new Rust beyond the extra rows — and pass the stored values straight into the query call on the Insights page.

**Prefer live preview over an Apply button.** Since it's just re-running a query, a slider that updates the resulting era count in real time as it's dragged is both better UX and no more expensive than the click-to-Apply pattern. This is exactly what `eraDiagnostic()` (§3.5 build order below) is for: render it alongside the sliders so moving the similarity slider visibly reshapes the per-week break table and the live era count, not just a number in isolation.

**Floor/ceiling per slider**, derived from where the benchmark grid (§3.2) produced clearly silly results — bound the sliders here rather than letting the owner drag into a broken state:

| Parameter | Floor | Ceiling | Why bounded here |
|---|---|---|---|
| Similarity threshold | 0.02 | 0.15 | Below 0.02 the grid collapsed toward 3 eras across the whole ~90-week span (undifferentiated blobs); above ~0.15 it approached the "every week is its own era" failure mode this whole redesign exists to avoid — by 0.2–0.3 it's fully broken (76–84 of 87 week-pairs flagged as breaks). |
| Min run length | 3 weeks | 10 weeks | Below 3, single noisy weeks survive as their own "eras" (the fragmentation the merge step exists to prevent). Above 10, short-but-real stretches (the benchmark's 4-week Neil Young run) get absorbed into neighbors and the weekly switch stops adding texture over the old monthly behaviour. |
| Weekly floor (hours) | 0.25h | 1.5h | Below 0.25h essentially disables the floor (near-zero weeks rarely occur even for lighter listeners). Above 1.5h starts risking real-but-quiet weeks getting treated as silence, which was the original Phase 9 bug in a different guise. |
| Max gap before forced break | 3 weeks | 10 weeks | Narrower than 3 weeks forces a break on perfectly normal short breaks in listening (a busy week); wider than 10 stops the "long silence = new chapter" rule from ever firing for anyone but the most sporadic listeners. |

**Interaction risk — flag this in the UI, not just the docs.** The four parameters aren't independent; the benchmark table in §3.2 shows a lower similarity threshold needs a higher min-run-length to avoid fragmenting, and the recommended bundle (0.04/4/0.5/6) is a matched set, not four separately-optimal numbers. Four freestanding sliders risk the owner landing on a combination nobody validated (e.g. similarity=0.02 with minWeeks=3, which the grid didn't test together). Two mitigations, either is enough on its own, both together is better:
1. **Show the resulting era count and length spread inline**, updating live as any slider moves (the `eraDiagnostic()` panel does most of this already) — the immediate feedback ("2 eras" or "31 eras") is usually enough for someone to notice they've gone too far, without needing to understand *why*.
2. **Offer 2–3 named presets as bundled defaults** — e.g. "Textured" (similarity 0.03, minWeeks 3), "Balanced" (the benchmarked 0.04/4 default), "Broad strokes" (similarity 0.08, minWeeks 8) — each a validated combination, with manual sliders available underneath for anyone who wants to go off-script. Cheaper to build than it sounds: three rows in the same settings table, a dropdown that just writes all four values at once.

### 3.6 Suggested build order
1. Backbone granularity swap (§3.1–3.2) — smallest diff, immediately testable against the owner's real data since the benchmark numbers above are ready to drop in as new defaults.
2. `eraDiagnostic()`-equivalent for weekly, so the owner can sanity-check the new boundaries the same way they already do for monthly — build this before the Settings UI (§3.5), since the Settings panel wants to embed it for live preview anyway.
3. Settings exposure (§3.5) — presets + bounded sliders, backed by the diagnostic panel from step 2.
4. Genre threads query (§3.3) — additive, no risk to the backbone.
5. Chart component (§3.4) — depends on both data sources existing.

---

## 5. Add-to-queue — a per-track "queue on Spotify" action

The owner wants a quick way to check out a song without leaving Deep Cuts — a link next to any track that drops it onto the end of whatever's currently playing on Spotify. The underlying API call is small; the two real costs are a one-time reauthorization for every existing user and a UI component that needs to land in a lot of places at once.

### 5.1 What it takes on the Spotify side
`POST /me/player/queue?uri={track_uri}` adds one track to the end of the current playback queue. Two hard requirements, neither negotiable:
- **New OAuth scope.** Today's `SCOPES` constant in `endpoints.rs` is `user-read-recently-played user-library-read playlist-read-private playlist-modify-private playlist-modify-public` — no playback scope. Queueing needs `user-modify-playback-state`. Scopes are fixed at consent time, so **every already-connected user has to go through Connect again** once this ships — a one-time "please reconnect Spotify" prompt on the Services page, not a silent upgrade.
- **An active Spotify Connect device.** The endpoint 404s with no active device — phone, desktop app, or web player, something has to already be in a playback session. This is a Spotify-side constraint the app cannot route around. The UI needs a specific failure message for this case ("open Spotify on a device first"), not a generic error toast, since it will be the most common failure mode, not an edge case.

### 5.2 What's already reusable
The generic plumbing exists: `SpotifyClient::post()` already handles auth, retry/backoff, and 429 quota handling for any endpoint, and `playlists.rs` is the existing template for a one-off authenticated write call. The addition is small on the Rust side:
- One new endpoint helper in `endpoints.rs`: `pub fn queue(uri: &str) -> String { format!("{API_BASE}/me/player/queue?uri={uri}") }`.
- One new Tauri command, `queue_track(track_id)`, resolving the internal `track_id` to a `spotify:track:{id}` URI and calling `client.post(db, &ep::queue(&uri), json!({}))` — note the empty-object body, since this endpoint takes no payload; `client.post()`'s signature always wraps a body, so passing `json!({})` rather than `Value::Null` avoids sending a literal `null` that Spotify's parser may reject.
- Same `local:`-prefixed-id exclusion already used in `playlists.rs::create()` — tracks without a real Spotify id can't be queued, and the button should be disabled (not error) on those rows.

### 5.3 Where the real work is: one shared component, many call sites
"Any song that appears" spans Discover, search results, Mixtape/PlaylistMaker, session detail, artist/album/track pages, and — once built — the Skip Hall of Fame and Crate pages from the metrics roadmap (§3.3, §3.6 above). Rather than wiring the button into each page separately, build one small reusable component (an icon button, e.g. `<QueueButton trackId={...} />`) that every track-row component imports, so future track-listing surfaces get it for free. Loading/success/failure states (queued ✓, no active device, generic error) should live in that one component, not be re-implemented per page.

### 5.4 Scope and sequencing
No new database tables, no new connector. This is a scope change + a small Rust command + one shared frontend component — closer to a one-drop item than the eras or credit work above. The one sequencing dependency: the reauthorization prompt should be tested alongside whatever Services-page flow already handles the initial Spotify connect, since it's the same UI path being asked to run a second time for existing users rather than a new one.

---

## 6. Liner Notes calendar — concept note (asked earlier, unresolved, folding in here)

The owner asked for an interactive calendar at the top of Liner Notes to change the week scope, "spiffy, snappy, and animated," and for a creative reimagining of the page more broadly. `HANDOFF-PHASE-9B.md` §2.4 already scoped the mechanical version (a calendar strip of the year's weeks, intensity-shaded, click to jump) — this note adds the creative angle that request was actually asking for, so it isn't lost between two handoff documents.

**The reframe:** Liner Notes already has the right metaphor in its name — lean into it harder. Physical liner notes are something you unfold, not a dashboard you scan. A concrete direction: the calendar strip *is* the "record sleeve" for the week — each week-cell shaded by hours (already scoped), but clicking one doesn't just swap data underneath a static layout, it plays a short unfold/turn animation (150–250ms, a CSS transform on the note card, not a page navigation) as the new week's note replaces the old one, so moving through weeks feels like flipping through a stack of liner notes rather than reloading a report. The fact sheet sidebar (already present) could adopt a torn-edge or stitched-margin visual treatment to lean into the physical-object feel without needing new data.

**Scope-check before committing further:** this is aesthetic/animation work layered on data that already exists (`weekFacts`, `composeNotes`) — no new queries needed beyond what §2.4 already calls for (the calendar strip itself). Good candidate for a design-focused pass once the calendar strip's data plumbing lands, rather than its own separate development slot.
