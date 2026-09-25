/**
 * Phase 10 (from the review catalogue, DeepSeek §2.3/§2.4/§2.6) — discovery depth:
 *   bubble score · blind spots · anti-recommendations · activity inference · duration preference.
 * Everything is derived from your own record plus Last.fm's similar-artist links (artist_relations 'similar').
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';

// ---------------------------------------------------------------- bubble score
export type BubbleYear = { year: number; score: number; effectiveArtists: number; families: number; hours: number };
/**
 * How wide your listening is, per year: normalised entropy of hours across scene families (0 = one family, 100 = spread
 * evenly across all you've ever touched), plus "effective artists" = 2^(artist entropy) — the number of artists that
 * would give the same spread if you listened to each equally.
 */
export async function bubbleScores(): Promise<BubbleYear[]> {
  const P = playsWhere('p');
  const fam = await query(`WITH sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
      x AS (SELECT EXTRACT(year FROM p.played_at)::INT AS y, sc.scene, SUM(p.ms_played) AS ms FROM plays_resolved p JOIN sc USING (artist_id) WHERE p.attended ${P} GROUP BY 1, 2),
      t AS (SELECT y, SUM(ms) AS tot, COUNT(*) AS k FROM x GROUP BY 1)
    SELECT x.y, -SUM((x.ms * 1.0 / t.tot) * LOG2(x.ms * 1.0 / t.tot)) AS h, MAX(t.k) AS k, MAX(t.tot) / 3600000.0 AS hours FROM x JOIN t USING (y) GROUP BY 1 HAVING MAX(t.tot) > 36000000 ORDER BY 1`);
  const [all] = await query(`SELECT COUNT(DISTINCT scene) AS n FROM artist_scene`);
  const art = await query(`WITH x AS (SELECT EXTRACT(year FROM p.played_at)::INT AS y, p.artist_id, SUM(p.ms_played) AS ms FROM plays_resolved p WHERE p.attended AND p.artist_id IS NOT NULL ${P} GROUP BY 1, 2), t AS (SELECT y, SUM(ms) AS tot FROM x GROUP BY 1)
    SELECT x.y, -SUM((x.ms * 1.0 / t.tot) * LOG2(x.ms * 1.0 / t.tot)) AS h FROM x JOIN t USING (y) GROUP BY 1`);
  const maxBits = Math.log2(Math.max(2, num(all?.n)));
  return fam.map((r) => ({ year: num(r.y), score: Math.round((num(r.h) / maxBits) * 100), families: num(r.k), hours: num(r.hours), effectiveArtists: Math.round(2 ** num(art.find((a) => num(a.y) === num(r.y))?.h)) }));
}

// ---------------------------------------------------------------- blind spots
export type BlindSpots = {
  neverPlayed: { name: string; pointers: number; via: string[] }[];     // similar-artist links from your favourites you've never followed
  doorstep: { scene: string; label: string; touching: number; hoursShare: number; examples: string[] }[];
  regions: { scene: string; label: string }[];                            // region families with no listening at all
  decades: { decade: number; share: number }[];
};
export async function blindSpots(): Promise<BlindSpots> {
  const P = playsWhere('p');
  const neverPlayed = (await query(`
    WITH top AS (SELECT artist_id, arg_max(artist_name, ms_played) AS a FROM plays_resolved p WHERE p.attended AND artist_id IS NOT NULL ${P} GROUP BY 1 ORDER BY SUM(ms_played) DESC LIMIT 150),
         mine AS (SELECT DISTINCT lower(trim(artist_name)) AS k FROM plays_resolved WHERE artist_name IS NOT NULL)
    SELECT r.related_name AS name, COUNT(DISTINCT r.artist_mbid) AS n, list(DISTINCT top.a)[1:3] AS via
    FROM artist_relations r JOIN top ON top.artist_id = r.artist_mbid
    WHERE r.relation_type = 'similar' AND r.related_name IS NOT NULL AND lower(trim(r.related_name)) NOT IN (SELECT k FROM mine)
    GROUP BY 1 HAVING COUNT(DISTINCT r.artist_mbid) >= 2 ORDER BY n DESC, name LIMIT 25`)).map((r) => ({ name: String(r.name), pointers: num(r.n), via: Array.isArray(r.via) ? (r.via as unknown[]).map(String) : [] }));
  const doorstep = (await query(`
    WITH prim AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
         h AS (SELECT p.artist_id, SUM(p.ms_played) AS ms, arg_max(p.artist_name, p.ms_played) AS a FROM plays_resolved p WHERE p.attended AND p.artist_id IS NOT NULL ${P} GROUP BY 1),
         tot AS (SELECT SUM(ms) AS t FROM h),
         touch AS (SELECT m.scene, t.artist_id FROM artist_tags t JOIN scene_tag_map m ON m.tag = lower(t.tag) JOIN scene_families f ON f.scene = m.scene AND NOT f.hidden WHERE t.weight >= 0.2 GROUP BY 1, 2),
         agg AS (SELECT touch.scene, COUNT(DISTINCT touch.artist_id) AS touching, list(DISTINCT h.a ORDER BY h.a)[1:3] AS ex FROM touch JOIN h USING (artist_id) GROUP BY 1),
         mainh AS (SELECT prim.scene, SUM(h.ms) AS ms FROM prim JOIN h USING (artist_id) GROUP BY 1)
    SELECT agg.scene, f.label, agg.touching, COALESCE(mainh.ms, 0) * 1.0 / (SELECT t FROM tot) AS share, agg.ex
    FROM agg JOIN scene_families f USING (scene) LEFT JOIN mainh USING (scene)
    WHERE COALESCE(mainh.ms, 0) * 1.0 / (SELECT t FROM tot) < 0.01 AND agg.touching >= 3 ORDER BY agg.touching DESC LIMIT 10`))
    .map((r) => ({ scene: String(r.scene), label: String(r.label), touching: num(r.touching), hoursShare: num(r.share), examples: Array.isArray(r.ex) ? (r.ex as unknown[]).map(String) : [] }));
  const regions = (await query(`SELECT f.scene, f.label FROM scene_families f WHERE f.kind = 'region' AND NOT f.hidden AND NOT EXISTS (SELECT 1 FROM artist_scene s WHERE s.scene = f.scene) ORDER BY f.label`)).map((r) => ({ scene: String(r.scene), label: String(r.label) }));
  const dec = await query(`SELECT FLOOR(EXTRACT(year FROM COALESCE(al.release_date, t.release_date)) / 10) * 10 AS d, SUM(p.ms_played) AS ms FROM plays_resolved p LEFT JOIN albums al USING (album_id) LEFT JOIN tracks t USING (track_id)
    WHERE p.attended AND COALESCE(al.release_date, t.release_date) IS NOT NULL ${P} GROUP BY 1`);
  const tot = dec.reduce((a, r) => a + num(r.ms), 0) || 1;
  const decades = [1950, 1960, 1970, 1980, 1990, 2000, 2010, 2020].map((d) => ({ decade: d, share: num(dec.find((r) => num(r.d) === d)?.ms) / tot })).filter((x) => x.share < 0.02);
  return { neverPlayed, doorstep, regions, decades: dec.length ? decades : [] };
}

// ---------------------------------------------------------------- anti-recommendations
export type AntiRec = { artistId: string; artist: string; plays: number; skipRate: number; why: string };
/** Artists your own taste says you should like — similar to your favourites, or carrying your core tags — that you keep skipping. */
export async function antiRecommendations(): Promise<{ artists: AntiRec[]; tags: { tag: string; plays: number; skipRate: number; vsYou: number }[] }> {
  const P = playsWhere('p');
  const artists = (await query(`
    WITH me AS (SELECT AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p WHERE 1=1 ${P}),
         top AS (SELECT artist_id, arg_max(artist_name, ms_played) AS a FROM plays_resolved p WHERE p.attended AND artist_id IS NOT NULL ${P} GROUP BY 1 ORDER BY SUM(ms_played) DESC LIMIT 100),
         sim AS (SELECT lower(trim(r.related_name)) AS k, arg_max(top.a, 1) AS via FROM artist_relations r JOIN top ON top.artist_id = r.artist_mbid WHERE r.relation_type = 'similar' GROUP BY 1),
         coretags AS (SELECT lower(t.tag) AS tag FROM artist_tags t JOIN top USING (artist_id) WHERE t.weight >= 0.4 GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 8),
         x AS (SELECT p.artist_id, arg_max(p.artist_name, p.ms_played) AS a, COUNT(*) AS n, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p WHERE p.artist_id IS NOT NULL ${P} GROUP BY 1)
    SELECT x.artist_id, x.a, x.n, x.sr, sim.via, (SELECT string_agg(DISTINCT lower(t.tag), ', ') FROM artist_tags t WHERE t.artist_id = x.artist_id AND lower(t.tag) IN (SELECT tag FROM coretags)) AS tags
    FROM x LEFT JOIN sim ON sim.k = lower(trim(x.a))
    WHERE x.n >= 5 AND x.sr >= GREATEST(0.6, (SELECT sr FROM me) + 0.3) AND x.artist_id NOT IN (SELECT artist_id FROM top)
      AND (sim.via IS NOT NULL OR EXISTS (SELECT 1 FROM artist_tags t WHERE t.artist_id = x.artist_id AND t.weight >= 0.3 AND lower(t.tag) IN (SELECT tag FROM coretags)))
    ORDER BY x.sr DESC, x.n DESC LIMIT 20`)).map((r) => ({ artistId: String(r.artist_id), artist: String(r.a), plays: num(r.n), skipRate: num(r.sr), why: r.via ? `Last.fm says they're like ${String(r.via)}` : `carries your core tags: ${String(r.tags ?? '')}` }));
  const tags = (await query(`
    WITH me AS (SELECT AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p WHERE 1=1 ${P})
    SELECT lower(t.tag) AS tag, COUNT(*) AS n, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p JOIN artist_tags t USING (artist_id)
    WHERE t.weight >= 0.4 ${P} GROUP BY 1 HAVING COUNT(*) >= 50 AND AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) >= (SELECT sr FROM me) * 1.5 + 0.05 ORDER BY sr DESC LIMIT 10`))
    .map((r) => ({ tag: String(r.tag), plays: num(r.n), skipRate: num(r.sr), vsYou: 0 }));
  const [me] = await query(`SELECT AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p WHERE 1=1 ${P}`);
  for (const t of tags) t.vsYou = num(me?.sr) ? t.skipRate / num(me.sr) : 0;
  return { artists, tags };
}

// ---------------------------------------------------------------- activity inference
export type Activity = 'workout' | 'commute' | 'focus' | 'wind-down' | 'party' | 'everyday';
export const ACTIVITY_RULES: Record<Activity, string> = {
  workout: 'mean tempo ≥ 125 bpm and energy ≥ 0.65, 20–120 minutes',
  commute: 'a weekday session starting 6–9:30 or 16–19:30, 15–75 minutes',
  focus: 'a weekday session starting 9–17, an hour or more, skip rate under 15 %, energy ≤ 0.6',
  'wind-down': 'starting 21:00–02:00 with low energy (≤ 0.45) or tempo under 100 bpm',
  party: 'Friday or Saturday 19:00–03:00, energy ≥ 0.6, an hour or more',
  everyday: 'everything else',
};
export type ActivityRow = { activity: Activity; sessions: number; hours: number; share: number; bpm: number | null; energy: number | null; topArtists: string[]; example: string | null };
/** Label each session by when it happened, how long it ran and what it sounded like. Rules are shown in the UI. */
export async function activities(): Promise<{ rows: ActivityRow[]; withFeatures: number; total: number }> {
  const rows = await query(`
    WITH sf AS (SELECT ps.session_id, AVG(f.bpm) AS bpm, AVG(f.energy) AS e, COUNT(f.track_id) AS nf FROM play_sessions ps JOIN plays_resolved p USING (play_id) LEFT JOIN track_features f ON f.track_id = p.track_id AND f.found GROUP BY 1),
         s AS (SELECT s.session_id, s.start_at, EXTRACT(epoch FROM (s.end_at - s.start_at)) / 60 AS mins, s.total_ms, s.skip_rate, EXTRACT(dow FROM s.start_at) AS dow, EXTRACT(hour FROM s.start_at) + EXTRACT(minute FROM s.start_at) / 60.0 AS hr, sf.bpm, sf.e, sf.nf
               FROM sessions s LEFT JOIN sf USING (session_id) WHERE s.total_ms >= 600000),
         lab AS (SELECT *, CASE
             WHEN bpm >= 125 AND e >= 0.65 AND mins BETWEEN 20 AND 120 THEN 'workout'
             WHEN dow IN (5, 6) AND (hr >= 19 OR hr < 3) AND COALESCE(e, 0) >= 0.6 AND mins >= 60 THEN 'party'
             WHEN (hr >= 21 OR hr < 2) AND (e <= 0.45 OR bpm < 100) THEN 'wind-down'
             WHEN dow BETWEEN 1 AND 5 AND ((hr >= 6 AND hr < 9.5) OR (hr >= 16 AND hr < 19.5)) AND mins BETWEEN 15 AND 75 THEN 'commute'
             WHEN dow BETWEEN 1 AND 5 AND hr >= 9 AND hr < 17 AND mins >= 60 AND COALESCE(skip_rate, 0) < 0.15 AND COALESCE(e, 0.5) <= 0.6 THEN 'focus'
             ELSE 'everyday' END AS act FROM s),
         art AS (SELECT lab.act, p.artist_name, SUM(p.ms_played) AS ms FROM lab JOIN play_sessions ps USING (session_id) JOIN plays_resolved p USING (play_id) GROUP BY 1, 2 QUALIFY ROW_NUMBER() OVER (PARTITION BY lab.act ORDER BY SUM(p.ms_played) DESC) <= 4)
    SELECT lab.act, COUNT(*) AS n, SUM(total_ms) / 3600000.0 AS h, AVG(bpm) AS bpm, AVG(e) AS e, (SELECT list(artist_name ORDER BY ms DESC) FROM art WHERE art.act = lab.act) AS top,
           arg_max(CAST(session_id AS VARCHAR), total_ms) AS ex, SUM(CASE WHEN nf > 0 THEN 1 ELSE 0 END) AS withf
    FROM lab GROUP BY 1`);
  const tot = rows.reduce((a, r) => a + num(r.h), 0) || 1;
  const order: Activity[] = ['focus', 'commute', 'workout', 'party', 'wind-down', 'everyday'];
  return {
    rows: rows.map((r) => ({ activity: String(r.act) as Activity, sessions: num(r.n), hours: num(r.h), share: num(r.h) / tot, bpm: r.bpm == null ? null : num(r.bpm), energy: r.e == null ? null : num(r.e), topArtists: Array.isArray(r.top) ? (r.top as unknown[]).map(String) : [], example: str(r.ex) }))
      .sort((a, b) => order.indexOf(a.activity) - order.indexOf(b.activity)),
    withFeatures: rows.reduce((a, r) => a + num(r.withf), 0), total: rows.reduce((a, r) => a + num(r.n), 0),
  };
}

// ---------------------------------------------------------------- duration preference
export type DurationBand = { band: string; lo: number; plays: number; share: number; hoursShare: number; skipRate: number };
/** Track length you gravitate to: plays and hours per length band, skip rate per band, and the median length by year. */
export async function durationPreference(): Promise<{ bands: DurationBand[]; byYear: { year: number; median: number }[]; epics: { trackId: string; track: string; artist: string; minutes: number; plays: number }[] }> {
  const P = playsWhere('p');
  const len = `COALESCE(t.duration_ms, t.duration_ms_est)`;
  const B: [string, number, number][] = [['under 2:30', 0, 150000], ['2:30–4:00', 150000, 240000], ['4:00–6:00', 240000, 360000], ['6:00–9:00', 360000, 540000], ['9 min +', 540000, 1e9]];
  const rows = await query(`SELECT ${B.map(([, lo, hi], i) => `WHEN ${len} >= ${lo} AND ${len} < ${hi} THEN ${i}`).reduce((a, c) => a + ' ' + c, 'CASE')} END AS b, COUNT(*) AS n, SUM(p.ms_played) AS ms, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr
    FROM plays_resolved p JOIN tracks t USING (track_id) WHERE ${len} > 20000 ${P} GROUP BY 1`);
  const tn = rows.reduce((a, r) => a + num(r.n), 0) || 1, tm = rows.reduce((a, r) => a + num(r.ms), 0) || 1;
  const bands = B.map(([band, lo], i) => { const r = rows.find((x) => num(x.b) === i); return { band, lo, plays: num(r?.n), share: num(r?.n) / tn, hoursShare: num(r?.ms) / tm, skipRate: num(r?.sr) }; });
  const byYear = (await query(`SELECT EXTRACT(year FROM p.played_at)::INT AS y, median(${len}) AS m FROM plays_resolved p JOIN tracks t USING (track_id) WHERE p.attended AND ${len} > 20000 ${P} GROUP BY 1 HAVING COUNT(*) > 100 ORDER BY 1`)).map((r) => ({ year: num(r.y), median: num(r.m) / 60000 }));
  const epics = (await query(`SELECT p.track_id, arg_max(p.track_name, p.ms_played) AS tr, arg_max(p.artist_name, p.ms_played) AS a, MAX(${len}) / 60000.0 AS mins, COUNT(*) AS n FROM plays_resolved p JOIN tracks t USING (track_id)
    WHERE p.attended AND ${len} >= 480000 ${P} GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY n DESC LIMIT 8`)).map((r) => ({ trackId: String(r.track_id), track: String(r.tr), artist: String(r.a), minutes: num(r.mins), plays: num(r.n) }));
  return { bands, byYear, epics };
}
