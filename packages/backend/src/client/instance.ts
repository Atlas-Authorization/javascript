import type { RequestFn } from './request';
import type { Metadata } from './types';

/**
 * §9.3 instance configuration. The instance is the tenant's environment (its
 * publishable key, frontend API host, allowed origins and auth config). The
 * signing private key is never returned. JWT templates live under their own
 * `jwtTemplates` resource, not here.
 */

export interface Instance {
  object: 'instance';
  id: string;
  environment: string;
  publishable_key: string;
  frontend_api_host: string;
  /**
   * The `iss` this instance's session tokens carry. It changes when a custom
   * domain goes active, so read it (and the two URLs below) rather than hard-coding it.
   */
  issuer: string;
  /** The OpenID discovery document whose `issuer` equals {@link issuer}. */
  discovery_url: string;
  /** The JWKS holding this instance's signing keys. */
  jwks_uri: string;
  allowed_origins: string[];
  auth_config: Metadata;
  created_at: number;
}

export interface UpdateInstanceBody {
  /** Exact origins only — a wildcard or a path is rejected (§13.1). */
  allowed_origins?: string[];
  auth_config?: Record<string, unknown>;
}

/** `PATCH /v1/instance` echoes only the mutable fields, not a full Instance. */
export interface InstanceUpdateResult {
  object: 'instance';
  id: string;
  allowed_origins: string[];
  auth_config: Metadata;
}

/** One problem (or note) the setup check found. */
export interface PreflightFinding {
  severity: 'error' | 'warning' | 'info';
  /** Stable snake_case identifier, e.g. `oauth_provider_missing_credentials`. */
  code: string;
  /** What is wrong, in a plain sentence. */
  message: string;
  /** What to do about it, in a plain sentence. */
  fix: string;
  /** Ids of what the finding is about (provider, client_id, domain, …). */
  subject?: Record<string, string>;
}

/** An advisory published for an Atlas browser SDK version. */
export interface SdkAdvisory {
  object: 'sdk_advisory';
  /** e.g. `@atlasauth/react`. */
  package: string;
  /** The affected range, e.g. `<0.8.1`. */
  affected: string;
  fixed_in: string;
  /** Stable code, e.g. `email_code_sign_in`. */
  reason: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  summary: string;
  /** ISO date. */
  published_at: string;
}

/** An Atlas browser SDK version that called this instance recently. */
export interface SdkVersionSeen {
  package: string;
  version: string;
  /** Epoch ms. */
  last_seen_at: number;
  /** The advisories that apply to this version. */
  advisories: SdkAdvisory[];
}

export interface PreflightReport {
  object: 'preflight';
  /** True when there are no error-severity findings. */
  ok: boolean;
  /** When the check ran (epoch ms). */
  checked_at: number;
  /** Ordered error, then warning, then info. */
  findings: PreflightFinding[];
  /** Atlas browser SDK versions seen in the last 7 days (newest first), with their advisories. */
  sdk_versions_seen?: SdkVersionSeen[];
}

/** A consent tool whose documented "reopen preferences" trigger Atlas fills in. */
export type CookieSettingsLinkPreset = 'cookiemunch' | 'cookiebot' | 'onetrust' | 'custom';

/** The footer "Cookie settings" link on the hosted pages, for reopening the consent preferences. */
export interface CookieSettingsLinkInput {
  /** The link text, 1-60 characters. */
  label: string;
  /** Fills in the consent tool's reopen trigger; `custom` (or none) uses `attributes` only. */
  preset?: CookieSettingsLinkPreset | null;
  /**
   * Extra attributes. Allowed names: `data-*`, `aria-*`, `id`, `class`, and `href`
   * (an https URL or a `#fragment`); values up to 200 characters. Event handlers
   * and other names are refused with a 400.
   */
  attributes?: Record<string, string>;
}

export interface CookieSettingsLink {
  label: string;
  preset: CookieSettingsLinkPreset | null;
  attributes: Record<string, string>;
  /** The attributes the rendered link carries: `attributes` plus the preset's trigger. */
  rendered_attributes: Record<string, string>;
}

/** One cookie or browser-storage key Atlas writes for the instance (all strictly necessary). */
export interface DeclaredCookie {
  /** The exact name, or null when `pattern` describes a family of keys. */
  name: string | null;
  /** A `*` wildcard for keys with an id suffix, e.g. `atlasid:*`. */
  pattern: string | null;
  store: 'cookie' | 'localStorage' | 'sessionStorage' | 'indexedDB';
  /** A cookie's Domain (or the exact Frontend API host); for storage, "your app's origin". */
  domain: string;
  /** Seconds; null = browser session (cookie) or until cleared (storage). */
  lifetime_seconds: number | null;
  /** The lifetime in words, for a cookie policy table. */
  lifetime: string;
  http_only: boolean;
  category: 'necessary';
  purpose: string;
  written_when: string;
  set_by: 'atlas_frontend_api' | 'atlas_sdk';
}

/** `page` (default): the consent tag carries the page language; `browser`: no attribute. */
export type CookieConsentCulture = 'page' | 'browser';

/** The cookie-consent script injected into the hosted sign-in, sign-up and account pages. */
export interface CookieConsent {
  object: 'cookie_consent';
  enabled: boolean;
  /** The consent script URL (https). */
  script_url?: string;
  script_id?: string | null;
  site_id?: string | null;
  blocking_mode?: string | null;
  extra_origins?: string[];
  /** The footer "Cookie settings" link, or null when none is set. */
  settings_link?: CookieSettingsLink | null;
  culture?: CookieConsentCulture;
  /** Every cookie and browser-storage key Atlas writes for this instance, for your cookie policy. */
  declared_cookies?: DeclaredCookie[];
}

export interface SetCookieConsentBody {
  /** Your consent script URL. Must be https; its origin is added to the page CSP. */
  script_url: string;
  /** The `<script id>` some consent tools need. */
  script_id?: string | null;
  /** Your consent site id (sent as `data-cbid`). */
  site_id?: string | null;
  /** The prior-blocking mode, e.g. `"auto"` (sent as `data-blockingmode`). */
  blocking_mode?: string | null;
  /** Other https URLs the script loads from or calls; each origin is added to the CSP. */
  extra_origins?: string[];
  /** A footer "Cookie settings" link that reopens the consent preferences; null or omitted for none. */
  settings_link?: CookieSettingsLinkInput | null;
  /** `page` (default) tags the consent script with the page language; `browser` leaves it to the tool. */
  culture?: CookieConsentCulture | null;
}

/** `POST /v1/instance/move_origin` (and the platform app twin). */
export interface OriginMoveRequest {
  /** The old origin, `scheme://host[:port]`. */
  from: string;
  /** The new origin: https, or http only for localhost. */
  to: string;
  /** `true` reports the diff and any problems and writes nothing. */
  dry_run?: boolean;
}

export interface OriginMoveChange {
  object: 'instance' | 'oauth_client' | 'atlas_id_app' | 'webhook_endpoint' | 'redirect_url';
  id: string;
  /** e.g. `allowed_origins`, `redirect_uris`, `homepage_url`, `branding.legal.privacyUrl`. */
  field: string;
  before: string | string[] | null;
  after: string | string[] | null;
}

export interface OriginMoveProblem {
  object?: string;
  id?: string;
  field?: string;
  url?: string;
  message?: string;
}

/** The before → after diff of an origin move. A repeated run returns no changes. */
export interface OriginMove {
  object: 'origin_move';
  from: string;
  to: string;
  dry_run: boolean;
  /** True when this run wrote changes. */
  applied: boolean;
  changes: OriginMoveChange[];
  /** Values the field would refuse; a real run with problems is a 422 and writes nothing. */
  problems: OriginMoveProblem[];
  /** Platform app twin only: the app after the move. */
  app?: Record<string, unknown>;
}

/** One link from this instance to another platform, and its health. */
export interface InstanceConnection {
  object: 'connection';
  kind: 'privacy_webhook' | 'cmp' | 'atlas_id_app' | 'jwt_template';
  /** What was checked, e.g. `privacy_webhook_delivery`, `cmp_site`. */
  check: string;
  ok: boolean;
  severity: 'error' | 'warning' | 'info';
  subject: Record<string, string>;
  /** What to do when `ok` is false. */
  fix_hint: string | null;
  /** Epoch ms. */
  last_checked_at: number;
  /** Kind-specific facts. */
  details: Record<string, unknown>;
}

export interface InstanceConnections {
  object: 'instance_connections';
  /** False when any warning- or error-severity row is not ok. */
  ok: boolean;
  checked_at: number;
  data: InstanceConnection[];
}

/** The Chatly connection (`enabled: false` and nothing else when none is set). */
export interface ChatlyIntegration {
  object: 'chatly_integration';
  enabled: boolean;
  channel?: string;
  /** The template name to pass to `getToken({ template: 'chatly' })`. */
  template?: 'chatly';
  /** `chatly:<channel>`. */
  audience?: string;
  issuer?: string;
  jwks_url?: string;
  token_ttl_seconds?: number;
  identity_verification?: { mode?: 'oidc'; issuer?: string; jwks_url?: string; audience?: string };
}

export interface SetChatlyIntegrationBody {
  /** The chat channel public id (letters, digits, `_` and `-`). */
  channel: string;
}

/** The Forumulate connection (`enabled: false` and nothing else when none is set). */
export interface ForumulateIntegration {
  object: 'forumulate_integration';
  enabled: boolean;
  org_id?: string;
  spaces?: Array<{ id: string; redeem_url: string }>;
  audience?: string;
  issuer?: string;
  jwks_url?: string;
  token_ttl_seconds?: number;
  /** The external_jwt provider to store on each space. */
  reader_auth_provider?: {
    method?: 'external_jwt';
    order?: number;
    config?: { jwksUrl?: string; issuer?: string; clientId?: string };
  };
}

export interface SetForumulateIntegrationBody {
  org_id: string;
  /** 1-50 space ids, or `{ id, redeem_url }`. */
  spaces: Array<string | { id: string; redeem_url?: string | null }>;
  /** The token `aud`. Default `forumulate:<org_id>`. */
  audience?: string | null;
}

export function instanceResource(request: RequestFn) {
  return {
    get(): Promise<Instance> {
      return request({ method: 'GET', path: '/v1/instance' });
    },
    update(body: UpdateInstanceBody): Promise<InstanceUpdateResult> {
      return request({ method: 'PATCH', path: '/v1/instance', body });
    },
    /** Check your setup in one call: configuration the server can see is broken or risky. */
    preflight(): Promise<PreflightReport> {
      return request({ method: 'GET', path: '/v1/instance/preflight' });
    },
    /**
     * Move every URL that points at one origin to another (a domain move), across
     * the instance, its OAuth clients, webhooks, redirect URLs and Sign in with
     * Atlas apps. `dry_run: true` writes nothing.
     */
    moveOrigin(body: OriginMoveRequest): Promise<OriginMove> {
      return request({ method: 'POST', path: '/v1/instance/move_origin', body });
    },
    /** The instance's links to other platforms and their health. Read-only. */
    connections(): Promise<InstanceConnections> {
      return request({ method: 'GET', path: '/v1/instance/connections' });
    },
    /** Built-in connections to other platforms. */
    integrations: {
      chatly: {
        get(): Promise<ChatlyIntegration> {
          return request({ method: 'GET', path: '/v1/instance/integrations/chatly' });
        },
        set(body: SetChatlyIntegrationBody): Promise<ChatlyIntegration> {
          return request({ method: 'PUT', path: '/v1/instance/integrations/chatly', body });
        },
        delete(): Promise<ChatlyIntegration> {
          return request({ method: 'DELETE', path: '/v1/instance/integrations/chatly' });
        },
      },
      forumulate: {
        get(): Promise<ForumulateIntegration> {
          return request({ method: 'GET', path: '/v1/instance/integrations/forumulate' });
        },
        /** Replaces the whole connection. */
        set(body: SetForumulateIntegrationBody): Promise<ForumulateIntegration> {
          return request({ method: 'PUT', path: '/v1/instance/integrations/forumulate', body });
        },
        delete(): Promise<ForumulateIntegration> {
          return request({ method: 'DELETE', path: '/v1/instance/integrations/forumulate' });
        },
      },
    },
    /** The cookie-consent script on the hosted pages (any provider). */
    cookieConsent: {
      get(): Promise<CookieConsent> {
        return request({ method: 'GET', path: '/v1/instance/cookie_consent' });
      },
      /** Replaces the whole setting. */
      set(body: SetCookieConsentBody): Promise<CookieConsent> {
        return request({ method: 'PUT', path: '/v1/instance/cookie_consent', body });
      },
      /** Turn it off: no script is injected and the CSP goes back to the default. */
      delete(): Promise<CookieConsent> {
        return request({ method: 'DELETE', path: '/v1/instance/cookie_consent' });
      },
    },
  };
}
