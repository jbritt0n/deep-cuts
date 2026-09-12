/**
 * Browser dev harness: serves the same commands the Tauri core exposes, over
 * HTTP, against a DuckDB file. Lets you iterate on the UI with `npm run
 * dev:browser` and no Rust toolchain. Read-only except import/rebuild.
 *   DEEPCUTS_DB=path/to/deep-cuts.duckdb node dev-server.mjs
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';

const here = path.dirname(fileURLToPath(import.meta.url));
const sqlDir = path.join(here, 'src-tauri', 'sql');
const rd = (n) => fs.readFileSync(path.join(sqlDir, n), 'utf8');
const dbPath = process.env.DEEPCUTS_DB ?? path.join(here, 'dev-data', 'deep-cuts.duckdb');
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

const inst = await DuckDBInstance.create(dbPath);
const con = await inst.connect();
await con.run("SET TimeZone='UTC'");
await con.run(rd('schema.sql'));
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
  async lyrics_enrich_now() { throw new Error('Lyric fetching needs the desktop app.'); },
  async save_binary_file() { return null; },
  async lastfm_wild_connect() { throw new Error('Connectors need the desktop app.'); }, async lastfm_wild_disconnect() { return null; }, async lastfm_wild_reset() { throw new Error('Connectors need the desktop app.'); },
  async statsfm_connect() { throw new Error('Connectors need the desktop app.'); }, async statsfm_disconnect() { return null; }, async musicbrainz_connect() { throw new Error('Connectors need the desktop app.'); }, async musicbrainz_disconnect() { return null; },
};

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
  const cmd = url.pathname.slice(1);
  let body = ''; for await (const c of req) body += c;
  try {
    if (!commands[cmd]) throw new Error(`unknown command ${cmd}`);
    const out = await commands[cmd](body ? JSON.parse(body) : {});
    res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out ?? null, (_, v) => (typeof v === 'bigint' ? Number(v) : v)));
  } catch (e) { res.statusCode = 400; res.end(String(e.message ?? e)); }
}).listen(4747, () => console.log(`Deep Cuts dev server on :4747 — db ${dbPath} — zone ${zone}`));
