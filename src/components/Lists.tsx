import { C } from '@/lib/theme';
import { Link } from 'react-router-dom';
import type { AlbumRow, ArtistRow, OnThisDayRow, PlayRow, RecordItem, SessionRow, TrackRow } from '@/lib/types';
import { DAY_PART_LABELS, SHAPE_LABELS, albumHref, artistHref, dayHref, fmtHours, fmtInt, fmtMs, fmtPct, fmtTime, trackHref, fmtDate } from '@/lib/format';

export function PlaysTable({ data, showDate = false, limit }: { data: PlayRow[]; showDate?: boolean; limit?: number }) {
  const rows = limit ? data.slice(0, limit) : data;
  if (!rows.length) return <p className="text-sm text-dust">No plays here.</p>;
  return (
    <ul className="divide-y divide-line/60">
      {rows.map((p, i) => (
        <li key={`${p.playedAt}-${i}`} className={`flex items-center gap-4 py-2 text-sm ${p.skipped || !p.attended ? 'text-dust' : ''}`}>
          <span className="num w-[7.5rem] shrink-0 text-xs text-dust">
            {showDate ? <Link to={dayHref(p.playedAt)} className="hover:text-amber">{p.playedAt.slice(5, 10)}</Link> : null}{showDate ? ' ' : ''}{fmtTime(p.playedAt)}
          </span>
          <div className="min-w-0 flex-1">
            {p.trackId ? <Link to={trackHref(p.trackId)} className={`block truncate hover:text-amber ${p.skipped ? 'line-through decoration-coral/60' : ''}`}>{p.track}</Link>
                       : <p className={`truncate ${p.skipped ? 'line-through decoration-coral/60' : ''}`}>{p.track}</p>}
            {p.artistId ? <Link to={artistHref(p.artistId)} className="block truncate text-xs text-dust transition hover:text-amber">{p.artist}</Link>
                        : <p className="truncate text-xs text-dust">{p.artist}</p>}
          </div>
          {!p.attended && <span className="text-[10px] text-violet" title="Autoplay with no interaction for a long stretch">unattended</span>}
          <span className="num shrink-0 text-xs text-dust">{p.skipped ? <span className="text-coral">skip</span> : fmtMs(p.msPlayed)}</span>
        </li>
      ))}
    </ul>
  );
}

export function TrackList({ data, showArtist = true }: { data: TrackRow[]; showArtist?: boolean }) {
  if (!data.length) return <p className="text-sm text-dust">Nothing here yet.</p>;
  const max = Math.max(...data.map((t) => t.plays), 1);
  return (
    <ol className="divide-y divide-line/60">
      {data.map((t, i) => (
        <li key={t.trackId} className="flex items-center gap-4 py-2 text-sm">
          <span className="num w-6 shrink-0 text-right text-xs text-dust">{i + 1}</span>
          <div className="min-w-0 flex-1">
            <Link to={trackHref(t.trackId)} className="block truncate hover:text-amber">{t.track}</Link>
            {showArtist && (t.artistId ? <Link to={artistHref(t.artistId)} className="block truncate text-xs text-dust hover:text-amber">{t.artist}</Link> : <p className="truncate text-xs text-dust">{t.artist}</p>)}
            <div className="mt-1 h-1 w-full overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-amber/70" style={{ width: `${(t.plays / max) * 100}%` }} /></div>
          </div>
          <span className="num shrink-0 text-right text-xs text-dust">{fmtInt(t.plays)} plays<br /><span className={t.skipRate >= 0.3 ? 'text-coral' : ''}>{fmtPct(t.skipRate)} skips</span></span>
        </li>
      ))}
    </ol>
  );
}

export function RankedBars({ data }: { data: ArtistRow[] }) {
  if (!data.length) return <p className="text-sm text-dust">Nothing here yet.</p>;
  const max = Math.max(...data.map((d) => d.hours), 1);
  return (
    <ol className="space-y-3">
      {data.map((a, i) => (
        <li key={a.artistId} className="group">
          <Link to={artistHref(a.artistId)} className="block">
            <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
              <span className="truncate transition group-hover:text-amber"><span className="num mr-2 text-xs text-dust">{i + 1}</span>{a.artist}</span>
              <span className="num shrink-0 text-xs text-dust">{fmtHours(a.hours)} · skips {fmtPct(a.skipRate)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-full bg-raised">
              <div className="h-full rounded-full bg-gradient-to-r from-amber/70 to-amber transition-all duration-500 group-hover:shadow-glow" style={{ width: `${(a.hours / max) * 100}%` }} />
            </div>
          </Link>
        </li>
      ))}
    </ol>
  );
}

export function AlbumList({ data }: { data: AlbumRow[] }) {
  if (!data.length) return <p className="text-sm text-dust">Nothing here yet.</p>;
  const max = Math.max(...data.map((d) => d.hours), 1);
  return (
    <ul className="space-y-2.5">
      {data.map((a) => (
        <li key={a.albumId} className="text-sm">
          <Link to={albumHref(a.albumId)} className="group block">
            <div className="flex items-baseline justify-between gap-3">
              <span className="truncate group-hover:text-amber">{a.album}<span className="ml-2 text-xs text-dust">{a.artist}</span></span>
              <span className="num shrink-0 text-xs text-dust">{fmtHours(a.hours)} · {fmtInt(a.plays)} plays</span>
            </div>
            <div className="mt-1 h-1 overflow-hidden rounded-full bg-raised"><div className="h-full rounded-full bg-moss/70" style={{ width: `${(a.hours / max) * 100}%` }} /></div>
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function Records({ data }: { data: RecordItem[] }) {
  return (
    <ul className="grid gap-3 sm:grid-cols-2">
      {data.map((r) => {
        const inner = (
          <>
            <p className="text-xs text-dust">{r.label}</p>
            <p className="num mt-1 font-display text-2xl text-amber">{r.value}</p>
            <p className="mt-1 truncate text-xs text-dust">{r.detail}</p>
          </>
        );
        return (
          <li key={r.label} className="rounded-xl border border-line bg-ink/40 p-4">
            {r.href ? <Link to={r.href} className="block hover:text-cream">{inner}</Link> : inner}
          </li>
        );
      })}
    </ul>
  );
}

export function OnThisDay({ data, todayLabel }: { data: OnThisDayRow[]; todayLabel: string }) {
  if (!data.length) return <p className="text-sm text-dust">No plays on {todayLabel} in past years.</p>;
  return (
    <ul className="divide-y divide-line/60">
      {data.map((d) => (
        <li key={d.year} className="flex items-baseline gap-4 py-2 text-sm">
          <span className="num w-12 text-dust">{d.year}</span>
          <span className="flex-1 truncate">{d.topArtistId ? <Link to={artistHref(d.topArtistId)} className="hover:text-amber">{d.topArtist}</Link> : d.topArtist ?? '—'}</span>
          <span className="num text-xs text-dust">{fmtInt(d.plays)} plays · {fmtInt(d.minutes)} min</span>
        </li>
      ))}
    </ul>
  );
}

export function ShapeDot({ shape }: { shape: string }) {
  return <span className="inline-block h-2 w-2 rounded-full" style={{ background: SHAPE_LABELS[shape]?.color ?? C.dust }} />;
}

export function SessionCard({ s, href }: { s: SessionRow; href?: string }) {
  const meta = SHAPE_LABELS[s.shape] ?? { label: s.shape, note: '' };
  const body = (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <p className="num text-xs text-dust"><span className="text-cream/80">{fmtDate(s.startAt, { month: 'short', day: 'numeric', year: 'numeric' })}</span> · {fmtTime(s.startAt)} → {fmtTime(s.endAt)} · {DAY_PART_LABELS[s.dayPart] ?? s.dayPart}</p>
        <span className="flex items-center gap-1.5 text-xs"><ShapeDot shape={s.shape} /><span title={meta.note}>{meta.label}</span></span>
      </div>
      <p className="num mt-2 font-display text-xl">{fmtHours(s.totalMs / 3600000)}</p>
      <p className="num mt-0.5 text-xs text-dust">
        {s.trackCount} tracks · {s.uniqueArtists} artist{s.uniqueArtists === 1 ? '' : 's'} · {s.skipCount} skip{s.skipCount === 1 ? '' : 's'}
        {s.noveltyRate >= 0.5 ? ` · ${fmtPct(s.noveltyRate)} new to you` : ''}
        {s.attention !== 'active' ? <span className="text-violet"> · {s.attention}</span> : ''}
      </p>
      {s.topArtists && s.topArtists.length > 0 && <p className="mt-3 truncate text-sm text-cream/90">{s.topArtists.join(' · ')}</p>}
      <p className={`${s.topArtists && s.topArtists.length ? 'mt-1' : 'mt-3'} truncate text-xs text-dust`}><span className="text-cream/70">Opened with</span> {s.openingTrack}</p>
      <p className="truncate text-xs text-dust"><span className="text-cream/70">Closed with</span> {s.closingTrack}</p>
    </>
  );
  return href
    ? <Link to={href} className="block rounded-xl border border-line bg-ink/40 p-4 transition hover:border-dust">{body}</Link>
    : <div className="rounded-xl border border-line bg-ink/40 p-4">{body}</div>;
}
