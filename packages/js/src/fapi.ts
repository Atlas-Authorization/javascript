import { fieldErrors, isTerminal, nextStep, type AttemptView, type FieldError } from './attempt';

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
}

export interface FapiResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
  errors: FieldError[];
}

export class FapiClient {
  constructor(private readonly options: FapiClientOptions) {}

  async request<T>(path: string, init: RequestInit = {}): Promise<FapiResponse<T>> {
    const doFetch = this.options.fetchImpl ?? fetch;

    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl ?? ''}${path}`, {
        ...init,
        // Cookies carry the session. A request without this is indistinguishable
        // from being signed out, which is a maddening bug to chase.
        credentials: 'include',
        headers: {
          'x-publishable-key': this.options.publishableKey,
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
        errors: [{ code: 'NETWORK', message: 'We could not reach the server.' }],
      };
    }

    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // A 204, or an error page from a proxy. Neither should crash the parse.
    }

    return {
      ok: response.ok,
      status: response.status,
      data: response.ok ? (body as T) : null,
      // §9.1 messages are written for humans and surfaced verbatim.
      errors: response.ok ? [] : fieldErrors(body),
    };
  }

  post<T>(path: string, body?: unknown) {
    return this.request<T>(path, {
      method: 'POST',
      body: body === undefined ? undefined : JSON.stringify(body),
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
}

export const initialFlow: FlowState = {
  attempt: null,
  errors: [],
  busy: false,
  pollSecret: null,
  ticket: null,
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
  const id = (attempt as { id?: string }).id ?? '';

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
    attempt: { id: pending.id, status: pending.status } as AttemptView,
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

  return {
    attempt: response.data,
    errors: [],
    busy: false,
    pollSecret: state.pollSecret,
    // A completion response carries the ticket to exchange for cookies.
    ticket: response.data.ticket ?? null,
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
  const id = (state.attempt as { id?: string } | null)?.id;
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
    // by a link opened on another device.
    pollSecret: response.data?.poll_secret ?? null,
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
  const id = (state.attempt as { id?: string } | null)?.id;
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
