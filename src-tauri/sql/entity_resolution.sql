-- ============================================================
-- Deep Cuts v3 — entity resolution (DM-01). Step 1 of the rebuild (DM-02).
-- Rebuilds artists / albums / tracks / aliases / plays_resolved from events.
-- Idempotent. History is never rewritten: raw names stay in `events`; this
-- file only decides which canonical identity each play rolls up to.
--
-- Identity rules (Phase 1; MBID takes over the artist key in CON-06):
--   artist_id = 'name:' || lower(trim(artist_name))       (case/space-insensitive merge)
--   album_id  = 'name:' || md5(artist_id || '|' || lower(trim(album_name)))
--   track_id  = spotify_track_id when present,
--               else 'local:' || md5(artist_id || '|' || lower(trim(track_name)))
-- Display names are the most-played spelling; other spellings become aliases.
-- ============================================================

-- Enrichment written by Phase 2 must survive rebuilds: keep it aside.
CREATE OR REPLACE TEMP TABLE _keep_artists AS
SELECT artist_id, mbid, image_url, enriched_at FROM artists WHERE enriched_at IS NOT NULL OR mbid IS NOT NULL;
CREATE OR REPLACE TEMP TABLE _keep_albums AS
SELECT album_id, release_date, album_type, total_tracks, image_url, enriched_at FROM albums WHERE enriched_at IS NOT NULL;
CREATE OR REPLACE TEMP TABLE _keep_tracks AS
SELECT track_id, duration_ms, track_number, isrc, explicit, release_date, release_precision, enriched_at
FROM tracks WHERE enriched_at IS NOT NULL;

-- ---- per-play identity ----------------------------------------------------
-- Which zone applies to each play: manual override by date → single-zone country → home zone.
CREATE OR REPLACE TEMP TABLE _home AS SELECT coalesce((SELECT value FROM app_meta WHERE key = 'timezone'), 'UTC') AS zone;
CREATE OR REPLACE TEMP TABLE _pz AS
SELECT p.*,
       coalesce(
         (SELECT ov.zone FROM tz_overrides ov WHERE CAST(p.played_at_utc AS DATE) BETWEEN ov.from_date AND ov.to_date ORDER BY ov.from_date DESC LIMIT 1),
         (SELECT cz.zone FROM country_zones cz WHERE cz.country = p.country AND cz.zone IN (SELECT DISTINCT zone FROM tz_offsets)),
         (SELECT zone FROM _home)) AS zone
FROM plays_normalized p;

CREATE OR REPLACE TEMP TABLE _p AS
SELECT
    p.*,
    -- local wall clock via tz_offsets for the play's zone (ASOF: latest range starting at/before the instant)
    CAST(p.played_at_utc AS TIMESTAMP) + (coalesce(o.offset_s, 0) * INTERVAL 1 SECOND) AS played_at,
    CASE WHEN artist_name IS NULL THEN NULL
         ELSE 'name:' || lower(trim(artist_name)) END                                   AS artist_id,
    CASE WHEN album_name IS NULL OR artist_name IS NULL THEN NULL
         ELSE 'name:' || md5(lower(trim(artist_name)) || '|' || lower(trim(album_name))) END AS album_id,
    CASE WHEN spotify_track_id IS NOT NULL THEN spotify_track_id
         WHEN track_name IS NULL THEN NULL
         ELSE 'local:' || md5(coalesce(lower(trim(artist_name)), '') || '|' || lower(trim(track_name))) END AS track_id
FROM _pz p
ASOF LEFT JOIN tz_offsets o ON o.zone = p.zone AND CAST(p.played_at_utc AS TIMESTAMP) >= o.from_utc;

-- manual merges (Settings → Merge artists): redirect ids, also carry album/track keys
UPDATE _p SET artist_id = m.into_artist_id FROM artist_merges m WHERE _p.artist_id = m.from_artist_id;
UPDATE _p SET album_id = 'name:' || md5(substr(artist_id, 6) || '|' || lower(trim(album_name))) WHERE album_id IS NOT NULL AND artist_id IN (SELECT into_artist_id FROM artist_merges);
UPDATE _p SET track_id = 'local:' || md5(substr(artist_id, 6) || '|' || lower(trim(track_name))) WHERE track_id LIKE 'local:%' AND artist_id IN (SELECT into_artist_id FROM artist_merges);

-- ---- artists ----------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE _artist_names AS
SELECT artist_id, artist_name, COUNT(*) AS plays, MAX(played_at) AS last_at
FROM _p WHERE artist_id IS NOT NULL GROUP BY 1, 2;

DELETE FROM artists;
INSERT INTO artists (artist_id, name, mbid, image_url, enriched_at)
SELECT n.artist_id,
       arg_max(n.artist_name, (n.plays, n.last_at)) AS name,   -- most-played, then most-recent spelling
       k.mbid, k.image_url, k.enriched_at
FROM _artist_names n LEFT JOIN _keep_artists k USING (artist_id)
GROUP BY n.artist_id, k.mbid, k.image_url, k.enriched_at;

DELETE FROM artist_aliases;
INSERT INTO artist_aliases (alias_name, artist_id, plays)
SELECT artist_name, artist_id, plays FROM _artist_names
QUALIFY ROW_NUMBER() OVER (PARTITION BY artist_name ORDER BY plays DESC) = 1;

-- ---- albums -----------------------------------------------------------------
DELETE FROM albums;
INSERT INTO albums (album_id, name, artist_id, release_date, album_type, total_tracks, image_url, enriched_at)
SELECT a.album_id,
       arg_max(a.album_name, a.plays) AS name,
       arg_max(a.artist_id, a.plays)  AS artist_id,
       k.release_date, k.album_type, k.total_tracks, k.image_url, k.enriched_at
FROM (SELECT album_id, album_name, artist_id, COUNT(*) AS plays
      FROM _p WHERE album_id IS NOT NULL GROUP BY 1, 2, 3) a
LEFT JOIN _keep_albums k USING (album_id)
GROUP BY a.album_id, k.release_date, k.album_type, k.total_tracks, k.image_url, k.enriched_at;

-- ---- tracks -----------------------------------------------------------------
-- duration_ms_est: the longest play that ended naturally ('trackdone') is a
-- solid lower bound on the real duration and is available for most tracks
-- before any enrichment runs. Used as the SES-01 middle fallback.
DELETE FROM tracks;
INSERT INTO tracks (track_id, name, artist_id, album_id, duration_ms, duration_ms_est, track_number,
                    isrc, explicit, release_date, release_precision, enriched_at)
SELECT t.track_id,
       arg_max(t.track_name, t.plays) AS name,
       arg_max(t.artist_id,  t.plays) AS artist_id,
       arg_max(t.album_id,   t.plays) AS album_id,
       k.duration_ms,
       MAX(t.done_ms)                 AS duration_ms_est,
       k.track_number, k.isrc, k.explicit, k.release_date, k.release_precision, k.enriched_at
FROM (SELECT track_id, track_name, artist_id, album_id, COUNT(*) AS plays,
             MAX(CASE WHEN end_reason = 'trackdone' THEN ms_played END) AS done_ms
      FROM _p WHERE track_id IS NOT NULL GROUP BY 1, 2, 3, 4) t
LEFT JOIN _keep_tracks k USING (track_id)
GROUP BY t.track_id, k.duration_ms, k.track_number, k.isrc, k.explicit, k.release_date, k.release_precision, k.enriched_at;

-- Alternate titles / artist credits seen for the same Spotify track id.
DELETE FROM track_aliases;
INSERT INTO track_aliases (track_id, alt_name, alt_artist)
SELECT DISTINCT p.track_id, p.track_name, p.artist_name
FROM _p p JOIN tracks t ON t.track_id = p.track_id
WHERE p.track_name IS DISTINCT FROM t.name;

-- ---- plays_resolved ---------------------------------------------------------
-- Materialised so every dashboard query is one scan with ids attached.
DELETE FROM plays_resolved;
INSERT INTO plays_resolved
SELECT
    p.play_id, p.played_at, p.played_at_utc, p.track_id, p.artist_id, p.album_id,
    coalesce(t.name, p.track_name)  AS track_name,
    coalesce(a.name, p.artist_name) AS artist_name,
    coalesce(al.name, p.album_name) AS album_name,
    p.ms_played, p.platform, p.end_reason, p.start_reason, p.shuffle, p.source,
    p.was_skipped, p.under_30s,
    ROW_NUMBER() OVER (PARTITION BY p.track_id ORDER BY p.played_at, p.play_id) = 1 AS is_first_play,
    ROW_NUMBER() OVER (PARTITION BY p.track_id ORDER BY p.played_at, p.play_id)     AS play_index,
    TRUE  AS attended,   -- refined by compute_sessions.sql
    NULL  AS idle_min,
    p.country, p.zone
FROM _p p
LEFT JOIN tracks  t  ON t.track_id  = p.track_id
LEFT JOIN artists a  ON a.artist_id = p.artist_id
LEFT JOIN albums  al ON al.album_id = p.album_id;

DROP TABLE _p; DROP TABLE _pz; DROP TABLE _home; DROP TABLE _artist_names;
DROP TABLE _keep_artists; DROP TABLE _keep_albums; DROP TABLE _keep_tracks;

INSERT INTO app_meta (key, value) VALUES ('last_entity_resolution', CAST(now() AS VARCHAR))
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
