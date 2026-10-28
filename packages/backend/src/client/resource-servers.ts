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
  /** RS256 (default) or ES256: the algorithm of this API's access tokens. */
  signing_alg: 'RS256' | 'ES256' | string;
  /** RFC 9728: Atlas serves protected-resource metadata for this API. */
  publish_resource_metadata?: boolean;
  /** `jwt` or `opaque` access tokens for this API; null = inherited from the client / instance. */
  access_token_format?: 'jwt' | 'opaque' | null;
  /** Refresh-token lifetimes for grants issued for this API (seconds); null = inherited. */
  refresh_token_absolute_ttl_seconds?: number | null;
  refresh_token_idle_ttl_seconds?: number | null;
  /** client_ids of the confidential clients allowed to introspect this API's tokens. */
  introspection_client_ids?: string[];
  created_at: number;
  updated_at: number;
}

/** Token settings an API can carry (create and update). */
export interface ResourceServerTokenFields {
  /** The access-token lifetime, 60–86400 seconds. */
  token_ttl_seconds?: number;
  /** `jwt` or `opaque`; null inherits. */
  access_token_format?: 'jwt' | 'opaque' | null;
  /** 300–31536000 seconds; null inherits. */
  refresh_token_absolute_ttl_seconds?: number | null;
  /** 300–31536000 seconds, at most the absolute lifetime; null inherits. */
  refresh_token_idle_ttl_seconds?: number | null;
  /** client_ids of confidential clients (e.g. this API's backend) that may introspect its tokens. */
  introspection_client_ids?: string[];
}

export interface CreateResourceServerBody extends ResourceServerTokenFields {
  identifier: string;
  name: string;
  /** Each scope is a bare string or `{ value, description? }`. */
  scopes?: Array<string | ResourceServerScope>;
  token_ttl_seconds?: number;
  /** RS256 (default) or ES256. */
  signing_alg?: 'RS256' | 'ES256';
  /** RFC 9728: serve protected-resource metadata for this API. */
  publish_resource_metadata?: boolean;
}

export interface UpdateResourceServerBody extends ResourceServerTokenFields {
  name?: string;
  scopes?: Array<string | ResourceServerScope>;
  token_ttl_seconds?: number;
  /** RS256 (default) or ES256. */
  signing_alg?: 'RS256' | 'ES256';
  /** RFC 9728: serve protected-resource metadata for this API. */
  publish_resource_metadata?: boolean;
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
