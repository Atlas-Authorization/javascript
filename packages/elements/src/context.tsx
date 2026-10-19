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
  atlasCaptchaLabels,
  createCaptchaController,
  flowNeedsCaptcha,
  isRenderableCaptcha,
  localizeCaptchaErrors,
  localizedErrorMessage,
  signInCaptchaOptions,
  startSignUp,
  advance,
  prepareFactor,
  flowFromPending,
  initialFlow,
  getPasskeyAssertion,
  type AttemptView,
  type CaptchaController,
  type CaptchaControllerOptions,
  type EmailDelivery,
  type FieldError,
  type FlowState,
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
export function useFlowDriver(mode: FlowMode, opts: { afterUrl?: string } = {}): FlowContextValue {
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
  const captchaOptions = useMemo<CaptchaControllerOptions>(() => {
    if (mode === 'sign-up') {
      const flow = instanceSettings?.captchaFlows.signUp;
      return { flow, active: !state.attempt && flowNeedsCaptcha(flow) };
    }
    return signInCaptchaOptions(instanceSettings?.captchaFlows.signIn, state, () => {
      void submitRef.current();
    });
  }, [instanceSettings, mode, state]);
  const captchaNeeded = captchaOptions.active && isRenderableCaptcha(captchaOptions.flow?.provider);
  // A layout effect: a `<*.Captcha>` mounting in this commit has attached its
  // element by now (child refs run first), so `configure` draws straight into it.
  useIsomorphicLayoutEffect(() => {
    captcha.configure(captchaOptions);
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
    setState((current) => ({ ...current, busy: true, errors: [] }));

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
      });
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
  }, [captcha, client, finish, mode, state, t, values]);
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
    const begin = await client.post<Record<string, unknown>>('/v1/client/sign_ins/passkey/begin');
    if (!begin.ok || !begin.data) {
      setState((current) => ({ ...current, errors: begin.errors }));
      return;
    }
    const body = await getPasskeyAssertion(begin.data);
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
  }, [client, finish, state.pollSecret]);

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
