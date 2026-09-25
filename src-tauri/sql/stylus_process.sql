-- ============================================================
-- Phase 9m — Stylus: turn ListenBrainz submissions waiting in stylus_inbox into play events, then empty the inbox.
-- Body shape (https://listenbrainz.readthedocs.io — submit-listens):
--   {"listen_type": "single" | "import" | "playing_now",
--    "payload": [{"listened_at": <unix s, start of listen>, "track_metadata": {"artist_name", "track_name", "release_name",
--                 "additional_info": {"duration_ms" | "duration" (s), "spotify_id" (URL), "origin_url", "isrc", "recording_mbid",
--                                     "media_player", "submission_client", "music_service" | "music_service_name"}}}]}
-- Privacy: per-device ts_precision / keep_player / keep_service / keep_device are applied before anything is stored.
-- Dedupe: skipped when the same device already sent it, or Spotify already has that play (same Spotify id — or the same
-- artist + title when the scrobble has no id — starting within 30 s). A scrobble that lands BEFORE Spotify's poll is
-- replaced by the richer Spotify row later, in entity_resolution.sql.
-- ============================================================
CREATE OR REPLACE TEMP TABLE _sin AS SELECT * FROM stylus_inbox;

CREATE OR REPLACE TEMP TABLE _sl AS
WITH b AS (SELECT i.device_id, TRY_CAST(i.body AS JSON) AS j FROM _sin i),
     l AS (SELECT b.device_id, json_extract_string(b.j, '$.listen_type') AS lt, unnest(from_json(json_extract(b.j, '$.payload'), '["JSON"]')) AS x FROM b WHERE b.j IS NOT NULL),
     f AS (
       SELECT l.device_id, l.lt, d.name AS device_name, d.ts_precision, d.keep_player, d.keep_service, d.keep_device, d.paused,
              to_timestamp(TRY_CAST(json_extract(l.x, '$.listened_at') AS BIGINT)) AS listen_at,
              NULLIF(trim(json_extract_string(l.x, '$.track_metadata.artist_name')), '') AS artist_name,
              NULLIF(trim(json_extract_string(l.x, '$.track_metadata.track_name')), '') AS track_name,
              NULLIF(trim(json_extract_string(l.x, '$.track_metadata.release_name')), '') AS album_name,
              COALESCE(TRY_CAST(json_extract(l.x, '$.track_metadata.additional_info.duration_ms') AS BIGINT),
                       TRY_CAST(json_extract(l.x, '$.track_metadata.additional_info.duration') AS BIGINT) * 1000) AS duration_ms,
              NULLIF(regexp_extract(COALESCE(json_extract_string(l.x, '$.track_metadata.additional_info.spotify_id'), json_extract_string(l.x, '$.track_metadata.additional_info.origin_url'), ''), 'open\.spotify\.com/track/([A-Za-z0-9]{22})', 1), '') AS spotify_track_id,
              json_extract_string(l.x, '$.track_metadata.additional_info.isrc') AS isrc,
              json_extract_string(l.x, '$.track_metadata.additional_info.recording_mbid') AS recording_mbid,
              COALESCE(json_extract_string(l.x, '$.track_metadata.additional_info.media_player'), json_extract_string(l.x, '$.track_metadata.additional_info.submission_client')) AS player,
              COALESCE(json_extract_string(l.x, '$.track_metadata.additional_info.music_service_name'), json_extract_string(l.x, '$.track_metadata.additional_info.music_service')) AS service
       FROM l JOIN stylus_devices d USING (device_id))
SELECT *, CASE ts_precision WHEN 'hour' THEN date_trunc('hour', listen_at) WHEN 'minute' THEN date_trunc('minute', listen_at) ELSE listen_at END AS at_kept
FROM f;

-- now playing (never stored as a play)
INSERT INTO stylus_now_playing (device_id, artist_name, track_name, release_name, since)
SELECT device_id, arg_max(artist_name, rowid), arg_max(track_name, rowid), arg_max(album_name, rowid), now() FROM (SELECT *, row_number() OVER () AS rowid FROM _sl WHERE lt = 'playing_now' AND NOT paused AND track_name IS NOT NULL) GROUP BY 1
ON CONFLICT (device_id) DO UPDATE SET artist_name = excluded.artist_name, track_name = excluded.track_name, release_name = excluded.release_name, since = now();

-- classify each listen
CREATE OR REPLACE TEMP TABLE _sl2 AS
SELECT s.*,
       CASE WHEN s.paused THEN 'discarded'
            -- the same listen twice in one batch (clients retry): only the first counts
            WHEN ROW_NUMBER() OVER (PARTITION BY s.device_id, lower(s.track_name), s.at_kept ORDER BY s.listen_at) > 1 THEN 'duplicate'
            WHEN EXISTS (SELECT 1 FROM plays_normalized n WHERE n.source = 'stylus' AND n.platform IS NOT DISTINCT FROM (CASE WHEN s.keep_device THEN 'stylus:' || s.device_name ELSE 'stylus' END)
                           AND lower(n.track_name) = lower(s.track_name) AND abs(epoch(n.raw_at) - epoch(s.at_kept)) <= 5) THEN 'duplicate'
            WHEN EXISTS (SELECT 1 FROM plays_normalized n WHERE n.source IN ('recently_played_poll', 'extended_export')
                           AND ((s.spotify_track_id IS NOT NULL AND n.spotify_track_id = s.spotify_track_id)
                                OR (s.spotify_track_id IS NULL AND lower(n.track_name) = lower(s.track_name) AND lower(n.artist_name) = lower(s.artist_name)))
                           AND (abs(epoch(CASE WHEN n.source = 'extended_export' THEN n.played_at_utc - n.ms_played * INTERVAL 1 MILLISECOND ELSE n.raw_at END) - epoch(s.listen_at)) <= 30
                                OR abs(epoch(n.raw_at) - epoch(s.listen_at + COALESCE(s.duration_ms, 0) * INTERVAL 1 MILLISECOND)) <= 30)) THEN 'duplicate'
            ELSE 'accepted' END AS verdict
FROM _sl s WHERE s.lt IN ('single', 'import') AND s.listen_at IS NOT NULL AND s.track_name IS NOT NULL AND s.artist_name IS NOT NULL;

INSERT INTO events (event_type, occurred_at, payload, source_file)
SELECT 'play', at_kept,
       json_object('source', 'stylus', 'track_name', track_name, 'artist_name', artist_name, 'album_name', album_name,
                   'spotify_track_id', spotify_track_id, 'ms_played', COALESCE(duration_ms, 210000), 'isrc', isrc, 'recording_mbid', recording_mbid,
                   'platform', CASE WHEN keep_device THEN 'stylus:' || device_name ELSE 'stylus' END,
                   'media_player', CASE WHEN keep_player THEN player END, 'music_service', CASE WHEN keep_service THEN service END,
                   'end_reason', 'trackdone', 'start_reason', 'unknown'),
       'stylus:' || device_id
FROM _sl2 WHERE verdict = 'accepted';

UPDATE stylus_devices SET last_seen_at = now(),
       accepted   = accepted   + COALESCE((SELECT COUNT(*) FROM _sl2 x WHERE x.device_id = stylus_devices.device_id AND x.verdict = 'accepted'), 0),
       duplicates = duplicates + COALESCE((SELECT COUNT(*) FROM _sl2 x WHERE x.device_id = stylus_devices.device_id AND x.verdict = 'duplicate'), 0),
       discarded  = discarded  + COALESCE((SELECT COUNT(*) FROM _sl2 x WHERE x.device_id = stylus_devices.device_id AND x.verdict = 'discarded'), 0)
WHERE device_id IN (SELECT DISTINCT device_id FROM _sin);

DELETE FROM stylus_inbox WHERE (device_id, received_at) IN (SELECT device_id, received_at FROM _sin);
DROP TABLE _sin; DROP TABLE _sl; DROP TABLE _sl2;

-- Phase 10b — Stylus S2 retention: past a device's retention_days, its scrobbles keep only what a play needs (track,
-- artist, album, time, duration); player, service and the device's name are dropped. Runs with every submission.
UPDATE events SET payload = json_merge_patch(payload, '{"media_player": null, "music_service": null, "platform": "stylus"}')
WHERE source_file LIKE 'stylus:%'
  AND EXISTS (SELECT 1 FROM stylus_devices d WHERE 'stylus:' || d.device_id = events.source_file AND d.retention_days IS NOT NULL
              AND events.occurred_at < now() - d.retention_days * INTERVAL 1 DAY)
  AND (json_extract_string(payload, '$.media_player') IS NOT NULL OR json_extract_string(payload, '$.music_service') IS NOT NULL OR json_extract_string(payload, '$.platform') <> 'stylus');
