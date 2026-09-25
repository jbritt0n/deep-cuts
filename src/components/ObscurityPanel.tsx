import { Card } from '@/components/Card';
import { entityObscurity } from '@/lib/crateQueries';
import { fmtInt } from '@/lib/format';
import { useAsync } from '@/lib/hooks';

const compact = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));

/** Phase 9n — obscurity from Last.fm listeners on the Artist and Album pages (the album page shows both). */
export function ObscurityPanel({ artistId, albumId }: { artistId: string | null; albumId?: string | null }) {
  const art = useAsync(() => (artistId ? entityObscurity('artist', artistId) : Promise.resolve(null)), [artistId]);
  const alb = useAsync(() => (albumId ? entityObscurity('album', albumId) : Promise.resolve(null)), [albumId]);
  const Row = ({ label, o }: { label: string; o: Awaited<ReturnType<typeof entityObscurity>> | null | undefined }) => (
    <div className="flex items-center gap-3 py-1.5">
      <span className="w-14 shrink-0 text-xs text-dust">{label}</span>
      {o?.obscurity != null ? <>
        <div className="relative h-2 flex-1 rounded-full bg-gradient-to-r from-raised via-violet/40 to-amber/80"><div className="absolute top-[-3px] h-3.5 w-1 rounded bg-cream" style={{ left: `calc(${Math.round(o.obscurity * 100)}% - 2px)` }} /></div>
        <span className={`w-24 shrink-0 text-sm ${o.obscurity >= 0.3 ? 'text-amber' : o.obscurity >= 0.18 ? 'text-cream' : 'text-dust'}`}>{o.tier}</span>
        <span className="num w-44 shrink-0 text-right text-[11px] text-dust" title={o.fetchedAt ? `Last.fm, read ${o.fetchedAt.slice(0, 10)}` : undefined}>{o.listeners != null ? `${compact(o.listeners)} listeners` : ''}{o.percentile != null ? ` · rarer than ${Math.round(o.percentile * 100)}% of your ${label === 'album' ? 'albums' : 'artists'}` : ''}</span>
      </> : <span className="text-xs text-dust">{o?.listeners === 0 ? 'Last.fm has no listeners on record' : 'not looked up yet — Last.fm fills this in a few dozen per hour'}</span>}
    </div>
  );
  const deep = alb.data?.listeners != null && art.data?.listeners ? alb.data.listeners / art.data.listeners : null;
  return (
    <Card title="Obscurity" subtitle="From Last.fm listener counts: everyone knows → known → cult → rare → ultra rare. The marker shows where it sits on that scale.">
      {albumId && <Row label="album" o={alb.data} />}
      <Row label="artist" o={art.data} />
      {deep != null && deep < 0.15 && <p className="mt-1 text-xs text-dust">A deep cut in their catalogue: only {Math.round(deep * 100)}% of the artist's Last.fm listeners have played this album ({fmtInt(alb.data!.listeners!)} of {fmtInt(art.data!.listeners!)}).</p>}
    </Card>
  );
}
