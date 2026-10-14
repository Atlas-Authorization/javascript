import { describe, expect, it } from 'vitest';
import { AA_TEXT, contrastRatio, readableInk, readableOn } from './contrast';
import { DESIGN_DEFAULTS, DESIGN_PRESETS, DESIGN_PRESET_LIST } from './presets';
import { resolveDesign } from './resolve';
import { PRESET_IDS, designSchema, validateDesign } from './schema';
import { designWarnings } from './warnings';

const ASSET = 'dasset_01J8ZW3K9M0000000000000000';

describe('presets', () => {
  it('has 12 presets, one per id, each a valid design', () => {
    expect(DESIGN_PRESET_LIST).toHaveLength(12);
    expect(Object.keys(DESIGN_PRESETS).sort()).toEqual([...PRESET_IDS].sort());
    for (const p of DESIGN_PRESET_LIST) {
      expect(designSchema.safeParse(p.design).success, p.id).toBe(true);
    }
  });

  it.each(PRESET_IDS)('preset %s resolves fully and ships no contrast warnings', (id) => {
    const r = resolveDesign({ preset: id });
    expect(r.preset).toBe(id);
    // fully resolved: every palette slot is a hex in both modes
    for (const p of [r.palette, r.paletteDark]) {
      for (const v of Object.values(p)) expect(v).toMatch(/^#[0-9a-f]{6}$/i);
    }
    // the resolved design re-validates as a stored design (round-trippable)
    expect(validateDesign(r).ok).toBe(true);
    // every preset is evaluated in both modes, even if it forces one
    expect(designWarnings({ ...r, colorScheme: 'auto' })).toEqual([]);
  });

  it('defaults equal the minimal preset', () => {
    expect(resolveDesign({})).toEqual(DESIGN_DEFAULTS);
    expect(resolveDesign(undefined)).toEqual(DESIGN_DEFAULTS);
    expect(resolveDesign({ preset: 'minimal' })).toEqual(DESIGN_DEFAULTS);
  });
});

describe('resolveDesign', () => {
  it('layers overrides over the preset per field', () => {
    const r = resolveDesign({ preset: 'editorial', shape: { radius: 20 }, typography: { baseSize: 18 } });
    expect(r.shape).toEqual({ radius: 20, controlRadius: 2, borderWidth: 1 });
    expect(r.typography.baseSize).toBe(18);
    expect(r.typography.headingFont).toBe('playfair-display');
    expect(r.inputs.style).toBe('underline');
  });

  it('a chosen body font also becomes the heading font unless set', () => {
    expect(resolveDesign({ preset: 'editorial', typography: { font: 'inter' } }).typography.headingFont).toBe('inter');
    expect(
      resolveDesign({ preset: 'editorial', typography: { font: 'inter', headingFont: 'merriweather' } }).typography
        .headingFont,
    ).toBe('merriweather');
  });

  it('recomputes primaryInk for a new primary, and carries brand colours into dark', () => {
    const light = resolveDesign({ palette: { primary: '#fde047' } });
    expect(light.palette.primaryInk).toBe(readableOn('#fde047'));
    expect(light.palette.primaryInk).toBe('#111827');
    expect(light.paletteDark.primary).toBe('#fde047');
    expect(light.paletteDark.primaryInk).toBe('#111827');
    // neutrals do not carry
    const n = resolveDesign({ palette: { background: '#ffffff' } });
    expect(n.paletteDark.background).toBe(DESIGN_DEFAULTS.paletteDark.background);
    // an explicit dark slot wins
    const both = resolveDesign({ palette: { primary: '#123456' }, paletteDark: { primary: '#abcdef' } });
    expect(both.paletteDark.primary).toBe('#abcdef');
  });

  it('treats background as atomic and carries artwork (not plain colours) into dark', () => {
    const r = resolveDesign({ preset: 'glass', background: { color: '#ffffff' } });
    expect(r.background).toEqual({ color: '#ffffff' });
    expect(r.backgroundDark).toEqual({});
    const photo = resolveDesign({
      preset: 'split-photo',
      background: { image: { assetId: ASSET }, color: '#ffffff', pattern: 'dots' },
    });
    expect(photo.background.gradient).toBeUndefined();
    expect(photo.backgroundDark).toEqual({ image: { assetId: ASSET }, pattern: 'dots' });
    const explicit = resolveDesign({ background: { color: '#ffffff' }, backgroundDark: { color: '#000000' } });
    expect(explicit.backgroundDark).toEqual({ color: '#000000' });
    const gradient = { type: 'linear' as const, angle: 135, stops: [{ color: '#0f172a', at: 0 }, { color: '#7c3aed', at: 100 }] };
    const g = resolveDesign({ preset: 'glass', background: { gradient, color: '#eef2ff' } });
    expect(g.backgroundDark).toEqual({ gradient });
  });

  it('is forgiving of stored junk: invalid sections are ignored, valid ones kept', () => {
    const r = resolveDesign({ preset: 'slate', typography: { font: 'removed-font' }, shape: { radius: 3 }, junk: 1 });
    expect(r.preset).toBe('slate');
    expect(r.typography.font).toBe('work-sans');
    expect(r.shape.radius).toBe(3);
    expect(resolveDesign('nonsense')).toEqual(DESIGN_DEFAULTS);
    expect(resolveDesign({ preset: 'nope' }).preset).toBe('minimal');
  });

  it('does not mutate the defaults or presets', () => {
    const before = JSON.stringify([DESIGN_DEFAULTS, DESIGN_PRESETS]);
    const r = resolveDesign({ preset: 'atlas' });
    r.palette.primary = '#000000';
    r.background.gradient!.stops[0]!.color = '#000000';
    expect(JSON.stringify([DESIGN_DEFAULTS, DESIGN_PRESETS])).toBe(before);
  });
});

describe('contrast', () => {
  it('computes WCAG ratios', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBe(1);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 1);
    expect(contrastRatio('nope', '#ffffff')).toBe(1);
  });

  it('readableOn picks dark ink on light fills and light ink on dark fills', () => {
    expect(readableOn('#ffffff')).toBe('#111827');
    expect(readableOn('#fde047')).toBe('#111827');
    expect(readableOn('#18181b')).toBe('#ffffff');
    expect(readableOn('#4f46e5')).toBe('#ffffff');
  });

  it('readableInk moves a colour along lightness until it passes, keeping passes unchanged', () => {
    expect(readableInk('#000000', ['#ffffff'])).toBe('#000000');
    const ink = readableInk('#67e8f9', ['#ffffff']);
    expect(ink).not.toBe('#67e8f9');
    expect(contrastRatio(ink, '#ffffff')).toBeGreaterThanOrEqual(AA_TEXT);
    const onDark = readableInk('#3730a3', ['#09090b']);
    expect(contrastRatio(onDark, '#09090b')).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe('designWarnings', () => {
  it('flags each checked pair in the modes the design can show', () => {
    const r = resolveDesign({
      colorScheme: 'light',
      palette: { text: '#dddddd', muted: '#eeeeee', primary: '#ffff00', primaryInk: '#ffffff', inputText: '#fafafa' },
    });
    const w = designWarnings(r);
    expect(w.map((x) => `${x.mode}:${x.pair.join('/')}`).sort()).toEqual([
      'light:inputText/inputBackground',
      'light:muted/surface',
      'light:primaryInk/primary',
      'light:text/surface',
    ]);
    expect(w[0]!.path.startsWith('palette.')).toBe(true);
    expect(w[0]!.required).toBe(4.5);
  });

  it('checks text on the page background only for card "none" outside split', () => {
    const base = { palette: { background: '#18181b' }, paletteDark: { background: '#fafafa' } } as const;
    expect(designWarnings(resolveDesign({ ...base })).length).toBe(0);
    const none = designWarnings(resolveDesign({ ...base, card: { style: 'none' } }));
    expect(none.map((x) => `${x.mode}:${x.pair.join('/')}`).sort()).toEqual([
      'dark:text/background',
      'light:text/background',
    ]);
    expect(designWarnings(resolveDesign({ ...base, card: { style: 'none' }, layout: { position: 'split' } }))).toEqual([]);
  });

  it('only checks dark when the design is forced dark', () => {
    const w = designWarnings(resolveDesign({ colorScheme: 'dark', palette: { text: '#ffffff' } }));
    expect(w).toEqual([]);
  });
});
