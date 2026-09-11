import { C } from '@/lib/theme';
import { useState } from 'react';
import { inTauri, invoke } from '@/lib/bridge';

/** Renders a 1080×1350 PNG (Instagram portrait) locally with canvas. Nothing leaves the machine. */
export function ShareCardButton({ title, subtitle, rows, footer = 'made with Deep Cuts' }: { title: string; subtitle: string; rows: { label: string; value: string }[]; footer?: string }) {
  const [busy, setBusy] = useState(false);
  const render = async () => {
    setBusy(true);
    try {
      await Promise.all([document.fonts.load('400 72px Fraunces'), document.fonts.load('300 30px Outfit'), document.fonts.load('400 26px "IBM Plex Mono"')]).catch(() => {});
      const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H; const g = c.getContext('2d')!;
      g.fillStyle = C.ink; g.fillRect(0, 0, W, H);
      // groove rings
      for (let r = 120; r < 900; r += 60) { g.beginPath(); g.arc(W * 0.82, 260, r, 0, Math.PI * 2); g.strokeStyle = 'rgba(239,233,244,0.05)'; g.lineWidth = 1; g.stroke(); }
      g.beginPath(); g.arc(W * 0.82, 260, 26, 0, Math.PI * 2); g.fillStyle = C.amber; g.fill();
      g.fillStyle = C.dust; g.font = '300 30px Outfit, system-ui'; g.fillText(subtitle, 80, 140);
      g.fillStyle = C.cream; g.font = '400 84px Fraunces, Georgia, serif';
      const words = title.split(' '); let line = '', y = 250; for (const w of words) { const test = line ? `${line} ${w}` : w; if (g.measureText(test).width > 880 && line) { g.fillText(line, 80, y); y += 92; line = w; } else line = test; } g.fillText(line, 80, y); y += 70;
      g.strokeStyle = C.line; g.beginPath(); g.moveTo(80, y); g.lineTo(W - 80, y); g.stroke(); y += 50;
      const n = Math.min(rows.length, 10);
      for (let i = 0; i < n; i++) {
        const r = rows[i]; const rowH = n > 5 ? 86 : 120;
        g.fillStyle = i === 0 ? C.amber : C.dust; g.font = `400 ${n > 5 ? 26 : 30}px "IBM Plex Mono", monospace`; g.fillText(String(i + 1).padStart(2, '0'), 80, y + 40);
        g.fillStyle = C.cream; g.font = `400 ${n > 5 ? 36 : 48}px Fraunces, Georgia, serif`;
        let label = r.label; while (g.measureText(label).width > 640 && label.length > 4) label = label.slice(0, -2) + '…';
        g.fillText(label, 160, y + 40);
        g.fillStyle = C.dust; g.font = `400 ${n > 5 ? 24 : 28}px "IBM Plex Mono", monospace`; const vw = g.measureText(r.value).width; g.fillText(r.value, W - 80 - vw, y + 40);
        y += rowH;
      }
      g.fillStyle = C.dust; g.font = '400 24px "IBM Plex Mono", monospace'; g.fillText(footer, 80, H - 70);
      const url = c.toDataURL('image/png'); const name = `deep-cuts-${title.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`;
      if (inTauri) {
        const { save } = await import('@tauri-apps/plugin-dialog');
        const path = await save({ defaultPath: name, filters: [{ name: 'PNG', extensions: ['png'] }] });
        if (path) await invoke('save_binary_file', { path, base64: url.split(',')[1] });
      } else { const a = document.createElement('a'); a.href = url; a.download = name; a.click(); }
    } finally { setBusy(false); }
  };
  return <button onClick={render} disabled={busy} className="rounded-full border border-line px-4 py-2 text-sm text-dust transition hover:border-dust hover:text-cream disabled:opacity-40">{busy ? 'Rendering…' : 'Share card'}</button>;
}
