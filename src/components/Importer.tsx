import { useEffect, useState } from 'react';
import { inTauri, invoke, listen } from '@/lib/bridge';
import type { ImportDone, ImportPreview, ImportProgress } from '@/lib/types';
import { fmtInt } from '@/lib/format';

type Phase = { kind: 'idle' } | { kind: 'inspecting'; path: string } | { kind: 'preview'; preview: ImportPreview }
  | { kind: 'importing'; progress: ImportProgress | null } | { kind: 'done'; done: ImportDone } | { kind: 'error'; message: string; path?: string };

/**
 * ING-01…04: one surface that takes the export zip (drag it in, or pick it),
 * previews what's inside, imports with progress, and hands back a summary.
 */
export function Importer({ onDone, compact = false }: { onDone?: (d: ImportDone) => void; compact?: boolean }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [hover, setHover] = useState(false);
  const [manual, setManual] = useState('');

  const inspect = async (path: string) => {
    setPhase({ kind: 'inspecting', path });
    try { setPhase({ kind: 'preview', preview: await invoke<ImportPreview>('inspect_import', { path }) }); }
    catch (e) { setPhase({ kind: 'error', message: String(e), path }); }
  };

  // Native drag-drop: Tauri delivers real file paths (the browser can't).
  useEffect(() => {
    if (!inTauri) return;
    let un: (() => void) | undefined;
    import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent((ev) => {
        if (ev.payload.type === 'over') setHover(true);
        else if (ev.payload.type === 'leave') setHover(false);
        else if (ev.payload.type === 'drop') { setHover(false); const p = ev.payload.paths[0]; if (p) void inspect(p); }
      }).then((u) => { un = u; }));
    return () => un?.();
  }, []);

  useEffect(() => {
    const uns: (() => void)[] = [];
    listen<ImportProgress>('import:progress', (p) => setPhase((ph) => (ph.kind === 'importing' ? { kind: 'importing', progress: p } : ph))).then((u) => uns.push(u));
    listen<ImportDone>('import:done', (d) => { setPhase({ kind: 'done', done: d }); onDone?.(d); }).then((u) => uns.push(u));
    listen<{ message: string }>('import:error', (e) => setPhase({ kind: 'error', message: e.message })).then((u) => uns.push(u));
    return () => uns.forEach((u) => u());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pick = async (directory: boolean) => {
    if (!inTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const sel = await open({ multiple: false, directory, filters: directory ? undefined : [{ name: 'Spotify export', extensions: ['zip', 'json'] }] });
    if (typeof sel === 'string') void inspect(sel);
  };

  const start = async (path: string) => {
    setPhase({ kind: 'importing', progress: null });
    try { await invoke<string>('start_import', { path }); } catch (e) { setPhase({ kind: 'error', message: String(e), path }); }
  };

  if (phase.kind === 'preview') {
    const p = phase.preview;
    return (
      <div className="rounded-2xl border border-line bg-surface p-6">
        <p className="text-xs text-dust">{p.sourceKind === 'zip' ? 'Export zip' : p.sourceKind === 'folder' ? 'Export folder' : 'Export file'} · {p.files.length} history file{p.files.length === 1 ? '' : 's'}</p>
        <h3 className="mt-1 font-display text-2xl">{fmtInt(p.rowsNew)} new plays{p.firstTs ? `, ${p.firstTs.slice(0, 10)} → ${p.lastTs?.slice(0, 10)}` : ''}</h3>
        <ul className="num mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-dust sm:grid-cols-4">
          <li>{fmtInt(p.rowsTotal)} rows in files</li>
          <li>{fmtInt(p.rowsSkipped)} podcast / video rows skipped</li>
          <li>{fmtInt(p.rowsDuplicateInFile)} duplicate rows collapsed</li>
          <li>{fmtInt(p.rowsAlreadyImported)} already in your record</li>
        </ul>
        {!compact && (
          <details className="mt-4 text-xs">
            <summary className="cursor-pointer text-dust hover:text-cream">Files</summary>
            <ul className="num mt-2 space-y-0.5 text-dust">{p.files.map((f) => <li key={f.name}>{f.name} · {fmtInt(f.rowsAudio)} plays · {f.firstTs?.slice(0, 10)} → {f.lastTs?.slice(0, 10)}</li>)}</ul>
          </details>
        )}
        {p.sample.length > 0 && (
          <div className="mt-4">
            <p className="text-xs text-dust">Most recent in the export</p>
            <ul className="mt-1 divide-y divide-line/60 text-sm">
              {p.sample.slice(0, compact ? 3 : 6).map((s, i) => <li key={i} className="flex gap-3 py-1.5"><span className="num w-32 shrink-0 text-xs text-dust">{s.ts}</span><span className="truncate">{s.track_name}</span><span className="truncate text-dust">{s.artist_name}</span></li>)}
            </ul>
          </div>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button onClick={() => start(p.source)} disabled={p.rowsNew === 0}
            className="rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-ink transition hover:shadow-glow disabled:cursor-not-allowed disabled:opacity-40">
            {p.rowsNew === 0 ? 'Nothing new to import' : `Import ${fmtInt(p.rowsNew)} plays`}
          </button>
          <button onClick={() => setPhase({ kind: 'idle' })} className="text-sm text-dust hover:text-cream">Choose a different file</button>
          {p.rowsAlreadyImported > 0 && <p className="text-xs text-dust">Re-importing is always safe — only new plays are added.</p>}
        </div>
      </div>
    );
  }

  if (phase.kind === 'importing') {
    const pr = phase.progress;
    const pct = pr && pr.file_count ? Math.min(100, Math.round((pr.file_index / pr.file_count) * 80) + (pr.stage === 'resolving' ? 85 : pr.stage === 'sessions' ? 92 : pr.stage === 'finishing' ? 98 : 0) * (['resolving', 'sessions', 'finishing'].includes(pr.stage) ? 1 : 0)) : 3;
    return (
      <div className="rounded-2xl border border-line bg-surface p-6">
        <div className="flex items-center gap-4">
          <span aria-hidden className="spin relative block h-10 w-10 rounded-full border border-amber/60"><span className="absolute inset-[6px] rounded-full border border-amber/30" /><span className="absolute inset-[15px] rounded-full bg-amber" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-display text-xl">{pr?.message ?? 'Starting'}</p>
            <p className="num mt-1 text-xs text-dust">{pr ? `${fmtInt(pr.rows_inserted)} plays added${pr.file_count ? ` · file ${Math.min(pr.file_index + 1, pr.file_count)} of ${pr.file_count}` : ''}` : ''}</p>
          </div>
        </div>
        <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber transition-all duration-300" style={{ width: `${Math.max(pct, 3)}%` }} /></div>
      </div>
    );
  }

  if (phase.kind === 'done') {
    const d = phase.done;
    return (
      <div className="rounded-2xl border border-amber/40 bg-amber/5 p-6">
        <p className="text-xs text-amber">Your record is ready</p>
        <h3 className="num mt-1 font-display text-2xl">{fmtInt(d.total_plays)} plays · {fmtInt(d.total_hours)} hours</h3>
        <p className="num mt-2 text-xs text-dust">+{fmtInt(d.rows_inserted)} new · {fmtInt(d.rows_duplicate)} duplicates skipped · {fmtInt(d.rows_skipped)} podcast/video rows skipped · {(d.elapsed_ms / 1000).toFixed(1)} s</p>
        <button onClick={() => setPhase({ kind: 'idle' })} className="mt-4 text-sm text-dust hover:text-cream">Import another export</button>
      </div>
    );
  }

  return (
    <div>
      <div onDragOver={(e) => { e.preventDefault(); setHover(true); }} onDragLeave={() => setHover(false)} onDrop={(e) => { e.preventDefault(); setHover(false); }}
        className={`relative rounded-2xl border-2 border-dashed p-8 text-center transition ${hover ? 'border-amber bg-amber/5' : 'border-line bg-surface/60'}`}>
        <div className="mx-auto grid h-16 w-16 place-items-center rounded-full border border-line bg-ink">
          <span aria-hidden className="relative block h-9 w-9 rounded-full border border-amber/70"><span className="absolute inset-[6px] rounded-full border border-amber/40" /><span className="absolute inset-[13px] rounded-full bg-amber" /></span>
        </div>
        <p className="mt-4 font-display text-2xl">{phase.kind === 'inspecting' ? 'Reading your export…' : 'Drop your Spotify export here'}</p>
        <p className="mt-2 text-sm text-dust">The <span className="text-cream/80">my_spotify_data.zip</span> Spotify emailed you, or its unzipped folder. No need to unzip.</p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
          {inTauri ? (
            <>
              <button onClick={() => pick(false)} className="rounded-full bg-amber px-5 py-2.5 text-sm font-medium text-ink transition hover:shadow-glow">Choose the zip</button>
              <button onClick={() => pick(true)} className="rounded-full border border-line px-5 py-2.5 text-sm text-dust transition hover:border-dust hover:text-cream">Choose a folder</button>
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); if (manual.trim()) void inspect(manual.trim()); }} className="flex w-full max-w-md gap-2">
              <input value={manual} onChange={(e) => setManual(e.target.value)} placeholder="/path/to/my_spotify_data.zip or folder (browser dev mode)" className="num flex-1 rounded-full border border-line bg-ink px-4 py-2 text-xs" />
              <button className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink">Read</button>
            </form>
          )}
        </div>
        {phase.kind === 'error' && <p className="mt-4 rounded-xl border border-coral/40 bg-coral/5 px-4 py-2 text-left text-xs text-coral">{phase.message}</p>}
      </div>
      {!compact && (
        <details className="mt-4 text-sm text-dust">
          <summary className="cursor-pointer hover:text-cream">Don't have an export yet?</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-xs">
            <li>Open spotify.com → Account → Privacy settings.</li>
            <li>Tick <em>Extended streaming history</em> (not the account-data one) and request.</li>
            <li>Spotify emails a zip within a few days (sometimes weeks). Drop it here as is.</li>
          </ol>
        </details>
      )}
    </div>
  );
}
