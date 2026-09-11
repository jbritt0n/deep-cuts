/**
 * Global listening filter. Applied by every query so "top artists" or "hours
 * by month" mean the same slice everywhere. Persisted in localStorage.
 *  - attentiveOnly: drop plays flagged unattended (laptop left on all night)
 *  - fromYear / toYear: inclusive year range, null = open
 */
export type ListeningFilter = { attentiveOnly: boolean; fromYear: number | null; toYear: number | null };

export const DEFAULT_FILTER: ListeningFilter = { attentiveOnly: true, fromYear: null, toYear: null };

let current: ListeningFilter = DEFAULT_FILTER;
export const setActiveFilter = (f: ListeningFilter) => { current = f; };
export const getActiveFilter = () => current;

/** SQL fragment starting with AND, for a plays_resolved alias (or none). */
export function playsWhere(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  const parts: string[] = [];
  if (current.attentiveOnly) parts.push(`${a}attended`);
  if (current.fromYear) parts.push(`${a}played_at >= DATE '${current.fromYear}-01-01'`);
  if (current.toYear) parts.push(`${a}played_at < DATE '${current.toYear + 1}-01-01'`);
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}

/** Same for the sessions table (start_at, attention). */
export function sessionsWhere(alias = ''): string {
  const a = alias ? `${alias}.` : '';
  const parts: string[] = [];
  if (current.attentiveOnly) parts.push(`${a}attention <> 'unattended'`);
  if (current.fromYear) parts.push(`${a}start_at >= DATE '${current.fromYear}-01-01'`);
  if (current.toYear) parts.push(`${a}start_at < DATE '${current.toYear + 1}-01-01'`);
  return parts.length ? ' AND ' + parts.join(' AND ') : '';
}

export const isFiltered = (f: ListeningFilter) => f.attentiveOnly || f.fromYear !== null || f.toYear !== null;

export function loadFilter(): ListeningFilter {
  try {
    const raw = localStorage.getItem('deepcuts.filter');
    if (raw) return { ...DEFAULT_FILTER, ...(JSON.parse(raw) as Partial<ListeningFilter>) };
  } catch { /* first run */ }
  return DEFAULT_FILTER;
}
export function saveFilter(f: ListeningFilter) {
  try { localStorage.setItem('deepcuts.filter', JSON.stringify(f)); } catch { /* ignore */ }
}
