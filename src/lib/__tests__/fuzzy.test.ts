import { describe, expect, it } from 'vitest';
import { fuzzyScore } from '../fuzzy';

describe('fuzzy (Phase 10c)', () => {
  it('matches in order and rejects otherwise', () => {
    expect(fuzzyScore('mf', 'Moods & Forecast')).not.toBeNull();
    expect(fuzzyScore('fm', 'Moods')).toBeNull();
  });
  it('prefers word starts and prefixes', () => {
    const items = ['Settings', 'Sessions', 'Services', 'Bubble & blind spots'];
    const best = (q: string) => items.map((t) => [t, fuzzyScore(q, t)] as const).filter((x) => x[1] != null).sort((a, b) => b[1]! - a[1]!)[0]?.[0];
    expect(best('sess')).toBe('Sessions');
    expect(best('bs')).toBe('Bubble & blind spots');
    expect(best('serv')).toBe('Services');
  });
});
