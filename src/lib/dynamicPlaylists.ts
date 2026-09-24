/**
 * Phase 9k — dynamic playlists (roadmap 9b §2.2). A definition is a rule + size + cadence, stored as JSON in
 * app_meta `dynamic_playlists`. Previews are rebuilt from your record whenever one is due (daily / weekly) and on
 * demand; when a definition is linked to a Spotify playlist and auto-sync is on, the new edition replaces that
 * playlist's tracks in place (`replace_playlist_items`) — same link, same followers, fresh songs.
 */
import { invoke } from './bridge';
import { query, num, str } from './db';
import { playsWhere } from './filter';
import { dayForecast } from './forecastQueries';
import { soundAlike, tempoStations } from './featureQueries';
import { revisit } from './revisitQueries';
import type { TrackRow } from './types';

export type Rule =
  | { kind: 'forecast' }
  | { kind: 'rotation'; days: number }
  | { kind: 'rediscover'; silentDays: number }
  | { kind: 'scene'; scene: string; recentDays: number | null }
  | { kind: 'tempo'; band: string; energy: 'any' | 'high' | 'low' }
  | { kind: 'revisit' }
  | { kind: 'soundsLike'; trackId: string; track: string }
  | { kind: 'words'; text: string };   // Phase 9l: a sentence, re-interpreted and rebuilt each edition
export type DynamicPlaylist = {
  id: string; name: string; rule: Rule; size: number; cadence: 'daily' | 'weekly'; autoSync: boolean;
  spotifyId: string | null; spotifyUrl: string | null; lastBuiltAt: string | null; lastSyncedAt: string | null; lastTrackIds: string[];
  /** Phase 9m: refresh only on days whose weather (Settings → Record → Weather) is this — a rainy-day station. */
  weatherGate?: 'sunny' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm' | null;
};
export const RULE_LABEL: Record<Rule['kind'], string> = {
  words: 'From words', forecast: "Today's forecast (DCFM)", rotation: 'Heavy rotation', rediscover: 'Rediscoveries', scene: 'A scene', tempo: 'A tempo band', revisit: 'To revisit', soundsLike: 'Sounds like a song',
};

export async function loadDynamic(): Promise<DynamicPlaylist[]> {
  const [r] = await query(`SELECT value FROM app_meta WHERE key = 'dynamic_playlists'`);
  try { const v = JSON.parse(String(r?.value ?? '[]')); return Array.isArray(v) ? v : []; } catch { return []; }
}
export const saveDynamic = (defs: DynamicPlaylist[]) => invoke('set_setting', { key: 'dynamic_playlists', value: JSON.stringify(defs) });
export const newId = () => `dp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
export const spotifyIdFromUrl = (url: string | null | undefined) => (url ? (/playlist\/([A-Za-z0-9]{22})/.exec(url)?.[1] ?? null) : null);

/** Build the current edition of a rule from the record. Never includes local files; de-duplicated; ≤ size. */
export async function buildRule(rule: Rule, size: number): Promise<TrackRow[]> {
  const P = playsWhere('p');
  const pick = (rows: Record<string, unknown>[]) => rows.map((r) => ({ trackId: String(r.track_id), track: String(r.t), artistId: str(r.aid), artist: String(r.a ?? ''), plays: num(r.n), hours: num(r.h), skipRate: num(r.sr) }));
  const base = `SELECT track_id, arg_max(track_name, ms_played) AS t, arg_max(artist_id, ms_played) AS aid, arg_max(artist_name, ms_played) AS a, COUNT(*) AS n, SUM(ms_played)/3600000.0 AS h, AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) AS sr
                FROM plays_resolved p WHERE p.attended AND track_id IS NOT NULL AND track_id NOT LIKE 'local:%' ${P}`;
  let out: TrackRow[] = [];
  switch (rule.kind) {
    case 'forecast': out = (await dayForecast()).tracks; break;
    case 'rotation': out = pick(await query(`${base} AND p.played_at >= now() - INTERVAL ${Math.max(3, Math.round(rule.days))} DAY GROUP BY 1 HAVING AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) < 0.4 ORDER BY n DESC LIMIT ${size}`)); break;
    case 'rediscover': out = pick(await query(`${base} GROUP BY 1 HAVING COUNT(*) >= 8 AND AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) < 0.3 AND MAX(played_at) < now() - INTERVAL ${Math.max(60, Math.round(rule.silentDays))} DAY ORDER BY hash(track_id || CAST(current_date AS VARCHAR)) LIMIT ${size}`)); break;
    case 'scene': out = pick(await query(`${base} AND p.artist_id IN (SELECT artist_id FROM artist_scene s WHERE s.scene = $1 QUALIFY s.weight = MAX(s.weight) OVER (PARTITION BY artist_id)) ${rule.recentDays ? `AND p.played_at >= now() - INTERVAL ${Math.round(rule.recentDays)} DAY` : ''} GROUP BY 1 HAVING AVG(CASE WHEN was_skipped THEN 1.0 ELSE 0 END) < 0.4 ORDER BY n DESC LIMIT ${size * 3}`, [rule.scene]));
      out = shuffleDaily(out).slice(0, size); break;
    case 'tempo': { const st = (await tempoStations(rule.energy, size * 3)).find((b) => b.id === rule.band); out = shuffleDaily((st?.tracks ?? []).map((t) => ({ trackId: t.trackId, track: t.track, artistId: t.artistId, artist: t.artist, plays: t.plays, hours: 0, skipRate: 0 }))); break; }
    case 'revisit': { const r = await revisit(size); out = [...r.regulars, ...r.fence, ...r.onceByLiked].map((t) => ({ trackId: t.trackId, track: t.track, artistId: t.artistId, artist: t.artist, plays: t.plays, hours: t.hours, skipRate: t.skipRate })); break; }
    case 'words': { const w = await import('./wordsPlaylist'); const spec = await w.interpret(rule.text); spec.size = size; out = (await w.buildFromSpec(spec)).picks.map((p) => ({ trackId: p.trackId, track: p.track, artistId: p.artistId, artist: p.artist, plays: p.plays, hours: 0, skipRate: 0 })); break; }
    case 'soundsLike': out = (await soundAlike(rule.trackId, size)).tracks.map((t) => ({ trackId: t.trackId, track: t.track, artistId: t.artistId, artist: t.artist, plays: t.plays, hours: 0, skipRate: 0 })); break;
  }
  const seen = new Set<string>();
  return out.filter((t) => t.trackId && !t.trackId.startsWith('local:') && !seen.has(t.trackId) && seen.add(t.trackId)).slice(0, size);
}
/** Deterministic per-day shuffle so a daily edition changes each day but is stable within it. */
function shuffleDaily<T extends { trackId: string }>(xs: T[]): T[] {
  const day = new Date().toISOString().slice(0, 10);
  const h = (s: string) => { let x = 2166136261; for (const c of s + day) x = Math.imul(x ^ c.charCodeAt(0), 16777619) >>> 0; return x; };
  return [...xs].sort((a, b) => h(a.trackId) - h(b.trackId));
}

export const isDue = (d: DynamicPlaylist, now = Date.now()) => !d.lastBuiltAt || now - Date.parse(d.lastBuiltAt) >= (d.cadence === 'daily' ? 20 : 6 * 24 + 20) * 3600e3;

/** Rebuild every due definition; push to Spotify where linked + auto. Returns what changed (for a toast). */
export async function refreshDue(force: string[] = []): Promise<{ rebuilt: string[]; synced: string[]; errors: string[] }> {
  const defs = await loadDynamic(); const rebuilt: string[] = [], synced: string[] = [], errors: string[] = [];
  const [w] = await query(`SELECT bucket FROM weather_daily WHERE date = current_date`).catch(() => [] as Record<string, unknown>[]);
  const today = str(w?.bucket);
  for (const d of defs) {
    if (!isDue(d) && !force.includes(d.id)) continue;
    if (d.weatherGate && d.weatherGate !== today && !force.includes(d.id)) continue;   // not this weather today — keep the last edition
    try {
      const tracks = await buildRule(d.rule, d.size);
      d.lastTrackIds = tracks.map((t) => t.trackId); d.lastBuiltAt = new Date().toISOString(); rebuilt.push(d.name);
      if (d.autoSync && d.spotifyId && tracks.length) { await invoke<number>('replace_playlist_items', { playlistId: d.spotifyId, trackIds: d.lastTrackIds }); d.lastSyncedAt = new Date().toISOString(); synced.push(d.name); }
    } catch (e) { errors.push(`${d.name}: ${String((e as Error).message ?? e)}`); }
  }
  if (rebuilt.length) await saveDynamic(defs);
  return { rebuilt, synced, errors };
}
