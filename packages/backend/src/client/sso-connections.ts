import { enc, type RequestFn } from './request';
import type { ListPage } from './types';
import {
  upstreamSigningKeys,
  type IdpInitiatedLoginSettings,
  type ProfileMapping,
  type ProfileMappingPreview,
  type ProfileMappingPreviewBody,
  type TokenEndpointAuthMethod,
  type UpstreamLogoutSettings,
  type UpstreamUrls,
} from './custom-oauth-providers';

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
  /** SAML Single Logout is on for the connection. */
  saml_single_logout?: boolean;
  /** The IdP SingleLogoutService Location / ResponseLocation and delivery binding. */
  saml_idp_slo_url?: string | null;
  saml_idp_slo_response_url?: string | null;
  saml_idp_slo_binding?: 'redirect' | 'post';
  /** The IdP SOAP SingleLogoutService — the back channel for sessions ended server-side. */
  saml_idp_slo_soap_url?: string | null;
  /** Assertions that are not encrypted to the connection's key are refused. */
  saml_require_encrypted_assertions?: boolean;
  /** An SP encryption key pair is set up (the private key is never returned). */
  has_saml_encryption_key?: boolean;
  /** A key rotation is in progress (the previous key is still accepted). */
  has_previous_saml_encryption_key?: boolean;
  saml_encryption_rotated_at?: number | null;
  has_discourse_secret: boolean;
  discourse_provider_url: string | null;
  allowed_domains: string[];
  claim_role_mappings: ClaimRoleMapping[];
  default_role_id: string | null;
  /** Which IdP claim/attribute carries each profile field (only the set keys). */
  attribute_mapping?: SsoAttributeMapping;
  /** OIDC: extra scopes requested on top of openid email profile. */
  oidc_scopes?: string[];
  /** OIDC relying-party settings (see custom OAuth providers). */
  profile_mapping?: Required<ProfileMapping> | null;
  token_endpoint_auth_method?: TokenEndpointAuthMethod | null;
  client_assertion_audience?: string | null;
  logout?: Required<UpstreamLogoutSettings>;
  idp_initiated_login?: Required<IdpInitiatedLoginSettings>;
  /** OIDC connections: the URLs to register at the IdP. */
  upstream_urls?: UpstreamUrls | null;
  /** Routing domains of an org-owned connection that the org has not verified. */
  domain_warnings?: Array<{ domain: string; code: 'unverified_organization_domain' }>;
  created_at: number;
  updated_at: number;
}

export interface SamlMetadata {
  object: 'sso_saml_metadata';
  sp_entity_id: string;
  acs_url: string;
  /** Our SingleLogoutService URL (both bindings), when Single Logout is on. */
  slo_url?: string | null;
  /** The SP EntityDescriptor XML, carried as a string inside this JSON envelope. */
  metadata_xml: string;
}

/** A SAML connection's SP encryption key pair — certificates only. */
export interface SamlEncryptionKey {
  object: 'sso_saml_encryption_key';
  connection_id: string;
  /** The current certificate (PEM), published in SP metadata; null when encryption is off. */
  certificate: string | null;
  /** The previous certificate during a rotation; null otherwise. */
  previous_certificate: string | null;
  /** When the current key was installed (epoch ms). */
  rotated_at: number | null;
  require_encrypted_assertions: boolean;
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
  /** SAML Single Logout on/off. */
  saml_single_logout?: boolean;
  /** https; null clears it. Filled by IdP metadata import when published. */
  saml_idp_slo_url?: string | null;
  saml_idp_slo_response_url?: string | null;
  saml_idp_slo_binding?: 'redirect' | 'post' | null;
  /** https; null clears it. The back channel for sessions ended server-side. */
  saml_idp_slo_soap_url?: string | null;
  /** Requires an encryption key (see `createSamlEncryptionKey`). */
  saml_require_encrypted_assertions?: boolean;
  discourse_secret?: string;
  discourse_provider_url?: string;
  allowed_domains?: string[];
  claim_role_mappings?: ClaimRoleMapping[];
  default_role_id?: string | null;
  /** null clears it. */
  attribute_mapping?: SsoAttributeMapping | null;
  /** OIDC only; null clears them. */
  oidc_scopes?: string[] | null;
  /** OIDC: declarative profile mapping; null clears it. */
  profile_mapping?: ProfileMapping | null;
  /** OIDC: token-endpoint client authentication (private_key_jwt needs no secret). */
  token_endpoint_auth_method?: TokenEndpointAuthMethod | null;
  client_assertion_audience?: string | null;
  /** OIDC: RP-initiated and back-channel logout. */
  logout?: UpstreamLogoutSettings | null;
  /** OIDC: third-party initiated login. */
  idp_initiated_login?: IdpInitiatedLoginSettings | null;
}

/** Claim (OIDC) or attribute (SAML) names for each profile field. */
export interface SsoAttributeMapping {
  email?: string;
  /** A remapped email is unverified unless this claim is mapped and true. */
  email_verified?: string;
  first_name?: string;
  last_name?: string;
  username?: string;
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
    /** OIDC: run the connection's profile mapping (or the body's) against a pasted sample. */
    previewProfileMapping(id: string, body: ProfileMappingPreviewBody): Promise<ProfileMappingPreview> {
      return request({ method: 'POST', path: `/v1/sso_connections/${enc(id)}/profile_mapping/preview`, body });
    },
    /** OIDC: the connection's private_key_jwt signing keys. */
    signingKeys(id: string) {
      return upstreamSigningKeys(request, `/v1/sso_connections/${enc(id)}`);
    },
    /** SP SAML metadata for a connection (JSON envelope carrying the XML). */
    samlMetadata(id: string): Promise<SamlMetadata> {
      return request({ method: 'GET', path: `/v1/sso_connections/${enc(id)}/saml_metadata` });
    },
    /** The SAML connection's SP encryption certificate(s). */
    getSamlEncryptionKey(id: string): Promise<SamlEncryptionKey> {
      return request({ method: 'GET', path: `/v1/sso_connections/${enc(id)}/saml_encryption_key` });
    },
    /**
     * Generate the SP encryption key pair, or ROTATE it when one exists: the
     * current pair becomes the previous one (still advertised and accepted until
     * {@link retirePreviousSamlEncryptionKey}).
     */
    createSamlEncryptionKey(id: string, idempotencyKey?: string): Promise<SamlEncryptionKey> {
      return request({ method: 'POST', path: `/v1/sso_connections/${enc(id)}/saml_encryption_key`, idempotencyKey });
    },
    /** Finish a rotation: stop accepting the previous encryption key. */
    retirePreviousSamlEncryptionKey(id: string): Promise<SamlEncryptionKey> {
      return request({ method: 'DELETE', path: `/v1/sso_connections/${enc(id)}/saml_encryption_key/previous` });
    },
    /** Turn assertion encryption off (refused while encrypted assertions are required). */
    deleteSamlEncryptionKey(id: string): Promise<SamlEncryptionKey> {
      return request({ method: 'DELETE', path: `/v1/sso_connections/${enc(id)}/saml_encryption_key` });
    },
  };
}
