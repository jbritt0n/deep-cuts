import { describe, expect, it } from 'vitest';
import { DEFAULT_FILTER, isFiltered, playsWhere, sessionsWhere, setActiveFilter } from '../filter';

describe('listening filter → SQL fragments', () => {
  it('produces nothing when the filter is open', () => {
    setActiveFilter({ attentiveOnly: false, fromYear: null, toYear: null });
    expect(playsWhere()).toBe(''); expect(sessionsWhere()).toBe('');
    expect(isFiltered({ attentiveOnly: false, fromYear: null, toYear: null })).toBe(false);
  });
  it('adds the attended flag with and without an alias', () => {
    setActiveFilter({ attentiveOnly: true, fromYear: null, toYear: null });
    expect(playsWhere()).toBe(' AND attended');
    expect(playsWhere('p')).toBe(' AND p.attended');
    expect(sessionsWhere('s')).toBe(" AND s.attention <> 'unattended'");
  });
  it('bounds years inclusively and always starts with AND', () => {
    setActiveFilter({ attentiveOnly: false, fromYear: 2021, toYear: 2023 });
    expect(playsWhere()).toBe(" AND played_at >= DATE '2021-01-01' AND played_at < DATE '2024-01-01'");
    expect(sessionsWhere()).toBe(" AND start_at >= DATE '2021-01-01' AND start_at < DATE '2024-01-01'");
    setActiveFilter({ attentiveOnly: true, fromYear: 2020, toYear: null });
    expect(playsWhere('x')).toBe(" AND x.attended AND x.played_at >= DATE '2020-01-01'");
  });
  it('default filter is attentive-only', () => {
    expect(DEFAULT_FILTER).toEqual({ attentiveOnly: true, fromYear: null, toYear: null });
    expect(isFiltered(DEFAULT_FILTER)).toBe(true);
  });
});
