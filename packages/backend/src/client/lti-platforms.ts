import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * An LTI 1.3 platform (LMS) registration for a core launch. Every field is a
 * PUBLIC trust anchor — a launch is verified against the platform's own
 * published JWKS, not a shared secret — so a registration is fully readable and
 * editable with no reveal-once.
 */
export interface LtiPlatform {
  object: 'lti_platform';
  id: string;
  organization_id: string | null;
  issuer: string;
  client_id: string;
  auth_login_url: string;
  jwks_uri: string;
  deployment_ids: string[];
  created_at: number;
  updated_at: number;
}

export interface CreateLtiPlatformBody {
  issuer: string;
  client_id: string;
  /** An absolute https URL. */
  auth_login_url: string;
  /** An absolute https URL. */
  jwks_uri: string;
  /** At least one deployment id is required. */
  deployment_ids: string[];
  organization_id?: string;
}

export interface UpdateLtiPlatformBody {
  auth_login_url?: string;
  jwks_uri?: string;
  deployment_ids?: string[];
  /** Pass `null` to unbind the platform from an organization. */
  organization_id?: string | null;
}

export function ltiPlatformsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<LtiPlatform>> {
      return request({ method: 'GET', path: '/v1/lti_platforms' });
    },
    get(id: string): Promise<LtiPlatform> {
      return request({ method: 'GET', path: `/v1/lti_platforms/${enc(id)}` });
    },
    create(body: CreateLtiPlatformBody, idempotencyKey?: string): Promise<LtiPlatform> {
      return request({ method: 'POST', path: '/v1/lti_platforms', body, idempotencyKey });
    },
    update(id: string, body: UpdateLtiPlatformBody): Promise<LtiPlatform> {
      return request({ method: 'PATCH', path: `/v1/lti_platforms/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'lti_platform'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/lti_platforms/${enc(id)}` });
    },
  };
}
