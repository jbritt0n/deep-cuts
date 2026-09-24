import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { QueueButton } from '@/components/QueueButton';
import { artistSound, flowFeatures, mixInto, sessionArc, soundAlike, tempoStations } from '@/lib/featureQueries';
import { C } from '@/lib/theme';
import { meanCost, smoothOrder } from '@/lib/harmonic';
import { artistHref, fmtInt, fmtPct, trackHref } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';
import type { TrackRow } from '@/lib/types';

/** Phase 9j — Song page: your tracks closest in sound (FreqBlog features). */
export function SoundsLike({ trackId, track }: { trackId: string; track: string }) {
  const { filter } = useFilter();
  const s = useAsync(() => soundAlike(trackId, 12), [trackId, filter]);
  if (s.error) return <Card title="Sounds like this"><ErrorBox message={s.error} /></Card>;
  if (!s.data?.seed) return null;   // no features for this song yet
  const d = s.data;
  return (
    <Card title="Sounds like this" subtitle={`From your own record — nearest in tempo, energy, loudness and key to ${d.seed!.bpm ? `${Math.round(d.seed!.bpm)} bpm` : ''}${d.seed!.key ? ` · ${d.seed!.key}` : ''}${d.seed!.camelot ? ` (${d.seed!.camelot})` : ''}.`}
      aside={d.tracks.length > 2 ? <span className="flex items-center gap-2"><KeepFresh trackId={trackId} track={track} /><MakePlaylistButton small label="Make a playlist" name={`Sounds like ${track}`} kind="insight" description="Songs from your record nearest in sound (tempo, energy, key)." tracks={d.tracks.map((t) => ({ trackId: t.trackId, track: t.track, artistId: t.artistId, artist: t.artist, plays: t.plays, hours: 0, skipRate: 0 }) as TrackRow)} /></span> : undefined}>
      <ul className="space-y-1 text-sm">
        {d.tracks.map((t) => (
          <li key={t.trackId} className="flex items-center gap-2">
            <QueueButton trackId={t.trackId} />
            <span className="min-w-0 flex-1 truncate"><Link to={trackHref(t.trackId)} className="hover:text-amber">{t.track}</Link> <span className="text-xs text-dust">{t.artistId ? <Link to={artistHref(t.artistId)} className="hover:text-cream">{t.artist}</Link> : t.artist}{t.sameArtist ? ' · same artist' : ''}</span></span>
            <span className="num shrink-0 text-[11px] text-dust">{t.bpm ? `${Math.round(t.bpm)} bpm` : ''}{t.camelot ? ` · ${t.camelot}` : ''}{t.energy != null ? ` · ${t.energy.toFixed(2)}` : ''}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Phase 9j — Artist page: their sound vs yours. */
export function ArtistSoundCard({ artistId, artist }: { artistId: string; artist: string }) {
  const { filter } = useFilter();
  const s = useAsync(() => artistSound(artistId), [artistId, filter]);
  if (!s.data) return null;
  const d = s.data;
  const Bar = ({ label, v, you, fmt, max }: { label: string; v: number; you: number; fmt: (x: number) => string; max: number }) => (
    <div className="text-sm"><div className="flex justify-between text-xs text-dust"><span>{label}</span><span className="num">{fmt(v)} <span className="text-dust/60">· you {fmt(you)}</span></span></div>
      <div className="relative mt-1 h-1.5 rounded-full bg-raised"><div className="h-full rounded-full bg-amber/80" style={{ width: `${Math.min(100, (v / max) * 100)}%` }} /><div className="absolute top-[-3px] h-3 w-0.5 bg-cream/70" style={{ left: `${Math.min(100, (you / max) * 100)}%` }} title="your average" /></div></div>
  );
  return (
    <Card title={`How ${artist} sounds`} subtitle={`Across the ${d.tracks} of their songs you play (FreqBlog), against your whole record — the white tick is you.${d.topKey ? ` Most common key: ${d.topKey}.` : ''}`}>
      <div className="space-y-3">
        <Bar label="Tempo" v={d.bpm} you={d.you.bpm} fmt={(x) => `${Math.round(x)} bpm`} max={180} />
        <Bar label="Energy" v={d.energy} you={d.you.energy} fmt={(x) => x.toFixed(2)} max={1} />
        <Bar label="Minor keys" v={d.minorShare} you={d.you.minorShare} fmt={fmtPct} max={1} />
      </div>
    </Card>
  );
}

/** Phase 9j — Library playlist: reorder for flow and save as a new playlist (the original is untouched). */
export function SmoothOrderButton({ name, tracks }: { name: string; tracks: TrackRow[] }) {
  const [out, setOut] = useState<{ tracks: TrackRow[]; before: number; after: number; covered: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      const f = await flowFeatures(tracks.map((t) => t.trackId).filter(Boolean) as string[]);
      const withF = tracks.filter((t) => t.trackId && f.has(t.trackId)).map((t) => ({ ...t, ...f.get(t.trackId!)! }));
      const rest = tracks.filter((t) => !t.trackId || !f.has(t.trackId));
      const ordered = smoothOrder(withF);
      setOut({ tracks: [...ordered, ...rest], before: meanCost(withF), after: meanCost(ordered), covered: withF.length });
    } finally { setBusy(false); }
  };
  if (!out) return <button disabled={busy || tracks.length < 3} onClick={run} title="Reorder so each song flows into the next — compatible keys, close tempos, a gentle energy curve" className="rounded-full border border-line px-3 py-1 text-xs text-dust hover:text-cream disabled:opacity-40">{busy ? 'Ordering…' : 'Smooth order'}</button>;
  const gain = out.before > 0 ? 1 - out.after / out.before : 0;
  return (
    <span className="inline-flex flex-wrap items-center gap-2 text-xs text-dust">
      <span>{out.covered < 3 ? 'Too few songs with audio features yet.' : `${Math.round(gain * 100)}% smoother (${out.covered} of ${tracks.length} songs have key & tempo)`}</span>
      {out.covered >= 3 && <MakePlaylistButton small label="Save as new playlist" name={`${name} · smooth order`} kind="list_export" description="Reordered by Deep Cuts for flow: compatible keys, close tempos." tracks={out.tracks} />}
    </span>
  );
}

// ============================================================================ Phase 9k

/** Moods & Forecast — stations by tempo, from your own rarely-skipped songs. */
export function TempoDial() {
  const { filter } = useFilter();
  const [energy, setEnergy] = useState<'any' | 'high' | 'low'>('any');
  const st = useAsync(() => tempoStations(energy, 25), [filter, energy]);
  const [open, setOpen] = useState<string | null>(null);
  if (st.error) return <Card title="The tempo dial"><ErrorBox message={st.error} /></Card>;
  if (!st.data) return null;
  if (st.data.every((b) => b.total === 0)) return <Card title="The tempo dial" subtitle="Stations by beats per minute — needs audio features from FreqBlog (Services)."><p className="text-sm text-dust">No tempo data yet.</p></Card>;
  const max = Math.max(...st.data.map((b) => b.total), 1);
  return (
    <Card title="The tempo dial" subtitle="Your own rarely-skipped songs, tuned by beats per minute. Pick a band for a ready-made playlist." aside={<div className="flex gap-1 text-xs">{(['any', 'high', 'low'] as const).map((e) => <button key={e} onClick={() => setEnergy(e)} className={`rounded-full px-3 py-1 ${energy === e ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{e === 'any' ? 'any energy' : `${e} energy`}</button>)}</div>}>
      <div className="grid gap-2 sm:grid-cols-5">
        {st.data.map((b) => (
          <button key={b.id} onClick={() => setOpen(open === b.id ? null : b.id)} disabled={!b.total} className={`rounded-xl border p-3 text-left disabled:opacity-40 ${open === b.id ? 'border-amber bg-amber/5' : 'border-line bg-ink/30 hover:border-dust'}`}>
            <p className="font-display text-lg">{b.label}</p>
            <p className="text-[11px] text-dust">{b.blurb}</p>
            <div className="mt-2 h-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/80" style={{ width: `${(b.total / max) * 100}%` }} /></div>
            <p className="num mt-1 text-[11px] text-dust">{fmtInt(b.total)} songs</p>
          </button>
        ))}
      </div>
      {open && (() => { const b = st.data!.find((x) => x.id === open)!; return (
        <div className="mt-4">
          <div className="mb-2 flex items-center justify-between"><p className="text-sm">{b.label} · {b.tracks.length} most-played</p><MakePlaylistButton small label="Make this station" name={`Tempo · ${b.label}${energy !== 'any' ? ` (${energy} energy)` : ''}`} kind="insight" description={`Songs you play, ${b.blurb}.`} tracks={b.tracks.map((t) => ({ trackId: t.trackId, track: t.track, artistId: t.artistId, artist: t.artist, plays: t.plays, hours: 0, skipRate: 0 }) as TrackRow)} /></div>
          <ul className="grid gap-x-6 gap-y-1 text-sm md:grid-cols-2">{b.tracks.slice(0, 16).map((t) => <li key={t.trackId} className="flex items-center gap-2"><QueueButton trackId={t.trackId} /><Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track} <span className="text-xs text-dust">{t.artist}</span></Link><span className="num text-[11px] text-dust">{Math.round(t.bpm)}</span></li>)}</ul>
        </div>
      ); })()}
    </Card>
  );
}

/** Session detail — energy (line) and tempo (dots) of each play in order; skips marked. */
export function SessionArc({ sessionId }: { sessionId: string }) {
  const a = useAsync(() => sessionArc(sessionId), [sessionId]);
  if (!a.data || a.data.filter((p) => p.energy != null).length < 3) return null;
  const pts = a.data; const W = 640, H = 120, pad = 8;
  const x = (i: number) => pad + (i / Math.max(1, pts.length - 1)) * (W - 2 * pad);
  const yE = (e: number) => H - pad - e * (H - 2 * pad);
  const bpms = pts.map((p) => p.bpm).filter((b): b is number => b != null); const lo = Math.min(...bpms, 60), hi = Math.max(...bpms, 180);
  const yB = (b: number) => H - pad - ((b - lo) / Math.max(1, hi - lo)) * (H - 2 * pad);
  const line = pts.filter((p) => p.energy != null).map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${yE(p.energy!).toFixed(1)}`).join(' ');
  const mean = (xs: number[]) => xs.reduce((s, v) => s + v, 0) / Math.max(1, xs.length);
  const half = Math.floor(pts.length / 2);
  const e1 = mean(pts.slice(0, half).map((p) => p.energy ?? NaN).filter((v) => !Number.isNaN(v))), e2 = mean(pts.slice(half).map((p) => p.energy ?? NaN).filter((v) => !Number.isNaN(v)));
  const shape = e2 - e1 > 0.12 ? 'built up' : e1 - e2 > 0.12 ? 'wound down' : 'held steady';
  return (
    <Card title="The session as sound" subtitle={`Energy (line) and tempo (dots) of each play in order — this session ${shape}. Skips in coral.`}>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Energy and tempo across the session">
        <path d={line} fill="none" stroke={C.amber} strokeWidth="2" strokeLinejoin="round" />
        {pts.map((p) => p.bpm != null && <circle key={p.i} cx={x(p.i)} cy={yB(p.bpm)} r="2.5" fill={p.skipped ? C.coral : C.violet} opacity="0.8"><title>{p.track} — {p.artist} · {Math.round(p.bpm)} bpm{p.energy != null ? ` · energy ${p.energy.toFixed(2)}` : ''}{p.skipped ? ' · skipped' : ''}</title></circle>)}
      </svg>
      <p className="num mt-1 flex justify-between text-[11px] text-dust"><span>{pts[0].at.slice(11, 16)}</span><span>{Math.round(lo)}–{Math.round(hi)} bpm</span><span>{pts[pts.length - 1].at.slice(11, 16)}</span></p>
    </Card>
  );
}

/** Song page — what mixes in well next (compatible key, tempo within 6 %). */
export function MixInto({ trackId }: { trackId: string }) {
  const m = useAsync(() => mixInto(trackId, 10), [trackId]);
  if (!m.data || !m.data.tracks.length) return null;
  return (
    <Card title="Mix into next" subtitle={`From your record: compatible key with ${m.data.camelot ?? '—'} and within 6 % of ${Math.round(m.data.bpm)} bpm (half/double time counts). Queue one and it'll flow.`}>
      <ul className="space-y-1 text-sm">{m.data.tracks.map((t) => <li key={t.trackId} className="flex items-center gap-2"><QueueButton trackId={t.trackId} /><Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track} <span className="text-xs text-dust">{t.artist}</span></Link><span className="num shrink-0 text-[11px] text-dust">{Math.round(t.bpm)} bpm · {t.camelot}{t.keyStep === 0 ? ' · same key' : ''}</span></li>)}</ul>
    </Card>
  );
}

/** Turn "Sounds like this" into a weekly dynamic playlist (Library → Dynamic). */
function KeepFresh({ trackId, track }: { trackId: string; track: string }) {
  const [done, setDone] = useState(false);
  const add = async () => {
    const m = await import('@/lib/dynamicPlaylists');
    const defs = await m.loadDynamic();
    if (!defs.some((x) => x.rule.kind === 'soundsLike' && x.rule.trackId === trackId)) defs.push({ id: m.newId(), name: `DC · Sounds like ${track}`, rule: { kind: 'soundsLike', trackId, track }, size: 25, cadence: 'weekly', autoSync: false, spotifyId: null, spotifyUrl: null, lastBuiltAt: null, lastSyncedAt: null, lastTrackIds: [] });
    await m.saveDynamic(defs); setDone(true);
  };
  return done ? <Link to="/library?tab=dynamic" className="text-xs text-moss hover:underline">added to Dynamic →</Link> : <button onClick={add} title="Add as a weekly dynamic playlist (Library → Dynamic)" className="rounded-full border border-line px-3 py-1 text-xs text-dust hover:text-cream">Keep it fresh</button>;
}
