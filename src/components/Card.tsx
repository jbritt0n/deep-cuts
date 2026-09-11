import type { ReactNode } from 'react';

export function Card({ title, subtitle, aside, children, className = '' }: {
  title?: string; subtitle?: string; aside?: ReactNode; children: ReactNode; className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-6 ${className}`}>
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

export function Loading({ label = 'Reading the record…' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-16 text-dust">
      <span aria-hidden className="spin relative block h-6 w-6 rounded-full border border-dust/50">
        <span className="absolute inset-[9px] rounded-full bg-amber" />
      </span>
      <span className="text-sm">{label}</span>
    </div>
  );
}

export function ErrorBox({ message }: { message: string }) {
  return <div className="rounded-xl border border-coral/40 bg-coral/5 px-4 py-3 text-sm text-coral">{message}</div>;
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
