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

def test_stuck_repeat_short_track():
    # A ~30s track autoplays to completion 20 times in a row with no clicks (start='unknown').
    con = fresh()
    for i in range(20): play(con, f"2024-12-29 19:{i*2:02d}:00", "So Excited", "B.B. King", ms=29740, end='trackdone', start='unknown')
    rebuild(con)
    s = con.execute("SELECT stuck_repeat, attention FROM sessions").fetchone()
    assert s[0] is True and s[1] == 'unattended', s
    # contrast: 20 deliberate clicks of the same song should NOT be flagged
    con2 = fresh()
    for i in range(20): play(con2, f"2024-12-29 19:{i*2:02d}:00", "Replay Me", "Band", ms=29740, end='trackdone', start='clickrow')
    rebuild(con2)
    s2 = con2.execute("SELECT stuck_repeat, attention FROM sessions").fetchone()
    assert s2[0] is False and s2[1] == 'active', s2

# ---------------------------------------------------------------------------
# Phase 8 — Heard in the Wild (wild_insert.sql + wild_plays view)
# ---------------------------------------------------------------------------
def wild(con, ts_iso, track, artist, album='Somewhere'):
    """Insert one ambient capture through wild_insert.sql. Returns rows inserted (0 or 1)."""
    uts = int(duckdb.connect().execute("SELECT epoch(CAST(? AS TIMESTAMPTZ))", [ts_iso]).fetchone()[0])
    payload = json.dumps({"track_name": track, "artist_name": artist, "album_name": album, "lastfm_uts": uts, "mbid": None, "source": "lastfm_wild", "platform": "pano"})
    before = con.execute("SELECT COUNT(*) FROM events WHERE event_type = 'wild_play'").fetchone()[0]
    con.execute(rd('wild_insert.sql'), [ts_iso, payload, track, artist, uts])
    return con.execute("SELECT COUNT(*) FROM events WHERE event_type = 'wild_play'").fetchone()[0] - before

def test_wild_never_touches_core_record():
    # Captures live in their own event class; the core pipeline must be blind to them.
    con = fresh()
    play(con, "2024-05-01 20:00:00", "Home Song", "Band")                 # one genuine play
    assert wild(con, "2024-05-02 13:00:00+00", "Cafe Song", "Stranger") == 1
    rebuild(con)
    assert con.execute("SELECT COUNT(*) FROM plays_normalized").fetchone()[0] == 1
    assert con.execute("SELECT COUNT(*) FROM plays_resolved").fetchone()[0] == 1
    assert con.execute("SELECT COUNT(*) FROM wild_plays").fetchone()[0] == 1
    assert con.execute("SELECT COUNT(*) FROM artists").fetchone()[0] == 1   # Stranger never became an entity
    w = con.execute("SELECT track_key, artist_key FROM wild_plays").fetchone()
    assert w == ('cafe song', 'stranger'), w

def test_wild_drops_own_spotify_playback():
    # Extended export stamps END of play: a 4-min song ending 20:04 ran 20:00→20:04.
    con = fresh()
    play(con, "2024-05-01 20:04:00", "Riff", "Band", ms=240000)
    assert wild(con, "2024-05-01 20:01:30+00", "Riff", "Band") == 0            # inside, same song → own speakers
    assert wild(con, "2024-05-01 19:58:30+00", "Riff", "Band") == 0            # 90 s before start, same song → tolerance
    assert wild(con, "2024-05-01 20:02:00+00", "Riff (feat. Guest)", "Band") == 0   # Google-style title suffix still matches
    assert wild(con, "2024-05-01 20:02:00+00", "Totally Other Title", "Band") == 0  # same artist strictly inside → one speaker
    assert wild(con, "2024-05-01 19:57:00+00", "Totally Other Title", "Band") == 1  # same artist, OUTSIDE interval, title differs → genuine
    assert wild(con, "2024-05-01 23:30:00+00", "Riff", "Band") == 1            # same song 3.5 h later → genuinely heard elsewhere
    assert wild(con, "2024-05-01 20:02:00+00", "Riff", "Someone Else") == 1    # different artist → cover heard in the wild, keep

def test_wild_start_stamped_sources_and_idempotency():
    # recently_played_poll stamps START of play; the interval runs forward from occurred_at.
    con = fresh()
    payload = json.dumps({"spotify_track_id": "t_x", "track_name": "Poll Song", "artist_name": "Band", "ms_played": 180000, "source": "recently_played_poll", "platform": "android"})
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', CAST(? AS TIMESTAMPTZ), CAST(? AS JSON), 'poll')", ["2024-06-01 09:00:00", payload])
    assert wild(con, "2024-06-01 09:02:00+00", "Poll Song", "Band") == 0       # 09:00→09:03, capture inside → dropped
    assert wild(con, "2024-06-01 09:06:00+00", "Poll Song", "Band") == 1       # 3 min after end, past tolerance → kept
    assert wild(con, "2024-06-01 09:06:00+00", "Poll Song", "Band") == 0       # exact re-import → idempotent
    assert con.execute("SELECT COUNT(*) FROM wild_plays").fetchone()[0] == 1

if __name__ == '__main__':
    tests = [v for k, v in globals().items() if k.startswith('test_')]
    fails = 0
    for t in tests:
        try: t(); print(f"✓ {t.__name__}")
        except Exception as e: fails += 1; print(f"✗ {t.__name__}: {e}")
    sys.exit(1 if fails else 0)
