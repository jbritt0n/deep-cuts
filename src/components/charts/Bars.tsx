import { memo } from 'react';
import { C } from '@/lib/theme';
/** Small vertical histogram / bar chart with labelled buckets. */
function HistogramImpl({ data, color = C.amber, highlight }: { data: { label: string; value: number }[]; color?: string; highlight?: (i: number) => boolean }) {
  const w = 520, h = 150, pad = 6, bottom = 18;
  const max = Math.max(...data.map((d) => d.value), 1);
  const bw = (w - pad * 2) / data.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Distribution">
      {data.map((d, i) => {
        const bh = ((h - bottom - pad) * d.value) / max;
        return (
          <g key={d.label}>
            <rect x={pad + i * bw + 3} y={h - bottom - bh} width={bw - 6} height={bh} rx={4} fill={color} fillOpacity={highlight?.(i) ? 1 : 0.55}>
              <title>{`${d.label}: ${d.value.toLocaleString()}`}</title>
            </rect>
            <text x={pad + i * bw + bw / 2} y={h - 4} textAnchor="middle" fontSize={9} fill={C.dust} fontFamily="var(--font-mono)">{d.label}</text>
            {d.value > 0 && <text x={pad + i * bw + bw / 2} y={h - bottom - bh - 4} textAnchor="middle" fontSize={9} fill={C.cream} fontFamily="var(--font-mono)">{d.value.toLocaleString()}</text>}
          </g>
        );
      })}
    </svg>
  );
}

/** Horizontal labelled bars for rate comparisons (skip rate by platform etc.). */
function RateBarsImpl({ data, format, color = C.coral }: { data: { label: string; value: number; note?: string }[]; format: (v: number) => string; color?: string }) {
  const max = Math.max(...data.map((d) => d.value), 0.0001);
  return (
    <ul className="space-y-2">
      {data.map((d) => (
        <li key={d.label} className="flex items-center gap-3 text-sm">
          <span className="w-32 shrink-0 truncate" title={d.label}>{d.label}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full" style={{ width: `${(d.value / max) * 100}%`, background: color }} /></div>
          <span className="num w-28 shrink-0 text-right text-xs text-dust">{format(d.value)}{d.note ? <span className="text-dust/60"> · {d.note}</span> : null}</span>
        </li>
      ))}
    </ul>
  );
}

/** Stacked 100% bars per year (shapes mix, attention mix). */
function StackedYearsImpl({ rows, keys, colors, labels }: { rows: { year: number; values: Record<string, number> }[]; keys: string[]; colors: Record<string, string>; labels: Record<string, string> }) {
  const w = 560, h = 170, pad = 6, bottom = 18, legend = 0;
  const bw = (w - pad * 2) / Math.max(rows.length, 1);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h + legend}`} className="w-full" role="img" aria-label="Mix by year">
        {rows.map((r, i) => {
          const total = keys.reduce((s, k) => s + (r.values[k] ?? 0), 0) || 1;
          let y = h - bottom;
          return (
            <g key={r.year}>
              {keys.map((k) => {
                const v = r.values[k] ?? 0; const bh = ((h - bottom - pad) * v) / total; y -= bh;
                return v > 0 ? <rect key={k} x={pad + i * bw + 3} y={y} width={bw - 6} height={bh} fill={colors[k] ?? C.dust} fillOpacity={0.9}><title>{`${r.year} · ${labels[k] ?? k}: ${Math.round((v / total) * 100)}% (${v.toLocaleString()})`}</title></rect> : null;
              })}
              <text x={pad + i * bw + bw / 2} y={h - 4} textAnchor="middle" fontSize={9} fill={C.dust} fontFamily="var(--font-mono)">{r.year}</text>
            </g>
          );
        })}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dust">
        {keys.map((k) => <li key={k} className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: colors[k] }} />{labels[k] ?? k}</li>)}
      </ul>
    </div>
  );
}

/** Line of values per year with a light band; used for completion / skip / median trends. */
function YearLinesImpl({ rows, series }: { rows: { year: number }[]; series: { key: string; label: string; color: string; values: number[]; format: (v: number) => string }[] }) {
  const w = 560, h = 150, pad = 10, bottom = 18;
  const n = rows.length;
  const x = (i: number) => pad + (n > 1 ? (i / (n - 1)) * (w - pad * 2) : w / 2);
  return (
    <div>
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full" role="img" aria-label="Trends by year">
        {series.map((s) => {
          const max = Math.max(...s.values, 0.0001);
          const y = (v: number) => h - bottom - (v / max) * (h - bottom - pad - 10);
          const d = s.values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)}`).join(' ');
          return (
            <g key={s.key}>
              <path d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" />
              {s.values.map((v, i) => <circle key={i} cx={x(i)} cy={y(v)} r={3} fill={s.color}><title>{`${rows[i].year} · ${s.label}: ${s.format(v)}`}</title></circle>)}
            </g>
          );
        })}
        {rows.map((r, i) => <text key={r.year} x={x(i)} y={h - 4} textAnchor="middle" fontSize={9} fill={C.dust} fontFamily="var(--font-mono)">{r.year}</text>)}
      </svg>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-dust">
        {series.map((s) => <li key={s.key} className="flex items-center gap-1.5"><span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{s.label}</li>)}
      </ul>
    </div>
  );
}

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const Histogram = memo(HistogramImpl);

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const RateBars = memo(RateBarsImpl);

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const StackedYears = memo(StackedYearsImpl);

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const YearLines = memo(YearLinesImpl);
