import { C } from '@/lib/theme';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { curated, inbox, spotifySearchUrl, type Rec } from '@/lib/recQueries';
import { lyricSearch } from '@/lib/phase4Queries';
import { earworms, madeByDeepCuts } from '@/lib/phase7Queries';
import { MixtapeBuilder } from '@/components/Mixtape';
import { useDebounced } from '@/lib/hooks';
import { fmtInt } from '@/lib/format';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { useAsync, useFilter } from '@/lib/hooks';
import { invoke } from '@/lib/bridge';
import { artistHref, fmtDate, fmtHours, fmtPct } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';

const ENGINE: Record<Rec['engine'], { label: string; color: string }> = {
  adjacency: { label: 'Next to your taste', color: C.moss },
  tag_affinity: { label: 'Tag affinity', color: C.amber },
  structural: { label: 'Gap in your own library', color: C.violet },
  side_project: { label: 'Side project', color: '#E4A5A0' },
  release_radar: { label: 'New release', color: '#6F8FB0' },
};

export function DiscoveryPage() {
  const { filter } = useFilter();
  const { data, error, reload } = useAsync(inbox, [filter]);
  const cur = useAsync(curated, [filter]);
  const [lq, setLq] = useState('');
  const dlq = useDebounced(lq, 250);
  const lyr = useAsync(() => lyricSearch(dlq), [dlq, filter]);
  const ew = useAsync(() => earworms(30), [filter]);
  const made = useAsync(madeByDeepCuts, [filter]);
  const [ewHidden, setEwHidden] = useState<Set<string>>(new Set());
  const [only, setOnly] = useState<Rec['engine'] | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading label="Thinking about what you'd like…" />;

  const feedback = async (r: Rec, verdict: 'accepted' | 'dismissed') => {
    try { await invoke('rec_feedback', { subjectType: 'artist', subjectKey: r.key, engine: r.engine, verdict }); } catch (e) { setMsg(String(e)); return; }
    setHidden(new Set([...hidden, r.key]));
    if (verdict === 'dismissed') setMsg(`Won't suggest ${r.title} again for 90 days.`);
  };
  const radar = async (r: Rec) => {
    setMsg(`Adding ${r.title} to your Radar playlist…`);
    try { const res = await invoke<{ added: number; url: string }>('add_to_radar', { search: r.spotifySearch }); setMsg(`Added ${res.added} tracks by ${r.title} to Deep Cuts Radar — find it in Spotify under Your Library → Playlists, or open it: ${res.url}`); await feedback(r, 'accepted'); made.reload(); }
    catch (e) { setMsg(String(e)); }
  };
  const recs = data.recs.filter((r) => !hidden.has(r.key) && (!only || r.engine === only));
  const counts = data.recs.reduce<Record<string, number>>((m, r) => ((m[r.engine] = (m[r.engine] ?? 0) + 1), m), {});

  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Discovery" title="Things you'd probably like"
        meta={<>{data.recs.length} suggestions · {data.acceptedCount} accepted, {data.dismissedCount} dismissed so far · dismissals are remembered for 90 days</>}>
        <p className="mt-4 max-w-2xl text-sm text-dust">Nothing here comes from Spotify's recommendations (development-mode apps don't get them). It's your own behaviour, plus the Last.fm similar-artist graph and Last.fm / MusicBrainz tags. Every row says why.</p>
      </Sleeve>
      {msg && <div className="mb-4 rounded-xl border border-line bg-surface px-4 py-3 text-sm text-dust">{msg}</div>}
      {data.unavailable.length > 0 && (
        <div className="mb-4 rounded-xl border border-amber/30 bg-amber/5 px-4 py-3 text-xs text-amber">
          Not running yet: {data.unavailable.join(' · ')}. <Link to="/services" className="underline">Connect in Services</Link> — the rest still works.
        </div>
      )}

      <div className="mb-4 flex flex-wrap gap-2 text-xs">
        <button onClick={() => setOnly(null)} className={`rounded-full px-3 py-1.5 ${only === null ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>All</button>
        {(Object.keys(ENGINE) as Rec['engine'][]).filter((k) => counts[k]).map((k) => (
          <button key={k} onClick={() => setOnly(k)} className={`flex items-center gap-2 rounded-full px-3 py-1.5 ${only === k ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: ENGINE[k].color }} />{ENGINE[k].label} · {counts[k]}
          </button>
        ))}
      </div>

      <div className="mb-6 grid gap-6 lg:grid-cols-[1.2fr_1fr]">
        <Card title="Mixtape builder" subtitle="Set the blend, pick a length, preview, publish. Artists you don't own are filled in from Spotify search."><MixtapeBuilder /></Card>
        <Card title="Made by Deep Cuts" subtitle="Playlists this app created on your Spotify. Radar lives here too." aside={made.data?.some((m) => m.kind === 'radar') ? <a href={made.data.find((m) => m.kind === 'radar')!.url ?? '#'} target="_blank" rel="noreferrer" className="text-xs text-dust hover:text-amber">open Radar</a> : undefined}>
          {made.data && made.data.length ? <ul className="divide-y divide-line/60 text-sm">{made.data.slice(0, 8).map((m) => <li key={m.id} className="flex items-center gap-3 py-1.5"><span className="min-w-0 flex-1 truncate">{m.url ? <a href={m.url} target="_blank" rel="noreferrer" className="hover:text-amber">{m.name}</a> : m.name}</span><span className="num shrink-0 text-xs text-dust">{m.kind} · {m.tracks} · {m.isPublic ? 'public' : 'private'} · {m.createdAt.slice(0, 10)}</span></li>)}</ul> : <p className="text-sm text-dust">Nothing created yet. Radar appears here after your first “Add to Radar”.</p>}
        </Card>
      </div>
      <div className="mb-6">
        <Card title="Earworms" subtitle="Songs that keep coming back: modest plays spread over many months, played on their own, never skipped. Tell it when it's right or wrong — it learns."
          aside={ew.data && ew.data.length ? <MakePlaylistButton small name="Earworms · Deep Cuts" tracks={ew.data.filter((e) => !ewHidden.has(e.trackId)).map((e) => ({ trackId: e.trackId, track: e.track, artistId: null, artist: e.artist, plays: e.plays, hours: 0, skipRate: e.skipRate }))} kind="insight" note="earworms" /> : undefined}>
          {!ew.data ? <Loading label="Listening for hooks…" /> : ew.data.length === 0 ? <p className="text-sm text-dust">Nothing recurring enough yet.</p> : (
            <ul className="grid gap-2 md:grid-cols-2 lg:grid-cols-3">
              {ew.data.filter((e) => !ewHidden.has(e.trackId)).slice(0, 18).map((e) => (
                <li key={e.trackId} className={`rounded-xl border p-3 text-sm ${e.verdict === 'accepted' ? 'border-moss/50 bg-moss/5' : 'border-line bg-ink/40'}`}>
                  <p className="truncate"><Link to={`/track/${encodeURIComponent(e.trackId)}`} className="hover:text-amber">{e.track}</Link><span className="ml-2 text-xs text-dust">{e.artist}</span></p>
                  <p className="num mt-0.5 text-xs text-dust">{e.plays} plays over {e.months} months in {e.years} year{e.years === 1 ? '' : 's'} · {Math.round(e.alone * 100)}% on its own</p>
                  <div className="mt-2 flex gap-3 text-xs">
                    <button onClick={() => invoke('rec_feedback', { subjectType: 'track', subjectKey: e.trackId, engine: 'earworm', verdict: 'accepted' }).then(() => ew.reload())} className="text-dust hover:text-moss">{e.verdict === 'accepted' ? 'confirmed' : 'yes, earworm'}</button>
                    <button onClick={() => invoke('rec_feedback', { subjectType: 'track', subjectKey: e.trackId, engine: 'earworm', verdict: 'dismissed' }).then(() => setEwHidden(new Set([...ewHidden, e.trackId])))} className="text-dust hover:text-coral">not really</button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="mb-6">
        <Card title="Curated from your own archive" subtitle="Deterministic playlists built from what you already have. Preview, trim, add, publish.">
          {cur.data ? (
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {cur.data.map((c) => (
                <div key={c.id} className="rounded-xl border border-line bg-ink/40 p-4">
                  <p className="font-display text-lg">{c.title}</p>
                  <p className="mt-1 text-xs text-dust">{c.blurb}</p>
                  <p className="num mt-2 truncate text-xs text-dust">{c.tracks.slice(0, 3).map((t) => t.track).join(' · ')}…</p>
                  <div className="mt-3"><MakePlaylistButton name={c.title} tracks={c.tracks} kind="insight" description={`${c.blurb} Made with Deep Cuts.`} note={`curated:${c.id}`} pool={c.tracks} label={`Preview ${c.tracks.length} tracks`} /></div>
                </div>
              ))}
            </div>
          ) : <Loading label="Curating…" />}
        </Card>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1.6fr_1fr]">
        <div className="space-y-3">
          {recs.length === 0 && <Card><p className="text-sm text-dust">Nothing left in this view. Connect Last.fm and MusicBrainz for more, or come back after new plays.</p></Card>}
          {recs.map((r) => (
            <div key={r.key} className="rounded-2xl border border-line bg-surface p-5">
              <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-xs text-dust"><span className="inline-block h-2 w-2 rounded-full" style={{ background: ENGINE[r.engine].color }} />{ENGINE[r.engine].label}{r.subtitle ? ` · ${r.subtitle}` : ''}</p>
                  <p className="mt-1 font-display text-2xl">{r.href ? <Link to={r.href} className="hover:text-amber">{r.title}</Link> : r.title}</p>
                  <p className="mt-1 text-sm text-dust">{r.reason}</p>
                </div>
                <div className="shrink-0 text-right">
                  <p className="text-xs text-dust">confidence</p>
                  <div className="mt-1 h-1.5 w-24 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full" style={{ width: `${Math.round(r.score * 100)}%`, background: ENGINE[r.engine].color }} /></div>
                  <p className="num mt-1 text-xs text-dust">{fmtPct(r.score)}</p>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-3 text-xs">
                <a href={spotifySearchUrl(r.spotifySearch)} target="_blank" rel="noreferrer" className="rounded-full border border-line px-3 py-1.5 text-dust hover:text-cream">Open on Spotify</a>
                {r.engine !== 'structural' && <button onClick={() => radar(r)} className="rounded-full bg-amber px-3 py-1.5 font-medium text-ink">Add to Radar playlist</button>}
                <button onClick={() => feedback(r, 'accepted')} className="text-dust hover:text-moss">Good call</button>
                <button onClick={() => feedback(r, 'dismissed')} className="text-dust hover:text-coral">Not for me</button>
                {r.seeds.length > 0 && <span className="ml-auto text-dust">via {r.seeds.map((s, i) => <span key={s.artistId}>{i > 0 ? ', ' : ''}<Link to={artistHref(s.artistId)} className="hover:text-amber">{s.artist}</Link></span>)}</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="space-y-6">
          <Card title="Release radar" subtitle="New from artists in your library, last 180 days, ranked by your hours with them.">
            {data.releases.length ? (
              <ul className="divide-y divide-line/60 text-sm">
                {data.releases.map((x) => <li key={x.key} className="py-2"><p className="truncate">{x.title}</p><p className="num text-xs text-dust"><Link to={artistHref(x.artistId)} className="hover:text-amber">{x.artist}</Link> · {fmtDate(x.date)} · {fmtHours(x.hours)} with them</p></li>)}
              </ul>
            ) : <p className="text-sm text-dust">Nothing new yet — MusicBrainz fills this in as it resolves your artists.</p>}
          </Card>
          <Card title="Your tag signature" subtitle="Tags you over-index on versus your library's base rate.">
            {data.signature.length ? (
              <ul className="space-y-2 text-sm">
                {data.signature.map((s) => (
                  <li key={s.tag}>
                    <div className="flex items-baseline justify-between"><span>{s.tag}</span><span className="num text-xs text-dust">×{s.lift.toFixed(2)}</span></div>
                    <div className="h-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/70" style={{ width: `${Math.min(100, s.lift * 40)}%` }} /></div>
                    <p className="truncate text-[11px] text-dust">{s.topArtists.join(', ')}</p>
                  </li>
                ))}
              </ul>
            ) : <p className="text-sm text-dust">Connect Last.fm to build your tag signature.</p>}
          </Card>
          <Card title="Songs about…" subtitle={lyr.data ? `Lyric themes known for ${fmtInt(Math.round(lyr.data.coverage * 100))}% of your top 2,000 tracks. Try rain, night, purple, city.` : 'Lyric themes from LRCLIB (enable in Settings).'}>
            <input value={lq} onChange={(e) => setLq(e.target.value)} placeholder="rain, night, purple…" className="w-full rounded-full border border-line bg-ink px-4 py-1.5 text-sm" aria-label="Lyric theme" />
            {lyr.data && lyr.data.hits.length > 0 && (
              <>
                <ul className="mt-3 divide-y divide-line/60 text-sm">{lyr.data.hits.slice(0, 12).map((t) => <li key={t.trackId} className="flex justify-between gap-2 py-1.5"><span className="truncate"><Link to={`/track/${encodeURIComponent(t.trackId)}`} className="hover:text-amber">{t.track}</Link><span className="ml-2 text-xs text-dust">{t.artist}</span></span><span className="num shrink-0 text-xs text-dust">{t.plays}×</span></li>)}</ul>
                <div className="mt-3"><MakePlaylistButton small name={`Songs about ${dlq}`} tracks={lyr.data.hits} kind="theme" description={`Songs whose lyrics touch on ${dlq}. Made with Deep Cuts.`} note={`lyrics:${dlq}`} pool={lyr.data.hits} /></div>
              </>
            )}
            {lyr.data && dlq.length >= 2 && lyr.data.hits.length === 0 && <p className="mt-3 text-sm text-dust">No matches yet — lyric features fill in gradually.</p>}
          </Card>
          <button onClick={reload} className="text-xs text-dust hover:text-cream">Refresh suggestions</button>
        </div>
      </div>
    </div>
  );
}
