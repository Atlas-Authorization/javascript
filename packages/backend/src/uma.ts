/**
 * User-Managed Access 2.0 for a RESOURCE SERVER: register what your users own, ask Atlas for permission tickets,
 * answer a request without a token with the UMA challenge, and read the permissions of a Requesting Party Token.
 * Atlas is the authorization server; the protection API needs a Protection API Access Token (PAT), which this
 * client fetches and refreshes with your confidential client's credentials (client_credentials, scope uma_protection).
 */

export const UMA_PROTECTION_SCOPE = 'uma_protection';

export interface UmaResourceBody {
  name: string;
  type?: string;
  uri?: string;
  icon_uri?: string;
  /** The scopes a requesting party can be granted on this resource. */
  resource_scopes?: string[];
  /** The Atlas user id of the resource owner, who can then share it from the hosted account page. */
  owner?: string;
  /** A resource-scoped roles resource whose role assignments decide who holds each scope. */
  rbac_resource_id?: string;
  /** Let a requesting party with no access ask the owner (the grant answers request_submitted until they decide). */
  owner_approval?: boolean;
}

export interface UmaResource extends UmaResourceBody {
  _id: string;
}

export interface UmaPermission {
  resource_id: string;
  resource_scopes: string[];
  exp?: number;
  iat?: number;
  nbf?: number;
}

/** The RPT introspection answer (UMA Federated Authorization 5.1.1): no `scope`, with `permissions`. */
export interface UmaIntrospection {
  active: boolean;
  sub?: string;
  exp?: number;
  iat?: number;
  client_id?: string;
  permissions?: UmaPermission[];
}

export class UmaProtectionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'UmaProtectionError';
  }
}

export interface UmaProtectionOptions {
  /** Your Atlas sign-in origin, e.g. `https://auth.example.com`. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** For tests or a proxy; defaults to the global fetch. */
  fetch?: typeof fetch;
}

export function createUmaProtection(options: UmaProtectionOptions) {
  const issuer = options.issuer.replace(/\/+$/, '');
  const doFetch = options.fetch ?? fetch;
  let pat: { token: string; expiresAt: number } | undefined;

  const getPat = async (): Promise<string> => {
    if (pat && pat.expiresAt - 30_000 > Date.now()) return pat.token;
    const res = await doFetch(`${issuer}/oauth2/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: `Basic ${btoa(`${encodeURIComponent(options.clientId)}:${encodeURIComponent(options.clientSecret)}`)}` },
      body: new URLSearchParams({ grant_type: 'client_credentials', scope: UMA_PROTECTION_SCOPE }).toString(),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new UmaProtectionError(res.status, body.error ?? 'invalid_client', body.error_description ?? 'Could not obtain a Protection API Access Token.');
    pat = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return pat.token;
  };

  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await doFetch(`${issuer}${path}`, {
      method,
      headers: { authorization: `Bearer ${await getPat()}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string; errors?: Array<{ code?: string; message?: string }> };
    if (!res.ok) {
      if (res.status === 401) pat = undefined;
      throw new UmaProtectionError(res.status, data.error ?? data.errors?.[0]?.code ?? 'error', data.message ?? data.errors?.[0]?.message ?? 'The protection API refused the request.');
    }
    return data as T;
  };

  return {
    /** A Protection API Access Token (cached until shortly before it expires). */
    getPat,
    resources: {
      create: (body: UmaResourceBody): Promise<{ _id: string }> => call('POST', '/oauth2/uma/resource_set', body),
      list: (): Promise<string[]> => call('GET', '/oauth2/uma/resource_set'),
      get: (id: string): Promise<UmaResource> => call('GET', `/oauth2/uma/resource_set/${encodeURIComponent(id)}`),
      update: (id: string, body: UmaResourceBody): Promise<UmaResource> => call('PUT', `/oauth2/uma/resource_set/${encodeURIComponent(id)}`, body),
      remove: (id: string): Promise<void> => call('DELETE', `/oauth2/uma/resource_set/${encodeURIComponent(id)}`),
    },
    /** Ask for a permission ticket covering one or more resources and scopes. */
    async requestTicket(permissions: Array<{ resource_id: string; resource_scopes?: string[] }>): Promise<string> {
      return (await call<{ ticket: string }>('POST', '/oauth2/uma/permission', permissions)).ticket;
    },
    /** The `WWW-Authenticate` value for a 401 that hands the client a ticket. */
    challenge(ticket: string, realm = 'uma'): string {
      return `UMA realm="${realm}", as_uri="${issuer}", ticket="${ticket}"`;
    },
    /** Introspect a Requesting Party Token with the PAT. */
    async introspect(rpt: string): Promise<UmaIntrospection> {
      const res = await doFetch(`${issuer}/oauth2/introspect`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await getPat()}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: rpt }).toString(),
      });
      if (!res.ok) throw new UmaProtectionError(res.status, 'introspection_failed', 'Introspection was refused.');
      return (await res.json()) as UmaIntrospection;
    },
  };
}

/** Whether an introspected RPT grants `scope` on `resourceId` (and has not expired). */
export function umaAllows(introspection: UmaIntrospection, resourceId: string, scope: string, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  if (!introspection.active) return false;
  return (introspection.permissions ?? []).some(
    (p) => p.resource_id === resourceId && p.resource_scopes.includes(scope) && (p.exp ?? introspection.exp ?? Infinity) > nowSeconds && (p.nbf ?? 0) <= nowSeconds,
  );
}
