/**
 * Phase 8 (roadmap §3.6) — record hygiene. Surfaces the outlier classes the
 * "So Excited" investigation exposed so they can be reviewed in one place
 * instead of being found by accident on a track page.
 *
 * Deliberately ignores the global listening filter: hygiene is about the raw
 * record, and an unattended session is exactly the thing the Attentive lens
 * would hide.
 */
import { query, num, str } from './db';

export type StuckSession = {
  sessionId: string; startAt: string; endAt: string; track: string; trackId: string | null; artist: string;
  plays: number; minutes: number; attention: string; overridden: boolean;
};

/** Sessions flagged stuck_repeat: one track completing naturally 8+ times in a row with no clicks. */
export async function stuckRepeatSessions(limit = 100): Promise<StuckSession[]> {
  return (await query(`
    WITH top AS (
      SELECT ps.session_id, arg_max(p.track_name, c) AS track, arg_max(p.track_id, c) AS track_id, arg_max(p.artist_name, c) AS artist, MAX(c) AS plays
      FROM (SELECT ps.session_id, p.track_id, COUNT(*) AS c FROM play_sessions ps JOIN plays_resolved p USING (play_id) GROUP BY 1, 2) x
      JOIN play_sessions ps ON ps.session_id = x.session_id JOIN plays_resolved p ON p.play_id = ps.play_id AND p.track_id = x.track_id
      GROUP BY 1)
    SELECT CAST(s.session_id AS VARCHAR) AS session_id, CAST(s.start_at AS VARCHAR) AS start_at, CAST(s.end_at AS VARCHAR) AS end_at,
           t.track, t.track_id, t.artist, t.plays, ROUND(s.total_ms / 60000.0) AS minutes, s.attention,
           EXISTS (SELECT 1 FROM session_overrides o WHERE o.start_at = s.start_at) AS overridden
    FROM sessions s JOIN top t USING (session_id)
    WHERE s.stuck_repeat ORDER BY s.total_ms DESC LIMIT ${limit}`)).map((r) => ({
    sessionId: String(r.session_id), startAt: String(r.start_at), endAt: String(r.end_at), track: String(r.track ?? ''), trackId: str(r.track_id), artist: String(r.artist ?? ''),
    plays: num(r.plays), minutes: num(r.minutes), attention: String(r.attention ?? 'active'), overridden: Boolean(r.overridden),
  }));
}

export type ShortTrackOutlier = { trackId: string; track: string; artist: string; durationS: number; plays: number; attendedPlays: number; topDay: string; topDayPlays: number };

/**
 * Very short tracks (<45 s known length) whose play count is out of proportion —
 * the class stuck_repeat is a special case of. Ranked by how concentrated the
 * plays are on a single day: a jingle you genuinely love is spread out; a loop is a spike.
 */
export async function shortTrackOutliers(limit = 40): Promise<ShortTrackOutlier[]> {
  return (await query(`
    WITH d AS (SELECT track_id, COALESCE(duration_ms, duration_ms_est) AS dur FROM tracks WHERE COALESCE(duration_ms, duration_ms_est) BETWEEN 1000 AND 45000),
    per_day AS (SELECT p.track_id, CAST(p.played_at AS DATE) AS day, COUNT(*) AS n FROM plays_resolved p JOIN d USING (track_id) GROUP BY 1, 2),
    agg AS (SELECT p.track_id, arg_max(p.track_name, p.play_index) AS track, arg_max(p.artist_name, p.play_index) AS artist, COUNT(*) AS plays,
                   COUNT(*) FILTER (WHERE p.attended) AS attended FROM plays_resolved p JOIN d USING (track_id) GROUP BY 1 HAVING COUNT(*) >= 25)
    SELECT a.track_id, a.track, a.artist, ROUND(d.dur / 1000.0) AS duration_s, a.plays, a.attended,
           CAST(arg_max(pd.day, pd.n) AS VARCHAR) AS top_day, MAX(pd.n) AS top_day_plays
    FROM agg a JOIN d USING (track_id) JOIN per_day pd USING (track_id)
    GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY MAX(pd.n) DESC, a.plays DESC LIMIT ${limit}`)).map((r) => ({
    trackId: String(r.track_id), track: String(r.track), artist: String(r.artist), durationS: num(r.duration_s), plays: num(r.plays), attendedPlays: num(r.attended),
    topDay: String(r.top_day), topDayPlays: num(r.top_day_plays),
  }));
}

export type Overrun = { trackId: string; track: string; artist: string; plays: number; worstMs: number; durationMs: number };

/** Plays whose ms_played exceeds the known track length by more than 10 % — clock glitches or wrong metadata. */
export async function overrunPlays(limit = 30): Promise<Overrun[]> {
  return (await query(`
    SELECT p.track_id, arg_max(p.track_name, p.ms_played) AS track, arg_max(p.artist_name, p.ms_played) AS artist, COUNT(*) AS plays,
           MAX(p.ms_played) AS worst_ms, MAX(t.duration_ms) AS duration_ms
    FROM plays_resolved p JOIN tracks t USING (track_id)
    WHERE t.duration_ms IS NOT NULL AND t.duration_ms > 0 AND p.ms_played > t.duration_ms * 1.1 + 2000
    GROUP BY 1 ORDER BY plays DESC, worst_ms DESC LIMIT ${limit}`)).map((r) => ({
    trackId: String(r.track_id), track: String(r.track), artist: String(r.artist), plays: num(r.plays), worstMs: num(r.worst_ms), durationMs: num(r.duration_ms),
  }));
}

export type Integrity = {
  plays: number; unattendedShare: number; stuckSessions: number; stuckHours: number; overriddenSessions: number;
  impossibleDays: number;    // days with > 24 h of played time
  overrunPlays: number; enrichedShare: number; tzOverrides: number; mergedArtists: number; wildCaptures: number;
};

/** One-glance confidence card: how clean is the record right now? */
export async function integrity(): Promise<Integrity> {
  const [r] = await query(`
    SELECT (SELECT COUNT(*) FROM plays_resolved) AS plays,
           (SELECT AVG(CASE WHEN attended THEN 0.0 ELSE 1.0 END) FROM plays_resolved) AS unattended_share,
           (SELECT COUNT(*) FROM sessions WHERE stuck_repeat) AS stuck_sessions,
           (SELECT COALESCE(SUM(total_ms), 0) / 3600000.0 FROM sessions WHERE stuck_repeat) AS stuck_hours,
           (SELECT COUNT(*) FROM session_overrides) AS overridden,
           (SELECT COUNT(*) FROM (SELECT CAST(played_at AS DATE) d, SUM(ms_played) ms FROM plays_resolved GROUP BY 1 HAVING SUM(ms_played) > 24 * 3600000)) AS impossible_days,
           (SELECT COUNT(*) FROM plays_resolved p JOIN tracks t USING (track_id) WHERE t.duration_ms > 0 AND p.ms_played > t.duration_ms * 1.1 + 2000) AS overrun,
           (SELECT AVG(CASE WHEN enriched_at IS NOT NULL THEN 1.0 ELSE 0.0 END) FROM tracks WHERE track_id NOT LIKE 'local:%') AS enriched_share,
           (SELECT COUNT(*) FROM tz_overrides) AS tz_overrides,
           (SELECT COUNT(*) FROM artist_merges) AS merges,
           (SELECT COUNT(*) FROM wild_plays) AS wild`);
  return {
    plays: num(r?.plays), unattendedShare: num(r?.unattended_share), stuckSessions: num(r?.stuck_sessions), stuckHours: num(r?.stuck_hours), overriddenSessions: num(r?.overridden),
    impossibleDays: num(r?.impossible_days), overrunPlays: num(r?.overrun), enrichedShare: num(r?.enriched_share), tzOverrides: num(r?.tz_overrides), mergedArtists: num(r?.merges), wildCaptures: num(r?.wild),
  };
}

// ---------------------------------------------------------------- Phase 10: ISRC duplicates (synthesis §1.4)
export type IsrcGroup = { isrc: string; track: string; artist: string; versions: { trackId: string; album: string | null; plays: number }[]; plays: number };
/** The same recording (one ISRC) under several track ids — a single, the album cut, a reissue — which splits its plays. */
export async function isrcDuplicates(limit = 40): Promise<{ groups: IsrcGroup[]; totalGroups: number; splitPlays: number }> {
  const rows = await query(`
    WITH t AS (SELECT t.track_id, upper(replace(t.isrc, '-', '')) AS isrc, t.name, a.name AS artist, al.name AS album FROM tracks t LEFT JOIN artists a USING (artist_id) LEFT JOIN albums al USING (album_id)
               WHERE t.isrc IS NOT NULL AND length(t.isrc) >= 12),
         g AS (SELECT isrc FROM t GROUP BY 1 HAVING COUNT(DISTINCT track_id) >= 2),
         p AS (SELECT track_id, COUNT(*) AS n FROM plays_resolved GROUP BY 1)
    SELECT t.isrc, arg_max(t.name, COALESCE(p.n, 0)) AS track, arg_max(t.artist, COALESCE(p.n, 0)) AS artist, SUM(COALESCE(p.n, 0)) AS plays,
           list({'trackId': t.track_id, 'album': t.album, 'plays': COALESCE(p.n, 0)} ORDER BY COALESCE(p.n, 0) DESC) AS versions, COUNT(*) FILTER (WHERE COALESCE(p.n, 0) > 0) AS played_versions
    FROM t JOIN g USING (isrc) LEFT JOIN p USING (track_id) GROUP BY 1 HAVING COUNT(*) FILTER (WHERE COALESCE(p.n, 0) > 0) >= 2 ORDER BY plays DESC`);
  const groups = rows.map((r) => ({ isrc: String(r.isrc), track: String(r.track), artist: String(r.artist ?? ''), plays: num(r.plays),
    versions: (Array.isArray(r.versions) ? r.versions as { trackId: string; album: string | null; plays: number }[] : []).map((v) => ({ trackId: String(v.trackId), album: v.album == null ? null : String(v.album), plays: num(v.plays) })) }));
  return { groups: groups.slice(0, limit), totalGroups: groups.length, splitPlays: groups.reduce((a, g) => a + g.plays - (g.versions[0]?.plays ?? 0), 0) };
}
