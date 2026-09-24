import { describe, expect, it } from 'vitest';
import { keyDistance, meanCost, smoothOrder, tempoDistance } from '../harmonic';

describe('harmonic ordering (Phase 9j)', () => {
  it('scores Camelot moves the way DJs mix', () => {
    expect(keyDistance('8A', '8A')).toBe(0);
    expect(keyDistance('8A', '9A')).toBe(1);
    expect(keyDistance('8A', '8B')).toBe(1);        // relative major
    expect(keyDistance('12A', '1A')).toBe(1);       // the wheel wraps
    expect(keyDistance('8A', '2B')).toBeGreaterThan(5);
  });
  it('treats half/double time as close', () => { expect(tempoDistance(70, 140)).toBeLessThan(tempoDistance(120, 140)); });
  it('produces a smoother order than a scrambled one', () => {
    const t = [['1', '8A', 120, 0.5], ['2', '3B', 92, 0.2], ['3', '9A', 124, 0.6], ['4', '4B', 95, 0.3], ['5', '8B', 122, 0.55], ['6', '10A', 128, 0.8]] as const;
    const tracks = t.map(([trackId, camelot, bpm, energy]) => ({ trackId, camelot, bpm, energy }));
    const ordered = smoothOrder(tracks);
    expect(ordered.map((x) => x.trackId).sort()).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(meanCost(ordered)).toBeLessThan(meanCost(tracks));
    expect(ordered[0].trackId).toBe('2');           // starts calm
  });
});
