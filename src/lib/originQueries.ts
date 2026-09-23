/**
 * Phase 9g — where your music comes from. MusicBrainz origin per artist (`artist_origin`, Phase 7)
 * aggregated per ISO country under the listening lens; scene families join for the "what kind" line.
 * Coverage is honest: artists without a resolved origin are counted and shown as such.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';

export type CountryRow = { country: string; name: string; hours: number; plays: number; artists: number; share: number; topArtists: string[]; scene: string | null; sceneLabel: string | null; firstPlayed: string | null };
export type OriginSummary = { rows: CountryRow[]; totalHours: number; coveredHours: number; coveredArtists: number; totalArtists: number; countries: number };

export async function originSummary(): Promise<OriginSummary> {
  const rows = await query(`
    WITH pa AS (SELECT artist_id, arg_max(artist_name, ms_played) AS artist, SUM(ms_played)/3600000.0 AS h, COUNT(*) AS c, MIN(played_at) AS first_at
                FROM plays_resolved p WHERE artist_id IS NOT NULL ${playsWhere('p')} GROUP BY 1),
         sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
         j AS (SELECT o.country, COALESCE(o.country_name, o.country) AS name, pa.*, sc.scene FROM pa JOIN artist_origin o USING (artist_id) LEFT JOIN sc USING (artist_id) WHERE o.country IS NOT NULL)
    SELECT country, arg_max(name, h) AS name, SUM(h) AS hours, SUM(c) AS plays, COUNT(*) AS artists,
           list(artist ORDER BY h DESC)[1:5] AS top, arg_max(scene, h) FILTER (WHERE scene IS NOT NULL) AS scene, CAST(MIN(first_at) AS VARCHAR) AS first_at
    FROM j GROUP BY 1 ORDER BY hours DESC`);
  const labels: Record<string, string> = {};
  for (const r of await query(`SELECT scene, label FROM scene_families`)) labels[String(r.scene)] = String(r.label);
  const [t] = await query(`
    WITH pa AS (SELECT artist_id, SUM(ms_played)/3600000.0 AS h FROM plays_resolved p WHERE artist_id IS NOT NULL ${playsWhere('p')} GROUP BY 1)
    SELECT SUM(h) AS total, SUM(h) FILTER (WHERE o.country IS NOT NULL) AS covered, COUNT(*) AS artists, COUNT(*) FILTER (WHERE o.country IS NOT NULL) AS covered_artists
    FROM pa LEFT JOIN artist_origin o USING (artist_id)`);
  const totalHours = num(t?.total), coveredHours = num(t?.covered);
  const out: CountryRow[] = rows.map((r) => ({
    country: String(r.country), name: String(r.name), hours: num(r.hours), plays: num(r.plays), artists: num(r.artists), share: coveredHours ? num(r.hours) / coveredHours : 0,
    topArtists: Array.isArray(r.top) ? (r.top as unknown[]).map(String) : [], scene: str(r.scene), sceneLabel: r.scene ? labels[String(r.scene)] ?? String(r.scene) : null, firstPlayed: str(r.first_at)?.slice(0, 10) ?? null,
  }));
  return { rows: out, totalHours, coveredHours, coveredArtists: num(t?.covered_artists), totalArtists: num(t?.artists), countries: out.length };
}

export type CountryArtist = { artistId: string; artist: string; hours: number; plays: number; city: string | null; scene: string | null; firstPlayed: string };
export async function countryArtists(country: string, limit = 40): Promise<CountryArtist[]> {
  return (await query(`
    WITH sc AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1)
    SELECT p.artist_id, arg_max(p.artist_name, p.ms_played) AS artist, SUM(p.ms_played)/3600000.0 AS h, COUNT(*) AS c, arg_max(o.city, p.ms_played) AS city, arg_max(sc.scene, p.ms_played) AS scene, CAST(MIN(p.played_at) AS VARCHAR) AS first_at
    FROM plays_resolved p JOIN artist_origin o USING (artist_id) LEFT JOIN sc USING (artist_id) WHERE o.country = $1 ${playsWhere('p')} GROUP BY 1 ORDER BY h DESC LIMIT ${Math.round(limit)}`, [country]))
    .map((r) => ({ artistId: String(r.artist_id), artist: String(r.artist), hours: num(r.h), plays: num(r.c), city: str(r.city), scene: str(r.scene), firstPlayed: String(r.first_at).slice(0, 10) }));
}

/** Hours per country per year — for "how your map widened": how many countries per year, and the newcomers. */
export async function originByYear(): Promise<{ year: number; countries: number; newCountries: string[]; hours: number }[]> {
  return (await query(`
    WITH py AS (SELECT o.country, EXTRACT(year FROM p.played_at)::INT AS y, SUM(p.ms_played)/3600000.0 AS h FROM plays_resolved p JOIN artist_origin o USING (artist_id) WHERE o.country IS NOT NULL ${playsWhere('p')} GROUP BY 1, 2 HAVING SUM(p.ms_played) >= 1800000),
         first AS (SELECT country, MIN(y) AS y0 FROM py GROUP BY 1)
    SELECT py.y AS year, COUNT(DISTINCT py.country) AS countries, SUM(py.h) AS hours, list(f.country ORDER BY py.h DESC) FILTER (WHERE f.y0 = py.y) AS newc
    FROM py LEFT JOIN first f ON f.country = py.country GROUP BY 1 ORDER BY 1`)).map((r) => ({ year: num(r.year), countries: num(r.countries), hours: num(r.hours), newCountries: Array.isArray(r.newc) ? (r.newc as unknown[]).map(String) : [] }));
}
