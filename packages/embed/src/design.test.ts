// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import { resolveDesign } from '@atlasauth/design';
import { AtlasWidget } from './widget';
import { widgetDesign } from './design';
import { optionsFromElement } from './config';
import type { AppearanceResponse, PublicAppearance } from './appearance';

const BRANDING: PublicAppearance = {
  applicationName: 'Acme',
  logoUrl: null,
  colorPrimary: '#5b5bd6',
  colorBackground: '#ffffff',
  colorText: '#1c1c1f',
  colorAccent: '#5b5bd6',
  colorCard: '#ffffff',
  colorBorder: '#e4e4e9',
  borderRadius: '10px',
  theme: 'light',
  fontStack: 'system-ui',
  layout: 'centered',
  headline: null,
  subheadline: null,
  footer: null,
  providerOrder: [],
  providerHidden: [],
};

const envelope = (extra: Partial<AppearanceResponse> = {}): AppearanceResponse => ({
  object: 'appearance',
  appearance: BRANDING,
  providers: [],
  strategies: { password: true, emailCode: false, emailLink: false, passkey: false, phoneCode: false, siwe: false },
  ...extra,
});

function fetchWith(body: AppearanceResponse) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    return new Response(JSON.stringify(path === '/v1/appearance' ? body : {}), {
      status: path === '/v1/appearance' ? 200 : 404,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const OPTS = { publishableKey: 'pk_test_1', frontendApi: 'https://accounts.acme.com' };
const forest = resolveDesign({ preset: 'forest', typography: { font: 'system' } });

describe('widgetDesign', () => {
  it('is null without a dashboard design or inline preset/design (legacy theming unchanged)', () => {
    expect(widgetDesign(null, { variables: { colorPrimary: '#ff0000' } })).toBeNull();
  });

  it('translates a design into widget tokens, interaction and social config', () => {
    const d = widgetDesign({ resolved: forest }, {
      design: { buttons: { style: 'outline', socialLayout: 'icons' }, inputs: { style: 'filled' }, spacing: { density: 'compact' } },
    })!;
    expect(d.tokens.colorPrimary).toBe(forest.palette.primary);
    expect(d.tokens.colorCard).toBe(forest.palette.surface);
    expect(d.interaction).toMatchObject({ buttonStyle: 'outline', inputStyle: 'filled', density: 'compact' });
    expect(d.socialButtons).toMatchObject({ variant: 'icon' });
    expect(d.render.attributes['data-atlas-design']).toBe(d.render.key);
    expect(d.render.attributes['data-atlas-button']).toBe('outline');
  });

  it('uses the dark palette for a dark (or auto + OS-dark) design', () => {
    const d = widgetDesign({ resolved: forest }, undefined, { prefersDark: true })!;
    expect(d.tokens.colorCard).toBe(forest.paletteDark.surface);
  });

  it('lets inline variables win', () => {
    const d = widgetDesign({ resolved: forest }, { variables: { colorPrimary: 'rebeccapurple' } })!;
    expect(d.tokens.colorPrimary).toBe('rebeccapurple');
  });
});

describe('<atlas-sign-in> with the design system', () => {
  it('without a design, themes exactly as before', async () => {
    const root = document.createElement('div');
    await new AtlasWidget(root, { ...OPTS, fetchImpl: fetchWith(envelope()) }).mount();
    expect(root.style.getPropertyValue('--atlas-embed-color-primary')).toBe('#5b5bd6');
    expect(root.hasAttribute('data-atlas-design')).toBe(false);
  });

  it('design: null from the server themes exactly as before', async () => {
    const root = document.createElement('div');
    await new AtlasWidget(root, { ...OPTS, fetchImpl: fetchWith(envelope({ design: null })) }).mount();
    expect(root.style.getPropertyValue('--atlas-embed-color-primary')).toBe('#5b5bd6');
    expect(root.hasAttribute('data-atlas-design')).toBe(false);
  });

  it('applies the dashboard design from /v1/appearance', async () => {
    const root = document.createElement('div');
    await new AtlasWidget(root, { ...OPTS, fetchImpl: fetchWith(envelope({ design: { resolved: forest } })) }).mount();
    expect(root.style.getPropertyValue('--atlas-embed-color-primary')).toBe(forest.palette.primary);
    const key = root.getAttribute('data-atlas-design');
    expect(key).toBeTruthy();
    expect(root.getAttribute('data-atlas-card')).toBe(forest.card.style);
  });

  it('inline preset/design override the dashboard design', async () => {
    const root = document.createElement('div');
    await new AtlasWidget(root, {
      ...OPTS,
      appearance: { preset: 'midnight', design: { typography: { font: 'system' }, palette: { primary: '#ff0000' } } },
      fetchImpl: fetchWith(envelope({ design: { resolved: forest } })),
    }).mount();
    expect(root.style.getPropertyValue('--atlas-embed-color-primary')).toBe('#ff0000');
    expect(root.getAttribute('data-atlas-card')).toBe(resolveDesign({ preset: 'midnight' }).card.style);
  });

  it('reads data-atlas-preset from the element', () => {
    const el = document.createElement('atlas-sign-in');
    el.setAttribute('data-atlas-key', 'pk_test_1');
    el.setAttribute('data-atlas-fapi', 'https://accounts.acme.com');
    el.setAttribute('data-atlas-preset', 'glass');
    expect(optionsFromElement(el, 'sign-in')?.appearance?.preset).toBe('glass');
  });
});
