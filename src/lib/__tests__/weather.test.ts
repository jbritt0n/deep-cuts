import { describe, expect, it } from 'vitest';
import { bucketOf, missingRanges, parseDaily } from '../weather';

describe('weather (Phase 9k)', () => {
  it('maps WMO codes to moods', () => {
    expect([0, 2, 45, 61, 81, 73, 95, 53].map(bucketOf)).toEqual(['sunny', 'cloudy', 'fog', 'rain', 'rain', 'snow', 'storm', 'rain']);
    expect(bucketOf(null)).toBeNull();
  });
  it('parses an Open-Meteo daily block', () => {
    const j = { daily: { time: ['2026-09-20', '2026-09-21', '2026-09-22'], weather_code: [61, 0, null], temperature_2m_max: [14.2, 21, 18], temperature_2m_min: [9, 11, 10], precipitation_sum: [6.1, 0, 0], sunshine_duration: [3600, 36000, null] } };
    const r = parseDaily(j, 'forecast', '2026-09-21');
    expect(r).toHaveLength(3);
    expect(r[0]).toMatchObject({ date: '2026-09-20', bucket: 'rain', tmax: 14.2, sunshine: 1, kind: 'observed' });   // past_days → observed
    expect(r[1]).toMatchObject({ bucket: 'sunny', sunshine: 10, kind: 'forecast' });
    expect(r[2].code).toBeNull();
    expect(parseDaily({}, 'observed')).toEqual([]);
  });
  it('asks only for missing date ranges, chunked', () => {
    const have = new Set(['2026-01-03', '2026-01-04']);
    expect(missingRanges(have, '2026-01-01', '2026-01-06')).toEqual([['2026-01-01', '2026-01-02'], ['2026-01-05', '2026-01-06']]);
    expect(missingRanges(new Set(), '2026-01-01', '2026-01-10', 4)).toEqual([['2026-01-01', '2026-01-04'], ['2026-01-05', '2026-01-08'], ['2026-01-09', '2026-01-10']]);
    expect(missingRanges(new Set(['2026-01-01']), '2026-01-01', '2026-01-01')).toEqual([]);
  });
});
