# Deep Cuts v3 — Service Connector Recommendations (external review)

**Source:** DeepSeek (AI advisor), September 11, 2026
**Status:** Suggestions only — not committed to roadmap, not scoped, not estimated.
**Companion to:** `docs/DEEPSEEK-RECOMMENDATIONS.md` (feature menu).
**Scope:** Third-party music services that could be plugged into Deep Cuts to add
analytical value, with a per-service assessment and a build contract.

> **Note to whoever picks this up:** these are *recommendations from an outside reader
> of the codebase*, not requests from the owner. The owner's priorities in §3 of
> `PROJECT-STATUS-AND-ROADMAP.md` take precedence. This file assumes the boundaries
> already established in `docs/SETUP.md` §D and `PROJECT-STATUS-AND-ROADMAP.md` §5 —
> free or user-keyed, no cloud, no telemetry, no hardcoded secrets, no stored lyric
> text.

---

## 0. How to read this file

- **§1** — The connector contract: boundaries and architecture any new service must
  respect. Read this first; it is the filter that determines what belongs.
- **§2** — Priority order, five tiers.
- **§3** — Service-by-service detail, tiered.
- **§4** — The build contract: files, tables, scheduler cadence, rate limits, error
  handling, verification protocol. This is what a connector actually costs.
- **§5** — What not to add and why.
- **§6** — Quick reference table.

Already-connected services (Spotify, Last.fm, MusicBrainz, ListenBrainz, Cover Art
Archive, LRCLIB) are **not** re-evaluated here. stats.fm is already in the codebase
and flagged for removal per `PROJECT-STATUS-AND-ROADMAP.md` §2.2; it is not
recommended for further investment.

---

## 1. The connector contract

Every new service must clear all of these. If it fails one, it does not belong.

1. **Free, or free-with-user-key.** No paid tiers required for the feature to work.
   No trial-dependent functionality. No enterprise-only data.
2. **Keyless, or the key lives in the OS keyring.** Never in the DB, never in
   `app_meta`, never hardcoded. The existing pattern (Spotify client ID, Last.fm key)
   is the model.
3. **No telemetry back to the service beyond the request itself.** No usage
   reporting, no analytics endpoints, no "phone home" on startup.
4. **Read-only against the service.** No writes that change state on someone else's
   platform unless the user explicitly clicks an action (the Spotify playlist-creation
   pattern is the exception, and it is user-initiated).
5. **Data stays local.** Cached responses live in the local DuckDB; nothing
   re-transmitted. If the service's terms forbid caching, respect that and cache only
   derived features, not raw payloads.
6. **Degrades independently.** A failed connector must not break the app. The existing
   pattern — "unavailable — connect in Services" — is the model. Every connector
   surface must render an empty state, not an error state.
7. **Copyright boundaries hold.** No service that requires storing lyric text,
   full tracks, or copyrighted media. Derived features only.
8. **Documented, stable API, or acknowledged fragility.** Official APIs preferred.
   Unofficial APIs and scrapers are allowed only if the owner explicitly opts in,
   clearly marked in the UI as experimental, and defended against breaking.

---

## 2. Priority order

| Tier | Service | Why it is here |
|---|---|---|
| **1 — Build** | Setlist.fm | Fills the existing `concerts` table. Free, keyed, MBID-based. Lowest effort, highest value. |
| **1 — Build** | Discogs | Adds a `label` dimension the record currently lacks. Free, keyed optional. Extends entity resolution. |
| **1 — Build** | FreqBlog *or* Musicstax | Unlocks the entire audio-features category you've flagged as missing. Pick by rate limit. |
| **2 — Consider** | WhoSampled | Musical genealogy — samples, covers, remixes. Unofficial API; fragile. Pairs with §2.13 graph work. |
| **2 — Consider** | Every Noise at Once (one-time import) | 2-D genre-space visualization. No ongoing API. Novel output. |
| **2 — Consider** | AcousticBrainz dump (one-time import) | Rich audio features with zero ongoing API calls. High setup effort, no limits thereafter. |
| **3 — Marginal** | SecondHandSongs | Overlaps WhoSampled. Pick one. |
| **3 — Marginal** | Genius / Musixmatch | LRCLIB already covers lyric themes. Only worth it for annotations. |
| **3 — Marginal** | Songkick / Bandsintown | Upcoming shows are notifications, not analytics. Setlist.fm covers the past. |
| **4 — Skip** | Rate Your Music | No official API, fragile scrapers, low analytical value. |
| **4 — Skip** | Apple Music API | $99/yr dev account, wrong design target. |

---

## 3. Service detail

### 3.1 Tier 1 — Build these

#### Setlist.fm

**What it adds:** Concert setlists — who played what, where, when. Automatically
populates the `concerts` table that currently exists as manual-entry only.

**Analytical value:**
- "You saw Beach House on 2022-08-14 — here's what you played the week before and
  after, and which songs from that setlist you've never streamed."
- Tour-vs-studio ratio: do you listen to more of an artist's catalogue after seeing
  them live?
- Venue memory: "every time you've seen a show at The Fillmore, you played X for
  weeks afterward."
- Setlist completeness: which songs from a show you attended have you still never
  played? (Feeds the concert memory idea in §2.2 of the feature recommendations.)

**Access:** Free REST API. Requires registration for an API key. Rate limit ~2 req/sec
authenticated. Artist lookup by MusicBrainz MBID — which you already resolve via the
MusicBrainz connector, so the join is direct.

**Fit:** Highest value, lowest effort. Fills an existing table (`concerts`) with
existing identity (`artists.mbid`). The `concertsFor()` query and schema already
exist — only the connector and the manual-entry UI remain.

**Boundaries:** Keyless once registered; key in keyring. Read-only. No caching
restrictions known.

**Caveat:** Setlist coverage is excellent for popular touring acts and sparse for
everything else. The UI should show "no setlists found" rather than an error.

---

#### Discogs

**What it adds:** Physical release metadata — pressings, labels, formats, catalogue
numbers, community stats. Where MusicBrainz gives the *canonical* release, Discogs
gives the *material object*.

**Analytical value:**
- **Label affinity** — a dimension the record currently has no concept of. "You
  over-index on releases from this label" is a genuinely new lens.
- **Format preference** — vinyl vs. digital vs. CD, when your plays map to specific
  pressings.
- **Obscurity proxy** — community ratings and marketplace stats as a signal for "how
  niche is this thing you love."
- Feeds the blind-spots analysis in §2.3 of the feature recommendations: "you've
  never played anything from these 40 labels."

**Access:** Free REST API. Optional personal access token raises the rate limit
(25/min unauthenticated → 60/min authenticated). The full database dump is CC0.

**Fit:** Extends the existing MusicBrainz/entity-resolution layer. New `labels` and
`releases` tables alongside the existing `albums`, keyed off MBID where possible.

**Boundaries:** Token (if used) in keyring. Read-only. Caching allowed for personal
use.

**Caveat:** Discogs and MusicBrainz disagree about release boundaries. The two
identity systems do not perfectly align. Plan for this: store both keys, prefer
MusicBrainz for canonical identity, use Discogs for material metadata.

---

#### FreqBlog Music Metadata *or* Musicstax

**What it adds:** BPM, key (name, Camelot, Open Key), energy, danceability, valence,
acousticness, instrumentalness, loudness, mood — essentially a drop-in replacement
for the deprecated Spotify audio-features endpoint.

**Analytical value:** unlocks the entire §2.6 audio-features category:
- Tempo drift: "your 2024 was 12 BPM faster than 2023."
- Key/mode analysis: "you over-index on minor keys in winter."
- Harmonic diversity: single "adventurousness" number.
- Duration preference trends.

**Access:**
- **FreqBlog** — free tier, ~1,000 requests/month, API key. Fine for a slowly-enriched
  library if you prioritise most-played tracks first (the existing enrichment model).
- **Musicstax** — API aimed at labels and partners; requires a relationship. Better
  rate limits if you can get access.

**Fit:** Small connector, new `track_features` table keyed by ISRC. Reuses the existing
enrichment scheduling (≤200 calls/hour, 25 per tick, most-played first) so it slots
into machinery that already exists.

**Boundaries:** Key in keyring. Read-only. Derived features cached locally; no raw
payloads retained beyond what is needed to populate the table.

**Caveat:** Spotify audio features are gone, and every replacement is either small
(FreqBlog), gated (Musicstax), or bulk (AcousticBrainz). Expect to pick one and
accept its limits rather than find a perfect substitute.

---

### 3.2 Tier 2 — Consider, with caveats

#### WhoSampled

**What it adds:** Sample, cover, and remix relationships between tracks. A *musical*
genealogy layer distinct from MusicBrainz's *personnel* genealogy.

**Analytical value:**
- "This track samples that track, which samples that other one" — a chain through your
  listening history.
- Cover-version detection: how many versions of the same song do you have, and which
  do you reach for?
- Sample-source discovery: "you love this drum break; here are 47 other songs that
  use it." The kind of insight that turns a record into a rabbit hole.

**Access:** **No official public API.** Unofficial APIs (RapidAPI, Parse) and scrapers
exist. Fragile, subject to breaking, and their terms are hostile to scraping in
spirit.

**Fit:** Extends the graph work in §2.13 of the feature recommendations — the artist
family tree becomes a *musical* family tree, and co-session edges gain a
sample-lineage overlay.

**Boundaries:** Only acceptable if the owner explicitly opts in, clearly marked
experimental in the UI, and built to fail soft (empty state, not error state) when
the unofficial API breaks.

**Verdict:** High analytical value, high fragility. Build only if the owner accepts
the maintenance burden.

---

#### Every Noise at Once (one-time import)

**What it adds:** A 2-D map of ~5,300 genre distinctions, positioned along axes
(organic ↔ mechanical, atmospheric ↔ spiky). Maps Spotify's genre taxonomy onto a
coordinate space.

**Analytical value:**
- Plot your listening on the ENAO map: "your 2024 was 30% more 'mechanical' than
  2023."
- Genre-space drift: are you moving toward denser/atmospheric music or spikier/bouncier?
- Novel visualization surface nothing else in the app provides.

**Access:** **No API.** The genre list is a static dataset. A one-time import (scrape
or manual export) into a `genre_map` table is the entire integration.

**Fit:** Joins against your existing Last.fm `artist_tags`. No ongoing API calls, no
rate limits, no keys.

**Boundaries:** One-time import; no live service; no key.

**Caveat:** The site is maintained by one person (Glenn McDonald, laid off from
Spotify in Dec 2023). The dataset is stable but not guaranteed. Import once, store
locally, never depend on it being reachable again.

---

#### AcousticBrainz dump (one-time import)

**What it adds:** ~120 low-level audio descriptors and 11 high-level features per
track, for ~7.5 million recordings. The richest audio-features dataset publicly
available.

**Analytical value:** Everything FreqBlog offers, plus the descriptors underneath it —
which enables custom feature work later (e.g., "what do your top tracks have in
common acoustically?").

**Access:** The live service shut down in mid-2022; the dataset was published as a
one-time public dump. Free to download, substantial in size.

**Fit:** One-time import matched against your ISRCs. Populates the same
`track_features` table as FreqBlog, so the two are interchangeable at the schema
level.

**Boundaries:** No key, no ongoing service, no rate limits — ever.

**Caveat:** High setup effort (bulk import, matching, storage). Worth it only if the
owner wants the richest possible feature set and does not mind the one-time work.
Not for a first pass.

---

### 3.3 Tier 3 — Marginal

#### SecondHandSongs

**What it adds:** Cover versions, originals, and song genealogies.

**Access:** Beta REST API, free, keyed.

**Verdict:** Overlaps heavily with WhoSampled. WhoSampled has richer sample data;
SecondHandSongs has cleaner cover data. **Pick one.** WhoSampled is the more
interesting for Deep Cuts because samples are a deeper rabbit hole than covers.

---

#### Genius / Musixmatch

**What it adds:** Richer lyric metadata — annotations, contributors, lyric status.

**Access:**
- **Genius** — API with token, exposes structured metadata (song, artist, album,
  annotations) but not raw lyrics text.
- **Musixmatch** — licensed lyrics access with proper API and free tier.

**Verdict:** Marginal. LRCLIB already covers the lyric-themes use case, and the
copyright boundary means raw text stays out. The only reason to add these is if the
owner wants **annotations** as a distinct feature — a richer form of derived
metadata. Not recommended until the existing lyric feature has proven its value.

---

#### Songkick / Bandsintown

**What it adds:** Upcoming and past concert dates.

**Access:**
- **Songkick** — public API historically, but has moved toward partner access; verify
  current availability before committing.
- **Bandsintown** — API requires app registration, rate-limited.

**Verdict:** Setlist.fm covers the analytically interesting half (what was played).
Upcoming shows are notifications, not analysis. Lower priority than Setlist.fm, and
largely redundant with it for the concert-memory feature.

---

### 3.4 Tier 4 — Skip

#### Rate Your Music

**What it adds:** User ratings, charts, genre hierarchies — the community's canonical
"is this album actually good" signal.

**Access:** No official API. Unofficial scrapers exist; they violate RYM's terms in
spirit if not letter.

**Verdict:** Skip. Fragile, ethically awkward, and the analytical value — "your taste
diverges from consensus by X%" — is a vanity metric, not an insight.

---

#### Apple Music API

**What it adds:** Apple Music catalogue and library access.

**Access:** Requires a $99/year Apple Developer account. Designed for app
distribution, not personal data analysis.

**Verdict:** Wrong tool. If cross-service import is desired, the Last.fm scrobble
history route (per §2.3 of the feature recommendations) is free and covers more of
the gap.

---

## 4. The build contract

What a connector actually costs. This is the checklist to follow so new connectors
look and behave like existing ones.

### 4.1 Files to touch

| Concern | File |
|---|---|
| Service client (HTTP, auth, parsing) | `src-tauri/src/connectors/<service>.rs` |
| Cached schema (new tables / columns) | append to `src-tauri/sql/schema.sql` |
| Cache read/write SQL | `src-tauri/sql/<service>_*.sql` |
| Scheduler hook | `src-tauri/src/scheduler.rs` |
| Command exposure | `src-tauri/src/commands.rs` |
| Services card | `src/pages/Services.tsx` |
| TypeScript query mirror (if UI reads cached data) | `src/lib/<service>Queries.ts` |
| Fixture test (if SQL logic is non-trivial) | `scripts/test_sql_fixtures.py` |

### 4.2 Database patterns

- **Cache tables** are additive and version-tolerant. Use
  `ALTER TABLE … ADD COLUMN IF NOT EXISTS` appended to `schema.sql` so existing owner
  records upgrade in place — the established pattern.
- **State tracking** reuses `connector_state` (service, status, account, last_sync_at,
  last_error, plays_added). Do not create a parallel table.
- **Identity joins** go through existing canonical IDs (`artists.artist_id`,
  `albums.album_id`, `tracks.track_id`) or MBID (`artists.mbid`) where the service
  supports it.
- **Derived-only caching** for anything under copyright: store features, not payloads.

### 4.3 Scheduler cadence

Match the existing rhythm:

| Cadence | Use for |
|---|---|
| Every 20 min | Live play polling (Spotify only) |
| Every few minutes | Cheap enrichment (tags, covers, lyrics) |
| Every 6 h | Slower connectors (stats.fm pattern) |
| Daily / nightly | Bulk reconciliation, cache refresh |
| One-time | Dump imports (AcousticBrainz, ENAO) |

New connectors should slot into an existing cadence rather than adding a new tick.
If a connector genuinely needs its own cadence, justify it in the PR.

### 4.4 Rate limits and quota

Follow the existing quota-aware pattern:

- Respect `Retry-After` and back off.
- On `QUOTA_EXCEEDED`, pause until the natural reset (midnight for Spotify) and log
  it in `activity_log` — **never** surface it as a UI error.
- Per-tick caps (the existing 25-per-10-minute model) prevent a new connector from
  starving the others.
- Authenticated rate limits (Discogs 60/min, Setlist.fm 2/sec, MusicBrainz 1/sec)
  belong in the client, not the caller.

### 4.5 Keys and secrets

- **Always** OS keyring via the existing mechanism.
- **Never** in `app_meta`, never in `.env` committed to the repo, never in logs.
- The Services card collects the key and writes it straight to the keyring.
- Key rotation (Last.fm's regenerated key mentioned in `docs/SETUP.md` §C) must be
  handled by re-prompting, not by silently failing.

### 4.6 Error surfacing

Two layers, both already established:

1. **In-app**: `connector_state.last_error` plus a status line on the Services card.
   The card should say "not connected" (informational) rather than "error" (alarming)
   when the user simply has not connected.
2. **Activity log**: transient failures (rate limit, network) log at `info`; genuine
   configuration problems (bad key, revoked token) log at `warn`.

A connector failure must never blank a page. The `ErrorBoundary` added in Phase 7c is
the backstop; the connector should degrade before reaching it.

### 4.7 Verification protocol

Per `PROJECT-STATUS-AND-ROADMAP.md` §2.1, the Rust layer is the least-proven part of
the codebase. Each new connector needs, at minimum:

1. **A dry-run harness** — a small Rust test or a standalone binary that hits the
   service with a known input and asserts a shaped response. Not run in CI (would
   need network + keys); run manually once per change.
2. **A degraded-path test** — disconnect the network mid-sync and confirm the app
   keeps working and the connector reports its failure without blanking a page.
3. **A real-data pass** — the owner runs it against their own account and reports the
   numbers. This has been the primary feedback loop for Rust throughout the project.
4. **A fixture** for any SQL that transforms the cached data — the same discipline
   that caught the album-ride and stuck-repeat bugs.

### 4.8 What a new connector must **not** do

- Add a new top-level navigation item.
- Add a new settings section outside the existing Settings page.
- Introduce a new state-management pattern in the frontend.
- Write to the `events` table (that is append-only, real listening only).
- Bypass `connector_state` for its own status tracking.

The value of the connector layer is that connectors are uniform. Keep them that way.

---

## 5. What not to add and why

- **Any service requiring cloud storage of the user's data.** Violates
  `docs/SETUP.md` §D and the local-first principle.
- **Any service requiring a paid subscription to function.** Free tier only, or
  user-provided key with a usable free tier.
- **Any service requiring a corporate relationship to sign up.** Musicstax is
  borderline here — it is listed as "consider" only because the owner may already
  have access; do not pursue it as a new signup.
- **Any service that stores or transmits raw lyrics.** The copyright boundary is
  explicit and must hold.
- **Any service already in the codebase that the roadmap has flagged for removal**
  (stats.fm). Do not invest further.
- **Any service whose only value is a vanity metric.** RYM-style consensus-divergence
  numbers are not worth the fragility.
- **Any real-time or social-feed service.** The Blend-via-file-exchange pattern is
  the right level for this project's ethos.

---

## 6. Quick reference

| Service | Adds | Access | Key? | Effort | Tier |
|---|---|---|---|---|---|
| **Setlist.fm** | Concert setlists | Free REST | Yes | Low | 1 |
| **Discogs** | Labels, releases, formats | Free REST | Optional | Low–med | 1 |
| **FreqBlog** | BPM, key, energy, mood | Free tier (1k/mo) | Yes | Low | 1 |
| **Musicstax** | BPM, key, energy (alt) | Partner API | Yes | Med | 1 (verify access) |
| **WhoSampled** | Samples, covers, remixes | Unofficial only | No | Med | 2 (fragile) |
| **Every Noise at Once** | 2-D genre map | One-time import | No | Low | 2 |
| **AcousticBrainz dump** | Rich audio features | One-time dump | No | High | 2 |
| **SecondHandSongs** | Covers, originals | Beta REST | Yes | Med | 3 |
| **Genius / Musixmatch** | Lyric annotations | REST | Yes | Med | 3 |
| **Songkick / Bandsintown** | Upcoming shows | Partner/registered | Yes | Med | 3 |
| **Rate Your Music** | Community ratings | Scrape only | — | Med | 4 (skip) |
| **Apple Music** | Catalogue + library | $99/yr dev account | Yes | High | 4 (skip) |

**Already connected (not re-evaluated):** Spotify, Last.fm, MusicBrainz,
ListenBrainz, Cover Art Archive, LRCLIB.

**Already in codebase, flagged for removal:** stats.fm.

---

*End of DeepSeek connector recommendations. Compiled September 11, 2026.*