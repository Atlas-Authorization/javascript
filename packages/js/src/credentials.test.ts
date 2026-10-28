import { describe, expect, it } from 'vitest';
import { createPublicKey, createVerify } from 'node:crypto';
import { generateHolderKey, parseCredentialOffer, presentSdJwt, receiveCredential } from './credentials';

const b64uJson = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
const decode = (s: string) => JSON.parse(Buffer.from(s, 'base64url').toString());

describe('wallet helpers', () => {
  it('parses an offer link and refuses a bare link', () => {
    const offer = { credential_issuer: 'https://op.test', credential_configuration_ids: ['vct_1'], grants: {} };
    expect(parseCredentialOffer(`openid-credential-offer://?credential_offer=${encodeURIComponent(JSON.stringify(offer))}`)).toEqual(offer);
    expect(() => parseCredentialOffer('openid-credential-offer://')).toThrow();
  });

  it('redeems an offer: token, proof with the c_nonce signed by the new device key, credential', async () => {
    const seen: { url: string; body?: string; auth?: string }[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push({ url, body: init?.body as string | undefined, auth: (init?.headers as Record<string, string> | undefined)?.authorization });
      if (url.endsWith('/openid-credential-issuer')) return new Response(JSON.stringify({ credential_endpoint: 'https://op.test/vci/credential', authorization_servers: ['https://op.test'] }));
      if (url.endsWith('/oauth-authorization-server')) return new Response(JSON.stringify({ token_endpoint: 'https://op.test/oauth2/token' }));
      if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'vcat_x', c_nonce: 'nonce-1' }));
      return new Response(JSON.stringify({ credential: 'jwt~', format: 'dc+sd-jwt' }));
    }) as unknown as typeof fetch;
    const got = await receiveCredential(
      { credential_issuer: 'https://op.test', credential_configuration_ids: ['vct_1'], grants: { 'urn:ietf:params:oauth:grant-type:pre-authorized_code': { 'pre-authorized_code': 'code-1' } } },
      { fetch: fetchImpl },
    );
    expect(got.credential).toBe('jwt~');
    expect(seen[2]!.body).toContain('pre-authorized_code=code-1');
    expect(seen[3]!.auth).toBe('Bearer vcat_x');
    const proof = JSON.parse(seen[3]!.body!).proof.jwt as string;
    const [h, p, s] = proof.split('.') as [string, string, string];
    expect(decode(h)).toMatchObject({ typ: 'openid4vci-proof+jwt', alg: 'ES256' });
    expect(decode(p)).toMatchObject({ aud: 'https://op.test', nonce: 'nonce-1' });
    const ok = createVerify('sha256').update(`${h}.${p}`).verify({ key: createPublicKey({ key: decode(h).jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });

  it('presents only the chosen disclosures with a key-binding JWT that commits to them', async () => {
    const key = await generateHolderKey();
    const d = (name: string, v: string) => Buffer.from(JSON.stringify(['salt', name, v])).toString('base64url');
    const credential = `${b64uJson({ alg: 'ES256' })}.${b64uJson({ vct: 't' })}.sig~${d('email', 'a@b.c')}~${d('secret', 'x')}~`;
    const vp = await presentSdJwt({ credential, reveal: ['email'], aud: 'redirect_uri:https://op.test/vp/response/r', nonce: 'n1', privateJwk: key.privateJwk });
    const parts = vp.split('~');
    expect(parts).toHaveLength(3); // jwt, one disclosure, kb
    expect(decode(parts[1]!)[1]).toBe('email');
    const [h, p, s] = parts[2]!.split('.') as [string, string, string];
    expect(decode(h).typ).toBe('kb+jwt');
    const base = `${parts[0]}~${parts[1]}~`;
    expect(decode(p)).toMatchObject({ aud: 'redirect_uri:https://op.test/vp/response/r', nonce: 'n1', sd_hash: (await import('node:crypto')).createHash('sha256').update(base).digest('base64url') });
    const ok = createVerify('sha256').update(`${h}.${p}`).verify({ key: createPublicKey({ key: key.publicJwk as never, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'));
    expect(ok).toBe(true);
  });
});
