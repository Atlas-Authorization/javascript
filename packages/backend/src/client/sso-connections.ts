import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

export interface ClaimRoleMapping {
  claim: string;
  value: string;
  /** camelCase on the wire, unlike the surrounding snake_case fields. */
  roleKey: string;
}

export interface SsoConnection {
  object: 'sso_connection';
  id: string;
  organization_id: string | null;
  type: string;
  status: string;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  has_secret: boolean;
  saml_idp_entity_id: string | null;
  saml_idp_sso_url: string | null;
  saml_sp_entity_id: string | null;
  has_saml_certificate: boolean;
  saml_allow_idp_initiated: boolean;
  saml_sign_authn_requests: boolean;
  saml_want_response_signed: boolean;
  has_discourse_secret: boolean;
  discourse_provider_url: string | null;
  allowed_domains: string[];
  claim_role_mappings: ClaimRoleMapping[];
  default_role_id: string | null;
  created_at: number;
  updated_at: number;
}

export interface SamlMetadata {
  object: 'sso_saml_metadata';
  sp_entity_id: string;
  acs_url: string;
  /** The SP EntityDescriptor XML, carried as a string inside this JSON envelope. */
  metadata_xml: string;
}

export interface CreateSsoConnectionBody {
  organization_id?: string | null;
  type?: 'oidc' | 'saml' | 'discourse' | 'discourse_consumer';
  status?: 'draft' | 'active' | 'disabled';
  oidc_issuer?: string;
  oidc_client_id?: string;
  /** Write-only; stored encrypted, never returned. */
  oidc_client_secret?: string;
  saml_idp_entity_id?: string;
  saml_idp_sso_url?: string;
  /** Write-only; only `has_saml_certificate` is ever returned. */
  saml_idp_certificate?: string;
  saml_sp_entity_id?: string;
  saml_allow_idp_initiated?: boolean;
  saml_sign_authn_requests?: boolean;
  saml_want_response_signed?: boolean;
  discourse_secret?: string;
  discourse_provider_url?: string;
  allowed_domains?: string[];
  claim_role_mappings?: ClaimRoleMapping[];
  default_role_id?: string | null;
}

/** PATCH accepts everything create does except `type`, which is immutable. */
export type UpdateSsoConnectionBody = Omit<CreateSsoConnectionBody, 'type'>;

export function ssoConnectionsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<SsoConnection>> {
      return request({ method: 'GET', path: '/v1/sso_connections' });
    },
    get(id: string): Promise<SsoConnection> {
      return request({ method: 'GET', path: `/v1/sso_connections/${enc(id)}` });
    },
    create(body: CreateSsoConnectionBody, idempotencyKey?: string): Promise<SsoConnection> {
      return request({ method: 'POST', path: '/v1/sso_connections', body, idempotencyKey });
    },
    update(id: string, body: UpdateSsoConnectionBody): Promise<SsoConnection> {
      return request({ method: 'PATCH', path: `/v1/sso_connections/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'sso_connection'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/sso_connections/${enc(id)}` });
    },
    /** SP SAML metadata for a connection (JSON envelope carrying the XML). */
    samlMetadata(id: string): Promise<SamlMetadata> {
      return request({ method: 'GET', path: `/v1/sso_connections/${enc(id)}/saml_metadata` });
    },
  };
}
