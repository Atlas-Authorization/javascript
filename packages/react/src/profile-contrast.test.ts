import { contrastRatio, parseCssColor, toHex } from '@atlasauth/design/runtime';
import { describe, expect, it } from 'vitest';
import { THEMES } from './appearance';
import { ATLAS_BASE_CSS } from './styles';

/** The input border the stylesheet paints: `color-mix(in srgb, border 50%, text)`. */
function inputBorder(border: string, text: string): string {
  const a = parseCssColor(border)!;
  const b = parseCssColor(text)!;
  return toHex({ r: (a.r + b.r) / 2, g: (a.g + b.g) / 2, b: (a.b + b.b) / 2, a: 1 });
}

describe('<UserProfile/> form tokens meet WCAG AA in both appearances', () => {
  it.each([
    ['light', THEMES.default],
    ['dark', THEMES.dark],
  ] as const)('%s: text 4.5:1, input border 3:1', (_name, t) => {
    expect(contrastRatio(t.colorText, t.colorBackground)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(inputBorder(t.colorBorder, t.colorText), t.colorBackground)).toBeGreaterThanOrEqual(3);
  });

  it('the stylesheet paints that mixed border on the account inputs and separates label from value', () => {
    const rule = (sel: string) => ATLAS_BASE_CSS.split('\n').find((l) => l.startsWith(sel)) ?? '';
    const field = rule('.atlas-account-field{');
    expect(field).toMatch(/display:flex/);
    expect(field).toMatch(/flex-direction:column/);
    expect(field).toMatch(/gap:/);
    const input = rule('.atlas-account-input,.atlas-input{');
    expect(input).toContain('color-mix(in srgb,var(--atlas-color-border) 50%,var(--atlas-color-text))');
    expect(input).toContain('background:var(--atlas-color-background');
    expect(input).toContain('color:var(--atlas-color-text');
  });
});
