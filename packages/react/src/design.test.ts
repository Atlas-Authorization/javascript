import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { designKey, resolveDesign } from '@atlasauth/design';
import { describe, expect, it, vi } from 'vitest';
import {
  ELEMENT_KEYS,
  THEMES,
  classFor,
  cssVariables,
  explicitTokens,
  instanceDesignFrom,
  renderAppearance,
  resolveTokens,
  type Appearance,
  type InstanceDesign,
} from './appearance';
import { ATLAS_BASE_CSS, ATLAS_DESIGN_CSS, ATLAS_STYLES_CSS } from './styles';

const instance: InstanceDesign = {
  scope: '.atlas-root',
  css: '.atlas-root{--atlas-color-primary:#000000;}',
  data_attributes: {},
  font_stylesheets: [],
  resolved: resolveDesign({ preset: 'forest', typography: { font: 'inter' } }),
};

describe('backward compatibility (no design anywhere)', () => {
  const cases: (Appearance | undefined)[] = [
    undefined,
    {},
    { baseTheme: 'dark' },
    { baseTheme: 'neobrutalist', variables: { colorPrimary: '#ff0000', fontFamily: 'Comic Sans MS' } },
    { variables: { borderRadius: '2px', spacingUnit: '6px' }, elements: { card: 'my-card' } },
  ];

  it.each(cases.map((c) => [JSON.stringify(c), c]))('%s renders the same variables as before', (_name, appearance) => {
    const out = renderAppearance(appearance, null);
    expect(out.style).toEqual(cssVariables(resolveTokens(appearance)));
    expect(out.attributes).toEqual({});
    expect(out.css).toBe('');
    expect(out.fontStylesheets).toEqual([]);
  });

  it('keeps the element class contract (ours first, theirs appended)', () => {
    expect(classFor('card', { elements: { card: 'x' } }, 'atlas-card')).toBe('atlas-card x');
    expect(classFor('card', undefined, 'atlas-card')).toBe('atlas-card');
  });

  it('leaves the base stylesheet byte-identical to the pre-design-system release', () => {
    // FNV-1a of ATLAS_BASE_CSS as shipped in @atlasauth/react 0.3.1.
    expect(designKey(ATLAS_BASE_CSS)).toBe(BASE_CSS_HASH);
  });

  it('gates every design rule on a design attribute of the root', () => {
    const rules = ATLAS_DESIGN_CSS.split('\n').filter((l) => l.trim());
    for (const rule of rules) {
      for (const selector of rule.slice(0, rule.indexOf('{')).split(/,(?![^(]*\))/)) {
        expect(selector, rule).toMatch(/^(:where\(\.atlas-root\[data-atlas-[a-z-]+(="[a-z]+")?\]\) |\.atlas-root\[data-atlas-design\])/);
      }
    }
    expect(ATLAS_STYLES_CSS.startsWith(ATLAS_BASE_CSS)).toBe(true);
  });
});

describe('the dashboard design', () => {
  it('is applied automatically: scoped stylesheet, root attributes, fonts on the FAPI origin', () => {
    const out = renderAppearance(undefined, instance, { frontendApi: 'https://auth.acme.com' });
    expect(out.attributes['data-atlas-design']).toBe(out.key);
    expect(out.attributes['data-atlas-card']).toBe(instance.resolved.card.style);
    expect(out.css).toContain(`.atlas-root[data-atlas-design="${out.key}"]{`);
    expect(out.css).toContain(`--atlas-color-primary:${instance.resolved.palette.primary}`);
    expect(out.fontStylesheets).toEqual(['https://auth.acme.com/v1/design/fonts/inter.css']);
    // No legacy token defaults inline: they would override the design's variables.
    expect(out.style).toEqual({});
  });

  it('is not injected as the server-sent CSS text', () => {
    const out = renderAppearance(undefined, { ...instance, css: '}</style><script>alert(1)</script>' });
    expect(out.css).not.toContain('script');
  });

  it('can be switched off', () => {
    const out = renderAppearance({ instanceDesign: false }, instance);
    expect(out.css).toBe('');
    expect(out.style).toEqual(cssVariables(resolveTokens(undefined)));
  });

  it('is read from the appearance response, tolerating absence', () => {
    expect(instanceDesignFrom({ design: instance })).toBe(instance);
    expect(instanceDesignFrom({ appearance: { design: instance } })).toBe(instance);
    expect(instanceDesignFrom({ appearance: {} })).toBeNull();
    expect(instanceDesignFrom({ design: null })).toBeNull();
    // design: null renders exactly the legacy output.
    expect(renderAppearance(undefined, instanceDesignFrom({ design: null }))).toEqual(renderAppearance(undefined, null));
    expect(instanceDesignFrom({ design: { css: 'x' } })).toBeNull();
    expect(instanceDesignFrom(null)).toBeNull();
  });
});

describe('code-level overrides win over the dashboard design', () => {
  it('appearance.design', () => {
    const out = renderAppearance({ design: { palette: { primary: '#ff0000' }, card: { style: 'glass' } } }, instance);
    expect(out.css).toContain('--atlas-color-primary:#ff0000');
    expect(out.attributes['data-atlas-card']).toBe('glass');
  });

  it('appearance.preset replaces the dashboard design as the base', () => {
    const out = renderAppearance({ preset: 'midnight' }, instance);
    expect(out.css).toContain(`--atlas-color-primary:${resolveDesign({ preset: 'midnight' }).palette.primary}`);
  });

  it('a preset works with no dashboard design at all (SSR-renderable)', () => {
    const out = renderAppearance({ preset: 'terminal' }, null);
    expect(out.css).not.toBe('');
    expect(out.attributes['data-atlas-design']).toBe(out.key);
  });

  it('legacy variables map onto the design; design beats variables', () => {
    const v = renderAppearance({ variables: { colorPrimary: '#00ff00', borderRadius: '4px' } }, instance);
    expect(v.css).toContain('--atlas-color-primary:#00ff00');
    expect(v.css).toContain('--atlas-radius-control:4px');
    const d = renderAppearance(
      { variables: { colorPrimary: '#00ff00' }, design: { palette: { primary: '#0000ff' } } },
      instance,
    );
    expect(d.css).toContain('--atlas-color-primary:#0000ff');
  });

  it('an unmappable token stays a raw inline variable (and still wins)', () => {
    const out = renderAppearance({ variables: { fontFamily: '"Brand Sans", sans-serif' } }, instance);
    expect(out.style).toEqual({ '--atlas-font-family': '"Brand Sans", sans-serif' });
  });

  it('only explicit tokens map (theme defaults never overwrite the dashboard)', () => {
    expect(explicitTokens({ baseTheme: 'default' })).toEqual({});
    expect(explicitTokens({ baseTheme: 'dark' }).colorBackground).toBe(THEMES.dark.colorBackground);
  });
});

describe('no CSS injection through props', () => {
  it('drops invalid design values with a dev warning; nothing reaches the stylesheet', () => {
    const warn = vi.fn();
    const evil = 'red;}body{display:none}';
    const out = renderAppearance(
      {
        preset: 'x</style>' as never,
        design: {
          palette: { primary: evil, accent: '#123456' },
          typography: { font: "x');@import url(evil" },
          shape: { radius: 9999 },
          nope: 1,
        } as never,
      },
      instance,
      { warn },
    );
    expect(out.css).not.toMatch(/display:none|@import|<\/style|9999/);
    expect(out.css).toContain('--atlas-color-accent:#123456');
    const messages = warn.mock.calls.map((c) => c[0]).join('\n');
    for (const path of ['appearance.preset', 'palette.primary', 'typography.font', 'shape.radius', 'design.nope']) {
      expect(messages).toContain(path);
    }
  });

  it('refuses an unsafe raw token', () => {
    const warn = vi.fn();
    const out = renderAppearance({ variables: { colorPrimary: 'var(--x);background:url(//evil)' } }, instance, { warn });
    expect(Object.values(out.style).join('')).not.toContain('url(');
    expect(warn).toHaveBeenCalled();
  });
});

describe('element keys', () => {
  it('every key a component passes to the class builders is a declared ElementKey', () => {
    const used = new Set<string>();
    for (const file of ['flow.tsx', 'account.tsx', 'organization.tsx', 'waitlist.tsx', 'billing.tsx', 'user-button.tsx', 'AtlasProvider.tsx']) {
      const src = readFileSync(join(__dirname, file), 'utf8');
      for (const m of src.matchAll(/(?:useClass|cls|classFor)\('([a-zA-Z]+)'/g)) used.add(m[1]!);
    }
    expect([...used].filter((k) => !(ELEMENT_KEYS as readonly string[]).includes(k))).toEqual([]);
    expect(used.size).toBeGreaterThan(25);
  });
});

const BASE_CSS_HASH = '1pre2y9';
