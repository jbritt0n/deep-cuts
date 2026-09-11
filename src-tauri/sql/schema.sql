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
CREATE OR REPLACE VIEW plays_normalized AS
SELECT
    event_id                                             AS play_id,
    CASE
        WHEN json_extract_string(payload, '$.source') IN ('extended_export')
             THEN occurred_at
        ELSE occurred_at + (COALESCE(CAST(json_extract(payload, '$.ms_played') AS BIGINT), 0) * INTERVAL 1 MILLISECOND)
    END                                                  AS played_at_utc,
    occurred_at                                          AS raw_at,
    json_extract_string(payload, '$.spotify_track_id')   AS spotify_track_id,
    json_extract_string(payload, '$.track_name')         AS track_name,
    json_extract_string(payload, '$.artist_name')        AS artist_name,
    json_extract_string(payload, '$.album_name')         AS album_name,
    CAST(json_extract(payload, '$.ms_played') AS BIGINT) AS ms_played,
    json_extract_string(payload, '$.platform')           AS platform,
    json_extract_string(payload, '$.end_reason')         AS end_reason,
    json_extract_string(payload, '$.start_reason')       AS start_reason,
    CAST(json_extract(payload, '$.shuffle') AS BOOLEAN)  AS shuffle,
    json_extract_string(payload, '$.source')             AS source,
    json_extract_string(payload, '$.country')            AS country,
    -- behavioural flags (replacing deprecated audio features) — v1 definition kept
    (json_extract_string(payload, '$.end_reason') IN ('fwdbtn', 'backbtn')) AS was_skipped,
    (CAST(json_extract(payload, '$.ms_played') AS BIGINT) < 30000)          AS under_30s
FROM events
WHERE event_type = 'play';

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
    attention              VARCHAR    -- active | drifting | unattended
);

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
