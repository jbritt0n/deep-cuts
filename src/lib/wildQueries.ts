/**
 * Phase 8 — Heard in the Wild.
 *
 * Reads the `wild_plays` view: ambient captures (Google Now Playing, Shazam)
 * that reached Last.fm via the phone and were imported as their own event
 * class. Nothing here touches plays_resolved as a *source* — it is only joined
 * against to answer "have I ever actually streamed this?".
 *
 * The global listening filter is deliberately NOT applied: captures have no
 * attention signal, and the year range is meaningless for a feed that started
 * the day Pano was installed.
 */
import { query, num, str } from './db';

/** Same normalisation wild_plays uses for track_key, applied to a plays_resolved column. */
const NORM_TRACK = (col: string) => `lower(trim(regexp_replace(regexp_replace(${col}, '\\s*[\\(\\[].*$', ''), '\\s+-\\s+.*$', '')))`;
const NORM_ARTIST = (col: string) => `lower(trim(${col}))`;

/** Distinct songs in the record, keyed the same way as captures. Cheap enough to inline as a CTE. */
const OWNED = `owned AS (
  SELECT ${NORM_TRACK('track_name')} AS track_key, ${NORM_ARTIST('artist_name')} AS artist_key,
         arg_max(track_id, ms_played) AS track_id, arg_max(artist_id, ms_played) AS artist_id, COUNT(*) AS plays
  FROM plays_resolved WHERE track_name IS NOT NULL AND artist_name IS NOT NULL GROUP BY 1, 2)`;

/** Feedback the user gave on wild songs (engine 'wild'): 'dismissed' hides, 'accepted' pins. */
const FEEDBACK = `fb AS (SELECT subject_key, arg_max(verdict, decided_at) AS verdict FROM recommendation_feedback WHERE engine = 'wild' GROUP BY 1)`;

export type WildOverview = {
  captures: number; songs: number; artists: number; neverStreamed: number; alreadyYours: number;
  firstHeard: string | null; lastHeard: string | null; days: number;
  byMonth: { month: string; captures: number; newSongs: number }[];
  byHour: { hour: number; captures: number }[];
  byWeekday: { dow: number; captures: number }[];
  topArtists: { artist: string; artistKey: string; captures: number; songs: number; inRecord: boolean; artistId: string | null }[];
};

export async function wildOverview(): Promise<WildOverview> {
  const [t] = await query(`
    WITH ${OWNED},
    songs AS (
      SELECT w.track_key, w.artist_key, COUNT(*) AS n, MAX(o.track_id) AS track_id
      FROM wild_plays w LEFT JOIN owned o USING (track_key, artist_key) GROUP BY 1, 2)
    SELECT (SELECT COUNT(*) FROM wild_plays) AS captures,
           COUNT(*) AS songs, COUNT(DISTINCT artist_key) AS artists,
           COUNT(*) FILTER (WHERE track_id IS NULL) AS never_streamed,
           COUNT(*) FILTER (WHERE track_id IS NOT NULL) AS already_yours,
           (SELECT CAST(MIN(heard_at) AS VARCHAR) FROM wild_plays) AS first_heard,
           (SELECT CAST(MAX(heard_at) AS VARCHAR) FROM wild_plays) AS last_heard,
           (SELECT COUNT(DISTINCT CAST(heard_at AS DATE)) FROM wild_plays) AS days
    FROM songs`);
  const byMonth = (await query(`
    WITH ${OWNED},
    first_seen AS (SELECT track_key, artist_key, MIN(heard_at) AS first_at FROM wild_plays GROUP BY 1, 2)
    SELECT strftime(w.heard_at, '%Y-%m') AS month, COUNT(*) AS captures,
           COUNT(DISTINCT CASE WHEN o.track_key IS NULL AND CAST(f.first_at AS DATE) = CAST(w.heard_at AS DATE) THEN w.track_key || '|' || w.artist_key END) AS new_songs
    FROM wild_plays w LEFT JOIN owned o USING (track_key, artist_key) JOIN first_seen f USING (track_key, artist_key)
    GROUP BY 1 ORDER BY 1`)).map((r) => ({ month: String(r.month), captures: num(r.captures), newSongs: num(r.new_songs) }));
  const byHour = (await query(`SELECT EXTRACT(hour FROM heard_at)::INT AS hour, COUNT(*) AS captures FROM wild_plays GROUP BY 1 ORDER BY 1`))
    .map((r) => ({ hour: num(r.hour), captures: num(r.captures) }));
  const byWeekday = (await query(`SELECT EXTRACT(isodow FROM heard_at)::INT AS dow, COUNT(*) AS captures FROM wild_plays GROUP BY 1 ORDER BY 1`))
    .map((r) => ({ dow: num(r.dow), captures: num(r.captures) }));
  const topArtists = (await query(`
    WITH art AS (SELECT ${NORM_ARTIST('artist_name')} AS artist_key, arg_max(artist_id, ms_played) AS artist_id FROM plays_resolved WHERE artist_id IS NOT NULL GROUP BY 1)
    SELECT arg_max(w.artist_name, w.heard_at) AS artist, w.artist_key, COUNT(*) AS captures, COUNT(DISTINCT w.track_key) AS songs,
           MAX(a.artist_id) AS artist_id
    FROM wild_plays w LEFT JOIN art a USING (artist_key) GROUP BY 2 ORDER BY captures DESC, songs DESC LIMIT 12`))
    .map((r) => ({ artist: String(r.artist), artistKey: String(r.artist_key), captures: num(r.captures), songs: num(r.songs), inRecord: r.artist_id !== null, artistId: str(r.artist_id) }));
  return {
    captures: num(t?.captures), songs: num(t?.songs), artists: num(t?.artists), neverStreamed: num(t?.never_streamed), alreadyYours: num(t?.already_yours),
    firstHeard: str(t?.first_heard), lastHeard: str(t?.last_heard), days: num(t?.days), byMonth, byHour, byWeekday, topArtists,
  };
}

export type WildSong = {
  key: string;            // track_key|artist_key — feedback subject
  track: string; artist: string; album: string | null;
  captures: number; firstHeard: string; lastHeard: string;
  trackId: string | null; artistId: string | null; yourPlays: number;   // matched onto your record, if any
  verdict: string | null;
};

const toSong = (r: Record<string, unknown>): WildSong => ({
  key: String(r.key), track: String(r.track), artist: String(r.artist), album: str(r.album),
  captures: num(r.captures), firstHeard: String(r.first_heard), lastHeard: String(r.last_heard),
  trackId: str(r.track_id), artistId: str(r.artist_id), yourPlays: num(r.your_plays), verdict: str(r.verdict),
});

/** Songs heard in the wild, grouped. `mode` picks the lens; `q` is a free-text filter. */
export async function wildSongs(mode: 'never' | 'yours' | 'all', q = '', limit = 200): Promise<WildSong[]> {
  const params: unknown[] = [];
  let filt = '';
  if (q.trim()) { params.push(`%${q.trim().toLowerCase()}%`); filt = `AND (lower(track) LIKE $${params.length} OR lower(artist) LIKE $${params.length})`; }
  const lens = mode === 'never' ? 'AND track_id IS NULL' : mode === 'yours' ? 'AND track_id IS NOT NULL' : '';
  return (await query(`
    WITH ${OWNED}, ${FEEDBACK},
    g AS (
      SELECT w.track_key || '|' || w.artist_key AS key,
             arg_max(w.track_name, w.heard_at) AS track, arg_max(w.artist_name, w.heard_at) AS artist, arg_max(w.album_name, w.heard_at) AS album,
             COUNT(*) AS captures, CAST(MIN(w.heard_at) AS VARCHAR) AS first_heard, CAST(MAX(w.heard_at) AS VARCHAR) AS last_heard,
             MAX(o.track_id) AS track_id, MAX(o.artist_id) AS artist_id, COALESCE(MAX(o.plays), 0) AS your_plays
      FROM wild_plays w LEFT JOIN owned o USING (track_key, artist_key) GROUP BY 1)
    SELECT g.*, fb.verdict FROM g LEFT JOIN fb ON fb.subject_key = g.key
    WHERE COALESCE(fb.verdict, '') <> 'dismissed' ${lens} ${filt}
    ORDER BY (fb.verdict = 'accepted') DESC NULLS LAST, captures DESC, last_heard DESC LIMIT ${limit}`, params)).map(toSong);
}

export type WildCapture = { id: string; heardAt: string; track: string; artist: string; album: string | null; inRecord: boolean; trackId: string | null };

/** Raw timeline, newest first. */
export async function wildRecent(limit = 60): Promise<WildCapture[]> {
  return (await query(`
    WITH ${OWNED}
    SELECT CAST(w.wild_id AS VARCHAR) AS id, CAST(w.heard_at AS VARCHAR) AS heard_at, w.track_name, w.artist_name, w.album_name, o.track_id
    FROM wild_plays w LEFT JOIN owned o USING (track_key, artist_key)
    ORDER BY w.heard_at DESC LIMIT ${limit}`)).map((r) => ({
    id: String(r.id), heardAt: String(r.heard_at), track: String(r.track_name), artist: String(r.artist_name), album: str(r.album_name),
    inRecord: r.track_id !== null, trackId: str(r.track_id),
  }));
}

/** Everything you heard in the wild on a given local day — for the Day page. */
export async function wildOnDay(day: string): Promise<WildCapture[]> {
  return (await query(`
    WITH ${OWNED}
    SELECT CAST(w.wild_id AS VARCHAR) AS id, CAST(w.heard_at AS VARCHAR) AS heard_at, w.track_name, w.artist_name, w.album_name, o.track_id
    FROM wild_plays w LEFT JOIN owned o USING (track_key, artist_key)
    WHERE CAST(w.heard_at AS DATE) = CAST($1 AS DATE) ORDER BY w.heard_at`, [day])).map((r) => ({
    id: String(r.id), heardAt: String(r.heard_at), track: String(r.track_name), artist: String(r.artist_name), album: str(r.album_name),
    inRecord: r.track_id !== null, trackId: str(r.track_id),
  }));
}

export const hasWild = async () => num((await query(`SELECT COUNT(*) AS n FROM wild_plays`))[0]?.n) > 0;
