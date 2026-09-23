/**
 * Phase 9 — playlist intelligence (owner request + DeepSeek §2.5).
 *
 * Everything joins playlist_items onto plays_resolved. "Within" means a play that
 * happened after the track was added to that playlist — the closest the record
 * gets to "played from this playlist" (Spotify's export doesn't say which
 * playlist a play came from). Coverage caveat: if a playlist's synced items are
 * fewer than Spotify's track_count, the sync was cut short by quota; `partial`
 * flags it so the numbers aren't mistaken for the whole picture.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { localToday } from './queries';

export type PlaylistSort = 'most_played' | 'least_played' | 'fewest_heard' | 'most_complete' | 'biggest' | 'stalest' | 'newest' | 'most_gems' | 'most_dead';
export type PlaylistScope = 'all' | 'mine' | 'followed';

export type PlaylistHealth = {
  playlistId: string; name: string; description: string | null; ownerIsMe: boolean; isPublic: boolean | null;
  trackCount: number; synced: number; partial: boolean;
  unreadable: boolean; syncError: string | null; itemsSyncedAt: string | null;   // Phase 9f: Spotify-made playlists are closed to third-party apps
  heard: number; completion: number;            // distinct tracks with any play since added / synced
  playsWithin: number; hoursWithin: number; skipRate: number;
  lastPlayedWithin: string | null; daysSinceTouched: number | null;
  gems: number; deadWeight: number; unheard: number;
  oldestAdd: string | null; newestAdd: string | null;
};

const HEALTH_SQL = () => `
    WITH it AS (
      SELECT pi.playlist_id, pi.track_id, pi.added_at,
             COUNT(p.play_id) FILTER (WHERE p.played_at_utc >= pi.added_at) AS plays_in,
             SUM(p.ms_played) FILTER (WHERE p.played_at_utc >= pi.added_at) AS ms_in,
             AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) FILTER (WHERE p.played_at_utc >= pi.added_at) AS sr_in,
             MAX(p.played_at) FILTER (WHERE p.played_at_utc >= pi.added_at) AS last_in,
             COUNT(p.play_id) AS plays_all,
             AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr_all
      FROM playlist_items pi LEFT JOIN plays_resolved p ON p.track_id = pi.track_id ${playsWhere('p')}
      GROUP BY 1, 2, 3),
    cls AS (
      SELECT *,
        plays_in = 0 AS unheard,
        -- a gem: a song you clearly love (15+ plays, rarely skipped) that this playlist never actually gets you to
        (plays_all >= 15 AND COALESCE(sr_all, 0) <= 0.2 AND plays_in <= 1) AS gem,
        -- dead weight: skipped most of the time inside, or sitting unplayed for 90+ days
        ((plays_in >= 3 AND sr_in >= 0.6) OR (plays_in = 0 AND added_at < CAST($1 AS DATE) - INTERVAL 90 DAY)) AS dead
      FROM it),
    agg AS (
      SELECT playlist_id, COUNT(*) AS synced, COUNT(*) FILTER (WHERE NOT unheard) AS heard,
             SUM(plays_in) AS plays_in, COALESCE(SUM(ms_in), 0) / 3600000.0 AS hours_in,
             SUM(plays_in * COALESCE(sr_in, 0)) / NULLIF(SUM(plays_in), 0) AS sr,
             MAX(last_in) AS last_in, COUNT(*) FILTER (WHERE gem) AS gems, COUNT(*) FILTER (WHERE dead) AS dead, COUNT(*) FILTER (WHERE unheard) AS unheard,
             MIN(added_at) AS oldest_add, MAX(added_at) AS newest_add
      FROM cls GROUP BY 1)
    SELECT pl.playlist_id, pl.name, pl.description, pl.owner_is_me, pl.public, pl.track_count, pl.sync_error, CAST(pl.items_synced_at AS VARCHAR) AS items_synced_at,
           COALESCE(a.synced, 0) AS synced, COALESCE(a.heard, 0) AS heard, COALESCE(a.plays_in, 0) AS plays_in, ROUND(COALESCE(a.hours_in, 0), 1) AS hours_in,
           COALESCE(a.sr, 0) AS sr, CAST(a.last_in AS VARCHAR) AS last_in,
           CASE WHEN a.last_in IS NULL THEN NULL ELSE CAST(CAST($1 AS DATE) - CAST(a.last_in AS DATE) AS INTEGER) END AS days_since,
           COALESCE(a.gems, 0) AS gems, COALESCE(a.dead, 0) AS dead, COALESCE(a.unheard, 0) AS unheard,
           CAST(a.oldest_add AS VARCHAR) AS oldest_add, CAST(a.newest_add AS VARCHAR) AS newest_add
    FROM playlists pl LEFT JOIN agg a USING (playlist_id)`;

const toHealth = (r: Record<string, unknown>): PlaylistHealth => {
  const synced = num(r.synced), heard = num(r.heard), tc = num(r.track_count);
  return {
    playlistId: String(r.playlist_id), name: String(r.name), description: str(r.description), ownerIsMe: Boolean(r.owner_is_me), isPublic: r.public == null ? null : Boolean(r.public),
    trackCount: tc, synced, partial: tc > 0 && synced < tc && !String(r.sync_error ?? '').startsWith('unreadable'), heard, completion: synced ? heard / synced : 0,
    unreadable: String(r.sync_error ?? '').startsWith('unreadable'), syncError: str(r.sync_error), itemsSyncedAt: str(r.items_synced_at),
    playsWithin: num(r.plays_in), hoursWithin: num(r.hours_in), skipRate: num(r.sr), lastPlayedWithin: str(r.last_in), daysSinceTouched: r.days_since == null ? null : num(r.days_since),
    gems: num(r.gems), deadWeight: num(r.dead), unheard: num(r.unheard), oldestAdd: str(r.oldest_add), newestAdd: str(r.newest_add),
  };
};

const ORDER: Record<PlaylistSort, string> = {
  most_played: 'plays_in DESC, hours_in DESC', least_played: 'plays_in ASC, synced DESC', fewest_heard: 'CASE WHEN synced > 0 THEN heard * 1.0 / synced END ASC NULLS LAST, synced DESC',
  most_complete: 'CASE WHEN synced > 0 THEN heard * 1.0 / synced END DESC NULLS LAST, plays_in DESC', biggest: 'pl.track_count DESC', stalest: 'days_since DESC NULLS FIRST, plays_in DESC',
  newest: 'newest_add DESC NULLS LAST', most_gems: 'gems DESC, plays_in DESC', most_dead: 'dead DESC, synced DESC',
};

export async function playlistHealth(scope: PlaylistScope = 'all', sort: PlaylistSort = 'most_played', q = ''): Promise<PlaylistHealth[]> {
  const params: unknown[] = [localToday()];
  const conds: string[] = [];
  if (scope === 'mine') conds.push('pl.owner_is_me'); if (scope === 'followed') conds.push('NOT pl.owner_is_me');
  if (q.trim()) { params.push(`%${q.trim().toLowerCase()}%`); conds.push(`lower(pl.name) LIKE $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return (await query(`${HEALTH_SQL()} ${where} ORDER BY ${ORDER[sort]}, pl.name`, params)).map(toHealth);
}

/** Library-wide picture: how much of what you've saved into playlists you actually reach, and how much sync is missing. */
export type PlaylistTotals = { playlists: number; mine: number; synced: number; expected: number; partial: number; unreadable: number; heard: number; gems: number; dead: number };
export async function playlistTotals(): Promise<PlaylistTotals> {
  const rows = await query(`${HEALTH_SQL()}`, [localToday()]);
  const z: PlaylistTotals = { playlists: 0, mine: 0, synced: 0, expected: 0, partial: 0, unreadable: 0, heard: 0, gems: 0, dead: 0 };
  for (const r of rows) {
    const unreadable = String(r.sync_error ?? '').startsWith('unreadable');
    z.playlists += 1; z.mine += r.owner_is_me ? 1 : 0; z.synced += num(r.synced); z.expected += unreadable ? 0 : num(r.track_count);
    z.partial += !unreadable && num(r.track_count) > num(r.synced) ? 1 : 0; z.unreadable += unreadable ? 1 : 0; z.heard += num(r.heard); z.gems += num(r.gems); z.dead += num(r.dead);
  }
  return z;
}

export type PlaylistTrack = {
  trackId: string; track: string; artistId: string | null; artist: string; position: number; addedAt: string;
  playsIn: number; playsAll: number; skipIn: number; lastIn: string | null; kind: 'gem' | 'dead' | 'unheard' | 'core' | 'ok';
};

/** Every track in one playlist, classified. `kind` drives the badge; sort keeps the playlist order. */
export async function playlistTracks(playlistId: string): Promise<PlaylistTrack[]> {
  return (await query(`
    SELECT pi.track_id, t.name AS track, t.artist_id, a.name AS artist, pi.position, CAST(pi.added_at AS VARCHAR) AS added,
           COUNT(p.play_id) FILTER (WHERE p.played_at_utc >= pi.added_at) AS plays_in, COUNT(p.play_id) AS plays_all,
           COALESCE(AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) FILTER (WHERE p.played_at_utc >= pi.added_at), 0) AS sr_in,
           COALESCE(AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END), 0) AS sr_all,
           CAST(MAX(p.played_at) FILTER (WHERE p.played_at_utc >= pi.added_at) AS VARCHAR) AS last_in,
           pi.added_at < CAST($2 AS DATE) - INTERVAL 90 DAY AS old_add
    FROM playlist_items pi JOIN tracks t ON t.track_id = pi.track_id LEFT JOIN artists a ON a.artist_id = t.artist_id
    LEFT JOIN plays_resolved p ON p.track_id = pi.track_id ${playsWhere('p')}
    WHERE pi.playlist_id = $1 GROUP BY 1, 2, 3, 4, 5, 6, pi.added_at ORDER BY pi.position`, [playlistId, localToday()])).map((r) => {
    const pin = num(r.plays_in), pall = num(r.plays_all), srIn = num(r.sr_in), srAll = num(r.sr_all);
    const kind: PlaylistTrack['kind'] = (pall >= 15 && srAll <= 0.2 && pin <= 1) ? 'gem' : (pin >= 3 && srIn >= 0.6) || (pin === 0 && Boolean(r.old_add)) ? 'dead' : pin === 0 ? 'unheard' : pin >= 5 && srIn < 0.25 ? 'core' : 'ok';
    return { trackId: String(r.track_id), track: String(r.track), artistId: str(r.artist_id), artist: String(r.artist ?? ''), position: num(r.position), addedAt: String(r.added), playsIn: pin, playsAll: pall, skipIn: srIn, lastIn: str(r.last_in), kind };
  });
}

export type Revisit = { playlistId: string; name: string; ownerIsMe: boolean; reason: string; score: number; daysSinceTouched: number | null; completion: number; gems: number; hoursWithin: number };

/** Playlists worth going back to: loved but neglected, or full of songs you love that you never reach through them. */
export async function playlistRevisit(limit = 6): Promise<Revisit[]> {
  const rows = (await query(`${HEALTH_SQL()} WHERE COALESCE(a.synced, 0) >= 5`, [localToday()])).map(toHealth);
  const scored: Revisit[] = [];
  for (const p of rows) {
    const stale = p.daysSinceTouched ?? 9999;
    if (p.hoursWithin >= 2 && p.skipRate < 0.25 && stale >= 90) {
      scored.push({ playlistId: p.playlistId, name: p.name, ownerIsMe: p.ownerIsMe, score: Math.min(1, p.hoursWithin / 20) * 0.6 + Math.min(1, stale / 365) * 0.4, reason: `${Math.round(p.hoursWithin)} h inside it, barely skipped, untouched for ${Math.round(stale / 30)} months`, daysSinceTouched: p.daysSinceTouched, completion: p.completion, gems: p.gems, hoursWithin: p.hoursWithin });
    } else if (p.gems >= 3) {
      scored.push({ playlistId: p.playlistId, name: p.name, ownerIsMe: p.ownerIsMe, score: Math.min(1, p.gems / 12) * 0.7 + (1 - p.completion) * 0.3, reason: `${p.gems} songs you love are in here and you never reach them this way`, daysSinceTouched: p.daysSinceTouched, completion: p.completion, gems: p.gems, hoursWithin: p.hoursWithin });
    } else if (p.completion < 0.4 && p.synced >= 15 && p.ownerIsMe && p.playsWithin >= 10) {
      scored.push({ playlistId: p.playlistId, name: p.name, ownerIsMe: p.ownerIsMe, score: (1 - p.completion) * 0.5, reason: `you've only ever heard ${Math.round(p.completion * 100)}% of it — ${p.unheard} songs waiting`, daysSinceTouched: p.daysSinceTouched, completion: p.completion, gems: p.gems, hoursWithin: p.hoursWithin });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
