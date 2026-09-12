import { describe, expect, it } from 'vitest';
import { ERA_DEFAULTS, ERA_PRESETS, eraParamsFromSettings, matchingPreset, sanitizeEraParams } from '../eraParams';

describe('era params (Phase 9b)', () => {
  it('defaults are the benchmarked bundle and match the Balanced preset', () => {
    expect(ERA_DEFAULTS).toEqual({ similarity: 0.04, minWeeks: 4, floorH: 0.5, maxGapWeeks: 6 });
    expect(matchingPreset(ERA_DEFAULTS)?.id).toBe('balanced');
  });
  it('reads stored settings and falls back per key', () => {
    const p = eraParamsFromSettings([{ key: 'era_similarity', value: '0.06' }, { key: 'era_min_weeks', value: '5' }, { key: 'theme', value: 'ink' }]);
    expect(p).toEqual({ similarity: 0.06, minWeeks: 5, floorH: 0.5, maxGapWeeks: 6 });
  });
  it('clamps out-of-range and garbage values into the slider bounds', () => {
    expect(eraParamsFromSettings([{ key: 'era_similarity', value: '0.9' }]).similarity).toBe(0.15);
    expect(eraParamsFromSettings([{ key: 'era_min_weeks', value: 'lots' }]).minWeeks).toBe(4);
    expect(sanitizeEraParams({ similarity: -1, minWeeks: 99, floorH: 0, maxGapWeeks: 1 })).toEqual({ similarity: 0.02, minWeeks: 10, floorH: 0.25, maxGapWeeks: 3 });
  });
  it('every preset is inside the bounds and round-trips through matchingPreset', () => {
    for (const x of ERA_PRESETS) { expect(sanitizeEraParams(x.params)).toEqual(x.params); expect(matchingPreset(x.params)?.id).toBe(x.id); }
  });
});
