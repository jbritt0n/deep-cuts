-- Aggregate a staged export (import_stage.sql → _stage) into blend_plays under a label.
-- Parameter ?1 = label. Never touches events.
INSERT INTO blend_plays (label, spotify_track_id, track_name, artist_name, album_name, plays, ms_played, first_at, last_at)
SELECT ?1,
       regexp_extract(spotify_track_uri, '([^:]+)$', 1), track_name, artist_name, album_name,
       COUNT(*), SUM(ms_played), MIN(CAST(ts AS TIMESTAMPTZ)), MAX(CAST(ts AS TIMESTAMPTZ))
FROM _stage WHERE track_name IS NOT NULL AND ts IS NOT NULL AND ms_played >= 30000
GROUP BY 2, 3, 4, 5;
