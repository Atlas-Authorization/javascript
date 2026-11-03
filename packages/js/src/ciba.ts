import type { FapiClient } from './fapi';

/**
 * CIBA self-service for the signed-in user: the backchannel requests waiting for their decision, and the
 * optional CIBA PIN apps must send as the `user_code`. Cookie-authenticated through the {@link FapiClient}
 * (`/v1/client/me/backchannel_requests`, `/v1/client/me/ciba_pin`); a bearer token is refused by the server.
 */
export interface CibaRequest {
  id: string;
  client_name: string;
  scope: string[];
  binding_message: string | null;
  created_at: number;
  expires_at: number;
}

export interface CibaPinStatus {
  set: boolean;
  updated_at: number | null;
  /** Some app on this instance can start CIBA requests, so showing the PIN form is worthwhile. */
  available: boolean;
}

export class CibaError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'CibaError';
    this.status = status;
    this.code = code;
  }
}

async function call<T>(client: FapiClient, path: string, init: RequestInit): Promise<T> {
  const res = await client.request<T>(path, init);
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new CibaError(res.status, first?.code ?? 'UNKNOWN', first?.message ?? 'The request failed.');
  }
  return res.data;
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
});

/** Requests from apps waiting for this user to approve or deny. */
export async function listCibaRequests(client: FapiClient): Promise<CibaRequest[]> {
  const body = await call<{ data?: CibaRequest[] }>(client, '/v1/client/me/backchannel_requests', json('GET'));
  return body.data ?? [];
}

/** Approve or deny one request. */
export async function decideCibaRequest(client: FapiClient, id: string, decision: 'approve' | 'deny'): Promise<'approved' | 'denied'> {
  const body = await call<{ status: 'approved' | 'denied' }>(client, `/v1/client/me/backchannel_requests/${encodeURIComponent(id)}`, json('POST', { decision }));
  return body.status;
}

export async function getCibaPin(client: FapiClient): Promise<CibaPinStatus> {
  const body = await call<{ set: boolean; updated_at?: number | null; available?: boolean }>(client, '/v1/client/me/ciba_pin', json('GET'));
  return { set: body.set, updated_at: body.updated_at ?? null, available: body.available ?? false };
}

/** Set or change the PIN (6 to 12 digits). Needs the current password and a recent sign-in. */
export async function setCibaPin(client: FapiClient, input: { pin: string; currentPassword?: string }): Promise<void> {
  await call(client, '/v1/client/me/ciba_pin', json('PUT', { pin: input.pin, current_password: input.currentPassword }));
}

export async function clearCibaPin(client: FapiClient, input: { currentPassword?: string } = {}): Promise<void> {
  await call(client, '/v1/client/me/ciba_pin', json('DELETE', { current_password: input.currentPassword }));
}
