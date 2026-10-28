import { createPasskey, getPasskeyAssertion, type WebAuthnHost } from './passkey';

/**
 * Passkeys for a user store you own (the Atlas Passkey API). The browser never
 * talks to Atlas: it talks to YOUR backend, which knows who is signed in and
 * calls the Passkey API with a secret key (`atlas.passkeyApi` in @atlasauth/backend).
 *
 * Contract of your four endpoints (all POST, JSON):
 *  - registrationInit      -> `{ options }`          (your backend passes the signed-in user's id)
 *  - registrationFinalize  <- `{ challenge, attestation_object, client_data_json, name?, transports? }`
 *  - loginInit             -> `{ handle, options }`
 *  - loginFinalize         <- `{ handle, challenge, credential_id, authenticator_data, client_data_json, signature }`
 *                          -> anything your backend answers once it has started its own session
 */
export interface ExternalPasskeyEndpoints {
  registrationInit: string;
  registrationFinalize: string;
  loginInit: string;
  loginFinalize: string;
}

export interface ExternalPasskeyOptions {
  endpoints: ExternalPasskeyEndpoints;
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  host?: WebAuthnHost;
}

async function post<T>(o: ExternalPasskeyOptions, url: string, body: unknown): Promise<T> {
  const f = o.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
  const res = await f(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json', ...o.headers },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as { error?: { message?: string }; message?: string } & T;
  if (!res.ok) throw new Error(json.error?.message ?? json.message ?? `Request failed (${res.status}).`);
  return json;
}

/** Register a passkey for the user your backend has signed in. */
export async function registerExternalPasskey(o: ExternalPasskeyOptions, input: { name?: string } = {}): Promise<unknown> {
  const init = await post<{ options: Record<string, unknown> }>(o, o.endpoints.registrationInit, {});
  const created = await createPasskey(init.options, { name: input.name, host: o.host });
  return post(o, o.endpoints.registrationFinalize, created);
}

/** Sign in with a passkey. `userId` (optional) is sent to your backend to narrow to one user's credentials. */
export async function loginWithExternalPasskey(o: ExternalPasskeyOptions, input: { mediation?: 'optional' | 'conditional'; signal?: AbortSignal } = {}): Promise<unknown> {
  const init = await post<{ handle: string; options: Record<string, unknown> }>(o, o.endpoints.loginInit, {});
  const assertion = await getPasskeyAssertion({ ...init.options, handle: init.handle }, { host: o.host, mediation: input.mediation, signal: input.signal });
  return post(o, o.endpoints.loginFinalize, assertion);
}
