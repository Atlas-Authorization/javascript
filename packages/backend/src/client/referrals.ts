import { enc, type RequestFn } from './request';
import type { ListPage } from './types';
import type { UserReferralResult } from './users';

/**
 * Referral attribution: the instance's connection to a referral platform.
 *
 * With referrals on, every interactive sign-up is reported to the platform
 * before `user.created` is sent and before the session is issued. The
 * platform's answer lands on the user (`referral`, `referral_code`,
 * `referral_link`). A slow or failing platform never fails a sign-up: the
 * call is retried, and `user.referral_attributed` is sent when it resolves.
 *
 * `provider` is `webhook` (the Atlas referral protocol, which any platform can
 * implement; see {@link verifyReferralRequest}), `referally` (the built-in
 * Referally adapter: `endpoint_url` is your Referally base URL, plus
 * `connection_id`, `signing_secret` and optionally `tracking_token`) or
 * another built-in vendor adapter.
 * `signing_secret` and `api_key` are write-only: reads return
 * `signing_secret_set` / `api_key_set`.
 */

/** What a provider can do. An operation it lacks is recorded as `skipped`. */
export interface ReferralProviderCapabilities {
  signup: boolean;
  erase: boolean;
  export: boolean;
  partner: boolean;
  auto_enroll: boolean;
  signal: boolean;
  /** Forwards an `external_id` change after sign-up (old id → new id). */
  alias?: boolean;
  /** Forwards email, name and ban/unban changes. */
  user?: boolean;
  /** Answers a ping (org, program, clock) for the connection test. */
  ping?: boolean;
}

/** A referral provider Atlas supports. */
export interface ReferralProviderInfo {
  /** `webhook` (the Atlas referral protocol) or a vendor adapter id (`dub`, `firstpromoter`, …). */
  id: string;
  name: string;
  capabilities: ReferralProviderCapabilities;
  /** What must be set before `enabled` can be true. */
  needs: Array<'endpoint_url' | 'signing_secret' | 'api_key' | 'connection_id' | 'tracking_token'>;
  /** The vendor's own first-party tracking cookie, suggested when this provider is picked. */
  default_context_cookie: string | null;
  docs_url: string | null;
}

/** Fraud and bot protection for referred sign-ups (`security` on the settings). */
export interface ReferralSecuritySettings {
  /**
   * `always` (default): a sign-up carrying a referral code must pass the bot
   * challenge, even where the captcha is otherwise off. `inherit`: the
   * instance captcha policy decides. With no working captcha, `always` behaves
   * as `inherit` and preflight reports `referrals_without_bot_protection`.
   */
  challenge_referred_signups: 'always' | 'inherit';
  /**
   * `flag` (default): report the sign-up with its risk. `strip`: report it as
   * not referred, with `rejected.reason`. `hold`: report nothing until the
   * email is proven, then re-assess.
   */
  on_high_risk: 'flag' | 'strip' | 'hold';
  /** Hold every referred sign-up until the email is proven. Default false. */
  hold_until_email_verified: boolean;
  /** Referred sign-ups per code from one IP network or device per hour before a velocity signal (1-1000, default 5). */
  max_referred_signups_per_ip_hour: number;
}

/** The connection's health, as the settings read reports it. */
export interface ReferralConnectionStatus {
  /** The last connection test, or null when never tested. */
  last_test: { ok: boolean; at: number; http_status: number | null; error: string | null } | null;
  /** Calls that failed permanently in the last 7 days. */
  failed_calls_7d: number;
  /** Calls waiting for a retry. */
  retrying_calls: number;
  /** Epoch ms of the last successful call, or null. */
  last_success_at: number | null;
  /** The last ping answer, when the provider supports ping. */
  last_ping?: ReferralPing | null;
  /**
   * A refusal only a person can fix: `signature_rejected` (the platform
   * answered 401: a rotated secret or clock skew) or `connection_paused`.
   */
  alert?: { code: string; message: string; at: number; call_id?: string } | null;
}

/** What a platform answers to a ping. */
export interface ReferralPing {
  ok: boolean;
  connection_id?: string | null;
  program_id?: string | null;
  program_name?: string | null;
  org_name?: string | null;
  auto_enroll_users?: boolean | null;
  /** The platform's clock, as it sent it. */
  server_time?: string | number | null;
  /** Platform clock minus Atlas clock, in ms. Over 60 s is a warning; over 5 minutes, signatures fail. */
  clock_skew_ms?: number | null;
  /** True when `clock_skew_ms` is over 60 seconds. */
  clock_skew_warning?: boolean;
  /** Epoch ms of the ping. */
  at?: number | null;
  http_status?: number | null;
  latency_ms?: number | null;
  error_code?: string | null;
  error?: string | null;
}

/** `GET /v1/instance/referrals`. */
export interface ReferralSettings {
  object: 'referral_settings';
  enabled: boolean;
  /** `webhook` (the Atlas referral protocol) or a built-in vendor adapter id. */
  provider: string;
  /** Base URL of the platform connection (Atlas referral protocol). */
  endpoint_url: string | null;
  /** Passed through to the platform. */
  program_id: string | null;
  /** Your label for the connection on the platform side. */
  connection_id: string | null;
  /** Whether a signing secret is stored (the value is never returned). */
  signing_secret_set: boolean;
  /** Whether a vendor API key is stored (the value is never returned). */
  api_key_set: boolean;
  /** Query parameters that carry a referral code, in priority order (default `ref`, `via`, `aff`). */
  url_params: string[];
  /** First-party tracking cookie read under consent; null = never read a cookie. */
  context_cookie: string | null;
  consent_category: string;
  consent_fallback_category: string | null;
  /** Every new user becomes a referrer (gets a code and link from the platform). */
  auto_enroll_users: boolean;
  /** e.g. `https://app.example.com/join?ref={code}`; builds `referral_link`. */
  link_template: string | null;
  /** How long a sign-up waits for the platform (100-5000 ms, default 3000). */
  timeout_ms: number;
  security: ReferralSecuritySettings;
  /** Public tracking token (the `referally` adapter derives the code lookup from it). */
  tracking_token?: string | null;
  /** Public, CORS-enabled lookup with `{code}` for "X invited you" on hosted sign-up. */
  code_lookup_url?: string | null;
  /** Show an optional "Referral code" field on hosted sign-up. */
  signup_code_field?: boolean;
  /** Forward email, name and ban/unban changes to the platform (default true). */
  forward_lifecycle?: boolean;
  /** Mirror the result into `public_metadata.referral` (default false). */
  mirror_to_public_metadata?: boolean;
  /** Add a `referral_code` claim (the user's own code) to ID tokens and sessions. */
  include_referral_claims?: boolean;
  /** What the chosen provider still needs before referrals can be enabled. */
  missing?: string[];
  connection?: ReferralConnectionStatus | null;
  providers: ReferralProviderInfo[];
  updated_at?: number | null;
}

/**
 * `PATCH /v1/instance/referrals`: only the fields sent change, `null` clears.
 * Enabling without what the provider needs is `422 REFERRALS_NOT_CONFIGURED`.
 */
export interface UpdateReferralSettingsBody {
  enabled?: boolean;
  provider?: string;
  /** https only (http only for localhost on a development instance). */
  endpoint_url?: string | null;
  program_id?: string | null;
  connection_id?: string | null;
  /** Write-only, 16-512 characters. */
  signing_secret?: string | null;
  /** Write-only vendor API key. */
  api_key?: string | null;
  /** 1-10 names of `[A-Za-z0-9_.-]{1,40}`. */
  url_params?: string[];
  context_cookie?: string | null;
  consent_category?: string;
  consent_fallback_category?: string | null;
  auto_enroll_users?: boolean;
  /** An https URL containing `{code}`. */
  link_template?: string | null;
  /** 100-5000. */
  timeout_ms?: number;
  /** Partial: only the security fields sent change. */
  security?: Partial<ReferralSecuritySettings>;
  tracking_token?: string | null;
  /** An https URL containing `{code}`. */
  code_lookup_url?: string | null;
  signup_code_field?: boolean;
  forward_lifecycle?: boolean;
  mirror_to_public_metadata?: boolean;
  include_referral_claims?: boolean;
}

/** `POST /v1/instance/referrals/test`. */
export interface ReferralConnectionTest {
  ok: boolean;
  http_status?: number | null;
  latency_ms?: number | null;
  /** e.g. `signature_rejected` (the platform answered 401/403), `timeout`, `network_error`, `url_blocked`, `http_500`. */
  error?: { code: string; message: string };
  /** The ping answer, when the provider supports ping (the test is then a ping). */
  ping?: ReferralPing | null;
  /** `ping`, or `probe` (the older signed export probe). */
  method?: 'ping' | 'probe';
  /** Human warnings, e.g. a clock more than 60 seconds off. */
  warnings?: string[];
}

/** `POST /v1/instance/referrals/simulate`: a sign-up call for a fake user, never stored. */
export interface ReferralSimulateResult {
  object: 'referral_simulation';
  ok: boolean;
  /** The logged call, in the delivery log. */
  call_id: string | null;
  /** `atlas_test_<random>`. */
  customer_ref: string;
  http_status: number | null;
  latency_ms: number | null;
  /** The platform's answer, normalised (null when the call failed). */
  result: {
    referral: { partner_id: string | null; partner_external_ref: string | null; matched_via: string | null; status: string | null } | null;
    partner: { id: string | null; code: string | null; link: string | null } | null;
    notes: string[];
  } | null;
  /** The platform's raw answer, personal fields removed. */
  response: unknown;
  error: { code: string; message: string } | null;
}

/** `POST /v1/instance/referrals/calls/retry_failed`. */
export interface ReferralRetryFailedResult {
  object: 'referral_retry';
  /** How many failed calls were queued to send now. */
  requeued: number;
}

/** `POST /v1/instance/referrals/backfill`. */
export interface ReferralBackfillBody {
  /** ISO 8601 date or date-time: users who signed up at or after it. */
  since: string;
  /** customerRef → code (a CSV, for example). Wins over `code_metadata_path`. */
  codes?: Record<string, string>;
  /** Where a stored code lives on the user, e.g. `public_metadata.referral_code`. */
  code_metadata_path?: string;
}

/** A backfill job. Users already reported are skipped. */
export interface ReferralBackfillJob {
  object: 'referral_backfill';
  id: string;
  /** `running` while any queued call is still to be sent, then `completed`. */
  status: string;
  /** Epoch ms. */
  since: number;
  code_metadata_path?: string | null;
  /** How many codes were given in `codes`. */
  codes_given?: number;
  users_scanned: number;
  /** Already reported, or no code while auto-enroll is off. */
  users_skipped: number;
  calls_queued: number;
  /** True when the run stopped at its cap: start another from `next_since`. */
  truncated: boolean;
  /** Epoch ms, when `truncated`. */
  next_since?: number | null;
  /** Where the queued calls stand. */
  calls: { pending: number; succeeded: number; failed: number; skipped: number; held: number };
  created_at: number;
  finished_at?: number | null;
}

export type ReferralCallKind =
  | 'signup'
  | 'erase'
  | 'export'
  | 'partner'
  | 'signal'
  | 'alias'
  | 'user'
  | 'ping'
  | 'test';
export type ReferralCallStatus = 'pending' | 'succeeded' | 'retrying' | 'failed' | 'held' | 'skipped';

/** The risk verdict sent with a sign-up (camelCase, as on the referral protocol). */
export interface ReferralRisk {
  level: 'low' | 'medium' | 'high';
  /** 0-100. */
  score: number;
  /**
   * e.g. `self_referral`, `ip_velocity`, `device_velocity`, `disposable_email`,
   * `datacenter_ip`, `tor_ip`, `captcha_not_passed`, `email_unverified`,
   * `restricted_identifier`.
   */
  signals: string[];
  captcha: 'passed' | 'not_required' | 'not_configured';
  emailVerified: boolean;
}

/** One call in the referral call log. */
export interface ReferralCall {
  object: 'referral_call';
  /** Also the signed `atlas-id` header of every attempt. */
  id: string;
  kind: ReferralCallKind;
  status: ReferralCallStatus;
  /** Sign-up calls: `referred`, `not_referred` or `stripped`. */
  outcome?: string | null;
  customer_ref: string;
  user_id?: string | null;
  http_status?: number | null;
  last_error?: string | null;
  attempts: number;
  /** Epoch ms of the next retry, while pending or retrying. */
  next_attempt_at?: number | null;
  risk?: ReferralRisk | null;
  /** What was sent (never secrets). */
  payload?: Record<string, unknown>;
  /** Round trip of the last attempt, in ms. */
  latency_ms?: number | null;
  /**
   * Machine code of the last failure, e.g. `signature_rejected` (401, not
   * retried), `connection_paused` (paused by the merchant, not retried),
   * `rate_limited`, `timeout`, `network_error`.
   */
  error_code?: string | null;
  /** The platform's last answer, with personal data removed. */
  response?: unknown;
  /** Sign-up calls: how the platform matched, the referrer and its notes. */
  highlights?: { matched_via: string | null; partner_external_ref: string | null; notes: string[] } | null;
  /** The platform's request id for its last answer, for its support team. */
  request_id?: string | null;
  /** The backfill job this call belongs to. */
  batch_id?: string | null;
  created_at: number;
  updated_at?: number;
}

export interface ListReferralCallsParams {
  /** 1-1000 (1-200 on servers before referral attribution v2), default 50, newest first. */
  limit?: number;
  status?: ReferralCallStatus;
  kind?: ReferralCallKind;
  user_id?: string;
  /** e.g. `signature_rejected`. */
  error_code?: string;
  /** The id of the last call of the previous page. */
  starting_after?: string;
}

export function referralsResource(request: RequestFn) {
  return {
    /** `GET /v1/instance/referrals` — settings, connection status and the supported providers. */
    get(): Promise<ReferralSettings> {
      return request({ method: 'GET', path: '/v1/instance/referrals' });
    },
    /** `PATCH /v1/instance/referrals` — partial update; secrets are write-only. */
    update(body: UpdateReferralSettingsBody, idempotencyKey?: string): Promise<ReferralSettings> {
      return request({ method: 'PATCH', path: '/v1/instance/referrals', body, idempotencyKey });
    },
    /**
     * `POST /v1/instance/referrals/test` — a signed probe of the platform. `ok`
     * when it answered 2xx or 404; `error.code` `signature_rejected` on 401/403.
     */
    test(): Promise<ReferralConnectionTest> {
      return request({ method: 'POST', path: '/v1/instance/referrals/test' });
    },
    /** `GET /v1/instance/referrals/calls` — the call log, newest first. */
    listCalls(params: ListReferralCallsParams = {}): Promise<ListPage<ReferralCall>> {
      return request({ method: 'GET', path: '/v1/instance/referrals/calls', query: { ...params } });
    },
    /**
     * `POST /v1/instance/referrals/calls/:id/retry` — retry a failed, retrying
     * or skipped call now (a connection test cannot be retried).
     */
    retryCall(id: string, idempotencyKey?: string): Promise<ReferralCall> {
      return request({
        method: 'POST',
        path: `/v1/instance/referrals/calls/${enc(id)}/retry`,
        idempotencyKey,
      });
    },
    /** `POST /v1/instance/referrals/calls/retry_failed` — re-queue every failed call (not tests) to send now. */
    retryFailed(
      filter: { kind?: ReferralCallKind; error_code?: string } = {},
      idempotencyKey?: string,
    ): Promise<ReferralRetryFailedResult> {
      return request({ method: 'POST', path: '/v1/instance/referrals/calls/retry_failed', body: filter, idempotencyKey });
    },
    /**
     * `POST /v1/instance/referrals/simulate` — send a sign-up call for a fake
     * user (`atlas_test_<random>`, never stored) with an optional code, and
     * return what the platform answered.
     */
    simulate(body: { code?: string } = {}): Promise<ReferralSimulateResult> {
      return request({ method: 'POST', path: '/v1/instance/referrals/simulate', body });
    },
    /**
     * `POST /v1/instance/referrals/backfill` — queue sign-up calls for existing
     * users with their real sign-up time. Referrals must be on (`422
     * REFERRALS_NOT_CONFIGURED` otherwise). Returns the job; poll {@link getBackfill}.
     */
    backfill(body: ReferralBackfillBody, idempotencyKey?: string): Promise<ReferralBackfillJob> {
      return request({ method: 'POST', path: '/v1/instance/referrals/backfill', body, idempotencyKey });
    },
    /** `GET /v1/instance/referrals/backfill/:id`. */
    getBackfill(id: string): Promise<ReferralBackfillJob> {
      return request({ method: 'GET', path: `/v1/instance/referrals/backfill/${enc(id)}` });
    },
    /**
     * `GET /v1/users/:id/referral` — the stored result for one user (who
     * referred them, how, their own code), with no call to the platform.
     */
    getForUser(userId: string): Promise<UserReferralResult> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/referral` });
    },
  };
}
