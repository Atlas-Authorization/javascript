import { describe, expect, it } from 'vitest';
import { buildWidgetAppearance, resolveChromeTokens, resolveTheme } from './theme';
import { dark } from '@atlasauth/themes';

describe('resolveTheme', () => {
  it('resolves a preset name, a passthrough object, and auto/none', () => {
    expect(resolveTheme('dark')).toBe(dark);
    expect(resolveTheme('auto')).toBeNull();
    expect(resolveTheme(undefined)).toBeNull();
    const custom = { variables: { colorPrimary: '#f00' } };
    expect(resolveTheme(custom)).toBe(custom);
  });
});

describe('buildWidgetAppearance', () => {
  it('maps theme variables onto the widget token set (primary → accent, bg → card)', () => {
    const a = buildWidgetAppearance({ theme: 'dark' });
    expect(a?.variables?.colorPrimary).toBe('#818cf8');
    expect(a?.variables?.colorAccent).toBe('#818cf8');
    expect(a?.variables?.colorBackground).toBe('#14171c');
    expect(a?.variables?.colorCard).toBe('#14171c');
    // colorDanger / spacingUnit have no widget token and are dropped.
    expect('colorDanger' in (a?.variables ?? {})).toBe(false);
  });

  it('layers primaryColor over the theme, and the advanced appearance over that', () => {
    const a = buildWidgetAppearance({
      theme: 'dark',
      primaryColor: '#16a34a',
      appearance: { variables: { colorText: '#000000' }, elements: { card: 'rounded-xl' } },
    });
    expect(a?.variables?.colorPrimary).toBe('#16a34a');
    expect(a?.variables?.colorText).toBe('#000000');
    expect(a?.elements?.card).toBe('rounded-xl');
  });

  it('returns undefined when there is nothing to theme', () => {
    expect(buildWidgetAppearance({ theme: 'auto' })).toBeUndefined();
  });
});

describe('resolveChromeTokens', () => {
  it('uses the dark preset for the shell, with a neutral fallback for missing tokens', () => {
    const t = resolveChromeTokens({ theme: 'dark' });
    expect(t.colorBackground).toBe('#14171c');
    expect(t.colorPrimary).toBe('#818cf8');
    expect(t.colorDanger).toBe('#f87171');
  });

  it('falls back to neutral light tokens for auto', () => {
    const t = resolveChromeTokens({ theme: 'auto' });
    expect(t.colorBackground).toBe('#ffffff');
    expect(t.colorPrimary).toBe('#5b5bd6');
  });

  it('primaryColor wins over the preset accent', () => {
    expect(resolveChromeTokens({ theme: 'dark', primaryColor: '#16a34a' }).colorPrimary).toBe('#16a34a');
  });
});
