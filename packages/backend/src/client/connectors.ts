import { enc, type RequestFn } from './request';

/** How an installing instance gets OAuth credentials for a connector. */
export type ConnectorShareMode = 'prefill' | 'full_shared' | 'full_idp';

/**
 * A community connector profile you publish to the connector directory: its
 * public listing, OAuth config and share modes. The shared client secret is
 * never returned.
 */
export interface CommunityConnector {
  object: 'connector';
  id: string;
  slug: string;
  display_name: string;
  logo_url?: string | null;
  tagline?: string | null;
  description?: string | null;
  category: string;
  tags: unknown[];
  website_url?: string | null;
  docs_url?: string | null;
  support_url?: string | null;
  setup_guide?: string | null;
  protocol: string;
  authorization_endpoint?: string | null;
  token_endpoint?: string | null;
  userinfo_endpoint?: string | null;
  issuer?: string | null;
  default_scopes: string[];
  api_scopes?: unknown[];
  credential_fields?: unknown[];
  share_modes: ConnectorShareMode[];
  shared_client_id?: string | null;
  shared_revoked: boolean;
  idp_issuer?: string | null;
  idp_auto_register: boolean;
  status: 'draft' | 'published' | 'unlisted' | 'banned';
  verified: boolean;
  featured: boolean;
  install_count: number;
  view_count: number;
  rating_avg: number;
  rating_count: number;
  /** Epoch ms. */
  created_at: number;
  /** Epoch ms. */
  updated_at: number;
}

/** Fields of a connector profile you can set on create or update. */
export interface UpdateCommunityConnectorBody {
  slug?: string;
  display_name?: string;
  logo_url?: string;
  tagline?: string;
  description?: string;
  category?: string;
  tags?: string[];
  website_url?: string;
  docs_url?: string;
  support_url?: string;
  screenshots?: unknown[];
  setup_guide?: string;
  protocol?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  issuer?: string;
  default_scopes?: string[];
  api_scopes?: unknown[];
  credential_fields?: unknown[];
  authorization_params?: Record<string, unknown>;
  quirks?: Record<string, unknown>;
  share_modes?: ConnectorShareMode[];
  idp_instance_id?: string;
  idp_issuer?: string;
  idp_auto_register?: boolean;
}

/** `slug` is globally unique and may not shadow a built-in provider. */
export interface CreateCommunityConnectorBody extends UpdateCommunityConnectorBody {
  slug: string;
  display_name: string;
}

/** Set or rotate (`client_id` + `client_secret`) or revoke (`revoke: true`) the full_shared credentials. */
export interface ConnectorSharedCredentialsBody {
  client_id?: string;
  client_secret?: string;
  revoke?: boolean;
}

export interface InstallConnectorBody {
  share_mode: ConnectorShareMode;
  /** Your own credentials (prefill mode). */
  client_id?: string;
  client_secret?: string;
  scopes?: string[];
}

export interface ConnectorInstall {
  object: 'connector_install';
  connector: string;
  share_mode: string;
  provider_key?: string;
  /** True when the install still needs your own client credentials. */
  needs_credentials?: boolean;
}

export interface ConnectorReview {
  object: 'connector_review';
  connector: string;
  rating: number;
}

/** A directory entry (built-in provider or community connector). Keys are camelCase. */
export interface ConnectorDirectoryEntry {
  source: 'builtin' | 'community';
  key: string;
  slug: string;
  displayName: string;
  category: string;
  tagline?: string | null;
  description?: string | null;
  logoUrl?: string | null;
  websiteUrl?: string | null;
  docsUrl?: string | null;
  verified?: boolean;
  featured?: boolean;
  installCount?: number;
  ratingAvg?: number;
  ratingCount?: number;
  rankScore?: number;
  defaultScopes?: string[];
  apiScopes?: unknown[];
  credentialFields?: unknown[];
  shareModes?: string[];
}

export interface ConnectorDirectoryParams {
  category?: string;
  /** Only verified community connectors. */
  verified?: boolean;
  /** Free-text search. */
  q?: string;
  limit?: number;
  offset?: number;
}

export function connectorsResource(request: RequestFn) {
  return {
    /** Your own connector profiles (draft and published). */
    list(): Promise<{ object: 'list'; data: CommunityConnector[]; has_more: false }> {
      return request({ method: 'GET', path: '/v1/connectors' });
    },
    create(
      body: CreateCommunityConnectorBody,
      idempotencyKey?: string,
    ): Promise<CommunityConnector> {
      return request({ method: 'POST', path: '/v1/connectors', body, idempotencyKey });
    },
    get(id: string): Promise<CommunityConnector> {
      return request({ method: 'GET', path: `/v1/connectors/${enc(id)}` });
    },
    update(id: string, body: UpdateCommunityConnectorBody): Promise<CommunityConnector> {
      return request({ method: 'PATCH', path: `/v1/connectors/${enc(id)}`, body });
    },
    /** Deletes the profile and its installs, reviews and reports. */
    delete(id: string): Promise<{ object: 'connector'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/connectors/${enc(id)}` });
    },
    /** List it in the public directory (unverified until reviewed). */
    publish(id: string): Promise<CommunityConnector> {
      return request({ method: 'POST', path: `/v1/connectors/${enc(id)}/publish` });
    },
    /** Take it out of the directory without deleting it. */
    unlist(id: string): Promise<CommunityConnector> {
      return request({ method: 'POST', path: `/v1/connectors/${enc(id)}/unlist` });
    },
    /** Set, rotate or revoke the full_shared credentials. Revoking stops every install. */
    setSharedCredentials(
      id: string,
      body: ConnectorSharedCredentialsBody,
    ): Promise<CommunityConnector> {
      return request({
        method: 'POST',
        path: `/v1/connectors/${enc(id)}/shared_credentials`,
        body,
      });
    },
    /** Enable a published connector (by slug) on this instance. */
    install(slug: string, body: InstallConnectorBody): Promise<ConnectorInstall> {
      return request({ method: 'POST', path: `/v1/connectors/${enc(slug)}/install`, body });
    },
    /** Rate a connector you installed, 1–5, with optional text. */
    review(slug: string, body: { rating: number; body?: string }): Promise<ConnectorReview> {
      return request({ method: 'POST', path: `/v1/connectors/${enc(slug)}/reviews`, body });
    },
    /** Browse built-in providers plus published community connectors, popular first. */
    directory(
      params: ConnectorDirectoryParams = {},
    ): Promise<{ object: 'list'; data: ConnectorDirectoryEntry[] }> {
      return request({ method: 'GET', path: '/v1/directory', query: { ...params } });
    },
  };
}
