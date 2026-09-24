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
    con.execute(rd('entity_resolution.sql')); con.execute(rd('compute_sessions.sql')); con.execute(rd('compute_milestones.sql')); con.execute(rd('compute_scenes.sql'))

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

def test_obscurity_view_fixed_reference():
    # Phase 9b: inverse log10 on a FIXED 10^7 reference — stable over time, comparable across records, clamped to [0, 1].
    con = fresh()
    for aid, n in [('name:huge', 10_000_000), ('name:mid', 100_000), ('name:tiny', 9), ('name:zero', 0), ('name:absurd', 10**12)]:
        con.execute("INSERT INTO artist_popularity (artist_id, listeners, playcount) VALUES (?, ?, 0)", [aid, n])
    o = dict(con.execute("SELECT artist_id, ROUND(obscurity, 3) FROM artist_obscurity").fetchall())
    assert o['name:huge'] < 0.001, o                 # 10M listeners → ~0
    assert abs(o['name:mid'] - (1 - 5/7)) < 0.01, o   # 1e5 → 1 - 5/7
    assert o['name:tiny'] == 1 - 1/7 or abs(o['name:tiny'] - 0.857) < 0.001, o
    assert o['name:zero'] == 1.0 and o['name:absurd'] == 0.0, o   # clamped both ends

def test_crate_flags_abandoned_and_rediscover():
    # The Crate's two cover states, computed the same way crateQueries.ts does (plays/days/silence), on a tiny record.
    con = fresh()
    play(con, "2024-01-05 20:00:00", "Once", "Solo", album="Left Behind")                              # 1 play, long ago → abandoned
    for d in range(20): play(con, f"2023-03-{1 + d % 28:02d} 20:00:00", f"Hit {d % 4}", "Loved", album="Old Flame")   # 20 plays, 2023 → rediscover
    for d in range(5): play(con, f"2024-06-{10 + d:02d} 20:00:00", "Now", "Current", album="Still Spinning")           # recent → neither
    rebuild(con)
    rows = con.execute("""
      WITH p AS (SELECT album_id, arg_max(album_name, ms_played) AS album, COUNT(*) AS plays, COUNT(DISTINCT CAST(played_at AS DATE)) AS days, MAX(played_at) AS last_at FROM plays_resolved WHERE album_id IS NOT NULL GROUP BY 1)
      SELECT album, (plays <= 2 AND days <= 2 AND CAST(DATE '2024-07-01' - CAST(last_at AS DATE) AS INTEGER) >= 60) AS abandoned,
             (plays >= 15 AND CAST(DATE '2024-07-01' - CAST(last_at AS DATE) AS INTEGER) >= 365) AS rediscover FROM p""").fetchall()
    f = {r[0]: (r[1], r[2]) for r in rows}
    assert f['Left Behind'] == (True, False), f
    assert f['Old Flame'] == (False, True), f
    assert f['Still Spinning'] == (False, False), f

def _tag(con, artist, tags):
    for t, w in tags: con.execute("INSERT INTO artist_tags (artist_id, tag, weight, source) VALUES (?, ?, ?, 'lastfm')", [f"name:{artist.lower()}", t, w])

def test_chaos_album_ride_low_and_wander_high():
    # Phase 9d: chaos is the mean tag-vector distance between consecutive plays. An album ride (one artist) must score
    # ~0; a session hopping jazz → death metal → ambient must score high. Tags are inserted BEFORE the pipeline runs.
    con = fresh()
    _tag(con, "Band", [("indie rock", .9)]); _tag(con, "Jazzman", [("jazz", .9), ("bebop", .6)]); _tag(con, "Doom", [("death metal", .9), ("metal", .8)]); _tag(con, "Drone", [("ambient", .9), ("electronic", .5)])
    for i in range(8): play(con, f"2024-03-01 20:{i*4:02d}:00", f"Track {i}", "Band", "Album")
    hop = ["Jazzman", "Doom", "Drone", "Jazzman", "Doom", "Drone", "Jazzman", "Doom", "Drone"]
    for i, a in enumerate(hop): play(con, f"2024-03-05 20:{i*4:02d}:00", f"{a} song {i}", a, f"{a} LP")
    rebuild(con)
    rows = dict(con.execute("SELECT session_shape, chaos FROM sessions").fetchall())
    assert rows.get('album_ride') is not None and rows['album_ride'] < 0.05, rows
    wander = [v for k, v in rows.items() if k != 'album_ride']
    assert wander and wander[0] > 0.9, rows

def test_chaos_null_without_tags():
    con = fresh()
    for i, a in enumerate(["A", "B", "C", "D"]): play(con, f"2024-03-05 20:{i*4:02d}:00", f"s{i}", a)
    rebuild(con)
    assert con.execute("SELECT chaos FROM sessions").fetchone()[0] is None

# ---------------------------------------------------------------- Phase 9f
def test_scenes_from_tables_and_overrides():
    # The vocabulary is data now: a tag mapped in scene_tag_map files the artist; an owner-added family + tag works the
    # same way; an unmapped tag files nothing; origin fallback applies only when no tag mapped; overrides win at weight 9.
    con = fresh()
    _tag(con, "Molam", [("molam", .9)]); _tag(con, "Jazzman", [("bebop", .8)]); _tag(con, "Nobody", [("seen live", .9)]); _tag(con, "Weak", [("jazz", .2)])
    for a in ("Molam", "Jazzman", "Nobody", "Weak", "Origin"): play(con, "2024-03-01 20:00:00", f"{a} song", a)
    con.execute("INSERT INTO artist_origin (artist_id, country) VALUES ('name:origin', 'TH'), ('name:jazzman', 'TH')")
    con.execute("INSERT INTO scene_families (scene, label, kind, builtin) VALUES ('thai-funk', 'Thai funk', 'region', FALSE)")
    con.execute("INSERT INTO scene_tag_map (tag, scene, builtin) VALUES ('molam', 'thai-funk', FALSE) ON CONFLICT (tag) DO UPDATE SET scene = excluded.scene")
    con.execute("INSERT INTO scene_overrides (artist_id, scene) VALUES ('name:nobody', 'jazz')")
    rebuild(con)
    rows = {r[0]: (r[1], r[2]) for r in con.execute("SELECT artist_id, scene, weight FROM artist_scene").fetchall()}
    assert rows['name:molam'][0] == 'thai-funk', rows
    assert rows['name:jazzman'][0] == 'jazz', rows            # tag beats origin
    assert rows['name:origin'][0] == 'southeast-asian', rows  # origin fallback
    assert rows['name:nobody'] == ('jazz', 9.0), rows          # override
    assert 'name:weak' not in rows, rows                       # below the 0.3 floor
    # hiding a family removes its filings on the next pass
    con.execute("UPDATE scene_families SET hidden = TRUE WHERE scene = 'thai-funk'"); con.execute(rd('compute_scenes.sql'))
    assert con.execute("SELECT COUNT(*) FROM artist_scene WHERE artist_id = 'name:molam'").fetchone()[0] == 0

def test_scene_vocabulary_integrity():
    con = fresh()
    assert con.execute("SELECT COUNT(*) FROM scene_tag_map m WHERE NOT EXISTS (SELECT 1 FROM scene_families f WHERE f.scene = m.scene)").fetchone()[0] == 0
    assert con.execute("SELECT COUNT(*) FROM scene_origin_map m WHERE NOT EXISTS (SELECT 1 FROM scene_families f WHERE f.scene = m.scene)").fetchone()[0] == 0
    # every 9e key still exists so old scene_overrides resolve
    for k in ['afro','turkish','japanese','post-punk','dream','psych','hip-hop','jazz','funk-soul','electronic','indie','folk','metal','caribbean','latin','classical','punk','classic-rock']:
        assert con.execute("SELECT COUNT(*) FROM scene_families WHERE scene = ?", [k]).fetchone()[0] == 1, k
    assert con.execute("SELECT COUNT(*) FROM scene_families WHERE NOT hidden").fetchone()[0] >= 60

def test_lyric_keywords_are_tfidf_not_frequency():
    # "love" appears in every song → excluded from every song's keywords; each song's own word ranks first.
    con = fresh()
    songs = {'t1': {'love': 9, 'river': 3, 'gold': 1}, 't2': {'love': 8, 'highway': 4, 'gold': 2}, 't3': {'love': 7, 'winter': 5}, 't4': {'love': 6, 'gold': 3, 'ashes': 2}}
    for tid, terms in songs.items():
        con.execute("INSERT INTO track_lyric_features (track_id, source, found, features_rev) VALUES (?, 'lrclib', TRUE, 2)", [tid])
        for term, tf in terms.items(): con.execute("INSERT INTO track_lyric_terms VALUES (?, ?, ?)", [tid, term, tf])
    kw = {r[0]: r[1] for r in con.execute("SELECT track_id, term FROM track_lyric_keywords WHERE rank = 1").fetchall()}
    assert kw == {'t1': 'river', 't2': 'highway', 't3': 'winter', 't4': 'ashes'}, kw
    assert con.execute("SELECT COUNT(*) FROM track_lyric_keywords WHERE term = 'love'").fetchone()[0] == 0
    # gold is in 3 of 4 songs (75 %) → over the 35 % ceiling → not a keyword either
    assert con.execute("SELECT COUNT(*) FROM track_lyric_keywords WHERE term = 'gold'").fetchone()[0] == 0

def test_playlist_columns_and_unreadable_marker():
    con = fresh()
    con.execute("INSERT INTO playlists (playlist_id, name, owner_is_me, owner_id, track_count, snapshot_id) VALUES ('p1', 'Mine', TRUE, 'me', 10, 's1'), ('p2', 'Discover Weekly', FALSE, 'spotify', 30, 's2')")
    con.execute("UPDATE playlists SET sync_error = 'unreadable: Spotify-made playlists are closed to third-party apps' WHERE owner_id = 'spotify' AND sync_error IS NULL")
    todo = con.execute("SELECT playlist_id FROM playlists WHERE (sync_error IS NULL OR sync_error NOT LIKE 'unreadable:%') AND (items_synced_at IS NULL OR items_snapshot_id IS DISTINCT FROM snapshot_id) ORDER BY owner_is_me DESC, items_synced_at ASC NULLS FIRST, first_seen_at ASC").fetchall()
    assert [r[0] for r in todo] == ['p1'], todo
    con.execute("UPDATE playlists SET items_synced_at = now(), items_snapshot_id = 's1' WHERE playlist_id = 'p1'")
    assert con.execute("SELECT COUNT(*) FROM playlists WHERE (sync_error IS NULL OR sync_error NOT LIKE 'unreadable:%') AND (items_synced_at IS NULL OR items_snapshot_id IS DISTINCT FROM snapshot_id)").fetchone()[0] == 0
    con.execute("UPDATE playlists SET snapshot_id = 's1b' WHERE playlist_id = 'p1'")   # Spotify moved the snapshot → due again
    assert con.execute("SELECT COUNT(*) FROM playlists WHERE items_snapshot_id IS DISTINCT FROM snapshot_id AND playlist_id = 'p1'").fetchone()[0] == 1

# ---------------------------------------------------------------- Phase 9g
def test_forecast_log_is_write_once():
    con = fresh()
    con.execute("INSERT INTO forecast_log (forecast_date, weekday, payload) VALUES (CAST('2026-09-22' AS DATE), 2, '{\"pAny\": 0.9}'::JSON) ON CONFLICT (forecast_date) DO NOTHING")
    con.execute("INSERT INTO forecast_log (forecast_date, weekday, payload) VALUES (CAST('2026-09-22' AS DATE), 2, '{\"pAny\": 0.1}'::JSON) ON CONFLICT (forecast_date) DO NOTHING")
    assert con.execute("SELECT CAST(payload->'pAny' AS DOUBLE) FROM forecast_log").fetchone()[0] == 0.9

def test_scene_week_share_sums_to_at_most_one():
    con = fresh()
    _tag(con, "Molam", [("molam", .9)]); _tag(con, "Jazzman", [("bebop", .8)])
    for d in range(1, 6): play(con, f"2024-03-0{d} 20:00:00", "a", "Molam", ms=2400000); play(con, f"2024-03-0{d} 21:00:00", "b", "Jazzman", ms=1200000)
    rebuild(con)
    rows = con.execute("""
      WITH w AS (SELECT DATE_TRUNC('week', played_at)::DATE AS wk, artist_id, SUM(ms_played)/3600000.0 AS h FROM plays_resolved WHERE artist_id IS NOT NULL GROUP BY 1, 2),
      tot AS (SELECT wk, SUM(h) AS th FROM w GROUP BY 1),
      sc AS (SELECT s.artist_id, arg_max(s.scene, s.weight) AS scene FROM artist_scene s JOIN scene_families f USING (scene) WHERE NOT f.hidden GROUP BY 1),
      sw AS (SELECT sc.scene, w.wk, SUM(w.h) AS h FROM w JOIN sc USING (artist_id) GROUP BY 1, 2)
      SELECT sw.wk, SUM(sw.h / tot.th) AS s, list(sw.scene) FROM sw JOIN tot USING (wk) GROUP BY 1""").fetchall()
    assert rows and all(abs(r[1] - 1.0) < 1e-9 for r in rows), rows      # every artist filed → shares sum to exactly 1
    assert set(rows[0][2]) == {'southeast-asian', 'jazz'}, rows

def test_track_features_and_origin_tables_exist():
    con = fresh()
    con.execute("INSERT INTO track_features (track_id, bpm, key_name, mode, energy) VALUES ('t', 120, 'A minor', 0, 0.5)")
    assert con.execute("SELECT found FROM track_features").fetchone()[0] is True
    assert con.execute("SELECT status FROM connector_state WHERE service = 'freqblog'").fetchone()[0] == 'disconnected'

# ---------------------------------------------------------------- Phase 9h
def test_lyric_keywords_idf_is_per_language():
    # Four English songs share 'river'; one Turkish song has 'gece'. Under a whole-corpus IDF 'gece' (df 1 of 5) would
    # out-score everything; per-language, the lone Turkish song is its own corpus and English words compete only with English.
    con = fresh()
    en = {'e1': {'river': 2, 'highway': 3}, 'e2': {'river': 2, 'winter': 3}, 'e3': {'ashes': 3, 'river': 1}, 'e4': {'harbor': 3, 'ember': 1}, 'e5': {'garden': 2, 'ember': 1}, 'e6': {'violet': 2, 'ember': 1}}
    for tid, terms in en.items():
        con.execute("INSERT INTO track_lyric_features (track_id, source, found, features_rev, lang) VALUES (?, 'lrclib', TRUE, 2, 'en')", [tid])
        for term, tf in terms.items(): con.execute("INSERT INTO track_lyric_terms VALUES (?, ?, ?)", [tid, term, tf])
    for tid, terms in {'t1': {'gece': 5, 'yol': 2}, 't2': {'deniz': 4, 'yol': 1}, 't3': {'kalp': 3, 'rüzgar': 2}}.items():
        con.execute("INSERT INTO track_lyric_features (track_id, source, found, features_rev, lang) VALUES (?, 'lrclib', TRUE, 2, 'tr')", [tid])
        for term, tf in terms.items(): con.execute("INSERT INTO track_lyric_terms VALUES (?, ?, ?)", [tid, term, tf])
    langs = dict(con.execute("SELECT term, lang FROM track_lyric_keywords GROUP BY 1, 2").fetchall())
    assert langs.get('gece') == 'tr' and langs.get('highway') == 'en', langs
    # 'river' is in 3 of 6 English songs (50 %) → above the per-language ceiling → nobody's keyword
    assert 'river' not in langs, langs
    # the Turkish score uses N = 3 Turkish songs, not 9 — so gece's score is 5·ln(3/1), not 5·ln(9/1)
    import math
    sc = con.execute("SELECT score FROM track_lyric_keywords WHERE term = 'gece'").fetchone()[0]
    assert abs(sc - 5 * math.log(3)) < 1e-9, sc

# ---------------------------------------------------------------- Phase 9i
def test_export_after_polling_counts_each_listen_once():
    # Owner plans a yearly extended-history export on top of polling. The export must supersede the polled copies
    # (matched on track + START of play within 10 s) and keep its own truth: the skipped play stays 31 s, not 200 s.
    import json
    con = fresh()
    poll = {"spotify_track_id": "abc", "track_name": "Song", "artist_name": "Band", "album_name": "LP", "ms_played": 200000, "source": "recently_played_poll"}
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', TIMESTAMPTZ '2026-03-01 12:00:00+00', ?::JSON, 'recently_played_poll')", [json.dumps(poll)])
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', TIMESTAMPTZ '2026-03-01 12:10:00+00', ?::JSON, 'recently_played_poll')", [json.dumps(dict(poll, spotify_track_id="def", track_name="Other"))])
    # a polled play the export does NOT contain (after the export's cut-off) must survive
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', TIMESTAMPTZ '2026-09-01 08:00:00+00', ?::JSON, 'recently_played_poll')", [json.dumps(dict(poll, spotify_track_id="new", track_name="After export"))])
    con.execute(rd('import_existing_keys.sql'))
    con.execute("""CREATE TEMP TABLE _stage AS SELECT * FROM (VALUES
        (TIMESTAMP '2026-03-01 12:03:21', 'spotify:track:abc', 'Song', 'Band', 'LP', 200000::BIGINT, 'linux', 'trackdone', 'clickrow', false, false, false, false, 'US'),
        (TIMESTAMP '2026-03-01 12:10:32', 'spotify:track:def', 'Other', 'Band', 'LP', 31000::BIGINT, 'linux', 'fwdbtn', 'clickrow', false, true, false, false, 'US'))
        t(ts, spotify_track_uri, track_name, artist_name, album_name, ms_played, platform, end_reason, start_reason, shuffle, export_skipped, offline, incognito, country)""")
    con.execute(rd('import_insert.sql').replace('?1', "'export-2026.json'"))
    # importing the same export again adds nothing (exact-key dedupe)
    con.execute(rd('import_existing_keys.sql')); con.execute(rd('import_insert.sql').replace('?1', "'export-2026.json'"))
    rebuild(con)
    rows = dict(con.execute("SELECT track_name, COUNT(*) FROM plays_resolved GROUP BY 1").fetchall())
    assert rows == {'Song': 1, 'Other': 1, 'After export': 1}, rows
    assert con.execute("SELECT ms_played FROM plays_resolved WHERE track_name = 'Other'").fetchone()[0] == 31000
    assert con.execute("SELECT COUNT(*) FROM events WHERE event_type = 'play'").fetchone()[0] == 5   # append-only log keeps both copies

def test_owner_overrides_survive_rebuild():
    con = fresh()
    play(con, "2024-03-01 20:00:00", "Song", "Band", album="Reissue")
    rebuild(con)
    aid = con.execute("SELECT album_id FROM albums").fetchone()[0]
    con.execute("INSERT INTO metadata_overrides (entity_type, entity_id, field, value) VALUES ('album', ?, 'release_date', '1971-01-01')", [aid])
    con.execute("INSERT INTO artist_origin (artist_id, country, city, source) VALUES ('name:band', 'US', 'Detroit', 'owner')")
    rebuild(con); rebuild(con)
    assert str(con.execute("SELECT release_date FROM albums WHERE album_id = ?", [aid]).fetchone()[0]) == '1971-01-01'
    assert con.execute("SELECT country, city, source FROM artist_origin WHERE artist_id = 'name:band'").fetchone() == ('US', 'Detroit', 'owner')

def test_demo_record_builds_with_every_feature():
    con = fresh()
    for f in ('demo_seed.sql', 'demo_events.sql', 'entity_resolution.sql', 'demo_enrich.sql', 'compute_sessions.sql', 'compute_milestones.sql', 'compute_scenes.sql', 'compute_insights.sql'): con.execute(rd(f))
    for table, least in (('plays_resolved', 20000), ('sessions', 500), ('insights', 20), ('artist_scene', 10), ('track_features', 100), ('track_lyric_keywords', 100), ('album_popularity', 10), ('playlist_items', 20), ('artist_mb_match', 10)):
        n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]; assert n >= least, (table, n)
    assert set(r[0] for r in con.execute("SELECT DISTINCT lang FROM track_lyric_keywords").fetchall()) >= {'en', 'tr'}
    assert con.execute("SELECT COUNT(DISTINCT country) FROM plays_resolved WHERE country IS NOT NULL").fetchone()[0] >= 3

# ---------------------------------------------------------------- Phase 9j
def test_polled_skips_are_inferred_and_keep_sessions_attended():
    # Owner: "skips show 0% everywhere and long sessions flag as inattentive". Polls only know a track started; the next
    # start tells us how long it really played. A 3-hour polled evening with a skip every ~40 minutes must show skips
    # and stay attended; the same evening with no skips at all still goes unattended after the idle gap (that part is right).
    import json, datetime as dt
    def evening(con, skips):
        t = dt.datetime(2026, 3, 1, 19, 0, tzinfo=dt.timezone.utc)
        for i in range(60):
            dur = 200000
            con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', ?, ?::JSON, 'poll')",
                        [t, json.dumps({"spotify_track_id": f"t{i}", "track_name": f"T{i}", "artist_name": "Band", "album_name": "LP", "ms_played": dur, "source": "recently_played_poll"})])
            t += dt.timedelta(milliseconds=(20000 if skips and i % 12 == 5 else dur))
    con = fresh(); evening(con, True); rebuild(con)
    sr, att = con.execute("SELECT AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END), AVG(CASE WHEN attended THEN 1.0 ELSE 0 END) FROM plays_resolved").fetchone()
    assert sr > 0.05, sr
    assert att > 0.95, att
    assert con.execute("SELECT MIN(ms_played) FROM plays_resolved").fetchone()[0] == 20000
    con = fresh(); evening(con, False); rebuild(con)
    assert con.execute("SELECT AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) FROM plays_resolved").fetchone()[0] == 0

# ---------------------------------------------------------------- Phase 9l
def test_export_supersedes_polls_whether_poll_time_is_start_or_end():
    # Spotify's recently-played played_at may be the start or the end of play. Either way the export row must replace the
    # polled copy (keeping its real 45 s and skip), and a song played twice back to back must stay two plays.
    import json
    def one(poll_times, exports):
        con = fresh()
        for t in poll_times:
            con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', ?::TIMESTAMPTZ, ?::JSON, 'poll')",
                        [t, json.dumps({"spotify_track_id": "abc", "track_name": "Song", "artist_name": "Band", "album_name": "LP", "ms_played": 200000, "source": "recently_played_poll"})])
        con.execute(rd('import_existing_keys.sql'))
        vals = ", ".join(f"(TIMESTAMP '{end}', 'spotify:track:abc', 'Song', 'Band', 'LP', {ms}::BIGINT, 'linux', '{er}', 'clickrow', false, {str(er == 'fwdbtn').lower()}, false, false, 'US')" for end, ms, er in exports)
        con.execute(f"CREATE TEMP TABLE _stage AS SELECT * FROM (VALUES {vals}) t(ts, spotify_track_uri, track_name, artist_name, album_name, ms_played, platform, end_reason, start_reason, shuffle, export_skipped, offline, incognito, country)")
        con.execute(rd('import_insert.sql').replace('?1', "'export.json'")); rebuild(con)
        return con.execute("SELECT COUNT(*), list(ms_played ORDER BY played_at), list(was_skipped ORDER BY played_at) FROM plays_resolved").fetchone()
    # poll stamped at START / at END, each with a few seconds of drift → one play with the export's truth
    for poll in ('2026-03-01 12:00:03+00', '2026-03-01 12:00:48+00'):
        n, ms, sk = one([poll], [('2026-03-01 12:00:45', 45000, 'fwdbtn')])
        assert (n, ms, sk) == (1, [45000], [True]), (poll, n, ms, sk)
    # the same song twice in a row (3:20 each): both polls, both export rows → exactly two plays
    n, ms, _ = one(['2026-03-01 12:00:00+00', '2026-03-01 12:03:20+00'], [('2026-03-01 12:03:20', 200000, 'trackdone'), ('2026-03-01 12:06:40', 200000, 'trackdone')])
    assert n == 2, (n, ms)

def test_resolution_watermark_stops_rebuild_every_launch():
    # After an export supersedes polled plays, events (5) ≠ plays_resolved (3) forever — the 9k startup check read that
    # as "stale" and rebuilt the whole record on every launch. The watermark sees nothing new.
    import json
    con = fresh()
    for t in ('2026-03-01 12:00:00+00', '2026-03-01 12:10:00+00'):
        con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', ?::TIMESTAMPTZ, ?::JSON, 'poll')", [t, json.dumps({"spotify_track_id": "abc" if t.endswith('00:00+00') else "def", "track_name": "S", "artist_name": "B", "album_name": "L", "ms_played": 200000, "source": "recently_played_poll"})])
    con.execute(rd('import_existing_keys.sql'))
    con.execute("""CREATE TEMP TABLE _stage AS SELECT * FROM (VALUES
        (TIMESTAMP '2026-03-01 12:03:21', 'spotify:track:abc', 'S', 'B', 'L', 200000::BIGINT, 'linux', 'trackdone', 'clickrow', false, false, false, false, 'US'),
        (TIMESTAMP '2026-03-01 12:10:32', 'spotify:track:def', 'S2', 'B', 'L', 31000::BIGINT, 'linux', 'fwdbtn', 'clickrow', false, true, false, false, 'US'))
        t(ts, spotify_track_uri, track_name, artist_name, album_name, ms_played, platform, end_reason, start_reason, shuffle, export_skipped, offline, incognito, country)""")
    con.execute(rd('import_insert.sql').replace('?1', "'e.json'")); rebuild(con)
    ev, res = con.execute("SELECT (SELECT COUNT(*) FROM events), (SELECT COUNT(*) FROM plays_resolved)").fetchone()
    assert ev != res, (ev, res)   # the old check would rebuild on every launch
    unresolved = con.execute("SELECT COUNT(*) FROM events WHERE ingested_at > COALESCE(TRY_CAST((SELECT value FROM app_meta WHERE key = 'resolved_through') AS TIMESTAMPTZ), TIMESTAMPTZ '1900-01-01 00:00:00+00')").fetchone()[0]
    assert unresolved == 0, unresolved
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', now(), '{\"spotify_track_id\": \"new\", \"source\": \"recently_played_poll\", \"ms_played\": 1000}'::JSON, 'poll')")
    assert con.execute("SELECT COUNT(*) FROM events WHERE ingested_at > TRY_CAST((SELECT value FROM app_meta WHERE key = 'resolved_through') AS TIMESTAMPTZ)").fetchone()[0] == 1

# ---------------------------------------------------------------- Phase 9m — Stylus
def test_stylus_listenbrainz_submissions():
    # Real client shapes: a Bandcamp scrobble from Web Scrobbler (no Spotify id), a Spotify-app scrobble from Pano (id in
    # spotify_id URL) that the poll ALSO recorded, a batch import, a playing_now, a resend of the same listen, a paused
    # device, and hour-rounded timestamps on a privacy-minded device.
    import json
    con = fresh()
    con.execute("INSERT INTO stylus_devices (device_id, name, token_hash) VALUES ('phone', 'Pixel', 'x'), ('laptop', 'Work laptop', 'y')")
    con.execute("UPDATE stylus_devices SET ts_precision = 'hour', keep_player = FALSE WHERE device_id = 'laptop'")
    con.execute("INSERT INTO stylus_devices (device_id, name, token_hash, paused) VALUES ('car', 'Car', 'z', TRUE)")
    # Spotify's poll already has the Pano track (poll stamped ~3:20 after the scrobble's start = end of play)
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', TIMESTAMPTZ '2026-03-01 12:13:20+00', ?::JSON, 'poll')",
                [json.dumps({"spotify_track_id": "4uLU6hMCjMI75M1A2tKUQC", "track_name": "Everlong", "artist_name": "Foo Fighters", "album_name": "The Colour", "ms_played": 200000, "source": "recently_played_poll"})])
    def listen(t, artist, track, extra=None):
        return {"listened_at": t, "track_metadata": {"artist_name": artist, "track_name": track, "release_name": "LP", "additional_info": dict({"duration_ms": 200000}, **(extra or {}))}}
    t0 = 1772366400   # 2026-03-01 12:00:00 UTC
    inbox = [
        ('phone', {"listen_type": "single", "payload": [listen(t0, "Khruangbin", "Maria También", {"music_service": "bandcamp.com", "submission_client": "Web Scrobbler"})]}),
        ('phone', {"listen_type": "single", "payload": [listen(t0 + 600, "Foo Fighters", "Everlong", {"spotify_id": "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "media_player": "Spotify"})]}),
        ('phone', {"listen_type": "import", "payload": [listen(t0 + 1200, "Altın Gün", "Goca Dünya"), listen(t0 + 1500, "Altın Gün", "Leylim Ley")]}),
        ('phone', {"listen_type": "playing_now", "payload": [{"track_metadata": {"artist_name": "Mitski", "track_name": "Nobody"}}]}),
        ('phone', {"listen_type": "single", "payload": [listen(t0, "Khruangbin", "Maria También")]}),       # resent
        ('laptop', {"listen_type": "single", "payload": [listen(t0 + 1234, "Nils Frahm", "Says", {"media_player": "foobar2000"})]}),
        ('car', {"listen_type": "single", "payload": [listen(t0 + 99, "Radio", "Song")]}),
    ]
    for dev, body in inbox:
        con.execute("INSERT INTO stylus_inbox (device_id, body) VALUES (?, ?)", [dev, json.dumps(body)])
    con.execute(rd('stylus_process.sql'))
    assert con.execute("SELECT COUNT(*) FROM stylus_inbox").fetchone()[0] == 0
    devs = {r[0]: r[1:] for r in con.execute("SELECT device_id, accepted, duplicates, discarded FROM stylus_devices").fetchall()}
    assert devs['phone'] == (3, 2, 0), devs      # bandcamp + 2 imports accepted; Everlong (Spotify had it) + resend = duplicates
    assert devs['laptop'] == (1, 0, 0) and devs['car'] == (0, 0, 1), devs
    assert con.execute("SELECT track_name FROM stylus_now_playing WHERE device_id = 'phone'").fetchone()[0] == 'Nobody'
    ev = con.execute("SELECT json_extract_string(payload, '$.track_name'), CAST(occurred_at AS VARCHAR), json_extract_string(payload, '$.media_player'), json_extract_string(payload, '$.platform') FROM events WHERE source_file LIKE 'stylus:%' ORDER BY 1").fetchall()
    says = [e for e in ev if e[0] == 'Says'][0]
    assert says[1].startswith('2026-03-01 12:00:00') and says[2] is None and says[3] == 'stylus:Work laptop', says   # hour-rounded, player dropped
    rebuild(con)
    names = sorted(r[0] for r in con.execute("SELECT track_name FROM plays_resolved").fetchall())
    assert names == ['Everlong', 'Goca Dünya', 'Leylim Ley', 'Maria También', 'Says'], names
    assert con.execute("SELECT track_id FROM plays_resolved WHERE track_name = 'Maria También'").fetchone()[0].startswith('local:')

def test_stylus_scrobble_before_poll_gives_way():
    # The scrobble lands first (no Spotify id, Pano on the Spotify app); the poll arrives later with the id → one play, Spotify's.
    import json
    con = fresh()
    con.execute("INSERT INTO stylus_devices (device_id, name, token_hash) VALUES ('phone', 'Pixel', 'x')")
    con.execute("INSERT INTO stylus_inbox (device_id, body) VALUES ('phone', ?)", [json.dumps({"listen_type": "single", "payload": [{"listened_at": 1772366400, "track_metadata": {"artist_name": "Foo Fighters", "track_name": "Everlong", "additional_info": {"duration_ms": 250000}}}]})])
    con.execute(rd('stylus_process.sql'))
    con.execute("INSERT INTO events (event_type, occurred_at, payload, source_file) VALUES ('play', TIMESTAMPTZ '2026-03-01 12:04:12+00', ?::JSON, 'poll')",
                [json.dumps({"spotify_track_id": "4uLU6hMCjMI75M1A2tKUQC", "track_name": "Everlong", "artist_name": "Foo Fighters", "album_name": "The Colour", "ms_played": 250000, "source": "recently_played_poll"})])
    rebuild(con)
    rows = con.execute("SELECT track_id FROM plays_resolved").fetchall()
    assert rows == [('4uLU6hMCjMI75M1A2tKUQC',)], rows

if __name__ == '__main__':
    tests = [v for k, v in globals().items() if k.startswith('test_')]
    fails = 0
    for t in tests:
        try: t(); print(f"✓ {t.__name__}")
        except Exception as e: fails += 1; print(f"✗ {t.__name__}: {e}")
    sys.exit(1 if fails else 0)
