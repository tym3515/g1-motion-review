import { useEffect, useState } from 'react';

const KEYS = [
  'ink', 'muted', 'faint', 'accent', 'accent-soft', 'ok', 'warn', 'warn-fill', 'bad', 'bad-soft', 'warn-soft',
  'stage', 'grid-major', 'grid-minor', 'track', 'line', 'line-2', 'line-data', 'surface', 'raised', 'live',
] as const;
export type ColorKey = (typeof KEYS)[number];
export type Colors = Record<ColorKey, string>;

/** 画布和 three.js 不认 CSS 变量，这里把主题色读成具体颜色值。 */
export function readColors(): Colors {
  const cs = getComputedStyle(document.documentElement);
  return Object.fromEntries(KEYS.map((k) => [k, cs.getPropertyValue(`--${k}`).trim()])) as Colors;
}

let current: Colors | null = null;
const listeners = new Set<(c: Colors) => void>();

function refresh() {
  current = readColors();
  listeners.forEach((l) => l(current!));
}

if (typeof window !== 'undefined') {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', refresh);
  new MutationObserver(refresh).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
}

export function getColors(): Colors {
  return (current ??= readColors());
}

export function onColors(fn: (c: Colors) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useColors(): Colors {
  const [c, setC] = useState(getColors);
  useEffect(() => onColors(setC), []);
  return c;
}
