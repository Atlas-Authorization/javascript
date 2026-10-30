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
  /**
   * The declared integration per allowed origin (`redirect` or `embedded`). An
   * origin not listed is inferred by preflight and login readiness.
   */
  allowed_origin_integrations?: Record<string, 'redirect' | 'embedded'>;
  auth_config: Metadata;
  /**
   * Sign-in methods that are switched on but not offered to users, because they
   * need an email provider and the instance has none (email is bring-your-own).
   * They become active on their own once a provider is configured.
   */
  inactive_methods?: InactiveMethod[];
  /** Methods that still work, minus the parts that need email (e.g. password without reset). */
  limited_methods?: LimitedMethod[];
  created_at: number;
}

/** A switched-on sign-in method that is not offered to users, and why. */
export interface InactiveMethod {
  method: 'password' | 'email_code' | 'email_link';
  reason: 'email_provider_required';
}

/**
 * A sign-in method that works, minus parts that need email: password sign-in
 * for users who already hold a password, without reset (and without sign-up
 * while sign-up must verify the address by email).
 */
export interface LimitedMethod {
  method: 'password';
  reason: 'email_provider_required';
  unavailable: Array<'password_reset' | 'password_sign_up'>;
}

/**
 * How an allowed origin signs in: `redirect` (hosted-redirect OIDC: the app
 * never runs the embedded components), `embedded` (the sign-in components run
 * on the origin), or `auto` / `null` (clear the hint; Atlas infers it).
 */
export type OriginIntegration = 'redirect' | 'embedded' | 'auto';

/** An `allowed_origins` entry that also declares how the origin signs in. */
export interface AllowedOriginEntry {
  origin: string;
  integration?: OriginIntegration | null;
}

/** An origin string, or `{ origin, integration }`. A plain string keeps the origin's current hint. */
export type AllowedOriginInput = string | AllowedOriginEntry;

export interface UpdateInstanceBody {
  /** Exact origins only — a wildcard or a path is rejected (§13.1). The list replaces the stored one. */
  allowed_origins?: AllowedOriginInput[];
  auth_config?: Record<string, unknown>;
}

/** `PATCH /v1/instance` echoes only the mutable fields, not a full Instance. */
export interface InstanceUpdateResult {
  object: 'instance';
  id: string;
  allowed_origins: string[];
  allowed_origin_integrations?: Record<string, 'redirect' | 'embedded'>;
  auth_config: Metadata;
  /**
   * The write is accepted even when a method needs an email provider the
   * instance does not have yet (Terraform or config import may add it later in
   * the same apply). Such methods are listed here and are not offered to users
   * until a provider is configured.
   */
  inactive_methods?: InactiveMethod[];
  /** Methods that still work, minus the parts that need email. */
  limited_methods?: LimitedMethod[];
  /**
   * What the write did not do as sent: `origin_still_referenced` (a removed
   * origin URLs still point at) and, on a lenient write, `unknown_field` (an
   * auth_config key that was ignored and not stored; `hint` names the endpoint
   * for a setting that has its own, e.g. branding → PATCH /v1/branding).
   */
  warnings?: InstanceUpdateWarning[];
}

/** One entry of {@link InstanceUpdateResult.warnings}. */
export interface InstanceUpdateWarning {
  code: 'origin_still_referenced' | 'unknown_field' | (string & {});
  message: string;
  /** unknown_field: the full path, e.g. `auth_config.strategies.atlasId`. */
  field?: string;
  hint?: string;
  did_you_mean?: string;
  /** origin_still_referenced: the removed origin. */
  origin?: string;
}

/**
 * Setup-check codes about sign-in methods that need email. The full list is at
 * `GET /v1/instance/preflight/codes`; a finding's `code` may be any of them.
 *
 * - `email_provider_missing`: an enabled method needs email and the instance has no
 *   email provider (`subject.methods` names them). A warning while the methods are
 *   inactive, an error while users with a password cannot reset it.
 * - `instance_sign_in_unused` (info): the instance's own sign-in methods are on but
 *   every user signs in with Sign in with Atlas.
 */
export type EmailSignInPreflightCode =
  | 'email_provider_missing'
  | 'email_sign_in_available'
  | 'instance_sign_in_unused'
  | 'no_usable_sign_in_methods'
  | 'sign_up_unreachable';

/** One problem (or note) the setup check found. */
export interface PreflightFinding {
  severity: 'error' | 'warning' | 'info';
  /** Stable snake_case identifier, e.g. `oauth_provider_missing_credentials`. */
  code: EmailSignInPreflightCode | (string & {});
  /** What is wrong, in a plain sentence. */
  message: string;
  /** What to do about it, in a plain sentence. */
  fix: string;
  /** Ids of what the finding is about (provider, client_id, domain, …). */
  subject?: Record<string, string>;
  /** `security_posture` on the findings about settings weaker than the defaults new instances get. */
  group?: 'security_posture';
  /** Only with `include_suppressed: true`: the finding does not apply to how the instance integrates. */
  suppressed?: true;
  suppressed_reason?: string;
}

/** A finding that does not apply to how the instance integrates, and why. */
export interface PreflightSuppressedFinding {
  code: string;
  severity: 'error' | 'warning' | 'info';
  subject: Record<string, string> | null;
  reason: string;
}

/** How one allowed https origin signs in, as preflight judged it. */
export interface PreflightOriginIntegration {
  origin: string;
  integration: 'redirect' | 'embedded';
  source: 'declared' | 'embedded_traffic' | 'redirect_clients' | 'default';
  /** False only for the default (nothing says how the origin signs in). */
  confident: boolean;
  reason: string;
}

export interface PreflightParams {
  /** Only findings at least this severe (`ok` still covers every finding). */
  min_severity?: 'error' | 'warning' | 'info';
  /** Also list the suppressed findings in `findings`, marked `suppressed: true`. */
  include_suppressed?: boolean;
}

/** One unknown body field your writes sent, aggregated over the report window. */
export interface UnknownFieldReportRow {
  method: string;
  /** The route template, e.g. `/v1/users/{id}`. */
  path: string;
  /** The field path, nested as `parent.child`. */
  field: string;
  count: number;
  /** Lenient requests: the field was ignored and named in Atlas-Unknown-Fields. */
  ignored_count: number;
  /** Strict requests: refused with 422 UNKNOWN_FIELD. */
  rejected_count: number;
  /** Epoch ms. */
  last_seen_at: number;
  /** The secret key that sent it (null without a key). */
  api_key_id: string | null;
}

export interface UnknownFieldsReport {
  object: 'unknown_fields_report';
  days: number;
  retention_days: number;
  strict_request_bodies: boolean;
  /** True when nothing in the window would be refused by strict request bodies. */
  safe_to_enable_strict: boolean;
  data: UnknownFieldReportRow[];
}

/** One operation in an OpenAPI diff. */
export interface OpenApiDiffItem {
  method: string;
  path: string;
  operation_id: string | null;
  summary: string | null;
  /** YYYY-MM-DD of the change. */
  at: string;
}

export interface OpenApiDiff {
  object: 'openapi_diff';
  since: string;
  /** The API build the diff was computed on (`<date>+<sha>`). */
  version: string;
  added: OpenApiDiffItem[];
  deprecated: OpenApiDiffItem[];
  removed: OpenApiDiffItem[];
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

/** One row of the integration-health report. */
export interface IntegrationHealthCheck {
  /** A preflight code verbatim, or `<source>.<check>`. */
  id: string;
  /** false = failing; null = not known or not configured. */
  ok: boolean | null;
  detail: string;
  fix: string | null;
  docs: string | null;
  /** For a check that calls your server: the hop that failed. */
  hop?: 'dns' | 'tls' | 'http' | 'challenge' | 'auth';
  status?: number;
  elapsedMs?: number;
  source: string;
  severity?: 'error' | 'warning' | 'info';
  subject?: Record<string, string>;
  observedAt?: number | null;
}

export interface IntegrationHealthReport {
  object: 'integration_health';
  ok: boolean;
  summary: { failing: number; passing: number; unknown: number };
  checks: IntegrationHealthCheck[];
  /** ISO 8601. */
  generatedAt: string;
  /** The same instant, epoch ms. */
  generated_at: number;
}

/** The embed manifest (embed-v1) for one instance: CSP sources per surface, storage, SRI and the merged policy. */
export interface EmbedManifest {
  schema: string;
  product: string;
  updated: string;
  openapi?: string;
  llms?: string;
  status?: string;
  docs?: string;
  checkers?: { userAgent: string; userAgents?: string[]; egress: string[] };
  surfaces: Record<
    string,
    {
      tenant?: boolean;
      servedBy?: 'customer' | 'atlas';
      csp?: Record<string, string[]>;
      requires?: Record<string, string[]>;
      trustedTypes?: string[];
      consentCategory?: string;
      storage?: Array<{ name: string; type: string; category: string; lifetime: string; purpose: { en: string } & Record<string, string> }>;
      sri?: Record<string, string>;
      notes?: string[];
    }
  >;
  changes: Array<{ effective: string; surface: string; add: Record<string, string[]>; remove: Record<string, string[]>; note?: string }>;
  tenant?: {
    instance: string;
    environment: string;
    frontendApiHosts: string[];
    shape: 'redirect' | 'panel' | 'button' | null;
    origin: string | null;
    originAllowed: boolean | null;
    /** The merged sources for your pages, as one Content-Security-Policy value. */
    policy: string;
    sources: Record<string, string[]>;
  };
}

export interface PreflightReport {
  object: 'preflight';
  /** True when there are no error-severity findings. */
  ok: boolean;
  /** When the check ran (epoch ms). */
  checked_at: number;
  /** Ordered error, then warning, then info; only those at or above `min_severity`. */
  findings: PreflightFinding[];
  /** The `min_severity` the findings were filtered by (`info` = everything). */
  min_severity?: 'error' | 'warning' | 'info';
  /** Findings that do not apply to how the instance integrates (not counted in `ok`). */
  suppressed?: PreflightSuppressedFinding[];
  /** How each allowed https origin signs in. */
  integrations?: PreflightOriginIntegration[];
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

/** Receiver health, in the webhook health vocabulary. */
export interface IntegrationReceiverHealth {
  url: string;
  endpoint_id: string | null;
  state: 'healthy' | 'failing' | 'disabled' | 'unknown';
  failing_since: number | null;
  disabled_at: number | null;
  last_success_at: number | null;
  last_failure: { at: number; status: number | null; error: string | null } | null;
  consecutive_failures: number;
  success_rate_24h: number | null;
  events?: string[];
}

/**
 * An identity integration: any service that verifies a user with a JWT — a
 * preset (`chatly`, `forumulate`, `cookiemunch`, `referalli`) or a custom one.
 * `enabled: false, connected: false` when it was never connected.
 */
export interface Integration {
  object: string;
  id: string;
  /** The same value as `id`. */
  product: string;
  preset: 'chatly' | 'forumulate' | 'cookiemunch' | 'referalli' | null;
  name?: string;
  role?: 'support_chat' | 'docs_community' | 'consent' | 'referrals' | 'other';
  enabled: boolean;
  connected: boolean;
  audience?: string;
  audience_format?: string | null;
  principal_claim?: 'audience_hint' | null;
  ext_claim?: 'external_id' | null;
  ttl_seconds?: number;
  issuer?: string;
  jwks_url?: string;
  token_schema?: string;
  events_url?: string | null;
  events_url_default?: boolean;
  events?: string[];
  backchannel_logout_url?: string | null;
  backchannel_logout_url_default?: boolean;
  /** Where the receiver comes from: set here, the first-party OAuth client's backchannel_logout_uri, or the preset's path. */
  backchannel_logout_source?: 'integration' | 'oauth_client' | 'preset' | null;
  /** With source `oauth_client`: that client's client_id (also the `aud` of its logout tokens). */
  backchannel_logout_client_id?: string | null;
  /** The first-party OAuth client the service signs users in with, as set (null = not set). */
  oauth_client_id?: string | null;
  verify_error_report_url?: string | null;
  cmp?: {
    script_url: string;
    script_id: string | null;
    site_id: string | null;
    blocking_mode: string | null;
    extra_origins: string[];
    settings_preset: 'cookiemunch' | 'cookiebot' | 'onetrust' | 'custom' | null;
    consent_api: { global: string; has_method: string; request_method: string | null; category_map: Record<string, string> | null } | null;
  } | null;
  atlas_id_users?: boolean;
  atlas_id_issuer?: { issuer: string; jwks_url: string } | null;
  enabled_at?: number | null;
  updated_at?: number | null;
  /** Present on a `?dry_run=true` answer. */
  dry_run?: boolean;
  health?: {
    last_minted_at: number | null;
    mints_24h: number;
    verify_errors_24h: number;
    last_verify_error: { error: string; audience: string | null; at: number; reported_at: number } | null;
    events: IntegrationReceiverHealth | null;
    backchannel_logout: IntegrationReceiverHealth | null;
  };
  /** Preset fields (chatly: channel/template/identity_verification; forumulate: org_id/spaces/reader_auth_provider; cookiemunch: site_id; referalli: org_id). */
  [presetField: string]: unknown;
}

export interface SetIntegrationBody {
  enabled?: boolean;
  /** `<preset>:<id>` for a preset; any value for a custom integration. */
  audience?: string;
  /** Custom integrations: the display name (required), role and audience format. */
  name?: string;
  role?: 'support_chat' | 'docs_community' | 'consent' | 'referrals' | 'other';
  audience_format?: string | null;
  principal_claim?: 'audience_hint' | null;
  ext_claim?: 'external_id' | null;
  /** 10-120. Default 120. */
  ttl_seconds?: number;
  /** Omitted = the preset default; null = none. */
  events_url?: string | null;
  /**
   * Omitted = the backchannel_logout_uri of the service's first-party OAuth
   * client when it has one, else the preset default; null = none.
   */
  backchannel_logout_url?: string | null;
  verify_error_report_url?: string | null;
  /**
   * The client_id of the first-party OAuth client the service signs users in
   * with. Omitted = the first-party client tagged `metadata.product = <id>`;
   * null = none.
   */
  oauth_client_id?: string | null;
  cmp?: {
    script_url: string;
    script_id?: string | null;
    site_id?: string | null;
    blocking_mode?: string | null;
    extra_origins?: string[];
    settings_preset?: 'cookiemunch' | 'cookiebot' | 'onetrust' | 'custom' | null;
  /** The CMP's consent API on the page: Atlas reads (and, with request_method, records) consent through it. */
  consent_api?: { global: string; has_method?: string | null; request_method?: string | null; category_map?: Record<string, string> | null } | null;
  } | null;
  atlas_id_users?: boolean;
  /** chatly: the channel (same as `audience: 'chatly:<channel>'`). */
  channel?: string;
  /** forumulate: the org and spaces. */
  org_id?: string;
  spaces?: Array<string | { id: string; redeem_url?: string | null }>;
}

export interface IntegrationDelivery {
  object: 'integration_delivery';
  kind: 'event' | 'backchannel_logout';
  integration: string;
  id: string;
  url: string;
  event_id?: string;
  event_type?: string | null;
  sid?: string | null;
  trace_id: string | null;
  status: 'pending' | 'success' | 'failed';
  attempt_number: number;
  http_status: number | null;
  error: string | null;
  created_at: number;
  [field: string]: unknown;
}

/** An integration token (the claims follow /schemas/integration-token-v1.json). */
export interface IntegrationTokenResponse {
  object: 'integration_token';
  integration: string;
  product: string;
  jwt: string;
  expires_in: number;
  audience: string;
  org_id?: string;
  space_id?: string;
  redeem_url?: string;
  issuer?: string;
  jwks_uri?: string;
}

/** "Sign in with Atlas" on the instance (`GET/PATCH /v1/instance/sign_in_with_atlas`). */
export interface SignInWithAtlasSettings {
  object: 'sign_in_with_atlas';
  /** Whether the embedded and hosted sign-in show "Continue with Atlas". */
  enabled: boolean;
  /** The SSO connection the button starts; null when off. */
  connection_id: string | null;
  /** `instance_toggle`: Atlas created the connection and its Atlas ID app. `linked`: an existing connection of yours. */
  managed_via: 'instance_toggle' | 'linked' | null;
  connection_status: string | null;
  /** Whether this deployment can offer Sign in with Atlas at all. */
  available: boolean;
  /** The Atlas issuer the connection must point at. */
  issuer: string | null;
  /** Active OIDC connections to that issuer that could be linked. */
  candidates: { id: string; client_id: string | null; managed_by_this_instance: boolean }[];
}

export interface UpdateSignInWithAtlasBody {
  enabled: boolean;
  /** Link this existing connection (an active OIDC connection to the Atlas issuer). Omit to pick or create one. */
  connection_id?: string | null;
}

/** Where the hosted pages send the browser (`GET/PATCH /v1/instance/hosted_pages`). */
export interface HostedPagesSettings {
  object: 'hosted_pages';
  /** `/hosted/sign-in` answers 302 here; null serves the hosted page. */
  sign_in_url: string | null;
  sign_up_url: string | null;
  user_url: string | null;
  /** The hosted pages these settings apply to. */
  hosted: { sign_in: string; sign_up: string; user: string };
}

/** Each URL https on one of the instance's allowed origins; null clears it. */
export interface UpdateHostedPagesBody {
  sign_in_url?: string | null;
  sign_up_url?: string | null;
  user_url?: string | null;
}

export function instanceResource(request: RequestFn) {
  return {
    get(): Promise<Instance> {
      return request({ method: 'GET', path: '/v1/instance' });
    },
    update(body: UpdateInstanceBody): Promise<InstanceUpdateResult> {
      return request({ method: 'PATCH', path: '/v1/instance', body });
    },
    /**
     * "Sign in with Atlas": read it, or turn it on or off. `enabled: true` links
     * an existing connection to the Atlas issuer (or the one named by
     * `connection_id`), else creates one.
     */
    signInWithAtlas: {
      get(): Promise<SignInWithAtlasSettings> {
        return request({ method: 'GET', path: '/v1/instance/sign_in_with_atlas' });
      },
      update(body: UpdateSignInWithAtlasBody): Promise<SignInWithAtlasSettings> {
        return request({ method: 'PATCH', path: '/v1/instance/sign_in_with_atlas', body });
      },
    },
    /** Send the hosted sign-in, sign-up and account pages to your app's own pages (302). */
    hostedPages: {
      get(): Promise<HostedPagesSettings> {
        return request({ method: 'GET', path: '/v1/instance/hosted_pages' });
      },
      update(body: UpdateHostedPagesBody): Promise<HostedPagesSettings> {
        return request({ method: 'PATCH', path: '/v1/instance/hosted_pages', body });
      },
    },
    /** Check your setup in one call: configuration the server can see is broken or risky. */
    preflight(params: PreflightParams = {}): Promise<PreflightReport> {
      return request({ method: 'GET', path: '/v1/instance/preflight', query: { ...params } });
    },
    /**
     * The unknown body fields your writes sent over the last `days` (1-90,
     * default 30): fix every row with an `ignored_count`, then turn
     * `auth_config.strictRequestBodies` on.
     */
    unknownFieldsReport(params: { days?: number } = {}): Promise<UnknownFieldsReport> {
      return request({ method: 'GET', path: '/v1/instance/unknown_fields_report', query: { ...params } });
    },
    /** What changed in the API since a date (YYYY-MM-DD): operations added, deprecated and removed. */
    openapiDiff(params: { since: string; surface?: string }): Promise<OpenApiDiff> {
      return request({ method: 'GET', path: '/v1/openapi/diff', query: { ...params } });
    },
    /**
     * Move every URL that points at one origin to another (a domain move), across
     * the instance, its OAuth clients, webhooks, redirect URLs and Sign in with
     * Atlas apps. `dry_run: true` writes nothing.
     */
    moveOrigin(body: OriginMoveRequest): Promise<OriginMove> {
      return request({ method: 'POST', path: '/v1/instance/move_origin', body });
    },
    /**
     * One report of everything that connects the instance to the outside world
     * (setup checks, webhooks with the failing hop, back-channel logout,
     * referrals, email, consent manager, SDK versions). `only` limits the
     * sources; `probe: false` skips live reachability probes.
     */
    integrationHealth(params: { only?: string[]; probe?: boolean } = {}): Promise<IntegrationHealthReport> {
      return request({
        method: 'GET',
        path: '/v1/integration-health',
        query: { only: params.only?.join(','), probe: params.probe === undefined ? undefined : String(params.probe) },
      });
    },
    /** The integration-health check sources this deployment reports. */
    integrationHealthProviders(): Promise<{ object: 'list'; data: { object: 'integration_health_provider'; source: string; description: string }[]; has_more: false }> {
      return request({ method: 'GET', path: '/v1/integration-health/providers' });
    },
    /**
     * The embed manifest for an instance (public; no key needed): CSP sources per
     * surface with its hosts filled in, and the merged policy in `tenant.policy`.
     */
    embed(params: { instance: string; origin?: string; shape?: 'redirect' | 'panel' | 'button' }): Promise<EmbedManifest> {
      return request({ method: 'GET', path: '/v1/embed', query: { ...params } });
    },
    /** The instance's links to other platforms and their health. Read-only. */
    connections(): Promise<InstanceConnections> {
      return request({ method: 'GET', path: '/v1/instance/connections' });
    },
    /**
     * Identity integrations: presets and custom integrations (generic), plus the
     * earlier per-product helpers (`chatly`, `forumulate`) on the same records.
     */
    integrations: {
      /** Every integration (the presets, connected or not, and every custom one) with its health. */
      list(): Promise<{ object: 'list'; data: Integration[]; has_more: boolean }> {
        return request({ method: 'GET', path: '/v1/instance/integrations' });
      },
      get(id: string): Promise<Integration> {
        return request({ method: 'GET', path: `/v1/instance/integrations/${encodeURIComponent(id)}` });
      },
      /** Connect or replace an integration. `{ dryRun: true }` validates and saves nothing. */
      set(id: string, body: SetIntegrationBody, opts: { dryRun?: boolean } = {}): Promise<Integration> {
        return request({
          method: 'PUT',
          path: `/v1/instance/integrations/${encodeURIComponent(id)}`,
          body,
          ...(opts.dryRun ? { query: { dry_run: 'true' } } : {}),
        });
      },
      remove(id: string): Promise<Integration> {
        return request({ method: 'DELETE', path: `/v1/instance/integrations/${encodeURIComponent(id)}` });
      },
      /** Event and back-channel logout deliveries, newest first; `trace` finds one operation. */
      deliveries(
        id: string,
        query: { limit?: number; trace?: string; kind?: 'event' | 'backchannel_logout' } = {},
      ): Promise<{ object: 'list'; data: IntegrationDelivery[]; has_more: boolean }> {
        return request({ method: 'GET', path: `/v1/instance/integrations/${encodeURIComponent(id)}/deliveries`, query });
      },
      /** Reveal the event receiver's signing secret (audited). */
      revealEventsSecret(id: string): Promise<{ object: 'integration_events_secret'; integration: string; endpoint_id: string; url: string; secret: string }> {
        return request({ method: 'POST', path: `/v1/instance/integrations/${encodeURIComponent(id)}/events_secret` });
      },
      /**
       * Rotate the event receiver's signing secret (shown once). With
       * `overlap_seconds` (at most 604800) the old secret keeps signing every
       * delivery as a second Atlas-Signature entry until `previous_secret_expires_at`.
       */
      rotateEventsSecret(
        id: string,
        body: { overlap_seconds?: number } = {},
      ): Promise<{
        object: 'integration_events_secret';
        integration: string;
        endpoint_id: string;
        url: string;
        secret: string;
        overlap_seconds: number;
        previous_secret_expires_at: number | null;
        warning: string;
      }> {
        return request({ method: 'POST', path: `/v1/instance/integrations/${encodeURIComponent(id)}/events_secret/rotate`, body });
      },
      /** An integration token for a Sign in with Atlas user (their Atlas ID access token). */
      atlasIdToken(id: string, accessToken: string): Promise<IntegrationTokenResponse> {
        return request({
          method: 'POST',
          path: `/v1/instance/integrations/${encodeURIComponent(id)}/atlas_id_tokens`,
          body: { access_token: accessToken },
        });
      },
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
