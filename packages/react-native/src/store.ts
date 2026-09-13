import {
  advance,
  getProviderToken as fetchProviderToken,
  initialFlow,
  readRedirectResult,
  type FapiClient,
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
  /** The instance's FAPI origin. */
  frontendApi?: string;
  /** Where the session token lives. Defaults to non-persistent in-memory. */
  storage?: TokenStorage;
  /** Injectable for tests; defaults to the platform `fetch`. */
  fetchImpl?: typeof fetch;
}

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

  constructor(config: AtlasStoreConfig) {
    this.storage = config.storage ?? createInMemoryStorage();
    const fetchImpl = config.fetchImpl ?? fetch;
    this.client = createNativeClient({
      publishableKey: config.publishableKey,
      frontendApi: config.frontendApi ?? '',
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
  }): Promise<FlowResult> => {
    const values = { identifier: input.identifier, password: input.password };

    let flow = await advance(this.client, initialFlow, values);
    if (flow.errors.length) return { status: 'error', errors: flow.errors };

    flow = await advance(this.client, flow, values);
    return this.completeFlow(flow);
  };

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
   * Create an account with an email + password. If the instance completes
   * sign-up immediately, the token is persisted; otherwise it returns
   * `needs_more` (typically an email code) — pass the code to `verifyEmailCode`.
   */
  signUpWithPassword = async (input: {
    emailAddress: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }): Promise<FlowResult> => {
    const response = await this.client.post<{
      id?: string;
      status?: string;
      ticket?: string;
    }>('/v1/client/sign_ups', {
      email_address: input.emailAddress,
      password: input.password,
      ...(input.firstName ? { first_name: input.firstName } : {}),
      ...(input.lastName ? { last_name: input.lastName } : {}),
    });

    if (!response.ok || !response.data) return { status: 'error', errors: response.errors };

    if (response.data.ticket) {
      await this.setSessionToken(response.data.ticket);
      return { status: 'complete', errors: [] };
    }
    return {
      status: 'needs_more',
      attemptStatus: response.data.status,
      attemptId: response.data.id,
      errors: [],
    };
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
