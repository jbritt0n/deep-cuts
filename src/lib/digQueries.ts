/**
 * Phase 9d — catalogue penetration + Dig Deeper (summary §3.4 / §3.6), one query pair per artist.
 *   - `catalogue_tracks` is MusicBrainz's recording count for the artist (fetched by `musicbrainz::enrich_catalogue`).
 *     It's a proxy — it counts live takes and remixes as separate recordings — so penetration is shown as "of ~N".
 *   - Unplayed tracks come from what the record already knows about: tracks in your liked songs / playlists /
 *     enriched albums by this artist that have zero plays. That's the honest local "dig list"; the rest of the
 *     catalogue exists only as a number until a release-level fetch is worth its API cost.
 *   - Feature credits (`track_credits`, credit_order > 0) show where this artist appears on other people's songs.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';

export type DigDeeper = {
  catalogueTracks: number | null; played: number; penetration: number | null;
  unplayed: { trackId: string; track: string; album: string | null; albumId: string | null; source: string; hint: string | null }[];
  barelyPlayed: { trackId: string; track: string; album: string | null; plays: number }[];
  features: { trackId: string; track: string; primary: string; plays: number }[];
  featuredOn: number;
};

export async function digDeeper(artistId: string): Promise<DigDeeper> {
  const [c] = await query(`SELECT a.catalogue_tracks AS cat, (SELECT COUNT(DISTINCT track_id) FROM plays_resolved p WHERE p.artist_id = $1 AND track_id IS NOT NULL ${playsWhere('p')}) AS played FROM artists a WHERE a.artist_id = $1`, [artistId]);
  const cat = c?.cat == null ? null : num(c.cat), played = num(c?.played);
  const unplayed = (await query(`
    WITH known AS (SELECT t.track_id, t.name, t.album_id, al.name AS album,
                          CASE WHEN EXISTS (SELECT 1 FROM liked_songs l WHERE l.track_id = t.track_id) THEN 'liked'
                               WHEN EXISTS (SELECT 1 FROM playlist_items pi WHERE pi.track_id = t.track_id) THEN 'in a playlist' ELSE 'on an album you played' END AS source
                   FROM tracks t LEFT JOIN albums al ON al.album_id = t.album_id WHERE t.artist_id = $1 AND t.track_id NOT LIKE 'local:%'
                     AND NOT EXISTS (SELECT 1 FROM plays_resolved p WHERE p.track_id = t.track_id)),
    hint AS (SELECT al.album_id, ROUND(SUM(p.ms_played)/3600000.0, 1) AS h FROM plays_resolved p JOIN albums al ON al.album_id = p.album_id WHERE p.artist_id = $1 GROUP BY 1)
    SELECT k.*, CASE WHEN h.h IS NOT NULL THEN 'from an album you gave ' || h.h || ' h' END AS hint FROM known k LEFT JOIN hint h USING (album_id)
    ORDER BY (k.source = 'liked') DESC, h.h DESC NULLS LAST, k.name LIMIT 40`, [artistId])).map((r) => ({ trackId: String(r.track_id), track: String(r.name), album: str(r.album), albumId: str(r.album_id), source: String(r.source), hint: str(r.hint) }));
  const barely = (await query(`SELECT p.track_id, arg_max(p.track_name, p.ms_played) AS name, arg_max(p.album_name, p.ms_played) AS album, COUNT(*) AS c FROM plays_resolved p WHERE p.artist_id = $1 AND p.track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1 HAVING COUNT(*) <= 2 ORDER BY c ASC, MAX(p.played_at) ASC LIMIT 20`, [artistId]))
    .map((r) => ({ trackId: String(r.track_id), track: String(r.name), album: str(r.album), plays: num(r.c) }));
  const features = (await query(`
    SELECT tc.track_id, arg_max(p.track_name, p.ms_played) AS name, arg_max(p.artist_name, p.ms_played) AS primary_name, COUNT(*) AS c
    FROM track_credits tc JOIN plays_resolved p ON p.track_id = tc.track_id
    WHERE tc.credit_order > 0 AND tc.artist_id = $1 AND p.artist_id <> $1 ${playsWhere('p')} GROUP BY 1 ORDER BY c DESC LIMIT 12`, [artistId]))
    .map((r) => ({ trackId: String(r.track_id), track: String(r.name), primary: String(r.primary_name ?? ''), plays: num(r.c) }));
  const [f] = await query(`SELECT COUNT(DISTINCT track_id) AS n FROM track_credits WHERE credit_order > 0 AND artist_id = $1`, [artistId]);
  return { catalogueTracks: cat, played, penetration: cat && cat > 0 ? Math.min(1, played / cat) : null, unplayed, barelyPlayed: barely, features, featuredOn: num(f?.n) };
}
