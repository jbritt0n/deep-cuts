/**
 * Phase 8 — discovery by genre. Two lenses over one chosen tag:
 *   1. your own library in that genre (artists carrying the tag, by your hours)
 *   2. artists you don't own, reached through similar-artist edges whose seed carries the tag
 * Tags come from artist_tags (Last.fm + MusicBrainz, normalised in Rust).
 * Coverage caveat: tags are fetched for artists you own, so lens 2 is only as
 * wide as the similar-artist graph around your genre seeds.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { intSetting, numSetting } from './settings';

export type GenreTag = { tag: string; artists: number; hours: number; plays: number };

/** Tags in your library, weighted by your hours with the artists that carry them. */
export async function genreTags(limit = 60, q = ''): Promise<GenreTag[]> {
  const params: unknown[] = [];
  let filt = '';
  if (q.trim()) { params.push(`%${q.trim().toLowerCase()}%`); filt = `AND t.tag LIKE $${params.length}`; }
  return (await query(`
    WITH owned AS (SELECT artist_id, SUM(ms_played)/3600000.0 AS hours, COUNT(*) AS plays FROM plays_resolved WHERE artist_id IS NOT NULL ${playsWhere()} GROUP BY 1),
    tags AS (SELECT artist_id, tag, MAX(weight) AS w FROM artist_tags t WHERE weight >= ${numSetting('tag_floor')} ${filt} GROUP BY 1, 2)
    SELECT t.tag, COUNT(DISTINCT t.artist_id) AS artists, ROUND(SUM(o.hours * t.w), 1) AS hours, SUM(o.plays) AS plays
    FROM tags t JOIN owned o USING (artist_id)
    GROUP BY 1 HAVING COUNT(DISTINCT t.artist_id) >= 2 ORDER BY hours DESC LIMIT ${limit}`, params))
    .map((r) => ({ tag: String(r.tag), artists: num(r.artists), hours: num(r.hours), plays: num(r.plays) }));
}

export type GenreArtist = { artistId: string; artist: string; hours: number; plays: number; weight: number; lastPlayed: string | null; imageUrl: string | null };

/** Lens 1 — your artists in this genre, by hours. */
export async function genreLibrary(tag: string, limit = 40): Promise<GenreArtist[]> {
  return (await query(`
    SELECT a.artist_id, a.name, ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, COUNT(*) AS plays, MAX(t.weight) AS w,
           CAST(MAX(p.played_at) AS VARCHAR) AS last_played, a.image_url
    FROM artist_tags t JOIN artists a USING (artist_id) JOIN plays_resolved p ON p.artist_id = a.artist_id
    WHERE t.tag = $1 ${playsWhere('p')}
    GROUP BY 1, 2, 7 ORDER BY hours DESC LIMIT ${limit}`, [tag])).map((r) => ({
    artistId: String(r.artist_id), artist: String(r.name), hours: num(r.hours), plays: num(r.plays), weight: num(r.w), lastPlayed: str(r.last_played), imageUrl: str(r.image_url),
  }));
}

export type GenreCandidate = { key: string; artist: string; score: number; via: string[]; viaIds: string[] };

/** Lens 2 — artists you don't own, adjacent to your artists in this genre. */
export async function genreDiscover(tag: string, limit = 30): Promise<GenreCandidate[]> {
  return (await query(`
    WITH owned AS (SELECT a.artist_id, lower(a.name) AS lname, a.mbid, SUM(p.ms_played)/3600000.0 AS hours
                   FROM artists a JOIN plays_resolved p ON p.artist_id = a.artist_id WHERE 1=1 ${playsWhere('p')} GROUP BY 1, 2, 3),
    seeds AS (SELECT t.artist_id, MAX(t.weight) AS w FROM artist_tags t WHERE t.tag = $1 GROUP BY 1),
    edges AS (SELECT r.artist_mbid AS seed_id, r.related_name AS name, split_part(r.related_mbid, '|', 1) AS key,
                     TRY_CAST(split_part(r.related_mbid, '|', 2) AS DOUBLE) AS match
              FROM artist_relations r WHERE r.relation_type IN ('similar', 'lb_similar')),
    cand AS (
      SELECT e.name, e.key, SUM(COALESCE(e.match, 0.3) * s.w * LOG(1 + o.hours)) AS score,
             list(a.name ORDER BY COALESCE(e.match, 0.3) * o.hours DESC) AS via, list(a.artist_id ORDER BY COALESCE(e.match, 0.3) * o.hours DESC) AS via_ids
      FROM edges e JOIN seeds s ON s.artist_id = e.seed_id JOIN owned o ON o.artist_id = e.seed_id JOIN artists a ON a.artist_id = e.seed_id
      WHERE NOT EXISTS (SELECT 1 FROM owned x WHERE x.lname = lower(e.name) OR (x.mbid IS NOT NULL AND x.mbid = e.key))
        AND NOT EXISTS (SELECT 1 FROM recommendation_feedback f WHERE f.subject_key = e.key AND f.verdict = 'dismissed' AND f.decided_at >= now() - INTERVAL ${intSetting('feedback_memory_days')} DAY)
      GROUP BY 1, 2)
    SELECT name, key, score / NULLIF(MAX(score) OVER (), 0) AS norm, via, via_ids FROM cand ORDER BY score DESC LIMIT ${limit}`, [tag])).map((r) => ({
    key: String(r.key), artist: String(r.name), score: num(r.norm),
    via: ((r.via as unknown[]) ?? []).slice(0, 3).map(String), viaIds: ((r.via_ids as unknown[]) ?? []).slice(0, 3).map(String),
  }));
}
