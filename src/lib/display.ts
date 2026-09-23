/**
 * Phase 9h — fit the screen (owner: "Eras needs scrolling and Library › Playlists is too large on my Toshiba").
 * Tailwind sizes type, spacing and cards in rem, so the whole UI scales with the root font size. `auto` picks it
 * from the window's CSS size — a 1366×768 laptop under a Linux panel (≈ 1366×690) lands on 13 px, a 1080p
 * monitor on 15, a large display on 16 — and follows window resizes. Owners can pin a size in Settings → Appearance.
 * Fixed-pixel SVG charts read `useViewport()` so they shrink with the window as well.
 */
import { useEffect, useState } from 'react';

export type Density = 'auto' | 'compact' | 'cozy' | 'comfortable' | 'large';
export const DENSITIES: { id: Density; label: string; px: number | null; blurb: string }[] = [
  { id: 'auto', label: 'Auto', px: null, blurb: 'Follows the window size.' },
  { id: 'compact', label: 'Compact', px: 13, blurb: 'Small laptops, 1366×768.' },
  { id: 'cozy', label: 'Cozy', px: 14.5, blurb: 'Most laptops.' },
  { id: 'comfortable', label: 'Comfortable', px: 16, blurb: 'The original size.' },
  { id: 'large', label: 'Large', px: 18, blurb: 'Big screens, viewed from further away.' },
];
const KEY = 'deepcuts.density';

/** Root font size for a window of w × h CSS pixels: the smaller of the width- and height-driven sizes. */
export function autoPx(w: number, h: number): number {
  const byH = h <= 700 ? 13 : h <= 800 ? 14 : h <= 900 ? 15 : 16;
  const byW = w <= 1280 ? 13 : w <= 1440 ? 14 : w <= 1680 ? 15 : 16;
  return Math.min(byH, byW);
}

export function loadDensity(): Density { try { const v = localStorage.getItem(KEY) as Density | null; return v && DENSITIES.some((d) => d.id === v) ? v : 'auto'; } catch { return 'auto'; } }
export function saveDensity(d: Density) { try { localStorage.setItem(KEY, d); } catch { /* ignore */ } applyDensity(d); window.dispatchEvent(new Event('deepcuts:density')); }

export function rootPx(d: Density = loadDensity()): number {
  const fixed = DENSITIES.find((x) => x.id === d)?.px;
  return fixed ?? autoPx(window.innerWidth, window.innerHeight);
}
export function applyDensity(d: Density = loadDensity()) {
  const px = rootPx(d);
  document.documentElement.style.fontSize = `${px}px`;
  document.documentElement.dataset.density = px <= 13.5 ? 'compact' : px <= 15 ? 'cozy' : 'comfortable';
}

let installed = false;
/** Call once at start-up: applies the density and re-applies on resize (debounced) while in auto. */
export function installDensity() {
  applyDensity();
  if (installed) return; installed = true;
  let t: number | undefined;
  window.addEventListener('resize', () => { window.clearTimeout(t); t = window.setTimeout(() => { if (loadDensity() === 'auto') applyDensity('auto'); }, 120); });
}

/** Window size in CSS px, updated on resize — for SVG charts that are drawn in pixels. */
export function useViewport() {
  const [v, setV] = useState(() => ({ w: window.innerWidth, h: window.innerHeight, px: rootPx() }));
  useEffect(() => {
    let t: number | undefined;
    const on = () => { window.clearTimeout(t); t = window.setTimeout(() => setV({ w: window.innerWidth, h: window.innerHeight, px: rootPx() }), 120); };
    window.addEventListener('resize', on); window.addEventListener('deepcuts:density', on);
    return () => { window.removeEventListener('resize', on); window.removeEventListener('deepcuts:density', on); };
  }, []);
  return v;
}
export const clamp = (lo: number, v: number, hi: number) => Math.max(lo, Math.min(hi, v));
