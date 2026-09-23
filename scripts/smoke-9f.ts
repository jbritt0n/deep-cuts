// Phase 9f smoke: scene vocabulary edits → re-file → Crate unsorted filter; lyric v2 queries; Daily Dig; movers;
// playlist totals with unreadable playlists; move-bundle export → inspect. Runs against dev-server.mjs on :4747.
(globalThis as unknown as { window: object }).window = {};
import { crateRecords, crateSections, dailyDig, popularityMovers, popularityTrajectory } from '../src/lib/crateQueries';
import { recomputeScenes, sceneFamilies, sceneKey, sceneOptions, sceneTags, setSceneTag, unmappedOrigins, unmappedTags, upsertSceneFamily, deleteSceneFamily } from '../src/lib/sceneQueries';
import { lyricCloud, lyricTracksFor } from '../src/lib/metricQueries';
import { lyricSearch } from '../src/lib/phase4Queries';
import { playlistHealth, playlistTotals } from '../src/lib/playlistQueries';
import { invoke } from '../src/lib/bridge';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(30)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

// scenes
const fams = await time('sceneFamilies', sceneFamilies); assert(fams.length >= 60, 'built-in families seeded'); console.log(`   ${fams.length} families, top: ${fams.slice(0, 4).map((f) => `${f.label} ${f.artists}`).join(' · ')}`);
const opts = await time('sceneOptions', sceneOptions); assert(opts.every((o) => o.label), 'labels');
const queue = await time('unmappedTags', () => unmappedTags(20)); console.log(`   ${queue.length} unfiled tags: ${queue.slice(0, 5).map((t) => t.tag).join(', ')}`);
await time('unmappedOrigins', unmappedOrigins);
const key = sceneKey('Smoke test scene ✓'); assert(key === 'smoke-test-scene', 'sceneKey slug ' + key);
await time('upsertSceneFamily', () => upsertSceneFamily({ scene: key, label: 'Smoke test scene', kind: 'style' }));
await time('setSceneTag', () => setSceneTag('smoke-test-tag', key));
const tags = await time('sceneTags', () => sceneTags(key)); assert(tags.some((t) => t.tag === 'smoke-test-tag'), 'tag mapped');
const r = await time('recomputeScenes', recomputeScenes); console.log(`   ${r.artists} artists / ${r.families} families`);
await time('deleteSceneFamily', () => deleteSceneFamily(key));
assert(!(await sceneFamilies()).some((f) => f.scene === key), 'deleted');

// crate: unsorted is a real filter and the deck reaches the last divider
const secs = await time('crateSections', () => crateSections('all'));
const all = await time('crateRecords (uncapped)', () => crateRecords({ sort: 'section' }));
const unsortedCount = secs.find((s) => s.section === 'unsorted')?.records ?? 0;
const uns = await time('crateRecords section=unsorted', () => crateRecords({ section: 'unsorted' }));
assert(uns.length === unsortedCount, `unsorted filter returns ${uns.length}, sections say ${unsortedCount}`);
assert(all.filter((x) => x.section == null).length === unsortedCount, 'uncapped deck reaches every unsorted record');
console.log(`   ${all.length} records, ${unsortedCount} unsorted`);

// lyrics v2
for (const k of ['keywords', 'themes', 'llm_themes', 'moods'] as const) { const c = await time(`lyricCloud ${k}`, () => lyricCloud(k)); console.log(`   ${c.words.length} words · ${c.coveredTracks}/${c.totalTracks} covered · ${c.oldRules} on old rules`); }
await time('lyricTracksFor', () => lyricTracksFor('river', 'keywords'));
await time('lyricSearch', () => lyricSearch('rain'));
await time('lyrics_status', () => invoke('lyrics_status'));

// daily dig + trajectory
const dig = await time('dailyDig', dailyDig); if (dig) console.log(`   ${dig.kind}: ${dig.record.album} — ${dig.record.artist} · ${dig.reason}`);
const dig2 = await dailyDig(); assert((dig?.record.albumId ?? null) === (dig2?.record.albumId ?? null), 'daily dig is stable within a day');
const mv = await time('popularityMovers', () => popularityMovers(5)); console.log(`   tracked ${mv.tracked}, rising ${mv.rising.length}, fading ${mv.fading.length}`);
if (fams[0]?.artists) { const anyArtist = (await crateRecords({ limit: 1 }))[0]?.artistId; if (anyArtist) await time('popularityTrajectory', () => popularityTrajectory(anyArtist)); }

// playlists
const tot = await time('playlistTotals', playlistTotals); console.log(`   ${tot.playlists} playlists · ${tot.partial} partial · ${tot.unreadable} unreadable`);
await time('playlistHealth', () => playlistHealth('all', 'most_played', ''));

// move bundle
const out = await time('export_move_bundle', () => invoke<string>('export_move_bundle', { destDir: null, passphrase: null }));
const man = await time('inspect_move_bundle', () => invoke<{ tables: { name: string }[]; plays: number }>('inspect_move_bundle', { path: out }));
assert(man.tables.length >= 40 && man.plays > 0, 'manifest lists tables and plays'); console.log(`   ${man.tables.length} tables, ${man.plays} plays → ${out}`);
console.log('9f smoke OK');
