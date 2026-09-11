import { moodMap } from '@/lib/phase4Queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { DAY_PART_LABELS, SHAPE_LABELS, artistHref, fmtHours, fmtPct } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { Link } from 'react-router-dom';

const PARTS = ['morning', 'midday', 'evening', 'night', 'late'];

export function MoodsPage() {
  const { filter } = useFilter();
  const { data, error } = useAsync(moodMap, [filter]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const max = Math.max(...data.map((s) => s.hours), 1);
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Mood of the day" title="Your ten stations" meta="Weekday and weekend, five parts of the day. Each cell is what you actually reach for then — artists ranked by how much more they show up in that slot than usual." />
      {(['weekday', 'weekend'] as const).map((dow) => (
        <div key={dow} className="mb-6">
          <h2 className="mb-3 font-display text-2xl capitalize">{dow}s</h2>
          <div className="grid gap-3 md:grid-cols-5">
            {PARTS.map((part) => {
              const s = data.find((x) => x.dow === dow && x.dayPart === part);
              if (!s) return <Card key={part} title={DAY_PART_LABELS[part]}><p className="text-sm text-dust">Quiet.</p></Card>;
              const shape = s.topShape ? SHAPE_LABELS[s.topShape] : null;
              return (
                <Card key={part} title={DAY_PART_LABELS[part]} subtitle={`${fmtHours(s.hours)} · skips ${fmtPct(s.skipRate)}${shape ? ` · leans ${shape.label.toLowerCase()}` : ''}`}>
                  <div className="mb-3 h-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/80" style={{ width: `${(s.hours / max) * 100}%` }} /></div>
                  <ul className="space-y-1 text-sm">{s.artists.map((a) => <li key={a.artistId} className="truncate"><Link to={artistHref(a.artistId)} className="hover:text-amber">{a.artist}</Link></li>)}</ul>
                  <div className="mt-3"><MakePlaylistButton small label="Tune in" name={`${dow === 'weekday' ? 'Weekday' : 'Weekend'} ${DAY_PART_LABELS[part].toLowerCase()} station`} tracks={s.tracks} kind="insight" description={`What you play on ${dow}s in the ${DAY_PART_LABELS[part].toLowerCase()}. Made with Deep Cuts.`} note={`station:${dow}:${part}`} pool={s.tracks} /></div>
                </Card>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
