import { describe, expect, it } from 'vitest';
import { fmtStamp, setAppTimezone } from '../format';

describe('fmtStamp (Phase 9e) — UTC instants shown in the record time zone', () => {
  it('treats offset-less DuckDB text as UTC and shifts to the app zone', () => {
    setAppTimezone('America/Detroit');
    expect(fmtStamp('2026-09-12 19:05:11', { hour: 'numeric', minute: '2-digit', hour12: false })).toBe('15:05');
    expect(fmtStamp('2026-09-12 19:05:11+00', { hour: 'numeric', minute: '2-digit', hour12: false })).toBe('15:05');
    expect(fmtStamp('2026-09-12T19:05:11Z', { hour: 'numeric', minute: '2-digit', hour12: false })).toBe('15:05');
  });
  it('returns empty for nothing and falls back on garbage', () => {
    expect(fmtStamp(null)).toBe('');
    expect(fmtStamp('not a time')).toBe('not a time');
  });
});
