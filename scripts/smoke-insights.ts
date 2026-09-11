(globalThis as unknown as { window: object }).window = {};
import * as i from '../src/lib/insightQueries';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try { const r = await fn(); console.log(`✓ ${label.padEnd(24)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; }
  catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 500)}`); throw e; }
};
const c = await time('lateNightCanon tracks', () => i.lateNightCanon('track')); console.log('  ', c.slice(0, 3).map((x) => `${x.name} (${x.latePlays} late, ×${x.lift.toFixed(1)})`).join(' · '));
const ca = await time('lateNightCanon artists', () => i.lateNightCanon('artist')); console.log('  ', ca.slice(0, 3).map((x) => `${x.name} ×${x.lift.toFixed(1)}`).join(' · '));
const o = await time('obsessions', () => i.obsessions()); console.log('  ', o.slice(0, 3).map((x) => `${x.artist} ${x.plays}× week of ${x.weekStart} (lift ${x.lift.toFixed(0)}, half-life ${x.halfLifeDays}d, ${x.peakTrack})`).join('\n   '));
const l = await time('lifecycle', i.lifecycle); console.log('   rising', l.rising.slice(0, 3).map((x) => x.artist).join(', '), '| fading', l.fading.slice(0, 3).map((x) => x.artist).join(', '), '| returned', l.returned.slice(0, 3).map((x) => `${x.artist} (${x.daysSilent}d)`).join(', '), '| retention', l.retention.map((r) => `${r.year}:${r.stillPlayed}/${r.discovered}`).join(' '));
const s = await time('skipForensics', i.skipForensics); console.log('   cantQuit', s.cantQuit.slice(0, 3).map((x) => `${x.track} ${Math.round(x.skipRate * 100)}%`).join(' · '), '| earlyExits', s.earlyExits.slice(0, 2).map((x) => `${x.track} @${Math.round(x.meanMs / 1000)}s ±${Math.round(x.sdMs / 1000)}`).join(' · '));
const se = await time('seasonality', i.seasonality); console.log('   winter', se.winter.slice(0, 3).map((x) => `${x.artist} ×${x.index.toFixed(1)}`).join(', '), '| summer', se.summer.slice(0, 3).map((x) => `${x.artist} ×${x.index.toFixed(1)}`).join(', '));
const p = await time('personas', i.personas); console.log('   weekday', p.weekday.hours.toFixed(0), 'h', p.weekday.topArtists.slice(0, 3).map((a) => a.artist).join(', '), '| weekend', p.weekend.hours.toFixed(0), 'h', p.weekend.topArtists.slice(0, 3).map((a) => a.artist).join(', '), '| commute', p.commute?.window, p.commute?.topArtists.slice(0, 2).map((a) => a.artist).join(', '));
const e = await time('eras', () => i.eras()); console.log('  ', e.length, 'eras;', e.slice(0, 4).map((x) => `${x.start.slice(0, 7)}→${x.end.slice(0, 7)} ${x.topArtists.map((a) => a.artist).join(' & ')}`).join('\n   '));
const y = await time('yearInReview 2025', () => i.yearInReview(2025)); console.log(`   ${y.hours} h · ${y.newArtists} new artists · top ${y.topArtists[0]?.artist} · loudest ${y.loudestDay?.day} · kept ${y.keptDiscoveries.length} dropped ${y.droppedDiscoveries.length} · canon ${y.canon[0]?.name}`);
const yr = await time('yearInReview rolling', () => i.yearInReview(null)); console.log(`   ${yr.hours} h · ${yr.months.length} months`);
