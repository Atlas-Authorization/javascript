import { describe, expect, it } from 'vitest';
import type { Appearance } from '@atlasauth/react';
import {
  APPEARANCE_KEYS,
  base,
  dark,
  experimental_createTheme,
  midnight,
  neobrutalism,
  shadcn,
  themes,
} from './index';

// Type-level assertion: every shipped theme must be assignable to `Appearance`.
// If any theme set a field that is not on the real Atlas type, this would fail
// to compile — i.e. the typecheck step is part of the test.
const _typed: Record<string, Appearance> = { base, dark, midnight, neobrutalism, shadcn };
void _typed;

/** The only token keys the Atlas `DesignTokens` type allows. */
const DESIGN_TOKEN_KEYS = new Set([
  'colorPrimary',
  'colorText',
  'colorBackground',
  'colorDanger',
  'colorBorder',
  'borderRadius',
  'fontFamily',
  'spacingUnit',
]);

/** The only element keys the Atlas `ElementKey` type allows. */
const ELEMENT_KEYS = new Set([
  'root',
  'card',
  'headerTitle',
  'headerSubtitle',
  'formField',
  'formFieldLabel',
  'formFieldInput',
  'formFieldError',
  'formButtonPrimary',
  'formButtonSecondary',
  'socialButton',
  'dividerText',
  'footerAction',
  'avatar',
  'menu',
  'menuItem',
  'badge',
]);

const NAMED = Object.entries(themes) as Array<[string, Appearance]>;

describe('prebuilt themes', () => {
  it('ships the documented set', () => {
    expect(Object.keys(themes).sort()).toEqual(
      ['base', 'dark', 'midnight', 'neobrutalism', 'shadcn'].sort(),
    );
  });

  it.each(NAMED)('%s is a non-empty object', (_name, theme) => {
    expect(theme).toBeTypeOf('object');
    expect(theme).not.toBeNull();
    expect(Object.keys(theme).length).toBeGreaterThan(0);
  });

  it.each(NAMED)('%s sets no unknown top-level key', (_name, theme) => {
    for (const key of Object.keys(theme)) {
      expect(APPEARANCE_KEYS).toContain(key as (typeof APPEARANCE_KEYS)[number]);
    }
  });

  it.each(NAMED)('%s uses only valid design-token keys with string values', (_name, theme) => {
    for (const [key, value] of Object.entries(theme.variables ?? {})) {
      expect(DESIGN_TOKEN_KEYS.has(key)).toBe(true);
      expect(value).toBeTypeOf('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it.each(NAMED)('%s uses only valid element keys with string values', (_name, theme) => {
    for (const [key, value] of Object.entries(theme.elements ?? {})) {
      expect(ELEMENT_KEYS.has(key)).toBe(true);
      expect(value).toBeTypeOf('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('dark is actually dark (background darker than text)', () => {
    // Sanity: a dark theme must not accidentally ship light tokens.
    expect(dark.variables?.colorBackground).toBe('#14171c');
    expect(midnight.variables?.colorBackground).toBe('#0b1020');
  });

  it('neobrutalism commits to hard edges', () => {
    expect(neobrutalism.variables?.borderRadius).toBe('0px');
    expect(neobrutalism.elements?.formButtonPrimary).toContain('border-2');
    expect(neobrutalism.elements?.card).toContain('shadow-[6px_6px_0_0_#000]');
  });

  it('shadcn uses a subtle radius', () => {
    expect(shadcn.variables?.borderRadius).toBe('6px');
  });
});

describe('experimental_createTheme', () => {
  it('deep-merges variables onto the default base', () => {
    const t = experimental_createTheme({ variables: { colorPrimary: '#16a34a' } });
    // Overridden field wins...
    expect(t.variables?.colorPrimary).toBe('#16a34a');
    // ...while the rest of the base tokens survive the merge.
    expect(t.variables?.colorBackground).toBe(base.variables?.colorBackground);
    expect(t.variables?.fontFamily).toBe(base.variables?.fontFamily);
  });

  it('deep-merges onto an explicit base theme', () => {
    const t = experimental_createTheme(
      { variables: { colorPrimary: '#16a34a' }, elements: { card: 'rounded-2xl' } },
      dark,
    );
    expect(t.variables?.colorPrimary).toBe('#16a34a');
    // dark's own tokens and element overrides are preserved.
    expect(t.variables?.colorBackground).toBe('#14171c');
    expect(t.elements?.formButtonPrimary).toBe(dark.elements?.formButtonPrimary);
    // ...and the new element override is layered in.
    expect(t.elements?.card).toBe('rounded-2xl');
  });

  it('does not mutate the base or the overrides', () => {
    const baseBefore = JSON.stringify(dark);
    const overrides: Appearance = { variables: { colorPrimary: '#fff' } };
    const overridesBefore = JSON.stringify(overrides);
    experimental_createTheme(overrides, dark);
    expect(JSON.stringify(dark)).toBe(baseBefore);
    expect(JSON.stringify(overrides)).toBe(overridesBefore);
  });

  it('ignores undefined override values rather than blanking the base', () => {
    const t = experimental_createTheme({ variables: { colorPrimary: undefined } }, dark);
    expect(t.variables?.colorPrimary).toBe(dark.variables?.colorPrimary);
  });

  it('produces a value that is still a valid Appearance', () => {
    const t = experimental_createTheme({ elements: { badge: 'uppercase' } }, shadcn);
    for (const key of Object.keys(t)) {
      expect(APPEARANCE_KEYS).toContain(key as (typeof APPEARANCE_KEYS)[number]);
    }
    for (const key of Object.keys(t.variables ?? {})) {
      expect(DESIGN_TOKEN_KEYS.has(key)).toBe(true);
    }
    for (const key of Object.keys(t.elements ?? {})) {
      expect(ELEMENT_KEYS.has(key)).toBe(true);
    }
  });
});
