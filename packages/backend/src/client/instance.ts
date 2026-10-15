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

export interface PreflightReport {
  object: 'preflight';
  /** True when there are no error-severity findings. */
  ok: boolean;
  /** When the check ran (epoch ms). */
  checked_at: number;
  /** Ordered error, then warning, then info. */
  findings: PreflightFinding[];
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
