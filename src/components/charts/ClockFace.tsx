import { memo } from 'react';
import { C } from '@/lib/theme';
import type { HourSlice } from '@/lib/types';
// Ported untouched from v1 (spec §0) — the signature visual.

/**
 * The record: a 24-hour dial drawn as a vinyl side.
 * Midnight at the top. Each hour is a groove-arc whose reach from the
 * label ring toward the spindle encodes hours listened.
 */
function ClockFaceImpl({ data, size = 380 }: { data: HourSlice[]; size?: number }) {
  const c = size / 2;
  const outer = c - 34;
  const inner = 58; // spindle label area
  const max = Math.max(...data.map((d) => d.hours), 1);

  const polar = (angleDeg: number, r: number) => {
    const a = ((angleDeg - 90) * Math.PI) / 180;
    return [c + r * Math.cos(a), c + r * Math.sin(a)];
  };

  const wedge = (hour: number, value: number) => {
    const start = (hour / 24) * 360 + 1.5;
    const end = ((hour + 1) / 24) * 360 - 1.5;
    const r = inner + (outer - inner) * (value / max);
    const [x1, y1] = polar(start, inner);
    const [x2, y2] = polar(start, r);
    const [x3, y3] = polar(end, r);
    const [x4, y4] = polar(end, inner);
    const large = 0;
    return `M ${x1} ${y1} L ${x2} ${y2} A ${r} ${r} 0 ${large} 1 ${x3} ${y3} L ${x4} ${y4} A ${inner} ${inner} 0 ${large} 0 ${x1} ${y1} Z`;
  };

  const isNight = (h: number) => h >= 22 || h < 5;
  const peak = data.reduce((a, b) => (b.hours > a.hours ? b : a));

  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="w-full max-w-[420px]" role="img"
      aria-label={`24-hour listening dial. Peak hour: ${peak.hour}:00 with ${peak.hours} hours.`}>
      {/* vinyl grooves */}
      {[0.98, 0.9, 0.8, 0.68].map((f, i) => (
        <circle key={i} cx={c} cy={c} r={outer * f + 14} fill="none"
          stroke={C.cream} strokeOpacity={0.05} strokeWidth={1} />
      ))}
      <circle cx={c} cy={c} r={outer + 16} fill="none" stroke={C.line} strokeWidth={1} />

      {/* hour wedges */}
      {data.map((d) => (
        <path
          key={d.hour}
          d={wedge(d.hour, Math.max(d.hours, max * 0.02))}
          fill={d.hour === peak.hour ? C.amber : isNight(d.hour) ? '#5A4A7A' : C.violet}
          fillOpacity={d.hour === peak.hour ? 1 : 0.55 + 0.45 * (d.hours / max)}
        >
          <title>{`${String(d.hour).padStart(2, '0')}:00 — ${d.hours} h`}</title>
        </path>
      ))}

      {/* hour ticks + key labels */}
      {[0, 6, 12, 18].map((h) => {
        const [x, y] = polar((h / 24) * 360, outer + 26);
        return (
          <text key={h} x={x} y={y} textAnchor="middle" dominantBaseline="middle"
            className="fill-dust" fontSize={11} fontFamily="var(--font-mono)">
            {h === 0 ? '12 AM' : h === 12 ? '12 PM' : h < 12 ? `${h} AM` : `${h - 12} PM`}
          </text>
        );
      })}

      {/* spindle */}
      <circle cx={c} cy={c} r={inner - 10} fill={C.surface} stroke={C.line} />
      <circle cx={c} cy={c} r={3} fill={C.amber} />
      <text x={c} y={c - 14} textAnchor="middle" className="fill-dust" fontSize={10}
        fontFamily="var(--font-mono)" letterSpacing="0.15em">PEAK</text>
      <text x={c} y={c + 10} textAnchor="middle" className="fill-cream" fontSize={20}
        fontFamily="var(--font-display)">
        {peak.hour === 0 ? '12 AM' : peak.hour === 12 ? '12 PM'
          : peak.hour < 12 ? `${peak.hour} AM` : `${peak.hour - 12} PM`}
      </text>
    </svg>
  );
}

/** Phase 10c (Kimi T3): redraw only when its props change, not on every parent render. */
export const ClockFace = memo(ClockFaceImpl);
