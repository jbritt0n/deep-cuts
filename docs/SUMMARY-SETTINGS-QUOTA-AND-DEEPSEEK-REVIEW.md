# Summary — Settings expansion, Spotify quota findings, and metrics/awards roadmap

**Written:** September 12, 2026. Covers everything discussed after
`docs/DESIGN-BRIEF-EXPLORATORY-FEATURES.md` was written — none of that document's
content (lyric-theme playlists, `track_credits`, the eras overhaul) is repeated here.
Three sections: Settings additions, Spotify quota findings, and a metrics/awards
feature set scoped against the current codebase.

---

## 1. Additional Settings-page candidates

Following on from the eras tuning sliders already scoped in the design brief
(§3.5 there), a broader pass over the codebase surfaced other hardcoded values that
fit the same "expose as a tunable, same as `attention_gap_min`" pattern. None of
these are scoped or estimated — flagging as roadmap candidates only.

| Candidate | Current hardcoded value | Where | Notes |
|---|---|---|---|
| Session shape thresholds | repeat rate ≥0.25, novelty ≥0.5, entropy ≥2.5, etc. | `compute_sessions.sql`, explicitly commented `owner to confirm` | Same pattern as attention gap; classifies `comfort_loop` / `discovery_run` / `warm_up` / `shuffle_wander` |
| Skip definition | under 30s = skip | `compute_sessions.sql` (`under_30s`) | Changes skip-rate numbers app-wide; 10–60s range suggested |
| Discover feedback memory | 90 days | `recQueries.ts`, `genreQueries.ts` (three separate hardcoded copies) | Consolidating to one setting also fixes a drift risk — three copies of "90" today |
| Forgotten-artist window | 540 days | comeback-candidate detection | Controls how sentimental vs. current comeback suggestions feel |
| Genre tag confidence floor | 0.2 weight | `genreQueries.ts` and everywhere tags are consumed | Also the floor the proposed eras genre-threads (design brief §3.3) would inherit |
| Mixtape default mix | resets to 40/20/20/20 each time | `Mixtape.tsx` | "Remember last mix" instead of a fixed default |
| Sync/poll cadence | Spotify poll 20 min, Last.fm/MusicBrainz trickle 5 min | `scheduler.rs` | Power-user section; battery/data tradeoff |
| Enrichment quota ceiling | `ENRICH_PER_HOUR = 200` | `scheduler.rs` | **See §2 below — active pain point, recommend surfacing this one first** |
| Lyric batch size | 40 tracks / 15 min | `lyrics.rs` | Speed vs. API politeness tradeoff |
| Playlist default visibility | no global default; per-playlist toggle only | Playlist export flow | Save a click for owners with a consistent preference |

Same mitigation as the eras sliders applies here: several of these interact (skip
definition changes what "high skip rate" means for session shapes; genre tag floor
changes what threads/Discover/eras-threads all see), so consider surfacing them in a
grouped "Advanced tuning" section with live before/after counts rather than as
disconnected sliders, once any of these move from candidate to build.

---

## 2. Spotify enrichment quota — investigated, not yet actioned

**Owner's reported problem:** enrichment frequently exhausts the daily API quota,
raising a question about whether that could also stall the recently-played poller
(risking permanent loss of listening history).

**Findings, verified against `src-tauri/src/spotify/client.rs` and `sync.rs`:**

- Spotify's `recently-played` endpoint is hard-capped at the **50 most recent plays**,
  with no way to page further back — a platform limitation, not something this app's
  design can extend. The poller calls `recently_played(50)` with no time cursor,
  matching that ceiling exactly.
- **Consequence:** any gap in polling during which more than 50 tracks are played
  loses everything beyond the most recent 50 at resume time, permanently and
  irrecoverably — true today regardless of quota settings.
- **However — already-built protection found in the client:** the poll call is
  marked `essential = true`, and `SpotifyClient::get()` explicitly skips the
  self-imposed enrichment pause for essential calls (`if !essential && self.is_paused()`).
  When the daily quota trips, **only enrichment goes silent until midnight** — the
  poller keeps attempting every cycle regardless.
- The self-imposed pause is **daily only** (`pause_until_midnight()`); there is no
  weekly/monthly quota bucket in the code. So the owner's worst-case framing ("a week
  or a month" of blocked polling) is not something the current architecture can
  produce — worth confirming this reassurance is accurate as understood, since it
  rests on reading the client code rather than observing it in production over a long
  outage.
- Narrow residual risk: if the *whole app* (not just enrichment) exhausts Spotify's
  daily allowance, the essential poll call could still receive one stray 429, but it
  retries with backoff and simply succeeds on the next ~20-minute cycle — not a
  multi-day failure mode.

**Recommendation given to the owner:** lower `ENRICH_PER_HOUR` from 200 to roughly
100 as a first move, purely to create more daily headroom before the shared quota
wall is hit at all — a defensive margin, not a fix for a bug, since the essential-call
protection already exists. No code changes made in this conversation; this is a
config-value suggestion for the owner to apply, and a candidate for the Settings
list in §1 (already included there).

---

## 3. Metrics, Awards & Quirks

A set of taste-revealing metrics plus playful superlative features. All computable
from tables that exist today, or from one small, well-justified addition per
feature. No new service connectors — Last.fm listener counts are the only new API
surface touched, and that connector is already live (`connectors/lastfm.rs`).

### 3.1 Awards & superlatives

**Placement:** the **In Review** page, not Achievements. Achievements are permanent
earned-once badges; awards are period-scoped superlatives that belong with the
period they describe. Since In Review already supports year / month / last-30-days /
custom range, an awards block at the end of any period works without new
navigation — annual awards for a year view, funnier monthly ones for a month view.

**Design:** a "Superlatives" section at the bottom of any In Review period — 8–10
category cards, each a winner plus a small runner-up line, click-through to the
entity page. Shareable as one composite image via the existing share-card canvas
pipeline (`ShareCard.tsx`, already built for Year in Review).

| Award | Definition | Data source |
|---|---|---|
| Most Played | Highest play count | `plays_resolved` |
| Most Skipped | Top skip rate, ≥10 plays | `plays_resolved.end_reason` |
| Best Newcomer | First played in period, highest plays | first-play date |
| Best Comeback | Returned after ≥2 years silent | gaps in play history |
| Quietest Obsession | High plays, few distinct sessions | plays ÷ sessions |
| Longest Relationship | Longest first-to-last span in period | min/max play dates |
| Most Chaotic / Smoothest | Highest / lowest session chaos score | tag vectors (§3.7) |
| Best Supporting Artist | Most plays as a *featured*, non-primary artist | `track_credits` (design brief §2) |
| Obsessive Day | Highest single-day, single-track count | `plays_resolved` |

Best Supporting Artist is the one award gated on work outside this feature: it needs
the `track_credits` table already scoped for the multi-artist enrichment. Until that
table has data, this award should render "not available this period" rather than an
error — a one-line conditional, not a blocker for shipping the other nine.

### 3.2 The Forecast

**Form:** a distribution, not a point prediction. Guessing one specific next track
has a base rate around 1 in 42,000 given this library's size — even a good model
reads as broken if it tries to name a track. A weather-style spread never fails and
is more honest about what the data actually supports.

**Two modes:**
1. **Distribution mode (default).** A probability spread over genres/tags and time
   slots — "today favors indie folk (62%), ambient (48%), a 30% chance of hip-hop."
   Built from the same weekday × hour × tag aggregation the Moods page already
   computes for mood stations — no new matrix, just a new read of an existing one.
2. **High-confidence mode**, firing only above a strict threshold — "you've played
   Bon Iver on 11 of the last 12 rainy Sundays — 92% chance today." Start
   conservative: require ≥85% historical hit rate over ≥8 prior exposures before
   this mode is allowed to fire at all; fall back to distribution mode otherwise.

**Accuracy tracking:** a new `forecast_log` table (forecast date, predicted
distribution or high-confidence call, actual outcome the following day) turns this
into a running "how well do I know my own listening" line — if accuracy improves,
the model is learning the owner's habits; if it degrades, habits are shifting, which
is itself worth surfacing ("your listening became less predictable in March"). Log
every forecast regardless of mode so the accuracy line covers both.

### 3.3 Skip Hall of Fame ("Not for me")

Tracks repeatedly shown and repeatedly rejected — the inverse of the obsessions
detector already in Insights.

**Filters, tuned to treat a consistent fast skip as a real signal rather than
filtering it out as an "intro-skip artifact":**
- Minimum exposure: shown ≥8 times (single intro-skips wash out naturally on a
  track only seen once or twice — no separate sub-30-second exclusion needed).
- Skip rate ≥85% (7/8, not 4/5).
- Exclude skip-spree sessions: a session with 10+ consecutive skips reflects the
  session, not the songs — filter those sessions out of the rate calculation rather
  than let them inflate every track's skip count.
- Distinguish sources: a skip during the owner's own play is a taste signal; a skip
  inside a followed playlist is a curation signal on the playlist, not the track —
  track these separately so they don't contaminate each other.

**Presentation:** one page, sorted by exposure count — "shown up 47 times, skipped
45." Two actions per row: **Give it a fair shot** (mark "tried," suppress 180 days)
or **Confirmed not for me** (permanent). Both write to the existing
`recommendation_feedback` table (confirmed present in `schema.sql`, already used by
the five recommendation engines) under a new `engine = 'skip_hall'` value — this also
hands the recommendation engines their first real negative signal, since none of the
five currently record an explicit "no."

### 3.4 Deep Cuts metrics

Three related numbers, all computable today with no new data, named after the app
itself.

**Deep cut ratio.** For each artist, rank their tracks by the owner's own play
count; top 5 = "hits," everything else = "deep cuts." The ratio is the share of
plays going to non-top-5 tracks. This measures the owner's *behavior*, not the
artist's popularity — pure SQL over `plays_resolved`, works per-artist, per-album,
per-year, or globally.

**Catalogue penetration.** "You've played 47% of Stereolab's catalogue." This needs
one real addition: `albums.total_tracks` exists today but is per-album (from
Spotify) — there's no rollup of an artist's *entire* released output. A small
enrichment pass using MusicBrainz release-groups (the connector and its
`artist_relations` cache already exist) to persist a total-track-count per artist
closes that gap; the query itself is then trivial once the count exists.

**Spread score.** The artist with the highest play count where the single top track
accounts for the *smallest* share of that artist's total plays — loved spread out
across the catalogue rather than concentrated on one song. Computable today, pure
SQL over `plays_resolved`.

**Deep Cuts Award:** catalogue penetration is the natural namesake award for the
Superlatives section (§3.1) — "The Deep Cuts Award goes to Stereolab, 47% of their
catalogue played." On-theme, and grounded in real per-account digging rather than
external popularity data.

### 3.5 Obscurity metrics

**Source:** Last.fm `listeners` count per artist — free, one call per artist,
cacheable forever, using the connector already wired up for tags and similar-artist
data.

- **Per-artist obscurity.** New `artist_popularity` table storing the raw listener
  count; obscurity score = inverse log of listener count so it ranks sensibly at
  both ends of the scale.
- **Average listening obscurity over time.** Weight each play by its artist's
  obscurity score, plot by year — "your 2018 was more obscure than your 2026,"
  answering whether digging tendency is increasing or fading.
- **Obscurity vs. play count scatter.** x = artist listener count (log), y = the
  owner's play count — the shape of this scatter is a portrait of the relationship
  with popularity generally: digs into obscure things preferentially, gravitates to
  what's already popular, or shows no pattern either way.
- **Artist popularity trajectory.** The most interesting of the five, and the one
  needing forward planning: a new `artist_popularity_history` table, appended on
  every enrichment pass rather than overwritten, so trajectories accumulate. "You
  discovered X at 5,000 listeners; they're at 2,000,000 now; you've played them 3
  times since" — the "liked them before they were cool" detector, and its inverse,
  "left when they got big." First snapshot is free; the feature only becomes
  interesting after months of accumulated snapshots, so starting the table early
  (even with no UI yet) matters more than usual for a "small addition."
- **The normie index.** Share of listening sitting above a popularity threshold, as
  one deliberately provocative, shareable number — "your normie index is 34%." Pure
  fun, built entirely on data the other four items already produce.

### 3.6 The Crate + Dig Deeper

**The Crate** — one page, two shelves, combining what would otherwise be three
separate ideas into a single scrollable grid of album covers laid out like a
physical crate (album art already available via the existing Cover Art Archive
connector and Spotify enrichment). The interaction is identical across shelves —
flip through covers, click one to open the album page — only the filter changes:

- **Fresh crate** — artists/tracks discovered and abandoned after 1–2 plays. "You
  pulled this record once, never put it back on." A revival surface for things that
  deserve a second chance.
- **Back room** — the most obscure records, sorted rarest-first using the obscurity
  score from §3.5.
- **Rediscover** (third shelf, cheap to add once the grid exists) — albums played
  heavily once and untouched for a year or more.

**Dig Deeper** lives on the artist page instead, since it's an action on one artist
rather than a browsing surface: "You've played 12 of their 47 tracks — dig into the
other 35." Opens a panel of unplayed tracks with a "why you might like this" hint
drawn from the existing tag/adjacency caches already powering Discover. Shares its
underlying query directly with catalogue penetration (§3.4), since both need the
same played-vs-total comparison per artist.

**Daily Dig** — one track per day on the dashboard, weighted toward forgotten
favorites and unexplored corners of the library. A small ritual card rather than a
full feature; changes the day-to-day feel of opening the app from "check my stats"
to "see what's in today," at very low build cost once the weighting logic exists
for Fresh Crate.

### 3.7 Session chaos score

**Definition:** for consecutive plays within a session, cosine distance between
artist tag vectors — already cached in `artist_tags` (weight, source columns exist
today) — averaged across the session into a single chaos score. Higher means more
jarring genre transitions.

This is an *attribute*, not a session shape: shape describes structure (album ride,
discovery run, comfort loop, warm-up), chaos describes coherence, and the two are
independent — a discovery run can be internally coherent or all over the place.
Store chaos alongside shape rather than folding it into the shape classification.

**Four placements, each small:**
1. **Session list row** — a chaos indicator (dot or number) beside each session,
   sortable alongside existing sort options.
2. **Session detail — transition chain.** A compact horizontal strip in the existing
   session detail view showing genre-family transitions play-by-play, colored per
   segment, so a jazz → death metal → ambient run visibly looks as jarring as it is.
   Reuses the tag-family vocabulary already established for the scene-detection work
   in `compute_insights.sql`.
3. **Sessions overview — two new charts.** Chaos-by-year (trending more or less
   coherent over time) and chaos-by-time-of-day (coherent mornings, scattered
   nights, or the reverse).
4. **Awards** (§3.1) — Most Chaotic and Smoothest session per period is where chaos
   gets its best payoff: "On April 3, 2022, you went jazz → death metal → ambient
   within 40 minutes."

**Cross-checks worth building alongside the feature, not after:** chaos-by-shape
should show album rides scoring low and discovery runs scoring high as a sanity
fixture (`test_chaos_album_ride_low`, `test_chaos_discovery_high`) — if it doesn't,
the shape-classification rules likely have a bug worth catching here rather than
downstream. A genre-family × genre-family transition heatmap ("you go ambient →
post-punk more than any other jump") is a second, very cheap chart once the
tag-family vocabulary is in hand.

### 3.8 Data requirements

| Feature | Needs | Status |
|---|---|---|
| Awards (most categories) | `plays_resolved`, dates, `end_reason` | Ready today |
| Awards — Best Supporting Artist | `track_credits` | Depends on design brief §2 |
| Forecast — distribution | weekday × hour × tag matrices | Ready (Moods page already builds these) |
| Forecast — accuracy log | new `forecast_log` table | Small addition |
| Skip Hall of Fame | `plays_resolved`, `recommendation_feedback` | Ready + one new engine key |
| Deep cut ratio | `plays_resolved` | Ready today |
| Catalogue penetration | total track count per artist | Small enrichment addition (confirmed gap — see §3.4) |
| Spread score | `plays_resolved` | Ready today |
| Obscurity per artist | Last.fm `listeners` | One call per artist, cacheable |
| Obscurity trajectory | `artist_popularity_history` | New table, appends over time |
| Normie index | obscurity data | Ready once obscurity is cached |
| The Crate | album art, play history | Ready — art already exists |
| Dig Deeper | catalogue penetration query | Shares §3.4's query |
| Daily Dig | play history + weights | Ready today |
| Chaos score | `artist_tags`, `plays_resolved` | Ready today |

**Net new tables:** `forecast_log`, `artist_popularity`, `artist_popularity_history`.
**Net new columns:** total-track-count per artist (enrichment addition).
**Net new connectors:** none.

### 3.9 Suggested build order

1. **Deep cut ratio + spread score** — pure SQL, no new data, ships the app's own
   namesake metric first. One drop.
2. **Awards section on In Review** — mostly presentation over existing queries;
   Best Supporting Artist degrades gracefully until `track_credits` lands, chaos
   award degrades gracefully until §3.7 ships. One drop.
3. **Session chaos score** — new aggregation alongside `compute_sessions.sql` or
   `compute_insights.sql`, plus the four UI placements and the two sanity-check
   fixtures. One to two drops.
4. **Skip Hall of Fame** — new query, new feedback engine key, one page. One drop.
5. **The Crate** — one page, two shelves, reuses existing album art. One drop.
6. **Obscurity metrics, first pass** — Last.fm listener counts cached once, per-artist
   score, average-over-time chart. Start `artist_popularity_history` here even
   though the trajectory UI ships later — snapshots need to accumulate regardless.
7. **Catalogue penetration + Dig Deeper** — depends on the total-track-count
   enrichment; both ship together since they share a query. One to two drops.
8. **Forecast** — distribution mode first, accuracy log alongside it, high-confidence
   mode only once the log shows the model holds up. Two drops plus ongoing tuning.
9. **Obscurity trajectory UI** — after enough snapshots have accumulated. Small.

Worth scheduling `track_credits` (design brief §2) ahead of step 2 specifically, so
Best Supporting Artist ships in its first version rather than landing later as a
follow-up pass to an already-shipped Awards section.
