-- Dedupe index for this import run (ING-02): (ts, spotify_track_uri, ms_played)
-- of every export play already in the event log. Built once per run.
CREATE OR REPLACE TEMP TABLE _existing_keys AS
SELECT
    CAST(occurred_at AS TIMESTAMP)                                   AS ts,   -- naive UTC (session TimeZone is UTC)
    json_extract_string(payload, '$.spotify_track_uri')              AS uri,
    CAST(json_extract(payload, '$.ms_played') AS BIGINT)             AS ms
FROM events
WHERE event_type = 'play'
  AND json_extract_string(payload, '$.source') = 'extended_export';
CREATE INDEX IF NOT EXISTS idx_existing_keys ON _existing_keys (ts, uri, ms);
