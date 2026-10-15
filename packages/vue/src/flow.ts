import { onScopeDispose, shallowRef, watch, type ShallowRef } from 'vue';
import {
  advanceWithCaptcha,
  createCaptchaController,
  createSignUp,
  fetchInstanceSettings,
  signInCaptchaOptions,
  flowNeedsCaptcha,
  type CaptchaController,
  type InstanceSettings,
} from '@atlasauth/js';
import {
  FapiClient,
  flowFromPending,
  pollAttempt,
  prepareFactor,
  shouldKeepPolling,
  type FlowState,
} from './fapi';
import { useAtlas } from './context';
import { translate } from './i18n';

/**
 * §10.2 the server-driven sign-in / sign-up flow, as a composable.
 *
 * The Vue peer of the React SDK's internal `useFlow`. It never decides what
 * comes next — it drives the flow through `advance`, which owns the
 * step-to-endpoint mapping in `@atlasauth/js`, and renders whatever `status` the
 * server returned. Sign-in and sign-up share it: `<SignUp>` starts the attempt
 * with {@link FlowController.create} (`POST /v1/client/sign_ups`), then the
 * emailed-code step runs through the same `submit`, exactly as in React.
 */
export interface FlowController {
  /** The current server-driven attempt state. */
  state: ShallowRef<FlowState>;
  /** Post the current step's fields; the server decides the next status. */
  submit(values: Record<string, string>): void;
  /**
   * Create an account (`POST /v1/client/sign_ups`) from a create-account form's
   * values — email, password and any configured sign-up fields — carrying the
   * sign-up captcha's token when the instance requires one. The emailed code is
   * then posted with {@link submit}.
   */
  create(values: Record<string, string>, consent?: boolean): void;
  /**
   * Ask the server to email a sign-in code or link for the current first-factor
   * step (`prepare_first_factor`). Resolves whether it was sent; the code is then
   * posted with {@link submit}, and a link is collected by the poll.
   */
  prepare(strategy: 'email_code' | 'email_link'): Promise<boolean>;
  /**
   * The instance's public sign-in / sign-up settings (captcha, sign-up fields,
   * legal consent, `emailDelivery`) from `GET /v1/appearance`; null until loaded
   * or when the server could not be reached.
   */
  settings: ShallowRef<InstanceSettings | null>;
  /** The sign-in captcha (identifier step / `needs_captcha` challenge). */
  captcha: CaptchaController;
  /** The sign-up captcha (the create-account step). */
  signUpCaptcha: CaptchaController;
}

export function useFlow(): FlowController {
  const atlas = useAtlas();
  // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
  // factor), so the user resumes at the demanded step instead of starting over.
  const state = shallowRef<FlowState>(flowFromPending(atlas.pendingAttempt));
  const settings = shallowRef<InstanceSettings | null>(null);
  const t = (key: string) => translate(atlas.catalog, key);

  const client = new FapiClient({
    publishableKey: atlas.publishableKey,
    baseUrl: atlas.frontendApi,
  });

  // §5 the per-flow captcha, driven by the instance's settings so turning it on
  // in the dashboard needs no code change. The widgets draw into the slots the
  // components attach.
  const captcha = createCaptchaController();
  const signUpCaptcha = createCaptchaController();
  let identifier = '';

  // On completion the response carries a one-time ticket (§7.1). Exchange it
  // for cookies over a same-origin request — FAPI is cross-origin to the app
  // and cannot set the cookie on the completion response itself — THEN
  // re-boot so the rest of the app sees a signed-in user.
  const finish = async (next: FlowState) => {
    state.value = next;
    if (next.attempt?.status === 'complete') {
      if (next.ticket) {
        await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
      }
      await atlas.reload();
    }
  };

  const submit = (values: Record<string, string>) => {
    void (async () => {
      state.value = { ...state.value, busy: true, errors: [] };
      const out = await advanceWithCaptcha(client, state.value, values, { captcha, identifier, t });
      identifier = out.identifier;
      await finish(out.state);
    })();
  };

  const create = (values: Record<string, string>, consent = true) => {
    void (async () => {
      state.value = { ...state.value, busy: true, errors: [] };
      await finish(await createSignUp(client, values, { consent, captcha: signUpCaptcha, t }));
    })();
  };

  const prepare = async (strategy: 'email_code' | 'email_link') => {
    state.value = { ...state.value, busy: true, errors: [] };
    const next = await prepareFactor(client, state.value, strategy);
    state.value = { ...next, busy: false };
    return next.errors.length === 0;
  };

  // Keep both captchas in step with the settings and the flow's current step.
  watch(
    [settings, state],
    ([current, flow]) => {
      captcha.configure(signInCaptchaOptions(current?.captchaFlows.signIn, flow, () => submit({})));
      const signUpFlow = current?.captchaFlows.signUp;
      signUpCaptcha.configure({ flow: signUpFlow, active: !flow.attempt && flowNeedsCaptcha(signUpFlow) });
    },
    { immediate: true },
  );
  if (typeof window !== 'undefined') {
    void fetchInstanceSettings(client).then((loaded) => {
      if (loaded) settings.value = loaded;
    });
  }
  onScopeDispose(() => {
    captcha.destroy();
    signUpCaptcha.destroy();
  });

  // §5.3: collect a sign-in completed by a link opened on another device. The
  // poll restarts whenever the flow state changes and only runs while the state
  // says it should — the Vue peer of React's polling effect.
  let poller: ReturnType<typeof setInterval> | null = null;
  const stopPolling = () => {
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
  };

  watch(
    state,
    (current) => {
      stopPolling();
      if (!shouldKeepPolling(current)) return;

      poller = setInterval(() => {
        void (async () => {
          const { state: next, ticket } = await pollAttempt(client, state.value);
          state.value = next;
          if (!ticket || !next.attempt) return;

          // The ticket is exchanged by a normal request, so no session token has
          // ever appeared in a URL.
          await client.post('/v1/client/tickets/exchange', {
            attempt_id: (next.attempt as { id?: string }).id,
            ticket,
          });
          await atlas.reload();
        })();
      }, 2_000);
    },
    { immediate: true },
  );

  onScopeDispose(stopPolling);

  return { state, submit, create, prepare, settings, captcha, signUpCaptcha };
}

/** §10.2 `useSignIn()` — drive a sign-in attempt. */
export function useSignIn(): FlowController {
  return useFlow();
}

/**
 * §10.2 `useSignUp()` — drive a sign-up attempt: `create(values)` posts
 * `/v1/client/sign_ups` (the account is created there), then `submit({ code })`
 * verifies the emailed code and completes the session.
 */
export function useSignUp(): FlowController {
  return useFlow();
}
