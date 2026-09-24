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
  tag: string; label: string; kind: 'tag' | 'decade' | 'scene'; start: string; end: string; endExclusive: string; weeks: number; hours: number; peakShare: number; meanShare: number;
  topArtists: { artistId: string; artist: string; hours: number }[]; inProgress: boolean; series: ThreadWeek[];
};
export type ThreadParams = { minWeeks: number; shareFloor: number; tagFloor: number; maxThreads: number; maxCoverage: number; decades: boolean; scenes: boolean; perYear: number };
export const THREAD_DEFAULTS: ThreadParams = { minWeeks: 3, shareFloor: 0.08, tagFloor: 0.2, maxThreads: 24, maxCoverage: 0.2, decades: true, scenes: true, perYear: 2 };
/** Phase 9g: scene-family threads carry this prefix in `tag` ('scene:west-african'); `threadLabel` renders them. */
export const SCENE_PREFIX = 'scene:';
export const isSceneThread = (tag: string) => tag.startsWith(SCENE_PREFIX);

/**
 * Phase 9e (owner: "rock could mean many things"): tags too broad to be a thread. Two filters, both applied:
 *   1. this list — umbrella genres, meta-tags and Last.fm noise words;
 *   2. coverage — any tag carried by more than `maxCoverage` (20 %) of YOUR tagged artists is, for you, generic,
 *      whatever it is. On a library that is 60 % indie rock, 'indie rock' says nothing; 'slowcore' does.
 */
export const GENERIC_TAGS = new Set(['rock', 'pop', 'indie', 'alternative', 'alternative rock', 'indie rock', 'indie pop', 'electronic', 'electronica', 'experimental', 'seen live', 'favorites', 'favourites', 'favorite', 'awesome', 'love', 'beautiful', 'chill', 'chillout', 'male vocalists', 'female vocalists', 'female vocalist', 'male vocalist', 'singer-songwriter', 'american', 'british', 'usa', 'uk', 'english', 'canadian', 'australian', 'german', 'french', '00s', '90s', '80s', '70s', '60s', '10s', '2000s', '2010s', '2020s', 'under 2000 listeners', 'all', 'music', 'good', 'cool', 'fun', 'classic', 'soundtrack', 'instrumental', 'live', 'cover', 'covers', 'remix', 'compilation', 'various artists', 'oldies', 'new', 'old']);
/** Defaults with the owner's tag floor applied (Settings → Tuning). */
const threadDefaults = (): ThreadParams => ({ ...THREAD_DEFAULTS, tagFloor: numSetting('tag_floor'), minWeeks: Math.round(numSetting('thread_min_weeks')), shareFloor: numSetting('thread_share_floor'), maxCoverage: numSetting('thread_max_coverage'), scenes: numSetting('thread_scenes') >= 0.5, maxThreads: Math.round(numSetting('thread_max')), perYear: Math.round(numSetting('thread_per_year')) });

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

/**
 * Per-tag, per-week share of listening carried by artists holding the tag (weight ≥ tagFloor). Weeks under
 * `weekFloorH` hours are dropped so a stray play can't be a 100 % week. Generic tags (see GENERIC_TAGS) and tags
 * covering more than `maxCoverage` of your tagged artists are excluded, so threads stay niche.
 */
export async function tagWeekShares(tagFloor = THREAD_DEFAULTS.tagFloor, weekFloorH = 0.5, maxCoverage = THREAD_DEFAULTS.maxCoverage): Promise<ShareRow[]> {
  const generic = [...GENERIC_TAGS].map((t) => `'${t.replace(/'/g, "''")}'`).join(', ');
  return (await query(`
    WITH w AS (SELECT DATE_TRUNC('week', played_at)::DATE AS wk, artist_id, SUM(ms_played)/3600000.0 AS h
               FROM plays_resolved WHERE artist_id IS NOT NULL ${playsWhere()} GROUP BY 1, 2),
    tot AS (SELECT wk, SUM(h) AS th FROM w GROUP BY 1 HAVING SUM(h) >= ${Number(weekFloorH)}),
    tagged AS (SELECT COUNT(DISTINCT artist_id) AS n FROM artist_tags WHERE weight >= ${Number(tagFloor)}),
    cov AS (SELECT tag, COUNT(DISTINCT artist_id) * 1.0 / (SELECT n FROM tagged) AS coverage FROM artist_tags WHERE weight >= ${Number(tagFloor)} GROUP BY 1),
    tags AS (SELECT t.artist_id, t.tag FROM artist_tags t JOIN cov USING (tag)
             WHERE t.weight >= ${Number(tagFloor)} AND lower(t.tag) NOT IN (${generic}) AND cov.coverage <= ${Number(maxCoverage)} GROUP BY 1, 2),
    tw AS (SELECT t.tag, w.wk, SUM(w.h) AS h FROM w JOIN tags t USING (artist_id) GROUP BY 1, 2)
    SELECT tw.tag, CAST(tw.wk AS VARCHAR) AS wk, ROUND(tw.h, 2) AS h, tw.h / tot.th AS share
    FROM tw JOIN tot USING (wk) ORDER BY tw.tag, tw.wk`)).map((r) => ({ tag: String(r.tag), week: String(r.wk).slice(0, 10), hours: num(r.h), share: num(r.share) }));
}

/**
 * Phase 9g: scene families as a third kind of thread (roadmap: "collapse genre threads onto scene families").
 * Share of each week's listening from artists whose strongest family is X. Families are broader than tags, so a
 * scene thread is the "what kind of music ruled these weeks" line; tag threads keep the niche detail underneath.
 * The coverage ceiling does not apply — a family covering half your artists is exactly what an era is made of.
 */
export async function sceneWeekShares(weekFloorH = 0.5): Promise<ShareRow[]> {
  return (await query(`
    WITH w AS (SELECT DATE_TRUNC('week', played_at)::DATE AS wk, artist_id, SUM(ms_played)/3600000.0 AS h
               FROM plays_resolved WHERE artist_id IS NOT NULL ${playsWhere()} GROUP BY 1, 2),
    tot AS (SELECT wk, SUM(h) AS th FROM w GROUP BY 1 HAVING SUM(h) >= ${Number(weekFloorH)}),
    sc AS (SELECT s.artist_id, arg_max(s.scene, s.weight) AS scene FROM artist_scene s JOIN scene_families f USING (scene) WHERE NOT f.hidden GROUP BY 1),
    sw AS (SELECT sc.scene, w.wk, SUM(w.h) AS h FROM w JOIN sc USING (artist_id) GROUP BY 1, 2)
    SELECT '${SCENE_PREFIX}' || sw.scene AS tag, CAST(sw.wk AS VARCHAR) AS wk, ROUND(sw.h, 2) AS h, sw.h / tot.th AS share
    FROM sw JOIN tot USING (wk) ORDER BY 1, 2`)).map((r) => ({ tag: String(r.tag), week: String(r.wk).slice(0, 10), hours: num(r.h), share: num(r.share) }));
}

/** Display label for any thread tag: 'scene:west-african' → 'West African', '1970s' → '1970s', 'slowcore' → 'slowcore'. */
export async function threadLabels(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const r of await query(`SELECT scene, label FROM scene_families`)) out[SCENE_PREFIX + String(r.scene)] = String(r.label ?? r.scene);
  return out;
}

/**
 * Phase 9e: decades as a second kind of thread — the share of each week's listening from tracks RELEASED in a decade
 * (Spotify enrichment's release_date). Tagged '1970s' etc. so they display like genre threads; the current decade is
 * skipped because most listening is recent and it would always be a thread.
 */
export async function decadeWeekShares(weekFloorH = 0.5): Promise<ShareRow[]> {
  return (await query(`
    WITH w AS (SELECT DATE_TRUNC('week', p.played_at)::DATE AS wk, (EXTRACT(year FROM t.release_date)::INT / 10) * 10 AS decade, SUM(p.ms_played)/3600000.0 AS h
               FROM plays_resolved p JOIN tracks t USING (track_id) WHERE t.release_date IS NOT NULL ${playsWhere('p')} GROUP BY 1, 2),
    tot AS (SELECT DATE_TRUNC('week', played_at)::DATE AS wk, SUM(ms_played)/3600000.0 AS th FROM plays_resolved WHERE 1=1 ${playsWhere()} GROUP BY 1 HAVING SUM(ms_played)/3600000.0 >= ${Number(weekFloorH)})
    SELECT CAST(w.decade AS VARCHAR) || 's' AS tag, CAST(w.wk AS VARCHAR) AS wk, ROUND(w.h, 2) AS h, w.h / tot.th AS share
    FROM w JOIN tot USING (wk) WHERE w.decade < (EXTRACT(year FROM CAST($1 AS DATE))::INT / 10) * 10 ORDER BY 1, 2`, [localToday()])).map((r) => ({ tag: String(r.tag), week: String(r.wk).slice(0, 10), hours: num(r.h), share: num(r.share) }));
}

/** Top artists carrying `tag` inside a span — the names on a thread's card. */
export async function threadArtists(tag: string, from: string, toExclusive: string, tagFloor: number, n = 3) {
  if (/^\d{4}s$/.test(tag)) {
    const d = Number(tag.slice(0, 4));
    return (await query(`
      SELECT p.artist_id, arg_max(p.artist_name, p.ms_played) AS name, ROUND(SUM(p.ms_played)/3600000.0, 1) AS h
      FROM plays_resolved p JOIN tracks t USING (track_id)
      WHERE EXTRACT(year FROM t.release_date) >= $1 AND EXTRACT(year FROM t.release_date) < $1 + 10 AND p.played_at >= CAST($2 AS DATE) AND p.played_at < CAST($3 AS DATE) ${playsWhere('p')}
      GROUP BY 1 ORDER BY h DESC LIMIT ${n}`, [d, from, toExclusive])).map((r) => ({ artistId: String(r.artist_id), artist: String(r.name), hours: num(r.h) }));
  }
  const src = isSceneThread(tag) ? `(SELECT artist_id FROM artist_scene s WHERE s.scene = $1 QUALIFY s.weight = MAX(s.weight) OVER (PARTITION BY artist_id))` : `(SELECT artist_id FROM artist_tags WHERE tag = $1 AND weight >= ${Number(tagFloor)} GROUP BY 1)`;
  const key = isSceneThread(tag) ? tag.slice(SCENE_PREFIX.length) : tag;
  return (await query(`
    SELECT p.artist_id, arg_max(p.artist_name, p.ms_played) AS name, ROUND(SUM(p.ms_played)/3600000.0, 1) AS h
    FROM plays_resolved p JOIN ${src} t USING (artist_id)
    WHERE p.played_at >= CAST($2 AS DATE) AND p.played_at < CAST($3 AS DATE) ${playsWhere('p')}
    GROUP BY 1 ORDER BY h DESC LIMIT ${n}`, [key, from, toExclusive])).map((r) => ({ artistId: String(r.artist_id), artist: String(r.name), hours: num(r.h) }));
}

/**
 * Threads across the whole record, strongest first (by hours inside the run). Capped at `maxThreads`
 * so the chart stays legible; the same tag can produce several threads if it rose, fell and rose again.
 */
export async function genreThreads(params?: Partial<ThreadParams>): Promise<GenreThread[]> {
  const p = { ...threadDefaults(), ...(params ?? {}) };
  const rows = [...await tagWeekShares(p.tagFloor, 0.5, p.maxCoverage), ...(p.decades ? await decadeWeekShares() : []), ...(p.scenes ? await sceneWeekShares() : [])];
  const byTag = new Map<string, ThreadWeek[]>();
  for (const r of rows) { const arr = byTag.get(r.tag) ?? []; arr.push({ week: r.week, hours: r.hours, share: r.share }); byTag.set(r.tag, arr); }
  const thisWeek = isoMonday(localToday());
  const labels = p.scenes ? await threadLabels() : {};
  const candidates: Omit<GenreThread, 'topArtists'>[] = [];
  for (const [tag, weeks] of byTag) {
    for (const run of findRuns(weeks, p.shareFloor, p.minWeeks)) {
      const start = run[0].week, end = run[run.length - 1].week;
      const hours = run.reduce((s, w) => s + w.hours, 0);
      candidates.push({ tag, label: labels[tag] ?? tag, kind: isSceneThread(tag) ? 'scene' : /^\d{4}s$/.test(tag) ? 'decade' : 'tag', start, end, endExclusive: addDays(end, 7), weeks: run.length, hours, peakShare: Math.max(...run.map((w) => w.share)), meanShare: run.reduce((s, w) => s + w.share, 0) / run.length, inProgress: end === thisWeek, series: run });
    }
  }
  // Phase 9i: 9h ranked every thread in the record by total hours and kept the top 12, so a thread that started
  // this spring could never outweigh years-long ones (owner: "no new threads since Apr 6"). Now, in order:
  //   1. anything still running or ended in the last 12 weeks (up to a third of the slots);
  //   2. the strongest `perYear` threads that *start* in each calendar year;
  //   3. the rest by hours — with scene-family threads capped at a third so the broad ones can't crowd out tags.
  candidates.sort((a, b) => b.hours - a.hours);
  const cap = Math.max(1, p.maxThreads);
  const recentCut = addDays(thisWeek, -84);
  const chosen = new Set<(typeof candidates)[number]>();
  const sceneCap = Math.max(1, Math.floor(cap / 3));
  const scenesIn = () => [...chosen].filter((c) => c.kind === 'scene').length;
  const take = (c: (typeof candidates)[number]) => { if (chosen.size >= cap || chosen.has(c)) return; if (c.kind === 'scene' && scenesIn() >= sceneCap) return; chosen.add(c); };
  candidates.filter((c) => c.end >= recentCut).slice(0, Math.max(2, Math.floor(cap / 3))).forEach(take);
  const years = [...new Set(candidates.map((c) => c.start.slice(0, 4)))].sort();
  for (const y of years) candidates.filter((c) => c.start.startsWith(y)).slice(0, Math.max(0, p.perYear)).forEach(take);
  candidates.forEach(take);
  const picked = [...chosen].sort((a, b) => b.hours - a.hours);
  const out: GenreThread[] = [];
  for (const c of picked) out.push({ ...c, topArtists: await threadArtists(c.tag, c.start, c.endExclusive, p.tagFloor) });
  return out.sort((a, b) => (a.start < b.start ? 1 : a.start > b.start ? -1 : b.hours - a.hours));
}

/** Tracks inside a thread span by artists carrying the tag — the "export thread as playlist" hook. */
export async function threadTracks(tag: string, from: string, toExclusive: string, n = 30, tagFloor = THREAD_DEFAULTS.tagFloor) {
  if (/^\d{4}s$/.test(tag)) {
    const d = Number(tag.slice(0, 4));
    return (await query(`
      SELECT p.track_id AS "trackId", p.track_name AS track, p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays,
             ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"
      FROM plays_resolved p JOIN tracks t USING (track_id)
      WHERE EXTRACT(year FROM t.release_date) >= $1 AND EXTRACT(year FROM t.release_date) < $1 + 10 AND p.track_id IS NOT NULL AND p.played_at >= CAST($2 AS DATE) AND p.played_at < CAST($3 AS DATE) ${playsWhere('p')}
      GROUP BY 1, 2, 3, 4 ORDER BY SUM(p.ms_played) DESC LIMIT ${n}`, [d, from, toExclusive])).map((r) => ({ trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) }));
  }
  const src = isSceneThread(tag) ? `(SELECT artist_id FROM artist_scene s WHERE s.scene = $1 QUALIFY s.weight = MAX(s.weight) OVER (PARTITION BY artist_id))` : `(SELECT artist_id FROM artist_tags WHERE tag = $1 AND weight >= ${Number(tagFloor)} GROUP BY 1)`;
  const key = isSceneThread(tag) ? tag.slice(SCENE_PREFIX.length) : tag;
  return (await query(`
    SELECT p.track_id AS "trackId", p.track_name AS track, p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays,
           ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"
    FROM plays_resolved p JOIN ${src} t USING (artist_id)
    WHERE p.track_id IS NOT NULL AND p.played_at >= CAST($2 AS DATE) AND p.played_at < CAST($3 AS DATE) ${playsWhere('p')}
    GROUP BY 1, 2, 3, 4 ORDER BY SUM(p.ms_played) DESC LIMIT ${n}`, [key, from, toExclusive])).map((r) => ({
    trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate),
  }));
}

export function addDays(iso: string, n: number) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
/** ISO Monday on or before `iso` (matches DuckDB's DATE_TRUNC('week')). */
export function isoMonday(iso: string) { const d = new Date(iso + 'T00:00:00Z'); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); }
