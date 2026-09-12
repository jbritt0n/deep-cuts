/**
 * Phase 9d — Superlatives (summary §3.1): period-scoped awards for In Review. Achievements are permanent
 * earned-once badges; these belong to the period they describe. Every category returns even when it has
 * no winner ("not available this period") so the section is always the same shape.
 * Best Supporting Artist needs `track_credits`; Most Chaotic / Smoothest need `sessions.chaos`;
 * the Deep Cuts Award needs `artists.catalogue_tracks` — each degrades to `available: false`.
 */
import { query, num, str } from './db';
import { playsWhere, sessionsWhere } from './filter';
import { albumHref, artistHref, trackHref } from './format';
import type { Period } from './insightQueries';

export type Award = { id: string; title: string; blurb: string; available: boolean; reason?: string; winner?: { name: string; sub?: string; href?: string; stat: string }; runnerUp?: { name: string; stat: string; href?: string } };

export async function awards(period: Period): Promise<Award[]> {
  const R = `played_at >= DATE '${period.from}' AND played_at < DATE '${period.to}'`;
  const W = `WHERE ${R} ${playsWhere()}`;
  const out: Award[] = [];
  const two = async (sql: string, params: unknown[] = []) => { const rows = await query(sql, params); return [rows[0], rows[1]] as const; };

  const [mp, mp2] = await two(`SELECT track_id, track_name, artist_name, COUNT(*) AS c FROM plays_resolved ${W} AND track_id IS NOT NULL GROUP BY 1, 2, 3 ORDER BY c DESC LIMIT 2`);
  out.push(mk('most_played', 'Most Played', 'The song you reached for most.', mp, mp2, (r) => ({ name: String(r.track_name), sub: String(r.artist_name ?? ''), href: trackHref(String(r.track_id)), stat: `${num(r.c)} plays` })));

  const [ms, ms2] = await two(`SELECT track_id, track_name, artist_name, COUNT(*) AS c, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved ${W} AND track_id IS NOT NULL GROUP BY 1, 2, 3 HAVING COUNT(*) >= 10 ORDER BY sr DESC, c DESC LIMIT 2`);
  out.push(mk('most_skipped', 'Most Skipped', 'Kept coming up, kept getting skipped (10+ plays).', ms, ms2, (r) => ({ name: String(r.track_name), sub: String(r.artist_name ?? ''), href: trackHref(String(r.track_id)), stat: `skipped ${Math.round(num(r.sr) * 100)}% of ${num(r.c)}` })));

  const [bn, bn2] = await two(`
    WITH f AS (SELECT artist_id, arg_max(artist_name, ms_played) AS name, MIN(played_at) AS first_at FROM plays_resolved WHERE artist_id IS NOT NULL ${playsWhere()} GROUP BY 1),
         c AS (SELECT artist_id, COUNT(*) AS c FROM plays_resolved ${W} AND artist_id IS NOT NULL GROUP BY 1)
    SELECT f.artist_id, f.name, c.c FROM f JOIN c USING (artist_id) WHERE f.first_at >= DATE '${period.from}' AND f.first_at < DATE '${period.to}' ORDER BY c.c DESC LIMIT 2`);
  out.push(mk('newcomer', 'Best Newcomer', 'First heard this period, played the most since.', bn, bn2, (r) => ({ name: String(r.name), href: artistHref(String(r.artist_id)), stat: `${num(r.c)} plays` })));

  const [cb, cb2] = await two(`
    WITH p AS (SELECT artist_id, artist_name, played_at, LAG(played_at) OVER (PARTITION BY artist_id ORDER BY played_at) AS prev FROM plays_resolved WHERE artist_id IS NOT NULL ${playsWhere()}),
         gaps AS (SELECT artist_id, arg_max(artist_name, played_at) AS name, MAX(played_at - prev) AS gap FROM p WHERE ${R} AND prev IS NOT NULL AND played_at - prev >= INTERVAL 730 DAY GROUP BY 1),
         c AS (SELECT artist_id, COUNT(*) AS c FROM plays_resolved ${W} GROUP BY 1)
    SELECT g.artist_id, g.name, date_diff('day', CAST('1970-01-01' AS TIMESTAMP), CAST('1970-01-01' AS TIMESTAMP) + g.gap) AS days, c.c FROM gaps g JOIN c USING (artist_id) ORDER BY c.c DESC, days DESC LIMIT 2`);
  out.push(mk('comeback', 'Best Comeback', 'Silent two years or more, then back.', cb, cb2, (r) => ({ name: String(r.name), href: artistHref(String(r.artist_id)), stat: `${Math.round(num(r.days) / 365)} years away · ${num(r.c)} plays since` })));

  const [qo, qo2] = await two(`
    SELECT p.artist_id, arg_max(p.artist_name, p.ms_played) AS name, COUNT(*) AS c, COUNT(DISTINCT ps.session_id) AS s
    FROM plays_resolved p JOIN play_sessions ps USING (play_id) ${W.replace(/played_at/g, 'p.played_at').replace(/WHERE/, 'WHERE p.artist_id IS NOT NULL AND')}
    GROUP BY 1 HAVING COUNT(*) >= 25 ORDER BY COUNT(*) * 1.0 / COUNT(DISTINCT ps.session_id) DESC LIMIT 2`);
  out.push(mk('quiet_obsession', 'Quietest Obsession', 'Many plays, few sittings — binged rather than sprinkled.', qo, qo2, (r) => ({ name: String(r.name), href: artistHref(String(r.artist_id)), stat: `${num(r.c)} plays in ${num(r.s)} session${num(r.s) === 1 ? '' : 's'}` })));

  const [lr, lr2] = await two(`SELECT artist_id, arg_max(artist_name, ms_played) AS name, date_diff('day', MIN(played_at), MAX(played_at)) AS span, COUNT(*) AS c FROM plays_resolved ${W} AND artist_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 10 ORDER BY span DESC, c DESC LIMIT 2`);
  out.push(mk('longest', 'Longest Relationship', 'First to last play, furthest apart inside the period.', lr, lr2, (r) => ({ name: String(r.name), href: artistHref(String(r.artist_id)), stat: `${num(r.span)} days · ${num(r.c)} plays` })));

  const [od, od2] = await two(`SELECT track_id, track_name, artist_name, CAST(CAST(played_at AS DATE) AS VARCHAR) AS day, COUNT(*) AS c FROM plays_resolved ${W} AND track_id IS NOT NULL GROUP BY 1, 2, 3, 4 ORDER BY c DESC LIMIT 2`);
  out.push(mk('obsessive_day', 'Obsessive Day', 'One song, one day, the most times.', od, od2, (r) => ({ name: String(r.track_name), sub: `${String(r.artist_name ?? '')} · ${String(r.day)}`, href: `/day/${String(r.day)}`, stat: `${num(r.c)} times in a day` })));

  // chaos pair — needs scored sessions
  const SR = `start_at >= DATE '${period.from}' AND start_at < DATE '${period.to}'`;
  const [ch, sm] = await Promise.all([
    query(`SELECT CAST(session_id AS VARCHAR) AS id, CAST(CAST(start_at AS DATE) AS VARCHAR) AS day, chaos, track_count, unique_artist_count AS ua FROM sessions WHERE ${SR} AND chaos IS NOT NULL AND track_count >= 6 ${sessionsWhere()} ORDER BY chaos DESC LIMIT 1`),
    query(`SELECT CAST(session_id AS VARCHAR) AS id, CAST(CAST(start_at AS DATE) AS VARCHAR) AS day, chaos, track_count, unique_artist_count AS ua FROM sessions WHERE ${SR} AND chaos IS NOT NULL AND track_count >= 6 AND unique_artist_count >= 3 ${sessionsWhere()} ORDER BY chaos ASC LIMIT 1`),
  ]);
  const sess = (r: Record<string, unknown> | undefined) => (r ? { name: String(r.day), sub: `${num(r.track_count)} plays · ${num(r.ua)} artists`, href: `/sessions/${String(r.id)}`, stat: `chaos ${num(r.chaos).toFixed(2)}` } : undefined);
  out.push({ id: 'chaotic', title: 'Most Chaotic Session', blurb: 'The wildest genre jumps in one sitting (6+ plays).', available: !!ch[0], reason: 'needs tagged artists', winner: sess(ch[0]) });
  out.push({ id: 'smoothest', title: 'Smoothest Session', blurb: 'Three or more artists, barely a seam between them.', available: !!sm[0], reason: 'needs tagged artists', winner: sess(sm[0]) });

  // Best Supporting Artist — track_credits, credit_order > 0
  const [bs, bs2] = await two(`
    SELECT tc.artist_name, tc.artist_id, COUNT(*) AS c, COUNT(DISTINCT p.track_id) AS tracks
    FROM plays_resolved p JOIN track_credits tc ON tc.track_id = p.track_id AND tc.credit_order > 0
    ${W.replace(/played_at/g, 'p.played_at')} GROUP BY 1, 2 ORDER BY c DESC LIMIT 2`);
  out.push({ ...mk('supporting', 'Best Supporting Artist', 'Most plays as a featured, non-primary credit.', bs, bs2, (r) => ({ name: String(r.artist_name), href: r.artist_id ? artistHref(String(r.artist_id)) : undefined, stat: `${num(r.c)} plays on ${num(r.tracks)} track${num(r.tracks) === 1 ? '' : 's'}` })), reason: 'needs MusicBrainz credits (Services → MusicBrainz)' });

  // Deep Cuts Award — catalogue penetration
  const [dc, dc2] = await two(`
    SELECT p.artist_id, arg_max(p.artist_name, p.ms_played) AS name, COUNT(DISTINCT p.track_id) AS played, a.catalogue_tracks AS cat
    FROM plays_resolved p JOIN artists a ON a.artist_id = p.artist_id ${W.replace(/played_at/g, 'p.played_at')} AND a.catalogue_tracks >= 10
    GROUP BY 1, 4 HAVING COUNT(DISTINCT p.track_id) >= 8 ORDER BY COUNT(DISTINCT p.track_id) * 1.0 / a.catalogue_tracks DESC LIMIT 2`);
  out.push({ ...mk('deep_cuts', 'The Deep Cuts Award', 'Deepest into one catalogue: distinct songs played as a share of everything they recorded.', dc, dc2, (r) => ({ name: String(r.name), href: artistHref(String(r.artist_id)), stat: `${Math.round(Math.min(1, num(r.played) / num(r.cat)) * 100)}% of ~${num(r.cat)} recordings` })), reason: 'needs catalogue sizes from MusicBrainz' });

  // Top album of the period as a small bonus
  const [ta, ta2] = await two(`SELECT album_id, album_name, artist_name, ROUND(SUM(ms_played)/3600000.0, 1) AS h FROM plays_resolved ${W} AND album_id IS NOT NULL GROUP BY 1, 2, 3 ORDER BY h DESC LIMIT 2`);
  out.push(mk('album', 'Record of the Period', 'Most hours from one album.', ta, ta2, (r) => ({ name: String(r.album_name), sub: String(r.artist_name ?? ''), href: albumHref(String(r.album_id)), stat: `${num(r.h)} h` })));
  return out;
}

function mk(id: string, title: string, blurb: string, w: Record<string, unknown> | undefined, r2: Record<string, unknown> | undefined, f: (r: Record<string, unknown>) => Award['winner']): Award {
  const winner = w ? f(w) : undefined; const ru = r2 ? f(r2) : undefined;
  return { id, title, blurb, available: !!winner, winner, runnerUp: ru ? { name: ru.name, stat: ru.stat, href: ru.href } : undefined };
}
export { str };
