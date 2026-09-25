import { describe, expect, it } from 'vitest';
import { layout } from '../forceLayout';

describe('force layout (Phase 10)', () => {
  const nodes = ['a', 'b', 'c', 'x', 'y', 'z'].map((id) => ({ id }));
  const edges = [{ a: 'a', b: 'b', w: 1 }, { a: 'b', b: 'c', w: 1 }, { a: 'a', b: 'c', w: 1 }, { a: 'x', b: 'y', w: 1 }, { a: 'y', b: 'z', w: 1 }, { a: 'x', b: 'z', w: 1 }];
  const d = (m: ReturnType<typeof layout>, p: string, q: string) => Math.hypot(m.get(p)!.x - m.get(q)!.x, m.get(p)!.y - m.get(q)!.y);
  it('keeps every node inside the canvas', () => { const m = layout(nodes, edges, { width: 400, height: 300 }); for (const n of m.values()) { expect(n.x).toBeGreaterThanOrEqual(20); expect(n.x).toBeLessThanOrEqual(380); expect(n.y).toBeLessThanOrEqual(280); } });
  it('pulls linked nodes together and pushes the two clusters apart', () => {
    const m = layout(nodes, edges, { width: 600, height: 400 });
    const within = (d(m, 'a', 'b') + d(m, 'b', 'c') + d(m, 'x', 'y') + d(m, 'y', 'z')) / 4;
    const across = (d(m, 'a', 'x') + d(m, 'b', 'y') + d(m, 'c', 'z')) / 3;
    expect(across).toBeGreaterThan(within * 1.5);
  });
  it('is deterministic for the same seed', () => { const a = layout(nodes, edges, { seed: 3 }), b = layout(nodes, edges, { seed: 3 }); expect(a.get('z')).toEqual(b.get('z')); });
});
