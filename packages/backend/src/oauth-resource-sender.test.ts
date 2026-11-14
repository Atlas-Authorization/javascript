import { describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { createAccessTokenVerifier } from './oauth-resource';
import {
  authorizationDetailsOf,
  certificateThumbprint,
  forwardedClientCert,
  matchAuthorizationDetails,
  senderConstraintOf,
  thumbprintsEqual,
  tokenGrants,
} from './oauth-resource-sender';

const ISSUER = 'https://auth.example.com';
const API = 'https://api.example.com';

describe('certificate thumbprints', () => {
  const der = Buffer.from('3082010a0282010100c0ffee', 'hex');
  const pem = `-----BEGIN CERTIFICATE-----\n${der.toString('base64')}\n-----END CERTIFICATE-----`;
  const expected = createHash('sha256').update(der).digest('base64url');

  it('is the base64url SHA-256 of the DER, from a PEM, a URL-encoded PEM or the bytes', async () => {
    expect(await certificateThumbprint(pem)).toBe(expected);
    expect(await certificateThumbprint(encodeURIComponent(pem))).toBe(expected);
    expect(await certificateThumbprint(new Uint8Array(der))).toBe(expected);
    await expect(certificateThumbprint(new Uint8Array())).rejects.toThrow();
  });

  it('compares in constant time', () => {
    expect(thumbprintsEqual('abc', 'abc')).toBe(true);
    expect(thumbprintsEqual('abc', 'abd')).toBe(false);
    expect(thumbprintsEqual('abc', 'abcd')).toBe(false);
  });

  it('reads the forwarded certificate only when the proxy secret is present', async () => {
    const read = forwardedClientCert({ proxySecret: { header: 'x-proxy', value: 's3cret' } });
    expect(await read({ headers: { 'ssl-client-cert': encodeURIComponent(pem), 'x-proxy': 's3cret' } })).toBe(expected);
    expect(await read({ headers: { 'ssl-client-cert': encodeURIComponent(pem) } })).toBeUndefined();
    expect(await read({ headers: { 'ssl-client-cert': encodeURIComponent(pem), 'x-proxy': 'wrong' } })).toBeUndefined();
    const fp = forwardedClientCert({ fingerprintHeader: 'x-fp' });
    const hex = createHash('sha256').update(der).digest('hex');
    expect(await fp({ headers: { 'x-fp': hex } })).toBe(expected);
    expect(await fp({ headers: { 'x-fp': hex.match(/../g)!.join(':') } })).toBe(expected);
    expect(await fp({ headers: { 'x-fp': expected } })).toBe(expected);
    expect(await fp({ headers: {} })).toBeUndefined();
  });
});

describe('authorization details (RFC 9396)', () => {
  const claims = {
    authorization_details: [
      { type: 'payment', actions: ['initiate', 'status'], locations: ['https://api.example.com/pay'], identifier: 'acct-1', amount: { max: 100 } },
      { type: 'account_info', datatypes: ['balance'] },
      { notype: true },
    ],
  };

  it('reads only entries with a type', () => {
    expect(authorizationDetailsOf(claims)).toHaveLength(2);
    expect(authorizationDetailsOf({})).toEqual([]);
  });

  it('needs every requirement covered by one entry of its type', () => {
    expect(matchAuthorizationDetails(claims, { type: 'payment', actions: ['initiate'] })).toMatchObject({ ok: true });
    expect(matchAuthorizationDetails(claims, { type: 'payment', actions: ['initiate', 'refund'] })).toMatchObject({ ok: false });
    expect(matchAuthorizationDetails(claims, { type: 'payment', locations: ['https://api.example.com/pay'], identifier: 'acct-1' })).toMatchObject({ ok: true });
    expect(matchAuthorizationDetails(claims, { type: 'payment', identifier: 'acct-2' })).toMatchObject({ ok: false });
    expect(matchAuthorizationDetails(claims, { type: 'payment', fields: { amount: { max: 100 } } })).toMatchObject({ ok: true });
    expect(matchAuthorizationDetails(claims, { type: 'payment', check: (d) => (d.amount as { max: number }).max >= 500 })).toMatchObject({ ok: false });
    const both = matchAuthorizationDetails(claims, [{ type: 'payment' }, { type: 'account_info', datatypes: ['balance'] }]);
    expect(both).toMatchObject({ ok: true });
    expect((both as { matched: unknown[] }).matched).toHaveLength(2);
    const missing = matchAuthorizationDetails(claims, [{ type: 'payment' }, { type: 'transfer' }]);
    expect(missing).toMatchObject({ ok: false, missing: [{ type: 'transfer' }] });
  });

  it('an entry that omits a restricted list does not cover it', () => {
    expect(matchAuthorizationDetails({ authorization_details: [{ type: 'payment' }] }, { type: 'payment', actions: ['initiate'] })).toMatchObject({ ok: false });
    expect(matchAuthorizationDetails({}, { type: 'payment' })).toMatchObject({ ok: false });
  });
});

describe('token grants', () => {
  it('reads the unified claim and falls back to the older ones', () => {
    expect(tokenGrants({ grants: [{ type: 'machine', id: 'g1', resource: API, scopes: ['a'], exp: 9 }, { type: 'x', id: 'g2', resource: 'r' }] })).toEqual([{ type: 'machine', id: 'g1', resource: API, scopes: ['a'], exp: 9 }]);
    expect(tokenGrants({ aud: API, grant_id: 'g1', grant_type: 'machine', scope: 'a b', constraints: { n: 1 } })).toEqual([{ type: 'machine', id: 'g1', resource: API, scopes: ['a', 'b'], constraints: { n: 1 } }]);
    expect(tokenGrants({ agent_grants: [{ grant_id: 'g', kind: 'tool', resource: 'r', scopes: ['s'] }] })).toEqual([{ type: 'agent', id: 'g', resource: 'r', scopes: ['s'], kind: 'tool' }]);
    expect(tokenGrants({})).toEqual([]);
  });

  it('reports what a token is bound to', () => {
    expect(senderConstraintOf({})).toEqual({ dpop: false, mtls: false });
    expect(senderConstraintOf({ cnf: { jkt: 'k', 'x5t#S256': 'x' } })).toEqual({ dpop: true, mtls: true });
  });
});

describe('the verifier with sender constraints and authorization details', () => {
  async function setup() {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
    const mint = (claims: Record<string, unknown> = {}) =>
      new SignJWT({ scope: 'orders:read', token_use: 'access_token', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(ISSUER)
        .setSubject('mch_1')
        .setAudience(API)
        .setIssuedAt()
        .setExpirationTime('5m')
        .sign(privateKey);
    return { jwk, mint };
  }
  const req = (token: string) => ({ method: 'GET', url: `${API}/orders`, headers: { authorization: `Bearer ${token}` } });

  it('refuses an unbound token where a sender constraint is required, accepts a certificate-bound one from its holder', async () => {
    const { jwk, mint } = await setup();
    const cert = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' });
    const x5t = createHash('sha256').update(cert).digest('base64url');
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [jwk] }, requireSenderConstrained: true, clientCertThumbprint: () => x5t });

    const bare = await verify(req(await mint()));
    expect(bare).toMatchObject({ ok: false, status: 401, error: 'invalid_token' });
    const bound = await verify(req(await mint({ cnf: { 'x5t#S256': x5t } })));
    expect(bound).toMatchObject({ ok: true, mtlsBound: true, dpopBound: false });
    const stolen = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [jwk] }, clientCertThumbprint: () => 'another-certificate' });
    expect(await stolen(req(await mint({ cnf: { 'x5t#S256': x5t } })))).toMatchObject({ ok: false, error: 'invalid_token' });
    const noReader = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [jwk] } });
    expect(await noReader(req(await mint({ cnf: { 'x5t#S256': x5t } })))).toMatchObject({ ok: false, error: 'invalid_token' });
  });

  it('can demand one kind per call', async () => {
    const { jwk, mint } = await setup();
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [jwk] }, clientCertThumbprint: () => 'x' });
    expect(await verify(req(await mint({ cnf: { 'x5t#S256': 'x' } })), { requireSenderConstrained: 'dpop' })).toMatchObject({ ok: false });
    expect(await verify(req(await mint({ cnf: { 'x5t#S256': 'x' } })), { requireSenderConstrained: 'mtls' })).toMatchObject({ ok: true });
    expect(await verify(req(await mint()), { requireSenderConstrained: 'mtls' })).toMatchObject({ ok: false });
  });

  it('answers 403 insufficient_authorization_details when the token does not cover the call', async () => {
    const { jwk, mint } = await setup();
    const verify = createAccessTokenVerifier({ issuer: ISSUER, audience: API, jwks: { keys: [jwk] } });
    const ok = await verify(req(await mint({ authorization_details: [{ type: 'payment', actions: ['initiate'] }] })), { requireAuthorizationDetails: { type: 'payment', actions: ['initiate'] } });
    expect(ok.ok).toBe(true);
    const no = await verify(req(await mint({ authorization_details: [{ type: 'payment', actions: ['status'] }] })), { requireAuthorizationDetails: { type: 'payment', actions: ['initiate'] } });
    expect(no).toMatchObject({ ok: false, status: 403, error: 'insufficient_authorization_details' });
    expect((no as { wwwAuthenticate: string }).wwwAuthenticate).toContain('insufficient_authorization_details');
  });
});
