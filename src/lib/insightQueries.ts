/**
 * Insight detectors (spec §7), run live against plays_resolved. Behaviour-only:
 * none of these need enrichment. All honour the listening lens. Each returns
 * plain rows the Insights / Year in Review pages render as cards.
 */
import { query, num, str } from './db';
import { playsWhere, sessionsWhere } from './filter';
import type { ArtistRow, TrackRow, SessionShapeRow, HourSlice, DayCell } from './types';
import { localToday } from './queries';
import { sanitizeEraParams, type EraParams } from './eraParams';
export type { EraParams } from './eraParams';

const PW = () => playsWhere();
const toA = (r: Record<string, unknown>): ArtistRow => ({ artistId: String(r.artistId), artist: String(r.artist), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) });
const toT = (r: Record<string, unknown>): TrackRow => ({ trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) });

// INS-06 — the 3 AM canon: highest late-night share vs overall, min 8 late plays.
export type CanonRow = { id: string; name: string; artist: string | null; artistId: string | null; latePlays: number; lateShare: number; lift: number };
export async function lateNightCanon(kind: 'track' | 'artist'): Promise<CanonRow[]> {
  const late = `(EXTRACT(hour FROM played_at) >= 23 OR EXTRACT(hour FROM played_at) < 4)`;
  const rows = kind === 'track'
    ? await query(`
      WITH base AS (SELECT AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) AS s FROM plays_resolved WHERE 1=1 ${PW()})
      SELECT track_id AS id, track_name AS name, artist_name AS artist, artist_id AS "artistId",
             COUNT(*) FILTER (WHERE ${late}) AS late_plays,
             AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) AS late_share,
             AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) / NULLIF((SELECT s FROM base), 0) AS lift
      FROM plays_resolved WHERE track_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3, 4
      HAVING late_plays >= 3 AND COUNT(*) >= 5 ORDER BY lift DESC, late_plays DESC LIMIT 15`)
    : await query(`
      WITH base AS (SELECT AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) AS s FROM plays_resolved WHERE 1=1 ${PW()})
      SELECT artist_id AS id, artist_name AS name, NULL AS artist, artist_id AS "artistId",
             COUNT(*) FILTER (WHERE ${late}) AS late_plays,
             AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) AS late_share,
             AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) / NULLIF((SELECT s FROM base), 0) AS lift
      FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3, 4
      HAVING late_plays >= 8 AND COUNT(*) >= 20 ORDER BY lift DESC, late_plays DESC LIMIT 15`);
  return rows.map((r) => ({ id: String(r.id), name: String(r.name), artist: str(r.artist), artistId: str(r.artistId), latePlays: num(r.late_plays), lateShare: num(r.late_share), lift: num(r.lift) }));
}

// INS-02 — obsessions: any 7-day window where an artist's plays ≥ 5× its trailing-90-day pace and ≥ 15 plays.
export type Obsession = { artistId: string; artist: string; weekStart: string; plays: number; expected: number; lift: number; halfLifeDays: number | null; peakTrack: string | null };
export async function obsessions(limit = 12): Promise<Obsession[]> {
  const rows = await query(`
    WITH w AS (
      SELECT artist_id, artist_name, DATE_TRUNC('week', played_at)::DATE AS wk, COUNT(*) AS c
      FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3),
    base AS (
      SELECT artist_id, wk, c,
             SUM(c) OVER (PARTITION BY artist_id ORDER BY wk RANGE BETWEEN INTERVAL 91 DAY PRECEDING AND INTERVAL 7 DAY PRECEDING) AS prior13w
      FROM w),
    hits AS (
      SELECT b.artist_id, w.artist_name, b.wk, b.c, COALESCE(b.prior13w, 0) / 13.0 AS expected,
             b.c / NULLIF(COALESCE(b.prior13w, 0) / 13.0, 0) AS lift
      FROM base b JOIN w USING (artist_id, wk)
      WHERE b.c >= 15 AND (b.prior13w IS NULL OR b.prior13w = 0 OR b.c >= 5 * b.prior13w / 13.0)),
    best AS (
      SELECT * FROM hits QUALIFY ROW_NUMBER() OVER (PARTITION BY artist_id ORDER BY c DESC) = 1),
    decay AS (
      SELECT h.artist_id, h.wk,
             MIN(w2.wk) FILTER (WHERE w2.wk > h.wk AND w2.c < h.c * 0.5) AS half_wk
      FROM best h LEFT JOIN w w2 ON w2.artist_id = h.artist_id GROUP BY 1, 2),
    peak_track AS (
      SELECT p.artist_id, b.wk, arg_max(p.track_name, cnt) AS track FROM (
        SELECT artist_id, track_name, DATE_TRUNC('week', played_at)::DATE AS wk, COUNT(*) AS cnt
        FROM plays_resolved WHERE 1=1 ${PW()} GROUP BY 1, 2, 3) p JOIN best b USING (artist_id, wk) GROUP BY 1, 2)
    SELECT b.artist_id, b.artist_name, CAST(b.wk AS VARCHAR) AS wk, b.c, b.expected, COALESCE(b.lift, 99) AS lift,
           CASE WHEN d.half_wk IS NULL THEN NULL ELSE d.half_wk - b.wk END AS half_days, pt.track
    FROM best b LEFT JOIN decay d USING (artist_id, wk) LEFT JOIN peak_track pt USING (artist_id, wk)
    ORDER BY b.c DESC LIMIT ${limit}`);
  return rows.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist_name), weekStart: String(r.wk), plays: num(r.c), expected: num(r.expected), lift: num(r.lift), halfLifeDays: r.half_days == null ? null : num(r.half_days), peakTrack: str(r.track) }));
}

// INS-03 — lifecycle: status per artist with ≥ 20 plays, relative to `today`.
export type Lifecycle = { artistId: string; artist: string; status: string; plays: number; hours: number; firstPlayed: string; lastPlayed: string; peakMonth: string; recentHours: number; priorHours: number; daysSilent: number };
export type RetentionArtist = { artistId: string; artist: string; plays: number; hours: number; lastPlayed: string; daysSilent: number; stillPlayed: boolean };
/** Phase 9: who you found in `year` (5+ plays) and whether they're still with you — the drill-down behind the retention bars. */
export async function retentionDetail(year: number): Promise<RetentionArtist[]> {
  const today = localToday();
  return (await query(`
    WITH first AS (SELECT artist_id, arg_max(artist_name, ms_played) AS name, EXTRACT(year FROM MIN(played_at))::INT AS y, COUNT(*) AS plays, SUM(ms_played)/3600000.0 AS hours, MAX(played_at) AS last_at
                   FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1 HAVING COUNT(*) >= 5)
    SELECT artist_id, name, plays, ROUND(hours, 1) AS hours, CAST(last_at AS VARCHAR) AS last_at,
           CAST(CAST($1 AS DATE) - CAST(last_at AS DATE) AS INTEGER) AS days_silent,
           last_at >= CAST($1 AS DATE) - INTERVAL 365 DAY AS still
    FROM first WHERE y = $2 ORDER BY still ASC, hours DESC`, [today, year])).map((r) => ({
    artistId: String(r.artist_id), artist: String(r.name), plays: num(r.plays), hours: num(r.hours), lastPlayed: String(r.last_at), daysSilent: num(r.days_silent), stillPlayed: Boolean(r.still),
  }));
}

export async function lifecycle(): Promise<{ rising: Lifecycle[]; fading: Lifecycle[]; returned: Lifecycle[]; dormant: Lifecycle[]; retention: { year: number; discovered: number; stillPlayed: number }[] }> {
  const today = localToday();
  const rows = await query(`
    WITH a AS (
      SELECT artist_id, artist_name, COUNT(*) AS plays, SUM(ms_played)/3600000.0 AS hours,
             MIN(played_at) AS first_at, MAX(played_at) AS last_at,
             SUM(ms_played) FILTER (WHERE played_at >= CAST($1 AS DATE) - INTERVAL 90 DAY)/3600000.0 AS recent_h,
             SUM(ms_played) FILTER (WHERE played_at <  CAST($1 AS DATE) - INTERVAL 90 DAY AND played_at >= CAST($1 AS DATE) - INTERVAL 180 DAY)/3600000.0 AS prior_h,
             MAX(played_at) FILTER (WHERE played_at < CAST($1 AS DATE) - INTERVAL 30 DAY) AS last_before_month,
             MIN(played_at) FILTER (WHERE played_at >= CAST($1 AS DATE) - INTERVAL 30 DAY) AS first_in_month
      FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2 HAVING COUNT(*) >= 20),
    pk AS (SELECT artist_id, arg_max(mo, h) AS peak_month FROM (
      SELECT artist_id, DATE_TRUNC('month', played_at)::DATE AS mo, SUM(ms_played) AS h FROM plays_resolved WHERE 1=1 ${PW()} GROUP BY 1, 2) GROUP BY 1)
    SELECT a.*, CAST(pk.peak_month AS VARCHAR) AS peak_month,
      CASE
        WHEN first_in_month IS NOT NULL AND last_before_month IS NOT NULL AND first_in_month - last_before_month >= INTERVAL 180 DAY THEN 'returned'
        WHEN last_at < CAST($1 AS DATE) - INTERVAL 180 DAY THEN 'dormant'
        WHEN COALESCE(recent_h, 0) > COALESCE(prior_h, 0) * 1.5 AND COALESCE(recent_h, 0) >= 0.5 THEN 'rising'
        WHEN COALESCE(recent_h, 0) < COALESCE(prior_h, 0) * 0.5 AND COALESCE(prior_h, 0) >= 1 THEN 'fading'
        ELSE 'steady' END AS status,
      CAST(CAST($1 AS DATE) - CAST(last_at AS DATE) AS INTEGER) AS days_silent
    FROM a LEFT JOIN pk USING (artist_id)`, [today]);
  const all: Lifecycle[] = rows.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist_name), status: String(r.status), plays: num(r.plays), hours: num(r.hours), firstPlayed: String(r.first_at), lastPlayed: String(r.last_at), peakMonth: String(r.peak_month ?? ''), recentHours: num(r.recent_h), priorHours: num(r.prior_h), daysSilent: num(r.days_silent) }));
  const by = (s: string, sort: (a: Lifecycle, b: Lifecycle) => number, n = 8) => all.filter((x) => x.status === s).sort(sort).slice(0, n);
  const retention = (await query(`
    WITH first AS (SELECT artist_id, EXTRACT(year FROM MIN(played_at))::INT AS y, COUNT(*) AS plays FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1 HAVING COUNT(*) >= 5),
         recent AS (SELECT DISTINCT artist_id FROM plays_resolved WHERE played_at >= CAST($1 AS DATE) - INTERVAL 365 DAY ${PW()})
    SELECT f.y AS year, COUNT(*) AS discovered, COUNT(r.artist_id) AS still FROM first f LEFT JOIN recent r USING (artist_id)
    WHERE f.y < EXTRACT(year FROM CAST($1 AS DATE)) GROUP BY 1 ORDER BY 1`, [today])).map((r) => ({ year: num(r.year), discovered: num(r.discovered), stillPlayed: num(r.still) }));
  return {
    rising: by('rising', (a, b) => b.recentHours - a.recentHours),
    fading: by('fading', (a, b) => b.priorHours - a.priorHours),
    returned: by('returned', (a, b) => b.hours - a.hours),
    dormant: by('dormant', (a, b) => b.hours - a.hours, 10),
    retention,
  };
}

// INS-04 — skip forensics.
export type CantQuit = TrackRow & { lastPlayed: string };
export type EarlyExit = { trackId: string; track: string; artist: string; artistId: string | null; n: number; meanMs: number; sdMs: number; durationMs: number | null };
export async function skipForensics(): Promise<{ cantQuit: CantQuit[]; earlyExits: EarlyExit[]; byYear: { year: number; skipRate: number; under30: number }[] }> {
  const cantQuit = (await query(`
    SELECT track_id AS "trackId", track_name AS track, artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays,
           ROUND(SUM(ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS "skipRate", CAST(MAX(played_at) AS VARCHAR) AS last
    FROM plays_resolved WHERE track_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3, 4
    HAVING COUNT(*) >= 10 AND "skipRate" >= 0.6 ORDER BY plays DESC LIMIT 12`)).map((r) => ({ ...toT(r), lastPlayed: String(r.last) }));
  const earlyExits = (await query(`
    SELECT p.track_id, p.track_name, p.artist_name, p.artist_id, COUNT(*) AS n, AVG(p.ms_played) AS mean_ms, STDDEV(p.ms_played) AS sd_ms,
           COALESCE(t.duration_ms, t.duration_ms_est) AS dur
    FROM plays_resolved p LEFT JOIN tracks t ON t.track_id = p.track_id
    WHERE p.was_skipped AND p.track_id IS NOT NULL AND p.ms_played > 5000 ${playsWhere('p')} GROUP BY 1, 2, 3, 4, 8
    HAVING COUNT(*) >= 6 AND STDDEV(p.ms_played) < 10000 ORDER BY n DESC LIMIT 12`)).map((r) => ({ trackId: String(r.track_id), track: String(r.track_name), artist: String(r.artist_name ?? ''), artistId: str(r.artist_id), n: num(r.n), meanMs: num(r.mean_ms), sdMs: num(r.sd_ms), durationMs: r.dur == null ? null : num(r.dur) }));
  const byYear = (await query(`
    SELECT EXTRACT(year FROM played_at)::INT AS year, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS skip_rate, AVG(CASE WHEN under_30s THEN 1.0 ELSE 0 END) AS under30
    FROM plays_resolved WHERE 1=1 ${PW()} GROUP BY 1 ORDER BY 1`)).map((r) => ({ year: num(r.year), skipRate: num(r.skip_rate), under30: num(r.under30) }));
  return { cantQuit, earlyExits, byYear };
}

// INS-05 — seasonality: artists whose share in one quarter is ≥ 2× their annual mean, ≥ 2 years of data.
export type Seasonal = { artistId: string; artist: string; season: string; index: number; plays: number; years: number };
export async function seasonality(): Promise<{ enough: boolean; winter: Seasonal[]; spring: Seasonal[]; summer: Seasonal[]; autumn: Seasonal[] }> {
  const [span] = await query(`SELECT COUNT(DISTINCT EXTRACT(year FROM played_at)) AS y FROM plays_resolved WHERE 1=1 ${PW()}`);
  if (num(span?.y) < 2) return { enough: false, winter: [], spring: [], summer: [], autumn: [] };
  const rows = await query(`
    WITH q AS (
      SELECT artist_id, artist_name,
             CASE WHEN EXTRACT(month FROM played_at) IN (12, 1, 2) THEN 'winter' WHEN EXTRACT(month FROM played_at) IN (3, 4, 5) THEN 'spring'
                  WHEN EXTRACT(month FROM played_at) IN (6, 7, 8) THEN 'summer' ELSE 'autumn' END AS season,
             COUNT(*) AS c, COUNT(DISTINCT EXTRACT(year FROM played_at)) AS yrs
      FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3),
    tot AS (SELECT artist_id, SUM(c) AS n, COUNT(DISTINCT season) AS seasons FROM q GROUP BY 1),
    all_season AS (SELECT season, SUM(c) * 1.0 / (SELECT SUM(c) FROM q) AS base FROM q GROUP BY 1)
    SELECT q.artist_id, q.artist_name, q.season, q.c, q.yrs, (q.c * 1.0 / t.n) / a.base AS idx
    FROM q JOIN tot t USING (artist_id) JOIN all_season a USING (season)
    WHERE t.n >= 40 AND q.c >= 25 AND q.yrs >= 2 AND (q.c * 1.0 / t.n) / a.base >= 2.0
    ORDER BY idx DESC`);
  const all: Seasonal[] = rows.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist_name), season: String(r.season), index: num(r.idx), plays: num(r.c), years: num(r.yrs) }));
  const pick = (s: string) => all.filter((x) => x.season === s).slice(0, 8);
  return { enough: true, winter: pick('winter'), spring: pick('spring'), summer: pick('summer'), autumn: pick('autumn') };
}

// INS-07 — weekday vs weekend personas, plus the commute signature.
export type Persona = { hours: number; topArtists: ArtistRow[]; shapes: SessionShapeRow[]; clock: HourSlice[]; skipRate: number };
export async function personas(): Promise<{ weekday: Persona; weekend: Persona; commute: { window: string; hours: number; topArtists: ArtistRow[] } | null }> {
  const build = async (weekend: boolean): Promise<Persona> => {
    const cond = weekend ? 'EXTRACT(dow FROM played_at) IN (0, 6)' : 'EXTRACT(dow FROM played_at) BETWEEN 1 AND 5';
    const [t] = await query(`SELECT SUM(ms_played)/3600000.0 AS h, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved WHERE ${cond} ${PW()}`);
    const topArtists = (await query(`
      SELECT artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"
      FROM plays_resolved WHERE ${cond} AND artist_id IS NOT NULL ${PW()} GROUP BY 1, 2 ORDER BY hours DESC LIMIT 6`)).map(toA);
    const shapes = (await query(`SELECT session_shape AS shape, COUNT(*) AS count FROM sessions WHERE is_weekend = ${weekend} AND track_count >= 2 ${sessionsWhere()} GROUP BY 1 ORDER BY 2 DESC`)).map((r) => ({ shape: String(r.shape), count: num(r.count) }));
    const clock = (await query(`
      WITH h AS (SELECT EXTRACT(hour FROM played_at) AS hour, SUM(ms_played)/3600000.0 AS hours FROM plays_resolved WHERE ${cond} ${PW()} GROUP BY 1)
      SELECT r.hour::INT AS hour, ROUND(COALESCE(h.hours, 0), 2) AS hours FROM range(24) r(hour) LEFT JOIN h USING (hour) ORDER BY 1`)).map((r) => ({ hour: num(r.hour), hours: num(r.hours) }));
    return { hours: num(t?.h), topArtists, shapes, clock, skipRate: num(t?.sr) };
  };
  const weekday = await build(false), weekend = await build(true);
  // commute: the recurring weekday hour (6–10 or 15–19) with the most sessions across distinct days
  const [c] = await query(`
    SELECT EXTRACT(hour FROM start_at)::INT AS h, COUNT(DISTINCT CAST(start_at AS DATE)) AS days, SUM(total_ms)/3600000.0 AS hrs
    FROM sessions WHERE NOT is_weekend AND (EXTRACT(hour FROM start_at) BETWEEN 6 AND 10 OR EXTRACT(hour FROM start_at) BETWEEN 15 AND 19) ${sessionsWhere()}
    GROUP BY 1 ORDER BY days DESC LIMIT 1`);
  let commute = null;
  if (c && num(c.days) >= 20) {
    const h = num(c.h);
    const top = (await query(`
      SELECT p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"
      FROM plays_resolved p WHERE EXTRACT(dow FROM p.played_at) BETWEEN 1 AND 5 AND EXTRACT(hour FROM p.played_at) BETWEEN ${h} AND ${h + 1} AND p.artist_id IS NOT NULL ${playsWhere('p')}
      GROUP BY 1, 2 ORDER BY hours DESC LIMIT 5`)).map(toA);
    commute = { window: `${h % 12 || 12}–${(h + 2) % 12 || 12} ${h + 2 < 12 ? 'AM' : 'PM'} on weekdays`, hours: num(c.hrs), topArtists: top };
  }
  return { weekday, weekend, commute };
}

// INS-01 — eras: adjacent WEEKS whose top-artist share vectors are similar belong to one era.
//
// Phase 9b (design brief §3): the backbone moved from month → ISO week (Monday start) so eras
// land at the 6–12 week scale the owner actually experiences them at. The CTE chain is generic
// over one truncated-date column, `wk`, so the swap did not restructure it — but the numbers
// did change shape: weekly top-40 vectors are ~10× noisier than monthly ones (median cosine
// 0.068 vs ~0.3 on the owner's record), so the threshold dropped from 0.3 to 0.04 and the
// minimum run from 2 months to 4 weeks. Defaults, bounds and presets live in `eraParams.ts`
// and are owner-tunable in Settings; the Phase 9 "keep every period" merge logic is unchanged.
//
// Phase 9 fix (owner saw no eras for 2025–26, twice): the old query DROPPED any era shorter than
// the minimum, so on a varied record every period became its own short era and was filtered out —
// the timeline simply ended. Now every week is kept: a RUN of consecutive short eras that together
// span `minWeeks`+ becomes its own era, and an isolated short era is absorbed into the era before
// it (or after, at the very start), so the timeline always reaches the present. The current week
// is flagged `inProgress`. `eraDiagnostic()` exposes the per-week numbers behind the boundaries.

export type Era = {
  start: string; end: string; endExclusive: string; weeks: number; hours: number;
  topArtists: { artistId: string; artist: string; hours: number }[];
  skipRate: number; noveltyRate: number; lateShare: number; topShape: string | null; topTag: string | null; name: string; inProgress: boolean;
};

/**
 * Cosine similarity between each period's vector and the previous period's, as a chain of CTEs.
 * Expects a CTE `${vectors}` with columns (${period}, ${id}, ${value}) and produces:
 *   `norms(${period}, n)`, `pairs(${period}, prev)`, `dots(${period}, dot)`, `sim(${period}, prev, cos)`.
 * Norms are computed once per period instead of via a correlated subquery per pair, and the dot
 * product is an INNER join on the shared id, so a period with no overlap simply has no `dots` row
 * (COALESCE → 0). Shared by the artist backbone; any other per-period vector (tags, albums) can
 * reuse it by naming its CTE.
 */
export function similarityChain({ vectors, period, id, value }: { vectors: string; period: string; id: string; value: string }) {
  return `
    norms AS (SELECT ${period}, SQRT(SUM(${value} * ${value})) AS n FROM ${vectors} GROUP BY 1),
    pairs AS (SELECT ${period}, LAG(${period}) OVER (ORDER BY ${period}) AS prev FROM norms),
    dots AS (SELECT p.${period}, SUM(x.${value} * y.${value}) AS dot
             FROM pairs p JOIN ${vectors} x ON x.${period} = p.${period} JOIN ${vectors} y ON y.${period} = p.prev AND y.${id} = x.${id}
             GROUP BY 1),
    sim AS (SELECT p.${period}, p.prev, COALESCE(d.dot, 0) / NULLIF(nx.n * ny.n, 0) AS cos
            FROM pairs p LEFT JOIN dots d USING (${period}) JOIN norms nx ON nx.${period} = p.${period} LEFT JOIN norms ny ON ny.${period} = p.prev)`;
}

const ERA_CTES = (p: EraParams) => `
    WITH m AS (
      SELECT DATE_TRUNC('week', played_at)::DATE AS wk, artist_id, artist_name, SUM(ms_played)/3600000.0 AS h
      FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3),
    tot AS (SELECT wk, SUM(h) AS th FROM m GROUP BY 1 HAVING SUM(h) >= ${p.floorH}),
    v AS (SELECT m.wk, m.artist_id, m.artist_name, m.h, m.h / t.th AS share FROM m JOIN tot t USING (wk)
          QUALIFY ROW_NUMBER() OVER (PARTITION BY m.wk ORDER BY m.h DESC) <= 40),
    ${similarityChain({ vectors: 'v', period: 'wk', id: 'artist_id', value: 'share' })},
    flagged AS (SELECT wk, prev, cos, CASE WHEN prev IS NULL OR cos < ${p.similarity} OR (wk - prev) > ${p.maxGapWeeks * 7} THEN 1 ELSE 0 END AS brk FROM sim),
    raw AS (SELECT wk, prev, cos, brk, SUM(brk) OVER (ORDER BY wk ROWS UNBOUNDED PRECEDING) AS era0 FROM flagged)`;

export async function eras(params?: Partial<EraParams>): Promise<Era[]> {
  const p = sanitizeEraParams(params);
  const rows = await query(`${ERA_CTES(p)},
    sizes AS (SELECT era0, COUNT(*) AS n FROM raw GROUP BY 1),
    big AS (SELECT r.wk, r.era0, s.n < ${p.minWeeks} AS short FROM raw r JOIN sizes s USING (era0)),
    starts AS (SELECT wk, era0, short, CASE WHEN short AND NOT COALESCE(LAG(short) OVER (ORDER BY wk), FALSE) THEN 1 ELSE 0 END AS run_start FROM big),
    runs AS (SELECT wk, era0, short, SUM(run_start) OVER (ORDER BY wk ROWS UNBOUNDED PRECEDING) AS run FROM starts),
    run_len AS (SELECT run, COUNT(*) AS n, MIN(era0) AS era_id FROM runs WHERE short GROUP BY 1),
    assigned AS (SELECT r.wk, CASE WHEN NOT r.short THEN r.era0 WHEN rl.n >= ${p.minWeeks} THEN rl.era_id END AS era1
                 FROM runs r LEFT JOIN run_len rl ON rl.run = r.run AND r.short),
    grp AS (
      SELECT wk, COALESCE(
        LAST_VALUE(era1 IGNORE NULLS) OVER (ORDER BY wk ROWS UNBOUNDED PRECEDING),
        FIRST_VALUE(era1 IGNORE NULLS) OVER (ORDER BY wk ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING),
        0) AS era FROM assigned),
    era_art AS (SELECT g.era, v.artist_id, v.artist_name, SUM(v.h) AS h FROM grp g JOIN v USING (wk) GROUP BY 1, 2, 3),
    span AS (SELECT era, MIN(wk) AS s, MAX(wk) + INTERVAL 7 DAY AS e FROM grp GROUP BY 1),
    beh AS (SELECT sp.era, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr, AVG(CASE WHEN p.is_first_play THEN 1.0 ELSE 0 END) AS nov,
                   AVG(CASE WHEN EXTRACT(hour FROM p.played_at) >= 23 OR EXTRACT(hour FROM p.played_at) < 4 THEN 1.0 ELSE 0 END) AS late
            FROM span sp JOIN plays_resolved p ON p.played_at >= sp.s AND p.played_at < sp.e WHERE 1=1 ${PW()} GROUP BY 1),
    shp AS (SELECT sp.era, arg_max(s.session_shape, c) AS shape FROM span sp JOIN (SELECT session_shape, start_at, COUNT(*) OVER (PARTITION BY session_shape, DATE_TRUNC('week', start_at)) c FROM sessions WHERE track_count >= 3 AND session_shape <> 'steady') s ON s.start_at >= sp.s AND s.start_at < sp.e GROUP BY 1),
    tg AS (SELECT ea.era, arg_max(t.tag, ea.h * t.weight) AS tag FROM era_art ea JOIN artist_tags t USING (artist_id) GROUP BY 1)
    SELECT g.era, CAST(MIN(g.wk) AS VARCHAR) AS s, CAST(MAX(g.wk) AS VARCHAR) AS e, CAST(MAX(g.wk) + INTERVAL 7 DAY AS DATE)::VARCHAR AS ex, COUNT(DISTINCT g.wk) AS n,
           SUM(t.th) AS hours, MAX(b.sr) AS sr, MAX(b.nov) AS nov, MAX(b.late) AS late, MAX(sh.shape) AS shape, MAX(tg.tag) AS tag,
           MAX(g.wk) = DATE_TRUNC('week', CAST($1 AS DATE))::DATE AS in_progress,
           (SELECT list(struct_pack(artist_id := artist_id, artist_name := artist_name, h := ROUND(h, 1)) ORDER BY h DESC) FROM (SELECT * FROM era_art ea WHERE ea.era = g.era ORDER BY h DESC LIMIT 3)) AS top
    FROM grp g JOIN tot t USING (wk) LEFT JOIN beh b ON b.era = g.era LEFT JOIN shp sh ON sh.era = g.era LEFT JOIN tg ON tg.era = g.era
    GROUP BY g.era ORDER BY MIN(g.wk) DESC`, [localToday()]);
  return rows.map((r) => {
    const e: Era = {
      start: String(r.s), end: String(r.e), endExclusive: String(r.ex), weeks: num(r.n), hours: num(r.hours),
      topArtists: ((r.top as { artist_id: string; artist_name: string; h: number }[]) ?? []).map((t) => ({ artistId: t.artist_id, artist: t.artist_name, hours: num(t.h) })),
      skipRate: num(r.sr), noveltyRate: num(r.nov), lateShare: num(r.late), topShape: str(r.shape), topTag: str(r.tag), name: '', inProgress: Boolean(r.in_progress),
    };
    e.name = nameEra(e);
    return e;
  });
}

export type EraWeek = { week: string; hours: number; cosToPrev: number | null; breaks: boolean; topArtist: string | null };
/**
 * Why the era boundaries fall where they do: per-week hours, similarity to the previous week, and
 * whether it opened a new (pre-merge) era. `limitWeeks = null` returns the whole record — the
 * eras chart uses that as its weekly hours backbone, so both read one data path.
 */
export async function eraDiagnostic(params?: Partial<EraParams>, limitWeeks: number | null = 52): Promise<EraWeek[]> {
  const p = sanitizeEraParams(params);
  return (await query(`${ERA_CTES(p)},
    ta AS (SELECT wk, arg_max(artist_name, h) AS top FROM v GROUP BY 1)
    SELECT CAST(r.wk AS VARCHAR) AS wk, t.th AS hours, r.cos, r.brk, ta.top
    FROM raw r JOIN tot t USING (wk) LEFT JOIN ta USING (wk) ORDER BY r.wk DESC ${limitWeeks ? `LIMIT ${Math.max(1, Math.round(limitWeeks))}` : ''}`)).map((r) => ({
    week: String(r.wk).slice(0, 10), hours: num(r.hours), cosToPrev: r.cos == null ? null : num(r.cos), breaks: num(r.brk) === 1, topArtist: str(r.top),
  })).reverse();
}

/** Deterministic, a little wry: a mood word only when the behaviour is notable; otherwise the season and the lead artists carry it. Season comes from the calendar dates, so it works at any grain. */
export function nameEra(e: Era): string {
  const m0 = Number(e.start.slice(5, 7)), m1 = Number(e.end.slice(5, 7));
  const season = (m: number) => (m === 12 || m <= 2 ? 'winter' : m <= 5 ? 'spring' : m <= 8 ? 'summer' : 'autumn');
  const span = season(m0) === season(m1) ? season(m0) : e.weeks >= 20 ? 'stretch' : `${season(m0)}-into-${season(m1)}`;
  const lead = e.topArtists[0]?.artist ?? 'Unknown';
  const second = e.topArtists[1]?.artist;
  const cap = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);
  if (e.weeks >= 40) return `The year of ${lead}`;
  const aAn = (n: string) => (/^the\s/i.test(n) ? n : `A ${n}`);
  const mood = e.lateShare >= 0.10 ? 'Late nights with' : e.skipRate >= 0.18 ? 'Restless' : e.noveltyRate >= 0.55 ? 'Wide-eyed' : e.topShape === 'album_ride' ? 'Front to back:' : e.topShape === 'comfort_loop' ? 'On repeat:' : e.topShape === 'binge' || e.topShape === 'deep_dive' ? 'All in on' : e.topShape === 'autopilot' ? 'Hands-off' : null;
  if (mood === 'Late nights with' || mood === 'All in on') return `${mood} ${lead}`;
  if (mood === 'Front to back:' || mood === 'On repeat:') return `${mood} ${lead}${second ? ` and ${second}` : ''}`;
  if (mood) return `${mood} ${lead} ${span}`;
  const v = (e.start.charCodeAt(5) + e.start.charCodeAt(6) + e.start.charCodeAt(8) + e.weeks) % 4;
  const the = (n: string) => (/^the\s/i.test(n) ? n : `The ${n}`);
  return v === 0 ? `${the(lead)} ${span}` : v === 1 ? `${cap(span)} of ${lead}${second ? ` and ${second}` : ''}` : v === 2 ? `${lead}, ${second ?? 'mostly'}, ${span}` : `${aAn(lead)} ${span}`;
}

/** Top tracks of an era (or any span) by hours — the "Soundtrack of this era" playlist hook. */
export async function spanTracks(from: string, toExclusive: string, n = 30): Promise<TrackRow[]> {
  const rows = await query(`SELECT track_id AS "trackId", track_name AS track, artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"
    FROM plays_resolved WHERE played_at >= DATE '${from}' AND played_at < DATE '${toExclusive}' AND track_id IS NOT NULL ${PW()} GROUP BY 1, 2, 3, 4 ORDER BY SUM(ms_played) DESC LIMIT ${n}`);
  return rows.map(toT);
}

// INS-12 — Review of any period: a year, a month, the last N days, or a custom range.
export type Period = { from: string; to: string; label: string }; // ISO dates, `to` exclusive
export const periodForYear = (y: number): Period => ({ from: `${y}-01-01`, to: `${y + 1}-01-01`, label: String(y) });
export const periodForMonth = (key: string): Period => { const [y, m] = key.split('-').map(Number); const nx = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`; return { from: `${key}-01`, to: nx, label: new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }) }; };
export const periodLastDays = (n: number): Period => { const t = new Date(localToday() + 'T00:00:00'); const to = new Date(t.getTime() + 86400e3); const from = new Date(t.getTime() - (n - 1) * 86400e3); const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; return { from: iso(from), to: iso(to), label: `Last ${n} days` }; };
export const periodCustom = (from: string, toInclusive: string): Period => { const t = new Date(toInclusive + 'T00:00:00'); const to = new Date(t.getTime() + 86400e3); const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); return { from, to: iso(to), label: `${fmt(from)} – ${fmt(toInclusive)}` }; };

export type YearReview = {
  period: Period; spanDays: number; monthsAvailable: string[];
  label: string; plays: number; hours: number; artists: number; tracks: number; newArtists: number; newTracks: number; days: number;
  topArtists: ArtistRow[]; topTracks: TrackRow[]; topAlbums: { albumId: string; album: string; artist: string; hours: number; imageUrl: string | null }[];
  shapes: SessionShapeRow[]; loudestDay: DayCell | null; longestSession: { day: string; hours: number; tracks: number; shape: string } | null;
  canon: CanonRow[]; clock: HourSlice[]; months: { month: string; key: string; hours: number }[];
  keptDiscoveries: { artistId: string; artist: string; plays: number }[]; droppedDiscoveries: { artistId: string; artist: string; plays: number }[];
  yearsAvailable: number[]; skipRate: number; lateShare: number;
};
export async function yearInReview(year: number | null): Promise<YearReview> {
  return periodReview(year ? periodForYear(year) : periodLastDays(365));
}

export async function periodReview(period: Period, topN = 5): Promise<YearReview> {
  const range = `played_at >= DATE '${period.from}' AND played_at < DATE '${period.to}'`;
  const srange = `start_at >= DATE '${period.from}' AND start_at < DATE '${period.to}'`;
  const W = `WHERE ${range} ${PW()}`;
  const dayCount = Math.round((new Date(period.to + 'T00:00:00').getTime() - new Date(period.from + 'T00:00:00').getTime()) / 86400e3);
  const [t] = await query(`
    SELECT COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0) AS hours, COUNT(DISTINCT artist_id) AS artists, COUNT(DISTINCT track_id) AS tracks,
           COUNT(DISTINCT CAST(played_at AS DATE)) AS days, SUM(CASE WHEN is_first_play THEN 1 ELSE 0 END) AS new_tracks,
           AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr,
           AVG(CASE WHEN EXTRACT(hour FROM played_at) >= 23 OR EXTRACT(hour FROM played_at) < 4 THEN 1.0 ELSE 0 END) AS late
    FROM plays_resolved ${W}`);
  const [na] = await query(`
    WITH f AS (SELECT artist_id, MIN(played_at) AS first_at FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1)
    SELECT COUNT(*) AS n FROM f WHERE ${range.replace(/played_at/g, 'first_at')}`);
  const topArtists = (await query(`SELECT artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS "skipRate" FROM plays_resolved ${W} AND artist_id IS NOT NULL GROUP BY 1, 2 ORDER BY hours DESC LIMIT ${topN}`)).map(toA);
  const topTracks = (await query(`SELECT track_id AS "trackId", track_name AS track, artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS "skipRate" FROM plays_resolved ${W} AND track_id IS NOT NULL GROUP BY 1, 2, 3, 4 ORDER BY plays DESC LIMIT ${topN}`)).map(toT);
  const topAlbums = (await query(`SELECT p.album_id, p.album_name, p.artist_name, ROUND(SUM(p.ms_played)/3600000.0, 1) AS h, ANY_VALUE(al.image_url) AS img FROM plays_resolved p LEFT JOIN albums al ON al.album_id = p.album_id ${W.replace(/played_at/g, 'p.played_at')} AND p.album_id IS NOT NULL GROUP BY 1, 2, 3 ORDER BY h DESC LIMIT ${topN}`)).map((r) => ({ albumId: String(r.album_id), album: String(r.album_name), artist: String(r.artist_name ?? ''), hours: num(r.h), imageUrl: str(r.img) }));
  const shapes = (await query(`SELECT session_shape AS shape, COUNT(*) AS count FROM sessions WHERE ${srange} AND track_count >= 2 ${sessionsWhere()} GROUP BY 1 ORDER BY 2 DESC`)).map((r) => ({ shape: String(r.shape), count: num(r.count) }));
  const [ld] = await query(`SELECT CAST(CAST(played_at AS DATE) AS VARCHAR) AS day, ROUND(SUM(ms_played)/60000.0) AS minutes, COUNT(*) AS plays FROM plays_resolved ${W} GROUP BY 1 ORDER BY minutes DESC LIMIT 1`);
  const [ls] = await query(`SELECT CAST(CAST(start_at AS DATE) AS VARCHAR) AS day, total_ms/3600000.0 AS h, track_count, session_shape FROM sessions WHERE ${srange} ${sessionsWhere()} ORDER BY total_ms DESC LIMIT 1`);
  const late = `(EXTRACT(hour FROM played_at) >= 23 OR EXTRACT(hour FROM played_at) < 4)`;
  const canon = (await query(`
    WITH base AS (SELECT AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) AS s FROM plays_resolved ${W})
    SELECT track_id AS id, track_name AS name, artist_name AS artist, artist_id AS "artistId", COUNT(*) FILTER (WHERE ${late}) AS late_plays,
           AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) AS late_share, AVG(CASE WHEN ${late} THEN 1.0 ELSE 0 END) / NULLIF((SELECT s FROM base), 0) AS lift
    FROM plays_resolved ${W} AND track_id IS NOT NULL GROUP BY 1, 2, 3, 4 HAVING late_plays >= 2 ORDER BY late_plays DESC, lift DESC LIMIT 5`))
    .map((r) => ({ id: String(r.id), name: String(r.name), artist: str(r.artist), artistId: str(r.artistId), latePlays: num(r.late_plays), lateShare: num(r.late_share), lift: num(r.lift) }));
  const clock = (await query(`WITH h AS (SELECT EXTRACT(hour FROM played_at) AS hour, SUM(ms_played)/3600000.0 AS hours FROM plays_resolved ${W} GROUP BY 1) SELECT r.hour::INT AS hour, ROUND(COALESCE(h.hours, 0), 2) AS hours FROM range(24) r(hour) LEFT JOIN h USING (hour) ORDER BY 1`)).map((r) => ({ hour: num(r.hour), hours: num(r.hours) }));
  // short periods get a day series, long ones a month series
  const months = dayCount <= 62
    ? (await query(`SELECT strftime(CAST(played_at AS DATE), '%d') AS month, CAST(CAST(played_at AS DATE) AS VARCHAR) AS key, ROUND(SUM(ms_played)/3600000.0, 1) AS hours FROM plays_resolved ${W} GROUP BY CAST(played_at AS DATE) ORDER BY 2`)).map((r) => ({ month: String(r.month), key: String(r.key), hours: num(r.hours) }))
    : (await query(`SELECT strftime(DATE_TRUNC('month', played_at), '%b %y') AS month, strftime(DATE_TRUNC('month', played_at), '%Y-%m') AS key, ROUND(SUM(ms_played)/3600000.0, 1) AS hours FROM plays_resolved ${W} GROUP BY DATE_TRUNC('month', played_at) ORDER BY DATE_TRUNC('month', played_at)`)).map((r) => ({ month: String(r.month), key: String(r.key), hours: num(r.hours) }));
  // discoveries: artists first heard in the period; kept = played again ≥ 90 days after first play
  const disc = await query(`
    WITH f AS (SELECT artist_id, artist_name, MIN(played_at) AS first_at, COUNT(*) AS plays, MAX(played_at) AS last_at FROM plays_resolved WHERE artist_id IS NOT NULL ${PW()} GROUP BY 1, 2)
    SELECT artist_id, artist_name, plays, last_at - first_at >= INTERVAL 90 DAY AS kept FROM f WHERE ${range.replace(/played_at/g, 'first_at')} AND plays >= 5 ORDER BY plays DESC`);
  const kept = disc.filter((r) => Boolean(r.kept)).slice(0, 8).map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist_name), plays: num(r.plays) }));
  const dropped = disc.filter((r) => !r.kept).slice(0, 8).map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist_name), plays: num(r.plays) }));
  const yearsAvailable = (await query(`SELECT DISTINCT EXTRACT(year FROM played_at)::INT AS y FROM plays_resolved ORDER BY 1 DESC`)).map((r) => num(r.y));
  const monthsAvailable = (await query(`SELECT DISTINCT strftime(DATE_TRUNC('month', played_at), '%Y-%m') AS k FROM plays_resolved ORDER BY 1 DESC`)).map((r) => String(r.k));
  return {
    period, spanDays: dayCount, monthsAvailable,
    label: period.label,
    plays: num(t?.plays), hours: num(t?.hours), artists: num(t?.artists), tracks: num(t?.tracks), days: num(t?.days), newTracks: num(t?.new_tracks), newArtists: num(na?.n),
    topArtists, topTracks, topAlbums, shapes,
    loudestDay: ld ? { day: String(ld.day), minutes: num(ld.minutes), plays: num(ld.plays) } : null,
    longestSession: ls ? { day: String(ls.day), hours: num(ls.h), tracks: num(ls.track_count), shape: String(ls.session_shape) } : null,
    canon, clock, months, keptDiscoveries: kept, droppedDiscoveries: dropped, yearsAvailable, skipRate: num(t?.sr), lateShare: num(t?.late),
  };
}
