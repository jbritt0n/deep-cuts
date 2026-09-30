/**
 * Phase 10d — the local model's vocabularies for lyric tagging v2. MUST match `MOODS` / `THEME_VOCAB` in
 * src-tauri/src/connectors/lyrics.rs (a vitest test compares them). Each mood sits on a two-axis map:
 * valence (−1 bleak … +1 bright) × energy (−1 calm … +1 intense) — Russell's circumplex, the usual way to lay out
 * emotion words so near-synonyms land near each other and the map shows the *shape* of what you listen to.
 */
export type Mood = { id: string; v: number; e: number };
export const MOODS: Mood[] = [
  { id: 'euphoric', v: 0.9, e: 0.9 }, { id: 'joyful', v: 0.85, e: 0.6 }, { id: 'celebratory', v: 0.75, e: 0.85 }, { id: 'triumphant', v: 0.65, e: 0.9 },
  { id: 'empowered', v: 0.55, e: 0.75 }, { id: 'confident', v: 0.5, e: 0.55 }, { id: 'playful', v: 0.7, e: 0.45 }, { id: 'carefree', v: 0.7, e: 0.2 },
  { id: 'smitten', v: 0.8, e: 0.3 }, { id: 'romantic', v: 0.65, e: 0.05 }, { id: 'tender', v: 0.55, e: -0.35 }, { id: 'hopeful', v: 0.55, e: 0.1 },
  { id: 'serene', v: 0.5, e: -0.8 }, { id: 'dreamy', v: 0.35, e: -0.6 }, { id: 'sultry', v: 0.35, e: 0.15 }, { id: 'hypnotic', v: 0.1, e: -0.2 },
  { id: 'wry', v: 0.25, e: 0.25 }, { id: 'nostalgic', v: 0.15, e: -0.45 }, { id: 'wistful', v: -0.1, e: -0.55 }, { id: 'bittersweet', v: 0.0, e: -0.3 },
  { id: 'reflective', v: 0.05, e: -0.7 }, { id: 'yearning', v: -0.3, e: 0.1 }, { id: 'vulnerable', v: -0.35, e: -0.35 }, { id: 'melancholic', v: -0.6, e: -0.55 },
  { id: 'lonely', v: -0.7, e: -0.4 }, { id: 'heartbroken', v: -0.8, e: -0.15 }, { id: 'mournful', v: -0.85, e: -0.6 }, { id: 'resigned', v: -0.55, e: -0.8 },
  { id: 'brooding', v: -0.5, e: -0.05 }, { id: 'eerie', v: -0.4, e: 0.0 }, { id: 'anxious', v: -0.5, e: 0.55 }, { id: 'restless', v: -0.2, e: 0.65 },
  { id: 'gritty', v: -0.15, e: 0.5 }, { id: 'defiant', v: -0.05, e: 0.8 }, { id: 'bitter', v: -0.6, e: 0.35 }, { id: 'angry', v: -0.75, e: 0.85 },
  { id: 'menacing', v: -0.65, e: 0.6 }, { id: 'desperate', v: -0.75, e: 0.55 },
];
export const MOOD_IDS = MOODS.map((m) => m.id);
export const moodOf = (id: string | null | undefined) => MOODS.find((m) => m.id === id);

export const THEME_VOCAB = ['rain', 'night', 'sun & summer', 'winter', 'ocean & shore', 'river & lake', 'the city', 'the road', 'home', 'romance', 'heartbreak', 'longing',
  'nostalgia & memory', 'dancing & party', 'dreams & sleep', 'fire & smoke', 'money & work', 'faith & the divine', 'youth & growing up', 'death & mourning', 'war & violence',
  'time passing', 'nature & wild', 'defiance & protest', 'loneliness & isolation', 'drink & intoxication', 'anger & revenge', 'hope & light', 'family', 'the body',
  'machines & static', 'space & cosmos', 'the troubled mind', 'small town & country', 'dawn & morning',
  'new love', 'desire & lust', 'devotion', 'jealousy', 'betrayal', 'friendship', 'self-worth', 'ambition & success', 'freedom & escape', 'identity', 'addiction', 'grief',
  'regret', 'forgiveness', 'moving on', 'obsession', 'temptation', 'survival', 'fame', 'social commentary', 'travel & wanderlust', 'nightlife'];
/** The first 35 are the cue-word lexicon's own themes (lyrics.rs `themes()`), so both methods can be compared. */
export const LEXICON_THEMES = THEME_VOCAB.slice(0, 35);

/** Colour families for the mood map and chips: bright-intense, bright-calm, bleak-calm, bleak-intense. */
export function moodQuadrant(m: Mood): 'bright-hot' | 'bright-calm' | 'bleak-calm' | 'bleak-hot' {
  return m.v >= 0 ? (m.e >= 0 ? 'bright-hot' : 'bright-calm') : (m.e >= 0 ? 'bleak-hot' : 'bleak-calm');
}

/** Heuristics behind the "suspicious" filter in Lyrics → Hygiene: tags the v1 prompt got wrong. */
export function suspicious(r: { track: string; artist: string; llmThemes: string[]; llmMood: string | null; llmRev: number | null }): string[] {
  const why: string[] = [];
  const name = `${r.track} ${r.artist}`.toLowerCase();
  const junk = /\b(radio edit|edit|remix|remaster(ed)?|version|mix|feat|words?|phrase|lowercase)\b|\d/;
  for (const t of r.llmThemes) {
    if (junk.test(t)) why.push(`“${t}” looks like a release or prompt word`);
    else if (t.length > 3 && name.includes(t)) why.push(`“${t}” is in the title or artist`);
  }
  if (r.llmMood && !MOOD_IDS.includes(r.llmMood)) why.push(`mood “${r.llmMood}” is not on the palette`);
  if (r.llmMood && junk.test(r.llmMood)) why.push(`mood “${r.llmMood}” looks like the prompt echoed back`);
  if ((r.llmRev ?? 0) < 2 && (r.llmThemes.length || r.llmMood)) why.push('tagged by the old free-form prompt');
  return why;
}
