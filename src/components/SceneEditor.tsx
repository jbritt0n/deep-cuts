import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox } from '@/components/Card';
import { useAsync, useFilter } from '@/lib/hooks';
import { fmtHours, fmtInt } from '@/lib/format';
import { deleteSceneFamily, recomputeScenes, sceneFamilies, sceneKey, sceneOrigins, sceneTags, setSceneOrigin, setSceneTag, unmappedOrigins, unmappedTags, upsertSceneFamily, type SceneFamily } from '@/lib/sceneQueries';

/**
 * Phase 9f — Settings → Tuning → Scenes. The vocabulary behind The Crate's sections, the Scenes list on
 * Eras and the coloured chains on session detail. Three things the owner can do here:
 *   1. add a family (a niche scene, a region) or hide a built-in;
 *   2. file a tag under a family — the "unfiled tags" queue lists what your artists carry that maps nowhere;
 *   3. add an origin-country fallback.
 * Every change is written at once; "Re-file now" reruns compute_scenes.sql so the rest of the app follows
 * without waiting for the nightly rebuild.
 */
export function SceneEditor() {
  const { filter } = useFilter();
  const [tick, setTick] = useState(0);
  const fams = useAsync(sceneFamilies, [filter, tick]);
  const queue = useAsync(() => unmappedTags(60), [filter, tick]);
  const [picked, setPicked] = useState<string | null>(null);
  const tags = useAsync(() => (picked ? sceneTags(picked) : Promise.resolve([])), [picked, filter, tick]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [dirty, setDirty] = useState(false);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr(null);
    try { await fn(); setMsg(ok); setDirty(true); setTick((t) => t + 1); } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const refile = () => act(async () => { const r = await recomputeScenes(); setMsg(`Re-filed: ${fmtInt(r.artists)} artists across ${r.families} families.`); setDirty(false); }, 'Re-filed.');

  const visible = useMemo(() => (fams.data ?? []).filter((f) => showHidden || !f.hidden), [fams.data, showHidden]);
  const options = useMemo(() => (fams.data ?? []).filter((f) => !f.hidden).sort((a, b) => a.label.localeCompare(b.label)), [fams.data]);
  const filed = (fams.data ?? []).reduce((a, f) => a + f.artists, 0);

  return (
    <Card title="Scenes" subtitle={fams.data ? `${fams.data.filter((f) => !f.hidden).length} families · ${fmtInt(filed)} artists filed · ${fams.data.reduce((a, f) => a + f.tags, 0)} tags mapped. Families are the sections in The Crate, the Scenes on Eras and the colours on session chains.` : 'The vocabulary behind sections and scenes.'}
      aside={<div className="flex items-center gap-2 text-xs">{dirty && <span className="text-amber">changes saved — re-file to apply</span>}<button disabled={busy} onClick={refile} className={`rounded-full border px-3 py-1 ${dirty ? 'border-amber text-amber hover:bg-amber/10' : 'border-line text-dust hover:text-cream'} disabled:opacity-40`}>{busy ? 'Working…' : 'Re-file now'}</button></div>}>
      {msg && <p className="mb-3 text-xs text-moss">{msg}</p>}
      {err && <div className="mb-3"><ErrorBox message={err} /></div>}
      {fams.error && <ErrorBox message={fams.error} />}
      <div className="grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <div className="min-w-0">
          <div className="mb-2 flex items-baseline justify-between"><p className="text-xs text-dust">Families — click one to see and edit its tags</p><label className="flex items-center gap-1 text-[11px] text-dust"><input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> show hidden</label></div>
          <ul className="max-h-[420px] space-y-1 overflow-y-auto pr-1 text-sm">
            {visible.map((f) => (
              <li key={f.scene} className={`flex items-center gap-2 rounded-lg border px-2 py-1 ${picked === f.scene ? 'border-amber bg-ink/40' : 'border-line/60'} ${f.hidden ? 'opacity-50' : ''}`}>
                <button onClick={() => setPicked(picked === f.scene ? null : f.scene)} className="min-w-0 flex-1 truncate text-left hover:text-amber" title={f.blurb ?? f.scene}>
                  {f.label}<span className="ml-2 text-[10px] uppercase tracking-wide text-dust/60">{f.kind}</span>{!f.builtin && <span className="ml-1 text-[10px] text-amber">yours</span>}
                </button>
                <span className="num shrink-0 text-xs text-dust" title={`${f.tags} tags → ${f.artists} artists (${f.filedByYou} filed by you) · ${fmtHours(f.hours)}`}>{f.artists} · {fmtHours(f.hours)}</span>
                <button disabled={busy} onClick={() => act(() => upsertSceneFamily({ ...f, hidden: !f.hidden }), f.hidden ? `${f.label} shown again.` : `${f.label} hidden — its tags no longer file anyone.`)} className="shrink-0 text-[11px] text-dust hover:text-cream" title={f.hidden ? 'Show this family again' : 'Hide this family (keeps its tags for later)'}>{f.hidden ? 'show' : 'hide'}</button>
                {!f.builtin && <button disabled={busy} onClick={() => { if (window.confirm(`Delete the family "${f.label}"? Its tag mappings and any artists you filed under it are unfiled.`)) void act(() => deleteSceneFamily(f.scene), `${f.label} deleted.`); }} className="shrink-0 text-[11px] text-dust hover:text-coral">delete</button>}
              </li>
            ))}
          </ul>
          <NewFamily busy={busy} onAdd={(f) => act(() => upsertSceneFamily(f), `Added ${f.label}. Now file some tags under it.`)} />
          {picked && (
            <div className="mt-4 rounded-xl border border-line bg-ink/30 p-3">
              <FamilyTags family={fams.data?.find((f) => f.scene === picked) ?? null} tags={tags.data ?? []} options={options} busy={busy}
                onUnmap={(t) => act(() => setSceneTag(t, null), `"${t}" unfiled.`)}
                onMove={(t, sc) => act(() => setSceneTag(t, sc), `"${t}" moved.`)}
                onAdd={(t) => act(() => setSceneTag(t, picked), `"${t}" filed under ${fams.data?.find((f) => f.scene === picked)?.label ?? picked}.`)} />
            </div>
          )}
        </div>
        <div className="min-w-0">
          <p className="mb-2 text-xs text-dust">Unfiled tags your artists carry — biggest first. Pick a family to file one.</p>
          {queue.error ? <ErrorBox message={queue.error} /> : !queue.data ? <p className="text-xs text-dust">Looking…</p> : queue.data.length === 0 ? <p className="text-xs text-dust">Every tag with weight is filed. New ones appear as Last.fm / MusicBrainz tags arrive.</p> : (
            <ul className="max-h-[420px] space-y-1 overflow-y-auto pr-1 text-sm">
              {queue.data.map((t) => (
                <li key={t.tag} className="flex items-center gap-2 rounded-lg border border-line/60 px-2 py-1">
                  <span className="min-w-0 flex-1 truncate">{t.tag}</span>
                  <span className="num shrink-0 text-xs text-dust">{t.artists} · {fmtHours(t.hours)}</span>
                  <select disabled={busy} defaultValue="" onChange={(e) => { const v = e.target.value; if (v) void act(() => setSceneTag(t.tag, v), `"${t.tag}" filed under ${options.find((o) => o.scene === v)?.label ?? v}.`); }} className="max-w-[140px] rounded border border-line bg-ink px-1 py-0.5 text-xs">
                    <option value="">file under…</option>
                    {options.map((o) => <option key={o.scene} value={o.scene}>{o.label}</option>)}
                  </select>
                </li>
              ))}
            </ul>
          )}
          <Origins busy={busy} options={options} act={act} tick={tick} />
          <p className="mt-4 text-[11px] text-dust/70">How filing works: an artist joins every family whose mapped tags it carries with total weight ≥ 0.3; an artist with no mapped tag falls back to its MusicBrainz origin country; your own decisions on a record card (<Link to="/crate" className="underline hover:text-cream">The Crate</Link>) always win. Umbrella tags — “rock”, “pop”, “seen live” — deliberately file nothing or something broad; niche families need niche tags.</p>
        </div>
      </div>
    </Card>
  );
}

function NewFamily({ busy, onAdd }: { busy: boolean; onAdd: (f: { scene: string; label: string; kind: 'region' | 'style'; blurb: string | null }) => void }) {
  const [label, setLabel] = useState(''); const [kind, setKind] = useState<'region' | 'style'>('style'); const [blurb, setBlurb] = useState('');
  const key = sceneKey(label);
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
      <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="New family, e.g. Thai funk & molam" className="min-w-[200px] flex-1 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm" />
      <select value={kind} onChange={(e) => setKind(e.target.value as 'region' | 'style')} className="rounded-lg border border-line bg-ink px-2 py-1.5 text-sm"><option value="style">style</option><option value="region">region</option></select>
      <input value={blurb} onChange={(e) => setBlurb(e.target.value)} placeholder="one line, optional" className="min-w-[160px] flex-1 rounded-lg border border-line bg-ink px-2 py-1.5 text-sm" />
      <button disabled={busy || label.trim().length < 2} onClick={() => { onAdd({ scene: key, label: label.trim(), kind, blurb: blurb.trim() || null }); setLabel(''); setBlurb(''); }} className="rounded-full border border-line px-3 py-1.5 text-dust hover:text-cream disabled:opacity-40">Add family</button>
      {label && <span className="num text-dust/60">key: {key}</span>}
    </div>
  );
}

function FamilyTags({ family, tags, options, busy, onUnmap, onMove, onAdd }: { family: SceneFamily | null; tags: { tag: string; builtin: boolean; artists: number; hours: number }[]; options: SceneFamily[]; busy: boolean; onUnmap: (t: string) => void; onMove: (t: string, sc: string) => void; onAdd: (t: string) => void }) {
  const [t, setT] = useState('');
  if (!family) return null;
  return (
    <div>
      <div className="flex items-baseline justify-between gap-2"><p className="text-sm">{family.label} <span className="text-xs text-dust">· {tags.length} tags · {family.artists} artists</span></p>{family.blurb && <p className="truncate text-xs text-dust">{family.blurb}</p>}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        {tags.map((x) => (
          <span key={x.tag} className={`group inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${x.artists > 0 ? 'border-line' : 'border-line/40 text-dust/70'}`} title={`${x.artists} of your artists · ${fmtHours(x.hours)}${x.builtin ? '' : ' · added by you'}`}>
            {x.tag}{x.artists > 0 && <span className="num text-dust/70">{x.artists}</span>}
            <select disabled={busy} value="" onChange={(e) => { const v = e.target.value; if (v === '__unmap') onUnmap(x.tag); else if (v) onMove(x.tag, v); }} className="w-4 cursor-pointer appearance-none bg-transparent text-dust opacity-60 group-hover:opacity-100" title="Move or unfile">
              <option value="">…</option>
              <option value="__unmap">unfile</option>
              {options.filter((o) => o.scene !== family.scene).map((o) => <option key={o.scene} value={o.scene}>→ {o.label}</option>)}
            </select>
          </span>
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2 text-xs">
        <input value={t} onChange={(e) => setT(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && t.trim()) { onAdd(t.trim()); setT(''); } }} placeholder={`add a tag to ${family.label} (exactly as Last.fm spells it)`} className="min-w-0 flex-1 rounded-lg border border-line bg-ink px-2 py-1 text-sm" />
        <button disabled={busy || !t.trim()} onClick={() => { onAdd(t.trim()); setT(''); }} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream disabled:opacity-40">Add</button>
      </div>
    </div>
  );
}

function Origins({ busy, options, act, tick }: { busy: boolean; options: SceneFamily[]; act: (fn: () => Promise<unknown>, ok: string) => Promise<void>; tick: number }) {
  const [open, setOpen] = useState(false);
  const origins = useAsync(() => (open ? sceneOrigins() : Promise.resolve([])), [open, tick]);
  const missing = useAsync(() => (open ? unmappedOrigins() : Promise.resolve([])), [open, tick]);
  const [cc, setCc] = useState(''); const [sc, setSc] = useState('');
  return (
    <div className="mt-4 border-t border-line pt-3">
      <button onClick={() => setOpen(!open)} className="text-xs text-dust hover:text-cream">{open ? '▾' : '▸'} Origin-country fallbacks (for artists with no mapped tag)</button>
      {open && (
        <div className="mt-2 text-xs">
          {missing.data && missing.data.length > 0 && <p className="mb-2 text-amber">Your artists come from {missing.data.length} countries with no fallback: {missing.data.slice(0, 12).map((m) => `${m.country} (${m.artists})`).join(', ')}{missing.data.length > 12 ? '…' : ''}</p>}
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <input value={cc} onChange={(e) => setCc(e.target.value.toUpperCase().slice(0, 2))} placeholder="CC" className="w-14 rounded border border-line bg-ink px-2 py-1 text-sm" />
            <select value={sc} onChange={(e) => setSc(e.target.value)} className="rounded border border-line bg-ink px-2 py-1 text-sm"><option value="">family…</option>{options.map((o) => <option key={o.scene} value={o.scene}>{o.label}</option>)}</select>
            <button disabled={busy || cc.length !== 2 || !sc} onClick={() => act(() => setSceneOrigin(cc, sc), `${cc} → ${options.find((o) => o.scene === sc)?.label ?? sc}.`)} className="rounded-full border border-line px-3 py-1 text-dust hover:text-cream disabled:opacity-40">Set</button>
          </div>
          <ul className="grid max-h-48 grid-cols-2 gap-x-3 gap-y-0.5 overflow-y-auto sm:grid-cols-3">
            {(origins.data ?? []).filter((o) => o.artists > 0).map((o) => <li key={o.country} className="flex items-baseline gap-1 truncate"><span className="num">{o.country}</span><span className="truncate text-dust">→ {options.find((x) => x.scene === o.scene)?.label ?? o.scene}</span><span className="num ml-auto text-dust/70" title={`${o.fallbackArtists} rely on this fallback`}>{o.artists}</span></li>)}
          </ul>
        </div>
      )}
    </div>
  );
}
