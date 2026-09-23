// Phase 9g smoke: Atlas origins, Forecast (+ log + accuracy), scene-family threads, tuning-driven Skip Hall.
(globalThis as unknown as { window: object }).window = {};
import { countryArtists, originByYear, originSummary } from '../src/lib/originQueries';
import { forecast, forecastAccuracy, logForecast } from '../src/lib/forecastQueries';
import { genreThreads, sceneWeekShares, threadArtists, threadTracks } from '../src/lib/threadQueries';
import { skipHall } from '../src/lib/skipHallQueries';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(28)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

const o = await time('originSummary', originSummary); console.log(`   ${o.countries} countries · ${o.coveredArtists}/${o.totalArtists} artists placed · top ${o.rows.slice(0, 3).map((r) => `${r.name} ${r.hours.toFixed(0)}h`).join(', ')}`);
assert(o.rows.every((r) => r.share >= 0 && r.share <= 1), 'shares in range');
if (o.rows[0]) { const a = await time('countryArtists', () => countryArtists(o.rows[0].country)); assert(a.length === o.rows[0].artists, `artists ${a.length} vs ${o.rows[0].artists}`); }
const yrs = await time('originByYear', originByYear); console.log(`   ${yrs.map((y) => `${y.year}:${y.countries}`).join(' ')}`);

const f = await time('forecast', () => forecast()); console.log(`   ${f.weekdayName}: pAny ${(f.pAny * 100).toFixed(0)}% over ${f.activeDays}/${f.sameDays} · ${f.scenes.slice(0, 3).map((s) => `${s.label} ${(s.p * 100).toFixed(0)}%`).join(', ')} · calls ${f.calls.length}`);
assert(f.scenes.every((s) => s.p <= 1.0001), 'scene p ≤ 1'); assert(f.slots.length === 4, 'four slots');
const wrote = await time('logForecast', () => logForecast(f)); const again = await logForecast({ ...f, logged: false }); assert(!(wrote && again), 'second log is a no-op'); console.log(`   logged=${wrote}`);
// backdate a copy of today's forecast so the accuracy scorer has something to grade
await fetch('http://localhost:4747/forecast_log_write', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ date: new Date(Date.now() - 7 * 86400e3).toISOString().slice(0, 10), weekday: f.weekday, payload: JSON.stringify({ weekday: f.weekday, pAny: f.pAny, scenes: f.scenes.map((s) => ({ scene: s.scene, p: s.p })), slots: [], calls: f.calls.map((c) => ({ kind: c.kind, key: c.key, label: c.label, p: c.p, n: c.n })) }) }) });
const acc = await time('forecastAccuracy', forecastAccuracy); console.log(`   ${acc.total} scored · brier ${acc.brier?.toFixed(3)} · skill ${acc.skill == null ? 'n/a' : (acc.skill * 100).toFixed(0) + '%'} · ${acc.verdict}`);
assert(acc.total >= 1 && acc.brier != null && acc.brier >= 0 && acc.brier <= 1, 'brier in range');

const sw = await time('sceneWeekShares', () => sceneWeekShares()); assert(sw.every((r) => r.tag.startsWith('scene:') && r.share <= 1.0001), 'scene shares'); console.log(`   ${sw.length} scene-week rows`);
const th = await time('genreThreads', () => genreThreads()); console.log(`   ${th.length} threads: ${th.slice(0, 5).map((t) => `${t.label} [${t.kind}] ${t.weeks}w`).join(' · ')}`);
const sc = th.find((t) => t.kind === 'scene');
if (sc) { const ta = await time('threadArtists scene', () => threadArtists(sc.tag, sc.start, sc.endExclusive, 0.2)); assert(ta.length > 0, 'scene thread has artists'); const tt = await time('threadTracks scene', () => threadTracks(sc.tag, sc.start, sc.endExclusive, 10)); assert(tt.length > 0, 'scene thread has tracks'); }
const off = await genreThreads({ scenes: false }); assert(off.every((t) => t.kind !== 'scene'), 'scenes off → no scene threads');
const sh = await time('skipHall (tuned defaults)', () => skipHall()); console.log(`   ${sh.rows.length} in the hall`);
console.log('9g smoke OK');
// sound
import { adventurousness, energyByHour, featureCoverage, featureExtremes, featuresByYear, keyWheel, keysBySeason } from '../src/lib/featureQueries';
const cv = await time('featureCoverage', featureCoverage); console.log(`   ${cv.featured}/${cv.played} featured · ${cv.missed} missed`);
const fy = await time('featuresByYear', featuresByYear); assert(fy.every((y) => y.bpm > 40 && y.bpm < 220 && y.minorShare >= 0 && y.minorShare <= 1), 'year features sane');
await time('energyByHour', energyByHour); await time('keysBySeason', keysBySeason); const kw = await time('keyWheel', keyWheel); assert(Math.abs(kw.reduce((a, k) => a + k.share, 0) - 1) < 1e-6 || kw.length === 0, 'key shares sum to 1');
const ad = await time('adventurousness', adventurousness); assert(ad.score >= 0 && ad.score <= 1, 'adventurousness in [0,1]'); console.log(`   ${(ad.score * 100).toFixed(0)}/100 · ${ad.binsUsed} cells`);
const ex = await time('featureExtremes', () => featureExtremes(3)); assert(ex.fastest[0] && ex.slowest[0] && (ex.fastest[0].bpm ?? 0) >= (ex.slowest[0].bpm ?? 0), 'fastest ≥ slowest');
console.log('9g sound OK');
