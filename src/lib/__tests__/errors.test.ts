import { describe, expect, it } from 'vitest';
import { classify, describeError, toDeepCutsError } from '../errors';

describe('error envelope (Phase 10b, Kimi T2)', () => {
  it('reads the Rust envelope', () => {
    const e = toDeepCutsError('{"code":"quota","message":"Spotify returned 429"}');
    expect(e.code).toBe('quota'); expect(e.message).toBe('[quota] Spotify returned 429');
  });
  it('classifies plain strings the same way Rust does', () => {
    expect(classify('FreqBlog rejected the key')).toBe('auth');
    expect(classify('Out of Range Error: cannot take logarithm of zero')).toBe('database');
    expect(classify('Binder Error: Referenced column "x" not found in FROM clause!')).toBe('database');
    expect(classify('An import is already running')).toBe('busy');
    expect(classify('Country must be a two-letter code (US, GB, TR…)')).toBe('invalid_input');
    expect(classify('error sending request: connection refused')).toBe('network');
  });
  it('survives String(e) and e.message round trips', () => {
    const e = toDeepCutsError(new Error('Binder Error: Ambiguous reference'));
    const again = describeError(String(e));
    expect(again.code).toBe('database'); expect(again.detail).toBe('Binder Error: Ambiguous reference');
  });
  it('keeps the owner-facing text for validation errors', () => {
    expect(describeError('[invalid_input] Use a year (1972) or a date (1972-03-01)').hint).toBe('Use a year (1972) or a date (1972-03-01)');
  });
});
