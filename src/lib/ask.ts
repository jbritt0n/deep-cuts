/**
 * Phase 9e — Ask the Archive (spec §9, "the meta-feature"). The model never touches the database: it writes ONE
 * read-only SQL statement from a schema summary, the app runs it through the same `query` bridge every page uses
 * (`Db::assert_read_only` gates it server-side; `isSafeSelect` mirrors that client-side), and the model then
 * narrates the rows it is handed. Facts come from the rows; the model is the writer, not the source. If the SQL
 * fails, the error goes back to the model once for a repair attempt. Everything runs on the owner's machine.
 */
import { invoke } from './bridge';
import { query } from './db';
import { playsWhere } from './filter';
import { settingRaw } from './settings';
import type { TrackRow } from './types';

export type ChatMsg = { role: 'system' | 'user' | 'assistant'; content: string };
export type AskTurn = { id: string; question: string; sql: string | null; explanation: string | null; columns: string[]; rows: Record<string, unknown>[]; rowCount: number; narrative: string | null; error: string | null; ms: number; attempts: number; tracks: TrackRow[] | null; model: string };
export type LlmStatus = { reachable: boolean; url: string; models: string[]; error: string | null };

export const llmStatus = () => invoke<LlmStatus>('llm_status');
export const currentModel = (models: string[]) => { const saved = settingRaw('ollama_model'); return saved && models.includes(saved) ? saved : models.find((m) => /llama|qwen|mistral|gemma|phi/i.test(m)) ?? models[0] ?? ''; };

/** Compact schema the model can hold in context. Column lists are curated, not dumped, so the important joins are obvious. */
export const SCHEMA_DOC = `
You query a DuckDB database of ONE person's music listening history ("the record"). Tables:

plays_resolved (one row per play — the main table): play_id, played_at TIMESTAMP (LOCAL wall clock), track_id, track_name, artist_id, artist_name, album_id, album_name, ms_played BIGINT, was_skipped BOOLEAN (user pressed skip), attended BOOLEAN (false = autoplay nobody was there for), is_first_play BOOLEAN (first time ever for that track), platform, shuffle, source ('extended_export' | 'live_poll' ...), under_30s BOOLEAN.
sessions: session_id, start_at TIMESTAMP, end_at, track_count, skip_count, unique_artist_count, total_ms, platform, session_shape ('album_ride','comfort_loop','discovery_run','deep_dive','binge','warm_up','restless','autopilot','shuffle_wander','steady'), skip_rate, novelty_rate, repeat_rate, artist_entropy, day_part ('morning','midday','evening','night','late'), is_late_night, is_weekend, attention ('active','drifting','unattended'), chaos DOUBLE (0 coherent → 1 jarring genre jumps).
play_sessions: play_id, session_id, position_in_session   -- joins plays to sessions
artists: artist_id, name, mbid, catalogue_tracks (approx. recordings the artist has released).
albums: album_id, name, artist_id, release_date DATE, total_tracks, image_url.
tracks: track_id, name, artist_id, album_id, duration_ms, release_date DATE, explicit BOOLEAN, isrc, track_number.
artist_tags: artist_id, tag, weight (0–1), source ('lastfm'|'musicbrainz').   -- genre tags
artist_scene: artist_id, scene ('psych','indie','electronic','jazz','afro','turkish','japanese','dream','post-punk','hip-hop','funk-soul','folk','metal','classical','punk','latin','caribbean','classic-rock'), weight.
artist_obscurity (view): artist_id, listeners (Last.fm), obscurity (0 mainstream → 1 unknown).
artist_origin: artist_id, country (ISO-2), city.
track_lyric_features: track_id, found, keywords VARCHAR[], themes VARCHAR[], colours VARCHAR[], lang.
liked_songs: track_id, added_at.   playlists: playlist_id, name, owner_is_me.   playlist_items: playlist_id, track_id, added_at.
milestones: kind, happened_at, subject_type, subject_id, payload JSON.
recommendation_feedback: subject_type, subject_key, engine, verdict ('accepted'|'dismissed'), decided_at.

Rules: DuckDB SQL dialect. Hours = SUM(ms_played)/3600000.0. Use plays_resolved for anything about listening; filter attended = TRUE unless the user asks about autoplay. played_at is local time; EXTRACT(hour FROM played_at), EXTRACT(dow FROM played_at) (0 = Sunday), EXTRACT(year FROM played_at), DATE_TRUNC('week', played_at). "Rainy"/weather is NOT in the data. Prefer a small number of well-named columns; include track_id/artist_id columns when listing tracks or artists so the app can link them. Always add a LIMIT (≤ 200).`;

const SYSTEM_SQL = `${SCHEMA_DOC}

Respond with ONLY a JSON object: {"sql": "<one SELECT or WITH statement, no semicolon>", "explanation": "<one plain sentence saying what the query counts>", "answerable": true|false, "why_not": "<only if not answerable>"}. If the question cannot be answered from these tables, set answerable=false and explain in why_not. Never write INSERT/UPDATE/DELETE/DROP/CREATE/PRAGMA.`;

const SYSTEM_NARRATE = `You are the voice of Deep Cuts, a local music-listening archive: warm, specific, a little wry, never gushing. You are given a question, the SQL that answered it, and the resulting rows as JSON. Write the answer in 2–5 sentences of plain prose (no headings, no bullet lists, no markdown). Use the actual numbers and names in the rows; do not invent anything not present. If the rows are empty, say so plainly and suggest what to ask instead. Do not restate the SQL.`;

const BANNED = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|ATTACH|COPY|EXPORT|IMPORT|PRAGMA|INSTALL|LOAD|CALL)\b/i;
export function isSafeSelect(sql: string): string | null {
  const t = sql.trim().replace(/;+\s*$/, '');
  if (t.includes(';')) return 'only a single statement is allowed';
  if (!/^(SELECT|WITH)\b/i.test(t)) return 'only SELECT / WITH queries are allowed';
  if (BANNED.test(t)) return 'statement contains a disallowed keyword';
  return null;
}
export const ensureLimit = (sql: string) => (/\blimit\s+\d+/i.test(sql) ? sql : `${sql.trim().replace(/;+\s*$/, '')} LIMIT 200`);

const chat = (model: string, messages: ChatMsg[], jsonMode: boolean, temperature = 0.1) => invoke<string>('llm_chat', { model, messages, jsonMode, temperature });
const parseJson = (s: string): Record<string, unknown> | null => { try { return JSON.parse(s.replace(/```json|```/g, '').trim()); } catch { const m = s.match(/\{[\s\S]*\}/); if (m) { try { return JSON.parse(m[0]); } catch { return null; } } return null; } };

/** Ask one question. `history` gives the model the last few turns so "and in 2024?" works. */
export async function askArchive(question: string, model: string, history: AskTurn[] = []): Promise<AskTurn> {
  const t0 = performance.now();
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const base: AskTurn = { id, question, sql: null, explanation: null, columns: [], rows: [], rowCount: 0, narrative: null, error: null, ms: 0, attempts: 0, tracks: null, model };
  const lens = playsWhere();
  const ctx: ChatMsg[] = [{ role: 'system', content: `${SYSTEM_SQL}\n\nThe user's current listening lens (always AND this into WHERE clauses on plays_resolved, it is already valid SQL for an alias-free query): ${lens.replace(/^\s*AND\s*/i, '') || 'no extra filter'}.` }];
  for (const h of history.slice(-4)) { ctx.push({ role: 'user', content: h.question }); ctx.push({ role: 'assistant', content: JSON.stringify({ sql: h.sql, explanation: h.explanation, answerable: !!h.sql }) }); }
  ctx.push({ role: 'user', content: question });

  let sql: string | null = null, explanation: string | null = null, lastErr: string | null = null;
  let rows: Record<string, unknown>[] = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    base.attempts = attempt;
    let raw: string;
    try { raw = await chat(model, attempt === 1 ? ctx : [...ctx, { role: 'assistant', content: JSON.stringify({ sql, explanation }) }, { role: 'user', content: `That SQL failed with: ${lastErr}. Fix it and respond with the same JSON shape.` }], true); }
    catch (e) { return { ...base, error: `Couldn't reach the model: ${String(e)}`, ms: performance.now() - t0 }; }
    const j = parseJson(raw);
    if (!j) { lastErr = 'response was not JSON'; continue; }
    if (j.answerable === false) return { ...base, error: null, narrative: String(j.why_not ?? "That isn't in the record."), explanation: null, ms: performance.now() - t0 };
    sql = String(j.sql ?? '').trim(); explanation = j.explanation ? String(j.explanation) : null;
    const unsafe = isSafeSelect(sql);
    if (unsafe) { lastErr = unsafe; continue; }
    sql = ensureLimit(sql);
    try { rows = await query(sql); lastErr = null; break; } catch (e) { lastErr = String(e).slice(0, 400); }
  }
  if (lastErr || !sql) return { ...base, sql, explanation, error: `The model's query didn't run: ${lastErr ?? 'no SQL produced'}`, ms: performance.now() - t0 };

  const columns = rows.length ? Object.keys(rows[0]) : [];
  const sample = rows.slice(0, 40).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typeof v === 'number' ? Math.round(v * 100) / 100 : v])));
  let narrative: string | null = null;
  try { narrative = await chat(model, [{ role: 'system', content: SYSTEM_NARRATE }, { role: 'user', content: `Question: ${question}\nSQL: ${sql}\nRow count: ${rows.length}${rows.length > 40 ? ' (first 40 shown)' : ''}\nRows: ${JSON.stringify(sample)}` }], false, 0.6); }
  catch (e) { narrative = null; lastErr = String(e); }
  return { ...base, sql, explanation, columns, rows, rowCount: rows.length, narrative, error: narrative ? null : lastErr ? `Got the rows, but the model couldn't narrate them: ${lastErr}` : null, tracks: tracksFrom(rows), ms: performance.now() - t0 };
}

/** If the answer lists tracks, lift them into TrackRows so the answer can become a playlist. */
export function tracksFrom(rows: Record<string, unknown>[]): TrackRow[] | null {
  if (!rows.length) return null;
  const k = Object.keys(rows[0]);
  const idK = k.find((c) => /^track_?id$/i.test(c)); const nameK = k.find((c) => /^(track_?name|track|name|title)$/i.test(c));
  if (!idK || !nameK) return null;
  const artistK = k.find((c) => /^artist_?name$|^artist$/i.test(c)), artistIdK = k.find((c) => /^artist_?id$/i.test(c)), playsK = k.find((c) => /plays|count|^c$|^n$/i.test(c));
  const seen = new Set<string>();
  return rows.filter((r) => r[idK] && !seen.has(String(r[idK])) && seen.add(String(r[idK]))).map((r) => ({ trackId: String(r[idK]), track: String(r[nameK]), artistId: artistIdK ? (r[artistIdK] == null ? null : String(r[artistIdK])) : null, artist: artistK ? String(r[artistK] ?? '') : '', plays: playsK ? Number(r[playsK]) || 0 : 0, hours: 0, skipRate: 0 }));
}

export const SUGGESTIONS = [
  'What did I listen to most on Sunday mornings last year?',
  'Which artists did I discover in 2025 and still play?',
  'How has my skip rate changed year by year?',
  'What are my most-played tracks after midnight?',
  'Which albums have I played front to back the most times?',
  'Show me artists I loved in 2023 and have not played since.',
  'What share of my listening is from the 1970s?',
  'Which sessions were the most chaotic, and what was in them?',
  'What tracks with the word "river" in their lyrics do I play most?',
  'How many hours did I listen per month this year?',
];
