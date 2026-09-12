/**
 * Phase 9c — the assorted metrics behind the new Insights page (eras moved to their own page).
 * All computable from `plays_resolved` / `sessions` today; each honours the listening lens.
 *   - Deep-cut ratio (summary §3.4): per artist, rank tracks by YOUR plays; top 5 = hits, rest = deep cuts.
 *     The ratio is the share of plays going to non-top-5 tracks — a measure of how you listen, not of the artist.
 *   - Spread score: the most-played artists whose single top track takes the SMALLEST share — love spread
 *     across a catalogue rather than one song.
 *   - Loyalty rollup (NEXT-DROP §2.3.13): artists where one album dominates.
 *   - Silence report (§2.3.14): longest gaps with zero plays, dark days per year.
 *   - Listening velocity (DeepSeek §2.4): hours per week as a rate, with a 12-week trend.
 *   - Device hand-off (§2.3.15): sessions that start on one platform family and finish on another.
 *   - Explicit share over time (§1.4): `tracks.explicit` is populated by enrichment but nothing read it.
 */
import { query, num, str } from './db';
import { playsWhere, sessionsWhere } from './filter';
import { localToday } from './queries';

const PW = (a?: string) => playsWhere(a);

export type DeepCutYear = { year: number; ratio: number; plays: number };
export type DeepCutArtist = { artistId: string; artist: string; plays: number; tracks: number; ratio: number; topShare: number; topTrack: string | null };
export async function deepCuts(): Promise<{ overall: number; byYear: DeepCutYear[]; deepest: DeepCutArtist[]; spread: DeepCutArtist[]; oneSong: DeepCutArtist[] }> {
  const base = `
    WITH t AS (SELECT artist_id, arg_max(artist_name, ms_played) AS artist, track_id, arg_max(track_name, ms_played) AS track, COUNT(*) AS c
               FROM plays_resolved WHERE artist_id IS NOT NULL AND track_id IS NOT NULL ${PW()} GROUP BY 1, 3),
    ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY artist_id ORDER BY c DESC) AS rk FROM t),
    per AS (SELECT artist_id, ANY_VALUE(artist) AS artist, SUM(c) AS plays, COUNT(*) AS tracks,
                   SUM(c) FILTER (WHERE rk > 5) * 1.0 / SUM(c) AS ratio, MAX(c) * 1.0 / SUM(c) AS top_share, arg_max(track, c) AS top_track
            FROM ranked GROUP BY 1)`;
  const [o] = await query(`${base} SELECT SUM(plays * ratio) / SUM(plays) AS r FROM per WHERE tracks >= 6`);
  const byYear = (await query(`
    WITH t AS (SELECT EXTRACT(year FROM played_at)::INT AS y, artist_id, track_id, COUNT(*) AS c FROM plays_resolved WHERE artist_id IS NOT NULL AND track_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3),
    ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY y, artist_id ORDER BY c DESC) AS rk FROM t)
    SELECT y, SUM(c) FILTER (WHERE rk > 5) * 1.0 / SUM(c) AS ratio, SUM(c) AS plays FROM ranked GROUP BY 1 ORDER BY 1`)).map((r) => ({ year: num(r.y), ratio: num(r.ratio), plays: num(r.plays) }));
  const map = (r: Record<string, unknown>): DeepCutArtist => ({ artistId: String(r.artist_id), artist: String(r.artist), plays: num(r.plays), tracks: num(r.tracks), ratio: num(r.ratio), topShare: num(r.top_share), topTrack: str(r.top_track) });
  const deepest = (await query(`${base} SELECT * FROM per WHERE plays >= 60 AND tracks >= 10 ORDER BY ratio DESC LIMIT 10`)).map(map);
  const spread = (await query(`${base} SELECT * FROM per WHERE plays >= 60 AND tracks >= 10 ORDER BY top_share ASC, plays DESC LIMIT 10`)).map(map);
  const oneSong = (await query(`${base} SELECT * FROM per WHERE plays >= 40 AND tracks >= 3 ORDER BY top_share DESC, plays DESC LIMIT 10`)).map(map);
  return { overall: num(o?.r), byYear, deepest, spread, oneSong };
}

export type LoyaltyRow = { artistId: string; artist: string; album: string; albumId: string | null; plays: number; albums: number; share: number; trend: number | null };
/** Artists where one album takes 70 %+ of your plays with them (3+ albums heard), and how that share moved between the earlier and later halves of your history with them. */
export async function albumLoyalty(limit = 14): Promise<LoyaltyRow[]> {
  return (await query(`
    WITH p AS (SELECT artist_id, arg_max(artist_name, ms_played) AS artist, album_id, arg_max(album_name, ms_played) AS album, COUNT(*) AS c,
                      COUNT(*) FILTER (WHERE played_at >= (SELECT MIN(played_at) + (MAX(played_at) - MIN(played_at)) / 2 FROM plays_resolved q WHERE q.artist_id = p.artist_id ${PW('q')})) AS late
               FROM plays_resolved p WHERE artist_id IS NOT NULL AND album_id IS NOT NULL ${PW('p')} GROUP BY 1, 3),
    a AS (SELECT artist_id, ANY_VALUE(artist) AS artist, SUM(c) AS plays, SUM(late) AS late_plays, COUNT(*) AS albums, arg_max(album, c) AS album, arg_max(album_id, c) AS album_id, MAX(c) AS top,
                 MAX(late) FILTER (WHERE c = (SELECT MAX(c) FROM p x WHERE x.artist_id = p.artist_id)) AS top_late
          FROM p GROUP BY 1)
    SELECT artist_id, artist, album, album_id, plays, albums, top * 1.0 / plays AS share,
           CASE WHEN late_plays > 0 AND plays - late_plays > 0 THEN (top_late * 1.0 / late_plays) - ((top - top_late) * 1.0 / (plays - late_plays)) END AS trend
    FROM a WHERE plays >= 40 AND albums >= 3 AND top * 1.0 / plays >= 0.7 ORDER BY plays DESC LIMIT ${limit}`)).map((r) => ({
    artistId: String(r.artist_id), artist: String(r.artist), album: String(r.album), albumId: str(r.album_id), plays: num(r.plays), albums: num(r.albums), share: num(r.share), trend: r.trend == null ? null : num(r.trend),
  }));
}

export type SilenceGap = { from: string; to: string; days: number; before: string | null; after: string | null };
export type DarkYear = { year: number; darkDays: number; totalDays: number };
export async function silenceReport(): Promise<{ gaps: SilenceGap[]; byYear: DarkYear[]; currentGapDays: number }> {
  const today = localToday();
  const gaps = (await query(`
    WITH d AS (SELECT DISTINCT CAST(played_at AS DATE) AS day FROM plays_resolved WHERE 1=1 ${PW()}),
    g AS (SELECT day, LAG(day) OVER (ORDER BY day) AS prev FROM d),
    big AS (SELECT prev AS from_day, day AS to_day, day - prev - 1 AS gap FROM g WHERE prev IS NOT NULL AND day - prev > 3),
    ctx AS (SELECT b.*, (SELECT arg_max(artist_name, ms_played) FROM plays_resolved p WHERE CAST(p.played_at AS DATE) = b.from_day) AS before,
                        (SELECT arg_max(artist_name, ms_played) FROM plays_resolved p WHERE CAST(p.played_at AS DATE) = b.to_day) AS after FROM big b)
    SELECT CAST(from_day AS VARCHAR) AS f, CAST(to_day AS VARCHAR) AS t, gap, before, after FROM ctx ORDER BY gap DESC LIMIT 10`)).map((r) => ({ from: String(r.f), to: String(r.t), days: num(r.gap), before: str(r.before), after: str(r.after) }));
  const byYear = (await query(`
    WITH d AS (SELECT DISTINCT CAST(played_at AS DATE) AS day FROM plays_resolved WHERE 1=1 ${PW()}),
    span AS (SELECT MIN(day) AS s, MAX(day) AS e FROM d),
    years AS (SELECT EXTRACT(year FROM day)::INT AS y, COUNT(*) AS lit FROM d GROUP BY 1)
    SELECT y.y, y.lit,
           CASE WHEN y.y = EXTRACT(year FROM sp.s) AND y.y = EXTRACT(year FROM sp.e) THEN sp.e - sp.s + 1
                WHEN y.y = EXTRACT(year FROM sp.s) THEN make_date(y.y, 12, 31) - sp.s + 1
                WHEN y.y = EXTRACT(year FROM sp.e) THEN sp.e - make_date(y.y, 1, 1) + 1
                ELSE make_date(y.y, 12, 31) - make_date(y.y, 1, 1) + 1 END AS total
    FROM years y CROSS JOIN span sp ORDER BY 1`)).map((r) => ({ year: num(r.y), darkDays: Math.max(0, num(r.total) - num(r.lit)), totalDays: num(r.total) }));
  const [last] = await query(`SELECT CAST($1 AS DATE) - CAST(MAX(played_at) AS DATE) AS d FROM plays_resolved WHERE 1=1 ${PW()}`, [today]);
  return { gaps, byYear, currentGapDays: num(last?.d) };
}

export type VelocityWeek = { week: string; hours: number; plays: number };
export async function velocity(weeks = 104): Promise<{ series: VelocityWeek[]; last12: number; prior12: number; allTimeWeekly: number }> {
  const series = (await query(`
    SELECT CAST(DATE_TRUNC('week', played_at) AS DATE)::VARCHAR AS wk, ROUND(SUM(ms_played)/3600000.0, 2) AS h, COUNT(*) AS c
    FROM plays_resolved WHERE 1=1 ${PW()} GROUP BY DATE_TRUNC('week', played_at) ORDER BY 1 DESC LIMIT ${weeks}`)).map((r) => ({ week: String(r.wk), hours: num(r.h), plays: num(r.c) })).reverse();
  const avg = (xs: VelocityWeek[]) => (xs.length ? xs.reduce((s, w) => s + w.hours, 0) / xs.length : 0);
  const [all] = await query(`SELECT SUM(ms_played)/3600000.0 / GREATEST(1, date_diff('week', MIN(played_at), MAX(played_at))) AS w FROM plays_resolved WHERE 1=1 ${PW()}`);
  return { series, last12: avg(series.slice(-12)), prior12: avg(series.slice(-24, -12)), allTimeWeekly: num(all?.w) };
}

export type HandoffRow = { from: string; to: string; sessions: number; share: number };
/** Sessions whose first and last play sit on different platform families; share is of sessions with 5+ plays. */
export async function deviceHandoff(): Promise<{ rows: HandoffRow[]; multiDeviceShare: number; longShare: number }> {
  const fam = (col: string) => `CASE WHEN lower(${col}) LIKE '%android%' OR lower(${col}) LIKE '%ios%' OR lower(${col}) LIKE '%iphone%' THEN 'phone' WHEN lower(${col}) LIKE '%car%' THEN 'car' WHEN lower(${col}) LIKE '%web%' THEN 'web' WHEN lower(${col}) LIKE '%cast%' OR lower(${col}) LIKE '%tv%' OR lower(${col}) LIKE '%sonos%' OR lower(${col}) LIKE '%speaker%' THEN 'speaker' WHEN ${col} IS NULL THEN 'unknown' ELSE 'desktop' END`;
  const rows = await query(`
    WITH s AS (SELECT ps.session_id, arg_min(${fam('p.platform')}, p.played_at) AS f, arg_max(${fam('p.platform')}, p.played_at) AS t, COUNT(*) AS n, MAX(se.total_ms) AS ms
               FROM play_sessions ps JOIN plays_resolved p USING (play_id) JOIN sessions se USING (session_id) WHERE 1=1 ${PW('p')} ${sessionsWhere('se')} GROUP BY 1 HAVING COUNT(*) >= 5)
    SELECT f, t, COUNT(*) AS c, COUNT(*) * 1.0 / (SELECT COUNT(*) FROM s) AS share,
           (SELECT COUNT(*) FILTER (WHERE f <> t) * 1.0 / NULLIF(COUNT(*), 0) FROM s) AS multi,
           (SELECT COUNT(*) FILTER (WHERE f <> t) * 1.0 / NULLIF(COUNT(*) FILTER (WHERE ms >= 3600000), 0) FROM s WHERE ms >= 3600000) AS long_share
    FROM s WHERE f <> t GROUP BY 1, 2 ORDER BY c DESC LIMIT 8`);
  return { rows: rows.map((r) => ({ from: String(r.f), to: String(r.t), sessions: num(r.c), share: num(r.share) })), multiDeviceShare: num(rows[0]?.multi), longShare: num(rows[0]?.long_share) };
}

export type ExplicitYear = { year: number; share: number; known: number };
export async function explicitShare(): Promise<ExplicitYear[]> {
  return (await query(`
    SELECT EXTRACT(year FROM p.played_at)::INT AS y, AVG(CASE WHEN t.explicit THEN 1.0 ELSE 0 END) AS share, COUNT(*) AS known
    FROM plays_resolved p JOIN tracks t USING (track_id) WHERE t.explicit IS NOT NULL ${PW('p')} GROUP BY 1 HAVING COUNT(*) >= 50 ORDER BY 1`)).map((r) => ({ year: num(r.y), share: num(r.share), known: num(r.known) }));
}
