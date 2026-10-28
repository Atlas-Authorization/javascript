import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export type NetworkAclAction = 'allow' | 'deny';

/**
 * §11.2 a per-instance IP allow/deny rule — a richer control than the single
 * ip_allowlist, layered on top of it. Rules are evaluated in priority order
 * (lower first), first match wins.
 */
export interface NetworkAcl {
  object: 'network_acl';
  id: string;
  action: NetworkAclAction;
  /** A single IP or CIDR range; refused at write time if malformed. */
  cidr: string;
  /** The network zone this rule matches instead of `cidr`. */
  zone_id: string | null;
  description: string | null;
  priority: number;
  enabled: boolean;
  created_at: number;
  updated_at: number;
}

export interface CreateNetworkAclBody {
  action: NetworkAclAction;
  /** A CIDR or address — or send `zone_id` instead (one of the two). */
  cidr?: string;
  zone_id?: string;
  description?: string | null;
  priority?: number;
  enabled?: boolean;
}

export interface UpdateNetworkAclBody {
  action?: NetworkAclAction;
  cidr?: string;
  zone_id?: string | null;
  description?: string | null;
  priority?: number;
  enabled?: boolean;
}

/**
 * CRUD over the instance's Network ACL rules. Enforcement lives in the request
 * choke point; this surface just manages the rules, and every write is audited.
 */
export function networkAclsResource(request: RequestFn) {
  return {
    /** All rules for the instance, in priority order. */
    list(): Promise<ListPage<NetworkAcl>> {
      return request({ method: 'GET', path: '/v1/network_acls' });
    },
    get(id: string): Promise<NetworkAcl> {
      return request({ method: 'GET', path: `/v1/network_acls/${enc(id)}` });
    },
    create(body: CreateNetworkAclBody, idempotencyKey?: string): Promise<NetworkAcl> {
      return request({ method: 'POST', path: '/v1/network_acls', body, idempotencyKey });
    },
    update(id: string, body: UpdateNetworkAclBody): Promise<NetworkAcl> {
      return request({ method: 'PATCH', path: `/v1/network_acls/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'network_acl'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/network_acls/${enc(id)}` });
    },
  };
}
