import { memo } from 'react';
import { C } from '@/lib/theme';
import type { SessionShapeRow } from '@/lib/types';
import { SHAPE_LABELS } from '@/lib/format';

function SessionShapesImpl({ data, onPick }: { data: SessionShapeRow[]; onPick?: (shape: string) => void }) {
  const total = data.reduce((s, d) => s + d.count, 0) || 1;
  return (
    <ul className="space-y-2.5">
      {data.map((d) => {
        const meta = SHAPE_LABELS[d.shape] ?? { label: d.shape, note: '', color: C.dust };
        const pct = (d.count / total) * 100;
        return (
          <li key={d.shape} className="text-sm">
            <button onClick={onPick ? () => onPick(d.shape) : undefined} className={`flex w-full items-center gap-3 text-left ${onPick ? 'hover:text-amber' : 'cursor-default'}`}>
              <span className="w-32 shrink-0" title={meta.note}>{meta.label}</span>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full" style={{ width: `${pct}%`, background: meta.color }} /></div>
              <span className="num w-24 shrink-0 text-right text-xs text-dust">{pct.toFixed(0)}% · {d.count.toLocaleString()}</span>
            </button>
            {onPick && <p className="ml-0 mt-0.5 text-[11px] text-dust/70">{meta.note}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const SessionShapes = memo(SessionShapesImpl);
