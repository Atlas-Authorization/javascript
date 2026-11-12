import { bufferToBase64Url } from './passkey';

/**
 * DPoP (RFC 9449) for browsers and agents: a non-extractable ES256 key the page
 * generates once, a proof for every request, and a fetch wrapper that attaches
 * both and answers a server's `DPoP-Nonce` demand. Tokens issued against the
 * proof's key carry `cnf.jkt`, so a copied token is useless without this key.
 */
export interface DpopKeyStore {
  get(): Promise<CryptoKeyPair | undefined>;
  set(pair: CryptoKeyPair): Promise<void>;
}

export interface DpopClientOptions {
  /** Keep the key pair across reloads (a CryptoKey can live in IndexedDB). Default: memory only. */
  store?: DpopKeyStore;
  /** The fetch to wrap. Default: global fetch. */
  fetch?: typeof fetch;
}

export interface DpopClient {
  /** RFC 7638 thumbprint of the public key: the value a bound token carries as `cnf.jkt`. */
  thumbprint(): Promise<string>;
  /** A proof JWT for one request. Pass `accessToken` at resource servers (adds `ath`), none at the token endpoint. */
  proof(method: string, url: string, opts?: { accessToken?: string; nonce?: string }): Promise<string>;
  /** `fetch` that sends `Authorization: DPoP <token>` plus a fresh proof, retrying once on `use_dpop_nonce`. */
  fetch(input: string | URL, init?: RequestInit & { accessToken?: string }): Promise<Response>;
}

const enc = (o: unknown) => bufferToBase64Url(new TextEncoder().encode(JSON.stringify(o)));
const ALG = { name: 'ECDSA', namedCurve: 'P-256' } as const;

// htu is the request URL without query or fragment (RFC 9449 §4.2).
const htuOf = (url: string | URL) => {
  const u = new URL(String(url));
  return `${u.origin}${u.pathname}`;
};

export function createDpopClient(options: DpopClientOptions = {}): DpopClient {
  const doFetch = options.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  let pair: Promise<CryptoKeyPair> | undefined;
  const nonces = new Map<string, string>();

  const keys = () =>
    (pair ??= (async () => {
      const saved = await options.store?.get();
      if (saved) return saved;
      // extractable:false keeps the private key unreadable by script; the public half stays exportable.
      const fresh = await crypto.subtle.generateKey(ALG, false, ['sign', 'verify']);
      await options.store?.set(fresh);
      return fresh;
    })());

  const publicJwk = async () => {
    const { kty, crv, x, y } = (await crypto.subtle.exportKey('jwk', (await keys()).publicKey)) as JsonWebKey;
    return { kty, crv, x, y };
  };

  const thumbprint = async () => {
    // RFC 7638 canonical member order for EC keys.
    const j = await publicJwk();
    const canon = JSON.stringify({ crv: j.crv, kty: j.kty, x: j.x, y: j.y });
    return bufferToBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canon)));
  };

  const proof: DpopClient['proof'] = async (method, url, opts = {}) => {
    const payload: Record<string, unknown> = {
      jti: crypto.randomUUID(),
      htm: method.toUpperCase(),
      htu: htuOf(url),
      iat: Math.floor(Date.now() / 1000),
    };
    if (opts.nonce) payload.nonce = opts.nonce;
    if (opts.accessToken) {
      payload.ath = bufferToBase64Url(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(opts.accessToken)),
      );
    }
    const signingInput = `${enc({ typ: 'dpop+jwt', alg: 'ES256', jwk: await publicJwk() })}.${enc(payload)}`;
    const sig = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      (await keys()).privateKey,
      new TextEncoder().encode(signingInput),
    );
    return `${signingInput}.${bufferToBase64Url(sig)}`;
  };

  const send: DpopClient['fetch'] = async (input, init = {}) => {
    const { accessToken, ...rest } = init;
    const method = rest.method ?? 'GET';
    const origin = new URL(String(input)).origin;
    const attempt = async () => {
      const headers = new Headers(rest.headers);
      headers.set('DPoP', await proof(method, String(input), { accessToken, nonce: nonces.get(origin) }));
      if (accessToken) headers.set('Authorization', `DPoP ${accessToken}`);
      const res = await doFetch(input, { ...rest, headers });
      const next = res.headers.get('DPoP-Nonce');
      if (next) nonces.set(origin, next);
      return { res, next };
    };
    const first = await attempt();
    // RFC 9449 §8/§9: a server that wants a nonce answers 400/401 with DPoP-Nonce; retry once with it.
    if (first.next && (first.res.status === 400 || first.res.status === 401)) return (await attempt()).res;
    return first.res;
  };

  return { thumbprint, proof, fetch: send };
}
