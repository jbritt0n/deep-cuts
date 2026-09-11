/**
 * Liner Notes (INS-13, facts-first). A weekly digest composed deterministically
 * from numbers — no model needed. Every sentence is backed by a row in `facts`,
 * shown alongside so it can be checked. When the LLM layer arrives it may
 * rewrite the prose, never the numbers.
 */
import { query, num, str } from './db';
import { playsWhere, sessionsWhere } from './filter';
import { SHAPE_LABELS, fmtHours, fmtInt, fmtPct } from './format';
import { localToday } from './queries';

export type WeekFacts = {
  weekStart: string; weekEnd: string; label: string;
  hours: number; prevHours: number; plays: number; days: number; artists: number; newArtists: number; newTracks: number;
  skipRate: number; prevSkipRate: number; lateShare: number; topShape: string | null;
  topArtists: { artistId: string; artist: string; hours: number; prevRank: number | null }[];
  topTrack: { trackId: string; track: string; artist: string; plays: number } | null;
  loudestDay: { day: string; minutes: number } | null;
  obsession: { artistId: string; artist: string; plays: number; usual: number } | null;
  comebacks: { artistId: string; artist: string; daysSilent: number }[];
  firstTimers: { artistId: string; artist: string; plays: number }[];
  milestones: { description: string; occurredAt: string; type: string }[];
};

export function mondayOf(dateIso: string): string {
  const d = new Date(dateIso + 'T00:00:00'); const dow = (d.getDay() + 6) % 7; d.setDate(d.getDate() - dow);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const addDays = (iso: string, n: number) => { const d = new Date(iso + 'T00:00:00'); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

export async function weekFacts(weekStart = mondayOf(addDays(localToday(), -7))): Promise<WeekFacts> {
  const ws = weekStart, we = addDays(ws, 7), ps = addDays(ws, -7);
  const PW = playsWhere();
  const R = (a: string, b: string) => `played_at >= DATE '${a}' AND played_at < DATE '${b}'`;
  const [t] = await query(`SELECT SUM(ms_played)/3600000.0 AS h, COUNT(*) AS plays, COUNT(DISTINCT CAST(played_at AS DATE)) AS days, COUNT(DISTINCT artist_id) AS artists,
    AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr, AVG(CASE WHEN EXTRACT(hour FROM played_at) >= 23 OR EXTRACT(hour FROM played_at) < 4 THEN 1.0 ELSE 0 END) AS late,
    SUM(CASE WHEN is_first_play THEN 1 ELSE 0 END) AS new_tracks FROM plays_resolved WHERE ${R(ws, we)} ${PW}`);
  const [p] = await query(`SELECT SUM(ms_played)/3600000.0 AS h, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr FROM plays_resolved WHERE ${R(ps, ws)} ${PW}`);
  const [na] = await query(`SELECT COUNT(*) AS n FROM (SELECT artist_id, MIN(played_at) AS f FROM plays_resolved WHERE artist_id IS NOT NULL ${PW} GROUP BY 1) WHERE f >= DATE '${ws}' AND f < DATE '${we}'`);
  const top = await query(`
    WITH cur AS (SELECT artist_id, artist_name, SUM(ms_played)/3600000.0 AS h FROM plays_resolved WHERE ${R(ws, we)} AND artist_id IS NOT NULL ${PW} GROUP BY 1, 2),
         prev AS (SELECT artist_id, ROW_NUMBER() OVER (ORDER BY SUM(ms_played) DESC) AS rk FROM plays_resolved WHERE ${R(ps, ws)} AND artist_id IS NOT NULL ${PW} GROUP BY 1)
    SELECT c.artist_id, c.artist_name, c.h, p.rk FROM cur c LEFT JOIN prev p USING (artist_id) ORDER BY c.h DESC LIMIT 5`);
  const [tt] = await query(`SELECT track_id, track_name, artist_name, COUNT(*) AS n FROM plays_resolved WHERE ${R(ws, we)} AND track_id IS NOT NULL ${PW} GROUP BY 1, 2, 3 ORDER BY n DESC LIMIT 1`);
  const [ld] = await query(`SELECT CAST(CAST(played_at AS DATE) AS VARCHAR) AS d, SUM(ms_played)/60000.0 AS m FROM plays_resolved WHERE ${R(ws, we)} ${PW} GROUP BY 1 ORDER BY m DESC LIMIT 1`);
  const [sh] = await query(`SELECT session_shape, COUNT(*) AS n FROM sessions WHERE start_at >= DATE '${ws}' AND start_at < DATE '${we}' AND track_count >= 3 AND session_shape <> 'steady' ${sessionsWhere()} GROUP BY 1 ORDER BY n DESC LIMIT 1`);
  const [ob] = await query(`
    WITH cur AS (SELECT artist_id, artist_name, COUNT(*) AS c FROM plays_resolved WHERE ${R(ws, we)} AND artist_id IS NOT NULL ${PW} GROUP BY 1, 2),
         base AS (SELECT artist_id, COUNT(*) / 12.0 AS wk FROM plays_resolved WHERE played_at >= DATE '${ws}' - INTERVAL 84 DAY AND played_at < DATE '${ws}' ${PW} GROUP BY 1)
    SELECT c.artist_id, c.artist_name, c.c, COALESCE(b.wk, 0) AS usual FROM cur c LEFT JOIN base b USING (artist_id) WHERE c.c >= 12 AND c.c >= 4 * COALESCE(b.wk, 0) ORDER BY c.c DESC LIMIT 1`);
  const cb = await query(`
    WITH cur AS (SELECT artist_id, artist_name, MIN(played_at) AS f FROM plays_resolved WHERE ${R(ws, we)} AND artist_id IS NOT NULL ${PW} GROUP BY 1, 2),
         before AS (SELECT artist_id, MAX(played_at) AS l, COUNT(*) AS n FROM plays_resolved WHERE played_at < DATE '${ws}' ${PW} GROUP BY 1)
    SELECT c.artist_id, c.artist_name, CAST(CAST(c.f AS DATE) - CAST(b.l AS DATE) AS INTEGER) AS silent FROM cur c JOIN before b USING (artist_id) WHERE b.n >= 20 AND c.f - b.l >= INTERVAL 180 DAY ORDER BY silent DESC LIMIT 4`);
  const ft = await query(`
    WITH f AS (SELECT artist_id, artist_name, MIN(played_at) AS first_at, COUNT(*) AS n FROM plays_resolved WHERE artist_id IS NOT NULL ${PW} GROUP BY 1, 2)
    SELECT artist_id, artist_name, n FROM f WHERE first_at >= DATE '${ws}' AND first_at < DATE '${we}' ORDER BY n DESC LIMIT 4`);
  const ms = await query(`SELECT description, CAST(occurred_at AS VARCHAR) AS at, type FROM milestones WHERE occurred_at >= DATE '${ws}' AND occurred_at < DATE '${we}' AND type <> 'first_play_anniversary' ORDER BY occurred_at LIMIT 8`);
  const fmt = (d: string) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  return {
    weekStart: ws, weekEnd: we, label: `${fmt(ws)} – ${fmt(addDays(ws, 6))}`,
    hours: num(t?.h), prevHours: num(p?.h), plays: num(t?.plays), days: num(t?.days), artists: num(t?.artists), newArtists: num(na?.n), newTracks: num(t?.new_tracks),
    skipRate: num(t?.sr), prevSkipRate: num(p?.sr), lateShare: num(t?.late), topShape: str(sh?.session_shape),
    topArtists: top.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist_name), hours: num(r.h), prevRank: r.rk == null ? null : num(r.rk) })),
    topTrack: tt ? { trackId: String(tt.track_id), track: String(tt.track_name), artist: String(tt.artist_name ?? ''), plays: num(tt.n) } : null,
    loudestDay: ld ? { day: String(ld.d), minutes: num(ld.m) } : null,
    obsession: ob ? { artistId: String(ob.artist_id), artist: String(ob.artist_name), plays: num(ob.c), usual: num(ob.usual) } : null,
    comebacks: cb.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist_name), daysSilent: num(r.silent) })),
    firstTimers: ft.map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist_name), plays: num(r.n) })),
    milestones: ms.map((r) => ({ description: String(r.description), occurredAt: String(r.at), type: String(r.type) })),
  };
}

/** The note itself. Warm, specific, a little wry; numbers first. Every number comes from `f`. */
export function composeNotes(f: WeekFacts): string[] {
  const out: string[] = [];
  if (f.plays === 0) return [`Nothing on the record for ${f.label}. A quiet week — or one that lived on a device Deep Cuts hasn't heard from yet.`];
  const delta = f.hours - f.prevHours;
  const dir = Math.abs(delta) < 0.5 ? 'about level with last week' : delta > 0 ? `up ${fmtHours(delta)} on last week` : `down ${fmtHours(-delta)} from last week`;
  out.push(`${fmtHours(f.hours)} across ${f.days} day${f.days === 1 ? '' : 's'}, ${dir}. ${fmtInt(f.plays)} plays, ${fmtInt(f.artists)} artists${f.newArtists ? `, ${f.newArtists} of them new to you` : ''}.`);
  if (f.topArtists.length) {
    const a = f.topArtists[0];
    const move = a.prevRank === null ? 'in from nowhere' : a.prevRank === 1 ? 'holding the top spot' : `up from #${a.prevRank}`;
    const rest = f.topArtists.slice(1, 3).map((x) => x.artist);
    out.push(`${a.artist} led with ${fmtHours(a.hours)}, ${move}${rest.length ? `; ${rest.join(' and ')} behind` : ''}.`);
  }
  if (f.obsession) out.push(`The obsession: ${f.obsession.artist}, ${f.obsession.plays} plays against a usual ${f.obsession.usual.toFixed(0)} a week.`);
  if (f.topTrack && f.topTrack.plays >= 4) out.push(`Most played song: ${f.topTrack.track} by ${f.topTrack.artist}, ${f.topTrack.plays} times.`);
  if (f.comebacks.length) out.push(`Back after a while: ${f.comebacks.map((c) => `${c.artist} (${c.daysSilent >= 365 ? `${(c.daysSilent / 365).toFixed(1)} years` : `${c.daysSilent} days`})`).join(', ')}.`);
  if (f.firstTimers.length) out.push(`First time on the record: ${f.firstTimers.map((x) => `${x.artist} (${x.plays})`).join(', ')}.`);
  const sd = f.skipRate - f.prevSkipRate;
  const patience = Math.abs(sd) < 0.02 ? '' : sd > 0 ? ` — ${fmtPct(sd)} more skipping than last week` : ` — ${fmtPct(-sd)} less skipping than last week`;
  const shape = f.topShape ? ` Sessions leaned ${SHAPE_LABELS[f.topShape]?.label.toLowerCase() ?? f.topShape}.` : '';
  out.push(`Skip rate ${fmtPct(f.skipRate)}${patience}.${shape}${f.lateShare >= 0.08 ? ` ${fmtPct(f.lateShare)} of it was after 11 PM.` : ''}`);
  if (f.loudestDay) out.push(`Loudest day: ${new Date(f.loudestDay.day + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' })}, ${fmtInt(f.loudestDay.minutes)} minutes.`);
  if (f.milestones.length) out.push(`Milestones: ${f.milestones.slice(0, 4).map((m) => m.description).join('; ')}.`);
  return out;
}
