import { useEffect, useMemo, useRef, useState, memo } from 'react';
import { C } from '@/lib/theme';

/**
 * Phase 9e — a word cloud without a library: words sorted by weight, sized by sqrt(weight), placed along an
 * Archimedean spiral from the centre with rectangle collision. Deterministic (no randomness), so the same data
 * always draws the same cloud. Hover a word for its weight; click to hand it back to the page.
 *
 * Phase 10d (owner: "expand the word cloud, improve the look"): measures its container and lays out at the real pixel
 * size (no more scaled-down text on a wide screen), holds up to 180 words, a five-step colour ramp from the skin, a
 * finer spiral that packs tighter, per-word colour override (`tone`), and a soft fade-in so a new view doesn't jump.
 */
export type CloudWord = { text: string; weight: number; note?: string; tone?: string };

function WordCloudImpl({ words, width: fixedW, height = 340, onPick, picked, maxWords = 90, minFont = 11, maxFont = 56 }: {
  words: CloudWord[]; width?: number; height?: number; onPick?: (w: CloudWord) => void; picked?: string | null; maxWords?: number; minFont?: number; maxFont?: number;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [measured, setMeasured] = useState(fixedW ?? 640);
  useEffect(() => {
    if (fixedW || !box.current || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((es) => { const w = Math.round(es[0].contentRect.width); if (w > 0) setMeasured((p) => (Math.abs(p - w) > 24 ? w : p)); });
    ro.observe(box.current); return () => ro.disconnect();
  }, [fixedW]);
  const width = fixedW ?? measured;
  const [hover, setHover] = useState<string | null>(null);
  const placed = useMemo(() => layout(words, width, height, maxWords, minFont, maxFont), [words, width, height, maxWords, minFont, maxFont]);
  if (!words.length) return <p className="text-sm text-dust">Nothing to cloud yet.</p>;
  const max = Math.max(...words.map((w) => w.weight), 1);
  const ramp = [C.dust, C.dust, C.cream, C.moss, C.amber];
  return (
    <div ref={box} className="w-full">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={fixedW ? undefined : height} className="block" role="img" aria-label="Word cloud" key={words.length + ':' + (words[0]?.text ?? '')} style={{ animation: 'dcFade 420ms ease-out' }}>
        <style>{'@keyframes dcFade{from{opacity:0}to{opacity:1}}'}</style>
        {placed.map((p, i) => {
          const t = Math.sqrt(p.weight / max);
          // colour by rank, not by ratio: with near-equal weights a ratio ramp paints everything the top colour
          const r = i / Math.max(1, placed.length - 1);
          const color = p.tone ?? ramp[r < 0.06 ? 4 : r < 0.18 ? 3 : r < 0.42 ? 2 : r < 0.7 ? 1 : 0];
          const active = hover === p.text || picked === p.text;
          return (
            <text key={p.text} x={p.x} y={p.y} fontSize={p.size} textAnchor="middle" dominantBaseline="middle" fill={active ? C.coral : color} opacity={hover && !active ? 0.28 : 0.55 + t * 0.45}
              fontWeight={p.size > 30 ? 500 : 400} tabIndex={onPick ? 0 : undefined} role={onPick ? 'button' : undefined}
              className={`font-display ${onPick ? 'cursor-pointer outline-none' : ''}`} style={{ transition: 'opacity 150ms, fill 150ms' }}
              onMouseEnter={() => setHover(p.text)} onMouseLeave={() => setHover(null)} onFocus={() => setHover(p.text)} onBlur={() => setHover(null)}
              onClick={() => onPick?.(p)} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick?.(p); } }}>
              <title>{`${p.text} — ${p.note ?? Math.round(p.weight)}`}</title>{p.text}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

type Placed = CloudWord & { x: number; y: number; size: number; w: number; h: number };
function layout(words: CloudWord[], W: number, H: number, maxWords: number, minFont: number, maxFont: number): Placed[] {
  const sorted = [...words].sort((a, b) => b.weight - a.weight).slice(0, maxWords);
  if (!sorted.length) return [];
  const max = Math.sqrt(sorted[0].weight), min = Math.sqrt(sorted[sorted.length - 1].weight);
  const top = Math.min(maxFont, H / 5.5, W / Math.max(4, sorted[0].text.length * 0.62));
  const size = (w: number) => { const t = max === min ? 1 : (Math.sqrt(w) - min) / (max - min); return minFont + t * (top - minFont); };
  const out: Placed[] = [];
  const cx = W / 2, cy = H / 2, aspect = W / H;
  for (const word of sorted) {
    const s = size(word.weight); const w = word.text.length * s * 0.56 + 8, h = s * 1.02;
    for (let i = 0; i < 6000; i++) {
      const a = 0.22 * i, r = 1.4 * Math.sqrt(i) * 1.5;
      const x = cx + r * Math.cos(a) * aspect * 0.9, y = cy + r * Math.sin(a);
      if (x - w / 2 < 2 || x + w / 2 > W - 2 || y - h / 2 < 2 || y + h / 2 > H - 2) continue;
      if (out.some((o) => Math.abs(o.x - x) < (o.w + w) / 2 && Math.abs(o.y - y) < (o.h + h) / 2)) continue;
      out.push({ ...word, x, y, size: s, w, h }); break;
    }
  }
  return out;
}

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const WordCloud = memo(WordCloudImpl);
