import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestIssuer } from './testing';
import { AtlasBackend } from './verify';
import { AtlasConfigError } from './mount';
import { createAccessTokenVerifier } from './oauth-resource';
import { AtlasExternalIdWriteError, syncLocalUser } from './sync-local-user';

afterEach(() => vi.unstubAllEnvs());

describe('AtlasBackend env defaults (secret key, API origin)', () => {
  it('verifyOnline works with only ATLAS_SECRET_KEY set, against the default API origin', async () => {
    vi.stubEnv('ATLAS_SECRET_KEY', 'sk_test_env');
    const issuer = await createTestIssuer();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ verified: true }), { status: 200 })) as unknown as typeof fetch;
    const backend = new AtlasBackend({ issuer: issuer.issuer, jwks: issuer.jwks, fetchImpl });
    expect((await backend.verifyOnline(await issuer.mintSession({ sub: 'u' }))).ok).toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(url).toBe('https://api.atlasauth.net/v1/tokens/verify');
    expect((init as RequestInit).headers).toMatchObject({ authorization: 'Bearer sk_test_env' });
  });

  it('ATLAS_API_URL moves the origin', async () => {
    vi.stubEnv('ATLAS_SECRET_KEY', 'sk_test_env');
    vi.stubEnv('ATLAS_API_URL', 'https://api.eu.example.com/');
    const issuer = await createTestIssuer();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ verified: true }), { status: 200 })) as unknown as typeof fetch;
    const backend = new AtlasBackend({ issuer: issuer.issuer, jwks: issuer.jwks, fetchImpl });
    await backend.verifyOnline(await issuer.mintSession({ sub: 'u' }));
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe('https://api.eu.example.com/v1/tokens/verify');
  });

  it('without a key it throws a typed config error naming the option', async () => {
    vi.stubEnv('ATLAS_SECRET_KEY', '');
    const issuer = await createTestIssuer();
    const backend = new AtlasBackend({ issuer: issuer.issuer, jwks: issuer.jwks });
    const err = await backend.verifyOnline(await issuer.mintSession({ sub: 'u' })).catch((e) => e);
    expect(err).toBeInstanceOf(AtlasConfigError);
    expect(err).toMatchObject({ code: 'secret_key_missing', missing: ['secretKey'] });
    expect(err.message).toMatch(/secretKey.*ATLAS_SECRET_KEY/);
  });

  it('warns once when jwksUrl is on another host than the issuer', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const mk = () => new AtlasBackend({ issuer: 'https://app.example.com/__atlas', jwksUrl: 'https://old-fapi.example.net/.well-known/jwks.json' });
    mk();
    mk();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/old-fapi\.example\.net.*app\.example\.com/);
    new AtlasBackend({ issuer: 'https://same.example.com', jwksUrl: 'https://same.example.com/x/jwks.json' });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe('createAccessTokenVerifier previousIssuers + audience list', () => {
  it('accepts the old and the new issuer and either audience, and refuses others', async () => {
    const oldI = await createTestIssuer({ issuer: 'https://old.example.com' } as never);
    const verify = createAccessTokenVerifier({
      issuer: 'https://new.example.com',
      previousIssuers: ['https://old.example.com/'],
      audience: ['urn:api', 'https://app.example.com/api/mcp'],
      jwks: oldI.jwks,
    });
    const mint = (iss: string, aud: string) => oldI.mintSession({ iss, aud, token_use: 'access_token' } as never);
    const r = (t: string) => verify({ headers: { authorization: `Bearer ${t}` } });
    expect((await r(await mint('https://old.example.com', 'urn:api'))).ok).toBe(true);
    expect((await r(await mint('https://new.example.com', 'https://app.example.com/api/mcp'))).ok).toBe(true);
    expect((await r(await mint('https://other.example.com', 'urn:api'))).ok).toBe(false);
    expect((await r(await mint('https://old.example.com', 'urn:nope'))).ok).toBe(false);
  });

  it('polls one revocation feed per audience and refuses a token revoked on either', async () => {
    const issuer = await createTestIssuer();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      if (url.endsWith('/v1/resource_servers')) return new Response(JSON.stringify({ data: [{ id: 'rs_a', identifier: 'urn:a' }, { id: 'rs_b', identifier: 'urn:b' }] }), { status: 200 });
      const dead = url.includes('/rs_b/') ? [{ family_id: null, jti: 'jti_dead', revoked_at: Date.now() }] : [];
      return new Response(JSON.stringify({ data: dead, has_more: false, next_cursor: null, server_time: Date.now() }), { status: 200 });
    }) as unknown as typeof fetch;
    const verify = createAccessTokenVerifier({ issuer: issuer.issuer, audience: ['urn:a', 'urn:b'], jwks: issuer.jwks, revocation: true, secretKey: 'sk_test_x', fetchImpl });
    const mint = (jti: string) => issuer.mintSession({ aud: 'urn:a', jti, token_use: 'access_token' } as never);
    expect((await verify({ headers: { authorization: `Bearer ${await mint('jti_dead')}` } })).ok).toBe(false);
    expect((await verify({ headers: { authorization: `Bearer ${await mint('jti_ok')}` } })).ok).toBe(true);
    expect(urls.some((u) => u.includes('/rs_a/revoked_tokens'))).toBe(true);
    expect(urls.some((u) => u.includes('/rs_b/revoked_tokens'))).toBe(true);
  });
});

describe('syncLocalUser writeExternalId', () => {
  const base = () => {
    const row = { id: 7, sub: 'user_1' as string | null };
    return {
      row,
      opts: {
        findBySub: async () => row,
        findByEmail: async () => null,
        subOf: () => row.sub,
        isLocalEmailVerified: () => true,
        link: async () => row,
        create: async () => row,
        localIdOf: (r: { id: number }) => String(r.id),
        writeExternalId: true,
        externalIdRetry: { delayMs: 1 },
      },
    };
  };

  it('writes the local id once, retrying a transient failure', async () => {
    const { opts } = base();
    const setExternalId = vi.fn().mockRejectedValueOnce(Object.assign(new Error('x'), { status: 503 })).mockResolvedValue({});
    const r = await syncLocalUser({ sub: 'user_1' }, { ...opts, atlas: { users: { setExternalId } } });
    expect(setExternalId).toHaveBeenCalledTimes(2);
    expect(setExternalId).toHaveBeenLastCalledWith('user_1', '7');
    expect(r.externalIdWritten).toBe(true);
  });

  it('skips the write when the token already carries it', async () => {
    const { opts } = base();
    const setExternalId = vi.fn();
    const r = await syncLocalUser({ sub: 'user_1', external_id: '7' }, { ...opts, atlas: { users: { setExternalId } } });
    expect(setExternalId).not.toHaveBeenCalled();
    expect(r.externalIdWritten).toBe(false);
  });

  it('does not retry a permanent 4xx and surfaces the row', async () => {
    const { opts, row } = base();
    const setExternalId = vi.fn().mockRejectedValue(Object.assign(new Error('taken'), { status: 409 }));
    const err = await syncLocalUser({ sub: 'user_1' }, { ...opts, atlas: { users: { setExternalId } } }).catch((e) => e);
    expect(err).toBeInstanceOf(AtlasExternalIdWriteError);
    expect(err.result.user).toBe(row);
    expect(setExternalId).toHaveBeenCalledTimes(1);
  });
});
