/**
 * Browser harness AND headless server: serves the same commands the Tauri core exposes, over HTTP,
 * against a DuckDB file. Two jobs:
 *   1. `npm run dev:browser` — iterate on the UI with no Rust toolchain (vite on :1420 talks to :4747).
 *   2. Phase 9e — the always-on Docker deployment: with DEEPCUTS_STATIC pointing at a `vite build`
 *      output it also serves the app itself, so http://host:4747/ is Deep Cuts in a browser.
 * Read-only except import / rebuild / settings / feedback. Connectors (Spotify polling, Last.fm…) live in the
 * Rust core only — the container is the analyst over a record the desktop app collects (docs/DOCKER.md).
 *   DEEPCUTS_DB=…/deep-cuts.duckdb  DEEPCUTS_STATIC=dist  HOST=0.0.0.0  PORT=4747  OLLAMA_URL=http://host:11434  node dev-server.mjs
 *   DEEPCUTS_READONLY=1 opens the file read-only (safe while the desktop app has it open) and refuses writes politely.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DuckDBInstance } from '@duckdb/node-api';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.join(here, 'src-tauri', 'sql');
const rd = (n) => fs.readFileSync(path.join(sqlDir, n), 'utf8');
const dbPath = process.env.DEEPCUTS_DB ?? path.join(here, 'dev-data', 'deep-cuts.duckdb');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const READONLY = !!process.env.DEEPCUTS_READONLY;
const inst = await DuckDBInstance.create(dbPath, READONLY ? { access_mode: 'READ_ONLY' } : undefined);
const con = await inst.connect();
await con.run("SET TimeZone='UTC'");
if (!READONLY) await con.run(rd('schema.sql'));
const events = [];
const emit = (name, payload) => events.push({ name, payload });

// tz_offsets like db.rs does, from the JS Intl database
async function loadTz(zone) {
  await con.run('DELETE FROM tz_offsets');
  let extra = []; try { const rd2 = await (await con.prepare("SELECT DISTINCT cz.zone FROM plays_normalized p JOIN country_zones cz USING (country) UNION SELECT DISTINCT zone FROM tz_overrides WHERE zone IS NOT NULL")).runAndReadAll(); extra = rd2.getRowObjectsJson().map((r) => r.zone); } catch { /* fresh db */ }
  for (const z of [zone, ...extra.filter((z) => z && z !== zone)]) await loadOneZone(z);
  await con.run(`INSERT INTO app_meta (key, value) VALUES ('timezone', '${zone}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`);
}
async function loadOneZone(zone) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const offsetAt = (d) => {
    const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
    return Math.round((local - d.getTime()) / 1000);
  };
  // coarse daily scan, then binary-search each transition to the hour (fast: ~9k Intl calls instead of 210k)
  const rows = []; const push = (t, off) => rows.push(`('${new Date(t).toISOString().slice(0, 19).replace('T', ' ')}', ${off}, '${zone}')`);
  let t = Date.UTC(2008, 0, 1); let prev = offsetAt(new Date(t)); push(t, prev);
  for (; t < Date.UTC(2032, 0, 1); t += 86400e3) {
    const off = offsetAt(new Date(t + 86400e3));
    if (off !== prev) {
      let lo = t, hi = t + 86400e3;
      while (hi - lo > 3600e3) { const mid = lo + Math.floor((hi - lo) / 2 / 3600e3) * 3600e3; if (offsetAt(new Date(mid)) === prev) lo = mid; else hi = mid; }
      push(hi, off); prev = off;
    }
  }
  await con.run(`INSERT INTO tz_offsets VALUES ${rows.join(',')}`);
}
const zone = process.env.DEEPCUTS_TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC';
await loadTz(zone);

const rowsOf = async (sql, params = []) => {
  const stmt = await con.prepare(sql);
  params.forEach((p, i) => (p === null || p === undefined ? stmt.bindNull(i + 1) : typeof p === 'number' ? (Number.isInteger(p) ? stmt.bindInteger(i + 1, p) : stmt.bindDouble(i + 1, p)) : typeof p === 'boolean' ? stmt.bindBoolean(i + 1, p) : stmt.bindVarchar(i + 1, String(p))));
  const reader = await stmt.runAndReadAll();
  return reader.getRowObjectsJson();
};
// a move bundle is a folder here; a .zip from the desktop app is unpacked next to itself with the unzip CLI
function bundleDir(p) {
  if (fs.statSync(p).isDirectory()) return p;
  const out = p.replace(/\.zip$/i, '');
  if (!fs.existsSync(path.join(out, 'manifest.json'))) { fs.mkdirSync(out, { recursive: true }); execFileSync('unzip', ['-o', '-q', p, '-d', out]); }
  return out;
}
const q = (v) => `'${String(v).replace(/'/g, "''")}'`;
const scalar = async (sql) => Object.values((await rowsOf(sql))[0] ?? {})[0] ?? 0;
const ro = (sql) => {
  const t = sql.trim().replace(/;$/, '');
  if (t.includes(';')) throw new Error('single statement only');
  if (!/^(select|with|describe|show)\b/i.test(t)) throw new Error('read-only');
};

async function rebuild() {
  await con.run(rd('entity_resolution.sql'));
  await con.run(rd('compute_sessions.sql'));
  await con.run(rd('compute_milestones.sql'));
  await con.run(rd('compute_scenes.sql'));
  await con.run(rd('compute_insights.sql'));
  await con.run('CHECKPOINT');
}

const locate = (input) => {
  const st = fs.statSync(input);
  if (st.isFile()) return [input];
  const out = [];
  const walk = (d, depth) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory() && depth < 4) walk(p, depth + 1); else if (/^Streaming_History_Audio_.*\.json$/.test(e.name)) out.push(p); } };
  walk(input, 0); return out.sort();
};

async function stage(file) {
  await con.run(rd('import_stage.sql').replace('?1', `'${file.replace(/'/g, "''")}'`));
  const [p] = await rowsOf(rd('import_preview.sql'));
  return { name: path.basename(file), rowsTotal: +p.rows_total, rowsAudio: +p.rows_audio, rowsSkipped: +p.rows_skipped, rowsDuplicateInFile: +p.rows_duplicate_in_file, rowsAlreadyImported: +p.rows_already_imported, firstTs: p.first_ts, lastTs: p.last_ts };
}

async function ollamaUrl() {
  if (process.env.OLLAMA_URL) return process.env.OLLAMA_URL.replace(/\/$/, '');
  try { const v = await scalar("SELECT value FROM app_meta WHERE key = 'ollama_url'"); if (v) return String(v).replace(/\/$/, ''); } catch { /* fresh db */ }
  return 'http://127.0.0.1:11434';
}

const commands = {
  async get_status() {
    const n = +(await scalar('SELECT COUNT(*) FROM plays_resolved'));
    const [r] = await rowsOf('SELECT CAST(MIN(played_at) AS VARCHAR) AS f, CAST(MAX(played_at) AS VARCHAR) AS l, COALESCE(ROUND(SUM(ms_played)/3600000.0,1),0) AS h FROM plays_resolved');
    return { version: '3.0.0-dev', hasData: n > 0, demo: false, playCount: n, totalHours: +r.h, firstPlay: r.f, lastPlay: r.l, importing: false, portable: false, dataDir: path.dirname(dbPath), dbPath, timezone: zone, lastImport: null };
  },
  async query({ sql, params }) { ro(sql); return rowsOf(sql, params ?? []); },
  async inspect_import({ path: input }) {
    const files = locate(input); if (!files.length) throw new Error('No Streaming_History_Audio_*.json found');
    await con.run(rd('import_existing_keys.sql'));
    const previews = []; for (const f of files) previews.push(await stage(f));
    const sample = await rowsOf("SELECT strftime(ts, '%Y-%m-%d %H:%M') AS ts, track_name, artist_name, album_name, ms_played FROM _stage WHERE track_name IS NOT NULL ORDER BY ts DESC LIMIT 6");
    const sum = (k) => previews.reduce((s, p) => s + p[k], 0);
    return { source: input, sourceKind: fs.statSync(input).isDirectory() ? 'folder' : 'file', files: previews, rowsTotal: sum('rowsTotal'), rowsAudio: sum('rowsAudio'), rowsSkipped: sum('rowsSkipped'), rowsDuplicateInFile: sum('rowsDuplicateInFile'), rowsAlreadyImported: sum('rowsAlreadyImported'), rowsNew: Math.max(0, sum('rowsAudio') - sum('rowsDuplicateInFile') - sum('rowsAlreadyImported')), firstTs: previews.map((p) => p.firstTs).filter(Boolean).sort()[0] ?? null, lastTs: previews.map((p) => p.lastTs).filter(Boolean).sort().at(-1) ?? null, sample };
  },
  async start_import({ path: input }) {
    const id = `dev-${Date.now()}`;
    (async () => {
      const t0 = Date.now(); const files = locate(input);
      await con.run(rd('import_existing_keys.sql'));
      let ins = 0, dup = 0, skip = 0;
      for (let i = 0; i < files.length; i++) {
        const f = files[i]; const name = path.basename(f);
        emit('import:progress', { stage: 'importing', file: name, file_index: i, file_count: files.length, rows_inserted: ins, rows_duplicate: dup, rows_skipped: skip, message: `Reading ${name}` });
        const p = await stage(f);
        const before = +(await scalar("SELECT COUNT(*) FROM events"));
        await con.run(rd('import_insert.sql').replace('?1', `'${name}'`));
        await con.run(rd('import_mark_keys.sql'));
        const got = +(await scalar("SELECT COUNT(*) FROM events")) - before;
        ins += got; dup += p.rowsAudio - got; skip += p.rowsSkipped;
      }
      emit('import:progress', { stage: 'resolving', file: null, file_index: files.length, file_count: files.length, rows_inserted: ins, rows_duplicate: dup, rows_skipped: skip, message: 'Resolving artists, albums and tracks' });
      await rebuild();
      emit('import:done', { import_id: id, files: files.length, rows_inserted: ins, rows_duplicate: dup, rows_skipped: skip, total_plays: +(await scalar('SELECT COUNT(*) FROM plays_resolved')), total_hours: +(await scalar('SELECT ROUND(SUM(ms_played)/3600000.0,1) FROM plays_resolved')), elapsed_ms: Date.now() - t0 });
      emit('data:changed', { reason: 'import' });
    })().catch((e) => emit('import:error', { message: String(e.message ?? e) }));
    return id;
  },
  async rebuild() { await rebuild(); emit('data:changed', { reason: 'rebuild' }); return null; },
  async get_activity() { return rowsOf('SELECT CAST(logged_at AS VARCHAR) AS at, task, level, message, detail FROM activity_log ORDER BY logged_at DESC LIMIT 100'); },
  async get_import_history() { return rowsOf('SELECT CAST(import_id AS VARCHAR) AS import_id, CAST(MIN(imported_at) AS VARCHAR) AS at, COUNT(*) AS files, SUM(rows_inserted) AS inserted, SUM(rows_duplicate) AS duplicate, SUM(rows_skipped) AS skipped FROM import_files GROUP BY 1 ORDER BY 2 DESC'); },
  async list_timezones() { return Intl.supportedValuesOf('timeZone'); },
  async set_timezone({ zone: z }) { await loadTz(z); await rebuild(); emit('data:changed', { reason: 'timezone' }); return null; },
  async open_data_folder() { return null; },
  async export_record({ destDir, format }) {
    const parquet = format === 'parquet', ext = parquet ? 'parquet' : 'csv', opts = parquet ? '(FORMAT PARQUET, COMPRESSION ZSTD)' : "(HEADER, DELIMITER ',')";
    const out = path.join(destDir || path.dirname(dbPath), `deep-cuts-export-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)}`); fs.mkdirSync(path.join(out, 'tables'), { recursive: true });
    await con.run(`COPY (SELECT * FROM plays_enriched ORDER BY played_at) TO ${q(path.join(out, `plays_enriched.${ext}`))} ${opts}`);
    for (const { table_name: t } of await rowsOf("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY 1")) {
      if (t === 'tz_offsets' || t.startsWith('_') || !Number(await scalar(`SELECT COUNT(*) FROM "${t}"`))) continue;
      const cols = parquet ? '*' : (await rowsOf(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = ${q(t)} ORDER BY ordinal_position`)).map((r) => `CAST("${r.column_name}" AS VARCHAR) AS "${r.column_name}"`).join(', ');
      await con.run(`COPY (SELECT ${cols} FROM "${t}") TO ${q(path.join(out, 'tables', `${t}.${ext}`))} ${opts}`);
    }
    fs.writeFileSync(path.join(out, 'README.txt'), 'Deep Cuts — everything in this record (dev harness export). plays_enriched: one row per play with its enrichment.\n');
    return out;
  },
  async export_events() { const out = path.join(path.dirname(dbPath), `events-${Date.now()}.parquet`); await con.run(`COPY (SELECT * FROM events) TO '${out}' (FORMAT PARQUET)`); return out; },
  async set_setting({ key, value }) { await con.run(`INSERT INTO app_meta (key, value) VALUES ('${key}', '${String(value).replace(/'/g, "''")}') ON CONFLICT (key) DO UPDATE SET value = excluded.value`); return null; },
  async get_settings() { return rowsOf('SELECT key, value FROM app_meta'); },
  async get_connectors() { return (await rowsOf("SELECT service, status, account, CAST(last_sync_at AS VARCHAR) AS lastSyncAt, last_error AS lastError, plays_added AS playsAdded FROM connector_state ORDER BY service")).map((r) => ({ ...r, playsAdded: Number(r.playsAdded), extra: r.service === 'spotify' ? { hasClientId: false, connected: false } : {} })); },
  async spotify_set_client_id() { throw new Error('Connectors need the desktop app — the browser harness has no keyring.'); },
  async spotify_connect() { throw new Error('Connectors need the desktop app.'); }, async spotify_disconnect() { return null; },
  async sync_now() { throw new Error('Connectors need the desktop app.'); }, async lastfm_connect() { throw new Error('Connectors need the desktop app.'); },
  async lastfm_disconnect() { return null; },
  async rec_feedback({ subjectType, subjectKey, engine, verdict }) { await con.run(`INSERT INTO recommendation_feedback (subject_type, subject_key, engine, verdict) VALUES ('${subjectType}', '${String(subjectKey).replace(/'/g, "''")}', '${engine}', '${verdict}')`); return null; },
  async create_playlist() { throw new Error('Creating playlists needs the desktop app connected to Spotify.'); },
  async add_to_radar() { throw new Error('Radar needs the desktop app connected to Spotify.'); },
  // Phase 9e: Ollama proxy (browser harness + Docker). OLLAMA_URL env wins; else app_meta ollama_url; else localhost.
  async llm_status() {
    if (process.env.OLLAMA_MOCK) return { reachable: true, url: 'mock://ollama', models: ['mock-model'], error: null };
    const url = await ollamaUrl();
    try { const r = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(4000) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); const v = await r.json(); return { reachable: true, url, models: (v.models ?? []).map((m) => m.name), error: null }; }
    catch (e) { return { reachable: false, url, models: [], error: String(e.message ?? e) }; }
  },
  async llm_chat({ model, messages, jsonMode, temperature }) {
    // OLLAMA_MOCK=1: a canned "model" for the smoke tests and screenshots — writes one fixed query, narrates one sentence.
    if (process.env.OLLAMA_MOCK) {
      const last = messages[messages.length - 1]?.content ?? '';
      if (jsonMode) return JSON.stringify(/fix it/i.test(last) ? { sql: 'SELECT artist_name, COUNT(*) AS plays FROM plays_resolved WHERE attended GROUP BY 1 ORDER BY 2 DESC LIMIT 5', explanation: 'repaired', answerable: true } : /lyrics/i.test(last) ? { sql: 'SELECT track_id, track_name, artist_name, COUNT(*) AS plays FROM plays_resolved WHERE attended GROUP BY 1, 2, 3 ORDER BY 4 DESC LIMIT 8', explanation: 'top tracks', answerable: true } : /weather|rain/i.test(last) ? { answerable: false, why_not: 'Weather is not in the record.' } : { sql: 'SELECT artist_name, COUNT(*) AS plays, ROUND(SUM(ms_played)/3600000.0, 1) AS hours FROM plays_resolved WHERE attended GROUP BY 1 ORDER BY 2 DESC LIMIT 5', explanation: 'top artists by plays', answerable: true });
      return `(mock narration for ${model}) The rows say what they say: five names, a few thousand plays between them, and one of them well ahead of the rest.`;
    }
    const url = await ollamaUrl();
    const body = { model, messages, stream: false, options: { temperature: temperature ?? 0.2, num_ctx: 8192 } }; if (jsonMode) body.format = 'json';
    const r = await fetch(`${url}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(240000) });
    const text = await r.text(); if (!r.ok) throw new Error(`Ollama ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text).message?.content ?? '';
  },
  // Phase 9f — scene vocabulary edits (mirror of commands.rs)
  async scene_family_upsert({ scene, label, kind, blurb, hidden }) {
    if (!/^[a-z0-9-]{1,40}$/.test(scene)) throw new Error('scene key must be lowercase letters, digits and hyphens');
    await con.run(`INSERT INTO scene_families (scene, label, kind, blurb, builtin, hidden) VALUES (${q(scene)}, ${q(label)}, ${q(kind === 'region' ? 'region' : 'style')}, ${blurb ? q(blurb) : 'NULL'}, FALSE, ${hidden ? 'TRUE' : 'FALSE'})
                   ON CONFLICT (scene) DO UPDATE SET label = excluded.label, kind = excluded.kind, blurb = excluded.blurb, hidden = excluded.hidden`);
    emit('data:changed', { reason: 'scenes' }); return null;
  },
  async scene_family_delete({ scene }) {
    const [row] = await rowsOf('SELECT builtin FROM scene_families WHERE scene = $1', [scene]);
    if (!row) return null; if (row.builtin) throw new Error('Built-in families can be hidden, not deleted.');
    await con.run(`DELETE FROM scene_tag_map WHERE scene = ${q(scene)}`); await con.run(`DELETE FROM scene_origin_map WHERE scene = ${q(scene)}`);
    await con.run(`DELETE FROM scene_overrides WHERE scene = ${q(scene)}`); await con.run(`DELETE FROM artist_scene WHERE scene = ${q(scene)}`); await con.run(`DELETE FROM scene_families WHERE scene = ${q(scene)}`);
    emit('data:changed', { reason: 'scenes' }); return null;
  },
  async scene_tag_set({ tag, scene }) {
    if (!tag) throw new Error('tag required');
    if (scene === null || scene === undefined) await con.run(`DELETE FROM scene_tag_map WHERE tag = ${q(tag)}`);
    else await con.run(`INSERT INTO scene_tag_map (tag, scene, builtin) VALUES (${q(tag)}, ${q(scene)}, FALSE) ON CONFLICT (tag) DO UPDATE SET scene = excluded.scene, builtin = FALSE`);
    return null;
  },
  async scene_origin_set({ country, scene }) {
    if (!/^[A-Z]{2}$/.test(country)) throw new Error('country must be an ISO alpha-2 code');
    if (scene === null || scene === undefined) await con.run(`DELETE FROM scene_origin_map WHERE country = ${q(country)}`);
    else await con.run(`INSERT INTO scene_origin_map (country, scene, builtin) VALUES (${q(country)}, ${q(scene)}, FALSE) ON CONFLICT (country) DO UPDATE SET scene = excluded.scene, builtin = FALSE`);
    return null;
  },
  async recompute_scenes() {
    await con.run(rd('compute_scenes.sql'));
    const [r] = await rowsOf('SELECT COUNT(DISTINCT artist_id) AS artists, COUNT(DISTINCT scene) AS families FROM artist_scene');
    emit('data:changed', { reason: 'scenes' }); return { artists: Number(r.artists), families: Number(r.families) };
  },
  async set_artist_scene({ artistId, scene }) {
    const q = (v) => (v == null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`);
    await con.run(`INSERT INTO scene_overrides (artist_id, scene) VALUES (${q(artistId)}, ${q(scene)}) ON CONFLICT (artist_id) DO UPDATE SET scene = excluded.scene, decided_at = now()`);
    await con.run(`DELETE FROM artist_scene WHERE artist_id = ${q(artistId)}`);
    if (scene) await con.run(`INSERT INTO artist_scene VALUES (${q(artistId)}, ${q(scene)}, 9.0)`);
    return null;
  },
  async queue_track({ trackId }) { return { status: String(trackId).startsWith('local:') ? 'unqueueable' : 'not_connected', message: 'Queueing needs the desktop app connected to Spotify.' }; },
  async save_text_file({ path: p, contents }) { fs.writeFileSync(p, contents); return null; },
  async import_blend({ path: input, label }) { const files = locate(input); if (!files.length) throw new Error('No history files found'); await con.run(`DELETE FROM blend_plays WHERE label = '${String(label).replace(/'/g, "''")}'`); let n = 0; for (const f of files) { await con.run(rd('import_stage.sql').replace('?1', `'${f.replace(/'/g, "''")}'`)); const before = +(await scalar('SELECT COUNT(*) FROM blend_plays')); await con.run(rd('import_blend.sql').replace('?1', `'${String(label).replace(/'/g, "''")}'`)); n += +(await scalar('SELECT COUNT(*) FROM blend_plays')) - before; } emit('data:changed', { reason: 'blend' }); return n; },
  async merge_artists({ fromId, intoId }) { await con.run(`INSERT INTO artist_merges (from_artist_id, into_artist_id) VALUES ('${fromId.replace(/'/g, "''")}', '${intoId.replace(/'/g, "''")}') ON CONFLICT DO UPDATE SET into_artist_id = excluded.into_artist_id`); await rebuild(); emit('data:changed', { reason: 'merge' }); return null; },
  async unmerge_artist({ fromId }) { await con.run(`DELETE FROM artist_merges WHERE from_artist_id = '${fromId.replace(/'/g, "''")}'`); await rebuild(); emit('data:changed', { reason: 'merge' }); return null; },
  async list_merges() { return rowsOf('SELECT m.from_artist_id AS fromId, m.into_artist_id AS intoId, a.name AS intoName, al.alias_name AS fromName FROM artist_merges m LEFT JOIN artists a ON a.artist_id = m.into_artist_id LEFT JOIN artist_aliases al ON al.artist_id = m.into_artist_id AND lower(al.alias_name) = substr(m.from_artist_id, 6) ORDER BY m.created_at DESC'); },
  async listenbrainz_connect() { throw new Error('Connectors need the desktop app.'); }, async listenbrainz_disconnect() { return null; },
  async set_tz_override({ fromDate, toDate, zone: z, note, removeId }) { if (removeId) await con.run(`DELETE FROM tz_overrides WHERE CAST(id AS VARCHAR) = '${removeId}'`); else await con.run(`INSERT INTO tz_overrides (from_date, to_date, zone, note) VALUES (DATE '${fromDate}', DATE '${toDate}', '${z}', ${note ? `'${String(note).replace(/'/g, "''")}'` : 'NULL'})`); await loadTz(zone); await rebuild(); emit('data:changed', { reason: 'timezone' }); return null; },
  async set_session_attention({ startAt, attention }) { if (attention) await con.run(`INSERT INTO session_overrides (start_at, attention) VALUES (TIMESTAMP '${startAt}', '${attention}') ON CONFLICT (start_at) DO UPDATE SET attention = excluded.attention`); else await con.run(`DELETE FROM session_overrides WHERE start_at = TIMESTAMP '${startAt}'`); await rebuild(); emit('data:changed', { reason: 'session' }); return null; },
  async set_concert() { return null; }, async mark_milestone_seen({ id }) { await con.run(`UPDATE milestones SET seen = TRUE WHERE CAST(milestone_id AS VARCHAR) = '${id}'`); return null; },
  async mark_insight_surfaced({ id }) { await con.run(`UPDATE insights SET surfaced = TRUE WHERE CAST(insight_id AS VARCHAR) = '${id}'`); return null; },
  async spotify_tracks_for_artists() { throw new Error('Needs the desktop app connected to Spotify.'); },
  async clear_blend() { await con.run('DELETE FROM blend_plays'); return null; },
  // Phase 9f — Move to another computer (mirror of migrate.rs). The harness writes a *folder* bundle (no zip
  // library in Node); the desktop app writes a .zip. Restore accepts either (zips via the `unzip` CLI when present).
  async export_move_bundle({ destDir, passphrase }) {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const dir = path.join(destDir || path.dirname(dbPath), `deep-cuts-move-${stamp}`); fs.mkdirSync(path.join(dir, 'tables'), { recursive: true });
    await con.run('CHECKPOINT');
    const names = (await rowsOf("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE' ORDER BY 1")).map((r) => r.table_name).filter((t) => t !== 'tz_offsets' && !t.startsWith('_'));
    const tables = [];
    for (const t of names) { await con.run(`COPY (SELECT * FROM "${t}") TO ${q(path.join(dir, 'tables', `${t}.parquet`))} (FORMAT PARQUET, COMPRESSION ZSTD)`); tables.push({ name: t, rows: Number(await scalar(`SELECT COUNT(*) FROM "${t}"`)) }); }
    const [span] = await rowsOf('SELECT CAST(MIN(played_at) AS VARCHAR) AS f, CAST(MAX(played_at) AS VARCHAR) AS l FROM plays_resolved');
    const manifest = { format: 1, app_version: 'dev-server', pipeline_rev: 'dev', created_at: new Date().toISOString(), zone, tables, events: Number(await scalar('SELECT COUNT(*) FROM events')), plays: Number(await scalar('SELECT COUNT(*) FROM plays_resolved')), first_play: span?.f ?? null, last_play: span?.l ?? null, secrets: false, source_os: process.platform, source_data_dir: path.dirname(dbPath) };
    if (passphrase) console.warn('dev-server has no keyring; secrets are not included in folder bundles');
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await con.run(`INSERT INTO activity_log (task, level, message, detail) VALUES ('move', 'info', 'Move bundle written (folder)', ${q(dir)})`);
    return dir;
  },
  async inspect_move_bundle({ path: p }) { return JSON.parse(fs.readFileSync(path.join(bundleDir(p), 'manifest.json'), 'utf8')); },
  async restore_move_bundle({ path: p }) {
    const dir = bundleDir(p); const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
    let backup = null;
    if (Number(await scalar('SELECT COUNT(*) FROM events')) > 0) { backup = path.join(path.dirname(dbPath), `events-before-restore-${Date.now()}.parquet`); await con.run(`COPY (SELECT * FROM events ORDER BY occurred_at) TO ${q(backup)} (FORMAT PARQUET)`); }
    const existing = new Set((await rowsOf("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main' AND table_type = 'BASE TABLE'")).map((r) => r.table_name));
    let tables = 0, rows = 0; const skipped = [];
    await con.run('BEGIN TRANSACTION');
    try {
      for (const t of manifest.tables) {
        const file = path.join(dir, 'tables', `${t.name}.parquet`);
        if (!existing.has(t.name) || !fs.existsSync(file)) { skipped.push(t.name); continue; }
        const src = (await rowsOf(`DESCRIBE SELECT * FROM read_parquet(${q(file)})`)).map((r) => r.column_name);
        const dst = (await rowsOf(`SELECT column_name FROM information_schema.columns WHERE table_schema = 'main' AND table_name = ${q(t.name)} ORDER BY ordinal_position`)).map((r) => r.column_name);
        const cols = dst.filter((c) => src.includes(c)).map((c) => `"${c}"`);
        if (!cols.length) { skipped.push(t.name); continue; }
        await con.run(`DELETE FROM "${t.name}"`); await con.run(`INSERT INTO "${t.name}" (${cols.join(', ')}) SELECT ${cols.join(', ')} FROM read_parquet(${q(file)})`);
        tables += 1; rows += Number(t.rows);
      }
      await con.run('COMMIT');
    } catch (e) { await con.run('ROLLBACK'); throw e; }
    let z = zone; try { z = String(await scalar("SELECT value FROM app_meta WHERE key = 'timezone'")) || zone; } catch { /* keep */ }
    await loadTz(z); await rebuild();
    emit('data:changed', { reason: 'restore' });
    return { tables, rows, skipped_tables: skipped, secrets_restored: 0, manifest, backup_of_previous: backup };
  },
  // Phase 9i — metadata corrections (mirror of commands.rs; MusicBrainz lookups need the desktop app)
  async meta_set({ entityType, entityId, field, value }) {
    const ok = { artist: ['image_url'], album: ['release_date', 'image_url'], track: ['isrc', 'release_date'] };
    if (!ok[entityType]?.includes(field)) throw new Error(`${entityType}.${field} can't be edited`);
    let v = (value ?? '').trim();
    if (field === 'release_date' && v && !/^\d{4}(-\d{2}-\d{2})?$/.test(v)) throw new Error('Use a year (1972) or a date (1972-03-01)');
    if (field === 'release_date' && /^\d{4}$/.test(v)) v += '-01-01';
    if (field === 'isrc') v = v.replace(/-/g, '').toUpperCase();
    if (!v) { await con.run(`DELETE FROM metadata_overrides WHERE entity_type = ${q(entityType)} AND entity_id = ${q(entityId)} AND field = ${q(field)}`); return null; }
    await con.run(`INSERT INTO metadata_overrides (entity_type, entity_id, field, value) VALUES (${q(entityType)}, ${q(entityId)}, ${q(field)}, ${q(v)}) ON CONFLICT (entity_type, entity_id, field) DO UPDATE SET value = excluded.value, updated_at = now()`);
    const [table, key] = { artist: ['artists', 'artist_id'], album: ['albums', 'album_id'], track: ['tracks', 'track_id'] }[entityType];
    await con.run(`UPDATE ${table} SET ${field} = ${field === 'release_date' ? `TRY_CAST(${q(v)} AS DATE)` : q(v)} WHERE ${key} = ${q(entityId)}`);
    if (field === 'isrc') { await con.run(`DELETE FROM track_features WHERE track_id = ${q(entityId)}`); await con.run(`DELETE FROM track_credits WHERE track_id = ${q(entityId)}`); }
    return null;
  },
  async artist_set_origin({ artistId, country, city, formedYear }) {
    const cc = (country ?? '').trim().toUpperCase();
    if (cc && !/^[A-Z]{2}$/.test(cc)) throw new Error('Country must be a two-letter code (US, GB, TR…)');
    if (!cc && !(city ?? '').trim() && formedYear == null) { await con.run(`DELETE FROM artist_origin WHERE artist_id = ${q(artistId)} AND source = 'owner'`); return null; }
    await con.run(`INSERT INTO artist_origin (artist_id, country, country_name, city, formed_year, source) VALUES (${q(artistId)}, ${cc ? q(cc) : 'NULL'}, NULL, ${(city ?? '').trim() ? q(city.trim()) : 'NULL'}, ${formedYear == null ? 'NULL' : Number(formedYear)}, 'owner')
                   ON CONFLICT (artist_id) DO UPDATE SET country = excluded.country, country_name = NULL, city = excluded.city, formed_year = excluded.formed_year, source = 'owner', fetched_at = now()`);
    return null;
  },
  async artist_mb_candidates() { throw new Error('MusicBrainz lookups need the desktop app.'); },
  async artist_set_mbid({ artistId, mbid }) {
    const id = String(mbid).trim().replace(/\/$/, '').split('/').pop();
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error("That doesn't look like a MusicBrainz artist id or URL");
    await con.run(`INSERT INTO artist_mb_match (artist_id, mbid, method, evidence) VALUES (${q(artistId)}, ${q(id)}, 'owner', 'chosen by you') ON CONFLICT (artist_id) DO UPDATE SET mbid = excluded.mbid, method = 'owner', evidence = excluded.evidence, checked_at = now()`);
    await con.run(`UPDATE artists SET mbid = ${q(id)} WHERE artist_id = ${q(artistId)}`);
    return null;
  },
  async forecast_log_write({ date, weekday, payload }) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('date must be YYYY-MM-DD');
    const before = Number(await scalar('SELECT COUNT(*) FROM forecast_log'));
    await con.run(`INSERT INTO forecast_log (forecast_date, weekday, payload) VALUES (CAST(${q(date)} AS DATE), ${Number(weekday)}, CAST(${q(payload)} AS JSON)) ON CONFLICT (forecast_date) DO NOTHING`);
    return Number(await scalar('SELECT COUNT(*) FROM forecast_log')) > before;
  },
  async lyrics_enrich_now() { throw new Error('Lyric fetching needs the desktop app.'); },
  async lyrics_status() { const [r] = await rowsOf("SELECT COUNT(*) FILTER (WHERE found AND COALESCE(features_rev, 1) < 2) AS old_rules, COUNT(*) FILTER (WHERE found AND COALESCE(features_rev, 1) >= 2) AS current FROM track_lyric_features"); const never = await scalar('SELECT COUNT(*) FROM (SELECT DISTINCT track_id FROM plays_resolved WHERE attended AND track_id IS NOT NULL) p WHERE NOT EXISTS (SELECT 1 FROM track_lyric_features f WHERE f.track_id = p.track_id)'); let llm = false; try { llm = String(await scalar("SELECT value FROM app_meta WHERE key = 'lyrics_llm_enabled'")) === 'true'; } catch { /* unset */ } return { oldRules: Number(r.old_rules), current: Number(r.current), never: Number(never), llmEnabled: llm }; },
  async save_binary_file() { return null; },
  async lastfm_wild_connect() { throw new Error('Connectors need the desktop app.'); }, async lastfm_wild_disconnect() { return null; }, async lastfm_wild_reset() { throw new Error('Connectors need the desktop app.'); },
  async statsfm_connect() { throw new Error('Connectors need the desktop app.'); }, async statsfm_disconnect() { return null; }, async musicbrainz_connect() { throw new Error('Connectors need the desktop app.'); }, async musicbrainz_disconnect() { return null; },
};

const STATIC = process.env.DEEPCUTS_STATIC ? path.resolve(process.env.DEEPCUTS_STATIC) : (fs.existsSync(path.join(here, 'dist', 'index.html')) && process.env.DEEPCUTS_SERVE_DIST ? path.join(here, 'dist') : null);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.woff': 'font/woff', '.json': 'application/json', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };
const WRITE_CMDS = new Set(['set_setting', 'set_timezone', 'rebuild', 'rec_feedback', 'set_artist_scene', 'scene_family_upsert', 'scene_family_delete', 'scene_tag_set', 'scene_origin_set', 'recompute_scenes', 'restore_move_bundle', 'forecast_log_write', 'meta_set', 'artist_set_origin', 'artist_set_mbid', 'set_session_attention', 'merge_artists', 'import_files', 'start_import', 'set_tz_override', 'delete_tz_override']);
function serveStatic(url, res) {
  if (!STATIC) return false;
  let rel = decodeURIComponent(url.pathname); if (rel === '/' || rel === '') rel = '/index.html';
  let file = path.join(STATIC, rel);
  if (!file.startsWith(STATIC)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { if (path.extname(rel)) return false; file = path.join(STATIC, 'index.html'); }
  res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
  if (rel.startsWith('/assets/')) res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  fs.createReadStream(file).pipe(res); return true;
}
const PORT = Number(process.env.PORT ?? 4747), HOST = process.env.HOST ?? '127.0.0.1';
http.createServer(async (req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', 'content-type');
  if (req.method === 'OPTIONS') return res.end();
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/_events') {
    const name = url.searchParams.get('name');
    const mine = events.filter((e) => e.name === name);
    for (const e of mine) events.splice(events.indexOf(e), 1);
    res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify(mine.map((e) => e.payload)));
  }
  if (url.pathname === '/_health') { res.setHeader('content-type', 'application/json'); return res.end(JSON.stringify({ ok: true, db: dbPath, readonly: READONLY, static: !!STATIC })); }
  const cmd = url.pathname.replace(/^\/api\//, '/').slice(1);
  if (req.method === 'GET' && !commands[cmd] && serveStatic(url, res)) return;
  let body = ''; for await (const c of req) body += c;
  try {
    if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
    if (READONLY && WRITE_CMDS.has(cmd)) throw new Error('This server is read-only — make the change in the desktop app.');
    const out = await commands[cmd](body ? JSON.parse(body) : {});
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out ?? null, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
  } catch (e) { res.statusCode = 400; res.end(String(e.message ?? e)); }
}).listen(PORT, HOST, () => console.log(`Deep Cuts server on http://${HOST}:${PORT} — db ${dbPath}${READONLY ? ' (read-only)' : ''} — zone ${zone}${STATIC ? ` — serving ${STATIC}` : ''}`));
