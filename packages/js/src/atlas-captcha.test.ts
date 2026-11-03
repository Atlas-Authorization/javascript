// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  atlasCaptchaLabels,
  encodeAtlasToken,
  renderAtlasCaptcha,
  searchAtlasRange,
  solveAtlasChallenge,
  type AtlasChallenge,
} from './atlas-captcha';
import { isRenderableCaptcha, renderCaptchaWidget } from './captcha-widget';
import { createCaptchaController } from './captcha-controller';

/**
 * The Atlas captcha widget in a DOM: it fetches a challenge, does the proof of
 * work (on the page thread here: `workers: false`), shows the shape step only
 * when the server sent one, and hands back the `atlas1.` token the server
 * verifies. The challenge is built the way the server builds it:
 * SHA-256(salt + n) for a secret n.
 */

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function makeChallenge(n: number, extra: Partial<AtlasChallenge> = {}): Promise<AtlasChallenge> {
  return {
    object: 'captcha_challenge',
    provider: 'atlas',
    token: `signed-envelope-${n}`,
    algorithm: 'SHA-256',
    salt: 'a1b2c3',
    challenge: await sha256Hex(`a1b2c3${n}`),
    maxnumber: 5000,
    expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
    interactive: null,
    accessible_alternative: false,
    ...extra,
  };
}

const decode = (token: string) => {
  expect(token.startsWith('atlas1.')).toBe(true);
  const b64 = token.slice('atlas1.'.length).replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(b64)) as { t: string; n: number; ms?: number; sel?: number; w?: number };
};

const container = () => {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
};

const TILE = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 72 72"><rect width="72" height="72"/></svg>';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe('Atlas captcha proof of work', () => {
  it('finds the secret number', async () => {
    const c = await makeChallenge(3217);
    expect(await searchAtlasRange(c, 0, c.maxnumber)).toBe(3217);
    expect(await solveAtlasChallenge(c, { workers: false })).toEqual({ n: 3217, worker: false });
  });

  it('reports no solution outside the range', async () => {
    const c = await makeChallenge(4999);
    expect(await searchAtlasRange(c, 0, 100)).toBeNull();
  });

  it('encodes the token the server parses', () => {
    expect(decode(encodeAtlasToken({ t: 'x.y', n: 7, sel: 5 }))).toEqual({ t: 'x.y', n: 7, sel: 5 });
  });
});

describe('Atlas captcha widget', () => {
  it('invisible at low risk: solves with nothing drawn and yields the token', async () => {
    const c = await makeChallenge(1234);
    const el = container();
    const handle = renderAtlasCaptcha(el, { fetchChallenge: async () => c, workers: false, mode: 'managed' });
    const sol = decode(await handle.token);
    expect(sol).toMatchObject({ t: c.token, n: 1234 });
    expect(typeof sol.ms).toBe('number');
    expect(el.querySelector('[data-atlas-captcha-puzzle]')).toBeNull();
    expect(el.textContent).toBe('');
    expect(handle.stale()).toBe(false);
  });

  it('shows the shape step when the server asks, and sends the chosen tiles as a mask', async () => {
    const c = await makeChallenge(42, {
      interactive: { kind: 'match_shapes', example: TILE, tiles: Array(9).fill(TILE) },
      accessible_alternative: true,
    });
    const el = container();
    const handle = renderAtlasCaptcha(el, { fetchChallenge: async () => c, workers: false });
    await vi.waitFor(() => expect(el.querySelectorAll('[data-atlas-captcha-tile]')).toHaveLength(9));
    const tiles = el.querySelectorAll<HTMLButtonElement>('[data-atlas-captcha-tile]');
    tiles[0]!.click();
    tiles[2]!.click();
    tiles[3]!.click();
    tiles[3]!.click(); // toggled back off
    expect(tiles[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(tiles[0]!.getAttribute('aria-label')).toBe('Picture 1');
    el.querySelector<HTMLButtonElement>('[data-atlas-captcha-confirm]')!.click();
    expect(decode(await handle.token)).toMatchObject({ n: 42, sel: 0b101 });
  });

  it('the accessible alternative asks for a no-puzzle challenge instead', async () => {
    const puzzle = await makeChallenge(9, {
      interactive: { kind: 'match_shapes', example: TILE, tiles: Array(9).fill(TILE) },
      accessible_alternative: true,
    });
    const plain = await makeChallenge(77, { token: 'accessible-envelope' });
    const fetchChallenge = vi.fn(async (accessible: boolean) => (accessible ? plain : puzzle));
    const el = container();
    const handle = renderAtlasCaptcha(el, { fetchChallenge, workers: false });
    await vi.waitFor(() => expect(el.querySelector('[data-atlas-captcha-alternative]')).not.toBeNull());
    el.querySelector<HTMLButtonElement>('[data-atlas-captcha-alternative]')!.click();
    const sol = decode(await handle.token);
    expect(sol).toMatchObject({ t: 'accessible-envelope', n: 77 });
    expect(sol.sel).toBeUndefined();
    expect(fetchChallenge.mock.calls.map((a) => a[0])).toEqual([false, true]);
  });

  it('removing the widget rejects its token', async () => {
    const c = await makeChallenge(4990);
    const el = container();
    const handle = renderAtlasCaptcha(el, { fetchChallenge: async () => c, workers: false });
    handle.remove();
    await expect(handle.token).rejects.toThrow();
  });

  it('is a renderable provider for the prebuilt forms, fetching from the flow’s challengeUrl', async () => {
    expect(isRenderableCaptcha('atlas')).toBe(true);
    const c = await makeChallenge(555);
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(c), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    const url = 'https://fapi.example.com/v1/client/captcha/challenge?flow=signUp&publishable_key=pk_test_x';
    const handle = renderCaptchaWidget(
      { enabled: true, provider: 'atlas', widget: 'invisible', challengeUrl: url },
      container(),
      { atlas: { workers: false } },
    );
    expect(decode(await handle.token)).toMatchObject({ n: 555 });
    expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ method: 'GET' }));
  });
});

describe('Atlas captcha labels from a form catalog', () => {
  it('maps catalog keys to labels and keeps English for unknown or echoed keys', () => {
    expect(
      atlasCaptchaLabels({ 'captcha.puzzleTile': 'Bild {n}', 'captcha.puzzleConfirm': 'Bestätigen' }),
    ).toEqual({ tile: 'Bild {n}', confirm: 'Bestätigen' });
    // A translator that echoes an unknown key back.
    expect(atlasCaptchaLabels((key) => key)).toEqual({});
    expect(atlasCaptchaLabels(undefined)).toEqual({});
  });

  it('the shared controller draws the puzzle in the form’s language', async () => {
    const c = await makeChallenge(21, {
      interactive: { kind: 'match_shapes', example: TILE, tiles: Array(9).fill(TILE) },
      accessible_alternative: true,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(c), { status: 200 })));
    const catalog: Record<string, string> = {
      'captcha.puzzlePrompt': 'Wähle alle Bilder mit derselben Form.',
      'captcha.puzzleTile': 'Bild {n}',
      'captcha.puzzleConfirm': 'Bestätigen',
    };
    const controller = createCaptchaController(
      {
        flow: { enabled: true, provider: 'atlas', challengeUrl: 'https://fapi.example.com/v1/client/captcha/challenge?flow=signUp' },
        active: true,
      },
      { atlasLabels: () => atlasCaptchaLabels(catalog) },
    );
    const el = container();
    controller.attach(el);
    await vi.waitFor(() => expect(el.querySelectorAll('[data-atlas-captcha-tile]')).toHaveLength(9));
    expect(el.textContent).toContain('Wähle alle Bilder mit derselben Form.');
    expect(el.querySelector('[data-atlas-captcha-tile]')!.getAttribute('aria-label')).toBe('Bild 1');
    expect(el.querySelector('[data-atlas-captcha-confirm]')!.textContent).toBe('Bestätigen');
    controller.destroy();
  });
});
