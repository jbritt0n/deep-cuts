/**
 * Phase 10 — Graph & connection views (DeepSeek §2.13 / §5.1, Kimi R1).
 *   co-listening: artists you play in the same sessions (Jaccard of their session sets), strongest links per artist;
 *   playlist overlap: shared tracks between your playlists and the ones you follow, incl. near-subsets.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';

export type CoNode = { id: string; name: string; hours: number; sessions: number; scene: string | null; label: string | null };
export type CoEdge = { a: string; b: string; shared: number; w: number };
export async function coListening(topN = 60, perNode = 4, minShared = 3): Promise<{ nodes: CoNode[]; edges: CoEdge[] }> {
  const P = playsWhere('p');
  const nodes = (await query(`
    WITH top AS (SELECT artist_id, arg_max(artist_name, ms_played) AS a, SUM(ms_played) / 3600000.0 AS h FROM plays_resolved p WHERE p.attended AND artist_id IS NOT NULL ${P} GROUP BY 1 ORDER BY h DESC LIMIT ${Math.round(topN)}),
         sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
         ss AS (SELECT p.artist_id, COUNT(DISTINCT ps.session_id) AS s FROM play_sessions ps JOIN plays_resolved p USING (play_id) WHERE p.artist_id IN (SELECT artist_id FROM top) GROUP BY 1)
    SELECT top.artist_id, top.a, top.h, COALESCE(ss.s, 0) AS s, sc.scene, f.label FROM top LEFT JOIN ss USING (artist_id) LEFT JOIN sc USING (artist_id) LEFT JOIN scene_families f ON f.scene = sc.scene`))
    .map((r) => ({ id: String(r.artist_id), name: String(r.a), hours: num(r.h), sessions: num(r.s), scene: str(r.scene), label: str(r.label) }));
  if (nodes.length < 2) return { nodes, edges: [] };
  const ids = nodes.map((n) => n.id);
  const edges = (await query(`
    WITH sa AS (SELECT DISTINCT ps.session_id, p.artist_id FROM play_sessions ps JOIN plays_resolved p USING (play_id) WHERE list_contains(string_split($1, '\u001f'), p.artist_id) ${P}),
         cnt AS (SELECT artist_id, COUNT(*) AS s FROM sa GROUP BY 1),
         pr AS (SELECT a.artist_id AS x, b.artist_id AS y, COUNT(*) AS shared_n FROM sa a JOIN sa b ON a.session_id = b.session_id AND a.artist_id < b.artist_id GROUP BY 1, 2 HAVING COUNT(*) >= ${Math.round(minShared)}),
         j AS (SELECT pr.x, pr.y, pr.shared_n, pr.shared_n * 1.0 / (cx.s + cy.s - pr.shared_n) AS w FROM pr JOIN cnt cx ON cx.artist_id = pr.x JOIN cnt cy ON cy.artist_id = pr.y),
         ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY x ORDER BY w DESC) AS rx, ROW_NUMBER() OVER (PARTITION BY y ORDER BY w DESC) AS ry FROM j)
    SELECT x, y, shared_n, w FROM ranked WHERE rx <= ${perNode} OR ry <= ${perNode}`, [ids.join('\u001f')]))
    .map((r) => ({ a: String(r.x), b: String(r.y), shared: num(r.shared_n), w: num(r.w) }));
  return { nodes, edges };
}

export type Overlap = { a: string; aName: string; aMine: boolean; b: string; bName: string; bMine: boolean; shared: number; jaccard: number; aInB: number; bInA: number };
/** Pairs of playlists (10+ items) that share songs; near-subset when 90 % of one sits inside the other. */
export async function playlistOverlap(limit = 40): Promise<{ pairs: Overlap[]; subsets: Overlap[]; playlists: number }> {
  const rows = await query(`
    WITH it AS (SELECT DISTINCT playlist_id, track_id FROM playlist_items),
         sz AS (SELECT playlist_id, COUNT(*) AS n FROM it GROUP BY 1 HAVING COUNT(*) >= 10),
         pr AS (SELECT a.playlist_id AS x, b.playlist_id AS y, COUNT(*) AS shared_n FROM it a JOIN it b ON a.track_id = b.track_id AND a.playlist_id < b.playlist_id
                WHERE a.playlist_id IN (SELECT playlist_id FROM sz) AND b.playlist_id IN (SELECT playlist_id FROM sz) GROUP BY 1, 2 HAVING COUNT(*) >= 3)
    SELECT pr.x, pr.y, pr.shared_n, sx.n AS nx, sy.n AS ny, COALESCE(NULLIF(trim(px.name), ''), 'Untitled') AS xn, COALESCE(NULLIF(trim(py.name), ''), 'Untitled') AS yn, px.owner_is_me AS xm, py.owner_is_me AS ym
    FROM pr JOIN sz sx ON sx.playlist_id = pr.x JOIN sz sy ON sy.playlist_id = pr.y JOIN playlists px ON px.playlist_id = pr.x JOIN playlists py ON py.playlist_id = pr.y`);
  const all: Overlap[] = rows.map((r) => ({ a: String(r.x), aName: String(r.xn), aMine: Boolean(r.xm), b: String(r.y), bName: String(r.yn), bMine: Boolean(r.ym), shared: num(r.shared_n),
    jaccard: num(r.shared_n) / (num(r.nx) + num(r.ny) - num(r.shared_n)), aInB: num(r.shared_n) / num(r.nx), bInA: num(r.shared_n) / num(r.ny) }));
  const [c] = await query(`SELECT COUNT(DISTINCT playlist_id) AS n FROM playlist_items`);
  return { pairs: [...all].sort((x, y) => y.jaccard - x.jaccard).slice(0, limit), subsets: all.filter((o) => Math.max(o.aInB, o.bInA) >= 0.9).sort((x, y) => y.shared - x.shared).slice(0, 20), playlists: num(c?.n) };
}
