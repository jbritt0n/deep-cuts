(globalThis as unknown as { window: object }).window = {};
import * as i from '../src/lib/insightQueries';
import { genreThreads, tagWeekShares } from '../src/lib/threadQueries';
import { setActiveFilter } from '../src/lib/filter';
import { ERA_PRESETS } from '../src/lib/eraParams';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try { const r = await fn(); console.log(`✓ ${label.padEnd(28)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; }
  catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; }
};
for (const p of ERA_PRESETS) {
  const e = await time(`eras · ${p.name}`, () => i.eras(p.params));
  console.log(`   ${e.length} eras; weeks: ${e.map((x) => x.weeks).join(',')}`);
  for (const x of e.slice(0, 3)) console.log(`   ${x.start} → ${x.end} (${x.weeks}w, ${x.hours.toFixed(0)} h) "${x.name}" ${x.topArtists.map((a) => a.artist).join(' & ')}${x.inProgress ? ' [in progress]' : ''}`);
}
const d = await time('eraDiagnostic 52', () => i.eraDiagnostic(undefined, 52)); console.log(`   ${d.length} weeks; breaks ${d.filter((w) => w.breaks).length}; median cos ${[...d.map((w) => w.cosToPrev ?? 0)].sort((a, b) => a - b)[Math.floor(d.length / 2)]?.toFixed(3)}`);
const all = await time('eraDiagnostic all', () => i.eraDiagnostic(undefined, null)); console.log(`   ${all.length} weeks total, ${all[0]?.week} → ${all.at(-1)?.week}`);
const sh = await time('tagWeekShares', () => tagWeekShares()); console.log(`   ${sh.length} tag×week rows, ${new Set(sh.map((r) => r.tag)).size} tags`);
const th = await time('genreThreads', () => genreThreads()); console.log(`   ${th.length} threads`); for (const t of th.slice(0, 6)) console.log(`   ${t.tag}: ${t.start} → ${t.end} (${t.weeks}w, ${t.hours.toFixed(0)} h, peak ${(t.peakShare * 100).toFixed(0)}%) ${t.topArtists.map((a) => a.artist).join(', ')}`);
