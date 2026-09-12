import { describe, expect, it } from 'vitest';
import { addDays, findRuns, isoMonday } from '../threadQueries';

const wk = (start: string, shares: number[]) => shares.map((share, i) => ({ week: addDays(start, i * 7), hours: share * 10, share }));

describe('genre thread run detection (Phase 9b)', () => {
  it('finds a run at or above the floor of at least minWeeks', () => {
    const runs = findRuns(wk('2025-01-06', [0.02, 0.1, 0.12, 0.09, 0.01, 0.2, 0.3]), 0.08, 3);
    expect(runs.map((r) => [r[0].week, r.length])).toEqual([['2025-01-13', 3]]);
  });
  it('drops runs shorter than minWeeks and breaks on a missing week', () => {
    const weeks = [...wk('2025-01-06', [0.2, 0.2]), ...wk('2025-01-27', [0.2, 0.2, 0.2])]; // gap: 01-20 missing
    expect(findRuns(weeks, 0.08, 3).map((r) => r[0].week)).toEqual(['2025-01-27']);
    expect(findRuns(weeks, 0.08, 4)).toEqual([]);
  });
  it('treats share exactly at the floor as in, and the boundary week below it as out', () => {
    expect(findRuns(wk('2025-01-06', [0.08, 0.08, 0.08, 0.0799]), 0.08, 3)[0].length).toBe(3);
  });
  it('isoMonday matches DATE_TRUNC(week) — Monday start', () => {
    expect(isoMonday('2026-09-12')).toBe('2026-09-07'); // a Saturday
    expect(isoMonday('2026-09-07')).toBe('2026-09-07');
    expect(isoMonday('2026-09-13')).toBe('2026-09-07'); // Sunday still belongs to Monday's week
  });
});
