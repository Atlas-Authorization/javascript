/**
 * Sender-constrained sessions: bind the signed-in session to this device's DPoP key.
 *
 *   const dpop = createDpopClient({ store });                       // non-extractable key, kept in IndexedDB
 *   const client = new FapiClient({ publishableKey, sessionBinding: dpop });
 *   // after sign-in:
 *   await bindSession(client);
 *
 * Every request the client then makes carries a proof from the key; a session cookie copied to another machine
 * is refused. Native apps pass `attestation` (App Attest, DeviceCheck or Play Integrity) when the instance
 * requires it. Needs the instance's `sessionBinding.mode` to be `optional` or `required`.
 */
import type { FapiClient, FapiResponse } from './fapi';
import { attestationHeaderFor, type AttestationProvider } from './attestation';

export interface SessionBindingView {
  object: 'session_binding';
  session_id: string;
  jkt: string;
  attested: boolean;
  bound_at: number;
}

export async function bindSession(client: FapiClient, options: { attestation?: AttestationProvider } = {}): Promise<FapiResponse<SessionBindingView>> {
  const header = options.attestation ? await attestationHeaderFor(client, options.attestation) : null;
  return client.request<SessionBindingView>('/v1/client/session_binding', {
    method: 'POST',
    body: '{}',
    headers: header ? { 'atlas-attestation': header } : {},
  });
}

/** Whether a failed response says the session must be bound (the instance requires it) or its key proven. */
export function sessionBindingRequired(response: Pick<FapiResponse<unknown>, 'errors'>): boolean {
  return response.errors.some((e) => (e as { reason?: string }).reason === 'session_binding_required' || (e as { reason?: string }).reason === 'dpop_binding_required');
}

export interface NavigationTicketView {
  object: 'navigation_ticket';
  ticket: string;
  /** The target with the ticket attached. */
  url: string;
  target: string;
  expires_at: number;
}

/**
 * A key-bound session cannot ride a page load (the browser cannot attach a DPoP proof), so Atlas's hosted pages and
 * the authorize endpoint read it as signed out. Ask for a one-time ticket first: it is minted by a DPoP-proved
 * request, is bound to this session, its key and this one URL, and works once within seconds.
 * `target` is a path on the Atlas host: `/hosted/sign-in?...` or `/oauth2/authorize?...`.
 */
export function createNavigationTicket(client: FapiClient, target: string, options: { ttlSeconds?: number } = {}): Promise<FapiResponse<NavigationTicketView>> {
  return client.request<NavigationTicketView>('/v1/client/session_binding/navigation_ticket', {
    method: 'POST',
    body: JSON.stringify({ target, ...(options.ttlSeconds ? { ttl_seconds: options.ttlSeconds } : {}) }),
  });
}

/**
 * Mint a ticket for `target` and navigate there. Resolves with the ticket response; when minting failed nothing
 * navigates (check `ok`, and `sessionBindingRequired` for a missing proof). `navigate` defaults to
 * `window.location.assign`; pass your router's function if you use one.
 */
export async function navigateWithTicket(
  client: FapiClient,
  target: string,
  options: { ttlSeconds?: number; navigate?: (url: string) => void } = {},
): Promise<FapiResponse<NavigationTicketView>> {
  const res = await createNavigationTicket(client, target, { ttlSeconds: options.ttlSeconds });
  if (res.ok && res.data) {
    const absolute = new URL(res.data.url, client.urlFor('/')).toString();
    (options.navigate ?? ((u: string) => window.location.assign(u)))(absolute);
  }
  return res;
}
