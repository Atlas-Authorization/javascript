import { describe, expect, it } from 'vitest';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK, type KeyLike } from 'jose';
import {
  buildWwwAuthenticate,
  createAccessTokenVerifier,
  memoryDpopReplayStore,
  protectedResourceMetadata,
  protectedResourceMetadataPath,
  type AccessTokenVerifierOptions,
} from './oauth-resource';

/**
 * Resource-server verification of Atlas-issued OAuth access tokens: audience,
 * scopes, sender constraint, and the exact RFC 6750 / 9728 challenges a client
 * (an MCP client in particular) uses to recover.
 */

const ISSUER = 'https://auth.example.com';
const API = 'https://api.example.com/mcp';
const META = 'https://api.example.com/.well-known/oauth-protected-resource/mcp';

// One issuer key for the whole file: RSA key generation costs a random, sometimes
// long, stretch of CPU (seconds on a loaded machine), and no test here depends on
// a fresh issuer key — the one that needs a foreign key generates its own.
let issuerKey: ReturnType<typeof generateKeyPair> | undefined;

async function setup() {
  const { privateKey, publicKey } = await (issuerKey ??= generateKeyPair('RS256'));
  const pub = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const opts = (o: Partial<AccessTokenVerifierOptions> = {}): AccessTokenVerifierOptions => ({
    issuer: ISSUER,
    audience: API,
    jwks: { keys: [pub] },
    resourceMetadataUrl: META,
    ...o,
  });
  const mint = (claims: Record<string, unknown> = {}, key: KeyLike = privateKey, kid = 'k1') =>
    new SignJWT({ scope: 'tools:read', client_id: 'cli_1', token_use: 'access_token', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer(ISSUER)
      .setSubject('user_1')
      .setAudience((claims.aud as string) ?? API)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key);
  return { opts, mint };
}

const req = (authorization?: string, extra: Record<string, string> = {}) => ({
  method: 'POST',
  url: 'https://api.example.com/mcp?x=1',
  headers: { ...(authorization ? { authorization } : {}), ...extra },
});

async function dpopKey() {
  const { privateKey, publicKey } = await generateKeyPair('ES256');
  const jwk = await exportJWK(publicKey);
  return { privateKey, jwk, jkt: await calculateJwkThumbprint(jwk, 'sha256') };
}

async function ath(token: string) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)));
  return Buffer.from(d).toString('base64url');
}

async function proof(
  k: { privateKey: KeyLike; jwk: JWK },
  token: string,
  o: { htm?: string; htu?: string; jti?: string; iat?: number; ath?: string } = {},
) {
  return new SignJWT({
    htm: o.htm ?? 'POST',
    htu: o.htu ?? 'https://api.example.com/mcp',
    jti: o.jti ?? crypto.randomUUID(),
    ath: o.ath ?? (await ath(token)),
  })
    .setProtectedHeader({ alg: 'ES256', typ: 'dpop+jwt', jwk: k.jwk })
    .setIssuedAt(o.iat ?? Math.floor(Date.now() / 1000))
    .sign(k.privateKey);
}

describe('createAccessTokenVerifier', () => {
  it('accepts a valid token for this API and surfaces subject, client and scopes', async () => {
    const { opts, mint } = await setup();
    const verify = createAccessTokenVerifier(opts({ requiredScopes: ['tools:read'] }));
    const r = await verify(req(`Bearer ${await mint()}`));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.subject).toBe('user_1');
    expect(r.clientId).toBe('cli_1');
    expect(r.scopes).toEqual(['tools:read']);
    expect(r.dpopBound).toBe(false);
  });

  it('answers a missing token with the bare challenge carrying resource_metadata (RFC 6750 §3.1, RFC 9728 §5.1)', async () => {
    const { opts } = await setup();
    const r = await createAccessTokenVerifier(opts({ requiredScopes: ['tools:read'] }))(req());
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(401);
    expect(r.error).toBeNull();
    expect(r.wwwAuthenticate).toBe(`Bearer scope="tools:read", resource_metadata="${META}"`);
    expect(r.wwwAuthenticate).not.toContain('error=');
  });

  it('rejects a malformed Authorization header with 400 invalid_request', async () => {
    const { opts } = await setup();
    const r = await createAccessTokenVerifier(opts())(req('Basic abc'));
    expect(r).toMatchObject({ ok: false, status: 400, error: 'invalid_request' });
  });

  it('rejects a token issued for a different API (RFC 8707 audience)', async () => {
    const { opts, mint } = await setup();
    const r = await createAccessTokenVerifier(opts())(req(`Bearer ${await mint({ aud: 'https://other.example.com' })}`));
    expect(r).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
    if (!r.ok) expect(r.wwwAuthenticate).toContain('error="invalid_token"');
  });

  it('accepts any of several audiences', async () => {
    const { opts, mint } = await setup();
    const verify = createAccessTokenVerifier(opts({ audience: ['https://x.example.com', API] }));
    expect((await verify(req(`Bearer ${await mint()}`))).ok).toBe(true);
  });

  it('rejects a token from another issuer, a wrong key, an expired token, and an ID token', async () => {
    const { opts, mint } = await setup();
    const verify = createAccessTokenVerifier(opts());
    const other = await generateKeyPair('RS256');
    expect((await verify(req(`Bearer ${await mint({}, other.privateKey)}`))).ok).toBe(false);
    const wrongIss = await new SignJWT({ token_use: 'access_token' })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer('https://evil.example.com')
      .setAudience(API)
      .setSubject('u')
      .setExpirationTime('5m')
      .sign(other.privateKey);
    expect((await verify(req(`Bearer ${wrongIss}`))).ok).toBe(false);
    const expired = createAccessTokenVerifier(opts({ now: () => Date.now() + 3_600_000 }));
    expect(await expired(req(`Bearer ${await mint()}`))).toMatchObject({ ok: false, error: 'invalid_token' });
    expect(await verify(req(`Bearer ${await mint({ token_use: 'id_token' })}`))).toMatchObject({
      ok: false,
      error: 'invalid_token',
      description: 'The token is not an access token.',
    });
  });

  it('answers missing scopes with 403 insufficient_scope naming every scope needed', async () => {
    const { opts, mint } = await setup();
    const verify = createAccessTokenVerifier(opts({ requiredScopes: ['tools:read'] }));
    const r = await verify(req(`Bearer ${await mint()}`), { requiredScopes: ['tools:write'] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.error).toBe('insufficient_scope');
    expect(r.wwwAuthenticate).toContain('scope="tools:read tools:write"');
    expect(r.wwwAuthenticate).toContain(`resource_metadata="${META}"`);
  });

  it('counts RBAC permissions toward required scopes', async () => {
    const { opts, mint } = await setup();
    const verify = createAccessTokenVerifier(opts({ requiredScopes: ['billing:read'] }));
    expect((await verify(req(`Bearer ${await mint({ permissions: ['billing:read'] })}`))).ok).toBe(true);
  });

  describe('DPoP (RFC 9449)', () => {
    it('accepts a bound token with a matching proof, and the result says it was bound', async () => {
      const { opts, mint } = await setup();
      const k = await dpopKey();
      const token = await mint({ cnf: { jkt: k.jkt } });
      const r = await createAccessTokenVerifier(opts())(req(`DPoP ${token}`, { dpop: await proof(k, token) }));
      expect(r).toMatchObject({ ok: true, dpopBound: true });
    });

    it('never accepts a bound token as a plain Bearer token', async () => {
      const { opts, mint } = await setup();
      const k = await dpopKey();
      const token = await mint({ cnf: { jkt: k.jkt } });
      const r = await createAccessTokenVerifier(opts())(req(`Bearer ${token}`, { dpop: await proof(k, token) }));
      expect(r).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
      if (!r.ok) expect(r.wwwAuthenticate.startsWith('DPoP ')).toBe(true);
    });

    it('rejects a missing proof, a proof from another key, wrong htm/htu/ath, a stale proof, and a replay', async () => {
      const { opts, mint } = await setup();
      const verify = createAccessTokenVerifier(opts({ dpopReplayStore: memoryDpopReplayStore() }));
      const k = await dpopKey();
      const token = await mint({ cnf: { jkt: k.jkt } });
      const bad = async (dpop?: string) => {
        const r = await verify(req(`DPoP ${token}`, dpop ? { dpop } : {}));
        expect(r).toMatchObject({ ok: false, status: 401, error: 'invalid_dpop_proof' });
      };
      await bad();
      await bad(await proof(await dpopKey(), token));
      await bad(await proof(k, token, { htm: 'GET' }));
      await bad(await proof(k, token, { htu: 'https://api.example.com/other' }));
      await bad(await proof(k, token, { ath: 'nope' }));
      await bad(await proof(k, token, { iat: Math.floor(Date.now() / 1000) - 3600 }));
      const once = await proof(k, token, { jti: 'fixed' });
      expect((await verify(req(`DPoP ${token}`, { dpop: once }))).ok).toBe(true);
      await bad(once);
    });

    it('requireDpop refuses an unbound token and challenges with the DPoP scheme', async () => {
      const { opts, mint } = await setup();
      const r = await createAccessTokenVerifier(opts({ requireDpop: true }))(req(`Bearer ${await mint()}`));
      expect(r).toMatchObject({ ok: false, status: 401 });
      if (!r.ok) expect(r.wwwAuthenticate).toMatch(/^DPoP .*algs="/);
    });

    it('resolves a path-only request URL against publicOrigin for htu', async () => {
      const { opts, mint } = await setup();
      const k = await dpopKey();
      const token = await mint({ cnf: { jkt: k.jkt } });
      // A fixed clock: the proof's iat and the verifier's "now" are the same
      // instant however long the machine takes between minting and verifying.
      const at = Date.now();
      const verify = createAccessTokenVerifier(opts({ publicOrigin: 'https://api.example.com', now: () => at }));
      const dpop = await proof(k, token, { iat: Math.floor(at / 1000) });
      const r = await verify({ method: 'POST', url: '/mcp', headers: { authorization: `DPoP ${token}`, dpop } });
      expect(r.ok).toBe(true);
    });
  });

  it('reads headers from a Fetch Headers object too', async () => {
    const { opts, mint } = await setup();
    const headers = new Headers({ authorization: `Bearer ${await mint()}` });
    expect((await createAccessTokenVerifier(opts())({ method: 'GET', url: API, headers })).ok).toBe(true);
  });

  it('refuses ambiguous key configuration', () => {
    expect(() => createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [] }, jwksUrl: 'https://x' })).toThrow();
  });
});

describe('challenge + metadata helpers', () => {
  it('escapes quoted values in WWW-Authenticate', () => {
    expect(buildWwwAuthenticate({ realm: 'a"b', error: 'invalid_token', description: 'x\\y' })).toBe(
      'Bearer realm="a\\"b", error="invalid_token", error_description="x\\\\y"',
    );
  });

  it('builds the RFC 9728 document and its path-inserted well-known location', () => {
    const doc = protectedResourceMetadata({
      resource: API,
      issuer: `${ISSUER}/`,
      scopesSupported: ['tools:read'],
      dpopBoundAccessTokensRequired: true,
    });
    expect(doc).toMatchObject({
      resource: API,
      authorization_servers: [ISSUER],
      bearer_methods_supported: ['header'],
      scopes_supported: ['tools:read'],
      dpop_bound_access_tokens_required: true,
    });
    expect(protectedResourceMetadataPath(API)).toBe('/.well-known/oauth-protected-resource/mcp');
    expect(protectedResourceMetadataPath('https://api.example.com')).toBe('/.well-known/oauth-protected-resource');
  });
});
