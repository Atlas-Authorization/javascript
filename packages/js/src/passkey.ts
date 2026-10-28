/**
 * §5.5 passkeys / WebAuthn — the client half.
 *
 * The browser ceremony (navigator.credentials.create / .get) can only run on the
 * client, so these helpers turn a server `begin` response into the arguments for
 * that ceremony, run it, and produce the `finish` POST body. The caller owns the
 * two HTTP calls (begin → helper → finish), matching the SDK's "the app owns
 * fetch + cookies" model (see native.ts). Everything is injectable via `host`,
 * so it is unit-testable without a real authenticator or DOM.
 *
 * Server routes these pair with:
 *   register: POST /v1/client/me/passkeys/begin → create → /finish
 *   sign in : POST /v1/client/sign_ins/passkey/begin → get → /finish
 */

import type { FapiClient, FapiResponse } from './fapi';

/** The slice of `navigator` these helpers need — injectable for tests. */
export interface WebAuthnHost {
  credentials: {
    create(options: { publicKey: PublicKeyCredentialCreationOptions; mediation?: 'silent' | 'optional' | 'conditional' | 'required'; signal?: AbortSignal }): Promise<Credential | null>;
    get(options: {
      publicKey: PublicKeyCredentialRequestOptions;
      mediation?: 'silent' | 'optional' | 'conditional' | 'required' | 'immediate';
      signal?: AbortSignal;
    }): Promise<Credential | null>;
  };
}

const defaultHost = (): WebAuthnHost => {
  const nav = (globalThis as { navigator?: unknown }).navigator;
  if (!nav || !(nav as { credentials?: unknown }).credentials) {
    throw new Error('WebAuthn is not available in this environment.');
  }
  return nav as unknown as WebAuthnHost;
};

/** ArrayBuffer/Uint8Array → base64url (no padding). */
export function bufferToBase64Url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 1) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (padded or not) → ArrayBuffer. */
export function base64UrlToBuffer(value: string): ArrayBuffer {
  const norm = value.replace(/-/g, '+').replace(/_/g, '/');
  const pad = norm.length % 4 === 0 ? '' : '='.repeat(4 - (norm.length % 4));
  const bin = atob(norm + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

/** True when the runtime supports the WebAuthn API. */
export function passkeysSupported(host?: unknown): boolean {
  const h = host ?? (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential;
  return typeof h !== 'undefined';
}

/** Whether conditional-UI (autofill) discovery is available (best-effort). */
export async function conditionalUiAvailable(): Promise<boolean> {
  const PK = (globalThis as { PublicKeyCredential?: { isConditionalMediationAvailable?: () => Promise<boolean> } })
    .PublicKeyCredential;
  try {
    return (await PK?.isConditionalMediationAvailable?.()) === true;
  } catch {
    return false;
  }
}

/**
 * WebAuthn Level 3 `getClientCapabilities()`: which features this browser supports
 * (`conditionalCreate`, `conditionalGet`, `hybridTransport`, `passkeyPlatformAuthenticator`,
 * `userVerifyingPlatformAuthenticator`, `relatedOrigins`, `signalAllAcceptedCredentials`, ...).
 * Returns an empty object where the method does not exist, so every capability reads as unsupported.
 */
export async function clientCapabilities(): Promise<Record<string, boolean>> {
  const PK = (globalThis as { PublicKeyCredential?: { getClientCapabilities?: () => Promise<Record<string, boolean>> } }).PublicKeyCredential;
  try {
    return (await PK?.getClientCapabilities?.()) ?? {};
  } catch {
    return {};
  }
}

/** Whether the browser can create a passkey automatically after a password sign-in (`mediation: "conditional"` on create). */
export async function conditionalCreateAvailable(): Promise<boolean> {
  return (await clientCapabilities()).conditionalCreate === true;
}

/**
 * A PRF salt: bytes, or a string (encoded as UTF-8). Use a fixed, app-chosen
 * salt per purpose (for example `"myapp:vault-key:v1"`), so the same passkey
 * always yields the same secret for that purpose.
 */
export type PasskeyPrfSalt = ArrayBuffer | ArrayBufferView | string;

/** The salts for one PRF evaluation (`second` asks for a second, independent output). */
export interface PasskeyPrfValues {
  first: PasskeyPrfSalt;
  second?: PasskeyPrfSalt;
}

/**
 * Ask the authenticator for the WebAuthn `prf` extension: a secret derived from
 * the passkey and your salt, which never leaves the browser. Use it to derive a
 * client-side encryption key. `eval` applies to any credential;
 * `evalByCredential` (sign-in only) gives per-credential salts keyed by
 * base64url credential id.
 */
export interface PasskeyPrfRequest {
  eval?: PasskeyPrfValues;
  evalByCredential?: Record<string, PasskeyPrfValues>;
}

/** What the browser answered for `prf`. */
export interface PasskeyPrfResult {
  /** Registration: whether the new passkey supports PRF. */
  enabled?: boolean;
  /** The PRF outputs (32 bytes each), when the authenticator evaluated them. */
  results?: { first: Uint8Array; second?: Uint8Array };
}

/**
 * The client extension results of a ceremony — returned to YOUR code only. They
 * are never sent to Atlas: the `finish` body is unchanged.
 */
export interface PasskeyExtensionResults {
  /** The credential the ceremony used (base64url). */
  credentialId: string;
  prf?: PasskeyPrfResult;
  /** Registration: whether a discoverable credential (passkey) was created, when the browser says. */
  credProps?: { rk?: boolean };
}

/** Options shared by both ceremonies for client extensions. */
export interface PasskeyExtensionOptions {
  /** Request the `prf` extension (the salts are sent to the authenticator, not to Atlas). */
  prf?: PasskeyPrfRequest;
  /** Receives the client extension results (PRF outputs) after a successful ceremony. */
  onExtensionResults?: (results: PasskeyExtensionResults) => void;
}

function saltBytes(salt: PasskeyPrfSalt): Uint8Array {
  if (typeof salt === 'string') return new TextEncoder().encode(salt);
  if (salt instanceof ArrayBuffer) return new Uint8Array(salt);
  return new Uint8Array(salt.buffer, salt.byteOffset, salt.byteLength);
}

function prfValues(v: PasskeyPrfValues): { first: Uint8Array; second?: Uint8Array } {
  return { first: saltBytes(v.first), ...(v.second !== undefined ? { second: saltBytes(v.second) } : {}) };
}

/** The `extensions` member for a ceremony, or undefined when nothing is requested. */
export function passkeyExtensionsInput(
  prf: PasskeyPrfRequest | undefined,
  ceremony: 'create' | 'get',
): Record<string, unknown> | undefined {
  if (!prf) return undefined;
  const out: Record<string, unknown> = {};
  if (prf.eval) out.eval = prfValues(prf.eval);
  if (ceremony === 'get' && prf.evalByCredential) {
    out.evalByCredential = Object.fromEntries(
      Object.entries(prf.evalByCredential).map(([id, v]) => [id, prfValues(v)]),
    );
  }
  return { prf: out };
}

const toBytes = (v: unknown): Uint8Array | undefined =>
  v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array(v.buffer, v.byteOffset, v.byteLength) : undefined;

/** Read (and normalise) a credential's client extension results. */
export function readExtensionResults(credential: PublicKeyCredential): PasskeyExtensionResults {
  const raw = (credential as unknown as { getClientExtensionResults?: () => Record<string, unknown> }).getClientExtensionResults?.() ?? {};
  const out: PasskeyExtensionResults = { credentialId: bufferToBase64Url(credential.rawId) };
  const prf = raw.prf as { enabled?: unknown; results?: { first?: unknown; second?: unknown } } | undefined;
  if (prf && typeof prf === 'object') {
    const first = toBytes(prf.results?.first);
    const second = toBytes(prf.results?.second);
    out.prf = {
      ...(typeof prf.enabled === 'boolean' ? { enabled: prf.enabled } : {}),
      ...(first ? { results: { first, ...(second ? { second } : {}) } } : {}),
    };
  }
  const credProps = raw.credProps as { rk?: unknown } | undefined;
  if (credProps && typeof credProps === 'object') out.credProps = typeof credProps.rk === 'boolean' ? { rk: credProps.rk } : {};
  return out;
}

/** The POST body for /v1/client/me/passkeys/finish. */
export interface PasskeyRegistrationBody {
  challenge: string;
  attestation_object: string;
  client_data_json: string;
  name?: string;
}

/**
 * Run navigator.credentials.create from a `/passkeys/begin` response and return
 * the `/finish` body. `begin` is the JSON the server sent (challenge, rp, user,
 * pubKeyCredParams, excludeCredentials, … — all base64url where it is bytes).
 */
export async function createPasskey(
  begin: Record<string, unknown>,
  opts: { name?: string; host?: WebAuthnHost; mediation?: 'optional' | 'conditional'; signal?: AbortSignal } & PasskeyExtensionOptions = {},
): Promise<PasskeyRegistrationBody> {
  const host = opts.host ?? defaultHost();
  const user = begin.user as { id: string; name: string; displayName: string };
  const exclude = (begin.excludeCredentials as { type: string; id: string }[] | undefined) ?? [];

  const publicKey = {
    challenge: base64UrlToBuffer(begin.challenge as string),
    rp: begin.rp,
    user: { ...user, id: base64UrlToBuffer(user.id) },
    pubKeyCredParams: begin.pubKeyCredParams,
    excludeCredentials: exclude.map((c) => ({ type: c.type, id: base64UrlToBuffer(c.id) })),
    authenticatorSelection: begin.authenticatorSelection,
    timeout: begin.timeout,
    attestation: begin.attestation,
    // WebAuthn Level 3: the server's preference order for the browser's passkey UI.
    ...(Array.isArray(begin.hints) && begin.hints.length ? { hints: begin.hints } : {}),
    ...extensionsMember(passkeyExtensionsInput(opts.prf, 'create'), begin.extensions),
  } as unknown as PublicKeyCredentialCreationOptions;

  // `mediation: 'conditional'` upgrades a password user to a passkey without a prompt of its own (browser permitting).
  const credential = (await host.credentials.create({
    publicKey,
    ...(opts.mediation ? { mediation: opts.mediation } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey registration was cancelled.');
  const response = credential.response as AuthenticatorAttestationResponse;
  // Client extension results (PRF outputs) go to the app's callback only —
  // never into the finish body, so Atlas never sees them.
  if (opts.onExtensionResults) opts.onExtensionResults(readExtensionResults(credential));

  return {
    // Echo the server's challenge string — the server matched/stored it.
    challenge: begin.challenge as string,
    attestation_object: bufferToBase64Url(response.attestationObject),
    client_data_json: bufferToBase64Url(response.clientDataJSON),
    ...(opts.name ? { name: opts.name } : {}),
  };
}

/** The POST body for /v1/client/sign_ins/passkey/finish. */
export interface PasskeyAssertionBody {
  handle: string;
  challenge: string;
  credential_id: string;
  authenticator_data: string;
  client_data_json: string;
  signature: string;
}

/**
 * Run navigator.credentials.get from a `/sign_ins/passkey/begin` response and
 * return the `/finish` body. Pass `mediation: 'conditional'` for autofill UI.
 */
export async function getPasskeyAssertion(
  begin: Record<string, unknown>,
  opts: { host?: WebAuthnHost; mediation?: 'optional' | 'conditional' | 'immediate'; signal?: AbortSignal } & PasskeyExtensionOptions = {},
): Promise<PasskeyAssertionBody> {
  const host = opts.host ?? defaultHost();
  const allow = (begin.allowCredentials as { type: string; id: string }[] | undefined) ?? [];

  const publicKey = {
    challenge: base64UrlToBuffer(begin.challenge as string),
    rpId: begin.rpId,
    allowCredentials: allow.map((c) => ({ type: c.type, id: base64UrlToBuffer(c.id) })),
    userVerification: begin.userVerification,
    timeout: begin.timeout,
    ...(Array.isArray(begin.hints) && begin.hints.length ? { hints: begin.hints } : {}),
    ...extensionsMember(passkeyExtensionsInput(opts.prf, 'get'), begin.extensions),
  } as unknown as PublicKeyCredentialRequestOptions;

  const credential = (await host.credentials.get({
    publicKey,
    ...(opts.mediation ? { mediation: opts.mediation } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey sign-in was cancelled.');
  const response = credential.response as AuthenticatorAssertionResponse;
  if (opts.onExtensionResults) opts.onExtensionResults(readExtensionResults(credential));

  return {
    handle: begin.handle as string,
    challenge: begin.challenge as string,
    credential_id: bufferToBase64Url(credential.rawId),
    authenticator_data: bufferToBase64Url(response.authenticatorData),
    client_data_json: bufferToBase64Url(response.clientDataJSON),
    signature: bufferToBase64Url(response.signature),
  };
}

/**
 * The ceremony's `extensions`: what the server's begin response asked for
 * (when it asks for any), with the app's PRF request merged in.
 */
function extensionsMember(
  app: Record<string, unknown> | undefined,
  server: unknown,
): { extensions?: Record<string, unknown> } {
  const fromServer = server && typeof server === 'object' && !Array.isArray(server) ? (server as Record<string, unknown>) : undefined;
  if (!app && !fromServer) return {};
  return { extensions: { ...(fromServer ?? {}), ...(app ?? {}) } };
}

/** The `GET /v1/client/me/passkeys/signal` response. */
export interface PasskeySignalInput {
  enabled: boolean;
  rp_id: string;
  user_id: string;
  name: string;
  display_name: string;
  credential_ids: string[];
}

/** The slice of `PublicKeyCredential` the Signal API calls need — injectable for tests. */
export interface PasskeySignalHost {
  signalAllAcceptedCredentials?(o: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }): Promise<void>;
  signalCurrentUserDetails?(o: { rpId: string; userId: string; name: string; displayName: string }): Promise<void>;
  signalUnknownCredential?(o: { rpId: string; credentialId: string }): Promise<void>;
}

const signalHost = (): PasskeySignalHost =>
  ((globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential ?? {}) as PasskeySignalHost;

/**
 * Tell the user's password manager what the server still accepts, so removed
 * passkeys disappear from its list and renamed accounts update. Best-effort:
 * browsers without the Signal API, or a signal the instance has off, do nothing.
 * Returns the names of the signals sent.
 */
export async function sendPasskeySignals(input: PasskeySignalInput, host: PasskeySignalHost = signalHost()): Promise<string[]> {
  if (!input.enabled) return [];
  const sent: string[] = [];
  const run = async (name: string, fn: (() => Promise<void>) | undefined) => {
    if (!fn) return;
    try {
      await fn();
      sent.push(name);
    } catch {
      // A signal is a hint; a rejected one (wrong rpId, stale handle) never blocks sign-in.
    }
  };
  await run('signalAllAcceptedCredentials', host.signalAllAcceptedCredentials?.bind(host, { rpId: input.rp_id, userId: input.user_id, allAcceptedCredentialIds: input.credential_ids }));
  await run('signalCurrentUserDetails', host.signalCurrentUserDetails?.bind(host, { rpId: input.rp_id, userId: input.user_id, name: input.name, displayName: input.display_name }));
  return sent;
}

/** Report a credential the server rejected as unknown (after a failed passkey sign-in). */
export async function signalUnknownPasskey(rpId: string, credentialId: string, host: PasskeySignalHost = signalHost()): Promise<boolean> {
  if (!host.signalUnknownCredential) return false;
  try {
    await host.signalUnknownCredential({ rpId, credentialId });
    return true;
  } catch {
    return false;
  }
}

/** The `GET /v1/client/me/passkeys/prompt` response. */
export interface PasskeyPromptDecision {
  eligible: boolean;
  variant: string;
  cooldown_days: number;
}

const PROMPT_KEY = 'atlas.passkeyPromptDismissedAt';
const DAY_MS = 86_400_000;

/** Eligible by the server and not dismissed within the cooldown on this device. */
export function passkeyPromptDue(
  decision: PasskeyPromptDecision,
  store: Pick<Storage, 'getItem'> | undefined = (globalThis as { localStorage?: Storage }).localStorage,
  now: number = Date.now(),
): boolean {
  if (!decision.eligible) return false;
  const at = Number(store?.getItem(PROMPT_KEY));
  return !(at > 0 && now - at < decision.cooldown_days * DAY_MS);
}

/** Start the cooldown (call when the user dismisses the nudge). */
export function dismissPasskeyPrompt(
  store: Pick<Storage, 'setItem'> | undefined = (globalThis as { localStorage?: Storage }).localStorage,
  now: number = Date.now(),
): void {
  store?.setItem(PROMPT_KEY, String(now));
}

/** What the user did with the nudge. */
export type PasskeyPromptEvent = 'shown' | 'dismissed' | 'accepted';

/**
 * Report what the user did with the passkey nudge. The server records it with the rollout
 * variant it computed itself (`passkey_prompt.shown|dismissed|accepted` in the audit log), so
 * conversion per variant is readable without trusting the client. Best-effort: never throws.
 */
export async function reportPasskeyPromptEvent(
  client: FapiClient,
  event: PasskeyPromptEvent,
  deviceClass?: 'desktop' | 'mobile' | 'tablet',
): Promise<boolean> {
  try {
    const res = await client.post('/v1/client/me/passkeys/prompt/events', { event, ...(deviceClass ? { device_class: deviceClass } : {}) });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Passkey recovery, step 1: an account whose only sign-in is a passkey (no password) that lost it
 * gets a code at a verified email or phone. Needs `accountUx.passkeyAdoption.recovery` on. The
 * answer is the same whether or not the account exists. Returns the sign-in attempt id for step 2.
 */
export async function startPasskeyRecovery(
  client: FapiClient,
  identifier: string,
  method: 'email' | 'phone' = 'email',
): Promise<FapiResponse<{ id: string }>> {
  const attempt = await client.post<{ id: string }>('/v1/client/sign_ins', { identifier });
  if (!attempt.ok || !attempt.data) return attempt;
  const prepared = await client.post(`/v1/client/sign_ins/${attempt.data.id}/prepare_first_factor`, {
    strategy: method === 'email' ? 'email_code' : 'phone_code',
  });
  return prepared.ok ? { ...prepared, data: { id: attempt.data.id } } : (prepared as unknown as FapiResponse<{ id: string }>);
}

/**
 * Passkey recovery, step 2: submit the code. A correct one completes the sign-in as usual (the
 * response carries the `ticket` to exchange for a session, or the next step if the account has
 * MFA). The user then adds a new passkey with the normal add flow, since the sign-in is fresh.
 */
export function finishPasskeyRecovery(
  client: FapiClient,
  attemptId: string,
  code: string,
  method: 'email' | 'phone' = 'email',
): Promise<FapiResponse<Record<string, unknown>>> {
  return client.post(`/v1/client/sign_ins/${attemptId}/attempt_first_factor`, {
    strategy: method === 'email' ? 'email_code' : 'phone_code',
    code,
  });
}
