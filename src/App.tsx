import { useEffect, useMemo, useState } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { invoke, listen } from './lib/bridge';
import { FilterContext } from './lib/hooks';
import { loadFilter, saveFilter, setActiveFilter, type ListeningFilter } from './lib/filter';
import { getYears } from './lib/queries';
import { applyTheme, loadThemeId } from './lib/theme';
import type { AppStatus } from './lib/types';
import { Shell } from './components/Shell';
import { Onboarding } from './pages/Onboarding';
import { Dashboard } from './pages/Dashboard';
import { Explore } from './pages/Explore';
import { ArtistPage } from './pages/Artist';
import { TrackPage } from './pages/Track';
import { AlbumPage } from './pages/Album';
import { DayPage } from './pages/Day';
import { MonthPage } from './pages/Month';
import { SessionsPage } from './pages/Sessions';
import { InsightsPage } from './pages/Insights';
import { ReviewPage } from './pages/Review';
import { DiscoveryPage } from './pages/Discovery';
import { AchievementsPage } from './pages/Achievements';
import { MoodsPage } from './pages/Moods';
import { DriftPage } from './pages/Drift';
import { ComparePage } from './pages/Compare';
import { LibraryPage } from './pages/Library';
import { BlendPage } from './pages/Blend';
import { NotesPage } from './pages/Notes';
import { PlaylistMakerProvider } from './components/PlaylistMaker';
import { ServicesPage } from './pages/Services';
import { SettingsPage } from './pages/Settings';

export function App() {
  const [status, setStatus] = useState<AppStatus | null>(null);
  const [filter, setFilterState] = useState<ListeningFilter>(() => { const f = loadFilter(); setActiveFilter(f); return f; });
  const [years, setYears] = useState<number[]>([]);
  const [theme, setThemeState] = useState<string>(() => applyTheme(loadThemeId()).id);
  const setTheme = (id: string) => setThemeState(applyTheme(id).id);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    invoke<AppStatus>('get_status').then((s) => { setStatus(s); setErr(null); }).catch((e) => setErr(String(e)));
    getYears().then(setYears).catch(() => {});
  };
  useEffect(() => {
    refresh();
    let un: (() => void) | undefined;
    listen('data:changed', refresh).then((u) => { un = u; });
    return () => un?.();
  }, []);

  const setFilter = (f: ListeningFilter) => { setActiveFilter(f); saveFilter(f); setFilterState(f); };
  const ctx = useMemo(() => ({ filter, setFilter, years, demo: status?.demo ?? false, theme, setTheme }), [filter, years, status?.demo, theme]);

  if (err) return (
    <div className="grid h-full place-items-center p-10 text-center">
      <div className="max-w-md">
        <h1 className="font-display text-3xl">Deep Cuts can't reach its record</h1>
        <p className="mt-3 text-dust">{err}</p>
        <p className="mt-3 text-sm text-dust">In browser dev mode, start <span className="num">npm run dev:browser</span>.</p>
      </div>
    </div>
  );
  if (!status) return <div className="grid h-full place-items-center text-dust">Opening your record…</div>;

  return (
    <FilterContext.Provider value={ctx}>
      <PlaylistMakerProvider>
      <HashRouter>
        <Routes>
          <Route path="/welcome" element={<Onboarding status={status} onDone={refresh} />} />
          <Route element={<Shell status={status} />}>
            <Route path="/" element={status.hasData || status.demo ? <Dashboard status={status} /> : <Navigate to="/welcome" replace />} />
            <Route path="/explore" element={<Explore />} />
            <Route path="/artist/:id" element={<ArtistPage />} />
            <Route path="/track/:id" element={<TrackPage />} />
            <Route path="/album/:id" element={<AlbumPage />} />
            <Route path="/day/:date" element={<DayPage />} />
            <Route path="/month/:key" element={<MonthPage />} />
            <Route path="/insights" element={<InsightsPage />} />
            <Route path="/notes" element={<NotesPage />} />
            <Route path="/discover" element={<DiscoveryPage />} />
            <Route path="/achievements" element={<AchievementsPage />} />
            <Route path="/moods" element={<MoodsPage />} />
            <Route path="/drift" element={<DriftPage />} />
            <Route path="/compare" element={<ComparePage />} />
            <Route path="/library" element={<LibraryPage />} />
            <Route path="/blend" element={<BlendPage />} />
            <Route path="/review" element={<ReviewPage />} />
            <Route path="/year" element={<Navigate to="/review" replace />} />
            <Route path="/sessions" element={<SessionsPage />} />
            <Route path="/sessions/:id" element={<SessionsPage />} />
            <Route path="/services" element={<ServicesPage />} />
            <Route path="/settings" element={<SettingsPage status={status} onChanged={refresh} />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </HashRouter>
      </PlaylistMakerProvider>
    </FilterContext.Provider>
  );
}
