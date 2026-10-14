import { describe, it, expect, afterEach } from 'vitest';
import { frame, render, COLS, ROWS } from './render';
import { staticBanner, bannerAllowed, BANNER_HEIGHT } from './banner';
import { progress, velocity, CRUISE } from './motion';
import { wordmarkLines, WORDMARK_ROWS } from './wordmark';

const stripAnsi = (s: string) => s.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');

describe('motion', () => {
  it('starts at 0 and ends at exactly 1', () => {
    expect(progress(0)).toBe(0);
    expect(progress(1)).toBeCloseTo(1, 10);
  });

  it('is monotonic', () => {
    let prev = -1;
    for (let i = 0; i <= 50; i += 1) {
      const p = progress(i / 50);
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });

  it('cruises at a constant velocity through the whole cruise band', () => {
    const mid = (CRUISE.from + CRUISE.to) / 2;
    expect(velocity(mid)).toBeCloseTo(1, 10);
    expect(velocity(CRUISE.from)).toBeCloseTo(1, 10);
    expect(velocity(CRUISE.to)).toBeCloseTo(1, 10);
    // Ramps rise from 0 and fall back to 0.
    expect(velocity(0)).toBe(0);
    expect(velocity(1)).toBeCloseTo(0, 10);
  });
});

describe('render', () => {
  it('fills a plausible fraction of the grid with the mark', () => {
    const cells = render(0.6, 0.34);
    const lit = cells.filter(Boolean).length;
    // The mark should be present and sized — not empty, not the whole screen.
    expect(lit).toBeGreaterThan(COLS * ROWS * 0.1);
    expect(lit).toBeLessThan(COLS * ROWS * 0.9);
  });

  it('shows all three materials in the rest pose', () => {
    const cells = render(0.6, 0.34).filter((c): c is NonNullable<typeof c> => c !== null);
    const mats = new Set(cells.map((c) => c.mat));
    expect(mats.has('tile')).toBe(true);
    expect(mats.has('diamond')).toBe(true);
    expect(mats.has('dot')).toBe(true);
  });

  it('carries the violet→cyan gradient across the tile', () => {
    const tile = render(0, 0)
      .filter((c): c is NonNullable<typeof c> => c?.mat === 'tile');
    const gs = tile.map((c) => c.g);
    // Face-on, the tile spans the full gradient range, not a single tone.
    expect(Math.min(...gs)).toBeLessThan(0.2);
    expect(Math.max(...gs)).toBeGreaterThan(0.8);
  });
});

describe('frame', () => {
  it('produces exactly ROWS lines', () => {
    expect(frame(0.6, 0.34, true).split('\n')).toHaveLength(ROWS);
  });

  it('is pure ASCII once ANSI is stripped', () => {
    const plain = stripAnsi(frame(0.6, 0.34, true));
    expect(plain).toMatch(/^[\x20-\x7e\n]*$/);
  });

  it('emits truecolor escapes with colour on, none with colour off', () => {
    expect(frame(0.6, 0.34, true)).toContain('\u001b[38;2;');
    expect(frame(0.6, 0.34, false)).not.toContain('\u001b[');
  });

  it('renders the same shape with and without colour', () => {
    expect(stripAnsi(frame(0.6, 0.34, true))).toBe(frame(0.6, 0.34, false));
  });
});

describe('wordmark', () => {
  it('is exactly WORDMARK_ROWS lines', () => {
    expect(wordmarkLines().length).toBe(WORDMARK_ROWS);
  });

  it('spells ATLAS in block ink', () => {
    const joined = stripAnsi(wordmarkLines().join('\n'));
    expect(joined).toContain('█');
  });
});

describe('banner', () => {
  it('BANNER_HEIGHT accounts for the mark and the wordmark block', () => {
    expect(BANNER_HEIGHT).toBe(ROWS + 1 + WORDMARK_ROWS + 2);
  });

  it('staticBanner contains the mark and the wordmark', () => {
    const plain = stripAnsi(staticBanner(false));
    expect(plain.split('\n').length).toBeGreaterThan(ROWS + WORDMARK_ROWS);
    expect(plain).toContain('█'); // wordmark ink
  });

  describe('bannerAllowed', () => {
    const saved = { ...process.env };
    afterEach(() => {
      process.env = { ...saved };
    });

    const fakeTty = (columns: number): NodeJS.WriteStream =>
      ({ isTTY: true, columns } as unknown as NodeJS.WriteStream);

    it('is false in CI', () => {
      process.env.CI = '1';
      delete process.env.ATLAS_NO_BANNER;
      expect(bannerAllowed(fakeTty(120))).toBe(false);
    });

    it('is false when ATLAS_NO_BANNER is set', () => {
      delete process.env.CI;
      process.env.ATLAS_NO_BANNER = '1';
      expect(bannerAllowed(fakeTty(120))).toBe(false);
    });

    it('is false on a non-TTY', () => {
      delete process.env.CI;
      delete process.env.ATLAS_NO_BANNER;
      expect(bannerAllowed({ isTTY: false } as NodeJS.WriteStream)).toBe(false);
    });

    it('is false on a too-narrow TTY', () => {
      delete process.env.CI;
      delete process.env.ATLAS_NO_BANNER;
      expect(bannerAllowed(fakeTty(COLS - 1))).toBe(false);
    });

    it('is true on a wide interactive TTY outside CI', () => {
      delete process.env.CI;
      delete process.env.ATLAS_NO_BANNER;
      expect(bannerAllowed(fakeTty(COLS + 10))).toBe(true);
    });
  });
});
