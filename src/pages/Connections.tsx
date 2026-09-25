import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Card, ErrorBox, Loading, Sleeve } from '@/components/Card';
import { coListening, familyTree, playlistOverlap, relLabel, treeCandidates } from '@/lib/connectionQueries';
import { layout } from '@/lib/forceLayout';
import { artistHref, fmtHours, fmtInt, fmtPct } from '@/lib/format';
import { useAsync, useFilter } from '@/lib/hooks';

const PALETTE = ['#F2A93B', '#E4655F', '#7FC8A9', '#8A6FB0', '#8FB3E4', '#F2C27B', '#E48FB0', '#5FD0A8', '#C9A77F', '#B9A6D6'];
const hash = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h; };

/** Phase 10 — Connections: how your artists and playlists relate. */
export function ConnectionsPage() {
  const [tab, setTab] = useState<'colisten' | 'overlap' | 'family'>('colisten');
  return (
    <div className="mx-auto max-w-6xl">
      <Sleeve kicker="Connections" title="How it all hangs together" meta="Your artists as a network of the ones you play together, and your playlists by the songs they share." />
      <div className="mb-6 flex flex-wrap gap-2" role="tablist">
        {([['colisten', 'Co-listening network'], ['overlap', 'Playlist overlap'], ['family', 'Family tree']] as const).map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`rounded-full px-4 py-1.5 text-sm ${tab === k ? 'bg-raised text-cream' : 'border border-line text-dust hover:text-cream'}`}>{l}</button>)}
      </div>
      {tab === 'colisten' && <CoListening />}
      {tab === 'overlap' && <PlaylistOverlap />}
      {tab === 'family' && <FamilyTree />}
    </div>
  );
}

function CoListening() {
  const { filter } = useFilter();
  const nav = useNavigate();
  const [size, setSize] = useState(60);
  const g = useAsync(() => coListening(size, 4, 3), [filter, size]);
  const [hover, setHover] = useState<string | null>(null);
  const W = 1000, H = 680;
  const pos = useMemo(() => (g.data ? layout(g.data.nodes.map((n) => ({ id: n.id })), g.data.edges.map((e) => ({ a: e.a, b: e.b, w: e.w * 4 })), { width: W, height: H, iterations: 320 }) : null), [g.data]);
  if (g.error) return <ErrorBox message={g.error} />;
  if (!g.data || !pos) return <Loading label="Drawing the network…" />;
  const { nodes, edges } = g.data;
  if (nodes.length < 3 || edges.length === 0) return <Card title="Co-listening network"><p className="text-sm text-dust">Not enough sessions with several artists yet.</p></Card>;
  const maxH = Math.max(...nodes.map((n) => n.hours)), maxW = Math.max(...edges.map((e) => e.w));
  const nbr = hover ? new Set(edges.filter((e) => e.a === hover || e.b === hover).flatMap((e) => [e.a, e.b])) : null;
  const scenes = [...new Map(nodes.filter((n) => n.scene).map((n) => [n.scene!, n.label ?? n.scene!])).entries()].slice(0, 10);
  const hn = hover ? nodes.find((n) => n.id === hover) : null;
  const hEdges = hover ? edges.filter((e) => e.a === hover || e.b === hover).sort((a, b) => b.w - a.w) : [];
  return (
    <Card title="Co-listening network" subtitle="Your most-played artists, sized by hours and coloured by scene. A line joins two artists you tend to play in the same sessions — thicker when they share more of their sessions. Each artist keeps its four strongest links. Hover to see who's close; click to open."
      aside={<label className="flex items-center gap-2 text-xs text-dust">artists <select value={size} onChange={(e) => setSize(Number(e.target.value))} className="rounded border border-line bg-ink px-1.5 py-0.5 text-cream">{[30, 60, 100, 150].map((n) => <option key={n} value={n}>{n}</option>)}</select></label>}>
      <div className="relative overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[640px]" role="img" aria-label="Network of artists played together">
          {edges.map((e) => { const a = pos.get(e.a)!, b = pos.get(e.b)!; const on = !nbr || (nbr.has(e.a) && nbr.has(e.b) && (e.a === hover || e.b === hover));
            return <line key={e.a + e.b} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--c-dust)" strokeOpacity={on ? 0.25 + 0.6 * (e.w / maxW) : 0.05} strokeWidth={0.5 + 3.5 * (e.w / maxW)} />; })}
          {nodes.map((n) => { const p = pos.get(n.id)!; const r = 4 + 16 * Math.sqrt(n.hours / maxH); const on = !nbr || nbr.has(n.id); const col = n.scene ? PALETTE[hash(n.scene) % PALETTE.length] : 'var(--c-dust)';
            return (
              <g key={n.id} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => nav(artistHref(n.id))} className="cursor-pointer" opacity={on ? 1 : 0.2}>
                <circle cx={p.x} cy={p.y} r={r} fill={col} fillOpacity={0.85} stroke="var(--c-ink)" strokeWidth="1.5" />
                {(r > 9 || (nbr && nbr.has(n.id))) && <text x={p.x} y={p.y - r - 4} fontSize="12" textAnchor="middle" fill="var(--c-cream)" style={{ paintOrder: 'stroke', stroke: 'var(--c-ink)', strokeWidth: 3 }} className="pointer-events-none">{n.name}</text>}
              </g>
            ); })}
        </svg>
        {hn && (
          <div className="pointer-events-none absolute right-3 top-3 w-64 rounded-xl border border-line bg-surface/95 p-3 text-sm shadow-lg">
            <p className="font-display text-lg">{hn.name}</p>
            <p className="num text-xs text-dust">{fmtHours(hn.hours)} · {fmtInt(hn.sessions)} sessions{hn.label ? ` · ${hn.label}` : ''}</p>
            <ul className="mt-2 space-y-0.5 text-xs">{hEdges.slice(0, 6).map((e) => { const o = nodes.find((n) => n.id === (e.a === hover ? e.b : e.a)); return <li key={e.a + e.b} className="flex justify-between gap-2"><span className="truncate">{o?.name}</span><span className="num text-dust">{e.shared} sessions · {fmtPct(e.w)}</span></li>; })}</ul>
          </div>
        )}
      </div>
      <div className="mt-2 flex flex-wrap gap-3 text-[11px] text-dust">{scenes.map(([k, l]) => <span key={k} className="flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full" style={{ background: PALETTE[hash(k) % PALETTE.length] }} />{l}</span>)}</div>
    </Card>
  );
}

function PlaylistOverlap() {
  const o = useAsync(() => playlistOverlap(40), []);
  if (o.error) return <ErrorBox message={o.error} />;
  if (!o.data) return <Loading />;
  const d = o.data;
  const Row = ({ x }: { x: (typeof d.pairs)[number] }) => (
    <li className="grid grid-cols-[1fr_auto_1fr_auto] items-baseline gap-2 py-1.5 text-sm">
      <span className="truncate">{x.aName}{!x.aMine && <span className="ml-1 text-[10px] text-dust">followed</span>}</span><span className="text-dust">↔</span>
      <span className="truncate">{x.bName}{!x.bMine && <span className="ml-1 text-[10px] text-dust">followed</span>}</span>
      <span className="num text-[11px] text-dust">{x.shared} shared · {fmtPct(x.jaccard)}</span>
    </li>
  );
  return (
    <div className="space-y-6">
      <Card title="Near-copies" subtitle="One playlist that sits (90 %+) inside another — candidates to merge, or to unfollow.">
        {d.subsets.length === 0 ? <p className="text-sm text-dust">None — your playlists are all distinct.</p> : <ul className="divide-y divide-line/50">{d.subsets.map((x) => <li key={x.a + x.b} className="py-1.5 text-sm"><span className="font-medium">{x.aInB >= x.bInA ? x.aName : x.bName}</span> <span className="text-dust">is {fmtPct(Math.max(x.aInB, x.bInA))} inside</span> <span className="font-medium">{x.aInB >= x.bInA ? x.bName : x.aName}</span> <span className="num text-[11px] text-dust">({x.shared} songs)</span></li>)}</ul>}
      </Card>
      <Card title="Most alike" subtitle={`Pairs among ${fmtInt(d.playlists)} synced playlists (10+ songs) by shared songs — % is the overlap of the two together.`}>
        {d.pairs.length === 0 ? <p className="text-sm text-dust">No playlists share three or more songs.</p> : <ul className="divide-y divide-line/50">{d.pairs.map((x) => <Row key={x.a + x.b} x={x} />)}</ul>}
      </Card>
      <p className="text-[11px] text-dust/70">Built from the playlist items Deep Cuts has synced (Library → Playlists); Spotify-made playlists can't be read, so they're not here. <Link to="/library?tab=playlists" className="underline hover:text-cream">Library → Playlists</Link></p>
    </div>
  );
}

/** Phase 10b — bands, members, side projects and collaborations around one artist (MusicBrainz relationships). */
function FamilyTree() {
  const nav = useNavigate();
  const cands = useAsync(() => treeCandidates(80), []);
  const [pick, setPick] = useState<string | null>(null);
  const id = pick ?? cands.data?.[0]?.artistId ?? null;
  const t = useAsync(() => (id ? familyTree(id) : Promise.resolve(null)), [id]);
  const [hover, setHover] = useState<string | null>(null);
  if (cands.error) return <ErrorBox message={cands.error} />;
  if (!cands.data) return <Loading rows={6} />;
  if (!cands.data.length) return <Card title="Family tree"><p className="text-sm text-dust">No MusicBrainz relationships collected yet — they arrive as the MusicBrainz pass works through your artists (Services).</p></Card>;
  const d = t.data;
  const W = 900, H = 640, cx = W / 2, cy = H / 2;
  const ring1 = d?.nodes.filter((n) => n.ring === 1) ?? [];
  const ring2 = d?.nodes.filter((n) => n.ring === 2) ?? [];
  const pos = new Map<string, { x: number; y: number }>();
  if (d?.centre) pos.set(d.centre.id, { x: cx, y: cy });
  ring1.forEach((n, i) => { const a = (i / Math.max(1, ring1.length)) * Math.PI * 2 - Math.PI / 2; pos.set(n.id, { x: cx + Math.cos(a) * 170, y: cy + Math.sin(a) * 170 }); });
  // ring 2 sits outside its parent, fanned around the parent's angle
  const kids = new Map<string, typeof ring2>(); for (const n of ring2) { const k = kids.get(n.via ?? '') ?? []; k.push(n); kids.set(n.via ?? '', k); }
  for (const [via, list] of kids) { const p = pos.get(via); if (!p) continue; const base = Math.atan2(p.y - cy, p.x - cx);
    list.forEach((n, i) => { const a = base + (i - (list.length - 1) / 2) * Math.min(0.28, 1.6 / Math.max(1, list.length)); pos.set(n.id, { x: cx + Math.cos(a) * 290, y: cy + Math.sin(a) * 290 }); }); }
  const all = d ? [d.centre!, ...d.nodes] : [];
  const near = hover && d ? new Set(d.edges.filter((e) => e.a === hover || e.b === hover).flatMap((e) => [e.a, e.b])) : null;
  return (
    <Card title="Family tree" subtitle="Bands, members, side projects and collaborations from MusicBrainz, two steps out from the artist you pick. Filled circles are artists in your record — click one to open it."
      aside={<select value={id ?? ''} onChange={(e) => setPick(e.target.value)} className="max-w-[16rem] rounded border border-line bg-ink px-2 py-1 text-xs text-cream">{cands.data.map((c) => <option key={c.artistId} value={c.artistId}>{c.name} · {c.relations}</option>)}</select>}>
      {t.error ? <ErrorBox message={t.error} /> : !d ? <Loading rows={6} /> : !d.centre ? <p className="text-sm text-dust">This artist has no MusicBrainz match yet.</p> : (
        <div className="overflow-x-auto">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[600px]" role="img" aria-label={`Relationships around ${d.centre.name}`}>
            {d.edges.map((e, i) => { const a = pos.get(e.a), b = pos.get(e.b); if (!a || !b) return null; const on = !near || (near.has(e.a) && near.has(e.b));
              return <g key={i}><line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--c-dust)" strokeOpacity={on ? 0.45 : 0.08} strokeDasharray={e.relation === 'member of band' ? undefined : '4 3'} />
                {on && near && <text x={(a.x + b.x) / 2} y={(a.y + b.y) / 2} fontSize="10" textAnchor="middle" fill="var(--c-dust)">{relLabel(e.relation)}</text>}</g>; })}
            {all.map((n) => { const p = pos.get(n.id); if (!p) return null; const r = n.ring === 0 ? 22 : n.ring === 1 ? 11 : 6; const yours = !!n.artistId; const on = !near || near.has(n.id);
              return (
                <g key={n.id} opacity={on ? 1 : 0.25} onMouseEnter={() => setHover(n.id)} onMouseLeave={() => setHover(null)} onClick={() => { if (n.artistId && n.ring > 0) setPick(n.artistId); else if (n.artistId) nav(artistHref(n.artistId)); }} className={yours ? 'cursor-pointer' : ''}>
                  <circle cx={p.x} cy={p.y} r={r} fill={yours ? 'var(--c-amber)' : 'var(--c-surface)'} stroke={yours ? 'var(--c-amber)' : 'var(--c-dust)'} strokeWidth="1.5" />
                  <text x={p.x} y={p.y + r + 13} fontSize={n.ring === 0 ? 15 : n.ring === 1 ? 12 : 10} textAnchor="middle" fill={n.ring === 2 && !yours ? 'var(--c-dust)' : 'var(--c-cream)'} style={{ paintOrder: 'stroke', stroke: 'var(--c-ink)', strokeWidth: 3 }}>{n.name}</text>
                  {n.ring > 0 && <title>{n.name} — {relLabel(n.relation)}{yours ? ` · ${fmtHours(n.hours)} in your record (click to centre)` : ''}</title>}
                </g>
              ); })}
          </svg>
          <p className="text-[11px] text-dust">Solid line = band membership, dashed = other relationships. {ring1.length} direct, {ring2.length} one step further{ring2.length >= 40 ? ' (first 40 shown)' : ''}. Click a filled circle to centre the tree on it; click the centre to open its page.</p>
        </div>
      )}
    </Card>
  );
}
