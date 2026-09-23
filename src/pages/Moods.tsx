import { moodMap } from '@/lib/phase4Queries';
import { useAsync, useFilter } from '@/lib/hooks';
import { DAY_PART_LABELS, SHAPE_LABELS, artistHref, fmtHours, fmtPct } from '@/lib/format';
import { Card, ErrorBox, Loading } from '@/components/Card';
import { MakePlaylistButton } from '@/components/PlaylistMaker';
import { Link } from 'react-router-dom';

const PARTS = ['morning', 'midday', 'evening', 'night', 'late'];
// Phase 9h: each station gets a frequency on the Deep Cuts dial
const FREQ: Record<'weekday' | 'weekend', Record<string, string>> = { weekday: { morning: '88.1', midday: '91.3', evening: '94.7', night: '97.9', late: '101.1' }, weekend: { morning: '89.5', midday: '92.9', evening: '96.3', night: '99.5', late: '104.7' } };

/** The ten mood stations (weekday/weekend × five day-parts), now the "dial" section of Moods & Forecast. */
export function MoodStations() {
  const { filter } = useFilter();
  const { data, error } = useAsync(moodMap, [filter]);
  if (error) return <ErrorBox message={error} />;
  if (!data) return <Loading />;
  const max = Math.max(...data.map((s) => s.hours), 1);
  return (
    <div>
      {(['weekday', 'weekend'] as const).map((dow) => (
        <div key={dow} className="mb-6">
          <h2 className="mb-3 font-display text-2xl capitalize">{dow}s</h2>
          <div className="grid gap-3 md:grid-cols-5">
            {PARTS.map((part) => {
              const s = data.find((x) => x.dow === dow && x.dayPart === part);
              if (!s) return <Card key={part} title={DAY_PART_LABELS[part]}><p className="text-sm text-dust">Quiet.</p></Card>;
              const shape = s.topShape ? SHAPE_LABELS[s.topShape] : null;
              return (
                <Card key={part} title={`${FREQ[dow][part]} · ${DAY_PART_LABELS[part]}`} subtitle={`${fmtHours(s.hours)} · skips ${fmtPct(s.skipRate)}${shape ? ` · leans ${shape.label.toLowerCase()}` : ''}`}>
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
