import type { YearReview } from './insightQueries';
import { SHAPE_LABELS, fmtHours, fmtInt, fmtPct } from './format';

/** INS-12: self-contained HTML in the app's voice; opens offline anywhere. */
export function yearReviewHtml(y: YearReview): string {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  const li = (rows: { a: string; b: string }[]) => rows.map((r) => `<li><span>${esc(r.a)}</span><span class="m">${esc(r.b)}</span></li>`).join('');
  const maxM = Math.max(...y.months.map((m) => m.hours), 1);
  const bars = y.months.map((m) => `<div class="bar" title="${m.month}: ${m.hours} h"><i style="height:${Math.round((m.hours / maxM) * 100)}%"></i><b>${m.month}</b></div>`).join('');
  const maxH = Math.max(...y.clock.map((c) => c.hours), 1);
  const dial = y.clock.map((c) => { const a = (c.hour / 24) * 2 * Math.PI - Math.PI / 2; const r = 40 + 60 * (c.hours / maxH); return `<line x1="${(150 + 40 * Math.cos(a)).toFixed(1)}" y1="${(150 + 40 * Math.sin(a)).toFixed(1)}" x2="${(150 + r * Math.cos(a)).toFixed(1)}" y2="${(150 + r * Math.sin(a)).toFixed(1)}" stroke="${c.hours === maxH ? '#F2A93B' : '#8A6FB0'}" stroke-width="7" stroke-linecap="round"/>`; }).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Deep Cuts — ${esc(y.label)}</title>
<style>body{margin:0;background:#141118;color:#EFE9F4;font:16px/1.5 Georgia,serif}main{max-width:900px;margin:0 auto;padding:48px 32px}
h1{font-size:64px;font-weight:400;margin:8px 0;letter-spacing:-.02em}h2{font-size:20px;font-weight:400;margin:0 0 12px}.k{color:#9C93AD;font-size:14px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:20px;margin-top:32px}.card{background:#1E1A26;border:1px solid #322B3E;border-radius:16px;padding:20px}
ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;gap:12px;padding:6px 0;border-bottom:1px solid #322B3E55;font-size:15px}.m{color:#9C93AD;font-family:ui-monospace,monospace;font-size:12px;white-space:nowrap}
.months{display:flex;gap:6px;align-items:flex-end;height:140px}.bar{flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;height:100%}.bar i{display:block;width:100%;background:#F2A93B;border-radius:6px 6px 0 0;opacity:.85}.bar b{font:11px ui-monospace,monospace;color:#9C93AD;margin-top:6px;font-weight:400}
.sleeve{border-bottom:1px solid #322B3E;padding-bottom:32px;display:grid;grid-template-columns:1.2fr 1fr;gap:24px;align-items:center}footer{margin-top:40px;color:#9C93AD;font-size:12px}</style></head>
<body><main><section class="sleeve"><div><p class="k">Deep Cuts · Year in Review · ${esc(y.label)}</p><h1>${fmtInt(y.hours)} hours</h1>
<p class="k">${fmtInt(y.plays)} plays across ${fmtInt(y.days)} days · ${fmtInt(y.artists)} artists, ${fmtInt(y.newArtists)} new to you · ${fmtInt(y.tracks)} tracks · skipped ${fmtPct(y.skipRate)}</p>
${y.loudestDay ? `<p class="k">Loudest day: ${y.loudestDay.day}, ${fmtInt(y.loudestDay.minutes)} minutes.${y.longestSession ? ` Longest session: ${y.longestSession.day}, ${fmtHours(y.longestSession.hours)}, a ${SHAPE_LABELS[y.longestSession.shape]?.label.toLowerCase() ?? y.longestSession.shape}.` : ''}</p>` : ''}</div>
<svg viewBox="0 0 300 300" width="260" height="260" aria-label="24-hour dial"><circle cx="150" cy="150" r="118" fill="none" stroke="#322B3E"/>${dial}<circle cx="150" cy="150" r="30" fill="#1E1A26" stroke="#322B3E"/><circle cx="150" cy="150" r="3" fill="#F2A93B"/></svg></section>
<div class="grid"><div class="card"><h2>Top artists</h2><ul>${li(y.topArtists.map((a) => ({ a: a.artist, b: fmtHours(a.hours) })))}</ul></div>
<div class="card"><h2>Top tracks</h2><ul>${li(y.topTracks.map((t) => ({ a: `${t.track} — ${t.artist}`, b: `${t.plays}×` })))}</ul></div>
<div class="card"><h2>Top albums</h2><ul>${li(y.topAlbums.map((a) => ({ a: `${a.album} — ${a.artist}`, b: fmtHours(a.hours) })))}</ul></div></div>
<div class="grid"><div class="card"><h2>Month by month</h2><div class="months">${bars}</div></div>
<div class="card"><h2>How you listened</h2><ul>${li(y.shapes.map((s) => ({ a: SHAPE_LABELS[s.shape]?.label ?? s.shape, b: `${s.count} sessions` })))}</ul></div></div>
<div class="grid"><div class="card"><h2>Discoveries you kept</h2><ul>${li(y.keptDiscoveries.map((d) => ({ a: d.artist, b: `${d.plays} plays` })))}</ul></div>
<div class="card"><h2>Discoveries you dropped</h2><ul>${li(y.droppedDiscoveries.map((d) => ({ a: d.artist, b: `${d.plays} plays` })))}</ul></div>
<div class="card"><h2>After midnight</h2><ul>${li(y.canon.map((c) => ({ a: `${c.name} — ${c.artist ?? ''}`, b: `${c.latePlays} late` })))}</ul></div></div>
<footer>Made with Deep Cuts · computed locally from your Spotify listening history · ${new Date().toISOString().slice(0, 10)}</footer></main></body></html>`;
}
