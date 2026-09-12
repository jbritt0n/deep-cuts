# Heard in the Wild — design note (Phase 8)

**What it is.** Songs the owner's phone recognised out in the world — Google's Pixel *Now Playing* (ambient) and *Shazam* (deliberate) — imported into Deep Cuts as a class of their own and surfaced on the `/wild` page. The interesting half is what the owner has **never streamed**: discovery the streaming record cannot produce on its own.

**Why it exists in this shape.** Neither Shazam (Apple) nor Now Playing (on-device history) has a "give me my history" API. Both can be scrobbled to Last.fm by a phone-side scrobbler (owner: Pano Scrobbler). So the buildable thing is a **Last.fm scrobble importer**, and the design problem is keeping those scrobbles from contaminating the owner's chosen listening.

## 1. Isolation: a separate event class
Captures are `events` rows with `event_type = 'wild_play'`. Every core view (`plays_normalized`, hence `plays_resolved`, sessions, insights, milestones, streaks) filters `event_type = 'play'`. Isolation is therefore structural: no query has to remember to exclude anything. `wild_plays` (schema.sql) is the only view that reads the class.

Invariant, checked by `scripts/smoke-wild.ts`: `COUNT(plays_resolved) = COUNT(events) − COUNT(wild_play events)`.

Rule for future work: **join `wild_plays` to the record, never the record to `wild_plays`.**

## 2. Deduplication: own playback overheard
Now Playing hears whatever is in the room — including the owner's own Spotify through a speaker. Pano may also be scrobbling the Spotify app itself. Last.fm does not say which client produced a scrobble, so the only honest test is temporal, done at ingest in `sql/wild_insert.sql`:

A capture stamped at `w_at` is **dropped** when a primary play (`event_type='play'`, any source) exists such that
- `p_artist = w_artist` (normalised: lower/trim), **and** either
  - `w_at ∈ [p_start − 120 s, p_end + 120 s]` **and** titles match loosely — normalised equality **or** containment after stripping `(…)`, `[…]` and ` - …` suffixes (Google's and Spotify's titles for the same recording differ), **or**
  - `w_at ∈ [p_start, p_end]` regardless of title — two songs cannot play from one speaker at once.

`p_start`/`p_end` follow each source's clock: the extended export stamps **end** of play, every other source stamps **start** (see the header of `plays_normalized`). The candidate scan is bounded to ±3 h on the indexed `events.occurred_at`, then JSON is unpacked only for those rows.

Also dropped: an exact re-import (same `lastfm_uts` + title) — the importer is idempotent.

**Accepted false negative:** a genuine ambient capture of artist X while the owner was streaming X at that moment is dropped. That is the safe direction for the metrics the owner cares about.

Fixtures: `test_wild_never_touches_core_record`, `test_wild_drops_own_spotify_playback` (inside / tolerance / suffix / same-artist-inside / same-artist-outside / hours-later / different-artist), `test_wild_start_stamped_sources_and_idempotency`.

## 3. Phone-side setup (what the app tells the owner)
1. Pano → scrobble **Now Playing** and **Shazam**.
2. Pano → **Spotify off** (its history is already in the record), or — cleaner — a **dedicated Last.fm account** that only Pano writes to, entered on the Services card. Then §2 is a safety net rather than the primary defence.
3. `since` defaults to setup day so a main account's years of Spotify scrobbles are never classified as "overheard".

## 4. What is *not* known
- Per-app origin (Shazam vs Now Playing). Last.fm doesn't expose the client. One bucket, said plainly in the UI.
- Duration, skip, or completion — a capture is a moment, not an interval. This is another reason captures must not enter the attention/session machinery.
- Location. Only time of day and weekday, which the page turns into "where the world plays you music".

## 5. Files
`src-tauri/sql/schema.sql` (view + connector row) · `src-tauri/sql/wild_insert.sql` · `src-tauri/src/connectors/lastfm_wild.rs` · `commands.rs` (`lastfm_wild_connect/disconnect`, `sync_now`, `get_connectors` extras) · `scheduler.rs` (30-min tick) · `src/lib/wildQueries.ts` · `src/pages/Wild.tsx` · `src/pages/Services.tsx` (`WildBody`) · `scripts/smoke-wild.ts` · fixtures in `scripts/test_sql_fixtures.py`.

## 6. What the first real run taught (Phase 9a)
The owner's first import was **entirely their own Spotify plays**. Two things combined: Pano was writing to a Last.fm account that Spotify also scrobbled to, and — because Spotify quota had been starving the poller — those plays had never reached the record, so §2's temporal check had nothing to match against. Lesson: **the desktop dedup can only catch what the record already holds; the phone-side account separation is the primary defence, not a nicety.** 9a added `lastfm_wild_reset` (purge + re-point) and a Services guard that fires when ≥ 60 % of captured songs are already in the record.

## 7. Ideas queued
Day-page strip (`wildOnDay()` exists, UI not wired) · "heard near a show" once Setlist.fm lands · monthly *new to you* digest via the Liner Notes composer · export the never-streamed list as a playlist in one click (the `MakePlaylistButton` needs Spotify track ids; `add_to_radar` by search works today).
