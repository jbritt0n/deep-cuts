-- After import_insert.sql: make this file's keys visible to the next file
-- in the same run (also collapses in-file duplicates for later files).
INSERT INTO _existing_keys
SELECT ts, spotify_track_uri, ms_played FROM _stage
WHERE track_name IS NOT NULL AND ts IS NOT NULL;
