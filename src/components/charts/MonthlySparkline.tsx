import { memo } from 'react';
import { C } from '@/lib/theme';
import { useNavigate } from 'react-router-dom';
import type { MonthPoint } from '@/lib/types';
import { monthHref } from '@/lib/format';

/** Area sparkline of hours per month; each point opens its month (v1, extended). */
function MonthlySparklineImpl({ data, color = C.amber, linkMonths = true }: { data: MonthPoint[]; color?: string; linkMonths?: boolean }) {
  const nav = useNavigate();
  if (data.length < 2) return null;
  const w = 560, h = 120, pad = 8;
  const max = Math.max(...data.map((d) => d.hours), 1);
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - (v / max) * (h - pad * 2 - 14);
  const line = data.map((d, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(d.hours)}`).join(' ');
  const area = `${line} L ${x(data.length - 1)} ${h - pad} L ${x(0)} ${h - pad} Z`;
  const id = `spark-${color.replace('#', '')}`;
  const step = data.length > 14 ? Math.ceil(data.length / 12) : 1;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label={`Hours per month, last ${data.length} months`}>
      <defs><linearGradient id={id} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={color} stopOpacity="0.3" /><stop offset="100%" stopColor={color} stopOpacity="0" /></linearGradient></defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
      {data.map((d, i) => (
        <g key={d.key} onClick={linkMonths ? () => nav(monthHref(d.key)) : undefined} className={linkMonths ? 'cursor-pointer' : ''}>
          <circle cx={x(i)} cy={y(d.hours)} r={2.5} fill={color}><title>{`${d.month}: ${d.hours} h`}</title></circle>
          <rect x={x(i) - 10} y={0} width={20} height={h} fill="transparent"><title>{`${d.month}: ${d.hours} h`}</title></rect>
          {i % step === 0 && <text x={x(i)} y={h} textAnchor="middle" fontSize={9} fill={C.dust} fontFamily="var(--font-mono)">{d.month}</text>}
        </g>
      ))}
    </svg>
  );
}

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const MonthlySparkline = memo(MonthlySparklineImpl);
