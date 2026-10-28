import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { AtlasBackend } from './verify';
import { createTestIssuer } from './testing';
import {
  auth0LegacyIssuer,
  clerkFrontendApiFromPublishableKey,
  clerkLegacyIssuer,
  descopeLegacyIssuer,
  kindeLegacyIssuer,
  oktaLegacyIssuer,
} from './legacy-issuer-presets';
import type { LegacyIssuer } from './legacy-issuers';

/**
 * Each preset against tokens shaped like the vendor's own (issuer, key-set
 * path, claims), with the key set served at the URL the preset derives, so a
 * wrong JWKS path or issuer fails the test.
 */
async function vendor(jwksUrl: string) {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const fetchImpl = (async (url: string | URL | Request) =>
    String(url) === jwksUrl
      ? new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
      : new Response('not found', { status: 404 })) as typeof fetch;
  const mint = (claims: Record<string, unknown>, opts: { iss: string; aud?: string; sub?: string; exp?: number }) => {
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: 'JWT' })
      .setIssuer(opts.iss)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? Math.floor(Date.now() / 1000) + 60);
    if (opts.sub) jwt = jwt.setSubject(opts.sub);
    if (opts.aud) jwt = jwt.setAudience(opts.aud);
    return jwt.sign(privateKey);
  };
  return { fetchImpl, mint };
}

async function backendFor(issuers: LegacyIssuer[], fetchImpl: typeof fetch) {
  const atlas = await createTestIssuer();
  return new AtlasBackend({ jwks: atlas.jwks, issuer: atlas.issuer, fetchImpl, legacyIssuers: issuers });
}

const until = () => Date.now() + 3_600_000;
const map = (table: Record<string, string>) => (sub: string) => table[sub] ?? null;

describe('clerkLegacyIssuer', () => {
  // pk_test_ + base64("clerk.example.com$")
  const pk = `pk_test_${Buffer.from('clerk.example.com$').toString('base64')}`;

  it('decodes the Frontend API host from a publishable key', () => {
    expect(clerkFrontendApiFromPublishableKey(pk)).toBe('clerk.example.com');
    expect(clerkFrontendApiFromPublishableKey(`pk_live_${Buffer.from('accounts.example.dev$').toString('base64')}`)).toBe(
      'accounts.example.dev',
    );
    expect(clerkFrontendApiFromPublishableKey('sk_test_abc')).toBeNull();
    expect(clerkFrontendApiFromPublishableKey(`pk_test_${Buffer.from('no-dollar').toString('base64')}`)).toBeNull();
  });

  it('accepts a v2 session token, checks azp, refuses pending sessions', async () => {
    const v = await vendor('https://clerk.example.com/.well-known/jwks.json');
    const backend = await backendFor(
      clerkLegacyIssuer({
        publishableKey: pk,
        until: until(),
        authorizedParties: ['https://app.example.com'],
        resolveSubject: map({ user_2abc: 'user_atlas_1' }),
      }),
      v.fetchImpl,
    );
    const claims = { azp: 'https://app.example.com', sid: 'sess_2xyz', v: 2, o: { id: 'org_1', rol: 'admin', slg: 'acme' }, fva: [5, -1] };
    const ok = await backend.verify(await v.mint(claims, { iss: 'https://clerk.example.com', sub: 'user_2abc' }));
    expect(ok.ok && ok.claims.sub).toBe('user_atlas_1');
    expect(ok.ok && ok.claims.legacy).toEqual({ kind: 'clerk', issuer: 'https://clerk.example.com', sub: 'user_2abc' });

    const foreignParty = await v.mint({ ...claims, azp: 'https://evil.example' }, { iss: 'https://clerk.example.com', sub: 'user_2abc' });
    expect((await backend.verify(foreignParty)).ok).toBe(false);
    const pending = await v.mint({ ...claims, sts: 'pending' }, { iss: 'https://clerk.example.com', sub: 'user_2abc' });
    expect((await backend.verify(pending)).ok).toBe(false);
  });
});

describe('auth0LegacyIssuer', () => {
  it('uses the trailing-slash issuer and requires the audience', async () => {
    const v = await vendor('https://acme.us.auth0.com/.well-known/jwks.json');
    const backend = await backendFor(
      auth0LegacyIssuer({
        domain: 'acme.us.auth0.com',
        audience: 'https://api.acme.example',
        until: until(),
        resolveSubject: map({ 'auth0|64f0c0ffee': 'user_atlas_2' }),
      }),
      v.fetchImpl,
    );
    const token = await v.mint(
      { scope: 'openid profile', azp: 'client123' },
      { iss: 'https://acme.us.auth0.com/', aud: 'https://api.acme.example', sub: 'auth0|64f0c0ffee' },
    );
    const r = await backend.verify(token);
    expect(r.ok && r.claims.sub).toBe('user_atlas_2');
    const otherApi = await v.mint({}, { iss: 'https://acme.us.auth0.com/', aud: 'https://other', sub: 'auth0|64f0c0ffee' });
    expect((await backend.verify(otherApi)).ok).toBe(false);
  });
});

describe('oktaLegacyIssuer', () => {
  it('maps an access token through uid (sub is the login)', async () => {
    const v = await vendor('https://acme.okta.com/oauth2/default/v1/keys');
    const backend = await backendFor(
      oktaLegacyIssuer({ domain: 'https://acme.okta.com', until: until(), resolveSubject: map({ '00u1abcdEFGH': 'user_atlas_3' }) }),
      v.fetchImpl,
    );
    const token = await v.mint(
      { ver: 1, jti: 'AT.x', cid: '0oa1', uid: '00u1abcdEFGH', scp: ['openid'] },
      { iss: 'https://acme.okta.com/oauth2/default', aud: 'api://default', sub: 'jane@example.com' },
    );
    const r = await backend.verify(token);
    expect(r.ok && r.claims.sub).toBe('user_atlas_3');
    expect(r.ok && r.claims.external_id).toBe('00u1abcdEFGH');
    // No uid: refused rather than falling back to the login.
    const noUid = await v.mint({ ver: 1 }, { iss: 'https://acme.okta.com/oauth2/default', aud: 'api://default', sub: '00u1abcdEFGH' });
    expect((await backend.verify(noUid)).ok).toBe(false);
  });

  it('accepts ID tokens with sub = user id and needs their audience', async () => {
    expect(() => oktaLegacyIssuer({ domain: 'acme.okta.com', token: 'id', until: until() })).toThrow(/audience/);
    const v = await vendor('https://acme.okta.com/oauth2/aus9/v1/keys');
    const backend = await backendFor(
      oktaLegacyIssuer({
        domain: 'acme.okta.com',
        authorizationServerId: 'aus9',
        token: 'id',
        audience: '0oaclient',
        until: until(),
        resolveSubject: map({ '00u9': 'user_atlas_9' }),
      }),
      v.fetchImpl,
    );
    const r = await backend.verify(await v.mint({}, { iss: 'https://acme.okta.com/oauth2/aus9', aud: '0oaclient', sub: '00u9' }));
    expect(r.ok && r.claims.sub).toBe('user_atlas_9');
  });
});

describe('kindeLegacyIssuer', () => {
  it('verifies against /.well-known/jwks', async () => {
    const v = await vendor('https://acme.kinde.com/.well-known/jwks');
    const backend = await backendFor(
      kindeLegacyIssuer({ issuerUrl: 'https://acme.kinde.com/', until: until(), resolveSubject: map({ kp_0a1b2c: 'user_atlas_4' }) }),
      v.fetchImpl,
    );
    const token = await v.mint(
      { org_code: 'org_123', permissions: ['read:x'], roles: [{ id: 'r1', key: 'admin', name: 'Admin' }] },
      { iss: 'https://acme.kinde.com', sub: 'kp_0a1b2c' },
    );
    const r = await backend.verify(token);
    expect(r.ok && r.claims.sub).toBe('user_atlas_4');
  });
});

describe('descopeLegacyIssuer', () => {
  const projectId = 'P2abcdefghijklmnopqrstuvwxyz';

  it('accepts both issuer shapes and refuses refresh tokens', async () => {
    const v = await vendor(`https://api.descope.com/v2/keys/${projectId}`);
    const backend = await backendFor(
      descopeLegacyIssuer({ projectId, until: until(), resolveSubject: map({ U2xyz: 'user_atlas_5' }) }),
      v.fetchImpl,
    );
    const claims = { drn: 'DS', amr: ['pwd'], tenants: { T1: { roles: ['admin'], permissions: [] } } };
    for (const iss of [`https://api.descope.com/${projectId}`, projectId]) {
      const r = await backend.verify(await v.mint(claims, { iss, sub: 'U2xyz' }));
      expect(r.ok && r.claims.sub).toBe('user_atlas_5');
    }
    const refresh = await v.mint({ ...claims, drn: 'DSR' }, { iss: projectId, sub: 'U2xyz' });
    expect((await backend.verify(refresh)).ok).toBe(false);
  });

  it('rejects a malformed project id', () => {
    expect(() => descopeLegacyIssuer({ projectId: '../evil', until: until() })).toThrow(/project id/);
  });
});
