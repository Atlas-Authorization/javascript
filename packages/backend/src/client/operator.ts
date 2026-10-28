import { openSealedBox as open, generateSealKeyPair as gen } from './sealed-box';

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Operator sign-in (`atlas login`) and token exchange, without a long-lived key.
 *
 *  1. `startOperatorLogin()` runs the RFC 8628 device flow against Atlas's own
 *     sign-in (the operator issuer) with the public `atlas-cli` client: show the
 *     person `verification_uri_complete` / `user_code`, then
 *  2. `pollOperatorLogin()` until it returns the operator access token, then
 *  3. `exchangeOperatorToken()` swaps it (RFC 8693) for a ONE-HOUR Atlas token
 *     bound to one instance (`ins_…`, Backend API) or app/account (`app_…` /
 *     `acct_…`, Platform API), with only the scopes you ask for.
 *
 * Root actions (create an app or instance, mint a key) need a multi-factor
 * sign-in within 5 minutes; otherwise the API answers 403 STEP_UP_REQUIRED.
 */

export interface OperatorConfiguration {
  issuer: string;
  device_authorization_endpoint: string;
  token_endpoint: string;
  client_id: string;
  scope: string;
  token_exchange_endpoint: string;
  token_exchange_audience: 'atlas';
  root_action_max_mfa_age_seconds: number;
  /** Other products that accept Atlas operators (pass one as `audience` to startOperatorLogin). */
  audiences?: string[];
  /** The claims an operator access token carries. */
  access_token_claims?: string[];
}

export interface DeviceAuthorization {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
  refresh_token?: string;
  id_token?: string;
  issued_token_type?: string;
}

export class OAuthFlowError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'OAuthFlowError';
  }
}

interface Opts {
  apiUrl?: string;
  fetch?: typeof fetch;
}

const DEFAULT_API = 'https://api.atlasauth.net';

async function form(fetchImpl: typeof fetch, url: string, body: Record<string, string>): Promise<Record<string, unknown> & { _status: number }> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(body).toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { ...json, _status: res.status };
}

/** GET /v1/operator — where the operator device flow and token exchange live. */
export async function operatorConfiguration(opts: Opts = {}): Promise<OperatorConfiguration> {
  const f = opts.fetch ?? globalThis.fetch;
  const res = await f(`${(opts.apiUrl ?? DEFAULT_API).replace(/\/+$/, '')}/v1/operator`, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new OAuthFlowError('not_configured', 'The operator issuer is not configured on this deployment.', res.status);
  return (await res.json()) as OperatorConfiguration;
}

/**
 * Start an RFC 8628 device flow against any Atlas instance's OAuth server, for a
 * CLI or TV app of your own: `issuer` is the instance's issuer (its Frontend API
 * host, e.g. `https://acme-fapi.atlasauth.net`) and `clientId` an OAuth client
 * with the `urn:ietf:params:oauth:grant-type:device_code` grant. Show the person
 * `verification_uri_complete` (or `verification_uri` + `user_code`), then
 * {@link pollDeviceAuthorization}. A confidential client passes `clientSecret`.
 */
export async function startDeviceAuthorization(
  params: { issuer: string; clientId: string; clientSecret?: string; scope?: string | string[]; resource?: string },
  opts: Pick<Opts, 'fetch'> = {},
): Promise<DeviceAuthorization & { config: DeviceFlowEndpoints }> {
  const base = params.issuer.replace(/\/+$/, '');
  const config: DeviceFlowEndpoints = {
    device_authorization_endpoint: `${base}/oauth2/device_authorization`,
    token_endpoint: `${base}/oauth2/token`,
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
  };
  const scope = Array.isArray(params.scope) ? params.scope.join(' ') : params.scope;
  return startDevice(opts.fetch ?? globalThis.fetch, config, { scope, resource: params.resource });
}

/** Where a device flow runs: {@link startDeviceAuthorization} fills it from the issuer. */
export interface DeviceFlowEndpoints {
  device_authorization_endpoint: string;
  token_endpoint: string;
  client_id: string;
  client_secret?: string;
}

async function startDevice(
  f: typeof fetch,
  config: DeviceFlowEndpoints,
  params: { scope?: string; resource?: string },
): Promise<DeviceAuthorization & { config: DeviceFlowEndpoints }> {
  const out = await form(f, config.device_authorization_endpoint, {
    client_id: config.client_id,
    ...(config.client_secret ? { client_secret: config.client_secret } : {}),
    ...(params.scope ? { scope: params.scope } : {}),
    ...(params.resource ? { resource: params.resource } : {}),
  });
  if (out._status !== 200) throw new OAuthFlowError(String(out.error ?? 'error'), String(out.error_description ?? 'Device authorization failed.'), out._status);
  return { ...(out as unknown as DeviceAuthorization), config };
}

/**
 * Poll the token endpoint until the person approves (resolves the tokens),
 * denies (`access_denied`) or the code expires (`expired_token`); both throw an
 * {@link OAuthFlowError}. Honours `interval` and adds 5 s on each `slow_down`.
 */
export async function pollDeviceAuthorization(
  start: DeviceAuthorization & { config: DeviceFlowEndpoints },
  opts: Pick<Opts, 'fetch'> & { sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<OAuthTokenResponse> {
  const f = opts.fetch ?? globalThis.fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  let interval = Math.max(1, start.interval) * 1000;
  const deadline = Date.now() + start.expires_in * 1000;
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw new OAuthFlowError('aborted', 'Sign-in was cancelled.', 0);
    await sleep(interval);
    const out = await form(f, start.config.token_endpoint, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: start.device_code,
      client_id: start.config.client_id,
      ...(start.config.client_secret ? { client_secret: start.config.client_secret } : {}),
    });
    if (out._status === 200) return out as unknown as OAuthTokenResponse;
    if (out.error === 'authorization_pending') continue;
    if (out.error === 'slow_down') {
      interval += 5000;
      continue;
    }
    throw new OAuthFlowError(String(out.error ?? 'error'), String(out.error_description ?? 'Sign-in failed.'), out._status);
  }
  throw new OAuthFlowError('expired_token', 'The sign-in code expired. Run the login again.', 400);
}

/**
 * Start the device flow. With `audience` (one of the configuration's
 * `audiences`), the operator token is minted FOR that other product
 * (`aud=<audience>`, sent as the RFC 8707 `resource`): hand it to that product;
 * Atlas's own token exchange refuses it.
 */
export async function startOperatorLogin(
  opts: Opts & { config?: OperatorConfiguration; audience?: string } = {},
): Promise<DeviceAuthorization & { config: OperatorConfiguration }> {
  const config = opts.config ?? (await operatorConfiguration(opts));
  const out = await startDevice(opts.fetch ?? globalThis.fetch, config, { scope: config.scope, resource: opts.audience });
  return { ...out, config };
}

/**
 * Poll until the person approves (resolves the operator token), denies or the
 * code expires (throws). Honours `interval` and `slow_down`.
 */
export async function pollOperatorLogin(
  start: DeviceAuthorization & { config: OperatorConfiguration },
  opts: Opts & { sleep?: (ms: number) => Promise<void>; signal?: AbortSignal } = {},
): Promise<OAuthTokenResponse> {
  return pollDeviceAuthorization(start, opts);
}

/** RFC 8693: swap an operator token for a one-hour, resource-bound Atlas token. */
export async function exchangeOperatorToken(
  subjectToken: string,
  params: { resource: string; scope: string | string[] },
  opts: Opts = {},
): Promise<OAuthTokenResponse & { resource: string }> {
  const out = await form(opts.fetch ?? globalThis.fetch, `${(opts.apiUrl ?? DEFAULT_API).replace(/\/+$/, '')}/v1/oauth/token`, {
    grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token: subjectToken,
    subject_token_type: 'urn:ietf:params:oauth:token-type:access_token',
    audience: 'atlas',
    resource: params.resource,
    scope: Array.isArray(params.scope) ? params.scope.join(' ') : params.scope,
  });
  if (out._status !== 200) {
    const err = out.error ?? (Array.isArray(out.errors) ? (out.errors[0] as { code?: string }).code : 'error');
    const msg = out.error_description ?? (Array.isArray(out.errors) ? (out.errors[0] as { message?: string }).message : 'Token exchange failed.');
    throw new OAuthFlowError(String(err), String(msg), out._status);
  }
  return out as unknown as OAuthTokenResponse & { resource: string };
}

/** client_credentials with a partner link's credentials (a partner calling an instance). */
export async function partnerLinkToken(
  clientId: string,
  clientSecret: string,
  opts: Opts & { scope?: string } = {},
): Promise<OAuthTokenResponse> {
  const body: Record<string, string> = { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret };
  if (opts.scope) body.scope = opts.scope;
  const out = await form(opts.fetch ?? globalThis.fetch, `${(opts.apiUrl ?? DEFAULT_API).replace(/\/+$/, '')}/v1/oauth/token`, body);
  if (out._status !== 200) throw new OAuthFlowError(String(out.error ?? 'error'), String(out.error_description ?? 'Token request failed.'), out._status);
  return out as unknown as OAuthTokenResponse;
}

/** A key pair for sealed secret delivery; pass `secretRecipient` to the client. */
export function generateSealKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array; secretRecipient: string } {
  const pair = gen();
  return { ...pair, secretRecipient: `x25519:${toB64(pair.publicKey)}` };
}

/** Open a `sealed_*` field (base64 libsodium sealed box) from an Atlas response. */
export function openSealedSecret(sealedBase64: string, keyPair: { publicKey: Uint8Array; secretKey: Uint8Array }): string {
  return new TextDecoder().decode(open(fromB64(sealedBase64), keyPair.publicKey, keyPair.secretKey));
}

/** POST /v1/keys/revoke_leaked — revoke leaked Atlas credentials (no key needed). */
export async function revokeLeakedKeys(
  secrets: string[],
  opts: Opts & { url?: string } = {},
): Promise<{ results: Array<{ index: number; kind: string; outcome: 'revoked' | 'already_revoked' | 'not_found' }> }> {
  const f = opts.fetch ?? globalThis.fetch;
  const res = await f(`${(opts.apiUrl ?? DEFAULT_API).replace(/\/+$/, '')}/v1/keys/revoke_leaked`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ secrets, ...(opts.url ? { url: opts.url } : {}) }),
  });
  if (!res.ok) throw new OAuthFlowError('request_failed', `revoke_leaked failed (${res.status}).`, res.status);
  return (await res.json()) as { results: Array<{ index: number; kind: string; outcome: 'revoked' | 'already_revoked' | 'not_found' }> };
}
export { sealBox, openSealedBox } from './sealed-box';
