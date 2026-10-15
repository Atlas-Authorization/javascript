import {
  EMAIL_DELIVERY_UNKNOWN,
  SignOutGuard,
  advance,
  fetchInstanceSettings,
  getProviderToken as fetchProviderToken,
  initialFlow,
  isCaptchaError,
  nextStep,
  readRedirectResult,
  resolveFrontendApi,
  startSignUp,
  type CaptchaFlowKey,
  type EmailDelivery,
  type FapiClient,
  type FapiRequest,
  type FlowCaptcha,
  type FlowState,
  type InstanceSettings,
  type ProviderToken,
  type SignOutOptions,
  type SignOutResult,
  type TombstoneStore,
} from '@atlasauth/js';
import {
  bearerFetch,
  createNativeClient,
  exchangeTicketForToken,
  fetchCurrentUser,
  startOAuthSignIn,
} from './fapi';
import { createInMemoryStorage, createInMemoryTombstoneStore, type TokenStorage } from './storage';
import {
  decodeClaims,
  type AtlasSession,
  type AtlasUser,
  type AuthStatus,
  type FlowResult,
  type SessionClaims,
} from './types';

/**
 * The whole SDK, minus React. Every hook is a thin binding over this store; the
 * store owns the state machine, the storage adapter, and the `@atlasauth/js` calls.
 * Keeping it framework-free is what lets the tests exercise the real behaviour —
 * sign-in persisting a token, sign-out clearing it — with no renderer, no DOM,
 * and no React at all.
 */

export interface AtlasStoreState {
  status: AuthStatus;
  user: AtlasUser | null;
  session: AtlasSession | null;
  claims: SessionClaims | null;
}

export interface AtlasStoreConfig {
  publishableKey: string;
  /**
   * The instance's Frontend API as an absolute URL, e.g.
   * `"https://auth.example.com"`. Required at runtime — a missing or malformed
   * value throws an `AtlasConfigError` (`FRONTEND_API_REQUIRED` /
   * `FRONTEND_API_INVALID`). A native app has no origin of its own, so
   * `"same-origin"` / a bare path is refused too. Optional in the type only so
   * existing call sites keep compiling.
   */
  frontendApi?: string;
  /** Where the session token lives. Defaults to non-persistent in-memory. */
  storage?: TokenStorage;
  /**
   * Where the ids of sessions this app signed out of are remembered, so a
   * session whose revoke never reached the server (offline, a 5xx) is not
   * re-adopted from a token the sign-out could not clear. Defaults to
   * process memory, which does not survive a restart — pass an AsyncStorage /
   * `expo-secure-store` adapter (see `createInMemoryTombstoneStore`) to keep
   * them across launches. Holds session ids only, never a token.
   */
  tombstoneStore?: TombstoneStore;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
  /**
   * Delays (ms) between background re-tries of a revoke `signOut()` could not
   * complete. Default `[15_000, 60_000, 300_000]`; `[]` re-tries only on a
   * later `bootstrap()`.
   */
  signOutRetryDelaysMs?: number[];
  /**
   * §5 supply a captcha token when the instance requires one. Captcha providers
   * draw their challenge in a browser, so this SDK renders none itself: render
   * the provider's widget your own way (its React Native SDK, or a WebView
   * loading the provider script with `captcha.siteKey`) and resolve the solved
   * token, or null to give up. Called only when a token is needed — the
   * sign-up / sign-in was refused with `CAPTCHA_REQUIRED` / `CAPTCHA_FAILED`, or
   * the server answered with a `needs_captcha` challenge — and the request is
   * then retried once with it. A `captchaToken` passed to the call itself is
   * used first. Without either, the call returns the `CAPTCHA_REQUIRED` error.
   */
  getCaptchaToken?: (request: CaptchaTokenRequest) => Promise<string | null>;
}

/** What {@link AtlasStoreConfig.getCaptchaToken} is asked for. */
export interface CaptchaTokenRequest {
  /** Which flow needs the token. */
  flow: Extract<CaptchaFlowKey, 'signUp' | 'signIn'>;
  /**
   * The instance's public captcha settings for that flow (provider, site key,
   * widget mode) from `GET /v1/appearance`; null if they could not be read.
   */
  captcha: FlowCaptcha | null;
}

/** The end-user message for a captcha that has to be completed first. */
const CAPTCHA_REQUIRED_MESSAGE = 'Please complete the security check, then try again.';

const attemptId = (flow: FlowState): string =>
  (flow.attempt as { id?: string } | null)?.id ?? '';

export class AtlasStore {
  private state: AtlasStoreState = {
    status: 'loading',
    user: null,
    session: null,
    claims: null,
  };

  private readonly listeners = new Set<() => void>();
  private readonly storage: TokenStorage;
  private readonly client: FapiClient;
  private readonly getCaptchaToken?: AtlasStoreConfig['getCaptchaToken'];
  /** Tombstones + revoke (with background re-try) for `signOut()` and `bootstrap()`. */
  private readonly guard: SignOutGuard;
  /** A raw FAPI request authenticated with `token` (not the stored one). */
  private readonly requestWith: (token: string | null) => FapiRequest;

  constructor(config: AtlasStoreConfig) {
    this.storage = config.storage ?? createInMemoryStorage();
    this.getCaptchaToken = config.getCaptchaToken;
    const fetchImpl = config.fetchImpl ?? fetch;
    const frontendApi = resolveFrontendApi(config.frontendApi, {
      component: '<AtlasProvider> / createAtlasStore()',
      allowSameOrigin: false,
    });
    this.client = createNativeClient({
      publishableKey: config.publishableKey,
      frontendApi,
      fetchImpl,
      getToken: () => this.storage.getToken(),
    });
    // The revoke is bound to the token being dropped, not read from storage at
    // call time: sign-out clears storage, and the background re-try of a failed
    // revoke must still be able to authenticate as the session it is ending.
    this.requestWith = (token) => (path, init = {}) => {
      const headers = new Headers(init.headers);
      headers.set('x-publishable-key', config.publishableKey);
      return bearerFetch(fetchImpl, () => token)(`${frontendApi}${path}`, { ...init, headers });
    };
    this.guard = new SignOutGuard({
      request: (path, init) =>
        Promise.resolve(this.storage.getToken()).then((token) => this.requestWith(token)(path, init)),
      frontendApi,
      store: config.tombstoneStore ?? createInMemoryTombstoneStore(),
      // No DOM: front-channel logout iframes cannot run here.
      frontChannelLogout: false,
      ...(config.signOutRetryDelaysMs ? { retryDelaysMs: config.signOutRetryDelaysMs } : {}),
    });
  }

  // ── external-store plumbing (for React's useSyncExternalStore) ────────────

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AtlasStoreState => this.state;

  private setState(next: Partial<AtlasStoreState>): void {
    this.state = { ...this.state, ...next };
    for (const listener of this.listeners) listener();
  }

  private async setSessionToken(jwt: string): Promise<void> {
    // A session this app signed out of is never adopted again.
    if (this.guard.isSignedOut(decodeClaims(jwt)?.sid)) return;
    await this.storage.setToken(jwt);
    this.setState({ status: 'signed_in', claims: decodeClaims(jwt) });
    // Fill in user/session; a failure here does not undo the sign-in — the token
    // is valid, the profile fetch can be retried.
    const { user, session } = await fetchCurrentUser(this.client);
    if (user) this.setState({ user, session });
  }

  private signedOut(): void {
    this.setState({ status: 'signed_out', user: null, session: null, claims: null });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Boot from whatever the storage adapter holds. Call once on mount. */
  bootstrap = async (): Promise<void> => {
    // Persisted tombstones first: a cold start must not re-adopt a session the
    // app signed out of while its revoke never reached the server.
    await this.guard.ready;
    const token = await this.storage.getToken();
    if (!token) {
      this.signedOut();
      return;
    }
    const claims = decodeClaims(token);
    if (this.refuse(claims?.sid, token)) return this.dropRefused();
    this.setState({ status: 'signed_in', claims });
    const { user, session } = await fetchCurrentUser(this.client);
    // The claims may lack `sid`; the session the server reports is checked too.
    if (session && this.refuse(session.id, token)) return this.dropRefused();
    if (user) {
      this.setState({ user, session });
    } else {
      // The token the adapter held is no longer accepted — clear it so the app
      // shows a sign-in screen instead of a broken signed-in one.
      await this.storage.clearToken();
      this.signedOut();
    }
  };

  // ── auth surface (bound as fields so hooks can pass them straight through) ─

  getToken = (): Promise<string | null> => Promise.resolve(this.storage.getToken());

  getProviderToken = (provider: string): Promise<ProviderToken | null> =>
    fetchProviderToken(this.client, provider);

  /**
   * Sign out: revoke the session on the Frontend API (retried once), drop the
   * stored token, and reset to signed-out. Resolves `{ revoked }` — `false`
   * when the server could not be reached or refused, in which case the session
   * id is remembered (see {@link AtlasStoreConfig.tombstoneStore}) so it is
   * never re-adopted, and the revoke is re-tried in the background with the
   * dropped token. With `{ strict: true }` an unconfirmed revoke rejects with a
   * `SignOutError` instead — after the local sign-out.
   *
   * `activeSessionId` is reported when the server names a promoted session, but
   * it is not adopted: promotion swaps browser session cookies, and a bearer
   * client receives no token for the promoted session (the Frontend API does not
   * promote on a bearer revoke today). Sign in again to use it.
   */
  signOut = async (options: SignOutOptions = {}): Promise<SignOutResult> => {
    let token: string | null = null;
    try {
      token = await this.storage.getToken();
    } catch {
      token = null;
    }
    const sessionId = (token ? decodeClaims(token)?.sid : null) ?? this.state.session?.id ?? null;
    const attempt = await this.guard.revoke(sessionId, { ...options, request: this.requestWith(token) });
    try {
      await this.storage.clearToken();
    } catch {
      // The tombstone still keeps the next bootstrap from re-adopting it.
    }
    this.signedOut();
    return this.guard.settle(attempt, options);
  };

  /** Cancel scheduled background revoke re-tries (provider unmount). */
  dispose = (): void => {
    this.guard.dispose();
  };

  /**
   * The instance's public sign-in / sign-up settings (`GET /v1/appearance`),
   * or null when they could not be read — for an app drawing its own forms.
   */
  getInstanceSettings = (): Promise<InstanceSettings | null> => fetchInstanceSettings(this.client);

  /**
   * Whether the app can deliver email (`InstanceSettings.emailDelivery`): hide
   * "Forgot password?" when `passwordReset` is false, show a "can't send email"
   * state (`EMAIL_UNAVAILABLE_MESSAGE`) instead of email + password sign-up when
   * `passwordSignUp` is false, and filter sign-in strategies with
   * `offeredFirstFactors()`. Everything reads as available when the settings
   * cannot be read — the server still refuses what it cannot deliver.
   */
  getEmailDelivery = async (): Promise<EmailDelivery> =>
    (await this.getInstanceSettings())?.emailDelivery ?? { ...EMAIL_DELIVERY_UNKNOWN };

  /** Whether `sessionId` was signed out of here; re-tries its revoke in the background. */
  private refuse(sessionId: string | null | undefined, token: string): boolean {
    return this.guard.refuse(sessionId, this.requestWith(token));
  }

  /** Boot found a signed-out session's token: drop it and stay signed out. */
  private async dropRefused(): Promise<void> {
    try {
      await this.storage.clearToken();
    } catch {
      // The tombstone keeps refusing it.
    }
    this.signedOut();
  }

  // ── sign-in ────────────────────────────────────────────────────────────────

  /**
   * Password sign-in. Drives the `@atlasauth/js` flow — identifier, then the
   * password first factor — and, on completion, exchanges the ticket for a token
   * and persists it. If the server owes a further step (2FA), returns
   * `needs_more` with the attempt so the app can prompt for it.
   */
  signInWithPassword = async (input: {
    identifier: string;
    password: string;
    /** §5 a solved captcha token, when the instance always requires one on sign-in. */
    captchaToken?: string;
  }): Promise<FlowResult> => {
    const values: Record<string, string> = { identifier: input.identifier, password: input.password };
    if (input.captchaToken) values.captcha_token = input.captchaToken;

    let flow = await advance(this.client, initialFlow, values);
    if (flow.errors.length) return { status: 'error', errors: flow.errors };

    // §5 the server withheld the attempt until a captcha clears (an always-on
    // sign-in gate, or a risk-triggered challenge): get a token from the app and
    // re-issue the identifier with it.
    if (flow.attempt && nextStep(flow.attempt).kind === 'collect_captcha') {
      const token = await this.captchaTokenFor('signIn');
      if (!token) return captchaRequired();
      flow = await advance(this.client, flow, { identifier: input.identifier, captcha_token: token });
      if (flow.errors.length) return { status: 'error', errors: flow.errors };
      // A rejected token comes back as the same challenge.
      if (flow.attempt && nextStep(flow.attempt).kind === 'collect_captcha') {
        return { status: 'error', errors: [{ code: 'CAPTCHA_FAILED', message: CAPTCHA_REQUIRED_MESSAGE }] };
      }
    }

    flow = await advance(this.client, flow, values);
    return this.completeFlow(flow);
  };

  /** Ask the app for a captcha token (see {@link AtlasStoreConfig.getCaptchaToken}). */
  private async captchaTokenFor(flow: CaptchaTokenRequest['flow']): Promise<string | null> {
    if (!this.getCaptchaToken) return null;
    const settings = await fetchInstanceSettings(this.client);
    try {
      return (await this.getCaptchaToken({ flow, captcha: settings?.captchaFlows[flow] ?? null })) || null;
    } catch {
      return null;
    }
  }

  /** Submit a second-factor / MFA code against a pending sign-in attempt. */
  attemptSecondFactor = async (input: {
    attemptId: string;
    status: string;
    code: string;
  }): Promise<FlowResult> => {
    const seeded: FlowState = {
      ...initialFlow,
      attempt: { id: input.attemptId, status: input.status } as FlowState['attempt'],
    };
    const flow = await advance(this.client, seeded, { code: input.code });
    return this.completeFlow(flow);
  };

  // ── OAuth ──────────────────────────────────────────────────────────────────

  /**
   * Begin OAuth. Returns the authorization URL for the app to open with
   * `expo-auth-session` / `Linking`. When the provider redirects back to the
   * app's deep link, hand the callback URL to `completeOAuthRedirect`.
   */
  startOAuth = (input: {
    provider: string;
    redirectUrl: string;
  }): Promise<{
    authorizationUrl: string | null;
    errors: Array<{ code: string; message: string; param?: string }>;
  }> => startOAuthSignIn(this.client, input);

  /**
   * Finish an OAuth sign-in from the deep-link callback URL. Parses Atlas's
   * redirect params (shared `@atlasauth/js` contract), and — if the sign-in
   * completed — exchanges the ticket for a token and persists it. A callback
   * carrying only a status (a second factor is still owed) returns `needs_more`.
   */
  completeOAuthRedirect = async (callbackUrl: string): Promise<FlowResult> => {
    const search = extractSearch(callbackUrl);
    const result = readRedirectResult(search);
    if (!result) {
      return { status: 'error', errors: [{ code: 'NO_REDIRECT', message: 'No Atlas redirect params found.' }] };
    }
    if (result.ticket) {
      const jwt = await exchangeTicketForToken(this.client, {
        attemptId: result.attemptId,
        ticket: result.ticket,
      });
      if (!jwt) {
        return { status: 'error', errors: [{ code: 'EXCHANGE_FAILED', message: 'Could not complete sign-in.' }] };
      }
      await this.setSessionToken(jwt);
      return { status: 'complete', errors: [] };
    }
    return {
      status: 'needs_more',
      attemptStatus: result.status,
      attemptId: result.attemptId,
      errors: [],
    };
  };

  // ── sign-up ──────────────────────────────────────────────────────────────

  /**
   * Create an account with an email + password (`POST /v1/client/sign_ups`).
   * If the instance completes sign-up immediately, the session ticket is
   * exchanged for a token and persisted; otherwise it returns `needs_more`
   * (typically an email code) — pass the code to `verifyEmailCode`.
   *
   * `fields` carries the instance's configured sign-up fields by key
   * (`firstName` / `lastName` are shorthands for the `first_name` / `last_name`
   * fields); `consent` is the legal-consent tick when the instance requires
   * agreement. When the instance requires a captcha on sign-up, pass
   * `captchaToken`, or give the provider a `getCaptchaToken` callback.
   */
  signUpWithPassword = async (input: {
    emailAddress: string;
    password: string;
    firstName?: string;
    lastName?: string;
    fields?: Record<string, string>;
    consent?: boolean;
    captchaToken?: string;
  }): Promise<FlowResult> => {
    const fields: Record<string, string> = { ...input.fields };
    if (input.firstName) fields.first_name = input.firstName;
    if (input.lastName) fields.last_name = input.lastName;
    const create = (captchaToken?: string) =>
      startSignUp(this.client, {
        email: input.emailAddress,
        password: input.password,
        fields,
        ...(input.consent ? { consent: true } : {}),
        ...(captchaToken ? { captchaToken } : {}),
      });

    let flow = await create(input.captchaToken);
    // §5 the instance requires a captcha on sign-up: get a token from the app
    // and retry once. Nothing was created by the refused request.
    if (flow.errors.some(isCaptchaError)) {
      const token = await this.captchaTokenFor('signUp');
      if (!token) return captchaRequired(flow.errors);
      flow = await create(token);
    }
    return this.completeFlow(flow);
  };

  /** Verify a sign-up email code and, on completion, persist the token. */
  verifyEmailCode = async (input: { attemptId: string; code: string }): Promise<FlowResult> => {
    const seeded: FlowState = {
      ...initialFlow,
      attempt: {
        id: input.attemptId,
        status: 'needs_email_verification',
      } as FlowState['attempt'],
    };
    const flow = await advance(this.client, seeded, { code: input.code });
    return this.completeFlow(flow);
  };

  // ── shared completion ──────────────────────────────────────────────────────

  private async completeFlow(flow: FlowState): Promise<FlowResult> {
    if (flow.errors.length) return { status: 'error', errors: flow.errors };
    if (flow.ticket) {
      const jwt = await exchangeTicketForToken(this.client, {
        attemptId: attemptId(flow),
        ticket: flow.ticket,
      });
      if (!jwt) {
        return { status: 'error', errors: [{ code: 'EXCHANGE_FAILED', message: 'Could not complete sign-in.' }] };
      }
      await this.setSessionToken(jwt);
      return { status: 'complete', errors: [] };
    }
    return {
      status: 'needs_more',
      attemptStatus: (flow.attempt as { status?: string } | null)?.status,
      attemptId: attemptId(flow),
      errors: [],
    };
  }
}

/** The `CAPTCHA_REQUIRED` result: the app supplied no captcha token. */
function captchaRequired(errors: FlowResult['errors'] = []): FlowResult {
  const fromServer = errors.find(isCaptchaError);
  return {
    status: 'error',
    errors: [
      {
        code: 'CAPTCHA_REQUIRED',
        message: fromServer?.code === 'CAPTCHA_REQUIRED' ? fromServer.message : CAPTCHA_REQUIRED_MESSAGE,
        ...(fromServer?.param ? { param: fromServer.param } : {}),
      },
    ],
  };
}

export function createAtlasStore(config: AtlasStoreConfig): AtlasStore {
  return new AtlasStore(config);
}

/**
 * Pull the query string out of a deep-link callback URL. `URL` parses custom
 * schemes (`myapp://cb?…`) fine; the fallback covers a bare `?a=b` fragment some
 * linking libraries hand back without a scheme.
 */
function extractSearch(url: string): string {
  try {
    return new URL(url).search;
  } catch {
    const q = url.indexOf('?');
    return q >= 0 ? url.slice(q) : '';
  }
}

// The sign-out and email-delivery types the store's surface uses, so an app
// imports them from this package.
export {
  EMAIL_DELIVERY_UNKNOWN,
  EMAIL_UNAVAILABLE_MESSAGE,
  SignOutError,
  offeredFirstFactors,
  type EmailDelivery,
  type InstanceSettings,
  type SignOutOptions,
  type SignOutResult,
} from '@atlasauth/js';
