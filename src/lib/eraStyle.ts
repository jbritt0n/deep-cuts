/**
 * Phase 9i — Eras chart appearance (owner: "adjust the gap between the areas and the colour schemes/style…,
 * make them more legible… a little taller"). A display preference, so it lives on this machine (localStorage)
 * like the display size, and every open chart follows a change immediately.
 */
import { useEffect, useState } from 'react';

export type EraPalette = 'ember' | 'spectrum' | 'dusk' | 'mono' | 'contrast';
export type EraFill = 'soft' | 'solid' | 'gradient' | 'outline';
export type EraStyle = { gap: number; bandGap: number; height: number; weekWidth: number; palette: EraPalette; fill: EraFill; labels: 'all' | 'long' };
export const ERA_STYLE_DEFAULT: EraStyle = { gap: 3, bandGap: 14, height: 1, weekWidth: 14, palette: 'ember', fill: 'gradient', labels: 'all' };

/** Era colours cycle through the palette in order; thread colours hash onto the second list. */
export const PALETTES: Record<EraPalette, { label: string; eras: string[]; threads: string[] }> = {
  ember:    { label: 'Ember (original)', eras: ['#F2A93B', '#D98E2B', '#F2C27B', '#C97A2A'], threads: ['#7FC8A9', '#8A6FB0', '#E4655F', '#6F8FB0', '#F2C27B', '#B9A6D6', '#E4A5A0', '#5FD0A8', '#8FB8FF'] },
  spectrum: { label: 'Spectrum', eras: ['#F2A93B', '#E4655F', '#B96FD6', '#6F8FF0', '#4FC3B0', '#9BD35A'], threads: ['#F7D07A', '#F29A94', '#D7A6EC', '#A9BCF7', '#8FE0D2', '#C5E89A', '#F5B97A'] },
  dusk:     { label: 'Dusk (pastel)', eras: ['#E8B4A0', '#C9A7D9', '#A7C4D9', '#D9C7A7', '#B4D9C4'], threads: ['#F0D5C8', '#DCCBE6', '#C8DCE8', '#E8DEC8', '#CFE8DA', '#E6C8D5'] },
  mono:     { label: 'Monochrome', eras: ['#EFE9F4', '#BDB6C9', '#8F889C'], threads: ['#D8D2E0', '#A9A2B6', '#7C758A', '#C4BDCF'] },
  contrast: { label: 'High contrast', eras: ['#FFB000', '#FE6100', '#DC267F', '#785EF0', '#648FFF'], threads: ['#FFE08A', '#FFA36B', '#F28BBF', '#B3A6FF', '#9FC0FF', '#FFFFFF'] },
};

const KEY = 'deepcuts.eraStyle';
export function loadEraStyle(): EraStyle { try { return { ...ERA_STYLE_DEFAULT, ...(JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<EraStyle>) }; } catch { return ERA_STYLE_DEFAULT; } }
export function saveEraStyle(s: EraStyle) { try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* ignore */ } window.dispatchEvent(new Event('deepcuts:erastyle')); }
export function useEraStyle(): EraStyle {
  const [s, setS] = useState(loadEraStyle);
  useEffect(() => { const on = () => setS(loadEraStyle()); window.addEventListener('deepcuts:erastyle', on); return () => window.removeEventListener('deepcuts:erastyle', on); }, []);
  return s;
}
