/**
 * Phase 4 analytics — all SQL over the derived tables, honouring the lens.
 * achievements · album completeness · mood-of-day map · half-life · taste drift
 * · compare periods · prune lists · decade mix · liked songs & playlists · blend
 */
import { query, num, str } from './db';
import { playsWhere, sessionsWhere } from './filter';
import type { ArtistRow, TrackRow } from './types';
import { localToday } from './queries';

const PW = () => playsWhere();
const T = `track_id AS "trackId", track_name AS track, artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"`;
const toT = (r: Record<string, unknown>): TrackRow => ({ trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) });
const toA = (r: Record<string, unknown>): ArtistRow => ({ artistId: String(r.artistId), artist: String(r.artist), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) });

// ---------------------------------------------------------------- achievements
export type Achievement = { id: string; title: string; blurb: string; earned: boolean; value: string; date: string | null; href: string | null; tier: 'bronze' | 'silver' | 'gold' };
export async function achievements(): Promise<Achievement[]> {
  const out: Achievement[] = [];
  const one = async (sql: string) => (await query(sql))[0] ?? {};
  const t = await one(`SELECT COUNT(*) AS plays, SUM(ms_played)/3600000.0 AS hours, COUNT(DISTINCT artist_id) AS artists, COUNT(DISTINCT track_id) AS tracks, COUNT(DISTINCT CAST(played_at AS DATE)) AS days FROM plays_resolved WHERE 1=1 ${PW()}`);
  const tier = (v: number, _b: number, s: number, g: number): Achievement['tier'] => (v >= g ? 'gold' : v >= s ? 'silver' : 'bronze');
  const hours = num(t.hours), artists = num(t.artists), days = num(t.days);
  out.push({ id: 'hours', title: hours >= 5000 ? 'Five thousand hours' : hours >= 1000 ? 'A thousand hours' : 'A hundred hours', blurb: 'Total time listened.', earned: hours >= 100, value: `${Math.round(hours).toLocaleString()} h`, date: null, href: null, tier: tier(hours, 100, 1000, 5000) });
  out.push({ id: 'artists', title: artists >= 5000 ? 'Five thousand voices' : artists >= 1000 ? 'A thousand voices' : 'A hundred voices', blurb: 'Distinct artists played.', earned: artists >= 100, value: artists.toLocaleString(), date: null, href: null, tier: tier(artists, 100, 1000, 5000) });
  out.push({ id: 'days', title: 'Days with music', blurb: 'Distinct days with at least one play.', earned: days >= 365, value: days.toLocaleString(), date: null, href: null, tier: tier(days, 365, 1000, 2000) });

  const c = await one(`SELECT track_id, track_name, artist_name, COUNT(*) AS n, CAST(MIN(CASE WHEN rn = 100 THEN played_at END) AS VARCHAR) AS at100 FROM (SELECT *, ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY played_at) AS rn FROM plays_resolved WHERE track_id IS NOT NULL ${PW()}) GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 1`);
  const cn = num(c.n);
  out.push({ id: 'century', title: cn >= 500 ? 'Five hundred club' : 'Century', blurb: 'One song, played 100 times.', earned: cn >= 100, value: c.track_name ? `${String(c.track_name)} · ${cn}×` : '—', date: str(c.at100), href: c.track_id ? `/track/${encodeURIComponent(String(c.track_id))}` : null, tier: tier(cn, 100, 250, 500) });

  const m = await one(`SELECT CAST(CAST(start_at AS DATE) AS VARCHAR) AS day, total_ms/3600000.0 AS h, track_count FROM sessions WHERE 1=1 ${sessionsWhere()} ORDER BY total_ms DESC LIMIT 1`);
  const mh = num(m.h);
  out.push({ id: 'marathon', title: mh >= 8 ? 'Ultramarathon' : 'Marathon', blurb: 'A single session of five hours or more.', earned: mh >= 5, value: m.day ? `${mh.toFixed(1)} h · ${num(m.track_count)} tracks` : '—', date: str(m.day), href: m.day ? `/day/${String(m.day)}` : null, tier: tier(mh, 5, 8, 12) });

  const s = await one(`WITH d AS (SELECT DISTINCT CAST(played_at AS DATE) AS day FROM plays_resolved WHERE 1=1 ${PW()}), g AS (SELECT day, day - ROW_NUMBER() OVER (ORDER BY day) * INTERVAL 1 DAY AS grp FROM d) SELECT COUNT(*) AS len, CAST(MAX(day) AS VARCHAR) AS e FROM g GROUP BY grp ORDER BY len DESC LIMIT 1`);
  const sl = num(s.len);
  out.push({ id: 'streak', title: sl >= 365 ? 'A year unbroken' : sl >= 100 ? 'Hundred-day streak' : 'Thirty-day streak', blurb: 'Consecutive days with a play.', earned: sl >= 30, value: `${sl} days`, date: str(s.e), href: null, tier: tier(sl, 30, 100, 365) });

  const owl = await one(`SELECT COUNT(*) AS n FROM plays_resolved WHERE (EXTRACT(hour FROM played_at) >= 23 OR EXTRACT(hour FROM played_at) < 4) ${PW()}`);
  out.push({ id: 'owl', title: 'Night owl', blurb: '500 plays between 11 PM and 4 AM.', earned: num(owl.n) >= 500, value: `${num(owl.n).toLocaleString()} late plays`, date: null, href: null, tier: tier(num(owl.n), 500, 2000, 5000) });

  const ex = await one(`SELECT strftime(mo, '%Y-%m') AS mo, n FROM (SELECT DATE_TRUNC('month', first_at) AS mo, COUNT(*) AS n FROM (SELECT artist_id, MIN(played_at) AS first_at FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1) GROUP BY 1) ORDER BY n DESC LIMIT 1`);
  out.push({ id: 'explorer', title: 'Explorer', blurb: '100 new artists in a single month.', earned: num(ex.n) >= 100, value: ex.mo ? `${num(ex.n)} new artists in ${String(ex.mo)}` : '—', date: ex.mo ? `${String(ex.mo)}-01` : null, href: ex.mo ? `/month/${String(ex.mo)}` : null, tier: tier(num(ex.n), 100, 200, 400) });

  const loyal = await query(`SELECT y, artist_name FROM (SELECT y, artist_name, ROW_NUMBER() OVER (PARTITION BY y ORDER BY h DESC) AS rn FROM (SELECT EXTRACT(year FROM played_at)::INT AS y, artist_name, SUM(ms_played) AS h FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2)) WHERE rn = 1 ORDER BY y`);
  let best = 0, bestName = ''; let run = 0;
  for (let i = 0; i < loyal.length; i++) { run = i > 0 && loyal[i].artist_name === loyal[i - 1].artist_name ? run + 1 : 1; if (run > best) { best = run; bestName = String(loyal[i].artist_name); } }
  out.push({ id: 'loyalist', title: 'Loyalist', blurb: 'The same #1 artist two or more years running.', earned: best >= 2, value: bestName ? `${bestName} · ${best} years` : '—', date: null, href: null, tier: tier(best, 2, 3, 5) });

  const rides = await one(`SELECT COUNT(*) AS n FROM sessions WHERE album_ride ${sessionsWhere()}`);
  out.push({ id: 'rider', title: 'Album rider', blurb: 'Fifty album rides — front to back, in order.', earned: num(rides.n) >= 50, value: `${num(rides.n)} rides`, date: null, href: '/sessions', tier: tier(num(rides.n), 50, 200, 500) });

  const comp = await albumCompleteness(1.0, 1);
  out.push({ id: 'completist', title: 'Completist', blurb: 'Every track of an album in one day.', earned: comp.length > 0, value: comp[0] ? `${comp[0].album} · ${comp[0].times}×` : '—', date: comp[0]?.lastDay ?? null, href: comp[0] ? `/album/${encodeURIComponent(comp[0].albumId)}` : null, tier: comp[0] && comp[0].times >= 10 ? 'gold' : comp[0] && comp[0].times >= 3 ? 'silver' : 'bronze' });
  out.push(...await moreAchievements(tier));
  return out;
}

// -------------------------------------------------------- album completeness
export type AlbumRun = { albumId: string; album: string; artistId: string | null; artist: string; knownTracks: number; times: number; bestShare: number; lastDay: string; scope: 'day' | 'session' };
/** Albums you've heard ≥ threshold of (share of known tracks) within one day or one session, and how often. Known tracks = Spotify total_tracks when enriched, else distinct tracks you've ever played from it. */
export async function albumCompleteness(threshold = 0.8, minKnown = 6, scope: 'day' | 'session' = 'day', limit = 40): Promise<AlbumRun[]> {
  const grp = scope === 'day' ? `CAST(p.played_at AS DATE)` : `ps.session_id`;
  const join = scope === 'day' ? '' : 'JOIN play_sessions ps USING (play_id)';
  const rows = await query(`
    WITH known AS (SELECT p.album_id, COALESCE(a.total_tracks, COUNT(DISTINCT p.track_id)) AS n_known FROM plays_resolved p JOIN albums a ON a.album_id = p.album_id WHERE p.album_id IS NOT NULL GROUP BY 1, a.total_tracks),
    runs AS (SELECT p.album_id, ${grp} AS g, COUNT(DISTINCT p.track_id) AS n, MAX(CAST(p.played_at AS DATE)) AS day
             FROM plays_resolved p ${join} WHERE p.album_id IS NOT NULL ${playsWhere('p')} GROUP BY 1, 2)
    SELECT r.album_id, al.name AS album, al.artist_id, ar.name AS artist, k.n_known, COUNT(*) AS times, MAX(r.n * 1.0 / k.n_known) AS best, CAST(MAX(r.day) AS VARCHAR) AS last_day
    FROM runs r JOIN known k USING (album_id) JOIN albums al ON al.album_id = r.album_id LEFT JOIN artists ar ON ar.artist_id = al.artist_id
    WHERE k.n_known >= ${minKnown} AND r.n * 1.0 / k.n_known >= ${threshold}
    GROUP BY 1, 2, 3, 4, 5 ORDER BY times DESC, best DESC LIMIT ${limit}`);
  return rows.map((r) => ({ albumId: String(r.album_id), album: String(r.album), artistId: str(r.artist_id), artist: String(r.artist ?? ''), knownTracks: num(r.n_known), times: num(r.times), bestShare: num(r.best), lastDay: String(r.last_day), scope }));
}

// ------------------------------------------------------------ mood-of-day map
export type Station = { dow: 'weekday' | 'weekend'; dayPart: string; hours: number; sessions: number; topShape: string | null; skipRate: number; artists: ArtistRow[]; tracks: TrackRow[] };
export async function moodMap(): Promise<Station[]> {
  const rows = await query(`
    WITH p AS (SELECT *, CASE WHEN EXTRACT(dow FROM played_at) IN (0, 6) THEN 'weekend' ELSE 'weekday' END AS dow,
                      CASE WHEN EXTRACT(hour FROM played_at) BETWEEN 5 AND 10 THEN 'morning' WHEN EXTRACT(hour FROM played_at) BETWEEN 11 AND 14 THEN 'midday'
                           WHEN EXTRACT(hour FROM played_at) BETWEEN 15 AND 19 THEN 'evening' WHEN EXTRACT(hour FROM played_at) BETWEEN 20 AND 23 THEN 'night' ELSE 'late' END AS part
               FROM plays_resolved WHERE 1=1 ${PW()})
    SELECT dow, part, SUM(ms_played)/3600000.0 AS hours, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM p GROUP BY 1, 2`);
  const shapes = await query(`
    WITH s AS (SELECT CASE WHEN is_weekend THEN 'weekend' ELSE 'weekday' END AS dow, day_part AS part, session_shape AS shape FROM sessions WHERE track_count >= 3 ${sessionsWhere()}),
         slot AS (SELECT dow, part, shape, COUNT(*) AS c FROM s GROUP BY 1, 2, 3), slot_n AS (SELECT dow, part, SUM(c) AS n FROM slot GROUP BY 1, 2),
         all_s AS (SELECT shape, COUNT(*) * 1.0 / (SELECT COUNT(*) FROM s) AS base FROM s GROUP BY 1)
    SELECT sl.dow, sl.part, MAX(sn.n) AS n, arg_max(sl.shape, (sl.c * 1.0 / sn.n) / a.base) AS shape
    FROM slot sl JOIN slot_n sn USING (dow, part) JOIN all_s a USING (shape) WHERE sl.c >= 5 GROUP BY 1, 2`);
  const out: Station[] = [];
  for (const r of rows) {
    const dow = String(r.dow) as Station['dow'], part = String(r.part);
    const cond = `${dow === 'weekend' ? 'EXTRACT(dow FROM played_at) IN (0, 6)' : 'EXTRACT(dow FROM played_at) BETWEEN 1 AND 5'} AND ${part === 'morning' ? 'EXTRACT(hour FROM played_at) BETWEEN 5 AND 10' : part === 'midday' ? 'EXTRACT(hour FROM played_at) BETWEEN 11 AND 14' : part === 'evening' ? 'EXTRACT(hour FROM played_at) BETWEEN 15 AND 19' : part === 'night' ? 'EXTRACT(hour FROM played_at) BETWEEN 20 AND 23' : 'EXTRACT(hour FROM played_at) < 5'}`;
    // lift: artists whose share in this slot beats their overall share
    const artists = (await query(`
      WITH slot AS (SELECT artist_id, artist_name, COUNT(*) AS c, SUM(ms_played)/3600000.0 AS h, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved WHERE ${cond} AND artist_id IS NOT NULL ${PW()} GROUP BY 1, 2),
           tot AS (SELECT artist_id, COUNT(*) AS c FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1),
           n AS (SELECT (SELECT SUM(c) FROM slot) AS s, (SELECT SUM(c) FROM tot) AS t)
      SELECT s.artist_id AS "artistId", s.artist_name AS artist, s.c AS plays, ROUND(s.h, 1) AS hours, s.sr AS "skipRate", (s.c * 1.0 / n.s) / (t.c * 1.0 / n.t) AS lift
      FROM slot s JOIN tot t USING (artist_id) CROSS JOIN n WHERE s.c >= 8 ORDER BY lift * LOG(1 + s.c) DESC LIMIT 6`)).map(toA);
    const tracks = (await query(`SELECT ${T} FROM plays_resolved WHERE ${cond} AND track_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3, 4 ORDER BY plays DESC LIMIT 30`)).map(toT);
    const sh = shapes.find((x) => x.dow === dow && x.part === part);
    out.push({ dow, dayPart: part, hours: num(r.hours), sessions: num(sh?.n), topShape: str(sh?.shape), skipRate: num(r.sr), artists, tracks });
  }
  return out;
}

// ---------------------------------------------------------------- half-life
export type HalfLife = { artistId: string; artist: string; peakMonth: string; peakHours: number; halfLifeDays: number | null; status: string; curve: { month: string; hours: number }[]; totalHours: number };
/** For artists with ≥ N hours: monthly hours from peak on, and days until hours fell below half of the peak month for good. */
export async function halfLives(minHours = 5, limit = 40): Promise<HalfLife[]> {
  const rows = await query(`
    WITH m AS (SELECT artist_id, artist_name, DATE_TRUNC('month', played_at)::DATE AS mo, SUM(ms_played)/3600000.0 AS h FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3),
    tot AS (SELECT artist_id, SUM(h) AS th FROM m GROUP BY 1 HAVING SUM(h) >= ${minHours}),
    pk AS (SELECT artist_id, arg_max(mo, h) AS peak, MAX(h) AS ph FROM m GROUP BY 1),
    after AS (SELECT m.artist_id, m.mo, m.h FROM m JOIN pk USING (artist_id) WHERE m.mo >= pk.peak),
    hl AS (SELECT a.artist_id, MIN(a.mo) AS half_mo FROM after a JOIN pk USING (artist_id) WHERE a.mo > pk.peak AND a.h < pk.ph * 0.5 AND NOT EXISTS (SELECT 1 FROM after b WHERE b.artist_id = a.artist_id AND b.mo > a.mo AND b.h >= pk.ph * 0.5) GROUP BY 1),
    last AS (SELECT artist_id, MAX(played_at) AS last_at FROM plays_resolved WHERE 1=1 ${PW()} GROUP BY 1)
    SELECT t.artist_id, ANY_VALUE(m.artist_name) AS artist, CAST(pk.peak AS VARCHAR) AS peak, pk.ph, t.th,
           CASE WHEN hl.half_mo IS NULL THEN NULL ELSE hl.half_mo - pk.peak END AS half_days,
           CASE WHEN l.last_at >= CAST('${localToday()}' AS DATE) - INTERVAL 90 DAY THEN 'current' WHEN hl.half_mo IS NULL THEN 'holding' ELSE 'faded' END AS status,
           (SELECT list(struct_pack(mo := CAST(a.mo AS VARCHAR), h := ROUND(a.h, 1)) ORDER BY a.mo) FROM after a WHERE a.artist_id = t.artist_id) AS curve
    FROM tot t JOIN pk USING (artist_id) JOIN m USING (artist_id) LEFT JOIN hl USING (artist_id) LEFT JOIN last l USING (artist_id)
    GROUP BY t.artist_id, pk.peak, pk.ph, t.th, hl.half_mo, l.last_at ORDER BY t.th DESC LIMIT ${limit}`);
  return rows.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist), peakMonth: String(r.peak), peakHours: num(r.ph), halfLifeDays: r.half_days == null ? null : num(r.half_days), status: String(r.status), totalHours: num(r.th),
    curve: ((r.curve as { mo: string; h: number }[]) ?? []).map((c) => ({ month: c.mo, hours: num(c.h) })) }));
}

// --------------------------------------------------------------- taste drift
export type Drift = { years: number[]; matrix: number[][]; positions: { year: number; x: number; y: number; hours: number; top: string[] }[]; adjacent: { from: number; to: number; similarity: number }[] };
/** Cosine similarity between years' artist-share vectors (top 200 artists per year), plus a 2-D layout via classical MDS. */
export async function tasteDrift(): Promise<Drift> {
  const rows = await query(`
    WITH v AS (SELECT EXTRACT(year FROM played_at)::INT AS y, artist_id, artist_name, SUM(ms_played) AS h FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3 QUALIFY ROW_NUMBER() OVER (PARTITION BY y ORDER BY h DESC) <= 200),
         t AS (SELECT y, SUM(h) AS th FROM v GROUP BY 1)
    SELECT v.y, v.artist_id, v.artist_name, v.h / t.th AS share, t.th FROM v JOIN t USING (y) WHERE t.th >= 3600000.0 * 20 ORDER BY y, share DESC`);
  const byYear = new Map<number, Map<string, number>>(); const top = new Map<number, string[]>(); const hours = new Map<number, number>();
  for (const r of rows) { const y = num(r.y); if (!byYear.has(y)) { byYear.set(y, new Map()); top.set(y, []); hours.set(y, num(r.th) / 3600000); } byYear.get(y)!.set(String(r.artist_id), num(r.share)); if (top.get(y)!.length < 3) top.get(y)!.push(String(r.artist_name)); }
  const years = [...byYear.keys()].sort();
  const cos = (a: Map<string, number>, b: Map<string, number>) => { let d = 0, na = 0, nb = 0; for (const [k, v] of a) { na += v * v; const w = b.get(k); if (w) d += v * w; } for (const v of b.values()) nb += v * v; return na && nb ? d / Math.sqrt(na * nb) : 0; };
  const matrix = years.map((a) => years.map((b) => cos(byYear.get(a)!, byYear.get(b)!)));
  // classical MDS on distance = 1 - similarity
  const n = years.length; let positions: Drift['positions'] = [];
  if (n >= 2) {
    const D2 = matrix.map((row) => row.map((s) => (1 - s) ** 2));
    const rowMean = D2.map((r) => r.reduce((s, v) => s + v, 0) / n); const grand = rowMean.reduce((s, v) => s + v, 0) / n;
    const B = D2.map((r, i) => r.map((v, j) => -0.5 * (v - rowMean[i] - rowMean[j] + grand)));
    const power = (excl: number[] | null) => { let v = Array.from({ length: n }, (_, i) => Math.sin(i + 1)); for (let it = 0; it < 200; it++) { let w = B.map((r) => r.reduce((s, b, j) => s + b * v[j], 0)); if (excl) { const dot = w.reduce((s, x, i) => s + x * excl[i], 0); w = w.map((x, i) => x - dot * excl[i]); } const norm = Math.hypot(...w) || 1; v = w.map((x) => x / norm); } const lambda = v.reduce((s, x, i) => s + x * B[i].reduce((ss, b, j) => ss + b * v[j], 0), 0); return { v, lambda: Math.max(lambda, 0) }; };
    const e1 = power(null); const e2 = power(e1.v);
    positions = years.map((y, i) => ({ year: y, x: e1.v[i] * Math.sqrt(e1.lambda), y: e2.v[i] * Math.sqrt(e2.lambda), hours: hours.get(y) ?? 0, top: top.get(y) ?? [] }));
  } else positions = years.map((y) => ({ year: y, x: 0, y: 0, hours: hours.get(y) ?? 0, top: top.get(y) ?? [] }));
  const adjacent = years.slice(1).map((y, i) => ({ from: years[i], to: y, similarity: matrix[i][i + 1] }));
  return { years, matrix, positions, adjacent };
}

// ------------------------------------------------------------------- prune
export type PruneRow = TrackRow & { lastPlayed: string; context: string };
export async function pruneLists(): Promise<{ likedSkipped: PruneRow[]; likedNeverPlayed: { trackId: string; track: string; artist: string; addedAt: string }[]; playlistDeadweight: (PruneRow & { playlist: string })[] }> {
  const likedSkipped = (await query(`
    SELECT p.track_id AS "trackId", p.track_name AS track, p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate",
           CAST(MAX(p.played_at) AS VARCHAR) AS last FROM plays_resolved p JOIN liked_songs l ON l.track_id = p.track_id WHERE p.played_at_utc >= l.added_at ${playsWhere('p')} GROUP BY 1, 2, 3, 4
    HAVING COUNT(*) >= 5 AND AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) >= 0.6 ORDER BY plays DESC LIMIT 40`)).map((r) => ({ ...toT(r), lastPlayed: String(r.last), context: 'liked' }));
  const likedNeverPlayed = (await query(`
    SELECT l.track_id, t.name, a.name AS artist, CAST(l.added_at AS VARCHAR) AS added FROM liked_songs l JOIN tracks t ON t.track_id = l.track_id LEFT JOIN artists a ON a.artist_id = t.artist_id
    WHERE NOT EXISTS (SELECT 1 FROM plays_resolved p WHERE p.track_id = l.track_id AND p.played_at >= l.added_at) AND l.added_at < now() - INTERVAL 90 DAY ORDER BY l.added_at LIMIT 60`)).map((r) => ({ trackId: String(r.track_id), track: String(r.name), artist: String(r.artist ?? ''), addedAt: String(r.added) }));
  const playlistDeadweight = (await query(`
    SELECT p.track_id AS "trackId", p.track_name AS track, p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate",
           CAST(MAX(p.played_at) AS VARCHAR) AS last, pl.name AS playlist FROM playlist_items pi JOIN playlists pl USING (playlist_id) JOIN plays_resolved p ON p.track_id = pi.track_id AND p.played_at_utc >= pi.added_at
    WHERE pl.owner_is_me ${playsWhere('p')} GROUP BY 1, 2, 3, 4, pl.name HAVING COUNT(*) >= 4 AND AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) >= 0.6 ORDER BY plays DESC LIMIT 40`)).map((r) => ({ ...toT(r), lastPlayed: String(r.last), context: 'playlist', playlist: String(r.playlist) }));
  return { likedSkipped, likedNeverPlayed, playlistDeadweight };
}

// ------------------------------------------------------- decades / listening age
export type DecadeMix = { coverage: number; byYear: { year: number; avgAge: number | null; decades: Record<string, number> }[]; decades: string[] };
export async function decadeMix(): Promise<DecadeMix> {
  const [c] = await query(`SELECT AVG(CASE WHEN t.release_date IS NOT NULL THEN 1.0 ELSE 0 END) AS cov FROM plays_resolved p LEFT JOIN tracks t ON t.track_id = p.track_id WHERE 1=1 ${playsWhere('p')}`);
  const rows = await query(`
    SELECT EXTRACT(year FROM p.played_at)::INT AS y, (EXTRACT(year FROM t.release_date)::INT / 10) * 10 AS decade, SUM(p.ms_played) AS ms,
           AVG(EXTRACT(year FROM p.played_at) - EXTRACT(year FROM t.release_date)) AS age
    FROM plays_resolved p JOIN tracks t ON t.track_id = p.track_id WHERE t.release_date IS NOT NULL ${playsWhere('p')} GROUP BY 1, 2 ORDER BY 1, 2`);
  const years = new Map<number, { decades: Record<string, number>; ms: number; ageMs: number }>();
  for (const r of rows) { const y = num(r.y); if (!years.has(y)) years.set(y, { decades: {}, ms: 0, ageMs: 0 }); const e = years.get(y)!; const d = `${num(r.decade)}s`; e.decades[d] = (e.decades[d] ?? 0) + num(r.ms); e.ms += num(r.ms); e.ageMs += num(r.age) * num(r.ms); }
  const decades = [...new Set(rows.map((r) => `${num(r.decade)}s`))].sort();
  return { coverage: num(c?.cov), decades, byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, e]) => ({ year, avgAge: e.ms ? e.ageMs / e.ms : null, decades: Object.fromEntries(Object.entries(e.decades).map(([k, v]) => [k, v / e.ms])) })) };
}

// ----------------------------------------------------------- liked & playlists
export type LikedSong = TrackRow & { addedAt: string; lastPlayed: string | null; playsSinceLiked: number };
export type LikedFilters = { yearLiked?: number | null; tag?: string | null; neverInPlaylist?: boolean; decade?: number | null; minPlays?: number | null; artistQuery?: string | null };
export async function likedSongs(sort: 'added' | 'plays' | 'hours' | 'skips' | 'unplayed' | 'lastPlayed' | 'momentum' = 'added', limit = 300, f: LikedFilters = {}): Promise<{ total: number; rows: LikedSong[]; timeline: { month: string; added: number }[]; lagDays: number | null }> {
  const order = { added: 'l.added_at DESC', plays: 'plays DESC', hours: 'hours DESC', skips: '"skipRate" DESC, plays DESC', unplayed: 'plays_since ASC, l.added_at DESC', lastPlayed: 'MAX(p.played_at) ASC NULLS FIRST', momentum: 'recent90 DESC, plays DESC' }[sort];
  // Phase 8 (§1.1): every user-supplied value goes through $n binding — no manual quote escaping.
  const conds: string[] = [];
  const params: unknown[] = [];
  if (f.yearLiked) conds.push(`EXTRACT(year FROM l.added_at) = ${Math.floor(f.yearLiked)}`);
  if (f.tag) { params.push(f.tag); conds.push(`EXISTS (SELECT 1 FROM artist_tags tg WHERE tg.artist_id = t.artist_id AND tg.tag = $${params.length})`); }
  if (f.neverInPlaylist) conds.push(`NOT EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.track_id = l.track_id)`);
  if (f.decade) conds.push(`EXTRACT(year FROM t.release_date) BETWEEN ${Math.floor(f.decade)} AND ${Math.floor(f.decade) + 9}`);
  if (f.artistQuery) { params.push(`%${f.artistQuery}%`); conds.push(`a.name ILIKE $${params.length}`); }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const having = f.minPlays ? `HAVING COUNT(p.play_id) >= ${Math.floor(f.minPlays)}` : '';
  const rows = (await query(`
    SELECT l.track_id AS "trackId", t.name AS track, t.artist_id AS "artistId", a.name AS artist,
           COUNT(p.play_id) AS plays, ROUND(COALESCE(SUM(p.ms_played), 0)/3600000.0, 1) AS hours, COALESCE(AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END), 0) AS "skipRate",
           CAST(l.added_at AS VARCHAR) AS added, CAST(MAX(p.played_at) AS VARCHAR) AS last, COUNT(p.play_id) FILTER (WHERE p.played_at_utc >= l.added_at) AS plays_since,
           COUNT(p.play_id) FILTER (WHERE p.played_at >= now() - INTERVAL 90 DAY) AS recent90
    FROM liked_songs l JOIN tracks t ON t.track_id = l.track_id LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN plays_resolved p ON p.track_id = l.track_id ${playsWhere('p').replace(/^ AND/, ' AND')}
    ${where} GROUP BY 1, 2, 3, 4, l.added_at ${having} ORDER BY ${order} LIMIT ${limit}`, params)).map((r) => ({ ...toT(r), addedAt: String(r.added), lastPlayed: str(r.last), playsSinceLiked: num(r.plays_since) }));
  const [t] = await query(`SELECT COUNT(*) AS n FROM liked_songs`);
  const timeline = (await query(`SELECT strftime(DATE_TRUNC('month', added_at), '%Y-%m') AS m, COUNT(*) AS n FROM liked_songs GROUP BY 1 ORDER BY 1`)).map((r) => ({ month: String(r.m), added: num(r.n) }));
  const [lag] = await query(`SELECT quantile_cont(epoch(l.added_at) - epoch(f.first_at), 0.5) / 86400.0 AS d FROM liked_songs l JOIN (SELECT track_id, MIN(played_at_utc) AS first_at FROM plays_resolved GROUP BY 1) f USING (track_id)`);
  return { total: num(t?.n), rows, timeline, lagDays: lag?.d == null ? null : num(lag.d) };
}

export async function likedArtists(limit = 100): Promise<(ArtistRow & { liked: number })[]> {
  return (await query(`
    SELECT t.artist_id AS "artistId", a.name AS artist, COUNT(DISTINCT l.track_id) AS liked, COUNT(p.play_id) AS plays, ROUND(COALESCE(SUM(p.ms_played), 0)/3600000.0, 1) AS hours, COALESCE(AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END), 0) AS "skipRate"
    FROM liked_songs l JOIN tracks t ON t.track_id = l.track_id LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN plays_resolved p ON p.track_id = l.track_id ${playsWhere('p')}
    WHERE t.artist_id IS NOT NULL GROUP BY 1, 2 ORDER BY liked DESC, hours DESC LIMIT ${limit}`)).map((r) => ({ ...toA(r), liked: num(r.liked) }));
}
export async function likedAlbums(limit = 100): Promise<{ albumId: string; album: string; artist: string; liked: number; plays: number; hours: number }[]> {
  return (await query(`
    SELECT t.album_id, al.name AS album, ar.name AS artist, COUNT(DISTINCT l.track_id) AS liked, COUNT(p.play_id) AS plays, ROUND(COALESCE(SUM(p.ms_played), 0)/3600000.0, 1) AS hours
    FROM liked_songs l JOIN tracks t ON t.track_id = l.track_id JOIN albums al ON al.album_id = t.album_id LEFT JOIN artists ar ON ar.artist_id = al.artist_id LEFT JOIN plays_resolved p ON p.track_id = l.track_id ${playsWhere('p')}
    GROUP BY 1, 2, 3 ORDER BY liked DESC, hours DESC LIMIT ${limit}`)).map((r) => ({ albumId: String(r.album_id), album: String(r.album), artist: String(r.artist ?? ''), liked: num(r.liked), plays: num(r.plays), hours: num(r.hours) }));
}

export type PlaylistSummary = { playlistId: string; name: string; description: string | null; ownerIsMe: boolean; trackCount: number; isPublic: boolean | null; playsWithin: number; hoursWithin: number; skipRate: number; syncedAt: string | null };
export async function playlistsOverview(): Promise<PlaylistSummary[]> {
  return (await query(`
    SELECT pl.playlist_id, pl.name, pl.description, pl.owner_is_me, pl.track_count, pl.public, CAST(pl.synced_at AS VARCHAR) AS synced,
           COUNT(p.play_id) AS plays, ROUND(COALESCE(SUM(p.ms_played), 0)/3600000.0, 1) AS hours, COALESCE(AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END), 0) AS sr
    FROM playlists pl LEFT JOIN playlist_items pi USING (playlist_id) LEFT JOIN plays_resolved p ON p.track_id = pi.track_id AND p.played_at_utc >= pi.added_at ${playsWhere('p')}
    GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY pl.owner_is_me DESC, hours DESC`)).map((r) => ({ playlistId: String(r.playlist_id), name: String(r.name), description: str(r.description), ownerIsMe: Boolean(r.owner_is_me), trackCount: num(r.track_count), isPublic: r.public == null ? null : Boolean(r.public), playsWithin: num(r.plays), hoursWithin: num(r.hours), skipRate: num(r.sr), syncedAt: str(r.synced) }));
}
export async function playlistDetail(playlistId: string): Promise<{ tracks: (TrackRow & { position: number; addedAt: string; playsOutside: number })[] }> {
  const tracks = (await query(`
    SELECT pi.track_id AS "trackId", t.name AS track, t.artist_id AS "artistId", a.name AS artist, pi.position, CAST(pi.added_at AS VARCHAR) AS added,
           COUNT(p.play_id) FILTER (WHERE p.played_at_utc >= pi.added_at) AS plays, ROUND(COALESCE(SUM(p.ms_played) FILTER (WHERE p.played_at_utc >= pi.added_at), 0)/3600000.0, 1) AS hours,
           COALESCE(AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) FILTER (WHERE p.played_at_utc >= pi.added_at), 0) AS "skipRate",
           COUNT(p.play_id) FILTER (WHERE p.played_at_utc < pi.added_at) AS plays_outside
    FROM playlist_items pi JOIN tracks t ON t.track_id = pi.track_id LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN plays_resolved p ON p.track_id = pi.track_id ${playsWhere('p')}
    WHERE pi.playlist_id = $1 GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY pi.position`, [playlistId])).map((r) => ({ ...toT(r), position: num(r.position), addedAt: String(r.added), playsOutside: num(r.plays_outside) }));
  return { tracks };
}

// -------------------------------------------------------------------- blend
export type Blend = { present: boolean; label: string | null; theirPlays: number; overlapArtists: number; sharedTop: { artist: string; yours: number; theirs: number }[]; youdLike: { artist: string; theirs: number }[]; theydLike: ArtistRow[]; blendTracks: TrackRow[] };
/** A second person's export, aggregated into blend_plays by import_blend. Compares taste and builds a blend playlist. */
export async function blend(): Promise<Blend> {
  const [m] = await query(`SELECT COUNT(*) AS n, SUM(plays) AS p, ANY_VALUE(label) AS label FROM blend_plays`);
  if (!m || num(m.n) === 0) return { present: false, label: null, theirPlays: 0, overlapArtists: 0, sharedTop: [], youdLike: [], theydLike: [], blendTracks: [] };
  const yours = `(SELECT lower(trim(artist_name)) AS a, artist_id, artist_name, COUNT(*) AS plays, SUM(ms_played)/3600000.0 AS h FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3)`;
  const theirs = `(SELECT lower(trim(artist_name)) AS a, ANY_VALUE(artist_name) AS artist_name, SUM(plays) AS plays FROM blend_plays GROUP BY 1)`;
  const [ov] = await query(`SELECT COUNT(*) AS n FROM ${yours} y JOIN ${theirs} t USING (a)`);
  const sharedTop = (await query(`SELECT y.artist_name AS artist, y.plays AS yours, t.plays AS theirs FROM ${yours} y JOIN ${theirs} t USING (a) ORDER BY SQRT(y.plays * t.plays) DESC LIMIT 15`)).map((r) => ({ artist: String(r.artist), yours: num(r.yours), theirs: num(r.theirs) }));
  const youdLike = (await query(`SELECT t.artist_name AS artist, t.plays AS theirs FROM ${theirs} t WHERE NOT EXISTS (SELECT 1 FROM ${yours} y WHERE y.a = t.a) AND t.plays >= 15 ORDER BY t.plays DESC LIMIT 15`)).map((r) => ({ artist: String(r.artist), theirs: num(r.theirs) }));
  const theydLike = (await query(`SELECT y.artist_id AS "artistId", y.artist_name AS artist, y.plays, ROUND(y.h, 1) AS hours, 0 AS "skipRate" FROM ${yours} y WHERE NOT EXISTS (SELECT 1 FROM ${theirs} t WHERE t.a = y.a) ORDER BY y.h DESC LIMIT 15`)).map(toA);
  const blendTracks = (await query(`
    WITH y AS (SELECT track_id, track_name, artist_id, artist_name, lower(trim(track_name)) || '|' || lower(trim(artist_name)) AS k, COUNT(*) AS plays, SUM(ms_played)/3600000.0 AS h FROM plays_resolved WHERE track_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3, 4, 5),
         t AS (SELECT lower(trim(track_name)) || '|' || lower(trim(artist_name)) AS k, spotify_track_id, SUM(plays) AS plays FROM blend_plays GROUP BY 1, 2)
    SELECT y.track_id AS "trackId", y.track_name AS track, y.artist_id AS "artistId", y.artist_name AS artist, y.plays, ROUND(y.h, 1) AS hours, 0 AS "skipRate", 2.0 * y.plays * t.plays / (y.plays + t.plays) AS score
    FROM y JOIN t ON t.k = y.k OR t.spotify_track_id = y.track_id ORDER BY score DESC LIMIT 40`)).map(toT);
  return { present: true, label: str(m.label), theirPlays: num(m.p), overlapArtists: num(ov?.n), sharedTop, youdLike, theydLike, blendTracks };
}

// ------------------------------------------------------------- lyric features
export type LyricHit = TrackRow & { keywords: string[]; themes: string[] };
export async function lyricSearch(term: string, limit = 60): Promise<{ coverage: number; hits: LyricHit[] }> {
  const [c] = await query(`SELECT COUNT(*) FILTER (WHERE f.track_id IS NOT NULL) * 1.0 / NULLIF(COUNT(*), 0) AS cov FROM (SELECT track_id FROM plays_resolved WHERE track_id IS NOT NULL ${PW()} GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 2000) p LEFT JOIN track_lyric_features f USING (track_id)`);
  const q = term.trim().toLowerCase();
  if (q.length < 2) return { coverage: num(c?.cov), hits: [] };
  const hits = (await query(`
    SELECT ${T}, f.keywords, f.themes FROM plays_resolved p JOIN track_lyric_features f USING (track_id)
    WHERE (EXISTS (SELECT 1 FROM track_lyric_terms lt WHERE lt.track_id = f.track_id AND (lt.term = $1 OR lt.term = $1 || 's' OR lt.term || 's' = $1))
        OR EXISTS (SELECT 1 FROM json_each(COALESCE(f.theme_scores, '{}'::JSON)) j WHERE j.key ILIKE '%' || $1 || '%')
        OR list_contains(f.themes, $1) OR list_contains(COALESCE(f.llm_themes, []::VARCHAR[]), $1) OR f.llm_mood ILIKE '%' || $1 || '%'
        OR list_contains(f.keywords, $1))
      ${playsWhere('p')} GROUP BY 1, 2, 3, 4, f.keywords, f.themes ORDER BY plays DESC LIMIT ${limit}`, [q])).map((r) => ({ ...toT(r), keywords: (r.keywords as string[]) ?? [], themes: (r.themes as string[]) ?? [] }));
  return { coverage: num(c?.cov), hits };
}

export async function likedFacets(): Promise<{ years: number[]; tags: { tag: string; n: number }[]; decades: number[] }> {
  const years = (await query(`SELECT DISTINCT EXTRACT(year FROM added_at)::INT AS y FROM liked_songs ORDER BY 1 DESC`)).map((r) => num(r.y));
  const tags = (await query(`SELECT tg.tag, COUNT(DISTINCT l.track_id) AS n FROM liked_songs l JOIN tracks t USING (track_id) JOIN artist_tags tg ON tg.artist_id = t.artist_id GROUP BY 1 ORDER BY n DESC LIMIT 30`)).map((r) => ({ tag: String(r.tag), n: num(r.n) }));
  const decades = (await query(`SELECT DISTINCT (EXTRACT(year FROM t.release_date)::INT / 10) * 10 AS d FROM liked_songs l JOIN tracks t USING (track_id) WHERE t.release_date IS NOT NULL ORDER BY 1`)).map((r) => num(r.d));
  return { years, tags, decades };
}

// ---------------------------------------------------------------- Phase 9j: sixteen more
/**
 * Achievements that use what the record learned in 9d–9j: origins, scenes, trips, audio and lyric features, listener
 * counts, catalogues. Each check is isolated — a table that's still empty (no FreqBlog yet, say) just leaves that badge
 * locked with a hint instead of breaking the page.
 */
async function moreAchievements(tier: (v: number, b: number, s: number, g: number) => Achievement['tier']): Promise<Achievement[]> {
  const out: Achievement[] = [];
  const one = async (sql: string) => { try { return (await query(sql))[0] ?? {}; } catch { return {}; } };
  const add = (a: Omit<Achievement, 'tier'> & { v: number; b: number; s: number; g: number }) => { const { v, b, s, g, ...rest } = a; out.push({ ...rest, tier: tier(v, b, s, g) }); };

  const w = await one(`SELECT COUNT(DISTINCT o.country) AS n FROM plays_resolved p JOIN artist_origin o USING (artist_id) WHERE o.country IS NOT NULL ${playsWhere('p')}`);
  add({ id: 'passport', title: 'Musical passport', blurb: 'Artists from 25 countries.', earned: num(w.n) >= 25, value: `${num(w.n)} countries`, date: null, href: '/atlas', v: num(w.n), b: 25, s: 50, g: 80 });
  const tr = await one(`SELECT COUNT(DISTINCT country) AS n FROM plays_resolved WHERE country IS NOT NULL ${PW()}`);
  add({ id: 'globetrotter', title: 'Globetrotter', blurb: 'Listened from 3 different countries.', earned: num(tr.n) >= 3, value: `${num(tr.n)} countries`, date: null, href: '/atlas#abroad', v: num(tr.n), b: 3, s: 8, g: 15 });
  const sc = await one(`WITH s AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1) SELECT COUNT(*) AS n FROM (SELECT s.scene FROM plays_resolved p JOIN s USING (artist_id) WHERE 1=1 ${playsWhere('p')} GROUP BY 1 HAVING SUM(p.ms_played) >= 3600000)`);
  add({ id: 'scenehopper', title: 'Scene hopper', blurb: 'An hour or more in 20 different scenes.', earned: num(sc.n) >= 20, value: `${num(sc.n)} scenes`, date: null, href: '/eras', v: num(sc.n), b: 20, s: 35, g: 50 });
  const dig = await one(`SELECT COUNT(*) AS n FROM (SELECT p.artist_id FROM plays_resolved p JOIN artist_popularity ap USING (artist_id) WHERE ap.listeners < 10000 ${playsWhere('p')} GROUP BY 1 HAVING COUNT(*) >= 5)`);
  add({ id: 'digger', title: 'Crate digger', blurb: '50 artists with under 10,000 Last.fm listeners, played 5+ times.', earned: num(dig.n) >= 50, value: `${num(dig.n)} tiny-audience artists`, date: null, href: '/crate', v: num(dig.n), b: 50, s: 150, g: 400 });
  const eb = await one(`SELECT COUNT(*) AS n FROM plays_resolved WHERE EXTRACT(hour FROM played_at) BETWEEN 5 AND 7 ${PW()}`);
  add({ id: 'earlybird', title: 'Early bird', blurb: '500 plays between 5 and 8 AM.', earned: num(eb.n) >= 500, value: `${num(eb.n).toLocaleString()} dawn plays`, date: null, href: '/moods', v: num(eb.n), b: 500, s: 2000, g: 5000 });
  const dec = await one(`SELECT COUNT(DISTINCT FLOOR(EXTRACT(year FROM COALESCE(al.release_date, t.release_date)) / 10)) AS n FROM plays_resolved p LEFT JOIN albums al USING (album_id) LEFT JOIN tracks t USING (track_id) WHERE COALESCE(al.release_date, t.release_date) IS NOT NULL ${playsWhere('p')}`);
  add({ id: 'timetraveller', title: 'Time traveller', blurb: 'Music released in 6 different decades.', earned: num(dec.n) >= 6, value: `${num(dec.n)} decades`, date: null, href: null, v: num(dec.n), b: 6, s: 8, g: 10 });
  const lang = await one(`SELECT COUNT(*) AS n FROM (SELECT lf.lang FROM track_lyric_features lf JOIN (SELECT DISTINCT track_id FROM plays_resolved WHERE 1=1 ${PW()}) p USING (track_id) WHERE lf.found AND lf.lang NOT IN ('und') GROUP BY 1 HAVING COUNT(*) >= 5)`);
  add({ id: 'polyglot', title: 'Polyglot ear', blurb: 'Songs sung in 3 languages (5+ songs each).', earned: num(lang.n) >= 3, value: `${num(lang.n)} languages`, date: null, href: '/insights', v: num(lang.n), b: 3, s: 5, g: 8 });
  const keys = await one(`SELECT COUNT(DISTINCT f.key_name) AS n FROM track_features f JOIN (SELECT DISTINCT track_id FROM plays_resolved WHERE 1=1 ${PW()}) p USING (track_id) WHERE f.found AND f.key_name IS NOT NULL`);
  add({ id: 'keys', title: 'All twenty-four', blurb: 'Songs in every major and minor key.', earned: num(keys.n) >= 24, value: `${num(keys.n)} of 24 keys`, date: null, href: '/insights', v: num(keys.n), b: 24, s: 24, g: 24 });
  const tempo = await one(`SELECT MIN(f.bpm) AS lo, MAX(f.bpm) AS hi FROM track_features f JOIN (SELECT DISTINCT track_id FROM plays_resolved WHERE 1=1 ${PW()}) p USING (track_id) WHERE f.found AND f.bpm IS NOT NULL`);
  const span = num(tempo.hi) - num(tempo.lo);
  add({ id: 'tempo', title: 'Full tempo range', blurb: 'Something under 70 bpm and something over 170.', earned: num(tempo.lo) > 0 && num(tempo.lo) < 70 && num(tempo.hi) > 170, value: tempo.lo ? `${Math.round(num(tempo.lo))}–${Math.round(num(tempo.hi))} bpm` : 'needs FreqBlog', date: null, href: '/insights', v: span, b: 100, s: 120, g: 140 });
  const cat = await one(`SELECT a.name, COUNT(DISTINCT p.track_id) * 1.0 / NULLIF(a.catalogue_tracks, 0) AS share, COUNT(DISTINCT p.track_id) AS heard FROM plays_resolved p JOIN artists a USING (artist_id) WHERE a.catalogue_tracks >= 20 ${playsWhere('p')} GROUP BY a.artist_id, a.name, a.catalogue_tracks ORDER BY share DESC LIMIT 1`);
  add({ id: 'deepdive', title: 'Deep diver', blurb: 'Heard 80% of an artist’s catalogue (20+ songs).', earned: num(cat.share) >= 0.8, value: cat.name ? `${String(cat.name)} · ${Math.round(Math.min(1, num(cat.share)) * 100)}%` : '—', date: null, href: null, v: num(cat.share), b: 0.8, s: 0.9, g: 1 });
  const liked = await one(`SELECT COUNT(*) AS n FROM liked_songs`);
  add({ id: 'hearts', title: 'Big heart', blurb: '1,000 Liked Songs.', earned: num(liked.n) >= 1000, value: `${num(liked.n).toLocaleString()} liked`, date: null, href: '/library', v: num(liked.n), b: 1000, s: 3000, g: 8000 });
  const pl = await one(`SELECT COUNT(*) AS n FROM playlists WHERE owner_is_me`);
  add({ id: 'architect', title: 'Playlist architect', blurb: '25 playlists of your own.', earned: num(pl.n) >= 25, value: `${num(pl.n)} playlists`, date: null, href: '/library', v: num(pl.n), b: 25, s: 75, g: 200 });
  const wild = await one(`SELECT COUNT(*) AS n FROM wild_plays`);
  add({ id: 'wild', title: 'Heard it in the wild', blurb: '50 captures from outside your own listening.', earned: num(wild.n) >= 50, value: `${num(wild.n)} captures`, date: null, href: '/wild', v: num(wild.n), b: 50, s: 250, g: 1000 });
  const re = await one(`WITH a AS (SELECT album_id, arg_max(album_name, ms_played) AS name, played_at, LAG(played_at) OVER (PARTITION BY album_id ORDER BY played_at) AS prev FROM plays_resolved WHERE album_id IS NOT NULL ${PW()}) SELECT name, MAX(EXTRACT(epoch FROM played_at - prev)) / 86400 AS gap FROM a GROUP BY album_id, name ORDER BY gap DESC NULLS LAST LIMIT 1`);
  add({ id: 'reunion', title: 'Reunion', blurb: 'Came back to an album after two years away.', earned: num(re.gap) >= 730, value: re.name ? `${String(re.name)} · ${(num(re.gap) / 365).toFixed(1)} years` : '—', date: null, href: '/crate?shelf=rediscover', v: num(re.gap), b: 730, s: 1825, g: 3650 });
  const ny = await one(`SELECT COUNT(DISTINCT EXTRACT(year FROM played_at)) AS n FROM plays_resolved WHERE EXTRACT(month FROM played_at) = 1 AND EXTRACT(day FROM played_at) = 1 AND EXTRACT(hour FROM played_at) = 0 ${PW()}`);
  add({ id: 'newyear', title: 'First song of the year', blurb: 'Music playing in the first hour of January 1st.', earned: num(ny.n) >= 1, value: `${num(ny.n)} New Year${num(ny.n) === 1 ? '' : 's'}`, date: null, href: null, v: num(ny.n), b: 1, s: 3, g: 5 });
  const early = await one(`WITH h AS (SELECT artist_id, arg_min(listeners, snapshot_at) AS l0, arg_max(listeners, snapshot_at) AS l1 FROM artist_popularity_history GROUP BY 1 HAVING COUNT(*) >= 2), f AS (SELECT artist_id, MIN(played_at) AS f FROM plays_resolved GROUP BY 1)
     SELECT COUNT(*) AS n, arg_max(a.name, h.l1 * 1.0 / h.l0) AS best FROM h JOIN f USING (artist_id) JOIN artists a USING (artist_id) WHERE h.l1 >= h.l0 * 1.5 AND f.f < (SELECT MIN(snapshot_at) FROM artist_popularity_history)`);
  add({ id: 'early', title: 'Ahead of the curve', blurb: 'Played an artist before their audience grew by half.', earned: num(early.n) >= 1, value: early.best ? `${String(early.best)}${num(early.n) > 1 ? ` + ${num(early.n) - 1} more` : ''}` : 'needs a month of listener history', date: null, href: '/insights', v: num(early.n), b: 1, s: 5, g: 15 });
  return out;
}
