import { Card, ErrorBox, Loading } from '@/components/Card';
import { isrcDuplicates } from '@/lib/hygieneQueries';
import { fmtInt } from '@/lib/format';
import { useAsync } from '@/lib/hooks';
import { sourceCoverage } from '@/lib/sourceQueries';

/** Phase 9l — Settings → Record: what an extended-history export did to the polled plays. */
export function SourceCoverageCard({ tick = 0 }: { tick?: number }) {
  const c = useAsync(sourceCoverage, [tick]);
  if (c.error) return <Card title="Polled vs exported"><ErrorBox message={c.error} /></Card>;
  if (!c.data) return <Card title="Polled vs exported"><Loading /></Card>;
  const d = c.data;
  const Row = ({ n, label, tone = '' }: { n: number; label: string; tone?: string }) => <li className="flex items-baseline gap-3"><span className={`num w-20 shrink-0 text-right font-display text-xl ${tone}`}>{fmtInt(n)}</span><span className="text-sm text-dust">{label}</span></li>;
  return (
    <Card title="Polled vs exported" subtitle="Spotify's live feed (polled every few minutes) only knows a song started; the extended-history export knows how long you listened, whether you skipped, and on what device. When both have the same listen, the export's copy wins and the polled one is dropped — never counted twice.">
      <p className="text-sm">{d.exportPlays ? <>Exports: <span className="num">{fmtInt(d.exportPlays)}</span> plays from {d.exportFiles} file{d.exportFiles === 1 ? '' : 's'}, <span className="num">{d.exportFrom}</span> → <span className="num">{d.exportTo}</span>.</> : 'No extended-history export imported yet — every play so far comes from polling.'}</p>
      <ul className="mt-3 space-y-1.5">
        <Row n={d.polledReplaced} label="polled plays replaced by the export's fuller copy (real listening time and skips)" tone="text-moss" />
        {d.exportPlays > 0 && <Row n={d.polledKeptInRange} label="polled plays inside the export's dates that it doesn't contain — kept (usually private sessions or a device the export skipped)" />}
        <Row n={d.polledAfterExport} label={d.exportPlays ? `polled plays after ${d.exportTo} — waiting for your next export; skips are inferred until then` : 'polled plays — skips inferred from when the next song started'} tone="text-amber" />
        {d.polledBeforeExport > 0 && <Row n={d.polledBeforeExport} label="polled plays from before the export's first day" />}
      </ul>
      <p className="mt-3 text-[11px] text-dust/70">Importing the same export twice adds nothing. A newer export that overlaps an older one adds only the plays the older one lacked. Download a fresh one any time from Spotify → Account → Privacy → Extended streaming history, then Settings → Record → Import.</p>
    </Card>
  );
}

/** Phase 10 — Settings → Hygiene: one recording, several track ids (single / album / reissue) splitting its plays. */
export function IsrcDuplicatesCard() {
  const d = useAsync(() => isrcDuplicates(40), []);
  if (d.error) return <Card title="Same recording, several versions"><ErrorBox message={d.error} /></Card>;
  if (!d.data) return <Card title="Same recording, several versions"><Loading rows={5} /></Card>;
  const x = d.data;
  return (
    <Card title="Same recording, several versions" subtitle={`Songs that share one ISRC — the identical recording released as a single, on the album, on a reissue — but are counted under separate entries. ${fmtInt(x.totalGroups)} such songs; ${fmtInt(x.splitPlays)} plays sit on a secondary version.`}>
      {x.groups.length === 0 ? <p className="text-sm text-dust">None found — each recording you play lives under one entry.</p> : (
        <ul className="max-h-[min(24rem,50vh)] divide-y divide-line/50 overflow-y-auto pr-1 text-sm">{x.groups.map((g) => (
          <li key={g.isrc} className="py-1.5">
            <p className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate">{g.track} <span className="text-xs text-dust">{g.artist}</span></span><span className="num text-[11px] text-dust">{fmtInt(g.plays)} plays · {g.isrc}</span></p>
            <p className="truncate text-[11px] text-dust">{g.versions.map((v) => `${v.album ?? '—'} (${v.plays})`).join(' · ')}</p>
          </li>
        ))}</ul>
      )}
      <p className="mt-2 text-[11px] text-dust/70">Report only for now — merging the versions into one entry (so charts count them together) is on the Phase 10 list.</p>
    </Card>
  );
}
