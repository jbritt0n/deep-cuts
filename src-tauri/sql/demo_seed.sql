-- ============================================================
-- Deep Cuts — demo data generator (pure SQL). Ported verbatim from v1 (NFR-06).
-- Builds ~3 years of realistic synthetic listening history so every
-- page has something to show before your Spotify export arrives.
-- Session-first generation gives real-looking sessions, skips,
-- commute/late-night patterns, and a few marathon days.
-- ============================================================

-- A fixed seed makes demo data identical on every machine / rerun.
SELECT setseed(0.4242);

CREATE OR REPLACE TEMP TABLE _artists AS
SELECT * FROM (VALUES
    ('King Gizzard & The Lizard Wizard', 'Nonagon Infinity',     30, 'android'),
    ('Mitski',                           'Laurel Hell',          22, 'android'),
    ('Khruangbin',                       'Mordechai',            21, 'windows'),
    ('Tatsuro Yamashita',                'For You',              15, 'android'),
    ('Radiohead',                        'In Rainbows',          14, 'windows'),
    ('Little Simz',                      'Sometimes I Might Be', 11, 'android'),
    ('Nils Frahm',                       'All Melody',           10, 'windows'),
    ('Altın Gün',                        'Yol',                   8, 'android_auto'),
    ('Sault',                            'Nine',                  7, 'android'),
    ('Beach House',                      'Once Twice Melody',     7, 'windows'),
    ('Floating Points',                  'Promises',              5, 'windows'),
    ('Arooj Aftab',                      'Vulture Prince',        4, 'android'),
    ('Yaeji',                            'With A Hammer',         4, 'android'),
    ('Men I Trust',                      'Untourable Album',      6, 'android_auto'),
    ('Hania Rani',                       'Ghosts',                5, 'windows')
) t(artist_name, album_name, weight, fav_platform);

CREATE OR REPLACE TEMP TABLE _aw AS
SELECT *,
    SUM(weight) OVER (ORDER BY artist_name ROWS UNBOUNDED PRECEDING) AS cum,
    SUM(weight) OVER ()                                              AS total
FROM _artists;

-- ~2,200 sessions across the last 3 years
CREATE OR REPLACE TEMP TABLE _sessions AS
WITH base AS (
    SELECT
        i,
        random()  AS r_day,
        random()  AS r_hour,
        random()  AS r_len,
        random()  AS r_art,
        random()  AS r_sticky,
        random()  AS r_plat
    FROM range(2200) t(i)
),
shaped AS (
    SELECT
        i,
        -- day within the last 3 years, gentle upward trend (more recent = slightly more)
        CAST(now() - INTERVAL 1 DAY - CAST(FLOOR(POW(r_day, 1.15) * 1095) AS INTEGER) * INTERVAL 1 DAY AS DATE) AS day,
        -- hour-of-day: commute peaks, evening, late-night tail
        CAST(CASE
            WHEN r_hour < 0.16 THEN 7  + FLOOR(random() * 3)    -- 7–9   morning
            WHEN r_hour < 0.30 THEN 12 + FLOOR(random() * 2)    -- 12–13 lunch
            WHEN r_hour < 0.55 THEN 17 + FLOOR(random() * 4)    -- 17–20 evening
            WHEN r_hour < 0.78 THEN 21 + FLOOR(random() * 3)    -- 21–23 night
            WHEN r_hour < 0.90 THEN FLOOR(random() * 3)         -- 0–2   late
            ELSE FLOOR(random() * 24)
        END AS INTEGER) AS hour,
        -- session length: mostly 4–14 tracks, occasional marathons
        CAST(CASE WHEN r_len > 0.96 THEN 40 + FLOOR(random() * 45)
             WHEN r_len > 0.80 THEN 15 + FLOOR(random() * 15)
             ELSE 3 + FLOOR(random() * 12) END AS INTEGER) AS n_tracks,
        r_art, r_sticky, r_plat
    FROM base
)
SELECT
    i,
    day + (hour * INTERVAL 1 HOUR) + (CAST(FLOOR(random() * 60) AS INTEGER) * INTERVAL 1 MINUTE) AS start_at,
    n_tracks,
    (SELECT artist_name FROM _aw WHERE cum >= r_art * total ORDER BY cum LIMIT 1) AS lead_artist,
    r_sticky < 0.55 AS sticky,       -- 55% of sessions are mostly one artist
    CASE WHEN r_plat < 0.62 THEN 'android'
         WHEN r_plat < 0.88 THEN 'windows'
         ELSE 'android_auto' END AS platform
FROM shaped;

-- expand to tracks
CREATE OR REPLACE TEMP TABLE _plays AS
WITH expanded AS (
    SELECT s.*, j, random() AS r_pick, random() AS r_stick2
    FROM _sessions s, range(s.n_tracks) t(j)
),
with_artist AS (
    SELECT
        e.*,
        CASE WHEN e.sticky AND e.r_stick2 < 0.8 THEN e.lead_artist
             ELSE (SELECT artist_name FROM _aw WHERE cum >= e.r_pick * total ORDER BY cum LIMIT 1)
        END AS artist_name,
        random() AS r_skip,
        random() AS r_track
    FROM expanded e
)
SELECT
    w.start_at + (CAST(w.j AS INTEGER) * INTERVAL 218 SECOND) + (CAST(FLOOR(random() * 20) AS INTEGER) * INTERVAL 1 SECOND) AS played_at,
    w.artist_name,
    a.album_name,
    -- invented track titles from word lists (deterministic per artist+slot)
    (['Velvet', 'Paper', 'Static', 'Amber', 'Hollow', 'Neon', 'Quiet', 'Copper', 'Glass', 'Salt'])
        [1 + (hash(w.artist_name || CAST(FLOOR(w.r_track * 14) AS VARCHAR)) % 10)::INT] || ' ' ||
    (['Tide', 'Signal', 'Orbit', 'Garden', 'Motor', 'Harbor', 'Lantern', 'Compass', 'Meridian', 'Static', 'Weather', 'Ceiling'])
        [1 + ((hash(w.artist_name || CAST(FLOOR(w.r_track * 14) AS VARCHAR)) / 7) % 12)::INT] AS track_name,
    substr(md5(w.artist_name || CAST(FLOOR(w.r_track * 14) AS VARCHAR)), 1, 22) AS spotify_track_id,
    CAST(CASE WHEN w.r_skip < 0.12 THEN 4000 + FLOOR(random() * 22000)
         ELSE 150000 + FLOOR(random() * 110000) END AS BIGINT) AS ms_played,
    CASE WHEN w.r_skip < 0.12 THEN 'fwdbtn' ELSE 'trackdone' END AS end_reason,
    w.platform
FROM with_artist w
JOIN _artists a USING (artist_name);

INSERT INTO events (event_type, occurred_at, payload, source_file)
SELECT
    'play',
    played_at,
    json_object(
        'spotify_track_id', spotify_track_id,
        'track_name',       track_name,
        'artist_name',      artist_name,
        'album_name',       album_name,
        'ms_played',        ms_played,
        'platform',         platform,
        'end_reason',       end_reason,
        'source',           'demo'
    ),
    'demo_seed'
FROM _plays
WHERE played_at < now();

DROP TABLE _artists; DROP TABLE _aw; DROP TABLE _sessions; DROP TABLE _plays;
