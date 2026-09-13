import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * A RADIUS NAS client — a VPN concentrator, WiFi controller, or firewall allowed
 * to authenticate this instance's users against the shared Atlas RADIUS listener.
 *
 * The per-NAS `shared_secret` is WRITE-ONLY: it is sent on create/update but no
 * read ever returns it — a view reports only `has_secret`.
 */
export interface RadiusClient {
  object: 'radius_client';
  id: string;
  name: string;
  nas_identifier: string;
  ip_address: string | null;
  /** Whether a shared secret is stored — never the secret itself. */
  has_secret: boolean;
  /** Blast-RADIUS (CVE-2024-3596) hardening: require attr 80 on Access-Requests. */
  require_message_authenticator: boolean;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateRadiusClientBody {
  name: string;
  nas_identifier: string;
  shared_secret: string;
  /** An optional exact source-IP match — a single address, not a CIDR range. */
  ip_address?: string | null;
  require_message_authenticator?: boolean;
  enabled?: boolean;
}

export interface UpdateRadiusClientBody {
  name?: string;
  nas_identifier?: string;
  /** Omit or send empty to keep the stored secret (write-only edit). */
  shared_secret?: string;
  ip_address?: string | null;
  require_message_authenticator?: boolean;
  enabled?: boolean;
}

export function radiusClientsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<RadiusClient>> {
      return request({ method: 'GET', path: '/v1/radius_clients' });
    },
    create(body: CreateRadiusClientBody, idempotencyKey?: string): Promise<RadiusClient> {
      return request({ method: 'POST', path: '/v1/radius_clients', body, idempotencyKey });
    },
    get(id: string): Promise<RadiusClient> {
      return request({ method: 'GET', path: `/v1/radius_clients/${enc(id)}` });
    },
    update(id: string, body: UpdateRadiusClientBody): Promise<RadiusClient> {
      return request({ method: 'PATCH', path: `/v1/radius_clients/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'radius_client'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/radius_clients/${enc(id)}` });
    },
  };
}
