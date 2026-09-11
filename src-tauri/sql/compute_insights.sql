-- ============================================================
-- Insights cache (spec §7, nightly). Rebuilds `insights` for the dashboard's
-- "unseen" row; keeps `surfaced`. Also rebuilds scenes (tag clusters).
-- ============================================================
CREATE OR REPLACE TEMP TABLE _surf AS SELECT kind, subject_type, subject_id, period_start FROM insights WHERE surfaced;
DELETE FROM insights;

-- ---- scenes: a small fixed vocabulary of tag families → scene; artist joins scenes by tag weight
DELETE FROM artist_scene;
CREATE OR REPLACE TEMP TABLE _scene_map AS SELECT * FROM (VALUES
 ('afrobeat','afro'),('afro-funk','afro'),('afrofunk','afro'),('highlife','afro'),('ethio-jazz','afro'),('ethiopian','afro'),('zamrock','afro'),('african','afro'),('nigerian','afro'),('ghanaian','afro'),('desert blues','afro'),('tuareg','afro'),('mbalax','afro'),('soukous','afro'),
 ('turkish','turkish'),('anatolian rock','turkish'),('turkish psychedelic','turkish'),('arabesk','turkish'),('turkish pop','turkish'),('turkish folk','turkish'),
 ('japanese','japanese'),('j-pop','japanese'),('city pop','japanese'),('shamisen','japanese'),('enka','japanese'),('shibuya-kei','japanese'),('j-rock','japanese'),
 ('post-punk','post-punk'),('new wave','post-punk'),('coldwave','post-punk'),('darkwave','post-punk'),('synth-pop','post-punk'),('gothic rock','post-punk'),
 ('shoegaze','dream'),('dream pop','dream'),('ethereal','dream'),('slowcore','dream'),
 ('psychedelic','psych'),('psychedelic rock','psych'),('neo-psychedelia','psych'),('krautrock','psych'),('space rock','psych'),('garage rock','psych'),('garage psych','psych'),
 ('hip-hop','hip-hop'),('trip-hop','hip-hop'),('instrumental hip-hop','hip-hop'),('boom bap','hip-hop'),('abstract hip-hop','hip-hop'),
 ('jazz','jazz'),('jazz fusion','jazz'),('spiritual jazz','jazz'),('bebop','jazz'),('hard bop','jazz'),('cool jazz','jazz'),('nu jazz','jazz'),
 ('funk','funk-soul'),('soul','funk-soul'),('neo-soul','funk-soul'),('northern soul','funk-soul'),('disco','funk-soul'),('boogie','funk-soul'),
 ('electronic','electronic'),('house','electronic'),('techno','electronic'),('idm','electronic'),('ambient','electronic'),('downtempo','electronic'),('electro','electronic'),('nu disco','electronic'),
 ('indie rock','indie'),('indie pop','indie'),('indie folk','indie'),('lo-fi','indie'),('bedroom pop','indie'),('slacker rock','indie'),
 ('folk','folk'),('singer-songwriter','folk'),('americana','folk'),('alt-country','folk'),('country','folk'),('bluegrass','folk'),
 ('metal','metal'),('industrial','metal'),('heavy metal','metal'),('doom metal','metal'),('sludge','metal'),('post-metal','metal'),('industrial metal','metal'),
 ('reggae','caribbean'),('dub','caribbean'),('ska','caribbean'),('rocksteady','caribbean'),('calypso','caribbean'),('dancehall','caribbean'),('soca','caribbean'),
 ('latin','latin'),('cumbia','latin'),('bossa nova','latin'),('samba','latin'),('tropicalia','latin'),('salsa','latin'),('mpb','latin'),('brazilian','latin'),
 ('classical','classical'),('baroque','classical'),('contemporary classical','classical'),('minimalism','classical'),('piano','classical'),('soundtrack','classical'),('film score','classical'),
 ('punk','punk'),('punk rock','punk'),('hardcore','punk'),('post-hardcore','punk'),('emo','punk'),('pop punk','punk'),
 ('classic rock','classic-rock'),('blues rock','classic-rock'),('hard rock','classic-rock'),('progressive rock','classic-rock'),('blues','classic-rock'),('southern rock','classic-rock')
) v(tag, scene);
INSERT INTO artist_scene
SELECT t.artist_id, m.scene, SUM(t.weight) AS w FROM artist_tags t JOIN _scene_map m USING (tag) GROUP BY 1, 2 HAVING SUM(t.weight) >= 0.3;
-- origin-based scenes when tags are missing
INSERT INTO artist_scene
SELECT o.artist_id, CASE o.country WHEN 'TR' THEN 'turkish' WHEN 'JP' THEN 'japanese' WHEN 'NG' THEN 'afro' WHEN 'GH' THEN 'afro' WHEN 'ET' THEN 'afro' WHEN 'ML' THEN 'afro' WHEN 'ZM' THEN 'afro' WHEN 'SN' THEN 'afro' WHEN 'BR' THEN 'latin' WHEN 'JM' THEN 'caribbean' END, 0.5
FROM artist_origin o WHERE o.country IN ('TR','JP','NG','GH','ET','ML','ZM','SN','BR','JM')
  AND NOT EXISTS (SELECT 1 FROM artist_scene s WHERE s.artist_id = o.artist_id);

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
DROP TABLE _surf; DROP TABLE _scene_map;
INSERT INTO app_meta (key, value) VALUES ('last_insights', CAST(now() AS VARCHAR)) ON CONFLICT (key) DO UPDATE SET value = excluded.value;
