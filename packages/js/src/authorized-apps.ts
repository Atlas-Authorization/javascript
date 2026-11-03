import type { FapiClient } from './fapi';

/**
 * The signed-in user's authorized apps: the third-party OAuth clients they signed
 * in to with this application, and the grants (OpenID Grant Management `grant_id`s)
 * each holds. Cookie-authenticated through the {@link FapiClient}
 * (`/v1/client/me/oauth_grants`, `/v1/client/me/managed_grants`).
 */

/** One grant an app holds for the user; withdrawing it ends every token issued under it. */
export interface AppGrant {
  id: string;
  scopes: string[];
  /** The API the grant covers, when it is for one. */
  resource: string | null;
  created_at: number;
  updated_at: number;
}

export interface AuthorizedApp {
  object: 'oauth_grant';
  /** The remembered consent's id; pass it to {@link disconnectAuthorizedApp}. */
  id: string;
  client_id: string | null;
  name: string;
  logo_url: string | null;
  first_party: boolean;
  scopes: string[];
  grants: AppGrant[];
  created_at: number;
}

/** A refused request; `code` is the server's stable error code. */
export class AuthorizedAppsError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'AuthorizedAppsError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(client: FapiClient, path: string, init: RequestInit): Promise<T> {
  const res = await client.request<T>(path, init);
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new AuthorizedAppsError(res.status, first?.code ?? 'UNKNOWN', first?.message ?? 'The request failed.');
  }
  return res.data;
}

/** The apps this user authorized, each with the grants it holds. */
export async function listAuthorizedApps(client: FapiClient): Promise<AuthorizedApp[]> {
  const body = await call<{ data?: AuthorizedApp[] }>(client, '/v1/client/me/oauth_grants', { method: 'GET' });
  return (body.data ?? []).map((app) => ({ ...app, grants: app.grants ?? [] }));
}

/** Forget an app entirely: its consent, every grant and every live token. */
export async function disconnectAuthorizedApp(client: FapiClient, consentId: string): Promise<void> {
  await call(client, `/v1/client/me/oauth_grants/${encodeURIComponent(consentId)}`, { method: 'DELETE' });
}

/** Withdraw one grant of an app, leaving its other grants alone. Every token issued under it ends at once. */
export async function revokeAppGrant(client: FapiClient, grantId: string): Promise<{ tokensEnded: number }> {
  const body = await call<{ tokens_ended?: number }>(client, `/v1/client/me/managed_grants/${encodeURIComponent(grantId)}`, { method: 'DELETE' });
  return { tokensEnded: body.tokens_ended ?? 0 };
}
