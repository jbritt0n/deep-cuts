/**
 * Phase 9f — the scene vocabulary as data.
 *
 * Until 9e the 18 scene families and the tags that fed them were a VALUES list inside
 * compute_insights.sql. They now live in three tables (schema.sql) that the owner can extend:
 *   scene_families    the families themselves (label, region | style, hidden)
 *   scene_tag_map     tag → family
 *   scene_origin_map  origin country → family (fallback when an artist has no mapped tag)
 * `compute_scenes.sql` rebuilds artist_scene from them; the Crate, Scenes, session chains and
 * the chaos legend all read artist_scene, so a new family appears everywhere at once.
 *
 * This module reads the vocabulary, reports how much of the record each family covers, lists the
 * tags your artists carry that map to nothing yet (the queue for the owner to file), and wraps the
 * write commands. Writes go through the host (Rust / dev-server) so the browser harness and the
 * desktop app behave identically.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';
import { playsWhere } from './filter';

export type SceneFamily = {
  scene: string; label: string; kind: 'region' | 'style'; blurb: string | null; builtin: boolean; hidden: boolean;
  tags: number; artists: number; hours: number; filedByYou: number;
};

/** Every family with its coverage under the lens: tags mapped, artists filed, hours. Hidden ones too (so they can be switched back on). */
export async function sceneFamilies(): Promise<SceneFamily[]> {
  const rows = await query(`
    WITH tg AS (SELECT scene, COUNT(*) AS tags FROM scene_tag_map GROUP BY 1),
         ar AS (SELECT sc.scene, COUNT(DISTINCT sc.artist_id) AS artists, COUNT(DISTINCT sc.artist_id) FILTER (WHERE sc.weight >= 9) AS filed FROM artist_scene sc GROUP BY 1),
         hr AS (SELECT s.scene, SUM(p.ms_played)/3600000.0 AS h FROM plays_resolved p JOIN (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1) s USING (artist_id) WHERE 1=1 ${playsWhere('p')} GROUP BY 1)
    SELECT f.scene, f.label, f.kind, f.blurb, f.builtin, f.hidden, COALESCE(tg.tags, 0) AS tags, COALESCE(ar.artists, 0) AS artists, COALESCE(ar.filed, 0) AS filed, COALESCE(hr.h, 0) AS hours
    FROM scene_families f LEFT JOIN tg USING (scene) LEFT JOIN ar USING (scene) LEFT JOIN hr USING (scene)
    ORDER BY f.hidden, hours DESC, f.label`);
  return rows.map((r) => ({
    scene: String(r.scene), label: String(r.label ?? r.scene), kind: (r.kind === 'region' ? 'region' : 'style'), blurb: str(r.blurb), builtin: Boolean(r.builtin), hidden: Boolean(r.hidden),
    tags: num(r.tags), artists: num(r.artists), hours: num(r.hours), filedByYou: num(r.filed),
  }));
}

/** Just the visible keys + labels, in label order — for pickers (Crate re-file, Settings). */
export async function sceneOptions(): Promise<{ scene: string; label: string; kind: string }[]> {
  return (await query(`SELECT scene, label, kind FROM scene_families WHERE NOT hidden ORDER BY kind, label`)).map((r) => ({ scene: String(r.scene), label: String(r.label ?? r.scene), kind: String(r.kind ?? 'style') }));
}

/** label lookup used by every page that prints a scene key. Falls back to the key itself. */
export async function sceneLabels(): Promise<Record<string, string>> {
  const out: Record<string, string> = { unsorted: 'unsorted' };
  for (const r of await query(`SELECT scene, label FROM scene_families`)) out[String(r.scene)] = String(r.label ?? r.scene);
  return out;
}

export type SceneTag = { tag: string; scene: string | null; builtin: boolean; artists: number; hours: number };
/** The tags mapped to one family, with how many of your artists carry each. */
export async function sceneTags(scene: string): Promise<SceneTag[]> {
  return (await query(`
    WITH use AS (SELECT lower(t.tag) AS tag, COUNT(DISTINCT t.artist_id) AS artists, SUM(p.ms_played)/3600000.0 AS h
                 FROM artist_tags t LEFT JOIN plays_resolved p ON p.artist_id = t.artist_id ${playsWhere('p')} WHERE t.weight >= 0.2 GROUP BY 1)
    SELECT m.tag, m.scene, m.builtin, COALESCE(u.artists, 0) AS artists, COALESCE(u.h, 0) AS hours
    FROM scene_tag_map m LEFT JOIN use u USING (tag) WHERE m.scene = $1 ORDER BY hours DESC, artists DESC, m.tag`, [scene])).map(toTag);
}

/**
 * Tags your artists carry that map to no family — the owner's filing queue. Weighted by hours under the
 * lens so the tag that would move the most listening into a section comes first. Umbrella words that
 * never make a good family ("seen live", "favorites", decades) are filtered.
 */
export async function unmappedTags(limit = 60): Promise<SceneTag[]> {
  return (await query(`
    WITH t AS (SELECT lower(t.tag) AS tag, t.artist_id, MAX(t.weight) AS w FROM artist_tags t WHERE t.weight >= 0.3 GROUP BY 1, 2),
         h AS (SELECT artist_id, SUM(ms_played)/3600000.0 AS h FROM plays_resolved p WHERE 1=1 ${playsWhere('p')} GROUP BY 1)
    SELECT t.tag, NULL AS scene, FALSE AS builtin, COUNT(DISTINCT t.artist_id) AS artists, COALESCE(SUM(h.h), 0) AS hours
    FROM t LEFT JOIN h USING (artist_id)
    WHERE NOT EXISTS (SELECT 1 FROM scene_tag_map m WHERE m.tag = t.tag)
      AND t.tag NOT IN ('seen live', 'favorites', 'favourites', 'favorite', 'favourite', 'all', 'awesome', 'love', 'loved', 'beautiful', 'chill', 'chillout', 'mellow', 'summer', 'party', 'sad', 'happy', 'epic', 'cool', 'good', 'great', 'best', 'male vocalists', 'female vocalists', 'male vocalist', 'female vocalist', 'vocal', 'vocals', 'instrumental', 'under 2000 listeners', 'american', 'usa', 'british', 'uk', 'english', 'canadian', 'pop', 'singer', 'band', 'guitar', 'live', 'covers', 'cover', 'remix', 'soundtracks', 'various', 'various artists', 'compilation', 'my music', 'check out', 'spotify', 'youtube', 'radio', 'oldies', 'classic', 'classics', 'legend', 'legends', 'genius', 'underrated', 'overrated', 'catchy', 'fun', 'dark', 'dreamy', 'atmospheric', 'melancholy', 'melancholic', 'relax', 'relaxing', 'sleep', 'study', 'workout', 'driving', 'rainy day', 'night', 'morning', 'love songs', 'romantic', 'sexy', 'weird', 'strange', 'unique', 'experimental pop', 'new', 'old', 'retro', 'vintage', 'nostalgia', 'nostalgic', 'gay', 'queer', 'lgbt', 'religious', 'christian', 'christmas', 'holiday', 'kids', 'children', 'comedy', 'spoken word', 'podcast', 'audiobook')
      AND t.tag NOT SIMILAR TO '(19|20)[0-9]0s?|[0-9]0s|[0-9]{4}'
    GROUP BY 1 ORDER BY hours DESC, artists DESC LIMIT ${Math.max(1, Math.round(limit))}`)).map(toTag);
}

/** Origin-country fallbacks, with how many of your artists each covers and how many would otherwise be unfiled. */
export async function sceneOrigins(): Promise<{ country: string; scene: string; builtin: boolean; artists: number; fallbackArtists: number }[]> {
  return (await query(`
    SELECT m.country, m.scene, m.builtin, COUNT(o.artist_id) AS artists,
           COUNT(o.artist_id) FILTER (WHERE NOT EXISTS (SELECT 1 FROM artist_tags t JOIN scene_tag_map tm ON tm.tag = lower(t.tag) WHERE t.artist_id = o.artist_id)) AS fallback
    FROM scene_origin_map m LEFT JOIN artist_origin o ON o.country = m.country GROUP BY 1, 2, 3 ORDER BY artists DESC, m.country`)).map((r) => ({ country: String(r.country), scene: String(r.scene), builtin: Boolean(r.builtin), artists: num(r.artists), fallbackArtists: num(r.fallback) }));
}

/** Countries your artists come from that have no fallback family yet. */
export async function unmappedOrigins(): Promise<{ country: string; artists: number }[]> {
  return (await query(`SELECT o.country, COUNT(*) AS n FROM artist_origin o WHERE o.country IS NOT NULL AND NOT EXISTS (SELECT 1 FROM scene_origin_map m WHERE m.country = o.country) GROUP BY 1 ORDER BY n DESC LIMIT 40`)).map((r) => ({ country: String(r.country), artists: num(r.n) }));
}

const toTag = (r: Record<string, unknown>): SceneTag => ({ tag: String(r.tag), scene: str(r.scene), builtin: Boolean(r.builtin), artists: num(r.artists), hours: num(r.hours) });

// ------------------------------------------------------------------ writes (host commands)

/** Slugify a label into a stable scene key: "Thai funk & molam" → "thai-funk-molam". */
export const sceneKey = (label: string) => label.toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'scene';

export const upsertSceneFamily = (f: { scene: string; label: string; kind: 'region' | 'style'; blurb?: string | null; hidden?: boolean }) =>
  invoke<void>('scene_family_upsert', { scene: f.scene, label: f.label, kind: f.kind, blurb: f.blurb ?? null, hidden: f.hidden ?? false });
/** Owner-made families only; built-ins can be hidden instead. Unmaps its tags and origins and clears overrides that pointed at it. */
export const deleteSceneFamily = (scene: string) => invoke<void>('scene_family_delete', { scene });
/** scene = null removes the mapping. */
export const setSceneTag = (tag: string, scene: string | null) => invoke<void>('scene_tag_set', { tag: tag.toLowerCase().trim(), scene });
export const setSceneOrigin = (country: string, scene: string | null) => invoke<void>('scene_origin_set', { country: country.toUpperCase().trim(), scene });
/** Re-run compute_scenes.sql now (a second or two) so the Crate and Scenes reflect the new vocabulary without waiting for the nightly rebuild. */
export const recomputeScenes = () => invoke<{ artists: number; families: number }>('recompute_scenes');
