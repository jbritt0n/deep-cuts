// Phase 9h smoke: Moods & Forecast (day forecast, outlook, fronts, backtest), listening abroad, per-language lyric
// keywords, listener landscape, and the forecast-log read that tripped the 9g guard ("payload" → LOAD).
(globalThis as unknown as { window: object }).window = {};
import { backtest, dayForecast, forecastAccuracy, fronts, weekOutlook } from '../src/lib/forecastQueries';
import { abroadSummary, flag } from '../src/lib/originQueries';
import { lyricCloud, lyricLanguages } from '../src/lib/metricQueries';
import { listenerLandscape } from '../src/lib/crateQueries';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(26)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

const d = await time('dayForecast', () => dayForecast()); console.log(`   ${d.condition.glyph} ${d.headline}`);
assert(d.hourly.length === 24 && d.hourly.every((h) => h.p >= 0 && h.p <= 1.0001), 'hourly probabilities'); assert(d.artists.every((a) => a.p <= 1.0001), 'artist p ≤ 1'); assert(d.tracks.length <= 25, 'station ≤ 25 tracks');
const w = await time('weekOutlook', () => weekOutlook()); assert(w.days.length === 7, 'seven days'); console.log(`   ${w.days.map((x) => `${x.weekdayName.slice(0, 2)}${x.condition.glyph}`).join(' ')} · trend ×${w.trend.toFixed(2)}`);
const f = await time('fronts', () => fronts()); assert(f.warm.every((x) => x.ratio >= 1.5) && f.cold.every((x) => x.ratio <= 0.6), 'front ratios'); console.log(`   warm ${f.warm.length} · cold ${f.cold.length}`);
const b = await time('backtest(28)', () => backtest(28)); assert(b.days.length === 28 && b.hitRate >= 0 && b.hitRate <= 1, 'backtest shape'); assert(b.days.every((x) => x.predicted.length <= 10), '≤ 10 picks'); console.log(`   hit ${(b.hitRate * 100).toFixed(0)}% vs base ${(b.baselineRate * 100).toFixed(0)}% · ${b.verdict}`);
await time('forecastAccuracy (payload read)', forecastAccuracy);

const a = await time('abroadSummary', abroadSummary); console.log(`   home ${a.home} · ${a.trips.length} trips · ${a.countries.map((c) => `${flag(c.country)} ${c.name}`).join(', ')}`);
if (a.trips.length) { const it = a.trips.find((t) => t.country === 'IT'); if (it) { assert(it.souvenir?.artist === 'Raffaella Carrà', `Italy souvenir is ${it.souvenir?.artist}`); console.log(`   Italy souvenir: ${it.souvenir?.track} — ${it.souvenir?.artist}`); } const tr = a.trips.find((t) => t.country === 'TR'); if (tr) assert(['Duman', 'Barış Manço'].includes(tr.souvenir?.artist ?? ''), `Turkey souvenir is ${tr.souvenir?.artist}`); }
assert(flag('TR') === '🇹🇷', 'flag');

const langs = await time('lyricLanguages', lyricLanguages); console.log(`   ${langs.map((l) => `${l.lang}:${l.tracks}`).join(' ')}`);
const en = await time('lyricCloud en', () => lyricCloud('keywords', null, 60, 'en')); const other = await time('lyricCloud other', () => lyricCloud('keywords', null, 60, 'other'));
console.log(`   en ${en.words.length} words · other ${other.words.length}`);
const land = await time('listenerLandscape', listenerLandscape); assert(Math.abs(land.tiers.reduce((x, t) => x + t.share, 0) - 1) < 1e-6 || land.covered === 0, 'tier shares sum to 1'); console.log(`   ${land.covered} artists · first comparison ${land.firstComparison}`);
console.log('9h smoke OK');
