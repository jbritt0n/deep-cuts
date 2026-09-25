// Phase 10a smoke: owner feedback (affinity, untitled playlists, country names, obscurity cards, The Newness) and the
// first Phase 10 features (discovery depth, connections, ISRC duplicates).
(globalThis as unknown as { window: object }).window = {};
import { query } from '../src/lib/db';
import { playlistHealth } from '../src/lib/playlistQueries';
import { originSummary, countryName } from '../src/lib/originQueries';
import { entityObscurity } from '../src/lib/crateQueries';
import { newness, newnessTimeline, periodAt } from '../src/lib/newnessQueries';
import { activities, antiRecommendations, blindSpots, bubbleScores, durationPreference } from '../src/lib/depthQueries';
import { coListening, playlistOverlap } from '../src/lib/connectionQueries';
import { isrcDuplicates } from '../src/lib/hygieneQueries';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(26)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

// playlists: affinity + untitled fallback
await query(`SELECT 1`);
const ph = await time('playlistHealth (affinity)', () => playlistHealth('all', 'affinity', ''));
const withAff = ph.filter((p) => p.affinity != null); assert(withAff.length >= 1 && withAff.every((p) => p.affinity! >= 0 && p.affinity! <= 1), 'affinity in 0–1');
assert(ph.find((p) => p.unreadable)?.affinity == null, 'unreadable has no affinity');
console.log(`   ${withAff.map((p) => `${p.name} ${Math.round(p.affinity! * 100)}%`).join(' · ')}`);
// Atlas: names from codes
assert(countryName('US') === 'United States' && countryName('TR').length > 3 && countryName('XK') === 'Kosovo', 'country names');
const os = await time('originSummary names', originSummary); assert(os.rows.every((r) => r.name !== 'New York' && r.name.length > 2), 'no city names');
// obscurity cards
const [ar] = await query(`SELECT artist_id FROM artist_popularity LIMIT 1`); const [al] = await query(`SELECT album_id FROM album_popularity WHERE found LIMIT 1`);
const oa = await time('entityObscurity artist', () => entityObscurity('artist', String(ar.artist_id))); assert(oa.tier && oa.percentile != null, 'artist obscurity');
const ob = await time('entityObscurity album', () => entityObscurity('album', String(al.album_id))); assert(ob.tier && ob.listeners != null, 'album obscurity');
// The Newness
for (const k of ['week', 'month', 'season'] as const) { const n = await time(`newness ${k}`, () => newness(periodAt(k, 1))); assert(n.newShare >= 0 && n.newShare <= 1 && n.finds.length <= 40, `newness ${k}`); }
const nm = await newness(periodAt('month', 0)); console.log(`   this month: ${nm.newArtists} new artists, ${Math.round(nm.newShare * 100)}% new (usually ${Math.round(nm.usualShare * 100)}%)`);
const tl = await time('newnessTimeline month', () => newnessTimeline('month', 12)); assert(tl.length === 12 && tl.every((p) => p.keepers <= p.newArtists), 'timeline');
// discovery depth
const bb = await time('bubbleScores', bubbleScores); assert(bb.every((y) => y.score >= 0 && y.score <= 100), 'bubble 0–100'); console.log(`   bubble: ${bb.map((y) => `${y.year}:${y.score}`).join(' ')}`);
await time('blindSpots', blindSpots); await time('antiRecommendations', antiRecommendations);
const act = await time('activities', activities); assert(act.rows.length >= 2 && Math.abs(act.rows.reduce((a, r) => a + r.share, 0) - 1) < 1e-6, 'activity shares'); console.log(`   ${act.rows.map((r) => `${r.activity} ${Math.round(r.share * 100)}%`).join(' · ')}`);
const du = await time('durationPreference', durationPreference); assert(Math.abs(du.bands.reduce((a, b) => a + b.share, 0) - 1) < 1e-6, 'bands sum to 1');
// connections
const cl = await time('coListening', () => coListening(30)); assert(cl.nodes.length >= 5 && cl.edges.every((e) => e.w > 0 && e.w <= 1), 'network'); console.log(`   ${cl.nodes.length} artists, ${cl.edges.length} links`);
const po = await time('playlistOverlap', () => playlistOverlap()); assert(po.pairs.every((p) => p.jaccard > 0 && p.jaccard <= 1), 'overlap');
const idup = await time('isrcDuplicates', () => isrcDuplicates()); console.log(`   ${idup.totalGroups} ISRC groups`);
console.log('10a smoke OK');
