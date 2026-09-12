/**
 * Phase 9b — the four knobs behind the weekly eras backbone (design brief §3.2 / §3.5).
 *
 * Defaults come from the benchmark against the owner's real history: at weekly grain the
 * median week-to-week cosine is ~0.07 (not ~0.3 as at monthly grain), so reusing the monthly
 * threshold would make every week its own era. 0.04 / 4 weeks / 0.5 h / 6 weeks is a matched
 * set — one listener's starting point, not a constant — which is why it's exposed in Settings.
 *
 * The bounds are where the benchmark grid produced clearly silly results (§3.5 table), so the
 * sliders can't be dragged into a broken state. Presets are validated bundles; the sliders
 * underneath are for going off-script.
 */
export type EraParams = { similarity: number; minWeeks: number; floorH: number; maxGapWeeks: number };

export const ERA_DEFAULTS: EraParams = { similarity: 0.04, minWeeks: 4, floorH: 0.5, maxGapWeeks: 6 };

export const ERA_BOUNDS: Record<keyof EraParams, { min: number; max: number; step: number; label: string; unit: string; why: string }> = {
  similarity:  { min: 0.02, max: 0.15, step: 0.005, label: 'Similarity threshold', unit: '',   why: 'Below 0.02 the whole record collapses into two or three blobs; above 0.15 nearly every week opens a new era.' },
  minWeeks:    { min: 3,    max: 10,   step: 1,     label: 'Shortest era',         unit: 'weeks', why: 'Under 3 a single noisy week survives as an "era"; over 10 short-but-real stretches get absorbed and the weekly grain stops adding texture.' },
  floorH:      { min: 0.25, max: 1.5,  step: 0.05,  label: 'Quiet-week floor',     unit: 'h',  why: 'Weeks with fewer hours than this are ignored so a stray play can\'t force a break. Above 1.5 h real-but-quiet weeks start being treated as silence.' },
  maxGapWeeks: { min: 3,    max: 10,   step: 1,     label: 'Silence that ends an era', unit: 'weeks', why: 'A gap longer than this always starts a new chapter. Narrower than 3 punishes a busy week; wider than 10 the rule never fires.' },
};

export type EraPreset = { id: string; name: string; blurb: string; params: EraParams };
export const ERA_PRESETS: EraPreset[] = [
  { id: 'textured', name: 'Textured',      blurb: 'More, shorter eras. Catches a one-off month.',       params: { similarity: 0.03, minWeeks: 3, floorH: 0.5, maxGapWeeks: 6 } },
  { id: 'balanced', name: 'Balanced',      blurb: 'The benchmarked default — 6–12 week stretches.',      params: { ...ERA_DEFAULTS } },
  { id: 'broad',    name: 'Broad strokes', blurb: 'Fewer, longer arcs. Closer to the old monthly feel.', params: { similarity: 0.08, minWeeks: 8, floorH: 0.5, maxGapWeeks: 6 } },
];

/** app_meta keys, one per knob — persisted through the generic get_settings / set_setting commands. */
export const ERA_KEYS: Record<keyof EraParams, string> = { similarity: 'era_similarity', minWeeks: 'era_min_weeks', floorH: 'era_floor_h', maxGapWeeks: 'era_max_gap_weeks' };

const clamp = (k: keyof EraParams, v: number) => { const b = ERA_BOUNDS[k]; if (!Number.isFinite(v)) return ERA_DEFAULTS[k]; return Math.min(b.max, Math.max(b.min, v)); };

/** Build params from stored settings rows; anything missing or out of range falls back to the default (and is clamped into the slider range). */
export function eraParamsFromSettings(rows: { key: string; value: string }[]): EraParams {
  const get = (k: keyof EraParams) => { const r = rows.find((x) => x.key === ERA_KEYS[k]); return r ? clamp(k, Number(r.value)) : ERA_DEFAULTS[k]; };
  return { similarity: get('similarity'), minWeeks: Math.round(get('minWeeks')), floorH: get('floorH'), maxGapWeeks: Math.round(get('maxGapWeeks')) };
}

export const clampEraParam = clamp;

/** Which preset (if any) a set of params matches exactly. */
export const matchingPreset = (p: EraParams) => ERA_PRESETS.find((x) => x.params.similarity === p.similarity && x.params.minWeeks === p.minWeeks && x.params.floorH === p.floorH && x.params.maxGapWeeks === p.maxGapWeeks) ?? null;

/** The values are floats; the SQL is built by interpolation, so make sure nothing but a number ever reaches it. */
export function sanitizeEraParams(p: Partial<EraParams> | undefined): EraParams {
  const base = { ...ERA_DEFAULTS, ...(p ?? {}) };
  return { similarity: clamp('similarity', Number(base.similarity)), minWeeks: Math.round(clamp('minWeeks', Number(base.minWeeks))), floorH: clamp('floorH', Number(base.floorH)), maxGapWeeks: Math.round(clamp('maxGapWeeks', Number(base.maxGapWeeks))) };
}
