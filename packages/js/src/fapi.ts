import { acceptPoliciesBody, type PolicyAcceptance } from './policies';
import { fieldErrors, isTerminal, nextStep, type AttemptView, type FieldError } from './attempt';
import { ATLAS_JS_SDK, SDK_HEADER, reportSdkAdvisory, sdkHeaderValue, type AtlasSdkInfo } from './sdk-advisory';
import { setPersistence, withDevBrowser, type PersistenceMode } from './dev-browser';
import { recoveryCodesFrom } from './mfa-enrollment';
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
import { deviceId } from './telemetry';
import { attestationHeaderFor, isAttestationGuarded, type AttestationProvider } from './attestation';
import { parsePolicyAcceptances } from './policy-acceptance';

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
   * Where the browser keeps the development-instance session token: `'local'`
   * (default; survives restarts, shared by tabs), `'session'` (this tab only) or
   * `'memory'` (this page load only; nothing is written). Production sessions
   * live in cookies and are not affected.
   */
  persistence?: PersistenceMode;
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
   * App and device attestation for native apps (Apple App Attest / Play
   * Integrity). When set, sign-up, sign-in and SMS-send calls carry the
   * `Atlas-Attestation` proof. See `./attestation`.
   */
  attestation?: AttestationProvider;
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

/**
 * The starts that can create an account, and so carry the SDK's stable device
 * id for the accounts-per-device abuse limit. Password and passwordless
 * sign-ins never create one and do not send it.
 */
export const DEVICE_ID_ROUTES: ReadonlySet<string> = new Set([
  '/v1/client/sign_ups',
  '/v1/client/sign_ins/oauth',
  '/v1/client/sign_ins/sso',
  '/v1/client/sign_ins/saml',
  '/v1/client/sign_ins/wsfed',
  '/v1/client/sign_ins/discourse',
  '/v1/client/sign_ins/id_token',
  '/v1/client/sign_ins/external_jwt',
  '/v1/client/sign_ins/ldap',
  '/v1/oauth/telegram',
  '/v1/oauth/game_platform',
  '/v1/oauth/siwe/verify',
  '/v1/oauth/siws/verify',
  '/v1/oauth/siwb/verify',
  '/v1/oauth/siwf/verify',
]);

export class FapiClient {
  constructor(private readonly options: FapiClientOptions) {
    // Keep the query this page was opened with: a referral code in it must
    // survive client-side navigation that drops it before the user signs up.
    rememberReferralLanding();
    if (options.persistence) setPersistence(options.persistence);
  }

  /** Which instance's referral config this client shares (one fetch per page). */
  get referralCacheKey(): string {
    return referralCacheKeyFor(this.options.baseUrl, this.options.publishableKey);
  }

  /** This client's own referral options (page-wide defaults fill the gaps). */
  get referralOptions(): ReferralCaptureOptions {
    return { referral: this.options.referral, referralConsent: this.options.referralConsent, referralSource: this.options.referralSource };
  }

  /** The publishable key this client sends. */
  get publishableKey(): string {
    return this.options.publishableKey;
  }

  /** The absolute URL of a Frontend API path (for a DPoP proof's `htu`). */
  urlFor(path: string): string {
    const base = this.options.baseUrl || (typeof window !== 'undefined' ? window.location.origin : '');
    return `${base}${path}`;
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
    const provider = this.options.attestation;
    const attestation =
      provider && isAttestationGuarded(path, (init.method ?? 'GET').toUpperCase())
        ? await attestationHeaderFor(this, provider)
        : null;
    try {
      response = await doFetch(`${this.options.baseUrl ?? ''}${path}`, {
        ...init,
        // Cookies carry the session. A request without this is indistinguishable
        // from being signed out, which is a maddening bug to chase. A call that
        // authenticates with a bearer token instead may opt out (`omit`).
        credentials: init.credentials ?? 'include',
        headers: {
          'x-publishable-key': this.options.publishableKey,
          [SDK_HEADER]: sdkHeaderValue(sdk),
          ...(language ? { 'accept-language': language } : {}),
          ...(attestation ? { 'atlas-attestation': attestation } : {}),
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
    // The stable device id rides on every start that can create an account
    // (email sign-up, social and enterprise SSO sign-ins) so the instance's
    // accounts-per-device abuse limit can count devices, not networks.
    const bare = path.split('?')[0];
    if (
      bare !== undefined &&
      DEVICE_ID_ROUTES.has(bare) &&
      payload !== null &&
      typeof payload === 'object' &&
      !Array.isArray(payload) &&
      !('device_id' in (payload as Record<string, unknown>))
    ) {
      const id = deviceId();
      if (id) payload = { ...(payload as Record<string, unknown>), device_id: id };
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
 * A per-call audience for an integration token: `audience` (the whole `aud`,
 * e.g. `cookiemunch:dv-1`), `cbid` (the Cookie Munch site id, the same as
 * `audience: 'cookiemunch:<cbid>'`), or `audienceParams` for any integration's
 * own parameter (e.g. `{ tenant: 't1' }`). The integration must permit it
 * (its `per_call_audience`); otherwise no token is minted.
 */
export interface IntegrationAudienceOptions {
  audience?: string;
  cbid?: string;
  audienceParams?: Record<string, string>;
}

/** The query string for a per-call audience (and any extra parameters). */
export function integrationAudienceQuery(options: IntegrationAudienceOptions & { spaceId?: string } = {}): string {
  const q = new URLSearchParams();
  if (options.spaceId) q.set('space_id', options.spaceId);
  for (const [k, v] of Object.entries(options.audienceParams ?? {})) if (typeof v === 'string' && v) q.set(k, v);
  if (options.cbid) q.set('cbid', options.cbid);
  if (options.audience) q.set('audience', options.audience);
  const s = q.toString();
  return s ? `?${s}` : '';
}

/** An integration token: what `getToken({ for })` resolves for a configured identity integration. */
export interface IntegrationToken {
  jwt: string;
  expiresIn: number;
  /** The integration id it was minted for (a preset such as `chatly`, or a custom id). */
  integration: string;
  /** The token's `aud`. */
  audience: string;
  /** Forumulate preset: the organization, the space and where the reader's browser redeems the token. */
  orgId?: string;
  spaceId?: string;
  redeemUrl?: string;
}

/**
 * `getToken({ for })` for a session: a short-lived token for a configured
 * identity integration — any service that verifies the user with a JWT (the
 * built-in presets `chatly`, `forumulate`, `cookiemunch`, `referalli`, or a
 * custom integration id). The refresh cookie is presented, never rotated. Null
 * when the integration is not enabled or the session is gone.
 */
export async function getIntegrationToken(
  client: FapiClient,
  sessionId: string,
  integration: string,
  options: { spaceId?: string } & IntegrationAudienceOptions = {},
): Promise<IntegrationToken | null> {
  const q = integrationAudienceQuery(options);
  const response = await client.post<{
    jwt: string;
    expires_in: number;
    integration: string;
    audience: string;
    org_id?: string;
    space_id?: string;
    redeem_url?: string;
  }>(`/v1/client/sessions/${encodeURIComponent(sessionId)}/integration_tokens/${encodeURIComponent(integration)}${q}`);
  if (!response.ok || !response.data?.jwt) return null;
  const d = response.data;
  return {
    jwt: d.jwt,
    expiresIn: d.expires_in,
    integration: d.integration,
    audience: d.audience,
    ...(d.org_id ? { orgId: d.org_id } : {}),
    ...(d.space_id ? { spaceId: d.space_id } : {}),
    ...(d.redeem_url ? { redeemUrl: d.redeem_url } : {}),
  };
}

/** An integration token for a Sign in with Atlas user (see {@link getAtlasIdIntegrationToken}). */
export interface AtlasIdIntegrationToken extends IntegrationToken {
  /** The Sign in with Atlas issuer: the token's `iss`. */
  issuer: string;
  /** Where the receiving service fetches the keys to verify it. */
  jwksUri: string;
}

/**
 * Makes a DPoP proof (RFC 9449) for one request, with the key the Sign in with
 * Atlas access token is bound to: a compact JWS with `htm`, `htu`, `iat`, `jti`
 * and `ath` (base64url SHA-256 of `accessToken`).
 */
export type DpopProofSigner = (input: { htm: 'POST'; htu: string; accessToken: string }) => Promise<string> | string;

/**
 * `getToken({ for, atlasIdAccessToken })` in browser code: an integration token
 * for a user who signed in with Sign in with Atlas (not a session of this
 * instance), for an app with no server of its own. The user's Sign in with
 * Atlas access token is sent as `Authorization: Bearer`, or — with `dpop` — as
 * `DPoP` with a proof for this request (required when the token is DPoP-bound).
 * The call must come from a web origin of the Sign in with Atlas app the token
 * was issued to, and sends no cookies. Null when the integration is not enabled
 * for Sign in with Atlas users, the token is not accepted, or the origin is not
 * the app's.
 */
export async function getAtlasIdIntegrationToken(
  client: FapiClient,
  integration: string,
  accessToken: string,
  options: { dpop?: DpopProofSigner } & IntegrationAudienceOptions = {},
): Promise<AtlasIdIntegrationToken | null> {
  if (!accessToken) return null;
  const path = `/v1/client/integrations/${encodeURIComponent(integration)}/atlas_id_tokens`;
  const headers: Record<string, string> = {};
  if (options.dpop) {
    headers.authorization = `DPoP ${accessToken}`;
    headers.dpop = await options.dpop({ htm: 'POST', htu: client.urlFor(path), accessToken });
  } else {
    headers.authorization = `Bearer ${accessToken}`;
  }
  // The publishable key also rides in the query, so the CORS preflight (which
  // carries no custom headers) can name the instance.
  const response = await client.request<{
    jwt: string;
    expires_in: number;
    integration: string;
    audience: string;
    issuer: string;
    jwks_uri: string;
  }>(`${path}?publishable_key=${encodeURIComponent(client.publishableKey)}${integrationAudienceQuery(options).replace(/^\?/, '&')}`, {
    method: 'POST',
    credentials: 'omit',
    headers,
  });
  if (!response.ok || !response.data?.jwt) return null;
  const d = response.data;
  return {
    jwt: d.jwt,
    expiresIn: d.expires_in,
    integration: d.integration,
    audience: d.audience,
    issuer: d.issuer,
    jwksUri: d.jwks_uri,
  };
}

/**
 * The signed-in user's Forumulate reader token for a connected space, and where
 * the reader's browser redeems it. Null without a session or a connection.
 *
 * @deprecated Use {@link getIntegrationToken} with `'forumulate'` (the server
 * keeps this route until 2027-10-23).
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
  /** Cross-device link: the code to show on this device; the device that opens the link shows the same one. */
  matchCode?: string | null;
  /**
   * After a sign-in completed here: true when this browser now holds the
   * session, false when it didn't keep it (its cookie was blocked). Unset while
   * unknown, and for a sign-in completed on another device.
   */
  sessionKept?: boolean;
  /**
   * The one-time recovery codes a mid-sign-in MFA enrolment came with
   * (`attempt_mfa_enrollment`'s `backup_codes`). Kept here, in memory only and
   * never in `attempt` or any storage, until the user says they saved them
   * (`pendingRecoveryCodes` / `acknowledgeRecoveryCodes`): the prebuilt
   * components show them before exchanging the ticket.
   */
  recoveryCodes?: string[] | null;
  /**
   * The one-time token for accepting policies while the attempt is
   * `needs_policy_acceptance` (from the response, or a redirect's
   * `__atlas_policy_token`). Sent by `acceptAttemptPolicies`.
   */
  policyToken?: string | null;
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
      // Duo has no code to type: the client polls once the user has been sent to Duo (`prepareDuo`).
      if (values.strategy === 'duo') {
        return {
          path: `/v1/client/sign_ins/${id}/attempt_second_factor`,
          body: { strategy: 'duo', ...(values.remember_device === 'true' ? { remember_device: true } : {}) },
        };
      }
      // Only ever the code (+ the §5.3 "remember this device" opt-in). Sending
      // `password` here would be posting a credential to an endpoint that has no
      // business seeing one.
      return {
        path: `/v1/client/sign_ins/${id}/attempt_second_factor`,
        body: {
          code: values.code ?? '',
          // EXT-04: `strategy: 'custom_challenge'` accepts only the application's own verdict.
          ...(values.strategy === 'custom_challenge' ? { strategy: 'custom_challenge' } : {}),
          ...(values.remember_device === 'true' ? { remember_device: true } : {}),
        },
      };

    /**
     * §11.1 MFA policy `required`. Two consecutive codes, and the factor id
     * from the prepare step — a different endpoint from the second factor,
     * because there is no factor to verify against yet.
     */
    case 'enroll_second_factor':
      // A texted factor (`enrollStrategy: 'phone_code'`, see mfa-enrollment.ts)
      // is proven by the one code sent to the phone.
      if (values.enrollStrategy === 'phone_code') {
        return {
          path: `/v1/client/sign_ins/${id}/attempt_mfa_enrollment`,
          body: { factor_id: values.factorId ?? '', code: values.code ?? '' },
        };
      }
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

    /**
     * A required policy changed since this user last accepted (or a sign-up is
     * held for one). `values.policy_acceptances` is the JSON `policy_acceptances`
     * body (see `PolicyAcceptanceController.build`); the proof is the held
     * attempt's one-time token (`values.policy_acceptance_token`, which
     * `advance` fills from `FlowState.policyToken`), else the poll secret.
     * `acceptAttemptPolicies` is the typed equivalent.
     */
    case 'accept_policies':
      return {
        path: `/v1/client/sign_ins/${id}/accept_policies`,
        body: acceptPoliciesBody(
          { policyToken: values.policy_acceptance_token, attempt, pollSecret: values.poll_secret },
          parsePolicyAcceptances(values.policy_acceptances),
        ),
      };

    /**
     * The user owes a required action. `values.action` names which (default: the
     * first one owed); the rest of `values` is what that action needs
     * (`password`, `first_name` / `last_name`, `step` + `code`). The proof is the
     * held attempt's one-time token (`required_action_token`, which `advance`
     * fills from `FlowState.policyToken`), else the poll secret.
     */
    case 'complete_required_action': {
      const owed = attempt?.pending_required_actions?.[0]?.action;
      const body: Record<string, unknown> = { action: values.action ?? owed ?? '' };
      for (const k of ['password', 'first_name', 'last_name', 'username', 'step', 'code', 'redirect_url', 'required_action_token', 'poll_secret']) {
        if (values[k] !== undefined) body[k] = values[k];
      }
      // complete_profile (progressive profiling): `field:<key>` values travel as `fields`.
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) if (k.startsWith('field:')) fields[k.slice(6)] = v;
      if (Object.keys(fields).length > 0) body.fields = fields;
      if (values.skip === 'true') body.skip = true;
      return { path: `/v1/client/sign_ins/${id}/required_actions`, body };
    }

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
export function flowFromPending(
  pending: { id: string; status: string; policyToken?: string } | null,
): FlowState {
  if (!pending) return initialFlow;
  return {
    ...initialFlow,
    attempt: { id: pending.id, status: pending.status },
    ...(pending.policyToken ? { policyToken: pending.policyToken } : {}),
  };
}

/** Advance the flow by one step. Never decides the next status itself. */
export async function advance(
  client: FapiClient,
  state: FlowState,
  values: Record<string, string>,
): Promise<FlowState> {
  // A held attempt proves itself with its token, or — a magic-link / QR tab — the poll secret.
  const heldKind = state.attempt ? nextStep(state.attempt).kind : null;
  const held = heldKind === 'accept_policies' || heldKind === 'complete_required_action';
  const proofs: Record<string, string> = {};
  if (heldKind === 'accept_policies' && state.policyToken && values.policy_acceptance_token === undefined) proofs.policy_acceptance_token = state.policyToken;
  if (heldKind === 'complete_required_action' && state.policyToken && values.required_action_token === undefined) proofs.required_action_token = state.policyToken;
  if (held && state.pollSecret && values.poll_secret === undefined) proofs.poll_secret = state.pollSecret;
  const request = requestForStep(state.attempt, { ...values, ...proofs });
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

  // An enrolment's recovery codes are shown once and never kept on the attempt.
  const { backup_codes: backupCodes, ...view } = response.data as AttemptView & { ticket?: string; backup_codes?: unknown };
  const recoveryCodes = recoveryCodesFrom(backupCodes);
  const sameAttempt = view.id === state.attempt?.id && view.status === state.attempt?.status;
  return {
    attempt: view,
    errors: [],
    busy: false,
    pollSecret: state.pollSecret,
    // A completion response carries the ticket to exchange for cookies.
    ticket: view.ticket ?? null,
    prepared: sameAttempt ? (state.prepared ?? null) : null,
    ...(recoveryCodes ? { recoveryCodes } : {}),
    ...(view.policy_acceptance_token || view.required_action_token
      ? { policyToken: view.policy_acceptance_token ?? view.required_action_token }
      : // A held attempt that is still the same one keeps its one-time proof (an identity check calls it repeatedly).
        sameAttempt && state.policyToken && view.status === 'needs_required_action'
        ? { policyToken: state.policyToken }
        : {}),
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
    /** The username to claim, when the instance offers usernames. */
    username?: string;
    /** Policy acceptance: one per policy the user accepted (see `buildPolicyAcceptances`). */
    policyAcceptances?: PolicyAcceptance[];
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
    ...(input.username ? { username: input.username } : {}),
    ...(input.policyAcceptances && input.policyAcceptances.length > 0 ? { policy_acceptances: input.policyAcceptances } : {}),
  });

  if (!response.ok || !response.data) {
    return { ...initialFlow, busy: false, errors: response.errors };
  }

  return {
    attempt: response.data,
    errors: [],
    busy: false,
    // Link mode: the sign-up's verification link may be opened anywhere; this
    // tab collects the session by polling with the secret the create returned.
    pollSecret: (response.data as { poll_secret?: string }).poll_secret ?? initialFlow.pollSecret,
    ticket: response.data.ticket ?? null,
    ...(response.data.policy_acceptance_token || response.data.required_action_token ? { policyToken: response.data.policy_acceptance_token ?? response.data.required_action_token } : {}),
  };
}

/**
 * Resend a sign-up's emailed proof (a code, a link, or both — whatever the
 * instance sends): `POST /v1/client/sign_ups/:id/prepare_verification`. The
 * earlier code / link stops working. A refusal (a 429 with `retry_after`)
 * comes back as `errors` with the attempt kept.
 */
export async function resendSignUpVerification(client: FapiClient, state: FlowState): Promise<FlowState> {
  const id = state.attempt?.id;
  if (!id) return state;
  const response = await client.post(`/v1/client/sign_ups/${id}/prepare_verification`, {});
  return response.ok ? { ...state, busy: false, errors: [] } : { ...state, busy: false, errors: response.errors };
}

/**
 * Whether a sign-up attempt is waiting on an emailed LINK only (no code to
 * type): the form says "check your email" and the tab polls. `emailVerification`
 * is the instance's `account.emailVerification`.
 */
export function awaitingSignUpLink(attempt: AttemptView | null | undefined, emailVerification: string | null | undefined): boolean {
  return (
    !!attempt &&
    attempt.object === 'sign_up_attempt' &&
    attempt.status === 'needs_email_verification' &&
    emailVerification === 'link'
  );
}

/** §5.3: ask the server to send a code or a magic link. */
export async function prepareFactor(
  client: FapiClient,
  state: FlowState,
  strategy: 'email_code' | 'email_link',
  opts: { crossDevice?: boolean } = {},
): Promise<FlowState> {
  const id = state.attempt?.id;
  if (!id) return state;

  const response = await client.post<{ poll_secret?: string; match_code?: string }>(
    `/v1/client/sign_ins/${id}/prepare_first_factor`,
    { strategy, ...(opts.crossDevice && strategy === 'email_link' ? { cross_device: true } : {}) },
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
    matchCode: response.data?.match_code ?? null,
  };
}

/** What the page the cross-device link opens needs: whether to ask for confirmation, and the code to compare. */
export interface CrossDeviceLinkPreview {
  requiresConfirmation: boolean;
  matchCode: string | null;
}

/**
 * Cross-device magic link, second device: read the code from the opened link (`?attempt=&token=&cross_device=1`)
 * so the page can show it next to the prompt "does this match the code on your other device?". Completes nothing.
 */
export async function previewCrossDeviceLink(client: FapiClient, link: { attempt: string; token: string }): Promise<CrossDeviceLinkPreview | null> {
  const response = await client.get<{ requires_confirmation?: boolean; match_code?: string }>(
    `/v1/client/sign_ins/verify?attempt=${encodeURIComponent(link.attempt)}&token=${encodeURIComponent(link.token)}&cross_device=1`,
  );
  if (!response.ok || !response.data) return null;
  return { requiresConfirmation: response.data.requires_confirmation === true, matchCode: response.data.match_code ?? null };
}

/**
 * Cross-device magic link, second device: confirm with the code both devices show. The first device's
 * `pollAttempt` then returns the ticket. One use; a wrong code invalidates the link.
 */
export async function confirmCrossDeviceLink(client: FapiClient, link: { attempt: string; token: string; matchCode: string }): Promise<boolean> {
  const response = await client.post('/v1/client/sign_ins/verify/confirm', { attempt: link.attempt, token: link.token, match_code: link.matchCode });
  return response.ok;
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

  // A sign-up waiting on its emailed verification link polls its own route.
  const resource = state.attempt?.object === 'sign_up_attempt' ? 'sign_ups' : 'sign_ins';
  const response = await client.get<AttemptView & { ticket?: string }>(
    `/v1/client/${resource}/${id}?poll_secret=${encodeURIComponent(state.pollSecret)}`,
  );

  if (!response.ok || !response.data) return { state, ticket: null };

  return {
    state: { ...state, attempt: response.data },
    ticket: response.data.ticket ?? null,
  };
}

/** Whether polling should continue, so a tab does not poll a dead attempt forever. */
export function shouldKeepPolling(state: FlowState): boolean {
  if (!state.pollSecret || !state.attempt || isTerminal(state.attempt)) return false;
  // A passkey-only sign-up waiting for its passkey: only this tab can move it on.
  const a = state.attempt;
  const waitingForPasskey =
    a.object === 'sign_up_attempt' && a.status === 'needs_first_factor' && (a.supported_first_factors ?? []).includes('passkey');
  return !waitingForPasskey;
}

/**
 * Finish a required action the sign-in is held on (`needs_required_action`):
 * `update_password` takes `password`; `update_profile` takes `first_name` /
 * `last_name`; `verify_email` takes `step: 'send'` (mails a code), then
 * `step: 'verify'` with `code`. Uses the flow's one-time token (or poll secret).
 * Returns the next flow state: `complete` with a `ticket`, still held on
 * another action, or the next step the server demands.
 */
export function completeRequiredAction(
  client: FapiClient,
  state: FlowState,
  input: {
    action?: string;
    password?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
    step?: 'send' | 'verify';
    code?: string;
    /** `complete_profile`: values by field key. */
    fields?: Record<string, string>;
    /** `complete_profile`: ask again later (optional fields only). */
    skip?: boolean;
  },
): Promise<FlowState> {
  const values: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) if (typeof v === 'string') values[k] = v;
  for (const [k, v] of Object.entries(input.fields ?? {})) values[`field:${k}`] = v;
  if (input.skip) values.skip = 'true';
  return advance(client, state, values);
}
