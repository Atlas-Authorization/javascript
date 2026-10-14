import {
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
  type FapiClient,
  type FlowCaptcha,
  type FlowState,
  type ProviderToken,
} from '@atlasauth/js';
import {
  createNativeClient,
  exchangeTicketForToken,
  fetchCurrentUser,
  startOAuthSignIn,
} from './fapi';
import { createInMemoryStorage, type TokenStorage } from './storage';
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
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
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

  constructor(config: AtlasStoreConfig) {
    this.storage = config.storage ?? createInMemoryStorage();
    this.getCaptchaToken = config.getCaptchaToken;
    const fetchImpl = config.fetchImpl ?? fetch;
    this.client = createNativeClient({
      publishableKey: config.publishableKey,
      frontendApi: resolveFrontendApi(config.frontendApi, {
        component: '<AtlasProvider> / createAtlasStore()',
        allowSameOrigin: false,
      }),
      fetchImpl,
      getToken: () => this.storage.getToken(),
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
    const token = await this.storage.getToken();
    if (!token) {
      this.signedOut();
      return;
    }
    this.setState({ status: 'signed_in', claims: decodeClaims(token) });
    const { user, session } = await fetchCurrentUser(this.client);
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

  signOut = async (): Promise<void> => {
    await this.storage.clearToken();
    this.signedOut();
  };

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
