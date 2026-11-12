/**
 * Headless developer-portal kit: build your own "register an app" pages on top of dynamic client registration.
 * The instance gives a developer an initial access token (`oauth_initial_access_token`, bound to them); registering
 * returns the app plus a registration access token that manages that one app afterwards. Call these from your
 * server (or a trusted back end) so neither token reaches a browser you do not control.
 */

export interface DeveloperPortalOptions {
  /** The instance's issuer (its frontend API host), e.g. `https://auth.example.com`. */
  issuer: string;
  fetchImpl?: typeof fetch;
}

/** One registered app, as the registration endpoint reports it. */
export interface DeveloperApp {
  /** The Atlas id (oac_...) the Backend API takes. Present on the registration response. */
  id?: string;
  client_id: string;
  client_name?: string;
  client_secret?: string;
  client_secret_expires_at?: number;
  redirect_uris: string[];
  scope?: string;
  grant_types?: string[];
  token_endpoint_auth_method?: string;
  status?: string;
  /** Returned once, on registration: keep it to manage the app later. */
  registration_access_token?: string;
  registration_client_uri?: string;
  [key: string]: unknown;
}

export interface DeveloperAppUsage {
  object: 'oauth_client_usage';
  client_id: string;
  rate_limit_per_minute: number | null;
  totals: { calls: number; token_issuances: number; errors: number; rate_limited: number };
  data: Array<{ day: string; calls: number; token_issuances: number; active_users: number; errors: number; rate_limited: number }>;
}

/** A refused request; `error` is the OAuth error code (`invalid_redirect_uri`, `invalid_client_metadata`, `invalid_token`...). */
export class DeveloperPortalError extends Error {
  readonly status: number;
  readonly error: string;
  constructor(status: number, error: string, message: string) {
    super(message);
    this.name = 'DeveloperPortalError';
    this.status = status;
    this.error = error;
  }
}

export interface DeveloperPortal {
  /** Register an app with the developer's initial access token. Returns the app, its secret and registration_access_token (shown once). */
  registerApp(developerToken: string, app: { client_name: string; redirect_uris: string[]; scope?: string; grant_types?: string[]; token_endpoint_auth_method?: string; logo_uri?: string }): Promise<DeveloperApp>;
  getApp(clientId: string, registrationToken: string): Promise<DeveloperApp>;
  /** Replace the app's redirect URIs (the instance's rules apply: https, and https only for some developers). */
  setRedirectUris(clientId: string, registrationToken: string, redirectUris: string[]): Promise<DeveloperApp>;
  /** Ask for scopes. The standard scopes are applied at once; others are refused until the instance allows them for the app. */
  requestScopes(clientId: string, registrationToken: string, scopes: string[]): Promise<DeveloperApp>;
  /** Issue a new secret; the previous one keeps working for a short overlap. */
  rotateSecret(clientId: string, registrationToken: string): Promise<{ client_id: string; client_secret: string; client_secret_expires_at: number }>;
  deleteApp(clientId: string, registrationToken: string): Promise<void>;
  /** Per-day token endpoint usage for the app (default last 30 days, at most 90). */
  getUsage(clientId: string, registrationToken: string, days?: number): Promise<DeveloperAppUsage>;
}

export function createDeveloperPortal(options: DeveloperPortalOptions): DeveloperPortal {
  const base = options.issuer.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  async function call<T>(path: string, method: string, token: string, body?: unknown): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) throw new DeveloperPortalError(res.status, String(data.error ?? 'request_failed'), String(data.error_description ?? 'The request failed.'));
    return data as T;
  }
  const own = (clientId: string) => `/oauth2/register/${encodeURIComponent(clientId)}`;

  return {
    registerApp: (developerToken, app) => call('/oauth2/register', 'POST', developerToken, app),
    getApp: (clientId, token) => call(own(clientId), 'GET', token),
    setRedirectUris: (clientId, token, redirect_uris) => call(own(clientId), 'PUT', token, { redirect_uris }),
    requestScopes: (clientId, token, scopes) => call(own(clientId), 'PUT', token, { scope: scopes.join(' ') }),
    rotateSecret: (clientId, token) => call(`${own(clientId)}/secret`, 'POST', token),
    deleteApp: (clientId, token) => call(own(clientId), 'DELETE', token),
    getUsage: (clientId, token, days) => call(`${own(clientId)}/usage${days ? `?days=${days}` : ''}`, 'GET', token),
  };
}
