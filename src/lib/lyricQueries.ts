/**
 * Phase 10d — everything the Lyrics page reads. All of it goes through `track_lyrics_effective` (computed features with
 * the owner's corrections applied, hidden songs left out) and `track_lyric_keywords` (TF-IDF honouring language fixes,
 * added / hidden words and the blocklist). Plays follow the listening lens like every other page.
 */
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { MOOD_IDS } from './lyricVocab';
import type { TrackRow } from './types';

export type CloudKind = 'keywords' | 'model_keywords' | 'themes' | 'llm_themes' | 'moods';
export type CloudWord = { text: string; weight: number; tracks: number };

const lit = (xs: string[]) => xs.map((x) => `'${x.replace(/'/g, "''")}'`).join(', ');
const PALETTE = lit(MOOD_IDS);
const langCond = (lang: string, col = 'lang') => (lang === 'all' ? 'TRUE' : lang === 'en' ? `${col} = 'en'` : lang === 'other' ? `${col} <> 'en'` : `${col} = '${lang.replace(/[^a-z-]/g, '')}'`);
const yearCond = (year: number | null) => (year ? `AND EXTRACT(year FROM p.played_at) = ${Math.round(year)}` : '');
const arr = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).map(String) : []);

/** The source rows for each cloud: (track_id, word, strength). */
function cloudSource(kind: CloudKind, lang: string, perSong: number): string {
  switch (kind) {
    case 'keywords': return `SELECT k.track_id, k.term AS word, LEAST(k.score, 8) / 4.0 AS s FROM track_lyric_keywords k WHERE k.rank <= ${Math.round(perSong)} AND ${langCond(lang, 'k.lang')}`;
    case 'model_keywords': return `SELECT e.track_id, unnest(e.llm_keywords) AS word, 1.0 AS s FROM track_lyrics_effective e WHERE e.llm_keywords IS NOT NULL AND ${langCond(lang, 'e.lang')}`;
    case 'themes': return `SELECT e.track_id, j.key AS word, GREATEST(CAST(j.value AS DOUBLE), 0.5) AS s FROM track_lyrics_effective e, json_each(COALESCE(e.theme_scores, '{}'::JSON)) j WHERE e.theme_scores IS NOT NULL`;
    case 'llm_themes': return `SELECT e.track_id, unnest(e.llm_themes) AS word, 1.0 AS s FROM track_lyrics_effective e WHERE e.llm_themes IS NOT NULL AND ${langCond(lang, 'e.lang')}`;
    case 'moods': return `SELECT e.track_id, e.llm_mood AS word, 1.0 AS s FROM track_lyrics_effective e WHERE e.llm_mood IN (${PALETTE}) UNION ALL SELECT e.track_id, e.llm_mood2, 0.5 FROM track_lyrics_effective e WHERE e.llm_mood2 IN (${PALETTE})`;
  }
}

export async function lyricCloud(kind: CloudKind, opts: { year?: number | null; lang?: string; perSong?: number; limit?: number } = {}): Promise<CloudWord[]> {
  const { year = null, lang = 'en', perSong = 8, limit = 160 } = opts;
  return (await query(`
    WITH pl AS (SELECT track_id, COUNT(*) AS c FROM plays_resolved p WHERE track_id IS NOT NULL ${yearCond(year)} ${playsWhere('p')} GROUP BY 1),
    kw AS (${cloudSource(kind, lang, perSong)})
    SELECT kw.word, SUM(pl.c * kw.s) AS w, COUNT(DISTINCT kw.track_id) AS t FROM kw JOIN pl USING (track_id)
    WHERE length(kw.word) >= 3 GROUP BY 1 ORDER BY w DESC LIMIT ${Math.round(limit)}`)).map((r) => ({ text: String(r.word), weight: num(r.w), tracks: num(r.t) }));
}

export async function lyricTracksFor(word: string, kind: CloudKind, opts: { year?: number | null; perSong?: number } = {}): Promise<TrackRow[]> {
  const { year = null, perSong = 15 } = opts;
  const cond = kind === 'keywords' ? `EXISTS (SELECT 1 FROM track_lyric_keywords k WHERE k.track_id = e.track_id AND k.term = $1 AND k.rank <= ${Math.round(perSong)})`
    : kind === 'model_keywords' ? `list_contains(e.llm_keywords, $1)`
    : kind === 'themes' ? `json_extract(e.theme_scores, '$."' || replace($1, '"', '') || '"') IS NOT NULL`
    : kind === 'llm_themes' ? `list_contains(e.llm_themes, $1)` : `(e.llm_mood = $1 OR e.llm_mood2 = $1)`;
  return (await query(`
    SELECT p.track_id AS "trackId", arg_max(p.track_name, p.ms_played) AS track, arg_max(p.artist_id, p.ms_played) AS "artistId", arg_max(p.artist_name, p.ms_played) AS artist, COUNT(*) AS plays,
           ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate"
    FROM plays_resolved p JOIN track_lyrics_effective e USING (track_id) WHERE ${cond} ${yearCond(year)} ${playsWhere('p')} GROUP BY 1 ORDER BY plays DESC LIMIT 60`, [word])).map((r) => ({
    trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate),
  }));
}

export type LyricOverview = { played: number; analysed: number; notFound: number; notLooked: number; modelTagged: number; modelOld: number; edited: number; hidden: number; languages: number; valence: number | null; playsCovered: number };
export async function lyricOverview(): Promise<LyricOverview> {
  const [r] = await query(`
    WITH pl AS (SELECT track_id, COUNT(*) AS c FROM plays_resolved p WHERE track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1)
    SELECT COUNT(*) AS played, COUNT(*) FILTER (WHERE f.found) AS analysed, COUNT(*) FILTER (WHERE f.track_id IS NOT NULL AND NOT f.found) AS nf, COUNT(*) FILTER (WHERE f.track_id IS NULL) AS nl,
           COUNT(*) FILTER (WHERE f.found AND COALESCE(f.llm_rev, 0) >= 2) AS mt, COUNT(*) FILTER (WHERE f.found AND COALESCE(f.llm_rev, 0) < 2 AND (f.llm_mood IS NOT NULL OR f.llm_themes IS NOT NULL)) AS mo,
           COUNT(o.track_id) AS edited, COUNT(*) FILTER (WHERE o.hidden) AS hidden, COUNT(DISTINCT f.lang) FILTER (WHERE f.found) AS langs,
           SUM(pl.c * f.valence) FILTER (WHERE f.valence IS NOT NULL) / NULLIF(SUM(pl.c) FILTER (WHERE f.valence IS NOT NULL), 0) AS val,
           SUM(pl.c) FILTER (WHERE f.found) * 1.0 / NULLIF(SUM(pl.c), 0) AS cov
    FROM pl LEFT JOIN track_lyric_features f USING (track_id) LEFT JOIN lyric_overrides o USING (track_id)`);
  return { played: num(r?.played), analysed: num(r?.analysed), notFound: num(r?.nf), notLooked: num(r?.nl), modelTagged: num(r?.mt), modelOld: num(r?.mo), edited: num(r?.edited), hidden: num(r?.hidden), languages: num(r?.langs), valence: r?.val == null ? null : num(r.val), playsCovered: num(r?.cov) };
}

/** Plays per palette mood (second mood counts half), with skip rate: the mood map. */
export async function moodMap(year: number | null = null): Promise<{ mood: string; plays: number; tracks: number; skipRate: number }[]> {
  return (await query(`
    WITH m AS (SELECT track_id, llm_mood AS mood, 1.0 AS w FROM track_lyrics_effective WHERE llm_mood IN (${PALETTE}) UNION ALL SELECT track_id, llm_mood2, 0.5 FROM track_lyrics_effective WHERE llm_mood2 IN (${PALETTE}))
    SELECT m.mood, SUM(m.w) AS plays, COUNT(DISTINCT m.track_id) AS tracks, SUM(m.w * CASE WHEN p.was_skipped THEN 1 ELSE 0 END) / SUM(m.w) AS sr
    FROM plays_resolved p JOIN m USING (track_id) WHERE TRUE ${yearCond(year)} ${playsWhere('p')} GROUP BY 1 ORDER BY plays DESC`)).map((r) => ({ mood: String(r.mood), plays: num(r.plays), tracks: num(r.tracks), skipRate: num(r.sr) }));
}

/** Month by month: plays-weighted lyric valence and how much of the listening had lyrics to read. */
export async function lyricWeather(): Promise<{ month: string; valence: number; bleak: number; bright: number; covered: number }[]> {
  return (await query(`
    SELECT strftime(date_trunc('month', p.played_at), '%Y-%m') AS m, AVG(e.valence) FILTER (WHERE e.valence IS NOT NULL) AS v,
           AVG(CASE WHEN e.valence < -0.2 THEN 1.0 ELSE 0 END) FILTER (WHERE e.valence IS NOT NULL) AS bleak, AVG(CASE WHEN e.valence > 0.2 THEN 1.0 ELSE 0 END) FILTER (WHERE e.valence IS NOT NULL) AS bright,
           COUNT(e.track_id) * 1.0 / COUNT(*) AS cov, COUNT(e.valence) AS n
    FROM plays_resolved p LEFT JOIN track_lyrics_effective e USING (track_id) WHERE p.track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1 HAVING COUNT(e.valence) >= 15 ORDER BY 1`))
    .map((r) => ({ month: String(r.m), valence: num(r.v), bleak: num(r.bleak), bright: num(r.bright), covered: num(r.cov) }));
}

type ThemeSource = 'themes' | 'llm_themes';
const themeRows = (src: ThemeSource) => src === 'themes'
  ? `SELECT track_id, unnest(themes) AS theme FROM track_lyrics_effective WHERE themes IS NOT NULL`
  : `SELECT track_id, unnest(llm_themes) AS theme FROM track_lyrics_effective WHERE llm_themes IS NOT NULL`;

/** Share of analysed plays carrying each theme, per year (top themes only). */
export async function themeDrift(src: ThemeSource, top = 10): Promise<{ years: number[]; themes: { theme: string; byYear: Record<number, number>; total: number }[] }> {
  const rows = await query(`
    WITH t AS (${themeRows(src)}), base AS (SELECT EXTRACT(year FROM p.played_at)::INT AS y, COUNT(*) AS n FROM plays_resolved p JOIN (SELECT DISTINCT track_id FROM t) USING (track_id) WHERE TRUE ${playsWhere('p')} GROUP BY 1 HAVING COUNT(*) >= 30),
         c AS (SELECT EXTRACT(year FROM p.played_at)::INT AS y, t.theme, COUNT(*) AS n FROM plays_resolved p JOIN t USING (track_id) WHERE TRUE ${playsWhere('p')} GROUP BY 1, 2),
         tops AS (SELECT theme FROM c GROUP BY 1 ORDER BY SUM(n) DESC LIMIT ${Math.round(top)})
    SELECT c.y, c.theme, c.n * 1.0 / base.n AS share FROM c JOIN base USING (y) JOIN tops USING (theme) ORDER BY 1`);
  const years = [...new Set(rows.map((r) => num(r.y)))].sort();
  const map = new Map<string, { theme: string; byYear: Record<number, number>; total: number }>();
  for (const r of rows) { const k = String(r.theme); const e = map.get(k) ?? { theme: k, byYear: {}, total: 0 }; e.byYear[num(r.y)] = num(r.share); e.total += num(r.share); map.set(k, e); }
  return { years, themes: [...map.values()].sort((a, b) => b.total - a.total) };
}

export const DAYPARTS = [{ id: 'morning', label: 'Morning', hours: '5–11' }, { id: 'afternoon', label: 'Afternoon', hours: '11–17' }, { id: 'evening', label: 'Evening', hours: '17–22' }, { id: 'night', label: 'Night', hours: '22–1' }, { id: 'late', label: 'Small hours', hours: '1–5' }] as const;
/** How much more (or less) each theme is played in each part of the day than overall: 1.0 = no difference. */
export async function themeClock(src: ThemeSource, top = 10): Promise<{ theme: string; index: Record<string, number>; plays: number }[]> {
  const rows = await query(`
    WITH t AS (${themeRows(src)}),
    pp AS (SELECT p.track_id, CASE WHEN h >= 5 AND h < 11 THEN 'morning' WHEN h >= 11 AND h < 17 THEN 'afternoon' WHEN h >= 17 AND h < 22 THEN 'evening' WHEN h >= 22 OR h < 1 THEN 'night' ELSE 'late' END AS dp
           FROM (SELECT track_id, EXTRACT(hour FROM played_at) AS h, attended, played_at FROM plays_resolved) p JOIN (SELECT DISTINCT track_id FROM t) USING (track_id) WHERE TRUE ${playsWhere('p')}),
    dpn AS (SELECT dp, COUNT(*) AS n FROM pp GROUP BY 1), tot AS (SELECT COUNT(*) AS n FROM pp),
    c AS (SELECT t.theme, pp.dp, COUNT(*) AS n FROM pp JOIN t USING (track_id) GROUP BY 1, 2),
    tt AS (SELECT theme, SUM(n) AS n FROM c GROUP BY 1 ORDER BY n DESC LIMIT ${Math.round(top)})
    SELECT c.theme, c.dp, (c.n * 1.0 / tt.n) / (dpn.n * 1.0 / tot.n) AS idx, tt.n AS plays FROM c JOIN tt USING (theme) JOIN dpn USING (dp), tot ORDER BY tt.n DESC`);
  const map = new Map<string, { theme: string; index: Record<string, number>; plays: number }>();
  for (const r of rows) { const k = String(r.theme); const e = map.get(k) ?? { theme: k, index: {}, plays: num(r.plays) }; e.index[String(r.dp)] = num(r.idx); map.set(k, e); }
  return [...map.values()];
}

/** Wordiest and chantiest songs you actually play (3+ plays). */
export async function wordiness(): Promise<{ wordiest: (TrackRow & { vocab: number })[]; chantiest: (TrackRow & { repetition: number })[] }> {
  const base = (order: string, extra: string) => query(`
    SELECT p.track_id AS "trackId", arg_max(p.track_name, p.ms_played) AS track, arg_max(p.artist_id, p.ms_played) AS "artistId", arg_max(p.artist_name, p.ms_played) AS artist, COUNT(*) AS plays,
           ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate", ANY_VALUE(e.vocab) AS vocab, ANY_VALUE(e.repetition) AS repetition
    FROM plays_resolved p JOIN track_lyrics_effective e USING (track_id) WHERE ${extra} ${playsWhere('p')} GROUP BY 1 HAVING COUNT(*) >= 3 ORDER BY ${order} LIMIT 8`);
  const map = (r: Record<string, unknown>) => ({ trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate), vocab: num(r.vocab), repetition: num(r.repetition) });
  const [w, c] = await Promise.all([base('vocab DESC', 'e.vocab IS NOT NULL'), base('repetition DESC', 'e.repetition IS NOT NULL AND e.word_count >= 60')]);
  return { wordiest: w.map(map), chantiest: c.map(map) };
}

/** Do you skip sad songs more? Skip rate by lyric valence band. */
export async function valenceSkips(): Promise<{ band: string; plays: number; skipRate: number }[]> {
  return (await query(`
    SELECT CASE WHEN e.valence < -0.5 THEN '1 bleak' WHEN e.valence < -0.15 THEN '2 dim' WHEN e.valence <= 0.15 THEN '3 mixed' WHEN e.valence <= 0.5 THEN '4 warm' ELSE '5 bright' END AS band,
           COUNT(*) AS n, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS sr
    FROM plays_resolved p JOIN track_lyrics_effective e USING (track_id) WHERE e.valence IS NOT NULL ${playsWhere('p')} GROUP BY 1 ORDER BY 1`)).map((r) => ({ band: String(r.band).slice(2), plays: num(r.n), skipRate: num(r.sr) }));
}

export async function lyricLanguages(): Promise<{ lang: string; tracks: number; plays: number }[]> {
  return (await query(`
    WITH pl AS (SELECT track_id, COUNT(*) AS c FROM plays_resolved p WHERE track_id IS NOT NULL ${playsWhere('p')} GROUP BY 1)
    SELECT e.lang, COUNT(*) AS t, SUM(pl.c) AS c FROM track_lyrics_effective e JOIN pl USING (track_id) WHERE COALESCE(e.features_rev, 1) >= 2 GROUP BY 1 ORDER BY c DESC`)).map((r) => ({ lang: String(r.lang), tracks: num(r.t), plays: num(r.c) }));
}

// ---------------------------------------------------------------------------------------------------------------- hygiene
export type HygieneFilter = 'all' | 'suspicious' | 'model' | 'untagged' | 'edited' | 'hidden' | 'errors' | 'notfound';
export type HygieneRow = {
  trackId: string; track: string; artist: string; plays: number; found: boolean; lang: string | null; langDetected: string | null;
  themes: string[]; llmThemes: string[]; llmMood: string | null; llmMood2: string | null; keywords: string[]; llmKeywords: string[]; summary: string | null;
  llmRev: number | null; llmModel: string | null; llmError: string | null; edited: boolean; locked: boolean; hidden: boolean;
};
const SUSPICIOUS_SQL = `((f.llm_mood IS NOT NULL AND f.llm_mood NOT IN (${PALETTE})) OR list_bool_or(list_transform(COALESCE(f.llm_themes, []::VARCHAR[]), x -> regexp_matches(lower(x), '\\b(radio edit|edit|remix|remaster(ed)?|version|mix|feat|words?|phrase)\\b|[0-9]') OR (length(x) > 3 AND strpos(lower(t.name || ' ' || COALESCE(a.name, '')), lower(x)) > 0))) OR (COALESCE(f.llm_rev, 0) < 2 AND (f.llm_mood IS NOT NULL OR f.llm_themes IS NOT NULL)))`;
export async function hygieneList(opts: { search?: string; filter?: HygieneFilter; lang?: string; limit?: number; offset?: number; trackId?: string | null } = {}): Promise<{ rows: HygieneRow[]; total: number }> {
  const { search = '', filter = 'all', lang = 'all', limit = 40, offset = 0, trackId = null } = opts;
  const where: string[] = [];
  const params: unknown[] = [];
  if (trackId) { params.push(trackId); where.push(`f.track_id = $${params.length}`); }
  if (search.trim()) { params.push(`%${search.trim().toLowerCase()}%`); const n = `$${params.length}`; where.push(`(lower(t.name) LIKE ${n} OR lower(a.name) LIKE ${n} OR list_contains(COALESCE(f.llm_keywords, []::VARCHAR[]), lower(trim(${n}, '%'))) OR list_contains(COALESCE(f.llm_themes, []::VARCHAR[]), lower(trim(${n}, '%'))))`); }
  where.push(filter === 'notfound' ? 'NOT f.found' : 'f.found');
  if (filter === 'suspicious') where.push(SUSPICIOUS_SQL);
  if (filter === 'model') where.push('COALESCE(f.llm_rev, 0) >= 2');
  if (filter === 'untagged') where.push('f.llm_mood IS NULL AND f.llm_themes IS NULL');
  if (filter === 'edited') where.push('o.track_id IS NOT NULL');
  if (filter === 'hidden') where.push('COALESCE(o.hidden, FALSE)');
  if (filter === 'errors') where.push('f.llm_error IS NOT NULL');
  if (lang !== 'all') where.push(langCond(lang, "COALESCE(NULLIF(o.lang, ''), f.lang)"));
  const from = `FROM track_lyric_features f JOIN tracks t USING (track_id) LEFT JOIN artists a ON a.artist_id = t.artist_id LEFT JOIN lyric_overrides o ON o.track_id = f.track_id
    LEFT JOIN (SELECT track_id, COUNT(*) AS c FROM plays_resolved p WHERE TRUE ${playsWhere('p')} GROUP BY 1) pl ON pl.track_id = f.track_id WHERE ${where.join(' AND ')}`;
  const [cnt] = await query(`SELECT COUNT(*) AS n ${from}`, params);
  const rows = await query(`
    SELECT f.track_id, t.name AS track, a.name AS artist, COALESCE(pl.c, 0) AS plays, f.found, COALESCE(NULLIF(o.lang, ''), f.lang) AS lang, f.lang AS lang_detected,
           COALESCE(o.themes, f.themes) AS themes, COALESCE(o.llm_themes, f.llm_themes) AS llm_themes, COALESCE(o.mood, f.llm_mood) AS llm_mood, f.llm_mood2, f.llm_keywords, f.llm_summary,
           f.llm_rev, f.llm_model, f.llm_error, o.track_id IS NOT NULL AS edited, COALESCE(o.locked, FALSE) AS locked, COALESCE(o.hidden, FALSE) AS hidden,
           (SELECT list(k.term ORDER BY k.rank) FROM track_lyric_keywords k WHERE k.track_id = f.track_id AND k.rank <= 10) AS kw
    ${from} ORDER BY plays DESC, t.name LIMIT ${Math.round(limit)} OFFSET ${Math.round(offset)}`, params);
  return {
    total: num(cnt?.n),
    rows: rows.map((r) => ({
      trackId: String(r.track_id), track: String(r.track ?? ''), artist: String(r.artist ?? ''), plays: num(r.plays), found: Boolean(r.found), lang: str(r.lang), langDetected: str(r.lang_detected),
      themes: arr(r.themes), llmThemes: arr(r.llm_themes), llmMood: str(r.llm_mood), llmMood2: str(r.llm_mood2), keywords: arr(r.kw), llmKeywords: arr(r.llm_keywords), summary: str(r.llm_summary),
      llmRev: r.llm_rev == null ? null : num(r.llm_rev), llmModel: str(r.llm_model), llmError: str(r.llm_error), edited: Boolean(r.edited), locked: Boolean(r.locked), hidden: Boolean(r.hidden),
    })),
  };
}

export type SongLyricDetail = {
  terms: { term: string; tf: number; score: number | null; rank: number | null; blocked: boolean; hidden: boolean; added: boolean }[];
  themeScores: Record<string, number>; computedThemes: string[]; computedLlmThemes: string[]; computedMood: string | null;
  override: { lang: string | null; themes: string[] | null; llmThemes: string[] | null; mood: string | null; keywordsAdd: string[]; keywordsHide: string[]; locked: boolean; hidden: boolean; note: string | null } | null;
  features: { wordCount: number; vocab: number | null; repetition: number | null; valence: number | null; langDetected: string | null; llmModel: string | null; llmAt: string | null; llmMs: number | null; llmAttempts: number; llmError: string | null; llmRev: number | null; summary: string | null } | null;
  neighbours: (TrackRow & { shared: string[] })[];
};
export async function songLyricDetail(id: string): Promise<SongLyricDetail> {
  const [f] = await query(`SELECT *, CAST(theme_scores AS VARCHAR) AS ts, CAST(llm_at AS VARCHAR) AS llm_at_s FROM track_lyric_features WHERE track_id = $1`, [id]);
  const [o] = await query(`SELECT * FROM lyric_overrides WHERE track_id = $1`, [id]);
  const terms = await query(`
    SELECT t.term, t.tf, k.score, k.rank, b.term IS NOT NULL AS blocked, list_contains(COALESCE(o.keywords_hide, []::VARCHAR[]), t.term) AS hidden, FALSE AS added
    FROM track_lyric_terms t LEFT JOIN track_lyric_keywords k ON k.track_id = t.track_id AND k.term = t.term LEFT JOIN lyric_term_blocklist b ON b.term = t.term LEFT JOIN lyric_overrides o ON o.track_id = t.track_id
    WHERE t.track_id = $1
    UNION ALL SELECT k.term, k.tf, k.score, k.rank, FALSE, FALSE, TRUE FROM track_lyric_keywords k WHERE k.track_id = $1 AND k.added
    ORDER BY rank NULLS LAST, tf DESC, term`, [id]);
  // lyrical neighbours: songs you play that share the most keywords / model keywords / themes with this one
  const neighbours = await query(`
    WITH me AS (SELECT term AS w FROM track_lyric_keywords WHERE track_id = $1 AND rank <= 12 UNION SELECT unnest(llm_keywords) FROM track_lyrics_effective WHERE track_id = $1 UNION SELECT unnest(llm_themes) FROM track_lyrics_effective WHERE track_id = $1),
         other AS (SELECT track_id, term AS w FROM track_lyric_keywords WHERE rank <= 12 AND track_id <> $1 UNION SELECT track_id, unnest(llm_keywords) FROM track_lyrics_effective WHERE track_id <> $1 UNION SELECT track_id, unnest(llm_themes) FROM track_lyrics_effective WHERE track_id <> $1),
         hits AS (SELECT o.track_id, list(DISTINCT o.w) AS shared, COUNT(DISTINCT o.w) AS n FROM other o JOIN me USING (w) GROUP BY 1 HAVING COUNT(DISTINCT o.w) >= 2)
    SELECT h.track_id AS "trackId", arg_max(p.track_name, p.ms_played) AS track, arg_max(p.artist_id, p.ms_played) AS "artistId", arg_max(p.artist_name, p.ms_played) AS artist, COUNT(*) AS plays,
           ROUND(SUM(p.ms_played)/3600000.0, 1) AS hours, AVG(CASE WHEN p.was_skipped THEN 1.0 ELSE 0 END) AS "skipRate", ANY_VALUE(h.shared) AS shared, ANY_VALUE(h.n) AS n
    FROM hits h JOIN plays_resolved p ON p.track_id = h.track_id WHERE TRUE ${playsWhere('p')} GROUP BY 1 ORDER BY n DESC, plays DESC LIMIT 6`, [id]);
  let themeScores: Record<string, number> = {};
  try { themeScores = f?.ts ? JSON.parse(String(f.ts)) : {}; } catch { /* malformed */ }
  const nullableArr = (v: unknown) => (v == null ? null : arr(v));
  return {
    terms: terms.map((r) => ({ term: String(r.term), tf: num(r.tf), score: r.score == null ? null : num(r.score), rank: r.rank == null ? null : num(r.rank), blocked: Boolean(r.blocked), hidden: Boolean(r.hidden), added: Boolean(r.added) })),
    themeScores, computedThemes: arr(f?.themes), computedLlmThemes: arr(f?.llm_themes), computedMood: str(f?.llm_mood),
    override: o ? { lang: str(o.lang), themes: nullableArr(o.themes), llmThemes: nullableArr(o.llm_themes), mood: str(o.mood), keywordsAdd: arr(o.keywords_add), keywordsHide: arr(o.keywords_hide), locked: Boolean(o.locked), hidden: Boolean(o.hidden), note: str(o.note) } : null,
    features: f ? { wordCount: num(f.word_count), vocab: f.vocab == null ? null : num(f.vocab), repetition: f.repetition == null ? null : num(f.repetition), valence: f.valence == null ? null : num(f.valence), langDetected: str(f.lang), llmModel: str(f.llm_model), llmAt: str(f.llm_at_s), llmMs: f.llm_ms == null ? null : num(f.llm_ms), llmAttempts: num(f.llm_attempts), llmError: str(f.llm_error), llmRev: f.llm_rev == null ? null : num(f.llm_rev), summary: str(f.llm_summary) } : null,
    neighbours: neighbours.map((r) => ({ trackId: String(r.trackId), track: String(r.track), artistId: str(r.artistId), artist: String(r.artist ?? ''), plays: num(r.plays), hours: num(r.hours), skipRate: num(r.skipRate), shared: arr(r.shared) })),
  };
}

export async function blocklist(): Promise<string[]> { return (await query(`SELECT term FROM lyric_term_blocklist ORDER BY term`)).map((r) => String(r.term)); }
