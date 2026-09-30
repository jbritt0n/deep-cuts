/**
 * Phase 9i — Roast Me. The receipts are facts from your record; the jokes are built on them. The local model (when
 * connected) gets only these receipts, so it can't invent things about you. Every line is about listening habits —
 * never about who you are.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { currentModel, llmStatus, type ChatMsg } from './ask';
import { MOOD_IDS } from './lyricVocab';

export type Heat = 'mild' | 'medium' | 'spicy';
/** Phase 10d: roast a period, not only the whole record. `from`/`to` are dates (to exclusive). */
export type Period = { kind: 'all' | 'year' | 'month' | 'week'; key: string; label: string; from: string | null; to: string | null };
export const ALL_TIME: Period = { kind: 'all', key: 'all', label: 'your whole record', from: null, to: null };
const dayIso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function periodFor(kind: Period['kind'], anchor: string): Period {
  const d = new Date(anchor + 'T00:00:00');
  if (kind === 'year') return { kind, key: String(d.getFullYear()), label: String(d.getFullYear()), from: `${d.getFullYear()}-01-01`, to: `${d.getFullYear() + 1}-01-01` };
  if (kind === 'month') { const a = new Date(d.getFullYear(), d.getMonth(), 1), b = new Date(d.getFullYear(), d.getMonth() + 1, 1); return { kind, key: dayIso(a).slice(0, 7), label: a.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }), from: dayIso(a), to: dayIso(b) }; }
  if (kind === 'week') { const m = new Date(d); m.setDate(d.getDate() - ((d.getDay() + 6) % 7)); const e = new Date(m); e.setDate(m.getDate() + 7); const l = new Date(m); l.setDate(m.getDate() + 6);
    return { kind, key: `w${dayIso(m)}`, label: `the week of ${m.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${l.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`, from: dayIso(m), to: dayIso(e) }; }
  return ALL_TIME;
}
const span = (p: Period, a = 'p') => (p.from && p.to ? ` AND ${a}.played_at >= DATE '${p.from}' AND ${a}.played_at < DATE '${p.to}'` : '');
export type Receipt = { id: string; line: string; receipt: string; weight: number; link?: string };

const pick = <T,>(xs: T[], seed: number) => xs[Math.abs(seed) % xs.length];
const pct = (r: number) => `${Math.round(r * 100)}%`;
const fmtN = (n: number) => n.toLocaleString('en-US');
const OPENERS: Record<Heat, string[]> = {
  mild: ['Okay. We looked at your listening. We love you. But.', 'A few gentle notes from your record, with affection.'],
  medium: ['Your listening history has been reviewed. The panel has concerns.', 'We ran the numbers on your taste. The numbers ran back.'],
  spicy: ['Ladies and gentlemen, the defendant. Let the record show:', 'Your Spotify history walked into a bar. The bartender asked if it was okay.'],
};
/** The sign-off is always kind — the point is that you clearly love music. */
function closerFor(f: Record<string, unknown>, seed: number): string {
  const h = Number(f.hours ?? 0), a = Number(f.artists ?? 0);
  const opts = [
    `But ${fmtN(Math.round(h))} hours across ${fmtN(a)} artists? That's not a habit. That's a life with a soundtrack.`,
    `Still — ${fmtN(a)} artists. Most people never get past fifty. You're doing fine.`,
    `Honestly though: nobody spends ${fmtN(Math.round(h))} hours on something they don't love. Keep digging.`,
  ];
  return opts[Math.abs(seed) % opts.length];
}

export async function roastReceipts(heat: Heat = 'medium', seed = 0, period: Period = ALL_TIME): Promise<{ receipts: Receipt[]; facts: Record<string, unknown>; opener: string; closer: string }> {
  const P = playsWhere('p') + span(period);
  const whole = period.kind === 'all';
  const [t] = await query(`SELECT SUM(ms_played)/3600000.0 AS h, COUNT(*) AS n, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr,
      AVG(CASE WHEN EXTRACT(hour FROM played_at) BETWEEN 1 AND 4 THEN 1.0 ELSE 0 END) AS late, COUNT(DISTINCT artist_id) AS artists, MIN(played_at) AS first FROM plays_resolved p WHERE p.attended ${P}`);
  const [top] = await query(`SELECT artist_id, arg_max(artist_name, ms_played) AS a, SUM(ms_played)/3600000.0 AS h FROM plays_resolved p WHERE p.attended AND artist_id IS NOT NULL ${P} GROUP BY 1 ORDER BY h DESC LIMIT 1`);
  const [rep] = await query(`SELECT track_id, arg_max(track_name, ms_played) AS t, arg_max(artist_name, ms_played) AS a, COUNT(*) AS n FROM plays_resolved p WHERE p.attended AND track_id IS NOT NULL ${P} GROUP BY 1 ORDER BY n DESC LIMIT 1`);
  const [day] = await query(`SELECT arg_max(track_name, ms_played) AS t, arg_max(artist_name, ms_played) AS a, CAST(CAST(played_at AS DATE) AS VARCHAR) AS d, COUNT(*) AS n FROM plays_resolved p WHERE p.attended AND track_id IS NOT NULL ${P} GROUP BY track_id, CAST(played_at AS DATE) ORDER BY n DESC LIMIT 1`);
  const [skip] = await query(`SELECT arg_max(artist_name, ms_played) AS a, COUNT(*) AS n, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p WHERE artist_id IS NOT NULL ${P} GROUP BY artist_id HAVING COUNT(*) >= 40 ORDER BY sr DESC LIMIT 1`);
  const [ob] = await query(`SELECT SUM(o.obscurity * p.ms_played) / NULLIF(SUM(p.ms_played) FILTER (WHERE o.obscurity IS NOT NULL), 0) AS ob, MIN(o.listeners) AS minl FROM plays_resolved p LEFT JOIN artist_obscurity o USING (artist_id) WHERE p.attended ${P}`);
  const [liked] = await query(`SELECT COUNT(*) AS never FROM liked_songs l WHERE l.added_at < now() - INTERVAL 90 DAY AND NOT EXISTS (SELECT 1 FROM plays_resolved p WHERE p.track_id = l.track_id AND p.played_at > l.added_at)`);
  const [aband] = await query(`WITH a AS (SELECT album_id, COUNT(*) AS n, COUNT(DISTINCT CAST(played_at AS DATE)) AS d, MAX(played_at) AS last FROM plays_resolved p WHERE album_id IS NOT NULL ${P} GROUP BY 1) SELECT COUNT(*) FILTER (WHERE n <= 2 AND d <= 1 AND last < now() - INTERVAL 60 DAY) AS abandoned, COUNT(*) AS albums FROM a`);
  const [sess] = await query(`SELECT MAX(EXTRACT(epoch FROM (end_at - start_at)))/3600.0 AS longest FROM sessions s WHERE COALESCE(s.attention, 'active') <> 'unattended' ${period.from ? `AND s.start_at >= DATE '${period.from}' AND s.start_at < DATE '${period.to}'` : ''}`).catch(() => [{ longest: null }]);
  const [sc] = await query(`WITH s AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1) SELECT f.label, SUM(p.ms_played) * 1.0 / (SELECT SUM(ms_played) FROM plays_resolved p WHERE p.attended ${P}) AS share FROM plays_resolved p JOIN s USING (artist_id) JOIN scene_families f USING (scene) WHERE p.attended ${P} GROUP BY 1 ORDER BY share DESC LIMIT 1`);
  const [yr] = await query(`WITH f AS (SELECT artist_id, MIN(played_at) AS f FROM plays_resolved WHERE artist_id IS NOT NULL GROUP BY 1) SELECT AVG(CASE WHEN f.f >= now() - INTERVAL 365 DAY THEN 1.0 ELSE 0 END) AS newshare FROM plays_resolved p JOIN f USING (artist_id) WHERE p.played_at >= now() - INTERVAL 365 DAY AND p.attended ${P}`);

  const H = num(t?.h), topShare = H ? num(top?.h) / H : 0;
  const facts = { hours: Math.round(H), plays: num(t?.n), skipRate: num(t?.sr), lateNightShare: num(t?.late), artists: num(t?.artists), topArtist: str(top?.a), topArtistShare: topShare, mostPlayedTrack: rep ? { track: str(rep.t), artist: str(rep.a), plays: num(rep.n) } : null,
    oneDayRecord: day ? { track: str(day.t), artist: str(day.a), date: str(day.d), plays: num(day.n) } : null, mostSkippedButKeptPlaying: skip ? { artist: str(skip.a), plays: num(skip.n), skipRate: num(skip.sr) } : null,
    obscurity: ob?.ob == null ? null : num(ob.ob), likedNeverPlayed: num(liked?.never), albumsAbandoned: num(aband?.abandoned), albums: num(aband?.albums), longestSessionHours: sess?.longest == null ? null : num(sess.longest), topScene: sc ? { label: str(sc.label), share: num(sc.share) } : null, newArtistShareThisYear: yr?.newshare == null ? null : num(yr.newshare) };

  const s = (k: string) => [...k].reduce((a, c) => a + c.charCodeAt(0), seed);
  const spicy = heat === 'spicy', mild = heat === 'mild';
  const R: Receipt[] = [];
  if (facts.mostPlayedTrack && facts.mostPlayedTrack.plays >= (period.kind === 'week' ? 12 : period.kind === 'month' ? 20 : 40)) { const m = facts.mostPlayedTrack; R.push({ id: 'rep', weight: m.plays, link: `/track/${encodeURIComponent(String(rep.track_id))}`, receipt: `${m.plays} plays of “${m.track}” by ${m.artist}`,
    line: pick(mild ? [`You and “${m.track}” have a very committed relationship.`, `“${m.track}” is basically your ringtone at this point.`] : spicy ? [`You've played “${m.track}” ${m.plays} times. That's not a favourite song, that's a hostage situation.`, `${m.plays} plays of “${m.track}”. ${m.artist} should be paying you rent.`] : [`${m.plays} plays of “${m.track}”. At some point it stopped being a song and became furniture.`, `“${m.track}” has heard more of your life than most of your friends.`], s('rep')) }); }
  if (facts.oneDayRecord && facts.oneDayRecord.plays >= 8) { const d = facts.oneDayRecord; R.push({ id: 'day', weight: d.plays * 4, receipt: `${d.plays} plays of “${d.track}” on ${d.date}`,
    line: pick(spicy ? [`On ${d.date} you played “${d.track}” ${d.plays} times in one day. Whatever happened, the song didn't fix it.`, `${d.plays} times in a day. “${d.track}” filed a restraining order.`] : [`${d.date}: “${d.track}”, ${d.plays} times. We don't need to talk about it.`, `On ${d.date} “${d.track}” was on a ${d.plays}-play loop. Were you okay?`], s('day')) }); }
  if (topShare >= 0.06 && facts.topArtist) R.push({ id: 'top', weight: topShare * 400, link: top ? `/artist/${encodeURIComponent(String(top.artist_id))}` : undefined, receipt: `${pct(topShare)} of all your listening is ${facts.topArtist}`,
    line: pick(spicy ? [`${pct(topShare)} of everything you've ever played is ${facts.topArtist}. That's not taste, that's a fan club with one member.`, `${facts.topArtist} is ${pct(topShare)} of ${whole ? 'your record' : period.label}. Blink twice if they're holding you.`] : [`${facts.topArtist} is ${pct(topShare)} of your listening. Other artists exist, apparently.`, `One in every ${Math.max(2, Math.round(1 / topShare))} hours: ${facts.topArtist}. Loyalty is a virtue. Mostly.`], s('top')) });
  if (facts.lateNightShare >= 0.08) R.push({ id: 'late', weight: facts.lateNightShare * 300, receipt: `${pct(facts.lateNightShare)} of your plays happen between 1 and 5 a.m.`,
    line: pick(spicy ? [`${pct(facts.lateNightShare)} of your listening happens between 1 and 5 a.m. Your sleep schedule is a rumour.`, `A fifth of your record is after 1 a.m. The owls are worried about you.`] : [`${pct(facts.lateNightShare)} of your plays are after 1 a.m. Bedtime is more of a suggestion.`], s('late')) });
  if (facts.mostSkippedButKeptPlaying && facts.mostSkippedButKeptPlaying.skipRate >= 0.5) { const k = facts.mostSkippedButKeptPlaying; R.push({ id: 'skip', weight: k.plays * k.skipRate, receipt: `${k.artist}: ${k.plays} plays, ${pct(k.skipRate)} skipped`,
    line: pick(spicy ? [`You've started ${k.artist} ${k.plays} times and bailed on ${pct(k.skipRate)} of them. Just break up already.`, `${k.artist}, ${pct(k.skipRate)} skip rate across ${k.plays} plays. This is the musical equivalent of opening the fridge again.`] : [`${k.artist}: ${k.plays} attempts, ${pct(k.skipRate)} skipped. It's complicated.`], s('skip')) }); }
  if (facts.obscurity != null) R.push({ id: 'ob', weight: 30, receipt: `average obscurity ${Math.round(facts.obscurity * 100)} / 100`,
    line: facts.obscurity >= 0.3 ? pick(spicy ? ['Your average artist has fewer listeners than a mid-sized high school. You find this impressive. Nobody else does.', 'If an artist crosses 50,000 listeners you treat it like a betrayal.'] : ['You like your bands like your coffee shops: nobody else has heard of them.'], s('ob'))
      : facts.obscurity <= 0.15 ? pick(spicy ? ['Your "deep cuts" are on the front page of every streaming service. The algorithm thanks you for your service.', 'Bold of you to name this app Deep Cuts.'] : ['Your deep cuts are other people\'s singles.'], s('ob')) : 'Your obscurity score is squarely average. Even your niche is mainstream-adjacent.' });
  if (whole && facts.likedNeverPlayed >= 20) R.push({ id: 'liked', weight: facts.likedNeverPlayed / 2, receipt: `${facts.likedNeverPlayed} liked songs never played again after liking`,
    line: pick(spicy ? [`${facts.likedNeverPlayed} songs you "liked" and never played again. That's not a library, it's a landfill with hearts on it.`] : [`${facts.likedNeverPlayed} liked songs, never revisited. The heart button is doing a lot of lying.`], s('liked')) });
  if (facts.albumsAbandoned >= 20) R.push({ id: 'aband', weight: facts.albumsAbandoned / 3, link: '/crate?shelf=fresh', receipt: `${facts.albumsAbandoned} of ${facts.albums} albums pulled once and never again`,
    line: pick(spicy ? [`${facts.albumsAbandoned} albums you started and abandoned after one listen. Commitment issues, but make it vinyl.`] : [`${facts.albumsAbandoned} albums got one listen and a polite goodbye.`], s('aband')) });
  if (facts.longestSessionHours && facts.longestSessionHours >= 6) R.push({ id: 'sess', weight: facts.longestSessionHours * 3, receipt: `longest session ${facts.longestSessionHours.toFixed(1)} hours`,
    line: pick([`Your longest session ran ${facts.longestSessionHours.toFixed(1)} hours. Hydrate.`, `A ${Math.round(facts.longestSessionHours)}-hour session. Some people run marathons; you ran a playlist.`], s('sess')) });
  if (facts.topScene?.share && facts.topScene.share >= 0.2) R.push({ id: 'scene', weight: facts.topScene.share * 100, receipt: `${pct(facts.topScene.share)} of your hours are ${facts.topScene.label}`,
    line: spicy ? `${pct(facts.topScene.share)} ${facts.topScene.label}. You don't have a genre, you have a uniform.` : `${pct(facts.topScene.share)} of your hours are ${facts.topScene.label}. Range is a strong word.` });
  if (whole && facts.newArtistShareThisYear != null && facts.newArtistShareThisYear <= 0.08) R.push({ id: 'new', weight: 40, receipt: `only ${pct(facts.newArtistShareThisYear)} of this year's listening was artists new to you`,
    line: spicy ? `Only ${pct(facts.newArtistShareThisYear)} of this year was new artists. Your taste froze somewhere around your last haircut.` : `${pct(facts.newArtistShareThisYear)} new artists this year. Comfort food, every meal.` });
  // ---- Phase 9j: more evidence
  const [sh] = await query(`SELECT AVG(CASE WHEN shuffle THEN 1.0 ELSE 0 END) FILTER (WHERE shuffle IS NOT NULL) AS s FROM plays_resolved p WHERE p.attended ${P}`).catch(() => [{ s: null } as Record<string, unknown>]);
  const [quick] = await query(`SELECT COUNT(*) AS n FROM plays_resolved p WHERE was_skipped AND ms_played < 10000 ${P}`);
  const [onehit] = await query(`WITH a AS (SELECT artist_id, COUNT(DISTINCT track_id) AS t, COUNT(*) AS n FROM plays_resolved p WHERE artist_id IS NOT NULL ${P} GROUP BY 1) SELECT COUNT(*) FILTER (WHERE t = 1 AND n >= 15) AS n FROM a`);
  const [snd] = await query(`SELECT AVG(f.bpm) AS bpm, AVG(CASE WHEN f.mode = 0 THEN 1.0 ELSE 0 END) FILTER (WHERE f.mode IS NOT NULL) AS minor, COUNT(*) AS n FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found AND p.attended ${P}`).catch(() => [{ n: 0 } as Record<string, unknown>]);
  const [sad] = await query(`SELECT AVG(CASE WHEN lf.valence < -0.2 THEN 1.0 ELSE 0 END) AS sad, AVG(CASE WHEN EXTRACT(hour FROM p.played_at) BETWEEN 0 AND 4 AND lf.valence < -0.2 THEN 1.0 ELSE 0 END) AS latesad, COUNT(*) AS n FROM plays_resolved p JOIN track_lyric_features lf USING (track_id) WHERE lf.found AND lf.valence IS NOT NULL AND p.attended ${P}`).catch(() => [{ n: 0 } as Record<string, unknown>]);
  const [xmas] = await query(`SELECT COUNT(*) AS n FROM plays_resolved p JOIN artist_tags t USING (artist_id) WHERE lower(t.tag) IN ('christmas', 'xmas', 'holiday') AND EXTRACT(month FROM p.played_at) BETWEEN 2 AND 10 ${P}`).catch(() => [{ n: 0 } as Record<string, unknown>]);
  const [old] = await query(`SELECT AVG(CASE WHEN COALESCE(al.release_date, t.release_date) < DATE '2000-01-01' THEN 1.0 ELSE 0 END) FILTER (WHERE COALESCE(al.release_date, t.release_date) IS NOT NULL) AS s FROM plays_resolved p LEFT JOIN albums al USING (album_id) LEFT JOIN tracks t USING (track_id) WHERE p.attended ${P}`).catch(() => [{ s: null } as Record<string, unknown>]);
  const [guilty] = await query(`SELECT arg_max(p.artist_name, p.ms_played) AS a, SUM(p.ms_played)/3600000.0 AS h FROM plays_resolved p JOIN artist_popularity ap USING (artist_id) WHERE ap.listeners >= 3000000 AND p.attended ${P} GROUP BY p.artist_id ORDER BY h DESC LIMIT 1`).catch(() => [] as Record<string, unknown>[]);
  const [morn] = await query(`WITH f AS (SELECT CAST(played_at AS DATE) AS d, arg_min(track_id, played_at) AS t, arg_min(track_name, played_at) AS name FROM plays_resolved p WHERE EXTRACT(hour FROM played_at) BETWEEN 5 AND 11 ${P} GROUP BY 1) SELECT name, COUNT(*) AS n FROM f GROUP BY t, name ORDER BY n DESC LIMIT 1`);
  const [ab] = await query(`WITH h AS (SELECT COALESCE((SELECT value FROM app_meta WHERE key = 'home_country'), (SELECT arg_max(country, n) FROM (SELECT country, COUNT(*) n FROM plays_resolved WHERE country IS NOT NULL GROUP BY 1))) AS home)
      SELECT p.country AS cc, arg_max(p.artist_name, p.ms_played) AS a, SUM(CASE WHEN o.country = (SELECT home FROM h) THEN p.ms_played ELSE 0 END) * 1.0 / SUM(p.ms_played) AS homeart FROM plays_resolved p LEFT JOIN artist_origin o USING (artist_id)
      WHERE p.country IS NOT NULL AND p.country <> (SELECT home FROM h) ${P} GROUP BY 1 HAVING SUM(p.ms_played) > 3600000 ORDER BY SUM(p.ms_played) DESC LIMIT 1`).catch(() => [] as Record<string, unknown>[]);
  const [hoard] = await query(`SELECT COUNT(*) AS pl, COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM playlist_items i JOIN plays_resolved p USING (track_id) WHERE i.playlist_id = pl.playlist_id AND p.played_at > now() - INTERVAL 365 DAY)) AS cold FROM playlists pl WHERE owner_is_me`).catch(() => [{ pl: 0 } as Record<string, unknown>]);
  Object.assign(facts, { shuffleShare: sh?.s == null ? null : num(sh.s), judgedInTenSeconds: num(quick?.n), oneSongArtists: num(onehit?.n), meanBpm: num(snd?.n) > 50 ? num(snd?.bpm) : null, minorKeyShare: num(snd?.n) > 50 ? num(snd?.minor) : null,
    sadLyricShare: num(sad?.n) > 50 ? num(sad?.sad) : null, lateSadShare: num(sad?.n) > 50 ? num(sad?.latesad) : null, christmasOutOfSeason: num(xmas?.n), pre2000Share: old?.s == null ? null : num(old.s),
    mainstreamGuiltyPleasure: guilty ? { artist: str(guilty.a), hours: num(guilty.h) } : null, morningRitual: morn && num(morn.n) >= 8 ? { track: str(morn.name), mornings: num(morn.n) } : null,
    abroad: ab ? { country: str(ab.cc), topArtist: str(ab.a), homeArtistShare: num(ab.homeart) } : null, playlists: num(hoard?.pl), coldPlaylists: num(hoard?.cold) });
  const F = facts as Record<string, unknown> & typeof facts & { [k: string]: any };   // eslint-disable-line @typescript-eslint/no-explicit-any
  if (F.judgedInTenSeconds >= 200) R.push({ id: 'quick', weight: Math.min(80, F.judgedInTenSeconds / 20), receipt: `${fmtN(F.judgedInTenSeconds)} songs skipped inside ten seconds`,
    line: pick(spicy ? [`You've rejected ${fmtN(F.judgedInTenSeconds)} songs in under ten seconds. Simon Cowell thinks you're harsh.`, `${fmtN(F.judgedInTenSeconds)} songs dismissed before the first chorus. Musicians spend years on these.`] : [`${fmtN(F.judgedInTenSeconds)} songs got less than ten seconds to make their case. Tough room.`], s('quick')) });
  if (F.shuffleShare != null && F.shuffleShare >= 0.6) R.push({ id: 'shuf', weight: 25, receipt: `${pct(F.shuffleShare)} of plays on shuffle`,
    line: pick(spicy ? [`${pct(F.shuffleShare)} shuffle. Albums have an order. Artists chose it. You pressed a button that says "I know better".`] : [`${pct(F.shuffleShare)} of your listening is on shuffle. Commitment, but make it random.`], s('shuf')) });
  if (F.oneSongArtists >= 15) R.push({ id: 'onehit', weight: F.oneSongArtists / 2, receipt: `${F.oneSongArtists} artists you've played 15+ times — always the same one song`,
    line: pick(spicy ? [`${F.oneSongArtists} artists where you know exactly one song and have played it to death. You're not a fan, you're a hostage negotiator.`] : [`${F.oneSongArtists} artists, one song each, on repeat. The rest of their discography sends its regards.`], s('onehit')) });
  if (F.meanBpm && F.meanBpm < 100) R.push({ id: 'bpm', weight: 30, receipt: `average tempo ${Math.round(F.meanBpm)} bpm`,
    line: spicy ? `Your music averages ${Math.round(F.meanBpm)} bpm. That's a resting heart rate, not a playlist.` : `An average of ${Math.round(F.meanBpm)} bpm. Your listening moves at the speed of a Sunday.` });
  if (F.meanBpm && F.meanBpm > 128) R.push({ id: 'bpm2', weight: 30, receipt: `average tempo ${Math.round(F.meanBpm)} bpm`, line: `${Math.round(F.meanBpm)} bpm on average. Everything you play sounds like it's late for something.` });
  if (F.minorKeyShare != null && F.minorKeyShare >= 0.55) R.push({ id: 'minor', weight: 35, receipt: `${pct(F.minorKeyShare)} of plays in a minor key`,
    line: spicy ? `${pct(F.minorKeyShare)} of your listening is in a minor key. Even your happy songs are sad about it.` : `${pct(F.minorKeyShare)} minor keys. Brooding is a lifestyle, apparently.` });
  if (F.lateSadShare != null && F.lateSadShare >= 0.04) R.push({ id: 'latesad', weight: 45, receipt: `${pct(F.lateSadShare)} of your plays are bleak-lyric songs after midnight`,
    line: spicy ? `Sad lyrics, after midnight, ${pct(F.lateSadShare)} of the time. Nobody who's fine does this.` : `After midnight you reach for the saddest lyrics in your library. Have some water. Maybe text someone.` });
  if (F.christmasOutOfSeason >= 10) R.push({ id: 'xmas', weight: 40, receipt: `${F.christmasOutOfSeason} Christmas-tagged plays between February and October`,
    line: pick([`${F.christmasOutOfSeason} Christmas plays outside of Christmas. In July. We have questions.`, `You played Christmas music in ${F.christmasOutOfSeason} non-festive moments. Santa has you on a list, and it's not the nice one.`], s('xmas')) });
  if (F.pre2000Share != null && F.pre2000Share >= 0.6) R.push({ id: 'old', weight: 35, receipt: `${pct(F.pre2000Share)} of your listening released before 2000`,
    line: spicy ? `${pct(F.pre2000Share)} of your music predates the year 2000. You're not a crate digger, you're a museum with a skip button.` : `${pct(F.pre2000Share)} of it came out last millennium. Born in the wrong decade, and you'll tell everyone.` });
  if (F.mainstreamGuiltyPleasure && facts.obscurity != null && facts.obscurity >= 0.22 && F.mainstreamGuiltyPleasure.hours >= 5) R.push({ id: 'guilty', weight: 50, receipt: `${Math.round(F.mainstreamGuiltyPleasure.hours)} h of ${F.mainstreamGuiltyPleasure.artist} (3M+ listeners) in an otherwise obscure record`,
    line: spicy ? `For someone who "only listens to underground stuff", you've spent ${Math.round(F.mainstreamGuiltyPleasure.hours)} hours with ${F.mainstreamGuiltyPleasure.artist}. We see you.` : `Deep cuts all round — and then ${Math.round(F.mainstreamGuiltyPleasure.hours)} hours of ${F.mainstreamGuiltyPleasure.artist}. Everybody has one.` });
  if (F.morningRitual) R.push({ id: 'morn', weight: 30, receipt: `“${F.morningRitual.track}” was your first song on ${F.morningRitual.mornings} mornings`,
    line: `“${F.morningRitual.track}” has opened ${F.morningRitual.mornings} of your mornings. It's not a song, it's an alarm clock with feelings.` });
  if (F.abroad && F.abroad.homeArtistShare >= 0.6) R.push({ id: 'abroad', weight: 35, receipt: `in ${F.abroad.country} ${pct(F.abroad.homeArtistShare)} of what you played was from home`,
    line: `You flew all the way to ${F.abroad.country} and ${pct(F.abroad.homeArtistShare)} of what you played was from home. The locals had music, you know.` });
  if (whole && F.playlists >= 10 && F.coldPlaylists / F.playlists >= 0.5) R.push({ id: 'hoard', weight: 30, receipt: `${F.coldPlaylists} of your ${F.playlists} playlists untouched for a year`,
    line: spicy ? `${F.coldPlaylists} of your ${F.playlists} playlists haven't been played in a year. You don't curate, you hoard.` : `${F.coldPlaylists} playlists gathering dust. Each one was going to be "the one".` });
  R.push(...(await nicheReceipts(P, period, heat, s)));
  Object.assign(facts, { period: period.label });
  // a different joke order per seed among near-equal weights, so "Different jokes" also reshuffles which receipts make the cut
  const sorted = R.map((r) => ({ r, k: r.weight * (0.85 + ((s(r.id) * 9301 + 49297) % 233280) / 233280 * 0.3) })).sort((a, b) => b.k - a.k).map((x) => x.r).slice(0, 12);
  return { receipts: sorted, facts, opener: period.kind === 'all' ? pick(OPENERS[heat], s('open')) : `${pick(OPENERS[heat], s('open'))} Today's exhibit: ${period.label}.`, closer: closerFor(facts, s('close')) };
}

/** Optional receipts fail soft (a table may be empty on a fresh record); smoke tests set this to see why. */
const dbg = (e: unknown) => { if ((globalThis as { __ROAST_DEBUG?: boolean }).__ROAST_DEBUG) console.log('roast query failed:', String(e).slice(0, 300)); };
// ---------------------------------------------------------------------------------------------------------------- Phase 10d
/** More niche, more personal receipts (owner: "more niche and personalised"). Each is a real pattern in the period. */
async function nicheReceipts(P: string, period: Period, heat: Heat, s: (k: string) => number): Promise<Receipt[]> {
  const spicy = heat === 'spicy', mild = heat === 'mild';
  const R: Receipt[] = [];
  const one = async (sql: string) => (await query(sql).catch((e) => { dbg(e); return [] as Record<string, unknown>[]; }))[0];
  const short = period.kind === 'week' || period.kind === 'month';

  // 1. one song, day after day
  const streak = await one(`WITH d AS (SELECT DISTINCT track_id, CAST(played_at AS DATE) AS d FROM plays_resolved p WHERE track_id IS NOT NULL ${P}),
      g AS (SELECT track_id, d, d - CAST(ROW_NUMBER() OVER (PARTITION BY track_id ORDER BY d) AS INTEGER) AS grp FROM d)
      SELECT g.track_id, ANY_VALUE(t.name) AS t, COUNT(*) AS days FROM g JOIN tracks t USING (track_id) GROUP BY g.track_id, grp ORDER BY days DESC LIMIT 1`);
  if (streak && num(streak.days) >= (short ? 5 : 9)) R.push({ id: 'streak', weight: Math.min(90, num(streak.days) * 3), link: `/track/${encodeURIComponent(String(streak.track_id))}`, receipt: `“${str(streak.t)}” played ${num(streak.days)} days in a row`,
    line: pick(spicy ? [`${num(streak.days)} consecutive days of “${str(streak.t)}”. That's not a song, it's a medication schedule.`, `“${str(streak.t)}”, ${num(streak.days)} days straight. Even the song wanted a day off.`] : [`“${str(streak.t)}” showed up ${num(streak.days)} days running. Attendance: perfect.`], s('streak')) });

  // 2. one artist, back to back
  const run = await one(`WITH o AS (SELECT artist_id, artist_name, played_at, ROW_NUMBER() OVER (ORDER BY played_at) - ROW_NUMBER() OVER (PARTITION BY artist_id ORDER BY played_at) AS g FROM plays_resolved p WHERE artist_id IS NOT NULL ${P})
      SELECT arg_max(artist_name, played_at) AS a, COUNT(*) AS n, CAST(CAST(MIN(played_at) AS DATE) AS VARCHAR) AS d FROM o GROUP BY artist_id, g ORDER BY n DESC LIMIT 1`);
  if (run && num(run.n) >= 25) R.push({ id: 'run', weight: Math.min(80, num(run.n)), receipt: `${num(run.n)} ${str(run.a)} songs back to back on ${str(run.d)}`,
    line: pick(spicy ? [`${num(run.n)} ${str(run.a)} tracks in a row on ${str(run.d)}. At that point you're not listening, you're auditing their catalogue.`] : [`On ${str(run.d)} you played ${num(run.n)} ${str(run.a)} songs without a break. A deep dive, or a hostage situation.`], s('run')) });

  // 3. the 3 a.m. confessional
  const late = await one(`SELECT arg_max(track_name, ms_played) AS t, arg_max(artist_name, ms_played) AS a, COUNT(*) AS n FROM plays_resolved p WHERE EXTRACT(hour FROM played_at) BETWEEN 2 AND 4 AND track_id IS NOT NULL ${P} GROUP BY track_id ORDER BY n DESC LIMIT 1`);
  if (late && num(late.n) >= (short ? 3 : 6)) R.push({ id: '3am', weight: num(late.n) * 4, receipt: `“${str(late.t)}” played ${num(late.n)} times between 2 and 5 a.m.`,
    line: pick(spicy ? [`Your 3 a.m. anthem is “${str(late.t)}” by ${str(late.a)}. ${num(late.n)} times. Whatever you were texting, don't.`, `“${str(late.t)}”, ${num(late.n)} plays in the small hours. That song knows things about you.`] : [`“${str(late.t)}” is what you play at 3 a.m. — ${num(late.n)} times. Get some sleep.`], s('3am')) });

  // 4. the commute DJ
  const comm = await one(`SELECT arg_max(artist_name, ms_played) AS a, SUM(ms_played)/3600000.0 AS h, SUM(ms_played) * 1.0 / SUM(SUM(ms_played)) OVER () AS share FROM plays_resolved p
      WHERE EXTRACT(isodow FROM played_at) <= 5 AND EXTRACT(hour FROM played_at) BETWEEN 7 AND 8 AND artist_id IS NOT NULL ${P} GROUP BY artist_id ORDER BY h DESC LIMIT 1`);
  if (comm && num(comm.share) >= 0.2 && num(comm.h) >= (short ? 0.7 : 3)) R.push({ id: 'commute', weight: num(comm.share) * 120, receipt: `${pct(num(comm.share))} of your weekday 7–9 a.m. is ${str(comm.a)}`,
    line: mild ? `Weekday mornings belong to ${str(comm.a)}. ${pct(num(comm.share))} of them.` : `${pct(num(comm.share))} of your weekday mornings are ${str(comm.a)}. The commute has one DJ and they're exhausted.` });

  // 5. two different people: weekday vs weekend
  const split = await query(`SELECT CASE WHEN EXTRACT(isodow FROM played_at) >= 6 THEN 'we' ELSE 'wd' END AS k, arg_max(artist_name, ms_played) AS a, SUM(ms_played) AS ms FROM plays_resolved p WHERE artist_id IS NOT NULL ${P} GROUP BY 1, artist_id QUALIFY ROW_NUMBER() OVER (PARTITION BY k ORDER BY ms DESC) = 1`).catch(() => []);
  const wd = split.find((r) => r.k === 'wd'), we = split.find((r) => r.k === 'we');
  if (wd && we && str(wd.a) !== str(we.a)) R.push({ id: 'split', weight: 28, receipt: `weekdays: ${str(wd.a)}; weekends: ${str(we.a)}`,
    line: spicy ? `Monday to Friday you're a ${str(wd.a)} person. Come Saturday it's all ${str(we.a)}. Pick a personality.` : `Weekday you: ${str(wd.a)}. Weekend you: ${str(we.a)}. Do they know about each other?` });

  // 6. judged before the intro ends
  const intro = await one(`SELECT arg_max(artist_name, ms_played) AS a, COUNT(*) AS n FROM plays_resolved p WHERE was_skipped AND ms_played < 30000 AND artist_id IS NOT NULL ${P} GROUP BY artist_id ORDER BY n DESC LIMIT 1`);
  if (intro && num(intro.n) >= (short ? 8 : 30)) R.push({ id: 'intro', weight: Math.min(70, num(intro.n) / 2), receipt: `${num(intro.n)} ${str(intro.a)} songs skipped inside 30 seconds`,
    line: pick([`You've skipped ${str(intro.a)} before the 30-second mark ${num(intro.n)} times. And yet you keep pressing play. Be honest with yourself.`, `${num(intro.n)} ${str(intro.a)} intros, abandoned. You don't hate them — you hate their intros.`], s('intro')) });

  // 7. long songs you couldn't finish
  const epic = await one(`SELECT COUNT(*) AS n, arg_max(p.track_name, t.duration_ms) AS t FROM plays_resolved p JOIN tracks t USING (track_id) WHERE t.duration_ms > 420000 AND p.was_skipped AND p.ms_played < t.duration_ms / 2 ${P}`);
  if (epic && num(epic.n) >= (short ? 4 : 12)) R.push({ id: 'epic', weight: num(epic.n), receipt: `${num(epic.n)} seven-minute-plus songs bailed on before halfway`,
    line: spicy ? `You love the idea of a seven-minute song. ${num(epic.n)} times you've bailed before minute four. Attention span of a trailer.` : `${num(epic.n)} long songs abandoned halfway — including “${str(epic.t)}”. The best part was coming, allegedly.` });

  // 8. skipping your own liked songs
  const lk = await one(`SELECT COUNT(*) AS n, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p JOIN liked_songs l USING (track_id) WHERE TRUE ${P}`);
  if (lk && num(lk.n) >= 50 && num(lk.sr) >= 0.25) R.push({ id: 'likedskip', weight: num(lk.sr) * 100, receipt: `${pct(num(lk.sr))} of plays of your own liked songs get skipped`,
    line: spicy ? `You skip ${pct(num(lk.sr))} of the songs you personally hearted. Your own library is swiping left on itself.` : `You skip ${pct(num(lk.sr))} of your own liked songs. The heart wants what it wants — just not right now.` });

  // 9–10. what your lyrics are about / how they feel (the local model's tags)
  const th = await one(`WITH t AS (SELECT track_id, unnest(COALESCE(llm_themes, themes)) AS theme FROM track_lyrics_effective), tot AS (SELECT COUNT(*) AS n FROM plays_resolved p JOIN (SELECT DISTINCT track_id FROM t) USING (track_id) WHERE TRUE ${P})
      SELECT t.theme, COUNT(*) * 1.0 / ANY_VALUE(tot.n) AS share, ANY_VALUE(tot.n) AS base FROM plays_resolved p JOIN t USING (track_id), tot WHERE TRUE ${P} GROUP BY 1 ORDER BY share DESC LIMIT 1`);
  if (th && num(th.base) >= (short ? 20 : 150) && num(th.share) >= 0.2) R.push({ id: 'theme', weight: num(th.share) * 110, link: '/lyrics', receipt: `${pct(num(th.share))} of the songs you played with readable lyrics are about ${str(th.theme)}`,
    line: pick(spicy ? [`${pct(num(th.share))} of your lyrics are about ${str(th.theme)}. Your playlist is a group chat that only discusses one thing.`, `${str(th.theme)}: ${pct(num(th.share))} of your lyrics. We get it. We've all gotten it.`] : [`${pct(num(th.share))} of what your songs sing about is ${str(th.theme)}. A theme, or a cry for help — hard to say.`], s('theme')) });
  const md = await one(`SELECT e.llm_mood AS m, COUNT(*) * 1.0 / SUM(COUNT(*)) OVER () AS share, SUM(COUNT(*)) OVER () AS base FROM plays_resolved p JOIN track_lyrics_effective e USING (track_id) WHERE e.llm_mood IN (${MOOD_IDS.map((m) => `'${m}'`).join(', ')}) ${P} GROUP BY 1 ORDER BY share DESC LIMIT 1`);
  if (md && num(md.base) >= (short ? 15 : 100) && num(md.share) >= 0.18) R.push({ id: 'mood', weight: num(md.share) * 100, link: '/lyrics', receipt: `your songs' most common mood: ${str(md.m)} (${pct(num(md.share))})`,
    line: spicy ? `Your local model read your lyrics and the verdict is “${str(md.m)}”. ${pct(num(md.share))} of the time. Even the AI is worried.` : `The mood of your music is “${str(md.m)}” — ${pct(num(md.share))} of it. Very on brand.` });

  // 11. summer songs in winter
  const sum = await one(`SELECT COUNT(*) AS n FROM plays_resolved p JOIN track_lyrics_effective e USING (track_id) WHERE (list_contains(e.themes, 'sun & summer') OR list_contains(COALESCE(e.llm_themes, []::VARCHAR[]), 'sun & summer')) AND EXTRACT(month FROM p.played_at) IN (12, 1, 2) ${P}`);
  if (sum && num(sum.n) >= 12) R.push({ id: 'summerwinter', weight: 30, receipt: `${num(sum.n)} plays of songs about summer in December–February`,
    line: `${num(sum.n)} songs about sunshine, played in the dead of winter. Manifesting, or denial?` });

  // 12. the word you can't stop picking
  const tw = await one(`WITH w AS (SELECT DISTINCT track_id, unnest(string_split(regexp_replace(lower(track_name), '[^a-z ]', ' ', 'g'), ' ')) AS w FROM plays_resolved p WHERE track_id IS NOT NULL ${P})
      SELECT w, COUNT(*) AS n FROM w WHERE length(w) >= 4 AND w NOT IN ('with', 'from', 'that', 'this', 'your', 'remix', 'edit', 'version', 'remastered', 'remaster', 'live', 'feat', 'radio', 'original', 'mix', 'what', 'when', 'have', 'like', 'just', 'dont', 'into', 'about', 'there', 'mono', 'stereo', 'single', 'album', 'demo')
      GROUP BY 1 ORDER BY n DESC LIMIT 1`);
  if (tw && num(tw.n) >= (short ? 5 : 14)) R.push({ id: 'titleword', weight: Math.min(55, num(tw.n) * 1.5), receipt: `${num(tw.n)} different songs with “${str(tw.w)}” in the title`,
    line: `You played ${num(tw.n)} different songs with “${str(tw.w)}” in the title. Your taste has a keyword and it's “${str(tw.w)}”.` });

  // 13. rave at 2 a.m.
  const bpm = await one(`SELECT AVG(f.bpm) AS b, COUNT(*) AS n FROM plays_resolved p JOIN track_features f USING (track_id) WHERE f.found AND EXTRACT(hour FROM p.played_at) BETWEEN 1 AND 4 ${P}`);
  if (bpm && num(bpm.n) >= 25 && num(bpm.b) >= 122) R.push({ id: 'latebpm', weight: 32, receipt: `your 1–5 a.m. music averages ${Math.round(num(bpm.b))} bpm`,
    line: `Between 1 and 5 a.m. your music averages ${Math.round(num(bpm.b))} bpm. Most people wind down. You're warming up.` });

  // 14. sunny days, indoors
  const wx = await one(`WITH d AS (SELECT CAST(played_at AS DATE) AS d, SUM(ms_played)/60000.0 AS m FROM plays_resolved p WHERE TRUE ${P} GROUP BY 1)
      SELECT AVG(d.m) FILTER (WHERE w.bucket IN ('sunny', 'clear')) AS sun, AVG(d.m) FILTER (WHERE w.bucket IN ('rain', 'storm', 'drizzle')) AS rain, COUNT(*) FILTER (WHERE w.bucket IN ('sunny', 'clear')) AS ns FROM d JOIN weather_daily w ON w.date = d.d`);
  if (wx && num(wx.ns) >= (short ? 2 : 10) && num(wx.sun) > num(wx.rain) * 1.15 && num(wx.rain) > 0) R.push({ id: 'sunny', weight: 30, receipt: `${Math.round(num(wx.sun))} min a day on sunny days vs ${Math.round(num(wx.rain))} on rainy ones`,
    line: spicy ? `You listen more on sunny days (${Math.round(num(wx.sun))} min) than rainy ones (${Math.round(num(wx.rain))}). The sun came out and you put your headphones on. Go outside.` : `Sunny days get more of your listening than rainy ones. Somebody's avoiding the weather.` });

  // 15. explicit
  const ex = await one(`SELECT AVG(CASE WHEN t.explicit THEN 1.0 ELSE 0 END) AS s, COUNT(*) AS n FROM plays_resolved p JOIN tracks t USING (track_id) WHERE t.explicit IS NOT NULL ${P}`);
  if (ex && num(ex.n) >= 100 && num(ex.s) >= 0.4) R.push({ id: 'explicit', weight: 26, receipt: `${pct(num(ex.s))} of your plays carry the explicit tag`,
    line: `${pct(num(ex.s))} explicit. Your speakers need a swear jar.` });

  // 16. ghosted (only for a period: who was big the period before and silent now)
  if (period.from && period.to) {
    const len = Math.round((new Date(period.to).getTime() - new Date(period.from).getTime()) / 86400000);
    const gh = await one(`WITH prev AS (SELECT artist_id, arg_max(artist_name, ms_played) AS a, SUM(ms_played)/3600000.0 AS h FROM plays_resolved p WHERE artist_id IS NOT NULL AND p.played_at >= DATE '${period.from}' - INTERVAL ${len} DAY AND p.played_at < DATE '${period.from}' ${playsWhere('p')} GROUP BY 1 ORDER BY h DESC LIMIT 5)
        SELECT a, h FROM prev WHERE NOT EXISTS (SELECT 1 FROM plays_resolved p WHERE p.artist_id = prev.artist_id ${P}) ORDER BY h DESC LIMIT 1`);
    if (gh && num(gh.h) >= 1) R.push({ id: 'ghost', weight: 45, receipt: `${str(gh.a)}: ${num(gh.h).toFixed(1)} h the period before, zero now`,
      line: spicy ? `${str(gh.a)} was in your top five last time. This time: nothing. Not a call, not a text. You ghosted them.` : `Last time ${str(gh.a)} was a regular. This time, not a single play. Everything okay between you two?` });
  }
  return R;
}

/** Everything the model may use: the receipts plus a broad, compact picture of the period. Names and numbers only. */
export async function roastDossier(period: Period, receipts: Receipt[], facts: Record<string, unknown>) {
  const P = playsWhere('p') + span(period);
  const safe = (sql: string) => query(sql).catch((e) => { dbg(e); return [] as Record<string, unknown>[]; });
  const [artists, tracks, albums, parts, days, scenes, tags, moods, themes, firsts] = await Promise.all([
    safe(`SELECT arg_max(artist_name, ms_played) AS a, ROUND(SUM(ms_played)/3600000.0, 1) AS h, COUNT(*) AS n, ROUND(AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) * 100) AS skip FROM plays_resolved p WHERE artist_id IS NOT NULL ${P} GROUP BY artist_id ORDER BY h DESC LIMIT 10`),
    safe(`SELECT arg_max(track_name, ms_played) AS t, arg_max(artist_name, ms_played) AS a, COUNT(*) AS n FROM plays_resolved p WHERE track_id IS NOT NULL ${P} GROUP BY track_id ORDER BY n DESC LIMIT 10`),
    safe(`SELECT arg_max(album_name, ms_played) AS al, arg_max(artist_name, ms_played) AS a, COUNT(*) AS n FROM plays_resolved p WHERE album_id IS NOT NULL ${P} GROUP BY album_id ORDER BY n DESC LIMIT 5`),
    safe(`SELECT CASE WHEN h BETWEEN 5 AND 11 THEN 'morning' WHEN h BETWEEN 12 AND 16 THEN 'afternoon' WHEN h BETWEEN 17 AND 22 THEN 'evening' ELSE 'late night' END AS k, ROUND(SUM(ms_played)/3600000.0, 1) AS v FROM (SELECT EXTRACT(hour FROM played_at) AS h, * FROM plays_resolved) p WHERE TRUE ${P} GROUP BY 1`),
    safe(`SELECT strftime(played_at, '%A') AS k, ROUND(SUM(ms_played)/3600000.0, 1) AS v FROM plays_resolved p WHERE TRUE ${P} GROUP BY 1 ORDER BY v DESC`),
    safe(`WITH s AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1) SELECT f.label AS k, ROUND(SUM(p.ms_played)/3600000.0, 1) AS v FROM plays_resolved p JOIN s USING (artist_id) JOIN scene_families f USING (scene) WHERE TRUE ${P} GROUP BY 1 ORDER BY v DESC LIMIT 6`),
    safe(`SELECT lower(t.tag) AS k, ROUND(SUM(p.ms_played)/3600000.0, 1) AS v FROM plays_resolved p JOIN artist_tags t USING (artist_id) WHERE TRUE ${P} GROUP BY 1 ORDER BY v DESC LIMIT 10`),
    safe(`SELECT e.llm_mood AS k, COUNT(*) AS v FROM plays_resolved p JOIN track_lyrics_effective e USING (track_id) WHERE e.llm_mood IN (${MOOD_IDS.map((m) => `'${m}'`).join(', ')}) ${P} GROUP BY 1 ORDER BY v DESC LIMIT 5`),
    safe(`SELECT theme AS k, COUNT(*) AS v FROM plays_resolved p JOIN (SELECT track_id, unnest(COALESCE(llm_themes, themes)) AS theme FROM track_lyrics_effective) e USING (track_id) WHERE TRUE ${P} GROUP BY 1 ORDER BY v DESC LIMIT 6`),
    period.from ? safe(`WITH f AS (SELECT artist_id, arg_max(artist_name, ms_played) AS a, MIN(played_at) AS first, COUNT(*) FILTER (WHERE TRUE ${P}) AS n FROM plays_resolved p WHERE artist_id IS NOT NULL GROUP BY 1)
      SELECT a, n FROM f WHERE first >= DATE '${period.from}' AND first < DATE '${period.to}' ORDER BY n DESC LIMIT 5`) : Promise.resolve([] as Record<string, unknown>[]),
  ]);
  const kv = (rows: Record<string, unknown>[]) => Object.fromEntries(rows.map((r) => [String(r.k), num(r.v)]));
  return {
    period: period.label, ...facts,
    topArtists: artists.map((r) => `${str(r.a)}: ${num(r.h)} h, ${num(r.n)} plays, ${num(r.skip)}% skipped`),
    topSongs: tracks.map((r) => `“${str(r.t)}” by ${str(r.a)} ×${num(r.n)}`),
    topAlbums: albums.map((r) => `${str(r.al)} — ${str(r.a)} (${num(r.n)} plays)`),
    hoursByPartOfDay: kv(parts), hoursByWeekday: kv(days), scenes: kv(scenes), genreTags: kv(tags), lyricMoods: kv(moods), lyricThemes: kv(themes),
    newArtistsThisPeriod: firsts.map((r) => `${str(r.a)} (${num(r.n)} plays)`),
    receipts: receipts.map((r) => r.receipt),
  };
}

/** The local model writes the routine from the dossier. Saved (llm_writings) like Liner Notes; never invents. */
export function roastMessages(heat: Heat, dossier: Record<string, unknown>): ChatMsg[] {
  const tone = heat === 'mild' ? 'gentle and affectionate, like a friend teasing' : heat === 'spicy' ? 'savage but still loving — a comedy-club roast, sharp punchlines, callbacks' : 'playful with some bite';
  return [
    { role: 'system', content: `You are a stand-up comic roasting one person's MUSIC LISTENING HABITS at their request, for ${String(dossier.period)}. Tone: ${tone}.
Be creative: find the funny connections BETWEEN facts (a top artist vs their skip rate, the lyric moods vs the time of day, the weekday vs weekend split, the genres vs the songs), use callbacks, give the listener a comic persona built from the evidence.
Hard rules: use ONLY names and numbers in the dossier — never invent songs, artists, numbers or events, and quote numbers exactly. Roast the listening, never the person: nothing about appearance, identity, body, health, money, relationships or intelligence, no slurs, no profanity beyond "damn". 200–300 words in 6–10 short paragraphs or one-liners, then one genuinely kind closing line about their taste. Plain text, no headings, no emoji, no lists.` },
    { role: 'user', content: `The dossier (JSON):\n${JSON.stringify(dossier)}\n\nRoast me.` },
  ];
}

export async function llmRoast(heat: Heat, receipts: Receipt[], facts: Record<string, unknown>, period: Period = ALL_TIME): Promise<{ text: string; model: string }> {
  const st = await llmStatus();
  if (!st.reachable || !st.models.length) throw new Error('No local model reachable — start Ollama and pick a model in Settings → Local model.');
  const model = currentModel(st.models);
  const messages = roastMessages(heat, await roastDossier(period, receipts, facts));
  const text = await invoke<string>('llm_chat', { model, messages, jsonMode: false, temperature: heat === 'spicy' ? 0.95 : 0.8, purpose: 'roast' });
  return { text: text.trim(), model };
}
