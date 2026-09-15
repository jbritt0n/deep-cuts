import { Link } from 'react-router-dom';
import { C } from '@/lib/theme';
import * as M from '@/lib/metricQueries';
import { useAsync, useFilter } from '@/lib/hooks';
import { albumHref, artistHref, fmtDate, fmtHours, fmtInt, fmtPct } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { Histogram, YearLines } from '@/components/charts/Bars';
import { WordCloud } from '@/components/charts/WordCloud';
import { TrackList } from '@/components/Lists';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { useState } from 'react';
import type { TrackRow } from '@/lib/types';

/** Phase 9c — Insights, rebuilt as the home for the app's own metrics now that Eras has its own page. */
export function InsightsPage() {
  const { filter } = useFilter();
  const dc = useAsync(M.deepCuts, [filter]);
  const loy = useAsync(() => M.albumLoyalty(), [filter]);
  const sil = useAsync(M.silenceReport, [filter]);
  const vel = useAsync(() => M.velocity(), [filter]);
  const hand = useAsync(M.deviceHandoff, [filter]);
  const expl = useAsync(M.explicitShare, [filter]);
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Insights" title="The record's own metrics" meta="Deep cuts, spread, loyalty, silence, pace — numbers about how you listen, not what. Eras and the behavioural detectors moved to their own page." />

      <Section title="Deep cuts" subtitle="For each artist, your five most-played songs are the hits; everything else is a deep cut. The ratio is the share of plays going past the hits — a measure of you, not of them." state={dc}>
        {(d) => (
          <div>
            <div className="mb-6 grid gap-8 lg:grid-cols-[auto_minmax(0,560px)] lg:items-end">
              <div><p className="num font-display text-6xl text-amber">{fmtPct(d.overall)}</p><p className="text-xs text-dust">of your plays, across artists with 6+ songs, go to deep cuts</p></div>
              <div><p className="mb-1 text-xs text-dust">Deep-cut ratio by year</p>{d.byYear.length > 1 ? <YearLines rows={d.byYear} series={[{ key: 'r', label: 'Deep-cut ratio', color: C.amber, values: d.byYear.map((y) => y.ratio), format: fmtPct }]} /> : <Muted>Needs two years.</Muted>}</div>
            </div>
            <div className="grid gap-6 lg:grid-cols-3">
              <ArtistCol title="Deepest digging" note="artists where you go furthest past the hits" rows={d.deepest} render={(a) => `${fmtPct(a.ratio)} deep cuts · ${a.tracks} songs`} />
              <ArtistCol title="Spread score" note="most-played artists whose top song takes the smallest share — love spread across the catalogue" rows={d.spread} render={(a) => `top song ${fmtPct(a.topShare)} of ${fmtInt(a.plays)} plays`} />
              <ArtistCol title="One-song relationships" note="the opposite: one track is most of it" rows={d.oneSong} render={(a) => `${a.topTrack ?? 'one song'} · ${fmtPct(a.topShare)}`} />
            </div>
          </div>
        )}
      </Section>

      <Section title="Album loyalty" subtitle="Artists you know through one record: one album is 70 %+ of your plays with them, across three or more albums heard. Trend compares the later half of your history with them to the earlier half." state={loy}>
        {(rows) => rows.length === 0 ? <Muted>No one-album relationships yet — or you spread your listening evenly.</Muted> : (
          <ul className="grid gap-2 md:grid-cols-2">
            {rows.map((r) => <li key={r.artistId} className="flex items-center gap-3 rounded-xl border border-line bg-ink/40 px-3 py-2 text-sm">
              <div className="min-w-0 flex-1"><Link to={artistHref(r.artistId)} className="truncate hover:text-amber">{r.artist}</Link><p className="truncate text-xs text-dust">{r.albumId ? <Link to={albumHref(r.albumId)} className="hover:text-amber">{r.album}</Link> : r.album} · {r.albums} albums heard</p></div>
              <div className="w-28 shrink-0"><div className="h-1.5 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-moss/80" style={{ width: `${r.share * 100}%` }} /></div><p className="num mt-0.5 text-right text-xs text-dust">{fmtPct(r.share)}{r.trend != null && Math.abs(r.trend) >= 0.1 ? <span className={r.trend > 0 ? 'text-amber' : 'text-moss'}> {r.trend > 0 ? '↑ tightening' : '↓ widening'}</span> : ''}</p></div>
            </li>)}
          </ul>
        )}
      </Section>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="Pace" subtitle="Hours per week — a rate, not a total." state={vel} flush>
          {(v) => (
            <div>
              <p className="num font-display text-4xl">{v.last12.toFixed(1)} <span className="text-base text-dust">h / week, last 12 weeks</span></p>
              <p className="num mt-1 text-xs text-dust">{v.prior12 > 0 ? <>{v.last12 >= v.prior12 ? '+' : '−'}{fmtPct(Math.abs(v.last12 - v.prior12) / v.prior12)} vs the 12 before · </> : null}all-time {v.allTimeWeekly.toFixed(1)} h / week</p>
              <div className="mt-4"><Histogram data={v.series.slice(-52).map((w) => ({ label: w.week.slice(5, 10), value: w.hours }))} color={C.amber} /></div>
              <p className="mt-1 text-[11px] text-dust/70">Last 52 weeks.</p>
            </div>
          )}
        </Section>
        <Section title="Silence" subtitle="The quietest stretches of the record — where life got in the way." state={sil} flush>
          {(s) => (
            <div>
              <p className="num text-xs text-dust">Dark days per year: {s.byYear.map((y) => `${y.year} ${y.darkDays}/${y.totalDays}`).join(' · ')}</p>
              {s.currentGapDays > 3 && <p className="mt-1 text-xs text-amber">It's been {s.currentGapDays} days since the last play under this lens.</p>}
              {s.gaps.length ? <ul className="mt-3 divide-y divide-line/60 text-sm">{s.gaps.slice(0, 7).map((g) => <li key={g.from} className="flex items-baseline gap-3 py-1.5"><span className="num w-14 shrink-0 font-display text-xl">{g.days}<span className="text-xs text-dust"> d</span></span><span className="min-w-0 flex-1 truncate"><Link to={`/day/${g.from}`} className="num text-xs text-dust hover:text-amber">{fmtDate(g.from, { month: 'short', day: 'numeric', year: 'numeric' })}</Link> → <Link to={`/day/${g.to}`} className="num text-xs text-dust hover:text-amber">{fmtDate(g.to, { month: 'short', day: 'numeric', year: 'numeric' })}</Link><span className="block truncate text-xs text-dust">{g.before ? `left on ${g.before}` : ''}{g.after ? ` · came back with ${g.after}` : ''}</span></span></li>)}</ul> : <Muted>No gap longer than three days. Relentless.</Muted>}
            </div>
          )}
        </Section>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Section title="Device hand-offs" subtitle="Sessions (5+ plays) that start on one device family and finish on another. Plumbing the session stitcher already does, surfaced." state={hand} flush>
          {(h) => h.rows.length === 0 ? <Muted>Every session stays on one device.</Muted> : (
            <div>
              <p className="num font-display text-4xl">{fmtPct(h.multiDeviceShare)} <span className="text-base text-dust">of sessions change device</span></p>
              <p className="num mt-1 text-xs text-dust">{fmtPct(h.longShare)} of hour-plus sessions do.</p>
              <ul className="mt-3 space-y-1.5 text-sm">{h.rows.map((r) => <li key={r.from + r.to} className="flex items-center gap-3"><span className="w-40 shrink-0 capitalize">{r.from} → {r.to}</span><div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-violet/80" style={{ width: `${Math.min(100, r.share * 100 / Math.max(h.rows[0].share, 0.01))}%` }} /></div><span className="num w-20 text-right text-xs text-dust">{fmtInt(r.sessions)} · {fmtPct(r.share)}</span></li>)}</ul>
            </div>
          )}
        </Section>
        <Section title="Explicit share" subtitle="Share of plays flagged explicit by Spotify, by year, where the flag is known." state={expl} flush>
          {(rows) => rows.length < 2 ? <Muted>Not enough enriched tracks yet — this fills in as Spotify enrichment runs.</Muted> : <YearLines rows={rows} series={[{ key: 'e', label: 'Explicit', color: C.coral, values: rows.map((r) => r.share), format: fmtPct }]} />}
        </Section>
      </div>
      <div className="mt-6"><LyricCloudCard /></div>
      <p className="mt-8 text-xs text-dust/70">Looking for eras, obsessions, comebacks or the 3 AM canon? They live on <Link to="/eras" className="underline hover:text-cream">Eras</Link> now.</p>
    </div>
  );
}

function Section<T>({ title, subtitle, state, children, flush = false }: { title: string; subtitle: string; state: { data: T | null; error: string | null }; children: (d: T) => React.ReactNode; flush?: boolean }) {
  return <div className={flush ? '' : 'mt-6'}><Card title={title} subtitle={subtitle}>{state.error ? <ErrorBox message={state.error} /> : state.data === null ? <Loading label="Computing…" /> : children(state.data)}</Card></div>;
}
const Muted = ({ children }: { children: React.ReactNode }) => <p className="text-sm text-dust">{children}</p>;
function ArtistCol({ title, note, rows, render }: { title: string; note: string; rows: M.DeepCutArtist[]; render: (a: M.DeepCutArtist) => string }) {
  return (
    <div>
      <p className="text-sm">{title}</p><p className="mb-2 text-xs text-dust">{note}</p>
      {rows.length ? <ol className="divide-y divide-line/60 text-sm">{rows.map((a, i) => <li key={a.artistId} className="flex items-baseline gap-2 py-1.5"><span className="num w-5 text-xs text-dust">{i + 1}</span><Link to={artistHref(a.artistId)} className="min-w-0 flex-1 truncate hover:text-amber">{a.artist}</Link><span className="num shrink-0 text-xs text-dust">{render(a)}</span></li>)}</ol> : <Muted>Not enough plays yet.</Muted>}
    </div>
  );
}
export { fmtHours };

/** Phase 9e — lyric keywords as a cloud, weighted by your plays. Click a word for the tracks behind it. */
function LyricCloudCard() {
  const { filter } = useFilter();
  const [kind, setKind] = useState<'keywords' | 'themes'>('keywords');
  const [year, setYear] = useState<number | null>(null);
  const [picked, setPicked] = useState<string | null>(null);
  const cloud = useAsync(() => M.lyricCloud(kind, year), [filter, kind, year]);
  const tracks = useAsync(() => (picked ? M.lyricTracksFor(picked, kind) : Promise.resolve(null)), [picked, kind, filter]);
  const years: number[] = []; for (let y = new Date().getFullYear(); y >= new Date().getFullYear() - 6; y--) years.push(y);
  return (
    <Card title="Lyric keywords" subtitle={cloud.data ? `Words that recur in the lyrics of what you play, sized by plays. Lyrics come from LRCLIB and are reduced to keywords on arrival — the text itself is never stored. Covers ${fmtInt(cloud.data.coveredTracks)} of ${fmtInt(cloud.data.totalTracks)} tracks so far.` : 'Words that recur in the lyrics of what you play.'}
      aside={<div className="flex flex-wrap gap-1 text-xs">{(['keywords', 'themes'] as const).map((k) => <button key={k} onClick={() => { setKind(k); setPicked(null); }} className={`rounded-full px-3 py-1 ${kind === k ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{k}</button>)}<select value={year ?? ''} onChange={(e) => { setYear(e.target.value ? Number(e.target.value) : null); setPicked(null); }} className="rounded-lg border border-line bg-ink px-2 py-1" aria-label="Year"><option value="">all years</option>{years.map((y) => <option key={y} value={y}>{y}</option>)}</select></div>}>
      {cloud.error ? <ErrorBox message={cloud.error} /> : !cloud.data ? <Loading label="Gathering words…" /> : cloud.data.words.length === 0 ? <p className="text-sm text-dust">No lyric features yet. Turn on lyric themes in Settings → Connectors and give LRCLIB a little while.</p> : (
        <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
          <WordCloud words={cloud.data.words.map((w) => ({ text: w.text, weight: w.weight, note: `${fmtInt(w.weight)} plays across ${w.tracks} tracks` }))} onPick={(w) => setPicked(w.text)} picked={picked} />
          <div className="min-w-0">
            {!picked ? <p className="text-sm text-dust">Click a word to see the songs that carry it — and turn them into a playlist.</p> : (
              <div>
                <div className="mb-2 flex items-baseline justify-between"><p className="text-sm">Songs with <span className="font-display text-lg text-coral">“{picked}”</span></p>{tracks.data && tracks.data.length > 0 && <MakePlaylistButton small label="Make playlist" name={`Deep Cuts · ${picked}`} tracks={tracks.data as TrackRow[]} kind="insight" note={`lyric:${kind}:${picked}`} pool={tracks.data as TrackRow[]} />}</div>
                {!tracks.data ? <Loading /> : <TrackList data={tracks.data as TrackRow[]} />}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  );
}
