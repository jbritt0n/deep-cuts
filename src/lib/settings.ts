/**
 * Phase 9c — one synchronous view of app_meta for the query layer.
 *
 * Settings that used to be hardcoded in TS (the discovery feedback memory, the forgotten-artist
 * window, the tag confidence floor, …) are read through `setting()` so Settings → Tuning changes
 * them everywhere at once. `loadSettings()` is awaited once at app start and again whenever the
 * record changes; queries read the cache synchronously, the same pattern as the listening lens.
 * Settings that live in SQL (short-play cutoff, session-shape thresholds) are read by the SQL
 * itself from app_meta and need a rebuild — `TUNING[].rebuild` says which.
 */
import { invoke } from './bridge';

let cache: Record<string, string> = {};
export async function loadSettings(): Promise<Record<string, string>> {
  try { const rows = await invoke<{ key: string; value: string }[]>('get_settings'); cache = Object.fromEntries(rows.map((r) => [r.key, r.value])); } catch { /* keep what we had */ }
  return cache;
}
export const settingRaw = (key: string) => cache[key];
export function setting(key: string, fallback: number): number { const v = Number(cache[key]); return Number.isFinite(v) && cache[key] !== undefined && cache[key] !== '' ? v : fallback; }
export const settingBool = (key: string, fallback = false) => (cache[key] === undefined ? fallback : cache[key] === 'true');
/** For tests / the browser harness: seed the cache without a round-trip. */
export const primeSettings = (v: Record<string, string>) => { cache = { ...v }; };

export type Tunable = { key: string; label: string; unit: string; min: number; max: number; step: number; def: number; why: string; group: 'sessions' | 'discovery' | 'connectors'; rebuild?: boolean };
export const TUNING: Tunable[] = [
  { key: 'attention_gap_min', group: 'sessions', label: 'Attention gap', unit: 'min', min: 15, max: 600, step: 15, def: 120, rebuild: true, why: 'How long autoplay may run without you touching anything before it stops counting as listening. 120: a double album still counts; a laptop left on overnight does not.' },
  { key: 'short_play_seconds', group: 'sessions', label: 'Short-play cutoff', unit: 's', min: 10, max: 60, step: 5, def: 30, rebuild: true, why: 'Plays shorter than this count as "under 30 s" in skip forensics and patience-by-year. Skips themselves are button presses, not a duration.' },
  { key: 'shape_loop_repeat', group: 'sessions', label: 'Comfort loop · repeat rate', unit: '', min: 0.1, max: 0.6, step: 0.05, def: 0.25, rebuild: true, why: 'Share of plays that are the same song straight again before a session reads as a comfort loop.' },
  { key: 'shape_discovery_novelty', group: 'sessions', label: 'Discovery run · new-to-you share', unit: '', min: 0.3, max: 0.8, step: 0.05, def: 0.5, rebuild: true, why: 'Share of never-before-played songs (6+ plays) before a session reads as a discovery run.' },
  { key: 'shape_restless_skip', group: 'sessions', label: 'Restless · skip rate', unit: '', min: 0.2, max: 0.7, step: 0.05, def: 0.4, rebuild: true, why: 'Skip rate at or above which a session is restless; warm-ups must stay under it.' },
  { key: 'shape_wander_entropy', group: 'sessions', label: 'Shuffle wander · artist variety', unit: 'bits', min: 1.5, max: 3.5, step: 0.1, def: 2.5, rebuild: true, why: 'Artist entropy (8+ plays) before a session reads as a shuffle wander. 3 bits ≈ eight artists sharing the time evenly.' },
  { key: 'feedback_memory_days', group: 'discovery', label: 'Discover feedback memory', unit: 'days', min: 14, max: 365, step: 7, def: 90, why: 'How long a dismissed recommendation stays hidden. One setting now, where three separate copies of "90" used to live.' },
  { key: 'forgotten_days', group: 'discovery', label: 'Forgotten-artist window', unit: 'days', min: 180, max: 1460, step: 30, def: 540, why: 'How long an artist must be silent before the comeback engine suggests them. Shorter feels current; longer feels sentimental.' },
  { key: 'tag_floor', group: 'discovery', label: 'Genre tag confidence floor', unit: '', min: 0.05, max: 0.6, step: 0.05, def: 0.2, why: 'Minimum Last.fm/MusicBrainz tag weight before a tag counts — for genre browse, genre threads and Discover alike.' },
  { key: 'lyrics_batch', group: 'connectors', label: 'Lyric batch size', unit: 'tracks / 15 min', min: 10, max: 100, step: 10, def: 40, why: 'How many tracks LRCLIB is asked about per tick. Politeness vs. speed.' },
];
export const tuningDefault = (key: string) => TUNING.find((t) => t.key === key)?.def ?? 0;
/** Tunables referenced from SQL/TS as `INTERVAL n DAY` etc. — always integers, always in range. */
export const intSetting = (key: string) => { const t = TUNING.find((x) => x.key === key)!; return Math.round(Math.min(t.max, Math.max(t.min, setting(key, t.def)))); };
export const numSetting = (key: string) => { const t = TUNING.find((x) => x.key === key)!; return Math.min(t.max, Math.max(t.min, setting(key, t.def))); };
