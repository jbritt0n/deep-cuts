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
for f in ('entity_resolution.sql', 'compute_sessions.sql', 'compute_milestones.sql'): con.execute(rd(f))
# Phase 9b dev-only enrichment stand-ins, so genre threads and The Crate have data before any connector runs.
# Tags follow the scene vocabulary in compute_insights.sql; listener counts are invented but shaped like Last.fm's.
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
con.execute(rd('compute_insights.sql'))
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
