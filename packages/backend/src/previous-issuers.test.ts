import { describe, expect, it } from 'vitest';
import { AtlasBackend } from './verify';
import { createTestIssuer } from './testing';

/**
 * An instance whose sign-in host moved (a custom domain or a path mount went
 * active) mints under a new issuer; tokens minted just before still carry the
 * old one. `previousIssuers` accepts those for the stated overlap, and nothing
 * else.
 */

const forbiddenFetch = (async () => {
  throw new Error('no network expected');
}) as unknown as typeof fetch;

describe('previousIssuers', () => {
  it('accepts the current and the listed earlier issuers, and no other', async () => {
    const fx = await createTestIssuer({ issuer: 'https://app.example.com/__atlas' });
    const old = 'https://bright-fox-fapi.example.test';
    const strict = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, fetchImpl: forbiddenFetch });
    const overlap = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, previousIssuers: [old], fetchImpl: forbiddenFetch });

    const current = await fx.mintSession({ sub: 'user_1' });
    const before = await fx.mintSession({ sub: 'user_1', iss: old });
    const foreign = await fx.mintSession({ sub: 'user_1', iss: 'https://someone-else.example.test' });

    expect((await strict.verify(current)).ok).toBe(true);
    expect((await strict.verify(before)).ok).toBe(false);
    expect((await overlap.verify(current)).ok).toBe(true);
    expect((await overlap.verify(before)).ok).toBe(true);
    expect((await overlap.verify(foreign)).ok).toBe(false);
  });
});
