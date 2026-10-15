import { contrastRatio, resolveDesign } from '@atlasauth/design';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_TOKENS, cssVariables, renderAppearance, resolveTokens, type InstanceDesign } from './appearance';
import { focusRingOn, textOnPrimary } from './contrast';
import { ATLAS_BASE_CSS, ATLAS_DESIGN_CSS } from './styles';

/** The declarations of the first rule (one per line) whose text contains `selector`. */
function rule(css: string, selector: string): string {
  const line = css.split('\n').find((l) => l.includes(selector));
  expect(line, selector).toBeDefined();
  return line!.slice(line!.indexOf('{') + 1, line!.lastIndexOf('}'));
}

describe('text on the primary colour', () => {
  it('is white on the default primary', () => {
    expect(textOnPrimary('#5b5bd6')).toBe('#ffffff');
    expect(resolveTokens().colorTextOnPrimary).toBe('#ffffff');
    expect(DEFAULT_TOKENS.colorTextOnPrimary).toBe('#ffffff');
  });

  it('is dark on a light primary', () => {
    expect(textOnPrimary('#ffe600')).toBe('#111111');
    expect(resolveTokens({ variables: { colorPrimary: '#ffe600' } }).colorTextOnPrimary).toBe('#111111');
  });

  it('is dark on the neobrutalist theme', () => {
    expect(resolveTokens({ baseTheme: 'neobrutalist' }).colorTextOnPrimary).toBe('#111111');
  });

  it('follows a primary overridden on top of a theme', () => {
    expect(resolveTokens({ baseTheme: 'neobrutalist', variables: { colorPrimary: '#1e3a8a' } }).colorTextOnPrimary).toBe(
      '#ffffff',
    );
  });

  it('reads rgb() and hsl() primaries', () => {
    expect(textOnPrimary('rgb(255, 230, 0)')).toBe('#111111');
    expect(textOnPrimary('hsl(54 100% 50%)')).toBe('#111111');
    expect(textOnPrimary('hsl(240, 60%, 30%)')).toBe('#ffffff');
  });

  it('an explicit colorTextOnPrimary wins', () => {
    const tokens = resolveTokens({ baseTheme: 'neobrutalist', variables: { colorTextOnPrimary: '#ff00ff' } });
    expect(tokens.colorTextOnPrimary).toBe('#ff00ff');
    expect(cssVariables(tokens)['--atlas-color-text-on-primary']).toBe('#ff00ff');
  });

  it('falls back to white for a primary it cannot evaluate', () => {
    expect(textOnPrimary('var(--brand)')).toBe('#ffffff');
    expect(resolveTokens({ variables: { colorPrimary: 'var(--brand)' } }).colorTextOnPrimary).toBe('#ffffff');
  });
});

describe('the focus ring colour', () => {
  it('defaults to the primary and follows it', () => {
    expect(resolveTokens().colorFocusRing).toBe(DEFAULT_TOKENS.colorPrimary);
    expect(resolveTokens({ variables: { colorPrimary: '#0f766e' } }).colorFocusRing).toBe('#0f766e');
  });

  it('keeps a theme ring that stays visible where its primary would not (yellow on white)', () => {
    expect(resolveTokens({ baseTheme: 'neobrutalist' }).colorFocusRing).toBe('#000000');
  });

  it('an explicit colorFocusRing wins and is emitted as a variable', () => {
    const tokens = resolveTokens({ variables: { colorPrimary: '#0f766e', colorFocusRing: '#000000' } });
    expect(cssVariables(tokens)['--atlas-color-focus-ring']).toBe('#000000');
  });

  it('darkens a light primary until it has 3:1 on the background (mint on white)', () => {
    expect(contrastRatio('#22f79a', '#ffffff')).toBeLessThan(1.6);
    const ring = resolveTokens({ variables: { colorPrimary: '#22f79a' } }).colorFocusRing;
    expect(ring).not.toBe('#22f79a');
    expect(contrastRatio(ring, '#ffffff')).toBeGreaterThanOrEqual(3);
    // Still the brand hue: green dominates.
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(ring.slice(i, i + 2), 16));
    expect(g).toBeGreaterThan(r!);
    expect(g).toBeGreaterThan(b!);
  });

  it('an explicit colorFocusRing still wins, even a low-contrast one', () => {
    expect(resolveTokens({ variables: { colorPrimary: '#22f79a', colorFocusRing: '#22f79a' } }).colorFocusRing).toBe(
      '#22f79a',
    );
  });

  it('clears 3:1 against colorBackground for any primary', () => {
    for (const primary of ['#22f79a', '#ffe600', '#fafafa', '#7dd3fc', '#0f766e', '#000000', '#5b5bd6']) {
      for (const colorBackground of ['#ffffff', '#f4f4f5', '#14171c', '#000000']) {
        const ring = resolveTokens({ variables: { colorPrimary: primary, colorBackground } }).colorFocusRing;
        expect(contrastRatio(ring, colorBackground), `${primary} on ${colorBackground}`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it('reads an hsl() primary', () => {
    const ring = focusRingOn('hsl(153 93% 55%)', '#ffffff');
    expect(ring.startsWith('#')).toBe(true);
    expect(contrastRatio(ring, '#ffffff')).toBeGreaterThanOrEqual(3);
  });

  it('lightens a dark primary on a dark background', () => {
    const ring = resolveTokens({ baseTheme: 'dark', variables: { colorPrimary: '#1e3a8a' } }).colorFocusRing;
    expect(contrastRatio(ring, '#14171c')).toBeGreaterThanOrEqual(3);
  });

  it('keeps a primary it cannot evaluate', () => {
    expect(resolveTokens({ variables: { colorPrimary: 'var(--brand)' } }).colorFocusRing).toBe('var(--brand)');
  });
});

describe('explicit accessibility tokens with a design active', () => {
  const instance: InstanceDesign = { resolved: resolveDesign({ preset: 'forest' }) };

  it('reach the root inline, over the design', () => {
    const out = renderAppearance({ variables: { colorTextOnPrimary: '#000000', colorFocusRing: '#123456' } }, instance);
    expect(out.style).toEqual({
      '--atlas-color-text-on-primary': '#000000',
      '--atlas-color-focus-ring': '#123456',
      '--atlas-focus-outline-color': '#123456',
    });
  });

  it('are not emitted when only derived', () => {
    const style = renderAppearance({ baseTheme: 'neobrutalist' }, instance).style;
    expect(style).not.toHaveProperty('--atlas-color-text-on-primary');
    expect(style).not.toHaveProperty('--atlas-color-focus-ring');
    expect(style).not.toHaveProperty('--atlas-focus-outline-color');
  });

  it('refuse an unsafe value', () => {
    const warn = vi.fn();
    const out = renderAppearance({ variables: { colorFocusRing: 'red;}body{display:none' } }, instance, { warn });
    expect(out.style).toEqual({});
    expect(warn).toHaveBeenCalled();
  });
});

describe('base stylesheet accessibility', () => {
  it('does not hard-code white text on the primary fill', () => {
    expect(rule(ATLAS_BASE_CSS, '.atlas-button{')).not.toContain('color:#fff;');
    expect(rule(ATLAS_BASE_CSS, '.atlas-button{')).toContain('color:var(--atlas-color-text-on-primary,#fff)');
    expect(rule(ATLAS_BASE_CSS, '.atlas-avatar{')).toContain('color:var(--atlas-color-text-on-primary,#fff)');
    expect(ATLAS_BASE_CSS).not.toMatch(/[;{]color:#fff[;}]/);
  });

  it('gives inputs and buttons a solid :focus-visible outline', () => {
    const focus = ATLAS_BASE_CSS.split('\n').find((l) => l.includes(':focus-visible'));
    expect(focus).toBeDefined();
    for (const cls of ['.atlas-input', '.atlas-button', '.atlas-social-button', '.atlas-menu-item', '.atlas-tab', '.atlas-avatar']) {
      expect(focus).toContain(cls);
    }
    expect(focus).toContain('outline:2px solid var(--atlas-color-focus-ring,var(--atlas-color-primary,#5b5bd6))');
    expect(focus).toContain('outline-offset:2px');
  });

  it('never sizes an input below 16px (iOS zooms on focus below that)', () => {
    expect(rule(ATLAS_BASE_CSS, '.atlas-input{')).toContain('font-size:max(16px,');
  });
});

describe('design stylesheet accessibility', () => {
  it('sizes inputs at 16px or more', () => {
    expect(rule(ATLAS_DESIGN_CSS, ':is(.atlas-input,.atlas-account-input){min-height')).toContain(
      'font-size:max(16px,var(--atlas-font-size-base))',
    );
  });

  it('focuses with a solid outline, not the translucent ring glow', () => {
    const focus = ATLAS_DESIGN_CSS.split('\n').find((l) => l.includes(':focus-visible'));
    expect(focus).toBeDefined();
    for (const cls of ['.atlas-input', '.atlas-button', '.atlas-social-button', '.atlas-menu-item', '.atlas-tab']) {
      expect(focus).toContain(cls);
    }
    expect(focus).toContain('outline:2px solid var(--atlas-focus-outline-color,var(--atlas-color-primary))');
    expect(ATLAS_DESIGN_CSS).not.toContain('outline:none;box-shadow:0 0 0 3px');
  });

  it('lets an explicit text-on-primary win over the design ink', () => {
    expect(rule(ATLAS_DESIGN_CSS, ') .atlas-button{')).toContain(
      'color:var(--atlas-color-text-on-primary,var(--atlas-color-primary-ink))',
    );
  });
});
