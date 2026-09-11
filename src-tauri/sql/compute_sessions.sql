-- ============================================================
-- Deep Cuts v3 — sessions v2 (pure SQL, rebuildable). Step 2 of the rebuild.
-- Ported from v1 compute_sessions.sql:
--   adaptive gaps — base 30 min · late night (23:00–06:00) 45 min · in-car 60 min
--   cross-device stitch — platform change with gap < 5 min stays together
-- Extended with SES-01…SES-10 metrics and the §6.2 v2 shape order.
-- Reads plays_resolved (so renamed artists count as one). Safe to re-run.
-- ============================================================

DELETE FROM session_transitions;
DELETE FROM play_sessions;
DELETE FROM sessions;

-- 1. order plays, look back one --------------------------------------------
CREATE OR REPLACE TEMP TABLE _ordered AS
SELECT
    p.play_id,
    p.played_at,                                                                    -- local wall clock
    p.track_id, p.artist_id, p.album_id, p.track_name, p.artist_name,
    p.ms_played, p.platform, p.was_skipped, p.is_first_play,
    -- an interaction is anything other than a track ending and the next starting by itself
    (coalesce(p.start_reason, 'trackdone') <> 'trackdone'
     OR coalesce(p.end_reason, 'trackdone') NOT IN ('trackdone', 'unknown'))     AS is_interaction,
    coalesce(t.duration_ms, t.duration_ms_est)                      AS dur_ms,
    (t.duration_ms IS NOT NULL)                                     AS dur_enriched,
    LAG(p.played_at)                    OVER w                      AS prev_at,
    LAG(p.platform)                     OVER w                      AS prev_platform
FROM plays_resolved p
LEFT JOIN tracks t ON t.track_id = p.track_id
WINDOW w AS (ORDER BY p.played_at, p.play_id);

-- 2. session boundaries (v1 rules) -------------------------------------------
CREATE OR REPLACE TEMP TABLE _flagged AS
SELECT *,
    CASE
        WHEN prev_at IS NULL THEN 1
        WHEN epoch(played_at) - epoch(prev_at) <
             CASE
                 WHEN lower(coalesce(prev_platform, '')) LIKE '%auto%'
                   OR lower(coalesce(prev_platform, '')) LIKE '%car%'   THEN 3600
                 WHEN EXTRACT(hour FROM prev_at) >= 23
                   OR EXTRACT(hour FROM prev_at) < 6                    THEN 2700
                 ELSE 1800
             END THEN 0
        WHEN platform IS DISTINCT FROM prev_platform
         AND epoch(played_at) - epoch(prev_at) < 300 THEN 0
        ELSE 1
    END AS new_session
FROM _ordered;

CREATE OR REPLACE TEMP TABLE _numbered AS
SELECT *,
    SUM(new_session) OVER (ORDER BY played_at, play_id ROWS UNBOUNDED PRECEDING) AS session_no
FROM _flagged;

-- 3. per-play features inside the session -----------------------------------
CREATE OR REPLACE TEMP TABLE _plays0 AS
SELECT *,
    ROW_NUMBER() OVER ws                                                    AS pos,          -- SES-09
    COUNT(*)     OVER (PARTITION BY session_no)                             AS n,
    (track_id IS NOT NULL AND track_id = LAG(track_id) OVER ws)             AS is_repeat,    -- SES-02
    (album_id IS DISTINCT FROM LAG(album_id) OVER ws)                       AS album_changed,
    -- attention: minutes since the last interaction (session start counts as one)
    (epoch(played_at) - epoch(coalesce(
        MAX(CASE WHEN is_interaction THEN played_at END) OVER (PARTITION BY session_no ORDER BY played_at, play_id ROWS UNBOUNDED PRECEDING),
        MIN(played_at) OVER (PARTITION BY session_no)))) / 60.0               AS idle_min
FROM _numbered
WINDOW ws AS (PARTITION BY session_no ORDER BY played_at, play_id);

CREATE OR REPLACE TEMP TABLE _gap AS
SELECT coalesce(TRY_CAST((SELECT value FROM app_meta WHERE key = 'attention_gap_min') AS DOUBLE), 120) AS gap_min;

-- islands: same-album run (SES-07 fallback) and non-skip run (SES-06)
CREATE OR REPLACE TEMP TABLE _plays AS
SELECT *,
    idle_min <= (SELECT gap_min FROM _gap)                                  AS attended,
    SUM(CASE WHEN album_changed THEN 1 ELSE 0 END) OVER ws2                  AS album_run,
    SUM(CASE WHEN was_skipped THEN 1 ELSE 0 END)   OVER ws2                  AS skip_island
FROM _plays0
WINDOW ws2 AS (PARTITION BY session_no ORDER BY pos ROWS UNBOUNDED PRECEDING);

-- longest run of consecutive non-skipped plays (SES-06)
CREATE OR REPLACE TEMP TABLE _runs AS
SELECT session_no, MAX(len) AS longest_unbroken_run
FROM (SELECT session_no, skip_island, COUNT(*) FILTER (WHERE NOT was_skipped) AS len
      FROM _plays GROUP BY 1, 2)
GROUP BY 1;

-- longest same-album run (SES-07 fallback: ≥ 6 consecutive *unskipped* plays from one album —
-- skipping through an album is not riding it)
CREATE OR REPLACE TEMP TABLE _album_runs AS
SELECT session_no, MAX(len) AS longest_album_run
FROM (SELECT session_no, album_run, COUNT(*) FILTER (WHERE NOT was_skipped) AS len
      FROM _plays WHERE album_id IS NOT NULL GROUP BY 1, 2)
GROUP BY 1;

-- artist entropy (SES-04) and top-artist share
CREATE OR REPLACE TEMP TABLE _artist_mix AS
WITH s AS (SELECT session_no, artist_id, COUNT(*) AS c FROM _plays GROUP BY 1, 2),
     t AS (SELECT session_no, SUM(c) AS n FROM s GROUP BY 1)
SELECT s.session_no,
       -SUM((c * 1.0 / n) * log2(c * 1.0 / n)) AS artist_entropy,
       MAX(c) * 1.0 / MAX(n)                  AS top_artist_share
FROM s JOIN t USING (session_no) GROUP BY 1;

-- single-track dominance (comfort loop, one track ≥ 40 % of plays)
CREATE OR REPLACE TEMP TABLE _track_mix AS
SELECT session_no, MAX(c) * 1.0 / SUM(c) AS top_track_share
FROM (SELECT session_no, track_id, COUNT(*) AS c FROM _plays GROUP BY 1, 2)
GROUP BY 1;

-- warm-up test: first third's skip rate vs the rest
CREATE OR REPLACE TEMP TABLE _thirds AS
SELECT session_no,
       AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) FILTER (WHERE pos <= CEIL(n / 3.0)) AS first_third_skip,
       AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) FILTER (WHERE pos >  CEIL(n / 3.0)) AS rest_skip
FROM _plays GROUP BY 1;

CREATE OR REPLACE TEMP TABLE _ids AS
SELECT session_no, uuid() AS session_id FROM (SELECT DISTINCT session_no FROM _plays);

-- 4. aggregate ---------------------------------------------------------------
CREATE OR REPLACE TEMP TABLE _agg AS
SELECT
    i.session_id,
    MIN(p.played_at)                                               AS start_at,
    MAX(p.played_at)                                               AS end_at,
    COUNT(*)                                                       AS track_count,
    SUM(CASE WHEN p.was_skipped THEN 1 ELSE 0 END)                 AS skip_count,
    COUNT(DISTINCT p.artist_id)                                    AS unique_artist_count,
    COUNT(DISTINCT p.track_id)                                     AS unique_track_count,
    SUM(p.ms_played)                                               AS total_ms,
    arg_min(p.platform,   p.played_at)                             AS platform,
    arg_min(p.track_id,   p.played_at)                             AS opening_track_id,
    arg_max(p.track_id,   p.played_at)                             AS closing_track_id,
    arg_min(p.track_name, p.played_at)                             AS opening_track,
    arg_max(p.track_name, p.played_at)                             AS closing_track,
    -- SES-01 completion: real duration → archive estimate → 1 - skip_rate
    AVG(LEAST(p.ms_played * 1.0 / p.dur_ms, 1.0)) FILTER (WHERE p.dur_ms > 0) AS completion_measured,
    AVG(CASE WHEN p.dur_ms > 0 THEN 1.0 ELSE 0 END)                AS completion_coverage,
    AVG(CASE WHEN p.dur_enriched THEN 1.0 ELSE 0 END)              AS enriched_coverage,
    AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END)               AS skip_rate,
    AVG(CASE WHEN p.is_repeat THEN 1.0 ELSE 0 END)                 AS repeat_rate,        -- SES-02
    AVG(CASE WHEN p.is_first_play THEN 1.0 ELSE 0 END)             AS novelty_rate,       -- SES-03
    MAX(am.artist_entropy)                                         AS artist_entropy,     -- SES-04
    MAX(am.top_artist_share)                                       AS top_artist_share,
    MAX(tm.top_track_share)                                        AS top_track_share,
    CAST(epoch(MIN(p.played_at) FILTER (WHERE p.was_skipped)) - epoch(MIN(p.played_at)) AS INTEGER)
                                                                   AS time_to_first_skip_s, -- SES-05
    MAX(r.longest_unbroken_run)                                    AS longest_unbroken_run, -- SES-06
    coalesce(MAX(ar.longest_album_run), 0) >= 6                    AS album_ride,           -- SES-07
    MAX(th.first_third_skip)                                       AS first_third_skip,
    MAX(th.rest_skip)                                              AS rest_skip,
    (epoch(MAX(p.played_at)) - epoch(MIN(p.played_at))) / 60.0     AS duration_min,
    SUM(CASE WHEN p.is_interaction THEN 1 ELSE 0 END)              AS interaction_count,
    SUM(CASE WHEN p.attended THEN p.ms_played ELSE 0 END)          AS attended_ms,
    SUM(CASE WHEN NOT p.attended THEN p.ms_played ELSE 0 END)      AS unattended_ms,
    EXTRACT(hour FROM MIN(p.played_at))                            AS start_hour,
    EXTRACT(dow  FROM MIN(p.played_at))                            AS start_dow
FROM _plays p
JOIN _ids        i  USING (session_no)
JOIN _artist_mix am USING (session_no)
JOIN _track_mix  tm USING (session_no)
JOIN _runs       r  USING (session_no)
LEFT JOIN _album_runs ar USING (session_no)
JOIN _thirds     th USING (session_no)
GROUP BY i.session_id;

INSERT INTO sessions
SELECT
    session_id,
    start_at, end_at,
    track_count, skip_count, unique_artist_count, unique_track_count, total_ms, platform,
    opening_track_id, closing_track_id, opening_track, closing_track,
    -- §6.2 shapes, first match wins
    CASE
        WHEN album_ride                                                        THEN 'album_ride'
        WHEN track_count >= 3 AND (repeat_rate >= 0.25 OR top_track_share >= 0.4) THEN 'comfort_loop'  -- ≥3 plays: owner to confirm
        WHEN novelty_rate >= 0.5 AND track_count >= 6 AND skip_rate < 0.6       THEN 'discovery_run'
        WHEN duration_min >= 90 AND top_artist_share >= 0.6                    THEN 'deep_dive'
        WHEN duration_min >= 180                                               THEN 'binge'
        WHEN first_third_skip >= 2 * coalesce(rest_skip, 0) AND first_third_skip > 0
         AND skip_rate < 0.4 AND track_count >= 6                              THEN 'warm_up'
        WHEN skip_rate >= 0.4                                                  THEN 'restless'
        WHEN duration_min >= 60 AND skip_rate <= 0.1 AND artist_entropy >= 3.0 THEN 'autopilot'
        WHEN artist_entropy >= 2.5 AND track_count >= 8                        THEN 'shuffle_wander'
        ELSE 'steady'
    END AS session_shape,
    coalesce(completion_measured, 1 - skip_rate)                   AS completion_rate,
    CASE WHEN completion_measured IS NULL THEN 'skip_fallback'
         WHEN enriched_coverage >= 0.8     THEN 'duration'
         ELSE 'estimate' END                                       AS completion_source,
    skip_rate, repeat_rate, novelty_rate, artist_entropy, top_artist_share,
    time_to_first_skip_s, longest_unbroken_run, album_ride,
    (start_hour >= 23 OR start_hour < 5)                           AS is_late_night,
    (start_dow IN (0, 6))                                          AS is_weekend,
    CASE                                                           -- SES-08
        WHEN start_hour BETWEEN 5  AND 10 THEN 'morning'
        WHEN start_hour BETWEEN 11 AND 14 THEN 'midday'
        WHEN start_hour BETWEEN 15 AND 19 THEN 'evening'
        WHEN start_hour BETWEEN 20 AND 23 THEN 'night'
        ELSE 'late'
    END AS day_part,
    interaction_count, attended_ms, unattended_ms,
    CASE WHEN unattended_ms = 0                          THEN 'active'
         WHEN unattended_ms < attended_ms                THEN 'drifting'
         ELSE 'unattended' END                          AS attention
FROM _agg;

-- manual session overrides (matched on local start time, ±5 min so rebuilds don't lose them)
UPDATE sessions s SET attention = o.attention, unattended_ms = CASE WHEN o.attention = 'unattended' THEN s.total_ms ELSE 0 END, attended_ms = CASE WHEN o.attention = 'unattended' THEN 0 ELSE s.total_ms END
FROM session_overrides o WHERE abs(epoch(s.start_at) - epoch(o.start_at)) <= 300;
UPDATE _plays SET attended = FALSE FROM _ids i JOIN sessions s ON s.session_id = i.session_id JOIN session_overrides o ON abs(epoch(s.start_at) - epoch(o.start_at)) <= 300
WHERE _plays.session_no = i.session_no AND o.attention = 'unattended';
UPDATE _plays SET attended = TRUE FROM _ids i JOIN sessions s ON s.session_id = i.session_id JOIN session_overrides o ON abs(epoch(s.start_at) - epoch(o.start_at)) <= 300
WHERE _plays.session_no = i.session_no AND o.attention = 'active';

-- write attention back onto plays so every rollup can filter on it
UPDATE plays_resolved SET attended = TRUE, idle_min = NULL;
UPDATE plays_resolved SET attended = x.attended, idle_min = x.idle_min
FROM (SELECT play_id, attended, idle_min FROM _plays) x
WHERE plays_resolved.play_id = x.play_id;

INSERT INTO play_sessions (play_id, session_id, position_in_session)
SELECT p.play_id, i.session_id, p.pos
FROM _plays p JOIN _ids i USING (session_no);

-- SES-10: what follows what, within sessions
INSERT INTO session_transitions (from_track_id, to_track_id, count)
SELECT prev_track, track_id, COUNT(*)
FROM (SELECT session_no, track_id,
             LAG(track_id) OVER (PARTITION BY session_no ORDER BY pos) AS prev_track
      FROM _plays)
WHERE prev_track IS NOT NULL AND track_id IS NOT NULL AND prev_track <> track_id
GROUP BY 1, 2;

DROP TABLE _ordered; DROP TABLE _flagged; DROP TABLE _numbered; DROP TABLE _plays0; DROP TABLE _plays;
DROP TABLE _runs; DROP TABLE _album_runs; DROP TABLE _artist_mix; DROP TABLE _track_mix;
DROP TABLE _thirds; DROP TABLE _ids; DROP TABLE _agg; DROP TABLE _gap;

INSERT INTO app_meta (key, value) VALUES ('last_sessions_rebuild', CAST(now() AS VARCHAR))
ON CONFLICT (key) DO UPDATE SET value = excluded.value;
