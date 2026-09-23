import { useEffect, useRef, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import type { AppStatus } from '@/lib/types';
import { SearchBox } from './SearchBox';
import { FilterLens } from './FilterLens';
import { ErrorBoundary } from './ErrorBoundary';

/**
 * Phase 9h — nav reorganised (owner: "the side bar is a little long"). Four always-visible entries, then four
 * collapsible groups. Open/closed state persists; the group holding the current page always opens itself.
 * Not for me moved to Settings → Not for me; Moods became Moods & Forecast.
 */
type NavItem = { to: string; label: string; match?: string[] };
type NavGroup = { id: string; label: string; items: NavItem[]; defaultOpen: boolean };
const PINNED: NavItem[] = [
  { to: '/', label: 'Dashboard' },
  { to: '/explore', label: 'Ask the archive', match: ['/explore'] },
  { to: '/library', label: 'Library' },
  { to: '/crate', label: 'The Crate' },
];
export const NAV_GROUPS: NavGroup[] = [
  { id: 'understand', label: 'Understand', defaultOpen: true, items: [
    { to: '/sessions', label: 'Sessions', match: ['/sessions'] },
    { to: '/eras', label: 'Eras' },
    { to: '/moods', label: 'Moods & Forecast', match: ['/moods', '/forecast'] },
    { to: '/insights', label: 'Insights' },
    { to: '/atlas', label: 'Atlas' },
    { to: '/drift', label: 'Taste drift' },
  ] },
  { id: 'stories', label: 'Stories', defaultOpen: false, items: [
    { to: '/notes', label: 'Liner Notes' },
    { to: '/review', label: 'In Review' },
    { to: '/compare', label: 'Compare' },
    { to: '/achievements', label: 'Achievements' },
  ] },
  { id: 'act', label: 'Act', defaultOpen: true, items: [
    { to: '/discover', label: 'Discover' },
    { to: '/wild', label: 'Heard in the Wild' },
    { to: '/blend', label: 'Blend' },
  ] },
  { id: 'app', label: 'App', defaultOpen: false, items: [
    { to: '/services', label: 'Services' },
    { to: '/settings', label: 'Settings' },
    { to: '/activity', label: 'Activity' },
  ] },
];
const NAV_KEY = 'deepcuts.nav';
const loadOpen = (): Record<string, boolean> => { try { return JSON.parse(localStorage.getItem(NAV_KEY) ?? '{}'); } catch { return {}; } };
const isHere = (n: NavItem, path: string) => (n.to === '/' ? path === '/' : (n.match ?? [n.to]).some((m) => path === m || path.startsWith(m + '/')));

function NavItemLink({ n, path }: { n: NavItem; path: string }) {
  const here = isHere(n, path);
  return <NavLink to={n.to} end={n.to === '/'} aria-current={here ? 'page' : undefined} className={`block rounded-lg px-3 py-1.5 text-sm transition ${here ? 'bg-raised text-cream' : 'text-dust hover:bg-raised/60 hover:text-cream'}`}>{n.label}</NavLink>;
}

function Nav() {
  const { pathname } = useLocation();
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  const toggle = (id: string, now: boolean) => { const next = { ...open, [id]: !now }; setOpen(next); try { localStorage.setItem(NAV_KEY, JSON.stringify(next)); } catch { /* private mode */ } };
  return (
    <nav className="mt-5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto pr-1" aria-label="Main">
      {PINNED.map((n) => <NavItemLink key={n.to} n={n} path={pathname} />)}
      {NAV_GROUPS.map((g) => {
        const holdsHere = g.items.some((n) => isHere(n, pathname));
        const isOpen = holdsHere || (open[g.id] ?? g.defaultOpen);
        return (
          <div key={g.id} className="mt-3">
            <button onClick={() => toggle(g.id, isOpen)} aria-expanded={isOpen} disabled={holdsHere && isOpen} title={holdsHere ? 'Holds the page you are on' : isOpen ? 'Collapse' : 'Expand'}
              className="flex w-full items-center gap-1.5 rounded-md px-3 py-1 text-left text-[10px] uppercase tracking-wider text-dust/70 hover:text-cream disabled:cursor-default disabled:hover:text-dust/70">
              <span aria-hidden className={`inline-block transition-transform ${isOpen ? 'rotate-90' : ''}`}>▸</span>{g.label}
              {!isOpen && <span className="ml-auto normal-case tracking-normal text-dust/50">{g.items.length}</span>}
            </button>
            {isOpen && <div className="mt-0.5 flex flex-col gap-0.5">{g.items.map((n) => <NavItemLink key={n.to} n={n} path={pathname} />)}</div>}
          </div>
        );
      })}
    </nav>
  );
}

export function Shell({ status }: { status: AppStatus }) {
  const loc = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // a new page starts at its top (the single scroller keeps its offset across routes otherwise); hash links keep theirs
  useEffect(() => { if (!loc.hash) mainRef.current?.scrollTo({ top: 0 }); }, [loc.pathname]);
  return (
    <div className="grid h-full grid-cols-[minmax(180px,13.75rem)_minmax(0,1fr)] grid-rows-[minmax(0,1fr)] overflow-hidden">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-full focus:bg-amber focus:px-3 focus:py-1 focus:text-ink">Skip to content</a>
      <aside className="flex min-h-0 flex-col border-r border-line bg-surface/40 px-3 py-4">
        <NavLink to="/" className="group flex items-center gap-3 px-2">
          <span aria-hidden className="relative block h-8 w-8 rounded-full border border-amber/70">
            <span className="absolute inset-[5px] rounded-full border border-amber/40" />
            <span className="absolute inset-[11px] rounded-full bg-amber transition group-hover:shadow-glow" />
          </span>
          <span className="font-display text-xl tracking-tight">Deep Cuts</span>
        </NavLink>
        <Nav />
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
        <header className="z-30 flex shrink-0 items-center gap-4 border-b border-line bg-ink/85 px-[clamp(1rem,2.2vw,2rem)] py-2.5 backdrop-blur">
          <SearchBox />
          <div className="ml-auto"><FilterLens /></div>
        </header>
        <main id="main" ref={mainRef} tabIndex={-1} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-[clamp(1rem,2.2vw,2rem)] pb-16 pt-[clamp(1rem,2vh,1.5rem)]">
          <ErrorBoundary resetKey={loc.pathname + loc.search}><Outlet /></ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
