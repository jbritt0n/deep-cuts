/**
 * Phase 9b — genre threads (design brief §3.3): the second layer of eras.
 *
 * The artist backbone in `insightQueries.eras()` is sequential — one era per week, because every
 * week is partitioned by the same similarity chain. Threads are the opposite: for each tag with
 * meaningful weight, take that tag's share of each week's listening and find contiguous runs where
 * the share stays above a floor. Every tag is detected on its own, so two threads (or a thread and
 * the backbone) can cover the same week — that overlap is the whole point of the layer. An
 * "afrobeat" thread can run underneath three different artist-named eras.
 *
 * Shares are computed in SQL (one row per tag × week); the run detection is plain TS so the
 * rule is unit-testable without a database (`findRuns`). Threads carry no generated name — they
 * display as "{tag} thread" — because `nameEra()` is tuned for artist-led narrative naming.
 *
 * Tuning is independent of the backbone and was NOT benchmarked in the 9b design pass (the owner's
 * library had no tag at high enough weight to test against). ≥ 8 % share for ≥ 3 weeks is the
 * suggested start; both are parameters.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { localToday } from './queries';
import { numSetting } from './settings';

export type ThreadWeek = { week: string; hours: number; share: number };
export type GenreThread = {
  tag: string; start: string; end: string; endExclusive: string; weeks: number; hours: number; peakShare: number; meanShare: number;
  topArtists: { artistId: string; artist: string; hours: number }[]; inProgress: boolean; series: ThreadWeek[];
};
export type ThreadParams = { minWeeks: number; shareFloor: number; tagFloor: number; maxThreads: number };
export const THREAD_DEFAULTS: ThreadParams = { minWeeks: 3, shareFloor: 0.08, tagFloor: 0.2, maxThreads: 12 };
/** Defaults with the owner's tag floor applied (Settings → Tuning). */
const threadDefaults = (): ThreadParams => ({ ...THREAD_DEFAULTS, tagFloor: numSetting('tag_floor') });

/** Contiguous runs of weeks where `share >= floor`, at least `minWeeks` long. Weeks are consecutive ISO Mondays; a missing week breaks the run. */
export function findRuns(weeks: ThreadWeek[], floor: number, minWeeks: number): ThreadWeek[][] {
  const sorted = [...weeks].sort((a, b) => (a.week < b.week ? -1 : a.week > b.week ? 1 : 0));
  const runs: ThreadWeek[][] = [];
  let cur: ThreadWeek[] = [];
  const nextMonday = (w: string) => { const d = new Date(w + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 7); return d.toISOString().slice(0, 10); };
  for (const w of sorted) {
    const contiguous = cur.length > 0 && nextMonday(cur[cur.length - 1].week) === w.week;
    if (w.share >= floor && (cur.length === 0 || contiguous)) { cur.push(w); continue; }
    if (cur.length >= minWeeks) runs.push(cur);
    cur = w.share >= floor ? [w] : [];
  }
  if (cur.length >= minWeeks) runs.push(cur);
  return runs;
}

type ShareRow = { tag: string; week: string; hours: number; share: number };

/** Per-tag, per-week share of listening carried by artists holding the tag (weight ≥ tagFloor). Weeks under `weekFloorH` hours are dropped so a stray play can't be a 100 % week. */
export async function tagWeekShares(tagFloor = THREAD_DEFAULTS.tagFloor, weekFloorH = 0.5): Promise<ShareRow[]> {
  return (await query(`
    WITH w AS (SELECT DATE_TRUNC('week', played_at)::DATE AS wk, artist_id, SUM(ms_played)/3600000.0 AS h
               FROM plays_resolved WHERE artist_id IS NOT NULL ${playsWhere()} GROUP BY 1, 2),
    tot AS (SELECT wk, SUM(h) AS th FROM w GROUP BY 1 HAVING SUM(h) >= ${Number(weekFloorH)}),
    tags AS (SELECT artist_id, tag FROM artist_tags WHERE weight >= ${Number(tagFloor)} GROUP BY 1, 2),
    tw AS (SELECT t.tag, w.wk, SUM(w.h) AS h FROM w JOIN tags t USING (artist_id) GROUP BY 1, 2)
    SELECT tw.tag, CAST(tw.wk AS VARCHAR) AS wk, ROUND(tw.h, 2) AS h, tw.h / tot.th AS share
    FROM tw JOIN tot USING (wk) ORDER BY tw.tag, tw.wk`)).map((r) => ({ tag: String(r.tag), week: String(r.wk).slice(0, 10), hours: num(r.h), share: num(r.share) }));
}

/** Top artists carrying `tag` inside a span — the names on a thread's card. */
async function threadArtists(tag: string, from: string, toExclusive: string, tagFloor: number, n = 3) {
  return (await query(`
    SELECT p.artist_id, arg_max(p.artist_name, p.ms_played) AS name, ROUND(SUM(p.ms_played)/3600000.0, 1) AS h
    FROM plays_resolved p JOIN (SELECT artist_id FROM artist_tags WHERE tag = $1 AND weight >= ${Number(tagFloor)} GROUP BY 1) t USING (artist_id)
    WHERE p.played_at >= CAST($2 AS DATE) AND p.played_at < CAST($3 AS DATE) ${playsWhere('p')}
    GROUP BY 1 ORDER BY h DESC LIMIT ${n}`, [tag, from, toExclusive])).map((r) => ({ artistId: String(r.artist_id), artist: String(r.name), hours: num(r.h) }));
}

/**
 * Threads across the whole record, strongest first (by hours inside the run). Capped at `maxThreads`
 * so the chart stays legible; the same tag can produce several threads if it rose, fell and rose again.
 */
export async function genreThreads(params?: Partial<ThreadParams>): Promise<GenreThread[]> {
  const p = { ...threadDefaults(), ...(params ?? {}) };
  const rows = await tagWeekShares(p.tagFloor);
  const byTag = new Map<string, ThreadWeek[]>();
  for (const r of rows) { const arr = byTag.get(r.tag) ?? []; arr.push({ week: r.week, hours: r.hours, share: r.share }); byTag.set(r.tag, arr); }
  const thisWeek = isoMonday(localToday());
  const candidates: Omit<GenreThread, 'topArtists'>[] = [];
  for (const [tag, weeks] of byTag) {
    for (const run of findRuns(weeks, p.shareFloor, p.minWeeks)) {
      const start = run[0].week, end = run[run.length - 1].week;
      const hours = run.reduce((s, w) => s + w.hours, 0);
      candidates.push({ tag, start, end, endExclusive: addDays(end, 7), weeks: run.length, hours, peakShare: Math.max(...run.map((w) => w.share)), meanShare: run.reduce((s, w) => s + w.share, 0) / run.length, inProgress: end === thisWeek, series: run });
    }
  }
  candidates.sort((a, b) => b.hours - a.hours);
  const picked = candidates.slice(0, Math.max(1, p.maxThreads));
  const out: GenreThread[] = [];
  for (const c of picked) out.push({ ...c, topArtists: await threadArtists(c.tag, c.start, c.endExclusive, p.tagFloor) });
  return out.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.hours - a.hours));
}

/** Tracks inside a thread span by artists carrying the tag — the "export thread as playlist" hook. */
export async function threadTracks(tag: string, from: string, toExclusive: string, n = 30, tagFloor = THREAD_DEFAULTS.tagFloor) {
  return (await query(`
    SELECT p.track_id AS "trackId", p.track_name AS track, p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays,
           ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"
    FROM plays_resolved p JOIN (SELECT artist_id FROM artist_tags WHERE tag = $1 AND weight >= ${Number(tagFloor)} GROUP BY 1) t USING (artist_id)
    WHERE p.track_id IS NOT NULL AND p.played_at >= CAST($2 AS DATE) AND p.played_at < CAST($3 AS DATE) ${playsWhere('p')}
    GROUP BY 1, 2, 3, 4 ORDER BY SUM(p.ms_played) DESC LIMIT ${n}`, [tag, from, toExclusive])).map((r) => ({
    trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate),
  }));
}

export function addDays(iso: string, n: number) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** ISO Monday on or before `iso` (matches DuckDB's DATE_TRUNC('week')). */
export function isoMonday(iso: string) { const d = new Date(iso + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); }
