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
