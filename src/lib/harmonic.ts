/**
 * Phase 9j — ordering tracks for flow with FreqBlog's key (Camelot) and tempo. Camelot codes: 1–12 + A (minor) / B (major).
 * Compatible moves (the DJ's "harmonic mixing" rules): same code, ±1 on the wheel with the same letter, or the same number
 * with the other letter (relative major/minor). Cost of a transition = key distance + tempo jump; a greedy walk from the
 * calmest track, then a 2-opt pass, gives a smooth order without trying every permutation.
 */
export type FlowTrack = { trackId: string; camelot: string | null; bpm: number | null; energy: number | null };

export function parseCamelot(c: string | null): { n: number; l: 'A' | 'B' } | null {
  const m = /^(\d{1,2})([AB])$/i.exec((c ?? '').trim());
  if (!m) return null; const n = Number(m[1]); if (n < 1 || n > 12) return null;
  return { n, l: m[2].toUpperCase() as 'A' | 'B' };
}
/** 0 = same key, 1 = a compatible neighbour, larger = a clash (steps round the wheel, +1 for a letter change). */
export function keyDistance(a: string | null, b: string | null): number {
  const x = parseCamelot(a), y = parseCamelot(b);
  if (!x || !y) return 1.5;   // unknown key: neutral
  const d = Math.min(Math.abs(x.n - y.n), 12 - Math.abs(x.n - y.n));
  if (d === 0) return x.l === y.l ? 0 : 1;
  return d + (x.l === y.l ? 0 : 1) - (d === 1 && x.l === y.l ? 0 : 0);
}
/** Tempo jump in "steps", treating half/double time as close (a 70 → 140 bpm change reads as smooth). */
export function tempoDistance(a: number | null, b: number | null): number {
  if (!a || !b) return 1;
  const r = Math.max(a, b) / Math.min(a, b);
  const nearest = Math.min(Math.abs(Math.log2(r)), Math.abs(Math.log2(r / 2)) + 0.15);
  return nearest * 12;   // ≈ 1 per 6 % tempo change
}
export const transitionCost = (a: FlowTrack, b: FlowTrack) => keyDistance(a.camelot, b.camelot) * 1.2 + tempoDistance(a.bpm, b.bpm) + Math.abs((a.energy ?? 0.5) - (b.energy ?? 0.5)) * 2;

export function smoothOrder<T extends FlowTrack>(tracks: T[]): T[] {
  if (tracks.length < 3) return [...tracks];
  const left = [...tracks];
  // start calm: lowest energy, then slowest
  left.sort((a, b) => (a.energy ?? 0.5) - (b.energy ?? 0.5) || (a.bpm ?? 120) - (b.bpm ?? 120));
  const out: T[] = [left.shift()!];
  while (left.length) {
    const cur = out[out.length - 1]; let bi = 0, bc = Infinity;
    left.forEach((t, i) => { const c = transitionCost(cur, t); if (c < bc) { bc = c; bi = i; } });
    out.push(left.splice(bi, 1)[0]);
  }
  // 2-opt: reverse any segment that lowers the total
  const cost = (xs: T[]) => xs.slice(1).reduce((s, t, i) => s + transitionCost(xs[i], t), 0);
  let best = cost(out), improved = true, guard = 0;
  while (improved && guard++ < 40) {
    improved = false;
    for (let i = 1; i < out.length - 2; i++) for (let j = i + 1; j < out.length - 1; j++) {
      const cand = [...out.slice(0, i), ...out.slice(i, j + 1).reverse(), ...out.slice(j + 1)];
      const c = cost(cand); if (c + 1e-9 < best) { out.splice(0, out.length, ...cand); best = c; improved = true; }
    }
  }
  return out;
}
/** Mean transition cost — for "smoother by N %" messages. */
export const meanCost = (xs: FlowTrack[]) => (xs.length < 2 ? 0 : xs.slice(1).reduce((s, t, i) => s + transitionCost(xs[i], t), 0) / (xs.length - 1));
