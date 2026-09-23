import { describe, expect, it } from 'vitest';
import { autoPx } from '../display';

describe('autoPx (Phase 9h display size)', () => {
  it('shrinks a 1366×768 laptop under a Linux panel to compact', () => expect(autoPx(1366, 690)).toBe(13));
  it('keeps full size on a large display', () => expect(autoPx(2560, 1300)).toBe(16));
  it('takes the tighter of width and height', () => { expect(autoPx(1920, 760)).toBe(14); expect(autoPx(1280, 1100)).toBe(13); });
  it('lands a 1080p monitor in between', () => expect(autoPx(1920, 960)).toBe(16));
});
