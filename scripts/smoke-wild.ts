/** Phase 8 — runs every Heard-in-the-Wild query against the dev server. `npm run dev:browser` first, then `npx tsx scripts/smoke-wild.ts`. */
(globalThis as unknown as { window: object }).window = {};
import * as w from '../src/lib/wildQueries';

const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try { const r = await fn(); console.log(`✓ ${label.padEnd(30)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; }
  catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 400)}`); throw e; }
};

const has = await time('hasWild', w.hasWild);
console.log(`   has captures: ${has}`);
const o = await time('wildOverview', w.wildOverview);
console.log(`   ${o.captures} captures · ${o.songs} songs · ${o.artists} artists · never streamed ${o.neverStreamed} · yours ${o.alreadyYours} · days ${o.days} · ${o.firstHeard} → ${o.lastHeard}`);
console.log(`   months ${o.byMonth.map((m) => `${m.month}:${m.captures}/${m.newSongs}new`).join(' ')}`);
console.log(`   hours ${o.byHour.map((h) => `${h.hour}h=${h.captures}`).join(' ')}`);
console.log(`   weekdays ${o.byWeekday.map((d) => `${d.dow}=${d.captures}`).join(' ')}`);
console.log(`   top artists ${o.topArtists.slice(0, 5).map((a) => `${a.artist}(${a.captures}×${a.inRecord ? ',yours' : ',new'})`).join(', ')}`);
for (const mode of ['never', 'yours', 'all'] as const) {
  const s = await time(`wildSongs(${mode})`, () => w.wildSongs(mode));
  console.log(`   ${s.length} songs · first: ${s[0]?.track} — ${s[0]?.artist} ${s[0]?.captures}× ${s[0]?.trackId ? `(you: ${s[0].yourPlays} plays, ${s[0].trackId})` : '(never streamed)'}`);
}
const q = await time('wildSongs(search "beach")', () => w.wildSongs('all', 'beach'));
console.log(`   ${q.map((s) => s.track).join(', ')}`);
const r = await time('wildRecent', () => w.wildRecent(5));
console.log(`   ${r.map((c) => `${c.heardAt.slice(5, 16)} ${c.track}${c.inRecord ? '*' : ''}`).join(' | ')}`);
const d = await time('wildOnDay', () => w.wildOnDay(r[0].heardAt.slice(0, 10)));
console.log(`   ${d.length} capture(s) on ${r[0].heardAt.slice(0, 10)}`);
// invariant: the core record must be blind to captures
const core = await (await fetch('http://localhost:4747/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sql: "SELECT (SELECT COUNT(*) FROM plays_resolved) AS core, (SELECT COUNT(*) FROM events) AS events, (SELECT COUNT(*) FROM events WHERE event_type = 'wild_play') AS wild", params: [] }) })).json() as { core: number; events: number; wild: number }[];
const c = core[0];
console.log(`   invariant: plays_resolved ${c.core} = events ${c.events} − wild ${c.wild} → ${Number(c.core) === Number(c.events) - Number(c.wild) ? 'OK' : 'BROKEN'}`);
if (Number(c.core) !== Number(c.events) - Number(c.wild)) process.exit(1);
