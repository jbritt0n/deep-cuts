/**
 * Phase 9l — Ask v2: a playlist from a sentence ("rainy late-night songs I've forgotten"). Two steps, both visible:
 *   1. interpret → a Spec (rule-based vocabulary; optionally the local model, whose JSON is validated against the same
 *      vocabulary so it can't invent scenes or tags that don't exist in your record);
 *   2. score your own tracks against the Spec deterministically, keeping the reasons for each pick.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { currentModel, llmStatus, type ChatMsg } from './ask';
import type { Bucket } from './weather';

export type Spec = {
  scenes: string[]; tags: string[]; themes: string[];
  bpm: [number, number] | null; energy: [number, number] | null; mood: 'bright' | 'dark' | null;
  weather: Bucket | null; hours: [number, number] | null; weekend: boolean | null;
  years: [number, number] | null; freshness: 'familiar' | 'forgotten' | 'any'; obscure: boolean; size: number;
};
export const emptySpec = (): Spec => ({ scenes: [], tags: [], themes: [], bpm: null, energy: null, mood: null, weather: null, hours: null, weekend: null, years: null, freshness: 'any', obscure: false, size: 30 });

const WORDS: { re: RegExp; apply: (s: Spec, m: RegExpMatchArray) => void }[] = [
  { re: /\b(rain(y)?|drizzl\w*|storm\w*|grey|gray)\b/, apply: (s, m) => { s.weather = /storm/.test(m[0]) ? 'storm' : 'rain'; } },
  { re: /\b(sunny|sunshine|sun|bright day)\b/, apply: (s) => { s.weather = 'sunny'; } },
  { re: /\b(snow(y)?|winter)\b/, apply: (s, m) => { if (m[0].startsWith('snow')) s.weather = 'snow'; else s.themes.push('winter'); } },
  { re: /\b(fog(gy)?|mist(y)?)\b/, apply: (s) => { s.weather = 'fog'; } },
  { re: /\b(late[- ]night|midnight|night(time)?|after dark|3 ?am)\b/, apply: (s) => { s.hours = [22, 4]; } },
  { re: /\b(morning|sunrise|breakfast|wake up)\b/, apply: (s) => { s.hours = [5, 11]; } },
  { re: /\b(afternoon)\b/, apply: (s) => { s.hours = [12, 16]; } },
  { re: /\b(evening|dinner|sunset)\b/, apply: (s) => { s.hours = [17, 21]; } },
  { re: /\b(weekend|saturday|sunday)\b/, apply: (s) => { s.weekend = true; } },
  { re: /\b(workout|gym|running|run|cardio|sprint)\b/, apply: (s) => { s.bpm = [125, 190]; s.energy = [0.6, 1]; } },
  { re: /\b(dance|party|club|groove|disco)\b/, apply: (s) => { s.bpm = s.bpm ?? [110, 132]; s.energy = [0.55, 1]; } },
  { re: /\b(chill|calm|mellow|relax\w*|slow|quiet|soft|sleep\w*|wind[- ]down)\b/, apply: (s, m) => { s.energy = [0, 0.45]; if (/sleep|slow/.test(m[0])) s.bpm = [0, 95]; } },
  { re: /\b(focus|study|work(ing)?|concentrat\w*)\b/, apply: (s) => { s.energy = [0.2, 0.6]; } },
  { re: /\b(sad|melanchol\w*|heartbr\w*|lonely|bleak|moody|dark|brood\w*)\b/, apply: (s) => { s.mood = 'dark'; } },
  { re: /\b(happy|upbeat|joy\w*|feel[- ]good|bright|sunny mood)\b/, apply: (s) => { s.mood = 'bright'; } },
  { re: /\b(forgotten|haven'?t heard|lost|rediscover\w*|old favou?rites?)\b/, apply: (s) => { s.freshness = 'forgotten'; } },
  { re: /\b(favou?rites?|on repeat|heavy rotation|classics of mine)\b/, apply: (s) => { s.freshness = 'familiar'; } },
  { re: /\b(obscure|deep cuts?|underground|hidden|rare)\b/, apply: (s) => { s.obscure = true; } },
  { re: /\b(19|20)?([0-9])0'?s\b/, apply: (s, m) => { const d = m[1] ? Number(m[1] + m[2] + '0') : (Number(m[2]) >= 3 ? 1900 : 2000) + Number(m[2]) * 10; s.years = [d, d + 9]; } },
  { re: /\b(\d{2,3})\s?bpm\b/, apply: (s, m) => { const b = Number(m[1]); s.bpm = [b - 6, b + 6]; } },
  { re: /\b(\d{1,3})\s?(songs|tracks)\b/, apply: (s, m) => { s.size = Math.max(5, Math.min(150, Number(m[1]))); } },
];
const LYRIC_THEMES = ['rain', 'night', 'winter', 'heartbreak', 'longing', 'romance', 'the city', 'the road', 'home', 'ocean & shore', 'dreams & sleep', 'nostalgia & memory', 'dancing & party', 'hope & light', 'loneliness & isolation', 'fire & smoke', 'space & cosmos', 'money & work', 'faith & the divine', 'family', 'death & mourning', 'defiance & protest'];

/** Rule-based reading of the sentence, using your own scene and tag vocabulary. */
export async function interpret(text: string): Promise<Spec> {
  const s = emptySpec(); const t = ` ${text.toLowerCase()} `;
  for (const w of WORDS) { const m = t.match(w.re); if (m) w.apply(s, m); }
  for (const th of LYRIC_THEMES) { const key = th.split(/[ &]+/)[0]; if (key.length > 3 && new RegExp(`\\b${key}`).test(t) && !s.themes.includes(th)) s.themes.push(th); }
  const scenes = await query(`SELECT scene, lower(label) AS label FROM scene_families WHERE NOT hidden`);
  for (const r of scenes) { const k = String(r.scene).replace(/-/g, ' '), l = String(r.label); if (t.includes(` ${k} `) || t.includes(` ${k}s `) || t.includes(l.split(/ [&/(]/)[0])) s.scenes.push(String(r.scene)); }
  // any word or two-word phrase that is a tag your artists actually carry
  const words = t.trim().split(/[^a-z0-9'’-]+/).filter((w) => w.length >= 3);
  const grams = [...words, ...words.slice(1).map((w, i) => `${words[i]} ${w}`)];
  if (grams.length) {
    const tags = await query(`SELECT DISTINCT lower(tag) AS tag FROM artist_tags WHERE lower(tag) IN (${grams.map((_, i) => `$${i + 1}`).join(', ')})`, grams);
    const stop = new Set(['songs', 'music', 'tracks', 'the', 'and', 'late', 'night', 'rain', 'rainy', 'forgotten', 'favorites', 'sad', 'happy', 'chill', 'dark', 'love', 'summer', 'winter', 'party']);
    const sceneWords = new Set(s.scenes.flatMap((k) => [k, k.replace(/-/g, ' ')]));
    for (const r of tags) { const tg = String(r.tag); if (!stop.has(tg) && !s.tags.includes(tg) && !sceneWords.has(tg)) s.tags.push(tg); }
  }
  return s;
}

/** The local model's reading, validated: unknown scenes/tags/themes are dropped, numbers are clamped. */
export async function interpretWithModel(text: string, fallback: Spec): Promise<{ spec: Spec; model: string }> {
  const st = await llmStatus(); if (!st.reachable || !st.models.length) throw new Error('No local model reachable.');
  const model = currentModel(st.models);
  const scenes = (await query(`SELECT scene FROM scene_families WHERE NOT hidden`)).map((r) => String(r.scene));
  const msgs: ChatMsg[] = [{ role: 'system', content: `Turn a request for a playlist into JSON filters over the listener's own music. Reply with ONLY JSON:
{"scenes": [from this list only: ${scenes.join(', ')}], "tags": [genre tags, lowercase], "themes": [from: ${LYRIC_THEMES.join(', ')}], "bpm": [min,max] or null, "energy": [0..1 min, max] or null,
 "mood": "bright"|"dark"|null, "weather": "sunny"|"cloudy"|"fog"|"rain"|"snow"|"storm"|null, "hours": [startHour,endHour] or null (22,4 = late night), "weekend": true|false|null,
 "years": [from,to] release years or null, "freshness": "familiar"|"forgotten"|"any", "obscure": true|false, "size": number}. Use null / [] when the request doesn't say.` }, { role: 'user', content: text }];
  const raw = await invoke<string>('llm_chat', { model, messages: msgs, jsonMode: true, temperature: 0.1 });
  let j: Partial<Spec> = {}; try { j = JSON.parse(raw.replace(/```json|```/g, '').trim()); } catch { return { spec: fallback, model }; }
  const tagOk = new Set((await query(`SELECT DISTINCT lower(tag) AS t FROM artist_tags`)).map((r) => String(r.t)));
  const rng = (v: unknown, lo: number, hi: number): [number, number] | null => (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number') ? [Math.max(lo, Math.min(hi, v[0])), Math.max(lo, Math.min(hi, v[1]))] : null);
  const spec: Spec = {
    scenes: (Array.isArray(j.scenes) ? j.scenes : []).map(String).filter((x) => scenes.includes(x)),
    tags: (Array.isArray(j.tags) ? j.tags : []).map((x) => String(x).toLowerCase()).filter((x) => tagOk.has(x)).slice(0, 8),
    themes: (Array.isArray(j.themes) ? j.themes : []).map(String).filter((x) => LYRIC_THEMES.includes(x)),
    bpm: rng(j.bpm, 40, 220), energy: rng(j.energy, 0, 1), mood: j.mood === 'bright' || j.mood === 'dark' ? j.mood : null,
    weather: (['sunny', 'cloudy', 'fog', 'rain', 'snow', 'storm'] as const).find((b) => b === j.weather) ?? null,
    hours: rng(j.hours, 0, 23) as [number, number] | null, weekend: typeof j.weekend === 'boolean' ? j.weekend : null, years: rng(j.years, 1900, 2100),
    freshness: j.freshness === 'familiar' || j.freshness === 'forgotten' ? j.freshness : 'any', obscure: j.obscure === true, size: Math.max(5, Math.min(150, Number(j.size) || fallback.size)),
  };
  // keep anything the rules found that the model left out (e.g. a tag it didn't recognise)
  for (const k of ['scenes', 'tags', 'themes'] as const) for (const v of fallback[k]) if (!spec[k].includes(v)) spec[k].push(v);
  return { spec, model };
}

export type Pick = { trackId: string; track: string; artistId: string | null; artist: string; plays: number; score: number; why: string[] };

/** Score every rarely-skipped track you've played against the Spec. Hard limits only where you asked for numbers. */
export async function buildFromSpec(s: Spec): Promise<{ picks: Pick[]; considered: number; criteria: number }> {
  const P = playsWhere('p');
  const hourCond = s.hours ? (s.hours[0] <= s.hours[1] ? `EXTRACT(hour FROM p.played_at) BETWEEN ${s.hours[0]} AND ${s.hours[1]}` : `(EXTRACT(hour FROM p.played_at) >= ${s.hours[0]} OR EXTRACT(hour FROM p.played_at) <= ${s.hours[1]})`) : 'FALSE';
  const rows = await query(`
    WITH wd AS (SELECT date FROM weather_daily WHERE kind = 'observed' AND bucket = ${s.weather ? `'${s.weather}'` : 'NULL'}),
    sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
    tg AS (SELECT artist_id, list(DISTINCT lower(tag)) AS tags FROM artist_tags WHERE weight >= 0.2 GROUP BY 1),
    t AS (SELECT p.track_id, arg_max(p.track_name, p.ms_played) AS t, arg_max(p.artist_id, p.ms_played) AS aid, arg_max(p.artist_name, p.ms_played) AS a, arg_max(p.album_id, p.ms_played) AS alb,
                 COUNT(*) AS n, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr, MAX(p.played_at) AS last,
                 AVG(CASE WHEN CAST(p.played_at AS DATE) IN (SELECT date FROM wd) THEN 1.0 ELSE 0 END) AS wshare,
                 AVG(CASE WHEN ${hourCond} THEN 1.0 ELSE 0 END) AS hshare,
                 AVG(CASE WHEN EXTRACT(dow FROM p.played_at) IN (0, 6) THEN 1.0 ELSE 0 END) AS weshare
          FROM plays_resolved p WHERE p.attended AND p.track_id IS NOT NULL AND p.track_id NOT LIKE 'local:%' ${P} GROUP BY 1 HAVING COUNT(*) >= 2 AND AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) < 0.5)
    SELECT t.*, f.bpm, f.energy, f.mode, lf.valence, lf.themes, sc.scene, tg.tags, EXTRACT(year FROM COALESCE(al.release_date, tr.release_date)) AS yr, ao.obscurity AS ob
    FROM t LEFT JOIN track_features f ON f.track_id = t.track_id AND f.found LEFT JOIN track_lyric_features lf ON lf.track_id = t.track_id AND lf.found
    LEFT JOIN sc ON sc.artist_id = t.aid LEFT JOIN tg ON tg.artist_id = t.aid LEFT JOIN albums al ON al.album_id = t.alb LEFT JOIN tracks tr ON tr.track_id = t.track_id LEFT JOIN artist_obscurity ao ON ao.artist_id = t.aid`);
  const [base] = await query(`SELECT AVG(CASE WHEN CAST(played_at AS DATE) IN (SELECT date FROM weather_daily WHERE kind = 'observed' AND bucket = ${s.weather ? `'${s.weather}'` : 'NULL'}) THEN 1.0 ELSE 0 END) AS w, AVG(CASE WHEN ${hourCond.replace(/p\./g, '')} THEN 1.0 ELSE 0 END) AS h FROM plays_resolved WHERE attended`);
  const wBase = num(base?.w), hBase = num(base?.h);
  let criteria = 0;
  const now = Date.now();
  const picks: Pick[] = [];
  for (const r of rows) {
    const why: string[] = []; let score = 0; let hardFail = false;
    const bpm = r.bpm == null ? null : num(r.bpm), energy = r.energy == null ? null : num(r.energy), val = r.valence == null ? null : num(r.valence);
    if (s.scenes.length) { if (s.scenes.includes(String(r.scene))) { score += 3; why.push(String(r.scene)); } }
    const tags = Array.isArray(r.tags) ? (r.tags as unknown[]).map(String) : [];
    if (s.tags.length) { const hit = s.tags.filter((x) => tags.includes(x)); if (hit.length) { score += 2.5 + hit.length * 0.5; why.push(hit.join(', ')); } }
    if (s.themes.length) { const th = Array.isArray(r.themes) ? (r.themes as unknown[]).map(String) : []; const hit = s.themes.filter((x) => th.includes(x)); if (hit.length) { score += 2 * hit.length; why.push(`lyrics: ${hit.join(', ')}`); } }
    if (s.bpm) { if (bpm == null) score -= 0.5; else if (bpm >= s.bpm[0] && bpm <= s.bpm[1]) { score += 2; why.push(`${Math.round(bpm)} bpm`); } else hardFail = true; }
    if (s.energy) { if (energy == null) score -= 0.5; else if (energy >= s.energy[0] - 0.05 && energy <= s.energy[1] + 0.05) { score += 1.5; why.push(`energy ${energy.toFixed(2)}`); } else hardFail = true; }
    if (s.mood) { const dark = (val != null && val < -0.15) || num(r.mode) === 0 && r.mode != null; const bright = (val != null && val > 0.15) || (num(r.mode) === 1 && (energy ?? 0) > 0.5);
      if ((s.mood === 'dark' && dark) || (s.mood === 'bright' && bright)) { score += 1.5; why.push(s.mood === 'dark' ? (val != null && val < -0.15 ? 'bleak lyrics' : 'minor key') : 'bright'); } }
    if (s.weather) { const lift = wBase > 0 ? num(r.wshare) / wBase : 0; if (lift >= 1.3 && num(r.n) >= 3) { score += Math.min(3, lift); why.push(`${lift.toFixed(1)}× on ${s.weather} days`); } }
    if (s.hours) { const lift = hBase > 0 ? num(r.hshare) / hBase : 0; if (lift >= 1.3) { score += Math.min(3, lift); why.push(`${lift.toFixed(1)}× at that hour`); } }
    if (s.weekend) { if (num(r.weshare) >= 0.45) { score += 1; why.push('a weekend song'); } }
    // a decade you asked for is strict — a song with no known release year can't be shown to be from it
    if (s.years) { const y = num(r.yr); if (r.yr != null && y >= s.years[0] && y <= s.years[1]) { score += 2; why.push(String(y)); } else hardFail = true; }
    if (s.obscure && r.ob != null && num(r.ob) >= 0.3) { score += 1.5; why.push('rare'); }
    const daysSince = (now - Date.parse(String(r.last).replace(' ', 'T'))) / 86400e3;
    if (s.freshness === 'forgotten') { if (daysSince >= 180 && num(r.n) >= 4) { score += 2 + Math.min(1.5, daysSince / 365); why.push(`not played in ${Math.round(daysSince / 30)} months`); } else score -= 1; }
    if (s.freshness === 'familiar') { score += Math.min(2, num(r.n) / 25); if (num(r.n) >= 25) why.push(`${num(r.n)} plays`); }
    score += Math.min(0.6, num(r.n) / 100) - num(r.sr);   // gentle tie-break: loved, rarely skipped
    if (!hardFail && why.length) picks.push({ trackId: String(r.track_id), track: String(r.t), artistId: str(r.aid), artist: String(r.a ?? ''), plays: num(r.n), score, why });
  }
  criteria = [s.scenes.length, s.tags.length, s.themes.length, s.bpm, s.energy, s.mood, s.weather, s.hours, s.weekend, s.years, s.obscure || null, s.freshness !== 'any' || null].filter((x) => x && x !== 0).length;
  // variety: at most 3 songs per artist
  const perArtist = new Map<string, number>();
  const out = picks.sort((a, b) => b.score - a.score).filter((p) => { const k = p.artistId ?? p.artist; const c = perArtist.get(k) ?? 0; if (c >= 3) return false; perArtist.set(k, c + 1); return true; }).slice(0, s.size);
  return { picks: out, considered: rows.length, criteria };
}

/** One-line summary of a Spec, for chips and playlist descriptions. */
export function describe(s: Spec): string[] {
  const out: string[] = [];
  if (s.weather) out.push(`${s.weather} days`); if (s.hours) out.push(s.hours[0] > s.hours[1] ? 'late night' : `${s.hours[0]}–${s.hours[1]} h`); if (s.weekend) out.push('weekends');
  if (s.mood) out.push(s.mood === 'dark' ? 'darker mood' : 'bright mood'); if (s.energy) out.push(`energy ${s.energy[0]}–${s.energy[1]}`); if (s.bpm) out.push(`${s.bpm[0]}–${s.bpm[1]} bpm`);
  if (s.years) out.push(`${s.years[0]}–${s.years[1]}`); for (const x of s.scenes) out.push(x.replace(/-/g, ' ')); for (const x of s.tags) out.push(x); for (const x of s.themes) out.push(`lyrics: ${x}`);
  if (s.freshness !== 'any') out.push(s.freshness === 'forgotten' ? 'forgotten' : 'favourites'); if (s.obscure) out.push('obscure');
  return out;
}
