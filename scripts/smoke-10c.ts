// Phase 10c smoke: command-palette search + fuzzy ranking, song lineage (links into your record), ISRC version merge.
(globalThis as unknown as { window: object }).window = {};
import { invoke } from '../src/lib/bridge';
import { query } from '../src/lib/db';
import { fuzzyScore } from '../src/lib/fuzzy';
import { lineageFor } from '../src/lib/metaQueries';
import { search } from '../src/lib/queries';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(28)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

// palette: record search is fast enough to type against, and fuzzy picks the obvious page
const r = await time('palette search "khru"', () => search('khru')); assert(r.artists.some((a) => a.artist === 'Khruangbin'), 'artist found');
const pages = ['Dashboard', 'Sessions', 'Settings', 'Services', 'Moods & Forecast', 'Bubble & blind spots', 'Mixtape', 'The Newness'];
const top = (q: string) => pages.map((p) => [p, fuzzyScore(q, p)] as const).filter((x) => x[1] != null).sort((a, b) => b[1]! - a[1]!)[0]?.[0];
for (const [q, want] of [['mix', 'Mixtape'], ['mf', 'Moods & Forecast'], ['new', 'The Newness'], ['bubble', 'Bubble & blind spots']] as const) assert(top(q) === want, `${q} → ${top(q)}`);
console.log('✓ fuzzy page ranking');

// lineage: the demo's Khruangbin "Salt Tide" links to the Radiohead and Floating Points songs in the record
const [st] = await query(`SELECT t.track_id FROM tracks t JOIN artists a USING (artist_id) WHERE a.name = 'Khruangbin' AND t.name = 'Salt Tide' LIMIT 1`);
const l = await time('lineageFor', () => lineageFor(String(st.track_id)));
assert(l.length === 3 && l[0].kind === 'cover_of' && l[0].original, `order ${l.map((x) => x.kind)}`);
assert(l.every((x) => x.trackId), `all three are in the record: ${JSON.stringify(l.map((x) => [x.artist, x.trackId]))}`);
console.log(`   ${l.map((x) => `${x.kind}: ${x.artist} — ${x.title} (${x.plays} plays)`).join(' · ')}`);

// ISRC merge on the live record: give two Radiohead songs one ISRC, rebuild, one disappears into the other
const two = await query(`SELECT t.track_id, COUNT(*) AS n FROM plays_resolved p JOIN tracks t USING (track_id) JOIN artists a ON a.artist_id = t.artist_id WHERE a.name = 'Radiohead' AND t.track_id NOT LIKE 'local:%' GROUP BY 1 ORDER BY 2 DESC LIMIT 2`);
if (two.length === 2) {
  const [a, b] = two.map((x) => String(x.track_id));
  const before = Number(two[0].n) + Number(two[1].n);
  for (const id of [a, b]) await invoke('meta_set', { entityType: 'track', entityId: id, field: 'isrc', value: 'ZZ-DEM-10-00001' });   // owner ISRC override, as the metadata panel writes it
  await time('rebuild (merge on)', () => invoke('rebuild'));
  const after = await query(`SELECT track_id, COUNT(*) AS n FROM plays_resolved WHERE track_id IN ($1, $2) GROUP BY 1`, [a, b]);
  assert(after.length === 1 && String(after[0].track_id) === a && Number(after[0].n) === before, `merged: ${JSON.stringify(after)} want ${before} under ${a}`);
  console.log(`   ${before} plays of two versions now count under one song`);
} else console.log('   (skipped merge — fewer than two Radiohead tracks)');
console.log('10c smoke OK');
