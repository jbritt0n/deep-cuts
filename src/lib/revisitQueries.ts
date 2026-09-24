/**
 * Phase 9i — "To revisit" (owner: "songs I played but didn't add to liked songs that I should revisit and evaluate").
 * The mirror of Library → Prune: not liked songs you've given up on, but songs you keep choosing and never saved.
 * Only attended plays count; skip-spree sessions don't. A verdict ("liked it" / "not for me") hides the song for a year.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';
import { playsWhere } from './filter';

export type RevisitTrack = { trackId: string; track: string; artistId: string | null; artist: string; album: string | null; plays: number; days: number; skipRate: number; hours: number; firstPlayed: string; lastPlayed: string };
export type Revisit = { regulars: RevisitTrack[]; fence: RevisitTrack[]; onceByLiked: RevisitTrack[] };

export async function revisit(limit = 40): Promise<Revisit> {
  const base = `
    WITH pt AS (
      SELECT p.track_id, arg_max(p.track_name, p.ms_played) AS track, arg_max(p.artist_id, p.ms_played) AS artist_id, arg_max(p.artist_name, p.ms_played) AS artist, arg_max(p.album_name, p.ms_played) AS album,
             COUNT(*) AS plays, COUNT(DISTINCT CAST(p.played_at AS DATE)) AS days, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr, SUM(p.ms_played)/3600000.0 AS h,
             CAST(MIN(p.played_at) AS VARCHAR) AS first_at, CAST(MAX(p.played_at) AS VARCHAR) AS last_at, MAX(p.played_at) AS last_ts
      FROM plays_resolved p WHERE p.attended AND p.track_id IS NOT NULL AND p.track_id NOT LIKE 'local:%' ${playsWhere('p')} GROUP BY 1),
    judged AS (SELECT subject_key FROM recommendation_feedback WHERE engine = 'revisit' AND subject_type = 'track' AND decided_at >= now() - INTERVAL 365 DAY),
    inpl AS (SELECT DISTINCT i.track_id FROM playlist_items i JOIN playlists pl USING (playlist_id) WHERE pl.owner_is_me),
    likedart AS (SELECT DISTINCT t.artist_id FROM liked_songs l JOIN tracks t USING (track_id)),
    c AS (SELECT pt.* FROM pt WHERE pt.track_id NOT IN (SELECT track_id FROM liked_songs) AND pt.track_id NOT IN (SELECT subject_key FROM judged))`;
  const map = (r: Record<string, unknown>): RevisitTrack => ({ trackId: String(r.track_id), track: String(r.track), artistId: str(r.artist_id), artist: String(r.artist ?? ''), album: str(r.album), plays: num(r.plays), days: num(r.days), skipRate: num(r.sr), hours: num(r.h), firstPlayed: String(r.first_at).slice(0, 10), lastPlayed: String(r.last_at).slice(0, 10) });
  const L = Math.max(5, Math.round(limit));
  const regulars = (await query(`${base} SELECT * FROM c WHERE plays >= 8 AND days >= 4 AND sr < 0.25 AND track_id NOT IN (SELECT track_id FROM inpl) ORDER BY days DESC, plays DESC LIMIT ${L}`)).map(map);
  const fence = (await query(`${base} SELECT * FROM c WHERE plays BETWEEN 3 AND 7 AND days >= 2 AND sr < 0.5 AND last_ts >= now() - INTERVAL 365 DAY ORDER BY sr ASC, plays DESC, last_ts DESC LIMIT ${L}`)).map(map);
  const onceByLiked = (await query(`${base} SELECT * FROM c WHERE plays = 1 AND sr = 0 AND artist_id IN (SELECT artist_id FROM likedart) AND last_ts BETWEEN now() - INTERVAL 730 DAY AND now() - INTERVAL 60 DAY ORDER BY last_ts DESC LIMIT ${L}`)).map(map);
  return { regulars, fence, onceByLiked };
}

/** verdict 'accepted' = "I like it / keep it", 'dismissed' = "not for me". Either hides the song here for a year. */
export const revisitVerdict = (trackId: string, verdict: 'accepted' | 'dismissed') => invoke('rec_feedback', { subjectType: 'track', subjectKey: trackId, engine: 'revisit', verdict });
