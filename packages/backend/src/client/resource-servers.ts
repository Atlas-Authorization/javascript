import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface ResourceServerScope {
  value: string;
  description?: string;
}

export interface ResourceServer {
  object: 'resource_server';
  id: string;
  identifier: string;
  name: string;
  scopes: ResourceServerScope[];
  token_ttl_seconds: number;
  signing_alg: string;
  created_at: number;
  updated_at: number;
}

export interface CreateResourceServerBody {
  identifier: string;
  name: string;
  /** Each scope is a bare string or `{ value, description? }`. */
  scopes?: Array<string | ResourceServerScope>;
  token_ttl_seconds?: number;
  signing_alg?: string;
}

export interface UpdateResourceServerBody {
  name?: string;
  scopes?: Array<string | ResourceServerScope>;
  token_ttl_seconds?: number;
  signing_alg?: string;
  /** Immutable — supplying a different value is rejected. */
  identifier?: string;
}

export function resourceServersResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<ResourceServer>> {
      return request({ method: 'GET', path: '/v1/resource_servers' });
    },
    get(id: string): Promise<ResourceServer> {
      return request({ method: 'GET', path: `/v1/resource_servers/${enc(id)}` });
    },
    create(body: CreateResourceServerBody): Promise<ResourceServer> {
      return request({ method: 'POST', path: '/v1/resource_servers', body });
    },
    update(id: string, body: UpdateResourceServerBody): Promise<ResourceServer> {
      return request({ method: 'PATCH', path: `/v1/resource_servers/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'resource_server'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/resource_servers/${enc(id)}` });
    },
  };
}
