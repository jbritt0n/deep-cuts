import { memo } from 'react';
import { C } from '@/lib/theme';
import { hourLabel } from '@/lib/format';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** SES-12: weekday × hour grid. Monday first, amber scale. */
function WeekHourHeatmapImpl({ data, metric = 'sessions' }: { data: { dow: number; hour: number; sessions: number; minutes: number }[]; metric?: 'sessions' | 'minutes' }) {
  const cell = 22, gap = 3, left = 34, top = 16;
  const order = [1, 2, 3, 4, 5, 6, 0];
  const v = (d: { sessions: number; minutes: number }) => (metric === 'sessions' ? d.sessions : d.minutes);
  const max = Math.max(...data.map(v), 1);
  const lookup = new Map(data.map((d) => [`${d.dow}-${d.hour}`, d]));
  const w = left + 24 * (cell + gap), h = top + 7 * (cell + gap);
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`Session starts by weekday and hour (${metric})`}>
      {[0, 6, 12, 18, 23].map((hh) => <text key={hh} x={left + hh * (cell + gap) + cell / 2} y={10} textAnchor="middle" fontSize={9} fill={C.dust} fontFamily="var(--font-mono)">{hourLabel(hh)}</text>)}
      {order.map((dow, r) => (
        <g key={dow}>
          <text x={0} y={top + r * (cell + gap) + cell / 2 + 3} fontSize={10} fill={C.dust} fontFamily="var(--font-mono)">{DAYS[dow]}</text>
          {Array.from({ length: 24 }, (_, hh) => {
            const d = lookup.get(`${dow}-${hh}`);
            const val = d ? v(d) : 0;
            const t = Math.pow(val / max, 0.6);
            return (
              <rect key={hh} x={left + hh * (cell + gap)} y={top + r * (cell + gap)} width={cell} height={cell} rx={4}
                fill={val ? C.amber : C.surface} fillOpacity={val ? 0.15 + 0.85 * t : 1}>
                <title>{`${DAYS[dow]} ${hourLabel(hh)} — ${d?.sessions ?? 0} sessions · ${Math.round(d?.minutes ?? 0)} min`}</title>
              </rect>
            );
          })}
        </g>
      ))}
    </svg>
  );
}

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const WeekHourHeatmap = memo(WeekHourHeatmapImpl);
