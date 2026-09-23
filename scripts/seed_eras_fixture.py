"""Structured fixture for the weekly eras + genre threads pipeline (Phase 9b).
Builds dev-data/eras-fixture.duckdb: five 8-week phases with disjoint artist sets, one noisy
single week, and a 4-week stretch where tagged 'afrobeat' artists carry ~35 % of the listening.
   python3 scripts/seed_eras_fixture.py ; DEEPCUTS_DB=dev-data/eras-fixture.duckdb node dev-server.mjs
Expected: ~5 eras at the Balanced preset covering every week; one afrobeat thread of 4 weeks."""
import duckdb, json, pathlib, random, datetime as dt
ROOT = pathlib.Path(__file__).resolve().parents[1]; SQL = ROOT / 'src-tauri' / 'sql'; rd = lambda n: (SQL / n).read_text()
DB = ROOT / 'dev-data' / 'eras-fixture.duckdb'; DB.parent.mkdir(exist_ok=True)
if DB.exists(): DB.unlink()
con = duckdb.connect(str(DB)); con.execute("SET TimeZone='UTC'"); con.execute(rd('schema.sql'))
con.execute("INSERT INTO tz_offsets VALUES ('2000-01-01 00:00:00', 0, 'UTC')")
con.execute("INSERT INTO app_meta (key,value) VALUES ('timezone','UTC') ON CONFLICT (key) DO UPDATE SET value=excluded.value")
random.seed(3)
def play(ts, track, artist, ms=240000):
    tid = f"t_{abs(hash((track, artist))) % 10**9}"
    payload = json.dumps({"spotify_track_uri": f"spotify:track:{tid}", "spotify_track_id": tid, "track_name": track, "artist_name": artist, "album_name": f"{artist} LP", "ms_played": ms, "platform": "linux", "end_reason": "trackdone", "start_reason": "trackdone", "shuffle": False, "source": "extended_export"})
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', CAST(? AS TIMESTAMPTZ), CAST(? AS JSON), 'fixture')", [ts.isoformat(), payload])
phases = [[f"P{p}A{a}" for a in range(6)] for p in range(5)]
afro = ["Fela Kuti", "Tony Allen", "Ebo Taylor"]
start = dt.datetime(2025, 1, 6, tzinfo=dt.timezone.utc)  # a Monday
week = 0
for p, artists in enumerate(phases):
    for w in range(8):
        wk = start + dt.timedelta(weeks=week); week += 1
        for d in range(7):
            for k in range(6):
                ts = wk + dt.timedelta(days=d, hours=18, minutes=4 * k)
                if p == 2 and 2 <= w <= 5 and k < 2: play(ts, f"Afro song {k}{d}", random.choice(afro))
                else: play(ts, f"{artists[k]} song {d % 3}", artists[k])
    if p == 1:  # one noisy week of strangers between phase 1 and 2
        wk = start + dt.timedelta(weeks=week); week += 1
        for d in range(7):
            for k in range(3): play(wk + dt.timedelta(days=d, hours=18, minutes=5 * k), f"Noise {d}{k}", f"Stranger {d}{k}")
for f in ('entity_resolution.sql', 'compute_sessions.sql', 'compute_milestones.sql'): con.execute(rd(f))
for a in afro: con.execute("INSERT INTO artist_tags (artist_id, tag, weight, source) VALUES (?, 'afrobeat', 0.9, 'lastfm')", [f"name:{a.lower()}"])
con.execute(rd('compute_scenes.sql')); con.execute(rd('compute_insights.sql'))
con.execute("CHECKPOINT")
print("plays", con.execute("SELECT COUNT(*) FROM plays_resolved").fetchone()[0], "weeks", week, "→", DB)
