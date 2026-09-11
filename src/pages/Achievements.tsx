import { C } from '@/lib/theme';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { achievements, albumCompleteness } from '@/lib/phase4Queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { albumHref, artistHref, fmtDate, fmtPct } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';

const TIER = { bronze: '#B87333', silver: '#B9B9C6', gold: C.amber };

export function AchievementsPage() {
  const { filter } = useFilter();
  const { data, error } = useAsync(achievements, [filter]);
  const [threshold, setThreshold] = useState(0.8);
  const [scope, setScope] = useState<'day' | 'session'>('day');
  const albums = useAsync(() => albumCompleteness(threshold, 6, scope, 40), [threshold, scope, filter]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const earned = data.filter((a) => a.earned);
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Achievements" title={`${earned.length} of ${data.length} on the shelf`} meta="Quiet badges computed from the record. No notifications unless you ask." />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {data.map((a) => (
          <div key={a.id} className={`rounded-2xl border p-5 ${a.earned ? 'border-line bg-surface' : 'border-line/50 bg-ink/30 opacity-60'}`}>
            <div className="flex items-start gap-3">
              <span aria-hidden className="relative mt-1 block h-8 w-8 shrink-0 rounded-full border" style={{ borderColor: a.earned ? TIER[a.tier] : C.line }}>
                <span className="absolute inset-[9px] rounded-full" style={{ background: a.earned ? TIER[a.tier] : C.line }} />
              </span>
              <div className="min-w-0">
                <p className="font-display text-xl">{a.title}</p>
                <p className="text-xs text-dust">{a.blurb}</p>
                <p className="num mt-2 truncate text-sm">{a.href ? <Link to={a.href} className="hover:text-amber">{a.value}</Link> : a.value}</p>
                {a.date && <p className="num text-xs text-dust">{fmtDate(a.date)}</p>}
              </div>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-8">
        <Card title="Albums heard whole" subtitle="Albums where you played at least this share of the tracks within one day or one session, and how many times."
          aside={<div className="flex items-center gap-3 text-xs text-dust">
            <label className="flex items-center gap-2">threshold <input type="range" min={50} max={100} step={5} value={Math.round(threshold * 100)} onChange={(e) => setThreshold(Number(e.target.value) / 100)} /> <span className="num w-9">{fmtPct(threshold)}</span></label>
            <div className="flex overflow-hidden rounded-full border border-line">{(['day', 'session'] as const).map((s) => <button key={s} onClick={() => setScope(s)} className={`px-3 py-1 ${scope === s ? 'bg-raised text-cream' : 'text-dust'}`}>{s}</button>)}</div>
          </div>}>
          {!albums.data ? <Loading label="Counting…" /> : albums.data.length === 0 ? <p className="text-sm text-dust">Nothing meets that bar yet.</p> : (
            <ol className="grid gap-x-8 gap-y-1 text-sm md:grid-cols-2">
              {albums.data.map((a, i) => <li key={a.albumId} className="flex items-baseline gap-3 py-1"><span className="num w-6 text-xs text-dust">{i + 1}</span><span className="min-w-0 flex-1 truncate"><Link to={albumHref(a.albumId)} className="hover:text-amber">{a.album}</Link>{a.artistId ? <Link to={artistHref(a.artistId)} className="ml-2 text-xs text-dust hover:text-amber">{a.artist}</Link> : null}</span><span className="num shrink-0 text-xs text-dust">{a.times}× · best {fmtPct(a.bestShare)} of {a.knownTracks}</span></li>)}
            </ol>
          )}
          <p className="mt-3 text-xs text-dust">"Known tracks" is the album's real track count once Spotify enrichment has run; before that it's the distinct tracks you've ever played from it, so early numbers lean generous.</p>
        </Card>
      </div>
    </div>
  );
}
