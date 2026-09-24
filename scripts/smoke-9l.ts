// Phase 9l smoke: playlists from words (interpretation + scoring), the words rule for dynamic playlists,
// and the polled-vs-exported coverage card.
(globalThis as unknown as { window: object }).window = {};
import { buildFromSpec, describe, interpret } from '../src/lib/wordsPlaylist';
import { buildRule } from '../src/lib/dynamicPlaylists';
import { sourceCoverage } from '../src/lib/sourceQueries';
import { query } from '../src/lib/db';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(30)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

const s1 = await time('interpret rainy late-night', () => interpret("rainy late-night songs I've forgotten"));
assert(s1.weather === 'rain' && s1.hours?.[0] === 22 && s1.freshness === 'forgotten', `spec ${JSON.stringify(s1)}`);
const s2 = await time('interpret 80s sunny saturday', () => interpret('upbeat 80s for a sunny Saturday, 20 songs'));
assert(s2.years?.[0] === 1980 && s2.weather === 'sunny' && s2.weekend && s2.mood === 'bright' && s2.size === 20, `spec ${JSON.stringify(s2)}`);
const s3 = await time('interpret 160 bpm run', () => interpret('something to run to — 160 bpm'));
assert(s3.bpm && s3.bpm[0] === 154 && s3.bpm[1] === 166, `bpm ${JSON.stringify(s3.bpm)}`);
const [sc] = await query(`SELECT f.label FROM artist_scene s JOIN scene_families f USING (scene) GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`);
const s4 = await time('interpret a scene name', () => interpret(`${String(sc.label).toLowerCase()} for the evening`));
assert(s4.scenes.length >= 1 && s4.hours?.[0] === 17, `scene ${JSON.stringify(s4)}`);
for (const [label, s] of [['rainy late-night', s1], ['80s sunny saturday', s2], ['160 bpm', s3], ['scene evening', s4]] as const) {
  const r = await time(`buildFromSpec ${label}`, () => buildFromSpec(s));
  const per = new Map<string, number>(); for (const p of r.picks) per.set(p.artist, (per.get(p.artist) ?? 0) + 1);
  assert(r.picks.every((p) => p.why.length > 0) && [...per.values()].every((n) => n <= 3) && r.picks.length <= s.size, `picks ${label}`);
  if (s.bpm) assert(r.picks.length === 0 || r.picks.every((p) => p.why.some((w) => w.endsWith('bpm'))), 'bpm is strict');
  console.log(`   ${r.picks.length} of ${r.considered} · [${describe(s).join(', ')}] · ${r.picks[0] ? `${r.picks[0].track} — ${r.picks[0].why.join(' · ')}` : '—'}`);
}
const dyn = await time('dynamic rule: words', () => buildRule({ kind: 'words', text: 'chill evening songs' }, 15)); assert(dyn.length > 0 && dyn.length <= 15, 'words rule');
const cov = await time('sourceCoverage', sourceCoverage); console.log(`   export ${cov.exportPlays} · polled ${cov.polledTotal} (replaced ${cov.polledReplaced}, after ${cov.polledAfterExport})`);
assert(cov.polledReplaced >= 0 && cov.polledTotal >= cov.polledReplaced, 'coverage adds up');
console.log('9l smoke OK');
