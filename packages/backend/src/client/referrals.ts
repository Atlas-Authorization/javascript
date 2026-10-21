import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

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
 * implement; see {@link verifyReferralRequest}) or a built-in vendor adapter.
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
}

/** A referral provider Atlas supports. */
export interface ReferralProviderInfo {
  /** `webhook` (the Atlas referral protocol) or a vendor adapter id (`dub`, `firstpromoter`, …). */
  id: string;
  name: string;
  capabilities: ReferralProviderCapabilities;
  /** What must be set before `enabled` can be true. */
  needs: Array<'endpoint_url' | 'signing_secret' | 'api_key' | 'connection_id'>;
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
}

/** `POST /v1/instance/referrals/test`. */
export interface ReferralConnectionTest {
  ok: boolean;
  http_status?: number | null;
  latency_ms?: number | null;
  /** e.g. `signature_rejected` (the platform answered 401/403), `timeout`, `network_error`, `url_blocked`, `http_500`. */
  error?: { code: string; message: string };
}

export type ReferralCallKind = 'signup' | 'erase' | 'export' | 'partner' | 'signal' | 'test';
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
  created_at: number;
  updated_at?: number;
}

export interface ListReferralCallsParams {
  /** 1-200, default 50, newest first. */
  limit?: number;
  status?: ReferralCallStatus;
  kind?: ReferralCallKind;
  user_id?: string;
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
  };
}
