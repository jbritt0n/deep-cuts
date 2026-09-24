// Phase 9j smoke: tag/scene edits, Wikipedia card data, sound tools (sounds-like, artist sound, smooth order),
// the bigger roast, and the new achievements.
(globalThis as unknown as { window: object }).window = {};
import { artistMeta, artistWiki, tagEdit, setArtistScene, artistSceneAuto } from '../src/lib/metaQueries';
import { artistSound, flowFeatures, soundAlike } from '../src/lib/featureQueries';
import { smoothOrder, meanCost } from '../src/lib/harmonic';
import { roastReceipts } from '../src/lib/roastQueries';
import { achievements } from '../src/lib/phase4Queries';
import { query } from '../src/lib/db';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(26)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

const A = 'name:duman';
await time('tag remove (blocks)', () => tagEdit(A, 'turkish rock', 'remove'));
let m = await artistMeta(A); assert(m && !m.tags.some((t) => t.tag === 'turkish rock') && m.blocked.includes('turkish rock'), 'blocked');
await time('tag add', () => tagEdit(A, 'anatolian rock', 'add')); m = await artistMeta(A); assert(m?.tags.some((t) => t.tag === 'anatolian rock' && t.source === 'owner'), 'owner tag');
await tagEdit(A, 'turkish rock', 'unblock'); assert(!(await artistMeta(A))?.blocked.length, 'unblocked');
await time('scene set / auto', async () => { await setArtistScene(A, 'balkan'); assert((await artistMeta(A))?.sceneByYou, 'filed by you'); await artistSceneAuto(A); assert(!(await artistMeta(A))?.sceneByYou, 'back to auto'); });
const w = await time('artistWiki (demo)', () => artistWiki(A)); assert(w?.extract, 'demo wiki');
const [tr] = await query(`SELECT track_id FROM track_features WHERE found LIMIT 1`);
const sa = await time('soundAlike', () => soundAlike(String(tr.track_id))); assert(sa.seed && sa.tracks.length > 3, 'neighbours'); console.log(`   ${sa.tracks.slice(0, 3).map((t) => `${t.track} ${Math.round(t.bpm ?? 0)}bpm ${t.camelot}`).join(' · ')}`);
const [ar] = await query(`SELECT artist_id FROM plays_resolved GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`);
const as = await time('artistSound', () => artistSound(String(ar.artist_id))); assert(as && as.bpm > 40, 'artist sound');
const ids = (await query(`SELECT track_id FROM track_features WHERE found LIMIT 25`)).map((r) => String(r.track_id));
const f = await time('flowFeatures', () => flowFeatures(ids)); const tracks = ids.map((id) => ({ trackId: id, ...f.get(id)! }));
const o = smoothOrder(tracks); assert(o.length === tracks.length && meanCost(o) <= meanCost(tracks), 'smoother'); console.log(`   flow cost ${meanCost(tracks).toFixed(2)} → ${meanCost(o).toFixed(2)}`);
const r = await time('roastReceipts spicy', () => roastReceipts('spicy', 3)); assert(r.receipts.length >= 5 && r.opener && r.closer, 'full roast'); console.log(`   ${r.receipts.length} receipts · “${r.closer}”`);
const ach = await time('achievements', achievements); assert(ach.length >= 27 && ['passport', 'polyglot', 'keys', 'early'].every((id) => ach.some((a) => a.id === id)), 'sixteen more'); console.log(`   ${ach.length} achievements, ${ach.filter((a) => a.earned).length} earned`);
console.log('9j smoke OK');
