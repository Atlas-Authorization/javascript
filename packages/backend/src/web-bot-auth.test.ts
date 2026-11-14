import { describe, expect, it } from 'vitest';
import { ed25519 } from '@noble/curves/ed25519';
import {
  WebBotAuthDirectoryCache,
  buildSignatureBase,
  bytesToBase64Url,
  createWebBotAuthVerifier,
  decideWebBotAuth,
  ed25519JwkThumbprint,
  normalizeDirectory,
  parseSignatureAgent,
  parseSignatureInput,
  signWebBotAuthRequest,
  verifyWebBotAuth,
  type WebBotAuthJwk,
} from './web-bot-auth';

// RFC 9421 Appendix B.1.4: the Ed25519 test key (also the key the Web Bot Auth drafts use in their examples).
const b64 = (s: string) => Uint8Array.from(Buffer.from(s, 'base64'));
const RFC_SEED = b64('MC4CAQAwBQYDK2VwBCIEIJ+DYvh6SEqVTm50DFtMDoQikTmiCqirVv9mWG9qfSnF').slice(-32);
const RFC_PUB = b64('MCowBQYDK2VwAyEAJrQLj5P/89iXES9+vFgrIy29clF9CC/oPPsw3c5D0bs=').slice(-32);
const RFC_X = 'JrQLj5P_89iXES9-vFgrIy29clF9CC_oPPsw3c5D0bs';

const AGENT = 'https://bot.example.com';
const jwk: WebBotAuthJwk = { kty: 'OKP', crv: 'Ed25519', x: RFC_X };
const KEYID = ed25519JwkThumbprint(jwk);
const URL_ = 'https://site.example.net/pricing?a=1';
const NOW = 1_735_689_600; // epoch seconds, the instant in the drafts' examples

const keys = async () => [jwk];
const req = (h: Record<string, string>, over: { method?: string; url?: string } = {}) => ({ method: over.method ?? 'GET', url: over.url ?? URL_, headers: h });
const sign = (o: Partial<Parameters<typeof signWebBotAuthRequest>[0]> = {}) =>
  signWebBotAuthRequest({ method: 'GET', url: URL_, signatureAgent: AGENT, privateKey: RFC_SEED, created: NOW, expires: NOW + 300, ...o });
const verify = (h: Record<string, string>, o: Partial<Parameters<typeof verifyWebBotAuth>[1]> = {}, r = req(h)) =>
  verifyWebBotAuth(r, { getKeys: keys, now: NOW * 1000, ...o });

describe('RFC 9421 vectors', () => {
  it('the test key is consistent and its thumbprint is the one the Web Bot Auth drafts show', () => {
    expect(bytesToBase64Url(ed25519.getPublicKey(RFC_SEED))).toBe(RFC_X);
    expect(bytesToBase64Url(RFC_PUB)).toBe(RFC_X);
    expect(KEYID).toBe('poqkLGiymh_W0uP6PZFw-dvez3QJT5SolqXBCW38r0U');
  });

  it('B.2.6 (Ed25519): the signature base and the signature are the RFC values', () => {
    const params = '("date" "@method" "@path" "@authority" "content-type" "content-length");created=1618884473;keyid="test-key-ed25519"';
    const built = buildSignatureBase(
      {
        method: 'POST',
        url: 'https://example.com/foo?param=Value&Pet=dog',
        headers: { Host: 'example.com', Date: 'Tue, 20 Apr 2021 02:07:55 GMT', 'Content-Type': 'application/json', 'Content-Length': '18' },
      },
      ['date', '@method', '@path', '@authority', 'content-type', 'content-length'],
      params,
    );
    expect(built).toEqual({
      base: [
        '"date": Tue, 20 Apr 2021 02:07:55 GMT',
        '"@method": POST',
        '"@path": /foo',
        '"@authority": example.com',
        '"content-type": application/json',
        '"content-length": 18',
        `"@signature-params": ${params}`,
      ].join('\n'),
    });
    const sig = ed25519.sign(new TextEncoder().encode((built as { base: string }).base), RFC_SEED);
    expect(Buffer.from(sig).toString('base64')).toBe('wqcAqbmYJ2ji2glfAMaRy4gruYYnx2nEFN2HN6jrnDnQCK1u02Gb04v9EDgwUPiu4A0w6vuQv5lIp5WPpBKRCw==');
  });

  it('derived components follow RFC 9421 section 2.2', () => {
    const r = { method: 'get', url: 'https://EXAMPLE.com:443/a/b?x=1&y=2', headers: {} };
    const out = buildSignatureBase(r, ['@method', '@authority', '@path', '@query', '@scheme', '@target-uri', '@request-target'], '()');
    expect(out).toEqual({
      base: ['"@method": GET', '"@authority": example.com', '"@path": /a/b', '"@query": ?x=1&y=2', '"@scheme": https', '"@target-uri": https://example.com/a/b?x=1&y=2', '"@request-target": /a/b?x=1&y=2', '"@signature-params": ()'].join('\n'),
    });
    expect(buildSignatureBase({ ...r, url: 'https://example.com/p' }, ['@query'], '()')).toEqual({ base: '"@query": ?\n"@signature-params": ()' });
    expect(buildSignatureBase({ ...r, url: 'https://example.com:8443/p' }, ['@authority'], '()')).toEqual({ base: '"@authority": example.com:8443\n"@signature-params": ()' });
  });

  it('refuses unsupported, duplicate and missing components', () => {
    const r = req({});
    expect(buildSignatureBase(r, ['@status'], '()')).toEqual({ error: 'unsupported_component' });
    expect(buildSignatureBase(r, ['@method', '@method'], '()')).toEqual({ error: 'unsupported_component' });
    expect(buildSignatureBase(r, ['Content-Type'], '()')).toEqual({ error: 'unsupported_component' });
    expect(buildSignatureBase(r, ['x-missing'], '()')).toEqual({ error: 'component_missing' });
  });
});

describe('structured field parsing', () => {
  it('reads Signature-Input members and keeps the raw params for the base', () => {
    const h = `sig1=("@authority" "signature-agent");created=${NOW};keyid="${KEYID}";alg="ed25519";expires=${NOW + 5};nonce="a b";tag="web-bot-auth"`;
    const [m] = parseSignatureInput(h)!;
    expect(m!.label).toBe('sig1');
    expect(m!.components.map((c) => c.name)).toEqual(['@authority', 'signature-agent']);
    expect(m!.params).toMatchObject({ created: NOW, keyid: KEYID, alg: 'ed25519', nonce: 'a b', tag: 'web-bot-auth' });
    expect(m!.raw).toBe(h.slice('sig1='.length));
  });
  it('rejects malformed input', () => {
    expect(parseSignatureInput('sig1=("a";created=1')).toBeNull();
    expect(parseSignatureInput('sig1=oops')).toBeNull();
    expect(parseSignatureInput('')).toBeNull();
  });
  it('reads the Signature-Agent forms and refuses unsafe ones', () => {
    expect(parseSignatureAgent('"https://bot.example.com"')).toBe('https://bot.example.com');
    expect(parseSignatureAgent('https://bot.example.com/')).toBe('https://bot.example.com');
    expect(parseSignatureAgent('sig1="https://bot.example.com/agents/a"', 'sig1')).toBe('https://bot.example.com/agents/a');
    expect(parseSignatureAgent('bot.example.com')).toBe('https://bot.example.com');
    expect(parseSignatureAgent('"http://bot.example.com"')).toBeNull();
    expect(parseSignatureAgent('"https://user:pw@bot.example.com"')).toBeNull();
    expect(parseSignatureAgent('"https://bot.example.com/?q=1"')).toBeNull();
    expect(normalizeDirectory('https://Bot.Example.com:443/')).toBe('https://bot.example.com');
  });
});

describe('verifyWebBotAuth', () => {
  it('verifies a signed request and names the directory and key', async () => {
    const r = await verify(sign());
    expect(r).toMatchObject({ signed: true, verified: true, directory: AGENT, keyId: KEYID, label: 'sig1', created: NOW, expires: NOW + 300, nonce: null });
  });

  it('covers extra components', async () => {
    const h = sign({ components: ['@authority', 'signature-agent', '@method', '@path', 'x-trace'], headers: { 'x-trace': 't1' } });
    expect((await verify({ ...h, 'x-trace': 't1' })).verified).toBe(true);
    expect((await verify({ ...h, 'x-trace': 't2' })).reason).toBe('bad_signature');
  });

  it('is unsigned without the headers, and fails on a different authority, path or agent', async () => {
    expect(await verify({})).toEqual({ signed: false, verified: false, reason: 'no_signature' });
    const h = sign({ components: ['@authority', 'signature-agent', '@path'] });
    expect((await verify(h, {}, req(h, { url: 'https://other.example.net/pricing?a=1' }))).reason).toBe('bad_signature');
    expect((await verify(h, {}, req(h, { url: 'https://site.example.net/other' }))).reason).toBe('bad_signature');
    expect((await verify({ ...h, 'signature-agent': '"https://evil.example.com"' })).reason).toBe('bad_signature');
  });

  it('enforces tag, algorithm, coverage and the time window', async () => {
    const h = sign();
    expect((await verify({ ...h, 'signature-input': h['signature-input']!.replace('web-bot-auth', 'other') })).reason).toBe('no_web_bot_auth_signature');
    expect((await verify({ ...h, 'signature-input': h['signature-input']!.replace('alg="ed25519"', 'alg="rsa-pss-sha512"') })).reason).toBe('unsupported_algorithm');
    expect((await verify(sign({ components: ['@authority'] }))).reason).toBe('components_not_covered');
    expect((await verify(sign({ components: ['signature-agent'] }))).reason).toBe('components_not_covered');
    const { 'signature-agent': _drop, ...noAgent } = h;
    expect((await verify(noAgent)).reason).toBe('missing_signature_agent');
    expect((await verify(sign({ created: NOW - 1000, expires: NOW - 500 }))).reason).toBe('expired');
    expect((await verify(sign({ created: NOW + 1000, expires: NOW + 1300 }))).reason).toBe('not_yet_valid');
    expect((await verify(sign({ created: NOW, expires: NOW + 7200 }))).reason).toBe('lifetime_too_long');
    expect((await verify(sign({ created: NOW, expires: NOW }))).reason).toBe('bad_params');
    // a small skew is tolerated, a large one is not
    expect((await verify(sign({ created: NOW + 20, expires: NOW + 320 }))).verified).toBe(true);
    expect((await verify(sign({ created: NOW - 400, expires: NOW - 40 }))).reason).toBe('expired');
  });

  it('refuses a key that is not in the directory, and an unreachable directory', async () => {
    const other = sign({ privateKey: Uint8Array.from({ length: 32 }, (_, i) => 200 - i) });
    expect((await verify(other)).reason).toBe('key_not_found');
    expect((await verify(sign(), { getKeys: async () => null })).reason).toBe('directory_unavailable');
  });

  it('asks for a refresh once when the key is not in the cached copy', async () => {
    const calls: boolean[] = [];
    const r = await verify(sign(), {
      getKeys: async (_u, o) => {
        calls.push(o.refresh);
        return o.refresh ? [jwk] : [];
      },
    });
    expect(r.verified).toBe(true);
    expect(calls).toEqual([false, true]);
  });

  it('rejects a flipped signature byte', async () => {
    const h = sign();
    const m = /^sig1=:(.*):$/.exec(h.signature!)!;
    const bytes = Buffer.from(m[1]!, 'base64');
    bytes[0] = bytes[0]! ^ 1;
    expect((await verify({ ...h, signature: `sig1=:${bytes.toString('base64')}:` })).reason).toBe('bad_signature');
  });

  it('claims the nonce only after the signature verified', async () => {
    const seen = new Set<string>();
    const claim = async (k: string) => (seen.has(k) ? false : (seen.add(k), true));
    const h = sign({ nonce: 'n1' });
    expect((await verify(h, { claimNonce: claim })).verified).toBe(true);
    expect((await verify(h, { claimNonce: claim })).reason).toBe('replayed');
    const forged = { ...h, signature: h.signature!.replace(/.{4}:$/, 'AAAA:') };
    seen.clear();
    expect((await verify(forged, { claimNonce: claim })).verified).toBe(false);
    expect(seen.size).toBe(0);
  });
});

describe('decideWebBotAuth', () => {
  const ok = { signed: true, verified: true, directory: AGENT, keyId: KEYID };
  it('allows, blocks and defaults to unknown; block beats allow', () => {
    expect(decideWebBotAuth(ok)).toMatchObject({ verified: true, tier: 'verified', decision: 'unknown', agent: { directory: AGENT, key_id: KEYID, name: 'bot.example.com' } });
    expect(decideWebBotAuth(ok, { allow: [{ directory: 'bot.example.com', name: 'Example' }] })).toMatchObject({ decision: 'allow', tier: 'allowed', agent: { name: 'Example' } });
    expect(decideWebBotAuth(ok, { block: [{ directory: AGENT }] })).toMatchObject({ decision: 'block', tier: 'blocked' });
    expect(decideWebBotAuth(ok, { allow: [{ directory: AGENT }], block: [{ directory: AGENT }] }).decision).toBe('block');
  });
  it('never trusts or blames a directory it did not verify', () => {
    const d = decideWebBotAuth({ signed: true, verified: false, reason: 'bad_signature', directory: AGENT }, { block: [{ directory: AGENT }] });
    expect(d).toEqual({ verified: false, agent: null, tier: 'unverified', decision: 'unknown', reason: 'bad_signature' });
  });
});

describe('WebBotAuthDirectoryCache', () => {
  it('caches, refreshes at most once per cooldown, and keeps the last good copy on failure', async () => {
    let t = 0;
    let fetches = 0;
    let fail = false;
    const cache = new WebBotAuthDirectoryCache({
      now: () => t,
      fetchJson: async () => {
        fetches++;
        return fail ? null : { keys: [jwk, { kty: 'RSA', n: 'x', e: 'AQAB' }] };
      },
    });
    const u = `${AGENT}/.well-known/http-message-signatures-directory`;
    expect(await cache.getKeys(u, { refresh: false })).toEqual([jwk]);
    await cache.getKeys(u, { refresh: false });
    expect(fetches).toBe(1);
    await cache.getKeys(u, { refresh: true }); // inside the cooldown
    expect(fetches).toBe(1);
    t = 61_000;
    await cache.getKeys(u, { refresh: true });
    expect(fetches).toBe(2);
    t = 61_000 + 11 * 60_000;
    fail = true;
    expect(await cache.getKeys(u, { refresh: false })).toEqual([jwk]);
    expect(fetches).toBe(3);
  });
  it('remembers a failure briefly instead of hammering the directory', async () => {
    let fetches = 0;
    const cache = new WebBotAuthDirectoryCache({ fetchJson: async () => (fetches++, null) });
    expect(await cache.getKeys('https://x.example.com/d', { refresh: false })).toBeNull();
    await cache.getKeys('https://x.example.com/d', { refresh: false });
    expect(fetches).toBe(1);
  });
});

describe('createWebBotAuthVerifier (local)', () => {
  const fakeFetch = (calls: string[]) =>
    (async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/http-message-signatures-directory+json' } });
    }) as unknown as typeof fetch;

  it('verifies against the fetched directory, applies lists and caches', async () => {
    const calls: string[] = [];
    const v = createWebBotAuthVerifier({ fetch: fakeFetch(calls), allow: [{ directory: AGENT, name: 'Example' }], now: () => NOW * 1000 });
    const a = await v.verify(req(sign()));
    expect(a).toMatchObject({ verified: true, decision: 'allow', agent: { name: 'Example', key_id: KEYID } });
    await v.verify(req(sign()));
    expect(calls).toEqual([`${AGENT}/.well-known/http-message-signatures-directory`]);
    expect((await v.verify(req({}))).decision).toBe('unknown');
  });

  it('refuses replays only when asked, and never fetches a private or plain-http directory', async () => {
    const calls: string[] = [];
    const strict = createWebBotAuthVerifier({ fetch: fakeFetch(calls), rejectReplays: true, now: () => NOW * 1000 });
    const h = sign({ nonce: 'abc' });
    expect((await strict.verify(req(h))).verified).toBe(true);
    expect((await strict.verify(req(h))).reason).toBe('replayed');
    const lax = createWebBotAuthVerifier({ fetch: fakeFetch(calls), now: () => NOW * 1000 });
    expect((await lax.verify(req(h))).verified).toBe(true);
    expect((await lax.verify(req(h))).verified).toBe(true);

    const none: string[] = [];
    const guarded = createWebBotAuthVerifier({ fetch: fakeFetch(none), now: () => NOW * 1000 });
    for (const agent of ['https://localhost', 'https://10.0.0.1', 'https://internal', 'https://x.localhost']) {
      expect((await guarded.verify(req(sign({ signatureAgent: agent })))).verified).toBe(false);
    }
    expect(none).toEqual([]);
  });
});
