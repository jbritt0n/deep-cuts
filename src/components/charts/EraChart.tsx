import { clamp, useViewport } from '@/lib/display';
import { PALETTES, useEraStyle, type EraStyle } from '@/lib/eraStyle';
import { useAsync } from '@/lib/hooks';
import { rangeWeather } from '@/lib/weatherQueries';
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
type Span = { key: string; kind: 'era' | 'thread'; label: string; sub: string; start: string; endExclusive: string; color: string; series: { week: string; hours: number }[]; hours: number; era?: Era; thread?: GenreThread };

const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

export function EraChart({ weeks, eras, threads, view, onView, onPick }: { weeks: EraWeek[]; eras: Era[]; threads: GenreThread[]; view: EraView; onView: (v: EraView) => void; onPick?: (s: { kind: 'era' | 'thread'; key: string }) => void }) {
  const vp = useViewport();
  const [hover, setHover] = useState<string | null>(null);
  const st = useEraStyle();
  const [tip, setTip] = useState<{ key: string; x: number; y: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const model = useMemo(() => build(weeks, eras, threads, st), [weeks, eras, threads, st]);
  if (!model) return <p className="text-sm text-dust">Nothing to chart yet.</p>;
  const { idx, spans, first, nWeeks } = model;
  const colW = st.weekWidth, padL = 8, padR = 24;
  const width = padL + nWeeks * colW + padR;
  const x = (week: string) => padL + (idx.get(week) ?? weekIndex(first, week)) * colW;
  const dim = (k: string) => (hover && hover !== k ? 0.22 : 1);
  // hover card position is relative to the chart wrapper, so it stays put while the chart scrolls horizontally
  const onMove = (k: string) => (e: React.MouseEvent) => { const r = wrapRef.current?.getBoundingClientRect(); if (r) setTip({ key: k, x: e.clientX - r.left, y: e.clientY - r.top }); };
  const enter = (k: string) => (e: React.MouseEvent) => { setHover(k); onMove(k)(e); };
  const leave = () => { setHover(null); setTip(null); };
  const tipSpan = tip ? spans.find((x) => x.key === tip.key) : null;
  const Tip = tipSpan && tip ? <HoverCard span={tipSpan} x={tip.x} y={tip.y} wrapW={wrapRef.current?.clientWidth ?? 800} /> : null;
  const eraSpans = spans.filter((s) => s.kind === 'era'), threadSpans = spans.filter((s) => s.kind === 'thread');
  const ticks = yearTicks(first, nWeeks);

  const Toggle = (
    <div className="flex items-center gap-1 text-xs" role="tablist" aria-label="Eras chart view">
      {(['areas', 'lanes'] as EraView[]).map((v) => <button key={v} role="tab" aria-selected={view === v} onClick={() => onView(v)} className={`rounded-full px-3 py-1 ${view === v ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{v === 'areas' ? 'Areas' : 'Lanes'}</button>)}
    </div>
  );

  if (view === 'areas') {
    // Phase 9i: two bands — eras (the artist backbone) on top, genre threads underneath — instead of everything on one
    // baseline, so a thread never hides an era. A gap separates consecutive eras and the two bands (Settings → Appearance).
    const h = Math.round(clamp(260, vp.h * 0.5, 520) * st.height), top = 34, axis = 22;
    const bands = h - top - axis - st.bandGap;
    const eraH = threadSpans.length ? Math.round(bands * 0.58) : bands;
    const eraBase = top + eraH, thTop = eraBase + st.bandGap, thBase = h - axis;
    const maxEra = Math.max(1, ...eraSpans.flatMap((s) => s.series.map((w) => w.hours)));
    const maxTh = Math.max(1, ...threadSpans.flatMap((s) => s.series.map((w) => w.hours)));
    const yE = (v: number) => eraBase - (v / maxEra) * (eraH - 6);
    const yT = (v: number) => thBase - (v / maxTh) * (thBase - thTop - 4);
    const inset = (s: Span, i: number, last: number) => (s.kind === 'era' ? [i === 0 ? 0 : st.gap / 2, i === last ? 0 : st.gap / 2] : [0, 0]);
    const area = (s: Span, y: (v: number) => number, base: number, [l, r]: number[]) => {
      if (!s.series.length) return '';
      const pts = s.series.map((w, i) => { const px = x(w.week) + colW / 2; const cx = i === 0 ? Math.max(px, x(s.start) + l) : i === s.series.length - 1 ? Math.min(px, x(s.start) + weeksIn(s) * colW - r) : px; return `${cx},${y(w.hours)}`; });
      const x0 = x(s.start) + l, x1 = x(s.start) + weeksIn(s) * colW - r;
      return `M${x0},${base} L${x0},${y(s.series[0].hours)} L${pts.join(' L')} L${x1},${y(s.series[s.series.length - 1].hours)} L${x1},${base} Z`;
    };
    const fillOf = (s: Span) => (st.fill === 'gradient' ? `url(#g-${cssId(s.key)})` : s.color);
    const fillOp = (kind: Span['kind']) => ({ soft: kind === 'era' ? 0.3 : 0.32, solid: kind === 'era' ? 0.8 : 0.7, gradient: 1, outline: 0.08 }[st.fill]);
    const strokeW = st.fill === 'outline' ? 2 : 1.4;
    return (
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">{Toggle}<Legend hover={hover} setHover={setHover} threads={threadSpans} /></div>
        <div ref={wrapRef} className="relative">
          <Scroller resetKey={`${nWeeks}:${colW}`}>
            <svg width={width} height={h} className="block" role="img" aria-label="Eras above, genre threads below, weekly hours">
              <defs>{st.fill === 'gradient' && spans.map((s) => <linearGradient key={s.key} id={`g-${cssId(s.key)}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={s.color} stopOpacity={s.kind === 'era' ? 0.85 : 0.75} /><stop offset="100%" stopColor={s.color} stopOpacity={0.12} /></linearGradient>)}</defs>
              {ticks.map((t) => <g key={t.week}><line x1={x(t.week)} x2={x(t.week)} y1={top - 4} y2={thBase} stroke={C.line} strokeDasharray="2 4" /><text x={x(t.week) + 4} y={h - 6} fontSize="12" fill={C.dust} className="num">{t.label}</text></g>)}
              <text x={padL} y={top - 20} fontSize="10" fill={C.dust} letterSpacing="0.08em">ERAS</text>
              <line x1={padL} x2={width - padR} y1={eraBase} y2={eraBase} stroke={C.line} />
              {threadSpans.length > 0 && <><text x={padL} y={thTop + 10} fontSize="10" fill={C.dust} letterSpacing="0.08em">THREADS</text><line x1={padL} x2={width - padR} y1={thBase} y2={thBase} stroke={C.line} /></>}
              {eraSpans.map((s, i) => { const ins = inset(s, i, eraSpans.length - 1); return (
                <g key={s.key} opacity={dim(s.key)} onMouseEnter={enter(s.key)} onMouseMove={onMove(s.key)} onMouseLeave={leave} onClick={() => onPick?.({ kind: 'era', key: s.key })} className="cursor-pointer" style={{ transition: 'opacity 150ms' }}>
                  <path d={area(s, yE, eraBase, ins)} fill={fillOf(s)} fillOpacity={fillOp('era')} stroke={s.color} strokeWidth={hover === s.key ? strokeW + 1 : strokeW} strokeLinejoin="round" />
                </g>
              ); })}
              {threadSpans.map((s) => (
                <g key={s.key} opacity={dim(s.key)} onMouseEnter={enter(s.key)} onMouseMove={onMove(s.key)} onMouseLeave={leave} onClick={() => onPick?.({ kind: 'thread', key: s.key })} className="cursor-pointer" style={{ transition: 'opacity 150ms' }}>
                  <path d={area(s, yT, thBase, [0, 0])} fill={fillOf(s)} fillOpacity={fillOp('thread')} stroke={s.color} strokeWidth={hover === s.key ? strokeW + 0.8 : strokeW - 0.2} strokeDasharray={st.fill === 'outline' ? undefined : '4 2'} strokeLinejoin="round" />
                </g>
              ))}
              {eraSpans.flatMap((s) => {
                // label at the era's start, repeated every ~50 weeks inside long eras so one is always in view while scrolling
                const n = weeksIn(s); if (st.labels === 'long' && n < 10) return [];
                const starts: number[] = []; for (let k = 0; k < n; k += 50) starts.push(k);
                return starts.map((k, j) => { const room = Math.min(n - k, 50) * colW - st.gap; if (room < 34) return null; const lines = wrap(s.label, Math.max(5, Math.floor(room / 7.2))); const lx = x(s.start) + k * colW + st.gap / 2 + 6; return (
                  <text key={`l${s.key}-${k}`} x={lx} y={top - 6 + (j ? 0 : 0)} fontSize="13" fontWeight={500} fill={C.cream} opacity={dim(s.key) * (j ? 0.6 : 1)} className="pointer-events-none" style={{ paintOrder: 'stroke', stroke: C.ink, strokeWidth: 3, strokeLinejoin: 'round' }}>
                    {lines.slice(0, 1).map((l, i) => <tspan key={i} x={lx}>{l}</tspan>)}
                  </text>
                ); });
              })}
            </svg>
          </Scroller>
          {Tip}
        </div>
        <p className="mt-1 text-[11px] text-dust/70">Top band: the artist backbone, one era after another. Bottom band: genre threads, which can run underneath several eras at once. Hover for the details, click to open. Gap, colours, fill and height: Settings → Appearance → Eras chart.</p>
      </div>
    );
  }

  // lanes
  const laneKeys = ['__eras', ...uniq(threadSpans.map((s) => s.label))];
  const laneH = Math.round(clamp(20, vp.h / 30, 30)), top = 6, h = top + laneKeys.length * laneH + 26;
  const laneY = (k: string) => top + laneKeys.indexOf(k) * laneH;
  return (
    <div>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">{Toggle}<Legend hover={hover} setHover={setHover} threads={threadSpans} /></div>
      <div ref={wrapRef} className="relative grid grid-cols-[110px_1fr]">
        <div className="text-xs text-dust" style={{ paddingTop: top }}>
          {laneKeys.map((k) => <div key={k} className="truncate pr-2 text-sm" style={{ height: laneH, lineHeight: `${laneH}px` }} title={k === '__eras' ? 'Artist eras' : k}>{k === '__eras' ? 'Eras' : k}</div>)}
        </div>
        <Scroller resetKey={`${nWeeks}:${colW}`}>
          <svg width={width} height={h} className="block" role="img" aria-label="Eras and genre threads as lanes">
            {ticks.map((t) => <g key={t.week}><line x1={x(t.week)} x2={x(t.week)} y1={top} y2={h - 20} stroke={C.line} strokeDasharray="2 4" /><text x={x(t.week) + 4} y={h - 6} fontSize="12" fill={C.dust} className="num">{t.label}</text></g>)}
            {spans.map((s) => {
              const lane = s.kind === 'era' ? '__eras' : s.label;
              const x0 = x(s.start), w = Math.max(colW, weeksIn(s) * colW - 2);
              return (
                <g key={s.key} opacity={dim(s.key)} onMouseEnter={enter(s.key)} onMouseMove={onMove(s.key)} onMouseLeave={leave} onClick={() => onPick?.({ kind: s.kind, key: s.key })} className="cursor-pointer" style={{ transition: 'opacity 150ms' }}>
                  <rect x={x0} y={laneY(lane) + 4} width={w} height={laneH - 8} rx={9} fill={s.color} fillOpacity={s.kind === 'era' ? 0.85 : 0.6} />
                  {w > 40 && <text x={x0 + 8} y={laneY(lane) + laneH / 2 + 4} fontSize="12" fill={C.ink} className="pointer-events-none">{truncate(s.kind === 'era' ? s.label : `${Math.round(s.hours)} h`, Math.floor(w / 7))}</text>}
                </g>
              );
            })}
          </svg>
        </Scroller>
        {Tip}
      </div>
    </div>
  );
}

/**
 * Horizontal scroller that opens at the right-hand end, so the present is in view first. Phase 9i: it jumps to the end
 * only when the chart's width changes (`resetKey`) — 9h re-ran on every render, so hovering an era after scrolling
 * left re-rendered the chart and snapped it back to today.
 */
function Scroller({ children, resetKey }: { children: ReactNode; resetKey: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = ref.current; if (el) el.scrollLeft = el.scrollWidth; }, [resetKey]);
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

function build(weeks: EraWeek[], eras: Era[], threads: GenreThread[], st: EraStyle) {
  const pal = PALETTES[st.palette] ?? PALETTES.ember;
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
    spans.push({ key: `era:${e.start}`, kind: 'era', label: e.name, sub: `${fmtDate(e.start, { month: 'short', day: 'numeric', year: 'numeric' })} → ${fmtDate(e.end, { month: 'short', day: 'numeric', year: 'numeric' })} · ${e.weeks} weeks · ${fmtHours(e.hours)}\n${e.topArtists.map((a) => a.artist).join(', ')}`, start: e.start, endExclusive: e.endExclusive, color: pal.eras[i % pal.eras.length], series, hours: e.hours, era: e });
  });
  for (const t of threads) {
    spans.push({ key: `thread:${t.tag}:${t.start}`, kind: 'thread', label: t.label, sub: `${fmtDate(t.start, { month: 'short', day: 'numeric', year: 'numeric' })} → ${fmtDate(t.end, { month: 'short', day: 'numeric', year: 'numeric' })} · ${t.weeks} weeks · ${fmtHours(t.hours)} · peak ${Math.round(t.peakShare * 100)}% of the week\n${t.topArtists.map((a) => a.artist).join(', ')}`, start: t.start, endExclusive: t.endExclusive, color: pal.threads[hash(t.tag) % pal.threads.length], series: t.series.map((w) => ({ week: w.week, hours: w.hours })), hours: t.hours, thread: t });
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

const cssId = (k: string) => k.replace(/[^a-zA-Z0-9_-]/g, '_');

/** Phase 9i: the expanded description on hover — full name, dates, size and who defined it, readable at any zoom. */
function HoverCard({ span: s, x, y, wrapW }: { span: Span; x: number; y: number; wrapW: number }) {
  const w = 300, left = Math.max(4, Math.min(x + 16, wrapW - w - 4));
  const e = s.era, t = s.thread;
  const d = (iso: string) => fmtDate(iso, { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    <div className="pointer-events-none absolute z-20 rounded-xl border border-line bg-surface/95 p-3 text-sm shadow-xl backdrop-blur" style={{ left, top: Math.max(0, y - 12), width: w }} role="tooltip">
      <p className="flex items-center gap-2"><span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: s.color }} /><span className="text-[10px] uppercase tracking-wider text-dust">{s.kind === 'era' ? 'Era' : t?.kind === 'scene' ? 'Scene thread' : t?.kind === 'decade' ? 'Decade thread' : 'Genre thread'}{(e?.inProgress || t?.inProgress) ? ' · still running' : ''}</span></p>
      <p className="mt-1 font-display text-lg leading-snug">{s.label}</p>
      <p className="num mt-1 text-xs text-dust">{d(s.start)} → {d(e?.end ?? t?.end ?? s.start)} · {e?.weeks ?? t?.weeks} weeks · {fmtHours(s.hours)}</p>
      {e && <p className="num mt-1 text-xs text-dust">{Math.round(e.noveltyRate * 100)}% new to you · skip rate {Math.round(e.skipRate * 100)}%{e.lateShare >= 0.25 ? ` · ${Math.round(e.lateShare * 100)}% after 10 pm` : ''}{e.topTag ? ` · ${e.topTag}` : ''}</p>}
      {t && <p className="num mt-1 text-xs text-dust">peak {Math.round(t.peakShare * 100)}% of a week · average {Math.round(t.meanShare * 100)}%</p>}
      <EraWeather from={s.start} to={s.endExclusive} />
      {(e?.topArtists ?? t?.topArtists ?? []).length > 0 && <p className="mt-2 text-xs"><span className="text-dust">Defined by </span>{(e?.topArtists ?? t?.topArtists ?? []).slice(0, 5).map((a) => a.artist).join(' · ')}</p>}
      <p className="mt-2 text-[10px] text-dust/70">click to open</p>
    </div>
  );
}

/** Phase 9m: the weather this stretch was listened in, when it stands out (needs Settings → Record → Weather). */
function EraWeather({ from, to }: { from: string; to: string }) {
  const w = useAsync(() => rangeWeather(from, to), [from, to]);
  if (!w.data) return null;
  return <p className="mt-1 text-xs">{w.data.glyph} listened most on {w.data.label.toLowerCase()} days — {Math.round(w.data.share * 100)}% of its hours vs {Math.round(w.data.baseShare * 100)}% overall</p>;
}
