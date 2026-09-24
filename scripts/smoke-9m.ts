// Phase 9m smoke: Stylus end to end over HTTP (device → token → validate → submit → plays), era weather,
// per-kind thread caps, and weather-gated dynamic playlists.
(globalThis as unknown as { window: object }).window = {};
import { invoke } from '../src/lib/bridge';
import { query } from '../src/lib/db';
import { rangeWeather } from '../src/lib/weatherQueries';
import { genreThreads } from '../src/lib/threadQueries';
import { loadDynamic, newId, refreshDue, saveDynamic, type Rule } from '../src/lib/dynamicPlaylists';
import { setActiveFilter } from '../src/lib/filter';
setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
const BASE = 'http://127.0.0.1:4747';
const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => { const t0 = performance.now(); try { const r = await fn(); console.log(`✓ ${label.padEnd(30)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; } catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 600)}`); throw e; } };
const assert = (c: unknown, m: string) => { if (!c) throw new Error('assertion failed: ' + m); };
const lb = (path: string, token: string | null, body?: unknown) => fetch(`${BASE}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Token ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });

// ---- Stylus
const dev = await time('stylus_add_device', () => invoke<{ deviceId: string; token: string }>('stylus_add_device', { name: 'Smoke phone' }));
assert(/^[0-9a-f]{64}$/.test(dev.token), 'token is 32 random bytes');
const [stored] = await query(`SELECT token_hash FROM stylus_devices WHERE device_id = $1`, [dev.deviceId]); assert(stored.token_hash !== dev.token, 'only the hash is stored');
const v = await time('GET /1/validate-token', async () => (await lb('/1/validate-token', dev.token)).json()); assert(v.valid === true, 'valid token');
const bad = await (await lb('/1/validate-token', 'nope')).json(); assert(bad.valid === false, 'invalid token');
assert((await lb('/1/submit-listens', 'nope', { listen_type: 'single', payload: [] })).status === 401, '401 on a bad token');
assert((await lb('/apis/listenbrainz/1/submit-listens', dev.token, { nonsense: true })).status === 400, '400 on a bad body (prefixed path)');
const before = Number((await query(`SELECT COUNT(*) AS n FROM plays_resolved WHERE platform LIKE 'stylus%'`))[0].n);
const now = Math.floor(Date.now() / 1000) - 3600;
const body = { listen_type: 'import', payload: [
  { listened_at: now, track_metadata: { artist_name: 'Smoke Band', track_name: 'Bandcamp Only', release_name: 'Tape', additional_info: { duration_ms: 181000, music_service: 'bandcamp.com', submission_client: 'Web Scrobbler' } } },
  { listened_at: now + 200, track_metadata: { artist_name: 'Smoke Band', track_name: 'Second Song', additional_info: { duration: 199 } } },
] };
const r1 = await time('POST /1/submit-listens', async () => lb('/1/submit-listens', dev.token, body)); assert(r1.status === 200, `status ${r1.status}`);
const r2 = await lb('/1/submit-listens', dev.token, body); assert(r2.status === 200, 'resend accepted');   // client retry
await lb('/1/submit-listens', dev.token, { listen_type: 'playing_now', payload: [{ track_metadata: { artist_name: 'Smoke Band', track_name: 'Right Now' } }] });
const after = Number((await query(`SELECT COUNT(*) AS n FROM plays_resolved WHERE platform LIKE 'stylus%'`))[0].n);
assert(after - before === 2, `two new plays, resend ignored (got ${after - before})`);
const [d] = await query(`SELECT accepted, duplicates FROM stylus_devices WHERE device_id = $1`, [dev.deviceId]); assert(Number(d.accepted) === 2 && Number(d.duplicates) === 2, `counts ${JSON.stringify(d)}`);
const [np] = await query(`SELECT track_name FROM stylus_now_playing WHERE device_id = $1`, [dev.deviceId]); assert(np?.track_name === 'Right Now', 'now playing');
const [ms] = await query(`SELECT ms_played FROM plays_resolved WHERE track_name = 'Second Song'`); assert(Number(ms.ms_played) === 199000, 'duration in seconds converted');
await invoke('stylus_update_device', { deviceId: dev.deviceId, tsPrecision: 'hour', keepPlayer: false, keepService: false, keepDevice: false, paused: true });
await lb('/1/submit-listens', dev.token, { listen_type: 'single', payload: [{ listened_at: now + 900, track_metadata: { artist_name: 'X', track_name: 'Paused' } }] });
const [pz] = await query(`SELECT discarded FROM stylus_devices WHERE device_id = $1`, [dev.deviceId]); assert(Number(pz.discarded) === 1, 'paused discards');
await time('stylus_remove_device', () => invoke('stylus_remove_device', { deviceId: dev.deviceId }));
assert(!(await (await lb('/1/validate-token', dev.token)).json()).valid, 'revoked token no longer valid');
console.log(`   stylus: +${after - before} plays, resend and paused handled, token revoked`);

// ---- era weather, thread caps, weather gate
const w = await time('rangeWeather', async () => rangeWeather('2023-01-01', '2027-01-01'));
console.log(`   ${w ? `${w.glyph} ${w.label} ${Math.round(w.share * 100)}% vs ${Math.round(w.baseShare * 100)}%` : 'no weather stands out (fine on invented weather)'}`);
const th = await time('genreThreads (caps)', () => genreThreads({ maxScene: 1, maxDecade: 0 }));
assert(th.filter((t) => t.kind === 'scene').length <= 1 && th.filter((t) => t.kind === 'decade').length === 0, 'per-kind caps');
const [today] = await query(`SELECT bucket FROM weather_daily WHERE date = current_date`);
const other = ['rain', 'sunny', 'snow'].find((b) => b !== today?.bucket) as 'rain';
const gated = { id: newId(), name: 'gated', rule: { kind: 'rotation', days: 30 } as Rule, size: 10, cadence: 'daily' as const, autoSync: false, spotifyId: null, spotifyUrl: null, lastBuiltAt: null, lastSyncedAt: null, lastTrackIds: [] as string[], weatherGate: other };
const open = { ...gated, id: newId(), name: 'open', weatherGate: (today?.bucket ?? null) as 'rain' | null };
await saveDynamic([gated, open]);
const rr = await time('refreshDue (weather gate)', () => refreshDue());
assert(!rr.rebuilt.includes('gated') && rr.rebuilt.includes('open'), `gate respected ${JSON.stringify(rr)}`);
await saveDynamic([]); assert((await loadDynamic()).length === 0, 'cleaned up');
console.log('9m smoke OK');
