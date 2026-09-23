import { useState } from 'react';
import { Card, ErrorBox } from '@/components/Card';
import { inTauri, invoke } from '@/lib/bridge';
import { fmtInt } from '@/lib/format';

type Manifest = { format: number; app_version: string; pipeline_rev: string; created_at: string; zone: string; tables: { name: string; rows: number }[]; events: number; plays: number; first_play: string | null; last_play: string | null; secrets: boolean; source_os: string; source_data_dir: string };
type Report = { tables: number; rows: number; skipped_tables: string[]; secrets_restored: number; manifest: Manifest; backup_of_previous: string | null };

/**
 * Phase 9f — Settings → Record → Move to another computer.
 * Export writes one zip with every table as Parquet (album art URLs, tags, lyric features, polled plays,
 * feedback, overrides, settings — everything) plus, with a passphrase, the connector tokens encrypted.
 * Restore on the other machine replaces that record with this one and rebuilds the derived tables under
 * that build's pipeline, so bundles survive version differences in either direction.
 */
export function MoveCard({ onChanged }: { onChanged: () => void }) {
  const [tab, setTab] = useState<'export' | 'restore'>('export');
  const [dest, setDest] = useState('');
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [bundle, setBundle] = useState('');
  const [man, setMan] = useState<Manifest | null>(null);
  const [report, setReport] = useState<Report | null>(null);

  const pick = async (directory: boolean, into: (p: string) => void) => {
    if (!inTauri) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const sel = await open({ multiple: false, directory, filters: directory ? undefined : [{ name: 'Deep Cuts move bundle', extensions: ['zip'] }] });
    if (typeof sel === 'string') into(sel);
  };
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(null); setMsg(null); try { await fn(); } catch (e) { setErr(String(e)); } finally { setBusy(false); } };

  return (
    <Card title="Move to another computer" subtitle="One file carries the whole record: every play, session, insight, album cover URL, tag, lyric feature, playlist, decision and setting. Restore it on the new machine and carry on.">
      <div className="mb-3 flex gap-2 text-xs">{(['export', 'restore'] as const).map((t) => <button key={t} onClick={() => setTab(t)} className={`rounded-full px-3 py-1 ${tab === t ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{t === 'export' ? 'Export this record' : 'Restore a bundle here'}</button>)}</div>
      {msg && <p className="mb-3 text-sm text-moss">{msg}</p>}
      {err && <div className="mb-3"><ErrorBox message={err} /></div>}

      {tab === 'export' && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <input value={dest} onChange={(e) => setDest(e.target.value)} placeholder="Folder to write the bundle into (blank = backups folder)" className="min-w-[260px] flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm" />
            {inTauri && <button disabled={busy} onClick={() => void pick(true, setDest)} className="rounded-full border border-line px-3 py-2 text-xs text-dust hover:text-cream">Choose folder…</button>}
          </div>
          <div>
            <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Passphrase — optional; include Spotify / Last.fm / stats.fm sign-ins, encrypted" className="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm" autoComplete="new-password" />
            <p className="mt-1 text-xs text-dust">Leave blank to move the record without any sign-in tokens — you'd reconnect the services on the new machine (two minutes). With a passphrase the tokens ride along encrypted (XChaCha20-Poly1305); the passphrase itself is never stored.</p>
          </div>
          <button disabled={busy} onClick={() => run(async () => { const p = await invoke<string>('export_move_bundle', { destDir: dest || null, passphrase: pw || null }); setMsg(`Bundle written: ${p}`); })} className="rounded-full border border-amber/60 px-4 py-2 text-amber hover:bg-amber/10 disabled:opacity-40">{busy ? 'Writing…' : 'Write move bundle'}</button>
          <p className="text-xs text-dust">Then, on the other computer: install Deep Cuts (any version from this one onwards), open Settings → Record → Move → Restore, point it at the zip. The nightly Parquet backups in your data folder stay separate — this is a full snapshot, not a backup rotation.</p>
        </div>
      )}

      {tab === 'restore' && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <input value={bundle} onChange={(e) => { setBundle(e.target.value); setMan(null); setReport(null); }} placeholder="Path to deep-cuts-move-….zip" className="min-w-[260px] flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm" />
            {inTauri && <button disabled={busy} onClick={() => void pick(false, (p) => { setBundle(p); setMan(null); setReport(null); })} className="rounded-full border border-line px-3 py-2 text-xs text-dust hover:text-cream">Choose file…</button>}
            <button disabled={busy || !bundle} onClick={() => run(async () => setMan(await invoke<Manifest>('inspect_move_bundle', { path: bundle })))} className="rounded-full border border-line px-3 py-2 text-xs text-dust hover:text-cream disabled:opacity-40">Inspect</button>
          </div>
          {man && !report && (
            <div className="rounded-xl border border-line bg-ink/40 p-4">
              <p className="font-display text-xl">{fmtInt(man.plays)} plays{man.first_play ? `, ${man.first_play.slice(0, 10)} → ${man.last_play?.slice(0, 10)}` : ''}</p>
              <p className="num mt-1 text-xs text-dust">made {man.created_at.slice(0, 16).replace('T', ' ')} on {man.source_os} · Deep Cuts {man.app_version} (pipeline {man.pipeline_rev}) · zone {man.zone} · {man.tables.length} tables, {fmtInt(man.tables.reduce((a, t) => a + t.rows, 0))} rows · {man.secrets ? 'includes encrypted sign-ins' : 'no sign-ins included'}</p>
              {man.secrets && <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Passphrase for the sign-ins (blank = restore without them)" className="mt-3 w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm" autoComplete="off" />}
              <p className="mt-3 text-xs text-coral">Restoring replaces everything in this record with the bundle's contents. Your current plays are first written to backups/ as a safety copy.</p>
              <button disabled={busy} onClick={() => { if (window.confirm('Replace this record with the bundle? Current plays are backed up first.')) void run(async () => { const r = await invoke<Report>('restore_move_bundle', { path: bundle, passphrase: pw || null }); setReport(r); setMsg(`Restored ${r.tables} tables (${fmtInt(r.rows)} rows)${r.secrets_restored ? `, ${r.secrets_restored} sign-ins` : ''}. Everything was rebuilt.`); onChanged(); }); }} className="mt-3 rounded-full border border-coral/60 px-4 py-2 text-coral hover:bg-coral/10 disabled:opacity-40">{busy ? 'Restoring…' : 'Restore this bundle'}</button>
            </div>
          )}
          {report && (
            <div className="rounded-xl border border-moss/40 bg-moss/5 p-4 text-xs text-dust">
              <p className="text-sm text-cream">Done — {report.tables} tables restored.</p>
              {report.skipped_tables.length > 0 && <p className="mt-1">Skipped (not in this version): {report.skipped_tables.join(', ')}</p>}
              {report.backup_of_previous && <p className="mt-1">Previous plays saved to {report.backup_of_previous}</p>}
              {report.manifest.secrets && report.secrets_restored === 0 && <p className="mt-1 text-amber">Sign-ins were not restored (no or wrong passphrase) — reconnect on Services.</p>}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}
