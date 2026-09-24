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

// ============================================================================ Phase 9j — using the features
export type SoundAlike = { trackId: string; track: string; artistId: string | null; artist: string; plays: number; bpm: number | null; key: string | null; camelot: string | null; energy: number | null; distance: number; sameArtist: boolean };
/**
 * "Sounds like this": your own tracks nearest in tempo (half/double time folded), energy, loudness and key (Camelot
 * neighbours count as close). Other artists first — the same artist's songs are shown after, marked.
 */
export async function soundAlike(trackId: string, n = 12): Promise<{ seed: { bpm: number | null; key: string | null; camelot: string | null; energy: number | null } | null; tracks: SoundAlike[] }> {
  const [s] = await query(`SELECT f.bpm, f.key_name, f.camelot, f.energy, f.loudness_db, t.artist_id FROM track_features f JOIN tracks t USING (track_id) WHERE f.track_id = $1 AND f.found`, [trackId]);
  if (!s) return { seed: null, tracks: [] };
  const rows = await query(`
    WITH me AS (SELECT track_id, COUNT(*) AS n, arg_max(track_name, ms_played) AS t, arg_max(artist_id, ms_played) AS aid, arg_max(artist_name, ms_played) AS a FROM plays_resolved p WHERE p.attended AND track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1)
    SELECT f.track_id, me.t, me.aid, me.a, me.n, f.bpm, f.key_name, f.camelot, f.energy,
           LEAST(ABS(LN(f.bpm / $2)), ABS(LN(f.bpm / ($2 * 2))) + 0.1, ABS(LN(f.bpm * 2 / $2)) + 0.1) * 6
           + ABS(COALESCE(f.energy, 0.5) - $3) * 4 + ABS(COALESCE(f.loudness_db, -9) - $4) / 6 AS d0
    FROM track_features f JOIN me USING (track_id) WHERE f.found AND f.bpm IS NOT NULL AND f.track_id <> $1
    ORDER BY d0 LIMIT 80`, [trackId, num(s.bpm) || 120, s.energy == null ? 0.5 : num(s.energy), s.loudness_db == null ? -9 : num(s.loudness_db)]);
  const { keyDistance } = await import('./harmonic');
  const tracks = rows.map((r) => ({ trackId: String(r.track_id), track: String(r.t), artistId: str(r.aid), artist: String(r.a ?? ''), plays: num(r.n), bpm: r.bpm == null ? null : num(r.bpm), key: str(r.key_name), camelot: str(r.camelot), energy: r.energy == null ? null : num(r.energy),
    distance: num(r.d0) + keyDistance(str(s.camelot), str(r.camelot)) * 0.6, sameArtist: str(r.aid) === str(s.artist_id) }))
    .sort((a, b) => Number(a.sameArtist) - Number(b.sameArtist) || a.distance - b.distance).slice(0, n);
  return { seed: { bpm: s.bpm == null ? null : num(s.bpm), key: str(s.key_name), camelot: str(s.camelot), energy: s.energy == null ? null : num(s.energy) }, tracks };
}

export type ArtistSound = { tracks: number; bpm: number; energy: number; minorShare: number; loudness: number; you: { bpm: number; energy: number; minorShare: number; loudness: number }; topKey: string | null };
/** One artist's sound (play-weighted over the songs of theirs you play) against your whole record. */
export async function artistSound(artistId: string): Promise<ArtistSound | null> {
  const q = (w: string) => `SELECT COUNT(DISTINCT p.track_id) AS t, AVG(f.bpm) AS bpm, AVG(f.energy) AS e, AVG(CASE WHEN f.mode = 0 THEN 1.0 ELSE 0 END) FILTER (WHERE f.mode IS NOT NULL) AS m, AVG(f.loudness_db) AS l, mode(f.key_name) AS k
    FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found AND p.attended ${w} ${playsWhere('p')}`;
  const [a] = await query(q('AND p.artist_id = $1'), [artistId]); const [y] = await query(q(''));
  if (!a || num(a.t) < 2) return null;
  return { tracks: num(a.t), bpm: num(a.bpm), energy: num(a.e), minorShare: num(a.m), loudness: num(a.l), topKey: str(a.k), you: { bpm: num(y?.bpm), energy: num(y?.e), minorShare: num(y?.m), loudness: num(y?.l) } };
}

/** Features for a list of tracks (for smooth ordering). Tracks without features keep their place at the end. */
export async function flowFeatures(trackIds: string[]): Promise<Map<string, { camelot: string | null; bpm: number | null; energy: number | null }>> {
  if (!trackIds.length) return new Map();
  // the bridge sends parameters as text, so pass the ids as one comma-joined string (track ids never contain commas)
  const rows = await query(`SELECT track_id, camelot, bpm, energy FROM track_features WHERE found AND list_contains(string_split($1, ','), track_id)`, [trackIds.join(',')]);
  return new Map(rows.map((r) => [String(r.track_id), { camelot: str(r.camelot), bpm: r.bpm == null ? null : num(r.bpm), energy: r.energy == null ? null : num(r.energy) }]));
}

// ============================================================================ Phase 9k — tempo dial, session arcs, mixing
export const TEMPO_BANDS: { id: string; label: string; lo: number; hi: number; blurb: string }[] = [
  { id: 'slow', label: 'Slow burn', lo: 0, hi: 90, blurb: 'under 90 bpm — ballads, ambient, late nights' },
  { id: 'walk', label: 'Walking pace', lo: 90, hi: 110, blurb: '90–110 — strolling, cooking, head-nod' },
  { id: 'groove', label: 'Groove', lo: 110, hi: 125, blurb: '110–125 — house, disco, a steady run' },
  { id: 'drive', label: 'Drive', lo: 125, hi: 140, blurb: '125–140 — cycling, driving, getting things done' },
  { id: 'sprint', label: 'Sprint', lo: 140, hi: 400, blurb: '140+ — running, drum & bass, punk' },
];
export type TempoStation = { id: string; label: string; blurb: string; tracks: { trackId: string; track: string; artistId: string | null; artist: string; plays: number; bpm: number; energy: number | null }[]; total: number };
/** Your most-played, rarely skipped tracks per tempo band, optionally filtered to high or low energy. */
export async function tempoStations(energy: 'any' | 'high' | 'low' = 'any', perBand = 25): Promise<TempoStation[]> {
  const ef = energy === 'high' ? 'AND f.energy >= 0.6' : energy === 'low' ? 'AND f.energy <= 0.4' : '';
  const rows = await query(`
    WITH me AS (SELECT track_id, COUNT(*) AS n, arg_max(track_name, ms_played) AS t, arg_max(artist_id, ms_played) AS aid, arg_max(artist_name, ms_played) AS a, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr
                FROM plays_resolved p WHERE p.attended AND track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1)
    SELECT f.track_id, me.t, me.aid, me.a, me.n, f.bpm, f.energy FROM track_features f JOIN me USING (track_id) WHERE f.found AND f.bpm IS NOT NULL AND me.sr < 0.4 ${ef} ORDER BY me.n DESC`);
  return TEMPO_BANDS.map((b) => {
    const inBand = rows.filter((r) => num(r.bpm) >= b.lo && num(r.bpm) < b.hi);
    return { ...b, total: inBand.length, tracks: inBand.slice(0, perBand).map((r) => ({ trackId: String(r.track_id), track: String(r.t), artistId: str(r.aid), artist: String(r.a ?? ''), plays: num(r.n), bpm: num(r.bpm), energy: r.energy == null ? null : num(r.energy) })) };
  });
}

export type ArcPoint = { i: number; track: string; artist: string; bpm: number | null; energy: number | null; skipped: boolean; at: string };
/** The energy and tempo of each play in one session, in order — the session's shape as sound. */
export async function sessionArc(sessionId: string): Promise<ArcPoint[]> {
  return (await query(`
    SELECT p.track_name, p.artist_name, f.bpm, f.energy, p.was_skipped, CAST(p.played_at AS VARCHAR) AS at
    FROM play_sessions ps JOIN plays_resolved p USING (play_id) LEFT JOIN track_features f ON f.track_id = p.track_id AND f.found
    WHERE CAST(ps.session_id AS VARCHAR) = $1 ORDER BY p.played_at`, [sessionId])).map((r, i) => ({ i, track: String(r.track_name ?? ''), artist: String(r.artist_name ?? ''), bpm: r.bpm == null ? null : num(r.bpm), energy: r.energy == null ? null : num(r.energy), skipped: Boolean(r.was_skipped), at: String(r.at) }));
}

/** Songs from your record that mix well *after* this one: a compatible key (Camelot distance ≤ 1) and tempo within ±6 % (or half/double time). */
export async function mixInto(trackId: string, n = 10) {
  const [s] = await query(`SELECT f.bpm, f.camelot, f.energy FROM track_features f WHERE f.track_id = $1 AND f.found AND f.bpm IS NOT NULL`, [trackId]);
  if (!s) return null;
  const bpm = num(s.bpm);
  const rows = await query(`
    WITH me AS (SELECT track_id, COUNT(*) AS n, arg_max(track_name, ms_played) AS t, arg_max(artist_id, ms_played) AS aid, arg_max(artist_name, ms_played) AS a, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p WHERE p.attended AND track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1)
    SELECT f.track_id, me.t, me.aid, me.a, me.n, f.bpm, f.camelot, f.energy FROM track_features f JOIN me USING (track_id)
    WHERE f.found AND f.track_id <> $1 AND f.camelot IS NOT NULL AND me.sr < 0.5
      AND (ABS(f.bpm / $2 - 1) <= 0.06 OR ABS(f.bpm / ($2 * 2) - 1) <= 0.06 OR ABS(f.bpm * 2 / $2 - 1) <= 0.06)
    ORDER BY me.n DESC LIMIT 200`, [trackId, bpm]);
  const { keyDistance } = await import('./harmonic');
  const out = rows.map((r) => ({ trackId: String(r.track_id), track: String(r.t), artistId: str(r.aid), artist: String(r.a ?? ''), plays: num(r.n), bpm: num(r.bpm), camelot: str(r.camelot), energy: r.energy == null ? null : num(r.energy), keyStep: keyDistance(str(s.camelot), str(r.camelot)) }))
    .filter((t) => t.keyStep <= 1).sort((a, b) => a.keyStep - b.keyStep || b.plays - a.plays).slice(0, n);
  return { bpm, camelot: str(s.camelot), tracks: out };
}
