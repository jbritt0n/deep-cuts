/**
 * Taste recommendations (REC-01…05) and the Discovery inbox (DIS-01…04).
 * Deterministic rules over your behaviour plus the cached Last.fm graph and
 * Last.fm / MusicBrainz tags. No LLM. Each candidate carries its reason.
 *
 * Sources (filled by the connectors):
 *   artist_relations  relation_type='similar'   related_mbid='<mbid|name:x>|<match>'   (Last.fm)
 *   artist_relations  relation_type in ('member of band','is person','collaboration',…) (MusicBrainz)
 *   artist_relations  relation_type='release'   related_mbid='<release-group-mbid>|<date>' related_name='<title>' (MusicBrainz)
 *   artist_tags       source in ('lastfm','musicbrainz')
 * Feedback: recommendation_feedback — dismissed keys are hidden for 90 days; accepted seeds get a boost.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';

export type Rec = {
  engine: 'adjacency' | 'tag_affinity' | 'structural' | 'side_project' | 'release_radar';
  key: string;               // stable key for feedback (mbid or name:x or album id)
  title: string;             // artist / album name
  subtitle: string | null;   // artist for albums, etc.
  reason: string;
  score: number;             // 0..1
  seeds: { artistId: string; artist: string }[];
  href: string | null;       // in-app link when the subject exists in the archive
  spotifySearch: string;     // fallback: search query for Spotify
};

const NOT_DISMISSED = `NOT EXISTS (SELECT 1 FROM recommendation_feedback f WHERE f.subject_key = %KEY% AND f.verdict = 'dismissed' AND f.decided_at >= now() - INTERVAL 90 DAY)`;
const nd = (expr: string) => NOT_DISMISSED.replace('%KEY%', expr);

/** Artists you already have, by normalised name — used to filter candidates and to weight seeds. */
const OWNED = () => `(SELECT a.artist_id, lower(a.name) AS lname, a.mbid, SUM(p.ms_played)/3600000.0 AS hours, COUNT(*) AS plays,
                       AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS skip_rate
                     FROM artists a JOIN plays_resolved p ON p.artist_id = a.artist_id WHERE 1=1 ${playsWhere('p')} GROUP BY 1, 2, 3)`;
const ACCEPT_BOOST = `(SELECT 1 + 0.5 * COUNT(*) FROM recommendation_feedback f WHERE f.verdict = 'accepted' AND f.subject_key = %KEY%)`;

// REC-01 — adjacency: artists next to your taste you haven't played.
export async function adjacency(limit = 20): Promise<Rec[]> {
  const rows = await query(`
    WITH owned AS ${OWNED()},
    edges AS (
      SELECT r.artist_mbid AS seed_id, r.related_name AS name,
             split_part(r.related_mbid, '|', 1) AS key,
             TRY_CAST(split_part(r.related_mbid, '|', 2) AS DOUBLE) AS match
      FROM artist_relations r WHERE r.relation_type = 'similar'),
    scored AS (
      SELECT e.name, e.key, SUM(e.match * LOG(1 + o.hours) * ${ACCEPT_BOOST.replace('%KEY%', 'e.key')}) AS score,
             list(struct_pack(artist_id := o.artist_id, artist := a.name) ORDER BY e.match * o.hours DESC) AS seeds
      FROM edges e JOIN owned o ON o.artist_id = e.seed_id JOIN artists a ON a.artist_id = o.artist_id
      WHERE NOT EXISTS (SELECT 1 FROM owned x WHERE x.lname = lower(e.name) OR (x.mbid IS NOT NULL AND x.mbid = e.key))
        AND ${nd('e.key')}
      GROUP BY 1, 2)
    SELECT *, score / NULLIF(MAX(score) OVER (), 0) AS norm FROM scored ORDER BY score DESC LIMIT ${limit}`);
  return rows.map((r) => {
    const seeds = ((r.seeds as { artist_id: string; artist: string }[]) ?? []).slice(0, 3).map((s) => ({ artistId: s.artist_id, artist: s.artist }));
    return { engine: 'adjacency', key: String(r.key), title: String(r.name), subtitle: null, score: num(r.norm),
      reason: `next to ${seeds.map((s) => s.artist).join(', ')} on Last.fm`, seeds, href: null, spotifySearch: String(r.name) };
  });
}

// REC-02 — tag affinity: tags you over-index on vs. your library's base rate, then artists carrying them that you lack.
export type TagSignature = { tag: string; yourShare: number; libraryShare: number; lift: number; hours: number; topArtists: string[] };
export async function tagSignature(limit = 15): Promise<TagSignature[]> {
  const rows = await query(`
    WITH owned AS ${OWNED()},
    tags AS (SELECT artist_id, tag, MAX(weight) AS w FROM artist_tags GROUP BY 1, 2),
    lib AS (SELECT t.tag, SUM(t.w) AS lib_w FROM tags t GROUP BY 1),
    you AS (SELECT t.tag, SUM(t.w * o.hours * (1 - o.skip_rate)) AS you_w,
                   list(a.name ORDER BY o.hours DESC) AS arts
            FROM tags t JOIN owned o USING (artist_id) JOIN artists a ON a.artist_id = o.artist_id GROUP BY 1),
    tot AS (SELECT (SELECT SUM(lib_w) FROM lib) AS lib_tot, (SELECT SUM(you_w) FROM you) AS you_tot)
    SELECT y.tag, y.you_w / t.you_tot AS your_share, l.lib_w / t.lib_tot AS lib_share,
           (y.you_w / t.you_tot) / NULLIF(l.lib_w / t.lib_tot, 0) AS lift, y.you_w AS hours, y.arts[1:4] AS arts
    FROM you y JOIN lib l USING (tag) CROSS JOIN tot t
    WHERE l.lib_w >= 3 ORDER BY lift DESC, your_share DESC LIMIT ${limit}`);
  return rows.map((r) => ({ tag: String(r.tag), yourShare: num(r.your_share), libraryShare: num(r.lib_share), lift: num(r.lift), hours: num(r.hours), topArtists: ((r.arts as string[]) ?? []) }));
}

/** Candidates for a tag: artists in the tag graph (via Last.fm similar edges or MB tags) that carry the tag and aren't yours. */
export async function tagAffinity(limit = 20): Promise<Rec[]> {
  const sig = await tagSignature(8);
  if (!sig.length) return [];
  const tagList = sig.map((s) => `'${s.tag.replace(/'/g, "''")}'`).join(',');
  // Artists we know tags for but don't own are rare (tags are fetched for owned artists), so we also
  // route through similar-artist edges whose *seed* carries the tag: "like X, who you over-index on".
  const rows = await query(`
    WITH owned AS ${OWNED()},
    sig AS (SELECT tag FROM (VALUES ${sig.map((s, i) => `('${s.tag.replace(/'/g, "''")}', ${sig.length - i})`).join(',')}) v(tag, rank)),
    seed_tags AS (SELECT t.artist_id, t.tag, MAX(t.weight) AS w FROM artist_tags t JOIN sig USING (tag) GROUP BY 1, 2),
    edges AS (SELECT r.artist_mbid AS seed_id, r.related_name AS name, split_part(r.related_mbid, '|', 1) AS key, TRY_CAST(split_part(r.related_mbid, '|', 2) AS DOUBLE) AS match
              FROM artist_relations r WHERE r.relation_type = 'similar'),
    cand AS (
      SELECT e.name, e.key, st.tag, SUM(e.match * st.w * LOG(1 + o.hours)) AS score, arg_max(a.name, o.hours) AS via
      FROM edges e JOIN seed_tags st ON st.artist_id = e.seed_id JOIN owned o ON o.artist_id = e.seed_id JOIN artists a ON a.artist_id = e.seed_id
      WHERE NOT EXISTS (SELECT 1 FROM owned x WHERE x.lname = lower(e.name) OR (x.mbid IS NOT NULL AND x.mbid = e.key)) AND ${nd('e.key')}
      GROUP BY 1, 2, 3)
    SELECT name, key, arg_max(tag, score) AS tag, arg_max(via, score) AS via, SUM(score) AS score,
           SUM(score) / NULLIF(MAX(SUM(score)) OVER (), 0) AS norm
    FROM cand WHERE tag IN (${tagList}) GROUP BY 1, 2 ORDER BY score DESC LIMIT ${limit}`);
  return rows.map((r) => ({ engine: 'tag_affinity', key: String(r.key), title: String(r.name), subtitle: null, score: num(r.norm),
    reason: `you over-index on ${String(r.tag)} — this sits next to ${String(r.via)}`, seeds: [], href: null, spotifySearch: String(r.name) }));
}

// REC-03 — structural gaps (pure SQL, works with zero external services).
export async function structural(limit = 20): Promise<Rec[]> {
  const PW = playsWhere();
  // (a) beloved artist, one album takes ≥ 60% of hours, and you've heard fewer than 60% of the tracks you know exist on other albums
  const loyalty = await query(`
    WITH ah AS (SELECT artist_id, artist_name, SUM(ms_played)/3600000.0 AS h, COUNT(DISTINCT album_id) AS albums FROM plays_resolved WHERE artist_id IS NOT NULL ${PW} GROUP BY 1, 2 HAVING SUM(ms_played)/3600000.0 >= 5),
         al AS (SELECT artist_id, album_id, album_name, SUM(ms_played)/3600000.0 AS h, COUNT(DISTINCT track_id) AS tracks FROM plays_resolved WHERE album_id IS NOT NULL ${PW} GROUP BY 1, 2, 3),
         top AS (SELECT * FROM al QUALIFY ROW_NUMBER() OVER (PARTITION BY artist_id ORDER BY h DESC) = 1),
         other AS (SELECT al.artist_id, arg_max(al.album_name, al.h) AS next_album, arg_max(al.album_id, al.h) AS next_id, MAX(al.h) AS next_h FROM al JOIN top t ON t.artist_id = al.artist_id AND t.album_id <> al.album_id GROUP BY 1)
    SELECT ah.artist_id, ah.artist_name, ah.h, t.album_name, t.h / ah.h AS share, o.next_album, o.next_id, o.next_h, ah.albums
    FROM ah JOIN top t USING (artist_id) LEFT JOIN other o USING (artist_id)
    WHERE t.h / ah.h >= 0.6 AND ${nd("'album-gap:' || ah.artist_id")}
    ORDER BY ah.h DESC LIMIT ${limit}`);
  // (b) underserved taste: low skip rate, decent completion, but few plays
  const underserved = await query(`
    SELECT artist_id, artist_name, COUNT(*) AS plays, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr, SUM(ms_played)/3600000.0 AS h,
           COUNT(DISTINCT track_id) AS tracks, MAX(played_at) AS last_at
    FROM plays_resolved WHERE artist_id IS NOT NULL ${PW} GROUP BY 1, 2
    HAVING COUNT(*) BETWEEN 8 AND 40 AND AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) <= 0.03 AND COUNT(DISTINCT track_id) >= 4
       AND ${nd("'underserved:' || artist_id")}
    ORDER BY (1 - sr) * LOG(plays) DESC, last_at DESC LIMIT ${limit}`);
  // (c) forgotten favourites: ≥ 5 h all time, nothing in 18 months
  const forgotten = await query(`
    SELECT artist_id, artist_name, SUM(ms_played)/3600000.0 AS h, MAX(played_at) AS last_at, COUNT(*) AS plays
    FROM plays_resolved WHERE artist_id IS NOT NULL ${PW} GROUP BY 1, 2
    HAVING SUM(ms_played)/3600000.0 >= 5 AND MAX(played_at) < CAST(now() AS DATE) - INTERVAL 540 DAY AND ${nd("'forgotten:' || artist_id")}
    ORDER BY h DESC LIMIT ${limit}`);
  // (d) one-track wonders: an artist where a single track is ≥ 70% of ≥ 15 plays — you never looked past the hit
  const oneTrack = await query(`
    WITH a AS (SELECT artist_id, artist_name, COUNT(*) AS plays, COUNT(DISTINCT track_id) AS tracks FROM plays_resolved WHERE artist_id IS NOT NULL ${PW} GROUP BY 1, 2 HAVING COUNT(*) >= 15),
         t AS (SELECT artist_id, arg_max(track_name, c) AS hit, MAX(c) AS hit_plays FROM (SELECT artist_id, track_name, COUNT(*) c FROM plays_resolved WHERE 1=1 ${PW} GROUP BY 1, 2) GROUP BY 1)
    SELECT a.*, t.hit, t.hit_plays FROM a JOIN t USING (artist_id) WHERE t.hit_plays * 1.0 / a.plays >= 0.7 AND ${nd("'one-track:' || a.artist_id")} ORDER BY a.plays DESC LIMIT ${limit}`);
  const out: Rec[] = [];
  for (const r of forgotten) {
    const months = Math.round((Date.now() - new Date(String(r.last_at).replace(' ', 'T')).getTime()) / (30 * 86400e3));
    out.push({ engine: 'structural', key: `forgotten:${String(r.artist_id)}`, title: String(r.artist_name), subtitle: 'forgotten favourite', score: Math.min(1, num(r.h) / 60),
      seeds: [{ artistId: String(r.artist_id), artist: String(r.artist_name) }], href: `/artist/${encodeURIComponent(String(r.artist_id))}`,
      reason: `${num(r.h).toFixed(0)} hours with them, then nothing for ${months} months`, spotifySearch: String(r.artist_name) });
  }
  for (const r of oneTrack) {
    out.push({ engine: 'structural', key: `one-track:${String(r.artist_id)}`, title: String(r.artist_name), subtitle: `beyond “${String(r.hit)}”`, score: Math.min(1, num(r.plays) / 80),
      seeds: [{ artistId: String(r.artist_id), artist: String(r.artist_name) }], href: `/artist/${encodeURIComponent(String(r.artist_id))}`,
      reason: `${num(r.hit_plays)} of your ${num(r.plays)} plays are “${String(r.hit)}” — you never looked past the hit`, spotifySearch: String(r.artist_name) });
  }
  for (const r of loyalty) {
    const share = num(r.share), albums = num(r.albums);
    out.push({ engine: 'structural', key: `album-gap:${String(r.artist_id)}`, title: String(r.artist_name), subtitle: `beyond ${String(r.album_name)}`,
      score: Math.min(1, share), seeds: [{ artistId: String(r.artist_id), artist: String(r.artist_name) }], href: `/artist/${encodeURIComponent(String(r.artist_id))}`,
      reason: `${Math.round(share * 100)}% of your ${num(r.h).toFixed(0)} hours with them is ${String(r.album_name)}${albums > 1 && r.next_album ? ` — ${String(r.next_album)} has ${num(r.next_h).toFixed(1)} h` : ' — the rest of the catalogue is unexplored'}`,
      spotifySearch: `${String(r.artist_name)} discography` });
  }
  for (const r of underserved) {
    out.push({ engine: 'structural', key: `underserved:${String(r.artist_id)}`, title: String(r.artist_name), subtitle: 'underserved taste',
      score: Math.min(1, (1 - num(r.sr)) * Math.log(num(r.plays)) / 4), seeds: [{ artistId: String(r.artist_id), artist: String(r.artist_name) }], href: `/artist/${encodeURIComponent(String(r.artist_id))}`,
      reason: `${num(r.plays)} plays, ${num(r.tracks)} tracks, ${Math.round(num(r.sr) * 100)}% skipped — you never bail, yet you rarely go back`, spotifySearch: String(r.artist_name) });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}

// REC-04 — side projects from MusicBrainz relationships.
export async function sideProjects(limit = 15): Promise<Rec[]> {
  const rows = await query(`
    WITH owned AS ${OWNED()},
    rel AS (SELECT r.artist_mbid, r.relation_type, split_part(r.related_mbid, '|', 1) AS key, r.related_name
            FROM artist_relations r WHERE r.relation_type NOT IN ('similar', 'release'))
    SELECT a.artist_id, a.name AS artist, o.hours, rel.relation_type, rel.key, rel.related_name,
           EXISTS (SELECT 1 FROM owned x WHERE x.mbid = rel.key OR x.lname = lower(rel.related_name)) AS owned_too
    FROM rel JOIN artists a ON a.mbid = rel.artist_mbid JOIN owned o ON o.artist_id = a.artist_id
    WHERE ${nd('rel.key')}
    QUALIFY ROW_NUMBER() OVER (PARTITION BY rel.key ORDER BY o.hours DESC) = 1
    ORDER BY o.hours DESC LIMIT ${limit * 2}`);
  return rows.filter((r) => !r.owned_too).slice(0, limit).map((r) => ({
    engine: 'side_project', key: String(r.key), title: String(r.related_name), subtitle: String(r.relation_type),
    score: Math.min(1, num(r.hours) / 40), seeds: [{ artistId: String(r.artist_id), artist: String(r.artist) }],
    reason: `you love ${String(r.artist)} — ${String(r.related_name)} is ${relationPhrase(String(r.relation_type))}`, href: null, spotifySearch: String(r.related_name) }));
}
const relationPhrase = (t: string) => ({ 'member of band': 'a band they play in', 'is person': 'the same person', 'collaboration': 'a collaboration of theirs', 'founder': 'a project they founded', 'subgroup': 'a subgroup', 'supporting musician': 'someone they play with', 'vocal': 'someone they sing with', 'instrumental supporting musician': 'someone they play with' }[t] ?? `linked (${t})`);

// REC-05 — release radar: new release groups for artists in your library, ranked by your hours.
export type Release = { key: string; title: string; artistId: string; artist: string; date: string; hours: number; kind: string };
export async function releaseRadar(limit = 20): Promise<Release[]> {
  const rows = await query(`
    WITH owned AS ${OWNED()}
    SELECT split_part(r.related_mbid, '|', 1) AS key, r.related_name AS title, split_part(r.related_mbid, '|', 2) AS date,
           a.artist_id, a.name AS artist, o.hours, COALESCE(r.relation_type, 'release') AS kind
    FROM artist_relations r JOIN artists a ON a.mbid = r.artist_mbid JOIN owned o ON o.artist_id = a.artist_id
    WHERE r.relation_type = 'release' AND TRY_CAST(split_part(r.related_mbid, '|', 2) AS DATE) >= CAST(now() AS DATE) - INTERVAL 180 DAY
      AND ${nd("split_part(r.related_mbid, '|', 1)")}
    ORDER BY o.hours DESC, date DESC LIMIT ${limit}`);
  return rows.map((r) => ({ key: String(r.key), title: String(r.title), artistId: String(r.artist_id), artist: String(r.artist), date: String(r.date), hours: num(r.hours), kind: String(r.kind) }));
}

export type Inbox = { recs: Rec[]; releases: Release[]; signature: TagSignature[]; unavailable: string[]; dismissedCount: number; acceptedCount: number };
export async function inbox(): Promise<Inbox> {
  const unavailable: string[] = [];
  const [hasSimilar, hasTags, hasMb] = await Promise.all([
    query(`SELECT COUNT(*) AS n FROM artist_relations WHERE relation_type = 'similar'`).then((r) => num(r[0]?.n) > 0),
    query(`SELECT COUNT(*) AS n FROM artist_tags`).then((r) => num(r[0]?.n) > 0),
    query(`SELECT COUNT(*) AS n FROM artists WHERE mbid IS NOT NULL`).then((r) => num(r[0]?.n) > 0),
  ]);
  const safe = async <T,>(label: string, ok: boolean, fn: () => Promise<T[]>): Promise<T[]> => {
    if (!ok) { unavailable.push(label); return []; }
    try { return await fn(); } catch { unavailable.push(label); return []; }
  };
  const [adj, tag, struct, side, rel, sig] = await Promise.all([
    safe('adjacency (needs Last.fm)', hasSimilar, () => adjacency(15)),
    safe('tag affinity (needs Last.fm or MusicBrainz tags)', hasTags && hasSimilar, () => tagAffinity(15)),
    structural(15),
    safe('side projects (needs MusicBrainz)', hasMb, () => sideProjects(10)),
    safe('release radar (needs MusicBrainz)', hasMb, () => releaseRadar(15)),
    hasTags ? tagSignature(10).catch(() => []) : Promise.resolve([]),
  ]);
  const seen = new Set<string>();
  const recs = [...adj, ...tag, ...side, ...struct].filter((r) => (seen.has(r.key) ? false : (seen.add(r.key), true))).sort((a, b) => b.score - a.score);
  const fb = await query(`SELECT verdict, COUNT(*) AS n FROM recommendation_feedback GROUP BY 1`);
  const cnt = (v: string) => num(fb.find((r) => r.verdict === v)?.n);
  return { recs, releases: rel, signature: sig, unavailable, dismissedCount: cnt('dismissed'), acceptedCount: cnt('accepted') };
}

// Curated playlist exports (DIS-01 + PLY-10): deterministic lists built from your own archive.
export type Curated = { id: string; title: string; blurb: string; tracks: import('./types').TrackRow[] };
export async function curated(): Promise<Curated[]> {
  const PW = playsWhere();
  const T = `track_id AS "trackId", track_name AS track, artist_id AS "artistId", artist_name AS artist, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"`;
  const map = (rows: Record<string, unknown>[]) => rows.map((r) => ({ trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate) }));
  const lists: Curated[] = [];
  lists.push({ id: 'rediscover', title: 'Rediscover', blurb: 'Songs you played 8+ times, never skipped, and haven\'t heard in over a year.', tracks: map(await query(`
    SELECT ${T} FROM plays_resolved WHERE track_id IS NOT NULL ${PW} GROUP BY 1, 2, 3, 4
    HAVING COUNT(*) >= 8 AND AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) <= 0.05 AND MAX(played_at) < CAST(now() AS DATE) - INTERVAL 365 DAY ORDER BY plays DESC LIMIT 40`)) });
  lists.push({ id: 'bsides', title: 'B-sides of your favourite albums', blurb: 'The least-played tracks from the albums you\'ve spent the most hours with.', tracks: map(await query(`
    WITH top AS (SELECT album_id FROM plays_resolved WHERE album_id IS NOT NULL ${PW} GROUP BY 1 ORDER BY SUM(ms_played) DESC LIMIT 25),
         t AS (SELECT ${T}, album_id, ROW_NUMBER() OVER (PARTITION BY album_id ORDER BY COUNT(*) ASC) AS rn FROM plays_resolved WHERE album_id IN (SELECT album_id FROM top) AND track_id IS NOT NULL ${PW} GROUP BY 1, 2, 3, 4, album_id)
    SELECT "trackId", track, "artistId", artist, plays, hours, "skipRate" FROM t WHERE rn <= 2 AND plays <= 3 ORDER BY album_id LIMIT 40`)) });
  lists.push({ id: 'never-skip', title: 'Never skipped, rarely played', blurb: 'Two to five plays, zero skips — songs that clearly work but never got their turn.', tracks: map(await query(`
    SELECT ${T} FROM plays_resolved WHERE track_id IS NOT NULL ${PW} GROUP BY 1, 2, 3, 4
    HAVING COUNT(*) BETWEEN 2 AND 5 AND SUM(CASE WHEN was_skipped THEN 1 ELSE 0 END) = 0 AND SUM(ms_played) >= 300000 ORDER BY SUM(ms_played) DESC LIMIT 40`)) });
  lists.push({ id: 'one-and-done', title: 'Played once, played through', blurb: 'Heard exactly once, all the way to the end. Worth a second listen.', tracks: map(await query(`
    SELECT ${T} FROM plays_resolved WHERE track_id IS NOT NULL AND end_reason = 'trackdone' AND ms_played >= 120000 ${PW} GROUP BY 1, 2, 3, 4 HAVING COUNT(*) = 1 ORDER BY MAX(played_at) DESC LIMIT 40`)) });
  lists.push({ id: 'openers', title: 'Openers', blurb: 'The songs you most often start a session with — your own overture.', tracks: map(await query(`
    SELECT t.track_id AS "trackId", t.name AS track, t.artist_id AS "artistId", a.name AS artist, COUNT(*) AS plays, 0 AS hours, 0 AS "skipRate"
    FROM sessions s JOIN tracks t ON t.track_id = s.opening_track_id LEFT JOIN artists a ON a.artist_id = t.artist_id WHERE s.track_count >= 3 GROUP BY 1, 2, 3, 4 ORDER BY plays DESC LIMIT 30`)) });
  return lists.filter((l) => l.tracks.length >= 5);
}

export const spotifySearchUrl = (q: string) => `https://open.spotify.com/search/${encodeURIComponent(q)}`;
export { str };
