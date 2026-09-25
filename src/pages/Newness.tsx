import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { QueueButton } from '@/components/QueueButton';
import { flag } from '@/lib/originQueries';
import { albumHref, artistHref, fmtHours, fmtInt, fmtPct, trackHref } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';
import { newness, newnessTimeline, periodAt, type PeriodKind } from '@/lib/newnessQueries';
import type { TrackRow } from '@/lib/types';

/** Phase 9n — The Newness: what was new to you, by week, month or season. */
export function NewnessPage() {
  const { filter } = useFilter();
  const [kind, setKind] = useState<PeriodKind>('month');
  const [offset, setOffset] = useState(0);
  const period = periodAt(kind, offset);
  const n = useAsync(() => newness(period), [filter, kind, offset]);
  const tl = useAsync(() => newnessTimeline(kind, kind === 'week' ? 16 : kind === 'month' ? 18 : 12), [filter, kind]);
  const d = n.data;
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="The Newness" title="What was new to you" meta="First plays ever — artists, albums and songs — in a week, a month or a season, and which of them stuck around." />
      <div className="mb-6 flex flex-wrap items-center gap-2">
        {(['week', 'month', 'season'] as const).map((k) => <button key={k} onClick={() => { setKind(k); setOffset(0); }} className={`rounded-full px-4 py-1.5 text-sm capitalize ${kind === k ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{k}</button>)}
        <span className="ml-4 flex items-center gap-2">
          <button onClick={() => setOffset((o) => o + 1)} className="rounded-full border border-line px-3 py-1 text-sm text-dust hover:text-cream" aria-label="Previous period">←</button>
          <span className="min-w-[12rem] text-center font-display text-xl">{period.label}</span>
          <button disabled={offset === 0} onClick={() => setOffset((o) => Math.max(0, o - 1))} className="rounded-full border border-line px-3 py-1 text-sm text-dust hover:text-cream disabled:opacity-30" aria-label="Next period">→</button>
        </span>
      </div>

      {n.error ? <ErrorBox message={n.error} /> : !d ? <Loading label="Looking for first plays…" /> : (
        <>
          <section className="grid gap-4 sm:grid-cols-4">
            <Stat v={fmtInt(d.newArtists)} l="new artists" />
            <Stat v={fmtInt(d.newAlbums)} l="new albums" />
            <Stat v={fmtInt(d.newTracksKnown)} l="new songs by artists you knew" />
            <Stat v={fmtPct(d.newShare)} l={`of ${fmtHours(d.hours)} was new · usually ${fmtPct(d.usualShare)}`} tone={d.newShare > d.usualShare * 1.2 ? 'text-moss' : d.newShare < d.usualShare * 0.7 ? 'text-coral' : ''} />
          </section>

          {/* Phase 10b: items-start — a stretched card left the scroll list ending halfway down its box */}
          <section className="mt-6 grid items-start gap-6 lg:grid-cols-[1.5fr_1fr]">
            <Card title="Best finds" subtitle={d.complete ? 'New artists this period, ranked by how much you played them then and since. ● = still playing them in the last 45 days.' : 'New artists so far this period, ranked by plays.'}
              aside={d.finds.length > 2 ? <MakePlaylistButton small label="Make a playlist" name={`The Newness · ${period.label}`} kind="insight" description={`Artists new to you in ${period.label} — their song you played most.`} tracks={d.finds.filter((f) => f.topTrackId).map((f) => ({ trackId: f.topTrackId!, track: f.topTrack ?? '', artistId: f.artistId, artist: f.artist, plays: f.plays, hours: f.hours, skipRate: 0 }) as TrackRow)} /> : undefined}>
              {d.finds.length === 0 ? <p className="text-sm text-dust">No new artists this period.</p> : (
                <ol className="max-h-[min(46rem,72vh)] space-y-1.5 overflow-y-auto pr-1 text-sm">
                  {d.finds.map((f, i) => (
                    <li key={f.artistId} className="flex items-center gap-2">
                      <span className="num w-6 text-right text-xs text-dust">{i + 1}</span>
                      {f.topTrackId && <QueueButton trackId={f.topTrackId} />}
                      <span className="min-w-0 flex-1 truncate"><Link to={artistHref(f.artistId)} className="hover:text-amber">{f.artist}</Link>{f.stillPlaying && <span className="ml-1 text-moss" title="played in the last 45 days">●</span>}
                        <span className="ml-2 text-xs text-dust">{[f.scene, f.country ? `${flag(f.country)}` : null, f.topTrack ? `“${f.topTrack}”` : null].filter(Boolean).join(' · ')}</span></span>
                      <span className="num shrink-0 text-[11px] text-dust" title={`first played ${f.firstPlayed}`}>{f.plays} plays{d.complete && f.laterPlays ? ` · +${fmtInt(f.laterPlays)} since` : ''}</span>
                    </li>
                  ))}
                </ol>
              )}
            </Card>
            <div className="space-y-6">
              <Card title="Where the new came from">
                {d.scenes.length === 0 && d.countries.length === 0 ? <p className="text-sm text-dust">—</p> : (
                  <div className="grid gap-4 sm:grid-cols-2 text-sm">
                    <ul className="space-y-1">{d.scenes.map((s) => <li key={s.label} className="flex justify-between gap-2"><span className="truncate">{s.label}</span><span className="num text-xs text-dust">{s.artists}</span></li>)}</ul>
                    <ul className="space-y-1">{d.countries.map((c) => <li key={c.country} className="flex justify-between gap-2"><span className="truncate">{flag(c.country)} {c.name}</span><span className="num text-xs text-dust">{c.artists}</span></li>)}</ul>
                  </div>
                )}
              </Card>
              <Card title="New albums" subtitle="First played this period, 3+ plays.">
                {d.albums.length === 0 ? <p className="text-sm text-dust">—</p> : <ul className="space-y-1 text-sm">{d.albums.map((a) => <li key={a.albumId} className="flex gap-2"><Link to={albumHref(a.albumId)} className="min-w-0 flex-1 truncate hover:text-amber">{a.album} <span className="text-xs text-dust">{a.artist}</span></Link><span className="num text-[11px] text-dust">{a.plays}</span></li>)}</ul>}
              </Card>
              <Card title="New songs from artists you knew">
                {d.tracksByKnown.length === 0 ? <p className="text-sm text-dust">—</p> : <ul className="space-y-1 text-sm">{d.tracksByKnown.map((t) => <li key={t.trackId} className="flex items-center gap-2"><QueueButton trackId={t.trackId} /><Link to={trackHref(t.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{t.track} <span className="text-xs text-dust">{t.artist}</span></Link><span className="num text-[11px] text-dust">{t.plays}</span></li>)}</ul>}
              </Card>
            </div>
          </section>
        </>
      )}

      <section className="mt-6">
        <Card title={`Discovery by ${kind}`} subtitle="Bars: new artists. Line: share of your listening that was new. Green part: keepers — artists still played 30+ days after that period ended.">
          {!tl.data ? <Loading /> : (() => {
            const pts = tl.data; const maxA = Math.max(1, ...pts.map((p) => p.newArtists)); const maxS = Math.max(0.01, ...pts.map((p) => p.newShare));
            const W = 720, H = 150, bw = W / pts.length;
            return (
              <svg viewBox={`0 0 ${W} ${H + 24}`} className="w-full" role="img" aria-label="Discovery over time">
                {pts.map((p, i) => { const h = (p.newArtists / maxA) * (H - 10), kh = (p.keepers / maxA) * (H - 10); return (
                  <g key={p.from} className="cursor-pointer" onClick={() => setOffset(pts.length - 1 - i)}>
                    <rect x={i * bw + 3} y={H - h} width={bw - 6} height={h} rx="3" fill="var(--c-amber)" opacity={pts.length - 1 - i === offset ? 0.95 : 0.45}><title>{p.label}: {p.newArtists} new artists, {p.keepers} keepers, {Math.round(p.newShare * 100)}% of listening new</title></rect>
                    <rect x={i * bw + 3} y={H - kh} width={bw - 6} height={kh} rx="3" fill="var(--c-moss)" opacity="0.8" />
                    {(i % Math.ceil(pts.length / 6) === 0 || i === pts.length - 1) && <text x={i * bw + bw / 2} y={H + 16} fontSize="10" textAnchor="middle" fill="var(--c-dust)">{p.label.replace('Week of ', '').replace(/ \d{4}$/, '').slice(0, 10)}</text>}
                  </g>
                ); })}
                <path d={pts.map((p, i) => `${i ? 'L' : 'M'}${(i * bw + bw / 2).toFixed(1)},${(H - (p.newShare / maxS) * (H - 10)).toFixed(1)}`).join(' ')} fill="none" stroke="var(--c-cream)" strokeWidth="1.5" strokeDasharray="4 3" />
              </svg>
            );
          })()}
          <p className="text-[11px] text-dust/70">Click a bar to open that {kind}.</p>
        </Card>
      </section>
    </div>
  );
}

const Stat = ({ v, l, tone = '' }: { v: string; l: string; tone?: string }) => <div className="rounded-2xl border border-line bg-surface p-4"><p className={`num font-display text-3xl ${tone}`}>{v}</p><p className="mt-1 text-xs text-dust">{l}</p></div>;
