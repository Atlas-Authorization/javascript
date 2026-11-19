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

describe('ATLAS_PREVIOUS_ISSUERS', () => {
  it('parses comma/space separated values, trimmed, empties ignored', async () => {
    const { parseIssuerList } = await import('./verify');
    expect(parseIssuerList(' https://a.example.com, https://b.example.com  ,, ')).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(parseIssuerList('https://a.example.com https://b.example.com')).toHaveLength(2);
    expect(parseIssuerList(undefined)).toEqual([]);
  });

  it('is used when the option is not passed, and an explicit option wins', async () => {
    const fx = await createTestIssuer({ issuer: 'https://app.example.com/__atlas' });
    const old = 'https://bright-fox-fapi.example.test';
    const before = await fx.mintSession({ sub: 'user_1', iss: old });
    const prev = process.env.ATLAS_PREVIOUS_ISSUERS;
    process.env.ATLAS_PREVIOUS_ISSUERS = ` ${old} , `;
    try {
      const fromEnv = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, fetchImpl: forbiddenFetch });
      const explicit = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, previousIssuers: [], fetchImpl: forbiddenFetch });
      expect((await fromEnv.verify(before)).ok).toBe(true);
      expect((await explicit.verify(before)).ok).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ATLAS_PREVIOUS_ISSUERS;
      else process.env.ATLAS_PREVIOUS_ISSUERS = prev;
    }
  });
});

describe('tokenUse: template', () => {
  it('accepts a template token for the right audience and refuses a session token, a wrong audience and the reverse', async () => {
    const fx = await createTestIssuer();
    const tpl = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, tokenUse: 'template', audience: 'billing-api', fetchImpl: forbiddenFetch });
    const session = new AtlasBackend({ jwks: fx.jwks, issuer: fx.issuer, fetchImpl: forbiddenFetch });

    const ok = await fx.mintSession({ token_use: 'template', aud: 'billing-api' });
    const wrongAud = await fx.mintSession({ token_use: 'template', aud: 'other-api' });
    const sess = await fx.mintSession({ aud: 'billing-api' });

    const r = await tpl.verify(ok);
    expect(r.ok).toBe(true);
    expect((await tpl.verify(wrongAud)).ok).toBe(false);
    expect((await tpl.verify(sess)).ok).toBe(false);
    expect((await session.verify(ok)).ok).toBe(false);
  });
});
