import { enc, type RequestFn } from './request';

export type SamlNameIdFormat = 'emailAddress' | 'persistent' | 'transient' | 'unspecified';

/** A SAML service provider Atlas issues assertions to, with its depth settings. */
export interface SamlIdpServiceProvider {
  object: 'saml_idp_service_provider';
  id: string;
  name: string;
  entity_id: string;
  acs_url: string;
  acs_urls: string[];
  name_id_format: SamlNameIdFormat;
  name_id_field: 'email' | 'user_id';
  attributes: Record<string, string>;
  encrypt_assertions: boolean;
  has_encryption_cert: boolean;
  signing_cert_count: number;
  require_signed_requests: boolean;
  signature_algorithm: 'rsa-sha256' | 'rsa-sha384' | 'rsa-sha512';
  digest_algorithm: 'sha256' | 'sha384' | 'sha512';
  sign_response: boolean;
  artifact_binding: boolean;
  ecp: boolean;
  attribute_query: boolean;
  slo_url: string | null;
  slo_binding: 'redirect' | 'post' | 'soap' | null;
  authn_context_class_ref: string | null;
  assertion_lifetime_seconds: number;
}

/** Any of these; `null` clears an optional setting. */
export interface UpdateSamlIdpServiceProviderBody {
  name?: string;
  acs_urls?: string[];
  name_id_format?: SamlNameIdFormat;
  name_id_field?: 'email' | 'user_id';
  attributes?: Record<string, string>;
  encrypt_assertions?: boolean;
  encryption_cert?: string | null;
  signing_certs?: string[];
  require_signed_requests?: boolean;
  signature_algorithm?: 'rsa-sha256' | 'rsa-sha384' | 'rsa-sha512';
  digest_algorithm?: 'sha256' | 'sha384' | 'sha512';
  sign_response?: boolean;
  artifact_binding?: boolean;
  ecp?: boolean;
  attribute_query?: boolean;
  slo_url?: string | null;
  slo_binding?: 'redirect' | 'post' | 'soap';
  authn_context_class_ref?: string | null;
  assertion_lifetime_seconds?: number | null;
}

export interface SamlIdpSpMetadata {
  object: 'saml_idp_sp_metadata';
  saved: boolean;
  entity_id: string;
  acs_url: string;
  acs_urls: string[];
  name_id_format: SamlNameIdFormat;
  signing_certs: string[];
  encryption_cert: string | null;
  slo_url: string | null;
  slo_binding: string | null;
  authn_requests_signed: boolean;
  want_assertions_signed: boolean;
  requested_attributes: string[];
  service_provider?: SamlIdpServiceProvider | null;
}

/** Atlas as a SAML identity provider: service-provider settings and metadata import. */
export function samlIdpResource(request: RequestFn) {
  return {
    /** `GET /v1/saml_idp/service_providers` */
    list(): Promise<{ object: 'list'; data: SamlIdpServiceProvider[] }> {
      return request({ method: 'GET', path: '/v1/saml_idp/service_providers' });
    },
    /** `GET /v1/saml_idp/service_providers/:id` */
    get(id: string): Promise<SamlIdpServiceProvider> {
      return request({ method: 'GET', path: `/v1/saml_idp/service_providers/${enc(id)}` });
    },
    /** `PATCH /v1/saml_idp/service_providers/:id` — NameID format, encryption, request signing, algorithms, logout. */
    update(id: string, body: UpdateSamlIdpServiceProviderBody): Promise<SamlIdpServiceProvider> {
      return request({ method: 'PATCH', path: `/v1/saml_idp/service_providers/${enc(id)}`, body });
    },
    /** `POST /v1/saml_idp/service_providers/import_metadata` — preview, or save with `save_as`. */
    importMetadata(body: { metadata_xml?: string; metadata_url?: string; mdq_base_url?: string; entity_id?: string; federation_certificate?: string; save_as?: string; name?: string }): Promise<SamlIdpSpMetadata> {
      return request({ method: 'POST', path: '/v1/saml_idp/service_providers/import_metadata', body });
    },
  };
}

export type CloudProvider = 'aws' | 'gcp' | 'azure';

/** A cloud access target: an AWS account and role, a Google Cloud workforce pool, or an Azure trust. */
export interface CloudAccessTarget {
  object: 'cloud_access_target';
  id: string;
  provider: CloudProvider;
  name: string;
  config: Record<string, unknown>;
  assignment: Record<string, unknown> | null;
  launch_url: string | null;
  created_at: number;
  updated_at: number;
}

export interface CloudAccessSetup {
  object: 'cloud_access_setup';
  target_id: string;
  provider: CloudProvider;
  steps: string[];
  snippets: Record<string, string>;
  sources: string[];
}

/** Cloud access portal: account and role tiles for the launcher. */
export function cloudAccessResource(request: RequestFn) {
  return {
    list(provider?: CloudProvider): Promise<{ object: 'list'; data: CloudAccessTarget[] }> {
      return request({ method: 'GET', path: `/v1/cloud_access/targets${provider ? `?provider=${provider}` : ''}` });
    },
    get(id: string): Promise<CloudAccessTarget> {
      return request({ method: 'GET', path: `/v1/cloud_access/targets/${enc(id)}` });
    },
    create(body: { provider: CloudProvider; name: string; config: Record<string, unknown>; assignment?: Record<string, unknown> }): Promise<CloudAccessTarget> {
      return request({ method: 'POST', path: '/v1/cloud_access/targets', body });
    },
    update(id: string, body: { name?: string; config?: Record<string, unknown>; assignment?: Record<string, unknown> }): Promise<CloudAccessTarget> {
      return request({ method: 'PATCH', path: `/v1/cloud_access/targets/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'cloud_access_target'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/cloud_access/targets/${enc(id)}` });
    },
    /** The commands and policy to apply on the cloud side. */
    setup(id: string): Promise<CloudAccessSetup> {
      return request({ method: 'GET', path: `/v1/cloud_access/targets/${enc(id)}/setup` });
    },
  };
}

/** A WS-Federation relying-party connection (sign people in through AD FS or another WS-Federation provider). */
export interface WsFedConnection {
  object: 'wsfed_connection';
  id: string;
  organization_id: string | null;
  status: 'draft' | 'active' | 'disabled';
  issuer: string | null;
  passive_endpoint: string | null;
  realm: string | null;
  signing_certificate_count: number;
  allowed_domains: string[];
  attribute_mapping: Record<string, string>;
  freshness_minutes: number | null;
  auth_method: string | null;
  /** Enter as the reply URL of the provider's relying-party trust. */
  acs_url: string;
  logout_start_url: string;
  created_at: number;
  updated_at: number;
}

export interface WsFedConnectionBody {
  organization_id?: string | null;
  status?: 'draft' | 'active' | 'disabled';
  metadata_url?: string;
  metadata_xml?: string;
  issuer?: string;
  passive_endpoint?: string;
  signing_certificates?: string;
  realm?: string;
  allowed_domains?: string[];
  attribute_mapping?: Record<string, string> | null;
  freshness_minutes?: number | null;
  auth_method?: string | null;
}

export function wsfedConnectionsResource(request: RequestFn) {
  return {
    list(): Promise<{ object: 'list'; data: WsFedConnection[] }> {
      return request({ method: 'GET', path: '/v1/wsfed_connections' });
    },
    get(id: string): Promise<WsFedConnection> {
      return request({ method: 'GET', path: `/v1/wsfed_connections/${enc(id)}` });
    },
    create(body: WsFedConnectionBody): Promise<WsFedConnection> {
      return request({ method: 'POST', path: '/v1/wsfed_connections', body });
    },
    update(id: string, body: WsFedConnectionBody): Promise<WsFedConnection> {
      return request({ method: 'PATCH', path: `/v1/wsfed_connections/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'wsfed_connection'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/wsfed_connections/${enc(id)}` });
    },
  };
}
