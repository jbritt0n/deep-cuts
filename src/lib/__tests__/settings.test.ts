import { describe, expect, it } from 'vitest';
import { TUNING, intSetting, numSetting, primeSettings, setting, settingBool } from '../settings';

describe('settings cache (Phase 9c)', () => {
  it('falls back per key and ignores garbage', () => {
    primeSettings({ feedback_memory_days: '30', tag_floor: 'nope', lyrics_enabled: 'true' });
    expect(setting('feedback_memory_days', 90)).toBe(30);
    expect(setting('tag_floor', 0.2)).toBe(0.2);
    expect(settingBool('lyrics_enabled')).toBe(true);
    expect(settingBool('missing', true)).toBe(true);
  });
  it('clamps tunables into their slider bounds and integers stay integers', () => {
    primeSettings({ forgotten_days: '99999', feedback_memory_days: '2.6', tag_floor: '-1' });
    expect(intSetting('forgotten_days')).toBe(1460);
    expect(intSetting('feedback_memory_days')).toBe(14);
    expect(numSetting('tag_floor')).toBe(0.05);
    primeSettings({});
    expect(intSetting('feedback_memory_days')).toBe(90);
  });
  it('every tunable has a default inside its own bounds and a unique key', () => {
    const keys = new Set<string>();
    for (const t of TUNING) { expect(t.def).toBeGreaterThanOrEqual(t.min); expect(t.def).toBeLessThanOrEqual(t.max); expect(keys.has(t.key)).toBe(false); keys.add(t.key); }
  });
});
