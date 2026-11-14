import { enc, type RequestFn } from './request';



export interface ProxyAppsListQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type ProxyAppsListResult = {
  object?: 'list';
  data?: {
    object?: 'proxy_app';
    id?: string;
    name?: string;
    hostname?: string;
    upstream_url?: string;
    rules?: Record<string, unknown>[];
    public_paths?: string[];
    inject_headers?: boolean;
    inject_token?: boolean;
    allow_agent_tokens?: boolean;
    enabled?: boolean;
    created_at?: number;
    updated_at?: number;
  }[];
  has_more?: boolean;
};

export type ProxyAppsCreateBody = {
  name: string;
  hostname: string;
  upstream_url: string;
  /** Path / method rules requiring a role, permission or entitlement. */
  rules?: Record<string, unknown>[];
  public_paths?: string[];
  inject_headers?: boolean;
  inject_token?: boolean;
  /** Also let an active agent through with its machine token (for example to front an MCP gateway). Its scopes count as the permissions rules check. Default false. */
  allow_agent_tokens?: boolean;
  enabled?: boolean;
};

export type ProxyAppsCreateResult = {
  object?: 'proxy_app';
  id?: string;
  name?: string;
  hostname?: string;
  upstream_url?: string;
  rules?: Record<string, unknown>[];
  public_paths?: string[];
  inject_headers?: boolean;
  inject_token?: boolean;
  allow_agent_tokens?: boolean;
  enabled?: boolean;
  created_at?: number;
  updated_at?: number;
};

export type ProxyAppsGetResult = {
  object?: 'proxy_app';
  id?: string;
  name?: string;
  hostname?: string;
  upstream_url?: string;
  rules?: Record<string, unknown>[];
  public_paths?: string[];
  inject_headers?: boolean;
  inject_token?: boolean;
  allow_agent_tokens?: boolean;
  enabled?: boolean;
  created_at?: number;
  updated_at?: number;
};

export type ProxyAppsUpdateBody = {
  name?: string;
  hostname?: string;
  upstream_url?: string;
  /** Path / method rules requiring a role, permission or entitlement. */
  rules?: Record<string, unknown>[];
  public_paths?: string[];
  inject_headers?: boolean;
  inject_token?: boolean;
  /** Also let an active agent through with its machine token (for example to front an MCP gateway). Its scopes count as the permissions rules check. Default false. */
  allow_agent_tokens?: boolean;
  enabled?: boolean;
};

export type ProxyAppsUpdateResult = {
  object?: 'proxy_app';
  id?: string;
  name?: string;
  hostname?: string;
  upstream_url?: string;
  rules?: Record<string, unknown>[];
  public_paths?: string[];
  inject_headers?: boolean;
  inject_token?: boolean;
  allow_agent_tokens?: boolean;
  enabled?: boolean;
  created_at?: number;
  updated_at?: number;
};

/** Operations on `/v1/proxy_apps` (5). */
export function proxyAppsOpsResource(request: RequestFn) {
  return {
    /** List the identity-aware proxy apps — hostnames protected by the forward-auth endpoint, with their path rules. */
    list(query?: ProxyAppsListQuery): Promise<ProxyAppsListResult> {
      return request({ method: 'GET', path: '/v1/proxy_apps', query: { ...query } });
    },
    /** Create a proxy app: a hostname, optional upstream URL, ordered path/method rules requiring a role, permission or entitlement, public paths, and header/token injection. The hostname is unique across the deployment. */
    create(body?: ProxyAppsCreateBody, idempotencyKey?: string): Promise<ProxyAppsCreateResult> {
      return request({ method: 'POST', path: '/v1/proxy_apps', body, idempotencyKey });
    },
    /** Read one identity-aware proxy app. */
    get(id: string): Promise<ProxyAppsGetResult> {
      return request({ method: 'GET', path: `/v1/proxy_apps/${enc(id)}` });
    },
    /** Update a proxy app. Omitted fields keep their value. */
    update(id: string, body?: ProxyAppsUpdateBody): Promise<ProxyAppsUpdateResult> {
      return request({ method: 'PATCH', path: `/v1/proxy_apps/${enc(id)}`, body });
    },
    /** Delete a proxy app. Its hostname stops resolving at the forward-auth endpoint. */
    delete(id: string): Promise<void> {
      return request({ method: 'DELETE', path: `/v1/proxy_apps/${enc(id)}` });
    },
  };
}
