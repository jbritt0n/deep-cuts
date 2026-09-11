-- ============================================================
-- INS-11 milestones — rebuilt from plays_resolved (idempotent; `seen` is kept).
-- Types: track_plays · artist_plays · artist_hours · first_play_anniversary ·
--        record_day · record_session · streak
-- ============================================================
CREATE OR REPLACE TEMP TABLE _seen AS SELECT type, subject_type, subject_id, value, seen FROM milestones WHERE seen;
DELETE FROM milestones;

-- nth play of a track / artist
INSERT INTO milestones (type, occurred_at, description, subject_type, subject_id, value)
SELECT 'track_plays', played_at, track_name || ' — ' || coalesce(artist_name, '') || ': play #' || rn, 'track', track_id, rn
FROM (SELECT track_id, track_name, artist_name, played_at, ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY played_at) AS rn FROM plays_resolved WHERE track_id IS NOT NULL AND attended)
WHERE rn IN (50, 100, 250, 500, 1000);

INSERT INTO milestones (type, occurred_at, description, subject_type, subject_id, value)
SELECT 'artist_plays', played_at, artist_name || ': play #' || rn, 'artist', artist_id, rn
FROM (SELECT artist_id, artist_name, played_at, ROW_NUMBER() OVER (PARTITION BY artist_id ORDER BY played_at) AS rn FROM plays_resolved WHERE artist_id IS NOT NULL AND attended)
WHERE rn IN (100, 500, 1000, 5000);

-- hour thresholds per artist (first play that crosses 10 / 50 / 100 / 500 h)
INSERT INTO milestones (type, occurred_at, description, subject_type, subject_id, value)
SELECT 'artist_hours', MIN(played_at), ANY_VALUE(artist_name) || ': ' || t.h || ' hours', 'artist', artist_id, t.h
FROM (SELECT artist_id, artist_name, played_at, SUM(ms_played) OVER (PARTITION BY artist_id ORDER BY played_at, play_id) / 3600000.0 AS cum_h
      FROM plays_resolved WHERE artist_id IS NOT NULL AND attended) p
JOIN (VALUES (10), (50), (100), (500)) t(h) ON p.cum_h >= t.h
GROUP BY artist_id, t.h;

-- anniversaries: one year (and multiples) since first play of an artist you still play
INSERT INTO milestones (type, occurred_at, description, subject_type, subject_id, value)
SELECT 'first_play_anniversary', f.first_at + (y.n * INTERVAL 1 YEAR), f.artist_name || ': ' || y.n || ' year' || CASE WHEN y.n = 1 THEN '' ELSE 's' END || ' since you first pressed play', 'artist', f.artist_id, y.n
FROM (SELECT artist_id, ANY_VALUE(artist_name) AS artist_name, MIN(played_at) AS first_at, COUNT(*) AS plays FROM plays_resolved WHERE artist_id IS NOT NULL AND attended GROUP BY 1 HAVING COUNT(*) >= 50 AND MAX(played_at) >= now() - INTERVAL 180 DAY) f
JOIN (SELECT range AS n FROM range(1, 15)) y ON f.first_at + (y.n * INTERVAL 1 YEAR) <= now();

-- records broken: new loudest day, new longest session
INSERT INTO milestones (type, occurred_at, description, subject_type, subject_id, value)
SELECT 'record_day', day, 'New loudest day: ' || CAST(ROUND(minutes) AS INTEGER) || ' minutes', 'day', CAST(day AS VARCHAR), CAST(minutes AS BIGINT)
FROM (SELECT day, minutes, MAX(minutes) OVER (ORDER BY day ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max FROM daily_minutes_attended)
WHERE prev_max IS NULL OR minutes > prev_max;

INSERT INTO milestones (type, occurred_at, description, subject_type, subject_id, value)
SELECT 'record_session', start_at, 'New longest session: ' || CAST(ROUND(total_ms / 3600000.0, 1) AS VARCHAR) || ' hours, ' || track_count || ' tracks', 'session', CAST(session_id AS VARCHAR), total_ms
FROM (SELECT session_id, start_at, total_ms, track_count, MAX(total_ms) OVER (ORDER BY start_at ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING) AS prev_max FROM sessions WHERE attention <> 'unattended')
WHERE (prev_max IS NULL OR total_ms > prev_max) AND total_ms >= 3600000;

-- streak thresholds
INSERT INTO milestones (type, occurred_at, description, subject_type, subject_id, value)
SELECT 'streak', day, len || '-day streak', 'streak', CAST(grp AS VARCHAR), len
FROM (SELECT day, grp, ROW_NUMBER() OVER (PARTITION BY grp ORDER BY day) AS len FROM (SELECT day, day - ROW_NUMBER() OVER (ORDER BY day) * INTERVAL 1 DAY AS grp FROM daily_minutes_attended))
WHERE len IN (30, 100, 365);

UPDATE milestones m SET seen = TRUE FROM _seen s WHERE m.type = s.type AND m.subject_type = s.subject_type AND m.subject_id = s.subject_id AND m.value = s.value;
DROP TABLE _seen;
INSERT INTO app_meta (key, value) VALUES ('last_milestones', CAST(now() AS VARCHAR)) ON CONFLICT (key) DO UPDATE SET value = excluded.value;
