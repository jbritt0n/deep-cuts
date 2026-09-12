const hue = (s: string) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };

/** One cover: the album image when enrichment has fetched it, otherwise a deterministic colour tile with the title — the same fallback in the collage, the Crate and anywhere else art may be missing. */
export function CoverTile({ id, title, subtitle, imageUrl, className = '', textClass = 'text-xs' }: { id: string; title: string; subtitle?: string; imageUrl?: string | null; className?: string; textClass?: string }) {
  const label = `${title}${subtitle ? ` — ${subtitle}` : ''}`;
  if (imageUrl) return <img src={imageUrl} alt={label} title={label} className={`aspect-square w-full object-cover ${className}`} loading="lazy" draggable={false} />;
  return (
    <div title={label} role="img" aria-label={label} className={`grid aspect-square w-full place-items-center p-2 text-center ${className}`} style={{ background: `linear-gradient(135deg, hsl(${hue(id)} 22% 18%), hsl(${(hue(id) + 40) % 360} 28% 26%))` }}>
      <span className={`font-display leading-tight text-cream/80 line-clamp-3 ${textClass}`}>{title}</span>
    </div>
  );
}

/** Album-art collage. Uses albums.image_url when enrichment has fetched it; otherwise a deterministic colour tile with initials, so the layout works before any connector runs. */
export function Collage({ items, size = 3, className = '' }: { items: { id: string; title: string; subtitle?: string; imageUrl?: string | null }[]; size?: number; className?: string }) {
  const tiles = items.slice(0, size * size);
  return (
    <div className={`grid gap-1 overflow-hidden rounded-2xl ${className}`} style={{ gridTemplateColumns: `repeat(${size}, minmax(0, 1fr))` }} aria-label="Album art collage">
      {tiles.map((t) => <CoverTile key={t.id} {...t} />)}
    </div>
  );
}
