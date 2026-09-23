-- ============================================================
-- Insights cache (spec §7, nightly). Rebuilds `insights` for the dashboard's
-- "unseen" row; keeps `surfaced`. Scenes are rebuilt by compute_scenes.sql beforehand.
-- ============================================================
CREATE OR REPLACE TEMP TABLE _surf AS SELECT kind, subject_type, subject_id, period_start FROM insights WHERE surfaced;
DELETE FROM insights;

-- ---- scenes: rebuilt by compute_scenes.sql (Phase 9f), which runs right before this file.

-- ---- INS-02 obsessions (artist, last 26 weeks) --------------------------------
INSERT INTO insights (kind, period_start, period_end, subject_type, subject_id, payload, score)
WITH w AS (SELECT artist_id, artist_name, DATE_TRUNC('week', played_at)::DATE AS wk, COUNT(*) AS c FROM plays_resolved WHERE attended AND artist_id IS NOT NULL AND played_at >= now() - INTERVAL 26 WEEK GROUP BY 1, 2, 3),
     b AS (SELECT artist_id, wk, c, SUM(c) OVER (PARTITION BY artist_id ORDER BY wk RANGE BETWEEN INTERVAL 91 DAY PRECEDING AND INTERVAL 7 DAY PRECEDING) AS prior FROM w)
SELECT 'obsession', wk, wk + INTERVAL 7 DAY, 'artist', b.artist_id,
       json_object('artist', w.artist_name, 'plays', b.c, 'usual', ROUND(COALESCE(b.prior, 0) / 13.0, 1)),
       b.c * 1.0 / GREATEST(COALESCE(b.prior, 0) / 13.0, 1)
FROM b JOIN w USING (artist_id, wk) WHERE b.c >= 15 AND b.c >= 5 * COALESCE(b.prior, 0) / 13.0
QUALIFY ROW_NUMBER() OVER (PARTITION BY b.artist_id ORDER BY b.c DESC) = 1;

-- ---- scene phases: a scene running ≥ 3× its 26-week baseline in a week ----------
INSERT INTO insights (kind, period_start, period_end, subject_type, subject_id, payload, score)
WITH sp AS (SELECT s.scene, DATE_TRUNC('week', p.played_at)::DATE AS wk, SUM(p.ms_played)/3600000.0 AS h, arg_max(p.artist_name, p.ms_played) AS lead
            FROM plays_resolved p JOIN artist_scene s USING (artist_id) WHERE p.attended AND p.played_at >= now() - INTERVAL 52 WEEK GROUP BY 1, 2),
     base AS (SELECT scene, AVG(h) AS avg_h FROM sp GROUP BY 1)
SELECT 'scene_phase', sp.wk, sp.wk + INTERVAL 7 DAY, 'scene', sp.scene,
       json_object('scene', sp.scene, 'hours', ROUND(sp.h, 1), 'usual', ROUND(b.avg_h, 1), 'lead', sp.lead), sp.h / GREATEST(b.avg_h, 0.25)
FROM sp JOIN base b USING (scene) WHERE sp.h >= 2 AND sp.h >= 3 * b.avg_h
QUALIFY ROW_NUMBER() OVER (PARTITION BY sp.scene ORDER BY sp.h DESC) = 1;

-- ---- INS-03 comebacks (last 60 days) -------------------------------------------
INSERT INTO insights (kind, period_start, period_end, subject_type, subject_id, payload, score)
WITH f AS (SELECT artist_id, artist_name, played_at, LAG(played_at) OVER (PARTITION BY artist_id ORDER BY played_at) AS prev FROM plays_resolved WHERE attended AND artist_id IS NOT NULL),
     n AS (SELECT artist_id, COUNT(*) AS plays FROM plays_resolved WHERE artist_id IS NOT NULL GROUP BY 1)
SELECT 'comeback', CAST(f.played_at AS DATE), CAST(f.played_at AS DATE), 'artist', f.artist_id,
       json_object('artist', f.artist_name, 'days_silent', CAST(CAST(f.played_at AS DATE) - CAST(f.prev AS DATE) AS INTEGER), 'plays', n.plays),
       (CAST(f.played_at AS DATE) - CAST(f.prev AS DATE)) / 30.0
FROM f JOIN n USING (artist_id) WHERE f.played_at >= now() - INTERVAL 60 DAY AND f.played_at - f.prev >= INTERVAL 180 DAY AND n.plays >= 20
QUALIFY ROW_NUMBER() OVER (PARTITION BY f.artist_id ORDER BY f.played_at DESC) = 1;

-- ---- earworms: songs that keep coming back ---------------------------------
-- Calibrated on the owner's own Earwormz playlist: they are NOT burst songs. They have
-- moderate play counts (8–40), recur across many distinct months over years, are played
-- on their own (not inside album rides) and are almost never skipped.
INSERT INTO insights (kind, period_start, period_end, subject_type, subject_id, payload, score)
WITH p AS (SELECT p.track_id, p.track_name, p.artist_name, p.played_at, p.was_skipped, COALESCE(s.album_ride, FALSE) AS ride
           FROM plays_resolved p LEFT JOIN play_sessions ps USING (play_id) LEFT JOIN sessions s USING (session_id) WHERE p.attended AND p.track_id IS NOT NULL),
     mo AS (SELECT track_id, COUNT(DISTINCT DATE_TRUNC('month', played_at)) AS months, COUNT(DISTINCT EXTRACT(year FROM played_at)) AS years FROM p GROUP BY 1),
     agg AS (SELECT track_id, ANY_VALUE(track_name) AS track_name, ANY_VALUE(artist_name) AS artist_name, COUNT(*) AS plays,
                    AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr, AVG(CASE WHEN ride THEN 0 ELSE 1.0 END) AS alone,
                    MAX(played_at) AS last_at, MIN(played_at) AS first_at, date_diff('day', MIN(played_at), MAX(played_at)) AS span
             FROM p GROUP BY 1)
SELECT 'earworm', CAST(a.first_at AS DATE), CAST(a.last_at AS DATE), 'track', a.track_id,
       json_object('track', a.track_name, 'artist', a.artist_name, 'plays', a.plays, 'months', m.months, 'years', m.years, 'span_days', a.span, 'skip_rate', ROUND(a.sr, 2), 'alone', ROUND(a.alone, 2)),
       -- recurrence (distinct months, capped) × years bonus × played-alone × not skipped × modest plays; density = months per month of span (sporadic returns score higher than a single stretch)
       POWER(LEAST(m.months, 12) / 12.0, 0.7) * (1 + 0.15 * LEAST(m.years, 4)) * a.alone * (1 - a.sr) * SQRT(LEAST(a.plays, 25) / 25.0)
       * (0.6 + 0.4 * LEAST(1.0, m.months / GREATEST(1.0, a.span / 30.0)))
FROM agg a JOIN mo m USING (track_id)
WHERE a.plays >= 7 AND m.months >= 3 AND a.span >= 90 AND a.alone >= 0.6 AND a.sr <= 0.15;

UPDATE insights i SET surfaced = TRUE FROM _surf s WHERE i.kind = s.kind AND i.subject_type = s.subject_type AND i.subject_id = s.subject_id AND i.period_start = s.period_start;
DROP TABLE _surf;
INSERT INTO app_meta (key, value) VALUES ('last_insights', CAST(now() AS VARCHAR)) ON CONFLICT (key) DO UPDATE SET value = excluded.value;
