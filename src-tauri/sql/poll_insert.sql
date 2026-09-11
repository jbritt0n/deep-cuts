-- ING-05/06 + CON-11: insert one recently-played item unless it already exists.
-- Parameters: ?1 played_at (ISO UTC start of play) · ?2 track id · ?3 payload JSON
--             · ?4 end-of-play epoch seconds (start + duration) for the tolerance check
-- Export rows are END of play; the API's are START. plays_normalized already
-- normalises both to end-of-play, so we compare there with a ±2 s tolerance.
INSERT INTO events (event_type, occurred_at, payload, source_file)
SELECT 'play', CAST(?1 AS TIMESTAMPTZ), CAST(?3 AS JSON), 'recently_played_poll'
WHERE NOT EXISTS (
    SELECT 1 FROM plays_normalized p
    WHERE p.spotify_track_id = ?2
      AND abs(epoch(p.played_at_utc) - ?4) <= 2.0);
