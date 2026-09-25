/**
 * Phase 10 — a small deterministic force-directed layout (Fruchterman–Reingold) for the Connections graphs.
 * Seeded, so the same record gives the same picture every time; no dependencies; ~200 nodes is comfortable.
 */
export type LNode = { id: string; weight?: number };
export type LEdge = { a: string; b: string; w: number };
export type Placed = { id: string; x: number; y: number };

export function layout(nodes: LNode[], edges: LEdge[], opts: { width?: number; height?: number; iterations?: number; seed?: number } = {}): Map<string, Placed> {
  const W = opts.width ?? 1000, H = opts.height ?? 700, N = nodes.length, iters = opts.iterations ?? 300;
  let s = opts.seed ?? 7; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const pos = nodes.map((n, i) => { const a = (i / Math.max(1, N)) * Math.PI * 2; return { id: n.id, x: W / 2 + Math.cos(a) * W * 0.3 + (rnd() - 0.5) * 20, y: H / 2 + Math.sin(a) * H * 0.3 + (rnd() - 0.5) * 20 }; });
  const idx = new Map(pos.map((p, i) => [p.id, i]));
  const k = Math.sqrt((W * H) / Math.max(1, N)) * 0.75;
  const E = edges.map((e) => ({ i: idx.get(e.a)!, j: idx.get(e.b)!, w: e.w })).filter((e) => e.i != null && e.j != null && e.i !== e.j);
  let t = W / 10;
  for (let it = 0; it < iters; it++) {
    const dx = new Float64Array(N), dy = new Float64Array(N);
    for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
      let x = pos[i].x - pos[j].x, y = pos[i].y - pos[j].y; let d2 = x * x + y * y;
      if (d2 < 0.01) { x = rnd() - 0.5; y = rnd() - 0.5; d2 = 0.01; }
      const f = (k * k) / d2;                       // repulsion ∝ k²/d, applied along (x, y)/d
      dx[i] += x * f; dy[i] += y * f; dx[j] -= x * f; dy[j] -= y * f;
    }
    for (const e of E) {
      const x = pos[e.i].x - pos[e.j].x, y = pos[e.i].y - pos[e.j].y; const d = Math.sqrt(x * x + y * y) || 0.01;
      const f = (d * d) / k * (0.5 + e.w) / d;     // attraction ∝ d²/k, stronger for heavier links
      dx[e.i] -= x * f; dy[e.i] -= y * f; dx[e.j] += x * f; dy[e.j] += y * f;
    }
    for (let i = 0; i < N; i++) {
      // gentle pull to the centre keeps disconnected nodes on screen
      dx[i] += (W / 2 - pos[i].x) * 0.01; dy[i] += (H / 2 - pos[i].y) * 0.01;
      const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 1; const m = Math.min(d, t);
      pos[i].x = Math.min(W - 20, Math.max(20, pos[i].x + (dx[i] / d) * m));
      pos[i].y = Math.min(H - 20, Math.max(20, pos[i].y + (dy[i] / d) * m));
    }
    t = Math.max(0.5, t * 0.985);
  }
  return new Map(pos.map((p) => [p.id, p]));
}
