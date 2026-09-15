import { C } from './theme';
// Ported from v1 lib/format.ts; hrefs now target hash routes and entity ids.
export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US');
export const fmtHours = (h: number) => (h >= 100 ? fmtInt(h) : h.toFixed(1)) + ' h';
export const fmtMinutes = (m: number) => (m >= 60 ? `${(m / 60).toFixed(1)} h` : `${Math.round(m)} min`);
export const fmtPct = (r: number) => `${Math.round(r * 100)}%`;

export function fmtMs(ms: number) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** '2025-08-29 19:09:07' -> '7:09 PM' */
export function fmtTime(ts: string) {
  const m = ts.match(/(\d{2}):(\d{2})/);
  if (!m) return ts;
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** 'YYYY-MM-DD...' -> 'Fri, Aug 29, 2025' */
export function fmtDate(ts: string, opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) {
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return ts;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).toLocaleDateString('en-US', opts);
}

/**
 * Phase 9e: instants (activity log, last sync, imports) are stored as TIMESTAMPTZ and come out of DuckDB as UTC
 * text; show them in the record's time zone (Settings → Record), not UTC. Plays use local wall-clock TIMESTAMPs
 * already, so they don't go through this.
 */
let appTimezone: string | undefined;
export const setAppTimezone = (tz: string | null | undefined) => { appTimezone = tz || undefined; };
export function fmtStamp(ts: string | null | undefined, opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) {
  if (!ts) return '';
  let iso = String(ts).trim().replace(' ', 'T');
  if (!/[zZ]$|[+-]\d{2}(:?\d{2})?$/.test(iso)) iso += 'Z';           // no offset → it was UTC
  else if (/[+-]\d{2}$/.test(iso)) iso += ':00';                       // '+00' → '+00:00'
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(ts).slice(0, 16);
  try { return d.toLocaleString('en-US', { ...opts, timeZone: appTimezone }); } catch { return d.toLocaleString('en-US', opts); }
}

export const hourLabel = (h: number) => (h === 0 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`);

/** §6.2 shapes v2. */
export const SHAPE_LABELS: Record<string, { label: string; note: string; color: string }> = {
  album_ride:     { label: 'Album ride',     note: 'front to back, in order',            get color() { return C.amber; } },
  comfort_loop:   { label: 'Comfort loop',   note: 'the same song, again',                color: '#E4A5A0' },
  discovery_run:  { label: 'Discovery run',  note: 'mostly songs you had never played',   get color() { return C.moss; } },
  deep_dive:      { label: 'Deep dive',      note: 'one artist, no exits',                color: '#F2C27B' },
  binge:          { label: 'Binge',          note: '3+ hours, no regrets',                color: '#D98E2B' },
  warm_up:        { label: 'Warm-up',        note: 'skippy start, then it settled',       color: '#B9A6D6' },
  restless:       { label: 'Restless',       note: 'skip, skip, skip',                    get color() { return C.coral; } },
  autopilot:      { label: 'Autopilot',      note: 'long, varied, hands off the wheel',   get color() { return C.violet; } },
  shuffle_wander: { label: 'Shuffle wander', note: 'everywhere at once',                  color: '#6F8FB0' },
  steady:         { label: 'Steady',         note: 'plays on, life goes on',              get color() { return C.dust; } },
};

/** How each shape is decided (first match wins, top to bottom) — shown in the Sessions explainer. */
export const SHAPE_RULES: { shape: string; rule: string }[] = [
  { shape: 'album_ride', rule: '6 or more consecutive unskipped plays from the same album' },
  { shape: 'comfort_loop', rule: '3+ plays and either 25%+ are the same song straight again, or one song is 40%+ of the session' },
  { shape: 'discovery_run', rule: '6+ plays, at least half never played before, and you actually listened (skip rate under 60%)' },
  { shape: 'deep_dive', rule: '90+ minutes with one artist taking 60%+ of the plays' },
  { shape: 'binge', rule: '3 hours or longer' },
  { shape: 'warm_up', rule: '6+ plays; the first third has at least twice the skip rate of the rest, overall skip rate under 40%' },
  { shape: 'restless', rule: 'skip rate 40% or higher' },
  { shape: 'autopilot', rule: '60+ minutes, skip rate 10% or lower, artist variety (entropy) 3.0 bits or more — a playlist doing the driving' },
  { shape: 'shuffle_wander', rule: '8+ plays and artist entropy 2.5 bits or more' },
  { shape: 'steady', rule: 'everything else — plays on, life goes on' },
];

export const DAY_PART_LABELS: Record<string, string> = {
  morning: 'Morning', midday: 'Midday', evening: 'Evening', night: 'Night', late: 'Late night',
};

export const artistHref = (id: string) => `/artist/${encodeURIComponent(id)}`;
export const trackHref = (id: string) => `/track/${encodeURIComponent(id)}`;
export const albumHref = (id: string) => `/album/${encodeURIComponent(id)}`;
export const dayHref = (date: string) => `/day/${date.slice(0, 10)}`;
export const monthHref = (key: string) => `/month/${key.slice(0, 7)}`;
export const monthLabel = (key: string) => {
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};
