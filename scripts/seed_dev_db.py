"""Build dev-data/deep-cuts.duckdb from the demo seed (no export needed), plus a handful of
Heard-in-the-Wild captures, so `npm run dev:browser` and the smoke scripts have data.
   pip install duckdb ; python3 scripts/seed_dev_db.py
Use scripts/validate_sql.py instead when you have a real Spotify export."""
import duckdb, json, os, pathlib, random, datetime as dt
from zoneinfo import ZoneInfo
ROOT = pathlib.Path(__file__).resolve().parents[1]; SQL = ROOT / 'src-tauri' / 'sql'; rd = lambda n: (SQL / n).read_text()
DB = ROOT / 'dev-data' / 'deep-cuts.duckdb'; DB.parent.mkdir(exist_ok=True)
if DB.exists(): DB.unlink()
ZONE = os.environ.get('DEEPCUTS_TZ', 'America/Detroit')
con = duckdb.connect(str(DB)); con.execute("SET TimeZone='UTC'"); con.execute(rd('schema.sql'))
z = ZoneInfo(ZONE); rows = []; prev = None; t = dt.datetime(2010, 1, 1, tzinfo=dt.timezone.utc)
while t < dt.datetime(2031, 1, 1, tzinfo=dt.timezone.utc):
    off = int(t.astimezone(z).utcoffset().total_seconds())
    if off != prev: rows.append((t.replace(tzinfo=None), off, ZONE)); prev = off
    t += dt.timedelta(hours=1)
con.executemany("INSERT INTO tz_offsets VALUES (?,?,?)", rows)
con.execute("INSERT INTO app_meta (key,value) VALUES ('timezone',?) ON CONFLICT (key) DO UPDATE SET value=excluded.value", [ZONE])
con.execute(rd('demo_seed.sql'))
# Phase 9f dev stand-ins for the Daily Dig: a record loved and dropped (rediscover) and two pulled once and left (abandoned).
def dev_play(days_ago, track, artist, album, ms=210000):
    payload = json.dumps({"spotify_track_uri": f"spotify:track:dev_{abs(hash(track)) % 10**8}", "spotify_track_id": f"dev_{abs(hash(track)) % 10**8}", "track_name": track, "artist_name": artist, "album_name": album, "ms_played": ms, "platform": "linux", "end_reason": "trackdone", "start_reason": "clickrow", "shuffle": False, "source": "extended_export"})
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', now() - INTERVAL (?) DAY - INTERVAL (?) MINUTE, CAST(? AS JSON), 'dev-seed')", [days_ago, abs(hash(track)) % 600, payload])
for i in range(24): dev_play(520 + (i % 6), f"Rediscover cut {i % 8 + 1}", "The Rediscover Band", "Loved And Left")
for i in range(2): dev_play(260, f"One listen {i + 1}", "Pulled Once", "Left On The Shelf")
dev_play(180, "Only track", "Solo Pull", "Never Returned")
con.execute(rd('entity_resolution.sql'))
# Phase 9b dev-only enrichment stand-ins, so genre threads and The Crate have data before any connector runs.
# Tags follow the scene vocabulary in scene_tag_map (schema.sql); listener counts are invented but shaped like Last.fm's.
TAGS = {'floating points': [('electronic', .9), ('ambient', .5)], 'little simz': [('hip-hop', .95)], 'mitski': [('indie rock', .9), ('indie', .6)], 'khruangbin': [('psychedelic', .8), ('funk', .5)],
        'king gizzard & the lizard wizard': [('psychedelic rock', .95), ('garage rock', .6)], 'tatsuro yamashita': [('city pop', .95), ('japanese', .8)], 'arooj aftab': [('jazz', .5), ('folk', .4)],
        'yaeji': [('house', .8), ('electronic', .6)], 'hania rani': [('contemporary classical', .9), ('piano', .7)], 'sault': [('soul', .8), ('funk', .6)], 'altın gün': [('anatolian rock', .95), ('turkish', .9), ('psychedelic', .5)],
        'radiohead': [('indie rock', .7), ('electronic', .4)], 'beach house': [('dream pop', .95), ('shoegaze', .5)], 'nils frahm': [('contemporary classical', .9), ('ambient', .6)], 'men i trust': [('indie pop', .9), ('dream pop', .5)]}
POP = {'radiohead': 6_100_000, 'beach house': 2_400_000, 'mitski': 1_900_000, 'khruangbin': 1_300_000, 'king gizzard & the lizard wizard': 900_000, 'little simz': 850_000, 'floating points': 600_000, 'nils frahm': 700_000,
       'men i trust': 800_000, 'yaeji': 350_000, 'sault': 220_000, 'tatsuro yamashita': 400_000, 'altın gün': 160_000, 'hania rani': 210_000, 'arooj aftab': 120_000}
for a, tags in TAGS.items():
    for t, w in tags: con.execute("INSERT INTO artist_tags (artist_id, tag, weight, source) VALUES (?, ?, ?, 'lastfm') ON CONFLICT DO NOTHING", [f'name:{a}', t, w])
for a, n in POP.items():
    con.execute("INSERT INTO artist_popularity (artist_id, listeners, playcount) VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [f'name:{a}', n, n * 40])
    con.execute("INSERT INTO artist_popularity_history (artist_id, listeners, playcount) VALUES (?, ?, ?)", [f'name:{a}', n, n * 40])
for f in ('compute_sessions.sql', 'compute_milestones.sql', 'compute_scenes.sql', 'compute_insights.sql'): con.execute(rd(f))  # tags must exist before sessions so chaos can score
# Phase 9e dev stand-ins: lyric keywords for the most-played tracks (invented — no real lyrics involved), so the cloud renders.
WORDS = ['night', 'river', 'gold', 'shadow', 'summer', 'home', 'fire', 'window', 'heart', 'city', 'rain', 'stranger', 'light', 'road', 'ocean', 'ghost', 'silver', 'dance', 'morning', 'fever', 'garden', 'mirror', 'letter', 'train', 'smoke', 'wire', 'winter', 'radio', 'blue', 'velvet']
THEMES = ['night', 'rain', 'cities', 'colours', 'love', 'leaving', 'weather', 'home']
top = con.execute("SELECT track_id FROM plays_resolved WHERE track_id IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 120").fetchall()
for i, (tid,) in enumerate(top):
    kws = [WORDS[(i * 7 + k * 3) % len(WORDS)] for k in range(6)]; ths = [THEMES[(i + k) % len(THEMES)] for k in range(2)]
    if i % 4 == 3:   # a quarter still on the 9e rules, so the "being re-analysed" states render
        con.execute("INSERT INTO track_lyric_features (track_id, source, found, word_count, keywords, themes, colours, lang, features_rev) VALUES (?, 'dev', TRUE, 200, ?, ?, [], 'en', 1) ON CONFLICT DO NOTHING", [tid, kws, ths]); continue
    # Phase 9f shape: term frequencies (a shared filler word in every song + distinctive ones), scored themes, structure, an LLM theme for some
    scores = {THEMES[(i + k) % len(THEMES)]: round(4.0 - k * 1.3 + (i % 3) * 0.4, 2) for k in range(3)}
    con.execute("INSERT INTO track_lyric_features (track_id, source, found, word_count, keywords, themes, colours, lang, features_rev, theme_scores, valence, repetition, vocab, llm_themes, llm_mood) VALUES (?, 'dev', TRUE, 200, ?, ?, [], 'en', 2, ?::JSON, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING",
                [tid, kws[:3], list(scores)[:2], json.dumps(scores), round(((i * 37) % 200) / 100 - 1, 2), round(0.2 + (i % 7) / 10, 3), 40 + i, (['late-night driving', 'lost love', 'city loneliness'][i % 3:i % 3 + 2] if i % 2 == 0 else None), (['wistful, warm', 'restless', 'bleak but tender', 'euphoric'][i % 4] if i % 2 == 0 else None)])
    con.execute("INSERT INTO track_lyric_terms VALUES (?, 'love', ?) ON CONFLICT DO NOTHING", [tid, 6 + i % 5])      # in every song → never a keyword
    for k, w in enumerate(kws): con.execute("INSERT INTO track_lyric_terms VALUES (?, ?, ?) ON CONFLICT DO NOTHING", [tid, w, 5 - k + (i % 2)])
# Phase 9f dev stand-ins: an artist with no tags → lands in the Crate's "unsorted" section; listener history with movement;
# three playlists (one Spotify-made and unreadable, one partly synced) so the Library totals strip exercises every state.
con.execute("DELETE FROM artist_tags WHERE artist_id = 'name:arooj aftab'")
ORIGIN = {'floating points': ('GB', 'United Kingdom', 'Manchester'), 'little simz': ('GB', 'United Kingdom', 'London'), 'mitski': ('US', 'United States', 'New York'), 'khruangbin': ('US', 'United States', 'Houston'), 'king gizzard & the lizard wizard': ('AU', 'Australia', 'Melbourne'),
          'tatsuro yamashita': ('JP', 'Japan', 'Tokyo'), 'arooj aftab': ('PK', 'Pakistan', 'Lahore'), 'yaeji': ('KR', 'South Korea', 'Seoul'), 'hania rani': ('PL', 'Poland', 'Gdańsk'), 'sault': ('GB', 'United Kingdom', 'London'), 'altın gün': ('NL', 'Netherlands', 'Amsterdam'),
          'radiohead': ('GB', 'United Kingdom', 'Oxford'), 'beach house': ('US', 'United States', 'Baltimore'), 'nils frahm': ('DE', 'Germany', 'Berlin'), 'men i trust': ('CA', 'Canada', 'Montréal')}
for a, (cc, name, city) in ORIGIN.items(): con.execute("INSERT INTO artist_origin (artist_id, country, country_name, city, source) VALUES (?, ?, ?, ?, 'dev') ON CONFLICT DO NOTHING", [f'name:{a}', cc, name, city])
for a, n in POP.items():
    for d, f in ((60, 0.82), (30, 0.93)):
        drift = 1.35 if a in ('arooj aftab', 'yaeji') else 0.75 if a == 'radiohead' else f
        con.execute("INSERT INTO artist_popularity_history (artist_id, listeners, playcount, snapshot_at) VALUES (?, ?, ?, now() - INTERVAL (?) DAY)", [f'name:{a}', int(n * drift * (1 if d == 30 else 0.9)), int(n * 40 * drift), d])
# Phase 9g dev stand-ins: audio features for most-played tracks (invented, shaped like FreqBlog's) so Sound renders.
KEYS = ['C major', 'G major', 'D major', 'A minor', 'E minor', 'F# minor', 'Bb major', 'F major', 'C# minor', 'Eb major', 'B minor', 'G minor']
CAM = ['8B', '9B', '10B', '8A', '9A', '11A', '6B', '7B', '12A', '5B', '10A', '6A']
feat_tracks = con.execute("SELECT track_id FROM plays_resolved WHERE track_id IS NOT NULL GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 160").fetchall()
for i, (tid,) in enumerate(feat_tracks):
    if i % 9 == 8: con.execute("INSERT INTO track_features (track_id, found, feature_source) VALUES (?, FALSE, 'name') ON CONFLICT DO NOTHING", [tid]); continue
    k = (i * 7) % 12
    con.execute("INSERT INTO track_features (track_id, bpm, key_name, key_int, mode, camelot, energy, loudness_db, danceability, valence, time_signature, acousticness, feature_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4, ?, 'isrc') ON CONFLICT DO NOTHING",
                [tid, 68 + (i * 13) % 105, KEYS[k], k, 0 if 'minor' in KEYS[k] else 1, CAM[k], round(0.15 + ((i * 29) % 80) / 100, 2), round(-16 + ((i * 11) % 12), 1), round(0.3 + ((i * 17) % 60) / 100, 2), round(((i * 23) % 100) / 100, 2), round(((i * 31) % 90) / 100, 2)])
pl_tracks = [t for (t,) in con.execute("SELECT track_id FROM plays_resolved WHERE track_id IS NOT NULL AND track_id NOT LIKE 'local:%' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 40").fetchall()]
con.execute("INSERT INTO playlists (playlist_id, name, description, owner_is_me, owner_id, track_count, snapshot_id, public, items_synced_at, items_snapshot_id) VALUES ('devpl1', 'Sunday slow', 'seeded', TRUE, 'me', 20, 's1', FALSE, now(), 's1') ON CONFLICT DO NOTHING")
con.execute("INSERT INTO playlists (playlist_id, name, description, owner_is_me, owner_id, track_count, snapshot_id, public, items_synced_at, items_snapshot_id) VALUES ('devpl2', 'Long drives (partly synced)', 'seeded', TRUE, 'me', 40, 's2', FALSE, now(), 's1') ON CONFLICT DO NOTHING")
con.execute("INSERT INTO playlists (playlist_id, name, description, owner_is_me, owner_id, track_count, snapshot_id, public, sync_error) VALUES ('devpl3', 'Discover Weekly', 'seeded', FALSE, 'spotify', 30, 's3', FALSE, 'unreadable: Spotify-made playlists are closed to third-party apps') ON CONFLICT DO NOTHING")
for i, t in enumerate(pl_tracks[:20]): con.execute("INSERT INTO playlist_items VALUES ('devpl1', ?, now() - INTERVAL 400 DAY, ?)", [t, i])
for i, t in enumerate(pl_tracks[20:35]): con.execute("INSERT INTO playlist_items VALUES ('devpl2', ?, now() - INTERVAL 200 DAY, ?)", [t, i])
# Phase 9d dev stand-ins: catalogue sizes (≈3× the songs heard) and a few feature credits, so Dig Deeper / Superlatives render.
con.execute("UPDATE artists SET catalogue_tracks = 3 * (SELECT COUNT(DISTINCT track_id) FROM plays_resolved p WHERE p.artist_id = artists.artist_id), catalogue_fetched_at = now()")
feat = con.execute("SELECT t.track_id, t.artist_id, a.name FROM tracks t JOIN artists a USING (artist_id) WHERE t.track_id NOT LIKE 'local:%' ORDER BY t.track_id LIMIT 6").fetchall()
others = con.execute("SELECT artist_id, name FROM artists ORDER BY name LIMIT 6").fetchall()
for (tid, aid, name), (oid, oname) in zip(feat, others):
    if oid == aid: continue
    con.execute("INSERT INTO track_credits (track_id, artist_id, artist_name, credit_order) VALUES (?, ?, ?, 0) ON CONFLICT DO NOTHING", [tid, aid, name])
    con.execute("INSERT INTO track_credits (track_id, artist_id, artist_name, credit_order) VALUES (?, ?, ?, 1) ON CONFLICT DO NOTHING", [tid, oid, oname])
# Heard in the Wild: one capture of the owner's own latest play (must be dropped), then genuine ones.
p = con.execute("SELECT track_name, artist_name, played_at_utc, ms_played FROM plays_resolved ORDER BY played_at_utc DESC LIMIT 1").fetchone()
end = p[2] if p[2].tzinfo else p[2].replace(tzinfo=dt.timezone.utc)
def wild(ts, track, artist):
    uts = int(ts.timestamp()); payload = json.dumps({"track_name": track, "artist_name": artist, "album_name": "Somewhere", "lastfm_uts": uts, "mbid": None, "source": "lastfm_wild", "platform": "pano"})
    con.execute(rd('wild_insert.sql'), [ts.isoformat(), payload, track, artist, uts])
wild(end - dt.timedelta(milliseconds=int(p[3] // 2)), p[0], p[1])
random.seed(7); base = end + dt.timedelta(days=1)
songs = [("Midnight City", "M83"), ("Genesis", "Grimes"), ("Space Song", "Beach House"), ("Motion Sickness", "Phoebe Bridgers"), ("Redbone", "Childish Gambino"), ("Electric Feel", "MGMT"), ("Dreams", "Fleetwood Mac"), ("Silver Soul", "Beach House")]
for _ in range(40):
    tr, ar = random.choice(songs); wild(base + dt.timedelta(days=random.randint(0, 60), hours=random.randint(7, 23), minutes=random.randint(0, 59)), tr, ar)
wild(end + dt.timedelta(days=20, hours=3), p[0], p[1])
con.execute("CHECKPOINT")
print("plays", con.execute("SELECT COUNT(*) FROM plays_resolved").fetchone()[0], "wild", con.execute("SELECT COUNT(*) FROM wild_plays").fetchone()[0], "→", DB)
