"""Validate the SQL pipeline against a real export with the Python DuckDB package (no Rust needed).
   pip install duckdb pytz
   python3 scripts/validate_sql.py "/path/to/Spotify Extended Streaming History"
Writes dev-data/deep-cuts.duckdb, which dev-server.mjs then serves.
"""
import duckdb, glob, os, time, sys
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
import pathlib
ROOT=pathlib.Path(__file__).resolve().parents[1]
SQL=str(ROOT/'src-tauri'/'sql')+'/'
EXPORT=sys.argv[1] if len(sys.argv)>1 else str(ROOT/'dev-data'/'export')
DB=str(ROOT/'dev-data'/'deep-cuts.duckdb')
def rd(n): return open(SQL+n).read()
db=DB; os.makedirs(os.path.dirname(db), exist_ok=True)
if os.path.exists(db): os.remove(db)
con = duckdb.connect(db)
con.execute("SET TimeZone='UTC'")   # emulate a no-ICU build
con.execute(rd('schema.sql'))
# tz_offsets like Rust will (chrono-tz): walk transitions 2010..2030
ZONE=os.environ.get('DEEPCUTS_TZ','America/Detroit'); z=ZoneInfo(ZONE); rows=[]; prev=None
t=datetime(2010,1,1,tzinfo=timezone.utc)
while t < datetime(2031,1,1,tzinfo=timezone.utc):
    off=int(t.astimezone(z).utcoffset().total_seconds())
    if off!=prev: rows.append((t.replace(tzinfo=None), off, ZONE)); prev=off
    t+=timedelta(hours=1)
con.executemany("INSERT INTO tz_offsets VALUES (?,?,?)", rows)
print("tz rows", len(rows))
files = sorted(glob.glob(os.path.join(EXPORT, '**', 'Streaming_History_Audio_*.json'), recursive=True))
if not files: sys.exit(f'No Streaming_History_Audio_*.json under {EXPORT}. Usage: python3 scripts/validate_sql.py <export folder>')
t0=time.time(); con.execute(rd('import_existing_keys.sql'))
for f in files:
    con.execute(rd('import_stage.sql'), [f]); con.execute(rd('import_insert.sql'), [os.path.basename(f)]); con.execute(rd('import_mark_keys.sql'))
print("import %.1fs" % (time.time()-t0))
t0=time.time(); con.execute(rd('entity_resolution.sql')); print("entity %.1fs" % (time.time()-t0))
t0=time.time(); con.execute(rd('compute_sessions.sql')); print("sessions %.1fs" % (time.time()-t0))
print(con.execute("SELECT COUNT(*), ROUND(SUM(ms_played)/3600000.0), COUNT(DISTINCT artist_id), COUNT(DISTINCT track_id) FROM plays_resolved").fetchone())
print(con.execute("select CAST(played_at_utc AS VARCHAR), CAST(played_at AS VARCHAR) from plays_resolved order by played_at limit 1").fetchall())
print(con.execute("select CAST(played_at_utc AS VARCHAR), CAST(played_at AS VARCHAR) from plays_resolved where played_at_utc >= '2026-07-01' order by played_at limit 1").fetchall())
print(con.execute("select count(*) from sessions").fetchone(), con.execute("select hour_of_day, hours from hourly_profile order by hours desc limit 3").fetchall())
con.execute("CHECKPOINT")
