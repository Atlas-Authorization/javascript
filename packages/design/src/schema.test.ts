import { describe, expect, it } from 'vitest';
import { applyDesignPatch, mergePatch } from './patch';
import { validateDesign, validateDesignPatch, type AtlasDesign } from './schema';

const ASSET = 'dasset_01J8ZW3K9M0000000000000000';

const paths = (r: ReturnType<typeof validateDesign>) => (r.ok ? [] : r.problems.map((p) => p.path));

describe('designSchema', () => {
  it('accepts an empty design and a fully specified one', () => {
    expect(validateDesign({}).ok).toBe(true);
    const full: AtlasDesign = {
      version: 1,
      preset: 'glass',
      colorScheme: 'dark',
      palette: { primary: '#112233', primaryInk: '#FFFFFF', accent: '#abcdef', background: '#000000', surface: '#111111', text: '#eeeeee', muted: '#999999', border: '#333333', danger: '#ff0000', success: '#00ff00', inputBackground: '#000000', inputText: '#ffffff' },
      paletteDark: { primary: '#445566' },
      typography: { font: 'inter', headingFont: 'playfair-display', baseSize: 16, headingWeight: 700, bodyWeight: 400, letterCase: 'uppercase', scale: 'golden' },
      shape: { radius: 32, controlRadius: 999, borderWidth: 3 },
      elevation: { cardShadow: 'xl' },
      spacing: { density: 'spacious' },
      card: { style: 'glass', blur: 40, width: 'wide' },
      layout: { position: 'split', splitImageSide: 'right', logoPlacement: 'hidden', logoSize: 'lg' },
      buttons: { style: 'gradient', socialLayout: 'icons' },
      inputs: { style: 'underline' },
      background: {
        color: '#101010',
        gradient: { type: 'linear', angle: 360, stops: [{ color: '#000000', at: 0 }, { color: '#ffffff', at: 100 }] },
        image: { assetId: ASSET, fit: 'contain', position: 'bottom-right', overlay: { color: '#000000', opacity: 0.5 }, blur: 20 },
        pattern: 'noise',
      },
      backgroundDark: { pattern: 'grid' },
      logo: { assetId: ASSET, darkAssetId: ASSET },
    };
    const r = validateDesign(full);
    expect(r).toEqual({ ok: true, value: full });
  });

  it('refuses unknown keys with their full path, at every depth', () => {
    expect(paths(validateDesign({ customCss: 'body{}' }))).toEqual(['customCss']);
    expect(paths(validateDesign({ typography: { fnt: 'inter' } }))).toEqual(['typography.fnt']);
    expect(paths(validateDesign({ background: { image: { assetId: ASSET, url: 'https://x' } } }))).toEqual([
      'background.image.url',
    ]);
    expect(
      paths(validateDesign({ background: { gradient: { type: 'linear', stops: [{ color: '#000000', at: 0, x: 1 }, { color: '#ffffff', at: 1 }] } } })),
    ).toEqual(['background.gradient.stops.0.x']);
  });

  it('has no raw CSS/HTML/URL field anywhere', () => {
    for (const k of ['customCss', 'customHtmlHeader', 'customHtmlFooter', 'css', 'html', 'fontUrl', 'imageUrl', 'logoUrl']) {
      expect(validateDesign({ [k]: 'x' }).ok).toBe(false);
    }
  });

  it('enforces strict #RRGGBB colours', () => {
    for (const bad of ['#fff', '#ffffffff', 'red', 'rgb(0,0,0)', '#gggggg', '#ffffff;}', ' #ffffff', '#ffffff\n']) {
      expect(validateDesign({ palette: { primary: bad } }).ok, bad).toBe(false);
    }
    expect(validateDesign({ palette: { primary: '#A1b2C3' } }).ok).toBe(true);
  });

  it('enforces numeric bounds and steps', () => {
    const bad: AtlasDesign[] = [
      { typography: { baseSize: 11 } },
      { typography: { baseSize: 21 } },
      { typography: { baseSize: 15.5 } },
      { typography: { headingWeight: 450 } },
      { typography: { headingWeight: 900 } },
      { typography: { bodyWeight: 200 } },
      { shape: { radius: 33 } },
      { shape: { radius: -1 } },
      { shape: { controlRadius: 1000 } },
      { shape: { borderWidth: 4 } },
      { card: { blur: 41 } },
      { background: { image: { assetId: ASSET, blur: 21 } } },
      { background: { image: { assetId: ASSET, overlay: { color: '#000000', opacity: 1.1 } } } },
      { background: { gradient: { type: 'linear', angle: 361, stops: [{ color: '#000000', at: 0 }, { color: '#ffffff', at: 100 }] } } },
      { background: { gradient: { type: 'linear', stops: [{ color: '#000000', at: 0 }] } } },
      { background: { gradient: { type: 'linear', stops: Array(5).fill({ color: '#000000', at: 0 }) } } },
      { background: { gradient: { type: 'linear', stops: [{ color: '#000000', at: -1 }, { color: '#ffffff', at: 100 }] } } },
    ];
    for (const d of bad) expect(validateDesign(d).ok, JSON.stringify(d)).toBe(false);
    for (const n of [NaN, Infinity, 1e308]) {
      expect(validateDesign({ typography: { baseSize: n } }).ok).toBe(false);
    }
  });

  it('accepts only catalog fonts, listed presets, enums and asset ids', () => {
    expect(validateDesign({ typography: { font: 'comic-sans' } }).ok).toBe(false);
    expect(validateDesign({ typography: { font: "Inter'; } body {" } }).ok).toBe(false);
    expect(validateDesign({ preset: 'nope' }).ok).toBe(false);
    expect(validateDesign({ card: { style: 'neon' } }).ok).toBe(false);
    expect(validateDesign({ background: { image: { assetId: 'https://evil.example/x.png' } } }).ok).toBe(false);
    expect(validateDesign({ background: { image: { assetId: 'dasset_../../etc' } } }).ok).toBe(false);
    expect(validateDesign({ background: { pattern: 'stripes' } }).ok).toBe(false);
  });

  it('refuses a non-object design', () => {
    for (const v of [null, 'x', 1, []]) expect(validateDesign(v).ok).toBe(false);
  });
});

describe('design patches', () => {
  const base: AtlasDesign = {
    preset: 'glass',
    palette: { primary: '#112233', accent: '#445566' },
    typography: { font: 'inter', baseSize: 16 },
    background: { gradient: { type: 'linear', stops: [{ color: '#000000', at: 0 }, { color: '#ffffff', at: 100 }] } },
  };

  it('merges nested objects and replaces scalars', () => {
    const r = applyDesignPatch(base, { palette: { primary: '#000000' }, shape: { radius: 4 } });
    expect(r.ok && r.value).toEqual({
      ...base,
      palette: { primary: '#000000', accent: '#445566' },
      shape: { radius: 4 },
    });
  });

  it('deletes on null, prunes emptied sections', () => {
    const r = applyDesignPatch(base, { palette: { primary: null, accent: null }, typography: { baseSize: null }, preset: null });
    expect(r.ok && r.value).toEqual({ typography: { font: 'inter' }, background: base.background });
  });

  it('replaces arrays wholesale', () => {
    const r = applyDesignPatch(base, {
      background: { gradient: { stops: [{ color: '#111111', at: 10 }, { color: '#222222', at: 20 }, { color: '#333333', at: 30 }] } },
    });
    expect(r.ok && r.value.background?.gradient?.stops).toHaveLength(3);
    expect(r.ok && r.value.background?.gradient?.type).toBe('linear');
  });

  it('re-validates the merged result', () => {
    // A gradient patch with no type onto a design that has no gradient is incomplete.
    const r = applyDesignPatch({}, { background: { gradient: { angle: 90 } } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.map((p) => p.path)).toContain('background.gradient.type');
  });

  it('refuses unknown keys and bad values in a patch, with paths', () => {
    const r = validateDesignPatch({ card: { colour: '#000000' }, shape: { radius: 99 } });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.map((p) => p.path).sort()).toEqual(['card.colour', 'shape.radius']);
  });

  it('refuses null inside arrays', () => {
    expect(validateDesignPatch({ background: { gradient: { type: 'linear', stops: [null, null] } } }).ok).toBe(false);
  });

  it('never pollutes prototypes', () => {
    const evil = JSON.parse('{"__proto__":{"polluted":true},"palette":{"__proto__":{"x":1}}}');
    expect(validateDesignPatch(evil).ok).toBe(false);
    const merged = mergePatch({}, evil);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(merged, '__proto__')).toBe(false);
  });
});
