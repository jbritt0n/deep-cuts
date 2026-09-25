/**
 * Phase 9b — The Crate: the record as a stack of album covers you flip through.
 *
 * One query, several shelves. A record is an album you have actually played (under the lens).
 * Two browse dimensions ride along on every record:
 *   - obscurity: from `artist_obscurity` (Last.fm listener count, inverse-log on a fixed reference);
 *     NULL until the Last.fm connector has fetched that artist, and the rarest records are exactly
 *     where coverage is thinnest — the UI must read NULL as "unknown", never as "mainstream".
 *   - section: the artist's strongest scene from `artist_scene` — built by `compute_scenes.sql` from the
 *     owner-editable vocabulary in `scene_families` / `scene_tag_map` (Phase 9f), so the dividers in
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
  obscurity: number | null; listeners: number | null; section: string | null; filedByYou: boolean; topTags: string[];
  /** Phase 9i: the record's own Last.fm listeners, separate from the artist's */
  albumObscurity?: number | null; albumListeners?: number | null;
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
    sc AS (SELECT artist_id, arg_max(scene, weight) AS scene, MAX(weight) >= 9 AS filed_by_you FROM artist_scene GROUP BY 1),
    tg AS (SELECT artist_id, list(tag ORDER BY weight DESC)[1:4] AS tags FROM artist_tags WHERE weight >= 0.2 GROUP BY 1),
    r AS (
      SELECT p.*, al.image_url, al.total_tracks, o.obscurity, o.listeners, ao.obscurity AS album_obscurity, ao.listeners AS album_listeners, sc.scene AS section, sc.filed_by_you, tg.tags AS top_tags, tt.name AS top_track,
             CAST(CAST($1 AS DATE) - CAST(p.last_at AS DATE) AS INTEGER) AS days_silent
      FROM p LEFT JOIN albums al ON al.album_id = p.album_id LEFT JOIN artist_obscurity o ON o.artist_id = p.artist_id LEFT JOIN album_obscurity ao ON ao.album_id = p.album_id
             LEFT JOIN sc ON sc.artist_id = p.artist_id LEFT JOIN tg ON tg.artist_id = p.artist_id LEFT JOIN tt ON tt.track_id = p.top_track_id),
    fb AS (SELECT subject_key AS album_id, arg_max(verdict, decided_at) AS verdict, MAX(decided_at) AS at FROM recommendation_feedback WHERE engine = 'crate' AND subject_type = 'album' GROUP BY 1),
    flags AS (
      SELECT r.*, (plays <= 2 AND days <= 2 AND days_silent >= 60) AS abandoned, (plays >= 15 AND days_silent >= 365) AS rediscover,
             LOG(1 + plays) / NULLIF(MAX(LOG(1 + plays)) OVER (), 0) AS wear,
             -- Phase 9c: the owner's own skip / keep decisions on the record card. Both last 90 days.
             COALESCE(fb.verdict = 'dismissed' AND fb.at >= now() - INTERVAL 90 DAY, FALSE) AS skipped,
             COALESCE(fb.verdict = 'accepted' AND fb.at >= now() - INTERVAL 90 DAY, FALSE) AS kept
      FROM r LEFT JOIN fb USING (album_id))`;

export async function crateRecords({ shelf = 'all', section = null, sort = 'section', limit = 5000 }: { shelf?: Shelf; section?: string | null; sort?: CrateSort; limit?: number } = {}): Promise<CrateRecord[]> {
  const params: unknown[] = [localToday()];
  let sec = '';
  // Phase 9f: 'unsorted' is a real filter (records whose artist has no scene); before, it mapped to NULL and matched nothing.
  if (section === 'unsorted') sec = 'AND section IS NULL';
  else if (section) { params.push(section); sec = `AND section = $${params.length}`; }
  const rows = await query(`${BASE()}
    SELECT album_id, album, artist_id, artist, image_url, plays, ROUND(hours, 2) AS hours, days, CAST(first_at AS VARCHAR) AS first_at, CAST(last_at AS VARCHAR) AS last_at, days_silent,
           tracks_played, total_tracks, top_track_id, top_track, obscurity, listeners, album_obscurity, album_listeners, section, filed_by_you, top_tags, wear, abandoned, rediscover, kept
    FROM flags WHERE NOT skipped AND ${SHELF_WHERE[shelf]} ${sec} ORDER BY kept DESC, ${SORTS[sort]} LIMIT ${Math.max(1, Math.round(limit))}`, params);
  return rows.map((r) => ({
    albumId: String(r.album_id), album: String(r.album), artistId: str(r.artist_id), artist: String(r.artist ?? ''), imageUrl: str(r.image_url),
    plays: num(r.plays), hours: num(r.hours), days: num(r.days), firstPlayed: String(r.first_at), lastPlayed: String(r.last_at), daysSilent: num(r.days_silent),
    tracksPlayed: num(r.tracks_played), totalTracks: r.total_tracks == null ? null : num(r.total_tracks), topTrackId: str(r.top_track_id), topTrack: str(r.top_track),
    obscurity: r.obscurity == null ? null : num(r.obscurity), listeners: r.listeners == null ? null : num(r.listeners), albumObscurity: r.album_obscurity == null ? null : num(r.album_obscurity), albumListeners: r.album_listeners == null ? null : num(r.album_listeners), section: str(r.section), filedByYou: Boolean(r.filed_by_you), topTags: Array.isArray(r.top_tags) ? (r.top_tags as unknown[]).map(String) : [],
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

/** Phase 9f: the scene vocabulary lives in `scene_families` now — see `sceneQueries.sceneOptions()`. This list is only the 9e built-ins, kept for tests and the Ask schema doc. */
export const LEGACY_SCENES = ['afro', 'turkish', 'japanese', 'post-punk', 'dream', 'psych', 'hip-hop', 'jazz', 'funk-soul', 'electronic', 'indie', 'folk', 'metal', 'caribbean', 'latin', 'classical', 'punk', 'classic-rock'];
/** Obscurity tiers, shared by the cover stamp and the record card. */
export const obscurityTier = (o: number) => (o >= 0.45 ? 'ultra rare' : o >= 0.3 ? 'rare' : o >= 0.18 ? 'cult' : o >= 0.1 ? 'known' : 'everyone knows');

// ------------------------------------------------------------------ Phase 9f: Daily Dig
export type DailyDig = { record: CrateRecord; reason: string; kind: 'rediscover' | 'abandoned' | 'backroom' | 'nearby'; alternates: number };
/**
 * One record a day, chosen deterministically from today's date so it holds still until tomorrow.
 * Pool, in order of preference: records you loved and dropped for a year (rediscover), records you pulled once
 * and left (abandoned, but at least 4 months old so it isn't a purchase you're still getting to), the rarest
 * scored records you barely played (backroom). Anything skipped or kept from the record card is excluded.
 */
export async function dailyDig(): Promise<DailyDig | null> {
  const today = localToday();
  const rows = await query(`${BASE()}
    SELECT album_id, album, artist_id, artist, image_url, plays, ROUND(hours, 2) AS hours, days, CAST(first_at AS VARCHAR) AS first_at, CAST(last_at AS VARCHAR) AS last_at, days_silent,
           tracks_played, total_tracks, top_track_id, top_track, obscurity, listeners, album_obscurity, album_listeners, section, filed_by_you, top_tags, wear, abandoned, rediscover, kept,
           CASE WHEN rediscover THEN 'rediscover' WHEN abandoned AND days_silent >= 120 THEN 'abandoned' WHEN obscurity >= 0.3 AND plays <= 8 THEN 'backroom' END AS kind
    FROM flags WHERE NOT skipped AND NOT kept AND (rediscover OR (abandoned AND days_silent >= 120) OR (obscurity >= 0.3 AND plays <= 8))
    ORDER BY hash(album_id || '${today}') LIMIT 60`, [today]);
  if (!rows.length) return null;
  // prefer rediscover > abandoned > backroom within the date-shuffled list, but let ~1 in 3 days be a surprise from the other pools
  const seed = Array.from(today).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const order: Array<DailyDig['kind']> = seed % 3 === 0 ? ['backroom', 'abandoned', 'rediscover'] : seed % 3 === 1 ? ['abandoned', 'rediscover', 'backroom'] : ['rediscover', 'abandoned', 'backroom'];
  const pick = order.map((k) => rows.find((r) => r.kind === k)).find(Boolean) ?? rows[0];
  const r = pick as Record<string, unknown>;
  const record: CrateRecord = {
    albumId: String(r.album_id), album: String(r.album), artistId: str(r.artist_id), artist: String(r.artist ?? ''), imageUrl: str(r.image_url),
    plays: num(r.plays), hours: num(r.hours), days: num(r.days), firstPlayed: String(r.first_at), lastPlayed: String(r.last_at), daysSilent: num(r.days_silent),
    tracksPlayed: num(r.tracks_played), totalTracks: r.total_tracks == null ? null : num(r.total_tracks), topTrackId: str(r.top_track_id), topTrack: str(r.top_track),
    obscurity: r.obscurity == null ? null : num(r.obscurity), listeners: r.listeners == null ? null : num(r.listeners), section: str(r.section), filedByYou: Boolean(r.filed_by_you), topTags: Array.isArray(r.top_tags) ? (r.top_tags as unknown[]).map(String) : [],
    wear: num(r.wear), abandoned: Boolean(r.abandoned), rediscover: Boolean(r.rediscover), kept: Boolean(r.kept),
  };
  const kind = (r.kind as DailyDig['kind']) ?? 'rediscover';
  const yrs = Math.round(record.daysSilent / 365 * 10) / 10;
  const reason = kind === 'rediscover' ? `${record.plays} plays, then nothing for ${yrs >= 1 ? `${yrs} years` : `${record.daysSilent} days`}. You loved this once.`
    : kind === 'abandoned' ? `Pulled ${record.plays === 1 ? 'once' : 'twice'} in ${record.firstPlayed.slice(0, 7)} and never again. Give it a real listen?`
    : `${record.listeners ? fmtListeners(record.listeners) + ' Last.fm listeners' : 'Rare'} — ${obscurityTier(record.obscurity ?? 0)} — and you've only played it ${record.plays} time${record.plays === 1 ? '' : 's'}.`;
  return { record, reason, kind, alternates: rows.length - 1 };
}
const fmtListeners = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

// ------------------------------------------------------------------ Phase 9f: obscurity trajectory
export type PopPoint = { at: string; listeners: number };
export type Trajectory = { points: PopPoint[]; first: number | null; last: number | null; change: number | null; days: number; word: string };
/** Last.fm listener snapshots for one artist since the connector started tracking them (Phase 9b); ratio last/first. */
export async function popularityTrajectory(artistId: string): Promise<Trajectory | null> {
  const pts = (await query(`SELECT CAST(snapshot_at AS VARCHAR) AS at, listeners FROM artist_popularity_history WHERE artist_id = $1 AND listeners IS NOT NULL ORDER BY snapshot_at`, [artistId])).map((r) => ({ at: String(r.at), listeners: num(r.listeners) }));
  if (pts.length < 2) return pts.length ? { points: pts, first: pts[0].listeners, last: pts[0].listeners, change: null, days: 0, word: 'one snapshot so far' } : null;
  const first = pts[0].listeners, last = pts[pts.length - 1].listeners;
  const change = first > 0 ? last / first - 1 : null;
  const days = Math.round((Date.parse(pts[pts.length - 1].at.replace(' ', 'T') + 'Z') - Date.parse(pts[0].at.replace(' ', 'T') + 'Z')) / 86400e3);
  const word = change == null ? 'unknown' : change >= 0.5 ? 'blowing up' : change >= 0.1 ? 'rising' : change <= -0.1 ? 'fading' : 'steady';
  return { points: pts, first, last, change, days, word };
}
export type Mover = { artistId: string; artist: string; first: number; last: number; change: number; days: number; yourPlays: number; firstPlayed: string };
/** Artists whose Last.fm listener count moved most since tracking began — the "you were early" and "the world moved on" lists. */
export async function popularityMovers(limit = 8): Promise<{ rising: Mover[]; fading: Mover[]; tracked: number; since: string | null }> {
  const rows = await query(`
    WITH h AS (SELECT artist_id, arg_min(listeners, snapshot_at) AS first_l, arg_max(listeners, snapshot_at) AS last_l, MIN(snapshot_at) AS t0, MAX(snapshot_at) AS t1, COUNT(*) AS n
               FROM artist_popularity_history WHERE listeners IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 2 AND MIN(listeners) >= 100),
         me AS (SELECT artist_id, arg_max(artist_name, ms_played) AS artist, COUNT(*) AS plays, CAST(MIN(played_at) AS VARCHAR) AS first_at FROM plays_resolved p WHERE artist_id IS NOT NULL ${playsWhere('p')} GROUP BY 1)
    SELECT h.artist_id, me.artist, h.first_l, h.last_l, h.last_l * 1.0 / h.first_l - 1 AS change, CAST(CAST(h.t1 AS DATE) - CAST(h.t0 AS DATE) AS INTEGER) AS days, me.plays, me.first_at
    FROM h JOIN me USING (artist_id) WHERE h.t1 > h.t0 + INTERVAL 7 DAY AND me.plays >= 3 ORDER BY ABS(change) DESC LIMIT ${Math.max(2, limit * 6)}`);
  const all: Mover[] = rows.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist), first: num(r.first_l), last: num(r.last_l), change: num(r.change), days: num(r.days), yourPlays: num(r.plays), firstPlayed: String(r.first_at).slice(0, 10) }));
  const [m] = await query(`SELECT COUNT(DISTINCT artist_id) AS n, CAST(MIN(snapshot_at) AS VARCHAR) AS since FROM artist_popularity_history`);
  return { rising: all.filter((a) => a.change > 0).sort((a, b) => b.change - a.change).slice(0, limit), fading: all.filter((a) => a.change < 0).sort((a, b) => a.change - b.change).slice(0, limit), tracked: num(m?.n), since: str(m?.since)?.slice(0, 10) ?? null };
}

// ------------------------------------------------------------------ Phase 9h: while the snapshots accumulate
export type ListenerTier = { tier: string; lo: number; hi: number | null; artists: number; hours: number; share: number };
export type SmallRoom = { artistId: string; artist: string; listeners: number; hours: number; plays: number };
/**
 * What current listener counts already say, before any artist has two snapshots: how your hours split across
 * audience sizes, and the artists you love most that the fewest other people know ("small rooms").
 * `firstComparison` is when the 30-day refresh gives the earliest-tracked artists their second snapshot.
 */
export async function listenerLandscape(): Promise<{ tiers: ListenerTier[]; smallRooms: SmallRoom[]; bigRooms: SmallRoom[]; covered: number; firstComparison: string | null }> {
  const TIERS: [string, number, number | null][] = [['under 10k', 0, 1e4], ['10k–100k', 1e4, 1e5], ['100k–1M', 1e5, 1e6], ['1M–5M', 1e6, 5e6], ['over 5M', 5e6, null]];
  const rows = await query(`
    WITH me AS (SELECT artist_id, arg_max(artist_name, ms_played) AS artist, SUM(ms_played)/3600000.0 AS h, COUNT(*) AS c FROM plays_resolved p WHERE artist_id IS NOT NULL ${playsWhere('p')} GROUP BY 1)
    SELECT me.artist_id, me.artist, me.h, me.c, ap.listeners FROM me JOIN artist_popularity ap USING (artist_id) WHERE ap.listeners IS NOT NULL`);
  const all = rows.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist), hours: num(r.h), plays: num(r.c), listeners: num(r.listeners) }));
  const total = all.reduce((a, r) => a + r.hours, 0) || 1;
  const tiers = TIERS.map(([tier, lo, hi]) => { const inT = all.filter((r) => r.listeners >= lo && (hi == null || r.listeners < hi)); const hours = inT.reduce((a, r) => a + r.hours, 0); return { tier, lo, hi, artists: inT.length, hours, share: hours / total }; });
  const loved = all.filter((r) => r.plays >= 10);
  const smallRooms = [...loved].sort((a, b) => a.listeners - b.listeners || b.hours - a.hours).slice(0, 8);
  const bigRooms = [...loved].sort((a, b) => b.listeners - a.listeners).slice(0, 5);
  const [f] = await query(`SELECT CAST(CAST(MIN(snapshot_at) AS DATE) + INTERVAL 30 DAY AS DATE) AS d, COUNT(*) FILTER (WHERE n >= 2) AS two FROM (SELECT artist_id, MIN(snapshot_at) AS snapshot_at, COUNT(*) AS n FROM artist_popularity_history GROUP BY 1)`);
  return { tiers, smallRooms, bigRooms, covered: all.length, firstComparison: f?.d ? String(f.d).slice(0, 10) : null };
}

// ------------------------------------------------------------------ Phase 9n: obscurity on entity pages
export type ObscurityCard = { listeners: number | null; obscurity: number | null; tier: string | null; percentile: number | null; fetchedAt: string | null };
/** One artist's or album's Last.fm-listener obscurity, and where it sits among everything you play (percentile by hours). */
export async function entityObscurity(kind: 'artist' | 'album', id: string): Promise<ObscurityCard> {
  const view = kind === 'artist' ? 'artist_obscurity' : 'album_obscurity', key = kind === 'artist' ? 'artist_id' : 'album_id';
  const [r] = await query(`SELECT listeners, obscurity, CAST(fetched_at AS VARCHAR) AS f FROM ${view} WHERE ${key} = $1`, [id]);
  if (!r || r.obscurity == null) return { listeners: r?.listeners == null ? null : num(r.listeners), obscurity: null, tier: null, percentile: null, fetchedAt: str(r?.f) };
  const [pc] = await query(`WITH h AS (SELECT p.${key} AS k, SUM(p.ms_played) AS ms FROM plays_resolved p WHERE p.${key} IS NOT NULL GROUP BY 1)
    SELECT SUM(h.ms) FILTER (WHERE o.obscurity < ${Number(num(r.obscurity)).toFixed(6)}) * 1.0 / NULLIF(SUM(h.ms), 0) AS below FROM h JOIN ${view} o ON o.${key} = h.k WHERE o.obscurity IS NOT NULL`);   // a number from the DB, safe to inline
  return { listeners: num(r.listeners), obscurity: num(r.obscurity), tier: obscurityTier(num(r.obscurity)), percentile: pc?.below == null ? null : num(pc.below), fetchedAt: str(r.f) };
}
