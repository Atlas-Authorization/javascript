/**
 * The React glue: one flow context shared by `<SignIn.*>` and `<SignUp.*>`, and
 * the driver hook that runs the Atlas attempt flow headlessly.
 *
 * The driver is the headless twin of `@atlasauth/react`'s internal `useFlow`: it
 * seeds from any mid-flow redirect (`pendingAttempt`), advances the attempt with
 * `@atlasauth/js`'s `advance` / `startSignUp`, and on completion exchanges the
 * one-time ticket for cookies and re-boots the provider — exactly the same
 * completion path `<SignIn>` uses, so a custom UI built from these primitives and
 * the prebuilt component end at the same signed-in state. The difference is that
 * nothing here renders chrome: the primitives do, however the developer composes
 * them.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  FapiClient,
  advanceWithCaptcha,
  beginPasskeySignIn,
  atlasCaptchaLabels,
  createCaptchaController,
  flowNeedsCaptcha,
  isRenderableCaptcha,
  localizeCaptchaErrors,
  localizedErrorMessage,
  signInCaptchaOptions,
  startSignUp,
  advance,
  nextStep,
  prepareFactor,
  PolicyAcceptanceController,
  controllerForPending,
  loadPolicies,
  isPolicyAcceptanceRequired,
  flowFromPending,
  initialFlow,
  getPasskeyAssertion,
  referralChallengeFlows,
  referralChallengeRequired,
  type AttemptView,
  type CaptchaController,
  type CaptchaControllerOptions,
  type EmailDelivery,
  type FieldError,
  type FlowState,
  type PasskeyExtensionResults,
  type PasskeyPrfRequest,
} from '@atlasauth/js';
import { useAtlas, useSignIn } from '@atlasauth/react';
import type { FlowMode } from './machine';

/** Everything a primitive reads from or writes to the running flow. */
export interface FlowContextValue {
  mode: FlowMode;
  attempt: AttemptView | null;
  errors: FieldError[];
  busy: boolean;
  /** The fields collected so far, keyed by `<Field name>`. */
  values: Record<string, string>;
  /** Write one field (what `<Field.Input onChange>` calls). */
  setValue(name: string, value: string): void;
  /** Advance the attempt with the collected values (`<Action name="submit">`). */
  submit(): Promise<void>;
  /** Re-send the current step's code / link (`<Action name="resend">`). */
  resend(): Promise<void>;
  /** Begin a social / OIDC sign-in (`<SignIn.Strategy name="oauth_*">`). */
  startOauth(provider: string): Promise<void>;
  /** Begin a passkey sign-in (`<SignIn.Strategy name="passkey">`). */
  startPasskey(): Promise<void>;
  /**
   * §5 the instance's captcha for this flow (sign-up's create step, sign-in's
   * identifier step / `needs_captcha` challenge), drawn by `<SignIn.Captcha>` /
   * `<SignUp.Captcha>`. Its token is sent as `captcha_token` automatically.
   * Optional so hand-built contexts (tests, custom drivers) stay valid.
   */
  captcha?: CaptchaController;
  /** Whether the current step draws a captcha widget. */
  captchaNeeded?: boolean;
  /**
   * What the app can do given whether it can deliver email
   * (`instanceSettings.emailDelivery`): `<*.Strategy>` hides email code / link
   * and `reset_password` by it, and `<SignUp.EmailUnavailable>` shows when
   * `passwordSignUp` is false. Undefined until the settings load (or in a
   * hand-built context) — everything is then offered, as before.
   */
  emailDelivery?: EmailDelivery;
  /**
   * The instance's policies (terms, privacy, …) for this flow: the sign-up's
   * published policies, or a sign-in's `pending_policies` while it is in
   * `needs_policy_acceptance`. `<*.Policies>` draws them; `submit` sends the
   * acceptances. Empty when the instance has none.
   */
  policies?: PolicyAcceptanceController;
  /** Whether the submit may go (every required checkbox policy is ticked). */
  policiesSatisfied?: boolean;
  /** A scroll-mode dialog is open (set by `submit` when one is still unread). */
  policyReading?: boolean;
  setPolicyReading?(reading: boolean): void;
  /** The title of a policy the user declined, until they try again. */
  policyDeclined?: string | null;
  /** The user declined `title`: cancels a sign-in attempt, or just reports on a sign-up. */
  declinePolicy?(title: string): void;
}

/** `useLayoutEffect` in the browser, `useEffect` during SSR (no warning). */
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const FlowContext = createContext<FlowContextValue | null>(null);

/**
 * Read the running flow. Throws (rather than returning a null-ish default) when a
 * primitive is used outside its `<SignIn.Root>` / `<SignUp.Root>`, because a
 * silently-inert `<Field>` is the kind of bug that eats an afternoon.
 */
export function useFlowContext(expected?: FlowMode): FlowContextValue {
  const value = useContext(FlowContext);
  if (!value) {
    throw new Error(
      'Atlas Elements primitives must be used inside <SignIn.Root> or <SignUp.Root>.',
    );
  }
  if (expected && value.mode !== expected) {
    throw new Error(
      `A <${expected === 'sign-in' ? 'SignIn' : 'SignUp'}.*> primitive was used inside a <${
        value.mode === 'sign-in' ? 'SignIn' : 'SignUp'
      }.Root>.`,
    );
  }
  return value;
}

/**
 * Run one Atlas attempt flow (sign-in or sign-up) and expose it as a
 * {@link FlowContextValue}. All completion handling (ticket exchange + provider
 * re-boot + optional `afterUrl` navigation) lives here, shared across every way a
 * developer composes the primitives.
 */
export function useFlowDriver(
  mode: FlowMode,
  opts: {
    afterUrl?: string;
    passkeyPrf?: PasskeyPrfRequest;
    onPasskeyExtensionResults?: (results: PasskeyExtensionResults) => void;
  } = {},
): FlowContextValue {
  const { publishableKey, frontendApi, reload, pendingAttempt, instanceSettings, catalog, errorCatalog, locale } =
    useAtlas();
  // Reuse the React SDK's imperative OAuth starter (popup/redirect + ticket
  // exchange + re-boot) rather than re-implementing it, so social sign-in behaves
  // identically to the prebuilt `<SignIn>`.
  const { startOauth: startOauthImpl } = useSignIn();

  const client = useMemo(
    () => new FapiClient({ publishableKey, baseUrl: frontendApi, locale }),
    [frontendApi, publishableKey, locale],
  );

  // Seed from a redirect that returned mid-flow (e.g. OAuth owing a second
  // factor), exactly as `<SignIn>` does, so the user resumes at the demanded step.
  const [state, setState] = useState<FlowState>(() =>
    mode === 'sign-in' ? flowFromPending(pendingAttempt) : initialFlow,
  );
  const [values, setValues] = useState<Record<string, string>>({});

  // Policy acceptance: the sign-up's policies, or a sign-in's pending ones.
  const policies = useMemo(() => new PolicyAcceptanceController([]), []);
  const [policyReading, setPolicyReading] = useState(false);
  const [policyDeclined, setPolicyDeclined] = useState<string | null>(null);
  const [policyVersion, bumpPolicies] = useState(0);
  useEffect(() => policies.subscribe(() => bumpPolicies((n) => n + 1)), [policies]);
  const attemptStep = state.attempt ? nextStep(state.attempt).kind : null;
  const pendingPolicyAttempt = attemptStep === 'accept_policies' ? state.attempt : null;
  useEffect(() => {
    let alive = true;
    if (pendingPolicyAttempt) {
      void controllerForPending(client, pendingPolicyAttempt, { locale: locale ?? undefined }).then((c) => {
        if (alive) policies.setPolicies(c.policies);
      });
    } else if (mode === 'sign-up' && !state.attempt) {
      void loadPolicies(client, { locale: locale ?? undefined }).then((list) => {
        if (alive) policies.setPolicies(list);
      });
    }
    return () => {
      alive = false;
    };
  }, [client, locale, mode, policies, pendingPolicyAttempt, state.attempt]);

  // §5 the per-flow captcha, driven by the instance's settings (`/v1/appearance`)
  // so switching it on in the dashboard makes `<*.Captcha>` draw it with no
  // code change. The shared controller from `@atlasauth/js` owns the lifecycle.
  const t = useCallback((key: string) => catalog[key] ?? key, [catalog]);
  const captchaRef = useRef<CaptchaController | null>(null);
  // The Atlas captcha's words follow the current catalog (read when a widget is drawn).
  const tRef = useRef(t);
  tRef.current = t;
  if (!captchaRef.current) {
    captchaRef.current = createCaptchaController(undefined, {
      atlasLabels: () => atlasCaptchaLabels(tRef.current),
    });
  }
  const captcha = captchaRef.current;
  const identifierRef = useRef('');
  const submitRef = useRef<() => Promise<void>>(async () => undefined);
  // Referral attribution: a referred sign-up shows the challenge when the
  // instance asks for it, even with the captcha otherwise off.
  const [referralChallenge, setReferralChallenge] = useState(false);
  const [passkeyChallenge, setPasskeyChallenge] = useState(false);
  useEffect(() => {
    let alive = true;
    void referralChallengeRequired(client).then((on) => {
      if (alive) setReferralChallenge(on);
    });
    return () => {
      alive = false;
    };
  }, [client, instanceSettings]);
  const captchaOptions = useMemo<CaptchaControllerOptions>(() => {
    const flows = instanceSettings
      ? referralChallenge
        ? referralChallengeFlows(instanceSettings.captchaFlows)
        : instanceSettings.captchaFlows
      : undefined;
    if (mode === 'sign-up') {
      const flow = flows?.signUp;
      return { flow, active: !state.attempt && flowNeedsCaptcha(flow) };
    }
    // A passkey begin the server refused pending a captcha (a force-challenge
    // switch): draw the sign-in challenge on the identifier step for its retry.
    if (passkeyChallenge && !state.attempt) return { flow: flows?.signIn, active: true, eager: true };
    return signInCaptchaOptions(flows?.signIn, state, () => {
      void submitRef.current();
    });
  }, [instanceSettings, mode, state, referralChallenge, passkeyChallenge]);
  const captchaNeeded = captchaOptions.active && isRenderableCaptcha(captchaOptions.flow?.provider, captchaOptions.flow);
  // A layout effect: a `<*.Captcha>` mounting in this commit has attached its
  // element by now (child refs run first), so `configure` draws straight into it.
  // Resolved once the passkey challenge's options are applied (its slot is drawn).
  const challengeDrawn = useRef<(() => void) | null>(null);
  useIsomorphicLayoutEffect(() => {
    captcha.configure(captchaOptions);
    challengeDrawn.current?.();
    challengeDrawn.current = null;
  }, [captcha, captchaOptions]);
  useEffect(() => () => captcha.destroy(), [captcha]);

  const setValue = useCallback((name: string, value: string) => {
    setValues((current) => ({ ...current, [name]: value }));
  }, []);

  // On completion: exchange the one-time ticket for cookies (FAPI is cross-origin
  // and cannot set the cookie itself), re-boot the provider, then optionally
  // navigate. Identical to `@atlasauth/react`'s `useFlow.finish`.
  const finish = useCallback(
    async (next: FlowState) => {
      setState(next);
      if (next.attempt?.status === 'complete') {
        if (next.ticket) {
          await client.post('/v1/client/tickets/exchange', {
            attempt_id: (next.attempt as { id?: string }).id,
            ticket: next.ticket,
          });
        }
        await reload();
        const target = opts.afterUrl?.trim();
        if (target && typeof window !== 'undefined') window.location.assign(target);
      }
    },
    [client, reload, opts.afterUrl],
  );

  const submit = useCallback(async () => {
    // A scroll-mode policy still unread: open its dialog first; accepting it submits again.
    if (mode === 'sign-up' && !state.attempt && policies.pendingScroll()) {
      setPolicyDeclined(null);
      setPolicyReading(true);
      return;
    }
    setState((current) => ({ ...current, busy: true, errors: [] }));

    // A sign-in waiting on policy acceptance posts the acceptances to `accept_policies`.
    if (mode === 'sign-in' && state.attempt && nextStep(state.attempt).kind === 'accept_policies') {
      const next = await advance(client, state, { ...values, policy_acceptances: JSON.stringify(policies.build()) });
      await finish(next);
      return;
    }

    // Sign-up's first POST creates the attempt via `/v1/client/sign_ups`, which
    // `advance` does not own (its pre-attempt branch is a sign-IN). Every later
    // step (the emailed verification code) flows through the shared `advance`.
    if (mode === 'sign-up' && !state.attempt) {
      const reserved = new Set(['email', 'identifier', 'password', 'consent', 'captcha_token']);
      const fields: Record<string, string> = {};
      for (const [k, v] of Object.entries(values)) {
        if (!reserved.has(k)) fields[k] = v;
      }
      // A token the developer set by hand (`setValue('captcha_token', …)`) wins;
      // otherwise the rendered `<SignUp.Captcha>` supplies one when required.
      const captchaToken = values.captcha_token || (await captcha.getToken()) || undefined;
      let next = await startSignUp(client, {
        email: values.email ?? values.identifier ?? '',
        password: values.password ?? '',
        ...(Object.keys(fields).length ? { fields } : {}),
        ...(values.consent === 'true' ? { consent: true } : {}),
        ...(captchaToken ? { captchaToken } : {}),
        ...(policies.policies.length > 0 ? { policyAcceptances: policies.build() } : {}),
      });
      // A policy changed while the form was open: reload them so the form asks again.
      if (isPolicyAcceptanceRequired(next.errors)) policies.setPolicies(await loadPolicies(client, { locale: locale ?? undefined }));
      next = { ...next, errors: localizeCaptchaErrors(next.errors, t).errors };
      // The token was spent either way; a refused create needs a fresh one.
      if (next.errors.length > 0 && captcha.needed) captcha.reset();
      await finish(next);
      return;
    }

    if (values.captcha_token) {
      // A hand-supplied token: drive the step as-is.
      const next = await advance(client, state, values);
      await finish(next);
      return;
    }
    const out = await advanceWithCaptcha(client, state, values, {
      captcha,
      identifier: identifierRef.current,
      t,
    });
    identifierRef.current = out.identifier;
    await finish(out.state);
  }, [captcha, client, finish, locale, mode, policies, state, t, values]);
  submitRef.current = submit;

  const resend = useCallback(async () => {
    if (!state.attempt) return;
    if (mode === 'sign-in') {
      // The verified sign-in re-send: ask the server to prepare the emailed code
      // again. Holds the poll secret for the cross-device magic-link path.
      const next = await prepareFactor(client, state, 'email_code');
      setState(next);
      return;
    }
    // Sign-up verification re-send. The server pairs `attempt_verification` with a
    // `prepare_verification`; re-posting it re-issues the emailed code.
    const id = (state.attempt as { id?: string }).id ?? '';
    await client.post(`/v1/client/sign_ups/${id}/prepare_verification`, {
      strategy: 'email_code',
    });
  }, [client, mode, state]);

  const startOauth = useCallback(
    async (provider: string) => {
      await startOauthImpl({ provider });
    },
    [startOauthImpl],
  );

  const startPasskey = useCallback(async () => {
    // Verified passkey sign-in: begin → browser ceremony (@atlasauth/js) → finish.
    // When the instance challenges every sign-in, the begin carries the sign-in
    // captcha's token (a hand-set `captcha_token` value wins); a refusal draws a
    // fresh challenge in `<SignIn.Captcha>` and the begin is retried once.
    let spent = false;
    const begin = await beginPasskeySignIn(client, {
      captcha: async ({ retry }) => {
        if (!retry) {
          if (values.captcha_token) return values.captcha_token;
          if (!captcha.needed) return null;
        } else if (!captcha.needed) {
          // Draw `<SignIn.Captcha>` for the challenge, and wait for that commit.
          await new Promise<void>((resolve) => {
            challengeDrawn.current = resolve;
            setPasskeyChallenge(true);
          });
        }
        const token = await captcha.getToken();
        if (token) spent = true;
        return token;
      },
    });
    setPasskeyChallenge(false);
    if (spent) captcha.reset();
    if (!begin.ok || !begin.data) {
      setState((current) => ({ ...current, errors: localizeCaptchaErrors(begin.errors, t).errors }));
      return;
    }
    const body = await getPasskeyAssertion(begin.data, {
      // PRF outputs go to the app's callback only, never into the finish body.
      ...(opts.passkeyPrf ? { prf: opts.passkeyPrf } : {}),
      ...(opts.onPasskeyExtensionResults ? { onExtensionResults: opts.onPasskeyExtensionResults } : {}),
    });
    const done = await client.post<AttemptView & { ticket?: string }>(
      '/v1/client/sign_ins/passkey/finish',
      body,
    );
    if (!done.ok || !done.data) {
      setState((current) => ({ ...current, errors: done.errors }));
      return;
    }
    await finish({
      attempt: done.data,
      errors: [],
      busy: false,
      pollSecret: state.pollSecret,
      ticket: done.data.ticket ?? null,
    });
  }, [captcha, client, finish, state.pollSecret, t, values.captcha_token, opts.passkeyPrf, opts.onPasskeyExtensionResults]);

  // Server errors in the app's language: each `message` becomes the catalog's
  // `error.<reason>` (else the server's own message), so `<Field.Error>` and any
  // custom error renderer show the localised text. `reason` stays on the error.
  const errors = useMemo(
    () =>
      state.errors.map((error) => ({
        ...error,
        message: localizedErrorMessage(error, errorCatalog ?? catalog, catalog),
      })),
    [state.errors, errorCatalog, catalog],
  );

  const declinePolicy = useCallback(
    (title: string) => {
      setPolicyReading(false);
      setPolicyDeclined(title);
      // Declining a sign-in's pending policy cancels the attempt: back to the start.
      if (mode === 'sign-in') setState({ ...initialFlow, errors: [] });
    },
    [mode],
  );

  return useMemo<FlowContextValue>(
    () => ({
      mode,
      attempt: state.attempt,
      errors,
      busy: state.busy,
      values,
      setValue,
      submit,
      resend,
      startOauth,
      startPasskey,
      captcha,
      captchaNeeded,
      ...(instanceSettings?.emailDelivery ? { emailDelivery: instanceSettings.emailDelivery } : {}),
      policies,
      policiesSatisfied: policies.canSubmit(),
      policyReading,
      setPolicyReading,
      policyDeclined,
      declinePolicy,
    }),
    [
      mode,
      state.attempt,
      errors,
      state.busy,
      values,
      setValue,
      submit,
      resend,
      startOauth,
      startPasskey,
      captcha,
      captchaNeeded,
      instanceSettings,
      policies,
      policyReading,
      policyDeclined,
      declinePolicy,
      policyVersion,
    ],
  );
}

/** Internal provider used by `<SignIn.Root>` / `<SignUp.Root>`. */
export function FlowProvider({
  value,
  children,
}: {
  value: FlowContextValue;
  children: ReactNode;
}) {
  return <FlowContext.Provider value={value}>{children}</FlowContext.Provider>;
}
