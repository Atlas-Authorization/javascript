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
import type { OriginMove, OriginMoveRequest, PreflightFinding } from './instance';
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
}

/**
 * The platform client: the platform-key (`psk_...`) surface for provisioning and
 * managing apps you own, and for registering Sign in with Atlas apps.
 *
 * A separate client from `createAtlasClient`, because the key is different: a
 * platform key manages many apps, a secret key manages exactly one instance.
 */
export interface AtlasPlatformClientConfig {
  /** The platform key (`psk_...`). Sent as `Authorization: Bearer <key>`; never logged. */
  platformKey: string;
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
export interface PlatformApp {
  object: 'app';
  id: string;
  name: string;
  environment: 'production' | 'development';
  publishable_key: string;
  allowed_origins: string[];
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
  allowed_origins?: string[];
  /** Default true: also provision a test-mode sibling instance. */
  create_development_sibling?: boolean;
  tags?: string[];
}

export interface UpdatePlatformAppBody {
  name?: string;
  allowed_origins?: string[];
  tags?: string[];
}

export interface ListPlatformAppsParams {
  /** Only apps carrying this tag. */
  tag?: string;
  /** `true`: only archived apps. */
  archived?: boolean;
  /** `true`: include archived apps alongside active ones. */
  include_archived?: boolean;
}

export interface CreatePlatformInstanceBody {
  environment?: 'production' | 'development';
  allowed_origins?: string[];
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
  id: string;
  secret: string;
  note: string;
}

/** Metadata of a currently-valid secret key. Never the secret itself. */
export interface PlatformSecretKey {
  object: 'secret_key';
  id: string;
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
  results: Array<{ id: string; deleted: boolean; reason?: string }>;
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
  allowed_origins?: string[];
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
export interface AtlasIdApp {
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
  managed_by_instance_id?: string | null;
  created_at: number;
  updated_at: number;
  /** On `get` only: people who have approved the app. */
  user_count?: number;
  /** The per-app webhook URL, or null. */
  webhook_url?: string | null;
  webhook_events?: Array<'user.updated' | 'user.deleted' | 'grant.revoked'>;
  /** false once auto-disabled after repeated failures; null without a webhook. */
  webhook_active?: boolean | null;
}

/** Create / rotate response: confidential apps carry the client secret exactly once. */
export interface AtlasIdAppWithSecret extends AtlasIdApp {
  client_secret?: string;
  /** The per-app webhook signing secret, returned exactly once (first set, or rotated). */
  webhook_secret?: string;
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

export interface CreateAtlasIdAppBody extends AtlasIdAppFields {
  name: string;
  redirect_uris: string[];
  /** Default `confidential`. */
  type?: 'confidential' | 'public';
}

export interface UpdateAtlasIdAppBody extends AtlasIdAppFields {
  name?: string;
  redirect_uris?: string[];
  /**
   * Per-app webhook (public https): user.updated, user.deleted and grant.revoked for
   * this app's users. Setting it the first time returns `webhook_secret` once; null removes it.
   */
  webhook_url?: string | null;
}

// ---- the client ----------------------------------------------------------------

function platformNamespaces(request: RequestFn) {
  return {
    apps: {
      /** Archived apps are hidden unless `include_archived` or `archived` is set. */
      list(params: ListPlatformAppsParams = {}): Promise<ListPage<PlatformApp>> {
        return request({ method: 'GET', path: '/v1/platform/apps', query: { ...params } });
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
      bulkDelete(ids: string[]): Promise<PlatformAppBulkDeleteResult> {
        return request({ method: 'POST', path: '/v1/platform/apps/bulk_delete', body: { ids } });
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
        body: { overlap_seconds?: number } = {},
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
      secretKeys(id: string): Promise<ListPage<PlatformSecretKey>> {
        return request({ method: 'GET', path: `/v1/platform/apps/${enc(id)}/secret_keys` });
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
        /** Revoke the instance's prior keys and mint a new one, revealed once. */
        rotateSecret(
          appId: string,
          instanceId: string,
          idempotencyKey?: string,
        ): Promise<PlatformInstanceSecretRotation> {
          return request({
            method: 'POST',
            path: `/v1/platform/apps/${enc(appId)}/instances/${enc(instanceId)}/rotate_secret`,
            idempotencyKey,
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
      list(): Promise<AtlasIdAppList> {
        return request({ method: 'GET', path: '/v1/platform/atlas_id_apps' });
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
      /** New client secret, returned exactly once. Public apps have none (409). */
      rotateSecret(id: string): Promise<AtlasIdAppWithSecret> {
        return request({
          method: 'POST',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/rotate_secret`,
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
      /** New per-app webhook signing secret (`webhook_secret`), returned once. 409 without a webhook. */
      rotateWebhookSecret(id: string): Promise<AtlasIdAppWithSecret> {
        return request({
          method: 'POST',
          path: `/v1/platform/atlas_id_apps/${enc(id)}/webhook/rotate_secret`,
        });
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
