import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha256';
import { getHeadlessCaptchaSolver, type AtlasChallenge } from '@atlasauth/js';
import { atlasHeadlessCaptchaSolver, getCaptchaToken, solveAtlasChallengeNative } from './captcha';

const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const challengeFor = (n: number, extra: Partial<AtlasChallenge> = {}): AtlasChallenge => ({
  object: 'captcha_challenge',
  provider: 'atlas',
  token: `env-${n}`,
  algorithm: 'SHA-256',
  salt: 'sé1b2',
  challenge: hex(sha256(new TextEncoder().encode(`sé1b2${n}`))),
  maxnumber: 3000,
  expires_at: new Date(Date.now() + 60_000).toISOString(),
  interactive: null,
  accessible_alternative: false,
  ...extra,
});

describe('solveAtlasChallengeNative', () => {
  it('finds the secret number, including n = 0 and a non-ASCII salt', async () => {
    expect(await solveAtlasChallengeNative(challengeFor(1234))).toBe(1234);
    expect(await solveAtlasChallengeNative(challengeFor(0))).toBe(0);
  });

  it('yields to the event loop between slices', async () => {
    const yieldFn = vi.fn(async () => {});
    expect(await solveAtlasChallengeNative(challengeFor(2500), { sliceMs: 0, yieldFn })).toBe(2500);
    expect(yieldFn).toHaveBeenCalled();
  });

  it('can be cancelled, and fails when no number matches', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(solveAtlasChallengeNative(challengeFor(10), { signal: ac.signal })).rejects.toThrow('cancelled');
    await expect(solveAtlasChallengeNative({ ...challengeFor(5000), maxnumber: 100 })).rejects.toThrow('no solution');
    await expect(solveAtlasChallengeNative({ salt: 'a', challenge: 'xyz', maxnumber: 1 })).rejects.toThrow('bad challenge');
  });
});

describe('getCaptchaToken', () => {
  const decode = (t: string) => JSON.parse(Buffer.from(t.slice('atlas1.'.length), 'base64url').toString('utf8'));

  it('returns the atlas1 token the server verifies', async () => {
    const token = await getCaptchaToken({ provider: 'atlas' }, { fetchChallenge: async () => challengeFor(777) });
    expect(token.startsWith('atlas1.')).toBe(true);
    expect(decode(token)).toMatchObject({ t: 'env-777', n: 777 });
  });

  it('takes the no-picture alternative when the server asks for the picture check', async () => {
    const fetchChallenge = vi.fn(async (accessible: boolean) =>
      accessible ? challengeFor(5) : challengeFor(5, { interactive: { kind: 'match_shapes', example: '', tiles: [] }, accessible_alternative: true }),
    );
    expect(decode(await getCaptchaToken({ provider: 'atlas' }, { fetchChallenge })).n).toBe(5);
    expect(fetchChallenge).toHaveBeenLastCalledWith(true);
    const stuck = async () => challengeFor(5, { interactive: { kind: 'match_shapes', example: '', tiles: [] } });
    await expect(getCaptchaToken({ provider: 'atlas' }, { fetchChallenge: stuck })).rejects.toThrow('picture check');
  });

  it('is installed as the headless solver on import and ignores other providers', async () => {
    expect(getHeadlessCaptchaSolver()).toBe(atlasHeadlessCaptchaSolver);
    expect(await atlasHeadlessCaptchaSolver({ enabled: true, provider: 'turnstile', siteKey: 'k' }, { flow: 'signIn' })).toBeNull();
  });
});
