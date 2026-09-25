/**
 * Phase 9n — The Newness: what was new to you in a week, a month or a season. "New" = the first attended play you ever
 * made of that artist / album / song, anywhere in the record. Seasons are meteorological (Dec–Feb winter, …).
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { countryName } from './originQueries';

export type PeriodKind = 'week' | 'month' | 'season';
export type Period = { kind: PeriodKind; from: string; to: string; label: string };   // [from, to)

const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const SEASONS = ['Winter', 'Spring', 'Summer', 'Autumn'];
/** The period containing today, shifted back by `offset` periods. */
export function periodAt(kind: PeriodKind, offset = 0, today = new Date()): Period {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  if (kind === 'week') {
    const mon = new Date(t); mon.setDate(t.getDate() - ((t.getDay() + 6) % 7) - 7 * offset);
    const end = new Date(mon); end.setDate(mon.getDate() + 7);
    const last = new Date(end); last.setDate(end.getDate() - 1);
    return { kind, from: iso(mon), to: iso(end), label: `Week of ${mon.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' })}` };
  }
  if (kind === 'month') {
    const s = new Date(t.getFullYear(), t.getMonth() - offset, 1), e = new Date(s.getFullYear(), s.getMonth() + 1, 1);
    return { kind, from: iso(s), to: iso(e), label: s.toLocaleDateString('en', { month: 'long', year: 'numeric' }) };
  }
  // season: Dec–Feb, Mar–May, Jun–Aug, Sep–Nov
  const m = t.getMonth(); const startMonth = m === 11 ? 11 : Math.floor((m + 1) / 3) * 3 - 1;
  const base = new Date(m === 11 || m >= 2 ? t.getFullYear() : t.getFullYear() - 1, startMonth === -1 ? 11 : startMonth, 1);
  const s = new Date(base.getFullYear(), base.getMonth() - 3 * offset, 1), e = new Date(s.getFullYear(), s.getMonth() + 3, 1);
  const idx = s.getMonth() === 11 ? 0 : Math.floor((s.getMonth() + 1) / 3);
  const yr = s.getMonth() === 11 ? `${s.getFullYear()}–${String(s.getFullYear() + 1).slice(2)}` : String(s.getFullYear());
  return { kind, from: iso(s), to: iso(e), label: `${SEASONS[idx % 4]} ${yr}` };
}

export type Find = { artistId: string; artist: string; plays: number; hours: number; tracks: number; firstPlayed: string; laterPlays: number; stillPlaying: boolean; scene: string | null; country: string | null; topTrackId: string | null; topTrack: string | null };
export type Newness = {
  period: Period; newArtists: number; newAlbums: number; newTracksKnown: number; hours: number; newHours: number; newShare: number; usualShare: number;
  finds: Find[]; albums: { albumId: string; album: string; artist: string; plays: number; firstPlayed: string }[];
  tracksByKnown: { trackId: string; track: string; artistId: string | null; artist: string; plays: number }[];
  scenes: { label: string; artists: number }[]; countries: { country: string; name: string; artists: number }[]; complete: boolean;
};

export async function newness(p: Period): Promise<Newness> {
  const P = playsWhere('p');
  const inP = `p.played_at >= CAST('${p.from}' AS DATE) AND p.played_at < CAST('${p.to}' AS DATE)`;
  const firsts = `
    fa AS (SELECT artist_id, MIN(played_at) AS f FROM plays_resolved WHERE attended AND artist_id IS NOT NULL GROUP BY 1),
    fal AS (SELECT album_id, MIN(played_at) AS f FROM plays_resolved WHERE attended AND album_id IS NOT NULL GROUP BY 1),
    ft AS (SELECT track_id, MIN(played_at) AS f FROM plays_resolved WHERE attended AND track_id IS NOT NULL GROUP BY 1)`;
  const [sum] = await query(`WITH ${firsts}
    SELECT COUNT(DISTINCT p.artist_id) FILTER (WHERE fa.f >= CAST('${p.from}' AS DATE) AND fa.f < CAST('${p.to}' AS DATE)) AS na,
           COUNT(DISTINCT p.album_id) FILTER (WHERE fal.f >= CAST('${p.from}' AS DATE) AND fal.f < CAST('${p.to}' AS DATE)) AS nal,
           COUNT(DISTINCT p.track_id) FILTER (WHERE ft.f >= CAST('${p.from}' AS DATE) AND ft.f < CAST('${p.to}' AS DATE) AND fa.f < CAST('${p.from}' AS DATE)) AS ntk,
           SUM(p.ms_played) / 3600000.0 AS h,
           SUM(p.ms_played) FILTER (WHERE fa.f >= CAST('${p.from}' AS DATE)) / 3600000.0 AS nh
    FROM plays_resolved p LEFT JOIN fa USING (artist_id) LEFT JOIN fal USING (album_id) LEFT JOIN ft USING (track_id) WHERE p.attended AND ${inP} ${P}`);
  // usual share of listening that goes to artists new that month (a stable baseline across period kinds)
  const [usual] = await query(`WITH fa AS (SELECT artist_id, MIN(played_at) AS f FROM plays_resolved WHERE attended AND artist_id IS NOT NULL GROUP BY 1)
    SELECT AVG(s) AS u FROM (SELECT date_trunc('month', p.played_at) AS m, SUM(p.ms_played) FILTER (WHERE date_trunc('month', fa.f) = date_trunc('month', p.played_at)) * 1.0 / SUM(p.ms_played) AS s
      FROM plays_resolved p JOIN fa USING (artist_id) WHERE p.attended ${P} GROUP BY 1 HAVING SUM(p.ms_played) > 3600000)`);
  const labels: Record<string, string> = {}; for (const r of await query(`SELECT scene, label FROM scene_families`)) labels[String(r.scene)] = String(r.label);
  const finds = (await query(`WITH ${firsts}, sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
      np AS (SELECT p.* FROM plays_resolved p JOIN fa USING (artist_id) WHERE p.attended AND ${inP} AND fa.f >= CAST('${p.from}' AS DATE) ${P}),
      later AS (SELECT artist_id, COUNT(*) AS n, MAX(played_at) AS last FROM plays_resolved WHERE attended AND played_at >= CAST('${p.to}' AS DATE) GROUP BY 1)
    SELECT np.artist_id, arg_max(np.artist_name, np.ms_played) AS a, COUNT(*) AS n, SUM(np.ms_played)/3600000.0 AS h, COUNT(DISTINCT np.track_id) AS t,
           CAST(MIN(np.played_at) AS VARCHAR) AS f, COALESCE(MAX(later.n), 0) AS ln, MAX(later.last) >= now() - INTERVAL 45 DAY AS still,
           MAX(sc.scene) AS scene, MAX(o.country) AS cc, arg_max(np.track_id, np.ms_played) AS tid, arg_max(np.track_name, np.ms_played) AS tn
    FROM np LEFT JOIN later USING (artist_id) LEFT JOIN sc USING (artist_id) LEFT JOIN artist_origin o USING (artist_id)
    GROUP BY 1 ORDER BY (COUNT(*) + COALESCE(MAX(later.n), 0) * 0.5) DESC LIMIT 40`))
    .map((r) => ({ artistId: String(r.artist_id), artist: String(r.a), plays: num(r.n), hours: num(r.h), tracks: num(r.t), firstPlayed: String(r.f).slice(0, 10), laterPlays: num(r.ln), stillPlaying: Boolean(r.still), scene: r.scene ? labels[String(r.scene)] ?? String(r.scene) : null, country: str(r.cc), topTrackId: str(r.tid), topTrack: str(r.tn) }));
  const albums = (await query(`WITH ${firsts}
    SELECT p.album_id, arg_max(p.album_name, p.ms_played) AS al, arg_max(p.artist_name, p.ms_played) AS a, COUNT(*) AS n, CAST(MIN(p.played_at) AS VARCHAR) AS f
    FROM plays_resolved p JOIN fal USING (album_id) WHERE p.attended AND ${inP} AND fal.f >= CAST('${p.from}' AS DATE) ${P} GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY n DESC LIMIT 12`))
    .map((r) => ({ albumId: String(r.album_id), album: String(r.al), artist: String(r.a), plays: num(r.n), firstPlayed: String(r.f).slice(0, 10) }));
  const tracksByKnown = (await query(`WITH ${firsts}
    SELECT p.track_id, arg_max(p.track_name, p.ms_played) AS t, arg_max(p.artist_id, p.ms_played) AS aid, arg_max(p.artist_name, p.ms_played) AS a, COUNT(*) AS n
    FROM plays_resolved p JOIN ft USING (track_id) JOIN fa USING (artist_id) WHERE p.attended AND ${inP} AND ft.f >= CAST('${p.from}' AS DATE) AND fa.f < CAST('${p.from}' AS DATE) ${P}
    GROUP BY 1 ORDER BY n DESC LIMIT 15`)).map((r) => ({ trackId: String(r.track_id), track: String(r.t), artistId: str(r.aid), artist: String(r.a), plays: num(r.n) }));
  const scenes = Object.entries(finds.reduce((m, f) => { if (f.scene) m[f.scene] = (m[f.scene] ?? 0) + 1; return m; }, {} as Record<string, number>)).map(([label, artists]) => ({ label, artists })).sort((a, b) => b.artists - a.artists).slice(0, 6);
  const countries = Object.entries(finds.reduce((m, f) => { if (f.country) m[f.country] = (m[f.country] ?? 0) + 1; return m; }, {} as Record<string, number>)).map(([country, artists]) => ({ country, name: countryName(country), artists })).sort((a, b) => b.artists - a.artists).slice(0, 6);
  const h = num(sum?.h), nh = num(sum?.nh);
  return { period: p, newArtists: num(sum?.na), newAlbums: num(sum?.nal), newTracksKnown: num(sum?.ntk), hours: h, newHours: nh, newShare: h ? nh / h : 0, usualShare: num(usual?.u),
    finds, albums, tracksByKnown, scenes, countries, complete: p.to <= iso(new Date()) };
}

export type NewnessPoint = { label: string; from: string; newArtists: number; newShare: number; keepers: number };
/** Discovery over the last n periods: new artists, share of listening that was new, and keepers (still played after). */
export async function newnessTimeline(kind: PeriodKind, n = 12): Promise<NewnessPoint[]> {
  const periods = Array.from({ length: n }, (_, i) => periodAt(kind, n - 1 - i));
  const P = playsWhere('p');
  const cases = periods.map((pp, i) => `WHEN p.played_at >= CAST('${pp.from}' AS DATE) AND p.played_at < CAST('${pp.to}' AS DATE) THEN ${i}`).join(' ');
  const rows = await query(`WITH fa AS (SELECT artist_id, MIN(played_at) AS f FROM plays_resolved WHERE attended AND artist_id IS NOT NULL GROUP BY 1),
      x AS (SELECT CASE ${cases} END AS k, p.artist_id, p.ms_played, fa.f FROM plays_resolved p JOIN fa USING (artist_id) WHERE p.attended ${P}),
      b AS (SELECT k, artist_id, SUM(ms_played) AS ms, MIN(f) AS f FROM x WHERE k IS NOT NULL GROUP BY 1, 2)
    SELECT k, SUM(ms) AS ms, SUM(ms) FILTER (WHERE CASE ${periods.map((pp, i) => `WHEN k = ${i} THEN f >= CAST('${pp.from}' AS DATE)`).join(' ')} END) AS nms,
           COUNT(*) FILTER (WHERE CASE ${periods.map((pp, i) => `WHEN k = ${i} THEN f >= CAST('${pp.from}' AS DATE)`).join(' ')} END) AS na,
           COUNT(*) FILTER (WHERE CASE ${periods.map((pp, i) => `WHEN k = ${i} THEN f >= CAST('${pp.from}' AS DATE) AND EXISTS (SELECT 1 FROM plays_resolved q WHERE q.artist_id = b.artist_id AND q.attended AND q.played_at >= CAST('${pp.to}' AS DATE) + INTERVAL 30 DAY)`).join(' ')} END) AS keep
    FROM b GROUP BY 1 ORDER BY 1`);
  return periods.map((pp, i) => { const r = rows.find((x) => num(x.k) === i); return { label: pp.label, from: pp.from, newArtists: num(r?.na), newShare: r && num(r.ms) ? num(r.nms) / num(r.ms) : 0, keepers: num(r?.keep) }; });
}
