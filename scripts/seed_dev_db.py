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
# Phase 9i: the demo extras live in SQL now, shared with the desktop app's own demo record (src-tauri/src/lib.rs):
# demo_events.sql (trips, dig candidates, country) → entity resolution → demo_enrich.sql (tags, listeners, origins,
# lyric / audio features, playlists, matches) → the rest of the pipeline.
con.execute(rd('demo_events.sql'))
con.execute(rd('entity_resolution.sql'))
con.execute(rd('demo_enrich.sql'))
for f in ('compute_sessions.sql', 'compute_milestones.sql', 'compute_scenes.sql', 'compute_insights.sql'): con.execute(rd(f))
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
