// Phase 9k smoke: weather (store, summary, outlook), tempo dial, session arc, mix-into, dynamic playlists.
(globalThis as unknown as { window: object }).window = {};
import { invoke } from '../src/lib/bridge';
import { query } from '../src/lib/db';
import { weatherOutlook, weatherSummary } from '../src/lib/weatherQueries';
import { mixInto, sessionArc, tempoStations } from '../src/lib/featureQueries';
import { buildRule, isDue, loadDynamic, newId, refreshDue, saveDynamic, type Rule } from '../src/lib/dynamicPlaylists';
import { localToday } from '../src/lib/queries';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(26)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };

// weather: a forecast row must not overwrite an observed one
const [past] = await query(`SELECT CAST(MIN(date) AS VARCHAR) AS d FROM weather_daily WHERE kind = 'observed'`);
const d0 = String(past.d).slice(0, 10);
await time('weather_store (no clobber)', () => invoke('weather_store', { rows: [{ date: d0, code: 95, bucket: 'storm', tmax: 1, tmin: 0, precip: 50, sunshine: 0, kind: 'forecast' }] }));
const [chk] = await query(`SELECT kind, bucket FROM weather_daily WHERE date = CAST($1 AS DATE)`, [d0]); assert(chk.kind === 'observed' && chk.bucket !== 'storm', 'observed kept');
const ws = await time('weatherSummary', weatherSummary); assert(ws.moods.length >= 4 && ws.temps.length >= 3, 'moods + temps');
console.log(`   ${ws.moods.map((m) => `${m.glyph}${m.label} ${Math.round(m.minutesPerDay)}m ${m.vsAverage >= 0 ? '+' : ''}${Math.round(m.vsAverage * 100)}%`).join(' · ')}`);
const wo = await time('weatherOutlook', () => weatherOutlook(localToday())); assert(wo.size >= 6, `week of weather (${wo.size})`);
// tempo / arcs / mixing
const ts = await time('tempoStations', () => tempoStations('any')); assert(ts.length === 5 && ts.some((b) => b.total > 0), 'bands');
const [s] = await query(`SELECT CAST(ps.session_id AS VARCHAR) AS id FROM play_sessions ps JOIN plays_resolved p USING (play_id) JOIN track_features f ON f.track_id = p.track_id AND f.found GROUP BY 1 HAVING COUNT(*) >= 5 LIMIT 1`);
const arc = await time('sessionArc', () => sessionArc(String(s.id))); assert(arc.length >= 5 && arc.some((p) => p.energy != null), 'arc');
const [t] = await query(`SELECT track_id FROM track_features WHERE found AND camelot IS NOT NULL LIMIT 1`);
const mx = await time('mixInto', () => mixInto(String(t.track_id))); assert(mx && mx.tracks.every((x) => x.keyStep <= 1), 'compatible keys only');
console.log(`   ${mx?.tracks.length} mixable from ${mx?.camelot} @ ${Math.round(mx?.bpm ?? 0)} bpm`);
// dynamic playlists: every rule builds; due logic; refresh + simulated sync
const [sc] = await query(`SELECT scene FROM artist_scene GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1`);
const rules: Rule[] = [{ kind: 'forecast' }, { kind: 'rotation', days: 30 }, { kind: 'rediscover', silentDays: 120 }, { kind: 'scene', scene: String(sc.scene), recentDays: null }, { kind: 'tempo', band: 'groove', energy: 'any' }, { kind: 'revisit' }, { kind: 'soundsLike', trackId: String(t.track_id), track: 'x' }];
for (const r of rules) { const out = await time(`buildRule ${r.kind}`, () => buildRule(r, 20)); assert(out.length <= 20 && new Set(out.map((x) => x.trackId)).size === out.length, `dedupe ${r.kind}`); console.log(`   ${out.length} songs`); }
const def = { id: newId(), name: 'smoke', rule: { kind: 'rotation', days: 30 } as Rule, size: 15, cadence: 'daily' as const, autoSync: true, spotifyId: '0123456789abcdefghijkl', spotifyUrl: null, lastBuiltAt: null, lastSyncedAt: null, lastTrackIds: [] as string[] };
await saveDynamic([def]); assert(isDue(def), 'new def is due');
const rr = await time('refreshDue', () => refreshDue()); assert(rr.rebuilt.includes('smoke') && rr.synced.includes('smoke') && !rr.errors.length, `rebuilt + synced ${JSON.stringify(rr)}`);
const after = (await loadDynamic())[0]; assert(after.lastTrackIds.length > 0 && !isDue(after), 'not due right after'); await saveDynamic([]);
console.log('9k smoke OK');
