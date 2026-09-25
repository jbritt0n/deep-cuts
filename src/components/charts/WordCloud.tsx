import { useMemo, useState, memo } from 'react';
import { C } from '@/lib/theme';

/**
 * Phase 9e — a word cloud without a library: words sorted by weight, sized by sqrt(weight), placed along an
 * Archimedean spiral from the centre with rectangle collision. Deterministic (no randomness), so the same data
 * always draws the same cloud. Hover a word for its weight; click to hand it back to the page.
 */
export type CloudWord = { text: string; weight: number; note?: string };

function WordCloudImpl({ words, width = 640, height = 340, onPick, picked }: { words: CloudWord[]; width?: number; height?: number; onPick?: (w: CloudWord) => void; picked?: string | null }) {
  const [hover, setHover] = useState<string | null>(null);
  const placed = useMemo(() => layout(words, width, height), [words, width, height]);
  if (!words.length) return <p className="text-sm text-dust">Nothing to cloud yet.</p>;
  const max = Math.max(...words.map((w) => w.weight), 1);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-auto w-full" role="img" aria-label="Word cloud">
      {placed.map((p) => {
        const t = p.weight / max;
        const color = t > 0.66 ? C.amber : t > 0.33 ? C.cream : C.dust;
        const active = hover === p.text || picked === p.text;
        return (
          <text key={p.text} x={p.x} y={p.y} fontSize={p.size} textAnchor="middle" dominantBaseline="middle" fill={active ? C.coral : color} opacity={hover && !active ? 0.35 : 1}
            className={`font-display ${onPick ? 'cursor-pointer' : ''}`} style={{ transition: 'opacity 150ms, fill 150ms' }} onMouseEnter={() => setHover(p.text)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.(p)}>
            <title>{`${p.text} — ${p.note ?? Math.round(p.weight)}`}</title>{p.text}
          </text>
        );
      })}
    </svg>
  );
}

type Placed = CloudWord & { x: number; y: number; size: number; w: number; h: number };
function layout(words: CloudWord[], W: number, H: number): Placed[] {
  const sorted = [...words].sort((a, b) => b.weight - a.weight).slice(0, 90);
  if (!sorted.length) return [];
  const max = Math.sqrt(sorted[0].weight), min = Math.sqrt(sorted[sorted.length - 1].weight);
  const size = (w: number) => { const t = max === min ? 1 : (Math.sqrt(w) - min) / (max - min); return 11 + t * 44; };
  const out: Placed[] = [];
  const cx = W / 2, cy = H / 2;
  for (const word of sorted) {
    const s = size(word.weight); const w = word.text.length * s * 0.58 + 6, h = s * 1.05;
    let placedOk = false;
    for (let i = 0; i < 4000 && !placedOk; i++) {
      const a = 0.35 * i, r = 2.2 * Math.sqrt(i) * 1.6;
      const x = cx + r * Math.cos(a) * (W / H), y = cy + r * Math.sin(a);
      if (x - w / 2 < 0 || x + w / 2 > W || y - h / 2 < 0 || y + h / 2 > H) continue;
      if (out.some((o) => Math.abs(o.x - x) < (o.w + w) / 2 && Math.abs(o.y - y) < (o.h + h) / 2)) continue;
      out.push({ ...word, x, y, size: s, w, h }); placedOk = true;
    }
  }
  return out;
}

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const WordCloud = memo(WordCloudImpl);
