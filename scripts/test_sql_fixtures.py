"""SQL fixture tests (spec Phase 3 acceptance): tiny synthetic records with known answers.
   python3 scripts/test_sql_fixtures.py       (needs: pip install duckdb)
Each test builds an in-memory DB from schema.sql, inserts events, runs the pipeline and asserts."""
import duckdb, json, pathlib, sys
ROOT = pathlib.Path(__file__).resolve().parents[1]; SQL = ROOT / 'src-tauri' / 'sql'
rd = lambda n: (SQL / n).read_text()

def fresh():
    con = duckdb.connect(); con.execute("SET TimeZone='UTC'"); con.execute(rd('schema.sql')); return con

def play(con, ts, track, artist, album='LP', ms=200000, end='trackdone', start='trackdone', tid=None):
    tid = tid or f"t_{track.lower().replace(' ', '_')}"
    payload = json.dumps({"spotify_track_uri": f"spotify:track:{tid}", "spotify_track_id": tid, "track_name": track, "artist_name": artist, "album_name": album, "ms_played": ms, "platform": "linux", "end_reason": end, "start_reason": start, "shuffle": False, "source": "extended_export"})
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', CAST(? AS TIMESTAMPTZ), CAST(? AS JSON), 'fixture')", [ts, payload])

def rebuild(con):
    con.execute(rd('entity_resolution.sql')); con.execute(rd('compute_sessions.sql')); con.execute(rd('compute_milestones.sql'))

def test_album_ride_and_gap():
    con = fresh()
    for i in range(8): play(con, f"2024-03-01 20:{i*4:02d}:00", f"Track {i}", "Band", "Album")   # 8 consecutive same-album plays, 4 min apart
    play(con, "2024-03-02 09:00:00", "Other", "Someone")                                          # 13 h later → new session
    rebuild(con)
    shapes = dict(con.execute("SELECT session_shape, COUNT(*) FROM sessions GROUP BY 1").fetchall())
    assert con.execute("SELECT COUNT(*) FROM sessions").fetchone()[0] == 2, shapes
    assert shapes.get('album_ride') == 1, shapes

def test_restless_and_skip_definition():
    con = fresh()
    for i in range(10): play(con, f"2024-03-01 20:{i*2:02d}:00", f"S {i}", "Band", ms=15000, end='fwdbtn')
    rebuild(con)
    s = con.execute("SELECT session_shape, skip_rate, skip_count FROM sessions").fetchone()
    assert s[0] == 'restless' and s[1] == 1.0 and s[2] == 10, s

def test_comfort_loop_needs_three_plays():
    con = fresh()
    play(con, "2024-03-01 20:00:00", "Loop", "Band"); play(con, "2024-03-01 20:04:00", "Loop", "Band")
    rebuild(con); assert con.execute("SELECT session_shape FROM sessions").fetchone()[0] == 'steady'
    play(con, "2024-03-01 20:08:00", "Loop", "Band"); rebuild(con)
    assert con.execute("SELECT session_shape FROM sessions").fetchone()[0] == 'comfort_loop'

def test_unattended_after_gap():
    con = fresh()
    con.execute("UPDATE app_meta SET value = '60' WHERE key = 'attention_gap_min'")
    play(con, "2024-03-01 22:00:00", "A", "Band", start='clickrow')                      # interaction
    for i in range(1, 30): play(con, f"2024-03-01 {22 + (i*4)//60:02d}:{(i*4)%60:02d}:00", f"T{i}", "Band")  # autoplay every 4 min for ~2 h
    rebuild(con)
    att, un = con.execute("SELECT COUNT(*) FILTER (WHERE attended), COUNT(*) FILTER (WHERE NOT attended) FROM plays_resolved").fetchone()
    assert un > 0 and att >= 15, (att, un)   # first hour attended, rest not
    assert con.execute("SELECT attention FROM sessions").fetchone()[0] in ('drifting', 'unattended')

def test_dedupe_and_alias_merge():
    con = fresh()
    play(con, "2024-03-01 20:00:00", "Same", "CHVRCHES"); play(con, "2024-03-01 20:04:00", "Same", "Chvrches")
    rebuild(con)
    assert con.execute("SELECT COUNT(*) FROM artists").fetchone()[0] == 1
    assert con.execute("SELECT COUNT(*) FROM artist_aliases").fetchone()[0] == 2
    # poll dedupe: a start-of-play event whose end matches an export end within 2 s is rejected
    con.execute(rd('poll_insert.sql').replace('?1', "'2024-03-01 19:56:41+00'").replace('?2', "'t_same'").replace('?3', "'" + json.dumps({"spotify_track_id": "t_same", "track_name": "Same", "artist_name": "CHVRCHES", "ms_played": 200000, "source": "recently_played_poll"}).replace("'", "''") + "'").replace('?4', str(int(duckdb.connect().execute("SELECT epoch(TIMESTAMPTZ '2024-03-01 20:00:00+00')").fetchone()[0]) + 1)))
    assert con.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 2

def test_milestones_and_merge():
    con = fresh()
    for i in range(100): play(con, f"2024-01-{1 + i//10:02d} 12:{(i%10)*5:02d}:00", "Hit", "Band", start='clickrow')
    rebuild(con)
    assert con.execute("SELECT COUNT(*) FROM milestones WHERE type = 'track_plays' AND value = 100").fetchone()[0] == 1
    play(con, "2024-02-01 12:00:00", "Hit", "Band (Deluxe)"); rebuild(con)
    con.execute("INSERT INTO artist_merges VALUES ('name:band (deluxe)', 'name:band', now())"); rebuild(con)
    assert con.execute("SELECT COUNT(*) FROM plays_resolved WHERE artist_id = 'name:band'").fetchone()[0] == 101

if __name__ == '__main__':
    tests = [v for k, v in globals().items() if k.startswith('test_')]
    fails = 0
    for t in tests:
        try: t(); print(f"✓ {t.__name__}")
        except Exception as e: fails += 1; print(f"✗ {t.__name__}: {e}")
    sys.exit(1 if fails else 0)
