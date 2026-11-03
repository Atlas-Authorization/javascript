/**
 * Wallet-side helpers for Atlas verifiable credentials (OpenID4VCI / OpenID4VP,
 * SD-JWT VC): redeem a credential offer, hold the credential with its device
 * key, and build a selective presentation. For web wallets, tests and demos.
 * Uses WebCrypto (ES256) only. mdoc credentials are received as-is
 * (`format: 'mso_mdoc'`); building an mdoc DeviceResponse is a native-wallet job.
 */

export interface CredentialOffer {
  credential_issuer: string;
  credential_configuration_ids: string[];
  grants?: Record<string, { 'pre-authorized_code'?: string; tx_code?: { length?: number } }>;
}

const PRE_AUTH = 'urn:ietf:params:oauth:grant-type:pre-authorized_code';

/** The offer inside an `openid-credential-offer://` link (or an https link carrying `credential_offer`). */
export function parseCredentialOffer(link: string): CredentialOffer {
  const raw = new URL(link).searchParams.get('credential_offer');
  if (!raw) throw new Error('The link does not carry a credential_offer.');
  const offer = JSON.parse(raw) as CredentialOffer;
  if (typeof offer.credential_issuer !== 'string' || !Array.isArray(offer.credential_configuration_ids)) {
    throw new Error('Malformed credential offer.');
  }
  return offer;
}

const enc = new TextEncoder();
const b64u = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = '';
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const b64uJson = (v: unknown) => b64u(enc.encode(JSON.stringify(v)));

export interface HolderKey {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

/** A fresh P-256 device key. */
export async function generateHolderKey(): Promise<HolderKey> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const publicJwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
  return { privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey), publicJwk: { ...publicJwk, alg: 'ES256' } };
}

async function signJwt(header: Record<string, unknown>, payload: Record<string, unknown>, privateJwk: JsonWebKey): Promise<string> {
  const key = await crypto.subtle.importKey('jwk', privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const input = `${b64uJson({ alg: 'ES256', ...header })}.${b64uJson(payload)}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(input));
  return `${input}.${b64u(sig)}`;
}

export interface ReceivedCredential extends HolderKey {
  credential: string;
  format: 'dc+sd-jwt' | 'mso_mdoc';
}

async function json<T>(res: Response): Promise<T> {
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; error_description?: string };
  if (!res.ok) throw new Error(body.error_description ?? body.error ?? `Request failed (${res.status}).`);
  return body;
}

/** Redeem an offer (pre-authorized code flow) and receive the credential bound to a new device key. */
export async function receiveCredential(
  offer: CredentialOffer,
  opts: { txCode?: string; fetch?: typeof fetch; key?: HolderKey; configurationId?: string } = {},
): Promise<ReceivedCredential> {
  const f = opts.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const code = offer.grants?.[PRE_AUTH]?.['pre-authorized_code'];
  if (!code) throw new Error('The offer has no pre-authorized code.');
  const issuer = offer.credential_issuer.replace(/\/$/, '');
  const meta = await json<{ credential_endpoint: string; authorization_servers?: string[]; credential_configurations_supported?: Record<string, { format?: string }> }>(
    await f(`${issuer}/.well-known/openid-credential-issuer`),
  );
  const asBase = (meta.authorization_servers?.[0] ?? issuer).replace(/\/$/, '');
  const as = await json<{ token_endpoint: string }>(await f(`${asBase}/.well-known/oauth-authorization-server`));
  const configurationId = opts.configurationId ?? offer.credential_configuration_ids[0]!;

  const token = await json<{ access_token: string; c_nonce?: string }>(
    await f(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: PRE_AUTH, 'pre-authorized_code': code, ...(opts.txCode ? { tx_code: opts.txCode } : {}) }).toString(),
    }),
  );

  const key = opts.key ?? (await generateHolderKey());
  const proof = await signJwt(
    { typ: 'openid4vci-proof+jwt', jwk: { kty: key.publicJwk.kty, crv: key.publicJwk.crv, x: key.publicJwk.x, y: key.publicJwk.y, alg: 'ES256' } },
    { aud: issuer, iat: Math.floor(Date.now() / 1000), nonce: token.c_nonce },
    key.privateJwk,
  );
  const issued = await json<{ credential: string; format?: 'dc+sd-jwt' | 'mso_mdoc' }>(
    await f(meta.credential_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token.access_token}` },
      body: JSON.stringify({ credential_configuration_id: configurationId, proof: { proof_type: 'jwt', jwt: proof } }),
    }),
  );
  return { ...key, credential: issued.credential, format: issued.format ?? (meta.credential_configurations_supported?.[configurationId]?.format as 'dc+sd-jwt') ?? 'dc+sd-jwt' };
}

/**
 * Build an SD-JWT VC presentation revealing only the claims in `reveal`, with a
 * key-binding JWT over `aud` and `nonce` (from the verifier's request object).
 */
export async function presentSdJwt(input: { credential: string; reveal: string[]; aud: string; nonce: string; privateJwk: JsonWebKey }): Promise<string> {
  const [jwt, ...rest] = input.credential.split('~').filter(Boolean);
  if (!jwt) throw new Error('Not an SD-JWT credential.');
  const shown = rest.filter((d) => {
    const name = JSON.parse(atob(d.replace(/-/g, '+').replace(/_/g, '/'))) as unknown[];
    return input.reveal.includes(String(name[1]));
  });
  const base = `${[jwt, ...shown].join('~')}~`;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(base));
  const kb = await signJwt(
    { typ: 'kb+jwt' },
    { aud: input.aud, nonce: input.nonce, iat: Math.floor(Date.now() / 1000), sd_hash: b64u(digest) },
    input.privateJwk,
  );
  return `${base}${kb}`;
}
