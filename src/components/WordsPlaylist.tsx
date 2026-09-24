import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { QueueButton } from '@/components/QueueButton';
import { llmStatus } from '@/lib/ask';
import { artistHref, trackHref } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { buildFromSpec, describe, interpret, interpretWithModel, type Pick, type Spec } from '@/lib/wordsPlaylist';
import type { TrackRow } from '@/lib/types';

const EXAMPLES = ['rainy late-night songs I\'ve forgotten', 'upbeat 80s for a sunny Saturday', 'dark shoegaze, 20 songs', 'something to run to — 160 bpm', 'calm Sunday morning, lyrics about home', 'obscure psych I play at night'];

/** Phase 9l — Ask v2: a playlist from a sentence, built only from your own record, with the reasons for every pick. */
export function WordsPlaylist() {
  const st = useAsync(llmStatus, []);
  const [text, setText] = useState(''); const [useModel, setUseModel] = useState(false);
  const [spec, setSpec] = useState<Spec | null>(null); const [res, setRes] = useState<{ picks: Pick[]; considered: number; criteria: number } | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null); const [via, setVia] = useState<string | null>(null); const [kept, setKept] = useState(false);
  const go = async (t = text) => {
    if (!t.trim()) return; setBusy(true); setErr(null); setRes(null); setKept(false);
    try {
      let s = await interpret(t); let v = 'the built-in vocabulary';
      if (useModel && st.data?.reachable) { const m = await interpretWithModel(t, s); s = m.spec; v = m.model; }
      setSpec(s); setVia(v); setRes(await buildFromSpec(s));
    } catch (e) { setErr(String(e)); } finally { setBusy(false); }
  };
  const keep = async () => {
    const m = await import('@/lib/dynamicPlaylists'); const defs = await m.loadDynamic();
    defs.push({ id: m.newId(), name: `DC · ${text.trim().slice(0, 60)}`, rule: { kind: 'words', text: text.trim() }, size: spec?.size ?? 30, cadence: 'weekly', autoSync: false, spotifyId: null, spotifyUrl: null, lastBuiltAt: null, lastSyncedAt: null, lastTrackIds: [] });
    await m.saveDynamic(defs); setKept(true);
  };
  const chips = spec ? describe(spec) : [];
  return (
    <Card title="Playlist from words" subtitle="Describe a mood, a moment or the weather — Deep Cuts builds it from songs you actually play, and says why each one fits. Works without a local model.">
      <div className="flex flex-wrap gap-2">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void go(); }} placeholder={EXAMPLES[0]} aria-label="Describe a playlist" className="min-w-[16rem] flex-1 rounded-xl border border-line bg-ink px-4 py-2.5 text-sm" />
        <button disabled={busy || !text.trim()} onClick={() => go()} className="rounded-full bg-amber px-4 py-2 text-sm font-medium text-ink disabled:opacity-40">{busy ? 'Building…' : 'Build it'}</button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
        {EXAMPLES.map((x) => <button key={x} onClick={() => { setText(x); void go(x); }} className="rounded-full border border-line px-2.5 py-0.5 text-dust hover:text-cream">{x}</button>)}
        {st.data?.reachable && <label className="ml-auto flex items-center gap-1 text-dust"><input type="checkbox" checked={useModel} onChange={(e) => setUseModel(e.target.checked)} /> let the local model read it</label>}
      </div>
      {err && <div className="mt-3"><ErrorBox message={err} /></div>}
      {busy && <Loading label="Reading your record…" />}
      {spec && res && (
        <div className="mt-4">
          <p className="text-xs text-dust">Read by {via} as: {chips.length ? chips.map((c) => <span key={c} className="ml-1 inline-block rounded-full border border-line px-2 py-0.5 text-cream">{c}</span>) : <span className="ml-1">nothing specific — try naming a mood, a time, the weather, a scene or a genre.</span>}</p>
          {res.picks.length === 0 ? <p className="mt-3 text-sm text-dust">Nothing in your record matches all of that. Loosen it a little (numbers like bpm or years are strict).</p> : (
            <>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <MakePlaylistButton small label={`Make playlist · ${res.picks.length}`} name={`DC · ${text.trim().slice(0, 80)}`} kind="insight" description={`“${text.trim()}” — built by Deep Cuts from your own listening: ${chips.join(', ')}.`} tracks={res.picks.map((p) => ({ trackId: p.trackId, track: p.track, artistId: p.artistId, artist: p.artist, plays: p.plays, hours: 0, skipRate: 0 }) as TrackRow)} />
                {kept ? <Link to="/library?tab=dynamic" className="text-xs text-moss hover:underline">added to Library → Dynamic →</Link> : <button onClick={keep} className="rounded-full border border-line px-3 py-1 text-xs text-dust hover:text-cream" title="Rebuild this sentence every week (Library → Dynamic)">Keep it fresh</button>}
                <span className="num ml-auto text-[11px] text-dust">{res.picks.length} of {res.considered.toLocaleString()} songs considered · ≤ 3 per artist</span>
              </div>
              <ol className="mt-3 max-h-[min(28rem,55vh)] space-y-1 overflow-y-auto pr-1 text-sm">
                {res.picks.map((p, i) => (
                  <li key={p.trackId} className="flex items-center gap-2">
                    <span className="num w-6 text-right text-xs text-dust">{i + 1}</span><QueueButton trackId={p.trackId} />
                    <span className="min-w-0 flex-1 truncate"><Link to={trackHref(p.trackId)} className="hover:text-amber">{p.track}</Link> <span className="text-xs text-dust">{p.artistId ? <Link to={artistHref(p.artistId)} className="hover:text-cream">{p.artist}</Link> : p.artist}</span></span>
                    <span className="hidden max-w-[45%] shrink-0 truncate text-[11px] text-dust sm:inline" title={p.why.join(' · ')}>{p.why.join(' · ')}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      )}
    </Card>
  );
}
