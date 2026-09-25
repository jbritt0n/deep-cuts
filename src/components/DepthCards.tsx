import { Link } from 'react-router-dom';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { ACTIVITY_RULES, activities, antiRecommendations, blindSpots, bubbleScores, durationPreference } from '@/lib/depthQueries';
import { artistHref, fmtHours, fmtInt, fmtPct, trackHref } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';

const Bar = ({ v, max = 1, tone = 'bg-amber/80' }: { v: number; max?: number; tone?: string }) => <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-raised"><div className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, (v / Math.max(1e-9, max)) * 100)}%` }} /></div>;

/** Discover — how wide your listening is, year by year. */
export function BubbleCard() {
  const { filter } = useFilter();
  const b = useAsync(bubbleScores, [filter]);
  if (b.error) return <Card title="Your bubble"><ErrorBox message={b.error} /></Card>;
  if (!b.data) return <Card title="Your bubble"><Loading /></Card>;
  const ys = b.data; const last = ys[ys.length - 1], prev = ys[ys.length - 2];
  return (
    <Card title="Your bubble" subtitle="How widely your listening spreads across scene families: 0 = one family, 100 = evenly across every family you've ever touched. Effective artists = how many artists, played equally, would give the same spread.">
      {!last ? <p className="text-sm text-dust">Needs scene filing (Settings → Tuning → Scenes).</p> : (
        <>
          <p className="font-display text-4xl num">{last.score}<span className="text-base text-dust"> / 100 in {last.year}</span></p>
          <p className="mt-1 text-sm text-dust">{prev ? (last.score > prev.score + 4 ? `Wider than ${prev.year} (${prev.score}) — you've been branching out.` : last.score < prev.score - 4 ? `Narrower than ${prev.year} (${prev.score}) — a tighter bubble this year.` : `About the same as ${prev.year} (${prev.score}).`) : ''} {fmtInt(last.effectiveArtists)} effective artists across {last.families} families.</p>
          <ul className="mt-3 space-y-1 text-sm">{ys.map((y) => <li key={y.year} className="flex items-center gap-3"><span className="num w-12 text-xs text-dust">{y.year}</span><Bar v={y.score} max={100} tone="bg-violet/80" /><span className="num w-36 text-right text-[11px] text-dust">{y.score} · {fmtInt(y.effectiveArtists)} eff. artists</span></li>)}</ul>
        </>
      )}
    </Card>
  );
}

/** Discover — what you haven't explored. */
export function BlindSpotsCard() {
  const { filter } = useFilter();
  const b = useAsync(blindSpots, [filter]);
  if (b.error) return <Card title="Blind spots"><ErrorBox message={b.error} /></Card>;
  if (!b.data) return <Card title="Blind spots"><Loading /></Card>;
  const d = b.data;
  return (
    <Card title="Blind spots" subtitle="Where your own taste points but your listening hasn't gone.">
      <div className="grid gap-6 lg:grid-cols-2">
        <div>
          <p className="mb-1 text-xs text-dust">Artists your favourites keep pointing to — never played (Last.fm similar artists)</p>
          {d.neverPlayed.length === 0 ? <p className="text-sm text-dust">None yet — Last.fm's similar-artist links fill in as the connector runs.</p> : (
            <ul className="space-y-1 text-sm">{d.neverPlayed.slice(0, 12).map((a) => <li key={a.name} className="flex items-baseline gap-2"><a href={`https://www.last.fm/music/${encodeURIComponent(a.name)}`} target="_blank" rel="noreferrer" className="min-w-0 flex-1 truncate hover:text-amber">{a.name}</a><span className="truncate text-[11px] text-dust" title={a.via.join(', ')}>via {a.via.slice(0, 2).join(', ')}{a.pointers > 2 ? ` +${a.pointers - 2}` : ''}</span></li>)}</ul>
          )}
        </div>
        <div className="space-y-4">
          <div>
            <p className="mb-1 text-xs text-dust">Scenes on your doorstep — tagged on artists you play, but under 1 % of your hours</p>
            {d.doorstep.length === 0 ? <p className="text-sm text-dust">—</p> : <ul className="space-y-1 text-sm">{d.doorstep.map((s) => <li key={s.scene} className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate">{s.label}</span><span className="truncate text-[11px] text-dust" title={s.examples.join(', ')}>{s.touching} of your artists · {fmtPct(s.hoursShare)}</span></li>)}</ul>}
          </div>
          {d.decades.length > 0 && <p className="text-sm"><span className="text-xs text-dust">Decades you've barely touched: </span>{d.decades.map((x) => `${x.decade}s`).join(' · ')}</p>}
          {d.regions.length > 0 && <p className="text-sm"><span className="text-xs text-dust">Regions with nothing filed yet: </span>{d.regions.slice(0, 10).map((r) => r.label).join(' · ')}{d.regions.length > 10 ? ` +${d.regions.length - 10}` : ''}</p>}
        </div>
      </div>
    </Card>
  );
}

/** Discover — should like, but don't. */
export function AntiRecsCard() {
  const { filter } = useFilter();
  const a = useAsync(antiRecommendations, [filter]);
  if (a.error) return <Card title="Should like, but don't"><ErrorBox message={a.error} /></Card>;
  if (!a.data) return <Card title="Should like, but don't"><Loading /></Card>;
  return (
    <Card title="Should like, but don't" subtitle="Artists your taste says are for you — similar to your favourites or carrying your core tags — that you keep skipping. Useful to know before a recommendation engine keeps offering them.">
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        {a.data.artists.length === 0 ? <p className="text-sm text-dust">Nobody — your taste and your skips agree.</p> : (
          <ul className="space-y-1 text-sm">{a.data.artists.map((x) => <li key={x.artistId} className="flex items-baseline gap-2"><Link to={artistHref(x.artistId)} className="min-w-0 flex-1 truncate hover:text-amber">{x.artist}</Link><span className="truncate text-[11px] text-dust" title={x.why}>{x.why}</span><span className="num shrink-0 text-xs text-coral">{fmtPct(x.skipRate)} of {x.plays}</span></li>)}</ul>
        )}
        <div>
          <p className="mb-1 text-xs text-dust">Tags you skip far more than usual</p>
          {a.data.tags.length === 0 ? <p className="text-sm text-dust">—</p> : <ul className="space-y-1 text-sm">{a.data.tags.map((t) => <li key={t.tag} className="flex items-center gap-2"><span className="w-32 shrink-0 truncate">{t.tag}</span><Bar v={t.skipRate} tone="bg-coral/80" /><span className="num w-24 text-right text-[11px] text-dust">{fmtPct(t.skipRate)} · {t.vsYou.toFixed(1)}× you</span></li>)}</ul>}
        </div>
      </div>
    </Card>
  );
}

const ACT_LABEL: Record<string, string> = { focus: 'Focus', commute: 'Commute', workout: 'Workout', party: 'Party', 'wind-down': 'Wind-down', everyday: 'Everyday' };
/** Sessions — what you were probably doing. */
export function ActivityCard() {
  const { filter } = useFilter();
  const a = useAsync(activities, [filter]);
  if (a.error) return <Card title="What you were doing"><ErrorBox message={a.error} /></Card>;
  if (!a.data) return <Card title="What you were doing"><Loading /></Card>;
  const d = a.data;
  return (
    <Card title="What you were doing" subtitle={`Each session of 10+ minutes labelled from when it happened, how long it ran and what it sounded like. ${d.withFeatures < d.total * 0.5 ? 'Workout, party and wind-down need tempo/energy from FreqBlog — few sessions have it yet, so those are undercounted.' : ''}`}>
      <ul className="space-y-2 text-sm">{d.rows.map((r) => (
        <li key={r.activity} className="grid grid-cols-[6rem_1fr] items-baseline gap-x-3">
          <span className="font-medium">{ACT_LABEL[r.activity]}</span>
          <span className="flex items-center gap-2"><Bar v={r.share} tone={r.activity === 'everyday' ? 'bg-dust/50' : 'bg-amber/80'} /><span className="num w-44 text-right text-[11px] text-dust">{fmtInt(r.sessions)} sessions · {fmtHours(r.hours)} · {fmtPct(r.share)}</span></span>
          <span />
          <span className="truncate text-xs text-dust" title={ACTIVITY_RULES[r.activity]}>{r.topArtists.slice(0, 3).join(' · ')}{r.bpm ? ` · ${Math.round(r.bpm)} bpm` : ''}{r.example && r.activity !== 'everyday' ? <> · <Link to={`/sessions/${r.example}`} className="underline hover:text-cream">longest</Link></> : null}</span>
        </li>
      ))}</ul>
      <details className="mt-3 text-[11px] text-dust"><summary className="cursor-pointer">How sessions are labelled</summary><ul className="mt-1 space-y-0.5">{Object.entries(ACTIVITY_RULES).map(([k, v]) => <li key={k}><span className="text-cream">{ACT_LABEL[k]}</span>: {v}</li>)}</ul><p className="mt-1">Checked in the order workout → party → wind-down → commute → focus; the first match wins.</p></details>
    </Card>
  );
}

/** Insights (Sound) — the length of song you gravitate to. */
export function DurationCard() {
  const { filter } = useFilter();
  const d = useAsync(durationPreference, [filter]);
  if (d.error) return <Card title="Song length"><ErrorBox message={d.error} /></Card>;
  if (!d.data) return <Card title="Song length"><Loading /></Card>;
  const x = d.data; const maxS = Math.max(...x.bands.map((b) => b.share), 0.01);
  return (
    <Card title="Song length" subtitle={x.byYear.length ? `Median song you play: ${x.byYear[x.byYear.length - 1].median.toFixed(1)} min in ${x.byYear[x.byYear.length - 1].year}${x.byYear.length > 1 ? ` (${x.byYear[0].median.toFixed(1)} in ${x.byYear[0].year})` : ''}. Skip rate by length shows where your patience runs out.` : 'Track lengths come from Spotify enrichment.'}>
      <ul className="space-y-1.5 text-sm">{x.bands.map((b) => <li key={b.band} className="flex items-center gap-3"><span className="w-24 shrink-0 text-xs">{b.band}</span><Bar v={b.share} max={maxS} /><span className="num w-44 text-right text-[11px] text-dust">{fmtPct(b.share)} of plays · skips {fmtPct(b.skipRate)}</span></li>)}</ul>
      {x.epics.length > 0 && <div className="mt-3"><p className="mb-1 text-xs text-dust">Epics you keep coming back to (8 min +)</p><ul className="space-y-0.5 text-sm">{x.epics.map((e) => <li key={e.trackId} className="flex gap-2"><Link to={trackHref(e.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{e.track} <span className="text-xs text-dust">{e.artist}</span></Link><span className="num text-[11px] text-dust">{e.minutes.toFixed(0)} min · {e.plays}×</span></li>)}</ul></div>}
    </Card>
  );
}
