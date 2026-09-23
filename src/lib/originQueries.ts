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

// ============================================================================ Phase 9h — listening abroad
// Where you were, not where the artist is from. A play's country is Spotify's conn_country (extended export) or, for
// polled plays that lack it, the single country of a travel time zone (Settings → Record → travel ranges) when that
// zone isn't home. Home = the `home_country` setting, else the country with the most plays.
const WHERE = (home: string) => `
  zc AS (SELECT zone, MIN(country) AS country FROM country_zones GROUP BY 1 HAVING COUNT(*) = 1),
  hz AS (SELECT COALESCE((SELECT value FROM app_meta WHERE key = 'timezone'), 'UTC') AS zone),
  pw AS (SELECT p.*, COALESCE(p.country, CASE WHEN p.zone <> (SELECT zone FROM hz) THEN zc.country END, '${home}') AS where_cc
         FROM plays_resolved p LEFT JOIN zc ON zc.zone = p.zone WHERE p.attended ${playsWhere('p')})`;

export async function homeCountry(): Promise<{ country: string; detected: boolean; knownShare: number }> {
  const [s] = await query(`SELECT value FROM app_meta WHERE key = 'home_country'`);
  const [m] = await query(`SELECT arg_max(country, n) AS c, SUM(n) FILTER (WHERE country IS NOT NULL) * 1.0 / SUM(n) AS share FROM (SELECT country, COUNT(*) AS n FROM plays_resolved GROUP BY 1)`);
  const set = str(s?.value)?.toUpperCase();
  const fallback = str(m?.c) ?? 'US';
  return { country: set && /^[A-Z]{2}$/.test(set) ? set : fallback, detected: !(set && /^[A-Z]{2}$/.test(set)), knownShare: num(m?.share) };
}

export type Trip = {
  id: string; country: string; name: string; start: string; end: string; days: number; hours: number; plays: number;
  topArtists: { artistId: string; artist: string; hours: number }[];
  souvenir: { trackId: string; track: string; artist: string; tripPlays: number; totalPlays: number } | null;
  localShare: number; homeLocalShare: number;   // share of listening from artists of this country — on the trip, and at home
};
export type AbroadCountry = { country: string; name: string; trips: number; days: number; hours: number; localShare: number; homeLocalShare: number; topArtists: string[] };
export type AbroadSummary = { home: string; homeDetected: boolean; knownShare: number; trips: Trip[]; countries: AbroadCountry[]; hoursAbroad: number; hoursTotal: number; scenes: { scene: string; label: string; abroad: number; home: number; lift: number }[]; byCountryHours: Record<string, number> };

/** Trips = runs of days in the same foreign country with gaps of ≤ 3 days, at least 30 minutes of listening. */
export async function abroadSummary(): Promise<AbroadSummary> {
  const h = await homeCountry(); const home = h.country;
  const tripsRows = await query(`WITH ${WHERE(home)},
    d AS (SELECT where_cc AS cc, CAST(played_at AS DATE) AS day, SUM(ms_played) AS ms FROM pw WHERE where_cc <> '${home}' GROUP BY 1, 2),
    g AS (SELECT *, SUM(CASE WHEN prev IS NULL OR day - prev > 3 THEN 1 ELSE 0 END) OVER (PARTITION BY cc ORDER BY day) AS trip FROM (SELECT *, LAG(day) OVER (PARTITION BY cc ORDER BY day) AS prev FROM d)),
    t AS (SELECT cc, trip, MIN(day) AS s, MAX(day) AS e, COUNT(*) AS days, SUM(ms)/3600000.0 AS h FROM g GROUP BY 1, 2 HAVING SUM(ms) >= 1800000)
    SELECT cc, trip, CAST(s AS VARCHAR) AS s, CAST(e AS VARCHAR) AS e, days, h FROM t ORDER BY s DESC`);
  const names: Record<string, string> = {};
  for (const r of await query(`SELECT country, arg_max(country_name, 1) AS n FROM artist_origin WHERE country IS NOT NULL GROUP BY 1`)) names[String(r.country)] = String(r.n);
  const nm = (cc: string) => names[cc] ?? REGION.of(cc) ?? cc;
  // home baseline: share of home listening per artist-origin country
  const baseRows = await query(`WITH ${WHERE(home)} SELECT o.country AS cc, SUM(pw.ms_played) * 1.0 / (SELECT SUM(ms_played) FROM pw WHERE where_cc = '${home}') AS share FROM pw JOIN artist_origin o USING (artist_id) WHERE pw.where_cc = '${home}' GROUP BY 1`);
  const homeShare = new Map(baseRows.map((r) => [String(r.cc), num(r.share)]));
  const trips: Trip[] = [];
  for (const r of tripsRows.slice(0, 40)) {
    const cc = String(r.cc), s = String(r.s).slice(0, 10), e = String(r.e).slice(0, 10);
    const inTrip = `pw.where_cc = '${cc}' AND CAST(pw.played_at AS DATE) BETWEEN CAST('${s}' AS DATE) AND CAST('${e}' AS DATE)`;
    const top = await query(`WITH ${WHERE(home)} SELECT artist_id, arg_max(artist_name, ms_played) AS a, SUM(ms_played)/3600000.0 AS h FROM pw WHERE ${inTrip} AND artist_id IS NOT NULL GROUP BY 1 ORDER BY h DESC LIMIT 4`);
    // souvenir: the song most particular to the trip — trip plays² / all-time plays, at least two plays there; songs by
    // artists from the country you were in count 1.5× (the Raffaella-Carrà-in-Italy effect)
    const [sv] = await query(`WITH ${WHERE(home)}, tp AS (SELECT track_id, arg_max(track_name, ms_played) AS t, arg_max(artist_name, ms_played) AS a, arg_max(artist_id, ms_played) AS aid, COUNT(*) AS n FROM pw WHERE ${inTrip} AND track_id IS NOT NULL GROUP BY 1 HAVING COUNT(*) >= 2),
        tot AS (SELECT track_id, COUNT(*) AS n FROM plays_resolved WHERE track_id IN (SELECT track_id FROM tp) GROUP BY 1)
      SELECT tp.track_id, tp.t, tp.a, tp.n, tot.n AS total FROM tp JOIN tot USING (track_id) LEFT JOIN artist_origin o ON o.artist_id = tp.aid
      ORDER BY tp.n * tp.n * 1.0 / tot.n * CASE WHEN o.country = '${cc}' THEN 1.5 ELSE 1 END DESC, tp.n DESC LIMIT 1`);
    const [loc] = await query(`WITH ${WHERE(home)} SELECT SUM(pw.ms_played) FILTER (WHERE o.country = '${cc}') * 1.0 / NULLIF(SUM(pw.ms_played), 0) AS share, COUNT(*) AS n FROM pw LEFT JOIN artist_origin o USING (artist_id) WHERE ${inTrip}`);
    trips.push({ id: `${cc}:${s}`, country: cc, name: nm(cc), start: s, end: e, days: num(r.days), hours: num(r.h), plays: num(loc?.n),
      topArtists: top.map((x) => ({ artistId: String(x.artist_id), artist: String(x.a), hours: num(x.h) })),
      souvenir: sv ? { trackId: String(sv.track_id), track: String(sv.t), artist: String(sv.a ?? ''), tripPlays: num(sv.n), totalPlays: num(sv.total) } : null,
      localShare: num(loc?.share), homeLocalShare: homeShare.get(cc) ?? 0 });
  }
  const byC = new Map<string, AbroadCountry>();
  for (const t of trips) {
    const c = byC.get(t.country) ?? { country: t.country, name: t.name, trips: 0, days: 0, hours: 0, localShare: 0, homeLocalShare: t.homeLocalShare, topArtists: [] };
    c.localShare = (c.localShare * c.hours + t.localShare * t.hours) / Math.max(1e-9, c.hours + t.hours);
    c.trips += 1; c.days += t.days; c.hours += t.hours;
    for (const a of t.topArtists) if (!c.topArtists.includes(a.artist) && c.topArtists.length < 5) c.topArtists.push(a.artist);
    byC.set(t.country, c);
  }
  const [tot] = await query(`WITH ${WHERE(home)} SELECT SUM(ms_played)/3600000.0 AS h, SUM(ms_played) FILTER (WHERE where_cc <> '${home}')/3600000.0 AS a FROM pw`);
  const byCountryHours: Record<string, number> = {};
  for (const r of await query(`WITH ${WHERE(home)} SELECT where_cc AS cc, SUM(ms_played)/3600000.0 AS h FROM pw GROUP BY 1`)) byCountryHours[String(r.cc)] = num(r.h);
  // scenes that travel: share of abroad hours vs home hours per scene family
  const sc = await query(`WITH ${WHERE(home)}, s AS (SELECT artist_id, arg_max(scene, weight) AS scene FROM artist_scene GROUP BY 1),
      x AS (SELECT s.scene, SUM(pw.ms_played) FILTER (WHERE pw.where_cc <> '${home}') AS a, SUM(pw.ms_played) FILTER (WHERE pw.where_cc = '${home}') AS h FROM pw JOIN s USING (artist_id) GROUP BY 1)
    SELECT x.scene, f.label, x.a * 1.0 / NULLIF((SELECT SUM(a) FROM x), 0) AS abroad, x.h * 1.0 / NULLIF((SELECT SUM(h) FROM x), 0) AS home FROM x JOIN scene_families f USING (scene)`);
  const scenes = sc.map((r) => ({ scene: String(r.scene), label: String(r.label), abroad: num(r.abroad), home: num(r.home), lift: (num(r.abroad) + 0.005) / (num(r.home) + 0.005) })).filter((x) => x.abroad >= 0.03).sort((a, b) => b.lift - a.lift).slice(0, 8);
  return { home, homeDetected: h.detected, knownShare: h.knownShare, trips, countries: [...byC.values()].sort((a, b) => b.hours - a.hours), hoursAbroad: num(tot?.a), hoursTotal: num(tot?.h), scenes, byCountryHours };
}
const REGION = (() => { try { const dn = new Intl.DisplayNames(['en'], { type: 'region' }); return { of: (c: string) => { try { return dn.of(c) ?? null; } catch { return null; } } }; } catch { return { of: () => null }; } })();
/** Regional-indicator flag for an ISO-2 code ("TR" → 🇹🇷). */
export const flag = (cc: string) => (/^[A-Z]{2}$/.test(cc) ? String.fromCodePoint(...[...cc].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65)) : '');
