import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { AppStatus } from '@/lib/types';
import { SearchBox } from './SearchBox';
import { FilterLens } from './FilterLens';
import { ErrorBoundary } from './ErrorBoundary';

const NAV: { to: string; label: string; group?: string }[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/explore', label: 'Ask the archive' },
  { to: '/library', label: 'Library' },
  { to: '/crate', label: 'The Crate' },
  { to: '/sessions', label: 'Sessions', group: 'Understand' },
  { to: '/eras', label: 'Eras' },
  { to: '/insights', label: 'Insights' },
  { to: '/notes', label: 'Liner Notes' },
  { to: '/review', label: 'In Review' },
  { to: '/compare', label: 'Compare' },
  { to: '/moods', label: 'Moods' },
  { to: '/drift', label: 'Taste drift' },
  { to: '/achievements', label: 'Achievements' },
  { to: '/notforme', label: 'Not for me' },
  { to: '/discover', label: 'Discover', group: 'Act' },
  { to: '/wild', label: 'Heard in the Wild' },
  { to: '/blend', label: 'Blend' },
  { to: '/services', label: 'Services', group: 'App' },
  { to: '/settings', label: 'Settings' },
  { to: '/activity', label: 'Activity' },
];

export function Shell({ status }: { status: AppStatus }) {
  const loc = useLocation();
  return (
    <div className="grid h-full grid-cols-[220px_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-full focus:bg-amber focus:px-3 focus:py-1 focus:text-ink">Skip to content</a>
      <aside className="flex flex-col border-r border-line bg-surface/40 px-4 py-5">
        <NavLink to="/" className="group flex items-center gap-3 px-2">
          <span aria-hidden className="relative block h-8 w-8 rounded-full border border-amber/70">
            <span className="absolute inset-[5px] rounded-full border border-amber/40" />
            <span className="absolute inset-[11px] rounded-full bg-amber transition group-hover:shadow-glow" />
          </span>
          <span className="font-display text-xl tracking-tight">Deep Cuts</span>
        </NavLink>
        <nav className="mt-6 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {NAV.map((n) => (
            <div key={n.to}>
              {n.group && <p className="mb-1 mt-4 px-3 text-[10px] uppercase tracking-wider text-dust/60">{n.group}</p>}
              <NavLink to={n.to} end={n.to === '/'}
                className={({ isActive }) => `block rounded-lg px-3 py-1.5 text-sm transition ${isActive || (n.to === '/sessions' && loc.pathname.startsWith('/sessions')) ? 'bg-raised text-cream' : 'text-dust hover:bg-raised/60 hover:text-cream'}`}>
                {n.label}
              </NavLink>
            </div>
          ))}
        </nav>
        <div className="mt-4 space-y-3 px-2 text-xs text-dust">
          {status.demo && (
            <NavLink to="/welcome" className="block rounded-lg border border-amber/40 bg-amber/5 px-3 py-2 text-amber hover:bg-amber/10">
              Demo record · import yours
            </NavLink>
          )}
          <p className="num">{status.playCount.toLocaleString()} plays</p>
          <p>{status.timezone}</p>
          <p className="text-dust/60">v{status.version} · local-first</p>
        </div>
      </aside>
      <div className="flex min-h-0 flex-col">
        <header className="sticky top-0 z-30 flex items-center gap-4 border-b border-line bg-ink/85 px-8 py-3 backdrop-blur">
          <SearchBox />
          <div className="ml-auto"><FilterLens /></div>
        </header>
        <main id="main" tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto px-8 pb-16 pt-6">
          <ErrorBoundary resetKey={loc.pathname + loc.search}><Outlet /></ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
