/**
 * Phase 9k — listening × weather (history from weather_daily, filled by syncWeather). Every figure compares days of
 * one kind of weather with all days that have weather, so "+30 %" means "30 % more than on an average day".
 * Days count whether or not you listened (a silent rainy day lowers rainy-day minutes), which keeps it honest.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { bucketInfo, type Bucket } from './weather';

export type WeatherMood = {
  bucket: Bucket; label: string; glyph: string; days: number; minutesPerDay: number; vsAverage: number; skipRate: number | null;
  bpm: number | null; energy: number | null; minor: number | null;
  scenes: { scene: string; label: string; lift: number; share: number }[]; artists: { artistId: string; artist: string; lift: number; hours: number }[];
};
export type WeatherSummary = { place: string | null; days: number; observedFrom: string | null; observedTo: string | null; moods: WeatherMood[]; temps: { band: string; lo: number; days: number; minutesPerDay: number; energy: number | null }[] };

export async function weatherSummary(): Promise<WeatherSummary> {
  const P = playsWhere('p');
  const [cov] = await query(`SELECT COUNT(*) AS n, CAST(MIN(date) AS VARCHAR) AS f, CAST(MAX(date) AS VARCHAR) AS l FROM weather_daily WHERE kind = 'observed'`);
  const [pl] = await query(`SELECT value FROM app_meta WHERE key = 'weather_place'`);
  const empty: WeatherSummary = { place: str(pl?.value), days: num(cov?.n), observedFrom: str(cov?.f), observedTo: str(cov?.l), moods: [], temps: [] };
  if (!num(cov?.n)) return empty;
  const daily = `
    wd AS (SELECT date, bucket, (tmax + tmin) / 2 AS tmean FROM weather_daily WHERE kind = 'observed' AND bucket IS NOT NULL
           AND date BETWEEN (SELECT CAST(MIN(played_at) AS DATE) FROM plays_resolved) AND (SELECT CAST(MAX(played_at) AS DATE) FROM plays_resolved)),
    pd AS (SELECT CAST(p.played_at AS DATE) AS date, SUM(p.ms_played)/60000.0 AS mins, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p WHERE p.attended ${P} GROUP BY 1),
    j AS (SELECT wd.*, COALESCE(pd.mins, 0) AS mins, pd.sr FROM wd LEFT JOIN pd USING (date))`;
  const rows = await query(`WITH ${daily}, avg AS (SELECT AVG(mins) AS m FROM j)
    SELECT bucket, COUNT(*) AS days, AVG(mins) AS mpd, AVG(mins) / NULLIF((SELECT m FROM avg), 0) - 1 AS vs, AVG(sr) AS sr FROM j GROUP BY 1 ORDER BY days DESC`);
  const snd = await query(`WITH wd AS (SELECT date, bucket FROM weather_daily WHERE kind = 'observed')
    SELECT wd.bucket, AVG(f.bpm) AS bpm, AVG(f.energy) AS e, AVG(CASE WHEN f.mode = 0 THEN 1.0 ELSE 0 END) FILTER (WHERE f.mode IS NOT NULL) AS minor
    FROM plays_resolved p JOIN wd ON wd.date = CAST(p.played_at AS DATE) JOIN track_features f ON f.track_id = p.track_id AND f.found WHERE p.attended ${P} GROUP BY 1`);
  const labels: Record<string, string> = {}; for (const r of await query(`SELECT scene, label FROM scene_families`)) labels[String(r.scene)] = String(r.label);
  // scene / artist lift per bucket: share of that weather's hours vs share of all weather-covered hours
  const sc = await query(`WITH wd AS (SELECT date, bucket FROM weather_daily WHERE kind = 'observed' AND bucket IS NOT NULL),
      s AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
      x AS (SELECT wd.bucket, s.scene, SUM(p.ms_played) AS ms FROM plays_resolved p JOIN wd ON wd.date = CAST(p.played_at AS DATE) JOIN s USING (artist_id) WHERE p.attended ${P} GROUP BY 1, 2),
      tb AS (SELECT bucket, SUM(ms) AS t FROM x GROUP BY 1), ts AS (SELECT scene, SUM(ms) AS t FROM x GROUP BY 1), tt AS (SELECT SUM(ms) AS t FROM x)
    SELECT x.bucket, x.scene, x.ms * 1.0 / tb.t AS share, (x.ms * 1.0 / tb.t) / (ts.t * 1.0 / (SELECT t FROM tt)) AS lift
    FROM x JOIN tb USING (bucket) JOIN ts USING (scene) WHERE x.ms >= 3600000 QUALIFY ROW_NUMBER() OVER (PARTITION BY x.bucket ORDER BY lift DESC) <= 3`);
  const ar = await query(`WITH wd AS (SELECT date, bucket FROM weather_daily WHERE kind = 'observed' AND bucket IS NOT NULL),
      x AS (SELECT wd.bucket, p.artist_id, arg_max(p.artist_name, p.ms_played) AS a, SUM(p.ms_played) AS ms FROM plays_resolved p JOIN wd ON wd.date = CAST(p.played_at AS DATE) WHERE p.attended AND p.artist_id IS NOT NULL ${P} GROUP BY 1, 2),
      tb AS (SELECT bucket, SUM(ms) AS t FROM x GROUP BY 1), ta AS (SELECT artist_id, SUM(ms) AS t FROM x GROUP BY 1), tt AS (SELECT SUM(ms) AS t FROM x)
    SELECT x.bucket, x.artist_id, x.a, x.ms / 3600000.0 AS h, (x.ms * 1.0 / tb.t) / (ta.t * 1.0 / (SELECT t FROM tt)) AS lift
    FROM x JOIN tb USING (bucket) JOIN ta USING (artist_id) WHERE x.ms >= 1800000 AND ta.t >= 7200000 QUALIFY ROW_NUMBER() OVER (PARTITION BY x.bucket ORDER BY lift DESC) <= 4`);
  const moods: WeatherMood[] = rows.map((r) => {
    const b = String(r.bucket) as Bucket; const info = bucketInfo(b); const f = snd.find((x) => x.bucket === b);
    return { bucket: b, label: info?.label ?? b, glyph: info?.glyph ?? '·', days: num(r.days), minutesPerDay: num(r.mpd), vsAverage: num(r.vs), skipRate: r.sr == null ? null : num(r.sr),
      bpm: f?.bpm == null ? null : num(f.bpm), energy: f?.e == null ? null : num(f.e), minor: f?.minor == null ? null : num(f.minor),
      scenes: sc.filter((x) => x.bucket === b).map((x) => ({ scene: String(x.scene), label: labels[String(x.scene)] ?? String(x.scene), lift: num(x.lift), share: num(x.share) })),
      artists: ar.filter((x) => x.bucket === b).map((x) => ({ artistId: String(x.artist_id), artist: String(x.a), lift: num(x.lift), hours: num(x.h) })) };
  });
  const temps = (await query(`WITH ${daily}, e AS (SELECT CAST(p.played_at AS DATE) AS date, AVG(f.energy) AS e FROM plays_resolved p JOIN track_features f ON f.track_id = p.track_id AND f.found WHERE p.attended ${P} GROUP BY 1)
    SELECT CAST(FLOOR(tmean / 5) * 5 AS INTEGER) AS lo, COUNT(*) AS days, AVG(mins) AS mpd, AVG(e.e) AS e FROM j LEFT JOIN e USING (date) WHERE tmean IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 5 ORDER BY 1`))
    .map((r) => ({ band: `${num(r.lo)}–${num(r.lo) + 5} °C`, lo: num(r.lo), days: num(r.days), minutesPerDay: num(r.mpd), energy: r.e == null ? null : num(r.e) }));
  return { ...empty, moods, temps };
}

export type WeatherOutlook = { date: string; bucket: Bucket | null; glyph: string | null; label: string | null; tmax: number | null; tmin: number | null; precip: number | null; kind: string; minutesFactor: number };
/** Next 7 days of weather with the listening multiplier for that kind of day (1 = no effect), for the forecast. */
export async function weatherOutlook(from: string): Promise<Map<string, WeatherOutlook>> {
  const s = await weatherSummary();
  const factor = new Map(s.moods.filter((m) => m.days >= 10).map((m) => [m.bucket, 1 + Math.max(-0.5, Math.min(0.8, m.vsAverage))]));
  const rows = await query(`SELECT CAST(date AS VARCHAR) AS d, bucket, tmax, tmin, precip_mm, kind FROM weather_daily WHERE date >= CAST($1 AS DATE) AND date < CAST($1 AS DATE) + INTERVAL 7 DAY`, [from]);
  return new Map(rows.map((r) => { const b = str(r.bucket) as Bucket | null; const info = bucketInfo(b); const d = String(r.d).slice(0, 10);
    return [d, { date: d, bucket: b, glyph: info?.glyph ?? null, label: info?.label ?? null, tmax: r.tmax == null ? null : num(r.tmax), tmin: r.tmin == null ? null : num(r.tmin), precip: r.precip_mm == null ? null : num(r.precip_mm), kind: String(r.kind), minutesFactor: (b && factor.get(b)) ?? 1 }]; }));
}

/** Phase 9m — the weather an era (or any date range) was listened in: the bucket that over-indexes most vs your whole record. */
export async function rangeWeather(from: string, toExclusive: string): Promise<{ bucket: Bucket; label: string; glyph: string; share: number; baseShare: number; lift: number } | null> {
  const rows = await query(`
    WITH wd AS (SELECT date, bucket FROM weather_daily WHERE kind = 'observed' AND bucket IS NOT NULL),
         p AS (SELECT CAST(played_at AS DATE) AS date, played_at, ms_played FROM plays_resolved WHERE attended),
         a AS (SELECT wd.bucket, SUM(p.ms_played) FILTER (WHERE p.played_at >= CAST($1 AS DATE) AND p.played_at < CAST($2 AS DATE)) AS era, SUM(p.ms_played) AS allh
               FROM p JOIN wd USING (date) GROUP BY 1)
    SELECT bucket, era * 1.0 / NULLIF((SELECT SUM(era) FROM a), 0) AS share, allh * 1.0 / NULLIF((SELECT SUM(allh) FROM a), 0) AS base FROM a`, [from, toExclusive]);
  const best = rows.map((r) => ({ bucket: String(r.bucket) as Bucket, share: num(r.share), base: num(r.base) })).filter((r) => r.share >= 0.08 && r.base > 0)
    .map((r) => ({ ...r, lift: r.share / r.base })).sort((a, b) => b.lift - a.lift)[0];
  if (!best || best.lift < 1.15) return null;
  const info = bucketInfo(best.bucket);
  return { bucket: best.bucket, label: info?.label ?? best.bucket, glyph: info?.glyph ?? '·', share: best.share, baseShare: best.base, lift: best.lift };
}
