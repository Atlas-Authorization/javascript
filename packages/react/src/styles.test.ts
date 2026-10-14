import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ATLAS_BASE_CSS, ATLAS_STYLES_CSS, injectAtlasStyles } from './styles';

/**
 * The v0.1.15 bug: the components emitted `atlas-*` class names but the package
 * shipped no CSS for them. This guard fails if a component ever references a
 * base class the stylesheet does not define — the exact regression.
 */
describe('base stylesheet covers every emitted class', () => {
  // The base classes the components hand to `useClass(..., base)` or write as a
  // literal `className`. Kept in sync with components.tsx.
  const EMITTED = [
    'atlas-root',
    'atlas-card',
    'atlas-title',
    'atlas-field',
    'atlas-input',
    'atlas-button',
    'atlas-error',
    'atlas-social-button',
    'atlas-social-label',
    'atlas-social-icon',
    'atlas-avatar',
    'atlas-menu',
    'atlas-menu-item',
    'atlas-user-button',
    'atlas-tabs',
    'atlas-tab',
    'atlas-pricing-table',
    'atlas-price',
    'atlas-interval',
  ];

  it('defines a rule for each class', () => {
    const missing = EMITTED.filter((cls) => !ATLAS_STYLES_CSS.includes(`.${cls}`));
    expect(missing).toEqual([]);
  });

  it('actually catches a class the components use but the source did not hardcode', () => {
    // Cross-check against the real component source so this list cannot silently
    // drift: every `atlas-…` class literal a component renders must be covered.
    // The library was split from a single `components.tsx` into per-component
    // sibling files, so scan every `*.tsx` component source (not just
    // `components.tsx`, which is now only re-exports) — otherwise moving a
    // class-bearing component into a new file would silently defeat this guard.
    // `AtlasProvider.tsx` is excluded: it is not a prebuilt-component render
    // surface and uses the string 'atlas-session' as a BroadcastChannel name,
    // not a CSS class.
    const files = readdirSync(__dirname).filter(
      (f) => f.endsWith('.tsx') && f !== 'AtlasProvider.tsx',
    );
    // Real class literals only: exclude `--atlas-*` CSS variables and
    // `data-atlas-*` attributes (both preceded by a hyphen).
    const used = new Set<string>();
    for (const file of files) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      for (const m of src.matchAll(/(?<![-\w])atlas-[a-z-]+/g)) used.add(m[0]);
    }
    const uncovered = [...used].filter((cls) => !ATLAS_STYLES_CSS.includes(`.${cls}`));
    expect(uncovered).toEqual([]);
  });

  it('themes off the --atlas-* design tokens (so appearance variables apply)', () => {
    expect(ATLAS_BASE_CSS).toContain('var(--atlas-color-primary');
    expect(ATLAS_BASE_CSS).toContain('var(--atlas-border-radius');
    // Scoped so it never leaks into the host app.
    expect(ATLAS_BASE_CSS).toContain('.atlas-root');
  });
});

describe('injectAtlasStyles', () => {
  it('is a safe no-op when there is no DOM (SSR)', () => {
    expect(typeof document).toBe('undefined');
    expect(() => injectAtlasStyles()).not.toThrow();
  });
});
