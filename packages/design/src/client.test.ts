import { describe, expect, it, vi } from 'vitest';
import { cleanDesign, composeDesign, designFromTokens, fontIdForFamily } from './client';
import { instanceDesignFrom } from './render';
import { DESIGN_DEFAULTS } from './presets';
import { layerDesign, resolveDesign } from './resolve';

describe('cleanDesign', () => {
  it('keeps valid leaves and drops invalid ones with a path warning', () => {
    const warn = vi.fn();
    const out = cleanDesign(
      { palette: { primary: '#112233', text: 'red; } body { x' }, card: { style: 'glass' }, bogus: 1 },
      warn,
    );
    expect(out).toEqual({ palette: { primary: '#112233' }, card: { style: 'glass' } });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('design.palette.text'));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('design.bogus'));
  });

  it('never merges prototype keys', () => {
    const out = cleanDesign(JSON.parse('{"__proto__":{"x":1},"shape":{"radius":4}}'), () => {});
    expect(out).toEqual({ shape: { radius: 4 } });
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });
});

describe('designFromTokens', () => {
  it('maps legacy tokens onto both palettes, shape, density and curated fonts', () => {
    const { design, rawVariables } = designFromTokens({
      colorPrimary: '#0F766E',
      colorText: 'rgb(10, 20, 30)',
      colorBackground: '#fff',
      borderRadius: '0.75rem',
      spacingUnit: '3px',
      fontFamily: '"Inter", sans-serif',
    });
    expect(design.palette).toMatchObject({ primary: '#0f766e', text: '#0a141e', inputText: '#0a141e', surface: '#ffffff', inputBackground: '#ffffff' });
    expect(design.paletteDark).toEqual(design.palette);
    expect(design.shape).toEqual({ radius: 12, controlRadius: 12 });
    expect(design.spacing).toEqual({ density: 'compact' });
    expect(design.typography).toEqual({ font: 'inter' });
    expect(rawVariables).toEqual({});
  });

  it('keeps unmappable tokens as raw legacy variables, refusing unsafe text', () => {
    const warn = vi.fn();
    const { design, rawVariables } = designFromTokens(
      { colorPrimary: 'var(--brand)', fontFamily: 'Comic Sans MS, cursive', colorText: 'red;}body{x:y' },
      warn,
    );
    expect(design).toEqual({});
    expect(rawVariables).toEqual({ '--atlas-color-primary': 'var(--brand)', '--atlas-font-family': 'Comic Sans MS, cursive' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('colorText'));
  });

  it('finds curated fonts by family or id', () => {
    expect(fontIdForFamily("'Playfair Display', serif")).toBe('playfair-display');
    expect(fontIdForFamily('jetbrains-mono')).toBe('jetbrains-mono');
    expect(fontIdForFamily('Wingdings')).toBeUndefined();
  });
});

describe('layerDesign', () => {
  it('is the identity on a resolved design with no overrides', () => {
    const r = resolveDesign({ preset: 'grape', palette: { primary: '#123456' } });
    expect(layerDesign(r, {})).toEqual(r);
  });

  it('applies overrides with the resolver rules (brand carries to dark, ink recomputed)', () => {
    const r = layerDesign(DESIGN_DEFAULTS, { palette: { primary: '#ffeb3b' } });
    expect(r.palette.primary).toBe('#ffeb3b');
    expect(r.paletteDark.primary).toBe('#ffeb3b');
    expect(r.palette.primaryInk).not.toBe(DESIGN_DEFAULTS.palette.primaryInk);
  });
});

describe('instanceDesignFrom', () => {
  it('treats design: null and a missing key as "no dashboard design"', () => {
    expect(instanceDesignFrom({ object: 'appearance', design: null })).toBeNull();
    expect(instanceDesignFrom({ object: 'appearance', appearance: {} })).toBeNull();
    expect(instanceDesignFrom({ design: null, appearance: { design: null } })).toBeNull();
    expect(instanceDesignFrom({ design: {} })).toBeNull();
    expect(composeDesign({ instance: instanceDesignFrom({ design: null }) }).active).toBe(false);
  });
});

describe('composeDesign', () => {
  const instance = { scope: '.atlas-root', css: 'ignored', resolved: resolveDesign({ preset: 'forest' }) };

  it('is inactive with no instance design and no preset/design (tokens alone keep legacy behaviour)', () => {
    expect(composeDesign({ tokens: { colorPrimary: '#000000' } }).active).toBe(false);
    expect(composeDesign({ instance: null }).active).toBe(false);
  });

  it('applies the instance design, scoped by a stable key', () => {
    const c = composeDesign({ instance, frontendApi: 'https://auth.acme.com' });
    expect(c.active).toBe(true);
    expect(c.scope).toBe(`.atlas-root[data-atlas-design="${c.key}"]`);
    expect(c.css).toContain(`${c.scope}{`);
    expect(c.css).toContain(`--atlas-color-primary:${instance.resolved.palette.primary}`);
    expect(c.dataAttributes['data-atlas-design']).toBe(c.key);
    expect(composeDesign({ instance }).key).toBe(c.key);
    // The server's CSS text is never injected as-is.
    expect(c.css).not.toContain('ignored');
  });

  it('code overrides win over the instance; preset replaces the base', () => {
    const c = composeDesign({ instance, design: { palette: { primary: '#ff0000' } } });
    expect(c.resolved!.palette.primary).toBe('#ff0000');
    expect(c.resolved!.preset).toBe('forest');
    const p = composeDesign({ instance, preset: 'midnight' });
    expect(p.resolved!.preset).toBe('midnight');
    // design > tokens
    const t = composeDesign({ instance, tokens: { colorPrimary: '#00ff00' }, design: { palette: { primary: '#0000ff' } } });
    expect(t.resolved!.palette.primary).toBe('#0000ff');
    const t2 = composeDesign({ instance, tokens: { colorPrimary: '#00ff00' } });
    expect(t2.resolved!.palette.primary).toBe('#00ff00');
  });

  it('drops invalid code values and an unknown preset with warnings', () => {
    const warn = vi.fn();
    const c = composeDesign({ preset: 'nope', design: { palette: { primary: 'url(javascript:alert(1))' } }, warn });
    expect(c.active).toBe(false);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('links self-hosted font sheets on the Frontend API origin only', () => {
    const c = composeDesign({ design: { typography: { font: 'inter' } }, frontendApi: 'https://auth.acme.com/' });
    expect(c.fontStylesheets).toEqual(['https://auth.acme.com/v1/design/fonts/inter.css']);
    expect(composeDesign({ design: { typography: { font: 'inter' } }, frontendApi: '' }).fontStylesheets).toEqual([
      '/v1/design/fonts/inter.css',
    ]);
    expect(composeDesign({ design: { typography: { font: 'inter' } }, frontendApi: 'javascript:x' }).fontStylesheets).toEqual([]);
  });

  it('tolerates a tampered instance payload', () => {
    const bad = { resolved: { ...DESIGN_DEFAULTS, palette: { ...DESIGN_DEFAULTS.palette, primary: 'red}*{x:y' } } };
    const c = composeDesign({ instance: bad });
    expect(c.css).not.toContain('red}');
    expect(c.resolved!.palette.primary).toMatch(/^#[0-9a-f]{6}$/i);
  });
});
