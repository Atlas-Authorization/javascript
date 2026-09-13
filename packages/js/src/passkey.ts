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

/** The slice of `navigator` these helpers need — injectable for tests. */
export interface WebAuthnHost {
  credentials: {
    create(options: { publicKey: PublicKeyCredentialCreationOptions; signal?: AbortSignal }): Promise<Credential | null>;
    get(options: {
      publicKey: PublicKeyCredentialRequestOptions;
      mediation?: 'silent' | 'optional' | 'conditional' | 'required';
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
  opts: { name?: string; host?: WebAuthnHost } = {},
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
  } as unknown as PublicKeyCredentialCreationOptions;

  const credential = (await host.credentials.create({ publicKey })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey registration was cancelled.');
  const response = credential.response as AuthenticatorAttestationResponse;

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
  opts: { host?: WebAuthnHost; mediation?: 'optional' | 'conditional'; signal?: AbortSignal } = {},
): Promise<PasskeyAssertionBody> {
  const host = opts.host ?? defaultHost();
  const allow = (begin.allowCredentials as { type: string; id: string }[] | undefined) ?? [];

  const publicKey = {
    challenge: base64UrlToBuffer(begin.challenge as string),
    rpId: begin.rpId,
    allowCredentials: allow.map((c) => ({ type: c.type, id: base64UrlToBuffer(c.id) })),
    userVerification: begin.userVerification,
    timeout: begin.timeout,
  } as unknown as PublicKeyCredentialRequestOptions;

  const credential = (await host.credentials.get({
    publicKey,
    ...(opts.mediation ? { mediation: opts.mediation } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  })) as PublicKeyCredential | null;
  if (!credential) throw new Error('Passkey sign-in was cancelled.');
  const response = credential.response as AuthenticatorAssertionResponse;

  return {
    handle: begin.handle as string,
    challenge: begin.challenge as string,
    credential_id: bufferToBase64Url(credential.rawId),
    authenticator_data: bufferToBase64Url(response.authenticatorData),
    client_data_json: bufferToBase64Url(response.clientDataJSON),
    signature: bufferToBase64Url(response.signature),
  };
}
