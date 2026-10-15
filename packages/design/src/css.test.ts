import { describe, expect, it } from 'vitest';
// Runs against the zod-free runtime entry: what the embed widget ships.
import {
  DESIGN_CSS_VARIABLES,
  DESIGN_CSS_VARIABLE_NAMES,
  FONT_CATALOG,
  PRESET_IDS,
  compileDesignCss,
  contrastRatio,
  focusRingColor,
  designDataAttributes,
  designFontSheets,
  fontStack,
  googleFontSheetUrl,
  isWebFont,
  resolveDesign,
  safeAssetUrl,
  type ResolvedDesign,
} from './runtime';

const ASSET = 'dasset_01J8ZW3K9M0000000000000000';
const assetUrl = (id: string) => `https://api.atlasauth.net/v1/assets/design/${id}.webp`;

/** Every `--name:value;` declaration in the output. */
function decls(css: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of css.matchAll(/(--atlas-[a-z0-9-]+):([^;]*);/g)) {
    out.set(m[1]!, [...(out.get(m[1]!) ?? []), m[2]!]);
  }
  return out;
}

/** Structural check: the stylesheet consists ONLY of our selectors wrapping custom properties. */
function assertOnlyCustomProperties(css: string, scope: string) {
  const esc = scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rule = `${esc}(?:\\[data-atlas-theme="(?:light|dark)"\\]|:not\\(\\[data-atlas-theme="light"\\]\\))?\\{(?:--atlas-[a-z0-9-]+:[^;{}<>\\\\]*;)*\\}`;
  const line = new RegExp(`^(?:${rule}|@media \\(prefers-color-scheme:dark\\)\\{${rule}\\})$`);
  for (const l of css.split('\n')) expect(l, l).toMatch(line);
}

const SAFE = /[<>\\]|@import|expression\s*\(|javascript:|\/\*/i;

describe('compileDesignCss', () => {
  it.each(PRESET_IDS)('preset %s compiles to custom properties only', (id) => {
    const css = compileDesignCss(resolveDesign({ preset: id }), { scope: ':root', assetUrl });
    assertOnlyCustomProperties(css, ':root');
    expect(css).not.toMatch(SAFE);
    for (const name of decls(css).keys()) expect(DESIGN_CSS_VARIABLE_NAMES.has(name), name).toBe(true);
  });

  it('emits every documented variable for a full design', () => {
    const d = resolveDesign({
      preset: 'glass',
      background: { image: { assetId: ASSET, overlay: { color: '#000000', opacity: 0.4 } } },
    });
    const v = decls(compileDesignCss(d, { scope: '.atlas', assetUrl }));
    for (const def of DESIGN_CSS_VARIABLES) expect(v.has(def.name), def.name).toBe(true);
  });

  it('emits a solid focus outline with 3:1 on the background and surface', () => {
    const v = decls(
      compileDesignCss(resolveDesign({ palette: { primary: '#22f79a', background: '#ffffff', surface: '#f8fafc' } }), {
        scope: ':root',
      }),
    );
    const ring = v.get('--atlas-focus-outline-color')?.[0];
    expect(ring).toBeDefined();
    expect(ring).not.toBe('#22f79a');
    expect(contrastRatio(ring!, '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(ring!, '#f8fafc')).toBeGreaterThanOrEqual(3);
    // A primary that already passes is the outline as-is.
    const dflt = decls(compileDesignCss(resolveDesign({ palette: { primary: '#4338ca', background: '#ffffff', surface: '#ffffff' } }), { scope: ':root' }));
    expect(dflt.get('--atlas-focus-outline-color')?.[0]).toBe('#4338ca');
  });

  it('focusRingColor keeps the hue and reaches 3:1 either way', () => {
    expect(contrastRatio(focusRingColor('#22f79a', ['#ffffff']), '#ffffff')).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(focusRingColor('#1e3a8a', ['#0b0b0f']), '#0b0b0f')).toBeGreaterThanOrEqual(3);
    expect(focusRingColor('#5b5bd6', ['#ffffff'])).toBe('#5b5bd6');
  });

  it('compiler names and documented variables are the same set', () => {
    expect([...DESIGN_CSS_VARIABLE_NAMES].sort()).toEqual(DESIGN_CSS_VARIABLES.map((v) => v.name).sort());
  });

  it('documents each variable once with a type and description', () => {
    const names = DESIGN_CSS_VARIABLES.map((v) => v.name);
    expect(new Set(names).size).toBe(names.length);
    for (const v of DESIGN_CSS_VARIABLES) {
      expect(v.name).toMatch(/^--atlas-[a-z0-9-]+$/);
      expect(v.description.length).toBeGreaterThan(5);
    }
  });

  it('auto: light by default, dark under prefers-color-scheme and the attribute', () => {
    const css = compileDesignCss(resolveDesign({}), { scope: ':root' });
    const lines = css.split('\n');
    expect(lines[0]).toContain('--atlas-color-background:#fafafa;');
    expect(lines[2]!.startsWith(':root[data-atlas-theme="dark"]{')).toBe(true);
    expect(lines[2]).toContain('--atlas-color-background:#09090b;');
    expect(lines[3]!.startsWith('@media (prefers-color-scheme:dark){:root:not([data-atlas-theme="light"]){')).toBe(true);
    expect(designDataAttributes(resolveDesign({}))['data-atlas-theme']).toBeUndefined();
  });

  it('forced dark: dark vars are the default and no media query is emitted', () => {
    const d = resolveDesign({ preset: 'midnight' });
    const css = compileDesignCss(d, { scope: ':root' });
    expect(css.split('\n')[0]).toContain('--atlas-color-background:#0b1020;');
    expect(css).not.toContain('@media');
    expect(designDataAttributes(d)['data-atlas-theme']).toBe('dark');
  });

  it('builds gradient, image, overlay and derived values from validated parts', () => {
    const d = resolveDesign({
      background: {
        gradient: { type: 'linear', angle: 90, stops: [{ color: '#FF0000', at: 0 }, { color: '#0000ff', at: 100 }] },
        image: { assetId: ASSET, fit: 'contain', position: 'top-right', overlay: { color: '#000000', opacity: 0.5 }, blur: 4 },
      },
      card: { style: 'glass', blur: 24 },
      shape: { controlRadius: 999 },
      typography: { letterCase: 'uppercase', baseSize: 16, scale: 'octave' },
    });
    const v = decls(compileDesignCss(d, { scope: ':root', assetUrl }));
    expect(v.get('--atlas-bg-gradient')![0]).toBe('linear-gradient(90deg, #ff0000 0%, #0000ff 100%)');
    expect(v.get('--atlas-bg-image')![0]).toBe(`url("${assetUrl(ASSET)}")`);
    expect(v.get('--atlas-bg-size')![0]).toBe('contain');
    expect(v.get('--atlas-bg-position')![0]).toBe('right top');
    expect(v.get('--atlas-bg-overlay')![0]).toBe('rgb(0 0 0 / 0.5)');
    expect(v.get('--atlas-bg-blur')![0]).toBe('4px');
    expect(v.get('--atlas-card-blur')![0]).toBe('24px');
    expect(v.get('--atlas-card-background')![0]).toBe('rgb(255 255 255 / 0.72)');
    expect(v.get('--atlas-radius-control')![0]).toBe('999px');
    expect(v.get('--atlas-button-text-transform')![0]).toBe('uppercase');
    expect(v.get('--atlas-font-size-title')![0]).toBe('32px');
    // the image carries into dark mode too
    expect(v.get('--atlas-bg-image')!.every((x) => x.startsWith('url('))).toBe(true);
  });

  it('applies blur only to glass cards and drops shadow for outline/none', () => {
    const solid = decls(compileDesignCss(resolveDesign({ card: { style: 'solid', blur: 30 } }), { scope: ':root' }));
    expect(solid.get('--atlas-card-blur')![0]).toBe('0px');
    const outline = decls(compileDesignCss(resolveDesign({ card: { style: 'outline' }, shape: { borderWidth: 0 } }), { scope: ':root' }));
    expect(outline.get('--atlas-shadow-card')![0]).toBe('none');
    expect(outline.get('--atlas-card-border-width')![0]).toBe('1px');
    const none = decls(compileDesignCss(resolveDesign({ card: { style: 'none' } }), { scope: ':root' }));
    expect(none.get('--atlas-card-background')![0]).toBe('transparent');
    expect(none.get('--atlas-card-border-width')![0]).toBe('0px');
  });

  it('without assetUrl, images compile to none', () => {
    const d = resolveDesign({ background: { image: { assetId: ASSET } } });
    expect(decls(compileDesignCss(d, { scope: ':root' })).get('--atlas-bg-image')![0]).toBe('none');
  });

  it('refuses unsafe scopes', () => {
    const d = resolveDesign({});
    for (const scope of ['', '</style><script>', 'a{}', 'a;b', 'a,b', 'a > b', '@import', '\\3c', 'x'.repeat(201)]) {
      expect(() => compileDesignCss(d, { scope }), scope).toThrow();
    }
    expect(() => compileDesignCss(d, { scope: '.atlas-root[data-x="1"]' })).not.toThrow();
  });
});

describe('compileDesignCss — injection attempts on a tampered resolved design', () => {
  const PAYLOADS = [
    '</style><script>alert(1)</script>',
    '#ffffff;}body{background:red',
    ';}body{',
    'url(javascript:alert(1))',
    'expression(alert(1))',
    '@import url(https://evil.example/x.css)',
    '\\3c /style\\3e',
    '#ff\\000000',
    '#ffffff\n}',
    'red',
    'rgb(0,0,0)',
    '/* */',
  ];
  const NUMS = [NaN, Infinity, -Infinity, 1e308, -1e308, '12px;}' as unknown as number, '1e3' as unknown as number];

  /** Put `value` into EVERY leaf of a resolved design. */
  function poison(value: unknown): ResolvedDesign {
    const d = resolveDesign({ background: { image: { assetId: ASSET, overlay: { color: '#000000', opacity: 0.5 } } } });
    const walk = (o: Record<string, unknown>) => {
      for (const k of Object.keys(o)) {
        const v = o[k];
        if (Array.isArray(v)) v.forEach((x) => typeof x === 'object' && x && walk(x as Record<string, unknown>));
        else if (v && typeof v === 'object') walk(v as Record<string, unknown>);
        else o[k] = value;
      }
    };
    walk(d as unknown as Record<string, unknown>);
    return d;
  }

  it.each([...PAYLOADS, ...NUMS])('payload %s never reaches the stylesheet', (payload) => {
    const evilUrl = () => String(payload);
    for (const opts of [{ scope: ':root', assetUrl }, { scope: ':root', assetUrl: evilUrl }]) {
      const css = compileDesignCss(poison(payload), opts);
      expect(css).not.toMatch(SAFE);
      assertOnlyCustomProperties(css, ':root');
      if (typeof payload === 'string') expect(css).not.toContain(payload);
    }
  });

  it('drops a tampered colour instead of emitting it, and keeps the rest', () => {
    const d = resolveDesign({});
    (d.palette as Record<string, string>).primary = '#000000;}body{x:y';
    const v = decls(compileDesignCss(d, { scope: ':root' }));
    expect(v.get('--atlas-color-primary')).toEqual(['#fafafa', '#fafafa']); // only the dark blocks remain
    expect(v.get('--atlas-color-text')).toBeDefined();
  });

  it('clamps out-of-range numbers', () => {
    const d = resolveDesign({});
    d.shape.radius = 10_000;
    d.typography.baseSize = 400;
    d.card.style = 'glass';
    d.card.blur = 9999;
    const v = decls(compileDesignCss(d, { scope: ':root' }));
    expect(v.get('--atlas-radius-card')![0]).toBe('32px');
    expect(v.get('--atlas-font-size-base')![0]).toBe('20px');
    expect(v.get('--atlas-card-blur')![0]).toBe('40px');
  });

  it('builds image URLs only from valid asset ids, and only safe URLs', () => {
    expect(safeAssetUrl(assetUrl, ASSET)).toBe(assetUrl(ASSET));
    expect(safeAssetUrl(assetUrl, 'https://evil.example/a.png')).toBeUndefined();
    expect(safeAssetUrl(() => 'javascript:alert(1)', ASSET)).toBeUndefined();
    expect(safeAssetUrl(() => 'https://x.example/a.png")', ASSET)).toBeUndefined();
    expect(safeAssetUrl(() => 'https://x.example/a b.png', ASSET)).toBeUndefined();
    expect(safeAssetUrl(() => '//evil.example/a.png', ASSET)).toBeUndefined();
    expect(safeAssetUrl(() => 'http://evil.example/a.png', ASSET)).toBeUndefined();
    expect(safeAssetUrl(() => 'data:image/svg+xml,<svg>', ASSET)).toBeUndefined();
    expect(safeAssetUrl(() => { throw new Error('x'); }, ASSET)).toBeUndefined();
    expect(safeAssetUrl(() => '/v1/assets/design/a.webp', ASSET)).toBe('/v1/assets/design/a.webp');
    expect(safeAssetUrl(() => 'http://localhost:3000/v1/assets/a.webp', ASSET)).toBe('http://localhost:3000/v1/assets/a.webp');
  });

  it('uses only catalog fonts', () => {
    const d = resolveDesign({});
    d.typography.font = "x'; } body { color: red";
    d.typography.headingFont = 'comic-sans';
    const v = decls(compileDesignCss(d, { scope: ':root' }));
    expect(v.get('--atlas-font-body')![0]).toBe(fontStack('system'));
    expect(v.get('--atlas-font-heading')![0]).toBe(fontStack('system'));
  });
});

describe('designDataAttributes', () => {
  it('maps enums to data attributes', () => {
    const a = designDataAttributes(
      resolveDesign({ preset: 'split-photo', card: { style: 'glass' }, buttons: { socialLayout: 'icons' } }),
    );
    expect(a).toMatchObject({
      'data-atlas-layout': 'split',
      'data-atlas-split-side': 'left',
      'data-atlas-card': 'glass',
      'data-atlas-logo': 'page',
      'data-atlas-social': 'icons',
    });
  });

  it('allowlists every value', () => {
    const d = resolveDesign({});
    (d.layout as unknown as Record<string, string>).position = '"><script>';
    (d.card as unknown as Record<string, string>).style = 'x" onload="y';
    (d as unknown as Record<string, unknown>).colorScheme = 'evil';
    const a = designDataAttributes(d);
    expect(a['data-atlas-layout']).toBe('center');
    expect(a['data-atlas-card']).toBe('solid');
    expect(a['data-atlas-theme']).toBeUndefined();
    for (const [k, v] of Object.entries(a)) {
      expect(k).toMatch(/^data-atlas-[a-z-]+$/);
      expect(v).toMatch(/^[a-z-]+$/);
    }
  });
});

describe('fonts', () => {
  it('has a curated, CSS-safe catalog', () => {
    expect(FONT_CATALOG.length).toBeGreaterThanOrEqual(16);
    for (const f of FONT_CATALOG) {
      expect(f.id).toMatch(/^[a-z0-9-]+$/);
      expect(fontStack(f.id)).not.toMatch(/[;{}<>\\"]/);
      if (f.google) {
        expect(f.google).toMatch(/^[A-Za-z0-9+]+:wght@[0-9;]+$/);
        expect(googleFontSheetUrl(f.id)).toMatch(/^https:\/\/fonts\.googleapis\.com\/css2\?family=/);
      }
    }
  });

  it('never builds a sheet URL for an unknown or system font', () => {
    expect(googleFontSheetUrl('system')).toBeNull();
    expect(googleFontSheetUrl('evil&family=x')).toBeNull();
    expect(googleFontSheetUrl(undefined)).toBeNull();
    expect(isWebFont('inter')).toBe(true);
    expect(isWebFont('system-mono')).toBe(false);
  });

  it('lists the mirrored sheets a design needs', () => {
    expect(designFontSheets(resolveDesign({ preset: 'editorial' }))).toEqual([
      '/v1/design/fonts/source-serif.css',
      '/v1/design/fonts/playfair-display.css',
    ]);
    expect(designFontSheets(resolveDesign({ preset: 'atlas' }))).toEqual([]);
  });
});
