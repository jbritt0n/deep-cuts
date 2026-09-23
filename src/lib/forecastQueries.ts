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
import { query, num } from './db';
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

