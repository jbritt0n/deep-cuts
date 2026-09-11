import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

export function SearchBox() {
  const [q, setQ] = useState('');
  const nav = useNavigate();
  return (
    <input value={q} onChange={(e) => setQ(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter' && q.trim().length >= 2) { nav(`/explore?q=${encodeURIComponent(q.trim())}`); setQ(''); } }}
      placeholder="Search artists, tracks, albums"
      aria-label="Search"
      className="w-80 rounded-full border border-line bg-surface px-4 py-1.5 text-sm placeholder:text-dust/60 focus:border-dust" />
  );
}
