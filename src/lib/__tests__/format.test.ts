import { describe, expect, it } from 'vitest';
import { fmtDate, fmtHours, fmtInt, fmtMinutes, fmtMs, fmtPct, fmtTime, hourLabel, monthLabel, SHAPE_LABELS, SHAPE_RULES } from '../format';

describe('format', () => {
  it('formats integers, hours, minutes, percentages', () => {
    expect(fmtInt(12345.6)).toBe('12,346');
    expect(fmtHours(3.14159)).toBe('3.1 h');
    expect(fmtHours(250)).toBe('250 h');
    expect(fmtMinutes(45)).toBe('45 min');
    expect(fmtMinutes(90)).toBe('1.5 h');
    expect(fmtPct(0.4567)).toBe('46%');
  });
  it('formats durations mm:ss', () => {
    expect(fmtMs(0)).toBe('0:00');
    expect(fmtMs(65_000)).toBe('1:05');
    expect(fmtMs(3_599_499)).toBe('59:59');
  });
  it('formats wall-clock times from record timestamps', () => {
    expect(fmtTime('2025-08-29 19:09:07')).toBe('7:09 PM');
    expect(fmtTime('2025-08-29 00:05:00')).toBe('12:05 AM');
    expect(fmtTime('2025-08-29 12:00:00')).toBe('12:00 PM');
    expect(fmtTime('garbage')).toBe('garbage');
  });
  it('formats dates without timezone drift', () => {
    expect(fmtDate('2025-08-29 19:09:07')).toBe('Fri, Aug 29, 2025');
    expect(fmtDate('2024-02-29', { month: 'short', year: 'numeric' })).toBe('Feb 2024');
    expect(fmtDate('nope')).toBe('nope');
  });
  it('labels hours and months', () => {
    expect(hourLabel(0)).toBe('12 AM'); expect(hourLabel(12)).toBe('12 PM'); expect(hourLabel(13)).toBe('1 PM'); expect(hourLabel(9)).toBe('9 AM');
    expect(monthLabel('2024-03')).toBe('March 2024');
  });
  it('keeps shape labels and rules in sync', () => {
    expect(SHAPE_RULES.map((r) => r.shape).sort()).toEqual(Object.keys(SHAPE_LABELS).sort());
    for (const k of Object.keys(SHAPE_LABELS)) expect(SHAPE_LABELS[k].color).toMatch(/^#|^rgb/);
  });
});
