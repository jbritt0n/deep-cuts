/**
 * Phase 9k — weather from Open-Meteo (free, no key, non-commercial). History comes from the archive API (the last
 * ~5 days aren't final there, so they come from the forecast API's `past_days`), the next 7 days from the forecast
 * API. Only the place you set is used — travel days abroad keep your home weather (Atlas covers where you were).
 * Everything network-facing is here; parsing and planning are pure and unit-tested (__tests__/weather.test.ts).
 */
import { invoke } from './bridge';
import { query, str } from './db';

export type Bucket = 'sunny' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm';
export type WeatherDay = { date: string; code: number | null; bucket: Bucket | null; tmax: number | null; tmin: number | null; precip: number | null; sunshine: number | null; kind: 'observed' | 'forecast' };
export const BUCKETS: { id: Bucket; label: string; glyph: string }[] = [
  { id: 'sunny', label: 'Sunny', glyph: '☀' }, { id: 'cloudy', label: 'Cloudy', glyph: '☁' }, { id: 'fog', label: 'Fog', glyph: '🌫' },
  { id: 'rain', label: 'Rain', glyph: '🌧' }, { id: 'snow', label: 'Snow', glyph: '❄' }, { id: 'storm', label: 'Storm', glyph: '⛈' },
];
export const bucketInfo = (b: string | null | undefined) => BUCKETS.find((x) => x.id === b) ?? null;

/** WMO weather interpretation codes → six listening-weather moods. */
export function bucketOf(code: number | null | undefined): Bucket | null {
  if (code == null || Number.isNaN(code)) return null;
  if (code <= 1) return 'sunny';
  if (code <= 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloudy';
}

/** Open-Meteo `daily` block → rows. Sunshine arrives in seconds. Missing arrays/values become null. */
export function parseDaily(json: unknown, kind: WeatherDay['kind'], today?: string): WeatherDay[] {
  const d = (json as { daily?: Record<string, unknown[]> })?.daily;
  if (!d || !Array.isArray(d.time)) return [];
  const at = (k: string, i: number) => { const a = d[k]; const v = Array.isArray(a) ? a[i] : null; return typeof v === 'number' && Number.isFinite(v) ? v : null; };
  return (d.time as string[]).map((date, i) => {
    const code = at('weather_code', i) ?? at('weathercode', i);
    const sun = at('sunshine_duration', i);
    const k: WeatherDay['kind'] = kind === 'forecast' && today && date < today ? 'observed' : kind;   // forecast API's past_days are observations
    return { date, code, bucket: bucketOf(code), tmax: at('temperature_2m_max', i), tmin: at('temperature_2m_min', i), precip: at('precipitation_sum', i), sunshine: sun == null ? null : Math.round((sun / 3600) * 10) / 10, kind: k };
  }).filter((r) => r.code != null || r.tmax != null);
}

/** Date ranges (≤ 366 days each) in [from, to] that aren't covered yet, so a sync only asks for what's missing. */
export function missingRanges(have: Set<string>, from: string, to: string, maxDays = 366): [string, string][] {
  const out: [string, string][] = [];
  const d = new Date(from + 'T12:00:00Z'), end = new Date(to + 'T12:00:00Z');
  let start: string | null = null, len = 0, prev: string | null = null;
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    if (!have.has(iso)) { if (!start) { start = iso; len = 0; } len++; prev = iso; if (len >= maxDays) { out.push([start, prev]); start = null; } }
    else if (start) { out.push([start, prev!]); start = null; }
  }
  if (start) out.push([start, prev!]);
  return out;
}

const DAILY = 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,sunshine_duration';
export type Place = { name: string; lat: number; lon: number; country?: string; admin1?: string };

export async function geocode(name: string): Promise<Place[]> {
  const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=6&language=en&format=json`);
  if (!r.ok) throw new Error(`Open-Meteo geocoding answered ${r.status}`);
  const j = await r.json() as { results?: { name: string; latitude: number; longitude: number; country?: string; admin1?: string }[] };
  return (j.results ?? []).map((x) => ({ name: x.name, lat: x.latitude, lon: x.longitude, country: x.country, admin1: x.admin1 }));
}

export async function weatherPlace(): Promise<Place | null> {
  const rows = await query(`SELECT key, value FROM app_meta WHERE key IN ('weather_lat', 'weather_lon', 'weather_place')`);
  const m = Object.fromEntries(rows.map((r) => [String(r.key), str(r.value)]));
  const lat = Number(m.weather_lat), lon = Number(m.weather_lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && m.weather_lat ? { name: m.weather_place ?? `${lat.toFixed(2)}, ${lon.toFixed(2)}`, lat, lon } : null;
}
export async function setWeatherPlace(p: Place | null) {
  await invoke('set_setting', { key: 'weather_lat', value: p ? String(p.lat) : '' });
  await invoke('set_setting', { key: 'weather_lon', value: p ? String(p.lon) : '' });
  await invoke('set_setting', { key: 'weather_place', value: p ? [p.name, p.admin1, p.country].filter(Boolean).join(', ') : '' });
}

/**
 * Fill history for the span of your record (oldest play → 6 days ago), then refresh the last week + next 7 days.
 * Returns how many days were stored. Safe to call often: only missing ranges are requested, and the forecast part
 * at most every 3 hours.
 */
export async function syncWeather(onProgress?: (msg: string) => void): Promise<number> {
  const place = await weatherPlace(); if (!place) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const [span] = await query(`SELECT CAST(CAST(MIN(played_at) AS DATE) AS VARCHAR) AS f FROM plays_resolved`);
  const first = str(span?.f)?.slice(0, 10) ?? today;
  const have = new Set((await query(`SELECT CAST(date AS VARCHAR) AS d FROM weather_daily WHERE kind = 'observed'`)).map((r) => String(r.d).slice(0, 10)));
  const cut = new Date(Date.now() - 6 * 86400e3).toISOString().slice(0, 10);
  let stored = 0;
  const base = `latitude=${place.lat}&longitude=${place.lon}&daily=${DAILY}&timezone=auto`;
  for (const [a, b] of first <= cut ? missingRanges(have, first < '1940-01-01' ? '1940-01-01' : first, cut) : []) {
    onProgress?.(`Weather history ${a} → ${b}…`);
    const r = await fetch(`https://archive-api.open-meteo.com/v1/archive?${base}&start_date=${a}&end_date=${b}`);
    if (!r.ok) throw new Error(`Open-Meteo archive answered ${r.status}`);
    stored += await invoke<number>('weather_store', { rows: parseDaily(await r.json(), 'observed') });
  }
  const [last] = await query(`SELECT MAX(fetched_at) > now() - INTERVAL 3 HOUR AS fresh FROM weather_daily WHERE kind = 'forecast'`);
  if (!last?.fresh) {
    onProgress?.('Weather forecast…');
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${base}&past_days=7&forecast_days=7`);
    if (!r.ok) throw new Error(`Open-Meteo forecast answered ${r.status}`);
    stored += await invoke<number>('weather_store', { rows: parseDaily(await r.json(), 'forecast', today) });
  }
  return stored;
}
