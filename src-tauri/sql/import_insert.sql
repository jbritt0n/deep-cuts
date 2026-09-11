-- Insert the staged rows that are audio plays and not already present (ING-02).
-- Parameter ?1 = source_file label (basename).
-- Within one file, duplicate keys are collapsed too (Spotify exports can
-- repeat a row). `events` is append-only: this is the only write path.
INSERT INTO events (event_type, occurred_at, payload, source_file)
SELECT
    'play',
    CAST(ts AS TIMESTAMPTZ),          -- naive UTC → instant (session TimeZone is UTC; no ICU needed)
    json_object(
        'spotify_track_uri', spotify_track_uri,
        'spotify_track_id',  CASE WHEN spotify_track_uri IS NOT NULL
                                  THEN regexp_extract(spotify_track_uri, '([^:]+)$', 1) END,
        'track_name',        track_name,
        'artist_name',       artist_name,
        'album_name',        album_name,
        'ms_played',         ms_played,
        'platform',          platform,
        'end_reason',        end_reason,
        'start_reason',      start_reason,
        'shuffle',           shuffle,
        'export_skipped',    export_skipped,
        'offline',           offline,
        'incognito',         incognito,
        'country',           country,
        'source',            'extended_export'
    ),
    ?1
FROM (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY ts, spotify_track_uri, ms_played ORDER BY ts) AS rn
    FROM _stage
    WHERE track_name IS NOT NULL AND ts IS NOT NULL
) s
WHERE rn = 1
  AND NOT EXISTS (
      SELECT 1 FROM _existing_keys k
      WHERE k.ts = s.ts
        AND k.uri IS NOT DISTINCT FROM s.spotify_track_uri
        AND k.ms = s.ms_played);
