/** Runs every query function against the dev server. `npm run dev:browser` first, then `npx tsx scripts/smoke-queries.ts`. */
(globalThis as unknown as { window: object }).window = {};
import * as q from '../src/lib/queries';
import * as s from '../src/lib/sessionQueries';
import { setActiveFilter } from '../src/lib/filter';

const time = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
  const t0 = performance.now();
  try { const r = await fn(); console.log(`✓ ${label.padEnd(38)} ${(performance.now() - t0).toFixed(0).padStart(5)} ms`); return r; }
  catch (e) { console.log(`✗ ${label}\n   ${String((e as Error).message ?? e).slice(0, 400)}`); throw e; }
};

for (const attentive of [false, true]) {
  setActiveFilter({ attentiveOnly: attentive, fromYear: attentive ? 2020 : null, toYear: null });
  console.log(`\n== filter attentiveOnly=${attentive}`);
  const d = await time('getDashboardStats', q.getDashboardStats);
  console.log(`   ${d.totalPlays} plays · ${d.totalHours} h · top: ${d.topArtists[0]?.artist} ${d.topArtists[0]?.hours}h · streak ${d.currentStreakDays} · shapes ${d.sessionShapes.length} · records ${d.records.length}`);
  const a = await time('getArtistDetail', () => q.getArtistDetail(d.topArtists[0].artistId));
  console.log(`   ${a?.artist} rank ${a?.rank} albums ${a?.albums.length} loyalty ${a?.albumLoyalty?.album} ${a?.albumLoyalty?.share.toFixed(2)} aliases ${a?.aliases}`);
  const t = await time('getTrackDetail', () => q.getTrackDetail(d.topTracks[0].trackId));
  console.log(`   ${t?.track} — ${t?.artist} · ${t?.plays} plays · dur ${t?.durationMs} est=${t?.durationEstimated} · after: ${t?.after[0]?.track} · exits ${t?.exitPoints.length}`);
  const al = await time('getAlbumDetail', () => q.getAlbumDetail(a!.albums[0].albumId));
  console.log(`   ${al?.album} · ${al?.tracks.length} tracks · rides ${al?.rideCount} · share ${al?.shareOfArtist.toFixed(2)}`);
  const day = await time('getDayDetail', () => q.getDayDetail(d.peakDay!.day));
  console.log(`   ${day?.date} ${day?.minutes} min · ${day?.sessions.length} sessions (${day?.sessions.map((x) => x.shape).join(',')})`);
  const m = await time('getMonthDetail', () => q.getMonthDetail(d.monthlyHours.at(-2)!.key));
  console.log(`   ${m?.label} ${m?.hours} h · ${m?.newTracks} new tracks · prev ${m?.prevMonth} next ${m?.nextMonth}`);
  const sr = await time('search', () => q.search('beach'));
  console.log(`   artists ${sr.artists.length} tracks ${sr.tracks.length} albums ${sr.albums.length}`);
  const ov = await time('getSessionsOverview', s.getSessionsOverview);
  console.log(`   ${ov.count} sessions · median ${ov.medianMin.toFixed(0)} min · p90 ${ov.p90Min.toFixed(0)} · marathons ${ov.marathonCount} · hist ${ov.lengthHist.map((h) => h.count).join('/')} · heat ${ov.heat.length} · openers ${ov.openers[0]?.track} · platforms ${ov.platforms.join(', ')}`);
  console.log(`   skip by platform: ${ov.skipByPlatform.map((p) => `${p.platform} ${(p.skipRate * 100).toFixed(0)}%`).join(', ')}`);
  const ls = await time('listSessions', () => s.listSessions({ ...s.DEFAULT_SESSION_FILTERS, shape: 'album_ride', sort: 'longest' }));
  console.log(`   ${ls.total} album rides · first ${ls.rows[0]?.startAt} ${ls.rows[0]?.trackCount} tracks`);
  const sd = await time('getSessionDetail', () => s.getSessionDetail(ls.rows[0].sessionId));
  console.log(`   ${sd?.plays.length} plays · artists ${sd?.artists.map((x) => x.artist).slice(0, 3).join(', ')}`);
}
console.log('\nyears', await q.getYears());
