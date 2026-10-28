import { enc, type RequestFn } from './request';

/**
 * The integration-facing routes, called with the instance secret key (an
 * integrated service calls the same routes with the partner link the instance
 * owner granted it): report a token a service refused, read the agent-sidebar
 * card for a user and run its actions, and read an instance's public metadata.
 */

export type IntegrationVerifyErrorCode =
  | 'aud_mismatch'
  | 'expired'
  | 'bad_signature'
  | 'unknown_kid'
  | 'session_revoked'
  | 'invalid_claims'
  | 'other';

export interface ReportVerifyErrorBody {
  /** The integration id the token was minted for (a preset or a custom id). */
  integration: string;
  error: IntegrationVerifyErrorCode;
  audience?: string;
  /** Epoch ms (or seconds) or an ISO time. Default now. */
  at?: number | string;
  kid?: string;
  sid?: string;
  detail?: string;
}

export interface IntegrationVerifyError {
  object: 'integration_verify_error';
  id: string;
  integration: string;
  audience: string | null;
  error: IntegrationVerifyErrorCode;
  at: number;
  trace_id: string | null;
  created_at: number;
}

export interface IntegrationCard {
  object: 'integration_card';
  integration: string;
  user: {
    id: string;
    email: string | null;
    email_verified: boolean;
    name: string | null;
    external_id: string | null;
    banned: boolean;
    mfa_enabled: boolean;
    last_sign_in_at: number | null;
    created_at: number;
    organizations: Array<{ id: string; name: string; role: string }>;
  };
  sessions_active: number;
  actions: Array<{ id: 'revoke_sessions'; label: string; confirm: boolean; available: boolean; requires_scope: string }>;
}

export interface InstanceMetadata {
  object: 'instance_metadata';
  id: string;
  issuer: string;
  jwks_uri: string;
  token_schema: string;
  integrations: Record<string, { audience: string; preset: string | null; ttl_seconds: number; additional_issuers?: string[] }>;
  trusted_issuers: Array<{ issuer: string; jwks_uri: string; kind: 'instance' | 'atlas_id' }>;
  previous_issuers: Array<{ issuer: string; jwks_uri: string; replaced_at: number }>;
}

export function integrationsResource(request: RequestFn) {
  return {
    /** `POST /v1/integrations/verify_errors` — record a token an integrated service refused. */
    reportVerifyError(body: ReportVerifyErrorBody): Promise<IntegrationVerifyError> {
      return request({ method: 'POST', path: '/v1/integrations/verify_errors', body });
    },
    /** `GET /v1/integrations/:integration/card` — the agent-sidebar card for a user (by token sub). */
    card(integration: string, query: { sub: string; iss?: string }): Promise<IntegrationCard> {
      return request({ method: 'GET', path: `/v1/integrations/${enc(integration)}/card`, query });
    },
    /** `POST /v1/integrations/:integration/card/actions/revoke_sessions` — sign the user out everywhere (audited with the agent). */
    revokeSessions(
      integration: string,
      body: { sub: string; iss?: string; agent?: { id?: string; name?: string; email?: string } },
    ): Promise<{ object: 'integration_card_action'; integration: string; action: 'revoke_sessions'; ok: boolean; sessions_revoked: number }> {
      return request({ method: 'POST', path: `/v1/integrations/${enc(integration)}/card/actions/revoke_sessions`, body });
    },
    /** `GET /v1/public/instances/:id` — the public metadata of an instance (no key needed). */
    instanceMetadata(instanceId: string): Promise<InstanceMetadata> {
      return request({ method: 'GET', path: `/v1/public/instances/${enc(instanceId)}` });
    },
  };
}
