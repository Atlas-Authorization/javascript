import type { RequestFn } from './request';
import type { Metadata } from './types';

/**
 * §9.3 instance configuration. The instance is the tenant's environment (its
 * publishable key, frontend API host, allowed origins and auth config). The
 * signing private key is never returned. JWT templates live under their own
 * `jwtTemplates` resource, not here.
 */

export interface Instance {
  object: 'instance';
  id: string;
  environment: string;
  publishable_key: string;
  frontend_api_host: string;
  allowed_origins: string[];
  auth_config: Metadata;
  created_at: number;
}

export interface UpdateInstanceBody {
  /** Exact origins only — a wildcard or a path is rejected (§13.1). */
  allowed_origins?: string[];
  auth_config?: Record<string, unknown>;
}

/** `PATCH /v1/instance` echoes only the mutable fields, not a full Instance. */
export interface InstanceUpdateResult {
  object: 'instance';
  id: string;
  allowed_origins: string[];
  auth_config: Metadata;
}

export function instanceResource(request: RequestFn) {
  return {
    get(): Promise<Instance> {
      return request({ method: 'GET', path: '/v1/instance' });
    },
    update(body: UpdateInstanceBody): Promise<InstanceUpdateResult> {
      return request({ method: 'PATCH', path: '/v1/instance', body });
    },
  };
}
