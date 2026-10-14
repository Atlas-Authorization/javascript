import { AA_TEXT, contrastRatio } from './contrast';
import type { PaletteSlot, ResolvedDesign, ResolvedPalette } from './schema';

/**
 * Contrast WARNINGS for a resolved design — advice, never a refusal. A brand
 * may knowingly ship a low-contrast pair; the editor and the API surface these
 * so they choose it with their eyes open (WCAG 2.x AA, 4.5:1 for text).
 *
 * Checked in each mode the design can actually show (light, dark or both for
 * `auto`):
 *   - text on surface            (the card's body copy)
 *   - muted on surface           (helper text, labels)
 *   - primaryInk on primary      (the primary button label)
 *   - inputText on inputBackground
 *   - text on background         (only when the card is `none` and the page is
 *                                 not split — then copy sits on the page itself)
 */

export interface DesignWarning {
  code: 'low_contrast';
  mode: 'light' | 'dark';
  /** `[foreground slot, background slot]`. */
  pair: [PaletteSlot, PaletteSlot];
  ratio: number;
  required: number;
  /** Dotted path of the setting to change, e.g. `paletteDark.primaryInk`. */
  path: string;
  message: string;
}

const LABEL: Record<PaletteSlot, string> = {
  primary: 'primary',
  primaryInk: 'primary button text',
  accent: 'accent',
  background: 'page background',
  surface: 'card surface',
  text: 'text',
  muted: 'muted text',
  border: 'border',
  danger: 'danger',
  success: 'success',
  inputBackground: 'input background',
  inputText: 'input text',
};

export function designWarnings(d: ResolvedDesign): DesignWarning[] {
  const modes: ('light' | 'dark')[] =
    d.colorScheme === 'auto' ? ['light', 'dark'] : [d.colorScheme];
  const pairs: [PaletteSlot, PaletteSlot][] = [
    ['text', 'surface'],
    ['muted', 'surface'],
    ['primaryInk', 'primary'],
    ['inputText', 'inputBackground'],
  ];
  if (d.card.style === 'none' && d.layout.position !== 'split') pairs.push(['text', 'background']);

  const out: DesignWarning[] = [];
  for (const mode of modes) {
    const p: ResolvedPalette = mode === 'light' ? d.palette : d.paletteDark;
    const section = mode === 'light' ? 'palette' : 'paletteDark';
    for (const [fg, bg] of pairs) {
      const ratio = Math.round(contrastRatio(p[fg], p[bg]) * 100) / 100;
      if (ratio >= AA_TEXT) continue;
      out.push({
        code: 'low_contrast',
        mode,
        pair: [fg, bg],
        ratio,
        required: AA_TEXT,
        path: `${section}.${fg}`,
        message: `In ${mode} mode, ${LABEL[fg]} (${p[fg]}) on ${LABEL[bg]} (${p[bg]}) has a contrast of ${ratio}:1; ${AA_TEXT}:1 is recommended for readable text.`,
      });
    }
  }
  return out;
}
