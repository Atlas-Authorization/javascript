import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type NetworkZoneAnonymizer = 'tor' | 'datacenter' | 'vpn';

/**
 * A reusable network zone: a union of CIDR ranges, ISO countries, ASNs and
 * anonymizer classes. Network ACL rules reference one by `zone_id`.
 */
export interface NetworkZone {
  object: 'network_zone';
  id: string;
  name: string;
  description: string | null;
  cidrs: string[];
  countries: string[];
  asns: number[];
  anonymizers: NetworkZoneAnonymizer[];
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateNetworkZoneBody {
  name: string;
  description?: string | null;
  cidrs?: string[];
  countries?: string[];
  asns?: number[];
  anonymizers?: NetworkZoneAnonymizer[];
  enabled?: boolean;
}

export type UpdateNetworkZoneBody = Partial<CreateNetworkZoneBody>;

export interface NetworkZoneCheck {
  object: 'network_zone_check';
  zone_id: string;
  ip: string;
  matches: boolean;
  facts: { country: string | null; asn: number | null; tor: boolean | null; datacenter: boolean | null };
}

/** CRUD over the instance's network zones, plus a what-if `check` for one address. */
export function networkZonesResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<NetworkZone>> {
      return request({ method: 'GET', path: '/v1/network_zones' });
    },
    get(id: string): Promise<NetworkZone> {
      return request({ method: 'GET', path: `/v1/network_zones/${enc(id)}` });
    },
    create(body: CreateNetworkZoneBody, idempotencyKey?: string): Promise<NetworkZone> {
      return request({ method: 'POST', path: '/v1/network_zones', body, idempotencyKey });
    },
    update(id: string, body: UpdateNetworkZoneBody): Promise<NetworkZone> {
      return request({ method: 'PATCH', path: `/v1/network_zones/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'network_zone'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/network_zones/${enc(id)}` });
    },
    /** Does `ip` fall inside the zone? Returns the resolved facts too. */
    check(id: string, ip: string): Promise<NetworkZoneCheck> {
      return request({ method: 'POST', path: `/v1/network_zones/${enc(id)}/check`, body: { ip } });
    },
  };
}
