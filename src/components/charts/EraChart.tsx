import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { C } from '@/lib/theme';
import type { Era, EraWeek } from '@/lib/insightQueries';
import type { GenreThread } from '@/lib/threadQueries';
import { addDays } from '@/lib/threadQueries';
import { fmtDate, fmtHours } from '@/lib/format';

/**
 * Phase 9b (design brief §3.4). Two readings of the same eras() + genreThreads() data:
 *   - "Areas": every era and thread drawn on its OWN zero baseline as a ~25 % alpha area, not stacked,
 *     so a thread rising underneath the backbone is visible as one shape crossing another.
 *   - "Lanes": each span as a labelled pill on its own row, positioned by week — exact boundaries,
 *     easier hover-to-isolate.
 * One SVG, week = one column, scrolls horizontally past the visible width. Hovering a span dims
 * everything else (opacity on the group; no re-layout). Both honour the listening lens because the
 * data does.
 */
export type EraView = 'areas' | 'lanes';
type Span = { key: string; kind: 'era' | 'thread'; label: string; sub: string; start: string; endExclusive: string; color: string; series: { week: string; hours: number }[]; hours: number };

const THREAD_COLORS = ['#7FC8A9', '#8A6FB0', '#E4655F', '#6F8FB0', '#F2C27B', '#B9A6D6', '#E4A5A0', '#5FD0A8', '#D98E2B', '#8FB8FF'];
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

export function EraChart({ weeks, eras, threads, view, onView, onPick }: { weeks: EraWeek[]; eras: Era[]; threads: GenreThread[]; view: EraView; onView: (v: EraView) => void; onPick?: (s: { kind: 'era' | 'thread'; key: string }) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const model = useMemo(() => build(weeks, eras, threads), [weeks, eras, threads]);
  if (!model) return <p className="text-sm text-dust">Nothing to chart yet.</p>;
  const { idx, spans, first, nWeeks, maxH } = model;
  const colW = 14, padL = 8, padR = 24;
  const width = padL + nWeeks * colW + padR;
  const x = (week: string) => padL + (idx.get(week) ?? weekIndex(first, week)) * colW;
  const dim = (k: string) => (hover && hover !== k ? 0.18 : 1);
  const eraSpans = spans.filter((s) => s.kind === 'era'), threadSpans = spans.filter((s) => s.kind === 'thread');
  const ticks = yearTicks(first, nWeeks);

  const Toggle = (
    <div className="flex items-center gap-1 text-xs" role="tablist" aria-label="Eras chart view">
      {(['areas', 'lanes'] as EraView[]).map((v) => <button key={v} role="tab" aria-selected={view === v} onClick={() => onView(v)} className={`rounded-full px-3 py-1 ${view === v ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{v === 'areas' ? 'Areas' : 'Lanes'}</button>)}
    </div>
  );

  if (view === 'areas') {
    const h = 340, top = 34, base = h - 30;
    const y = (v: number) => base - (v / maxH) * (base - top);
    const area = (s: Span) => {
      if (!s.series.length) return '';
      const pts = s.series.map((w) => `${x(w.week) + colW / 2},${y(w.hours)}`);
      const x0 = x(s.series[0].week) + colW / 2, x1 = x(s.series[s.series.length - 1].week) + colW / 2;
      return `M${x0},${base} L${pts.join(' L')} L${x1},${base} Z`;
    };
    const line = (s: Span) => s.series.map((w, i) => `${i ? 'L' : 'M'}${x(w.week) + colW / 2},${y(w.hours)}`).join(' ');
    return (
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">{Toggle}<Legend hover={hover} setHover={setHover} threads={threadSpans} /></div>
        <Scroller>
          <svg width={width} height={h} className="block" role="img" aria-label="Eras and genre threads, weekly hours">
            {ticks.map((t) => <g key={t.week}><line x1={x(t.week)} x2={x(t.week)} y1={top} y2={base} stroke={C.line} strokeDasharray="2 4" /><text x={x(t.week) + 4} y={h - 8} fontSize="12" fill={C.dust} className="num">{t.label}</text></g>)}
            <line x1={padL} x2={width - padR} y1={base} y2={base} stroke={C.line} />
            {eraSpans.map((s) => (
              <g key={s.key} opacity={dim(s.key)} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.({ kind: 'era', key: s.key })} className="cursor-pointer" style={{ transition: 'opacity 150ms' }}>
                <title>{`${s.label}\n${s.sub}`}</title>
                <path d={area(s)} fill={s.color} fillOpacity={0.25} />
                <path d={line(s)} fill="none" stroke={s.color} strokeWidth={1.2} />
              </g>
            ))}
            {threadSpans.map((s) => (
              <g key={s.key} opacity={dim(s.key)} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.({ kind: 'thread', key: s.key })} className="cursor-pointer" style={{ transition: 'opacity 150ms' }}>
                <title>{`${s.label}\n${s.sub}`}</title>
                <path d={area(s)} fill={s.color} fillOpacity={0.28} />
                <path d={line(s)} fill="none" stroke={s.color} strokeWidth={1.4} strokeDasharray="3 2" />
              </g>
            ))}
            {eraSpans.flatMap((s) => {
              // label at the era's start, repeated every ~50 weeks inside long eras so one is always in view while scrolling
              const n = weeksIn(s); const starts: number[] = []; for (let k = 0; k < n; k += 50) starts.push(k);
              return starts.map((k, j) => { const room = Math.min(n - k, 50) * colW; const lines = wrap(s.label, Math.max(6, Math.floor(room / 7))); const lx = x(s.start) + k * colW + 6; return (
                <text key={`l${s.key}-${k}`} x={lx} y={16} fontSize="12" fill={C.cream} opacity={dim(s.key) * (j ? 0.55 : 1)} className="pointer-events-none">
                  {lines.map((l, i) => <tspan key={i} x={lx} dy={i ? 14 : 0}>{l}</tspan>)}
                </text>
              ); });
            })}
          </svg>
        </Scroller>
        <p className="mt-1 text-[11px] text-dust/70">Solid: the artist backbone, one era after another. Dashed: genre threads, which may run underneath several eras at once. Each shape sits on its own baseline — nothing is stacked.</p>
      </div>
    );
  }

  // lanes
  const laneKeys = ['__eras', ...uniq(threadSpans.map((s) => s.label))];
  const laneH = 30, top = 6, h = top + laneKeys.length * laneH + 26;
  const laneY = (k: string) => top + laneKeys.indexOf(k) * laneH;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">{Toggle}<Legend hover={hover} setHover={setHover} threads={threadSpans} /></div>
      <div className="grid grid-cols-[110px_1fr]">
        <div className="text-xs text-dust" style={{ paddingTop: top }}>
          {laneKeys.map((k) => <div key={k} className="truncate pr-2 text-sm" style={{ height: laneH, lineHeight: `${laneH}px` }} title={k === '__eras' ? 'Artist eras' : k}>{k === '__eras' ? 'Eras' : k}</div>)}
        </div>
        <Scroller>
          <svg width={width} height={h} className="block" role="img" aria-label="Eras and genre threads as lanes">
            {ticks.map((t) => <g key={t.week}><line x1={x(t.week)} x2={x(t.week)} y1={top} y2={h - 20} stroke={C.line} strokeDasharray="2 4" /><text x={x(t.week) + 4} y={h - 6} fontSize="12" fill={C.dust} className="num">{t.label}</text></g>)}
            {spans.map((s) => {
              const lane = s.kind === 'era' ? '__eras' : s.label;
              const x0 = x(s.start), w = Math.max(colW, weeksIn(s) * colW - 2);
              return (
                <g key={s.key} opacity={dim(s.key)} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)} onClick={() => onPick?.({ kind: s.kind, key: s.key })} className="cursor-pointer" style={{ transition: 'opacity 150ms' }}>
                  <title>{`${s.label}\n${s.sub}`}</title>
                  <rect x={x0} y={laneY(lane) + 4} width={w} height={laneH - 8} rx={9} fill={s.color} fillOpacity={s.kind === 'era' ? 0.85 : 0.6} />
                  {w > 40 && <text x={x0 + 8} y={laneY(lane) + laneH / 2 + 4} fontSize="12" fill={C.ink} className="pointer-events-none">{truncate(s.kind === 'era' ? s.label : `${Math.round(s.hours)} h`, Math.floor(w / 7))}</text>}
                </g>
              );
            })}
          </svg>
        </Scroller>
      </div>
    </div>
  );
}

/** Horizontal scroller that opens at the right-hand end, so the present is in view first. */
function Scroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollLeft = el.scrollWidth; }, [children]);
  return <div ref={ref} className="overflow-x-auto">{children}</div>;
}

function Legend({ threads, hover, setHover }: { threads: Span[]; hover: string | null; setHover: (k: string | null) => void }) {
  const tags = uniq(threads.map((t) => t.label));
  if (!tags.length) return <p className="text-[11px] text-dust/70">No genre threads yet — they need Last.fm or MusicBrainz tags.</p>;
  return (
    <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-dust">
      {tags.map((t) => { const s = threads.find((x) => x.label === t)!; const active = hover === null || threads.some((x) => x.key === hover && x.label === t); return <li key={t} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)} className="flex items-center gap-1.5" style={{ opacity: active ? 1 : 0.4 }}><span className="inline-block h-2 w-2 rounded-full" style={{ background: s.color }} />{t}</li>; })}
    </ul>
  );
}

function build(weeks: EraWeek[], eras: Era[], threads: GenreThread[]) {
  if (!weeks.length && !eras.length) return null;
  const allStarts = [...weeks.map((w) => w.week), ...eras.map((e) => e.start), ...threads.map((t) => t.start)];
  const allEnds = [...weeks.map((w) => w.week), ...eras.map((e) => e.end), ...threads.map((t) => t.end)];
  const first = allStarts.sort()[0], last = allEnds.sort().at(-1)!;
  const nWeeks = weekIndex(first, last) + 1;
  const idx = new Map<string, number>(); for (let i = 0; i < nWeeks; i++) idx.set(addDays(first, i * 7), i);
  const hoursByWeek = new Map(weeks.map((w) => [w.week, w.hours]));
  const spans: Span[] = [];
  eras.forEach((e, i) => {
    const series: { week: string; hours: number }[] = [];
    for (let w = e.start; w < e.endExclusive; w = addDays(w, 7)) series.push({ week: w, hours: hoursByWeek.get(w) ?? 0 });
    spans.push({ key: `era:${e.start}`, kind: 'era', label: e.name, sub: `${fmtDate(e.start, { month: 'short', day: 'numeric', year: 'numeric' })} → ${fmtDate(e.end, { month: 'short', day: 'numeric', year: 'numeric' })} · ${e.weeks} weeks · ${fmtHours(e.hours)}\n${e.topArtists.map((a) => a.artist).join(', ')}`, start: e.start, endExclusive: e.endExclusive, color: i % 2 ? '#D98E2B' : C.amber, series, hours: e.hours });
  });
  for (const t of threads) {
    spans.push({ key: `thread:${t.tag}:${t.start}`, kind: 'thread', label: t.label, sub: `${fmtDate(t.start, { month: 'short', day: 'numeric', year: 'numeric' })} → ${fmtDate(t.end, { month: 'short', day: 'numeric', year: 'numeric' })} · ${t.weeks} weeks · ${fmtHours(t.hours)} · peak ${Math.round(t.peakShare * 100)}% of the week\n${t.topArtists.map((a) => a.artist).join(', ')}`, start: t.start, endExclusive: t.endExclusive, color: THREAD_COLORS[hash(t.tag) % THREAD_COLORS.length], series: t.series.map((w) => ({ week: w.week, hours: w.hours })), hours: t.hours });
  }
  const maxH = Math.max(1, ...weeks.map((w) => w.hours), ...spans.flatMap((s) => s.series.map((w) => w.hours)));
  return { idx, spans, first, nWeeks, maxH };
}
const weekIndex = (first: string, week: string) => Math.round((Date.parse(week + 'T00:00:00Z') - Date.parse(first + 'T00:00:00Z')) / (7 * 86400e3));
const weeksIn = (s: Span) => Math.max(1, weekIndex(s.start, s.endExclusive));
const uniq = <T,>(xs: T[]) => [...new Set(xs)];
/** Wrap a label onto at most two lines of ~n characters; the second line is truncated. */
function wrap(s: string, n: number): string[] {
  if (s.length <= n) return [s];
  const words = s.split(' '); let first = '';
  for (const w of words) { if ((first + ' ' + w).trim().length > n) break; first = (first + ' ' + w).trim(); }
  if (!first) first = s.slice(0, n);
  const rest = s.slice(first.length).trim();
  return rest ? [first, truncate(rest, n)] : [first];
}
const truncate = (s: string, n: number) => (s.length <= n ? s : n <= 1 ? '' : s.slice(0, Math.max(0, n - 1)) + '…');
function yearTicks(first: string, n: number) {
  const out: { week: string; label: string }[] = [];
  let lastKey = '';
  for (let i = 0; i < n; i++) {
    const w = addDays(first, i * 7);
    const key = n > 130 ? w.slice(0, 4) : w.slice(0, 7);
    if (key !== lastKey) { lastKey = key; if (n > 130 ? w.slice(5, 7) === '01' || i === 0 : true) out.push({ week: w, label: n > 130 ? key : fmtDate(w, { month: 'short', year: n <= 60 ? undefined : '2-digit' }) }); }
  }
  // thin monthly ticks when many months
  return n > 60 && n <= 130 ? out.filter((_, i) => i % 3 === 0) : out;
}
