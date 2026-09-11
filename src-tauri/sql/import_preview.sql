-- Preview counts for one staged file (ING-01). Runs after import_stage.sql.
SELECT
    COUNT(*)                                                             AS rows_total,
    COUNT(*) FILTER (WHERE track_name IS NOT NULL AND ts IS NOT NULL)    AS rows_audio,
    COUNT(*) FILTER (WHERE track_name IS NULL OR ts IS NULL)             AS rows_skipped,
    strftime(MIN(ts) FILTER (WHERE track_name IS NOT NULL), '%Y-%m-%dT%H:%M:%SZ')                        AS first_ts,
    strftime(MAX(ts) FILTER (WHERE track_name IS NOT NULL), '%Y-%m-%dT%H:%M:%SZ')                        AS last_ts,
    COUNT(*) FILTER (WHERE track_name IS NOT NULL AND ts IS NOT NULL)
      - COUNT(DISTINCT (ts, spotify_track_uri, ms_played)) FILTER (WHERE track_name IS NOT NULL AND ts IS NOT NULL)
                                                                         AS rows_duplicate_in_file,
    COUNT(*) FILTER (WHERE track_name IS NOT NULL AND ts IS NOT NULL
        AND EXISTS (SELECT 1 FROM _existing_keys k
                    WHERE k.ts = _stage.ts
                      AND k.uri IS NOT DISTINCT FROM _stage.spotify_track_uri
                      AND k.ms = _stage.ms_played))                      AS rows_already_imported
FROM _stage;
