import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@/lib/bridge';
import type { AppStatus } from '@/lib/types';
import { useAsync, useDebounced, useFilter, useSettings } from '@/lib/hooks';
import { ERA_BOUNDS, ERA_KEYS, ERA_PRESETS, eraParamsFromSettings, matchingPreset, sanitizeEraParams, type EraParams } from '@/lib/eraParams';
import { TUNING, loadSettings, type Tunable } from '@/lib/settings';
import { eraDiagnostic, eras } from '@/lib/insightQueries';
import { storage, fmtBytes } from '@/lib/storageQueries';
import { fmtStamp } from '@/lib/format';
import { THEMES } from '@/lib/theme';
import { fmtInt } from '@/lib/format';
import { Card, ErrorBox, Sleeve } from '@/components/Card';
import { Importer } from '@/components/Importer';
import { SceneEditor } from '@/components/SceneEditor';
import { MoveCard } from '@/components/MoveCard';
import { WeatherSettingsCard } from '@/components/WeatherCards';
import { IsrcDuplicatesCard, SourceCoverageCard } from '@/components/SourceCoverageCard';
import { search } from '@/lib/queries';
import type { ArtistRow } from '@/lib/types';
import { sessionOverrides, travel } from '@/lib/phase7Queries';
import { integrity, overrunPlays, shortTrackOutliers, stuckRepeatSessions } from '@/lib/hygieneQueries';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { SkipHallPage } from '@/pages/SkipHall';
import { DENSITIES, loadDensity, rootPx, saveDensity, type Density } from '@/lib/display';
import { ERA_STYLE_DEFAULT, PALETTES, loadEraStyle, saveEraStyle, type EraFill, type EraPalette, type EraStyle } from '@/lib/eraStyle';
import { fmtDate, fmtPct, trackHref } from '@/lib/format';

type ImportRun = { import_id: string; at: string; files: number; inserted: number; duplicate: number; skipped: number };

type Tab = 'look' | 'record' | 'tuning' | 'connectors' | 'hygiene' | 'notforme';
const TABS: { id: Tab; label: string; blurb: string }[] = [
  { id: 'look', label: 'Appearance', blurb: 'Skins.' },
  { id: 'record', label: 'Record', blurb: 'Your history, time zones, data.' },
  { id: 'tuning', label: 'Tuning', blurb: 'Eras, scenes, sessions and discovery thresholds.' },
  { id: 'connectors', label: 'Connectors', blurb: 'Budgets and batch sizes for the background jobs.' },
  { id: 'hygiene', label: 'Hygiene', blurb: 'Outliers, corrected sessions, merged artists.' },
  { id: 'notforme', label: 'Not for me', blurb: 'Songs you keep being shown and keep skipping (moved here from the sidebar in 9h).' },
];

export function SettingsPage({ status, onChanged }: { status: AppStatus; onChanged: () => void }) {
  const { theme, setTheme } = useFilter();
  // Phase 9h: the tab follows the URL (so /settings?tab=notforme works while Settings is already open) and writes it back
  const loc = useLocation(); const nav = useNavigate();
  const urlTab = (new URLSearchParams(loc.search).get('tab') as Tab) || 'look';
  const tab: Tab = TABS.some((t) => t.id === urlTab) ? urlTab : 'look';
  const setTab = (t: Tab) => nav({ pathname: '/settings', search: `?tab=${t}` }, { replace: true });
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [zones, setZones] = useState<string[]>([]);
  const [lyrics, setLyrics] = useState(false);
  const imports = useAsync(() => invoke<ImportRun[]>('get_import_history'), [busy]);

  useEffect(() => {
    invoke<string[]>('list_timezones').then(setZones).catch(() => {});
    invoke<{ key: string; value: string }[]>('get_settings').then((rows) => { const l = rows.find((r) => r.key === 'lyrics_enabled'); setLyrics(l?.value === 'true'); }).catch(() => {});
  }, []);

  const run = async (label: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(label); setErr(null); setMsg(null);
    try { await fn(); await loadSettings(); setMsg(ok); onChanged(); } catch (e) { setErr(String(e)); } finally { setBusy(null); }
  };
  const last = imports.data?.[0];

  return (
    <div className="mx-auto max-w-5xl">
      <Sleeve kicker="Settings" title="Your record, your machine" meta={<>{status.portable ? 'Portable mode · ' : ''}{status.dataDir} · <Link to="/activity" className="underline hover:text-cream">Activity log</Link></>} />
      <div className="mb-6 flex flex-wrap gap-2" role="tablist">
        {TABS.map((t) => <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)} title={t.blurb} className={`rounded-full px-4 py-1.5 text-sm ${tab === t.id ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{t.label}</button>)}
      </div>
      {msg && <div className="mb-4 rounded-xl border border-moss/40 bg-moss/5 px-4 py-3 text-sm text-moss">{msg}</div>}
      {err && <div className="mb-4"><ErrorBox message={err} /></div>}

      {tab === 'look' && <DisplaySize />}
      {tab === 'look' && <EraStyleCard />}
      {tab === 'look' && (
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
      )}

      {tab === 'record' && (
        <div className="grid gap-6 md:grid-cols-2">
          <Card title="Listening history" subtitle={last ? `Last import ${fmtStamp(last.at, { month: 'short', day: 'numeric', year: 'numeric' })} · +${fmtInt(Number(last.inserted))} plays. Only new plays are ever added.` : 'Add a Spotify export; only new plays are added.'}>
            <Importer compact onDone={onChanged} />
            {imports.data && imports.data.length > 1 && <p className="mt-3 text-xs text-dust">{imports.data.length} imports so far — the full list is on <Link to="/activity" className="underline hover:text-cream">Activity</Link>.</p>}
          </Card>
          <Card title="Time zone" subtitle="Hours of the day and session boundaries are computed in this zone.">
            <select value={status.timezone} disabled={!!busy || !zones.length}
              onChange={(e) => run('tz', () => invoke('set_timezone', { zone: e.target.value }), `Time zone set to ${e.target.value}. Everything was recomputed.`)}
              className="w-full rounded-lg border border-line bg-ink px-3 py-2 text-sm">
              {(zones.length ? zones : [status.timezone]).map((z) => <option key={z} value={z}>{z}</option>)}
            </select>
            <p className="mt-2 text-xs text-dust">Detected from this machine. Plays made abroad use travel ranges below.</p>
          </Card>
          <Travel busy={busy} run={run} zones={zones} home={status.timezone} />
          <StorageCard />
          <Card title="Data" subtitle="Everything lives in one DuckDB file. Raw plays are never modified.">
            <ul className="num space-y-1 text-xs text-dust">
              <li>{status.dbPath}</li>
              <li>{fmtInt(status.playCount)} plays{status.firstPlay ? ` · ${status.firstPlay.slice(0, 10)} → ${status.lastPlay?.slice(0, 10)}` : ''}</li>
            </ul>
            <div className="mt-4 flex flex-wrap gap-2 text-sm">
              <button disabled={!!busy} onClick={() => run('open', () => invoke('open_data_folder'), 'Opened the data folder.')} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream disabled:opacity-40">Show data folder</button>
              <button disabled={!!busy} onClick={() => run('export', async () => { const p = await invoke<string>('export_events'); setMsg(`Exported to ${p}`); }, 'Exported.')} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream disabled:opacity-40">Export all plays (Parquet)</button>
              <button disabled={!!busy} onClick={() => run('exportall', async () => { const p = await invoke<string>('export_record', { destDir: null, format: 'csv' }); setMsg(`Everything exported (CSV) to ${p}`); }, 'Exported.')} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream disabled:opacity-40" title="Every table plus plays_enriched — one row per play with origin, scene, tags, art, audio and lyric features. Opens in any spreadsheet.">Export everything (CSV)</button>
              <button disabled={!!busy} onClick={() => run('exportallpq', async () => { const p = await invoke<string>('export_record', { destDir: null, format: 'parquet' }); setMsg(`Everything exported (Parquet) to ${p}`); }, 'Exported.')} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream disabled:opacity-40">…as Parquet</button>
              <button disabled={!!busy} onClick={() => run('rebuild', () => invoke('rebuild'), 'Rebuilt every derived table from the raw plays.')} className="rounded-full border border-line px-4 py-2 text-dust hover:text-cream disabled:opacity-40">{busy === 'rebuild' ? 'Rebuilding…' : 'Rebuild everything'}</button>
            </div>
            <p className="mt-3 text-xs text-dust">Portable mode: put an empty file named <span className="num">portable.flag</span> next to the app and it keeps its data in a <span className="num">data</span> folder beside it.</p>
          </Card>
          <div className="md:col-span-2"><SourceCoverageCard /></div>
          <div className="md:col-span-2"><WeatherSettingsCard /></div>
          <div className="md:col-span-2"><MoveCard onChanged={onChanged} /></div>
        </div>
      )}

      {tab === 'tuning' && (
        <div className="space-y-6">
          <EraTuning />
          <SceneEditor />
          <TuningGroup group="sessions" title="Sessions" subtitle="Attention, skips and the session-shape rules. These are baked into the session table, so changes apply after a rebuild (a few seconds)." busy={busy} run={run} />
          <div className="grid gap-6 md:grid-cols-2">
            <TuningGroup group="discovery" title="Discovery and tags" subtitle="Read live by Discover, genre browse and genre threads — no rebuild." busy={busy} run={run} />
            <TuningGroup group="threads" title="Genre threads and Not for me" subtitle="Phase 9g: the detection rules behind the threads on Eras and the bar for Not for me. Read live — no rebuild." busy={busy} run={run} />
            <Preferences busy={busy} run={run} />
          </div>
        </div>
      )}

      {tab === 'connectors' && (
        <div className="grid gap-6 md:grid-cols-2">
          <EnrichmentQuota busy={busy} run={run} />
          <Card title="Lyric themes" subtitle="Fetch lyrics from LRCLIB for your most-played tracks and keep only derived themes and keywords — the text itself is never stored.">
            <label className="flex items-center gap-3 text-sm">
              <input type="checkbox" checked={lyrics} onChange={(e) => { setLyrics(e.target.checked); void run('lyrics', () => invoke('set_setting', { key: 'lyrics_enabled', value: String(e.target.checked) }), e.target.checked ? 'Lyric features enabled.' : 'Lyric features paused.'); }} />
              Enable lyric features
            </label>
            <LyricsV2 enabled={lyrics} busy={busy} run={run} />
            <button disabled={!!busy || !lyrics} onClick={() => run('lyricsnow', () => invoke<string>('lyrics_enrich_now').then((m) => setMsg(m)), 'Done.')} className="mt-3 rounded-full border border-line px-4 py-2 text-sm text-dust hover:text-cream disabled:opacity-40">Fetch a batch now</button>
          </Card>
          <TuningGroup group="connectors" title="Batch sizes" subtitle="Speed against politeness for the background connectors." busy={busy} run={run} />
          <OllamaCard busy={busy} run={run} />
          <Card title="Services" subtitle="Keys, connections and sync live on their own page."><Link to="/services" className="text-sm text-amber hover:underline">Open Services →</Link></Card>
        </div>
      )}

      {tab === 'notforme' && <SkipHallPage embedded />}
      {tab === 'hygiene' && (
        <div className="space-y-6">
          <IsrcDuplicatesCard />
          <ReviewOutliers busy={busy} run={run} />
          <SessionHygiene busy={busy} run={run} />
          <MergeArtists busy={busy} run={run} />
        </div>
      )}
    </div>
  );
}

/** Phase 9c: one card per TUNING group — a bounded slider per setting, saved together; session-group changes trigger a rebuild. */
function TuningGroup({ group, title, subtitle, busy, run }: { group: Tunable['group']; title: string; subtitle: string; busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const settings = useSettings();
  const items = TUNING.filter((t) => t.group === group);
  const stored = useMemo(() => Object.fromEntries(items.map((t) => { const r = settings.data?.find((x) => x.key === t.key); const v = Number(r?.value); return [t.key, Number.isFinite(v) && r ? v : t.def]; })), [settings.data, items]);
  const [draft, setDraft] = useState<Record<string, number> | null>(null);
  const v = draft ?? stored;
  const dirty = items.filter((t) => v[t.key] !== stored[t.key]);
  const needsRebuild = dirty.some((t) => t.rebuild);
  const apply = () => run(group, async () => { for (const t of dirty) await invoke('set_setting', { key: t.key, value: String(v[t.key]) }); if (needsRebuild) await invoke('rebuild'); settings.reload(); setDraft(null); }, needsRebuild ? `${dirty.length} setting${dirty.length === 1 ? '' : 's'} saved and sessions rebuilt.` : `${dirty.length} setting${dirty.length === 1 ? '' : 's'} saved.`);
  return (
    <Card title={title} subtitle={subtitle} aside={<div className="flex gap-2">{dirty.length > 0 && <button onClick={() => setDraft(null)} className="text-xs text-dust hover:text-cream">discard</button>}<button disabled={!!busy || !dirty.length} onClick={apply} className="rounded-full bg-amber px-4 py-1.5 text-xs font-medium text-ink disabled:opacity-40">{busy === group ? (needsRebuild ? 'Rebuilding…' : 'Saving…') : needsRebuild ? 'Apply & rebuild' : 'Apply'}</button></div>}>
      <div className="grid gap-4 md:grid-cols-2">
        {items.map((t) => (
          <div key={t.key}>
            <div className="flex items-baseline justify-between text-sm"><label htmlFor={`tune-${t.key}`}>{t.label}</label><span className="num text-xs text-cream">{t.step < 1 ? v[t.key].toFixed(2) : v[t.key]}{t.unit ? ` ${t.unit}` : ''}{v[t.key] !== t.def && <button onClick={() => setDraft({ ...v, [t.key]: t.def })} className="ml-2 text-dust hover:text-cream" title={`Reset to ${t.def}`}>↺</button>}</span></div>
            <input id={`tune-${t.key}`} type="range" min={t.min} max={t.max} step={t.step} value={v[t.key]} onChange={(e) => setDraft({ ...v, [t.key]: Number(e.target.value) })} className="mt-1 w-full accent-amber" />
            <p className="mt-0.5 text-[11px] text-dust/80">{t.why}</p>
          </div>
        ))}
      </div>
    </Card>
  );
}

/** Two non-numeric preferences from the roadmap: playlist default visibility and remembering the last Mixtape mix. */
function Preferences({ busy, run }: { busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const settings = useSettings();
  const pub = settings.data?.find((r) => r.key === 'playlist_default_public')?.value === 'true';
  const remember = settings.data?.find((r) => r.key === 'mixtape_last_mix');
  return (
    <Card title="Preferences" subtitle="Small defaults that save a click.">
      <label className="flex items-start gap-3 text-sm"><input type="checkbox" checked={pub} disabled={!!busy} onChange={(e) => run('pref', async () => { await invoke('set_setting', { key: 'playlist_default_public', value: String(e.target.checked) }); settings.reload(); }, e.target.checked ? 'New playlists default to public.' : 'New playlists default to private.')} /><span>New Spotify playlists default to <span className="text-cream">{pub ? 'public' : 'private'}</span><span className="block text-xs text-dust">The toggle in every playlist preview still overrides this per playlist.</span></span></label>
      <p className="mt-4 text-sm">Mixtape remembers your last mix{remember ? <span className="text-xs text-dust"> — currently {remember.value.replace(/[{}"]/g, '').replace(/,/g, ' · ')}</span> : <span className="text-xs text-dust"> — nothing saved yet; it will remember the next mix you build.</span>}</p>
      {remember && <button disabled={!!busy} onClick={() => run('pref', async () => { await invoke('set_setting', { key: 'mixtape_last_mix', value: '' }); settings.reload(); }, 'Mixtape reset to 40 / 20 / 20 / 20.')} className="mt-2 text-xs text-dust hover:text-coral">forget it</button>}
    </Card>
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

/** Phase 8 (roadmap §3.6): the outlier classes the "So Excited" bug exposed, reviewable in one place. */
function ReviewOutliers({ busy, run }: { busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const [tab, setTab] = useState<'stuck' | 'short' | 'overrun'>('stuck');
  const integ = useAsync(integrity, [busy]);
  const stuck = useAsync(stuckRepeatSessions, [busy]);
  const short = useAsync(shortTrackOutliers, [busy]);
  const over = useAsync(overrunPlays, [busy]);
  const i = integ.data;
  const pill = (k: typeof tab, l: string, n?: number) => <button key={k} onClick={() => setTab(k)} className={`rounded-full px-3 py-1.5 text-xs ${tab === k ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{l}{n !== undefined ? ` · ${fmtInt(n)}` : ''}</button>;
  return (
    <Card title="Review outliers" subtitle="Things that inflate the numbers without being listening. Mark a session unattended and every total, streak and record recomputes; the Attentive lens then hides it everywhere.">
      {i && (
        <ul className="num mb-4 grid gap-2 text-xs text-dust sm:grid-cols-3 lg:grid-cols-6">
          <li><span className="block font-display text-xl text-cream">{fmtInt(i.stuckSessions)}</span>stuck-repeat sessions · {i.stuckHours.toFixed(1)} h</li>
          <li><span className="block font-display text-xl text-cream">{fmtPct(i.unattendedShare)}</span>of plays unattended</li>
          <li><span className={`block font-display text-xl ${i.impossibleDays ? 'text-coral' : 'text-cream'}`}>{fmtInt(i.impossibleDays)}</span>days over 24 h of music</li>
          <li><span className="block font-display text-xl text-cream">{fmtInt(i.overrunPlays)}</span>plays longer than the song</li>
          <li><span className="block font-display text-xl text-cream">{fmtPct(i.enrichedShare)}</span>tracks enriched</li>
          <li><span className="block font-display text-xl text-cream">{fmtInt(i.overriddenSessions)}</span>sessions corrected by hand</li>
        </ul>
      )}
      <div className="mb-3 flex flex-wrap gap-2">{pill('stuck', 'Stuck on repeat', stuck.data?.length)}{pill('short', 'Short tracks, big counts', short.data?.length)}{pill('overrun', 'Played longer than the song', over.data?.length)}</div>
      {tab === 'stuck' && (!stuck.data ? <p className="text-sm text-dust">Looking…</p> : stuck.data.length === 0 ? <p className="text-sm text-dust">No stuck-repeat sessions. The record is clean of this class.</p> : (
        <ul className="divide-y divide-line/60 text-sm">
          {stuck.data.map((s) => (
            <li key={s.sessionId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <Link to={`/sessions/${s.sessionId}`} className="num w-36 shrink-0 text-xs text-dust hover:text-amber">{fmtDate(s.startAt, { month: 'short', day: 'numeric', year: 'numeric' })}</Link>
              <span className="min-w-0 flex-1 truncate">{s.trackId ? <Link to={trackHref(s.trackId)} className="hover:text-amber">{s.track}</Link> : s.track}<span className="ml-2 text-xs text-dust">{s.artist}</span></span>
              <span className="num shrink-0 text-xs text-dust">{fmtInt(s.plays)}× · {fmtInt(s.minutes)} min</span>
              <span className={`num shrink-0 text-xs ${s.attention === 'unattended' ? 'text-violet' : 'text-amber'}`}>{s.attention}{s.overridden ? ' (by hand)' : ''}</span>
              {s.attention !== 'unattended'
                ? <button disabled={!!busy} onClick={() => run('sess', () => invoke('set_session_attention', { startAt: s.startAt, attention: 'unattended' }), 'Marked unattended; recomputed.')} className="rounded-full border border-line px-3 py-1 text-xs text-dust hover:text-cream disabled:opacity-40">Mark unattended</button>
                : <button disabled={!!busy} onClick={() => run('sess', () => invoke('set_session_attention', { startAt: s.startAt, attention: 'active' }), 'Marked as listened; recomputed.')} className="text-xs text-dust hover:text-cream">it was me</button>}
            </li>
          ))}
        </ul>
      ))}
      {tab === 'short' && (!short.data ? <p className="text-sm text-dust">Looking…</p> : short.data.length === 0 ? <p className="text-sm text-dust">No short tracks with suspicious play counts.</p> : (
        <ul className="divide-y divide-line/60 text-sm">
          {short.data.map((t) => (
            <li key={t.trackId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1 truncate"><Link to={trackHref(t.trackId)} className="hover:text-amber">{t.track}</Link><span className="ml-2 text-xs text-dust">{t.artist} · {t.durationS}s</span></span>
              <span className="num shrink-0 text-xs text-dust">{fmtInt(t.plays)} plays · {fmtInt(t.attendedPlays)} attended</span>
              <Link to={`/day/${t.topDay}`} className="num shrink-0 text-xs text-amber hover:underline">{fmtInt(t.topDayPlays)}× on {t.topDay}</Link>
            </li>
          ))}
        </ul>
      ))}
      {tab === 'overrun' && (!over.data ? <p className="text-sm text-dust">Looking…</p> : over.data.length === 0 ? <p className="text-sm text-dust">Every play fits inside its song.</p> : (
        <ul className="divide-y divide-line/60 text-sm">
          {over.data.map((t) => (
            <li key={t.trackId} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 truncate"><Link to={trackHref(t.trackId)} className="hover:text-amber">{t.track}</Link><span className="ml-2 text-xs text-dust">{t.artist}</span></span>
              <span className="num shrink-0 text-xs text-dust">{fmtInt(t.plays)} play{t.plays === 1 ? '' : 's'} · worst {Math.round(t.worstMs / 1000)}s vs {Math.round(t.durationMs / 1000)}s</span>
            </li>
          ))}
        </ul>
      ))}
      <p className="mt-3 text-xs text-dust/70">Stuck on repeat = the same track completing naturally 8+ times in a row with no clicks between. Short tracks are ranked by their single busiest day — a loop is a spike, a jingle you love is spread out. Overruns are usually a clock glitch or wrong metadata, listed so you know they exist.</p>
    </Card>
  );
}

/** Phase 9b (design brief §3.5): the four weekly-era knobs, as presets plus bounded sliders with a live preview. Eras aren't materialised, so there's nothing to rebuild — every move re-runs the query. */
function EraTuning() {
  const settings = useSettings();
  const [p, setP] = useState<EraParams | null>(null);
  useEffect(() => { if (settings.data && !p) setP(eraParamsFromSettings(settings.data)); }, [settings.data, p]);
  const live = useDebounced(p, 350);
  const preview = useAsync(async () => { if (!live) return null; const [e, d] = await Promise.all([eras(live), eraDiagnostic(live, 52)]); return { eras: e, weeks: d }; }, [live]);
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    if (!live || !settings.data) return;
    const stored = eraParamsFromSettings(settings.data);
    const changed = (Object.keys(ERA_KEYS) as (keyof EraParams)[]).filter((k) => stored[k] !== live[k]);
    if (!changed.length) return;
    Promise.all(changed.map((k) => invoke('set_setting', { key: ERA_KEYS[k], value: String(live[k]) }))).then(() => { setSaved(new Date().toLocaleTimeString()); settings.reload(); }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);
  if (!p) return <Card title="Eras"><p className="text-sm text-dust">Loading…</p></Card>;
  const preset = matchingPreset(p);
  const set = (k: keyof EraParams, v: number) => setP(sanitizeEraParams({ ...p, [k]: v }));
  const lens = preview.data?.eras.map((e) => e.weeks).sort((a, b) => a - b) ?? [];
  const median = lens.length ? lens[Math.floor(lens.length / 2)] : 0;
  const verdict = !preview.data ? null : preview.data.eras.length <= 2 ? 'Everything is one blob — raise the similarity threshold or shorten the minimum era.' : median <= 3 ? 'Every few weeks is its own era — lower the threshold or lengthen the minimum.' : 'Looks textured: a mix of short and long stretches.';
  return (
    <Card title="Eras" subtitle="How the Eras timeline is cut into eras. Weekly grain; the recommended bundle came from a benchmark on a real record and won't suit every listener, so tune it here and watch the count respond." aside={saved ? <span className="text-xs text-moss">saved {saved}</span> : undefined}>
      <div className="grid gap-6 lg:grid-cols-[1fr_1.1fr]">
        <div>
          <div className="mb-4 flex flex-wrap gap-2">
            {ERA_PRESETS.map((x) => (
              <button key={x.id} onClick={() => setP({ ...x.params })} aria-pressed={preset?.id === x.id} className={`rounded-xl border px-3 py-2 text-left transition ${preset?.id === x.id ? 'border-amber bg-amber/5' : 'border-line hover:border-dust'}`}>
                <p className="text-sm">{x.name}</p><p className="text-[11px] text-dust">{x.blurb}</p>
              </button>
            ))}
            {!preset && <span className="self-center rounded-full border border-line px-3 py-1 text-xs text-dust">custom</span>}
          </div>
          <div className="space-y-4">
            {(Object.keys(ERA_BOUNDS) as (keyof EraParams)[]).map((k) => { const b = ERA_BOUNDS[k]; return (
              <div key={k}>
                <div className="flex items-baseline justify-between text-sm"><label htmlFor={`era-${k}`}>{b.label}</label><span className="num text-xs text-cream">{k === 'similarity' ? p[k].toFixed(3) : p[k]}{b.unit ? ` ${b.unit}` : ''}</span></div>
                <input id={`era-${k}`} type="range" min={b.min} max={b.max} step={b.step} value={p[k]} onChange={(e) => set(k, Number(e.target.value))} className="mt-1 w-full accent-amber" />
                <p className="mt-0.5 text-[11px] text-dust/80">{b.why}</p>
              </div>
            ); })}
          </div>
          <p className="mt-4 text-xs text-dust/70">The knobs interact: a lower threshold wants a longer minimum era. If the preview says every week is its own era, you've gone too far — pick a preset to come back.</p>
        </div>
        <div className="rounded-xl border border-line bg-ink/40 p-4">
          {!preview.data ? <p className="text-sm text-dust">Re-cutting the timeline…</p> : (
            <div>
              <p className="font-display text-3xl">{preview.data.eras.length} <span className="text-base text-dust">eras</span>{lens.length > 0 && <span className="num ml-3 text-sm text-dust">{lens[0]}–{lens[lens.length - 1]} weeks · median {median}</span>}</p>
              <p className={`mt-1 text-xs ${preview.data.eras.length <= 2 || median <= 3 ? 'text-coral' : 'text-moss'}`}>{verdict}</p>
              <p className="mt-4 text-xs text-dust">Last 52 weeks — each cell is one week; an amber cell opened a new era before merging.</p>
              <div className="mt-2 flex flex-wrap gap-0.5">{preview.data.weeks.map((w) => <span key={w.week} title={`${w.week}: ${w.hours.toFixed(1)} h · similarity ${w.cosToPrev?.toFixed(3) ?? '—'}`} className={`h-4 w-3 rounded-sm ${w.breaks ? 'bg-amber' : 'bg-raised'}`} />)}</div>
              <ul className="mt-4 space-y-1.5 text-sm">{preview.data.eras.slice(0, 6).map((e) => <li key={e.start} className="flex items-baseline gap-3"><span className="num w-24 shrink-0 text-xs text-dust">{e.start.slice(0, 7)} · {e.weeks}w</span><span className="truncate">{e.name}</span></li>)}{preview.data.eras.length > 6 && <li className="text-xs text-dust">and {preview.data.eras.length - 6} more</li>}</ul>
              <Link to="/eras" className="mt-3 inline-block text-xs text-dust underline hover:text-cream">See them on Eras</Link>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Phase 9b: the Spotify enrichment ceiling, exposed. Polling and enrichment share one daily quota; enrichment is retryable forever, a missed poll is a lost play. Default lowered 200 → 100 for headroom. */
function EnrichmentQuota({ busy, run }: { busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const settings = useSettings();
  const stored = useMemo(() => Number(settings.data?.find((r) => r.key === 'enrich_per_hour')?.value ?? 100) || 100, [settings.data]);
  const [v, setV] = useState<number | null>(null);
  const val = v ?? stored;
  return (
    <Card title="Spotify enrichment budget" subtitle="Track-metadata calls per hour. Polling for new plays is never throttled by this; it only caps the background enrichment that shares Spotify's daily quota with it.">
      <div className="flex items-center gap-3">
        <input type="range" min={25} max={300} step={25} value={val} onChange={(e) => setV(Number(e.target.value))} className="flex-1 accent-amber" aria-label="Enrichment calls per hour" />
        <span className="num w-24 text-right text-sm">{val} / hour</span>
        <button disabled={!!busy || val === stored} onClick={() => run('enrich', async () => { await invoke('set_setting', { key: 'enrich_per_hour', value: String(val) }); settings.reload(); }, `Enrichment capped at ${val} calls an hour.`)} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">Apply</button>
      </div>
      <p className="mt-3 text-xs text-dust">100 is the safe default: enough to work through a library over a few weeks while leaving room for the 20-minute poll every day. Raise it if enrichment is the only thing you're waiting on; lower it if the Activity log shows quota pauses.</p>
    </Card>
  );
}

/** Phase 9e: what the record costs on disk. File size is exact; per-group bytes are estimated from row × column counts. */
function StorageCard() {
  const st = useAsync(storage, []);
  const [open, setOpen] = useState(false);
  if (st.error) return <Card title="Stored data"><ErrorBox message={st.error} /></Card>;
  if (!st.data) return <Card title="Stored data"><p className="text-sm text-dust">Measuring…</p></Card>;
  const d = st.data; const max = Math.max(...d.groups.map((g) => g.bytes), 1);
  return (
    <Card title="Stored data" subtitle={`${fmtBytes(d.fileBytes)} on disk${d.walBytes > 0 ? ` (+ ${fmtBytes(d.walBytes)} pending writes)` : ''} · ${fmtInt(d.imported.events)} raw plays kept forever, ${fmtInt(d.imported.plays)} resolved. Per-group sizes are estimates.`}>
      <ul className="space-y-2 text-sm">
        {d.groups.map((g) => <li key={g.group}><div className="flex items-baseline justify-between"><span>{g.group}</span><span className="num text-xs text-dust">~{fmtBytes(g.bytes)} · {fmtInt(g.rows)} rows</span></div><div className="mt-1 h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/70" style={{ width: `${(g.bytes / max) * 100}%` }} /></div></li>)}
      </ul>
      <p className="num mt-3 text-xs text-dust">Sources: {d.imported.sources.map((s) => `${s.source} ${fmtInt(s.n)}`).join(' · ')}</p>
      <button onClick={() => setOpen(!open)} className="mt-2 text-xs text-dust hover:text-cream">{open ? '▾' : '▸'} every table</button>
      {open && <table className="num mt-2 w-full text-left text-xs"><tbody>{d.tables.filter((t) => t.rows > 0).map((t) => <tr key={t.table} className="border-t border-line/60"><td className="py-1 font-sans">{t.table}</td><td className="py-1 text-right text-dust">{fmtInt(t.rows)}</td><td className="py-1 text-right text-dust">~{fmtBytes(t.estBytes)}</td></tr>)}</tbody></table>}
      <p className="mt-3 text-[11px] text-dust/70">Everything except the raw plays and your own decisions can be rebuilt; connector caches refill on their own. A Parquet export of the raw plays is typically a tenth of the database size.</p>
    </Card>
  );
}

/** Phase 9e: where the local model lives. Default is Ollama's own port on this machine; a Docker deployment points it at the host. */
function OllamaCard({ busy, run }: { busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const settings = useSettings();
  const stored = settings.data?.find((r) => r.key === 'ollama_url')?.value ?? '';
  const [v, setV] = useState<string | null>(null);
  const val = v ?? stored;
  const st = useAsync(() => invoke<{ reachable: boolean; url: string; models: string[]; error: string | null }>('llm_status'), [stored]);
  return (
    <Card title="Local model (Ollama)" subtitle="Ask the archive talks to Ollama over HTTP. Nothing leaves this machine unless you point this at another one.">
      <div className="flex items-center gap-2"><input value={val} onChange={(e) => setV(e.target.value)} placeholder="http://127.0.0.1:11434" className="num flex-1 rounded-lg border border-line bg-ink px-3 py-2 text-sm" aria-label="Ollama URL" /><button disabled={!!busy || val === stored} onClick={() => run('ollama', async () => { await invoke('set_setting', { key: 'ollama_url', value: val.trim() }); settings.reload(); }, 'Ollama URL saved.')} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">Save</button></div>
      <p className={`mt-2 text-xs ${st.data?.reachable ? 'text-moss' : 'text-dust'}`}>{!st.data ? 'checking…' : st.data.reachable ? `Reachable · ${st.data.models.length} model${st.data.models.length === 1 ? '' : 's'}: ${st.data.models.join(', ') || 'none pulled yet'}` : `Not reachable at ${st.data.url}${st.data.error ? ` — ${st.data.error.slice(0, 100)}` : ''}`}</p>
      <p className="mt-2 text-[11px] text-dust/70">In Docker, set <span className="num">OLLAMA_URL=http://host.docker.internal:11434</span> (or the host's LAN address) — the container proxies to it.</p>
    </Card>
  );
}

/** Phase 9f: lyric features v2 — progress of the re-analysis and the optional local-model theming. */
function LyricsV2({ enabled, busy, run }: { enabled: boolean; busy: string | null; run: (l: string, fn: () => Promise<unknown>, ok: string) => Promise<void> }) {
  const st = useAsync(() => invoke<{ oldRules: number; current: number; never: number; llmEnabled: boolean }>('lyrics_status'), [busy]);
  if (!st.data) return null;
  const d = st.data;
  return (
    <div className="mt-3 space-y-2 text-xs text-dust">
      <p>New in this build: keywords are scored against your whole lyric corpus (so “love” and “night” stop being everyone's keyword), themes need several cues before they fire, and each song gets a valence, a repetition score and a language. {d.oldRules > 0 ? <>{fmtInt(d.oldRules)} songs still carry the old features and are re-fetched a batch at a time; {fmtInt(d.current)} are done.</> : <>{fmtInt(d.current)} songs analysed under the new rules.</>}{d.never > 0 && <> {fmtInt(d.never)} played tracks not looked up yet.</>}</p>
      <label className="flex items-center gap-3 text-sm text-cream">
        <input type="checkbox" checked={d.llmEnabled} disabled={!enabled || !!busy} onChange={(e) => void run('lyricsllm', () => invoke('set_setting', { key: 'lyrics_llm_enabled', value: String(e.target.checked) }), e.target.checked ? 'The local model will name themes and a mood for each English song as it is fetched.' : 'Local-model theming off.')} />
        Let the local model (Ollama) name themes and a mood too
      </label>
      <p>The text is shown to the model on this machine and discarded — only its 3–5 theme phrases and one mood line are kept. Needs a model picked in the Ollama card. Slower: a few seconds per song.</p>
    </div>
  );
}

/** Phase 9h — Settings → Appearance → Display size. Scales the whole UI (type, spacing, cards) via the root font size. */
function DisplaySize() {
  const [d, setD] = useState<Density>(loadDensity);
  const [px, setPx] = useState(rootPx());
  const pick = (x: Density) => { saveDensity(x); setD(x); setPx(rootPx(x)); };
  return (
    <Card title="Display size" subtitle={`Scales text, spacing and charts together. Now ${px} px${d === 'auto' ? ` — chosen for this ${window.innerWidth}×${window.innerHeight} window` : ''}. Saved on this machine.`} className="mb-6">
      <div className="flex flex-wrap gap-2">
        {DENSITIES.map((x) => (
          <button key={x.id} onClick={() => pick(x.id)} aria-pressed={d === x.id} title={x.blurb}
            className={`rounded-xl border px-4 py-2 text-left ${d === x.id ? 'border-amber text-cream' : 'border-line text-dust hover:text-cream'}`}>
            <span className="block text-sm">{x.label}</span><span className="block text-[11px] text-dust">{x.px ? `${x.px} px` : 'fits the window'}</span>
          </button>
        ))}
      </div>
    </Card>
  );
}

/** Phase 9i — Settings → Appearance → Eras chart: gaps, palette, fill, height, week width. Saved on this machine. */
function EraStyleCard() {
  const [st, setSt] = useState<EraStyle>(loadEraStyle);
  const set = (patch: Partial<EraStyle>) => { const n = { ...st, ...patch }; setSt(n); saveEraStyle(n); };
  const Slider = ({ label, k, min, max, step, fmt }: { label: string; k: 'gap' | 'bandGap' | 'height' | 'weekWidth'; min: number; max: number; step: number; fmt: (v: number) => string }) => (
    <label className="block text-xs text-dust">{label} <span className="num text-cream">{fmt(st[k])}</span>
      <input type="range" min={min} max={max} step={step} value={st[k]} onChange={(e) => set({ [k]: Number(e.target.value) } as Partial<EraStyle>)} className="mt-1 w-full accent-amber" />
    </label>
  );
  const pal = PALETTES[st.palette];
  return (
    <Card title="Eras chart" subtitle="How the Areas view on Eras looks. Changes show immediately on any open chart." className="mb-6" aside={<button onClick={() => { setSt(ERA_STYLE_DEFAULT); saveEraStyle(ERA_STYLE_DEFAULT); }} className="text-xs text-dust hover:text-cream">Reset</button>}>
      <div className="grid gap-6 lg:grid-cols-[1fr_1fr]">
        <div className="space-y-4">
          <Slider label="Gap between eras" k="gap" min={0} max={16} step={1} fmt={(v) => `${v} px`} />
          <Slider label="Gap between eras and threads" k="bandGap" min={0} max={48} step={2} fmt={(v) => `${v} px`} />
          <Slider label="Chart height" k="height" min={0.7} max={1.6} step={0.05} fmt={(v) => `${Math.round(v * 100)}%`} />
          <Slider label="Week width (zoom)" k="weekWidth" min={6} max={28} step={1} fmt={(v) => `${v} px`} />
          <label className="flex items-center gap-2 text-xs text-dust"><input type="checkbox" checked={st.labels === 'long'} onChange={(e) => set({ labels: e.target.checked ? 'long' : 'all' })} /> Label only eras of 10 weeks or more</label>
        </div>
        <div className="space-y-4">
          <div><p className="mb-1 text-xs text-dust">Colours</p><div className="flex flex-wrap gap-2">{(Object.keys(PALETTES) as EraPalette[]).map((k) => (
            <button key={k} onClick={() => set({ palette: k })} aria-pressed={st.palette === k} className={`rounded-xl border px-3 py-2 text-left text-xs ${st.palette === k ? 'border-amber text-cream' : 'border-line text-dust hover:text-cream'}`}>
              <span className="mb-1 flex gap-0.5">{PALETTES[k].eras.slice(0, 5).map((c) => <span key={c} className="inline-block h-3 w-4 rounded-sm" style={{ background: c }} />)}</span>{PALETTES[k].label}
            </button>))}</div></div>
          <div><p className="mb-1 text-xs text-dust">Fill</p><div className="flex flex-wrap gap-1">{(['gradient', 'soft', 'solid', 'outline'] as EraFill[]).map((f) => <button key={f} onClick={() => set({ fill: f })} aria-pressed={st.fill === f} className={`rounded-full px-3 py-1 text-xs capitalize ${st.fill === f ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{f}</button>)}</div></div>
          <svg viewBox="0 0 300 90" className="w-full rounded-lg border border-line bg-ink/40" role="img" aria-label="Preview">
            <defs>{pal.eras.slice(0, 3).map((c, i) => <linearGradient key={i} id={`pv${i}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={c} stopOpacity={0.85} /><stop offset="100%" stopColor={c} stopOpacity={0.12} /></linearGradient>)}</defs>
            {[[8, 100, 'M8,60 L8,30 L40,22 L70,34 L100,26 L100,60 Z'], [100, 190, 'M100,60 L100,38 L130,18 L160,28 L190,40 L190,60 Z'], [190, 292, 'M190,60 L190,32 L220,26 L260,20 L292,34 L292,60 Z']].map(([, , d], i) => {
              const g = st.gap / 2; const shift = i === 0 ? -g : i === 2 ? g : 0; const c = pal.eras[i % pal.eras.length];
              return <path key={i} transform={`translate(${shift},0)`} d={String(d)} fill={st.fill === 'gradient' ? `url(#pv${i})` : c} fillOpacity={st.fill === 'gradient' ? 1 : st.fill === 'solid' ? 0.8 : st.fill === 'outline' ? 0.08 : 0.3} stroke={c} strokeWidth={st.fill === 'outline' ? 2 : 1.4} />;
            })}
            <path d={`M8,${80 + Math.min(8, st.bandGap / 6)} L60,${70 + Math.min(8, st.bandGap / 6)} L120,${74 + Math.min(8, st.bandGap / 6)} L180,${68 + Math.min(8, st.bandGap / 6)} L240,${76 + Math.min(8, st.bandGap / 6)}`} fill="none" stroke={pal.threads[0]} strokeWidth="1.4" strokeDasharray={st.fill === 'outline' ? undefined : '4 2'} />
          </svg>
        </div>
      </div>
    </Card>
  );
}
