/**
 * Phase 9e — what the record costs on disk (owner request). DuckDB reports the file size precisely
 * (`pragma_database_size()`); per-table bytes aren't exposed, so each table's share is ESTIMATED from
 * row count × column count relative to the whole, then scaled to the real file size. Good enough to see
 * that plays dominate and the caches are small — not an audit.
 */
import { query, num } from './db';

export type StorageRow = { table: string; rows: number; columns: number; estBytes: number; group: string };
export type Storage = { fileBytes: number; walBytes: number; blockSize: number; tables: StorageRow[]; groups: { group: string; bytes: number; rows: number }[]; imported: { events: number; plays: number; sources: { source: string; n: number }[] } };

const GROUP: [RegExp, string][] = [
  [/^(events|plays_normalized|import_files)$/, 'Raw plays (imports + polling)'],
  [/^(plays_resolved|sessions|play_sessions|session_transitions|daily_minutes|milestones|insights|artist_scene|eras)/, 'Derived tables (rebuildable)'],
  [/^(artists|albums|tracks|artist_aliases|artist_merges|entity)/, 'Entities'],
  [/^(artist_tags|artist_relations|artist_popularity|artist_origin|track_features|track_credits|track_lyric_features|cover|lyrics)/, 'Connector caches'],
  [/^(liked_songs|playlists|playlist_items|created_playlists|blend|wild|concerts|notes|recommendation_feedback|goals)/, 'Library & your decisions'],
  [/^(api_calls|activity_log|connector_state|app_meta|tz_|country_zones|forecast|ask_)/, 'Bookkeeping'],
];
const groupOf = (t: string) => GROUP.find(([re]) => re.test(t))?.[1] ?? 'Other';

export async function storage(): Promise<Storage> {
  const [sz] = await query(`SELECT database_size, wal_size, block_size FROM pragma_database_size()`);
  const parse = (s: unknown) => { const m = String(s ?? '0').match(/([\d.]+)\s*(bytes|KiB|MiB|GiB|TiB)?/i); if (!m) return 0; const n = Number(m[1]); const u = (m[2] ?? 'bytes').toLowerCase(); return n * ({ bytes: 1, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 } as Record<string, number>)[u]; };
  const fileBytes = parse(sz?.database_size), walBytes = parse(sz?.wal_size);
  const raw = (await query(`SELECT table_name, estimated_size, column_count FROM duckdb_tables() WHERE NOT internal AND NOT temporary ORDER BY estimated_size DESC`)).map((r) => ({ table: String(r.table_name), rows: num(r.estimated_size), columns: num(r.column_count) }));
  const weight = raw.reduce((s, t) => s + t.rows * t.columns, 0) || 1;
  const tables: StorageRow[] = raw.map((t) => ({ ...t, estBytes: (t.rows * t.columns / weight) * fileBytes, group: groupOf(t.table) }));
  const groups = [...tables.reduce((m, t) => { const g = m.get(t.group) ?? { group: t.group, bytes: 0, rows: 0 }; g.bytes += t.estBytes; g.rows += t.rows; return m.set(t.group, g); }, new Map<string, { group: string; bytes: number; rows: number }>()).values()].sort((a, b) => b.bytes - a.bytes);
  const [ev] = await query(`SELECT COUNT(*) AS e FROM events`);
  const [pl] = await query(`SELECT COUNT(*) AS p FROM plays_resolved`);
  const sources = (await query(`SELECT COALESCE(source, 'export') AS s, COUNT(*) AS n FROM plays_normalized GROUP BY 1 ORDER BY 2 DESC`)).map((r) => ({ source: String(r.s), n: num(r.n) }));
  return { fileBytes, walBytes, blockSize: num(sz?.block_size), tables, groups, imported: { events: num(ev?.e), plays: num(pl?.p), sources } };
}

export const fmtBytes = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : b >= 1024 ** 2 ? `${(b / 1024 ** 2).toFixed(1)} MB` : b >= 1024 ? `${Math.round(b / 1024)} KB` : `${Math.round(b)} B`);
