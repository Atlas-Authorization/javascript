import { describe, expect, it, vi } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend, hasPermission, hasRole } from './verify';
import { JwksCache, REFETCH_INTERVAL_MS, readKid } from './jwks-cache';

const ISSUER = 'https://bright-fox-42.fapi.atlas.dev';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

async function keyring(kid = 'kid-1') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid, alg: 'RS256', use: 'sig' };
  return { privateKey, jwks: { keys: [jwk] }, kid };
}

async function mint(
  privateKey: Parameters<typeof SignJWT.prototype.sign>[0],
  kid: string,
  claims: Record<string, unknown> = {},
  opts: { expiresIn?: string; issuer?: string } = {},
) {
  return new SignJWT({ sid: 'sess_1', sv: 1, mfa: false, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setSubject('user_1')
    .setIssuer(opts.issuer ?? ISSUER)
    .setIssuedAt()
    .setExpirationTime(opts.expiresIn ?? '60s')
    .sign(privateKey as never);
}

const serving = (jwks: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(jwks), { status: 200 })) as unknown as typeof fetch;

const calls = (impl: typeof fetch) =>
  (impl as unknown as ReturnType<typeof vi.fn>).mock.calls.length;

describe('local verification', () => {
  it('accepts a well-formed token', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    const result = await backend.verify(await mint(privateKey, kid));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.claims.sub).toBe('user_1');
  });

  it('refuses a token from a different issuer', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    // Without the issuer check, any Atlas instance's token would be accepted.
    const token = await mint(privateKey, kid, {}, { issuer: 'https://evil.fapi.atlas.dev' });
    expect(await backend.verify(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses an expired token', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
      now: () => Date.now() + 120_000,
    });

    expect(await backend.verify(await mint(privateKey, kid))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  /** §7.3: five seconds either side, matching the server's minting tolerance. */
  it('tolerates a small clock difference', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
      // Three seconds past expiry — inside the allowed skew.
      now: () => Date.now() + 63_000,
    });

    expect((await backend.verify(await mint(privateKey, kid))).ok).toBe(true);
  });

  it('refuses a token signed by an unrelated key', async () => {
    const real = await keyring('kid-1');
    const impostor = await keyring('kid-1');

    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(real.jwks),
    });

    expect(await backend.verify(await mint(impostor.privateKey, 'kid-1'))).toEqual({
      ok: false,
      reason: 'invalid',
    });
  });

  it('reports one reason for every kind of invalid token', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    const wrongIssuer = await backend.verify(
      await mint(privateKey, kid, {}, { issuer: 'https://elsewhere' }),
    );
    const tampered = await backend.verify((await mint(privateKey, kid)).slice(0, -3) + 'aaa');

    // Naming which check failed helps someone refining a forgery far more than
    // it helps a developer debug a real token.
    expect(wrongIssuer).toEqual(tampered);
  });

  it('refuses garbage without attempting a fetch', async () => {
    const fetchImpl = serving({ keys: [] });
    const backend = new AtlasBackend({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl });

    expect(await backend.verify('not-a-jwt')).toEqual({ ok: false, reason: 'malformed' });
    expect(calls(fetchImpl)).toBe(0);
  });
});

/**
 * §13.1 token-confusion guard. An OP access token (token_use:'access_token')
 * and an id_token (carries aud) are signed with the SAME instance key/issuer as
 * a first-party session JWT. A customer backend must reject them so a "Sign in
 * with Atlas" RP can't replay one as a customer session.
 */
describe('token confusion guard (§13.1)', () => {
  const backendFor = async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({ jwksUrl: JWKS_URL, issuer: ISSUER, fetchImpl: serving(jwks) });
    return { backend, privateKey, kid };
  };

  it('rejects an OP access token (token_use:access_token)', async () => {
    const { backend, privateKey, kid } = await backendFor();
    const token = await mint(privateKey, kid, {
      token_use: 'access_token',
      scope: 'openid',
      client_id: 'client_abc',
    });
    expect(await backend.verify(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('rejects an id_token (carries aud)', async () => {
    const { backend, privateKey, kid } = await backendFor();
    const token = await mint(privateKey, kid, { aud: 'client_abc' });
    expect(await backend.verify(token)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('accepts a NEW session token marked token_use:session', async () => {
    const { backend, privateKey, kid } = await backendFor();
    expect((await backend.verify(await mint(privateKey, kid, { token_use: 'session' }))).ok).toBe(true);
  });

  it('accepts a LEGACY session token with no token_use/aud (backward-compat)', async () => {
    const { backend, privateKey, kid } = await backendFor();
    expect((await backend.verify(await mint(privateKey, kid))).ok).toBe(true);
  });
});

/**
 * §7.3 optional azp allowlist: what stops a token issued to one of the
 * customer's apps being replayed against another.
 */
describe('authorized parties', () => {
  it('accepts a token whose azp is allowed', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
      authorizedParties: ['https://app.customer.com'],
    });

    const token = await mint(privateKey, kid, { azp: 'https://app.customer.com' });
    expect((await backend.verify(token)).ok).toBe(true);
  });

  it('refuses a token minted for a different origin', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
      authorizedParties: ['https://app.customer.com'],
    });

    const token = await mint(privateKey, kid, { azp: 'https://other.customer.com' });
    expect(await backend.verify(token)).toEqual({ ok: false, reason: 'unauthorized_party' });
  });

  it('refuses a token with no azp when an allowlist is configured', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
      authorizedParties: ['https://app.customer.com'],
    });

    // A missing claim must not satisfy an allowlist.
    expect(await backend.verify(await mint(privateKey, kid))).toEqual({
      ok: false,
      reason: 'unauthorized_party',
    });
  });

  it('ignores azp entirely when no allowlist is configured', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    const token = await mint(privateKey, kid, { azp: 'https://anywhere' });
    expect((await backend.verify(token)).ok).toBe(true);
  });
});

/**
 * The rate limit is the security property. Without it, an attacker sends tokens
 * carrying random `kid`s and each one forces an outbound request — turning any
 * unauthenticated caller into a traffic amplifier aimed at Atlas, from inside
 * the customer's own infrastructure.
 */
describe('JWKS caching and kid-miss refetch', () => {
  it('fetches once and serves the rest from cache', async () => {
    const { jwks, kid } = await keyring();
    const fetchImpl = serving(jwks);
    const cache = new JwksCache({ url: JWKS_URL, fetchImpl });

    await cache.get(kid);
    await cache.get(kid);
    await cache.get(kid);

    expect(calls(fetchImpl)).toBe(1);
  });

  it('refetches when it sees a kid it does not have', async () => {
    const first = await keyring('kid-old');
    const second = await keyring('kid-new');
    let current = first.jwks;

    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(current), { status: 200 }),
    ) as unknown as typeof fetch;

    let clock = 1_000_000;
    const cache = new JwksCache({ url: JWKS_URL, fetchImpl, now: () => clock });

    await cache.get('kid-old');
    // Key rotated on the server; §7.3 says this must need no deploy.
    current = second.jwks;
    clock += REFETCH_INTERVAL_MS + 1;

    const jwks = await cache.get('kid-new');
    expect(jwks!.keys[0]!.kid).toBe('kid-new');
    expect(cache.lastOutcome).toBe('refetched');
  });

  it('throttles repeated misses to one fetch per minute', async () => {
    const { jwks } = await keyring('kid-1');
    const fetchImpl = serving(jwks);
    let clock = 1_000_000;
    const cache = new JwksCache({ url: JWKS_URL, fetchImpl, now: () => clock });

    await cache.get('kid-1');
    const initial = calls(fetchImpl);

    // A hundred forged kids inside the window.
    for (let i = 0; i < 100; i++) {
      clock += 10;
      await cache.get(`forged-${i}`);
    }

    expect(calls(fetchImpl)).toBe(initial);
    expect(cache.lastOutcome).toBe('throttled');
  });

  it('allows another refetch once the window has passed', async () => {
    const { jwks } = await keyring('kid-1');
    const fetchImpl = serving(jwks);
    let clock = 1_000_000;
    const cache = new JwksCache({ url: JWKS_URL, fetchImpl, now: () => clock });

    await cache.get('kid-1');
    await cache.get('missing');
    const throttled = calls(fetchImpl);

    clock += REFETCH_INTERVAL_MS + 1;
    await cache.get('missing');

    expect(calls(fetchImpl)).toBe(throttled + 1);
  });

  /**
   * A JWKS outage should degrade to "keys rotated in the last minute do not
   * work yet", not "nobody can authenticate".
   */
  it('keeps serving cached keys when a refetch fails', async () => {
    const { jwks, kid } = await keyring();
    let failing = false;
    const fetchImpl = vi.fn(async () => {
      if (failing) throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify(jwks), { status: 200 });
    }) as unknown as typeof fetch;

    let clock = 1_000_000;
    const cache = new JwksCache({ url: JWKS_URL, fetchImpl, now: () => clock });
    await cache.get(kid);

    failing = true;
    clock += REFETCH_INTERVAL_MS + 1;

    const result = await cache.get('unknown-kid');
    expect(result!.keys[0]!.kid).toBe(kid);
    expect(cache.lastOutcome).toBe('failed');
  });

  it('returns null when the very first fetch fails', async () => {
    const dead = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const cache = new JwksCache({ url: JWKS_URL, fetchImpl: dead });
    expect(await cache.get('kid-1')).toBeNull();
  });

  it('rejects a malformed JWKS rather than caching it', async () => {
    const junk = (async () =>
      new Response(JSON.stringify({ nope: true }), { status: 200 })) as unknown as typeof fetch;

    const cache = new JwksCache({ url: JWKS_URL, fetchImpl: junk });
    expect(await cache.get('kid-1')).toBeNull();
  });

  it('reads the kid from a token header', async () => {
    const { privateKey, kid } = await keyring('kid-abc');
    expect(readKid(await mint(privateKey, kid))).toBe('kid-abc');
    expect(readKid('garbage')).toBeUndefined();
  });
});

describe('reading the token off a request', () => {
  const backendFor = async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });
    return { backend, token: await mint(privateKey, kid) };
  };

  it('reads a bearer header', async () => {
    const { backend, token } = await backendFor();
    const result = await backend.authenticateRequest({
      headers: { authorization: `Bearer ${token}` },
    });
    expect(result.ok).toBe(true);
  });

  it('reads the __session cookie', async () => {
    const { backend, token } = await backendFor();
    const result = await backend.authenticateRequest({
      headers: { cookie: `other=x; __session=${token}` },
    });
    expect(result.ok).toBe(true);
  });

  it('prefers the header over the cookie', async () => {
    const { backend, token } = await backendFor();
    // A caller that set the header deliberately should not be overridden by a
    // stale cookie.
    const result = await backend.authenticateRequest({
      headers: { authorization: `Bearer ${token}`, cookie: '__session=stale' },
    });
    expect(result.ok).toBe(true);
  });

  it('works with a Headers-style object', async () => {
    const { backend, token } = await backendFor();
    const result = await backend.authenticateRequest({
      headers: new Headers({ authorization: `Bearer ${token}` }),
    });
    expect(result.ok).toBe(true);
  });

  it('refuses a request carrying nothing', async () => {
    const { backend } = await backendFor();
    expect(await backend.authenticateRequest({ headers: {} })).toEqual({
      ok: false,
      reason: 'malformed',
    });
  });
});

/**
 * §7.3's documented slow path. Using it everywhere makes Atlas's availability
 * the customer's availability, which is what local verification exists to
 * avoid.
 */
describe('verifyOnline', () => {
  const setup = async (online: (input: unknown) => Response) => {
    const { privateKey, jwks, kid } = await keyring();
    const fetchImpl = vi.fn(async (url: string | URL) =>
      String(url).includes('jwks')
        ? new Response(JSON.stringify(jwks), { status: 200 })
        : online(url),
    ) as unknown as typeof fetch;

    return {
      backend: new AtlasBackend({
        jwksUrl: JWKS_URL,
        issuer: ISSUER,
        fetchImpl,
        secretKey: 'sk_test_x',
        bapiBaseUrl: 'https://api.atlas.dev',
      }),
      token: await mint(privateKey, kid),
    };
  };

  it('accepts when Atlas confirms the session is live', async () => {
    const { backend, token } = await setup(
      () => new Response(JSON.stringify({ verified: true }), { status: 200 }),
    );
    expect((await backend.verifyOnline(token)).ok).toBe(true);
  });

  it('refuses when Atlas says the session is revoked', async () => {
    const { backend, token } = await setup(
      () => new Response(JSON.stringify({ verified: false }), { status: 200 }),
    );
    expect((await backend.verifyOnline(token)).ok).toBe(false);
  });

  /**
   * The caller reached for verifyOnline precisely because a stale answer was
   * unacceptable. Returning the local result on an outage would hand them the
   * thing they explicitly refused.
   */
  it('fails closed when Atlas is unreachable', async () => {
    const { backend, token } = await setup(() => {
      throw new Error('ECONNREFUSED');
    });
    expect((await backend.verifyOnline(token)).ok).toBe(false);
  });

  it('refuses locally-invalid tokens without a round trip', async () => {
    const { backend } = await setup(() => new Response('{}', { status: 200 }));
    expect(await backend.verifyOnline('garbage')).toEqual({ ok: false, reason: 'malformed' });
  });

  /**
   * Silently degrading to local verification would give the caller the opposite
   * of what they asked for, so it throws at the call site instead.
   */
  it('throws rather than silently verifying locally when unconfigured', async () => {
    const { privateKey, jwks, kid } = await keyring();
    const backend = new AtlasBackend({
      jwksUrl: JWKS_URL,
      issuer: ISSUER,
      fetchImpl: serving(jwks),
    });

    await expect(backend.verifyOnline(await mint(privateKey, kid))).rejects.toThrow(/secretKey/);
  });
});

describe('permission helpers', () => {
  const claims = {
    iss: ISSUER,
    sub: 'user_1',
    sid: 'sess_1',
    exp: 0,
    // org_permissions are org-scoped, so a real token that carries them always
    // carries the org_id too — the shared authz primitive requires the active
    // org rather than letting a permission count with no organization.
    org_id: 'org_1',
    org_role: 'org:admin',
    org_permissions: ['org:invoices:manage'],
  };

  it('reads permissions straight off the token', () => {
    // The whole point of putting them in the claims: no call to Atlas, and a
    // change lands within one token lifetime — the same bound as revocation.
    expect(hasPermission(claims, 'org:invoices:manage')).toBe(true);
    expect(hasPermission(claims, 'org:billing:manage')).toBe(false);
  });

  it('is safe on a token with no org context', () => {
    expect(hasPermission({ ...claims, org_permissions: undefined }, 'anything')).toBe(false);
  });

  it('checks the role', () => {
    expect(hasRole(claims, 'org:admin')).toBe(true);
    expect(hasRole(claims, 'org:member')).toBe(false);
  });
});
