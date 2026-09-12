/**
 * Phase 9b — The Crate: the record as a stack of album covers you flip through.
 *
 * One query, several shelves. A record is an album you have actually played (under the lens).
 * Two browse dimensions ride along on every record:
 *   - obscurity: from `artist_obscurity` (Last.fm listener count, inverse-log on a fixed reference);
 *     NULL until the Last.fm connector has fetched that artist, and the rarest records are exactly
 *     where coverage is thinnest — the UI must read NULL as "unknown", never as "mainstream".
 *   - section: the artist's strongest scene from `artist_scene` — the same tag-family vocabulary
 *     `compute_insights.sql` uses for scene detection and session chaos scoring, so the dividers in
 *     the crate match the scenes elsewhere in the app.
 * Two states are surfaced on the cover itself rather than in a sidebar:
 *   - wear: how loved the record looks, log-scaled play count normalised across the shelf (0–1).
 *   - abandoned: pulled once or twice, never returned to (≤ 2 plays on ≤ 2 days, quiet 60+ days).
 * Shelves: all · fresh (abandoned) · backroom (rarest first, needs obscurity) · rediscover (played
 * heavily, untouched for a year).
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { localToday } from './queries';

export type Shelf = 'all' | 'fresh' | 'backroom' | 'rediscover';
export type CrateSort = 'section' | 'obscurity' | 'plays' | 'recent' | 'oldest';
export type CrateRecord = {
  albumId: string; album: string; artistId: string | null; artist: string; imageUrl: string | null;
  plays: number; hours: number; days: number; firstPlayed: string; lastPlayed: string; daysSilent: number;
  tracksPlayed: number; totalTracks: number | null; topTrackId: string | null; topTrack: string | null;
  obscurity: number | null; listeners: number | null; section: string | null;
  wear: number; abandoned: boolean; rediscover: boolean;
};
export type CrateSection = { section: string; records: number; hours: number };

const SHELF_WHERE: Record<Shelf, string> = {
  all: '1=1',
  fresh: 'abandoned',
  backroom: 'obscurity IS NOT NULL',
  rediscover: 'rediscover',
};
const SORTS: Record<CrateSort, string> = {
  section: "COALESCE(section, 'zzz'), obscurity DESC NULLS LAST, plays DESC",
  obscurity: 'obscurity DESC NULLS LAST, plays DESC',
  plays: 'plays DESC',
  recent: 'last_at DESC',
  oldest: 'first_at ASC',
};

const BASE = () => `
    WITH p AS (
      SELECT p.album_id, arg_max(p.album_name, p.ms_played) AS album, arg_max(p.artist_id, p.ms_played) AS artist_id, arg_max(p.artist_name, p.ms_played) AS artist,
             COUNT(*) AS plays, SUM(p.ms_played)/3600000.0 AS hours, COUNT(DISTINCT CAST(p.played_at AS DATE)) AS days,
             MIN(p.played_at) AS first_at, MAX(p.played_at) AS last_at, COUNT(DISTINCT p.track_id) AS tracks_played,
             arg_max(p.track_id, CASE WHEN p.track_id LIKE 'local:%' THEN 0 ELSE 1 END * 1000000 + p.ms_played) AS top_track_id
      FROM plays_resolved p WHERE p.album_id IS NOT NULL ${playsWhere('p')} GROUP BY 1),
    tt AS (SELECT track_id, arg_max(track_name, ms_played) AS name FROM plays_resolved WHERE track_id IS NOT NULL GROUP BY 1),
    sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
    r AS (
      SELECT p.*, al.image_url, al.total_tracks, o.obscurity, o.listeners, sc.scene AS section, tt.name AS top_track,
             CAST(CAST($1 AS DATE) - CAST(p.last_at AS DATE) AS INTEGER) AS days_silent
      FROM p LEFT JOIN albums al ON al.album_id = p.album_id LEFT JOIN artist_obscurity o ON o.artist_id = p.artist_id
             LEFT JOIN sc ON sc.artist_id = p.artist_id LEFT JOIN tt ON tt.track_id = p.top_track_id),
    flags AS (
      SELECT r.*, (plays <= 2 AND days <= 2 AND days_silent >= 60) AS abandoned, (plays >= 15 AND days_silent >= 365) AS rediscover,
             LOG(1 + plays) / NULLIF(MAX(LOG(1 + plays)) OVER (), 0) AS wear
      FROM r)`;

export async function crateRecords({ shelf = 'all', section = null, sort = 'section', limit = 400 }: { shelf?: Shelf; section?: string | null; sort?: CrateSort; limit?: number } = {}): Promise<CrateRecord[]> {
  const params: unknown[] = [localToday()];
  let sec = '';
  if (section) { params.push(section); sec = `AND section = $${params.length}`; }
  const rows = await query(`${BASE()}
    SELECT album_id, album, artist_id, artist, image_url, plays, ROUND(hours, 2) AS hours, days, CAST(first_at AS VARCHAR) AS first_at, CAST(last_at AS VARCHAR) AS last_at, days_silent,
           tracks_played, total_tracks, top_track_id, top_track, obscurity, listeners, section, wear, abandoned, rediscover
    FROM flags WHERE ${SHELF_WHERE[shelf]} ${sec} ORDER BY ${SORTS[sort]} LIMIT ${Math.max(1, Math.round(limit))}`, params);
  return rows.map((r) => ({
    albumId: String(r.album_id), album: String(r.album), artistId: str(r.artist_id), artist: String(r.artist ?? ''), imageUrl: str(r.image_url),
    plays: num(r.plays), hours: num(r.hours), days: num(r.days), firstPlayed: String(r.first_at), lastPlayed: String(r.last_at), daysSilent: num(r.days_silent),
    tracksPlayed: num(r.tracks_played), totalTracks: r.total_tracks == null ? null : num(r.total_tracks), topTrackId: str(r.top_track_id), topTrack: str(r.top_track),
    obscurity: r.obscurity == null ? null : num(r.obscurity), listeners: r.listeners == null ? null : num(r.listeners), section: str(r.section),
    wear: num(r.wear), abandoned: Boolean(r.abandoned), rediscover: Boolean(r.rediscover),
  }));
}

/** The dividers: scenes present on this shelf, with record counts. */
export async function crateSections(shelf: Shelf = 'all'): Promise<CrateSection[]> {
  return (await query(`${BASE()}
    SELECT COALESCE(section, 'unsorted') AS section, COUNT(*) AS n, ROUND(SUM(hours), 1) AS hours FROM flags WHERE ${SHELF_WHERE[shelf]} GROUP BY 1 ORDER BY (COALESCE(section, 'unsorted') = 'unsorted'), 1`, [localToday()]))
    .map((r) => ({ section: String(r.section), records: num(r.n), hours: num(r.hours) }));
}

/** Shelf sizes plus how much of the crate has an obscurity score at all — the coverage caveat the page states out loud. */
export async function crateSummary(): Promise<{ records: number; fresh: number; backroom: number; rediscover: number; scored: number; rarest: { album: string; artist: string; listeners: number } | null }> {
  const [r] = await query(`${BASE()}
    SELECT COUNT(*) AS records, COUNT(*) FILTER (WHERE abandoned) AS fresh, COUNT(*) FILTER (WHERE obscurity IS NOT NULL) AS backroom, COUNT(*) FILTER (WHERE rediscover) AS rediscover,
           COUNT(*) FILTER (WHERE obscurity IS NOT NULL) AS scored, arg_max(album, obscurity) AS rarest_album, arg_max(artist, obscurity) AS rarest_artist, MIN(listeners) AS rarest_listeners
    FROM flags`, [localToday()]);
  return { records: num(r?.records), fresh: num(r?.fresh), backroom: num(r?.backroom), rediscover: num(r?.rediscover), scored: num(r?.scored), rarest: r?.rarest_album ? { album: String(r.rarest_album), artist: String(r.rarest_artist ?? ''), listeners: num(r.rarest_listeners) } : null };
}
