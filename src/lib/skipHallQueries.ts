/**
 * Phase 9d — Skip Hall of Fame / "Not for me" (summary §3.3): tracks repeatedly shown and repeatedly rejected,
 * the inverse of the obsessions detector.
 *   - exposure ≥ 8 plays (a single intro-skip on a song seen twice washes out on its own)
 *   - skip rate ≥ 85 % (7 of 8, not 4 of 5)
 *   - skip-spree sessions are excluded from the rate: a sitting with 10+ skips at a 70 %+ skip rate says
 *     something about the sitting, not the songs (the exact "10 consecutive" run isn't persisted; this is the proxy)
 *   - the owner's verdicts live in recommendation_feedback under engine 'skip_hall': 'accepted' = "give it a fair
 *     shot" (hidden 180 days), 'dismissed' = "confirmed not for me" (hidden for good). This is the first explicit
 *     negative signal the recommendation engines have; they can read it later.
 * Playlist-context vs own-play skips are not separable today (plays don't record which playlist they came from).
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';

export type SkipHallRow = { trackId: string; track: string; artistId: string | null; artist: string; shown: number; skipped: number; skipRate: number; firstSkipped: string; lastSkipped: string; sessions: number; meanMs: number; verdict: string | null };

export async function skipHall(limit = 60, minShown = 8, minRate = 0.85): Promise<{ rows: SkipHallRow[]; tried: SkipHallRow[]; confirmed: SkipHallRow[] }> {
  const rows = (await query(`
    WITH spree AS (SELECT session_id FROM sessions WHERE skip_count >= 10 AND skip_rate >= 0.7),
    p AS (SELECT p.track_id, p.track_name, p.artist_id, p.artist_name, p.was_skipped, p.played_at, p.ms_played, ps.session_id
          FROM plays_resolved p LEFT JOIN play_sessions ps USING (play_id)
          WHERE p.track_id IS NOT NULL ${playsWhere('p')} AND NOT EXISTS (SELECT 1 FROM spree s WHERE s.session_id = ps.session_id)),
    agg AS (SELECT track_id, arg_max(track_name, ms_played) AS track, arg_max(artist_id, ms_played) AS artist_id, arg_max(artist_name, ms_played) AS artist,
                   COUNT(*) AS shown, COUNT(*) FILTER (WHERE was_skipped) AS skipped, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr,
                   MIN(played_at) FILTER (WHERE was_skipped) AS first_s, MAX(played_at) FILTER (WHERE was_skipped) AS last_s, COUNT(DISTINCT session_id) AS sessions, AVG(ms_played) FILTER (WHERE was_skipped) AS mean_ms
            FROM p GROUP BY 1 HAVING COUNT(*) >= ${Math.round(minShown)} AND AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) >= ${Number(minRate)}),
    fb AS (SELECT subject_key, arg_max(verdict, decided_at) AS verdict, MAX(decided_at) AS at FROM recommendation_feedback WHERE engine = 'skip_hall' GROUP BY 1)
    SELECT a.*, CAST(a.first_s AS VARCHAR) AS first_s_v, CAST(a.last_s AS VARCHAR) AS last_s_v,
           CASE WHEN fb.verdict = 'dismissed' THEN 'confirmed' WHEN fb.verdict = 'accepted' AND fb.at >= now() - INTERVAL 180 DAY THEN 'tried' END AS verdict
    FROM agg a LEFT JOIN fb ON fb.subject_key = a.track_id ORDER BY a.shown DESC, a.sr DESC LIMIT ${Math.round(limit) * 2}`)).map((r) => ({
    trackId: String(r.track_id), track: String(r.track), artistId: str(r.artist_id), artist: String(r.artist ?? ''), shown: num(r.shown), skipped: num(r.skipped), skipRate: num(r.sr),
    firstSkipped: String(r.first_s_v ?? ''), lastSkipped: String(r.last_s_v ?? ''), sessions: num(r.sessions), meanMs: num(r.mean_ms), verdict: str(r.verdict),
  }));
  return { rows: rows.filter((r) => !r.verdict).slice(0, limit), tried: rows.filter((r) => r.verdict === 'tried'), confirmed: rows.filter((r) => r.verdict === 'confirmed') };
}
