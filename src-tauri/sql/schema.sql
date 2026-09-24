-- ============================================================
-- Deep Cuts v3 — DuckDB schema
-- Ported from v1 packages/schema/schema.sql and extended per spec §4.
-- Event-sourced core: `events` is append-only truth (NFR-03); every
-- other table is derived and rebuilt by the pipeline (DM-02):
--   entity_resolution.sql → compute_sessions.sql → (Phase 3) lifecycle,
--   insights, milestones.
-- This file is idempotent: safe to run on every app start.
-- ============================================================

-- ------------------------------------------------------------
-- 4.1 Core (v1, unchanged shape)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    event_id     UUID DEFAULT uuid() PRIMARY KEY,
    event_type   VARCHAR NOT NULL,          -- 'play'
    occurred_at  TIMESTAMPTZ NOT NULL,      -- see plays_normalized for semantics
    payload      JSON NOT NULL,
    ingested_at  TIMESTAMPTZ DEFAULT now(),
    source_file  VARCHAR
);
CREATE INDEX IF NOT EXISTS idx_events_occurred ON events (occurred_at);

-- Local time without the ICU extension: Rust fills this from the IANA tz
-- database for the configured zone (default: the OS zone). Each row is a
-- UTC range with a fixed offset; the rebuild ASOF-joins plays onto it. When
-- empty, local = UTC. All *display* timestamps in derived tables are naive
-- local wall-clock TIMESTAMPs; `events.occurred_at` stays a UTC instant.
CREATE TABLE IF NOT EXISTS tz_offsets (
    from_utc   TIMESTAMP,
    offset_s   INTEGER,
    zone       VARCHAR
);

-- App metadata (schema version, timezone, last rebuild…)
CREATE TABLE IF NOT EXISTS app_meta (
    key   VARCHAR PRIMARY KEY,
    value VARCHAR
);
INSERT INTO app_meta (key, value) VALUES ('schema_version', '3')
ON CONFLICT (key) DO NOTHING;
INSERT INTO app_meta (key, value) VALUES ('attention_gap_min', '120')
ON CONFLICT (key) DO NOTHING;

-- Import bookkeeping (ING-02/ING-03): one row per source file per import run.
CREATE TABLE IF NOT EXISTS import_files (
    import_id     UUID,
    source_file   VARCHAR,
    imported_at   TIMESTAMPTZ DEFAULT now(),
    rows_total    INTEGER,
    rows_audio    INTEGER,
    rows_skipped  INTEGER,   -- podcast / video / audiobook rows (no track name)
    rows_inserted INTEGER,   -- after dedupe
    rows_duplicate INTEGER
);

-- Background task log surfaced in Settings → Activity (NFR-05)
CREATE TABLE IF NOT EXISTS activity_log (
    id          UUID DEFAULT uuid() PRIMARY KEY,
    logged_at   TIMESTAMPTZ DEFAULT now(),
    task        VARCHAR,          -- 'import' | 'rebuild' | 'demo_seed' | 'poll' | 'sync' | 'enrich' …
    level       VARCHAR,          -- 'info' | 'warn' | 'error'
    message     VARCHAR,
    detail      VARCHAR
);

-- ------------------------------------------------------------
-- plays_normalized — one row per play, straight from events.
--
-- TIMESTAMP SEMANTICS (CON-11 / ING-06 / spec §15 risk row):
--   * source = 'extended_export'      → occurred_at is END of play (Spotify "ts")
--   * source = 'recently_played_poll' → occurred_at is START of play (API played_at)
--   * source = 'lastfm_import'        → START of play (scrobble time)
--   * source = 'statsfm_import'       → START of play
--   * source = 'demo'                 → START of play (synthetic)
-- `played_at_utc` below is normalised to END-of-play for every source so the
-- dashboard has one consistent clock: start-of-play sources add ms_played.
-- Local wall-clock conversion happens in entity_resolution.sql (tz_offsets).
-- Dedupe across sources happens at ingest on (track identity, played_at ±2 s).
-- ------------------------------------------------------------
-- Phase 9j: Spotify's recently-played API reports only that a track STARTED — no skip reason, no ms played — so 9i
-- stored every polled play as heard in full, never skipped (owner: "skips show 0% everywhere, long sessions flag as
-- inattentive"). For polled plays we now infer both from the next polled start: if the next track began before this
-- one could have finished, you moved on; the time between the two starts is what you heard (capped at the track's
-- length). A skip = moved on > 15 s before the end AND heard < 85 %. Inferred skips set end_reason 'fwdbtn', so they
-- also count as interactions for attention. Exports keep their own real values.
CREATE OR REPLACE VIEW plays_normalized AS
WITH e AS (
    SELECT event_id, occurred_at, payload,
           json_extract_string(payload, '$.source') AS src,
           CAST(json_extract(payload, '$.ms_played') AS BIGINT) AS ms_raw
    FROM events WHERE event_type = 'play'),
poll AS (
    SELECT event_id,
           epoch_ms(LEAD(occurred_at) OVER (ORDER BY occurred_at, event_id)) - epoch_ms(occurred_at) AS to_next_ms
    FROM e WHERE src = 'recently_played_poll'),
x AS (
    SELECT e.*, poll.to_next_ms,
           CASE WHEN e.src = 'recently_played_poll' AND poll.to_next_ms IS NOT NULL AND poll.to_next_ms >= 0 AND poll.to_next_ms < e.ms_raw
                THEN poll.to_next_ms ELSE e.ms_raw END AS ms_eff,
           (e.src = 'recently_played_poll' AND poll.to_next_ms IS NOT NULL AND poll.to_next_ms >= 0
            AND poll.to_next_ms < e.ms_raw - 15000 AND poll.to_next_ms < 0.85 * e.ms_raw) AS skip_inferred
    FROM e LEFT JOIN poll USING (event_id))
SELECT
    event_id                                             AS play_id,
    CASE WHEN src IN ('extended_export') THEN occurred_at
         ELSE occurred_at + (COALESCE(ms_eff, 0) * INTERVAL 1 MILLISECOND) END AS played_at_utc,
    occurred_at                                          AS raw_at,
    json_extract_string(payload, '$.spotify_track_id')   AS spotify_track_id,
    json_extract_string(payload, '$.track_name')         AS track_name,
    json_extract_string(payload, '$.artist_name')        AS artist_name,
    json_extract_string(payload, '$.album_name')         AS album_name,
    ms_eff                                               AS ms_played,
    json_extract_string(payload, '$.platform')           AS platform,
    CASE WHEN skip_inferred THEN 'fwdbtn' ELSE json_extract_string(payload, '$.end_reason') END AS end_reason,
    json_extract_string(payload, '$.start_reason')       AS start_reason,
    CAST(json_extract(payload, '$.shuffle') AS BOOLEAN)  AS shuffle,
    src                                                  AS source,
    json_extract_string(payload, '$.country')            AS country,
    COALESCE(skip_inferred OR json_extract_string(payload, '$.end_reason') IN ('fwdbtn', 'backbtn'), FALSE) AS was_skipped,
    -- Phase 9c: the "short play" cutoff is owner-tunable (app_meta short_play_seconds, default 30). Rebuild after changing.
    (ms_eff < 1000 * coalesce(TRY_CAST((SELECT value FROM app_meta WHERE key = 'short_play_seconds') AS BIGINT), 30)) AS under_30s
FROM x;

-- ------------------------------------------------------------
-- 4.2 Entity tables (canonical IDs). Populated by entity_resolution.sql.
--   artist_id: 'name:<lower-trimmed name>' now; MBID-keyed identity later (CON-06).
--   track_id : spotify track id when known, else 'local:<hash(name,artist)>'.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artists (
    artist_id    VARCHAR PRIMARY KEY,
    name         VARCHAR,               -- display name = most-played spelling
    mbid         VARCHAR,               -- CON-06 seam, NULL until MusicBrainz resolves it
    image_url    VARCHAR,
    enriched_at  TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS albums (
    album_id        VARCHAR PRIMARY KEY,
    name            VARCHAR,
    artist_id       VARCHAR,
    release_date    DATE,
    album_type      VARCHAR,
    total_tracks    INTEGER,
    image_url       VARCHAR,
    enriched_at     TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS tracks (
    track_id          VARCHAR PRIMARY KEY,
    name              VARCHAR,
    artist_id         VARCHAR,
    album_id          VARCHAR,
    duration_ms       INTEGER,          -- from Spotify enrichment (ENR-01)
    duration_ms_est   INTEGER,          -- from the archive: longest 'trackdone' play
    track_number      INTEGER,          -- for SES-07 album_ride ordering (Phase 2)
    isrc              VARCHAR,
    explicit          BOOLEAN,
    release_date      DATE,
    release_precision VARCHAR,
    enriched_at       TIMESTAMPTZ
);

-- Alternate spellings/ids that map onto one canonical entity. History is never
-- rewritten (CON-06): aliases let renamed artists stay queryable under either name.
CREATE TABLE IF NOT EXISTS artist_aliases (
    alias_name  VARCHAR,
    artist_id   VARCHAR,
    plays       INTEGER,
    PRIMARY KEY (alias_name)
);
CREATE TABLE IF NOT EXISTS track_aliases (
    track_id    VARCHAR,
    alt_name    VARCHAR,
    alt_artist  VARCHAR
);

-- Tags from Last.fm / MusicBrainz (ENR-02, CON-12): one tag set per artist
-- identity, sources coexist, merge never overwrite.
CREATE TABLE IF NOT EXISTS artist_tags (
    artist_id   VARCHAR,
    tag         VARCHAR,       -- normalised lowercase
    weight      DOUBLE,
    source      VARCHAR,       -- 'lastfm' | 'musicbrainz'
    fetched_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (artist_id, tag, source)
);

-- MusicBrainz relationships → side-project detector (CON-07 / REC-04)
CREATE TABLE IF NOT EXISTS artist_relations (
    artist_mbid    VARCHAR,
    relation_type  VARCHAR,     -- 'member of band' | 'is person' | 'collaboration' …
    related_mbid   VARCHAR,
    related_name   VARCHAR,
    fetched_at     TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- 4.3 Library and playlists (Phase 2 fill; schema lands now)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS liked_songs (
    track_id   VARCHAR PRIMARY KEY,
    added_at   TIMESTAMPTZ,
    synced_at  TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS playlists (
    playlist_id  VARCHAR PRIMARY KEY,
    name         VARCHAR,
    description  VARCHAR,
    owner_is_me  BOOLEAN,
    track_count  INTEGER,
    snapshot_id  VARCHAR,
    public       BOOLEAN,
    synced_at    TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS playlist_items (
    playlist_id  VARCHAR,
    track_id     VARCHAR,
    added_at     TIMESTAMPTZ,
    position     INTEGER
);
CREATE TABLE IF NOT EXISTS created_playlists (
    id                  UUID DEFAULT uuid() PRIMARY KEY,
    spotify_playlist_id VARCHAR,
    name                VARCHAR,
    kind                VARCHAR,        -- 'theme' | 'list_export' | 'insight' | 'radar'
    theme_text          VARCHAR,
    theme_profile       JSON,
    track_ids           JSON,
    rationale           JSON,           -- Phase 4 seam: per-track "why"
    is_public           BOOLEAN DEFAULT FALSE,
    created_at          TIMESTAMPTZ DEFAULT now(),
    llm_model           VARCHAR         -- Phase 4 seam
);

-- ------------------------------------------------------------
-- 4.4 Sessions v2 — rebuilt by compute_sessions.sql
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
    session_id             UUID PRIMARY KEY,
    start_at               TIMESTAMP,   -- local wall clock
    end_at                 TIMESTAMP,
    track_count            INTEGER,
    skip_count             INTEGER,
    unique_artist_count    INTEGER,
    unique_track_count     INTEGER,
    total_ms               BIGINT,
    platform               VARCHAR,
    opening_track_id       VARCHAR,
    closing_track_id       VARCHAR,
    opening_track          VARCHAR,
    closing_track          VARCHAR,
    session_shape          VARCHAR,   -- §6.2 v2 shapes
    -- v2 metrics (SES-01…08)
    completion_rate        DOUBLE,
    completion_source      VARCHAR,   -- 'duration' | 'estimate' | 'skip_fallback'
    skip_rate              DOUBLE,
    repeat_rate            DOUBLE,
    novelty_rate           DOUBLE,
    artist_entropy         DOUBLE,
    top_artist_share       DOUBLE,
    time_to_first_skip_s   INTEGER,
    longest_unbroken_run   INTEGER,
    album_ride             BOOLEAN,
    is_late_night          BOOLEAN,
    is_weekend             BOOLEAN,
    day_part               VARCHAR,   -- morning | midday | evening | night | late
    -- attention (see plays_resolved.attended)
    interaction_count      INTEGER,
    attended_ms            BIGINT,
    unattended_ms          BIGINT,
    attention              VARCHAR,   -- active | drifting | unattended
    stuck_repeat           BOOLEAN DEFAULT FALSE  -- same track ≥8× in a row naturally — likely left looping
);
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS stuck_repeat BOOLEAN DEFAULT FALSE;
-- Phase 9d: session chaos — mean cosine DISTANCE between consecutive plays' artist tag vectors (0 = coherent, 1 = jarring).
-- An attribute, not a shape: shape describes structure, chaos describes coherence. NULL when too few tagged pairs.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chaos DOUBLE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS chaos_pairs INTEGER;

CREATE TABLE IF NOT EXISTS play_sessions (
    play_id              UUID,
    session_id           UUID,
    position_in_session  INTEGER     -- SES-09, 1-based
);

CREATE TABLE IF NOT EXISTS session_transitions (
    from_track_id  VARCHAR,
    to_track_id    VARCHAR,
    count          INTEGER
);

-- ------------------------------------------------------------
-- 4.5 Insights cache, milestones, lifecycle (Phase 3 fill; tables land now)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS insights (
    insight_id    UUID DEFAULT uuid() PRIMARY KEY,
    kind          VARCHAR,
    period_start  DATE,
    period_end    DATE,
    subject_type  VARCHAR,
    subject_id    VARCHAR,
    payload       JSON,
    score         DOUBLE,
    generated_at  TIMESTAMPTZ DEFAULT now(),
    surfaced      BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS milestones (
    milestone_id  UUID DEFAULT uuid() PRIMARY KEY,
    type          VARCHAR,
    occurred_at   TIMESTAMPTZ,
    description   VARCHAR,
    subject_type  VARCHAR,
    subject_id    VARCHAR,
    value         BIGINT,
    seen          BOOLEAN DEFAULT FALSE
);

CREATE TABLE IF NOT EXISTS artist_lifecycle (
    artist_id        VARCHAR PRIMARY KEY,
    first_played_at  TIMESTAMPTZ,
    peak_month       DATE,
    peak_hours       DOUBLE,
    last_played_at   TIMESTAMPTZ,
    status           VARCHAR,     -- rising | peak | fading | dormant | returned
    months_active    INTEGER,
    half_life_days   INTEGER
);

-- Recommendation feedback (DIS-03 seam): dismissals suppress for 90 days.
CREATE TABLE IF NOT EXISTS recommendation_feedback (
    subject_type  VARCHAR,       -- 'artist' | 'album'
    subject_key   VARCHAR,       -- mbid or normalised name
    engine        VARCHAR,       -- 'adjacency' | 'tag_affinity' | 'structural' | 'side_project' | 'release_radar'
    verdict       VARCHAR,       -- 'accepted' | 'dismissed'
    decided_at    TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Convenience rollups used by the dashboard (v1, now on plays_resolved
-- so renamed artists roll up together)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plays_resolved (
    play_id           UUID,
    played_at         TIMESTAMP,     -- LOCAL wall clock (end of play)
    played_at_utc     TIMESTAMPTZ,   -- the instant
    track_id          VARCHAR,
    artist_id         VARCHAR,
    album_id          VARCHAR,
    track_name        VARCHAR,
    artist_name       VARCHAR,     -- canonical display name
    album_name        VARCHAR,
    ms_played         BIGINT,
    platform          VARCHAR,
    end_reason        VARCHAR,
    start_reason      VARCHAR,
    shuffle           BOOLEAN,
    source            VARCHAR,
    was_skipped       BOOLEAN,
    under_30s         BOOLEAN,
    is_first_play     BOOLEAN,     -- SES-03 novelty
    play_index        INTEGER,     -- nth play of this track (1-based)
    -- Attention (set by compute_sessions.sql): a play is attended when the
    -- listener interacted (click / skip / back / app open / stop) within the
    -- last `attention_gap_min` minutes (app_meta, default 120). Long autoplay
    -- stretches — the laptop left on all night — become unattended.
    attended          BOOLEAN DEFAULT TRUE,
    idle_min          DOUBLE,      -- minutes since the last interaction
    country           VARCHAR,     -- conn_country from the export
    zone              VARCHAR      -- IANA zone used for played_at
);

CREATE OR REPLACE VIEW daily_minutes AS
SELECT
    CAST(played_at AS DATE)             AS day,
    ROUND(SUM(ms_played) / 60000.0, 1)  AS minutes,
    COUNT(*)                            AS plays,
    COUNT(DISTINCT artist_id)           AS unique_artists
FROM plays_resolved
GROUP BY 1;

CREATE OR REPLACE VIEW top_artists_all_time AS
SELECT
    artist_id,
    artist_name,
    COUNT(*)                                     AS plays,
    ROUND(SUM(ms_played) / 3600000.0, 1)         AS hours,
    AVG(CASE WHEN was_skipped THEN 1 ELSE 0 END) AS skip_rate,
    MIN(played_at)                               AS first_played_at,
    MAX(played_at)                               AS last_played_at
FROM plays_resolved
WHERE artist_id IS NOT NULL
GROUP BY 1, 2;

-- Attentive-only variants for the UI filter.
CREATE OR REPLACE VIEW daily_minutes_attended AS
SELECT CAST(played_at AS DATE) AS day, ROUND(SUM(ms_played) / 60000.0, 1) AS minutes,
       COUNT(*) AS plays, COUNT(DISTINCT artist_id) AS unique_artists
FROM plays_resolved WHERE attended GROUP BY 1;

CREATE OR REPLACE VIEW hourly_profile AS
SELECT
    EXTRACT(hour FROM played_at)          AS hour_of_day,
    ROUND(SUM(ms_played) / 3600000.0, 2)  AS hours,
    COUNT(*)                              AS plays
FROM plays_resolved
GROUP BY 1
ORDER BY 1;

-- ------------------------------------------------------------
-- Phase 2 — connectors (CON) state and Spotify sync bookkeeping
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS connector_state (
    service        VARCHAR PRIMARY KEY,   -- spotify | lastfm | musicbrainz | statsfm
    status         VARCHAR,               -- disconnected | connected | error | paused
    account        VARCHAR,               -- display name / username
    last_sync_at   TIMESTAMPTZ,
    last_error     VARCHAR,
    plays_added    BIGINT DEFAULT 0,      -- CON-10: what this source contributed
    detail         JSON
);
INSERT INTO connector_state (service, status) VALUES ('spotify', 'disconnected'), ('lastfm', 'disconnected'),
       ('musicbrainz', 'disconnected'), ('statsfm', 'disconnected'), ('listenbrainz', 'disconnected')
ON CONFLICT (service) DO NOTHING;

-- API-07 quota bookkeeping: calls per hour per service, and pause-until.
CREATE TABLE IF NOT EXISTS api_calls (
    service    VARCHAR,
    called_at  TIMESTAMPTZ DEFAULT now(),
    endpoint   VARCHAR,
    status     INTEGER
);

-- ------------------------------------------------------------
-- Phase 4 — blend (a second person's export, aggregated; never mixed into events)
-- and lyric features (derived only — full lyrics are never stored).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS blend_plays (
    label             VARCHAR,          -- whose export ("Sam")
    spotify_track_id  VARCHAR,
    track_name        VARCHAR,
    artist_name       VARCHAR,
    album_name        VARCHAR,
    plays             INTEGER,
    ms_played         BIGINT,
    first_at          TIMESTAMPTZ,
    last_at           TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS track_lyric_features (
    track_id     VARCHAR PRIMARY KEY,
    source       VARCHAR,               -- 'lrclib'
    found        BOOLEAN,               -- false = looked, no lyrics (don't retry)
    word_count   INTEGER,
    keywords     VARCHAR[],             -- distinctive content words, lowercase (≤ 40)
    themes       VARCHAR[],             -- from the theme dictionary (rain, night, colours, cities…)
    colours      VARCHAR[],
    lang         VARCHAR,
    fetched_at   TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Phase 5 — data hygiene: manual artist merges applied during entity resolution.
-- History is never rewritten; the mapping just redirects the canonical id.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artist_merges (
    from_artist_id  VARCHAR PRIMARY KEY,   -- the id being folded in
    into_artist_id  VARCHAR,               -- the id that survives
    created_at      TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Phase 7 — travel time zones, scenes, hygiene, concerts
-- ------------------------------------------------------------
-- Single-zone countries → IANA zone. Plays whose conn_country maps here use that
-- zone; multi-zone countries (US, CA, AU, BR, MX, RU, ID…) fall back to the home
-- zone unless a manual override covers the date.
CREATE TABLE IF NOT EXISTS country_zones (country VARCHAR PRIMARY KEY, zone VARCHAR);
INSERT INTO country_zones VALUES
 ('TR','Europe/Istanbul'),('GB','Europe/London'),('IE','Europe/Dublin'),('PT','Europe/Lisbon'),('FR','Europe/Paris'),('DE','Europe/Berlin'),('NL','Europe/Amsterdam'),('BE','Europe/Brussels'),('ES','Europe/Madrid'),('IT','Europe/Rome'),('CH','Europe/Zurich'),('AT','Europe/Vienna'),('CZ','Europe/Prague'),('PL','Europe/Warsaw'),('HU','Europe/Budapest'),('DK','Europe/Copenhagen'),('SE','Europe/Stockholm'),('NO','Europe/Oslo'),('FI','Europe/Helsinki'),('GR','Europe/Athens'),('RO','Europe/Bucharest'),('BG','Europe/Sofia'),('HR','Europe/Zagreb'),('RS','Europe/Belgrade'),('UA','Europe/Kyiv'),('IS','Atlantic/Reykjavik'),
 ('IL','Asia/Jerusalem'),('AE','Asia/Dubai'),('SA','Asia/Riyadh'),('EG','Africa/Cairo'),('MA','Africa/Casablanca'),('ZA','Africa/Johannesburg'),('KE','Africa/Nairobi'),('NG','Africa/Lagos'),('GH','Africa/Accra'),('ET','Africa/Addis_Ababa'),('TZ','Africa/Dar_es_Salaam'),
 ('IN','Asia/Kolkata'),('JP','Asia/Tokyo'),('KR','Asia/Seoul'),('CN','Asia/Shanghai'),('HK','Asia/Hong_Kong'),('TW','Asia/Taipei'),('SG','Asia/Singapore'),('MY','Asia/Kuala_Lumpur'),('TH','Asia/Bangkok'),('VN','Asia/Ho_Chi_Minh'),('PH','Asia/Manila'),('NZ','Pacific/Auckland'),
 ('AR','America/Argentina/Buenos_Aires'),('CL','America/Santiago'),('CO','America/Bogota'),('PE','America/Lima'),('UY','America/Montevideo'),('CR','America/Costa_Rica'),('PA','America/Panama'),('JM','America/Jamaica'),('CU','America/Havana'),('DO','America/Santo_Domingo'),('PR','America/Puerto_Rico'),('GT','America/Guatemala')
ON CONFLICT (country) DO NOTHING;

-- Manual overrides (Settings → Travel): inclusive dates, local.
CREATE TABLE IF NOT EXISTS tz_overrides (
    id         UUID DEFAULT uuid() PRIMARY KEY,
    from_date  DATE,
    to_date    DATE,
    zone       VARCHAR,
    note       VARCHAR
);

-- Sessions the owner marked by hand (Settings → Session hygiene / session page).
CREATE TABLE IF NOT EXISTS session_overrides (
    start_at   TIMESTAMP,     -- local start of the session at the time it was marked (stable across rebuilds)
    attention  VARCHAR,       -- 'unattended' | 'active'
    note       VARCHAR,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (start_at)
);

-- Concerts (lite): dates you saw an artist; artist page shows the bump.
CREATE TABLE IF NOT EXISTS concerts (
    id         UUID DEFAULT uuid() PRIMARY KEY,
    artist_id  VARCHAR,
    on_date    DATE,
    venue      VARCHAR,
    note       VARCHAR
);

-- Scenes: clusters of artists that share tags / origin. Rebuilt by compute_insights.sql.
CREATE TABLE IF NOT EXISTS artist_scene (artist_id VARCHAR, scene VARCHAR, weight DOUBLE);

-- Artist origin from Wikidata / MusicBrainz area (Phase 7 connector).
CREATE TABLE IF NOT EXISTS artist_origin (
    artist_id    VARCHAR PRIMARY KEY,
    country      VARCHAR,     -- ISO-2
    country_name VARCHAR,
    city         VARCHAR,
    formed_year  INTEGER,
    source       VARCHAR,
    fetched_at   TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Migrations for records created by earlier versions (idempotent).
-- ------------------------------------------------------------
ALTER TABLE plays_resolved ADD COLUMN IF NOT EXISTS country VARCHAR;
ALTER TABLE plays_resolved ADD COLUMN IF NOT EXISTS zone VARCHAR;
ALTER TABLE plays_resolved ADD COLUMN IF NOT EXISTS attended BOOLEAN DEFAULT TRUE;
ALTER TABLE plays_resolved ADD COLUMN IF NOT EXISTS idle_min DOUBLE;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS interaction_count INTEGER;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS attended_ms BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS unattended_ms BIGINT;
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS attention VARCHAR;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS duration_ms_est INTEGER;
ALTER TABLE tracks ADD COLUMN IF NOT EXISTS track_number INTEGER;
ALTER TABLE artists ADD COLUMN IF NOT EXISTS mbid VARCHAR;
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS public BOOLEAN;
ALTER TABLE created_playlists ADD COLUMN IF NOT EXISTS is_public BOOLEAN DEFAULT FALSE;
ALTER TABLE connector_state ADD COLUMN IF NOT EXISTS detail JSON;

-- ------------------------------------------------------------
-- Phase 8 — Heard in the Wild (ambient / Shazam captures via Last.fm).
--
-- Captures arrive as Last.fm scrobbles written by a phone-side scrobbler
-- (Pano Scrobbler → Now Playing + Shazam). They are stored as a SEPARATE
-- event class, `event_type = 'wild_play'`, so nothing in the core pipeline
-- (plays_normalized → plays_resolved → sessions/insights/streaks) can ever see
-- them: every core view filters `event_type = 'play'`. This is deliberate —
-- a capture is "I heard this somewhere", not "I chose to play this".
--
-- Per-app provenance (Shazam vs. Now Playing) is NOT recoverable: the Last.fm
-- API does not expose which client submitted a scrobble. The whole class is
-- therefore one bucket. `occurred_at` is the scrobble timestamp (start of the
-- moment the song was heard); captures carry no duration and no skip signal.
--
-- Deduplication against the owner's own Spotify playback happens at ingest
-- (wild_insert.sql): a capture that lands inside a primary play of the same
-- song/artist is the owner's own speakers being overheard, and is dropped.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW wild_plays AS
SELECT
    event_id                                             AS wild_id,
    occurred_at                                          AS heard_at_utc,
    -- local wall clock in the home zone (tz_offsets is loaded by the app)
    CAST(occurred_at AS TIMESTAMP)
      + COALESCE((SELECT t.offset_s FROM tz_offsets t
                  WHERE t.zone = (SELECT value FROM app_meta WHERE key = 'timezone')
                    AND t.from_utc <= CAST(occurred_at AS TIMESTAMP)
                  ORDER BY t.from_utc DESC LIMIT 1), 0) * INTERVAL 1 SECOND AS heard_at,
    json_extract_string(payload, '$.track_name')         AS track_name,
    json_extract_string(payload, '$.artist_name')        AS artist_name,
    json_extract_string(payload, '$.album_name')         AS album_name,
    CAST(json_extract(payload, '$.lastfm_uts') AS BIGINT) AS lastfm_uts,
    json_extract_string(payload, '$.mbid')               AS track_mbid,
    json_extract_string(payload, '$.source')             AS source,
    -- normalised keys used to match a capture back onto the owner's record
    lower(trim(json_extract_string(payload, '$.artist_name')))                                       AS artist_key,
    lower(trim(regexp_replace(regexp_replace(json_extract_string(payload, '$.track_name'),
                 '\s*[\(\[].*$', ''), '\s+-\s+.*$', '')))                                                AS track_key
FROM events
WHERE event_type = 'wild_play';

INSERT INTO connector_state (service, status) VALUES ('lastfm_wild', 'disconnected')
ON CONFLICT (service) DO NOTHING;

-- ------------------------------------------------------------
-- Phase 9b — artist popularity (Last.fm listener counts) → obscurity score.
--
-- `artist_popularity` holds the latest snapshot per artist; `artist_popularity_history`
-- is appended on every enrichment pass and never overwritten, so "you found them at
-- 5,000 listeners, they're at 2,000,000 now" becomes answerable once enough snapshots
-- have accumulated. The score is an inverse log of the listener count on a FIXED
-- reference (10^7 listeners → 0, a single listener → 1) so it is stable over time and
-- comparable across records; it deliberately does not renormalise to this library's max.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artist_popularity (
    artist_id   VARCHAR PRIMARY KEY,
    listeners   BIGINT,
    playcount   BIGINT,
    source      VARCHAR DEFAULT 'lastfm',
    fetched_at  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS artist_popularity_history (
    artist_id    VARCHAR,
    listeners    BIGINT,
    playcount    BIGINT,
    snapshot_at  TIMESTAMPTZ DEFAULT now()
);
CREATE OR REPLACE VIEW artist_obscurity AS
SELECT artist_id, listeners, playcount, fetched_at,
       GREATEST(0.0, LEAST(1.0, 1.0 - LOG10(COALESCE(listeners, 0) + 1) / 7.0)) AS obscurity
FROM artist_popularity;

-- ------------------------------------------------------------
-- Phase 9d — catalogue size per artist (MusicBrainz recording count) → catalogue penetration,
-- and multi-artist credits (MusicBrainz recording by ISRC) → Best Supporting Artist, feature credit.
-- Both additive; tracks.artist_id stays the single load-bearing attribution.
-- ------------------------------------------------------------
ALTER TABLE artists ADD COLUMN IF NOT EXISTS catalogue_tracks INTEGER;      -- MusicBrainz recording-count (a proxy: includes live/remix recordings)
ALTER TABLE artists ADD COLUMN IF NOT EXISTS catalogue_fetched_at TIMESTAMPTZ;
CREATE TABLE IF NOT EXISTS track_credits (
    track_id      VARCHAR,
    artist_id     VARCHAR,       -- resolved to a known artist_id where the name matches, else NULL
    artist_name   VARCHAR,       -- as MusicBrainz credits it
    artist_mbid   VARCHAR,
    credit_order  INTEGER,       -- 0 = primary
    source        VARCHAR DEFAULT 'musicbrainz',
    fetched_at    TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (track_id, credit_order)
);

-- Phase 9e — the owner's own filing decisions for The Crate / Scenes: which scene family an artist belongs to.
-- Applied at the end of compute_insights.sql (overrides win over tag-derived scenes) and immediately by set_artist_scene.
CREATE TABLE IF NOT EXISTS scene_overrides (
    artist_id  VARCHAR PRIMARY KEY,
    scene      VARCHAR,           -- NULL = "unsorted", explicitly
    decided_at TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Phase 9f — scenes become data. The fixed 18-family vocabulary that lived inside
-- compute_insights.sql is now three tables the owner can extend from Settings → Tuning → Scenes:
--   scene_families   the sections / scenes themselves (label, kind: region | style)
--   scene_tag_map    Last.fm / MusicBrainz tag → family
--   scene_origin_map MusicBrainz origin country → family (used when an artist has no mapped tag)
-- Built-ins are seeded with ON CONFLICT DO NOTHING on every open, so upgrades add new built-ins
-- without touching anything the owner added or re-pointed (builtin = FALSE rows are theirs).
-- compute_scenes.sql reads these tables; nothing else hardcodes a scene name any more.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS scene_families (
    scene      VARCHAR PRIMARY KEY,   -- stable key, lowercase, hyphenated ('west-african')
    label      VARCHAR,               -- what the UI shows ('West African')
    kind       VARCHAR,               -- 'region' | 'style'
    blurb      VARCHAR,
    builtin    BOOLEAN DEFAULT TRUE,
    hidden     BOOLEAN DEFAULT FALSE, -- owner switched it off; tags mapped here fall through to nothing
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS scene_tag_map (
    tag        VARCHAR PRIMARY KEY,   -- lowercase tag exactly as artist_tags carries it
    scene      VARCHAR,
    builtin    BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS scene_origin_map (
    country    VARCHAR PRIMARY KEY,   -- ISO-3166 alpha-2 as artist_origin.country carries it
    scene      VARCHAR,
    builtin    BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMPTZ DEFAULT now()
);

INSERT INTO scene_families (scene, label, kind, blurb) VALUES
 -- the original 18 (keys unchanged so scene_overrides written in 9e still resolve)
 ('afro', 'Afro (general)', 'region', 'African music without a finer regional tag.'),
 ('turkish', 'Turkish', 'region', 'Anatolian rock, arabesk, Turkish psych, pop and folk.'),
 ('japanese', 'Japanese', 'region', 'J-pop, city pop, Shibuya-kei, enka, J-rock.'),
 ('post-punk', 'Post-punk', 'style', 'Post-punk, new wave, cold/darkwave, gothic rock, synth-pop.'),
 ('dream', 'Dream pop / shoegaze', 'style', NULL),
 ('psych', 'Psych', 'style', 'Psychedelic and garage rock, neo-psych, kraut, space rock.'),
 ('hip-hop', 'Hip-hop', 'style', NULL),
 ('jazz', 'Jazz', 'style', NULL),
 ('funk-soul', 'Funk & soul', 'style', 'Funk, soul, disco, boogie.'),
 ('electronic', 'Electronic', 'style', 'House, techno, IDM, electro, downtempo.'),
 ('indie', 'Indie', 'style', NULL),
 ('folk', 'Folk & country', 'style', NULL),
 ('metal', 'Metal', 'style', NULL),
 ('caribbean', 'Caribbean', 'region', 'Reggae, dub, ska, dancehall, soca, calypso.'),
 ('latin', 'Latin American', 'region', 'Cumbia, salsa, boleros, reggaeton, Andean.'),
 ('classical', 'Classical & score', 'style', NULL),
 ('punk', 'Punk & hardcore', 'style', NULL),
 ('classic-rock', 'Classic rock', 'style', 'Classic, hard, blues and progressive rock.'),
 -- new regions
 ('west-african', 'West African', 'region', 'Afrobeat, highlife, mbalax, fuji, jùjú, Malian and Senegalese music.'),
 ('east-african', 'East African', 'region', 'Ethio-jazz, benga, taarab, Sudanese and Somali pop.'),
 ('southern-african', 'Southern African', 'region', 'Zamrock, chimurenga, mbaqanga, kwaito, amapiano, gqom.'),
 ('north-african', 'North African & Maghreb', 'region', 'Raï, chaabi, gnawa, Moroccan and Egyptian music.'),
 ('arabic', 'Arabic & Levantine', 'region', 'Arabic pop and classical, Lebanese, Iraqi, Gulf.'),
 ('persian', 'Persian & Central Asian', 'region', NULL),
 ('south-asian', 'South Asian', 'region', 'Filmi, Hindustani and Carnatic, qawwali, bhangra, Sri Lankan and Bangladeshi music.'),
 ('korean', 'Korean', 'region', 'K-pop, K-indie, K-hip-hop, trot.'),
 ('chinese', 'Chinese & Taiwanese', 'region', 'C-pop, Mandopop, Cantopop, Taiwanese indie.'),
 ('southeast-asian', 'Southeast Asian', 'region', 'Thai molam and luk thung, Indonesian dangdut and pop, Vietnamese, Filipino, Khmer.'),
 ('greek', 'Greek', 'region', 'Rebetiko, laika, entekhno.'),
 ('balkan', 'Balkan & Eastern European', 'region', 'Balkan brass, Romani, klezmer, Yugoslav rock, Polish and Hungarian pop.'),
 ('russian', 'Russian & post-Soviet', 'region', NULL),
 ('french', 'French', 'region', 'Chanson, yé-yé, French pop and touch.'),
 ('italian', 'Italian', 'region', 'Cantautori, Italo disco, Italian library music.'),
 ('german', 'German', 'region', 'NDW, Schlager, German pop and hip-hop.'),
 ('iberian', 'Spanish & Portuguese', 'region', 'Flamenco, fado, Spanish and Portuguese pop and rock.'),
 ('nordic', 'Nordic', 'region', 'Scandinavian and Finnish pop, folk and rock.'),
 ('celtic', 'Celtic & British Isles folk', 'region', NULL),
 ('brazilian', 'Brazilian', 'region', 'MPB, tropicália, samba, bossa nova, forró, baile funk.'),
 ('oceanian', 'Australian & Pacific', 'region', NULL),
 -- new styles (niche families that were previously swallowed by broader ones)
 ('ambient', 'Ambient & drone', 'style', 'Ambient, drone, kankyō ongaku, new age, dark ambient.'),
 ('experimental', 'Experimental & noise', 'style', 'Noise, avant-garde, musique concrète, free improvisation.'),
 ('post-rock', 'Post-rock & math rock', 'style', NULL),
 ('emo', 'Emo & post-hardcore', 'style', 'Midwest emo, screamo, post-hardcore.'),
 ('extreme-metal', 'Extreme metal', 'style', 'Black, death, doom, sludge, grind.'),
 ('industrial', 'Industrial & EBM', 'style', 'Industrial, EBM, minimal wave, power electronics.'),
 ('synth', 'Synthwave & vapor', 'style', 'Synthwave, vaporwave, chillwave, retrowave.'),
 ('bass', 'UK bass & breakbeat', 'style', 'Jungle, drum and bass, dubstep, UK garage, grime, footwork.'),
 ('trap', 'Trap & modern rap', 'style', 'Trap, drill, cloud rap, emo rap, plugg.'),
 ('rnb', 'R&B', 'style', 'Contemporary and alternative R&B, quiet storm.'),
 ('gospel-blues', 'Gospel & blues', 'style', NULL),
 ('country', 'Country', 'style', 'Outlaw, honky-tonk, bluegrass, old-time, alt-country.'),
 ('americana-folk', 'Freak & psych folk', 'style', 'Freak folk, psych folk, anti-folk, folk baroque.'),
 ('surf-rockabilly', 'Surf & rockabilly', 'style', NULL),
 ('britpop', 'Britpop & jangle', 'style', 'Britpop, Madchester, C86, jangle pop.'),
 ('sophisti', 'Sophisti-pop & yacht rock', 'style', 'Sophisti-pop, yacht rock, blue-eyed soul, AOR.'),
 ('chamber-pop', 'Chamber & baroque pop', 'style', NULL),
 ('library', 'Library, lounge & exotica', 'style', 'Library music, exotica, space-age pop, easy listening.'),
 ('free-jazz', 'Free & spiritual jazz', 'style', NULL),
 ('minimal', 'Minimalism & modern classical', 'style', NULL),
 ('early-music', 'Early music & opera', 'style', 'Medieval, Renaissance, baroque vocal, opera.'),
 ('stage-screen', 'Stage, screen & games', 'style', 'Musicals, anime, video-game music, vocaloid.'),
 ('hyperpop', 'Hyperpop & PC music', 'style', NULL),
 ('disco-boogie', 'Disco, boogie & Italo', 'style', 'Disco, boogie, Italo, cosmic, Balearic, nu-disco.'),
 ('dub-techno', 'Deep & dub techno', 'style', 'Dub techno, deep house, minimal techno.'),
 ('reggaeton', 'Reggaetón & Latin urban', 'style', NULL),
 ('cumbia-tropical', 'Cumbia & tropical', 'style', 'Cumbia, chicha, tropical bass, digital cumbia.')
ON CONFLICT DO NOTHING;

INSERT INTO scene_tag_map (tag, scene) VALUES
 -- afro (general) — only umbrella tags; specifics go to the regions
 ('african','afro'),('afro','afro'),('afropop','afro'),('afro pop','afro'),('afro-pop','afro'),('afrobeats','afro'),('world','afro'),
 -- west african
 ('afrobeat','west-african'),('afro-funk','west-african'),('afrofunk','west-african'),('highlife','west-african'),('nigerian','west-african'),('ghanaian','west-african'),('desert blues','west-african'),('tuareg','west-african'),('mbalax','west-african'),('senegalese','west-african'),('malian','west-african'),('mali','west-african'),('fuji','west-african'),('juju','west-african'),('jùjú','west-african'),('apala','west-african'),('wassoulou','west-african'),('mandingue','west-african'),('ivorian','west-african'),('coupé-décalé','west-african'),('beninese','west-african'),('guinean','west-african'),('burkinabe','west-african'),('cape verdean','west-african'),('cabo verde','west-african'),('morna','west-african'),('funaná','west-african'),('cameroonian','west-african'),('makossa','west-african'),('bikutsi','west-african'),
 -- east african
 ('ethio-jazz','east-african'),('ethiopian','east-african'),('ethiopia','east-african'),('eritrean','east-african'),('benga','east-african'),('kenyan','east-african'),('taarab','east-african'),('tanzanian','east-african'),('bongo flava','east-african'),('sudanese','east-african'),('somali','east-african'),('ugandan','east-african'),('rwandan','east-african'),
 -- southern african
 ('zamrock','southern-african'),('zambian','southern-african'),('zimbabwean','southern-african'),('chimurenga','southern-african'),('south african','southern-african'),('mbaqanga','southern-african'),('kwaito','southern-african'),('amapiano','southern-african'),('gqom','southern-african'),('kwela','southern-african'),('marabi','southern-african'),('maskandi','southern-african'),('mozambican','southern-african'),('marrabenta','southern-african'),('angolan','southern-african'),('kizomba','southern-african'),('semba','southern-african'),('kuduro','southern-african'),('malagasy','southern-african'),('congolese','southern-african'),('soukous','southern-african'),('rumba congolaise','southern-african'),('ndombolo','southern-african'),
 -- north african & maghreb
 ('rai','north-african'),('raï','north-african'),('chaabi','north-african'),('gnawa','north-african'),('moroccan','north-african'),('algerian','north-african'),('tunisian','north-african'),('egyptian','north-african'),('libyan','north-african'),('maghreb','north-african'),('shaabi','north-african'),('mahraganat','north-african'),
 -- arabic & levantine
 ('arabic','arabic'),('arab','arabic'),('arabic pop','arabic'),('lebanese','arabic'),('syrian','arabic'),('iraqi','arabic'),('palestinian','arabic'),('jordanian','arabic'),('khaliji','arabic'),('gulf','arabic'),('dabke','arabic'),('oud','arabic'),('maqam','arabic'),('yemeni','arabic'),('saudi','arabic'),('emirati','arabic'),
 -- persian & central asian
 ('persian','persian'),('iranian','persian'),('iran','persian'),('persian pop','persian'),('persian classical','persian'),('afghan','persian'),('tajik','persian'),('uzbek','persian'),('kazakh','persian'),('kyrgyz','persian'),('azerbaijani','persian'),('mugham','persian'),('armenian','persian'),('georgian','persian'),('kurdish','persian'),
 -- south asian
 ('indian','south-asian'),('india','south-asian'),('bollywood','south-asian'),('filmi','south-asian'),('hindustani','south-asian'),('hindustani classical','south-asian'),('carnatic','south-asian'),('indian classical','south-asian'),('bhangra','south-asian'),('punjabi','south-asian'),('qawwali','south-asian'),('pakistani','south-asian'),('ghazal','south-asian'),('sufi','south-asian'),('tamil','south-asian'),('telugu','south-asian'),('malayalam','south-asian'),('kannada','south-asian'),('bengali','south-asian'),('bangladeshi','south-asian'),('sri lankan','south-asian'),('nepali','south-asian'),('sitar','south-asian'),('desi','south-asian'),('indian pop','south-asian'),('indie india','south-asian'),
 -- korean
 ('korean','korean'),('k-pop','korean'),('kpop','korean'),('k-indie','korean'),('k-rock','korean'),('k-hip hop','korean'),('k-hip-hop','korean'),('khiphop','korean'),('k-r&b','korean'),('trot','korean'),('korean indie','korean'),('korean ballad','korean'),
 -- chinese & taiwanese
 ('chinese','chinese'),('c-pop','chinese'),('cpop','chinese'),('mandopop','chinese'),('cantopop','chinese'),('taiwanese','chinese'),('hong kong','chinese'),('mandarin','chinese'),('cantonese','chinese'),('chinese indie','chinese'),('chinese rock','chinese'),('tibetan','chinese'),('mongolian','chinese'),
 -- southeast asian
 ('thai','southeast-asian'),('molam','southeast-asian'),('mor lam','southeast-asian'),('luk thung','southeast-asian'),('luk krung','southeast-asian'),('thai funk','southeast-asian'),('indonesian','southeast-asian'),('dangdut','southeast-asian'),('gamelan','southeast-asian'),('indonesian pop','southeast-asian'),('malaysian','southeast-asian'),('vietnamese','southeast-asian'),('v-pop','southeast-asian'),('filipino','southeast-asian'),('opm','southeast-asian'),('pinoy','southeast-asian'),('p-pop','southeast-asian'),('khmer','southeast-asian'),('cambodian','southeast-asian'),('burmese','southeast-asian'),('lao','southeast-asian'),('singaporean','southeast-asian'),
 -- turkish
 ('turkish','turkish'),('anatolian rock','turkish'),('anadolu rock','turkish'),('turkish psychedelic','turkish'),('turkish psych','turkish'),('arabesk','turkish'),('turkish pop','turkish'),('turkish folk','turkish'),('turkish jazz','turkish'),('turkish hip hop','turkish'),('türkçe','turkish'),('türkçe pop','turkish'),('türkçe rap','turkish'),('turkish rap','turkish'),('turkish rock','turkish'),('ottoman','turkish'),('fasıl','turkish'),
 -- japanese
 ('japanese','japanese'),('j-pop','japanese'),('jpop','japanese'),('city pop','japanese'),('shamisen','japanese'),('enka','japanese'),('shibuya-kei','japanese'),('shibuya kei','japanese'),('j-rock','japanese'),('jrock','japanese'),('kayokyoku','japanese'),('kayōkyoku','japanese'),('japanese jazz','japanese'),('j-jazz','japanese'),('japanese indie','japanese'),('japanese hip hop','japanese'),('j-hip hop','japanese'),('visual kei','japanese'),('japanese ambient','japanese'),('kankyo ongaku','japanese'),('kankyō ongaku','japanese'),('japanese folk','japanese'),('group sounds','japanese'),('japanese psychedelic','japanese'),('japanese electronic','japanese'),('japanoise','japanese'),('idol','japanese'),('japanese classical','japanese'),
 -- greek
 ('greek','greek'),('rebetiko','greek'),('laika','greek'),('laïka','greek'),('entekhno','greek'),('greek folk','greek'),('greek pop','greek'),('greek rock','greek'),('cypriot','greek'),
 -- balkan & eastern european
 ('balkan','balkan'),('balkan brass','balkan'),('romani','balkan'),('gypsy','balkan'),('klezmer','balkan'),('yugoslav','balkan'),('ex-yu','balkan'),('serbian','balkan'),('croatian','balkan'),('bosnian','balkan'),('slovenian','balkan'),('macedonian','balkan'),('bulgarian','balkan'),('romanian','balkan'),('manele','balkan'),('albanian','balkan'),('hungarian','balkan'),('polish','balkan'),('czech','balkan'),('slovak','balkan'),('ukrainian','balkan'),('moldovan','balkan'),('sevdah','balkan'),('turbo folk','balkan'),
 -- russian & post-soviet
 ('russian','russian'),('russian rock','russian'),('russian pop','russian'),('soviet','russian'),('russian folk','russian'),('russian hip hop','russian'),('belarusian','russian'),('bard','russian'),('estrada','russian'),('baltic','russian'),('lithuanian','russian'),('latvian','russian'),('estonian','russian'),
 -- french
 ('french','french'),('chanson','french'),('chanson française','french'),('french pop','french'),('yé-yé','french'),('ye-ye','french'),('yeye','french'),('french touch','french'),('french house','french'),('french rap','french'),('french hip hop','french'),('variété française','french'),('belgian','french'),('quebec','french'),('québécois','french'),('swiss','french'),('francophone','french'),
 -- italian
 ('italian','italian'),('cantautori','italian'),('cantautore','italian'),('italo disco','disco-boogie'),('italian pop','italian'),('italian rock','italian'),('italian prog','italian'),('italian library','library'),('italian hip hop','italian'),('canzone napoletana','italian'),('neapolitan','italian'),('sardinian','italian'),
 -- german
 ('german','german'),('neue deutsche welle','german'),('ndw','german'),('schlager','german'),('deutschrap','german'),('german hip hop','german'),('german pop','german'),('deutschpop','german'),('austrian','german'),('hamburger schule','german'),('krautrock','psych'),
 -- iberian
 ('spanish','iberian'),('flamenco','iberian'),('spanish pop','iberian'),('spanish rock','iberian'),('spanish indie','iberian'),('rumba catalana','iberian'),('catalan','iberian'),('basque','iberian'),('galician','iberian'),('portuguese','iberian'),('fado','iberian'),('portuguese pop','iberian'),('portuguese rock','iberian'),('copla','iberian'),('movida','iberian'),
 -- nordic
 ('swedish','nordic'),('swedish pop','nordic'),('swedish indie','nordic'),('norwegian','nordic'),('danish','nordic'),('finnish','nordic'),('icelandic','nordic'),('scandinavian','nordic'),('nordic','nordic'),('nordic folk','nordic'),('sami','nordic'),('faroese','nordic'),
 -- celtic & british isles folk
 ('celtic','celtic'),('irish','celtic'),('irish folk','celtic'),('scottish','celtic'),('scottish folk','celtic'),('welsh','celtic'),('breton','celtic'),('british folk','celtic'),('english folk','celtic'),('folk rock','celtic'),('sea shanty','celtic'),('trad','celtic'),
 -- brazilian (split from latin)
 ('brazilian','brazilian'),('brazil','brazilian'),('mpb','brazilian'),('bossa nova','brazilian'),('samba','brazilian'),('tropicalia','brazilian'),('tropicália','brazilian'),('forró','brazilian'),('forro','brazilian'),('baile funk','brazilian'),('funk carioca','brazilian'),('brazilian jazz','brazilian'),('brazilian psychedelic','brazilian'),('brazilian rock','brazilian'),('brazilian indie','brazilian'),('sertanejo','brazilian'),('axé','brazilian'),('pagode','brazilian'),('choro','brazilian'),('samba rock','brazilian'),('samba soul','brazilian'),('brazilian pop','brazilian'),('brazilian hip hop','brazilian'),('bahia','brazilian'),
 -- latin american
 ('latin','latin'),('latin america','latin'),('latin pop','latin'),('latin rock','latin'),('latin alternative','latin'),('latin jazz','latin'),('salsa','latin'),('bolero','latin'),('boleros','latin'),('mariachi','latin'),('ranchera','latin'),('norteño','latin'),('norteno','latin'),('tejano','latin'),('tex-mex','latin'),('banda','latin'),('corridos','latin'),('corridos tumbados','latin'),('mexican','latin'),('mexico','latin'),('argentine','latin'),('argentina','latin'),('tango','latin'),('rock nacional','latin'),('rock en español','latin'),('rock en espanol','latin'),('chilean','latin'),('nueva canción','latin'),('nueva cancion','latin'),('andean','latin'),('peruvian','latin'),('colombian','latin'),('vallenato','latin'),('champeta','latin'),('venezuelan','latin'),('cuban','latin'),('son cubano','latin'),('timba','latin'),('afro-cuban','latin'),('afro cuban','latin'),('rumba','latin'),('merengue','latin'),('bachata','latin'),('dominican','latin'),('puerto rican','latin'),('uruguayan','latin'),('candombe','latin'),('bolivian','latin'),('ecuadorian','latin'),('boogaloo','latin'),('latin soul','latin'),
 ('cumbia','cumbia-tropical'),('chicha','cumbia-tropical'),('cumbia peruana','cumbia-tropical'),('tropical','cumbia-tropical'),('tropical bass','cumbia-tropical'),('digital cumbia','cumbia-tropical'),('nu cumbia','cumbia-tropical'),('cumbia villera','cumbia-tropical'),
 ('reggaeton','reggaeton'),('reggaetón','reggaeton'),('latin urban','reggaeton'),('urbano','reggaeton'),('urbano latino','reggaeton'),('latin trap','reggaeton'),('dembow','reggaeton'),('perreo','reggaeton'),('neoperreo','reggaeton'),
 -- caribbean
 ('reggae','caribbean'),('dub','caribbean'),('ska','caribbean'),('rocksteady','caribbean'),('calypso','caribbean'),('dancehall','caribbean'),('soca','caribbean'),('jamaican','caribbean'),('roots reggae','caribbean'),('lovers rock','caribbean'),('mento','caribbean'),('trinidadian','caribbean'),('haitian','caribbean'),('kompa','caribbean'),('compas','caribbean'),('zouk','caribbean'),('rapso','caribbean'),('caribbean','caribbean'),('reggae fusion','caribbean'),('ragga','caribbean'),('bahamian','caribbean'),('junkanoo','caribbean'),
 -- oceanian
 ('australian','oceanian'),('aussie','oceanian'),('australian indie','oceanian'),('australian hip hop','oceanian'),('new zealand','oceanian'),('kiwi','oceanian'),('dunedin sound','oceanian'),('maori','oceanian'),('māori','oceanian'),('hawaiian','oceanian'),('polynesian','oceanian'),('pacific','oceanian'),('papuan','oceanian'),('fijian','oceanian'),
 -- post-punk
 ('post-punk','post-punk'),('post punk','post-punk'),('new wave','post-punk'),('coldwave','post-punk'),('cold wave','post-punk'),('darkwave','post-punk'),('dark wave','post-punk'),('synth-pop','post-punk'),('synthpop','post-punk'),('synth pop','post-punk'),('gothic rock','post-punk'),('goth rock','post-punk'),('goth','post-punk'),('no wave','post-punk'),('post-punk revival','post-punk'),('minimal synth','post-punk'),('art punk','post-punk'),('dance-punk','post-punk'),('ethereal wave','post-punk'),('deathrock','post-punk'),
 -- dream pop / shoegaze
 ('shoegaze','dream'),('dream pop','dream'),('ethereal','dream'),('slowcore','dream'),('sadcore','dream'),('nu gaze','dream'),('nugaze','dream'),('noise pop','dream'),
 -- psych
 ('psychedelic','psych'),('psychedelic rock','psych'),('neo-psychedelia','psych'),('neo-psychedelic','psych'),('neo psychedelia','psych'),('space rock','psych'),('garage rock','psych'),('garage psych','psych'),('psych rock','psych'),('acid rock','psych'),('kosmische','psych'),('kosmische musik','psych'),('freakbeat','psych'),('psychedelic pop','psych'),('stoner rock','psych'),('desert rock','psych'),('heavy psych','psych'),('psychedelic soul','psych'),('psych pop','psych'),('paisley underground','psych'),
 -- hip-hop
 ('hip-hop','hip-hop'),('hip hop','hip-hop'),('hiphop','hip-hop'),('rap','hip-hop'),('trip-hop','hip-hop'),('trip hop','hip-hop'),('instrumental hip-hop','hip-hop'),('instrumental hip hop','hip-hop'),('boom bap','hip-hop'),('abstract hip-hop','hip-hop'),('abstract hip hop','hip-hop'),('underground hip-hop','hip-hop'),('underground hip hop','hip-hop'),('conscious hip hop','hip-hop'),('east coast hip hop','hip-hop'),('west coast hip hop','hip-hop'),('southern hip hop','hip-hop'),('g-funk','hip-hop'),('golden age hip hop','hip-hop'),('jazz rap','hip-hop'),('alternative hip hop','hip-hop'),('alternative rap','hip-hop'),('lo-fi hip hop','hip-hop'),('lofi hip hop','hip-hop'),('turntablism','hip-hop'),('grime','bass'),
 ('trap','trap'),('drill','trap'),('uk drill','trap'),('cloud rap','trap'),('emo rap','trap'),('plugg','trap'),('rage','trap'),('phonk','trap'),('mumble rap','trap'),('melodic rap','trap'),('memphis rap','trap'),('sad rap','trap'),
 -- jazz
 ('jazz','jazz'),('jazz fusion','jazz'),('fusion','jazz'),('bebop','jazz'),('hard bop','jazz'),('cool jazz','jazz'),('nu jazz','jazz'),('nu-jazz','jazz'),('modal jazz','jazz'),('post-bop','jazz'),('swing','jazz'),('big band','jazz'),('vocal jazz','jazz'),('jazz funk','jazz'),('jazz-funk','jazz'),('smooth jazz','jazz'),('acid jazz','jazz'),('contemporary jazz','jazz'),('ecm','jazz'),('jazz vocal','jazz'),('bossa jazz','jazz'),('soul jazz','jazz'),('jazztronica','jazz'),('uk jazz','jazz'),('modern jazz','jazz'),
 ('spiritual jazz','free-jazz'),('free jazz','free-jazz'),('avant-garde jazz','free-jazz'),('avant garde jazz','free-jazz'),('fire music','free-jazz'),('free improvisation','free-jazz'),('loft jazz','free-jazz'),('creative music','free-jazz'),
 -- funk & soul
 ('funk','funk-soul'),('soul','funk-soul'),('neo-soul','funk-soul'),('neo soul','funk-soul'),('northern soul','funk-soul'),('deep soul','funk-soul'),('southern soul','funk-soul'),('motown','funk-soul'),('philly soul','funk-soul'),('psychedelic funk','funk-soul'),('p-funk','funk-soul'),('rare groove','funk-soul'),('soul funk','funk-soul'),('classic soul','funk-soul'),('60s soul','funk-soul'),('70s soul','funk-soul'),('funk rock','funk-soul'),('go-go','funk-soul'),('new orleans funk','funk-soul'),
 ('disco','disco-boogie'),('boogie','disco-boogie'),('nu disco','disco-boogie'),('nu-disco','disco-boogie'),('italo','disco-boogie'),('italo-disco','disco-boogie'),('cosmic disco','disco-boogie'),('cosmic','disco-boogie'),('balearic','disco-boogie'),('disco funk','disco-boogie'),('euro disco','disco-boogie'),('hi-nrg','disco-boogie'),('space disco','disco-boogie'),('post-disco','disco-boogie'),('electro-funk','disco-boogie'),('electrofunk','disco-boogie'),
 ('r&b','rnb'),('rnb','rnb'),('r and b','rnb'),('contemporary r&b','rnb'),('alternative r&b','rnb'),('alt r&b','rnb'),('quiet storm','rnb'),('new jack swing','rnb'),('pbr&b','rnb'),('90s r&b','rnb'),('slow jams','rnb'),
 ('gospel','gospel-blues'),('blues','gospel-blues'),('delta blues','gospel-blues'),('chicago blues','gospel-blues'),('electric blues','gospel-blues'),('country blues','gospel-blues'),('soul blues','gospel-blues'),('spirituals','gospel-blues'),('doo-wop','gospel-blues'),('doo wop','gospel-blues'),('zydeco','gospel-blues'),('cajun','gospel-blues'),('piedmont blues','gospel-blues'),('jump blues','gospel-blues'),('gospel soul','gospel-blues'),('southern gospel','gospel-blues'),
 -- electronic
 ('electronic','electronic'),('electronica','electronic'),('house','electronic'),('techno','electronic'),('idm','electronic'),('downtempo','electronic'),('electro','electronic'),('acid house','electronic'),('acid','electronic'),('chicago house','electronic'),('detroit techno','electronic'),('trance','electronic'),('progressive house','electronic'),('tech house','electronic'),('breaks','electronic'),('big beat','electronic'),('glitch','electronic'),('braindance','electronic'),('leftfield','electronic'),('electropop','electronic'),('electro pop','electronic'),('dance','electronic'),('edm','electronic'),('deep house','dub-techno'),('dub techno','dub-techno'),('minimal techno','dub-techno'),('minimal','dub-techno'),('microhouse','dub-techno'),('ambient techno','dub-techno'),('ambient house','dub-techno'),('lo-fi house','dub-techno'),('outsider house','dub-techno'),('deep techno','dub-techno'),
 ('jungle','bass'),('drum and bass','bass'),('drum n bass','bass'),('drum & bass','bass'),('dnb','bass'),('liquid funk','bass'),('dubstep','bass'),('uk garage','bass'),('ukg','bass'),('2-step','bass'),('2 step','bass'),('garage','bass'),('speed garage','bass'),('footwork','bass'),('juke','bass'),('uk bass','bass'),('bass music','bass'),('breakbeat','bass'),('hardcore breaks','bass'),('uk funky','bass'),('wonky','bass'),('future garage','bass'),('post-dubstep','bass'),('bassline','bass'),('grime instrumental','bass'),('baltimore club','bass'),('jersey club','bass'),('ghettotech','bass'),
 ('ambient','ambient'),('drone','ambient'),('dark ambient','ambient'),('new age','ambient'),('space ambient','ambient'),('ambient drone','ambient'),('environmental','ambient'),('fourth world','ambient'),('healing','ambient'),('meditation','ambient'),('lowercase','ambient'),('field recordings','ambient'),('field recording','ambient'),('isolationism','ambient'),
 ('synthwave','synth'),('retrowave','synth'),('outrun','synth'),('vaporwave','synth'),('chillwave','synth'),('darksynth','synth'),('dreamwave','synth'),('future funk','synth'),('mallsoft','synth'),('synthwave pop','synth'),('80s synth','synth'),
 ('hyperpop','hyperpop'),('pc music','hyperpop'),('bubblegum bass','hyperpop'),('glitchcore','hyperpop'),('digicore','hyperpop'),('nightcore','hyperpop'),('deconstructed club','hyperpop'),
 ('industrial','industrial'),('ebm','industrial'),('electronic body music','industrial'),('minimal wave','industrial'),('power electronics','industrial'),('industrial rock','industrial'),('aggrotech','industrial'),('futurepop','industrial'),('industrial techno','industrial'),('rhythmic noise','industrial'),('martial industrial','industrial'),('neofolk','industrial'),('death industrial','industrial'),('industrial metal','industrial'),
 ('noise','experimental'),('experimental','experimental'),('avant-garde','experimental'),('avant garde','experimental'),('musique concrète','experimental'),('musique concrete','experimental'),('noise rock','experimental'),('sound art','experimental'),('electroacoustic','experimental'),('free improv','experimental'),('improvisation','experimental'),('harsh noise','experimental'),('plunderphonics','experimental'),('sound collage','experimental'),('outsider','experimental'),('zeuhl','experimental'),('rock in opposition','experimental'),('rio','experimental'),('lowercase noise','experimental'),('glitch noise','experimental'),('japanoise','experimental'),
 -- indie
 ('indie rock','indie'),('indie pop','indie'),('indie folk','indie'),('indie','indie'),('lo-fi','indie'),('lo fi','indie'),('bedroom pop','indie'),('slacker rock','indie'),('alternative rock','indie'),('alternative','indie'),('college rock','indie'),('twee','indie'),('twee pop','indie'),('power pop','indie'),('art rock','indie'),('art pop','indie'),('garage pop','indie'),('surf pop','indie'),('grunge','indie'),('90s alternative','indie'),('alt rock','indie'),('indietronica','indie'),('folktronica','indie'),('anti-folk','americana-folk'),
 ('britpop','britpop'),('madchester','britpop'),('baggy','britpop'),('c86','britpop'),('jangle pop','britpop'),('jangle','britpop'),('british indie','britpop'),('uk indie','britpop'),('shambling','britpop'),('post-britpop','britpop'),('new rave','britpop'),
 ('sophisti-pop','sophisti'),('sophisti pop','sophisti'),('yacht rock','sophisti'),('blue-eyed soul','sophisti'),('aor','sophisti'),('soft rock','sophisti'),('adult contemporary','sophisti'),('westcoast','sophisti'),('west coast pop','sophisti'),('smooth pop','sophisti'),
 ('chamber pop','chamber-pop'),('baroque pop','chamber-pop'),('orchestral pop','chamber-pop'),('sunshine pop','chamber-pop'),('wall of sound','chamber-pop'),('symphonic pop','chamber-pop'),
 ('post-rock','post-rock'),('post rock','post-rock'),('math rock','post-rock'),('instrumental rock','post-rock'),('crescendocore','post-rock'),('slint','post-rock'),('midwest math','post-rock'),
 -- folk & country
 ('folk','folk'),('singer-songwriter','folk'),('singer songwriter','folk'),('americana','folk'),('acoustic','folk'),('contemporary folk','folk'),('folk pop','folk'),('chamber folk','folk'),('traditional folk','folk'),('folk revival','folk'),('protest','folk'),
 ('freak folk','americana-folk'),('psych folk','americana-folk'),('psychedelic folk','americana-folk'),('acid folk','americana-folk'),('folk baroque','americana-folk'),('new weird america','americana-folk'),('avant-folk','americana-folk'),('wyrd folk','americana-folk'),('progressive folk','americana-folk'),
 ('alt-country','country'),('alt country','country'),('country','country'),('bluegrass','country'),('outlaw country','country'),('honky tonk','country'),('honky-tonk','country'),('old-time','country'),('old time','country'),('country rock','country'),('cosmic country','country'),('western swing','country'),('classic country','country'),('countrypolitan','country'),('bakersfield sound','country'),('nashville sound','country'),('country soul','country'),('red dirt','country'),('newgrass','country'),('appalachian','country'),('texas country','country'),('country pop','country'),
 -- metal
 ('metal','metal'),('heavy metal','metal'),('thrash metal','metal'),('thrash','metal'),('power metal','metal'),('progressive metal','metal'),('prog metal','metal'),('nwobhm','metal'),('speed metal','metal'),('groove metal','metal'),('nu metal','metal'),('nu-metal','metal'),('alternative metal','metal'),('metalcore','metal'),('symphonic metal','metal'),('folk metal','metal'),('glam metal','metal'),('hair metal','metal'),('traditional metal','metal'),('djent','metal'),
 ('doom metal','extreme-metal'),('doom','extreme-metal'),('sludge','extreme-metal'),('sludge metal','extreme-metal'),('post-metal','extreme-metal'),('black metal','extreme-metal'),('death metal','extreme-metal'),('atmospheric black metal','extreme-metal'),('blackgaze','extreme-metal'),('grindcore','extreme-metal'),('drone metal','extreme-metal'),('funeral doom','extreme-metal'),('stoner metal','extreme-metal'),('technical death metal','extreme-metal'),('melodic death metal','extreme-metal'),('deathcore','extreme-metal'),('war metal','extreme-metal'),('crust','extreme-metal'),('crust punk','extreme-metal'),
 -- punk
 ('punk','punk'),('punk rock','punk'),('hardcore','punk'),('hardcore punk','punk'),('pop punk','punk'),('pop-punk','punk'),('oi','punk'),('street punk','punk'),('anarcho-punk','punk'),('anarcho punk','punk'),('garage punk','punk'),('proto-punk','punk'),('proto punk','punk'),('ska punk','punk'),('skate punk','punk'),('psychobilly','surf-rockabilly'),('riot grrrl','punk'),('queercore','punk'),('egg punk','punk'),('powerviolence','punk'),('d-beat','punk'),('nyhc','punk'),('straight edge','punk'),('youth crew','punk'),('melodic hardcore','punk'),('post-punk hardcore','punk'),('folk punk','punk'),('cowpunk','punk'),
 ('post-hardcore','emo'),('emo','emo'),('midwest emo','emo'),('screamo','emo'),('emoviolence','emo'),('skramz','emo'),('emo pop','emo'),('emocore','emo'),('math emo','emo'),('5th wave emo','emo'),('emo revival','emo'),('sasscore','emo'),
 -- classic rock
 ('classic rock','classic-rock'),('blues rock','classic-rock'),('hard rock','classic-rock'),('progressive rock','classic-rock'),('prog rock','classic-rock'),('prog','classic-rock'),('southern rock','classic-rock'),('rock','classic-rock'),('rock and roll','classic-rock'),('rock n roll','classic-rock'),('rock & roll','classic-rock'),('arena rock','classic-rock'),('glam rock','classic-rock'),('glam','classic-rock'),('pub rock','classic-rock'),('boogie rock','classic-rock'),('heartland rock','classic-rock'),('roots rock','classic-rock'),('jam band','classic-rock'),('jam','classic-rock'),('folk rock 60s','classic-rock'),('60s rock','classic-rock'),('70s rock','classic-rock'),('british invasion','classic-rock'),('merseybeat','classic-rock'),('canterbury scene','classic-rock'),('canterbury','classic-rock'),('symphonic prog','classic-rock'),('space prog','classic-rock'),
 ('surf','surf-rockabilly'),('surf rock','surf-rockabilly'),('rockabilly','surf-rockabilly'),('instrumental surf','surf-rockabilly'),('garage surf','surf-rockabilly'),('hot rod','surf-rockabilly'),('exotica surf','surf-rockabilly'),('twang','surf-rockabilly'),('girl group','surf-rockabilly'),('girl groups','surf-rockabilly'),('teen pop 60s','surf-rockabilly'),('northern soul surf','surf-rockabilly'),
 -- classical & score
 ('classical','classical'),('baroque','classical'),('contemporary classical','classical'),('piano','classical'),('soundtrack','classical'),('film score','classical'),('film soundtrack','classical'),('score','classical'),('orchestral','classical'),('romantic','classical'),('chamber music','classical'),('string quartet','classical'),('symphony','classical'),('20th century classical','classical'),('impressionism','classical'),('neoclassical','classical'),('cinematic','classical'),('composer','classical'),
 ('minimalism','minimal'),('minimal classical','minimal'),('modern classical','minimal'),('post-minimalism','minimal'),('holy minimalism','minimal'),('process music','minimal'),('tape music','minimal'),('neoclassical darkwave','minimal'),('piano ambient','minimal'),('contemporary piano','minimal'),
 ('early music','early-music'),('medieval','early-music'),('renaissance','early-music'),('opera','early-music'),('gregorian chant','early-music'),('plainchant','early-music'),('choral','early-music'),('sacred music','early-music'),('lute','early-music'),('harpsichord','early-music'),('baroque opera','early-music'),('lieder','early-music'),('art song','early-music'),
 ('musicals','stage-screen'),('musical','stage-screen'),('broadway','stage-screen'),('show tunes','stage-screen'),('anime','stage-screen'),('video game music','stage-screen'),('vgm','stage-screen'),('game soundtrack','stage-screen'),('chiptune','stage-screen'),('vocaloid','stage-screen'),('disney','stage-screen'),('cartoon','stage-screen'),('tv theme','stage-screen'),
 ('library music','library'),('library','library'),('lounge','library'),('exotica','library'),('space age pop','library'),('space-age pop','library'),('easy listening','library'),('mood music','library'),('elevator','library'),('production music','library'),('bachelor pad','library'),('cocktail','library'),('tiki','library'),('muzak','library'),('lounge exotica','library'),('kpm','library'),('beat library','library'),('groovy library','library')
ON CONFLICT DO NOTHING;

INSERT INTO scene_origin_map (country, scene) VALUES
 ('TR','turkish'),('JP','japanese'),('KR','korean'),('KP','korean'),('CN','chinese'),('TW','chinese'),('HK','chinese'),('MO','chinese'),('MN','chinese'),
 ('TH','southeast-asian'),('ID','southeast-asian'),('MY','southeast-asian'),('VN','southeast-asian'),('PH','southeast-asian'),('KH','southeast-asian'),('LA','southeast-asian'),('MM','southeast-asian'),('SG','southeast-asian'),
 ('IN','south-asian'),('PK','south-asian'),('BD','south-asian'),('LK','south-asian'),('NP','south-asian'),('BT','south-asian'),('MV','south-asian'),
 ('IR','persian'),('AF','persian'),('TJ','persian'),('UZ','persian'),('KZ','persian'),('KG','persian'),('TM','persian'),('AZ','persian'),('AM','persian'),('GE','persian'),
 ('SA','arabic'),('AE','arabic'),('QA','arabic'),('KW','arabic'),('BH','arabic'),('OM','arabic'),('YE','arabic'),('IQ','arabic'),('SY','arabic'),('LB','arabic'),('JO','arabic'),('PS','arabic'),
 ('EG','north-african'),('MA','north-african'),('DZ','north-african'),('TN','north-african'),('LY','north-african'),('MR','north-african'),('SD','north-african'),
 ('NG','west-african'),('GH','west-african'),('ML','west-african'),('SN','west-african'),('GN','west-african'),('GW','west-african'),('CI','west-african'),('BF','west-african'),('BJ','west-african'),('TG','west-african'),('NE','west-african'),('CM','west-african'),('CV','west-african'),('SL','west-african'),('LR','west-african'),('GM','west-african'),('TD','west-african'),('GA','west-african'),('CG','southern-african'),('CD','southern-african'),
 ('ET','east-african'),('ER','east-african'),('KE','east-african'),('TZ','east-african'),('UG','east-african'),('RW','east-african'),('BI','east-african'),('SO','east-african'),('DJ','east-african'),('SS','east-african'),
 ('ZM','southern-african'),('ZW','southern-african'),('ZA','southern-african'),('MZ','southern-african'),('AO','southern-african'),('NA','southern-african'),('BW','southern-african'),('MW','southern-african'),('LS','southern-african'),('SZ','southern-african'),('MG','southern-african'),('MU','southern-african'),
 ('BR','brazilian'),('JM','caribbean'),('TT','caribbean'),('BB','caribbean'),('HT','caribbean'),('BS','caribbean'),('GD','caribbean'),('LC','caribbean'),('VC','caribbean'),('AG','caribbean'),('DM','caribbean'),('KN','caribbean'),('BZ','caribbean'),('GY','caribbean'),('SR','caribbean'),('MQ','caribbean'),('GP','caribbean'),('CW','caribbean'),('AW','caribbean'),
 ('MX','latin'),('AR','latin'),('CL','latin'),('CO','latin'),('PE','latin'),('VE','latin'),('CU','latin'),('DO','latin'),('PR','latin'),('UY','latin'),('BO','latin'),('EC','latin'),('PY','latin'),('GT','latin'),('HN','latin'),('SV','latin'),('NI','latin'),('CR','latin'),('PA','latin'),
 ('GR','greek'),('CY','greek'),('RS','balkan'),('HR','balkan'),('BA','balkan'),('SI','balkan'),('MK','balkan'),('ME','balkan'),('BG','balkan'),('RO','balkan'),('AL','balkan'),('XK','balkan'),('HU','balkan'),('PL','balkan'),('CZ','balkan'),('SK','balkan'),('UA','balkan'),('MD','balkan'),
 ('RU','russian'),('BY','russian'),('LT','russian'),('LV','russian'),('EE','russian'),
 ('FR','french'),('BE','french'),('IT','italian'),('DE','german'),('AT','german'),('CH','german'),('ES','iberian'),('PT','iberian'),
 ('SE','nordic'),('NO','nordic'),('DK','nordic'),('FI','nordic'),('IS','nordic'),('FO','nordic'),('IE','celtic'),
 ('AU','oceanian'),('NZ','oceanian'),('PG','oceanian'),('FJ','oceanian'),('WS','oceanian'),('TO','oceanian'),('NC','oceanian'),('PF','oceanian')
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- Phase 9f — lyric features v2. Keywords become distinctive (TF-IDF over your own lyric corpus
-- instead of raw frequency), themes are scored rather than triggered by a single word, and a
-- handful of structural features join them. The text itself is still never stored.
-- ------------------------------------------------------------
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS features_rev INTEGER DEFAULT 1;   -- 1 = 9e rules, 2 = 9f rules; rows below the current rev are re-fetched and re-featurised
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS theme_scores JSON;                -- {"night": 0.42, "heartbreak": 0.31, ...} — every theme that scored, not just the winners
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS valence DOUBLE;                   -- −1 (bleak) … +1 (bright), from a small sentiment lexicon
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS repetition DOUBLE;                -- 1 − distinct/total: 0 = every line new, 0.9 = a chant
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS vocab INTEGER;                    -- distinct content words
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS llm_themes VARCHAR[];             -- optional: themes named by the local model (Ollama), from the transient text
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS llm_mood VARCHAR;                 -- optional: one-phrase mood from the local model
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS llm_model VARCHAR;
ALTER TABLE track_lyric_features ADD COLUMN IF NOT EXISTS llm_at TIMESTAMPTZ;

-- per-track term frequencies (top 60 content words). Keywords are derived from these against the
-- whole corpus, so a word that is in every song ("love") stops counting as a keyword for any of them.
CREATE TABLE IF NOT EXISTS track_lyric_terms (
    track_id  VARCHAR,
    term      VARCHAR,
    tf        INTEGER,       -- occurrences in this song
    PRIMARY KEY (track_id, term)
);

-- TF-IDF keywords: tf × ln(N / df), top 15 per track.
-- Phase 9h: N and df are counted *within each song's language*. Across the whole corpus a Turkish or Russian word
-- is rare simply because few songs are in that language, so it out-scored every English word (owner: "the largest
-- words are foreign"). Per-language IDF compares a word only with songs it could have appeared in.
CREATE OR REPLACE VIEW track_lyric_keywords AS
WITH f AS (SELECT track_id, COALESCE(NULLIF(lang, ''), 'und') AS lang FROM track_lyric_features WHERE found AND COALESCE(features_rev, 1) >= 2),
     n AS (SELECT lang, COUNT(*) AS n FROM f GROUP BY 1),
     df AS (SELECT f.lang, t.term, COUNT(*) AS df FROM track_lyric_terms t JOIN f USING (track_id) GROUP BY 1, 2),
     scored AS (SELECT t.track_id, f.lang, t.term, t.tf, d.df, t.tf * LN(GREATEST(n.n, 2) * 1.0 / d.df) AS score
                FROM track_lyric_terms t JOIN f USING (track_id) JOIN df d ON d.lang = f.lang AND d.term = t.term JOIN n ON n.lang = f.lang
                WHERE d.df < GREATEST(n.n, 2) * 0.35)     -- a word in over a third of that language's songs is not distinctive of any of them
SELECT track_id, lang, term, tf, df, score, ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY score DESC, tf DESC, term) AS rank
FROM scored
QUALIFY rank <= 15;

-- ------------------------------------------------------------
-- Phase 9f — playlist sync that survives quota and unreadable playlists.
-- ------------------------------------------------------------
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS owner_id VARCHAR;              -- Spotify user id of the owner ('spotify' = Spotify-made)
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS items_synced_at TIMESTAMPTZ;   -- when the items were last pulled in full
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS items_snapshot_id VARCHAR;     -- the snapshot the items belong to; unchanged snapshot → no re-fetch
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS sync_error VARCHAR;            -- last item-fetch failure ('unreadable: Spotify-owned playlists are closed to third-party apps')
ALTER TABLE playlists ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ DEFAULT now();

-- ------------------------------------------------------------
-- Phase 9g — the Forecast (summary §3.2). One row per local date: what the app predicted for that day, written
-- the first time the dashboard is opened that day. Never overwritten, so the accuracy line stays honest.
-- payload: {"weekday": 0-6, "pAny": 0.83, "scenes": [{"scene": "psych", "p": 0.62}, ...], "slots": [{"slot": "evening", "p": 0.7}, ...],
--           "calls": [{"kind": "artist", "key": "name:...", "label": "Bon Iver", "p": 0.92, "n": 11}]}
-- Accuracy is computed by joining payload against plays_resolved for forecast_date (forecastQueries.ts); no outcome column needed.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS forecast_log (
    forecast_date DATE PRIMARY KEY,
    weekday       INTEGER,
    payload       JSON,
    created_at    TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Phase 9g — audio features via FreqBlog (free tier 1,000 req/month; POST /bulk = 50 tracks per request).
-- Derived numbers only. bpm / key / energy / loudness are 100 %-coverage fields; valence / mood / danceability are
-- perceptual estimates and the UI labels them "directional". `feature_source` records which lookup matched (isrc | name).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS track_features (
    track_id         VARCHAR PRIMARY KEY,
    isrc             VARCHAR,
    bpm              DOUBLE,
    bpm_alt          DOUBLE,          -- half/double-time alternative when the service reports one
    bpm_confidence   DOUBLE,
    key_name         VARCHAR,         -- 'F# minor'
    key_int          INTEGER,         -- 0 = C … 11 = B, -1 unknown
    mode             INTEGER,         -- 1 major, 0 minor
    camelot          VARCHAR,         -- '11A'
    energy           DOUBLE,
    loudness_db      DOUBLE,
    danceability     DOUBLE,
    valence          DOUBLE,
    mood             VARCHAR,
    time_signature   INTEGER,
    acousticness     DOUBLE,
    instrumentalness DOUBLE,
    liveness         DOUBLE,
    speechiness      DOUBLE,
    genre            VARCHAR,
    feature_source   VARCHAR,
    found            BOOLEAN DEFAULT TRUE,   -- FALSE = asked, service had nothing (don't ask again for 90 days)
    fetched_at       TIMESTAMPTZ DEFAULT now()
);
INSERT INTO connector_state (service, status) VALUES ('freqblog', 'disconnected') ON CONFLICT (service) DO NOTHING;

-- ------------------------------------------------------------
-- Phase 9i — metadata you can trust and correct.
-- artist_mb_match: HOW each artist's MusicBrainz id was chosen. 9h matched by name alone (first exact-name hit of 3),
--   which is how Paul Banks got a Danish namesake and Rodriguez a Cuban one. Methods, strongest first:
--   'owner' (you picked it) · 'isrc' (the MusicBrainz recording behind one of your tracks credits this artist) ·
--   'albums' (several namesakes; this one has release groups matching your albums) · 'name' (one exact-name hit only).
--   Kept outside `artists` because entity_resolution rebuilds that table; the rebuild re-applies these.
-- metadata_overrides: owner corrections for rebuilt tables, re-applied at the end of entity_resolution.sql.
--   Fields: album.release_date · album.image_url · track.isrc · track.release_date · artist.image_url.
--   Artist origin corrections live in artist_origin with source = 'owner' (enrichment never overwrites those).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artist_mb_match (
    artist_id   VARCHAR PRIMARY KEY,
    mbid        VARCHAR,
    method      VARCHAR,          -- owner | isrc | albums | name | ambiguous
    evidence    VARCHAR,          -- e.g. the ISRC, or '3 of 5 albums'
    candidates  INTEGER,          -- exact-name namesakes MusicBrainz returned
    checked_at  TIMESTAMPTZ DEFAULT now()
);
CREATE TABLE IF NOT EXISTS metadata_overrides (
    entity_type VARCHAR,          -- artist | album | track
    entity_id   VARCHAR,
    field       VARCHAR,
    value       VARCHAR,
    updated_at  TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (entity_type, entity_id, field)
);

-- Phase 9i — album-level listeners (Last.fm album.getInfo), so The Crate can show how rare the *record* is separately
-- from how rare the *artist* is (a famous band's forgotten album; an unknown artist's one breakout). Same scale as artists.
CREATE TABLE IF NOT EXISTS album_popularity (
    album_id    VARCHAR PRIMARY KEY,
    listeners   BIGINT,
    playcount   BIGINT,
    found       BOOLEAN DEFAULT TRUE,
    fetched_at  TIMESTAMPTZ DEFAULT now()
);
CREATE OR REPLACE VIEW album_obscurity AS
SELECT album_id, listeners, playcount, fetched_at,
       CASE WHEN found THEN GREATEST(0.0, LEAST(1.0, 1.0 - LOG10(COALESCE(listeners, 0) + 1) / 7.0)) END AS obscurity
FROM album_popularity;

-- ------------------------------------------------------------
-- Phase 9i — one row per play with everything the record knows about it, for "Export everything" (a spreadsheet-
-- friendly flat file next to the per-table dumps). Read-only view; nothing depends on it inside the app.
-- ------------------------------------------------------------
CREATE OR REPLACE VIEW plays_enriched AS
WITH sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
     tg AS (SELECT artist_id, string_agg(tag, '; ' ORDER BY weight DESC) AS tags FROM (SELECT artist_id, tag, MAX(weight) AS weight FROM artist_tags GROUP BY 1, 2 QUALIFY ROW_NUMBER() OVER (PARTITION BY artist_id ORDER BY MAX(weight) DESC) <= 5) GROUP BY 1)
SELECT p.played_at, p.track_id, p.track_name, p.artist_id, p.artist_name, p.album_id, p.album_name, p.ms_played, p.was_skipped, p.attended,
       p.platform, p.country AS listened_in_country, p.zone AS listened_in_zone,
       t.isrc, CAST(COALESCE(al.release_date, t.release_date) AS VARCHAR) AS release_date, al.image_url AS album_art_url,
       o.country AS artist_country, o.city AS artist_city, f.label AS scene, tg.tags AS artist_tags,
       ap.listeners AS artist_lastfm_listeners, alp.listeners AS album_lastfm_listeners,
       tf.bpm, tf.key_name AS musical_key, tf.energy, tf.loudness_db,
       lf.lang AS lyric_language, array_to_string(lf.themes, '; ') AS lyric_themes, lf.valence AS lyric_valence, lf.llm_mood AS lyric_mood,
       (l.track_id IS NOT NULL) AS in_liked_songs
FROM plays_resolved p
LEFT JOIN tracks t ON t.track_id = p.track_id LEFT JOIN albums al ON al.album_id = p.album_id
LEFT JOIN artist_origin o ON o.artist_id = p.artist_id LEFT JOIN sc ON sc.artist_id = p.artist_id LEFT JOIN scene_families f ON f.scene = sc.scene
LEFT JOIN tg ON tg.artist_id = p.artist_id LEFT JOIN artist_popularity ap ON ap.artist_id = p.artist_id LEFT JOIN album_popularity alp ON alp.album_id = p.album_id
LEFT JOIN track_features tf ON tf.track_id = p.track_id AND tf.found LEFT JOIN track_lyric_features lf ON lf.track_id = p.track_id AND lf.found
LEFT JOIN liked_songs l ON l.track_id = p.track_id;

-- ------------------------------------------------------------
-- Phase 9j — owner tag edits. A tag you remove is BLOCKED for that artist: it's deleted now, stripped again after every
-- Last.fm / MusicBrainz pass and at the start of compute_scenes.sql, so enrichment can't bring it back (owner: Ljupka
-- Dimitrovska kept a "german" tag). Tags you add are artist_tags rows with source = 'owner', weight 1.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tag_blocks (
    artist_id  VARCHAR,
    tag        VARCHAR,
    blocked_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (artist_id, tag)
);

-- ------------------------------------------------------------
-- Phase 9j — Wikipedia: a picture and a short description per artist (owner: "Connect Wiki for pictures/descriptions?").
-- Resolved by chain, never by name: MusicBrainz artist → its Wikidata link → the Wikipedia article in your language
-- (English fallback) → the REST summary (extract + lead image). So a namesake can't sneak in, as happened with origins.
-- Text is Wikipedia's (CC BY-SA) and the image is from Wikimedia Commons; both are shown with a link and credit.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS artist_wiki (
    artist_id   VARCHAR PRIMARY KEY,
    qid         VARCHAR,          -- Wikidata id, e.g. Q1234
    lang        VARCHAR,
    title       VARCHAR,
    extract     VARCHAR,          -- the summary's plain-text intro
    description VARCHAR,          -- one-line Wikidata description ("Macedonian singer")
    image_url   VARCHAR,          -- lead image (thumbnail ~ 640 px)
    page_url    VARCHAR,
    found       BOOLEAN DEFAULT TRUE,
    fetched_at  TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Phase 9k — weather (Open-Meteo, free, no key) for the place you set in Settings → Record → Weather.
-- One row per local date: observed history (archive API) for the span of your record, plus the 7-day forecast.
-- `bucket` folds WMO weather codes into six moods: sunny · cloudy · fog · rain · snow · storm.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS weather_daily (
    date        DATE PRIMARY KEY,
    code        INTEGER,         -- WMO weather code
    bucket      VARCHAR,
    tmax        DOUBLE,          -- °C
    tmin        DOUBLE,
    precip_mm   DOUBLE,
    sunshine_h  DOUBLE,
    kind        VARCHAR,         -- observed | forecast
    fetched_at  TIMESTAMPTZ DEFAULT now()
);

-- ------------------------------------------------------------
-- Phase 9m — Stylus S1: Deep Cuts' own scrobble receiver (docs/STYLUS-SPEC.md). It speaks the ListenBrainz API, so
-- Pano Scrobbler, Web Scrobbler, multi-scrobbler, Navidrome, Jellyfin… can point at it. Rust only authenticates and
-- drops the raw request into stylus_inbox; stylus_process.sql does the rest (testable without the network).
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stylus_devices (
    device_id     VARCHAR PRIMARY KEY,
    name          VARCHAR,
    token_hash    VARCHAR,           -- sha-256 hex of the token; the token itself is shown once and never stored
    ts_precision  VARCHAR DEFAULT 'exact',   -- exact | minute | hour — what's kept of each listen's time
    keep_player   BOOLEAN DEFAULT TRUE,      -- "Poweramp", "Web Scrobbler"
    keep_service  BOOLEAN DEFAULT TRUE,      -- "bandcamp.com", "youtube"
    keep_device   BOOLEAN DEFAULT TRUE,      -- this device's name on each play (the platform field)
    paused        BOOLEAN DEFAULT FALSE,     -- accept and discard, so clients don't queue up
    created_at    TIMESTAMPTZ DEFAULT now(),
    last_seen_at  TIMESTAMPTZ,
    accepted      BIGINT DEFAULT 0,
    duplicates    BIGINT DEFAULT 0,          -- already recorded by Spotify (or resent by the client)
    discarded     BIGINT DEFAULT 0           -- arrived while paused
);
CREATE TABLE IF NOT EXISTS stylus_inbox (device_id VARCHAR, body VARCHAR, received_at TIMESTAMPTZ DEFAULT now());
CREATE TABLE IF NOT EXISTS stylus_now_playing (device_id VARCHAR PRIMARY KEY, artist_name VARCHAR, track_name VARCHAR, release_name VARCHAR, since TIMESTAMPTZ DEFAULT now());
