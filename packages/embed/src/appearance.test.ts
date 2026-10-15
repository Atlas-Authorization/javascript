import { contrastRatio } from '@atlasauth/design/runtime';
import { describe, expect, it } from 'vitest';
import {
  classFor,
  cssVariables,
  orderedProviders,
  providerLabel,
  resolveInteraction,
  resolveTokens,
  focusRingOn,
  textOnPrimary,
  type PublicAppearance,
} from './appearance';
import { EMBED_CSS } from './styles';

const appearance = (over: Partial<PublicAppearance> = {}): PublicAppearance => ({
  applicationName: 'Acme',
  logoUrl: null,
  colorPrimary: '#111111',
  colorBackground: '#ffffff',
  colorText: '#222222',
  colorAccent: '#333333',
  colorCard: '#f9f9f9',
  colorBorder: '#eeeeee',
  borderRadius: '6px',
  theme: 'light',
  fontStack: 'Inter, sans-serif',
  layout: 'centered',
  headline: null,
  subheadline: null,
  footer: null,
  providerOrder: [],
  providerHidden: [],
  ...over,
});

describe('resolving theme tokens', () => {
  it('maps the tenant appearance onto tokens', () => {
    const tokens = resolveTokens(appearance());
    expect(tokens.colorPrimary).toBe('#111111');
    expect(tokens.fontFamily).toBe('Inter, sans-serif');
  });

  it('lets an inline override win, leaving other tokens intact', () => {
    const tokens = resolveTokens(appearance(), { variables: { colorPrimary: '#ff0000' } });
    expect(tokens.colorPrimary).toBe('#ff0000');
    // The other tokens still come from the tenant.
    expect(tokens.colorText).toBe('#222222');
  });

  it('emits kebab-cased --atlas-embed-* custom properties', () => {
    const vars = cssVariables(resolveTokens(appearance()));
    expect(vars['--atlas-embed-color-primary']).toBe('#111111');
    expect(vars['--atlas-embed-border-radius']).toBe('6px');
  });
});

describe('accessibility of the base styles', () => {
  it('picks the primary button label for contrast', () => {
    expect(textOnPrimary('#5b5bd6')).toBe('#ffffff');
    expect(textOnPrimary('#ffe600')).toBe('#111111');
    expect(textOnPrimary('var(--brand)')).toBe('#ffffff');
  });

  it('labels the primary button from the contrast variable, not a fixed white', () => {
    const button = EMBED_CSS.slice(EMBED_CSS.indexOf('.atlas-embed-button {'));
    expect(button.slice(0, button.indexOf('}'))).toContain('color: var(--_on-primary)');
  });

  it('derives a focus ring with 3:1 on the card and background (mint on white)', () => {
    const ring = focusRingOn('#22f79a', ['#ffffff', '#ffffff']);
    expect(ring).not.toBe('#22f79a');
    expect(contrastRatio(ring, '#ffffff')).toBeGreaterThanOrEqual(3);
    // A primary that already passes is kept as is.
    expect(focusRingOn('#5b5bd6', ['#ffffff'])).toBe('#5b5bd6');
    // Both papers must pass, and a dark card gets a lighter ring.
    const dark = focusRingOn('#1e3a8a', ['#14171c', '#0b0b0f']);
    expect(contrastRatio(dark, '#14171c')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(dark, '#0b0b0f')).toBeGreaterThanOrEqual(3);
    expect(focusRingOn('var(--brand)', ['#ffffff'])).toBe('var(--brand)');
  });

  it('gives buttons a solid :focus-visible outline', () => {
    expect(EMBED_CSS).toMatch(/\.atlas-embed-button:focus-visible[^{]*\{\s*outline: 2px solid var\(--_focus\)/);
  });

  it('never sizes a text field below 16px', () => {
    for (const cls of ['.atlas-embed-input {', '.atlas-embed-social-search {']) {
      const rule = EMBED_CSS.slice(EMBED_CSS.indexOf(cls));
      expect(rule.slice(0, rule.indexOf('}')), cls).toContain('font-size: 16px');
    }
  });
});

describe('per-element class overrides', () => {
  it('appends the override so ours stays and theirs wins on ties', () => {
    expect(classFor('buttonPrimary', 'atlas-embed-button', { elements: { buttonPrimary: 'brand' } })).toBe(
      'atlas-embed-button brand',
    );
  });

  it('is just the base when there is no override', () => {
    expect(classFor('card', 'atlas-embed-card')).toBe('atlas-embed-card');
  });
});

describe('provider ordering', () => {
  it('honours the tenant order then appends the rest, dropping hidden', () => {
    const result = orderedProviders(
      ['google', 'github', 'gitlab'],
      appearance({ providerOrder: ['github'], providerHidden: ['gitlab'] }),
    );
    expect(result).toEqual(['github', 'google']);
  });

  it('falls back to the enabled order with no appearance', () => {
    expect(orderedProviders(['google', 'github'], null)).toEqual(['google', 'github']);
  });
});

describe('provider labels', () => {
  it('uses known names and title-cases the rest', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('acme_sso')).toBe('Acme Sso');
  });
});

describe('resolving the interaction config', () => {
  it('defaults to a polished-out-of-the-box feel', () => {
    const i = resolveInteraction(undefined, undefined);
    expect(i).toEqual({
      buttonStyle: 'solid',
      buttonEffect: 'scale',
      shadow: 'md',
      density: 'comfortable',
      inputStyle: 'outline',
      animations: true,
      motionSpeed: 'normal',
      loading: 'spinner',
    });
  });

  it('lets the inline override win over the tenant default', () => {
    const i = resolveInteraction(
      { buttonEffect: 'ripple', shadow: 'lg' },
      { buttonEffect: 'glow' },
    );
    expect(i.buttonEffect).toBe('glow'); // inline wins
    expect(i.shadow).toBe('lg'); // falls through to the tenant default
  });

  it('falls back to defaults for junk values rather than emitting a broken attribute', () => {
    const i = resolveInteraction({ buttonStyle: 'neon' as never, motionSpeed: 'warp' as never }, undefined);
    expect(i.buttonStyle).toBe('solid');
    expect(i.motionSpeed).toBe('normal');
  });

  it('treats animations as a real boolean — false is honoured, not ignored', () => {
    expect(resolveInteraction({ animations: false }, undefined).animations).toBe(false);
    expect(resolveInteraction({ animations: false }, { animations: true }).animations).toBe(true);
  });

  it('resolves the loading style — default spinner, valid wins, junk falls back', () => {
    expect(resolveInteraction(undefined, undefined).loading).toBe('spinner');
    expect(resolveInteraction({ loading: 'skeleton' }, undefined).loading).toBe('skeleton');
    expect(resolveInteraction({ loading: 'dots' }, { loading: 'bar' }).loading).toBe('bar');
    expect(resolveInteraction({ loading: 'orbit' as never }, undefined).loading).toBe('spinner');
  });
});
