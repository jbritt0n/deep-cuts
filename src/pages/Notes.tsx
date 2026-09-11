import { useState } from 'react';
import { Link } from 'react-router-dom';
import { composeNotes, mondayOf, weekFacts } from '@/lib/notesQueries';
import { useAsync, useFilter } from '@/lib/hooks';
import { localToday } from '@/lib/queries';
import { artistHref, fmtHours, fmtInt, fmtPct } from '@/lib/format';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';

export function NotesPage() {
  const { filter } = useFilter();
  const [offset, setOffset] = useState(1); // weeks back; 1 = last complete week
  const start = (() => { const d = new Date(localToday() + 'T00:00:00'); d.setDate(d.getDate() - offset * 7); return mondayOf(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`); })();
  const { data: f, error } = useAsync(() => weekFacts(start), [start, filter]);
  if (error) return <ErrorBox message={error} />;
  if (!f) return <Loading label="Writing…" />;
  const notes = composeNotes(f);
  return (
    <div className="mx-auto max-w-5xl">
      <Sleeve kicker={<>Liner Notes · week of {f.label} · <button onClick={() => setOffset(offset + 1)} className="hover:text-amber">← earlier</button>{offset > 0 && <> · <button onClick={() => setOffset(offset - 1)} className="hover:text-amber">later →</button></>}</>}
        title={f.plays ? `${fmtHours(f.hours)}, ${f.topArtists[0] ? `mostly ${f.topArtists[0].artist}` : 'quietly'}` : 'A quiet week'}
        meta="A weekly note written from the numbers. The facts it draws on sit alongside so you can check every line." />
      <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <Card title="The note">
          <div className="space-y-4 font-display text-lg leading-relaxed">{notes.map((n, i) => <p key={i}>{n}</p>)}</div>
          <p className="mt-6 text-xs text-dust">Composed by rules today. When the local model arrives it may rephrase this; it will never change a number.</p>
        </Card>
        <Card title="Fact sheet">
          <ul className="num space-y-1.5 text-sm text-dust">
            <li>hours <span className="text-cream">{fmtHours(f.hours)}</span> · last week {fmtHours(f.prevHours)}</li>
            <li>plays <span className="text-cream">{fmtInt(f.plays)}</span> · days {f.days} · artists {fmtInt(f.artists)} · new {f.newArtists}</li>
            <li>skip rate <span className="text-cream">{fmtPct(f.skipRate)}</span> · last week {fmtPct(f.prevSkipRate)} · late {fmtPct(f.lateShare)}</li>
            {f.topArtists.map((a, i) => <li key={a.artistId}>#{i + 1} <Link to={artistHref(a.artistId)} className="text-cream hover:text-amber">{a.artist}</Link> {fmtHours(a.hours)}{a.prevRank ? ` (was #${a.prevRank})` : ' (new)'}</li>)}
            {f.topTrack && <li>top track <span className="text-cream">{f.topTrack.track}</span> {f.topTrack.plays}×</li>}
            {f.obsession && <li>obsession <span className="text-cream">{f.obsession.artist}</span> {f.obsession.plays} vs usual {f.obsession.usual.toFixed(1)}/wk</li>}
            {f.comebacks.map((c) => <li key={c.artistId}>comeback <Link to={artistHref(c.artistId)} className="text-cream hover:text-amber">{c.artist}</Link> after {c.daysSilent} d</li>)}
            {f.loudestDay && <li>loudest <Link to={`/day/${f.loudestDay.day}`} className="text-cream hover:text-amber">{f.loudestDay.day}</Link> {fmtInt(f.loudestDay.minutes)} min</li>}
            {f.milestones.map((m, i) => <li key={i}>milestone · {m.description}</li>)}
          </ul>
        </Card>
      </div>
    </div>
  );
}
