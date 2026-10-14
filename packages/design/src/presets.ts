import type { AtlasDesign } from './schema';
import { PALETTE_SLOTS, type PresetId, type ResolvedDesign, type ResolvedPalette } from './vocab';

/**
 * Presets tuned for SIGN-IN pages. Each is a partial design (with its own dark
 * palette) layered over {@link DESIGN_DEFAULTS}; a stored design then layers
 * its overrides over the preset (see `resolveDesign`).
 *
 * Every palette here is chosen so the four contrast checks in `designWarnings`
 * pass in both modes — a preset that ships a warning teaches customers to
 * ignore warnings. (Asserted by presets.test.ts.)
 */

/**
 * A palette written compactly: twelve space-separated colours in slot order —
 * primary primaryInk accent background surface text muted border danger
 * success inputBackground inputText — with `-` for a slot the preset leaves
 * unset. Compact on purpose: the preset table ships inside the embeddable
 * widget's single script. A malformed spec throws at load (and in the tests).
 */
function pal(spec: string): ResolvedPalette {
  const parts = spec.split(' ');
  if (parts.length !== PALETTE_SLOTS.length) throw new Error(`palette spec needs ${PALETTE_SLOTS.length} slots: ${spec}`);
  const out: Partial<ResolvedPalette> = {};
  parts.forEach((v, i) => {
    if (v !== '-') out[PALETTE_SLOTS[i]!] = v;
  });
  return out as ResolvedPalette;
}

/** The fully-resolved baseline — equal to the `minimal` preset. */
export const DESIGN_DEFAULTS: ResolvedDesign = {
  version: 1,
  preset: 'minimal',
  colorScheme: 'auto',
  palette: pal('#18181b #ffffff #4f46e5 #fafafa #ffffff #18181b #71717a #e4e4e7 #dc2626 #15803d #ffffff #18181b'),
  paletteDark: pal('#fafafa #18181b #818cf8 #09090b #18181b #fafafa #a1a1aa #3f3f46 #f87171 #4ade80 #09090b #fafafa'),
  typography: {
    font: 'inter',
    headingFont: 'inter',
    baseSize: 15,
    headingWeight: 600,
    bodyWeight: 400,
    letterCase: 'none',
    scale: 'perfect-fourth',
  },
  shape: { radius: 12, controlRadius: 8, borderWidth: 1 },
  elevation: { cardShadow: 'md' },
  spacing: { density: 'comfortable' },
  card: { style: 'solid', blur: 16, width: 'normal' },
  layout: { position: 'center', splitImageSide: 'left', logoPlacement: 'card', logoSize: 'md' },
  buttons: { style: 'solid', socialLayout: 'list' },
  inputs: { style: 'outline' },
  background: {},
  backgroundDark: {},
  logo: {},
};

export interface DesignPreset {
  id: PresetId;
  label: string;
  description: string;
  /** Overrides over DESIGN_DEFAULTS (no `preset` key). */
  design: Omit<AtlasDesign, 'preset' | 'version'>;
}

/**
 * The preset designs — overrides over {@link DESIGN_DEFAULTS} (no `preset`
 * key) — keyed by id. This is all the resolver needs; the editor-facing
 * labels live in {@link DESIGN_PRESETS}, built from this and the labels below,
 * so a renderer that only resolves never ships the copy.
 */
export const PRESET_DESIGNS: Record<PresetId, { design: Omit<AtlasDesign, 'preset' | 'version'> }> = {
  minimal: {
    design: {},
  },
  atlas: {
    design: {
      palette: pal('#6d4aff #ffffff #0e8fc7 #f6f5ff #ffffff #0b0d17 #5b6078 #e2def5 #d92d3a #0f7a52 #ffffff #0b0d17'),
      paletteDark: pal('#7455fa #ffffff #46c7ff #070811 #0f1120 #eef0f6 #959bb0 #262a40 #ff6b6b #43d9a0 #0b0d17 #eef0f6'),
      typography: { font: 'system', headingFont: 'system', headingWeight: 600 },
      shape: { radius: 14, controlRadius: 9, borderWidth: 1 },
      elevation: { cardShadow: 'lg' },
      buttons: { style: 'gradient' },
      background: {
        gradient: {
          type: 'linear',
          angle: 160,
          stops: [
            { color: '#f6f5ff', at: 0 },
            { color: '#eef6ff', at: 100 },
          ],
        },
      },
      backgroundDark: {
        gradient: {
          type: 'radial',
          stops: [
            { color: '#1a1440', at: 0 },
            { color: '#070811', at: 70 },
          ],
        },
        pattern: 'grid',
      },
    },
  },
  glass: {
    design: {
      palette: pal('#4338ca - #db2777 #eef2ff #ffffff #111827 #4b5563 #ffffff - - #ffffff #111827'),
      paletteDark: pal('#a5b4fc - #f472b6 #1e1b4b #111827 #f9fafb #cbd5e1 #374151 - - #0b1120 #f9fafb'),
      shape: { radius: 20, controlRadius: 12 },
      elevation: { cardShadow: 'xl' },
      card: { style: 'glass', blur: 20 },
      background: {
        gradient: {
          type: 'linear',
          angle: 135,
          stops: [
            { color: '#6366f1', at: 0 },
            { color: '#ec4899', at: 55 },
            { color: '#f59e0b', at: 100 },
          ],
        },
      },
      backgroundDark: {
        gradient: {
          type: 'linear',
          angle: 135,
          stops: [
            { color: '#1e1b4b', at: 0 },
            { color: '#4c1d95', at: 55 },
            { color: '#831843', at: 100 },
          ],
        },
      },
    },
  },
  midnight: {
    design: {
      colorScheme: 'dark',
      palette: pal('#1d4ed8 - #7c3aed #eef2f9 #ffffff #0b1020 #475569 #d5dceb - - #ffffff #0b1020'),
      paletteDark: pal('#60a5fa - #a78bfa #0b1020 #121a2f #e6eaf5 #94a3b8 #24314f #f87171 #34d399 #0e1528 #e6eaf5'),
      typography: { font: 'manrope', headingFont: 'manrope' },
      shape: { radius: 16, controlRadius: 10 },
      elevation: { cardShadow: 'lg' },
      backgroundDark: { pattern: 'dots' },
    },
  },
  editorial: {
    design: {
      palette: pal('#8b2e1f - #8a6410 #f7f3ec #fffdf8 #1f1a14 #6b6157 #e3dacb - - #fffdf8 #1f1a14'),
      paletteDark: pal('#e07a5f - #d4a64a #16130f #1f1b16 #f2ebe0 #a89f92 #3a332a - - #16130f #f2ebe0'),
      typography: {
        font: 'source-serif',
        headingFont: 'playfair-display',
        baseSize: 16,
        headingWeight: 700,
        scale: 'golden',
      },
      shape: { radius: 4, controlRadius: 2 },
      elevation: { cardShadow: 'sm' },
      inputs: { style: 'underline' },
    },
  },
  terminal: {
    design: {
      colorScheme: 'dark',
      palette: pal('#166534 - #0e7490 #f4fbf3 #ffffff #0b2a0b #3f6b3c #b7d8b4 - - #ffffff #0b2a0b'),
      paletteDark: pal('#39ff14 #031003 #00e5ff #0a0f0a #0d140d #c8f7c5 #7fb57b #2c5a2c #ff5555 #39ff14 #050805 #c8f7c5'),
      typography: {
        font: 'jetbrains-mono',
        headingFont: 'jetbrains-mono',
        baseSize: 14,
        letterCase: 'uppercase',
        scale: 'major-second',
      },
      shape: { radius: 0, controlRadius: 0, borderWidth: 1 },
      elevation: { cardShadow: 'none' },
      card: { style: 'outline' },
      buttons: { style: 'outline' },
      backgroundDark: { pattern: 'grid' },
    },
  },
  sunrise: {
    design: {
      palette: pal('#c2410c - #be185d #fff1e6 #ffffff #2a1a12 #7c5e52 #f4d9cb - - #ffffff #2a1a12'),
      paletteDark: pal('#fb923c - #f472b6 #1a0f0a #24150f #fdebe1 #c4a092 #4a2e22 - - #1a0f0a #fdebe1'),
      typography: { font: 'poppins', headingFont: 'poppins' },
      shape: { radius: 20, controlRadius: 999 },
      elevation: { cardShadow: 'lg' },
      background: {
        gradient: {
          type: 'linear',
          angle: 160,
          stops: [
            { color: '#fff1e6', at: 0 },
            { color: '#ffe4ec', at: 100 },
          ],
        },
      },
      backgroundDark: {
        gradient: {
          type: 'linear',
          angle: 160,
          stops: [
            { color: '#2a1209', at: 0 },
            { color: '#2a0f1c', at: 100 },
          ],
        },
      },
    },
  },
  forest: {
    design: {
      palette: pal('#166534 - #a16207 #f3f7f2 #ffffff #14261a #53685a #d6e3d8 - - #f3f7f2 #14261a'),
      paletteDark: pal('#4ade80 - #facc15 #0c1510 #13201a #e3efe6 #9db5a4 #2a3d31 - - #0c1510 #e3efe6'),
      typography: { font: 'dm-sans', headingFont: 'dm-sans' },
      shape: { radius: 10, controlRadius: 8 },
      inputs: { style: 'filled' },
    },
  },
  grape: {
    design: {
      palette: pal('#7e22ce - #be185d #faf5ff #ffffff #2e1065 #6b5b8a #e9d5ff - - #ffffff #2e1065'),
      paletteDark: pal('#c084fc - #f472b6 #12081f #1c1030 #f3e8ff #b4a3cf #3b2559 - - #12081f #f3e8ff'),
      typography: { font: 'nunito', headingFont: 'nunito', headingWeight: 800 },
      shape: { radius: 24, controlRadius: 14 },
      buttons: { socialLayout: 'grid' },
      background: { pattern: 'dots' },
      backgroundDark: { pattern: 'dots' },
    },
  },
  slate: {
    design: {
      palette: pal('#334155 - #0369a1 #f1f5f9 #ffffff #0f172a #64748b #cbd5e1 - - #f8fafc #0f172a'),
      paletteDark: pal('#cbd5e1 - #38bdf8 #0f172a #1e293b #f1f5f9 #94a3b8 #334155 - - #0f172a #f1f5f9'),
      typography: { font: 'work-sans', headingFont: 'work-sans' },
      shape: { radius: 8, controlRadius: 6 },
      elevation: { cardShadow: 'sm' },
      spacing: { density: 'compact' },
      inputs: { style: 'filled' },
    },
  },
  'split-photo': {
    design: {
      layout: { position: 'split', splitImageSide: 'left', logoPlacement: 'page' },
      card: { style: 'none', width: 'normal' },
      elevation: { cardShadow: 'none' },
      shape: { radius: 0, controlRadius: 8 },
      background: {
        gradient: {
          type: 'linear',
          angle: 135,
          stops: [
            { color: '#0f172a', at: 0 },
            { color: '#334155', at: 100 },
          ],
        },
      },
      backgroundDark: {
        gradient: {
          type: 'linear',
          angle: 135,
          stops: [
            { color: '#020617', at: 0 },
            { color: '#1e293b', at: 100 },
          ],
        },
      },
    },
  },
  bold: {
    design: {
      palette: pal('#4338ca - #ca8a04 #4338ca #ffffff #111827 #4b5563 #e5e7eb - - #ffffff #111827'),
      paletteDark: pal('#a5b4fc - #facc15 #1e1b4b #111827 #f9fafb #cbd5e1 #374151 - - #0b1120 #f9fafb'),
      typography: {
        font: 'montserrat',
        headingFont: 'montserrat',
        baseSize: 17,
        headingWeight: 800,
        letterCase: 'uppercase',
        scale: 'octave',
      },
      shape: { radius: 24, controlRadius: 999, borderWidth: 0 },
      elevation: { cardShadow: 'xl' },
      spacing: { density: 'spacious' },
      card: { width: 'wide' },
    },
  },
};

const PRESET_LABELS: Record<PresetId, { label: string; description: string }> = {
  minimal: {
    label: 'Minimal',
    description: 'Neutral, quiet and familiar. The default.',
  },
  atlas: {
    label: 'Atlas',
    description: 'The Atlas console look: deep ink, violet-to-cyan accents, soft glow.',
  },
  glass: {
    label: 'Glass',
    description: 'A frosted card over a vivid gradient.',
  },
  midnight: {
    label: 'Midnight',
    description: 'Dark navy, calm blue accents. Dark by default.',
  },
  editorial: {
    label: 'Editorial',
    description: 'Serif type on warm paper, like a well-set magazine.',
  },
  terminal: {
    label: 'Terminal',
    description: 'Monospace, phosphor green on black. Dark by default.',
  },
  sunrise: {
    label: 'Sunrise',
    description: 'Warm peach-to-rose gradient with pill buttons.',
  },
  forest: {
    label: 'Forest',
    description: 'Deep greens and soft sage, filled inputs.',
  },
  grape: {
    label: 'Grape',
    description: 'Playful purple, rounded everything, grid social buttons.',
  },
  slate: {
    label: 'Slate',
    description: 'Businesslike greys, compact spacing, filled inputs.',
  },
  'split-photo': {
    label: 'Split photo',
    description: 'Half photo, half form. Upload a background image; until then a dark gradient fills the image side.',
  },
  bold: {
    label: 'Bold',
    description: 'Big type on a saturated solid background.',
  },
};

function buildPresets(): Record<PresetId, DesignPreset> {
  const out = {} as Record<PresetId, DesignPreset>;
  for (const id of Object.keys(PRESET_DESIGNS) as PresetId[]) {
    out[id] = { id, ...PRESET_LABELS[id], design: PRESET_DESIGNS[id].design };
  }
  return out;
}

/** Every preset with its editor label and description. */
export const DESIGN_PRESETS: Record<PresetId, DesignPreset> = /* @__PURE__ */ buildPresets();

/** Preset list for editors, in display order. */
export const DESIGN_PRESET_LIST: readonly DesignPreset[] = /* @__PURE__ */ Object.values(DESIGN_PRESETS);
