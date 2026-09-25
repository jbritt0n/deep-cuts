import { Link } from 'react-router-dom';
import { Card } from '@/components/Card';
import { trackHref } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { lineageFor, type LineageRow } from '@/lib/metaQueries';

const HEAD: Record<LineageRow['kind'], string> = { cover_of: 'A cover of', samples: 'Samples', sampled_by: 'Sampled by', remix_of: 'A remix of', remixed_by: 'Remixed by', version: 'Other versions' };

/** Phase 10c — samples, remixes and covers of this song, from MusicBrainz. Hidden until something is known. */
export function LineageCard({ trackId }: { trackId: string }) {
  const l = useAsync(() => lineageFor(trackId), [trackId]);
  if (!l.data?.length) return null;
  const groups = (Object.keys(HEAD) as LineageRow['kind'][]).map((k) => [k, l.data!.filter((r) => r.kind === k)] as const).filter(([, rs]) => rs.length);
  return (
    <Card className="mt-6" title="Lineage" subtitle="What this song borrows, who borrowed from it, and who else has recorded it — from MusicBrainz. Highlighted ones are in your record.">
      <div className="grid gap-5 sm:grid-cols-2">
        {groups.map(([k, rs]) => (
          <div key={k}>
            <p className="mb-1.5 text-xs uppercase tracking-wider text-dust">{HEAD[k]}</p>
            <ul className="space-y-1 text-sm">
              {rs.slice(0, 10).map((r) => (
                <li key={r.mbid} className="flex items-baseline gap-2">
                  {r.trackId ? <Link to={trackHref(r.trackId)} className="truncate text-amber hover:underline">{r.title}</Link>
                    : <a href={`https://musicbrainz.org/recording/${r.mbid}`} target="_blank" rel="noreferrer" className="truncate hover:text-cream">{r.title}</a>}
                  <span className="truncate text-xs text-dust">{r.artist ?? ''}{r.year ? ` · ${r.year}` : ''}{r.original ? ' · the original' : ''}{r.trackId ? ` · ${r.plays} plays` : ''}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </Card>
  );
}
