/**
 * ATLAS, as letterforms.
 *
 * Under a rendered 3D mark, the plain word "ATLAS" in spaced capitals reads as
 * a placeholder: the image above is doing real work and the caption is doing
 * none. A small block font puts the two at the same weight, and carrying the
 * mark's violet→cyan gradient across the letters makes the whole banner one
 * idea rather than a picture with a label stuck underneath.
 */

/** 5 rows, 4 columns per glyph. `#` is ink. */
const GLYPHS: Record<string, string[]> = {
  A: [' ## ', '#  #', '####', '#  #', '#  #'],
  T: ['####', ' ## ', ' ## ', ' ## ', ' ## '],
  L: ['#   ', '#   ', '#   ', '#   ', '####'],
  S: ['####', '#   ', '####', '   #', '####'],
};

const WORD = 'ATLAS';
const ROWS = 5;
/** One blank column between letters. */
const TRACKING = 1;

/**
 * A per-letter colour: given the letter's index and the total count, return the
 * ANSI sequence to open it with (the caller resets after). Returning '' means
 * no colour, which is how NO_COLOR mode flows through without a second path.
 */
export type LetterColour = (index: number, count: number) => string;

/**
 * Render the wordmark.
 *
 * Returns exactly `ROWS` lines so a caller doing cursor arithmetic (the
 * animation rewinds by a computed number of rows) never drifts — a wordmark of
 * variable height would silently break that.
 */
export function wordmarkLines(colour?: LetterColour, reset = '', indent = 2): string[] {
  const lines: string[] = [];

  for (let row = 0; row < ROWS; row += 1) {
    let line = ' '.repeat(indent);

    for (let i = 0; i < WORD.length; i += 1) {
      const glyph = GLYPHS[WORD[i]!];
      if (!glyph) continue;

      const open = colour ? colour(i, WORD.length) : '';
      // `#` becomes a solid block; the table stays legible as ASCII in source,
      // which is the reason it is written that way.
      const cells = glyph[row]!.replace(/#/g, '█');
      line += open ? `${open}${cells}${reset}` : cells;
      if (i < WORD.length - 1) line += ' '.repeat(TRACKING);
    }

    lines.push(line.replace(/\s+$/, ''));
  }

  return lines;
}

/** Height in rows, so callers can do cursor arithmetic without guessing. */
export const WORDMARK_ROWS = ROWS;
