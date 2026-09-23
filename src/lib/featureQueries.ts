/**
 * Phase 9g — audio features (FreqBlog) read against your plays. bpm / key / energy / loudness are the reliable
 * fields; valence, mood and danceability are perceptual estimates the UI labels "directional". Everything is
 * play-weighted under the lens, so it describes what you listened to, not what sits in the library.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';

export type FeatureCoverage = { featured: number; played: number; missed: number; share: number };
export async function featureCoverage(): Promise<FeatureCoverage> {
  const [r] = await query(`
    WITH pt AS (SELECT DISTINCT track_id FROM plays_resolved p WHERE track_id IS NOT NULL ${playsWhere('p')})
    SELECT COUNT(*) AS played, COUNT(*) FILTER (WHERE f.found) AS featured, COUNT(*) FILTER (WHERE f.track_id IS NOT NULL AND NOT f.found) AS missed FROM pt LEFT JOIN track_features f USING (track_id)`);
  const played = num(r?.played), featured = num(r?.featured);
  return { featured, played, missed: num(r?.missed), share: played ? featured / played : 0 };
}

export type YearFeature = { year: number; bpm: number; energy: number; loudness: number; minorShare: number; acoustic: number; tracks: number };
/** Play-weighted tempo, energy, loudness, minor-key share and acousticness by year. */
export async function featuresByYear(): Promise<YearFeature[]> {
  return (await query(`
    SELECT EXTRACT(year FROM p.played_at)::INT AS y, AVG(f.bpm) AS bpm, AVG(f.energy) AS energy, AVG(f.loudness_db) AS loud, AVG(CASE WHEN f.mode = 0 THEN 1.0 ELSE 0 END) FILTER (WHERE f.mode IS NOT NULL) AS minor, AVG(f.acousticness) AS ac, COUNT(DISTINCT p.track_id) AS n
    FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found ${playsWhere('p')} GROUP BY 1 HAVING COUNT(*) >= 30 ORDER BY 1`))
    .map((r) => ({ year: num(r.y), bpm: num(r.bpm), energy: num(r.energy), loudness: num(r.loud), minorShare: num(r.minor), acoustic: num(r.ac), tracks: num(r.n) }));
}

export type HourFeature = { hour: number; energy: number; bpm: number; plays: number };
export async function energyByHour(): Promise<HourFeature[]> {
  return (await query(`SELECT EXTRACT(hour FROM p.played_at)::INT AS h, AVG(f.energy) AS e, AVG(f.bpm) AS bpm, COUNT(*) AS n FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found ${playsWhere('p')} GROUP BY 1 ORDER BY 1`))
    .map((r) => ({ hour: num(r.h), energy: num(r.e), bpm: num(r.bpm), plays: num(r.n) }));
}

export type SeasonKey = { season: string; minorShare: number; bpm: number; energy: number; plays: number };
/** "Minor keys in winter": mode and tempo by season (Dec–Feb winter, etc.; northern hemisphere naming). */
export async function keysBySeason(): Promise<SeasonKey[]> {
  return (await query(`
    SELECT CASE WHEN EXTRACT(month FROM p.played_at) IN (12, 1, 2) THEN 'winter' WHEN EXTRACT(month FROM p.played_at) IN (3, 4, 5) THEN 'spring' WHEN EXTRACT(month FROM p.played_at) IN (6, 7, 8) THEN 'summer' ELSE 'autumn' END AS s,
           AVG(CASE WHEN f.mode = 0 THEN 1.0 ELSE 0 END) FILTER (WHERE f.mode IS NOT NULL) AS minor, AVG(f.bpm) AS bpm, AVG(f.energy) AS e, COUNT(*) AS n
    FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found ${playsWhere('p')} GROUP BY 1`))
    .map((r) => ({ season: String(r.s), minorShare: num(r.minor), bpm: num(r.bpm), energy: num(r.e), plays: num(r.n) }))
    .sort((a, b) => ['winter', 'spring', 'summer', 'autumn'].indexOf(a.season) - ['winter', 'spring', 'summer', 'autumn'].indexOf(b.season));
}

export type KeyCell = { key: string; camelot: string | null; plays: number; tracks: number; share: number };
/** The 24-cell key × mode wheel, play-weighted. */
export async function keyWheel(): Promise<KeyCell[]> {
  const rows = await query(`SELECT f.key_name AS k, arg_max(f.camelot, 1) AS cam, COUNT(*) AS n, COUNT(DISTINCT p.track_id) AS t FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found AND f.key_name IS NOT NULL ${playsWhere('p')} GROUP BY 1 ORDER BY n DESC`);
  const total = rows.reduce((a, r) => a + num(r.n), 0) || 1;
  return rows.map((r) => ({ key: String(r.k), camelot: str(r.cam), plays: num(r.n), tracks: num(r.t), share: num(r.n) / total }));
}

export type Adventurousness = { score: number; binsUsed: number; binsTotal: number; entropyBits: number; byYear: { year: number; score: number }[] };
/**
 * How widely you roam across tempo × key bins (12 bpm-wide bins from 60 to 180 × 24 keys = 240 cells). Score = normalised
 * entropy of the play distribution over cells (1 = spread evenly everywhere, 0 = one cell). Per year too, so the line moves.
 */
export async function adventurousness(): Promise<Adventurousness> {
  const cells = await query(`
    SELECT EXTRACT(year FROM p.played_at)::INT AS y, LEAST(9, GREATEST(0, FLOOR((f.bpm - 60) / 12)))::INT AS tb, f.key_name AS k, COUNT(*) AS n
    FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found AND f.bpm IS NOT NULL AND f.key_name IS NOT NULL ${playsWhere('p')} GROUP BY 1, 2, 3`);
  const H = (rows: { n: number }[]) => { const t = rows.reduce((a, r) => a + r.n, 0); if (!t) return 0; return -rows.reduce((a, r) => { const p = r.n / t; return a + p * Math.log2(p); }, 0); };
  const all = new Map<string, number>(); const years = new Map<number, Map<string, number>>();
  for (const r of cells) { const c = `${num(r.tb)}|${r.k}`; all.set(c, (all.get(c) ?? 0) + num(r.n)); const y = num(r.y); if (!years.has(y)) years.set(y, new Map()); years.get(y)!.set(c, (years.get(y)!.get(c) ?? 0) + num(r.n)); }
  const total = 240, maxBits = Math.log2(total);
  const bits = H([...all.values()].map((n) => ({ n })));
  return { score: maxBits ? bits / maxBits : 0, binsUsed: all.size, binsTotal: total, entropyBits: bits, byYear: [...years.entries()].sort((a, b) => a[0] - b[0]).map(([year, m]) => ({ year, score: H([...m.values()].map((n) => ({ n }))) / maxBits })) };
}

export type FeatureTrack = { trackId: string; track: string; artistId: string | null; artist: string; plays: number; bpm: number | null; key: string | null; energy: number | null };
/** Extremes: fastest / slowest / most energetic / quietest among tracks you've played ≥ minPlays times. */
export async function featureExtremes(minPlays = 3): Promise<{ fastest: FeatureTrack[]; slowest: FeatureTrack[]; loudest: FeatureTrack[]; quietest: FeatureTrack[] }> {
  const pick = async (order: string) => (await query(`
    SELECT p.track_id, arg_max(p.track_name, p.ms_played) AS track, arg_max(p.artist_id, p.ms_played) AS aid, arg_max(p.artist_name, p.ms_played) AS artist, COUNT(*) AS n, MAX(f.bpm) AS bpm, MAX(f.key_name) AS k, MAX(f.energy) AS e, MAX(f.loudness_db) AS l
    FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found ${playsWhere('p')} GROUP BY 1 HAVING COUNT(*) >= ${Math.round(minPlays)} AND ${order.includes('bpm') ? 'MAX(f.bpm) IS NOT NULL' : order.includes('loudness') ? 'MAX(f.loudness_db) IS NOT NULL' : 'MAX(f.energy) IS NOT NULL'} ORDER BY ${order} LIMIT 5`))
    .map((r) => ({ trackId: String(r.track_id), track: String(r.track), artistId: str(r.aid), artist: String(r.artist ?? ''), plays: num(r.n), bpm: r.bpm == null ? null : num(r.bpm), key: str(r.k), energy: r.e == null ? null : num(r.e) }));
  return { fastest: await pick('MAX(f.bpm) DESC'), slowest: await pick('MAX(f.bpm) ASC'), loudest: await pick('MAX(f.loudness_db) DESC'), quietest: await pick('MAX(f.loudness_db) ASC') };
}
