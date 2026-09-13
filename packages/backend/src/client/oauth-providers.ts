import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** One credential input a provider needs (client_id, team_id, private key…). */
export interface OAuthProviderCredentialField {
  key: string;
  label: string;
  /** Stored encrypted and never returned. */
  secret?: boolean;
  multiline?: boolean;
  optional?: boolean;
  help?: string;
}

/** A provider-specific option beyond credentials (Google `hd`, tenant, prompt…). */
export interface OAuthProviderSetting {
  key: string;
  label: string;
  type: 'string' | 'boolean' | 'select';
  options?: string[];
  help?: string;
}

/**
 * A single social sign-in provider row: the whole catalog entry plus whatever is
 * configured for this instance, and NEVER the secret — only `has_secret`. The
 * `redirect_uri` is derived from the instance's own FAPI host (the exact string
 * to register at the provider console), never accepted from the caller.
 */
export interface OAuthProvider {
  object: 'oauth_provider';
  provider: string;
  display_name: string;
  category: string;
  tier: string;
  setup_docs_url: string | null;
  default_scopes: string[];
  credential_fields: OAuthProviderCredentialField[];
  settings: OAuthProviderSetting[];
  native: boolean;
  redirect_uri: string;
  configured: boolean;
  client_id: string | null;
  has_secret: boolean;
  enabled: boolean;
  /** §6.5 which screens this provider serves. Both default true. */
  allow_sign_in: boolean;
  allow_sign_up: boolean;
  scopes: string[];
  updated_at: number | null;
}

/**
 * Credentials for the redirect code-exchange flow. `client_id`/`client_secret`
 * cover the common two-field case; `values` carries the exact per-field shape for
 * providers that need more (Apple team/key id, etc.), and `settings` the
 * provider-specific options. The secret is write-only.
 */
export interface UpsertOAuthProviderBody {
  client_id?: string;
  /** Write-only; stored encrypted, never returned. Required for redirect-only providers. */
  client_secret?: string;
  scopes?: string[];
  values?: Record<string, string>;
  settings?: Record<string, string>;
}

/** The connectivity test's honest verdict: what it proved, and what it did not. */
export interface OAuthConnectionTest {
  object: 'oauth_connection_test';
  provider: string;
  ok: boolean;
  reason: string;
  message: string;
  /** The credential facts this check verified. */
  checked: string[];
  /** What a pass deliberately does NOT prove (redirect registration, consent…). */
  not_checked: string[];
}

export function oauthProvidersResource(request: RequestFn) {
  return {
    /** The whole catalog, configured or not — a not-yet-set-up provider is exactly the one a setup agent wants. */
    list(): Promise<ListPage<OAuthProvider>> {
      return request({ method: 'GET', path: '/v1/oauth_providers' });
    },
    get(provider: string): Promise<OAuthProvider> {
      return request({ method: 'GET', path: `/v1/oauth_providers/${enc(provider)}` });
    },
    /** Set (or replace) this instance's own credentials for a provider. */
    upsert(
      provider: string,
      body: UpsertOAuthProviderBody,
      idempotencyKey?: string,
    ): Promise<{ object: 'oauth_provider'; provider: string; configured: true }> {
      return request({
        method: 'PUT',
        path: `/v1/oauth_providers/${enc(provider)}`,
        body,
        idempotencyKey,
      });
    },
    delete(
      provider: string,
    ): Promise<{ object: 'oauth_provider'; provider: string; deleted: true; note: string }> {
      return request({ method: 'DELETE', path: `/v1/oauth_providers/${enc(provider)}` });
    },
    /** Turn a configured provider on or off. Refused if it has no usable credentials. */
    setEnabled(
      provider: string,
      enabled: boolean,
    ): Promise<{ object: 'oauth_provider'; provider: string; enabled: boolean }> {
      return request({
        method: 'POST',
        path: `/v1/oauth_providers/${enc(provider)}/enabled`,
        body: { enabled },
      });
    },
    /** §6.5 which screens this provider serves. At least one must be true. */
    setScope(
      provider: string,
      body: { allow_sign_in: boolean; allow_sign_up: boolean },
    ): Promise<{
      object: 'oauth_provider';
      provider: string;
      allow_sign_in: boolean;
      allow_sign_up: boolean;
    }> {
      return request({
        method: 'POST',
        path: `/v1/oauth_providers/${enc(provider)}/scope`,
        body,
      });
    },
    /** Verify the stored credentials against the provider's token endpoint, without enabling it. */
    test(provider: string): Promise<OAuthConnectionTest> {
      return request({ method: 'POST', path: `/v1/oauth_providers/${enc(provider)}/test` });
    },
  };
}
