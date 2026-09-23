import { useState } from 'react';
import { Link } from 'react-router-dom';
import { invoke } from '@/lib/bridge';
import { skipHall, type SkipHallRow } from '@/lib/skipHallQueries';
import { useAsync, useFilter } from '@/lib/hooks';
import { artistHref, fmtDate, fmtInt, fmtMs, fmtPct, trackHref } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { QueueButton } from '@/components/QueueButton';

/** Phase 9d — Not for me: the songs you keep skipping. Two verdicts per row, both stored as recommendation feedback under engine 'skip_hall'. */
export function SkipHallPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { filter } = useFilter();
  const [tick, setTick] = useState(0);
  const d = useAsync(() => skipHall(), [filter, tick]);
  const [msg, setMsg] = useState<string | null>(null);
  const decide = async (r: SkipHallRow, verdict: 'accepted' | 'dismissed') => {
    await invoke('rec_feedback', { subjectType: 'track', subjectKey: r.trackId, engine: 'skip_hall', verdict }).catch(() => {});
    setMsg(verdict === 'accepted' ? `Fair enough — "${r.track}" gets another shot; it stays off this list for 180 days.` : `"${r.track}" confirmed not for you.`);
    setTick((t) => t + 1);
  };
  return (
    <div className="mx-auto max-w-5xl">
      {!embedded && <Sleeve kicker="Not for me" title="The Skip Hall of Fame" meta="Songs that keep showing up and keep getting skipped: seen 8+ times, skipped 85 % or more. Skip-spree sessions (10+ skips) are left out — those say something about the sitting, not the song." />}
      {embedded && <p className="mb-4 max-w-3xl text-sm text-dust">Songs that keep being put in front of you and keep getting skipped. The bar for entry — exposures and skip rate — is in <a href="#/settings?tab=tuning" className="underline hover:text-cream">Tuning</a>; skip-spree sessions are left out because they say something about the sitting, not the song.</p>}
      {msg && <div className="mb-4 rounded-xl border border-moss/40 bg-moss/5 px-4 py-3 text-sm text-moss">{msg}</div>}
      {d.error ? <ErrorBox message={d.error} /> : !d.data ? <Loading /> : (
        <>
          <Card title="Shown up, skipped" subtitle="Sorted by exposure. Give one a fair shot (it comes back in 180 days if you keep skipping) or confirm it — the first explicit 'no' the recommendation engines have ever had from you.">
            {d.data.rows.length === 0 ? <p className="text-sm text-dust">Nothing here. Either you like what plays, or you don't let it repeat.</p> : (
              <ul className="divide-y divide-line/60 text-sm">
                {d.data.rows.map((r) => (
                  <li key={r.trackId} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <div className="min-w-0 flex-1">
                      <Link to={trackHref(r.trackId)} className="block truncate hover:text-amber">{r.track}</Link>
                      <p className="truncate text-xs text-dust">{r.artistId ? <Link to={artistHref(r.artistId)} className="hover:text-amber">{r.artist}</Link> : r.artist} · bail at {fmtMs(r.meanMs)} · {r.firstSkipped ? `since ${fmtDate(r.firstSkipped, { month: 'short', year: 'numeric' })}` : ''}</p>
                    </div>
                    <span className="num shrink-0 text-right text-xs text-dust">shown <span className="text-cream">{fmtInt(r.shown)}</span> · skipped <span className="text-coral">{fmtInt(r.skipped)}</span><br />{fmtPct(r.skipRate)} across {r.sessions} sessions</span>
                    <QueueButton trackId={r.trackId} />
                    <span className="flex shrink-0 gap-1.5 text-xs">
                      <button onClick={() => decide(r, 'accepted')} className="rounded-full border border-line px-3 py-1 text-dust hover:border-moss hover:text-moss">Give it a fair shot</button>
                      <button onClick={() => decide(r, 'dismissed')} className="rounded-full border border-line px-3 py-1 text-dust hover:border-coral hover:text-coral">Confirmed not for me</button>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          <div className="mt-6 grid gap-6 md:grid-cols-2">
            <Card title="On probation" subtitle="Given a fair shot in the last 180 days.">{d.data.tried.length ? <ul className="divide-y divide-line/60 text-sm">{d.data.tried.map((r) => <li key={r.trackId} className="flex items-center gap-3 py-1.5"><Link to={trackHref(r.trackId)} className="min-w-0 flex-1 truncate hover:text-amber">{r.track}<span className="ml-2 text-xs text-dust">{r.artist}</span></Link><span className="num text-xs text-dust">{fmtInt(r.skipped)}/{fmtInt(r.shown)}</span><QueueButton trackId={r.trackId} /></li>)}</ul> : <p className="text-sm text-dust">—</p>}</Card>
            <Card title="Confirmed" subtitle="You said no. Undo by giving one a fair shot."> {d.data.confirmed.length ? <ul className="divide-y divide-line/60 text-sm">{d.data.confirmed.map((r) => <li key={r.trackId} className="flex items-center gap-3 py-1.5"><Link to={trackHref(r.trackId)} className="min-w-0 flex-1 truncate text-dust hover:text-amber">{r.track}<span className="ml-2 text-xs">{r.artist}</span></Link><button onClick={() => decide(r, 'accepted')} className="text-xs text-dust hover:text-moss">fair shot</button></li>)}</ul> : <p className="text-sm text-dust">—</p>}</Card>
          </div>
        </>
      )}
    </div>
  );
}
