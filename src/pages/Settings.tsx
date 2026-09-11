import { useEffect, useState } from 'react';
import { invoke } from '@/lib/bridge';
import type { AppStatus } from '@/lib/types';
import { useAsync, useFilter } from '@/lib/hooks';
import { THEMES } from '@/lib/theme';
import { fmtInt } from '@/lib/format';
import { Card, ErrorBox, Sleeve } from '@/components/Card';
import { Importer } from '@/components/Importer';
import { search } from '@/lib/queries';
import type { ArtistRow } from '@/lib/types';
import { sessionOverrides, travel } from '@/lib/phase7Queries';

type Activity = { at: string; task: string; level: string; message: string; detail: string | null };
type ImportRun = { import_id: string; at: string; files: number; inserted: number; duplicate: number; skipped: number };

export function SettingsPage({ status, onChanged }: { status: AppStatus; onChanged: () => void }) {
  const { theme, setTheme } = useFilter();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [gap, setGap] = useState('120');
  const [lyrics, setLyrics] = useState(false);
  const activity = useAsync(() => invoke<Activity[]>('get_activity', { limit: 60 }), [busy]);
  const imports = useAsync(() => invoke<ImportRun[]>('get_import_history'), [busy]);

  useEffect(() => {
    invoke<string[]>('list_timezones').then(setZones).catch(() => {});
    invoke<{ key: string; value: string }[]>('get_settings').then((rows) => { const g = rows.find((r) => r.key === 'attention_gap_min'); if (g) setGap(g.value); const l = rows.find((r) => r.key === 'lyrics_enabled'); setLyrics(l?.value === 'true'); }).catch(() => {});
  }, []);

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label); setErr(null); setMsg(null);
    try { await fn(); setMsg(ok); onChanged(); } catch (e) { setErr(String(e)); } finally { setBusy(null); }
  };

  return (
    <div className="mx-auto max-w-5xl">
      <Sleeve kicker="Settings" title="Your record, your machine" meta={<>{status.portable ? 'Portable mode · ' : ''}{status.dataDir}</>} />
      {msg && <div className="mb-4 rounded-xl border border-moss/40 bg-moss/5 px-4 py-3 text-sm text-moss">{msg}</div>}
      {err && <div className="mb-4"><ErrorBox message={err} /></div>}

      <div className="mb-6">
        <Card title="Skin" subtitle="Colour scheme for the whole app, charts included. Saved on this machine.">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            {THEMES.map((t) => (
              <button key={t.id} onClick={() => setTheme(t.id)} aria-pressed={theme === t.id}
                className={`rounded-xl border p-3 text-left transition ${theme === t.id ? 'border-amber' : 'border-line hover:border-dust'}`} style={{ background: t.p.ink, color: t.p.cream }}>
                <div className="mb-2 flex gap-1">{[t.p.amber, t.p.coral, t.p.moss, t.p.violet, t.p.dust].map((c, i) => <span key={i} className="h-3 w-3 rounded-full" style={{ background: c }} />)}</div>
                <p className="font-display text-base">{t.name}</p>
                <p className="text-[11px]" style={{ color: t.p.dust }}>{t.blurb}</p>
              </button>
            ))}
          </div>
        </Card>
      </div>
      <div className="grid gap-6 md:grid-cols-2">
        <Card title="Listening history" subtitle="Add a newer export any time. Only new plays are added; the rest is skipped.">
          <Importer compact onDone={onChanged} />
          {imports.data && imports.data.length > 0 && (
            <ul className="num mt-4 space-y-1 text-xs text-dust">
              {imports.data.map((r) => <li key={r.import_id}>{r.at?.slice(0, 16)} · {r.files} files · +{fmtInt(Number(r.inserted))} plays · {fmtInt(Number(r.duplicate))} duplicates</li>)}
            </ul>
          )}
        </Card>

        <div className="space-y-6">
          <Card title="Attention gap" subtitle="How long autoplay may run without you touching anything before it stops counting as listening.">
            <div className="flex items-center gap-3">
              <input type="number" min={15} max={600} step={15} value={gap} onChange={(e) => setGap(e.target.value)} className="num w-24 rounded-lg border border-line bg-ink px-3 py-2 text-sm" aria-label="Attention gap in minutes" />
              <span className="text-sm text-dust">minutes</span>
              <button disabled={!!busy} onClick={() => run('gap', async () => { await invoke('set_setting', { key: 'attention_gap_min', value: gap }); await invoke('rebuild'); }, `Attention gap set to ${gap} min and sessions rebuilt.`)}
                className="ml-auto rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">{busy === 'gap' ? 'Rebuilding…' : 'Apply'}</button>
            </div>
            <p className="mt-3 text-xs text-dust">120 minutes: a double album with no skips still counts; a laptop left on overnight does not.</p>
          </Card>

          <Card title="Lyric themes" subtitle="Fetch lyrics from LRCLIB for your most-played tracks and keep only derived themes and keywords — the text itself is never stored.">
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={lyrics} onChange={(e) => { setLyrics(e.target.checked); void run('lyrics', () => invoke('set_setting', { key: 'lyrics_enabled', value: String(e.target.checked) }), e.target.checked ? 'Lyric features enabled. They fill in a few dozen tracks every 15 minutes.' : 'Lyric features paused.'); }} />
              Enable lyric features
            </label>
            <button disabled={!!busy || !lyrics} onClick={() => run('lyricsnow', () => invoke<string>('lyrics_enrich_now').then((m) => setMsg(m)), 'Done.')} className="mt-3 rounded-full border border-line px-4 py-2 text-sm text-dust hover:text-cream disabled:opacity-40">Fetch a batch now</button>
          </Card>

          <Card title="Time zone" subtitle="Hours of the day and session boundaries are computed in this zone.">
            <select value={status.timezone} disabled={!!busy || !zones.length}
              onChange={(e) => run('tz', () => invoke('set_timezone', { zone: e.target.value }), `Time zone set to ${e.target.value}. Everything was recomputed.`)}
              className="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm">
              {(zones.length ? zones : [status.timezone]).map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <p className="mt-2 text-xs text-dust">Detected from this machine. If you've moved, plays before the move still use this zone — one zone per record for now.</p>
          </Card>

          <Card title="Data" subtitle="Everything lives in one DuckDB file. Raw plays are never modified.">
            <ul className="num space-y-1 text-xs text-dust">
              <li>{status.dbPath}</li>
              <li>{fmtInt(status.playCount)} plays{status.firstPlay ? ` · ${status.firstPlay.slice(0, 10)} → ${status.lastPlay?.slice(0, 10)}` : ''}</li>
            </ul>
            <div className="mt-4 flex flex-wrap gap-2 text-sm">
              <button disabled={!!busy} onClick={() => run('open', () => invoke('open_data_folder'), 'Opened the data folder.')} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream disabled:opacity-40">Show data folder</button>
              <button disabled={!!busy} onClick={() => run('export', async () => { const p = await invoke<string>('export_events'); setMsg(`Exported to ${p}`); }, 'Exported.')} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream disabled:opacity-40">Export all plays (Parquet)</button>
              <button disabled={!!busy} onClick={() => run('rebuild', () => invoke('rebuild'), 'Rebuilt every derived table from the raw plays.')} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream disabled:opacity-40">{busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild everything'}</button>
            </div>
            <p className="mt-3 text-xs text-dust">Portable mode: put an empty file named <span className="num">portable.flag</span> next to the app and it keeps its data in a <span className="num">data</span> folder beside it.</p>
          </Card>
        </div>
      </div>

      <div className="mt-6 grid gap-6 md:grid-cols-2">
        <Travel busy={busy} run={run} zones={zones} home={status.timezone} />
        <SessionHygiene busy={busy} run={run} />
      </div>
      <div className="mt-6">
        <MergeArtists busy={busy} run={run} />
      </div>
      <div className="mt-6">
        <Card title="Activity" subtitle="Everything the app did in the background. Failures land here, never as a crash.">
          {activity.data && activity.data.length ? (
            <ul className="divide-y divide-line/60 text-sm">
              {activity.data.map((a, i) => <li key={i} className="flex gap-4 py-2"><span className="num w-36 shrink-0 text-xs text-dust">{a.at?.slice(0, 16)}</span><span className={`w-16 shrink-0 text-xs ${a.level === 'error' ? 'text-coral' : a.level === 'warn' ? 'text-amber' : 'text-dust'}`}>{a.task}</span><span className="min-w-0 flex-1 truncate" title={a.detail ?? ''}>{a.message}</span></li>)}
            </ul>
          ) : <p className="text-sm text-dust">Nothing yet.</p>}
        </Card>
      </div>
    </div>
  );
}

type Merge = { fromId: string; intoId: string; intoName: string | null; fromName: string | null };
function MergeArtists({ busy, run }: { busy: string | null; run: (label: string, fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [qa, setQa] = useState(''); const [qb, setQb] = useState('');
  const [a, setA] = useState<ArtistRow | null>(null); const [b, setB] = useState<ArtistRow | null>(null);
  const [ra, setRa] = useState<ArtistRow[]>([]); const [rb, setRb] = useState<ArtistRow[]>([]);
  const merges = useAsync(() => invoke<Merge[]>('list_merges'), [busy]);
  useEffect(() => { if (qa.length >= 2) search(qa).then((r) => setRa(r.artists.slice(0, 6))).catch(() => {}); else setRa([]); }, [qa]);
  useEffect(() => { if (qb.length >= 2) search(qb).then((r) => setRb(r.artists.slice(0, 6))).catch(() => {}); else setRb([]); }, [qb]);
  const Pick = ({ q, setQ, res, val, setVal, label }: { q: string; setQ: (v: string) => void; res: ArtistRow[]; val: ArtistRow | null; setVal: (a: ArtistRow | null) => void; label: string }) => (
    <div>
      <p className="mb-1 text-xs text-dust">{label}</p>
      {val ? <div className="flex items-center gap-2 rounded-lg border border-line bg-ink px-3 py-1.5 text-sm"><span className="truncate">{val.artist}</span><span className="num text-xs text-dust">{val.plays} plays</span><button onClick={() => setVal(null)} className="ml-auto text-xs text-dust hover:text-cream">change</button></div>
        : <><input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="w-full rounded-lg border border-line bg-ink px-3 py-1.5 text-sm" />{res.length > 0 && <ul className="mt-1 divide-y divide-line/60 rounded-lg border border-line bg-surface text-sm">{res.map((r) => <li key={r.artistId}><button onClick={() => { setVal(r); setQ(''); }} className="flex w-full justify-between px-3 py-1.5 text-left hover:text-amber"><span className="truncate">{r.artist}</span><span className="num text-xs text-dust">{r.plays}</span></button></li>)}</ul>}</>}
    </div>
  );
  return (
    <Card title="Merge artists" subtitle="When the same artist appears under two names (a rename, a stray featuring credit), fold one into the other. Raw plays are untouched; only the canonical id changes. Reversible.">
      <div className="grid gap-3 md:grid-cols-[1fr_auto_1fr_auto] md:items-end">
        <Pick q={qa} setQ={setQa} res={ra} val={a} setVal={setA} label="Fold this…" />
        <span className="hidden text-dust md:block">→</span>
        <Pick q={qb} setQ={setQb} res={rb} val={b} setVal={setB} label="…into this" />
        <button disabled={!!busy || !a || !b || a.artistId === b.artistId} onClick={() => run('merge', () => invoke('merge_artists', { fromId: a!.artistId, intoId: b!.artistId }).then(() => { setA(null); setB(null); }), `Merged ${a?.artist} into ${b?.artist} and rebuilt.`)} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">{busy === 'merge' ? 'Rebuilding…' : 'Merge'}</button>
      </div>
      {merges.data && merges.data.length > 0 && (
        <ul className="mt-4 divide-y divide-line/60 text-sm">{merges.data.map((m) => <li key={m.fromId} className="flex items-center gap-3 py-1.5"><span className="num truncate text-xs text-dust">{m.fromName ?? m.fromId.replace('name:', '')}</span><span className="text-dust">→</span><span className="truncate">{m.intoName ?? m.intoId}</span><button disabled={!!busy} onClick={() => run('unmerge', () => invoke('unmerge_artist', { fromId: m.fromId }), 'Merge undone and rebuilt.')} className="ml-auto text-xs text-dust hover:text-coral">undo</button></li>)}</ul>
      )}
    </Card>
  );
}

function Travel({ busy, run, zones, home }: { busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok: string) => Promise<void>; zones: string[]; home: string }) {
  const t = useAsync(travel, [busy]);
  const [from, setFrom] = useState(''); const [to, setTo] = useState(''); const [zone, setZone] = useState('Europe/Istanbul'); const [note, setNote] = useState('');
  return (
    <Card title="Travel and time zones" subtitle={`Home zone ${home}. Plays made abroad use the country Spotify recorded (single-zone countries only). Add date ranges for anything else.`}>
      {t.data && <p className="num mb-3 text-xs text-dust">{t.data.byZone.map((z) => `${z.zone} ${fmtInt(z.plays)}`).join(' · ')}</p>}
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1.4fr]">
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="num rounded-lg border border-line bg-ink px-2 py-1 text-xs" aria-label="From" />
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="num rounded-lg border border-line bg-ink px-2 py-1 text-xs" aria-label="To" />
        <select value={zone} onChange={(e) => setZone(e.target.value)} className="rounded-lg border border-line bg-ink px-2 py-1 text-xs">{(zones.length ? zones : [zone]).map((z) => <option key={z} value={z}>{z}</option>)}</select>
      </div>
      <div className="mt-2 flex gap-2">
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Note (Istanbul summer)" className="flex-1 rounded-lg border border-line bg-ink px-2 py-1 text-xs" />
        <button disabled={!!busy || !from || !to || from > to} onClick={() => run('tz', () => invoke('set_tz_override', { fromDate: from, toDate: to, zone, note }), 'Travel range added; everything recomputed.')} className="rounded-full bg-amber px-3 py-1 text-xs font-medium text-ink disabled:opacity-40">Add</button>
      </div>
      {t.data && t.data.overrides.length > 0 && <ul className="mt-3 divide-y divide-line/60 text-xs">{t.data.overrides.map((o) => <li key={o.id} className="flex items-center gap-2 py-1.5"><span className="num">{o.from} → {o.to}</span><span className="text-dust">{o.zone}{o.note ? ` · ${o.note}` : ''}</span><button disabled={!!busy} onClick={() => run('tz', () => invoke('set_tz_override', { fromDate: o.from, toDate: o.to, zone: o.zone, removeId: o.id }), 'Removed; recomputed.')} className="ml-auto text-dust hover:text-coral">remove</button></li>)}</ul>}
    </Card>
  );
}
function SessionHygiene({ busy, run }: { busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const o = useAsync(sessionOverrides, [busy]);
  return (
    <Card title="Session hygiene" subtitle="Sessions you marked by hand. Use the buttons on any session page (Sessions → open one → “Mark unattended”).">
      {o.data && o.data.length ? <ul className="divide-y divide-line/60 text-sm">{o.data.map((s) => <li key={s.startAt} className="flex items-center gap-3 py-1.5"><span className="num text-xs">{s.startAt.slice(0, 16)}</span><span className={s.attention === 'unattended' ? 'text-violet' : 'text-moss'}>{s.attention}</span><button disabled={!!busy} onClick={() => run('sess', () => invoke('set_session_attention', { startAt: s.startAt, attention: null }), 'Override removed; recomputed.')} className="ml-auto text-xs text-dust hover:text-coral">undo</button></li>)}</ul> : <p className="text-sm text-dust">None yet.</p>}
    </Card>
  );
}
