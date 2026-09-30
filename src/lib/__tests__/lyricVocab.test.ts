import { describe, expect, it } from 'vitest';
import rs from '../../../src-tauri/src/connectors/lyrics.rs?raw';
import { MOOD_IDS, THEME_VOCAB, suspicious } from '../lyricVocab';

const list = (name: string) => { const m = new RegExp(`pub const ${name}: &\\[&str\\] = &\\[([\\s\\S]*?)\\];`).exec(rs); return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : []; };

describe('lyric vocabularies (Phase 10d)', () => {
  it('moods match the Rust palette exactly', () => { expect(list('MOODS')).toEqual(MOOD_IDS); });
  it('themes match the Rust vocabulary exactly', () => { expect(list('THEME_VOCAB')).toEqual(THEME_VOCAB); });
  it('flags the owner-reported v1 mistakes', () => {
    expect(suspicious({ track: 'Big Bad Wolf (Radio Edit)', artist: 'Duck Sauce', llmThemes: ['radio edit'], llmMood: null, llmRev: 2 })).toHaveLength(1);
    expect(suspicious({ track: 'x', artist: 'y', llmThemes: [], llmMood: '1 to 2 words', llmRev: 1 }).length).toBeGreaterThanOrEqual(2);
    expect(suspicious({ track: 'Hypercolour', artist: 'CamelPhat', llmThemes: ['the road'], llmMood: 'euphoric', llmRev: 2 })).toEqual([]);
  });
});
