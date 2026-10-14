/**
 * The curated font list a design may name.
 *
 * A design never carries a font URL or a free-text family: it names one of
 * these ids, and everything that reaches CSS (the family name, the fallback
 * stack, the stylesheet address) is a constant from this table. That is what
 * makes `font` safe to compile into a stylesheet without escaping, and what
 * lets the server mirror exactly these families and nothing else.
 *
 * Web fonts are SELF-HOSTED: Atlas mirrors the Google Fonts CSS2 sheet and its
 * woff2 files into its own storage
 * and pages link `/v1/design/fonts/<id>.css` on Atlas's origin. No visitor's
 * browser ever contacts Google. `system*` entries load nothing at all.
 */

export type FontCategory = 'sans-serif' | 'serif' | 'monospace';

export interface FontDefinition {
  /** Stable id stored in a design (`typography.font`). */
  id: string;
  /** Human label for editors. */
  label: string;
  /** The CSS family name (null for the pure system stacks). */
  family: string | null;
  category: FontCategory;
  /** Fallback stack appended after the family. Constant, CSS-safe. */
  fallback: string;
  /**
   * Google Fonts CSS2 family spec (`Inter:wght@400;500;600;700;800`), or null
   * when the font is a local system stack that needs no web font.
   */
  google: string | null;
}

const SANS_FALLBACK =
  "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF_FALLBACK = "Georgia, Cambria, 'Times New Roman', Times, serif";
const MONO_FALLBACK = "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, monospace";

const W5 = 'wght@400;500;600;700;800';

export const FONT_CATALOG: readonly FontDefinition[] = [
  { id: 'system', label: 'System UI', family: null, category: 'sans-serif', fallback: `-apple-system, BlinkMacSystemFont, ${SANS_FALLBACK}`, google: null },
  { id: 'system-serif', label: 'System serif (Georgia)', family: null, category: 'serif', fallback: SERIF_FALLBACK, google: null },
  { id: 'system-mono', label: 'System monospace', family: null, category: 'monospace', fallback: MONO_FALLBACK, google: null },
  { id: 'inter', label: 'Inter', family: 'Inter', category: 'sans-serif', fallback: SANS_FALLBACK, google: `Inter:${W5}` },
  { id: 'roboto', label: 'Roboto', family: 'Roboto', category: 'sans-serif', fallback: SANS_FALLBACK, google: 'Roboto:wght@400;500;700;800' },
  { id: 'open-sans', label: 'Open Sans', family: 'Open Sans', category: 'sans-serif', fallback: SANS_FALLBACK, google: `Open+Sans:${W5}` },
  { id: 'lato', label: 'Lato', family: 'Lato', category: 'sans-serif', fallback: SANS_FALLBACK, google: 'Lato:wght@400;700;900' },
  { id: 'montserrat', label: 'Montserrat', family: 'Montserrat', category: 'sans-serif', fallback: SANS_FALLBACK, google: `Montserrat:${W5}` },
  { id: 'poppins', label: 'Poppins', family: 'Poppins', category: 'sans-serif', fallback: SANS_FALLBACK, google: `Poppins:${W5}` },
  { id: 'nunito', label: 'Nunito', family: 'Nunito', category: 'sans-serif', fallback: SANS_FALLBACK, google: `Nunito:${W5}` },
  { id: 'work-sans', label: 'Work Sans', family: 'Work Sans', category: 'sans-serif', fallback: SANS_FALLBACK, google: `Work+Sans:${W5}` },
  { id: 'dm-sans', label: 'DM Sans', family: 'DM Sans', category: 'sans-serif', fallback: SANS_FALLBACK, google: `DM+Sans:${W5}` },
  { id: 'manrope', label: 'Manrope', family: 'Manrope', category: 'sans-serif', fallback: SANS_FALLBACK, google: `Manrope:${W5}` },
  { id: 'source-serif', label: 'Source Serif', family: 'Source Serif 4', category: 'serif', fallback: SERIF_FALLBACK, google: `Source+Serif+4:${W5}` },
  { id: 'merriweather', label: 'Merriweather', family: 'Merriweather', category: 'serif', fallback: SERIF_FALLBACK, google: 'Merriweather:wght@400;700;900' },
  { id: 'playfair-display', label: 'Playfair Display', family: 'Playfair Display', category: 'serif', fallback: SERIF_FALLBACK, google: `Playfair+Display:${W5}` },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', family: 'JetBrains Mono', category: 'monospace', fallback: MONO_FALLBACK, google: `JetBrains+Mono:${W5}` },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', family: 'IBM Plex Mono', category: 'monospace', fallback: MONO_FALLBACK, google: 'IBM+Plex+Mono:wght@400;500;600;700' },
] as const;

export const FONT_IDS = FONT_CATALOG.map((f) => f.id) as readonly string[];

const BY_ID = new Map(FONT_CATALOG.map((f) => [f.id, f]));

/** The catalog entry for an id, or undefined when it is not on the list. */
export function fontById(id: unknown): FontDefinition | undefined {
  return typeof id === 'string' ? BY_ID.get(id) : undefined;
}

/** True when the font needs a mirrored web-font stylesheet. */
export function isWebFont(id: unknown): boolean {
  return !!fontById(id)?.google;
}

/**
 * The full CSS `font-family` value for a catalog id — a quoted constant family
 * plus its fallback stack. Unknown ids get the system stack: a font is never
 * built from caller text.
 */
export function fontStack(id: unknown): string {
  const f = fontById(id) ?? BY_ID.get('system')!;
  return f.family ? `'${f.family}', ${f.fallback}` : f.fallback;
}

/**
 * The upstream Google Fonts CSS2 URL for an allowlisted font id (server-side
 * mirror only — never sent to a browser). Null for unknown or system fonts.
 */
export function googleFontSheetUrl(id: unknown): string | null {
  const f = fontById(id);
  if (!f?.google) return null;
  return `https://fonts.googleapis.com/css2?family=${f.google}&display=swap`;
}

/** The Atlas-origin path of a font's mirrored stylesheet (relative to the API origin). */
export function fontSheetPath(id: unknown): string | null {
  const f = fontById(id);
  return f?.google ? `/v1/design/fonts/${f.id}.css` : null;
}
