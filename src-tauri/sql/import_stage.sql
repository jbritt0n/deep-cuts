-- ============================================================
-- Import: stage one Streaming_History_Audio_*.json file (ING-01…03)
-- Parameter ?1 = absolute path to the JSON file.
-- The file is read as a JSON array of untyped objects so any export
-- vintage (2016 files lack `skipped`, `audiobook_*`, …) parses.
-- Result: TEMP table _stage with one row per record.
-- ============================================================
CREATE OR REPLACE TEMP TABLE _stage AS
SELECT
    -- ts is an ISO-8601 UTC instant ("2021-01-01T00:00:24Z"). read_json may drop
    -- the 'Z'; either way the digits ARE UTC, so strip any Z and cast to a naive
    -- TIMESTAMP (never TIMESTAMPTZ — that would apply the session time zone).
    TRY_CAST(regexp_replace(json_extract_string(json, '$.ts'), 'Z$', '') AS TIMESTAMP) AS ts,
    json_extract_string(json, '$.spotify_track_uri')                   AS spotify_track_uri,
    json_extract_string(json, '$.master_metadata_track_name')          AS track_name,
    json_extract_string(json, '$.master_metadata_album_artist_name')   AS artist_name,
    json_extract_string(json, '$.master_metadata_album_album_name')    AS album_name,
    COALESCE(TRY_CAST(json_extract(json, '$.ms_played') AS BIGINT), 0) AS ms_played,
    json_extract_string(json, '$.platform')                            AS platform,
    json_extract_string(json, '$.reason_end')                          AS end_reason,
    json_extract_string(json, '$.reason_start')                        AS start_reason,
    TRY_CAST(json_extract(json, '$.shuffle')        AS BOOLEAN)        AS shuffle,
    TRY_CAST(json_extract(json, '$.skipped')        AS BOOLEAN)        AS export_skipped,
    TRY_CAST(json_extract(json, '$.offline')        AS BOOLEAN)        AS offline,
    TRY_CAST(json_extract(json, '$.incognito_mode') AS BOOLEAN)        AS incognito,
    json_extract_string(json, '$.conn_country')                        AS country,
    (json_extract_string(json, '$.spotify_episode_uri') IS NOT NULL)   AS is_podcast,
    (json_extract_string(json, '$.audiobook_uri') IS NOT NULL)         AS is_audiobook
FROM read_json(?1, format = 'array', records = 'false');
