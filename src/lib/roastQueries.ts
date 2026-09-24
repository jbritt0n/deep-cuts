/**
 * Phase 9i — Roast Me. The receipts are facts from your record; the jokes are built on them. The local model (when
 * connected) gets only these receipts, so it can't invent things about you. Every line is about listening habits —
 * never about who you are.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { currentModel, llmStatus, type ChatMsg } from './ask';

export type Heat = 'mild' | 'medium' | 'spicy';
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

export async function roastReceipts(heat: Heat = 'medium', seed = 0): Promise<{ receipts: Receipt[]; facts: Record<string, unknown>; opener: string; closer: string }> {
  const P = playsWhere('p');
  const [t] = await query(`SELECT SUM(ms_played)/3600000.0 AS h, COUNT(*) AS n, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr,
      AVG(CASE WHEN EXTRACT(hour FROM played_at) BETWEEN 1 AND 4 THEN 1.0 ELSE 0 END) AS late, COUNT(DISTINCT artist_id) AS artists, MIN(played_at) AS first FROM plays_resolved p WHERE p.attended ${P}`);
  const [top] = await query(`SELECT artist_id, arg_max(artist_name, ms_played) AS a, SUM(ms_played)/3600000.0 AS h FROM plays_resolved p WHERE p.attended AND artist_id IS NOT NULL ${P} GROUP BY 1 ORDER BY h DESC LIMIT 1`);
  const [rep] = await query(`SELECT track_id, arg_max(track_name, ms_played) AS t, arg_max(artist_name, ms_played) AS a, COUNT(*) AS n FROM plays_resolved p WHERE p.attended AND track_id IS NOT NULL ${P} GROUP BY 1 ORDER BY n DESC LIMIT 1`);
  const [day] = await query(`SELECT arg_max(track_name, ms_played) AS t, arg_max(artist_name, ms_played) AS a, CAST(CAST(played_at AS DATE) AS VARCHAR) AS d, COUNT(*) AS n FROM plays_resolved p WHERE p.attended AND track_id IS NOT NULL ${P} GROUP BY track_id, CAST(played_at AS DATE) ORDER BY n DESC LIMIT 1`);
  const [skip] = await query(`SELECT arg_max(artist_name, ms_played) AS a, COUNT(*) AS n, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved p WHERE artist_id IS NOT NULL ${P} GROUP BY artist_id HAVING COUNT(*) >= 40 ORDER BY sr DESC LIMIT 1`);
  const [ob] = await query(`SELECT SUM(o.obscurity * p.ms_played) / NULLIF(SUM(p.ms_played) FILTER (WHERE o.obscurity IS NOT NULL), 0) AS ob, MIN(o.listeners) AS minl FROM plays_resolved p LEFT JOIN artist_obscurity o USING (artist_id) WHERE p.attended ${P}`);
  const [liked] = await query(`SELECT COUNT(*) AS never FROM liked_songs l WHERE l.added_at < now() - INTERVAL 90 DAY AND NOT EXISTS (SELECT 1 FROM plays_resolved p WHERE p.track_id = l.track_id AND p.played_at > l.added_at)`);
  const [aband] = await query(`WITH a AS (SELECT album_id, COUNT(*) AS n, COUNT(DISTINCT CAST(played_at AS DATE)) AS d, MAX(played_at) AS last FROM plays_resolved p WHERE album_id IS NOT NULL ${P} GROUP BY 1) SELECT COUNT(*) FILTER (WHERE n <= 2 AND d <= 1 AND last < now() - INTERVAL 60 DAY) AS abandoned, COUNT(*) AS albums FROM a`);
  const [sess] = await query(`SELECT MAX(EXTRACT(epoch FROM (ended_at - started_at)))/3600.0 AS longest FROM sessions`).catch(() => [{ longest: null }]);
  const [sc] = await query(`WITH s AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1) SELECT f.label, SUM(p.ms_played) * 1.0 / (SELECT SUM(ms_played) FROM plays_resolved p WHERE p.attended ${P}) AS share FROM plays_resolved p JOIN s USING (artist_id) JOIN scene_families f USING (scene) WHERE p.attended ${P} GROUP BY 1 ORDER BY share DESC LIMIT 1`);
  const [yr] = await query(`WITH f AS (SELECT artist_id, MIN(played_at) AS f FROM plays_resolved WHERE artist_id IS NOT NULL GROUP BY 1) SELECT AVG(CASE WHEN f.f >= now() - INTERVAL 365 DAY THEN 1.0 ELSE 0 END) AS newshare FROM plays_resolved p JOIN f USING (artist_id) WHERE p.played_at >= now() - INTERVAL 365 DAY AND p.attended ${P}`);

  const H = num(t?.h), topShare = H ? num(top?.h) / H : 0;
  const facts = { hours: Math.round(H), plays: num(t?.n), skipRate: num(t?.sr), lateNightShare: num(t?.late), artists: num(t?.artists), topArtist: str(top?.a), topArtistShare: topShare, mostPlayedTrack: rep ? { track: str(rep.t), artist: str(rep.a), plays: num(rep.n) } : null,
    oneDayRecord: day ? { track: str(day.t), artist: str(day.a), date: str(day.d), plays: num(day.n) } : null, mostSkippedButKeptPlaying: skip ? { artist: str(skip.a), plays: num(skip.n), skipRate: num(skip.sr) } : null,
    obscurity: ob?.ob == null ? null : num(ob.ob), likedNeverPlayed: num(liked?.never), albumsAbandoned: num(aband?.abandoned), albums: num(aband?.albums), longestSessionHours: sess?.longest == null ? null : num(sess.longest), topScene: sc ? { label: str(sc.label), share: num(sc.share) } : null, newArtistShareThisYear: yr?.newshare == null ? null : num(yr.newshare) };

  const s = (k: string) => [...k].reduce((a, c) => a + c.charCodeAt(0), seed);
  const spicy = heat === 'spicy', mild = heat === 'mild';
  const R: Receipt[] = [];
  if (facts.mostPlayedTrack && facts.mostPlayedTrack.plays >= 40) { const m = facts.mostPlayedTrack; R.push({ id: 'rep', weight: m.plays, link: `/track/${encodeURIComponent(String(rep.track_id))}`, receipt: `${m.plays} plays of “${m.track}” by ${m.artist}`,
    line: pick(mild ? [`You and “${m.track}” have a very committed relationship.`, `“${m.track}” is basically your ringtone at this point.`] : spicy ? [`You've played “${m.track}” ${m.plays} times. That's not a favourite song, that's a hostage situation.`, `${m.plays} plays of “${m.track}”. ${m.artist} should be paying you rent.`] : [`${m.plays} plays of “${m.track}”. At some point it stopped being a song and became furniture.`, `“${m.track}” has heard more of your life than most of your friends.`], s('rep')) }); }
  if (facts.oneDayRecord && facts.oneDayRecord.plays >= 8) { const d = facts.oneDayRecord; R.push({ id: 'day', weight: d.plays * 4, receipt: `${d.plays} plays of “${d.track}” on ${d.date}`,
    line: pick(spicy ? [`On ${d.date} you played “${d.track}” ${d.plays} times in one day. Whatever happened, the song didn't fix it.`, `${d.plays} times in a day. “${d.track}” filed a restraining order.`] : [`${d.date}: “${d.track}”, ${d.plays} times. We don't need to talk about it.`, `On ${d.date} “${d.track}” was on a ${d.plays}-play loop. Were you okay?`], s('day')) }); }
  if (topShare >= 0.06 && facts.topArtist) R.push({ id: 'top', weight: topShare * 400, link: top ? `/artist/${encodeURIComponent(String(top.artist_id))}` : undefined, receipt: `${pct(topShare)} of all your listening is ${facts.topArtist}`,
    line: pick(spicy ? [`${pct(topShare)} of everything you've ever played is ${facts.topArtist}. That's not taste, that's a fan club with one member.`, `${facts.topArtist} is ${pct(topShare)} of your record. Blink twice if they're holding you.`] : [`${facts.topArtist} is ${pct(topShare)} of your listening. Other artists exist, apparently.`, `One in every ${Math.max(2, Math.round(1 / topShare))} hours: ${facts.topArtist}. Loyalty is a virtue. Mostly.`], s('top')) });
  if (facts.lateNightShare >= 0.08) R.push({ id: 'late', weight: facts.lateNightShare * 300, receipt: `${pct(facts.lateNightShare)} of your plays happen between 1 and 5 a.m.`,
    line: pick(spicy ? [`${pct(facts.lateNightShare)} of your listening happens between 1 and 5 a.m. Your sleep schedule is a rumour.`, `A fifth of your record is after 1 a.m. The owls are worried about you.`] : [`${pct(facts.lateNightShare)} of your plays are after 1 a.m. Bedtime is more of a suggestion.`], s('late')) });
  if (facts.mostSkippedButKeptPlaying && facts.mostSkippedButKeptPlaying.skipRate >= 0.5) { const k = facts.mostSkippedButKeptPlaying; R.push({ id: 'skip', weight: k.plays * k.skipRate, receipt: `${k.artist}: ${k.plays} plays, ${pct(k.skipRate)} skipped`,
    line: pick(spicy ? [`You've started ${k.artist} ${k.plays} times and bailed on ${pct(k.skipRate)} of them. Just break up already.`, `${k.artist}, ${pct(k.skipRate)} skip rate across ${k.plays} plays. This is the musical equivalent of opening the fridge again.`] : [`${k.artist}: ${k.plays} attempts, ${pct(k.skipRate)} skipped. It's complicated.`], s('skip')) }); }
  if (facts.obscurity != null) R.push({ id: 'ob', weight: 30, receipt: `average obscurity ${Math.round(facts.obscurity * 100)} / 100`,
    line: facts.obscurity >= 0.3 ? pick(spicy ? ['Your average artist has fewer listeners than a mid-sized high school. You find this impressive. Nobody else does.', 'If an artist crosses 50,000 listeners you treat it like a betrayal.'] : ['You like your bands like your coffee shops: nobody else has heard of them.'], s('ob'))
      : facts.obscurity <= 0.15 ? pick(spicy ? ['Your "deep cuts" are on the front page of every streaming service. The algorithm thanks you for your service.', 'Bold of you to name this app Deep Cuts.'] : ['Your deep cuts are other people\'s singles.'], s('ob')) : 'Your obscurity score is squarely average. Even your niche is mainstream-adjacent.' });
  if (facts.likedNeverPlayed >= 20) R.push({ id: 'liked', weight: facts.likedNeverPlayed / 2, receipt: `${facts.likedNeverPlayed} liked songs never played again after liking`,
    line: pick(spicy ? [`${facts.likedNeverPlayed} songs you "liked" and never played again. That's not a library, it's a landfill with hearts on it.`] : [`${facts.likedNeverPlayed} liked songs, never revisited. The heart button is doing a lot of lying.`], s('liked')) });
  if (facts.albumsAbandoned >= 20) R.push({ id: 'aband', weight: facts.albumsAbandoned / 3, link: '/crate?shelf=fresh', receipt: `${facts.albumsAbandoned} of ${facts.albums} albums pulled once and never again`,
    line: pick(spicy ? [`${facts.albumsAbandoned} albums you started and abandoned after one listen. Commitment issues, but make it vinyl.`] : [`${facts.albumsAbandoned} albums got one listen and a polite goodbye.`], s('aband')) });
  if (facts.longestSessionHours && facts.longestSessionHours >= 6) R.push({ id: 'sess', weight: facts.longestSessionHours * 3, receipt: `longest session ${facts.longestSessionHours.toFixed(1)} hours`,
    line: pick([`Your longest session ran ${facts.longestSessionHours.toFixed(1)} hours. Hydrate.`, `A ${Math.round(facts.longestSessionHours)}-hour session. Some people run marathons; you ran a playlist.`], s('sess')) });
  if (facts.topScene?.share && facts.topScene.share >= 0.2) R.push({ id: 'scene', weight: facts.topScene.share * 100, receipt: `${pct(facts.topScene.share)} of your hours are ${facts.topScene.label}`,
    line: spicy ? `${pct(facts.topScene.share)} ${facts.topScene.label}. You don't have a genre, you have a uniform.` : `${pct(facts.topScene.share)} of your hours are ${facts.topScene.label}. Range is a strong word.` });
  if (facts.newArtistShareThisYear != null && facts.newArtistShareThisYear <= 0.08) R.push({ id: 'new', weight: 40, receipt: `only ${pct(facts.newArtistShareThisYear)} of this year's listening was artists new to you`,
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
  if (F.playlists >= 10 && F.coldPlaylists / F.playlists >= 0.5) R.push({ id: 'hoard', weight: 30, receipt: `${F.coldPlaylists} of your ${F.playlists} playlists untouched for a year`,
    line: spicy ? `${F.coldPlaylists} of your ${F.playlists} playlists haven't been played in a year. You don't curate, you hoard.` : `${F.coldPlaylists} playlists gathering dust. Each one was going to be "the one".` });
  const sorted = R.sort((a, b) => b.weight - a.weight).slice(0, 10);
  return { receipts: sorted, facts, opener: pick(OPENERS[heat], s('open')), closer: closerFor(facts, s('close')) };
}

/** The local model writes the routine from the receipts only. Returns the text, or throws if no model is reachable. */
export async function llmRoast(heat: Heat, receipts: Receipt[], facts: Record<string, unknown>): Promise<{ text: string; model: string }> {
  const st = await llmStatus();
  if (!st.reachable || !st.models.length) throw new Error('No local model reachable — start Ollama and pick a model in Settings → Connectors.');
  const model = currentModel(st.models);
  const tone = heat === 'mild' ? 'gentle and affectionate, like a friend teasing' : heat === 'spicy' ? 'savage but still loving — a comedy-club roast, sharp punchlines' : 'playful with some bite';
  const messages: ChatMsg[] = [
    { role: 'system', content: `You are a stand-up comic roasting one person's MUSIC LISTENING HABITS at their request. Tone: ${tone}.
Rules: use ONLY the facts provided — never invent songs, artists, numbers or events. Roast the listening, never the person: nothing about appearance, identity, body, health, money, relationships or intelligence, no slurs, no profanity beyond "damn". 180–260 words, 5–8 short paragraphs or one-liners, then end with one genuinely kind closing line about their taste. Plain text, no headings, no emoji.` },
    { role: 'user', content: `Facts about my listening (JSON):\n${JSON.stringify(facts)}\n\nObservations already made (you may sharpen them):\n${receipts.map((r) => `- ${r.receipt}`).join('\n')}\n\nRoast me.` },
  ];
  const text = await invoke<string>('llm_chat', { model, messages, jsonMode: false, temperature: heat === 'spicy' ? 0.95 : 0.8 });
  return { text: text.trim(), model };
}
