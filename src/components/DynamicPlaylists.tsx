import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { invoke } from '@/lib/bridge';
import { buildRule, isDue, loadDynamic, newId, refreshDue, RULE_LABEL, saveDynamic, type DynamicPlaylist, type Rule } from '@/lib/dynamicPlaylists';
import { TEMPO_BANDS } from '@/lib/featureQueries';
import { sceneOptions } from '@/lib/sceneQueries';
import { fmtDate, trackHref } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import type { TrackRow } from '@/lib/types';

/** Phase 9k — Library → Dynamic: playlists that rebuild themselves from your record, optionally kept in sync on Spotify. */
export function DynamicTab() {
  const [tick, setTick] = useState(0);
  const defs = useAsync(loadDynamic, [tick]);
  const [msg, setMsg] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState<string | null>(null);
  const save = async (next: DynamicPlaylist[]) => { await saveDynamic(next); setTick((t) => t + 1); };
  const act = async (id: string, fn: () => Promise<void>) => { setBusy(id); setErr(null); try { await fn(); } catch (e) { setErr(String(e)); } finally { setBusy(null); setTick((t) => t + 1); } };
  if (defs.error) return <ErrorBox message={defs.error} />;
  if (!defs.data) return <Loading />;
  const list = defs.data;
  return (
    <div className="space-y-6">
      <p className="max-w-3xl text-sm text-dust">Playlists that rebuild themselves from your record — daily or weekly. Link one to Spotify and each new edition replaces its songs in place: same link, same cover, fresh music. Editions rebuild when Deep Cuts opens and one is due.</p>
      {msg && <p className="text-sm text-moss">{msg}</p>}{err && <ErrorBox message={err} />}
      <NewDynamic onAdd={(d) => save([...list, d]).then(() => setMsg(`Added “${d.name}”. Build a first edition below.`))} />
      {list.length === 0 ? <Card title="No dynamic playlists yet"><p className="text-sm text-dust">Try "Today's forecast · daily" — Deep Cuts' guess at what you'll reach for, fresh each morning.</p></Card> : (
        <div className="grid gap-4 lg:grid-cols-2">
          {list.map((d) => (
            <DynamicCard key={d.id} d={d} busy={busy === d.id}
              onChange={(patch) => save(list.map((x) => (x.id === d.id ? { ...x, ...patch } : x)))}
              onDelete={() => { if (window.confirm(`Delete “${d.name}”? The Spotify playlist (if any) is left as it is.`)) void save(list.filter((x) => x.id !== d.id)); }}
              onRefresh={() => act(d.id, async () => { const r = await refreshDue([d.id]); setMsg(r.errors.length ? r.errors.join(' · ') : `“${d.name}” rebuilt${r.synced.length ? ' and synced to Spotify' : ''}.`); })}
              onLink={() => act(d.id, async () => {
                const tracks = await buildRule(d.rule, d.size);
                const r = await invoke<{ spotify_playlist_id: string; url: string; added: number }>('create_playlist', { playlist: { name: d.name, description: `Dynamic playlist from Deep Cuts — ${RULE_LABEL[d.rule.kind].toLowerCase()}, refreshed ${d.cadence}.`, public: false, kind: 'dynamic', track_ids: tracks.map((t) => t.trackId), source_note: `dynamic:${d.id}` } });
                const now = new Date().toISOString();
                await saveDynamic(list.map((x) => (x.id === d.id ? { ...x, spotifyId: r.spotify_playlist_id, spotifyUrl: r.url, autoSync: true, lastBuiltAt: now, lastSyncedAt: now, lastTrackIds: tracks.map((t) => t.trackId) } : x)));
                setMsg(`Created on Spotify with ${r.added} songs and linked — it will refresh ${d.cadence}.`);
              })} />
          ))}
        </div>
      )}
    </div>
  );
}

function NewDynamic({ onAdd }: { onAdd: (d: DynamicPlaylist) => void }) {
  const scenes = useAsync(sceneOptions, []);
  const [kind, setKind] = useState<Rule['kind']>('forecast');
  const [name, setName] = useState(''); const [size, setSize] = useState(30); const [cadence, setCadence] = useState<'daily' | 'weekly'>('daily');
  const [days, setDays] = useState(14); const [gate, setGate] = useState<'' | 'sunny' | 'cloudy' | 'fog' | 'rain' | 'snow' | 'storm'>(''); const [scene, setScene] = useState(''); const [band, setBand] = useState('groove'); const [energy, setEnergy] = useState<'any' | 'high' | 'low'>('any');
  const rule = (): Rule | null => {
    switch (kind) {
      case 'forecast': return { kind }; case 'revisit': return { kind };
      case 'rotation': return { kind, days }; case 'rediscover': return { kind, silentDays: Math.max(60, days) };
      case 'scene': return scene ? { kind, scene, recentDays: null } : null;
      case 'tempo': return { kind, band, energy };
      default: return null;
    }
  };
  const auto = `${RULE_LABEL[kind]}${kind === 'scene' && scene ? ` · ${(scenes.data ?? []).find((s) => s.scene === scene)?.label ?? scene}` : kind === 'tempo' ? ` · ${TEMPO_BANDS.find((b) => b.id === band)?.label}` : ''}`;
  const r = rule();
  return (
    <Card title="New dynamic playlist" subtitle="Pick a rule; the name is optional. (Sounds-like playlists are started from a song page.)">
      <div className="flex flex-wrap items-end gap-3 text-sm">
        <label className="text-xs text-dust">Rule<select value={kind} onChange={(e) => setKind(e.target.value as Rule['kind'])} className="mt-1 block rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream">{(['forecast', 'rotation', 'rediscover', 'scene', 'tempo', 'revisit'] as const).map((k) => <option key={k} value={k}>{RULE_LABEL[k]}</option>)}</select></label>
        {(kind === 'rotation' || kind === 'rediscover') && <label className="text-xs text-dust">{kind === 'rotation' ? 'Last N days' : 'Silent for N days'}<input type="number" min={kind === 'rotation' ? 3 : 60} max={1000} value={kind === 'rediscover' ? Math.max(60, days) : days} onChange={(e) => setDays(Number(e.target.value))} className="num mt-1 block w-24 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream" /></label>}
        {kind === 'scene' && <label className="text-xs text-dust">Scene<select value={scene} onChange={(e) => setScene(e.target.value)} className="mt-1 block rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream"><option value="">choose…</option>{(scenes.data ?? []).map((s) => <option key={s.scene} value={s.scene}>{s.label}</option>)}</select></label>}
        {kind === 'tempo' && <><label className="text-xs text-dust">Band<select value={band} onChange={(e) => setBand(e.target.value)} className="mt-1 block rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream">{TEMPO_BANDS.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}</select></label>
          <label className="text-xs text-dust">Energy<select value={energy} onChange={(e) => setEnergy(e.target.value as 'any' | 'high' | 'low')} className="mt-1 block rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream"><option value="any">any</option><option value="high">high</option><option value="low">low</option></select></label></>}
        <label className="text-xs text-dust">Songs<input type="number" min={5} max={200} value={size} onChange={(e) => setSize(Math.max(5, Math.min(200, Number(e.target.value))))} className="num mt-1 block w-20 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream" /></label>
        <label className="text-xs text-dust">Refresh<select value={cadence} onChange={(e) => setCadence(e.target.value as 'daily' | 'weekly')} className="mt-1 block rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream"><option value="daily">daily</option><option value="weekly">weekly</option></select></label>
        <label className="text-xs text-dust" title="Needs your city in Settings → Record → Weather">Only on<select value={gate} onChange={(e) => setGate(e.target.value as typeof gate)} className="mt-1 block rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream"><option value="">any day</option>{(['rain', 'sunny', 'cloudy', 'snow', 'storm', 'fog'] as const).map((b) => <option key={b} value={b}>{b} days</option>)}</select></label>
        <label className="min-w-[12rem] flex-1 text-xs text-dust">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder={`DC · ${auto}`} className="mt-1 block w-full rounded-lg border border-line bg-ink px-2 py-1.5 text-sm text-cream" /></label>
        <button disabled={!r} onClick={() => { if (r) { onAdd({ id: newId(), name: name.trim() || `DC · ${auto}`, rule: r, size, cadence, autoSync: false, spotifyId: null, spotifyUrl: null, lastBuiltAt: null, lastSyncedAt: null, lastTrackIds: [], weatherGate: gate || null }); setName(''); } }} className="rounded-full bg-amber px-4 py-1.5 text-sm font-medium text-ink disabled:opacity-40">Add</button>
      </div>
    </Card>
  );
}

function DynamicCard({ d, busy, onChange, onDelete, onRefresh, onLink }: { d: DynamicPlaylist; busy: boolean; onChange: (p: Partial<DynamicPlaylist>) => void; onDelete: () => void; onRefresh: () => void; onLink: () => void }) {
  const [preview, setPreview] = useState<TrackRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const show = async () => { setLoading(true); try { setPreview(await buildRule(d.rule, d.size)); } finally { setLoading(false); } };
  return (
    <Card title={d.name} subtitle={`${RULE_LABEL[d.rule.kind]} · ${d.size} songs · ${d.cadence}${d.weatherGate ? ` on ${d.weatherGate} days` : ''}${d.lastBuiltAt ? ` · last edition ${fmtDate(d.lastBuiltAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}` : ' · never built'}${isDue(d) ? ' · due' : ''}`}
      aside={<button onClick={onDelete} className="text-xs text-dust hover:text-coral">delete</button>}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <button disabled={busy} onClick={onRefresh} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream disabled:opacity-40">{busy ? 'Working…' : 'Rebuild now'}</button>
        <button disabled={loading} onClick={show} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream">{preview ? 'Refresh preview' : 'Preview'}</button>
        {d.spotifyId ? <>
          <a href={d.spotifyUrl ?? `https://open.spotify.com/playlist/${d.spotifyId}`} target="_blank" rel="noreferrer" className="rounded-full border border-moss/50 px-3 py-1 text-moss hover:bg-moss/10">On Spotify ↗</a>
          <label className="flex items-center gap-1 text-dust"><input type="checkbox" checked={d.autoSync} onChange={(e) => onChange({ autoSync: e.target.checked })} /> keep in sync</label>
          <button onClick={() => onChange({ spotifyId: null, spotifyUrl: null, autoSync: false })} className="text-dust hover:text-coral">unlink</button>
        </> : <button disabled={busy} onClick={onLink} className="rounded-full border border-amber/60 px-3 py-1 text-amber hover:bg-amber/10 disabled:opacity-40">Create on Spotify & keep in sync</button>}
      </div>
      {d.lastSyncedAt && <p className="num mt-2 text-[11px] text-dust">synced to Spotify {fmtDate(d.lastSyncedAt, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} · {d.lastTrackIds.length} songs</p>}
      {loading && <Loading label="Building this edition…" />}
      {preview && (preview.length === 0 ? <p className="mt-3 text-sm text-dust">This rule finds nothing right now.</p> : (
        <ol className="mt-3 max-h-[min(18rem,40vh)] space-y-1 overflow-y-auto pr-1 text-sm">{preview.map((t, i) => <li key={t.trackId} className="flex gap-2"><span className="num w-6 text-right text-xs text-dust">{i + 1}</span><Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track} <span className="text-xs text-dust">{t.artist}</span></Link></li>)}</ol>
      ))}
    </Card>
  );
}
