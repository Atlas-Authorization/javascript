import type { FapiClient } from './fapi';

/**
 * User-Managed Access, from the two browser-side seats.
 *
 * The RESOURCE OWNER (signed in, cookie-authenticated through the {@link FapiClient}): list what they own and who
 * it is shared with, share and stop sharing, and answer access requests (`/v1/client/me/uma/*`).
 *
 * The CLIENT acting for a requesting party: build the claims-gathering URL for a `need_info` answer that carries
 * `redirect_user`, and read the ticket / error from the redirect back.
 */

export interface UmaPolicy {
  object: 'uma_policy';
  id: string;
  resource_id: string;
  subject: { type: 'user' | 'group' | 'org'; id: string };
  scopes: string[];
  created_at: number;
}

export interface UmaOwnedResource {
  object: 'uma_resource';
  id: string;
  name: string;
  type: string | null;
  uri: string | null;
  resource_scopes: string[];
  app: string | null;
  policies: UmaPolicy[];
}

export interface UmaAccessRequest {
  object: 'uma_access_request';
  id: string;
  resource_id: string;
  resource_name?: string;
  requester_user_id: string;
  /** The requester's email address. */
  requester?: string | null;
  scopes: string[];
  status: 'pending' | 'approved' | 'denied';
  created_at: number;
  decided_at: number | null;
}

/** A refused request; `code` is the server's stable error code. */
export class UmaError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'UmaError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(client: FapiClient, path: string, init: RequestInit): Promise<T> {
  const res = await client.request<T>(path, init);
  if (!res.ok) {
    const first = res.errors[0];
    throw new UmaError(res.status, first?.code ?? 'UNKNOWN', first?.message ?? 'The request failed.');
  }
  return res.data as T;
}

const json = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const enc = encodeURIComponent;

/** The resources the signed-in user owns, with who each is shared with. */
export async function listUmaResources(client: FapiClient): Promise<UmaOwnedResource[]> {
  return (await call<{ data?: UmaOwnedResource[] }>(client, '/v1/client/me/uma/resources', { method: 'GET' })).data ?? [];
}

/** Share a resource with a person (verified `email`) or a `subject` (user, group, org). Replaces an earlier share to the same subject. */
export function shareUmaResource(
  client: FapiClient,
  resourceId: string,
  target: { email: string } | { subject: { type: 'user' | 'group' | 'org'; id: string } },
  scopes: string[],
): Promise<UmaPolicy> {
  return call(client, `/v1/client/me/uma/resources/${enc(resourceId)}/policies`, json('PUT', { ...target, scopes }));
}

export async function unshareUmaResource(client: FapiClient, resourceId: string, subject: { type: string; id: string }): Promise<void> {
  await call(client, `/v1/client/me/uma/resources/${enc(resourceId)}/policies/${enc(subject.type)}/${enc(subject.id)}`, { method: 'DELETE' });
}

/** Access requests for the user's resources (the owner-approval queue). */
export async function listUmaAccessRequests(client: FapiClient, status?: UmaAccessRequest['status']): Promise<UmaAccessRequest[]> {
  const q = status ? `?status=${enc(status)}` : '';
  return (await call<{ data?: UmaAccessRequest[] }>(client, `/v1/client/me/uma/requests${q}`, { method: 'GET' })).data ?? [];
}

/** Approve (optionally narrowing `scopes`) or deny a pending request. A request is decided once. */
export function decideUmaAccessRequest(client: FapiClient, requestId: string, decision: 'approve' | 'deny', scopes?: string[]): Promise<UmaAccessRequest> {
  return call(client, `/v1/client/me/uma/requests/${enc(requestId)}/decision`, json('POST', { decision, ...(scopes ? { scopes } : {}) }));
}

/**
 * The URL to send the requesting party to for interactive claims gathering. `redirectUser` is the `redirect_user`
 * from the `need_info` answer; `ticket` is that answer's (rotated) ticket. `claimsRedirectUri` must be one of the
 * client's registered claims redirect URIs.
 */
export function umaClaimsUrl(redirectUser: string, params: { clientId: string; ticket: string; claimsRedirectUri?: string; state?: string }): string {
  const url = new URL(redirectUser);
  url.searchParams.set('client_id', params.clientId);
  url.searchParams.set('ticket', params.ticket);
  if (params.claimsRedirectUri) url.searchParams.set('claims_redirect_uri', params.claimsRedirectUri);
  if (params.state) url.searchParams.set('state', params.state);
  return url.toString();
}

/** Read the redirect back from claims gathering: a new `ticket`, or an `error` (the person cancelled). */
export function parseUmaClaimsRedirect(redirectUrl: string): { ticket?: string; error?: string; state?: string } {
  const p = new URL(redirectUrl).searchParams;
  return { ticket: p.get('ticket') ?? undefined, error: p.get('error') ?? undefined, state: p.get('state') ?? undefined };
}
