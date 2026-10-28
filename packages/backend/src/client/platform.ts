import { metadataQuery, type ProvisioningFields, type ProvisioningInput, type ProvisioningMetadata } from './compliance';
import type { KeyKind, StandardKey, Whoami } from './credentials';
import {
  createKeyedRequest,
  enc,
  type AtlasRequestSettings,
  type RequestFn,
  type UnknownFieldsEvent,
} from './request';
import type { ListPage } from './types';
import type {
  BackchannelDeliveriesQuery,
  BackchannelLogoutDeliveryPage,
  BackchannelLogoutTest,
} from './oauth-clients';
import type { AllowedOriginInput, OriginMove, OriginMoveRequest, PreflightFinding } from './instance';
import type { ConfigChangelogEntry, ListConfigChangelogParams } from './activity';
import type {
  AtlasDesign,
  AtlasDesignPatch,
  DeletedDesignAsset,
  DesignAsset,
  DesignAssetData,
  DesignPreview,
  ResolvedAtlasDesign,
  UploadDesignAssetOptions,
} from './design';

/** `GET /v1/platform/atlas_id_apps/{id}/preflight`. */
export interface AtlasIdAppPreflight {
  object: 'preflight';
  app_id: string;
  /** True when there are no error-severity findings. */
  ok: boolean;
  checked_at: number;
  user_count: number;
  findings: PreflightFinding[];
  /** The page origins the Sign in with Atlas button script ran on in the last 7 days. */
  button_rendered_origins?: { origin: string; last_seen_at: number; requests: number }[];
  /** How the last 7 days' sign-ins started: the rendered button, the script API, One Tap, the no-script fallback, or unmarked. */
  authorize_requests_7d?: { button: number; js: number; fedcm: number; fallback: number; unmarked: number };
  /** Origins of sign-ins that came through the no-script fallback link (`?atlasid_fallback=1`). */
  fallback_origins?: { origin: string; last_seen_at: number; requests: number }[];
  /** Whether the app's homepage references the button script (null = could not check). */
  homepage_includes_script?: boolean | null;
}

/**
 * The platform client: the platform-key (`psk_...`) surface for provisioning and
 * managing apps you own, and for registering Sign in with Atlas apps.
 *
 * A separate client from `createAtlasClient`, because the key is different: a
 * platform key manages many apps, a secret key manages exactly one instance.
 */
export interface AtlasPlatformClientConfig {
  /**
   * The platform key (`atlas_live_psk_…` or legacy `psk_…`), or a one-hour
   * platform-bound access token from `exchangeOperatorToken`. Sent as
   * `Authorization: Bearer <key>`; never logged.
   */
  platformKey: string;
  /** Sealed secret delivery (`x25519:<public key>`); see AtlasClientConfig.secretRecipient. */
  secretRecipient?: string;
  /** Base URL of the API, e.g. `https://api.atlasauth.net`. */
  apiUrl?: string;
  /** Injectable `fetch`, for tests and non-global-fetch runtimes. */
  fetch?: typeof fetch;
  /** `true` sends `Atlas-Strict: true` on every write (unknown body fields → 422). */
  strict?: boolean;
  /** Called with the body fields Atlas ignored on a successful write. */
  onUnknownFields?: (event: UnknownFieldsEvent) => void;
}

// ---- apps ------------------------------------------------------------------

/** An app (instance) a platform owns. Never carries a secret. */
export interface PlatformApp extends ProvisioningFields {
  object: 'app';
  id: string;
  name: string;
  environment: 'production' | 'development';
  publishable_key: string;
  /** The Frontend API host: the default per-app host, or the custom domain once it is active. */
  frontend_api_host: string | null;
  /**
   * The `iss` this app's session tokens carry. It changes when a custom domain
   * goes active, so read it (and the two URLs below) rather than hard-coding it.
   */
  issuer: string;
  /** The OpenID discovery document whose `issuer` equals {@link issuer}. */
  discovery_url: string;
  /** The JWKS holding this app's signing keys. */
  jwks_uri: string;
  allowed_origins: string[];
  /** The declared integration per allowed origin. Write `allowed_origins` entries as `{ origin, integration }` to set one. */
  allowed_origin_integrations?: Record<string, 'redirect' | 'embedded'>;
  /** Housekeeping labels (up to 20, each up to 40 chars). */
  tags: string[];
  /** Hidden from the default listing. A visibility flag only: the app still serves auth. */
  archived: boolean;
  /** Epoch ms the app was archived, or null. */
  archived_at: number | null;
  disabled: boolean;
  created_at: number;
  updated_at: number;
}

/** An app plus its secret key (`sk_...`), revealed exactly once. */
export interface PlatformAppWithSecret extends PlatformApp {
  secret: string;
  note?: string;
}

/** The create response: the app, its secret and (by default) its test-mode sibling. */
export interface CreatedPlatformApp extends PlatformAppWithSecret {
  /**
   * The sibling instance in the opposite environment (development for a
   * production app) with its own publishable key and reveal-once secret.
   * Absent when `create_development_sibling: false`.
   */
  sibling_instance?: PlatformAppWithSecret;
}

export interface CreatePlatformAppBody {
  name?: string;
  environment?: 'production' | 'development';
  /** Origin strings, or `{ origin, integration }` entries (`redirect` | `embedded` | `auto`). */
  allowed_origins?: AllowedOriginInput[];
  /** Default true: also provision a test-mode sibling instance. */
  create_development_sibling?: boolean;
  tags?: string[];
  metadata?: ProvisioningMetadata;
  /** A stable key of your own: a repeat create with it returns the existing app (200, no secret). */
  external_ref?: string;
}

export interface UpdatePlatformAppBody {
  name?: string;
  /** Origin strings, or `{ origin, integration }` entries (`redirect` | `embedded` | `auto`). */
  allowed_origins?: AllowedOriginInput[];
  tags?: string[];
  /** Replaces the provisioning metadata. */
  metadata?: ProvisioningMetadata;
}

export interface ListPlatformAppsParams {
  /** Only apps carrying this tag. */
  tag?: string;
  /** `true`: only archived apps. */
  archived?: boolean;
  /** `true`: include archived apps alongside active ones. */
  include_archived?: boolean;
  /** Only apps whose provisioning metadata matches every pair. */
  metadata?: ProvisioningMetadata;
}

export interface CreatePlatformInstanceBody extends ProvisioningInput {
  environment?: 'production' | 'development';
  /** Origin strings, or `{ origin, integration }` entries (`redirect` | `embedded` | `auto`). */
  allowed_origins?: AllowedOriginInput[];
}

export interface PlatformAppSecretRotation {
  object: 'app_secret';
  app_id: string;
  /** The new secret key, revealed exactly once. */
  secret: string;
  overlap_seconds: number;
  /** When the prior keys stop working (epoch ms); null on a hard cut. */
  previous_keys_expire_at?: number | null;
  note: string;
}

export interface PlatformInstanceSecretRotation {
  object: 'app_secret';
  app_id: string;
  instance_id: string;
  /** @deprecated Never sent; read `instance_id`. */
  id?: string;
  /** The new secret key, revealed exactly once. */
  secret: string;
  /** The overlap applied, in seconds. */
  overlap_seconds: number;
  /** When the prior keys stop working (epoch ms); null on a hard cut. */
  previous_keys_expire_at: number | null;
  note: string;
}

/** Body of the platform app and instance rotate_secret calls. */
export interface RotatePlatformSecretBody {
  /** How long the prior keys keep working, in seconds. Default 259200 (72 hours). `0` revokes them now. At most 604800 (7 days). */
  overlap_seconds?: number;
}

/** Body of the Sign in with Atlas app rotate calls (client secret and webhook secret). */
export interface RotateAtlasIdAppSecretBody {
  /**
   * How long the previous secret keeps working, in seconds; at most 604800 (7
   * days). Default for the client secret: 86400 (24 hours). Default for the
   * webhook secret: 0 (it stops signing at once). `0` stops it now.
   */
  overlap_seconds?: number;
}

/** Metadata of a currently-valid secret key. Never the secret itself. */
export interface PlatformSecretKey extends ProvisioningFields {
  object: 'secret_key';
  id: string;
  name?: string | null;
  prefix: string;
  created_at: number;
  expires_at?: number | null;
}

export interface PlatformAppTransfer {
  object: 'app_transfer';
  id: string;
  /** One-time token for the receiving platform's `apps.acceptTransfer`. */
  transfer_token: string;
  expires_at: number;
  note: string;
}

export interface PlatformAppBulkDeleteResult {
  object: 'bulk_delete_result';
  /** `disable` (ids) or `hard_delete` (a sandbox metadata selection). */
  mode?: 'disable' | 'hard_delete';
  dry_run?: boolean;
  results: Array<{ id: string; type?: string; instance_id?: string; deleted: boolean; reason?: string }>;
  changes?: Array<{ section: string; before: unknown; after: unknown }>;
}

/** A sandbox teardown selection: must carry `sandbox: true`. */
export interface SandboxTeardownBody {
  metadata: ProvisioningMetadata;
  dry_run?: boolean;
}

/** A named, tagged extra secret key for an app. */
export interface CreatePlatformSecretKeyBody extends ProvisioningInput {
  name?: string;
  /** Any instance of the same app; default the app's own. */
  instance_id?: string;
}

export interface CreatedPlatformSecretKey extends PlatformSecretKey {
  app_id: string;
  instance_id: string;
  /** Present only on a fresh create (never on an idempotent replay). */
  secret?: string;
  note?: string;
}

export interface CloneConfigBody {
  /** Default `development`. */
  to_environment?: 'development' | 'production';
  target_instance_id?: string;
  /** Default auth_config, roles, redirect_urls. */
  sections?: Array<'auth_config' | 'allowed_origins' | 'roles' | 'redirect_urls'>;
  include_origins?: boolean;
  dry_run?: boolean;
}

export interface CloneConfigResult {
  object: 'clone_config_result' | 'dry_run';
  source_instance_id: string;
  target_instance_id: string | null;
  to_environment: string;
  created_target: boolean;
  sections: string[];
  excluded: Array<{ path: string; reason: 'secret' | 'instance_specific' }>;
  never_copied: string[];
  changes: Array<{ section: string; before: unknown; after: unknown }>;
  target?: PlatformApp | null;
  /** When a new instance was created for the clone: its secret key, shown once. */
  secret?: string;
  note?: string;
}

export interface AccountlessApp {
  object: 'accountless_app';
  id: string;
  name: string;
  environment: string;
  publishable_key: string;
  /** One-time token the new owner passes to `apps.claim`. */
  claim_token: string;
  expires_at: number;
  note: string;
}

export interface CreateAccountlessAppBody {
  name?: string;
  environment?: 'production' | 'development';
  /** Origin strings, or `{ origin, integration }` entries (`redirect` | `embedded` | `auto`). */
  allowed_origins?: AllowedOriginInput[];
}

// ---- Sign in with Atlas apps --------------------------------------------------

/** Page text on the Sign in with Atlas page. Plain text; null or empty uses the default. */
export interface AtlasIdAppCopy {
  /** Default "Sign in" (the app is named on the "to continue to {app}" line under it). */
  sign_in_title?: string | null;
  sign_in_subtitle?: string | null;
  /** Default "Create your Atlas Account". */
  sign_up_title?: string | null;
  sign_up_subtitle?: string | null;
  /** Shown on the consent screen above the list of permissions. */
  consent_message?: string | null;
  /** https URL, linked in the page footer. */
  support_url?: string | null;
  /** Text of the support link. Default "Help". */
  support_label?: string | null;
}

/** How the Sign in with Atlas page and consent screen look for an app. */
export interface AtlasIdAppBranding {
  theme: 'auto' | 'light' | 'dark';
  accent_color: string | null;
  background_color: string | null;
  privacy_policy_url: string | null;
  terms_of_service_url: string | null;
  /** The stored design overrides (null = none). */
  design?: AtlasDesign | null;
  resolved_design?: ResolvedAtlasDesign;
  copy: AtlasIdAppCopy;
}

/**
 * Branding input. On update each field merges with what is stored; `null`
 * clears a field, and `branding: null` clears all of it.
 */
export interface AtlasIdAppBrandingInput {
  /** Default `auto` (follows the visitor's system setting). */
  theme?: 'auto' | 'light' | 'dark' | null;
  /** Button colour, `#RRGGBB`. */
  accent_color?: string | null;
  /** Page background behind the card, `#RRGGBB`. */
  background_color?: string | null;
  /** https URL, linked in the page footer. */
  privacy_policy_url?: string | null;
  terms_of_service_url?: string | null;
  /** Merged like a design patch over what is stored; `null` removes the design. */
  design?: AtlasDesignPatch | null;
  copy?: AtlasIdAppCopy;
}

/** A Sign in with Atlas app: an OpenID Connect client on the Atlas issuer. */
export interface AtlasIdApp extends ProvisioningFields {
  object: 'atlas_id_app';
  id: string;
  client_id: string;
  name: string;
  logo_url?: string | null;
  homepage_url?: string | null;
  branding?: AtlasIdAppBranding;
  redirect_uris: string[];
  post_logout_redirect_uris: string[];
  backchannel_logout_uri: string | null;
  backchannel_logout_session_required: boolean;
  frontchannel_logout_uri: string | null;
  frontchannel_logout_session_required: boolean;
  allowed_scopes: string[];
  type: 'confidential' | 'public';
  secret_prefix?: string | null;
  /** The instance that manages this app's grants (its scoped key lists and revokes them), or null. */
  managed_by_instance_id?: string | null;
  /** `instance_toggle`: an instance's Sign in with Atlas toggle app; `adopted`: handed to an instance with `setManagedBy`. */
  managed_via?: 'instance_toggle' | 'adopted' | null;
  created_at: number;
  updated_at: number;
  /** On `get` only: people who have approved the app. */
  user_count?: number;
  /** The per-app webhook URL, or null. */
  webhook_url?: string | null;
  webhook_events?: Array<'user.updated' | 'user.deleted' | 'grant.revoked'>;
  /** false once auto-disabled after repeated failures; null without a webhook. */
  webhook_active?: boolean | null;
  /** While a webhook secret rotation overlap is open: when the previous secret stops signing deliveries (epoch ms); else null. */
  webhook_previous_secret_expires_at?: number | null;
  /** After a client secret rotation with overlap: when the previous secret stops working (epoch ms); else null. */
  previous_secret_expires_at?: number | null;
  /** When the current client secret was issued (epoch ms); null for a public app. */
  secret_issued_at?: number | null;
  /** Test sign-in mode: `+atlas_test` addresses on a verified domain sign in to this app with the fixed code 424242. */
  test_mode?: boolean;
  /** Test and review accounts must use an address on a domain you verified. */
  provisioned_verified_domains_only?: boolean;
}

/** A Sign in with Atlas test or review account: confined to the app(s) it was made for. */
export interface AtlasIdProvisionedAccount {
  object: 'atlas_id_provisioned_account';
  id: string;
  /** The Atlas ID subject the app sees. */
  sub: string;
  email: string | null;
  email_verified: boolean;
  label: string;
  kind: 'provisioned' | 'test_mode' | 'developer';
  provisioned_by: 'app' | 'staff';
  app_ids: string[];
  apps: Array<{ id: string; client_id: string; name: string }>;
  any_app: boolean;
  two_factor_exempt: boolean;
  /** Epoch ms; null = never expires. */
  expires_at: number | null;
  expired: boolean;
  developer_account_id: string | null;
  created_by: { type: string; id: string };
  last_sign_in_at: number | null;
  password_rotated_at: number | null;
  created_at: number;
  updated_at: number;
  /** Only on create and password rotation: the password, returned exactly once. */
  password?: string;
  /** With a `secretRecipient`: the password sealed to it. */
  sealed_password?: string;
  note?: string;
}

export interface AtlasIdProvisionedAccountList {
  object: 'list';
  data: AtlasIdProvisionedAccount[];
  /** The account-wide cap (default 25). */
  limit: number;
  /** Test accounts the account holds across all its apps. */
  total: number;
}

export interface CreateAtlasIdProvisionedAccountBody {
  email: string;
  /** What the account is for, e.g. "app-store reviewer". */
  label: string;
  /** At least 12 characters. Omit it and Atlas generates one. Returned once either way. */
  password?: string;
  /** Default true. */
  email_verified?: boolean;
  /** Never asked for a second factor when signing in to this app. A risk you opt into. */
  two_factor_exempt?: boolean;
  /** Epoch ms or ISO 8601; omit or null for a non-expiring account. */
  expires_at?: number | string | null;
}

export interface RotateAtlasIdProvisionedPasswordBody {
  /** At least 12 characters; omit it and Atlas generates one. */
  password?: string;
}

/** A domain the account claimed; verified ones gate test sign-in mode. */
export interface AccountDomain {
  object: 'account_domain';
  id: string;
  domain: string;
  verified: boolean;
  verified_at: number | null;
  last_checked_at: number | null;
  verification: { type: 'TXT'; name: string; value: string };
  record_found?: boolean;
  created_at: number;
}

/** Create / rotate response: confidential apps carry the client secret exactly once. */
export interface AtlasIdAppWithSecret extends AtlasIdApp {
  client_secret?: string;
  /** With a `secretRecipient`: the client secret sealed to it. */
  sealed_client_secret?: string;
  /** The per-app webhook signing secret, returned exactly once (first set, or rotated). */
  webhook_secret?: string;
  /** With a `secretRecipient`: the webhook secret sealed to it. */
  sealed_webhook_secret?: string;
  /** On a rotation: the overlap applied, in seconds. */
  overlap_seconds?: number;
  note?: string;
}

/** A person who has approved a Sign in with Atlas app (privacy-request lookup). */
export interface AtlasIdAppUser {
  object: 'atlas_id_user';
  atlas_id_user: true;
  /** The user id as this app sees it (the id_token `sub`). */
  sub: string;
  grant_id: string;
  scopes: string[];
  granted_at: number;
}

/** A revoked grant: the app's refresh tokens for the user stop working. */
export interface AtlasIdGrantRevocation {
  object: 'atlas_id_grant';
  id: string;
  sub: string;
  revoked: true;
  tokens_revoked?: number;
  backchannel_logouts?: number;
}

/** The account's Sign in with Atlas publisher (name + DNS-verified domain). */
export interface AtlasIdPublisher {
  object: 'atlas_id_publisher';
  name: string;
  domain: string;
  verified: boolean;
  verified_at?: number | null;
  /** Publisher-wide consent for verified apps (openid / email / profile only). */
  skip_consent: boolean;
  /** The TXT record to publish. */
  verification: { record_name: string; record_type: 'TXT'; record_value: string };
  last_checked_at?: number | null;
  created_at?: number;
  updated_at?: number;
  /** On `verify` only: whether the TXT record matched. */
  record_found?: boolean;
}

export interface SetAtlasIdPublisherBody {
  /** Shown on consent screens once verified (up to 100 characters). */
  name: string;
  /** The host your apps' homepage_url lives on, e.g. `example.com`. */
  domain: string;
  skip_consent?: boolean;
}

export interface AtlasIdAppList {
  object: 'list';
  data: AtlasIdApp[];
  /** The issuer every app's tokens carry. */
  issuer: string;
  discovery_url: string;
  /** How many apps the account may register. */
  limit: number;
}

interface AtlasIdAppFields {
  /** Where `/oauth2/logout` may send the user after sign-out (exact match). */
  post_logout_redirect_uris?: string[];
  /** Back-Channel Logout: a signed `logout_token` is POSTed here when the user signs out. */
  backchannel_logout_uri?: string | null;
  /** Whether the app needs `sid` in the logout_token (Atlas always includes it). */
  backchannel_logout_session_required?: boolean;
  /** Front-Channel Logout: loaded in a hidden iframe on the Atlas sign-out page. */
  frontchannel_logout_uri?: string | null;
  /** Add `sid` to the front-channel logout URL. */
  frontchannel_logout_session_required?: boolean;
  logo_url?: string | null;
  homepage_url?: string | null;
  allowed_scopes?: string[];
  branding?: AtlasIdAppBrandingInput | null;
}

export interface CreateAtlasIdAppBody extends AtlasIdAppFields, ProvisioningInput {
  name: string;
  redirect_uris: string[];
  /** Default `confidential`. */
  type?: 'confidential' | 'public';
}

export interface UpdateAtlasIdAppBody extends AtlasIdAppFields {
  name?: string;
  /** Replaces the provisioning metadata. */
  metadata?: ProvisioningMetadata;
  redirect_uris?: string[];
  /**
   * Per-app webhook (public https): user.updated, user.deleted and grant.revoked for
   * this app's users. Setting it the first time returns `webhook_secret` once; null removes it.
   */
  webhook_url?: string | null;
  /** Turn test sign-in mode on or off. Turning it on needs a verified domain on the account. */
  test_mode?: boolean;
  /** Require test and review accounts to use an address on a domain you verified. */
  provisioned_verified_domains_only?: boolean;
}

// ---- account audit ----------------------------------------------------------------

export interface AccountAuditRecord {
  object: 'account_audit_log';
  id: string;
  account_id: string;
  actor: { type: string; id: string | null };
  action: string;
  target: { type: string | null; id: string | null };
  instance_id: string | null;
  ip: string | null;
  user_agent: string | null;
  metadata: Record<string, unknown>;
  created_at: number;
}

export interface AccountAuditStream {
  object: 'account_audit_stream';
  id: string;
  url: string;
  format: 'atlas' | 'cloudevents';
  active: boolean;
  has_secret: true;
  cursor: string | null;
  consecutive_failures: number;
  failing_since: number | null;
  next_attempt_at: number | null;
  last_delivered_at: number | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

// ---- the client ----------------------------------------------------------------

function platformNamespaces(request: RequestFn) {
  return {
    /** Introspect the platform key / token this client uses. */
    whoami(): Promise<Whoami> {
      return request({ method: 'GET', path: '/v1/platform/whoami' });
    },
    /** Every credential on the account (incl. revoked), and minting/revoking them. */
    keys: {
      list(params: { kind?: KeyKind; status?: StandardKey['status']; instance_id?: string } = {}): Promise<ListPage<StandardKey>> {
        return request({ method: 'GET', path: '/v1/platform/keys', query: { ...params } });
      },
      /** Scopes ⊆ the caller's; per-app grant scopes `atlas_id_apps:<app id>:grants:read|write` allowed. */
      create(body: {
        scopes: string[];
        name?: string;
        application_ids?: string[];
        expires_at?: number | string;
        ip_allowlist?: string[];
        owner?: string;
        key_format?: 'atlas' | 'legacy';
      }): Promise<{ object: 'platform_api_key'; id: string; prefix: string; scopes: string[]; secret?: string; sealed_secret?: string }> {
        return request({ method: 'POST', path: '/v1/platform/keys', body });
      },
      update(id: string, body: { name?: string | null; owner?: string | null; expires_at?: number | string | null }): Promise<{ object: 'platform_api_key'; id: string }> {
        return request({ method: 'PATCH', path: `/v1/platform/keys/${enc(id)}`, body });
      },
      revoke(id: string): Promise<{ object: 'key'; id: string; kind: KeyKind; revoked: true }> {
        return request({ method: 'POST', path: `/v1/platform/keys/${enc(id)}/revoke` });
      },
    },
    /** The account audit log and its streams. */
    audit: {
      list(params: { limit?: number; starting_after?: string; action?: string } = {}): Promise<ListPage<AccountAuditRecord>> {
        return request({ method: 'GET', path: '/v1/platform/audit_logs', query: { ...params } });
      },
      streams: {
        list(): Promise<ListPage<AccountAuditStream>> {
          return request({ method: 'GET', path: '/v1/platform/audit_streams' });
        },
        create(body: { url: string; format?: 'atlas' | 'cloudevents' }): Promise<AccountAuditStream & { secret?: string; sealed_secret?: string }> {
          return request({ method: 'POST', path: '/v1/platform/audit_streams', body });
        },
        update(id: string, body: { url?: string; format?: 'atlas' | 'cloudevents'; active?: boolean }): Promise<AccountAuditStream> {
          return request({ method: 'PATCH', path: `/v1/platform/audit_streams/${enc(id)}`, body });
        },
        delete(id: string): Promise<{ object: 'account_audit_stream'; id: string; deleted: true }> {
          return request({ method: 'DELETE', path: `/v1/platform/audit_streams/${enc(id)}` });
        },
        test(id: string): Promise<{ id: string; ok: boolean; status: number | null; error?: string }> {
          return request({ method: 'POST', path: `/v1/platform/audit_streams/${enc(id)}/test` });
        },
      },
    },
    apps: {
      /** Archived apps are hidden unless `include_archived` or `archived` is set. */
      list(params: ListPlatformAppsParams = {}): Promise<ListPage<PlatformApp>> {
        const { metadata, ...rest } = params;
        return request({ method: 'GET', path: '/v1/platform/apps', query: { ...rest, ...metadataQuery(metadata) } });
      },
      /** Provision an app; its secret key is revealed exactly once. */
      create(body: CreatePlatformAppBody = {}, idempotencyKey?: string): Promise<CreatedPlatformApp> {
        return request({ method: 'POST', path: '/v1/platform/apps', body, idempotencyKey });
      },
      get(id: string): Promise<PlatformApp> {
        return request({ method: 'GET', path: `/v1/platform/apps/${enc(id)}` });
      },
      update(id: string, body: UpdatePlatformAppBody): Promise<PlatformApp> {
        return request({ method: 'PATCH', path: `/v1/platform/apps/${enc(id)}`, body });
      },
      /** Disable the app (sign-ins and sign-ups refused). Soft and reversible. */
      delete(
        id: string,
      ): Promise<{ object: 'app'; id: string; disabled: true; note: string }> {
        return request({ method: 'DELETE', path: `/v1/platform/apps/${enc(id)}` });
      },
      /** Disable up to 100 apps; ids you do not own are skipped as `not_found`. */
      bulkDelete(ids: string[] | SandboxTeardownBody): Promise<PlatformAppBulkDeleteResult> {
        return request({
          method: 'POST',
          path: '/v1/platform/apps/bulk_delete',
          body: Array.isArray(ids) ? { ids } : ids,
        });
      },
      /**
       * Hard delete every sandbox-tagged app and resource of this platform
       * (`{ sandbox: true }` must be in the selection). `dry_run` lists what would go.
       */
      sandboxTeardown(metadata: ProvisioningMetadata = { sandbox: true }, opts: { dryRun?: boolean } = {}): Promise<PlatformAppBulkDeleteResult> {
        return request({
          method: 'POST',
          path: '/v1/platform/apps/bulk_delete',
          body: { metadata, ...(opts.dryRun ? { dry_run: true } : {}) },
        });
      },
      /** Copy an app's configuration into its development (or another) instance, secrets excluded. */
      cloneConfig(id: string, body: CloneConfigBody = {}, idempotencyKey?: string): Promise<CloneConfigResult> {
        return request({ method: 'POST', path: `/v1/platform/apps/${enc(id)}/clone_config`, body, idempotencyKey });
      },
      /** Mint an additional named, taggable secret key (shown once; `external_ref` makes it idempotent). */
      createSecretKey(id: string, body: CreatePlatformSecretKeyBody = {}, idempotencyKey?: string): Promise<CreatedPlatformSecretKey> {
        return request({ method: 'POST', path: `/v1/platform/apps/${enc(id)}/secret_keys`, body, idempotencyKey });
      },
      /** Hide from the default listing. Does not disable the app. */
      archive(id: string): Promise<PlatformApp> {
        return request({ method: 'POST', path: `/v1/platform/apps/${enc(id)}/archive` });
      },
      unarchive(id: string): Promise<PlatformApp> {
        return request({ method: 'POST', path: `/v1/platform/apps/${enc(id)}/unarchive` });
      },
      /**
       * Mint a new secret key while the prior keys stay valid for
       * `overlap_seconds` (default 72h, max 7 days; 0 = immediate cut).
       */
      rotateSecret(
        id: string,
        body: RotatePlatformSecretBody = {},
        idempotencyKey?: string,
      ): Promise<PlatformAppSecretRotation> {
        return request({
          method: 'POST',
          path: `/v1/platform/apps/${enc(id)}/rotate_secret`,
          body,
          idempotencyKey,
        });
      },
      /** Currently-valid secret keys (metadata only). */
      secretKeys(id: string, params: { metadata?: ProvisioningMetadata } = {}): Promise<ListPage<PlatformSecretKey>> {
        return request({ method: 'GET', path: `/v1/platform/apps/${enc(id)}/secret_keys`, query: metadataQuery(params.metadata) });
      },
      instances: {
        list(appId: string): Promise<ListPage<PlatformApp>> {
          return request({ method: 'GET', path: `/v1/platform/apps/${enc(appId)}/instances` });
        },
        /** Add an instance (e.g. development beside production); secret revealed once. */
        create(
          appId: string,
          body: CreatePlatformInstanceBody = {},
          idempotencyKey?: string,
        ): Promise<PlatformAppWithSecret> {
          return request({
            method: 'POST',
            path: `/v1/platform/apps/${enc(appId)}/instances`,
            body,
            idempotencyKey,
          });
        },
        /**
         * Mint a new secret key for one instance, revealed once. The prior keys
         * stay valid for `overlap_seconds` (default 72h, max 7 days; 0 =
         * immediate cut), like `apps.rotateSecret`. The third argument may also
         * be the idempotency key (the 0.9 signature).
         */
        rotateSecret(
          appId: string,
          instanceId: string,
          bodyOrIdempotencyKey?: RotatePlatformSecretBody | string,
          idempotencyKey?: string,
        ): Promise<PlatformInstanceSecretRotation> {
          const legacyKey = typeof bodyOrIdempotencyKey === 'string';
          return request({
            method: 'POST',
            path: `/v1/platform/apps/${enc(appId)}/instances/${enc(instanceId)}/rotate_secret`,
            body: legacyKey ? undefined : bodyOrIdempotencyKey,
            idempotencyKey: legacyKey ? bodyOrIdempotencyKey : idempotencyKey,
          });
        },
      },
      /** Start a transfer: a one-time token the receiving platform accepts. */
      transfer(id: string, idempotencyKey?: string): Promise<PlatformAppTransfer> {
        return request({
          method: 'POST',
          path: `/v1/platform/apps/${enc(id)}/transfer`,
          idempotencyKey,
        });
      },
      /** Take ownership of an app by its transfer token. */
      acceptTransfer(
        transferToken: string,
        idempotencyKey?: string,
      ): Promise<PlatformApp & { note: string }> {
        return request({
          method: 'POST',
          path: '/v1/platform/apps/accept_transfer',
          body: { transfer_token: transferToken },
          idempotencyKey,
        });
      },
      /** Claim an accountless app by its claim token; mints its first secret key. */
      claim(claimToken: string, idempotencyKey?: string): Promise<PlatformAppWithSecret> {
        return request({
          method: 'POST',
          path: '/v1/platform/apps/claim',
          body: { claim_token: claimToken },
          idempotencyKey,
        });
      },
    },
    accountlessApps: {
      /** Mint an app owned by no platform, with a one-time claim token. No secret until claimed. */
      create(body: CreateAccountlessAppBody = {}, idempotencyKey?: string): Promise<AccountlessApp> {
        return request({
          method: 'POST',
          path: '/v1/platform/accountless_apps',
          body,
          idempotencyKey,
        });
      },
    },
    /** Sign in with Atlas apps registered to the platform's account. */
    atlasIdApps: {
      list(params: { metadata?: ProvisioningMetadata } = {}): Promise<AtlasIdAppList> {
        return request({ method: 'GET', path: '/v1/platform/atlas_id_apps', query: metadataQuery(params.metadata) });
      },
      /** Register an app. A confidential app's `client_secret` is returned exactly once. */
      create(body: CreateAtlasIdAppBody, idempotencyKey?: string): Promise<AtlasIdAppWithSecret> {
        return request({
          method: 'POST',
          path: '/v1/platform/atlas_id_apps',
          body,
          idempotencyKey,
        });
      },
      get(id: string): Promise<AtlasIdApp> {
        return request({ method: 'GET', path: `/v1/platform/atlas_id_apps/${enc(id)}` });
      },
      /** `[]` clears a URI list; `null` clears a logout URI. */
      update(id: string, body: UpdateAtlasIdAppBody): Promise<AtlasIdApp> {
        return request({ method: 'PATCH', path: `/v1/platform/atlas_id_apps/${enc(id)}`, body });
      },
      /** The client_id stops working immediately. */
      delete(id: string): Promise<{ object: 'atlas_id_app'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/platform/atlas_id_apps/${enc(id)}` });
      },
      /**
       * New client secret, returned exactly once. The previous one keeps working
       * for `overlap_seconds` (default 24h; 0 = revoke now). Public apps have none (409).
       */
      rotateSecret(id: string, body?: RotateAtlasIdAppSecretBody): Promise<AtlasIdAppWithSecret> {
        return request({
          method: 'POST',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/rotate_secret`,
          body,
        });
      },
      /** The app's back-channel logout delivery log, newest first. */
      listBackchannelDeliveries(
        id: string,
        query: BackchannelDeliveriesQuery = {},
      ): Promise<BackchannelLogoutDeliveryPage> {
        return request({
          method: 'GET',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/backchannel_deliveries`,
          query: { ...query },
        });
      },
      /** Send a test back-channel logout to the app now and return what it answered. */
      testBackchannelLogout(id: string): Promise<BackchannelLogoutTest> {
        return request({
          method: 'POST',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/backchannel_logout/test`,
        });
      },
      /** Check the app's setup (URIs, back-channel delivery, homepage host, legal links, secret age). */
      preflight(id: string): Promise<AtlasIdAppPreflight> {
        return request({ method: 'GET', path: `/v1/platform/atlas_id_apps/${enc(id)}/preflight` });
      },
      /**
       * Privacy requests: is this person one of the app's users? Exact match on a
       * verified email; anyone else gets the same empty list.
       */
      findUsers(id: string, email: string): Promise<{ object: 'list'; data: AtlasIdAppUser[] }> {
        return request({
          method: 'GET',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/users`,
          query: { email },
        });
      },
      /** Revoke one user's grant (grant_id from `findUsers`); the next sign-in asks for consent again. */
      revokeGrant(id: string, grantId: string): Promise<AtlasIdGrantRevocation> {
        return request({
          method: 'DELETE',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/grants/${enc(grantId)}`,
        });
      },
      /** Move the app's URLs from one origin to another. `dry_run: true` writes nothing. */
      moveOrigin(id: string, body: OriginMoveRequest): Promise<OriginMove> {
        return request({
          method: 'POST',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/move_origin`,
          body,
        });
      },
      /**
       * Hand the app's grant management to an instance of the same account
       * (`managed_via: "adopted"`), or take it back with `null`. That instance's
       * secret key, scoped to `privacy:grants:revoke` or `atlas_id_grants:*`,
       * then lists and revokes the app's grants, so a data-rights tool never
       * needs the platform key. The app stays yours to edit.
       */
      setManagedBy(id: string, instanceId: string | null): Promise<AtlasIdApp & { changed: boolean }> {
        return request({
          method: 'PUT',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/managed_by`,
          body: { instance_id: instanceId },
        });
      },
      /**
       * New per-app webhook signing secret (`webhook_secret`), returned once. By
       * default the previous secret stops at once; for `overlap_seconds` it signs
       * each delivery too. 409 without a webhook.
       */
      rotateWebhookSecret(id: string, body?: RotateAtlasIdAppSecretBody): Promise<AtlasIdAppWithSecret> {
        return request({
          method: 'POST',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/webhook/rotate_secret`,
          body,
        });
      },
      /**
       * Test and review accounts for this app: real Atlas accounts confined to
       * it (reviewer logins, CI, demos). Needs `platform:atlas_id_apps:provision`
       * or the per-app `atlas_id_apps:<app id>:provision` scope. Passwords come
       * back exactly once, on create and on rotation (pass `secretRecipient` to
       * receive them sealed).
       */
      provisionedAccounts: {
        list(appId: string): Promise<AtlasIdProvisionedAccountList> {
          return request({ method: 'GET', path: `/v1/platform/atlas_id_apps/${enc(appId)}/provisioned_accounts` });
        },
        create(
          appId: string,
          body: CreateAtlasIdProvisionedAccountBody,
          idempotencyKey?: string,
        ): Promise<AtlasIdProvisionedAccount> {
          return request({
            method: 'POST',
            path: `/v1/platform/atlas_id_apps/${enc(appId)}/provisioned_accounts`,
            body,
            idempotencyKey,
          });
        },
        get(appId: string, accountId: string): Promise<AtlasIdProvisionedAccount> {
          return request({
            method: 'GET',
            path: `/v1/platform/atlas_id_apps/${enc(appId)}/provisioned_accounts/${enc(accountId)}`,
          });
        },
        /** Deletes the account and ends every session and grant it holds. */
        remove(
          appId: string,
          accountId: string,
        ): Promise<{ object: 'atlas_id_provisioned_account'; id: string; deleted: true; sessions_ended: number }> {
          return request({
            method: 'DELETE',
            path: `/v1/platform/atlas_id_apps/${enc(appId)}/provisioned_accounts/${enc(accountId)}`,
          });
        },
        /** A new password (yours, or one Atlas generates), returned once. */
        rotatePassword(
          appId: string,
          accountId: string,
          body?: RotateAtlasIdProvisionedPasswordBody,
        ): Promise<AtlasIdProvisionedAccount> {
          return request({
            method: 'POST',
            path: `/v1/platform/atlas_id_apps/${enc(appId)}/provisioned_accounts/${enc(accountId)}/password`,
            body,
          });
        },
      },
      /** Preview a design on the Sign in with Atlas page without saving it. */
      previewDesign(design: AtlasDesign): Promise<DesignPreview> {
        return request({
          method: 'POST',
          path: '/v1/platform/atlas_id_apps/design/preview',
          body: { design },
        });
      },
    },
    /** Domains the account verified by DNS; they gate test sign-in mode and the test-account domain restriction. */
    domains: {
      list(): Promise<{ object: 'list'; data: AccountDomain[]; verified_domains: string[] }> {
        return request({ method: 'GET', path: '/v1/platform/domains' });
      },
      /** Claim a domain; returns the TXT record to publish. */
      claim(domain: string): Promise<AccountDomain> {
        return request({ method: 'POST', path: '/v1/platform/domains', body: { domain } });
      },
      verify(domainId: string): Promise<AccountDomain> {
        return request({ method: 'POST', path: `/v1/platform/domains/${enc(domainId)}/verify` });
      },
      remove(domainId: string): Promise<unknown> {
        return request({ method: 'DELETE', path: `/v1/platform/domains/${enc(domainId)}` });
      },
    },
    /** The account's Sign in with Atlas publisher name and verified domain. */
    atlasIdPublisher: {
      /** 404 until claimed. */
      get(): Promise<AtlasIdPublisher> {
        return request({ method: 'GET', path: '/v1/platform/atlas_id_publisher' });
      },
      /** Claim a publisher name and domain; returns the TXT record to publish. */
      set(body: SetAtlasIdPublisherBody): Promise<AtlasIdPublisher> {
        return request({ method: 'PUT', path: '/v1/platform/atlas_id_publisher', body });
      },
      /** Turn publisher-wide consent on or off. */
      update(body: { skip_consent: boolean }): Promise<AtlasIdPublisher> {
        return request({ method: 'PATCH', path: '/v1/platform/atlas_id_publisher', body });
      },
      delete(): Promise<{ object: 'atlas_id_publisher'; deleted: true }> {
        return request({ method: 'DELETE', path: '/v1/platform/atlas_id_publisher' });
      },
      /** Look up the TXT record now (`record_found`). */
      verify(): Promise<AtlasIdPublisher> {
        return request({ method: 'POST', path: '/v1/platform/atlas_id_publisher/verify' });
      },
    },
    /** Config change history for the account's Sign in with Atlas apps. */
    configChangelog: {
      list(params: ListConfigChangelogParams = {}): Promise<{
        object: 'config_changelog';
        data: ConfigChangelogEntry[];
        has_more?: boolean;
        next_cursor?: string | null;
      }> {
        return request({ method: 'GET', path: '/v1/platform/config_changelog', query: { ...params } });
      },
    },
    /** Design images owned by the platform's account, for Sign in with Atlas app designs. */
    designAssets: {
      upload(data: DesignAssetData, options: UploadDesignAssetOptions = {}): Promise<DesignAsset> {
        return request({
          method: 'POST',
          path: '/v1/platform/design/assets',
          query: { kind: options.kind },
          rawBody: { data, contentType: options.contentType },
        });
      },
      list(): Promise<ListPage<DesignAsset>> {
        return request({ method: 'GET', path: '/v1/platform/design/assets' });
      },
      /** Refused with 409 while a saved app design still uses it. */
      delete(assetId: string): Promise<DeletedDesignAsset> {
        return request({ method: 'DELETE', path: `/v1/platform/design/assets/${enc(assetId)}` });
      },
    },
  };
}

/** Every namespace of the platform client. */
export type AtlasPlatformNamespaces = ReturnType<typeof platformNamespaces>;

export interface AtlasPlatformClient extends AtlasPlatformNamespaces {
  /** A copy of this client with some settings changed, e.g. `{ strict: true }`. */
  withOptions(overrides: AtlasRequestSettings): AtlasPlatformClient;
}

export function createAtlasPlatformClient(config: AtlasPlatformClientConfig): AtlasPlatformClient {
  if (!config.platformKey) {
    throw new Error('createAtlasPlatformClient requires a platformKey.');
  }
  const request = createKeyedRequest(config.platformKey, config);
  return {
    ...platformNamespaces(request),
    withOptions(overrides: AtlasRequestSettings): AtlasPlatformClient {
      return createAtlasPlatformClient({ ...config, ...overrides });
    },
  };
}
