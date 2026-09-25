import { describeError } from '@/lib/errors';
import type { ReactNode } from 'react';

export function Card({ title, subtitle, aside, children, className = '' }: {
  title?: string; subtitle?: string; aside?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section id={title ? `c-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48)}` : undefined} data-card-title={title || undefined} className={`scroll-mt-4 rounded-2xl border border-line bg-surface p-6 ${className}`}>
      {(title || aside) && (
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            {title && <h2 className="font-display text-xl">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-dust">{subtitle}</p>}
          </div>
          {aside}
        </div>
      )}
      {children}
    </section>
  );
}

export function StatCard({ label, value, footnote, accent = false }: { label: string; value: string; footnote?: string; accent?: boolean }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-5">
      <p className="text-xs text-dust">{label}</p>
      <p className={`num mt-2 font-display text-3xl tracking-tight ${accent ? 'text-amber' : 'text-cream'}`}>{value}</p>
      {footnote && <p className="mt-1.5 text-xs text-dust">{footnote}</p>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-dust">{children}</p>;
}

/**
 * Phase 10 (Kimi T3): a skeleton instead of a spinner — pulsing bars roughly where the content will be, so pages
 * don't jump when a query lands. The label stays for screen readers (role=status) and as a small caption.
 * `rows` sizes the skeleton; the pulse is disabled by the reduced-motion rule in index.css.
 */
export function Loading({ label = 'Reading the record…', rows = 4 }: { label?: string; rows?: number }) {
  const widths = ['92%', '78%', '85%', '64%', '88%', '71%', '80%', '58%'];
  return (
    <div role="status" aria-live="polite" className="py-4">
      <div aria-hidden className="space-y-2.5">
        {Array.from({ length: Math.max(1, rows) }, (_, i) => <div key={i} className="skeleton h-3.5 rounded-full" style={{ width: widths[i % widths.length] }} />)}
      </div>
      <p className="mt-3 text-[11px] text-dust/70">{label}</p>
    </div>
  );
}

/** A skeleton shaped like a chart: bars of varying height. */
export function ChartSkeleton({ height = 140, bars = 24 }: { height?: number; bars?: number }) {
  return (
    <div role="status" aria-label="Loading chart" className="flex items-end gap-1 py-2" style={{ height }}>
      {Array.from({ length: bars }, (_, i) => <div key={i} className="skeleton flex-1 rounded-sm" style={{ height: `${30 + ((i * 37) % 60)}%` }} />)}
    </div>
  );
}

/** Phase 10b: a plain explanation from the error's code, the technical text under "details". */
export function ErrorBox({ message }: { message: string }) {
  const d = describeError(message);
  const tone = d.code === 'quota' || d.code === 'busy' || d.code === 'network' ? 'border-amber/40 bg-amber/5 text-amber' : 'border-coral/40 bg-coral/5 text-coral';
  return (
    <div role="alert" className={`rounded-xl border px-4 py-3 text-sm ${tone}`}>
      <p>{d.hint}{d.code === 'auth' && <> <a href="#/services" className="underline">Open Services</a></>}</p>
      {d.hint !== d.detail && <details className="mt-1 text-[11px] opacity-80"><summary className="cursor-pointer">details · {d.code}</summary><p className="mt-1 whitespace-pre-wrap break-words font-mono">{d.detail}</p></details>}
    </div>
  );
}

/** Record-sleeve page header for entities. */
export function Sleeve({ kicker, title, meta, children }: { kicker?: ReactNode; title: ReactNode; meta?: ReactNode; children?: ReactNode }) {
  return (
    <header className="sleeve -mx-8 -mt-6 mb-8 border-b border-line px-8 pb-8 pt-8">
      {kicker && <div className="text-sm text-dust">{kicker}</div>}
      <h1 className="mt-2 font-display text-4xl leading-tight tracking-tight md:text-5xl">{title}</h1>
      {meta && <div className="num mt-3 text-sm text-dust">{meta}</div>}
      {children}
    </header>
  );
}
