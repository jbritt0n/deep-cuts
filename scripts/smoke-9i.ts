// Phase 9i smoke: metadata read/correct, album vs artist obscurity, To revisit, Roast Me receipts, recency-aware threads,
// Export everything, and the demo extras that every newer page relies on.
(globalThis as unknown as { window: object }).window = {};
import { albumMeta, artistMeta, metaSet, setArtistOrigin, setArtistMbid, trackMeta } from '../src/lib/metaQueries';
import { crateRecords } from '../src/lib/crateQueries';
import { revisit } from '../src/lib/revisitQueries';
import { roastReceipts } from '../src/lib/roastQueries';
import { genreThreads } from '../src/lib/threadQueries';
import { lyricLanguages } from '../src/lib/metricQueries';
import { abroadSummary } from '../src/lib/originQueries';
import { invoke } from '../src/lib/bridge';
import { query } from '../src/lib/db';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(28)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

const a = await time('artistMeta', () => artistMeta('name:sault')); assert(a?.matchMethod === 'name' ? a.country.value === 'GB' : a?.matchMethod === 'owner', 'demo match + origin');   // 'owner' = left by an earlier run of this smoke on the same seed (owner matches can't be cleared)
await time('setArtistOrigin (owner)', () => setArtistOrigin('name:sault', 'US', 'Detroit', 2019));
const a2 = await artistMeta('name:sault'); assert(a2?.country.owner && a2.country.value === 'US' && a2.city === 'Detroit', 'owner origin applied');
await setArtistOrigin('name:sault', null, null, null); assert(!(await artistMeta('name:sault'))?.country.owner, 'origin reset');
await time('setArtistMbid (paste URL)', () => setArtistMbid('name:sault', 'https://musicbrainz.org/artist/0a1b2c3d-1111-2222-3333-444455556666/'));
assert((await artistMeta('name:sault'))?.matchMethod === 'owner', 'owner match');
let bad = false; try { await setArtistMbid('name:sault', 'not-an-id'); } catch { bad = true; } assert(bad, 'rejects a bad id');
const [al] = await query(`SELECT album_id FROM albums LIMIT 1`);
await time('meta_set album release_date', () => metaSet('album', String(al.album_id), 'release_date', '1971'));
assert((await albumMeta(String(al.album_id)))?.releaseDate.value === '1971-01-01', 'year normalised'); await metaSet('album', String(al.album_id), 'release_date', null);
const [tr] = await query(`SELECT track_id FROM track_features WHERE found LIMIT 1`);
const tm = await time('trackMeta', () => trackMeta(String(tr.track_id))); assert(tm?.features?.found, 'track features shown');

const recs = await time('crateRecords (album obscurity)', () => crateRecords({ limit: 50 })); assert(recs.some((r) => r.albumObscurity != null) && recs.some((r) => r.obscurity != null), 'both obscurities');
const rv = await time('revisit', () => revisit(20)); console.log(`   regulars ${rv.regulars.length} · fence ${rv.fence.length} · once ${rv.onceByLiked.length}`);
for (const h of ['mild', 'medium', 'spicy'] as const) { const r = await time(`roastReceipts ${h}`, () => roastReceipts(h, 1)); assert(r.receipts.length >= 3, 'receipts'); if (h === 'spicy') console.log(`   “${r.receipts[0].line}” (${r.receipts[0].receipt})`); }

const th = await time('genreThreads (recency-aware)', () => genreThreads()); const yrs = new Set(th.map((t) => t.start.slice(0, 4)));
assert(th.length <= 24 && th.filter((t) => t.kind === 'scene').length <= 8, 'caps'); console.log(`   ${th.length} threads across ${yrs.size} years`);
const langs = await time('lyricLanguages (demo)', lyricLanguages); assert(langs.some((l) => l.lang === 'tr'), 'demo has Turkish lyrics');
const ab = await time('abroadSummary (demo)', abroadSummary); assert(ab.trips.length >= 3, 'demo trips');
const out = await time('export_record csv', () => invoke<string>('export_record', { destDir: null, format: 'csv' })); console.log(`   → ${out}`);
console.log('9i smoke OK');
