-- Phase 8 — insert ONE ambient capture (a Last.fm scrobble from the phone)
-- as a `wild_play` event, unless it is a duplicate.
--
-- Parameters:
--   ?1  heard_at   ISO-8601 UTC instant of the scrobble (start of play)
--   ?2  payload    JSON (track_name, artist_name, album_name, lastfm_uts, mbid, source)
--   ?3  track_name
--   ?4  artist_name
--   ?5  uts        scrobble timestamp as epoch seconds (BIGINT)
--
-- A capture is dropped when ANY of these hold:
--
--  (A) Already imported — same scrobble timestamp + same song. Makes re-running
--      the importer idempotent.
--
--  (B) It is the owner's own Spotify playback being overheard. Pano's
--      Now Playing / Shazam scrobbles carry no origin, so the only honest test
--      is temporal: if a PRIMARY play (`event_type = 'play'`, any source) of the
--      same artist was running when the capture was stamped, the capture is a
--      duplicate of listening the record already has.
--
--      Start/end of the primary play are derived from the source's clock
--      semantics (see plays_normalized): the extended export stamps END of play,
--      every other source stamps START. A ±120 s tolerance around the interval
--      absorbs phone/desktop clock drift and Pano's stamp-at-start behaviour.
--
--      Title match is deliberately loose (normalised equality OR containment
--      after stripping "(feat. …)" / "- Remaster" suffixes) because Google's
--      and Spotify's titles for the same recording differ. Artist match is
--      strict. A same-artist capture that lands strictly INSIDE the primary
--      interval is also dropped even when the titles disagree — two songs
--      cannot physically play at once, so that is the same speaker.
--
-- The window on `events.occurred_at` (indexed) keeps this cheap: only plays
-- within ±3 h of the capture are examined, then the JSON is unpacked for those.
INSERT INTO events (event_type, occurred_at, payload, source_file)
SELECT 'wild_play', CAST(?1 AS TIMESTAMPTZ), CAST(?2 AS JSON), 'lastfm_wild'
WHERE NOT EXISTS (                                              -- (A) idempotent
    SELECT 1 FROM events w
    WHERE w.event_type = 'wild_play'
      AND CAST(json_extract(w.payload, '$.lastfm_uts') AS BIGINT) = CAST(?5 AS BIGINT)
      AND lower(trim(json_extract_string(w.payload, '$.track_name'))) = lower(trim(?3))
)
AND NOT EXISTS (                                                -- (B) own playback overheard
    WITH cand AS (
        SELECT
            CASE WHEN json_extract_string(e.payload, '$.source') = 'extended_export'
                 THEN e.occurred_at - COALESCE(CAST(json_extract(e.payload, '$.ms_played') AS BIGINT), 0) * INTERVAL 1 MILLISECOND
                 ELSE e.occurred_at END                                                                AS p_start,
            CASE WHEN json_extract_string(e.payload, '$.source') = 'extended_export'
                 THEN e.occurred_at
                 ELSE e.occurred_at + COALESCE(CAST(json_extract(e.payload, '$.ms_played') AS BIGINT), 0) * INTERVAL 1 MILLISECOND END AS p_end,
            lower(trim(json_extract_string(e.payload, '$.artist_name')))                                                          AS p_artist,
            lower(trim(regexp_replace(regexp_replace(json_extract_string(e.payload, '$.track_name'), '\s*[\(\[].*$', ''), '\s+-\s+.*$', ''))) AS p_track
        FROM events e
        WHERE e.event_type = 'play'
          AND e.occurred_at BETWEEN to_timestamp(CAST(?5 AS BIGINT)) - INTERVAL 3 HOUR
                                AND to_timestamp(CAST(?5 AS BIGINT)) + INTERVAL 3 HOUR
    ),
    me AS (
        SELECT lower(trim(?4)) AS w_artist,
               lower(trim(regexp_replace(regexp_replace(?3, '\s*[\(\[].*$', ''), '\s+-\s+.*$', ''))) AS w_track,
               to_timestamp(CAST(?5 AS BIGINT)) AS w_at
    )
    SELECT 1 FROM cand c, me
    WHERE c.p_artist = me.w_artist
      AND (
            -- same song, within tolerance of the play interval
            (   me.w_at BETWEEN c.p_start - INTERVAL 120 SECOND AND c.p_end + INTERVAL 120 SECOND
            AND (c.p_track = me.w_track OR c.p_track LIKE '%' || me.w_track || '%' OR me.w_track LIKE '%' || c.p_track || '%'))
            -- same artist, strictly inside the play: one speaker, one song
         OR (   me.w_at BETWEEN c.p_start AND c.p_end)
      )
);
