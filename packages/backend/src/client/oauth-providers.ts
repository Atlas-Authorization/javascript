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
  /** Extra scopes the provider's API supports beyond sign-in. */
  api_scopes?: string[];
  /** The effective sign-in mode (in-page native library or redirect). */
  mode?: OAuthProviderMode;
  /** Native providers only: the JavaScript origins to register at the provider console. */
  javascript_origins?: string[];
  /** Atlas's own callback URL; a `custom_redirect_uri` forwards `?code&state` here. */
  atlas_callback?: string;
  /** Your own already-registered callback (migration), or null. */
  custom_redirect_uri?: string | null;
  /** The instance's icon override for this provider's button, or null. */
  icon_url?: string | null;
  /** Wallet providers only (siwe, siws, siwb, siwf): the stored verifier settings. */
  setting_values?: Record<string, string>;
}

export type OAuthProviderMode = 'native' | 'redirect';

/** `GET /v1/oauth_providers` filters. */
export interface ListOAuthProvidersParams {
  /** Only these catalogue keys (exact match, e.g. `google`). */
  provider?: string | string[];
  /** `true`: only providers with credentials stored; `false`: only those not set up. */
  configured?: boolean;
}

/**
 * Verifier settings for the wallet providers (no credentials). `null` or `""`
 * clears one; an unknown key is refused.
 */
export interface OAuthWalletSettings {
  /** siwe / siws / siwb / siwf: the expected domain (`hostname[:port]`). */
  domain?: string | null;
  /** siwe / siwf: allowed chain ids (positive integers, array or comma list). */
  chain_ids?: number[] | string | null;
  /** siwe: an https RPC URL; enables smart-contract (EIP-1271) wallets. */
  rpc_url?: string | null;
  /** siws: allowed networks. siwb: allowed Bitcoin networks (`mainnet`, `testnet`, `testnet4`, `signet`, `regtest`). */
  networks?: Array<'mainnet' | 'devnet' | 'testnet' | 'testnet4' | 'signet' | 'regtest'> | string | null;
  /** siwf: an https Optimism RPC URL, required to verify FID ownership. */
  optimism_rpc_url?: string | null;
  /** siwf: the Farcaster ID registry contract (`0x…`). */
  id_registry_address?: string | null;
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
  /**
   * Non-secret provider settings (e.g. `redirect_uri`), or the wallet
   * providers' verifier settings. `null` or `""` clears a setting.
   */
  settings?: Record<string, string | null> | OAuthWalletSettings;
  /** Your own already-registered callback URL (migration). */
  custom_redirect_uri?: string;
  native?: boolean;
  /** Force the sign-in mode; `""` or `null` clears the override. */
  mode?: OAuthProviderMode | '' | null;
  /** The brand shown on the button (e.g. "Discord"); empty or `null` clears. Display only. */
  display_name?: string | null;
  /** An http(s) or `data:image` icon for the button; empty or `null` clears. */
  icon_url?: string | null;
}

/** What `upsert` returns. */
export interface OAuthProviderUpsertResult {
  object: 'oauth_provider';
  provider: string;
  configured: boolean;
  enabled: boolean;
  /** Wallet providers only: the stored verifier settings after this write. */
  setting_values?: Record<string, string>;
  updated_fields: string[];
  warning?: string;
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
    list(params: ListOAuthProvidersParams = {}): Promise<ListPage<OAuthProvider>> {
      const provider = Array.isArray(params.provider) ? params.provider.join(',') : params.provider;
      return request({
        method: 'GET',
        path: '/v1/oauth_providers',
        query: { provider, configured: params.configured },
      });
    },
    get(provider: string): Promise<OAuthProvider> {
      return request({ method: 'GET', path: `/v1/oauth_providers/${enc(provider)}` });
    },
    /** Set (or replace) this instance's own credentials for a provider. */
    upsert(
      provider: string,
      body: UpsertOAuthProviderBody,
      idempotencyKey?: string,
    ): Promise<OAuthProviderUpsertResult> {
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
