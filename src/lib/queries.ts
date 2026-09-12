/**
 * Every metric the UI shows, as SQL against the derived tables. Ported from v1
 * apps/web/src/lib/queries.ts (the SQL is the value) and extended for v3:
 * canonical ids (artist_id / track_id / album_id), sessions v2 columns, and
 * the new track / album / month pages. Rust never sees any of this.
 *
 * Time: `played_at` in plays_resolved is already local wall-clock, so no tz
 * math here. "Today" comes from the caller so we don't depend on the DB clock.
 */
import { query, num, str } from './db';
import { playsWhere, sessionsWhere } from './filter';
import type {
  AlbumDetail, AlbumRow, ArtistDetail, ArtistRow, DashboardStats, DayCell, DayDetail, HourSlice,
  MonthDetail, MonthPoint, PlayRow, RecordItem, SearchResults, SessionRow, TrackDetail, TrackRow,
} from './types';
import { albumHref, artistHref, dayHref, fmtHours, fmtInt, fmtMinutes, monthLabel, trackHref } from './format';

export const localToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Shared SELECT fragments -----------------------------------------------------
const PLAY_COLS = `
  CAST(played_at AS VARCHAR) AS "playedAt",
  track_id    AS "trackId",
  track_name  AS track,
  artist_id   AS "artistId",
  artist_name AS artist,
  album_name  AS album,
  ms_played   AS "msPlayed",
  was_skipped AS skipped,
  attended,
  platform`;

const SESSION_COLS = `
  CAST(session_id AS VARCHAR) AS "sessionId",
  CAST(start_at AS VARCHAR)   AS "startAt",
  CAST(end_at AS VARCHAR)     AS "endAt",
  track_count                 AS "trackCount",
  skip_count                  AS "skipCount",
  unique_artist_count         AS "uniqueArtists",
  total_ms                    AS "totalMs",
  session_shape               AS shape,
  opening_track               AS "openingTrack",
  closing_track               AS "closingTrack",
  platform,
  ROUND(completion_rate, 3)   AS "completionRate",
  completion_source           AS "completionSource",
  ROUND(skip_rate, 3)         AS "skipRate",
  ROUND(repeat_rate, 3)       AS "repeatRate",
  ROUND(novelty_rate, 3)      AS "noveltyRate",
  ROUND(artist_entropy, 2)    AS "artistEntropy",
  day_part                    AS "dayPart",
  album_ride                  AS "albumRide",
  attention,
  interaction_count           AS "interactions",
  unattended_ms               AS "unattendedMs",
  ROUND(chaos, 3)             AS chaos`;

const TRACK_ROW = `
  track_id AS "trackId", track_name AS track, artist_id AS "artistId", artist_name AS artist,
  COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours,
  ROUND(AVG(CASE WHEN was_skipped THEN 1 ELSE 0 END), 3) AS "skipRate"`;

const ARTIST_ROW = `artist_id AS "artistId", artist_name AS artist, plays, hours, ROUND(skip_rate, 3) AS "skipRate"`;

const CLOCK_SQL = (where = '') => `
  WITH h AS (SELECT EXTRACT(hour FROM played_at) AS hour, SUM(ms_played)/3600000.0 AS hours
             FROM plays_resolved ${where || 'WHERE 1=1'} ${playsWhere()} GROUP BY 1)
  SELECT r.hour::INT AS hour, ROUND(COALESCE(h.hours, 0), 2) AS hours
  FROM range(24) r(hour) LEFT JOIN h USING (hour) ORDER BY 1`;

// Months are padded so a quiet month still shows as zero.
const MONTHLY_SQL = (months: number, where = '', todayParam = '$1') => `
  WITH m AS (SELECT DATE_TRUNC('month', CAST(${todayParam} AS DATE)) - INTERVAL (${months} - 1 - i) MONTH AS mo FROM range(${months}) r(i)),
       h AS (SELECT DATE_TRUNC('month', played_at) AS mo, SUM(ms_played)/3600000.0 AS hours
             FROM plays_resolved WHERE played_at >= DATE_TRUNC('month', CAST(${todayParam} AS DATE)) - INTERVAL (${months} - 1) MONTH ${where} ${playsWhere()}
             GROUP BY 1)
  SELECT strftime(m.mo, '%b %y') AS month, strftime(m.mo, '%Y-%m') AS key, ROUND(COALESCE(h.hours, 0), 1) AS hours
  FROM m LEFT JOIN h USING (mo) ORDER BY m.mo`;

// Filter-aware replacements for the schema views.
const DAILY = () => `(SELECT CAST(played_at AS DATE) AS day, ROUND(SUM(ms_played)/60000.0, 1) AS minutes, COUNT(*) AS plays
                      FROM plays_resolved WHERE 1=1 ${playsWhere()} GROUP BY 1)`;
const TOP_ARTISTS = () => `(SELECT artist_id, artist_name, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours,
                             AVG(CASE WHEN was_skipped THEN 1 ELSE 0 END) AS skip_rate
                             FROM plays_resolved WHERE artist_id IS NOT NULL ${playsWhere()} GROUP BY 1, 2)`;
const PW = () => playsWhere();
const SW = () => sessionsWhere();

const toMonthly = (rows: Record<string, unknown>[]): MonthPoint[] =>
  rows.map((r) => ({ month: String(r.month), key: String(r.key), hours: num(r.hours) }));

// Dashboard -------------------------------------------------------------------
/** Phase 8 (§3.5): the dashboard heatmap for any scope — 'last365' (default) or a calendar year. */
export async function getCalendar(scope: 'last365' | number): Promise<DayCell[]> {
  if (scope === 'last365') {
    return (await query(`
      WITH d AS (SELECT CAST(CAST($1 AS DATE) - INTERVAL 364 DAY + i * INTERVAL 1 DAY AS DATE) AS day FROM range(365) r(i))
      SELECT CAST(d.day AS VARCHAR) AS day, COALESCE(m.minutes, 0) AS minutes, COALESCE(m.plays, 0) AS plays
      FROM d LEFT JOIN ${DAILY()} m USING (day) ORDER BY d.day`, [localToday()])).map(toDayCell);
  }
  const y = Math.floor(scope);
  const days = (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0)) ? 366 : 365;
  return (await query(`
    WITH d AS (SELECT CAST(DATE '${y}-01-01' + i * INTERVAL 1 DAY AS DATE) AS day FROM range(${days}) r(i))
    SELECT CAST(d.day AS VARCHAR) AS day, COALESCE(m.minutes, 0) AS minutes, COALESCE(m.plays, 0) AS plays
    FROM d LEFT JOIN ${DAILY()} m USING (day) ORDER BY d.day`)).map(toDayCell);
}

export async function getDashboardStats(): Promise<DashboardStats> {
  const today = localToday();

  const [totals] = await query(`
    SELECT COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0) AS hours,
           COUNT(DISTINCT artist_id) AS artists, COUNT(DISTINCT track_id) AS tracks
    FROM plays_resolved WHERE 1=1 ${PW()}`);

  const calendar = (await query(`
    WITH d AS (SELECT CAST(CAST($1 AS DATE) - INTERVAL 364 DAY + i * INTERVAL 1 DAY AS DATE) AS day FROM range(365) r(i))
    SELECT CAST(d.day AS VARCHAR) AS day, COALESCE(m.minutes, 0) AS minutes, COALESCE(m.plays, 0) AS plays
    FROM d LEFT JOIN ${DAILY()} m USING (day) ORDER BY d.day`, [today])).map(toDayCell);

  const clock = (await query(CLOCK_SQL())).map(toHour);

  const topArtists = (await query(`
    SELECT ${ARTIST_ROW} FROM ${TOP_ARTISTS()} ORDER BY hours DESC LIMIT 10`)).map(toArtistRow);

  const topTracks = (await query(`
    SELECT ${TRACK_ROW} FROM plays_resolved WHERE track_id IS NOT NULL ${PW()}
    GROUP BY 1, 2, 3, 4 ORDER BY plays DESC LIMIT 10`)).map(toTrackRow);

  const sessionShapes = (await query(`
    SELECT session_shape AS shape, COUNT(*) AS count FROM sessions WHERE 1=1 ${SW()} GROUP BY 1 ORDER BY 2 DESC`))
    .map((r) => ({ shape: String(r.shape), count: num(r.count) }));

  const monthlyHours = toMonthly(await query(MONTHLY_SQL(12), [today]));

  const recentPlays = (await query(`
    SELECT ${PLAY_COLS} FROM plays_resolved WHERE 1=1 ${PW()} ORDER BY played_at DESC LIMIT 12`)).map(toPlayRow);

  const onThisDay = (await query(`
    SELECT EXTRACT(year FROM played_at)::INT AS year, COUNT(*) AS plays,
           ROUND(SUM(ms_played)/60000.0) AS minutes,
           arg_max(artist_name, c) AS "topArtist", arg_max(artist_id, c) AS "topArtistId"
    FROM (SELECT played_at, ms_played, artist_name, artist_id,
                 COUNT(*) OVER (PARTITION BY EXTRACT(year FROM played_at), artist_id) AS c
          FROM plays_resolved
          WHERE strftime(played_at, '%m-%d') = strftime(CAST($1 AS DATE), '%m-%d')
            AND CAST(played_at AS DATE) < CAST($1 AS DATE) ${PW()})
    GROUP BY 1 ORDER BY 1 DESC`, [today])).map((r) => ({
      year: num(r.year), plays: num(r.plays), minutes: num(r.minutes),
      topArtist: str(r.topArtist), topArtistId: str(r.topArtistId),
    }));

  const [streakRow] = await query(`
    WITH days AS (SELECT day FROM ${DAILY()} WHERE minutes > 0),
    gaps AS (SELECT day, day - ROW_NUMBER() OVER (ORDER BY day) * INTERVAL 1 DAY AS grp FROM days)
    SELECT COUNT(*) AS streak FROM gaps
    WHERE grp = (SELECT grp FROM gaps ORDER BY day DESC LIMIT 1)
      AND (SELECT MAX(day) FROM days) >= CAST($1 AS DATE) - INTERVAL 1 DAY`, [today]);

  const records = await getRecords();
  const peakDay = calendar.length ? calendar.reduce((a, b) => (b.minutes > a.minutes ? b : a)) : null;

  return {
    totalPlays: num(totals?.plays), totalHours: num(totals?.hours),
    uniqueArtists: num(totals?.artists), uniqueTracks: num(totals?.tracks),
    currentStreakDays: num(streakRow?.streak),
    peakDay, calendar, clock, topArtists, topTracks, sessionShapes, monthlyHours, recentPlays, onThisDay, records,
  };
}

async function getRecords(): Promise<RecordItem[]> {
  const out: RecordItem[] = [];
  const [loud] = await query(`SELECT CAST(day AS VARCHAR) AS day, minutes FROM ${DAILY()} ORDER BY minutes DESC LIMIT 1`);
  if (loud) out.push({ label: 'Loudest day', value: fmtMinutes(num(loud.minutes)), detail: String(loud.day), href: dayHref(String(loud.day)) });

  const [sess] = await query(`
    SELECT CAST(CAST(start_at AS DATE) AS VARCHAR) AS day, track_count, total_ms, session_shape
    FROM sessions WHERE 1=1 ${SW()} ORDER BY total_ms DESC LIMIT 1`);
  if (sess) out.push({ label: 'Longest session', value: fmtHours(num(sess.total_ms) / 3600000), detail: `${fmtInt(num(sess.track_count))} tracks · ${String(sess.day)}`, href: dayHref(String(sess.day)) });

  const [streak] = await query(`
    WITH days AS (SELECT day FROM ${DAILY()} WHERE minutes > 0),
    gaps AS (SELECT day, day - ROW_NUMBER() OVER (ORDER BY day) * INTERVAL 1 DAY AS grp FROM days),
    runs AS (SELECT grp, COUNT(*) AS len, MIN(day) AS s, MAX(day) AS e FROM gaps GROUP BY grp)
    SELECT len, CAST(s AS VARCHAR) AS s, CAST(e AS VARCHAR) AS e FROM runs ORDER BY len DESC LIMIT 1`);
  if (streak) out.push({ label: 'Longest streak', value: `${fmtInt(num(streak.len))} days`, detail: `${String(streak.s)} → ${String(streak.e)}` });

  const [track] = await query(`
    SELECT track_id, track_name, artist_name, COUNT(*) AS plays FROM plays_resolved
    WHERE track_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3 ORDER BY plays DESC LIMIT 1`);
  if (track) out.push({ label: 'Most played track', value: `${fmtInt(num(track.plays))}×`, detail: `${String(track.track_name)} — ${String(track.artist_name)}`, href: trackHref(String(track.track_id)) });

  const [night] = await query(`
    SELECT artist_id, artist_name, COUNT(*) AS plays FROM plays_resolved
    WHERE (EXTRACT(hour FROM played_at) >= 23 OR EXTRACT(hour FROM played_at) < 4) AND artist_id IS NOT NULL ${PW()}
    GROUP BY 1, 2 ORDER BY plays DESC LIMIT 1`);
  if (night) out.push({ label: 'Late-night companion', value: String(night.artist_name), detail: `${fmtInt(num(night.plays))} plays between 11 PM and 4 AM`, href: artistHref(String(night.artist_id)) });

  const [ride] = await query(`
    SELECT COUNT(*) AS n FROM sessions WHERE album_ride ${SW()}`);
  if (ride && num(ride.n) > 0) out.push({ label: 'Album rides', value: fmtInt(num(ride.n)), detail: 'sessions with 6+ tracks from one album in a row' });

  return out;
}

// Day ---------------------------------------------------------------------------
export async function getDayDetail(date: string): Promise<DayDetail | null> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const [t] = await query(`
    SELECT COUNT(*) AS plays, ROUND(SUM(ms_played)/60000.0, 1) AS minutes,
           COUNT(DISTINCT artist_id) AS artists,
           SUM(CASE WHEN was_skipped THEN 1 ELSE 0 END) AS skips
    FROM plays_resolved WHERE CAST(played_at AS DATE) = CAST($1 AS DATE) ${PW()}`, [date]);

  const playsList = (await query(`
    SELECT ${PLAY_COLS} FROM plays_resolved
    WHERE CAST(played_at AS DATE) = CAST($1 AS DATE) ${PW()} ORDER BY played_at`, [date])).map(toPlayRow);

  const sessions = (await query(`
    SELECT ${SESSION_COLS} FROM sessions
    WHERE CAST(start_at AS DATE) = CAST($1 AS DATE) ${SW()} ORDER BY start_at`, [date])).map(toSessionRow);

  const [nav] = await query(`
    SELECT CAST(MAX(CASE WHEN day < CAST($1 AS DATE) THEN day END) AS VARCHAR) AS prev,
           CAST(MIN(CASE WHEN day > CAST($1 AS DATE) THEN day END) AS VARCHAR) AS next
    FROM ${DAILY()} WHERE minutes > 0`, [date]);

  return {
    date, plays: num(t?.plays), minutes: num(t?.minutes), uniqueArtists: num(t?.artists), skips: num(t?.skips),
    sessions, playsList, prevDay: str(nav?.prev), nextDay: str(nav?.next),
  };
}

// Month -----------------------------------------------------------------------
export async function getMonthDetail(key: string): Promise<MonthDetail | null> {
  if (!/^\d{4}-\d{2}$/.test(key)) return null;
  const first = `${key}-01`;
  const W = `WHERE DATE_TRUNC('month', played_at) = DATE_TRUNC('month', CAST($1 AS DATE))`;

  const [t] = await query(`
    SELECT COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours,
           COUNT(DISTINCT artist_id) AS artists, COUNT(DISTINCT track_id) AS tracks,
           SUM(CASE WHEN was_skipped THEN 1 ELSE 0 END) AS skips,
           SUM(CASE WHEN is_first_play THEN 1 ELSE 0 END) AS new_tracks
    FROM plays_resolved ${W} ${PW()}`, [first]);
  if (!t || num(t.plays) === 0) return null;

  const days = (await query(`
    WITH d AS (SELECT CAST(CAST($1 AS DATE) + i * INTERVAL 1 DAY AS DATE) AS day FROM range(31) r(i)
               WHERE DATE_TRUNC('month', CAST($1 AS DATE) + i * INTERVAL 1 DAY) = CAST($1 AS DATE))
    SELECT CAST(d.day AS VARCHAR) AS day, COALESCE(m.minutes, 0) AS minutes, COALESCE(m.plays, 0) AS plays
    FROM d LEFT JOIN ${DAILY()} m USING (day) ORDER BY d.day`, [first])).map(toDayCell);

  const clock = (await query(CLOCK_SQL(W), [first])).map(toHour);

  const topArtists = (await query(`
    SELECT artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays,
           ROUND(SUM(ms_played)/3600000.0, 1) AS hours,
           ROUND(AVG(CASE WHEN was_skipped THEN 1 ELSE 0 END), 3) AS "skipRate"
    FROM plays_resolved ${W} AND artist_id IS NOT NULL ${PW()} GROUP BY 1, 2 ORDER BY hours DESC LIMIT 10`, [first])).map(toArtistRow);

  const topTracks = (await query(`
    SELECT ${TRACK_ROW} FROM plays_resolved ${W} AND track_id IS NOT NULL ${PW()}
    GROUP BY 1, 2, 3, 4 ORDER BY plays DESC LIMIT 10`, [first])).map(toTrackRow);

  const shapes = (await query(`
    SELECT session_shape AS shape, COUNT(*) AS count FROM sessions
    WHERE DATE_TRUNC('month', start_at) = DATE_TRUNC('month', CAST($1 AS DATE)) ${SW()} GROUP BY 1 ORDER BY 2 DESC`, [first]))
    .map((r) => ({ shape: String(r.shape), count: num(r.count) }));

  const [nav] = await query(`
    WITH m AS (SELECT DISTINCT DATE_TRUNC('month', played_at) AS mo FROM plays_resolved)
    SELECT strftime(MAX(CASE WHEN mo < CAST($1 AS DATE) THEN mo END), '%Y-%m') AS prev,
           strftime(MIN(CASE WHEN mo > CAST($1 AS DATE) THEN mo END), '%Y-%m') AS next FROM m`, [first]);

  return {
    key, label: monthLabel(key),
    plays: num(t.plays), hours: num(t.hours), uniqueArtists: num(t.artists), uniqueTracks: num(t.tracks),
    skips: num(t.skips), newTracks: num(t.new_tracks),
    days, clock, topArtists, topTracks, shapes, prevMonth: str(nav?.prev), nextMonth: str(nav?.next),
  };
}

// Artist ------------------------------------------------------------------------
export async function getArtistDetail(artistId: string): Promise<ArtistDetail | null> {
  const today = localToday();
  const [t] = await query(`
    SELECT a.name, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours,
           COUNT(DISTINCT track_id) AS tracks,
           ROUND(AVG(CASE WHEN was_skipped THEN 1 ELSE 0 END), 3) AS skip_rate,
           CAST(MIN(played_at) AS VARCHAR) AS first_played, CAST(MAX(played_at) AS VARCHAR) AS last_played,
           ROUND(AVG(CASE WHEN EXTRACT(hour FROM played_at) >= 23 OR EXTRACT(hour FROM played_at) < 4 THEN 1.0 ELSE 0 END), 3) AS late_share
    FROM plays_resolved p JOIN artists a ON a.artist_id = p.artist_id
    WHERE p.artist_id = $1 ${playsWhere('p')} GROUP BY a.name`, [artistId]);
  if (!t || num(t.plays) === 0) return null;

  const aliases = (await query(`SELECT alias_name FROM artist_aliases WHERE artist_id = $1 AND alias_name <> $2 ORDER BY plays DESC`, [artistId, String(t.name)]))
    .map((r) => String(r.alias_name));

  const [rankRow] = await query(`
    SELECT rank FROM (SELECT artist_id, RANK() OVER (ORDER BY hours DESC) AS rank FROM ${TOP_ARTISTS()})
    WHERE artist_id = $1`, [artistId]);

  const monthly = toMonthly(await query(MONTHLY_SQL(24, 'AND artist_id = $2'), [today, artistId]));
  const clock = (await query(CLOCK_SQL('WHERE artist_id = $1'), [artistId])).map(toHour);

  const topTracks = (await query(`
    SELECT ${TRACK_ROW} FROM plays_resolved WHERE artist_id = $1 AND track_id IS NOT NULL ${PW()}
    GROUP BY 1, 2, 3, 4 ORDER BY plays DESC LIMIT 12`, [artistId])).map(toTrackRow);

  const topDays = (await query(`
    SELECT CAST(CAST(played_at AS DATE) AS VARCHAR) AS day,
           ROUND(SUM(ms_played)/60000.0, 1) AS minutes, COUNT(*) AS plays
    FROM plays_resolved WHERE artist_id = $1 ${PW()} GROUP BY 1 ORDER BY minutes DESC LIMIT 5`, [artistId])).map(toDayCell);

  const albums = (await query(`
    SELECT album_id AS "albumId", album_name AS album, artist_id AS "artistId", artist_name AS artist,
           COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours
    FROM plays_resolved WHERE artist_id = $1 AND album_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3, 4 ORDER BY hours DESC LIMIT 8`, [artistId])).map(toAlbumRow);

  const totalAlbumHours = albums.reduce((s, a) => s + a.hours, 0);
  const albumLoyalty = albums[0] && num(t.hours) > 0 ? { album: albums[0].album, share: albums[0].hours / Math.max(num(t.hours), totalAlbumHours, 0.1) } : null;

  return {
    artistId, artist: String(t.name), aliases,
    plays: num(t.plays), hours: num(t.hours), uniqueTracks: num(t.tracks),
    skipRate: num(t.skip_rate), firstPlayed: String(t.first_played), lastPlayed: String(t.last_played),
    rank: rankRow ? num(rankRow.rank) : null,
    monthly, topTracks, clock, topDays, albums, lateNightShare: num(t.late_share), albumLoyalty,
  };
}

// Track -------------------------------------------------------------------------
export async function getTrackDetail(trackId: string): Promise<TrackDetail | null> {
  const today = localToday();
  const [t] = await query(`
    SELECT tr.name, tr.artist_id, a.name AS artist_name, tr.album_id, al.name AS album_name,
           tr.duration_ms, tr.duration_ms_est,
           COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 2) AS hours,
           ROUND(AVG(CASE WHEN was_skipped THEN 1 ELSE 0 END), 3) AS skip_rate,
           CAST(MIN(played_at) AS VARCHAR) AS first_played, CAST(MAX(played_at) AS VARCHAR) AS last_played
    FROM plays_resolved p
    JOIN tracks tr ON tr.track_id = p.track_id
    LEFT JOIN artists a ON a.artist_id = tr.artist_id
    LEFT JOIN albums al ON al.album_id = tr.album_id
    WHERE p.track_id = $1 ${playsWhere('p')}
    GROUP BY tr.name, tr.artist_id, a.name, tr.album_id, al.name, tr.duration_ms, tr.duration_ms_est`, [trackId]);
  if (!t || num(t.plays) === 0) return null;

  const [rankRow] = await query(`
    SELECT rank FROM (SELECT track_id, RANK() OVER (ORDER BY COUNT(*) DESC) AS rank FROM plays_resolved WHERE track_id IS NOT NULL ${PW()} GROUP BY track_id)
    WHERE track_id = $1`, [trackId]);

  const monthly = toMonthly(await query(MONTHLY_SQL(24, 'AND track_id = $2'), [today, trackId]));
  const clock = (await query(CLOCK_SQL('WHERE track_id = $1'), [trackId])).map(toHour);

  // Where you bail (INS-04 seed): skipped plays bucketed to 10 s.
  const exitPoints = (await query(`
    SELECT (ms_played // 10000) * 10000 AS ms, COUNT(*) AS n
    FROM plays_resolved WHERE track_id = $1 AND was_skipped GROUP BY 1 ORDER BY 1`, [trackId]))
    .map((r) => ({ msPlayed: num(r.ms), count: num(r.n) }));
  const [early] = await query(`
    SELECT AVG(ms_played) AS mean_ms, STDDEV(ms_played) AS sd_ms, COUNT(*) AS n
    FROM plays_resolved WHERE track_id = $1 AND was_skipped`, [trackId]);
  const earlyExitMs = early && num(early.n) >= 6 && num(early.sd_ms) < 10000 ? num(early.mean_ms) : null;

  const neighbours = (dir: 'before' | 'after') => query(`
    SELECT ${dir === 'before' ? 'from_track_id' : 'to_track_id'} AS id, t.name AS track, a.name AS artist, s.count
    FROM session_transitions s
    JOIN tracks t ON t.track_id = ${dir === 'before' ? 's.from_track_id' : 's.to_track_id'}
    LEFT JOIN artists a ON a.artist_id = t.artist_id
    WHERE ${dir === 'before' ? 's.to_track_id' : 's.from_track_id'} = $1 ORDER BY s.count DESC LIMIT 6`, [trackId]);
  const mapN = (rows: Record<string, unknown>[]) => rows.map((r) => ({ trackId: String(r.id), track: String(r.track), artist: String(r.artist ?? ''), count: num(r.count) }));
  const before = mapN(await neighbours('before'));
  const after = mapN(await neighbours('after'));

  const recentPlays = (await query(`SELECT ${PLAY_COLS} FROM plays_resolved WHERE track_id = $1 ${PW()} ORDER BY played_at DESC LIMIT 15`, [trackId])).map(toPlayRow);
  const aliases = (await query(`SELECT DISTINCT alt_name FROM track_aliases WHERE track_id = $1`, [trackId])).map((r) => String(r.alt_name));

  return {
    trackId, track: String(t.name), artistId: str(t.artist_id), artist: String(t.artist_name ?? ''),
    albumId: str(t.album_id), album: str(t.album_name),
    plays: num(t.plays), hours: num(t.hours), skipRate: num(t.skip_rate),
    durationMs: t.duration_ms != null ? num(t.duration_ms) : t.duration_ms_est != null ? num(t.duration_ms_est) : null,
    durationEstimated: t.duration_ms == null,
    firstPlayed: String(t.first_played), lastPlayed: String(t.last_played),
    rank: rankRow ? num(rankRow.rank) : null,
    monthly, clock, exitPoints, earlyExitMs, before, after, recentPlays, aliases,
  };
}

// Album -------------------------------------------------------------------------
export async function getAlbumDetail(albumId: string): Promise<AlbumDetail | null> {
  const today = localToday();
  const [t] = await query(`
    SELECT al.name, al.artist_id, a.name AS artist_name,
           COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours,
           ROUND(AVG(CASE WHEN was_skipped THEN 1 ELSE 0 END), 3) AS skip_rate,
           CAST(MIN(played_at) AS VARCHAR) AS first_played, CAST(MAX(played_at) AS VARCHAR) AS last_played
    FROM plays_resolved p JOIN albums al ON al.album_id = p.album_id LEFT JOIN artists a ON a.artist_id = al.artist_id
    WHERE p.album_id = $1 ${playsWhere('p')} GROUP BY al.name, al.artist_id, a.name`, [albumId]);
  if (!t || num(t.plays) === 0) return null;

  const tracks = (await query(`
    SELECT ${TRACK_ROW} FROM plays_resolved WHERE album_id = $1 AND track_id IS NOT NULL ${PW()}
    GROUP BY 1, 2, 3, 4 ORDER BY plays DESC`, [albumId])).map(toTrackRow);

  const monthly = toMonthly(await query(MONTHLY_SQL(24, 'AND album_id = $2'), [today, albumId]));

  // Sessions where this album was ridden: ≥ 6 consecutive plays from it.
  const [ride] = await query(`
    WITH s AS (SELECT ps.session_id, COUNT(*) AS n FROM plays_resolved p JOIN play_sessions ps USING (play_id)
               WHERE p.album_id = $1 GROUP BY 1)
    SELECT COUNT(*) AS rides FROM s JOIN sessions USING (session_id) WHERE album_ride AND n >= 6`, [albumId]);

  const [share] = await query(`
    SELECT SUM(CASE WHEN album_id = $1 THEN ms_played ELSE 0 END) * 1.0 / NULLIF(SUM(ms_played), 0) AS share
    FROM plays_resolved WHERE artist_id = $2 ${PW()}`, [albumId, String(t.artist_id ?? '')]);

  return {
    albumId, album: String(t.name), artistId: str(t.artist_id), artist: String(t.artist_name ?? ''),
    plays: num(t.plays), hours: num(t.hours), skipRate: num(t.skip_rate),
    firstPlayed: String(t.first_played), lastPlayed: String(t.last_played),
    tracks, monthly, rideCount: num(ride?.rides), shareOfArtist: num(share?.share),
  };
}

// Search ------------------------------------------------------------------------
export async function search(q: string): Promise<SearchResults> {
  const term = q.trim();
  if (term.length < 2) return { q: term, artists: [], tracks: [], albums: [] };
  const like = `%${term}%`;

  const artists = (await query(`
    SELECT ${ARTIST_ROW} FROM ${TOP_ARTISTS()}
    WHERE artist_id IN (SELECT artist_id FROM artist_aliases WHERE alias_name ILIKE $1)
    ORDER BY hours DESC LIMIT 15`, [like])).map(toArtistRow);

  const tracks = (await query(`
    SELECT ${TRACK_ROW} FROM plays_resolved WHERE track_name ILIKE $1 AND track_id IS NOT NULL ${PW()}
    GROUP BY 1, 2, 3, 4 ORDER BY plays DESC LIMIT 25`, [like])).map(toTrackRow);

  const albums = (await query(`
    SELECT album_id AS "albumId", album_name AS album, artist_id AS "artistId", artist_name AS artist,
           COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours
    FROM plays_resolved WHERE album_name ILIKE $1 AND album_id IS NOT NULL ${PW()}
    GROUP BY 1, 2, 3, 4 ORDER BY plays DESC LIMIT 12`, [like])).map(toAlbumRow);

  return { q: term, artists, tracks, albums };
}

// Row mappers -----------------------------------------------------------------
const toDayCell = (r: Record<string, unknown>): DayCell => ({ day: String(r.day), minutes: num(r.minutes), plays: num(r.plays) });
const toHour = (r: Record<string, unknown>): HourSlice => ({ hour: num(r.hour), hours: num(r.hours) });
const toArtistRow = (r: Record<string, unknown>): ArtistRow => ({ artistId: String(r.artistId), artist: String(r.artist), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) });
const toTrackRow = (r: Record<string, unknown>): TrackRow => ({ trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) });
const toAlbumRow = (r: Record<string, unknown>): AlbumRow => ({ albumId: String(r.albumId), album: String(r.album), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), imageUrl: str(r.imageUrl) });
const toPlayRow = (r: Record<string, unknown>): PlayRow => ({
  playedAt: String(r.playedAt), trackId: str(r.trackId), track: String(r.track), artistId: str(r.artistId),
  artist: String(r.artist ?? ''), album: str(r.album), msPlayed: num(r.msPlayed), skipped: Boolean(r.skipped), attended: r.attended === undefined ? true : Boolean(r.attended), platform: str(r.platform),
});
const toSessionRow = (r: Record<string, unknown>): SessionRow => ({
  sessionId: String(r.sessionId), startAt: String(r.startAt), endAt: String(r.endAt),
  trackCount: num(r.trackCount), skipCount: num(r.skipCount), uniqueArtists: num(r.uniqueArtists), totalMs: num(r.totalMs),
  shape: String(r.shape), openingTrack: String(r.openingTrack ?? ''), closingTrack: String(r.closingTrack ?? ''), platform: str(r.platform),
  completionRate: num(r.completionRate), completionSource: String(r.completionSource ?? ''), skipRate: num(r.skipRate),
  repeatRate: num(r.repeatRate), noveltyRate: num(r.noveltyRate), artistEntropy: num(r.artistEntropy),
  dayPart: String(r.dayPart ?? ''), albumRide: Boolean(r.albumRide),
  attention: String(r.attention ?? 'active'), interactions: num(r.interactions), unattendedMs: num(r.unattendedMs),
  chaos: r.chaos == null ? null : num(r.chaos),
});

export { albumHref, artistHref };

/** Years present in the record (for the year-range filter). Unfiltered on purpose. */
export async function getYears(): Promise<number[]> {
  const rows = await query(`SELECT DISTINCT EXTRACT(year FROM played_at)::INT AS y FROM plays_resolved ORDER BY 1`);
  return rows.map((r) => num(r.y));
}

/** Expandable top lists (dashboard / review). `range` = [from, toExclusive] ISO dates. */
export async function topArtists(n: number, range?: [string, string]): Promise<ArtistRow[]> {
  const W = range ? `AND played_at >= DATE '${range[0]}' AND played_at < DATE '${range[1]}'` : '';
  return (await query(`SELECT artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours, ROUND(AVG(CASE WHEN was_skipped THEN 1 ELSE 0 END), 3) AS "skipRate"
    FROM plays_resolved WHERE artist_id IS NOT NULL ${W} ${PW()} GROUP BY 1, 2 ORDER BY hours DESC LIMIT ${Math.min(500, n)}`)).map(toArtistRow);
}
export async function topTracks(n: number, range?: [string, string], by: 'plays' | 'hours' = 'plays'): Promise<TrackRow[]> {
  const W = range ? `AND played_at >= DATE '${range[0]}' AND played_at < DATE '${range[1]}'` : '';
  return (await query(`SELECT ${TRACK_ROW} FROM plays_resolved WHERE track_id IS NOT NULL ${W} ${PW()} GROUP BY 1, 2, 3, 4 ORDER BY ${by === 'plays' ? 'plays' : 'SUM(ms_played)'} DESC LIMIT ${Math.min(500, n)}`)).map(toTrackRow);
}
export async function topAlbums(n: number, range?: [string, string]): Promise<AlbumRow[]> {
  const W = range ? `AND played_at >= DATE '${range[0]}' AND played_at < DATE '${range[1]}'` : '';
  return (await query(`SELECT p.album_id AS "albumId", p.album_name AS album, p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, ANY_VALUE(al.image_url) AS "imageUrl"
    FROM plays_resolved p LEFT JOIN albums al ON al.album_id = p.album_id WHERE p.album_id IS NOT NULL ${W.replace(/played_at/g, 'p.played_at')} ${playsWhere('p')} GROUP BY 1, 2, 3, 4 ORDER BY hours DESC LIMIT ${Math.min(500, n)}`)).map(toAlbumRow);
}

/** Recent milestones (INS-11), newest first, unseen first. */
export async function recentMilestones(limit = 8): Promise<{ id: string; type: string; description: string; occurredAt: string; subjectType: string; subjectId: string; seen: boolean }[]> {
  const rows = await query(`SELECT CAST(milestone_id AS VARCHAR) AS id, type, description, CAST(occurred_at AS VARCHAR) AS at, subject_type, subject_id, seen FROM milestones
    WHERE (occurred_at >= now() - INTERVAL 45 DAY AND type <> 'first_play_anniversary') OR (type = 'first_play_anniversary' AND occurred_at >= now() - INTERVAL 14 DAY AND value >= 5) ORDER BY seen, occurred_at DESC LIMIT ${limit}`);
  return rows.map((r) => ({ id: String(r.id), type: String(r.type), description: String(r.description), occurredAt: String(r.at), subjectType: String(r.subject_type), subjectId: String(r.subject_id), seen: Boolean(r.seen) }));
}
