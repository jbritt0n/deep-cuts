/** Phase 7: scenes, earworms, insights cache, library extras, mixtape, travel, hygiene. */
import { query, num, str } from './db';
import { playsWhere } from './filter';
import type { TrackRow } from './types';

const PW = () => playsWhere();
const T = `p.track_id AS "trackId", p.track_name AS track, p.artist_id AS "artistId", p.artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"`;
const toT = (r: Record<string, unknown>): TrackRow => ({ trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) });

export type Insight = { id: string; kind: string; periodStart: string; subjectType: string; subjectId: string; payload: Record<string, unknown>; score: number; surfaced: boolean };
export async function unseenInsights(limit = 6): Promise<Insight[]> {
  const rows = await query(`SELECT CAST(insight_id AS VARCHAR) AS id, kind, CAST(period_start AS VARCHAR) AS ps, subject_type, subject_id, payload, score, surfaced FROM insights
    WHERE period_start >= now() - INTERVAL 120 DAY OR kind = 'earworm' ORDER BY surfaced, CASE kind WHEN 'earworm' THEN 0.6 * score ELSE score END DESC LIMIT ${limit}`);
  return rows.map((r) => ({ id: String(r.id), kind: String(r.kind), periodStart: String(r.ps), subjectType: String(r.subject_type), subjectId: String(r.subject_id), payload: typeof r.payload === 'string' ? JSON.parse(r.payload as string) : (r.payload as Record<string, unknown>) ?? {}, score: num(r.score), surfaced: Boolean(r.surfaced) }));
}

export type Earworm = { trackId: string; track: string; artist: string; plays: number; months: number; years: number; spanDays: number; skipRate: number; alone: number; score: number; verdict: string | null };
export async function earworms(limit = 40): Promise<Earworm[]> {
  const rows = await query(`SELECT i.subject_id, i.payload, i.score, f.verdict FROM insights i LEFT JOIN (SELECT subject_key, arg_max(verdict, decided_at) AS verdict FROM recommendation_feedback WHERE engine = 'earworm' GROUP BY 1) f ON f.subject_key = i.subject_id
    WHERE i.kind = 'earworm' AND COALESCE(f.verdict, '') <> 'dismissed' ORDER BY (CASE WHEN f.verdict = 'accepted' THEN 1 ELSE 0 END) DESC, i.score DESC LIMIT ${limit}`);
  return rows.map((r) => { const p = typeof r.payload === 'string' ? JSON.parse(r.payload as string) : (r.payload as Record<string, unknown>); return { trackId: String(r.subject_id), track: String(p.track), artist: String(p.artist ?? ''), plays: num(p.plays), months: num(p.months), years: num(p.years), spanDays: num(p.span_days), skipRate: num(p.skip_rate), alone: num(p.alone), score: num(r.score), verdict: str(r.verdict) }; });
}

export type Scene = { scene: string; artists: number; hours: number; lead: string[]; share: number };
export async function scenes(): Promise<Scene[]> {
  const rows = await query(`
    WITH s AS (SELECT sc.scene, p.artist_id, p.artist_name, SUM(p.ms_played)/3600000.0 AS h FROM plays_resolved p JOIN artist_scene sc USING (artist_id) WHERE 1=1 ${playsWhere('p')} GROUP BY 1, 2, 3),
         tot AS (SELECT SUM(ms_played)/3600000.0 AS th FROM plays_resolved WHERE 1=1 ${PW()})
    SELECT scene, COUNT(*) AS artists, SUM(h) AS hours, list(artist_name ORDER BY h DESC)[1:4] AS lead, SUM(h) / (SELECT th FROM tot) AS share FROM s GROUP BY 1 ORDER BY hours DESC`);
  return rows.map((r) => ({ scene: String(r.scene), artists: num(r.artists), hours: num(r.hours), lead: (r.lead as string[]) ?? [], share: num(r.share) }));
}
export async function sceneTracks(scene: string, n = 30): Promise<TrackRow[]> {
  return (await query(`SELECT ${T} FROM plays_resolved p JOIN artist_scene sc USING (artist_id) WHERE sc.scene = $1 AND p.track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1, 2, 3, 4 ORDER BY SUM(p.ms_played) DESC LIMIT ${n}`, [scene])).map(toT);
}
/** Weekly hours per scene for the last N weeks — the "scene phases" ribbon. */
export async function sceneTimeline(weeks = 104): Promise<{ week: string; scene: string; hours: number }[]> {
  return (await query(`SELECT strftime(DATE_TRUNC('week', p.played_at), '%Y-%m-%d') AS wk, sc.scene, SUM(p.ms_played)/3600000.0 AS h FROM plays_resolved p JOIN artist_scene sc USING (artist_id)
    WHERE p.played_at >= now() - INTERVAL ${weeks} WEEK ${playsWhere('p')} GROUP BY 1, 2 ORDER BY 1`)).map((r) => ({ week: String(r.wk), scene: String(r.scene), hours: num(r.h) }));
}

/** "Also in rotation" for a span: tracks ranked just below the hits. */
export async function spanDeepCuts(from: string, toExclusive: string, skip = 10, n = 20): Promise<TrackRow[]> {
  return (await query(`SELECT ${T} FROM plays_resolved p WHERE p.played_at >= DATE '${from}' AND p.played_at < DATE '${toExclusive}' AND p.track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1, 2, 3, 4 ORDER BY SUM(p.ms_played) DESC LIMIT ${n} OFFSET ${skip}`)).map(toT);
}

export type MadeBy = { id: string; spotifyPlaylistId: string | null; name: string; kind: string; createdAt: string; tracks: number; isPublic: boolean; url: string | null };
export async function madeByDeepCuts(): Promise<MadeBy[]> {
  return (await query(`SELECT CAST(id AS VARCHAR) AS id, spotify_playlist_id, name, kind, CAST(created_at AS VARCHAR) AS at, COALESCE(json_array_length(track_ids), 0) AS n, is_public FROM created_playlists ORDER BY created_at DESC`))
    .map((r) => ({ id: String(r.id), spotifyPlaylistId: str(r.spotify_playlist_id), name: String(r.name), kind: String(r.kind), createdAt: String(r.at), tracks: num(r.n), isPublic: Boolean(r.is_public), url: r.spotify_playlist_id ? `https://open.spotify.com/playlist/${String(r.spotify_playlist_id)}` : null }));
}

/** Followed playlists you rarely play from — the "hard to find again" problem. */
export type FollowedRow = { playlistId: string; name: string; tracks: number; playedTracks: number; lastPlayed: string | null; hours: number; gems: TrackRow[] };
export async function followedPlaylists(): Promise<FollowedRow[]> {
  const rows = await query(`
    SELECT pl.playlist_id, pl.name, pl.track_count, COUNT(DISTINCT p.track_id) AS played, CAST(MAX(p.played_at) AS VARCHAR) AS last, ROUND(COALESCE(SUM(p.ms_played), 0)/3600000.0, 1) AS h
    FROM playlists pl LEFT JOIN playlist_items pi USING (playlist_id) LEFT JOIN plays_resolved p ON p.track_id = pi.track_id ${playsWhere('p')}
    WHERE NOT pl.owner_is_me GROUP BY 1, 2, 3 ORDER BY last NULLS FIRST, pl.name`);
  const out: FollowedRow[] = [];
  for (const r of rows) {
    const gems = (await query(`SELECT ${T} FROM playlist_items pi JOIN plays_resolved p ON p.track_id = pi.track_id WHERE pi.playlist_id = $1 ${playsWhere('p')} GROUP BY 1, 2, 3, 4 HAVING AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) <= 0.1 ORDER BY plays DESC LIMIT 5`, [String(r.playlist_id)])).map(toT);
    out.push({ playlistId: String(r.playlist_id), name: String(r.name), tracks: num(r.track_count), playedTracks: num(r.played), lastPlayed: str(r.last), hours: num(r.h), gems });
  }
  return out;
}

/** Mixtape candidates from cached graphs: artists you don't own, per engine. */
export async function mixtapeArtists(engine: 'adjacency' | 'tag' | 'lb', n = 12): Promise<{ name: string; via: string; score: number }[]> {
  const owned = `(SELECT lower(name) AS lname, mbid FROM artists)`;
  const rel = engine === 'lb' ? 'lb_similar' : 'similar';
  if (engine === 'tag') {
    return (await query(`
      WITH sig AS (SELECT t.tag, SUM(t.weight * h.h) AS w FROM artist_tags t JOIN (SELECT artist_id, SUM(ms_played)/3600000.0 AS h FROM plays_resolved WHERE 1=1 ${PW()} GROUP BY 1) h USING (artist_id) GROUP BY 1 ORDER BY w DESC LIMIT 10),
           edges AS (SELECT r.artist_mbid AS seed, r.related_name AS name, TRY_CAST(split_part(r.related_mbid, '|', 2) AS DOUBLE) AS m FROM artist_relations r WHERE r.relation_type IN ('similar', 'lb_similar'))
      SELECT e.name, arg_max(a.name, e.m) AS via, SUM(e.m * s.w) AS score FROM edges e JOIN artist_tags t ON t.artist_id = e.seed JOIN sig s USING (tag) JOIN artists a ON a.artist_id = e.seed
      WHERE lower(e.name) NOT IN (SELECT lname FROM ${owned}) GROUP BY 1 ORDER BY score DESC LIMIT ${n}`)).map((r) => ({ name: String(r.name), via: String(r.via), score: num(r.score) }));
  }
  return (await query(`
    WITH o AS (SELECT artist_id, SUM(ms_played)/3600000.0 AS h FROM plays_resolved WHERE 1=1 ${PW()} GROUP BY 1)
    SELECT r.related_name AS name, arg_max(a.name, o.h) AS via, SUM(TRY_CAST(split_part(r.related_mbid, '|', 2) AS DOUBLE) * LOG(1 + o.h)) AS score
    FROM artist_relations r JOIN artists a ON a.artist_id = r.artist_mbid JOIN o ON o.artist_id = a.artist_id
    WHERE r.relation_type = '${rel}' AND lower(r.related_name) NOT IN (SELECT lname FROM ${owned})
      AND NOT EXISTS (SELECT 1 FROM recommendation_feedback f WHERE f.verdict = 'dismissed' AND lower(f.subject_key) LIKE '%' || lower(r.related_name))
    GROUP BY 1 ORDER BY score DESC LIMIT ${n}`)).map((r) => ({ name: String(r.name), via: String(r.via), score: num(r.score) }));
}

// travel / hygiene / concerts ------------------------------------------------
export async function travel(): Promise<{ overrides: { id: string; from: string; to: string; zone: string; note: string | null }[]; byZone: { zone: string; plays: number; countries: string[] }[]; countries: { country: string; plays: number; zone: string | null }[] }> {
  const overrides = (await query(`SELECT CAST(id AS VARCHAR) AS id, CAST(from_date AS VARCHAR) AS f, CAST(to_date AS VARCHAR) AS t, zone, note FROM tz_overrides ORDER BY from_date DESC`)).map((r) => ({ id: String(r.id), from: String(r.f), to: String(r.t), zone: String(r.zone), note: str(r.note) }));
  const byZone = (await query(`SELECT zone, COUNT(*) AS n, list(DISTINCT country) AS cs FROM plays_resolved GROUP BY 1 ORDER BY n DESC`)).map((r) => ({ zone: String(r.zone), plays: num(r.n), countries: ((r.cs as string[]) ?? []).filter(Boolean) }));
  const countries = (await query(`SELECT p.country, COUNT(*) AS n, cz.zone FROM plays_resolved p LEFT JOIN country_zones cz USING (country) WHERE p.country IS NOT NULL GROUP BY 1, 3 ORDER BY n DESC LIMIT 20`)).map((r) => ({ country: String(r.country), plays: num(r.n), zone: str(r.zone) }));
  return { overrides, byZone, countries };
}
export async function sessionOverrides(): Promise<{ startAt: string; attention: string }[]> {
  return (await query(`SELECT CAST(start_at AS VARCHAR) AS s, attention FROM session_overrides ORDER BY start_at DESC`)).map((r) => ({ startAt: String(r.s), attention: String(r.attention) }));
}
export async function concertsFor(artistId: string): Promise<{ id: string; date: string; venue: string | null; before: number; after: number }[]> {
  return (await query(`SELECT CAST(c.id AS VARCHAR) AS id, CAST(c.on_date AS VARCHAR) AS d, c.venue,
      (SELECT COUNT(*) FROM plays_resolved p WHERE p.artist_id = c.artist_id AND p.played_at >= c.on_date - INTERVAL 30 DAY AND p.played_at < c.on_date) AS before,
      (SELECT COUNT(*) FROM plays_resolved p WHERE p.artist_id = c.artist_id AND p.played_at >= c.on_date AND p.played_at < c.on_date + INTERVAL 30 DAY) AS after
    FROM concerts c WHERE c.artist_id = $1 ORDER BY c.on_date DESC`, [artistId])).map((r) => ({ id: String(r.id), date: String(r.d), venue: str(r.venue), before: num(r.before), after: num(r.after) }));
}
