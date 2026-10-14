/**
 * The welcome banner: the Atlas mark spinning up, cruising, and settling.
 *
 * ── WHEN IT RUNS MATTERS MORE THAN HOW IT LOOKS ──────────────────────
 * Only on a TTY, never in CI, never when output is piped or the terminal is too
 * narrow. An animation that delayed a scripted command by a second would be the
 * thing people write wrappers to avoid — so if anything is going to READ the
 * output, there is no animation. `ATLAS_NO_BANNER=1` turns it off entirely;
 * `NO_COLOR` keeps the form (the characters carry it) and drops only the tint.
 */

import { frame, COLS, ROWS } from './render';
import { wordmarkLines, WORDMARK_ROWS, type LetterColour } from './wordmark';
import { CRUISE, progress, velocity } from './motion';

const ESC = '\u001b';
const RESET = `${ESC}[0m`;
const DIM = `${ESC}[2m`;
const BOLD = `${ESC}[1m`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const ERASE_EOL = `${ESC}[K`;

const VIOLET: [number, number, number] = [110, 92, 255];
const CYAN: [number, number, number] = [70, 199, 255];

const TAGLINE = '  identity infrastructure for every app';

/**
 * A frame is written as a leading newline, ROWS lines, then a trailing newline
 * — ROWS + 1 newlines, so the cursor ends exactly that far below where it
 * started. Derived from ROWS so changing the frame height cannot reintroduce
 * the classic off-by-one that walks the animation up over the shell prompt.
 */
const FRAME_ADVANCE = ROWS + 1;

/** Rows a finished banner leaves on screen: the mark, then the wordmark block. */
export const BANNER_HEIGHT = FRAME_ADVANCE + WORDMARK_ROWS + 2;

/** Carry the mark's gradient across the letters: violet on the left → cyan on the right. */
const letterColour: LetterColour = (i, count) => {
  const t = count > 1 ? i / (count - 1) : 0;
  const r = Math.round(VIOLET[0] + (CYAN[0] - VIOLET[0]) * t);
  const g = Math.round(VIOLET[1] + (CYAN[1] - VIOLET[1]) * t);
  const b = Math.round(VIOLET[2] + (CYAN[2] - VIOLET[2]) * t);
  return `${BOLD}${ESC}[38;2;${r};${g};${b}m`;
};

function wordmark(colour: boolean): string {
  const lines = wordmarkLines(colour ? letterColour : undefined, colour ? RESET : '');
  const tag = colour ? `${DIM}${TAGLINE}${RESET}` : TAGLINE;
  return ['', ...lines, tag, ''].join('\n');
}

/** `ESC[K` after each row, so a narrow frame erases the tail of a wider one. */
function overwrite(body: string): string {
  return body
    .split('\n')
    .map((line) => line + ERASE_EOL)
    .join('\n');
}

/**
 * Where the spin stops: a three-quarter view. A touch of Y turn plus the
 * standing X tilt shows the diamond proud of the tile and the dot proud of the
 * diamond — face-on, the depth is all there in the geometry and none of it is
 * visible.
 */
const REST_AY = 0.34;
const REST_AX = 0.2;

/** A still banner (mark + wordmark), for when motion is not wanted. */
export function staticBanner(colour = true): string {
  return `\n${frame(REST_AY, REST_AX, colour)}\n${wordmark(colour)}`;
}

export function bannerAllowed(stream: NodeJS.WriteStream = process.stdout): boolean {
  if (process.env.ATLAS_NO_BANNER) return false;
  if (process.env.CI) return false;
  if (!stream.isTTY) return false;
  if ((stream.columns ?? 80) < COLS + 2) return false;
  return true;
}

const FPS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function paint(ay: number, ax: number, colour: boolean): void {
  process.stdout.write(`\n${overwrite(frame(ay, ax, colour))}\n`);
  process.stdout.write(`${ESC}[${FRAME_ADVANCE}A`);
}

/**
 * The intro: spin up, cruise, settle on the rest pose.
 *
 * It must END so the CLI can print afterwards, so it turns for about two seconds
 * and lands on exactly `REST_AY` — the same pose `staticBanner` uses, so the
 * final animation frame and the still image are the same picture. The motion is
 * trapezoidal, not eased: most of those two seconds are at one constant speed.
 */
export async function animate(): Promise<void> {
  const colour = !process.env.NO_COLOR;
  const frames = 56;
  const sweep = Math.PI * 4; // two full turns

  process.stdout.write(HIDE_CURSOR);
  try {
    for (let i = 0; i < frames; i += 1) {
      const p = progress(i / (frames - 1));
      // Count DOWN to the rest angle so the last frame lands on it exactly.
      const ay = REST_AY + (1 - p) * sweep;
      const ax = 0.12 + p * (REST_AX - 0.12);
      paint(ay, ax, colour);
      await sleep(1000 / FPS);
    }
    // Settle frame erases too — it is drawn over the last animation frame,
    // which may have been wider.
    process.stdout.write(`\n${overwrite(frame(REST_AY, REST_AX, colour))}\n`);
    process.stdout.write(overwrite(wordmark(colour)));
  } finally {
    process.stdout.write(SHOW_CURSOR);
  }
}

/**
 * Print the banner the right way for the current environment: animate on an
 * interactive TTY, fall back to the still image otherwise. The one call a CLI
 * needs.
 */
export async function showBanner(): Promise<void> {
  if (bannerAllowed()) {
    await animate();
    return;
  }
  // Still image only when colour is useful (a TTY that was too slow/narrow);
  // piped or CI output gets nothing, so logs stay clean.
  if (process.stdout.isTTY && !process.env.ATLAS_NO_BANNER) {
    process.stdout.write(`${staticBanner(!process.env.NO_COLOR)}\n`);
  }
}

export { CRUISE, velocity };
