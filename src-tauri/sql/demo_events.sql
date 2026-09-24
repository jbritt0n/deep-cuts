-- ============================================================
-- Phase 9i — extra demo plays, run after demo_seed.sql and BEFORE entity_resolution.sql.
-- Gives a first-time user (and the dev harness) every newer feature to look at before they import anything:
-- a record to rediscover and two abandoned ones (Daily Dig / The Crate), trips to Italy and Türkiye with local
-- artists (Atlas → Listening abroad), and home plays marked with a country. Deterministic: same demo every install.
-- ============================================================
UPDATE events SET payload = json_merge_patch(payload, '{"country": "US"}')
WHERE event_type = 'play' AND json_extract_string(payload, '$.country') IS NULL;

CREATE TEMP TABLE _demo_plays AS
WITH spec AS (
  SELECT 520 + (i % 6) AS d, 'Rediscover cut ' || (i % 8 + 1) AS track, 'The Rediscover Band' AS artist, 'Loved And Left' AS album, 'US' AS cc, i FROM range(24) r(i)
  UNION ALL SELECT 260, 'One listen ' || (i + 1), 'Pulled Once', 'Left On The Shelf', 'US', i FROM range(2) r(i)
  UNION ALL SELECT 180, 'Only track', 'Solo Pull', 'Never Returned', 'US', 0
  UNION ALL SELECT 1100 - (i % 9), ['Tanti auguri', 'A far l''amore comincia tu', 'Rumore', 'Pedro'][i % 4 + 1], 'Raffaella Carrà', 'Raffica di Raffaella', 'IT', i FROM range(40) r(i)
  UNION ALL SELECT 1100 - (i % 9), 'Tatsuro cut', 'Tatsuro Yamashita', 'For You', 'IT', i FROM range(12) r(i)
  UNION ALL SELECT t - (i % 12), ['Bu akşam', 'Senden daha güzel', 'Istanbul', 'Her şeyi yak'][i % 4 + 1], 'Duman', 'Belki Alışman Lazım', 'TR', i FROM range(55) r(i), (VALUES (760), (400)) v(t)
  UNION ALL SELECT t - (i % 12), ['Gülpembe', 'Dönence'][i % 2 + 1], 'Barış Manço', 'Sarı Çizmeli Mehmet Ağa', 'TR', i FROM range(20) r(i), (VALUES (760), (400)) v(t)
  UNION ALL SELECT t - (i % 12), 'Mitski cut', 'Mitski', 'Be the Cowboy', 'TR', i FROM range(15) r(i), (VALUES (760), (400)) v(t)
  UNION ALL SELECT 30, 'Duman at home', 'Duman', 'Belki Alışman Lazım', 'US', i FROM range(3) r(i)
)
SELECT *, 'dev_' || CAST(hash(track) % 100000000 AS VARCHAR) AS tid FROM spec;

INSERT INTO events (event_type, occurred_at, payload, source_file)
SELECT 'play',
       now() - INTERVAL (d) DAY - INTERVAL (CAST(hash(track) % 400 AS INTEGER) + i * 7) MINUTE,   -- distinct minutes so ingest dedupe keeps every play
       json_object('country', cc, 'spotify_track_uri', 'spotify:track:' || tid, 'spotify_track_id', tid, 'track_name', track, 'artist_name', artist,
                   'album_name', album, 'ms_played', 210000, 'platform', 'linux', 'end_reason', 'trackdone', 'start_reason', 'clickrow', 'shuffle', false, 'source', 'extended_export'),
       'demo-seed'
FROM _demo_plays;
DROP TABLE _demo_plays;
