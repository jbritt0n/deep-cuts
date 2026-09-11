import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { search } from '@/lib/queries';
import { useAsync, useDebounced, useFilter } from '@/lib/hooks';
import { Card, Loading } from '@/components/Card';
import { AlbumList, RankedBars, TrackList } from '@/components/Lists';

export function Explore() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const dq = useDebounced(q, 200);
  const { filter } = useFilter();
  const { data, loading } = useAsync(() => search(dq), [dq, filter]);
  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="font-display text-4xl tracking-tight">Explore</h1>
      <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setParams(e.target.value ? { q: e.target.value } : {}); }}
        placeholder="Type an artist, a song, an album…" aria-label="Search the archive"
        className="mt-6 w-full rounded-2xl border border-line bg-surface px-5 py-4 font-display text-2xl placeholder:text-dust/50 focus:border-dust" />
      {dq.trim().length < 2 ? <p className="mt-4 text-sm text-dust">Two letters and I'll start looking. Results follow the listening lens above.</p>
        : loading && !data ? <Loading label="Looking…" />
        : data && (
          <div className="mt-6 grid gap-6 lg:grid-cols-3">
            <Card title={`Artists · ${data.artists.length}`}><RankedBars data={data.artists} /></Card>
            <Card title={`Tracks · ${data.tracks.length}`}><TrackList data={data.tracks} /></Card>
            <Card title={`Albums · ${data.albums.length}`}><AlbumList data={data.albums} /></Card>
          </div>
        )}
    </div>
  );
}
