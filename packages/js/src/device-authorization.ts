import type { FapiClient } from './fapi';

/**
 * Device sign-in (OAuth 2.0 Device Authorization Grant, RFC 8628) from YOUR app:
 * the signed-in user types — or scans — the code their TV, console or CLI shows,
 * and your own page approves it. The alternative to sending them to Atlas's
 * hosted `/oauth2/device` page.
 *
 *   const auth = await lookupDeviceAuthorization(client, typedCode);
 *   // show auth.client.name and auth.scopes, then:
 *   await approveDeviceAuthorization(client, auth);   // or denyDeviceAuthorization
 *
 * The calls use the signed-in session (the cookie, or a native app's session
 * token). When the application requires a recent re-authentication to approve a
 * device (`requiresStepUp`), a stale session gets a
 * {@link DeviceAuthorizationError} with `needsReverification` — re-authenticate
 * (`reauthenticate()`), then approve again.
 */

export interface DeviceAuthorizationScope {
  scope: string;
  /** A human description for the consent text. */
  description: string;
}

export interface DeviceAuthorization {
  object: 'device_authorization';
  id: string;
  /** The code as the device shows it, e.g. `WDJB-MJHT`. */
  userCode: string;
  status: 'pending' | 'approved' | 'denied';
  client: {
    clientId: string;
    name: string;
    logoUrl: string | null;
    homepageUrl: string | null;
    firstParty: boolean;
  };
  scopes: DeviceAuthorizationScope[];
  /** The API the device asked for a token for, if any. */
  audience: string | null;
  /** Approving needs a recent re-authentication. */
  requiresStepUp: boolean;
  createdAt: number;
  expiresAt: number;
}

/** A refused request. `code` is the server's stable error code (`NOT_FOUND`, `RATE_LIMITED`, `STEP_UP_REQUIRED`, …). */
export class DeviceAuthorizationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly param?: string;
  readonly reason?: string;
  readonly meta?: Record<string, unknown>;

  constructor(status: number, code: string, message: string, param?: string, reason?: string, meta?: Record<string, unknown>) {
    super(message);
    this.name = 'DeviceAuthorizationError';
    this.status = status;
    this.code = code;
    this.param = param;
    if (reason) this.reason = reason;
    if (meta) this.meta = meta;
  }

  /** True when approving needs a fresh re-authentication first. */
  get needsReverification(): boolean {
    return this.code === 'STEP_UP_REQUIRED';
  }

  /** True when the code is unknown, expired or already used. */
  get isInvalidCode(): boolean {
    return this.status === 404 || this.status === 409;
  }
}

interface WireDeviceAuthorization {
  object: 'device_authorization';
  id: string;
  user_code: string;
  status: 'pending' | 'approved' | 'denied';
  client: { client_id: string; name: string; logo_url: string | null; homepage_url: string | null; first_party: boolean };
  scopes: DeviceAuthorizationScope[];
  audience: string | null;
  requires_step_up: boolean;
  created_at: number;
  expires_at: number;
}

const BASE = '/v1/client/me/device_authorizations';

function fromWire(w: WireDeviceAuthorization): DeviceAuthorization {
  return {
    object: 'device_authorization',
    id: w.id,
    userCode: w.user_code,
    status: w.status,
    client: {
      clientId: w.client.client_id,
      name: w.client.name,
      logoUrl: w.client.logo_url ?? null,
      homepageUrl: w.client.homepage_url ?? null,
      firstParty: w.client.first_party === true,
    },
    scopes: w.scopes ?? [],
    audience: w.audience ?? null,
    requiresStepUp: w.requires_step_up === true,
    createdAt: w.created_at,
    expiresAt: w.expires_at,
  };
}

async function call(client: FapiClient, path: string, body: Record<string, unknown>): Promise<DeviceAuthorization> {
  const res = await client.request<WireDeviceAuthorization>(path, { method: 'POST', body: JSON.stringify(body) });
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new DeviceAuthorizationError(
      res.status,
      first?.code ?? 'UNKNOWN',
      first?.message ?? 'The request failed.',
      first?.param,
      first?.reason,
      first?.meta,
    );
  }
  return fromWire(res.data);
}

/**
 * Normalise what a person typed into the `XXXX-XXXX` form devices show:
 * uppercase, spaces and dashes ignored. Returns the input unchanged when it is
 * not 8 letters or digits, so the server answers "not valid".
 */
export function formatUserCode(input: string): string {
  const cleaned = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return cleaned.length === 8 ? `${cleaned.slice(0, 4)}-${cleaned.slice(4)}` : input.trim();
}

/** Read a `user_code` from a verification URL the device displayed (`?user_code=`), if any. */
export function userCodeFromUrl(url: string | URL): string | null {
  try {
    const value = new URL(String(url)).searchParams.get('user_code');
    return value ? formatUserCode(value) : null;
  } catch {
    return null;
  }
}

/** Look up a pending device sign-in by the code the device shows. */
export async function lookupDeviceAuthorization(client: FapiClient, userCode: string): Promise<DeviceAuthorization> {
  return call(client, `${BASE}/lookup`, { user_code: formatUserCode(userCode) });
}

/** Approve the device sign-in for the signed-in user. The device's next poll receives its tokens. */
export async function approveDeviceAuthorization(
  client: FapiClient,
  authorization: Pick<DeviceAuthorization, 'id' | 'userCode'>,
): Promise<DeviceAuthorization> {
  return call(client, `${BASE}/${encodeURIComponent(authorization.id)}/approve`, { user_code: authorization.userCode });
}

/** Deny the device sign-in. The device's next poll is told `access_denied`. */
export async function denyDeviceAuthorization(
  client: FapiClient,
  authorization: Pick<DeviceAuthorization, 'id' | 'userCode'>,
): Promise<DeviceAuthorization> {
  return call(client, `${BASE}/${encodeURIComponent(authorization.id)}/deny`, { user_code: authorization.userCode });
}
