import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import { buildSignatureBase, ed25519JwkThumbprint, serializeComponentId, signWebBotAuthRequest, verifyWebBotAuth, bytesToBase64Url, type WebBotAuthJwk } from './web-bot-auth';
import { createPinnedFetch, PinnedFetchError } from './web-bot-auth-pinned';

const SEED = new Uint8Array(32).fill(7);
const jwk: WebBotAuthJwk = { kty: 'OKP', crv: 'Ed25519', x: bytesToBase64Url(ed25519.getPublicKey(SEED)) };
const AGENT = 'https://bot.example.com';
const URL_ = 'https://site.example.net/search?q=a%20b&tag=x&tag=y&n=1';
const NOW = 1_735_689_600;
const keys = async () => [jwk];
const sign = (components: Parameters<typeof signWebBotAuthRequest>[0]['components'], headers: Record<string, string> = {}) =>
  signWebBotAuthRequest({ method: 'GET', url: URL_, signatureAgent: AGENT, privateKey: SEED, created: NOW, expires: NOW + 300, components, headers });
const verify = (signed: Record<string, string>, extra: Record<string, string> = {}, url = URL_) =>
  verifyWebBotAuth({ method: 'GET', url, headers: { ...extra, ...signed } }, { getKeys: keys, now: NOW * 1000 });

describe('parameterized covered components (RFC 9421)', () => {
  const r = { method: 'GET', url: URL_, headers: { 'example-dict': 'a=1,   b=2;x=y, c', 'example-list': '(a  b);q=1.50 , c', 'content-type': 'text/plain' } };

  it('serializes identifiers with their parameters', () => {
    expect(serializeComponentId({ name: 'example-dict', params: { key: 'a' } })).toBe('"example-dict";key="a"');
    expect(serializeComponentId({ name: '@query-param', params: { name: 'q' } })).toBe('"@query-param";name="q"');
    expect(serializeComponentId({ name: 'x', params: { sf: true } })).toBe('"x";sf');
  });

  it('builds sf, key, bs and query-param lines', () => {
    const lines = (c: Parameters<typeof buildSignatureBase>[1]) => (buildSignatureBase(r, c, '()') as { base: string }).base.split('\n')[0];
    expect(lines([{ name: 'example-dict', params: { sf: true } }])).toBe('"example-dict";sf: a=1, b=2;x=y, c');
    expect(lines([{ name: 'example-dict', params: { key: 'b' } }])).toBe('"example-dict";key="b": 2;x=y');
    expect(lines([{ name: 'example-dict', params: { key: 'c' } }])).toBe('"example-dict";key="c": ?1');
    expect(lines([{ name: 'example-list', params: { sf: true } }])).toBe('"example-list";sf: (a b);q=1.5, c');
    expect(lines([{ name: 'content-type', params: { bs: true } }])).toBe(`"content-type";bs: :${Buffer.from('text/plain').toString('base64')}:`);
    expect(lines([{ name: '@query-param', params: { name: 'q' } }])).toBe('"@query-param";name="q": a%20b');
  });

  it('fails closed on what it cannot rebuild', () => {
    const run = (c: Parameters<typeof buildSignatureBase>[1]) => buildSignatureBase(r, c, '()');
    expect(run([{ name: 'example-dict', params: { key: 'zzz' } }])).toEqual({ error: 'component_missing' });
    expect(run([{ name: '@query-param', params: { name: 'tag' } }])).toEqual({ error: 'component_missing' });
    expect(run([{ name: '@query-param', params: { name: 'absent' } }])).toEqual({ error: 'component_missing' });
    expect(run([{ name: 'content-type', params: { req: true } }])).toEqual({ error: 'unsupported_component' });
    expect(run([{ name: 'content-type', params: { tr: true } }])).toEqual({ error: 'unsupported_component' });
    expect(run([{ name: '@method', params: { sf: true } }])).toEqual({ error: 'unsupported_component' });
    expect(run([{ name: 'example-dict', params: { sf: true } }, { name: 'example-dict', params: { sf: true } }])).toEqual({ error: 'unsupported_component' });
  });

  it('verifies a signature that covers parameterized components, and rejects it once the covered member changes', async () => {
    const components: Parameters<typeof sign>[0] = ['@authority', { name: 'signature-agent' }, { name: '@query-param', params: { name: 'q' } }, { name: 'x-dict', params: { key: 'a' } }];
    const signed = sign(components, { 'x-dict': 'a=1, b=2' });
    expect(await verify(signed, { 'x-dict': 'a=1, b=2' })).toMatchObject({ verified: true });
    // The uncovered member may change; the covered one may not.
    expect(await verify(signed, { 'x-dict': 'a=1, b=9' })).toMatchObject({ verified: true });
    expect(await verify(signed, { 'x-dict': 'a=2, b=2' })).toMatchObject({ verified: false, reason: 'bad_signature' });
    expect(await verify(signed, { 'x-dict': 'a=1' }, 'https://site.example.net/search?q=other&tag=x&tag=y')).toMatchObject({ verified: false, reason: 'bad_signature' });
  });

  it('reads the directory from the covered dictionary member of Signature-Agent, and from nowhere else', async () => {
    const manual = (agentHeader: string, key: string) => {
      const comps = ['@authority', { name: 'signature-agent', params: { key } }] as const;
      const params = `(${comps.map((c) => serializeComponentId(typeof c === 'string' ? { name: c } : c)).join(' ')});created=${NOW};keyid="${ed25519JwkThumbprint(jwk)}";alg="ed25519";expires=${NOW + 300};tag="web-bot-auth"`;
      const built = buildSignatureBase({ method: 'GET', url: URL_, headers: { 'signature-agent': agentHeader } }, comps as never, params) as { base: string };
      const sig = Buffer.from(ed25519.sign(new TextEncoder().encode(built.base), SEED)).toString('base64');
      return { 'signature-agent': agentHeader, 'signature-input': `sig1=${params}`, signature: `sig1=:${sig}:` };
    };
    // The signature covers member "good"; a different member sits under the label "sig1", where the old lookup would have read it.
    const header = `sig1="https://evil.example.org", good="${AGENT}"`;
    expect(await verify(manual(header, 'good'))).toMatchObject({ verified: true, directory: AGENT });
    // Covering a member the header does not have fails, instead of falling back to the first one.
    expect(await verify(manual(`other="${AGENT}"`, 'sig1'))).toMatchObject({ verified: false, reason: 'bad_signature_agent' });
  });

  it('still requires @authority and signature-agent', async () => {
    expect(await verify(sign(['@authority']))).toMatchObject({ reason: 'components_not_covered' });
    expect(await verify(sign([{ name: 'signature-agent' }]))).toMatchObject({ reason: 'components_not_covered' });
  });
});

describe('ed25519 thumbprint stays the key id', () => {
  it('is stable', () => {
    expect(ed25519JwkThumbprint(jwk)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe('the pinned directory fetch', () => {
  it('refuses a host that resolves to any special-purpose address, before connecting', async () => {
    for (const address of ['127.0.0.1', '10.0.0.5', '169.254.169.254', '::1', 'fd00::1', '::ffff:7f00:1', '100.64.0.1']) {
      const f = createPinnedFetch({ resolve: async () => ['93.184.216.34', address] });
      await expect(f('https://dir.example.com/.well-known/http-message-signatures-directory'), address).rejects.toBeInstanceOf(PinnedFetchError);
    }
  });

  it('refuses plain http, credentials, odd ports, localhost and literal private addresses', async () => {
    const f = createPinnedFetch({ resolve: async () => ['93.184.216.34'] });
    for (const url of ['http://dir.example.com/', 'https://u:p@dir.example.com/', 'https://dir.example.com:8443/', 'https://localhost/', 'https://app.localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://169.254.169.254/latest/meta-data']) {
      await expect(f(url), url).rejects.toBeInstanceOf(PinnedFetchError);
    }
  });

  it('refuses when DNS fails or answers nothing', async () => {
    await expect(createPinnedFetch({ resolve: async () => [] })('https://dir.example.com/')).rejects.toMatchObject({ reason: 'dns_failure' });
    await expect(createPinnedFetch({ resolve: async () => { throw new Error('nx'); } })('https://dir.example.com/')).rejects.toMatchObject({ reason: 'dns_failure' });
  });
});
