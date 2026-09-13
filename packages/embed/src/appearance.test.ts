import { describe, expect, it } from 'vitest';
import {
  classFor,
  cssVariables,
  orderedProviders,
  providerLabel,
  resolveInteraction,
  resolveTokens,
  type PublicAppearance,
} from './appearance';

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
