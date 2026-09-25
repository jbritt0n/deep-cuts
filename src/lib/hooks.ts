import { createContext, useContext, useEffect, useRef, useState, type DependencyList } from 'react';
import { invoke, listen } from './bridge';
import { DEFAULT_FILTER, type ListeningFilter } from './filter';

export type AsyncState<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

/** Load data; re-run when deps change or the record changes (data:changed). */
export function useAsync<T>(fn: () => Promise<T>, deps: DependencyList): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setLoading(true);
    fn().then((d) => { if (alive.current) { setData(d); setError(null); } })
        .catch((e) => { if (alive.current) setError(String(e?.message ?? e)); })
        .finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  useEffect(() => {
    let un: (() => void) | undefined;
    listen('data:changed', () => setTick((t) => t + 1)).then((u) => { un = u; });
    // Phase 10c: "Refresh this page" in the command palette (and the post-rebuild refresh) re-run every query on screen
    const again = () => setTick((t) => t + 1);
    window.addEventListener('deepcuts:refresh', again);
    return () => { un?.(); window.removeEventListener('deepcuts:refresh', again); };
  }, []);
  return { data, error, loading, reload: () => setTick((t) => t + 1) };
}

export type FilterCtx = {
  filter: ListeningFilter;
  setFilter: (f: ListeningFilter) => void;
  years: number[];         // years present in the record
  demo: boolean;
  theme: string;
  setTheme: (id: string) => void;
};
export const FilterContext = createContext<FilterCtx>({ filter: DEFAULT_FILTER, setFilter: () => {}, years: [], demo: false, theme: 'ink', setTheme: () => {} });
export const useFilter = () => useContext(FilterContext);

/** Debounced value. */
export function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => { const t = setTimeout(() => setV(value), ms); return () => clearTimeout(t); }, [value, ms]);
  return v;
}

/** app_meta settings as {key, value} rows; re-read on data:changed and on demand. Used by the eras tuning (Settings ↔ Insights share one source of truth). */
export function useSettings(): AsyncState<{ key: string; value: string }[]> {
  return useAsync(() => invoke<{ key: string; value: string }[]>('get_settings'), []);
}
