import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type JSX,
} from 'solid-js';
import { isServer, render } from 'solid-js/web';
import { h } from './h';
import {
  EMAIL_UNAVAILABLE_MESSAGE,
  FapiClient,
  localizedErrorMessage,
  type ErrorStrings,
  advanceWithCaptcha,
  createCaptchaController,
  createSignUp,
  fetchInstanceSettings,
  flowFromPending,
  flowNeedsCaptcha,
  nextStep,
  offeredFirstFactors,
  pollAttempt,
  prepareFactor,
  planFirstFactor,
  shouldKeepPolling,
  signInCaptchaOptions,
  type CaptchaController,
  type FlowState,
  type InstanceSettings,
  type PublicSignUpField,
} from '@atlasauth/js';
import { useAtlas } from './context';
import type { AtlasClient } from './provider';

/**
 * The mountable widgets — `<SignIn>`, `<SignUp>`, `<UserButton>`.
 *
 * `@atlasauth/js` ships no DOM widgets (it is the framework-agnostic flow
 * DRIVER: `advance` / `nextStep` / `pollAttempt`, which own the
 * step-to-endpoint mapping in ONE place). So, exactly as `@atlasauth/react` and
 * `@atlasauth/vue` do, the rendered flow lives in the framework binding and is
 * driven by that shared driver — a client that guessed the next step locally is
 * how a password ends up posted to the second-factor endpoint.
 *
 * The public components are deliberately thin: each creates a host element and,
 * in `onMount`, calls the client's `mountX(el)` seam, tearing it down in
 * `onCleanup`. The actual rendering is a nested Solid root (`render`) owned by
 * the client, so the mounted flow can reach the same client's `reload()` /
 * `signOut()` without being inside the component's context.
 */

type FlowErrors = FlowState['errors'];

/** A labelled, UNCONTROLLED input — its value is read from the form's
 * `FormData` on submit, which sidesteps per-keystroke signal churn for a plain
 * auth form. */
function field(name: string, label: string, type = 'text'): JSX.Element {
  return h('label', { class: 'atlas-field' }, [
    h('span', label),
    h('input', { class: 'atlas-input', name, type }),
  ]);
}

/** The flow's errors, rendered as alerts. Field-scoped ones (e.g. a rejected
 * password) are included: these forms have no per-field error slot, and an
 * error the user never sees is a form they cannot get past. */
function renderErrors(errors: FlowErrors, strings?: ErrorStrings): JSX.Element {
  // A server error in the app's language: `error.<reason>` from the client's
  // `localization`, else the server's (Accept-Language-localised) message.
  return errors.map((error) =>
    h('p', { class: 'atlas-error', role: 'alert' }, localizedErrorMessage(error, strings)),
  );
}

/**
 * The en-US strings of the create-account form and the captcha, under the same
 * catalog keys `@atlasauth/react` uses (`@atlasauth/localizations`).
 */
export const SIGN_UP_TEXT: Record<string, string> = {
  'signUp.title': 'Sign up',
  'signUp.submit': 'Continue',
  'signUp.emailLabel': 'Email address',
  'signUp.passwordLabel': 'Password',
  'signUp.optionalField': '{label} (optional)',
  'signUp.selectPlaceholder': 'Select…',
  'signUp.consentAgree': 'I agree to the',
  'signUp.consentNotice': 'By continuing you agree to the',
  'signUp.terms': 'Terms of Service',
  'signUp.privacy': 'Privacy Policy',
  'signUp.and': 'and',
  'signUp.emailUnavailable': EMAIL_UNAVAILABLE_MESSAGE,
  'captcha.prompt': 'Complete the security check to continue.',
  'captcha.required': 'Please complete the security check, then try again.',
  'captcha.failed': "The security check didn't pass. Please try again.",
};

const t = (key: string, vars: Record<string, string> = {}) =>
  (SIGN_UP_TEXT[key] ?? key).replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m);

/**
 * The element a flow's captcha widget draws into, while `drawn()` says the flow
 * needs one (see `createCaptchaController` in `@atlasauth/js`). The controller is
 * attached once the element is in the document and detached when it leaves.
 */
function captchaSlot(controller: CaptchaController, drawn: () => boolean): JSX.Element {
  return (() => {
    if (!drawn()) return null;
    const el = document.createElement('div');
    el.className = 'atlas-captcha';
    el.setAttribute('data-atlas-captcha', '');
    queueMicrotask(() => {
      if (el.isConnected) controller.attach(el);
    });
    onCleanup(() => controller.attach(null));
    return el;
  }) as unknown as JSX.Element;
}

/** The fields for the current server-driven step. The `unknown`/default branch
 * says so out loud rather than rendering a blank box the user cannot act on. */
function renderFields(kind: string): JSX.Element {
  switch (kind) {
    case 'collect_identifier':
      return [field('identifier', 'Email', 'email')];
    case 'collect_first_factor':
      return [field('password', 'Password', 'password')];
    case 'collect_second_factor':
      return [field('code', 'Two-factor code')];
    case 'enroll_second_factor':
      // Two codes, not one: consecutive codes catch a phone with a fast clock
      // here rather than on every sign-in afterwards.
      return [
        field('code', 'Authenticator code'),
        field('secondCode', 'Next authenticator code'),
      ];
    case 'collect_email_code':
      return [field('code', 'Email code')];
    case 'collect_new_password':
      return [field('password', 'New password', 'password')];
    case 'collect_captcha':
      // §5 the server withheld the attempt until a captcha clears. Solving the
      // widget resubmits the identifier on its own; the button retries.
      return [h('p', { class: 'atlas-text' }, t('captcha.prompt'))];
    case 'await_oauth':
      return [h('p', 'Continue in the window that opened.')];
    case 'done':
      return [h('p', 'Signed in — you can close this.')];
    default:
      return [h('p', { class: 'atlas-error' }, 'This step needs an updated app. Please reload.')];
  }
}

/** The "this app can't send email" state, in place of a form that would need it. */
function emailUnavailable(): JSX.Element {
  return h('p', { class: 'atlas-error', role: 'alert' }, t('signUp.emailUnavailable'));
}

/** A first factor's strategy name — the server sends plain names; tolerate `{ strategy }` entries too. */
function strategyNames(strategies: readonly unknown[]): string[] {
  return strategies
    .map((s) => (typeof s === 'string' ? s : (s as { strategy?: unknown } | null)?.strategy))
    .filter((s): s is string => typeof s === 'string');
}

/** An emailed first factor the user asked for: a code to type, or a link to open. */
type EmailFactor = 'email_code' | 'email_link';

/**
 * The first-factor step: the factors this app can actually offer
 * (`offeredFirstFactors` — no email code / link while it cannot deliver email).
 * A password field when `password` is offered (or the server sent no list), a
 * button per emailed factor, and the "can't send email" notice when nothing is
 * left. Once a code was sent only the code field remains, so the submit is
 * the email-code attempt.
 */
function renderFirstFactor(
  offered: string[],
  listed: boolean,
  sent: EmailFactor | null,
  send: (strategy: EmailFactor) => void,
): JSX.Element {
  const resend = (strategy: EmailFactor) =>
    h('button', { class: 'atlas-link', type: 'button', 'data-atlas-resend': '', onClick: () => send(strategy) },
      strategy === 'email_code' ? 'Resend code' : 'Resend link');
  if (sent === 'email_code') {
    return [h('p', { class: 'atlas-text', 'data-atlas-code-sent': '' }, 'We sent you a code. Enter it below.'), field('code', 'Email code'), resend('email_code')];
  }
  if (sent === 'email_link') {
    return [h('p', { class: 'atlas-text', 'data-atlas-link-sent': '' }, 'Check your email for a sign-in link.'), resend('email_link')];
  }
  const out: JSX.Element[] = [];
  // No password on offer: the emailed factor is being sent on its own; the
  // buttons below are the retry if that send failed.
  if (listed && !offered.includes('password') && (offered.includes('email_code') || offered.includes('email_link'))) {
    out.push(h('p', { class: 'atlas-text', 'aria-live': 'polite' }, 'Sending…'));
  }
  if (!listed || offered.includes('password')) out.push(field('password', 'Password', 'password'));
  if (offered.includes('email_code')) {
    out.push(h('button', { class: 'atlas-link', type: 'button', onClick: () => send('email_code') }, 'Email me a code'));
  }
  if (offered.includes('email_link')) {
    out.push(h('button', { class: 'atlas-link', type: 'button', onClick: () => send('email_link') }, 'Email me a sign-in link'));
  }
  if (!out.length) out.push(emailUnavailable());
  return out;
}

function renderSubmit(kind: string, busy: boolean, hidden = false): JSX.Element {
  if (hidden || kind === 'done' || kind === 'await_oauth') return null;
  return h('button', { class: 'atlas-button', type: 'submit', disabled: busy }, 'Continue');
}

/** One configured sign-up field's control (uncontrolled — read from `FormData`). */
function signUpControl(f: PublicSignUpField): JSX.Element {
  switch (f.type) {
    case 'checkbox':
      return h('input', { type: 'checkbox', name: f.key, value: 'true' });
    case 'select':
      return h('select', { class: 'atlas-input', name: f.key, required: f.required }, [
        h('option', { value: '' }, f.placeholder ?? t('signUp.selectPlaceholder')),
        ...f.options.map((o) => h('option', { value: o }, o)),
      ]);
    case 'textarea':
      return h('textarea', {
        class: 'atlas-input',
        name: f.key,
        rows: 3,
        required: f.required,
        placeholder: f.placeholder ?? undefined,
      });
    case 'radio':
    case 'multiselect':
      return h(
        'span',
        { class: 'atlas-choices' },
        f.options.map((o) =>
          h('label', { class: 'atlas-choice' }, [
            h('input', { type: f.type === 'radio' ? 'radio' : 'checkbox', name: f.key, value: o }),
            o,
          ]),
        ),
      );
    default: {
      const type = ['email', 'tel', 'url', 'number', 'date'].includes(f.type) ? f.type : 'text';
      return h('input', {
        class: 'atlas-input',
        type,
        name: f.key,
        required: f.required,
        placeholder: f.placeholder ?? undefined,
      });
    }
  }
}

/**
 * The create-account step's fields: the instance's configured extra fields,
 * email + password, and the legal-consent row. Re-rendered only when the
 * settings change, so what the user typed survives a refused submit.
 */
function renderSignUpFields(settings: InstanceSettings | null): JSX.Element {
  const legal = settings?.legal;
  const showLegal = !!legal && (!!legal.termsUrl || !!legal.privacyUrl);
  const links: JSX.Element[] = [];
  if (legal?.termsUrl) {
    links.push(h('a', { class: 'atlas-link', href: legal.termsUrl, target: '_blank', rel: 'noopener noreferrer' }, t('signUp.terms')));
  }
  if (legal?.privacyUrl) {
    if (links.length) links.push(` ${t('signUp.and')} `);
    links.push(h('a', { class: 'atlas-link', href: legal.privacyUrl, target: '_blank', rel: 'noopener noreferrer' }, t('signUp.privacy')));
  }
  return [
    ...(settings?.signUpFields ?? []).map((f) =>
      // A choice group holds several inputs, so it can't sit inside one <label>.
      h(f.type === 'radio' || f.type === 'multiselect' ? 'div' : 'label', { class: 'atlas-field' }, [
        h('span', f.required ? f.label : t('signUp.optionalField', { label: f.label })),
        signUpControl(f),
      ]),
    ),
    h('label', { class: 'atlas-field' }, [
      h('span', t('signUp.emailLabel')),
      h('input', { class: 'atlas-input', name: 'email', type: 'email', autocomplete: 'email', required: true }),
    ]),
    h('label', { class: 'atlas-field' }, [
      h('span', t('signUp.passwordLabel')),
      h('input', { class: 'atlas-input', name: 'password', type: 'password', autocomplete: 'new-password', required: true }),
    ]),
    showLegal
      ? h('label', { class: 'atlas-consent' }, [
          legal!.required ? h('input', { type: 'checkbox', name: 'consent', value: 'true', required: true }) : null,
          h('span', { class: 'atlas-text' }, [
            t(legal!.required ? 'signUp.consentAgree' : 'signUp.consentNotice'),
            ' ',
            ...links,
            '.',
          ]),
        ])
      : null,
  ] as unknown as JSX.Element;
}

/** Read a form into values; repeated names (a multiselect) are comma-joined,
 *  the same encoding as React, the embed widget and the hosted page. */
function formValues(form: HTMLFormElement): Record<string, string> {
  const values: Record<string, string> = {};
  new FormData(form).forEach((value, key) => {
    values[key] = key in values ? `${values[key]}, ${String(value)}` : String(value);
  });
  return values;
}

/**
 * The server-driven sign-in / sign-up flow. Never decides what comes next: it
 * drives through `advance` (the driver owns the step→endpoint mapping) and
 * renders whatever `status` the server returned. In `sign-up` mode the first
 * step is the create-account form, which POSTs `/v1/client/sign_ups`; from there
 * it is the same driver (the emailed-code step, then the ticket exchange). Both
 * draw the instance's captcha when it is required.
 */
function Flow(props: { client: AtlasClient; title: string; mode: 'sign-in' | 'sign-up' }): JSX.Element {
  const client = props.client;
  const fapi = new FapiClient({
    publishableKey: client.publishableKey,
    baseUrl: client.frontendApi,
    locale: client.locale,
  });
  // Seeded from a redirect that returned mid-flow (OAuth owing a second
  // factor), so the user resumes at the demanded step instead of restarting.
  const [state, setStateRaw] = createSignal<FlowState>(
    props.mode === 'sign-in' ? flowFromPending(client.pendingAttempt) : flowFromPending(null),
  );
  const [settings, setSettingsRaw] = createSignal<InstanceSettings | null>(null);

  // §5 the per-flow captcha, driven by the instance's settings so turning it on
  // in the dashboard needs no code change. Configured synchronously with every
  // state / settings change, before the view reads `drawn`.
  const captcha = createCaptchaController();
  const signUpCaptcha = createCaptchaController();
  const [captchaDrawn, setCaptchaDrawn] = createSignal(false);
  const [signUpCaptchaDrawn, setSignUpCaptchaDrawn] = createSignal(false);
  let identifier = '';
  const syncCaptcha = () => {
    const current = settings();
    const flow = state();
    if (props.mode === 'sign-in') {
      captcha.configure(signInCaptchaOptions(current?.captchaFlows.signIn, flow, () => submit({})));
    } else {
      const signUpFlow = current?.captchaFlows.signUp;
      signUpCaptcha.configure({ flow: signUpFlow, active: !flow.attempt && flowNeedsCaptcha(signUpFlow) });
    }
    setCaptchaDrawn(captcha.needed);
    setSignUpCaptchaDrawn(signUpCaptcha.needed);
  };
  const setState = (next: FlowState | ((s: FlowState) => FlowState)) => {
    setStateRaw(next as FlowState);
    syncCaptcha();
  };
  if (!isServer) {
    void fetchInstanceSettings(fapi).then((loaded) => {
      if (!loaded) return;
      setSettingsRaw(loaded);
      syncCaptcha();
    });
  }
  onCleanup(() => {
    captcha.destroy();
    signUpCaptcha.destroy();
  });

  // A completion response carries a one-time ticket (§7.1). FAPI is
  // cross-origin to the app and cannot set the cookie on its own response,
  // so exchange the ticket over a request THEN re-boot, so the rest of the
  // app sees a signed-in user — and no session token ever rode in a URL.
  const finish = async (next: FlowState) => {
    setState(next);
    if (next.attempt?.status === 'complete') {
      if (next.ticket) {
        await fapi.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
      }
      await client.reload();
    }
  };

  const submit = (values: Record<string, string>) => {
    void (async () => {
      setState((s) => ({ ...s, busy: true, errors: [] }));
      const out = await advanceWithCaptcha(fapi, state(), values, { captcha, identifier, t });
      identifier = out.identifier;
      await finish(out.state);
    })();
  };

  const create = (values: Record<string, string>) => {
    void (async () => {
      setState((s) => ({ ...s, busy: true, errors: [] }));
      // The consent box is `required` when the instance requires agreement, so a
      // submitted form always carries it then; without a requirement it is moot.
      const { consent, ...rest } = values;
      const agreed = settings()?.legal.required ? consent === 'true' : true;
      await finish(await createSignUp(fapi, rest, { consent: agreed, captcha: signUpCaptcha, t }));
    })();
  };

  // §5.3 magic-link poll: a sign-in finished on another device. Restart on each
  // state change, run only while the state says to, stop on teardown.
  let poller: ReturnType<typeof setInterval> | null = null;
  const stopPolling = () => {
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
  };
  createEffect(() => {
    const current = state();
    stopPolling();
    if (!shouldKeepPolling(current)) return;
    poller = setInterval(() => {
      void (async () => {
        const { state: next, ticket } = await pollAttempt(fapi, state());
        setState(next);
        if (!ticket || !next.attempt) return;
        await fapi.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        await client.reload();
      })();
    }, 2_000);
  });
  onCleanup(stopPolling);

  // The step KIND, memoized, so the inputs are re-created only when the step
  // changes — not on every busy/error update, which would wipe what was typed.
  const kind = createMemo(() => {
    const attempt = state().attempt;
    if (!attempt) return props.mode === 'sign-up' ? 'create_account' : 'collect_identifier';
    return nextStep(attempt).kind;
  });

  // §email delivery: the first factors this app can offer, keyed as a string so
  // the inputs are re-created only when the offer itself changes.
  const firstFactor = createMemo(() => {
    const attempt = state().attempt;
    const step = attempt ? nextStep(attempt) : null;
    if (step?.kind !== 'collect_first_factor') return '';
    const listed = strategyNames(step.strategies ?? []);
    const offered = offeredFirstFactors(listed, settings()?.emailDelivery);
    return `${listed.length ? 'listed' : 'unlisted'}:${offered.join(',')}`;
  });
  const [emailSent, setEmailSent] = createSignal<EmailFactor | null>(null);
  createEffect(() => {
    kind();
    setEmailSent(null);
  });
  const sendEmailFactor = (strategy: EmailFactor) => {
    void (async () => {
      setState((s) => ({ ...s, busy: true, errors: [] }));
      const next = await prepareFactor(fapi, state(), strategy);
      setState(next);
      if (!next.errors.length) setEmailSent(strategy);
    })();
  };
  // With no password on offer, email the code (or link) as soon as the step
  // appears — once per attempt, so a failed send waits for the user's retry.
  let autoSentFor: string | null = null;
  createEffect(() => {
    const offer = firstFactor();
    const id = state().attempt?.id ?? null;
    if (!offer.startsWith('listed:') || !id || autoSentFor === id) return;
    const strategy = planFirstFactor(offer.slice('listed:'.length).split(',')).autoSend;
    if (!strategy) return;
    autoSentFor = id;
    sendEmailFactor(strategy);
  });
  // Nothing to submit while only an emailed factor is on offer and not yet sent.
  const awaitingEmail = () => {
    if (kind() !== 'collect_first_factor' || emailSent() === 'email_code') return false;
    const offer = firstFactor();
    return emailSent() === 'email_link' || (offer.startsWith('listed:') && planFirstFactor(offer.slice(7).split(',')).autoSend !== null);
  };
  // §email delivery: a password sign-up needs a verification email; when the
  // app cannot send one, say so instead of a form that cannot finish.
  const signUpBlocked = () =>
    kind() === 'create_account' && settings()?.emailDelivery?.passwordSignUp === false;

  return h(
    'form',
    {
      class: 'atlas-card',
      onSubmit: (event: Event) => {
        event.preventDefault();
        const values = formValues(event.currentTarget as HTMLFormElement);
        if (kind() === 'create_account') create(values);
        else submit(values);
      },
    },
    [
      h('h1', { class: 'atlas-title' }, props.title),
      () => renderErrors(state().errors, client.localization),
      () => {
        if (kind() === 'create_account') return signUpBlocked() ? emailUnavailable() : renderSignUpFields(settings());
        if (kind() === 'collect_first_factor') {
          const [listed, offered] = firstFactor().split(':') as [string, string];
          return renderFirstFactor(offered ? offered.split(',') : [], listed === 'listed', emailSent(), sendEmailFactor);
        }
        return renderFields(kind());
      },
      captchaSlot(signUpCaptcha, () => kind() === 'create_account' && !signUpBlocked() && signUpCaptchaDrawn()),
      captchaSlot(
        captcha,
        () => (kind() === 'collect_identifier' || kind() === 'collect_captcha') && captchaDrawn(),
      ),
      () => renderSubmit(kind(), state().busy, signUpBlocked() || awaitingEmail()),
    ],
  );
}

/** The signed-in user's avatar + a menu whose only built-in action is sign-out
 * — the Solid peer of Vue's `<UserButton>`. Renders nothing when signed out. */
function UserButtonView(client: AtlasClient): JSX.Element {
  const [open, setOpen] = createSignal(false);
  const user = () => client.state.user;
  const label = () => {
    const u = user();
    if (!u) return '';
    return [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || '';
  };

  return h(
    Show,
    { when: () => Boolean(user()) },
    () =>
      h('div', { class: 'atlas-user-button' }, [
        h(
          'button',
          {
            class: 'atlas-avatar',
            'aria-expanded': () => open(),
            onClick: () => setOpen(!open()),
          },
          () => {
            const u = user();
            return u?.image_url
              ? h('img', { alt: '', src: u.image_url })
              : h('span', () => label().slice(0, 1));
          },
        ),
        () =>
          open()
            ? h('div', { class: 'atlas-menu', role: 'menu' }, [
                h('span', { class: 'atlas-menu-item' }, () => label()),
                h(
                  'button',
                  { class: 'atlas-menu-item', onClick: () => void client.signOut() },
                  'Sign out',
                ),
              ])
            : null,
      ]),
  );
}

// --- Mount seams, called by the client's `mountX` methods. `render` returns the
// disposer that `onCleanup` later invokes to tear the nested root down. ---

export function mountSignInWidget(client: AtlasClient, el: HTMLElement): () => void {
  return render(() => Flow({ client, title: 'Sign in', mode: 'sign-in' }), el);
}

export function mountSignUpWidget(client: AtlasClient, el: HTMLElement): () => void {
  return render(() => Flow({ client, title: 'Sign up', mode: 'sign-up' }), el);
}

export function mountUserButtonWidget(client: AtlasClient, el: HTMLElement): () => void {
  return render(() => UserButtonView(client), el);
}

// --- The public, thin mountable components. ---

/**
 * Build a component that mounts one widget. It calls the CLIENT's seam
 * (`client.mountSignIn` etc.) rather than the module function directly, so the
 * mounted root reaches the same client the provider built — and so the seam is a
 * real, test-observable boundary. The host element is created imperatively
 * (not via a reactive `ref`) so it is guaranteed present the moment `onMount`
 * fires. SSR renders an empty host and hydrates on the client.
 */
function mountable(
  seam: (client: AtlasClient) => (el: HTMLElement) => () => void,
  rootClass: string,
) {
  return (): JSX.Element => {
    const client = useAtlas();
    if (isServer) return h('div', { class: rootClass });

    const container = document.createElement('div');
    container.className = rootClass;
    onMount(() => {
      // The seam drives a nested Solid root into `container`; its disposer is
      // the whole teardown, so unmounting the component unmounts the widget.
      const dispose = seam(client)(container);
      onCleanup(dispose);
    });
    return container;
  };
}

export const SignIn = mountable((client) => client.mountSignIn, 'atlas-signin-root');
export const SignUp = mountable((client) => client.mountSignUp, 'atlas-signup-root');
export const UserButton = mountable((client) => client.mountUserButton, 'atlas-user-button-root');
