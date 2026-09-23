/**
 * Phase 9g — the Forecast (summary §3.2). A distribution, never a point prediction.
 *
 * Base rate = your last 26 same-weekdays (attended listening, under the lens). For each scene family, time slot
 * and — in high-confidence mode — artist, p = share of those days on which it played. Distribution mode always
 * fires; high-confidence mode names an artist or scene only above 85 % over ≥ 8 exposures (summary's floor).
 * The first time the dashboard opens on a day the forecast is logged (forecast_log); accuracy joins the logged
 * probabilities against what actually played, as a Brier score per month, so "how well do I know my own
 * listening" becomes a line — rising means habits are settling, falling means they are shifting.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { localToday } from './queries';

export type SceneP = { scene: string; label: string; p: number; hours: number };
export type SlotP = { slot: 'morning' | 'afternoon' | 'evening' | 'night'; p: number; minutes: number };
export type Call = { kind: 'artist' | 'scene'; key: string; label: string; p: number; n: number; hits: number };
export type Forecast = { date: string; weekday: number; weekdayName: string; sameDays: number; activeDays: number; pAny: number; scenes: SceneP[]; slots: SlotP[]; calls: Call[]; logged: boolean; thin: boolean };

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WINDOW_WEEKS = 26;
export const CALL_MIN_P = 0.85, CALL_MIN_N = 8;

/** Same-weekday day set: every date in the window with that weekday (active or not) — the denominator for pAny. */
const sameDaysSql = (today: string) => `
  days AS (SELECT CAST('${today}' AS DATE) - INTERVAL (7 * i) DAY AS d FROM range(1, ${WINDOW_WEEKS + 1}) t(i)),
  pl AS (SELECT CAST(p.played_at AS DATE) AS d, p.artist_id, p.artist_name, p.ms_played, EXTRACT(hour FROM p.played_at) AS hr
         FROM plays_resolved p WHERE p.attended AND CAST(p.played_at AS DATE) IN (SELECT CAST(d AS DATE) FROM days) ${playsWhere('p')}),
  active AS (SELECT DISTINCT d FROM pl)`;

export async function forecast(date = localToday()): Promise<Forecast> {
  const weekday = new Date(date + 'T12:00:00').getDay();
  const [base] = await query(`WITH ${sameDaysSql(date)} SELECT (SELECT COUNT(*) FROM days) AS same, (SELECT COUNT(*) FROM active) AS active`);
  const sameDays = num(base?.same), activeDays = num(base?.active);
  const denom = Math.max(activeDays, 1);
  const scenes: SceneP[] = (await query(`WITH ${sameDaysSql(date)},
      sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1)
    SELECT sc.scene, f.label, COUNT(DISTINCT pl.d) AS days, SUM(pl.ms_played)/3600000.0 AS h
    FROM pl JOIN sc USING (artist_id) JOIN scene_families f ON f.scene = sc.scene AND NOT f.hidden GROUP BY 1, 2 ORDER BY days DESC, h DESC LIMIT 8`))
    .map((r) => ({ scene: String(r.scene), label: String(r.label ?? r.scene), p: num(r.days) / denom, hours: num(r.h) }));
  const slotRows = await query(`WITH ${sameDaysSql(date)}
    SELECT CASE WHEN hr BETWEEN 5 AND 11 THEN 'morning' WHEN hr BETWEEN 12 AND 16 THEN 'afternoon' WHEN hr BETWEEN 17 AND 21 THEN 'evening' ELSE 'night' END AS slot, COUNT(DISTINCT d) AS days, SUM(ms_played)/60000.0 AS mins FROM pl GROUP BY 1`);
  const slots: SlotP[] = (['morning', 'afternoon', 'evening', 'night'] as const).map((slot) => { const r = slotRows.find((x) => x.slot === slot); return { slot, p: num(r?.days) / denom, minutes: num(r?.mins) / denom }; });
  // high-confidence calls: artists and scenes ≥ CALL_MIN_P over ≥ CALL_MIN_N active same-weekdays
  const calls: Call[] = [];
  if (activeDays >= CALL_MIN_N) {
    for (const r of await query(`WITH ${sameDaysSql(date)}
        SELECT artist_id, arg_max(artist_name, ms_played) AS artist, COUNT(DISTINCT d) AS days FROM pl WHERE artist_id IS NOT NULL GROUP BY 1 HAVING COUNT(DISTINCT d) >= ${Math.ceil(CALL_MIN_P * activeDays)} ORDER BY days DESC LIMIT 3`))
      calls.push({ kind: 'artist', key: String(r.artist_id), label: String(r.artist), p: num(r.days) / denom, n: activeDays, hits: num(r.days) });
    for (const s of scenes) if (s.p >= CALL_MIN_P) calls.push({ kind: 'scene', key: s.scene, label: s.label, p: s.p, n: activeDays, hits: Math.round(s.p * denom) });
  }
  const [lg] = await query(`SELECT COUNT(*) AS n FROM forecast_log WHERE forecast_date = CAST($1 AS DATE)`, [date]);
  return { date, weekday, weekdayName: DAYS[weekday], sameDays, activeDays, pAny: sameDays ? activeDays / sameDays : 0, scenes, slots, calls, logged: num(lg?.n) > 0, thin: activeDays < 6 };
}

/** Log today's forecast once (idempotent on the host side). Returns true when a row was written. */
export async function logForecast(f: Forecast): Promise<boolean> {
  if (f.logged) return false;
  const payload = { weekday: f.weekday, pAny: f.pAny, scenes: f.scenes.map((s) => ({ scene: s.scene, p: s.p })), slots: f.slots.map((s) => ({ slot: s.slot, p: s.p })), calls: f.calls.map((c) => ({ kind: c.kind, key: c.key, label: c.label, p: c.p, n: c.n })) };
  try { return Boolean(await invoke<boolean>('forecast_log_write', { date: f.date, weekday: f.weekday, payload: JSON.stringify(payload) })); } catch { return false; }
}

export type AccuracyMonth = { month: string; forecasts: number; brier: number; hitRate: number | null; calls: number; callHits: number; anyRight: number };
export type Accuracy = { months: AccuracyMonth[]; total: number; brier: number | null; skill: number | null; callHitRate: number | null; verdict: string };

/**
 * Brier score of logged scene probabilities against what actually played that day (0 = perfect, 0.25 = coin-flip).
 * Skill = 1 − Brier/BrierClimatology, where climatology predicts every scene at its base rate; > 0 means the
 * forecast beats "same as always". High-confidence calls are scored as plain hits.
 */
export async function forecastAccuracy(): Promise<Accuracy> {
  const logs = await query(`SELECT CAST(forecast_date AS VARCHAR) AS d, payload FROM forecast_log WHERE forecast_date < CAST($1 AS DATE) ORDER BY forecast_date`, [localToday()]);
  if (!logs.length) return { months: [], total: 0, brier: null, skill: null, callHitRate: null, verdict: 'No past forecasts yet — open the dashboard on a few days and come back.' };
  const actual = await query(`
    WITH sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1)
    SELECT CAST(p.played_at AS DATE) AS d, list(DISTINCT sc.scene) FILTER (WHERE sc.scene IS NOT NULL) AS scenes, list(DISTINCT p.artist_id) AS artists, COUNT(*) AS plays
    FROM plays_resolved p LEFT JOIN sc USING (artist_id) WHERE p.attended AND CAST(p.played_at AS DATE) IN (SELECT forecast_date FROM forecast_log) ${playsWhere('p')} GROUP BY 1`);
  const byDay = new Map(actual.map((r) => [String(r.d), { scenes: new Set((r.scenes as unknown[] ?? []).map(String)), artists: new Set((r.artists as unknown[] ?? []).map(String)) }]));
  // climatology: base rate of each scene over the logged days
  const base = new Map<string, number>();
  for (const [, a] of byDay) for (const s of a.scenes) base.set(s, (base.get(s) ?? 0) + 1);
  const monthAgg = new Map<string, { n: number; brier: number; clim: number; calls: number; callHits: number; anyRight: number; terms: number }>();
  let totalBrier = 0, totalClim = 0, terms = 0, calls = 0, callHits = 0;
  for (const l of logs) {
    const d = String(l.d); const p = typeof l.payload === 'string' ? JSON.parse(l.payload) : (l.payload as Record<string, unknown>);
    const act = byDay.get(d) ?? { scenes: new Set<string>(), artists: new Set<string>() };
    const m = d.slice(0, 7); const agg = monthAgg.get(m) ?? { n: 0, brier: 0, clim: 0, calls: 0, callHits: 0, anyRight: 0, terms: 0 };
    agg.n += 1;
    const pAny = num((p as { pAny?: number }).pAny ?? 0.5); const anyActual = act.scenes.size > 0 || act.artists.size > 0;
    if ((pAny >= 0.5) === anyActual) agg.anyRight += 1;
    for (const s of ((p as { scenes?: { scene: string; p: number }[] }).scenes ?? [])) {
      const o = act.scenes.has(s.scene) ? 1 : 0; const b = (s.p - o) ** 2; const c = ((base.get(s.scene) ?? 0) / byDay.size - o) ** 2;
      agg.brier += b; agg.clim += c; agg.terms += 1; totalBrier += b; totalClim += c; terms += 1;
    }
    for (const c of ((p as { calls?: { kind: string; key: string }[] }).calls ?? [])) { agg.calls += 1; calls += 1; const hit = c.kind === 'artist' ? act.artists.has(c.key) : act.scenes.has(c.key); if (hit) { agg.callHits += 1; callHits += 1; } }
    monthAgg.set(m, agg);
  }
  const months: AccuracyMonth[] = [...monthAgg.entries()].map(([month, a]) => ({ month, forecasts: a.n, brier: a.terms ? a.brier / a.terms : 0, hitRate: a.calls ? a.callHits / a.calls : null, calls: a.calls, callHits: a.callHits, anyRight: a.n ? a.anyRight / a.n : 0 }));
  const brier = terms ? totalBrier / terms : null; const clim = terms ? totalClim / terms : null;
  const skill = brier != null && clim ? 1 - brier / clim : null;
  const verdict = brier == null || logs.length < 7 || skill == null ? `Scoring so far: ${logs.length} day${logs.length === 1 ? '' : 's'}. A verdict needs a week of forecasts and enough variety to beat your base rate against.` : skill > 0.15 ? 'Your listening is predictable — the forecast clearly beats "same as always".' : skill > 0 ? 'Mildly predictable: the forecast edges out the base rate.' : 'Unpredictable lately — the forecast does no better than your long-run averages. Habits may be shifting.';
  return { months, total: logs.length, brier, skill, callHitRate: calls ? callHits / calls : null, verdict };
}


// ============================================================================ Phase 9h — Moods & Forecast
// "Habits + trends": every probability below blends the weekday base rate (last 26 same-weekdays) with the recent
// rate (last 14 days, any weekday), half and half — the recent half only counts when you listened on ≥ 3 of those days.
const HISTORY_DAYS = 182, RECENT_DAYS = 14;
const dow = (iso: string) => new Date(iso + 'T12:00:00').getDay();   // 0 = Sunday, same as DuckDB dayofweek()

export type HourCell = { hour: number; p: number; scene: string | null; label: string | null };
export type LikelyArtist = { artistId: string; artist: string; p: number; pWeekday: number; pRecent: number };
export type LikelyTrack = { trackId: string; track: string; artistId: string | null; artist: string; plays: number; hours: number; skipRate: number; p: number };
export type SlotOutlook = { slot: SlotP['slot']; p: number; minutes: number; scene: string | null; label: string | null };
export type Condition = { key: 'downpour' | 'showers' | 'scattered' | 'drizzle' | 'clear'; label: string; glyph: string };
export type DayForecast = Forecast & { expectedMinutes: number; recentActive: number; hourly: HourCell[]; slotOutlook: SlotOutlook[]; artists: LikelyArtist[]; tracks: LikelyTrack[]; condition: Condition; headline: string };

/** Weather words for "how much music is coming". Minutes are the average over same weekdays, silent ones included. */
export function condition(pAny: number, minutes: number): Condition {
  if (pAny < 0.35) return { key: 'clear', label: 'Mostly clear — a quiet day', glyph: '☀' };
  if (minutes >= 150) return { key: 'downpour', label: 'Downpour', glyph: '⛈' };
  if (minutes >= 75) return { key: 'showers', label: 'Steady showers', glyph: '🌧' };
  if (minutes >= 30) return { key: 'scattered', label: 'Scattered showers', glyph: '🌦' };
  return { key: 'drizzle', label: 'Light drizzle', glyph: '🌤' };
}

export async function dayForecast(date = localToday()): Promise<DayForecast> {
  const base = await forecast(date);
  const w = dow(date);
  const P = playsWhere('p');
  const hist = `CAST('${date}' AS DATE) - INTERVAL ${HISTORY_DAYS} DAY`, today = `CAST('${date}' AS DATE)`;
  const [m] = await query(`
    WITH d AS (SELECT CAST(p.played_at AS DATE) AS day, SUM(p.ms_played)/60000.0 AS mins FROM plays_resolved p WHERE p.attended AND p.played_at >= ${hist} AND CAST(p.played_at AS DATE) < ${today} ${P} GROUP BY 1)
    SELECT SUM(mins) FILTER (WHERE dayofweek(day) = ${w}) / ${HISTORY_DAYS / 7} AS mins, COUNT(*) FILTER (WHERE day >= ${today} - INTERVAL ${RECENT_DAYS} DAY) AS recent FROM d`);
  const expectedMinutes = num(m?.mins), recentActive = num(m?.recent);
  const useRecent = recentActive >= 3;
  const denomW = Math.max(base.activeDays, 1), denomR = Math.max(recentActive, 1);
  const sc = `sc AS (SELECT s.artist_id, arg_max(s.scene, s.weight) AS scene FROM artist_scene s JOIN scene_families f USING (scene) WHERE NOT f.hidden GROUP BY 1)`;
  // hourly radar: share of listening same-weekdays with plays in that hour, and the hour's leading scene
  const hr = await query(`
    WITH pl AS (SELECT CAST(p.played_at AS DATE) AS day, EXTRACT(hour FROM p.played_at)::INT AS h, p.artist_id, p.ms_played FROM plays_resolved p
                WHERE p.attended AND p.played_at >= ${hist} AND CAST(p.played_at AS DATE) < ${today} AND dayofweek(p.played_at) = ${w} ${P}), ${sc}
    SELECT pl.h, COUNT(DISTINCT pl.day) AS days, arg_max(sc.scene, pl.ms_played) AS scene FROM pl LEFT JOIN sc USING (artist_id) GROUP BY 1`);
  const labels: Record<string, string> = {}; for (const r of await query(`SELECT scene, label FROM scene_families`)) labels[String(r.scene)] = String(r.label);
  const hourly: HourCell[] = Array.from({ length: 24 }, (_, h) => { const r = hr.find((x) => num(x.h) === h); const s = r?.scene ? String(r.scene) : null; return { hour: h, p: num(r?.days) / denomW, scene: s, label: s ? labels[s] ?? s : null }; });
  // per day-part: minutes and leading scene
  const so = await query(`
    WITH pl AS (SELECT CAST(p.played_at AS DATE) AS day, EXTRACT(hour FROM p.played_at) AS hr, p.artist_id, p.ms_played FROM plays_resolved p
                WHERE p.attended AND p.played_at >= ${hist} AND CAST(p.played_at AS DATE) < ${today} AND dayofweek(p.played_at) = ${w} ${P}), ${sc}
    SELECT CASE WHEN hr BETWEEN 5 AND 11 THEN 'morning' WHEN hr BETWEEN 12 AND 16 THEN 'afternoon' WHEN hr BETWEEN 17 AND 21 THEN 'evening' ELSE 'night' END AS slot,
           arg_max(sc.scene, pl.ms_played) FILTER (WHERE sc.scene IS NOT NULL) AS scene FROM pl LEFT JOIN sc USING (artist_id) GROUP BY 1`);
  const slotOutlook: SlotOutlook[] = base.slots.map((s) => { const r = so.find((x) => x.slot === s.slot); const k = r?.scene ? String(r.scene) : null; return { ...s, scene: k, label: k ? labels[k] ?? k : null }; });
  // likely artists: blended day-rates
  const ar = await query(`
    WITH pl AS (SELECT CAST(p.played_at AS DATE) AS day, p.artist_id, p.artist_name, p.ms_played FROM plays_resolved p WHERE p.attended AND p.artist_id IS NOT NULL AND p.played_at >= ${hist} AND CAST(p.played_at AS DATE) < ${today} ${P})
    SELECT artist_id, arg_max(artist_name, ms_played) AS artist,
           COUNT(DISTINCT day) FILTER (WHERE dayofweek(day) = ${w}) AS wd, COUNT(DISTINCT day) FILTER (WHERE day >= ${today} - INTERVAL ${RECENT_DAYS} DAY) AS rd
    FROM pl GROUP BY 1 HAVING wd > 0 OR rd > 0`);
  const artists: LikelyArtist[] = ar.map((r) => { const pw = num(r.wd) / denomW, pr = num(r.rd) / denomR; return { artistId: String(r.artist_id), artist: String(r.artist), pWeekday: pw, pRecent: useRecent ? pr : 0, p: useRecent ? 0.5 * pw + 0.5 * pr : pw }; })
    .sort((a, b) => b.p - a.p).slice(0, 12);
  // likely tracks: same blend on track-days, top 25 → the "station" playlist
  const tr = await query(`
    WITH pl AS (SELECT CAST(p.played_at AS DATE) AS day, p.track_id, p.track_name, p.artist_id, p.artist_name, p.ms_played, p.was_skipped FROM plays_resolved p WHERE p.attended AND p.track_id IS NOT NULL AND p.played_at >= ${hist} AND CAST(p.played_at AS DATE) < ${today} ${P})
    SELECT track_id, arg_max(track_name, ms_played) AS track, arg_max(artist_id, ms_played) AS aid, arg_max(artist_name, ms_played) AS artist, COUNT(*) AS plays, SUM(ms_played)/3600000.0 AS h, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr,
           COUNT(DISTINCT day) FILTER (WHERE dayofweek(day) = ${w}) AS wd, COUNT(DISTINCT day) FILTER (WHERE day >= ${today} - INTERVAL ${RECENT_DAYS} DAY) AS rd
    FROM pl GROUP BY 1 HAVING (wd > 0 OR rd > 0) AND AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) < 0.5`);
  const tracks: LikelyTrack[] = tr.map((r) => { const pw = num(r.wd) / denomW, pr = num(r.rd) / denomR; return { trackId: String(r.track_id), track: String(r.track), artistId: str(r.aid), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.h), skipRate: num(r.sr), p: useRecent ? 0.5 * pw + 0.5 * pr : pw }; })
    .sort((a, b) => b.p - a.p || b.plays - a.plays).slice(0, 25);
  const cond = condition(base.pAny, expectedMinutes);
  const peak = [...slotOutlook].sort((a, b) => b.minutes - a.minutes)[0];
  const [s1, s2, s3] = base.scenes;
  const headline = base.thin ? `Not enough ${base.weekdayName}s on record to call it.`
    : cond.key === 'clear' ? `${cond.label}: only a ${fmtPctS(base.pAny)} chance of any listening${s1 ? `; if it comes, expect ${s1.label}` : ''}.`
    : `${cond.label}, heaviest in the ${peak?.slot ?? 'evening'}${peak?.label ? ` (${peak.label})` : ''}.${s1 ? ` Prevailing ${s1.label} (${fmtPctS(s1.p)})` : ''}${s2 ? `, gusts of ${s2.label}` : ''}${s3 && s3.p >= 0.3 ? `, a chance of ${s3.label}` : ''}.`;
  return { ...base, expectedMinutes, recentActive, hourly, slotOutlook, artists, tracks, condition: cond, headline };
}
const fmtPctS = (r: number) => `${Math.round(r * 100)}%`;

export type OutlookDay = { date: string; weekdayName: string; pAny: number; minutes: number; condition: Condition; scenes: { scene: string; label: string; p: number }[]; topArtist: string | null; peakSlot: string | null };
/** The next seven days from the weekday profiles, nudged by the last four weeks' volume vs the 26-week average. */
export async function weekOutlook(from = localToday()): Promise<{ days: OutlookDay[]; trend: number }> {
  const P = playsWhere('p');
  const hist = `CAST('${from}' AS DATE) - INTERVAL ${HISTORY_DAYS} DAY`, today = `CAST('${from}' AS DATE)`;
  const rows = await query(`
    WITH pl AS (SELECT CAST(p.played_at AS DATE) AS day, EXTRACT(hour FROM p.played_at) AS hr, p.artist_id, p.artist_name, p.ms_played FROM plays_resolved p WHERE p.attended AND p.played_at >= ${hist} AND CAST(p.played_at AS DATE) < ${today} ${P}),
         sc AS (SELECT s.artist_id, arg_max(s.scene, s.weight) AS scene FROM artist_scene s JOIN scene_families f USING (scene) WHERE NOT f.hidden GROUP BY 1),
         byday AS (SELECT dayofweek(day) AS w, COUNT(DISTINCT day) AS active, SUM(ms_played)/60000.0 AS mins, arg_max(artist_name, ms_played) AS top_artist,
                          arg_max(CASE WHEN hr BETWEEN 5 AND 11 THEN 'morning' WHEN hr BETWEEN 12 AND 16 THEN 'afternoon' WHEN hr BETWEEN 17 AND 21 THEN 'evening' ELSE 'night' END, ms_played) AS peak FROM pl GROUP BY 1),
         scd AS (SELECT dayofweek(pl.day) AS w, sc.scene, COUNT(DISTINCT pl.day) AS days FROM pl JOIN sc USING (artist_id) GROUP BY 1, 2)
    SELECT b.w, b.active, b.mins, b.top_artist, b.peak, list({'scene': scd.scene, 'days': scd.days} ORDER BY scd.days DESC)[1:3] AS scenes FROM byday b LEFT JOIN scd USING (w) GROUP BY 1, 2, 3, 4, 5`);
  const [t] = await query(`SELECT SUM(ms_played) FILTER (WHERE played_at >= CAST('${from}' AS DATE) - INTERVAL 28 DAY) / 4.0 AS recent, SUM(ms_played) / ${HISTORY_DAYS / 7} AS base FROM plays_resolved p WHERE p.attended AND p.played_at >= ${hist} AND CAST(p.played_at AS DATE) < ${today} ${P}`);
  const trend = num(t?.base) ? Math.max(0.5, Math.min(1.8, num(t?.recent) / num(t?.base))) : 1;
  const labels: Record<string, string> = {}; for (const r of await query(`SELECT scene, label FROM scene_families`)) labels[String(r.scene)] = String(r.label);
  const weeks = HISTORY_DAYS / 7;
  const days: OutlookDay[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(from + 'T12:00:00'); d.setDate(d.getDate() + i);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = rows.find((x) => num(x.w) === d.getDay());
    const active = num(r?.active), pAny = active / weeks, minutes = (num(r?.mins) / weeks) * trend;
    const scenes = (Array.isArray(r?.scenes) ? (r!.scenes as { scene: string | null; days: number }[]) : []).filter((x) => x && x.scene).map((x) => ({ scene: String(x.scene), label: labels[String(x.scene)] ?? String(x.scene), p: active ? num(x.days) / active : 0 }));
    days.push({ date: iso, weekdayName: DAYS[d.getDay()], pAny, minutes, condition: condition(pAny, minutes), scenes, topArtist: str(r?.top_artist), peakSlot: str(r?.peak) });
  }
  return { days, trend };
}

export type Front = { key: string; label: string; recentShare: number; priorShare: number; ratio: number; kind: 'scene' | 'artist' };
/** Warm fronts (gaining share in the last 28 days vs the 84 before) and cold fronts (losing it). */
export async function fronts(from = localToday()): Promise<{ warm: Front[]; cold: Front[] }> {
  const P = playsWhere('p');
  const q = (key: string, label: string, join: string) => query(`
    WITH pl AS (SELECT p.*, p.played_at >= CAST('${from}' AS DATE) - INTERVAL 28 DAY AS recent FROM plays_resolved p WHERE p.attended AND p.played_at >= CAST('${from}' AS DATE) - INTERVAL 112 DAY AND CAST(p.played_at AS DATE) < CAST('${from}' AS DATE) ${P}),
         tot AS (SELECT SUM(ms_played) FILTER (WHERE recent) AS r, SUM(ms_played) FILTER (WHERE NOT recent) AS o FROM pl)
    SELECT ${key} AS k, ${label} AS l, SUM(ms_played) FILTER (WHERE recent) * 1.0 / (SELECT r FROM tot) AS rs, SUM(ms_played) FILTER (WHERE NOT recent) * 1.0 / (SELECT o FROM tot) AS os
    FROM pl ${join} GROUP BY 1 HAVING SUM(ms_played) >= 3600000`);
  const lab: Record<string, string> = {}; for (const r of await query(`SELECT scene, label FROM scene_families`)) lab[String(r.scene)] = String(r.label);
  const toF = (kind: Front['kind']) => (r: Record<string, unknown>): Front => { const rs = num(r.rs), os = num(r.os); return { key: String(r.k), label: kind === 'scene' ? lab[String(r.k)] ?? String(r.k) : String(r.l), recentShare: rs, priorShare: os, ratio: (rs + 0.005) / (os + 0.005), kind }; };
  const scenes = (await q('sc.scene', 'sc.scene', 'JOIN (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1) sc USING (artist_id)')).map(toF('scene'));
  const artists = (await q('pl.artist_id', 'arg_max(pl.artist_name, pl.ms_played)', 'WHERE pl.artist_id IS NOT NULL')).map(toF('artist'));
  const all = [...scenes, ...artists].filter((f) => f.recentShare + f.priorShare >= 0.01);
  return { warm: all.filter((f) => f.ratio >= 1.5 && f.recentShare >= 0.01).sort((a, b) => b.ratio - a.ratio).slice(0, 6), cold: all.filter((f) => f.ratio <= 0.6 && f.priorShare >= 0.015).sort((a, b) => a.ratio - b.ratio).slice(0, 6) };
}

export type BacktestDay = { date: string; weekdayName: string; listened: boolean; pAny: number; hits: number; baselineHits: number; predicted: { artistId: string; artist: string; p: number; hit: boolean }[] };
export type Backtest = { days: BacktestDay[]; hitRate: number; baselineRate: number; lift: number | null; brierAny: number; listenedDays: number; verdict: string };
/**
 * Replay the artist forecast on each of the last `n` days using only data from before that day. hit@10 = share of the
 * ten predicted artists you actually played that day (days with listening only). Baseline = "your ten biggest
 * artists of the last 26 weeks" — the forecast has to beat plain popularity to be worth anything.
 */
export async function backtest(n = 28, from = localToday()): Promise<Backtest> {
  const P = playsWhere('p');
  const rows = await query(`
    WITH t AS (SELECT CAST(CAST('${from}' AS DATE) - INTERVAL (i) DAY AS DATE) AS d FROM range(1, ${Math.round(n) + 1}) r(i)),
    pl AS (SELECT CAST(p.played_at AS DATE) AS day, p.artist_id, arg_max(p.artist_name, p.ms_played) AS artist, SUM(p.ms_played) AS ms FROM plays_resolved p
           WHERE p.attended AND p.artist_id IS NOT NULL AND p.played_at >= CAST('${from}' AS DATE) - INTERVAL ${HISTORY_DAYS + n + 1} DAY ${P} GROUP BY 1, 2),
    act AS (SELECT DISTINCT day FROM pl),
    wka AS (SELECT t.d, COUNT(a.day) AS n FROM t LEFT JOIN act a ON a.day < t.d AND a.day >= t.d - INTERVAL ${HISTORY_DAYS} DAY AND dayofweek(a.day) = dayofweek(t.d) GROUP BY 1),
    rca AS (SELECT t.d, COUNT(a.day) AS n FROM t LEFT JOIN act a ON a.day < t.d AND a.day >= t.d - INTERVAL ${RECENT_DAYS} DAY GROUP BY 1),
    hist AS (SELECT t.d, pl.artist_id, arg_max(pl.artist, pl.ms) AS artist, SUM(pl.ms) AS ms,
                    COUNT(*) FILTER (WHERE dayofweek(pl.day) = dayofweek(t.d)) AS wd, COUNT(*) FILTER (WHERE pl.day >= t.d - INTERVAL ${RECENT_DAYS} DAY) AS rd
             FROM t JOIN pl ON pl.day < t.d AND pl.day >= t.d - INTERVAL ${HISTORY_DAYS} DAY GROUP BY 1, 2),
    scored AS (SELECT h.d, h.artist_id, h.artist, h.ms,
                      CASE WHEN r.n >= 3 THEN 0.5 * h.wd / GREATEST(w.n, 1) + 0.5 * h.rd / GREATEST(r.n, 1) ELSE h.wd * 1.0 / GREATEST(w.n, 1) END AS p
               FROM hist h JOIN wka w USING (d) JOIN rca r USING (d)),
    pred AS (SELECT * FROM scored QUALIFY ROW_NUMBER() OVER (PARTITION BY d ORDER BY p DESC, ms DESC) <= 10),
    base AS (SELECT * FROM scored QUALIFY ROW_NUMBER() OVER (PARTITION BY d ORDER BY ms DESC) <= 10)
    SELECT CAST(t.d AS VARCHAR) AS d, dayofweek(t.d) AS w, (t.d IN (SELECT day FROM act)) AS listened, w.n / ${HISTORY_DAYS / 7}.0 AS pany,
           (SELECT list({'id': pr.artist_id, 'artist': pr.artist, 'p': pr.p, 'hit': EXISTS (SELECT 1 FROM pl x WHERE x.day = t.d AND x.artist_id = pr.artist_id)} ORDER BY pr.p DESC) FROM pred pr WHERE pr.d = t.d) AS predicted,
           (SELECT COUNT(*) FROM base b WHERE b.d = t.d AND EXISTS (SELECT 1 FROM pl x WHERE x.day = t.d AND x.artist_id = b.artist_id)) AS base_hits
    FROM t JOIN wka w USING (d) ORDER BY t.d DESC`);
  const days: BacktestDay[] = rows.map((r) => {
    const pr = (Array.isArray(r.predicted) ? r.predicted as { id: string; artist: string; p: number; hit: boolean }[] : []).map((x) => ({ artistId: String(x.id), artist: String(x.artist), p: num(x.p), hit: Boolean(x.hit) }));
    return { date: String(r.d).slice(0, 10), weekdayName: DAYS[num(r.w)], listened: Boolean(r.listened), pAny: num(r.pany), hits: pr.filter((x) => x.hit).length, baselineHits: num(r.base_hits), predicted: pr };
  });
  const on = days.filter((d) => d.listened);
  const hitRate = on.length ? on.reduce((a, d) => a + d.hits, 0) / (on.length * 10) : 0;
  const baselineRate = on.length ? on.reduce((a, d) => a + d.baselineHits, 0) / (on.length * 10) : 0;
  const brierAny = days.length ? days.reduce((a, d) => a + (d.pAny - (d.listened ? 1 : 0)) ** 2, 0) / days.length : 0;
  const lift = baselineRate > 0 ? hitRate / baselineRate : null;
  const verdict = on.length < 5 ? 'Too few listening days in the window to judge.'
    : lift != null && lift >= 1.15 ? `The forecast reads you well — its picks land ${Math.round((lift - 1) * 100)}% more often than just naming your biggest artists.`
    : lift != null && lift >= 0.95 ? 'About as good as naming your biggest artists: your days look alike, so habit is the whole story.'
    : 'Your recent days broke pattern — plain popularity beat the weekday-and-trend model. Tastes on the move.';
  return { days, hitRate, baselineRate, lift, brierAny, listenedDays: on.length, verdict };
}
