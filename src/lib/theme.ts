/**
 * Skins. Each theme sets the seven palette roles as CSS variables (Tailwind reads
 * them) and updates `C`, the colour object every SVG chart reads at render time.
 * Persisted in localStorage; applied to <html data-theme>.
 */
export type Palette = { ink: string; surface: string; raised: string; line: string; cream: string; dust: string; amber: string; coral: string; moss: string; violet: string; scheme: 'dark' | 'light' };
export type Theme = { id: string; name: string; blurb: string; p: Palette };

export const THEMES: Theme[] = [
  { id: 'ink', name: 'Ink & amber', blurb: 'The original. Deep violet-black, warm amber.', p: { ink: '#141118', surface: '#1E1A26', raised: '#272231', line: '#322B3E', cream: '#EFE9F4', dust: '#9C93AD', amber: '#F2A93B', coral: '#E4655F', moss: '#7FC8A9', violet: '#8A6FB0', scheme: 'dark' } },
  { id: 'lagoon', name: 'Lagoon', blurb: 'Teal water, lemon light.', p: { ink: '#062F33', surface: '#0B3C41', raised: '#114B51', line: '#1A5C62', cream: '#F6F2A6', dust: '#9CC9C4', amber: '#F5E663', coral: '#FF8A65', moss: '#7EE0B8', violet: '#8FB8FF', scheme: 'dark' } },
  { id: 'darkroom', name: 'Darkroom', blurb: 'Safelight red on black. For late sessions.', p: { ink: '#0C0A0A', surface: '#161010', raised: '#211515', line: '#33201F', cream: '#F3E7E4', dust: '#A98A86', amber: '#FF4D3D', coral: '#FF9E80', moss: '#FFC6A5', violet: '#B36B60', scheme: 'dark' } },
  { id: 'sleeve', name: 'Paper sleeve', blurb: 'Cream paper, ink type, one red stamp. Light mode.', p: { ink: '#F4EFE6', surface: '#FBF8F1', raised: '#EDE6D8', line: '#D9D0BE', cream: '#1F1A17', dust: '#6F675C', amber: '#C8451B', coral: '#B23A48', moss: '#3F7D5A', violet: '#5B4B8A', scheme: 'light' } },
  { id: 'neon', name: 'Neon arcade', blurb: 'Midnight purple, electric cyan and magenta.', p: { ink: '#0D0A1F', surface: '#150F2E', raised: '#1E163F', line: '#2C2159', cream: '#EAF6FF', dust: '#8F8FBF', amber: '#2DE2FF', coral: '#FF3DA1', moss: '#7DFF9C', violet: '#B36BFF', scheme: 'dark' } },
  { id: 'forest', name: 'Forest floor', blurb: 'Moss, bark, a little sun.', p: { ink: '#0F1611', surface: '#161F19', raised: '#1E2B22', line: '#2C3D31', cream: '#EAF0E4', dust: '#93A896', amber: '#D9B85C', coral: '#D96C4F', moss: '#7FC8A9', violet: '#8AA1C2', scheme: 'dark' } },
  { id: 'sunset', name: 'Sunset drive', blurb: 'Burnt orange on indigo dusk.', p: { ink: '#191331', surface: '#221A42', raised: '#2C2254', line: '#3C2F6E', cream: '#FFF1E0', dust: '#B5A1C9', amber: '#FF9F45', coral: '#FF5E7A', moss: '#FFD166', violet: '#C77DFF', scheme: 'dark' } },
  { id: 'mono', name: 'Monochrome', blurb: 'Greys and one white. No colour, all contrast.', p: { ink: '#0E0E10', surface: '#171719', raised: '#212124', line: '#2F2F33', cream: '#F2F2F2', dust: '#9A9A9F', amber: '#FFFFFF', coral: '#D0D0D0', moss: '#B8B8B8', violet: '#8A8A8F', scheme: 'dark' } },
  { id: 'terminal', name: 'Terminal', blurb: 'Phosphor green on near-black.', p: { ink: '#050806', surface: '#0A100B', raised: '#101A12', line: '#1C2C1F', cream: '#D8FFDC', dust: '#7FAF86', amber: '#3CFF6E', coral: '#FFB347', moss: '#9CFF57', violet: '#5FD0A8', scheme: 'dark' } },
  { id: 'rosewater', name: 'Rosewater', blurb: 'Dusty pink, plum and gold. Light mode.', p: { ink: '#FBF1F3', surface: '#FFF8F9', raised: '#F3E3E8', line: '#E3CCD4', cream: '#3A2430', dust: '#8C6E7A', amber: '#B8862B', coral: '#C24B6E', moss: '#4C8C6F', violet: '#7A5A9E', scheme: 'light' } },
];

/** Live colours for charts (mutated by applyTheme; components read at render). */
export const C: Record<'ink' | 'surface' | 'raised' | 'line' | 'cream' | 'dust' | 'amber' | 'coral' | 'moss' | 'violet', string> = { ...THEMES[0].p } as never;

export function applyTheme(id: string) {
  const t = THEMES.find((x) => x.id === id) ?? THEMES[0];
  const root = document.documentElement;
  for (const k of ['ink', 'surface', 'raised', 'line', 'cream', 'dust', 'amber', 'coral', 'moss', 'violet'] as const) {
    root.style.setProperty(`--c-${k}`, t.p[k]);
    C[k] = t.p[k];
  }
  root.style.setProperty('color-scheme', t.p.scheme);
  root.dataset.theme = t.id;
  try { localStorage.setItem('deepcuts.theme', t.id); } catch { /* ignore */ }
  return t;
}
export const loadThemeId = () => { try { return localStorage.getItem('deepcuts.theme') ?? 'ink'; } catch { return 'ink'; } };
