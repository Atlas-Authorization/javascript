import { fieldErrors, isTerminal, nextStep, type AttemptView, type FieldError } from './attempt';
import { ATLAS_JS_SDK, SDK_HEADER, reportSdkAdvisory, sdkHeaderValue, type AtlasSdkInfo } from './sdk-advisory';
import { withDevBrowser } from './dev-browser';
import {
  acceptsReferral,
  currentReferral,
  referralCacheKeyFor,
  rememberReferralLanding,
  seedReferralConfig,
  type ReferralCaptureOptions,
  type ReferralConsent,
  type ReferralSourceReader,
} from './referral';

/**
 * The FAPI client and the sign-in flow driver.
 *
 * The driver's whole job is to answer one question — "given the step the server
 * says we are on, which endpoint does this input go to?" — and to answer it in
 * ONE place. Scattering that decision across a component is how a password ends
 * up posted to the second-factor endpoint, or a TOTP code to
 * `attempt_first_factor`: both produce a confusing 400 rather than an obvious
 * bug, and both are easy to write.
 *
 * Nothing here ever advances the flow locally. The status always comes back
 * from the server (§5), so a client that guesses wrong is corrected on the next
 * response rather than diverging silently.
 */

export interface FapiClientOptions {
  publishableKey: string;
  /** The instance's FAPI origin. Empty for same-origin. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /**
   * The app's UI language as a BCP-47 tag (`"es"`, `"pt-BR"`). When set, every
   * request carries it as `Accept-Language`, so the server writes its error
   * `message`s in that language — the fallback a prebuilt form shows for an
   * error whose `reason` its catalog has no string for. Unset sends no header
   * (the browser's own `Accept-Language` applies). A malformed tag is ignored.
   */
  locale?: string;
  /**
   * Which SDK is calling, sent as `X-Atlas-SDK` so the Frontend API can answer
   * an upgrade advisory (logged once per page load). Framework SDKs pass their
   * own package; defaults to `@atlasauth/js`.
   */
  sdk?: AtlasSdkInfo;
  /**
   * Referral attribution. By default (`'auto'`) a client captures the referral
   * the visitor arrived with (the page's referral script `window.aff`, explicit
   * `ref_*` URL parameters, the instance's URL parameters, then its tracking
   * cookie) and sends it on every sign-in / sign-up start, when the instance
   * has referrals on. `false` turns that off. See `./referral`.
   */
  referral?: false | 'auto';
  /**
   * The app's own consent decision for referral tracking (click and anonymous
   * ids): `'granted'` / `'denied'`, a boolean, or a function returning one.
   * A consent manager on the page decides when there is one; this applies
   * when there isn't (or when the instance's `consent_provider` is `app`).
   * Default: code only.
   */
  referralConsent?: ReferralConsent;
  /** Your own reader for a referral program the SDK doesn't know: `() => ({code, clickId, anonId}) | null`. */
  referralSource?: ReferralSourceReader;
}

/**
 * A locale tag normalised for the `Accept-Language` header (`pt_BR` → `pt-BR`),
 * or null when it is not a plausible BCP-47 tag. Restricting it to letters,
 * digits and hyphens keeps the header CORS-safelisted, so sending it never adds
 * a preflight to a cross-origin Frontend API call.
 */
export function acceptLanguageFor(locale: string | null | undefined): string | null {
  if (typeof locale !== 'string') return null;
  const tag = locale.trim().replace(/_/g, '-');
  return /^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$/.test(tag) ? tag : null;
}

export interface FapiResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  errors: FieldError[];
}

export class FapiClient {
  constructor(private readonly options: FapiClientOptions) {
    // Keep the query this page was opened with: a referral code in it must
    // survive client-side navigation that drops it before the user signs up.
    rememberReferralLanding();
  }

  /** Which instance's referral config this client shares (one fetch per page). */
  get referralCacheKey(): string {
    return referralCacheKeyFor(this.options.baseUrl, this.options.publishableKey);
  }

  /** This client's own referral options (page-wide defaults fill the gaps). */
  get referralOptions(): ReferralCaptureOptions {
    return { referral: this.options.referral, referralConsent: this.options.referralConsent, referralSource: this.options.referralSource };
  }

  /** The `Accept-Language` this client sends, or null when it sends none. */
  get locale(): string | null {
    return acceptLanguageFor(this.options.locale);
  }

  /**
   * The origin FAPI serves from — where an OAuth popup's callback page lives, so
   * the popup flow can pin `postMessage`'s `event.origin` to it. Empty `baseUrl`
   * means same-origin, so callers fall back to `window.location.origin`.
   */
  get frontendApiOrigin(): string {
    const base = this.options.baseUrl;
    if (!base) return '';
    try {
      return new URL(base).origin;
    } catch {
      return '';
    }
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<FapiResponse<T>> {
    // Development instances keep the session in a header where the browser blocks the cookie (./dev-browser).
    const doFetch = withDevBrowser(this.options.publishableKey, this.options.fetchImpl ?? fetch);

    const language = this.locale;
    const sdk = this.options.sdk ?? ATLAS_JS_SDK;
    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl ?? ''}${path}`, {
        ...init,
        // Cookies carry the session. A request without this is indistinguishable
        // from being signed out, which is a maddening bug to chase.
        credentials: 'include',
        headers: {
          'x-publishable-key': this.options.publishableKey,
          [SDK_HEADER]: sdkHeaderValue(sdk),
          ...(language ? { 'accept-language': language } : {}),
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch {
      /**
       * A network failure is reported as a form-level error rather than thrown.
       * A sign-in box that throws on a flaky connection unmounts itself and
       * loses whatever the user had typed.
       */
      return {
        ok: false,
        status: 0,
        data: null,
        errors: [{ code: 'NETWORK', reason: 'network', message: 'We could not reach the server.' }],
      };
    }

    reportSdkAdvisory(response, sdk);

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A 204, or an error page from a proxy. Neither should crash the parse.
    }

    // Any environment / appearance read also tells referral capture the
    // instance's config, so a page that already loaded it never fetches it again.
    const bare = path.split('?')[0];
    if (response.ok && (init.method ?? 'GET') === 'GET' && (bare === '/v1/client/environment' || bare === '/v1/appearance')) {
      seedReferralConfig(this.referralCacheKey, body);
    }

    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? (body as T) : null,
      // §9.1 messages are written for humans and surfaced verbatim.
      errors: response.ok ? [] : fieldErrors(body),
    };
  }

  async post<T>(path: string, body?: unknown): Promise<FapiResponse<T>> {
    // Referral attribution rides on every sign-in / sign-up start (and on the
    // steps that continue one: the server keeps the first one it is given).
    let payload = body;
    if (
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      !('referral' in (payload as Record<string, unknown>)) &&
      acceptsReferral(path)
    ) {
      const referral = await currentReferral(this);
      if (referral) payload = { ...(payload as Record<string, unknown>), referral };
    }
    return this.request<T>(path, {
      method: 'POST',
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
  }

  get<T>(path: string) {
    return this.request<T>(path, { method: 'GET' });
  }
}

/**
 * §6.6 client-side token vault. A signed-in user's OWN live provider access
 * token, so the app can call e.g. the Google API from the browser — the
 * `user.getToken({ provider })` equivalent.
 *
 * The server keys the lookup off the session, never a user id, so this can only
 * ever return the caller's own token. The long-lived refresh token is never
 * exposed — only the short-lived access token it mints.
 */
export interface ProviderToken {
  provider: string;
  accessToken: string;
  /** Epoch ms, or null when the provider issues non-expiring tokens. */
  expiresAt: number | null;
  scopes: string[];
}

/**
 * Fetch the signed-in user's provider access token. Returns null when there is
 * no usable token (no linked account, or the provider granted none / revoked
 * it) — the caller's cue to prompt a re-connect rather than treat it as fatal.
 * The server refreshes a stale token on read, single-flight, so the token
 * handed back is always live.
 */
export async function getProviderToken(
  client: FapiClient,
  provider: string,
): Promise<ProviderToken | null> {
  const response = await client.get<{
    provider: string;
    access_token: string;
    expires_at: number | null;
    scopes: string[];
  }>(`/v1/client/me/external_accounts/${encodeURIComponent(provider)}/token`);

  if (!response.ok || !response.data) return null;

  return {
    provider: response.data.provider,
    accessToken: response.data.access_token,
    expiresAt: response.data.expires_at ?? null,
    scopes: response.data.scopes ?? [],
  };
}

/**
 * `getToken({ template })` for a session: a short-lived JWT minted from a named
 * JWT template (or a built-in preset such as `chatly`, for a support-chat
 * identity), for the session the browser's cookie carries. The refresh cookie is
 * presented, never rotated. Null when the instance has no such template or the
 * session is gone.
 */
export async function getTemplateToken(
  client: FapiClient,
  sessionId: string,
  template: string,
): Promise<{ jwt: string; expiresIn: number } | null> {
  const response = await client.post<{ jwt: string; expires_in: number }>(
    `/v1/client/sessions/${encodeURIComponent(sessionId)}/tokens/${encodeURIComponent(template)}`,
  );
  if (!response.ok || !response.data?.jwt) return null;
  return { jwt: response.data.jwt, expiresIn: response.data.expires_in };
}

/**
 * The signed-in user's Forumulate reader token for a connected space, and where
 * the reader's browser redeems it. Null without a session or a connection.
 */
export async function getForumulateReaderToken(
  client: FapiClient,
  spaceId?: string,
): Promise<{ jwt: string; expiresIn: number; orgId: string; spaceId: string; redeemUrl: string } | null> {
  const response = await client.get<{
    jwt: string;
    expires_in: number;
    org_id: string;
    space_id: string;
    redeem_url: string;
  }>(`/v1/client/forumulate/reader_token${spaceId ? `?space_id=${encodeURIComponent(spaceId)}` : ''}`);
  if (!response.ok || !response.data?.jwt) return null;
  const d = response.data;
  return { jwt: d.jwt, expiresIn: d.expires_in, orgId: d.org_id, spaceId: d.space_id, redeemUrl: d.redeem_url };
}

export interface FlowState {
  attempt: AttemptView | null;
  errors: FieldError[];
  busy: boolean;
  /** Held only for the magic-link path; see §5.3. */
  pollSecret: string | null;
  /**
   * §7.1: the one-time ticket a completion response carries. Present for exactly
   * one step — the one that reached `complete` — so the caller can exchange it
   * for cookies and then it is gone.
   */
  ticket: string | null;
  /**
   * §5.3 the emailed factor this attempt has been sent (`prepareFactor`), so a
   * form draws the code field or the "check your email" step. Cleared when the
   * server returns a new attempt.
   */
  prepared?: 'email_code' | 'email_link' | null;
  /**
   * After a sign-in completed here: true when this browser now holds the
   * session, false when it didn't keep it (its cookie was blocked). Unset while
   * unknown, and for a sign-in completed on another device.
   */
  sessionKept?: boolean;
}

export const initialFlow: FlowState = {
  attempt: null,
  errors: [],
  busy: false,
  pollSecret: null,
  ticket: null,
  prepared: null,
};

/**
 * Which request the current step needs.
 *
 * Exported and tested separately from the network call, because this mapping is
 * the part that can be wrong in a way nobody notices until a user is stuck.
 */
export function requestForStep(
  attempt: AttemptView | null,
  values: Record<string, string>,
): { path: string; body: Record<string, unknown> } | null {
  if (!attempt) {
    return {
      path: '/v1/client/sign_ins',
      // §5 carry a captcha token when the sign-in flow gates the identifier
      // step (an always-on per-flow captcha, or a risk-triggered challenge the
      // server answered with needs_captcha).
      body: {
        identifier: values.identifier ?? '',
        ...(values.captcha_token ? { captcha_token: values.captcha_token } : {}),
      },
    };
  }

  const step = nextStep(attempt);
  const id = attempt.id ?? '';

  switch (step.kind) {
    case 'collect_identifier':
      return {
        path: '/v1/client/sign_ins',
        body: {
          identifier: values.identifier ?? '',
          ...(values.captcha_token ? { captcha_token: values.captcha_token } : {}),
        },
      };

    case 'collect_first_factor':
      /**
       * An emailed code and a password both arrive as "the thing the user
       * typed", but they are different strategies on the same endpoint. The
       * presence of a code field is what distinguishes them — a client-declared
       * strategy would be a field the client can get wrong.
       */
      return values.code
        ? {
            path: `/v1/client/sign_ins/${id}/attempt_first_factor`,
            body: { strategy: 'email_code', code: values.code },
          }
        : {
            path: `/v1/client/sign_ins/${id}/attempt_first_factor`,
            body: { strategy: 'password', password: values.password ?? '' },
          };

    case 'collect_second_factor':
      // Only ever the code (+ the §5.3 "remember this device" opt-in). Sending
      // `password` here would be posting a credential to an endpoint that has no
      // business seeing one.
      return {
        path: `/v1/client/sign_ins/${id}/attempt_second_factor`,
        body: {
          code: values.code ?? '',
          ...(values.remember_device === 'true' ? { remember_device: true } : {}),
        },
      };

    /**
     * §11.1 MFA policy `required`. Two consecutive codes, and the factor id
     * from the prepare step — a different endpoint from the second factor,
     * because there is no factor to verify against yet.
     */
    case 'enroll_second_factor':
      return {
        path: `/v1/client/sign_ins/${id}/attempt_mfa_enrollment`,
        body: {
          factor_id: values.factorId ?? '',
          codes: [values.code ?? '', values.secondCode ?? ''],
        },
      };

    case 'collect_email_code':
      return {
        path: `/v1/client/sign_ups/${id}/attempt_verification`,
        body: { code: values.code ?? '' },
      };

    case 'collect_captcha':
      /**
       * §5 the challenge marker carries no attempt id — the server withheld the
       * attempt until the captcha clears. There is nothing to submit until the
       * widget yields a token (the client should render the captcha, not POST);
       * once solved, re-issue the identifier POST WITH the token to create the
       * real attempt. Submitting without a token just re-triggers the challenge.
       */
      return values.captcha_token
        ? {
            path: '/v1/client/sign_ins',
            body: {
              identifier: values.identifier ?? '',
              captcha_token: values.captcha_token,
            },
          }
        : null;

    case 'collect_new_password':
      return {
        path: `/v1/client/password_resets/${id}/set_new_password`,
        body: { password: values.password ?? '' },
      };

    case 'await_oauth':
    case 'done':
    case 'restart':
    case 'unknown':
      /**
       * Nothing to submit. Returning null rather than a best guess means a
       * component cannot accidentally POST to an endpoint that does not apply
       * to the state the server put it in.
       */
      return null;
  }
}

/**
 * §5.3: seed a flow from an attempt the app was handed mid-stream — an OAuth
 * redirect that came back needing a second factor (`__atlas_status`), with no
 * ticket because the server withheld the session until the factor is passed.
 *
 * The attempt id lets the next submit target the right attempt; the status
 * routes the UI to the step the server is demanding. A null pending attempt —
 * the ordinary fresh sign-in — yields the empty initial flow.
 */
export function flowFromPending(pending: { id: string; status: string } | null): FlowState {
  if (!pending) return initialFlow;
  return {
    ...initialFlow,
    attempt: { id: pending.id, status: pending.status },
  };
}

/** Advance the flow by one step. Never decides the next status itself. */
export async function advance(
  client: FapiClient,
  state: FlowState,
  values: Record<string, string>,
): Promise<FlowState> {
  const request = requestForStep(state.attempt, values);
  if (!request) return state;

  const response = await client.post<AttemptView & { ticket?: string }>(request.path, request.body);

  if (!response.ok || !response.data) {
    /**
     * The attempt is KEPT on failure. Clearing it would drop the user back to
     * the identifier step after one wrong password, losing the progress they
     * made and re-triggering the anti-enumeration path for no reason.
     */
    return { ...state, busy: false, errors: response.errors };
  }

  const sameAttempt = response.data.id === state.attempt?.id && response.data.status === state.attempt?.status;
  return {
    attempt: response.data,
    errors: [],
    busy: false,
    pollSecret: state.pollSecret,
    // A completion response carries the ticket to exchange for cookies.
    ticket: response.data.ticket ?? null,
    prepared: sameAttempt ? (state.prepared ?? null) : null,
  };
}

/**
 * §5 Begin a password sign-up. POSTs email + password + the tenant's configured
 * extra fields (name, company, phone, custom…) to `/v1/client/sign_ups` and
 * returns a flow. Usually `needs_email_verification` — the shared `advance` then
 * drives the emailed code to completion — or, when the instance doesn't gate on
 * verification, a `complete` attempt carrying the session ticket.
 */
export async function startSignUp(
  client: FapiClient,
  input: {
    email: string;
    password: string;
    fields?: Record<string, string>;
    consent?: boolean;
    captchaToken?: string;
  },
): Promise<FlowState> {
  const hasFields = input.fields && Object.keys(input.fields).length > 0;
  const response = await client.post<AttemptView & { ticket?: string }>('/v1/client/sign_ups', {
    email: input.email,
    password: input.password,
    ...(hasFields ? { fields: input.fields } : {}),
    // §5.1 forward the legal-consent tick so the server can enforce a REQUIRED
    // agreement (the disabled submit is only a client-side courtesy).
    ...(input.consent ? { consent: true } : {}),
    // §5 the bot-defence token, when the sign-up flow's captcha is enabled.
    ...(input.captchaToken ? { captcha_token: input.captchaToken } : {}),
  });

  if (!response.ok || !response.data) {
    return { ...initialFlow, busy: false, errors: response.errors };
  }

  return {
    attempt: response.data,
    errors: [],
    busy: false,
    pollSecret: initialFlow.pollSecret,
    ticket: response.data.ticket ?? null,
  };
}

/** §5.3: ask the server to send a code or a magic link. */
export async function prepareFactor(
  client: FapiClient,
  state: FlowState,
  strategy: 'email_code' | 'email_link',
): Promise<FlowState> {
  const id = state.attempt?.id;
  if (!id) return state;

  const response = await client.post<{ poll_secret?: string }>(
    `/v1/client/sign_ins/${id}/prepare_first_factor`,
    { strategy },
  );

  if (!response.ok) return { ...state, busy: false, errors: response.errors };

  return {
    ...state,
    busy: false,
    errors: [],
    // Held in memory only. It is what lets THIS tab collect a sign-in completed
    // by a link opened on another device. A code is typed into this tab, so
    // there is nothing to poll for.
    pollSecret: strategy === 'email_link' ? (response.data?.poll_secret ?? null) : null,
    prepared: strategy,
  };
}

/**
 * §5.3 polling. Returns the updated flow, and a ticket once the link has been
 * opened somewhere.
 */
export async function pollAttempt(
  client: FapiClient,
  state: FlowState,
): Promise<{ state: FlowState; ticket: string | null }> {
  const id = state.attempt?.id;
  if (!id || !state.pollSecret) return { state, ticket: null };

  const response = await client.get<AttemptView & { ticket?: string }>(
    `/v1/client/sign_ins/${id}?poll_secret=${encodeURIComponent(state.pollSecret)}`,
  );

  if (!response.ok || !response.data) return { state, ticket: null };

  return {
    state: { ...state, attempt: response.data },
    ticket: response.data.ticket ?? null,
  };
}

/** Whether polling should continue, so a tab does not poll a dead attempt forever. */
export function shouldKeepPolling(state: FlowState): boolean {
  return Boolean(state.pollSecret) && Boolean(state.attempt) && !isTerminal(state.attempt!);
}
