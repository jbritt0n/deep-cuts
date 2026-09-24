-- ============================================================
-- Phase 9i — demo enrichment, run AFTER entity_resolution.sql and BEFORE compute_sessions / scenes / insights.
-- Stand-ins for what the connectors would fetch (tags, listeners, origins, lyric and audio features, playlists,
-- MusicBrainz matches), shaped like the real thing and clearly invented. The same file seeds scripts/seed_dev_db.py.
-- ============================================================
CREATE TEMP TABLE _demo_artists (name VARCHAR, tags VARCHAR[], weights DOUBLE[], listeners BIGINT, cc VARCHAR, country_name VARCHAR, city VARCHAR);
INSERT INTO _demo_artists VALUES
 ('floating points', ['electronic', 'ambient'], [0.9, 0.5], 600000, 'GB', 'United Kingdom', 'Manchester'),
 ('little simz', ['hip-hop'], [0.95], 850000, 'GB', 'United Kingdom', 'London'),
 ('mitski', ['indie rock', 'indie'], [0.9, 0.6], 1900000, 'US', 'United States', 'New York'),
 ('khruangbin', ['psychedelic', 'funk'], [0.8, 0.5], 1300000, 'US', 'United States', 'Houston'),
 ('king gizzard & the lizard wizard', ['psychedelic rock', 'garage rock'], [0.95, 0.6], 900000, 'AU', 'Australia', 'Melbourne'),
 ('tatsuro yamashita', ['city pop', 'japanese'], [0.95, 0.8], 400000, 'JP', 'Japan', 'Tokyo'),
 ('arooj aftab', [], [], 120000, 'PK', 'Pakistan', 'Lahore'),              -- no tags on purpose: the Crate's "unsorted" example
 ('yaeji', ['house', 'electronic'], [0.8, 0.6], 350000, 'KR', 'South Korea', 'Seoul'),
 ('hania rani', ['contemporary classical', 'piano'], [0.9, 0.7], 210000, 'PL', 'Poland', 'Gdańsk'),
 ('sault', ['soul', 'funk'], [0.8, 0.6], 220000, 'GB', 'United Kingdom', 'London'),
 ('altın gün', ['anatolian rock', 'turkish', 'psychedelic'], [0.95, 0.9, 0.5], 160000, 'NL', 'Netherlands', 'Amsterdam'),
 ('radiohead', ['indie rock', 'electronic'], [0.7, 0.4], 6100000, 'GB', 'United Kingdom', 'Oxford'),
 ('beach house', ['dream pop', 'shoegaze'], [0.95, 0.5], 2400000, 'US', 'United States', 'Baltimore'),
 ('nils frahm', ['contemporary classical', 'ambient'], [0.9, 0.6], 700000, 'DE', 'Germany', 'Berlin'),
 ('men i trust', ['indie pop', 'dream pop'], [0.9, 0.5], 800000, 'CA', 'Canada', 'Montréal'),
 ('raffaella carrà', ['italian pop', 'disco'], [0.9, 0.6], 450000, 'IT', 'Italy', 'Bologna'),
 ('duman', ['turkish rock', 'turkish'], [0.9, 0.8], 380000, 'TR', 'Türkiye', 'Istanbul'),
 ('barış manço', ['anatolian rock', 'turkish'], [0.9, 0.8], 420000, 'TR', 'Türkiye', 'Istanbul');

INSERT INTO artist_tags (artist_id, tag, weight, source)
SELECT 'name:' || a.name, a.tags[k], a.weights[k], 'lastfm' FROM _demo_artists a, range(1, 6) r(k) WHERE k <= len(a.tags) ON CONFLICT DO NOTHING;
INSERT INTO artist_popularity (artist_id, listeners, playcount) SELECT 'name:' || name, listeners, listeners * 40 FROM _demo_artists ON CONFLICT DO NOTHING;
-- listener history: two monthly snapshots with movement (Rising and fading), plus today's
INSERT INTO artist_popularity_history (artist_id, listeners, playcount, snapshot_at)
SELECT 'name:' || name, CAST(listeners * f AS BIGINT), CAST(listeners * 40 * f AS BIGINT), now() - INTERVAL (d) DAY
FROM _demo_artists, (VALUES (60, 0.0), (30, 1.0)) v(d, k),
     LATERAL (SELECT CASE WHEN name IN ('arooj aftab', 'yaeji') THEN (CASE WHEN k = 0 THEN 0.66 ELSE 0.82 END) WHEN name = 'radiohead' THEN (CASE WHEN k = 0 THEN 1.3 ELSE 1.15 END) ELSE (CASE WHEN k = 0 THEN 0.9 ELSE 0.95 END) END AS f);
INSERT INTO artist_popularity_history (artist_id, listeners, playcount) SELECT 'name:' || name, listeners, listeners * 40 FROM _demo_artists;
INSERT INTO artist_origin (artist_id, country, country_name, city, source) SELECT 'name:' || name, cc, country_name, city, 'demo' FROM _demo_artists ON CONFLICT DO NOTHING;
-- MusicBrainz match evidence, so the metadata panel shows each state (invented ids)
INSERT INTO artist_mb_match (artist_id, mbid, method, evidence, candidates)
SELECT 'name:' || name, substr(md5(name), 1, 8) || '-' || substr(md5(name), 9, 4) || '-' || substr(md5(name), 13, 4) || '-' || substr(md5(name), 17, 4) || '-' || substr(md5(name), 21, 12),
       CASE WHEN name = 'duman' THEN 'albums' WHEN name = 'sault' THEN 'name' ELSE 'isrc' END,
       CASE WHEN name = 'duman' THEN '2 of your 2 album titles' WHEN name = 'sault' THEN 'the only exact-name match' ELSE 'demo ISRC' END,
       CASE WHEN name = 'duman' THEN 3 ELSE 0 END
FROM _demo_artists ON CONFLICT DO NOTHING;
UPDATE artists SET mbid = m.mbid FROM artist_mb_match m WHERE m.artist_id = artists.artist_id;
-- album listeners: a share of the artist's, smaller for later/rarer albums
INSERT INTO album_popularity (album_id, listeners, playcount, found)
SELECT al.album_id, CAST(ap.listeners * (0.08 + (hash(al.album_id) % 60) / 100.0) AS BIGINT), CAST(ap.listeners * 12 AS BIGINT), TRUE
FROM albums al JOIN artist_popularity ap ON ap.artist_id = al.artist_id ON CONFLICT DO NOTHING;
DROP TABLE _demo_artists;

-- lyric features for the 120 most-played tracks: a quarter still on the old rules (the "re-analysing" state), Turkish
-- tracks in Turkish (the language chips), a shared filler word in every English song (never a keyword)
CREATE TEMP TABLE _top AS SELECT track_id, arg_max(artist_id, ms_played) AS artist_id, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, track_id) - 1 AS i FROM plays_resolved WHERE track_id IS NOT NULL GROUP BY 1 QUALIFY i < 120;
CREATE TEMP TABLE _w AS SELECT ['night', 'river', 'gold', 'shadow', 'summer', 'home', 'fire', 'window', 'heart', 'city', 'rain', 'stranger', 'light', 'road', 'ocean', 'ghost', 'silver', 'dance', 'morning', 'fever', 'garden', 'mirror', 'letter', 'train', 'smoke', 'wire', 'winter', 'radio', 'harbour', 'ember'] AS en,
                                  ['gece', 'yol', 'deniz', 'kalp', 'rüzgar', 'şehir', 'yağmur', 'ay', 'ateş', 'sokak'] AS tr,
                                  ['night', 'rain', 'the city', 'dancing & party', 'romance', 'heartbreak', 'the road', 'home'] AS th;
INSERT INTO track_lyric_features (track_id, source, found, word_count, keywords, themes, colours, lang, features_rev, theme_scores, valence, repetition, vocab, llm_themes, llm_mood)
SELECT t.track_id, 'demo', TRUE, 200,
       CASE WHEN a.artist_id IN ('name:duman', 'name:barış manço') THEN [w.tr[i % 10 + 1], w.tr[(i + 3) % 10 + 1]] ELSE [w.en[(i * 7) % 30 + 1], w.en[(i * 7 + 3) % 30 + 1], w.en[(i * 7 + 6) % 30 + 1]] END,
       CASE WHEN a.artist_id IN ('name:duman', 'name:barış manço') THEN []::VARCHAR[] ELSE [w.th[i % 8 + 1], w.th[(i + 1) % 8 + 1]] END, []::VARCHAR[],
       CASE WHEN a.artist_id IN ('name:duman', 'name:barış manço') THEN 'tr' ELSE 'en' END,
       CASE WHEN i % 4 = 3 THEN 1 ELSE 2 END,
       CASE WHEN a.artist_id IN ('name:duman', 'name:barış manço') OR i % 4 = 3 THEN NULL ELSE json_object(w.th[i % 8 + 1], 4.0 + (i % 3) * 0.4, w.th[(i + 1) % 8 + 1], 2.7 + (i % 3) * 0.4, w.th[(i + 2) % 8 + 1], 1.4) END,
       CASE WHEN a.artist_id IN ('name:duman', 'name:barış manço') THEN NULL ELSE round(((i * 37) % 200) / 100.0 - 1, 2) END, round(0.2 + (i % 7) / 10.0, 3), 40 + i,
       CASE WHEN i % 2 = 0 AND i % 4 <> 3 THEN [['late-night driving', 'lost love', 'city loneliness'][i % 3 + 1]] END,
       CASE WHEN i % 2 = 0 AND i % 4 <> 3 THEN ['wistful, warm', 'restless', 'bleak but tender', 'euphoric'][i % 4 + 1] END
FROM _top t LEFT JOIN artists a ON a.artist_id = t.artist_id CROSS JOIN _w w ON CONFLICT DO NOTHING;
INSERT INTO track_lyric_terms (track_id, term, tf)
SELECT t.track_id, 'love', 6 + t.i % 5 FROM _top t JOIN track_lyric_features f USING (track_id) WHERE f.lang = 'en' AND f.features_rev = 2
UNION ALL SELECT f.track_id, f.keywords[n], 5 - n + (t.i % 2) FROM track_lyric_features f JOIN _top t USING (track_id), range(1, 4) r(n) WHERE f.features_rev = 2 AND n <= len(f.keywords)
ON CONFLICT DO NOTHING;
-- the Turkish trip songs, in Turkish, so Insights → Lyric keywords has a second language to switch to
INSERT INTO track_lyric_features (track_id, source, found, word_count, keywords, themes, colours, lang, features_rev, repetition, vocab)
SELECT t.track_id, 'demo', TRUE, 180, [w.tr[k % 10 + 1], w.tr[(k + 4) % 10 + 1], w.tr[(k + 7) % 10 + 1]], []::VARCHAR[], []::VARCHAR[], 'tr', 2, 0.3, 50
FROM (SELECT t.track_id, ROW_NUMBER() OVER (ORDER BY t.track_id) AS k FROM tracks t JOIN artists a USING (artist_id) WHERE a.artist_id IN ('name:duman', 'name:barış manço')) t CROSS JOIN _w w
ON CONFLICT DO NOTHING;
INSERT INTO track_lyric_terms (track_id, term, tf)
SELECT f.track_id, f.keywords[n], 6 - n FROM track_lyric_features f, range(1, 4) r(n) WHERE f.lang = 'tr' AND n <= len(f.keywords) ON CONFLICT DO NOTHING;
DROP TABLE _w;

-- audio features for the 160 most-played tracks (every ninth one "not in the catalogue")
CREATE TEMP TABLE _ft AS SELECT track_id, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, track_id) - 1 AS i FROM plays_resolved WHERE track_id IS NOT NULL GROUP BY 1 QUALIFY i < 160;
INSERT INTO track_features (track_id, bpm, key_name, key_int, mode, camelot, energy, loudness_db, danceability, valence, time_signature, acousticness, feature_source, found)
SELECT track_id,
       CASE WHEN i % 9 = 8 THEN NULL ELSE 68 + (i * 13) % 105 END,
       CASE WHEN i % 9 = 8 THEN NULL ELSE ['C major', 'G major', 'D major', 'A minor', 'E minor', 'F# minor', 'Bb major', 'F major', 'C# minor', 'Eb major', 'B minor', 'G minor'][(i * 7) % 12 + 1] END,
       CASE WHEN i % 9 = 8 THEN NULL ELSE (i * 7) % 12 END,
       CASE WHEN i % 9 = 8 THEN NULL WHEN (i * 7) % 12 IN (3, 4, 5, 8, 10, 11) THEN 0 ELSE 1 END,
       CASE WHEN i % 9 = 8 THEN NULL ELSE ['8B', '9B', '10B', '8A', '9A', '11A', '6B', '7B', '12A', '5B', '10A', '6A'][(i * 7) % 12 + 1] END,
       CASE WHEN i % 9 = 8 THEN NULL ELSE round(0.15 + ((i * 29) % 80) / 100.0, 2) END,
       CASE WHEN i % 9 = 8 THEN NULL ELSE round(-16 + ((i * 11) % 12), 1) END,
       CASE WHEN i % 9 = 8 THEN NULL ELSE round(0.3 + ((i * 17) % 60) / 100.0, 2) END,
       CASE WHEN i % 9 = 8 THEN NULL ELSE round(((i * 23) % 100) / 100.0, 2) END, 4,
       CASE WHEN i % 9 = 8 THEN NULL ELSE round(((i * 31) % 90) / 100.0, 2) END,
       CASE WHEN i % 9 = 8 THEN 'name' ELSE 'isrc' END, i % 9 <> 8
FROM _ft ON CONFLICT DO NOTHING;
DROP TABLE _ft; DROP TABLE _top;

-- playlists: one fully synced, one partly synced, one Spotify-made (unreadable) — every Library state
INSERT INTO playlists (playlist_id, name, description, owner_is_me, owner_id, track_count, snapshot_id, public, items_synced_at, items_snapshot_id, sync_error) VALUES
 ('devpl1', 'Sunday slow', 'demo', TRUE, 'me', 20, 's1', FALSE, now(), 's1', NULL),
 ('devpl2', 'Long drives (partly synced)', 'demo', TRUE, 'me', 40, 's2', FALSE, now(), 's1', NULL),
 ('devpl3', 'Discover Weekly', 'demo', FALSE, 'spotify', 30, 's3', FALSE, NULL, NULL, 'unreadable: Spotify-made playlists are closed to third-party apps')
ON CONFLICT DO NOTHING;
INSERT INTO playlist_items (playlist_id, track_id, added_at, position)
SELECT CASE WHEN i < 20 THEN 'devpl1' ELSE 'devpl2' END, track_id, now() - INTERVAL (CASE WHEN i < 20 THEN 400 ELSE 200 END) DAY, CASE WHEN i < 20 THEN i ELSE i - 20 END
FROM (SELECT track_id, ROW_NUMBER() OVER (ORDER BY COUNT(*) DESC, track_id) - 1 AS i FROM plays_resolved WHERE track_id IS NOT NULL AND track_id NOT LIKE 'local:%' GROUP BY 1 QUALIFY i < 35);

-- catalogue sizes (≈ 3× the songs heard) and a couple of feature credits (Dig Deeper, Superlatives)
UPDATE artists SET catalogue_tracks = 3 * (SELECT COUNT(DISTINCT track_id) FROM plays_resolved p WHERE p.artist_id = artists.artist_id), catalogue_fetched_at = now();
INSERT INTO track_credits (track_id, artist_id, artist_name, credit_order)
SELECT t.track_id, t.artist_id, a.name, 0 FROM tracks t JOIN artists a USING (artist_id) WHERE t.track_id NOT LIKE 'local:%' ORDER BY t.track_id LIMIT 6 ON CONFLICT DO NOTHING;
INSERT INTO track_credits (track_id, artist_id, artist_name, credit_order)
SELECT x.track_id, o.artist_id, o.name, 1
FROM (SELECT t.track_id, t.artist_id, ROW_NUMBER() OVER (ORDER BY t.track_id) AS k FROM tracks t WHERE t.track_id NOT LIKE 'local:%' ORDER BY t.track_id LIMIT 6) x
JOIN (SELECT artist_id, name, ROW_NUMBER() OVER (ORDER BY name) AS k FROM artists) o ON o.k = x.k AND o.artist_id <> x.artist_id ON CONFLICT DO NOTHING;
