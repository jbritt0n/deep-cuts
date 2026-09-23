import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { search } from '@/lib/queries';
import { useAsync, useDebounced, useFilter } from '@/lib/hooks';
import { Card, Loading } from '@/components/Card';
import { AlbumList, RankedBars, TrackList } from '@/components/Lists';

/**
 * Artists / tracks / albums search over your record (the original Explore). Phase 9h: a reusable block —
 * the full page at /explore/lists (where the header search box lands) and the top of Ask the archive.
 * The query lives in ?q= so results are linkable and survive back/forward.
 */
export function ExploreSearch({ autoFocus = false, big = true }: { autoFocus?: boolean; big?: boolean }) {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  useEffect(() => { const p = params.get('q') ?? ''; if (p !== q) setQ(p); }, [params]); // eslint-disable-line react-hooks/exhaustive-deps
  const dq = useDebounced(q, 200);
  const { filter } = useFilter();
  const { data, loading } = useAsync(() => search(dq), [dq, filter]);
  return (
    <div>
      <input autoFocus={autoFocus} value={q} onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}, { replace: true }); }}
        placeholder="Type an artist, a song, an album…" aria-label="Search the archive"
        className={`w-full rounded-2xl border border-line bg-surface placeholder:text-dust/50 focus:border-dust ${big ? 'px-5 py-4 font-display text-2xl' : 'px-4 py-3 font-display text-lg'}`} />
      {dq.trim().length < 2 ? <p className="mt-3 text-sm text-dust">Two letters and I'll start looking. Results follow the listening lens above.</p>
        : loading && !data ? <Loading label="Looking…" />
        : data && (data.artists.length + data.tracks.length + data.albums.length === 0 ? <p className="mt-3 text-sm text-dust">Nothing in your record matches “{dq}”.</p> : (
          <div className="mt-5 grid gap-6 lg:grid-cols-3">
            <Card title={`Artists · ${data.artists.length}`}><RankedBars data={data.artists} /></Card>
            <Card title={`Tracks · ${data.tracks.length}`}><TrackList data={data.tracks} /></Card>
            <Card title={`Albums · ${data.albums.length}`}><AlbumList data={data.albums} /></Card>
          </div>
        ))}
    </div>
  );
}

export function Explore() {
  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-5 flex items-baseline justify-between gap-4"><h1 className="font-display text-4xl tracking-tight">Explore</h1><Link to="/explore" className="text-sm text-dust hover:text-amber">Ask the archive →</Link></div>
      <ExploreSearch autoFocus />
    </div>
  );
}
