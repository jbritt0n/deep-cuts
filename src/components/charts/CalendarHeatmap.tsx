import { C } from '@/lib/theme';
import { Link } from 'react-router-dom';
import type { DayCell } from '@/lib/types';
import { dayHref } from '@/lib/format';

const CELL = 11, GAP = 3;

/** GitHub-style year heatmap in the amber scale (v1). Each cell links to its day. */
export function CalendarHeatmap({ data }: { data: DayCell[] }) {
  if (!data.length) return null;
  const max = Math.max(...data.map((d) => d.minutes), 1);
  const first = new Date(data[0].day + 'T00:00:00Z');
  const startDow = first.getUTCDay();
  const weeks = Math.ceil((data.length + startDow) / 7);
  const width = weeks * (CELL + GAP), height = 7 * (CELL + GAP) + 16;
  const shade = (m: number) => (m <= 0 ? { fill: C.surface, opacity: 1 } : { fill: C.amber, opacity: 0.18 + 0.82 * Math.pow(m / max, 0.6) });
  const months: { x: number; label: string }[] = [];
  let lastMonth = -1;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Daily listening minutes over the past year. Click a day to open it.">
      {data.map((d, i) => {
        const idx = i + startDow, week = Math.floor(idx / 7), dow = idx % 7;
        const date = new Date(d.day + 'T00:00:00Z');
        if (date.getUTCMonth() !== lastMonth && date.getUTCDate() <= 7) { lastMonth = date.getUTCMonth(); months.push({ x: week * (CELL + GAP), label: date.toLocaleString('en', { month: 'short', timeZone: 'UTC' }) }); }
        const s = shade(d.minutes);
        const rect = (
          <rect x={week * (CELL + GAP)} y={dow * (CELL + GAP) + 14} width={CELL} height={CELL} rx={2.5} fill={s.fill} fillOpacity={s.opacity} className="hover:stroke-cream/70" strokeWidth={1}>
            <title>{`${d.day} — ${Math.round(d.minutes)} min · ${d.plays} plays`}</title>
          </rect>
        );
        return d.plays > 0 ? <Link key={d.day} to={dayHref(d.day)}>{rect}</Link> : <g key={d.day}>{rect}</g>;
      })}
      {months.map((m) => <text key={m.x} x={m.x} y={8} fontSize={9} fill={C.dust} fontFamily="var(--font-mono)">{m.label}</text>)}
    </svg>
  );
}
