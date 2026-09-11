/**
 * Session analytics (spec §6.3 SES-11…14, plus attention and year trends).
 * Everything honours the global listening filter.
 */
import { query, num, str } from './db';
import { playsWhere, sessionsWhere } from './filter';
import type { SessionRow } from './types';

export type SessionFilters = {
  shape: string | null;
  dayPart: string | null;
  platform: string | null;   // platform family
  attention: string | null;
  minTracks: number;
  q: string;                 // Phase 8 (§3.4): artist or track name contained in the session
  sort: 'recent' | 'oldest' | 'longest' | 'most_tracks' | 'skippiest';
  page: number;
};
export const DEFAULT_SESSION_FILTERS: SessionFilters = { shape: null, dayPart: null, platform: null, attention: null, minTracks: 3, q: '', sort: 'recent', page: 0 };
export const PAGE = 40;

/** Platform strings are messy ("Windows 7 (6.1.7601; x64…)", "Partner roku_tv rca;…"). Bucket them. */
export const PLATFORM_FAMILY = `
  CASE
    WHEN lower(platform) LIKE '%auto%' OR lower(platform) LIKE '%car%' OR lower(platform) LIKE '%carplay%' THEN 'Car'
    WHEN lower(platform) LIKE 'android%'                                   THEN 'Android'
    WHEN lower(platform) LIKE 'ios%' OR lower(platform) LIKE '%iphone%' OR lower(platform) LIKE '%ipad%' THEN 'iPhone / iPad'
    WHEN lower(platform) LIKE 'windows%'                                   THEN 'Windows'
    WHEN lower(platform) LIKE 'os x%' OR lower(platform) LIKE 'macos%' OR lower(platform) LIKE 'mac%' THEN 'Mac'
    WHEN lower(platform) LIKE 'linux%'                                     THEN 'Linux'
    WHEN lower(platform) LIKE 'web%'                                       THEN 'Web player'
    WHEN lower(platform) LIKE '%playstation%' OR lower(platform) LIKE '%xbox%' THEN 'Console'   -- before 'partner%': consoles arrive as "Partner playstation4 …" (caught by platformFamily.test.ts)
    WHEN lower(platform) LIKE 'partner%' OR lower(platform) LIKE '%tv%' OR lower(platform) LIKE '%sonos%' OR lower(platform) LIKE '%speaker%' OR lower(platform) LIKE '%cast%' THEN 'TV / speaker'
    WHEN platform IS NULL THEN 'Unknown'
    ELSE 'Other'
  END`;

const SESSION_COLS = `
  CAST(session_id AS VARCHAR) AS "sessionId", CAST(start_at AS VARCHAR) AS "startAt", CAST(end_at AS VARCHAR) AS "endAt",
  track_count AS "trackCount", skip_count AS "skipCount", unique_artist_count AS "uniqueArtists", total_ms AS "totalMs",
  session_shape AS shape, opening_track AS "openingTrack", closing_track AS "closingTrack", platform,
  ROUND(completion_rate, 3) AS "completionRate", completion_source AS "completionSource", ROUND(skip_rate, 3) AS "skipRate",
  ROUND(repeat_rate, 3) AS "repeatRate", ROUND(novelty_rate, 3) AS "noveltyRate", ROUND(artist_entropy, 2) AS "artistEntropy",
  day_part AS "dayPart", album_ride AS "albumRide", attention, interaction_count AS interactions, unattended_ms AS "unattendedMs"`;

export const toSessionRow = (r: Record<string, unknown>): SessionRow => ({
  sessionId: String(r.sessionId), startAt: String(r.startAt), endAt: String(r.endAt),
  trackCount: num(r.trackCount), skipCount: num(r.skipCount), uniqueArtists: num(r.uniqueArtists), totalMs: num(r.totalMs),
  shape: String(r.shape), openingTrack: String(r.openingTrack ?? ''), closingTrack: String(r.closingTrack ?? ''), platform: str(r.platform),
  completionRate: num(r.completionRate), completionSource: String(r.completionSource ?? ''), skipRate: num(r.skipRate),
  repeatRate: num(r.repeatRate), noveltyRate: num(r.noveltyRate), artistEntropy: num(r.artistEntropy),
  dayPart: String(r.dayPart ?? ''), albumRide: Boolean(r.albumRide),
  attention: String(r.attention ?? 'active'), interactions: num(r.interactions), unattendedMs: num(r.unattendedMs),
  topArtists: Array.isArray(r.topArtists) ? (r.topArtists as unknown[]).map(String) : undefined,
});

export type SessionsOverview = {
  count: number; medianMin: number; p90Min: number; marathonCount: number; avgTracks: number;
  completion: number; skipRate: number; noveltyRate: number; repeatRate: number;
  attention: { active: number; drifting: number; unattended: number };     // hours
  shapes: { shape: string; count: number; hours: number }[];
  shapesByYear: { year: number; shape: string; count: number }[];
  heat: { dow: number; hour: number; sessions: number; minutes: number }[];
  lengthHist: { bucket: string; count: number; lo: number }[];
  byYear: { year: number; sessions: number; medianMin: number; completion: number; skipRate: number; noveltyRate: number; attendedHours: number; unattendedHours: number }[];
  skipByDayPart: { dayPart: string; skipRate: number; plays: number }[];
  skipByPlatform: { platform: string; skipRate: number; plays: number }[];
  openers: { trackId: string; track: string; artist: string; count: number }[];
  closers: { trackId: string; track: string; artist: string; count: number }[];
  morningOpeners: { trackId: string; track: string; artist: string; count: number }[];
  lateClosers: { trackId: string; track: string; artist: string; count: number }[];
  platforms: string[];
};

export async function getSessionsOverview(): Promise<SessionsOverview> {
  const SW = sessionsWhere();
  const PW = playsWhere('p');
  const base = `FROM sessions WHERE track_count >= 2 ${SW}`;

  const [t] = await query(`
    SELECT COUNT(*) AS n,
           quantile_cont((epoch(end_at) - epoch(start_at)) / 60.0, 0.5) AS med,
           quantile_cont((epoch(end_at) - epoch(start_at)) / 60.0, 0.9) AS p90,
           COUNT(*) FILTER (WHERE (epoch(end_at) - epoch(start_at)) / 60.0 >= 180) AS marathons,
           AVG(track_count) AS avg_tracks,
           AVG(completion_rate) AS completion, AVG(skip_rate) AS skip_rate,
           AVG(novelty_rate) AS novelty, AVG(repeat_rate) AS repeat_rate
    ${base}`);

  const att = await query(`SELECT attention, SUM(total_ms)/3600000.0 AS h FROM sessions WHERE 1=1 ${SW} GROUP BY 1`);
  const attention = { active: 0, drifting: 0, unattended: 0 };
  for (const r of att) (attention as Record<string, number>)[String(r.attention)] = num(r.h);

  const shapes = (await query(`SELECT session_shape AS shape, COUNT(*) AS count, ROUND(SUM(total_ms)/3600000.0, 1) AS hours ${base} GROUP BY 1 ORDER BY 2 DESC`))
    .map((r) => ({ shape: String(r.shape), count: num(r.count), hours: num(r.hours) }));

  const shapesByYear = (await query(`SELECT EXTRACT(year FROM start_at)::INT AS year, session_shape AS shape, COUNT(*) AS count ${base} GROUP BY 1, 2 ORDER BY 1`))
    .map((r) => ({ year: num(r.year), shape: String(r.shape), count: num(r.count) }));

  const heat = (await query(`
    SELECT EXTRACT(dow FROM start_at)::INT AS dow, EXTRACT(hour FROM start_at)::INT AS hour,
           COUNT(*) AS sessions, ROUND(SUM(total_ms)/60000.0) AS minutes
    ${base} GROUP BY 1, 2`)).map((r) => ({ dow: num(r.dow), hour: num(r.hour), sessions: num(r.sessions), minutes: num(r.minutes) }));

  const lengthHist = (await query(`
    WITH b AS (SELECT * FROM (VALUES (0,'<15 min'),(15,'15–30'),(30,'30–60'),(60,'1–2 h'),(120,'2–3 h'),(180,'3–5 h'),(300,'5–8 h'),(480,'8 h+')) v(lo, label)),
         s AS (SELECT (epoch(end_at) - epoch(start_at)) / 60.0 AS mins ${base})
    SELECT b.label AS bucket, b.lo, COUNT(s.mins) AS count
    FROM b LEFT JOIN s ON s.mins >= b.lo AND s.mins < COALESCE((SELECT MIN(lo) FROM b b2 WHERE b2.lo > b.lo), 1e9)
    GROUP BY 1, 2 ORDER BY b.lo`)).map((r) => ({ bucket: String(r.bucket), lo: num(r.lo), count: num(r.count) }));

  const byYear = (await query(`
    SELECT EXTRACT(year FROM start_at)::INT AS year, COUNT(*) AS sessions,
           quantile_cont((epoch(end_at) - epoch(start_at)) / 60.0, 0.5) AS med,
           AVG(completion_rate) AS completion, AVG(skip_rate) AS skip_rate, AVG(novelty_rate) AS novelty,
           SUM(attended_ms)/3600000.0 AS att_h, SUM(unattended_ms)/3600000.0 AS unatt_h
    ${base} GROUP BY 1 ORDER BY 1`)).map((r) => ({
      year: num(r.year), sessions: num(r.sessions), medianMin: num(r.med), completion: num(r.completion),
      skipRate: num(r.skip_rate), noveltyRate: num(r.novelty), attendedHours: num(r.att_h), unattendedHours: num(r.unatt_h),
    }));

  const skipByDayPart = (await query(`
    SELECT s.day_part AS day_part, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS skip_rate, COUNT(*) AS plays
    FROM plays_resolved p JOIN play_sessions ps USING (play_id) JOIN sessions s USING (session_id)
    WHERE 1=1 ${PW} ${sessionsWhere('s')} GROUP BY 1`)).map((r) => ({ dayPart: String(r.day_part), skipRate: num(r.skip_rate), plays: num(r.plays) }));

  const skipByPlatform = (await query(`
    SELECT ${PLATFORM_FAMILY} AS fam, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS skip_rate, COUNT(*) AS plays
    FROM plays_resolved p WHERE 1=1 ${PW} GROUP BY 1 HAVING COUNT(*) >= 200 ORDER BY plays DESC`))
    .map((r) => ({ platform: String(r.fam), skipRate: num(r.skip_rate), plays: num(r.plays) }));

  const edge = (col: 'opening_track_id' | 'closing_track_id', extra = '') => query(`
    SELECT s.${col} AS id, t.name AS track, a.name AS artist, COUNT(*) AS count
    FROM sessions s JOIN tracks t ON t.track_id = s.${col} LEFT JOIN artists a ON a.artist_id = t.artist_id
    WHERE s.track_count >= 3 ${SW} ${extra} GROUP BY 1, 2, 3 ORDER BY count DESC LIMIT 10`);
  const mapE = (rows: Record<string, unknown>[]) => rows.map((r) => ({ trackId: String(r.id), track: String(r.track), artist: String(r.artist ?? ''), count: num(r.count) }));
  const openers = mapE(await edge('opening_track_id'));
  const closers = mapE(await edge('closing_track_id'));
  const morningOpeners = mapE(await edge('opening_track_id', "AND s.day_part = 'morning'"));
  const lateClosers = mapE(await edge('closing_track_id', "AND (s.day_part IN ('night','late') OR s.is_late_night)"));

  const platforms = (await query(`SELECT DISTINCT ${PLATFORM_FAMILY} AS fam FROM sessions ORDER BY 1`)).map((r) => String(r.fam));

  return {
    count: num(t?.n), medianMin: num(t?.med), p90Min: num(t?.p90), marathonCount: num(t?.marathons), avgTracks: num(t?.avg_tracks),
    completion: num(t?.completion), skipRate: num(t?.skip_rate), noveltyRate: num(t?.novelty), repeatRate: num(t?.repeat_rate),
    attention, shapes, shapesByYear, heat, lengthHist, byYear, skipByDayPart, skipByPlatform,
    openers, closers, morningOpeners, lateClosers, platforms,
  };
}

export async function listSessions(f: SessionFilters): Promise<{ rows: SessionRow[]; total: number }> {
  const parts = [`track_count >= ${Math.max(1, Math.floor(f.minTracks))}`];
  const params: unknown[] = [];
  if (f.shape) { params.push(f.shape); parts.push(`session_shape = $${params.length}`); }
  if (f.dayPart) { params.push(f.dayPart); parts.push(`day_part = $${params.length}`); }
  if (f.attention) { params.push(f.attention); parts.push(`attention = $${params.length}`); }
  if (f.platform) { params.push(f.platform); parts.push(`${PLATFORM_FAMILY} = $${params.length}`); }
  if (f.q && f.q.trim()) {
    params.push(`%${f.q.trim().toLowerCase()}%`);
    parts.push(`EXISTS (SELECT 1 FROM play_sessions ps JOIN plays_resolved p USING (play_id) WHERE ps.session_id = sessions.session_id AND (lower(p.artist_name) LIKE $${params.length} OR lower(p.track_name) LIKE $${params.length}))`);
  }
  const where = `WHERE ${parts.join(' AND ')} ${sessionsWhere()}`;
  const order = { recent: 'start_at DESC', oldest: 'start_at ASC', longest: 'total_ms DESC', most_tracks: 'track_count DESC', skippiest: 'skip_rate DESC, track_count DESC' }[f.sort];
  // Top artists per session (by plays) for the card face — computed only for the page being shown.
  const rows = (await query(`
    WITH page AS (SELECT * FROM sessions ${where} ORDER BY ${order} LIMIT ${PAGE} OFFSET ${f.page * PAGE}),
    ta AS (
      SELECT ps.session_id, list(artist_name ORDER BY n DESC, artist_name) FILTER (WHERE rn <= 2) AS top
      FROM (SELECT ps.session_id, p.artist_name, COUNT(*) AS n, ROW_NUMBER() OVER (PARTITION BY ps.session_id ORDER BY COUNT(*) DESC, p.artist_name) AS rn
            FROM play_sessions ps JOIN page USING (session_id) JOIN plays_resolved p USING (play_id) WHERE p.artist_name IS NOT NULL GROUP BY 1, 2) ps
      GROUP BY 1)
    SELECT ${SESSION_COLS}, ta.top AS "topArtists" FROM page LEFT JOIN ta USING (session_id) ORDER BY ${order}`, params)).map(toSessionRow);
  const [c] = await query(`SELECT COUNT(*) AS n FROM sessions ${where}`, params);
  return { rows, total: num(c?.n) };
}

export type SessionDetail = {
  session: SessionRow;
  plays: { position: number; playedAt: string; trackId: string | null; track: string; artistId: string | null; artist: string; album: string | null; msPlayed: number; skipped: boolean; attended: boolean; isFirstPlay: boolean; startReason: string | null; endReason: string | null }[];
  artists: { artistId: string; artist: string; plays: number }[];
};

export async function getSessionDetail(sessionId: string): Promise<SessionDetail | null> {
  const [s] = await query(`SELECT ${SESSION_COLS} FROM sessions WHERE CAST(session_id AS VARCHAR) = $1`, [sessionId]);
  if (!s) return null;
  const plays = (await query(`
    SELECT ps.position_in_session AS position, CAST(p.played_at AS VARCHAR) AS "playedAt", p.track_id AS "trackId", p.track_name AS track,
           p.artist_id AS "artistId", p.artist_name AS artist, p.album_name AS album, p.ms_played AS "msPlayed", p.was_skipped AS skipped,
           p.attended, p.is_first_play AS "isFirstPlay", p.start_reason AS "startReason", p.end_reason AS "endReason"
    FROM play_sessions ps JOIN plays_resolved p USING (play_id)
    WHERE CAST(ps.session_id AS VARCHAR) = $1 ORDER BY ps.position_in_session`, [sessionId])).map((r) => ({
      position: num(r.position), playedAt: String(r.playedAt), trackId: str(r.trackId), track: String(r.track), artistId: str(r.artistId),
      artist: String(r.artist ?? ''), album: str(r.album), msPlayed: num(r.msPlayed), skipped: Boolean(r.skipped), attended: Boolean(r.attended),
      isFirstPlay: Boolean(r.isFirstPlay), startReason: str(r.startReason), endReason: str(r.endReason),
    }));
  const artists = (await query(`
    SELECT p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays
    FROM play_sessions ps JOIN plays_resolved p USING (play_id)
    WHERE CAST(ps.session_id AS VARCHAR) = $1 AND p.artist_id IS NOT NULL GROUP BY 1, 2 ORDER BY plays DESC LIMIT 8`, [sessionId]))
    .map((r) => ({ artistId: String(r.artistId), artist: String(r.artist), plays: num(r.plays) }));
  return { session: toSessionRow(s), plays, artists };
}
