// Phase 10b smoke: bubble (log-of-zero fix), family tree, error envelope through the real bridge, Stylus S2 retention
// setting, and the Privacy panel's queries.
(globalThis as unknown as { window: object }).window = {};
import { invoke } from '../src/lib/bridge';
import { query } from '../src/lib/db';
import { bubbleScores } from '../src/lib/depthQueries';
import { familyTree, treeCandidates } from '../src/lib/connectionQueries';
import { DeepCutsError } from '../src/lib/errors';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(28)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

// bubble survives zero-length plays (the owner's "cannot take logarithm of zero")
await invoke('query', { sql: 'SELECT 1' }).catch(() => {});
const [sample] = await query(`SELECT track_name, artist_name, album_name FROM plays_resolved LIMIT 1`);
await fetch('http://127.0.0.1:4747/stylus_add_device', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'zero-length test' }) });
const b = await time('bubbleScores', bubbleScores); assert(b.length > 0 && b.every((y) => Number.isFinite(y.score)), 'finite bubble scores');
void sample;

// family tree from the demo relationships
const cands = await time('treeCandidates', () => treeCandidates()); assert(cands.some((c) => c.name === 'Radiohead'), 'Radiohead has relations');
const rh = cands.find((c) => c.name === 'Radiohead')!;
const t = await time('familyTree Radiohead', () => familyTree(rh.artistId));
const names = t.nodes.map((n) => n.name);
assert(t.centre && names.includes('Thom Yorke') && names.includes('The Smile'), `rings ${names.join(', ')}`);
assert(t.nodes.find((n) => n.name === 'Thom Yorke')?.ring === 1 && t.nodes.find((n) => n.name === 'The Smile')?.ring === 2, 'ring depths');
console.log(`   ${t.centre!.name}: ${t.nodes.filter((n) => n.ring === 1).length} direct, ${t.nodes.filter((n) => n.ring === 2).length} further — ${names.join(', ')}`);

// error envelope through the bridge: a validation error and a SQL error both arrive typed
let e1: unknown; try { await invoke('artist_set_origin', { artistId: 'x', country: 'USA', city: null, formedYear: null }); } catch (e) { e1 = e; }
assert(e1 instanceof DeepCutsError && e1.code === 'invalid_input', `validation → ${String(e1)}`);
let e2: unknown; try { await query(`SELECT no_such_column FROM plays_resolved`); } catch (e) { e2 = e; }
assert(e2 instanceof DeepCutsError && e2.code === 'database', `sql → ${String(e2)}`);
console.log(`   ${String(e1)}\n   ${String(e2).slice(0, 90)}`);

// Stylus S2: retention setting round-trips and runs
const dev = await invoke<{ deviceId: string }>('stylus_add_device', { name: 'Retention test' });
await time('stylus_update_device (90 d)', () => invoke('stylus_update_device', { deviceId: dev.deviceId, tsPrecision: 'exact', keepPlayer: true, keepService: true, keepDevice: true, paused: false, retentionDays: 90 }));
const [r] = await query(`SELECT retention_days FROM stylus_devices WHERE device_id = $1`, [dev.deviceId]); assert(Number(r.retention_days) === 90, 'retention saved');
await invoke('stylus_update_device', { deviceId: dev.deviceId, tsPrecision: 'exact', keepPlayer: true, keepService: true, keepDevice: true, paused: false, retentionDays: null });
const [r2] = await query(`SELECT retention_days FROM stylus_devices WHERE device_id = $1`, [dev.deviceId]); assert(r2.retention_days == null, 'forever = NULL');
for (const d of await query(`SELECT device_id FROM stylus_devices`)) await invoke('stylus_remove_device', { deviceId: String(d.device_id) });

// Privacy panel queries
for (const sql of [`SELECT COUNT(*) AS n FROM plays_resolved WHERE source = 'recently_played_poll'`, `SELECT COUNT(*) AS n FROM artist_wiki WHERE found`, `SELECT COUNT(*) AS n FROM weather_daily`])
  await time(`privacy: ${sql.slice(21, 60)}`, () => query(sql));
console.log('10b smoke OK');
