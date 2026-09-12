import { useState } from 'react';
import { invoke } from '@/lib/bridge';
import { useAsync } from '@/lib/hooks';
import { fmtInt } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';

type Activity = { at: string; task: string; level: string; message: string; detail: string | null };
type ImportRun = { import_id: string; at: string; files: number; inserted: number; duplicate: number; skipped: number };

/** Phase 9c — Activity moved out of Settings into its own page: everything the app did in the background, plus import history. */
export function ActivityPage() {
  const [level, setLevel] = useState<'all' | 'warn' | 'error'>('all');
  const [task, setTask] = useState<string>('all');
  const act = useAsync(() => invoke<Activity[]>('get_activity', { limit: 400 }), []);
  const imports = useAsync(() => invoke<ImportRun[]>('get_import_history'), []);
  const rows = (act.data ?? []).filter((a) => (level === 'all' || a.level === level || (level === 'warn' && a.level === 'error')) && (task === 'all' || a.task === task));
  const tasks = [...new Set((act.data ?? []).map((a) => a.task))].sort();
  const counts = { warn: (act.data ?? []).filter((a) => a.level === 'warn').length, error: (act.data ?? []).filter((a) => a.level === 'error').length };
  const pill = (on: boolean) => `rounded-full px-3 py-1 text-xs ${on ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`;
  return (
    <div className="mx-auto max-w-5xl">
      <Sleeve kicker="App" title="Activity" meta="Everything the app did in the background. Failures land here, never as a crash." />
      <Card title="Log" aside={<div className="flex flex-wrap gap-1.5"><button className={pill(level === 'all')} onClick={() => setLevel('all')}>all</button><button className={pill(level === 'warn')} onClick={() => setLevel('warn')}>warnings · {counts.warn + counts.error}</button><button className={pill(level === 'error')} onClick={() => setLevel('error')}>errors · {counts.error}</button><select value={task} onChange={(e) => setTask(e.target.value)} className="rounded-lg border border-line bg-ink px-2 py-1 text-xs" aria-label="Task"><option value="all">every task</option>{tasks.map((t) => <option key={t} value={t}>{t}</option>)}</select></div>}>
        {act.error ? <ErrorBox message={act.error} /> : !act.data ? <Loading /> : rows.length === 0 ? <p className="text-sm text-dust">Nothing here.</p> : (
          <ul className="divide-y divide-line/60 text-sm">
            {rows.map((a, i) => <li key={i} className="flex gap-4 py-2"><span className="num w-36 shrink-0 text-xs text-dust">{a.at?.slice(0, 16)}</span><span className={`w-20 shrink-0 text-xs ${a.level === 'error' ? 'text-coral' : a.level === 'warn' ? 'text-amber' : 'text-dust'}`}>{a.task}</span><span className="min-w-0 flex-1"><span className="block truncate" title={a.detail ?? ''}>{a.message}</span>{a.detail && a.level !== 'info' && <span className="block truncate text-xs text-dust/70">{a.detail}</span>}</span></li>)}
          </ul>
        )}
      </Card>
      <div className="mt-6">
        <Card title="Imports" subtitle="Every export you've added. Only new plays are ever inserted.">
          {imports.data && imports.data.length ? <ul className="num space-y-1 text-xs text-dust">{imports.data.map((r) => <li key={r.import_id}>{r.at?.slice(0, 16)} · {r.files} files · +{fmtInt(Number(r.inserted))} plays · {fmtInt(Number(r.duplicate))} duplicates · {fmtInt(Number(r.skipped))} skipped</li>)}</ul> : <p className="text-sm text-dust">No imports yet.</p>}
        </Card>
      </div>
    </div>
  );
}
