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
  wear: number; abandoned: boolean; rediscover: boolean; kept: boolean;
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
    fb AS (SELECT subject_key AS album_id, arg_max(verdict, decided_at) AS verdict, MAX(decided_at) AS at FROM recommendation_feedback WHERE engine = 'crate' AND subject_type = 'album' GROUP BY 1),
    flags AS (
      SELECT r.*, (plays <= 2 AND days <= 2 AND days_silent >= 60) AS abandoned, (plays >= 15 AND days_silent >= 365) AS rediscover,
             LOG(1 + plays) / NULLIF(MAX(LOG(1 + plays)) OVER (), 0) AS wear,
             -- Phase 9c: the owner's own skip / keep decisions on the record card. Both last 90 days.
             COALESCE(fb.verdict = 'dismissed' AND fb.at >= now() - INTERVAL 90 DAY, FALSE) AS skipped,
             COALESCE(fb.verdict = 'accepted' AND fb.at >= now() - INTERVAL 90 DAY, FALSE) AS kept
      FROM r LEFT JOIN fb USING (album_id))`;

export async function crateRecords({ shelf = 'all', section = null, sort = 'section', limit = 400 }: { shelf?: Shelf; section?: string | null; sort?: CrateSort; limit?: number } = {}): Promise<CrateRecord[]> {
  const params: unknown[] = [localToday()];
  let sec = '';
  if (section) { params.push(section); sec = `AND section = $${params.length}`; }
  const rows = await query(`${BASE()}
    SELECT album_id, album, artist_id, artist, image_url, plays, ROUND(hours, 2) AS hours, days, CAST(first_at AS VARCHAR) AS first_at, CAST(last_at AS VARCHAR) AS last_at, days_silent,
           tracks_played, total_tracks, top_track_id, top_track, obscurity, listeners, section, wear, abandoned, rediscover, kept
    FROM flags WHERE NOT skipped AND ${SHELF_WHERE[shelf]} ${sec} ORDER BY kept DESC, ${SORTS[sort]} LIMIT ${Math.max(1, Math.round(limit))}`, params);
  return rows.map((r) => ({
    albumId: String(r.album_id), album: String(r.album), artistId: str(r.artist_id), artist: String(r.artist ?? ''), imageUrl: str(r.image_url),
    plays: num(r.plays), hours: num(r.hours), days: num(r.days), firstPlayed: String(r.first_at), lastPlayed: String(r.last_at), daysSilent: num(r.days_silent),
    tracksPlayed: num(r.tracks_played), totalTracks: r.total_tracks == null ? null : num(r.total_tracks), topTrackId: str(r.top_track_id), topTrack: str(r.top_track),
    obscurity: r.obscurity == null ? null : num(r.obscurity), listeners: r.listeners == null ? null : num(r.listeners), section: str(r.section),
    wear: num(r.wear), abandoned: Boolean(r.abandoned), rediscover: Boolean(r.rediscover), kept: Boolean(r.kept),
  }));
}

/** The dividers: scenes present on this shelf, with record counts. */
export async function crateSections(shelf: Shelf = 'all'): Promise<CrateSection[]> {
  return (await query(`${BASE()}
    SELECT COALESCE(section, 'unsorted') AS section, COUNT(*) AS n, ROUND(SUM(hours), 1) AS hours FROM flags WHERE NOT skipped AND ${SHELF_WHERE[shelf]} GROUP BY 1 ORDER BY (COALESCE(section, 'unsorted') = 'unsorted'), 1`, [localToday()]))
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

export type CrateTrack = { trackId: string; track: string; trackNumber: number | null; plays: number; skipRate: number; lastPlayed: string | null };
/** Every track you've played from an album, in album order where enrichment knows it. */
export async function albumTracks(albumId: string): Promise<CrateTrack[]> {
  return (await query(`
    SELECT p.track_id, arg_max(p.track_name, p.ms_played) AS name, MAX(t.track_number) AS no, COUNT(*) AS plays,
           AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr, CAST(MAX(p.played_at) AS VARCHAR) AS last_at
    FROM plays_resolved p LEFT JOIN tracks t ON t.track_id = p.track_id
    WHERE p.album_id = $1 AND p.track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1 ORDER BY no NULLS LAST, plays DESC`, [albumId])).map((r) => ({
    trackId: String(r.track_id), track: String(r.name), trackNumber: r.no == null ? null : num(r.no), plays: num(r.plays), skipRate: num(r.sr), lastPlayed: str(r.last_at),
  }));
}

export type RelatedAlbum = { albumId: string; album: string; artistId: string | null; artist: string; imageUrl: string | null; plays: number; reason: string };
export type RelatedArtist = { key: string; artist: string; artistId: string | null; via: string; known: boolean; lastPlayed: string | null };
/**
 * Nearby in the crate (owner request): records adjacent to this one that you haven't really opened.
 *   - other albums by the same artist you barely touched, or that sit in your liked songs / playlists unplayed;
 *   - artists you don't own, adjacent through the Last.fm / ListenBrainz similar graph;
 *   - artists you know but haven't played in a year, adjacent to this one.
 */
export async function related(albumId: string, artistId: string | null): Promise<{ albums: RelatedAlbum[]; unknown: RelatedArtist[]; dormant: RelatedArtist[] }> {
  if (!artistId) return { albums: [], unknown: [], dormant: [] };
  const albums = (await query(`
    WITH played AS (SELECT album_id, COUNT(*) AS c FROM plays_resolved WHERE album_id IS NOT NULL ${playsWhere()} GROUP BY 1),
    mine AS (SELECT al.album_id, al.name, al.artist_id, a.name AS artist, al.image_url, COALESCE(p.c, 0) AS plays, al.total_tracks
             FROM albums al JOIN artists a ON a.artist_id = al.artist_id LEFT JOIN played p USING (album_id) WHERE al.artist_id = $1 AND al.album_id <> $2),
    saved AS (SELECT DISTINCT t.album_id FROM tracks t WHERE t.album_id IS NOT NULL AND (EXISTS (SELECT 1 FROM liked_songs l WHERE l.track_id = t.track_id) OR EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.track_id = t.track_id)))
    SELECT m.*, CASE WHEN m.plays = 0 AND s.album_id IS NOT NULL THEN 'saved, never played' WHEN m.plays = 0 THEN 'never opened' WHEN m.plays <= 3 THEN 'barely opened' END AS reason
    FROM mine m LEFT JOIN saved s USING (album_id) WHERE m.plays <= 3 ORDER BY m.plays ASC, m.name LIMIT 6`, [artistId, albumId])).map((r) => ({ albumId: String(r.album_id), album: String(r.name), artistId: str(r.artist_id), artist: String(r.artist ?? ''), imageUrl: str(r.image_url), plays: num(r.plays), reason: String(r.reason ?? '') }));
  const rows = await query(`
    WITH e AS (SELECT r.related_name AS name, split_part(r.related_mbid, '|', 1) AS key, TRY_CAST(split_part(r.related_mbid, '|', 2) AS DOUBLE) AS m
               FROM artist_relations r WHERE r.artist_mbid = $1 AND r.relation_type IN ('similar', 'lb_similar')),
    own AS (SELECT a.artist_id, lower(a.name) AS lname, a.mbid, MAX(p.played_at) AS last_at FROM artists a JOIN plays_resolved p ON p.artist_id = a.artist_id WHERE 1=1 ${playsWhere('p')} GROUP BY 1, 2, 3),
    me AS (SELECT name FROM artists WHERE artist_id = $1)
    SELECT e.name, e.key, o.artist_id, CAST(o.last_at AS VARCHAR) AS last_at, (SELECT name FROM me) AS via, COALESCE(e.m, 0.3) AS m
    FROM e LEFT JOIN own o ON o.lname = lower(e.name) OR (o.mbid IS NOT NULL AND o.mbid = e.key)
    WHERE NOT EXISTS (SELECT 1 FROM recommendation_feedback f WHERE f.subject_key = e.key AND f.verdict = 'dismissed' AND f.decided_at >= now() - INTERVAL 90 DAY)
    ORDER BY m DESC LIMIT 40`, [artistId]);
  const today = Date.parse(localToday() + 'T00:00:00');
  const all: RelatedArtist[] = rows.map((r) => ({ key: String(r.key), artist: String(r.name), artistId: str(r.artist_id), via: String(r.via ?? ''), known: r.artist_id != null, lastPlayed: str(r.last_at) }));
  return {
    albums,
    unknown: all.filter((a) => !a.known).slice(0, 6),
    dormant: all.filter((a) => a.known && a.lastPlayed && today - Date.parse(a.lastPlayed.slice(0, 10) + 'T00:00:00') >= 365 * 86400e3).slice(0, 6),
  };
}
