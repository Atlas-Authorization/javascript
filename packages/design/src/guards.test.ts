import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDesign, isValidDesign, isValidDesignSection } from './guards';
import { DESIGN_PRESET_LIST } from './presets';
import { resolveDesign } from './resolve';
import { designSchema } from './schema';
import { compileDesignCss, composeDesign } from './runtime';

/** A small deterministic PRNG so the fuzz is reproducible. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NASTY: unknown[] = [
  undefined, null, true, 0, -1, 1.5, 12, 13, 16, 20, 21, 100, 150, 400, 450, 500, 999, 1000, NaN, Infinity,
  '', 'x', '#fff', '#FFFFFF', '#12345g', '#1234567', 'red', 'red;}body{x:y', '</style><script>', 'url(javascript:alert(1))',
  'inter', 'Inter', 'system', 'comic-sans', 'solid', 'glass', 'gradient', 'icons', 'filled', 'underline', 'compact',
  'linear', 'radial', 'cover', 'top-left', 'dots', 'auto', 'dark', 'midnight', 'nope', 'uppercase', 'golden',
  'dasset_01J8ZW3K9M0000000000000000', 'dasset_bad', [], {}, [1, 2], { a: 1 },
];

const SECTION_KEYS: Record<string, string[]> = {
  palette: ['primary', 'primaryInk', 'accent', 'background', 'surface', 'text', 'muted', 'border', 'danger', 'success', 'inputBackground', 'inputText', 'bogus'],
  typography: ['font', 'headingFont', 'baseSize', 'headingWeight', 'bodyWeight', 'letterCase', 'scale', 'size'],
  shape: ['radius', 'controlRadius', 'borderWidth', 'r'],
  elevation: ['cardShadow', 'x'],
  spacing: ['density'],
  card: ['style', 'blur', 'width', 'height'],
  layout: ['position', 'splitImageSide', 'logoPlacement', 'logoSize'],
  buttons: ['style', 'socialLayout'],
  inputs: ['style'],
  logo: ['assetId', 'darkAssetId', 'url'],
};

function randomDesign(r: () => number): Record<string, unknown> {
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const out: Record<string, unknown> = {};
  const tops = ['version', 'preset', 'colorScheme', 'background', 'backgroundDark', 'paletteDark', ...Object.keys(SECTION_KEYS), 'css'];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const k = pick(tops);
    if (k === 'version') out[k] = pick([1, 2, '1', undefined]);
    else if (k === 'preset' || k === 'colorScheme') out[k] = pick(NASTY);
    else if (k === 'background' || k === 'backgroundDark') {
      const bg: Record<string, unknown> = {};
      if (r() < 0.5) bg.color = pick(NASTY);
      if (r() < 0.4) bg.pattern = pick(NASTY);
      if (r() < 0.4) {
        const stops = Array.from({ length: Math.floor(r() * 6) }, () =>
          r() < 0.8 ? { color: pick(['#112233', '#abcdef', ...NASTY.slice(20, 30)]), at: pick([0, 50, 100, 101, -1, NaN, '5']) } : pick(NASTY),
        );
        bg.gradient = r() < 0.9 ? { type: pick(['linear', 'radial', 'conic', undefined]), angle: pick([undefined, 0, 90, 361, 45.5]), stops } : pick(NASTY);
      }
      if (r() < 0.4) {
        bg.image = { assetId: pick(['dasset_01J8ZW3K9M0000000000000000', 'dasset_x', undefined]), fit: pick([undefined, 'cover', 'fill']), blur: pick([undefined, 0, 20, 21]), overlay: pick([undefined, { color: '#000000', opacity: 0.5 }, { color: '#000000', opacity: 2 }, { color: '#000000' }]) };
      }
      if (r() < 0.1) bg.extra = 1;
      out[k] = r() < 0.9 ? bg : pick(NASTY);
    } else if (k === 'css') out[k] = 'body{}';
    else {
      const keys = SECTION_KEYS[k === 'paletteDark' ? 'palette' : k]!;
      const sec: Record<string, unknown> = {};
      const m = 1 + Math.floor(r() * 3);
      for (let j = 0; j < m; j++) sec[pick(keys)] = pick(NASTY);
      out[k] = r() < 0.9 ? sec : pick(NASTY);
    }
  }
  return out;
}

describe('runtime guards agree with the zod schema', () => {
  it('on every preset and on resolved designs', () => {
    for (const p of DESIGN_PRESET_LIST) {
      expect(isValidDesign({ preset: p.id, ...p.design })).toBe(true);
      expect(designSchema.safeParse({ preset: p.id, ...p.design }).success).toBe(true);
      const resolved = resolveDesign({ preset: p.id });
      expect(isValidDesign(resolved)).toBe(designSchema.safeParse(resolved).success);
    }
  });

  it('on 5000 fuzzed designs (same accept/reject, per design and per section)', () => {
    const r = rng(42);
    let accepted = 0;
    for (let i = 0; i < 5000; i++) {
      const d = randomDesign(r);
      const zod = designSchema.safeParse(d).success;
      expect(isValidDesign(d), JSON.stringify(d)).toBe(zod);
      if (zod) accepted++;
      for (const [k, v] of Object.entries(d)) {
        const field = (designSchema.shape as Record<string, { safeParse(v: unknown): { success: boolean } }>)[k];
        if (field && v !== undefined) expect(isValidDesignSection(k, v), `${k}: ${JSON.stringify(v)}`).toBe(field.safeParse(v).success);
      }
      // Whatever checkDesign keeps is valid.
      expect(designSchema.safeParse(checkDesign(d)).success).toBe(true);
    }
    expect(accepted).toBeGreaterThan(100);
  });
});

describe('the runtime entry', () => {
  it('pulls in no zod (static import graph from runtime.ts)', () => {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(join(__dirname, file), 'utf8');
      for (const m of src.matchAll(/^(?:import|export)\s+(?!type\b)[^;]*?from\s+'([^']+)'/gms)) {
        const spec = m[1]!;
        expect(spec, `${file} imports ${spec}`).not.toBe('zod');
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\//);
        if (!/^(?:import|export)\s+type\b/.test(m[0])) visit(`${spec.slice(2)}.ts`);
      }
    };
    visit('runtime.ts');
    expect(seen.has('schema.ts')).toBe(false);
    expect(seen.has('guards.ts')).toBe(true);
  });

  it('never lets injection attempts in code overrides reach CSS', () => {
    const r = rng(7);
    for (let i = 0; i < 1000; i++) {
      const c = composeDesign({ design: randomDesign(r), preset: 'glass', warn: () => {} });
      expect(c.css).not.toMatch(/[<>\\]|@import|javascript:|expression\(|body\{/i);
    }
    expect(() => compileDesignCss(resolveDesign({}), { scope: '.a{}' })).toThrow();
  });
});
