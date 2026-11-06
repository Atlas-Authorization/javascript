import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
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
  atlasCaptchaLabels,
  attemptPasswordHoldProof,
  preparePasswordHoldProof,
  createCaptchaController,
  createPasskeySignInController,
  createSignUp,
  PolicyAcceptanceController,
  confirmPolicies,
  controllerForPending,
  fetchInstanceSettings,
  loadPolicies,
  initialFlow,
  injectPolicyStyles,
  mountPolicyAcceptStep,
  mountPolicyClickwrap,
  mountPolicyConsent,
  flowFromPending,
  flowNeedsCaptcha,
  acknowledgeExistingAccount,
  acknowledgeRecoveryCodes,
  canDownloadRecoveryCodes,
  copyRecoveryCodes,
  createMfaEnrollment,
  createEmailLinkConfirmation,
  emailLinkFromUrl,
  enrollmentOptionKey,
  type EmailLink,
  type MfaEnrollmentStrategy,
  downloadRecoveryCodes,
  enrollmentSubmitKey,
  existingAccountResetUrl,
  groupSetupKey,
  mfaChoicesFrom,
  prepareSecondFactorCode,
  sendOnlyWaySecondFactorCode,
  holdsSecondFactor,
  secondFactorSendText,
  continueOnHostedPage,
  nextStep,
  pendingExistingAccountNotice,
  pendingRecoveryCodes,
  signInAfterProofUrl,
  signUpProvedByLink,
  offeredFirstFactors,
  passkeysSupported,
  pollAttempt,
  prepareFactor,
  planFirstFactor,
  shouldKeepPolling,
  signInCaptchaOptions,
  startSignInWithAtlas,
  type CaptchaController,
  type FlowState,
  type InstanceSettings,
  type PublicSignUpField,
} from '@atlasauth/js';
import { useAtlas } from './context';
import type { AtlasClient } from './provider';
import { ATLAS_SOLID_SDK } from './version';
import { policyHost, policyText } from './policies';

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
function field(name: string, label: string, type = 'text', autocomplete?: string): JSX.Element {
  return h('label', { class: 'atlas-field' }, [
    h('span', label),
    h('input', { class: 'atlas-input', name, type, ...(autocomplete ? { autocomplete } : {}) }),
  ]);
}

/** The flow's errors, rendered as alerts. Field-scoped ones (e.g. a rejected
 * password) are included: these forms have no per-field error slot, and an
 * error the user never sees is a form they cannot get past. */
function renderErrors(errors: FlowErrors, strings?: ErrorStrings, signInHref?: string | null): JSX.Element {
  // A server error in the app's language: `error.<reason>` from the client's
  // `localization`, else the server's (Accept-Language-localised) message.
  return errors.map((error) =>
    h(
      'p',
      { class: 'atlas-error', role: 'alert' },
      localizedErrorMessage(error, strings),
      signInHref && error.code === 'IDENTIFIER_EXISTS' && !error.param && error.meta?.['identifier'] !== 'username'
        ? [' ', h('a', { class: 'atlas-link', href: signInHref }, t('signIn.title'))]
        : null,
    ),
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
  'signIn.passkeyButton': 'Sign in with a passkey',
  'signIn.passkeyCancelled': "Passkey sign-in didn't finish. Try again, or use another way to sign in.",
  'captcha.prompt': 'Complete the security check to continue.',
  'captcha.required': 'Please complete the security check, then try again.',
  'captcha.failed': "The security check didn't pass. Please try again.",
  'captcha.checking': 'Checking your browser…',
  'captcha.verified': 'Security check complete.',
  'captcha.puzzlePrompt': "Select every picture that shows the same shape as this one. Colour and size don't matter.",
  'captcha.puzzleConfirm': 'Confirm',
  'captcha.puzzleTile': 'Picture {n}',
  'captcha.puzzleAlternative': "Can't do the picture check? Use a longer automatic check instead.",
  'signIn.continueWithAtlas': 'Continue with Atlas',
  'signIn.passwordHoldReleased': 'Your email is verified. Enter your password to sign in.',
  'signUp.existingAccount': 'You already had an account. Your existing password still applies.',
  'signUp.emailConfirmed': 'Your email is confirmed. Sign in to continue.',
  'signIn.forgotPassword': 'Forgot password?',
  'signIn.title': 'Sign in',
  'mfa.enrollChoose': 'Set up a second step for signing in.',
  'mfa.enrollTotpOption': 'Use an authenticator app',
  'mfa.enrollSmsOption': 'Use text messages',
  'link.title': "Confirm it's you",
  'link.matchCodeHint': 'Opening the link on another device? Enter this code there.',
  'link.checking': 'Checking your link…',
  'link.enterCodeHelp': 'Enter the code shown on the device where you started.',
  'link.codeLabel': 'Code',
  'link.confirm': 'Confirm',
  'link.confirmed': 'Confirmed. You can close this tab and go back to where you started.',
  'link.invalid': 'This link is no longer valid. Go back to where you started and ask for a new one.',
  'mfa.enrollHotpOption': 'Use a counter-based code generator',
  'mfa.enrollYubikeyOption': 'Use a YubiKey',
  'mfa.enrollDuoOption': 'Use Duo',
  'mfa.enrollPasskeyOption': 'Use a passkey',
  'mfa.yubikeyLabel': 'Touch your YubiKey',
  'mfa.enrollDuoHelp': 'Open Duo and approve the request, then come back and continue.',
  'mfa.enrollDuoOpen': 'Open Duo',
  'mfa.enrollPasskeyHelp': 'Create a passkey on this device to use as your second step. It must ask for your PIN or biometrics.',
  'mfa.enrollPasskeyCreate': 'Create passkey',
  'mfa.enrollScan': 'Scan this QR code with your authenticator app, or enter the setup key.',
  'mfa.enrollQrAlt': 'QR code for your authenticator app',
  'mfa.enrollSetupKey': 'Setup key',
  'mfa.enrollPreparing': 'Setting up…',
  'mfa.enrollFirstCodeLabel': 'Code from your authenticator app',
  'mfa.enrollSecondCodeLabel': 'The next code it shows',
  'mfa.phoneLabel': 'Mobile number',
  'mfa.phoneHint': 'Include the country code, for example +14155550101.',
  'mfa.sendCode': 'Text me a code',
  'mfa.codeTextedTo': 'Enter the code we texted to {phone}.',
  'mfa.codeWait': 'You can ask for another code in {seconds} seconds.',
  'mfa.codeLabel': 'Code',
  'mfa.recoveryCodesTitle': 'Save your recovery codes',
  'mfa.recoveryCodesHelp': "Each code works once. If you can't use your second step, sign in with one of these. Keep them somewhere safe: they won't be shown again.",
  'mfa.recoveryCodesCopy': 'Copy codes',
  'mfa.recoveryCodesCopied': 'Copied.',
  'mfa.recoveryCodesDownload': 'Download as .txt',
  'mfa.recoveryCodesSaved': "I've saved my codes",
  'signIn.resendCode': 'Resend code',
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
      // `webauthn`: saved passkeys appear in this field's autofill while <SignIn> holds a conditional request.
      return [field('identifier', 'Email', 'email', 'username webauthn')];
    case 'collect_first_factor':
      return [field('password', 'Password', 'password')];
    case 'collect_second_factor':
      return [field('code', 'Two-factor code')];
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

/** The password can sign in now that a proof lifted its hold. */
function passwordReleased(): JSX.Element {
  return h('p', { class: 'atlas-text', 'data-atlas-password-released': '' }, t('signIn.passwordHoldReleased'));
}

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
  released: boolean,
  usePassword: () => void,
): JSX.Element {
  const back = () =>
    offered.includes('password')
      ? h('button', { class: 'atlas-link', type: 'button', 'data-strategy': 'password', onClick: usePassword }, 'Use your password instead')
      : null;
  const resend = (strategy: EmailFactor) =>
    h('button', { class: 'atlas-link', type: 'button', 'data-atlas-resend': '', onClick: () => send(strategy) },
      strategy === 'email_code' ? 'Resend code' : 'Resend link');
  if (sent === 'email_code') {
    return [h('p', { class: 'atlas-text', 'data-atlas-code-sent': '' }, 'We sent you a code. Enter it below.'), field('code', 'Email code'), resend('email_code'), back()];
  }
  if (sent === 'email_link') {
    return [h('p', { class: 'atlas-text', 'data-atlas-link-sent': '' }, 'Check your email for a sign-in link.'), resend('email_link'), back()];
  }
  const out: JSX.Element[] = [];
  // No password on offer: the emailed factor is being sent on its own; the
  // buttons below are the retry if that send failed.
  if (listed && !offered.includes('password') && (offered.includes('email_code') || offered.includes('email_link'))) {
    out.push(h('p', { class: 'atlas-text', 'aria-live': 'polite' }, 'Sending…'));
  }
  if (released) out.push(passwordReleased());
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

function renderSubmit(kind: string, busy: boolean, hidden = false, blocked = false, label = 'Continue'): JSX.Element {
  if (hidden || kind === 'done' || kind === 'await_oauth' || kind === 'accept_policies') return null;
  return h('button', { class: 'atlas-button', type: 'submit', disabled: busy || blocked }, label);
}

/** The one-time recovery codes an MFA enrolment came with: shown before the flow finishes. */
function RecoveryCodesCard(codes: string[], busy: () => boolean, onSaved: () => void): JSX.Element {
  const [copied, setCopied] = createSignal(false);
  const secondary = (attr: string, label: string, onClick: () => void) =>
    h('button', { class: 'atlas-link', type: 'button', 'data-atlas': attr, onClick }, label);
  return h('div', { 'data-atlas': 'recovery-codes' }, [
    h('h2', { class: 'atlas-title' }, t('mfa.recoveryCodesTitle')),
    h('p', { class: 'atlas-text' }, t('mfa.recoveryCodesHelp')),
    h('ul', { class: 'atlas-recovery-codes', 'data-atlas': 'recovery-codes-list' }, codes.map((code) => h('li', code))),
    typeof navigator !== 'undefined' && typeof navigator.clipboard?.writeText === 'function'
      ? secondary('recovery-codes-copy', t('mfa.recoveryCodesCopy'), () => void copyRecoveryCodes(codes).then((ok) => setCopied(ok)))
      : null,
    canDownloadRecoveryCodes() ? secondary('recovery-codes-download', t('mfa.recoveryCodesDownload'), () => downloadRecoveryCodes(codes)) : null,
    () => (copied() ? h('p', { class: 'atlas-text', 'aria-live': 'polite', 'data-atlas': 'recovery-codes-copied' }, t('mfa.recoveryCodesCopied')) : null),
    h('button', { class: 'atlas-button', type: 'button', 'data-atlas': 'recovery-codes-saved', disabled: busy, onClick: onSaved }, t('mfa.recoveryCodesSaved')),
  ]);
}

/** Where `<SignUp>`'s two links go: a string overrides, null hides, unset is the hosted page. */
export interface SignUpProps {
  /** The existing-account notice's "Forgot password?". */
  resetPasswordUrl?: string | null;
  /** "Sign in", once an emailed link confirmed the address and made no session here. */
  signInUrl?: string | null;
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
function renderSignUpFields(settings: InstanceSettings | null, hasPolicies = false): JSX.Element {
  // Instance policies replace the legacy single "I agree to the Terms" row.
  const legal = hasPolicies ? undefined : settings?.legal;
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
    // The policy boxes are the controller's, not form fields.
    if (key === 'policies' || key.startsWith('policy_')) return;
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
function Flow(props: { client: AtlasClient; title: string; mode: 'sign-in' | 'sign-up'; links?: SignUpProps }): JSX.Element {
  const client = props.client;
  const fapi = new FapiClient({
    publishableKey: client.publishableKey,
    baseUrl: client.frontendApi,
    locale: client.locale,
    sdk: ATLAS_SOLID_SDK,
  });
  // Seeded from a redirect that returned mid-flow (OAuth owing a second
  // factor), so the user resumes at the demanded step instead of restarting.
  const [state, setStateRaw] = createSignal<FlowState>(
    props.mode === 'sign-in' ? flowFromPending(client.pendingAttempt) : flowFromPending(null),
  );
  const [settings, setSettingsRaw] = createSignal<InstanceSettings | null>(null);

  // Policy acceptance: the sign-up's policies (terms, privacy, …), kept in a
  // controller; `policyTick` re-runs the view when a box is ticked or they load.
  const policies = new PolicyAcceptanceController([]);
  const [policyTick, setPolicyTick] = createSignal(0);
  const offPolicies = policies.subscribe(() => setPolicyTick((n) => n + 1));
  onCleanup(offPolicies);
  const hasPolicies = createMemo(() => (policyTick(), policies.policies.length > 0));
  const policiesBlocked = () => (policyTick(), policies.policies.length > 0 && !policies.canSubmit());
  const [declined, setDeclined] = createSignal<string | null>(null);
  const pt = policyText(client, (key, vars) => t(key, vars));

  // §5 the per-flow captcha, driven by the instance's settings so turning it on
  // in the dashboard needs no code change. Configured synchronously with every
  // state / settings change, before the view reads `drawn`.
  // The Atlas captcha's words follow the form's catalog.
  const captchaSettings = { atlasLabels: () => atlasCaptchaLabels((key) => t(key)) };
  const captcha = createCaptchaController(undefined, captchaSettings);
  const signUpCaptcha = createCaptchaController(undefined, captchaSettings);
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
  if (!isServer && props.mode === 'sign-up') {
    void loadPolicies(fapi, { locale: client.locale ?? undefined }).then((list) => policies.setPolicies(list));
  }
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
    const codes = pendingRecoveryCodes(next);
    setState(codes ? { ...next, busy: true } : next);
    if (next.attempt?.status === 'complete') {
      let exchanged = true;
      if (next.ticket) {
        const res = await fapi.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
        exchanged = res.ok;
        if (!exchanged && !codes) setState((s) => ({ ...s, sessionKept: false }));
      }
      // The ticket dies in 60 seconds and saving the codes can take longer, so it is redeemed
      // as they're drawn. A refused exchange keeps it, so the save reports it.
      if (codes) {
        setState({ ...next, busy: false, ticket: exchanged ? null : next.ticket });
        return;
      }
      // Hold before the app learns of the session, so nothing unmounts this notice.
      if (exchanged && pendingExistingAccountNotice(next)) {
        setState({ ...next, ticket: null });
        return;
      }
      await client.reload();
    }
  };

  // What lifts a password hold on this instance: the emailed code, or a link where it verifies by link only.
  const holdProof = (): EmailFactor => (settings()?.account?.emailVerification === 'link' ? 'email_link' : 'email_code');

  const submit = (values: Record<string, string>) => {
    void (async () => {
      setState((s) => ({ ...s, busy: true, errors: [] }));
      const hold = state().passwordHold;
      // A code that lifts a password hold goes to its own attempt, not this sign-in.
      if (kind() === 'collect_first_factor' && hold && !hold.released && emailSent() === 'email_code' && holdProof() === 'email_code') {
        setState(await attemptPasswordHoldProof(fapi, state(), values.code ?? ''));
        return;
      }
      const out = await advanceWithCaptcha(fapi, state(), values, { captcha, identifier, t });
      identifier = out.identifier;
      await finish(out.state);
    })();
  };

  /** The sign-up submit: scroll-mode policies are read in their unskippable dialog first. */
  const startCreate = (values: Record<string, string>) => {
    setDeclined(null);
    if (hasPolicies() && policies.pendingScroll()) {
      void confirmPolicies(policies, { t: pt }).then((res) => {
        if (res.ok) create(values);
        else setDeclined(res.declined);
      });
      return;
    }
    create(values);
  };

  /** The sign-in step for `needs_policy_acceptance`: the dialog / checkboxes, then the acceptances go to the flow. */
  const policyStep = (): JSX.Element => {
    const el = document.createElement('div');
    let step: ReturnType<typeof mountPolicyAcceptStep> | null = null;
    let alive = true;
    void controllerForPending(fapi, untrack(() => state().attempt), { locale: client.locale ?? undefined }).then((controller) => {
      if (!alive) return;
      injectPolicyStyles(el.ownerDocument);
      step = mountPolicyAcceptStep(el, controller, {
        t: pt,
        onSubmit: (acceptances) => submit({ policy_acceptances: JSON.stringify(acceptances) }),
        // Declining cancels the attempt: back to the first step, saying why.
        onDecline: (policy) =>
          setState({ ...initialFlow, errors: [{ code: 'POLICY_DECLINED', message: pt('policy.declined', { policy: policy.title }) }] }),
      });
    });
    createEffect(() => step?.setBusy(state().busy));
    onCleanup(() => {
      alive = false;
      step?.destroy();
    });
    return el;
  };

  const create = (values: Record<string, string>) => {
    void (async () => {
      setState((s) => ({ ...s, busy: true, errors: [] }));
      // The consent box is `required` when the instance requires agreement, so a
      // submitted form always carries it then; without a requirement it is moot.
      const { consent, ...rest } = values;
      const agreed = hasPolicies() ? true : settings()?.legal.required ? consent === 'true' : true;
      await finish(await createSignUp(fapi, rest, { consent: agreed, captcha: signUpCaptcha, t, policies }));
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
        const polled = state();
        const { state: next, ticket } = await pollAttempt(fapi, polled);
        // A resend rotated the secret meanwhile: this answer is stale.
        if (state().pollSecret === polled.pollSecret) setState(next);
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

  // Passkey sign-in on the first step, as the hosted page: the button and autofill.
  const passkey = createPasskeySignInController({
    client: fapi,
    onStart: () => setState((s) => ({ ...s, busy: true, errors: [] })),
    onResult: finish,
    captcha: () => captcha,
    cancelledMessage: () => t('signIn.passkeyCancelled'),
  });
  const passkeyOffered = createMemo(
    () => props.mode === 'sign-in' && kind() === 'collect_identifier' && settings()?.passkeySignIn === true && passkeysSupported(),
  );
  createEffect(() => (passkeyOffered() ? passkey.armAutofill() : passkey.stopAutofill()));
  onCleanup(() => passkey.stopAutofill());

  // A link confirmed the address and made no session here. Says the same for any address.
  const provedSignUp = createMemo(() => signUpProvedByLink(state().attempt));
  const matchCode = createMemo(() => state().matchCode ?? null);

  // The MFA enrolment step: the authenticator's QR code and setup key, or a texted code.
  const enrollment = createMfaEnrollment(fapi, () => mfaChoicesFrom(settings()?.account));
  const [enrollmentState, setEnrollmentState] = createSignal(enrollment.state);
  onCleanup(enrollment.subscribe((next) => setEnrollmentState(next)));
  createEffect(() => {
    const id = kind() === 'enroll_second_factor' ? (state().attempt?.id ?? null) : null;
    if (id) enrollment.start(id);
    else enrollment.reset();
  });
  // Through this key: the inputs are re-created when the setup changes, not on busy or an error.
  const enrollmentKey = createMemo(() => {
    const s = enrollmentState();
    return `${s.method}|${s.enrollment ? 1 : 0}|${s.enrollment?.factorId ?? ''}|${s.options.join()}|${s.totpCodes}`;
  });
  const renderEnrollment = (): JSX.Element => {
    enrollmentKey();
    const s = untrack(enrollmentState);
    const method = (m: MfaEnrollmentStrategy) =>
      h('button', { class: 'atlas-link', type: 'button', 'data-atlas-mfa-method': m, onClick: () => void enrollment.choose(m) }, t(enrollmentOptionKey(m)));
    const out: JSX.Element[] = [];
    if (s.method === null) {
      out.push(h('p', { class: 'atlas-text' }, t('mfa.enrollChoose')), ...s.options.map(method));
    } else if (s.method === 'yubikey') {
      out.push(field('otp', t('mfa.yubikeyLabel'), 'text', 'off'));
    } else if (s.method !== 'phone_code' && !s.enrollment) {
      out.push(h('p', { class: 'atlas-text', 'aria-live': 'polite' }, t('mfa.enrollPreparing')));
    } else if (s.method === 'passkey') {
      out.push(h('p', { class: 'atlas-text' }, t('mfa.enrollPasskeyHelp')));
    } else if (s.method === 'duo') {
      const url = s.enrollment?.authorizationUrl;
      out.push(
        h('p', { class: 'atlas-text' }, t('mfa.enrollDuoHelp')),
        url ? h('a', { class: 'atlas-link', 'data-atlas': 'mfa-duo-open', href: url, target: '_blank', rel: 'noopener noreferrer' }, t('mfa.enrollDuoOpen')) : null,
      );
    } else if ((s.method === 'totp' || s.method === 'hotp') && s.enrollment) {
      const e = s.enrollment;
      out.push(h('p', { class: 'atlas-text' }, t('mfa.enrollScan')));
      if (e.qrCode) out.push(h('img', { class: 'atlas-mfa-qr', 'data-atlas': 'mfa-qr', src: e.qrCode, alt: t('mfa.enrollQrAlt'), width: 180, height: 180 }));
      if (e.secret) out.push(h('p', { class: 'atlas-text', 'data-atlas': 'mfa-setup-key' }, `${t('mfa.enrollSetupKey')}: `, h('code', groupSetupKey(e.secret))));
      out.push(field('code', t('mfa.enrollFirstCodeLabel'), 'text', 'one-time-code'));
      if (s.method === 'totp' && s.totpCodes >= 2) out.push(field('secondCode', t('mfa.enrollSecondCodeLabel'), 'text', 'one-time-code'));
    } else if (!s.enrollment) {
      out.push(field('phone', t('mfa.phoneLabel'), 'tel', 'tel'), h('p', { class: 'atlas-text' }, t('mfa.phoneHint')));
    } else {
      out.push(
        h('p', { class: 'atlas-text', 'aria-live': 'polite', 'data-atlas': 'mfa-code-texted' }, t('mfa.codeTextedTo', { phone: s.enrollment.phone ?? '' })),
        field('code', t('mfa.codeLabel'), 'text', 'one-time-code'),
        h('button', { class: 'atlas-link', type: 'button', 'data-atlas-resend': '', onClick: () => void enrollment.resend() }, t('signIn.resendCode')),
      );
    }
    if (s.method !== null && s.options.length > 1) out.push(...s.options.filter((m) => m !== s.method).map(method));
    return out as unknown as JSX.Element;
  };

  // §email delivery: the first factors this app can offer, keyed as a string so
  // the inputs are re-created only when the offer itself changes.
  const firstFactor = createMemo(() => {
    const attempt = state().attempt;
    const step = attempt ? nextStep(attempt) : null;
    if (step?.kind !== 'collect_first_factor' || provedSignUp()) return '';
    const listed = strategyNames(step.strategies ?? []);
    const offered = offeredFirstFactors(listed, settings()?.emailDelivery);
    const hold = state().passwordHold;
    // The emailed proof of a password hold, whichever factors the instance signs in with.
    const withProof =
      hold && !hold.released && settings()?.emailDelivery?.available !== false && !offered.includes(holdProof())
        ? [...offered, holdProof()]
        : offered;
    return `${listed.length ? 'listed' : 'unlisted'}:${withProof.join(',')}`;
  });
  const passwordHoldReleased = createMemo(() => state().passwordHold?.released === true);
  const existingAccountNotice = createMemo(() => pendingExistingAccountNotice(state()));
  const recoveryCodes = createMemo(() => pendingRecoveryCodes(state()));
  const [emailSent, setEmailSent] = createSignal<EmailFactor | null>(null);
  createEffect(() => {
    kind();
    // A proven hold goes back to the password field.
    passwordHoldReleased();
    setEmailSent(null);
  });
  const usePassword = () => {
    setEmailSent(null);
    setState((s) => ({ ...s, prepared: null, pollSecret: null, errors: [] }));
  };
  const sendEmailFactor = (strategy: EmailFactor) => {
    void (async () => {
      setState((s) => ({ ...s, busy: true, errors: [] }));
      const hold = state().passwordHold;
      const proof = holdProof();
      const next =
        hold && !hold.released && strategy === proof
          ? await preparePasswordHoldProof(fapi, state(), proof)
          : await prepareFactor(fapi, state(), strategy);
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
  // Second factor: "Email me a code" (and the on-arrival send when the inbox is the only way), "Use a passkey".
  const [secondMail, setSecondMail] = createSignal<{ attemptId: string; busy?: boolean; sentTo?: string; error?: string } | null>(null);
  const secondMailNow = () => {
    const m = secondMail();
    return m && m.attemptId === (state().attempt?.id ?? null) ? m : null;
  };
  const [secondText, setSecondText] = createSignal<{ attemptId: string; busy?: boolean; sentTo?: string; error?: string } | null>(null);
  const secondTextNow = () => {
    const m = secondText();
    return m && m.attemptId === (state().attempt?.id ?? null) ? m : null;
  };
  const [notHeld, setNotHeld] = createSignal<string[]>([]);
  let onlyWayFor: string | null = null;
  createEffect(() => {
    const id = state().attempt?.id ?? null;
    const { emailCode, sms, passkey } = mfaChoicesFrom(settings()?.account);
    if (kind() !== 'collect_second_factor' || !id || onlyWayFor === id || (!emailCode && !sms && !passkey)) return;
    onlyWayFor = id;
    for (const factor of ['passkey', 'sms', 'email_code'] as const) {
      void holdsSecondFactor(fapi, id, factor).then((held) => { if (!held) setNotHeld((list) => [...list, `${id}:${factor}`]); });
    }
    // secondMailNow and secondTextNow ignore an answer for an attempt the flow has left.
    if (emailCode) void sendOnlyWaySecondFactorCode(fapi, id, 'email_code', (seconds) => setSecondMail({ attemptId: id, error: t('mfa.codeWait', { seconds: String(seconds) }) })).then((sentTo) => { if (sentTo) setSecondMail({ attemptId: id, sentTo }); });
    if (sms) void sendOnlyWaySecondFactorCode(fapi, id, 'sms', (seconds) => setSecondText({ attemptId: id, error: t('mfa.codeWait', { seconds: String(seconds) }) })).then((sentTo) => { if (sentTo) setSecondText({ attemptId: id, sentTo }); });
  });
  const sendSecondCode = (
    attemptId: string,
    strategy: 'email_code' | 'sms',
    now: () => { sentTo?: string } | null,
    set: (value: { attemptId: string; busy?: boolean; sentTo?: string; error?: string }) => void,
  ) => {
    const before = now()?.sentTo;
    set({ attemptId, sentTo: before, busy: true });
    prepareSecondFactorCode(fapi, attemptId, strategy)
      .then(({ sentTo }) => {
        set({ attemptId, sentTo });
        // A wrong code's message no longer applies once a new code has gone out.
        setState((s) => ({ ...s, errors: [] }));
      })
      .catch((e: unknown) => set({ attemptId, sentTo: before, error: secondFactorSendText(e, t) }));
  };
  const sendSecondMail = (attemptId: string) => sendSecondCode(attemptId, 'email_code', secondMailNow, setSecondMail);
  const sendSecondText = (attemptId: string) => sendSecondCode(attemptId, 'sms', secondTextNow, setSecondText);
  const secondFactorOptions = (): JSX.Element => {
    const attempt = state().attempt;
    const choices = mfaChoicesFrom(settings()?.account);
    if (!attempt) return null;
    const lacks = (factor: string) => notHeld().includes(`${attempt.id}:${factor}`);
    const option = (name: string, m: { busy?: boolean; sentTo?: string; error?: string } | null, line: (to: string) => string, label: string, send: () => void) => {
      const sent = m?.sentTo !== undefined;
      return [
        sent ? h('p', { class: 'atlas-text', 'data-atlas': `${name}-sent`, 'aria-live': 'polite' }, line(m!.sentTo!)) : null,
        h(
          'button',
          { class: 'atlas-link', type: 'button', 'data-atlas': sent ? `${name}-resend` : name, disabled: state().busy || !!m?.busy, onClick: send },
          m?.busy ? t('signIn.sending') : sent || m?.error ? t('signIn.resendCode') : t(label),
        ),
        m?.error ? h('p', { class: 'atlas-error', role: 'alert' }, m.error) : null,
      ];
    };
    const email = !settings()?.account.emailSecondFactor || lacks('email_code')
      ? null
      : option('email-second-factor', secondMailNow(), (to) => t('signIn.codeSentTo', { email: to }), 'signIn.emailCodeOption', () => sendSecondMail(attempt.id!));
    const sms = !choices.sms || lacks('sms')
      ? null
      : option('sms-second-factor', secondTextNow(), (to) => t('mfa.codeTextedTo', { phone: to }), 'mfa.smsCodeOption', () => sendSecondText(attempt.id!));
    const passkeyButton = choices.passkey && !lacks('passkey')
      ? h(
          'button',
          { class: 'atlas-link', type: 'button', 'data-atlas': 'passkey-second-factor', disabled: state().busy, onClick: () => continueOnHostedPage(choices, attempt.id!, 'needs_second_factor') },
          t('mfa.enrollPasskeyOption'),
        )
      : null;
    return [sms, email, passkeyButton];
  };
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

  // "Sign in with Atlas", when the instance has it on (from /v1/appearance).
  const atlasConnection = () =>
    props.mode === 'sign-in' && !state().attempt ? settings()?.signInWithAtlas?.connectionId ?? null : null;
  const [atlasError, setAtlasError] = createSignal<string | null>(null);
  const continueWithAtlas = async () => {
    const connectionId = atlasConnection();
    if (!connectionId || isServer) return;
    setAtlasError(null);
    const started = await startSignInWithAtlas(fapi, connectionId, window.location.href);
    if ('url' in started) window.location.assign(started.url);
    else setAtlasError(started.error);
  };

  return h(
    'form',
    {
      class: 'atlas-card',
      onSubmit: (event: Event) => {
        event.preventDefault();
        const values = formValues(event.currentTarget as HTMLFormElement);
        if (kind() === 'create_account') startCreate(values);
        // Enrolment: text the code to the typed number, or confirm the factor.
        else if (kind() === 'enroll_second_factor') void enrollment.submit(values).then((next) => next && submit(next));
        else {
          passkey.stopAutofill();
          submit(values);
        }
      },
    },
    [
      h('h1', { class: 'atlas-title' }, props.title),
      () =>
        atlasConnection()
          ? [
              h(
                'button',
                { type: 'button', class: 'atlas-social-button', 'data-atlas-provider': 'atlas', onClick: () => void continueWithAtlas() },
                t('signIn.continueWithAtlas'),
              ),
              atlasError() ? h('p', { class: 'atlas-error', role: 'alert' }, atlasError()!) : null,
            ]
          : null,
      () =>
        renderErrors(
          state().errors,
          client.localization,
          // The losing tab of a sign-up race: the address is taken, so the way on is signing in.
          props.mode === 'sign-up' && kind() === 'collect_email_code'
            ? signInAfterProofUrl({ url: props.links?.signInUrl, frontendApi: client.frontendApi })
            : null,
        ),
      () => {
        // Through the memo: reading state() here would redraw the inputs and lose what's typed.
        const codes = recoveryCodes();
        if (codes) return RecoveryCodesCard(codes, () => state().busy, () => void finish(acknowledgeRecoveryCodes(untrack(state))));
        if (existingAccountNotice()) {
          const resetHref = existingAccountResetUrl({ url: props.links?.resetPasswordUrl, frontendApi: client.frontendApi });
          return h('div', { 'data-atlas-existing-account': '' }, [
            h('p', { class: 'atlas-text' }, t('signUp.existingAccount')),
            resetHref ? h('p', { class: 'atlas-text' }, h('a', { class: 'atlas-link', href: resetHref }, t('signIn.forgotPassword'))) : null,
            h(
              'button',
              { class: 'atlas-button', type: 'button', disabled: state().busy, onClick: () => void finish(acknowledgeExistingAccount(state())) },
              'Continue',
            ),
          ]);
        }
        if (kind() === 'create_account') return signUpBlocked() ? emailUnavailable() : renderSignUpFields(settings(), hasPolicies());
        if (kind() === 'accept_policies') return policyStep();
        if (provedSignUp()) {
          const signInHref = signInAfterProofUrl({ url: props.links?.signInUrl, frontendApi: client.frontendApi });
          return h('div', { 'data-atlas-email-confirmed': '' }, [
            h('p', { class: 'atlas-text', role: 'status' }, t('signUp.emailConfirmed')),
            signInHref ? h('a', { class: 'atlas-button', href: signInHref }, t('signIn.title')) : null,
          ]);
        }
        if (kind() === 'enroll_second_factor') return renderEnrollment();
        if (kind() === 'collect_first_factor') {
          const [listed, offered] = firstFactor().split(':') as [string, string];
          return renderFirstFactor(offered ? offered.split(',') : [], listed === 'listed', emailSent(), sendEmailFactor, passwordHoldReleased(), usePassword);
        }
        return renderFields(kind());
      },
      () =>
        kind() === 'create_account' && !signUpBlocked() && hasPolicies()
          ? [
              policyHost('div', (el) => mountPolicyConsent(el, policies, { t: pt })),
              declined() ? h('p', { class: 'atlas-error', role: 'alert', 'data-atlas-policy-declined': '' }, pt('policy.declined', { policy: declined()! })) : null,
            ]
          : null,
      captchaSlot(signUpCaptcha, () => kind() === 'create_account' && !signUpBlocked() && signUpCaptchaDrawn()),
      captchaSlot(
        captcha,
        () => (kind() === 'collect_identifier' || kind() === 'collect_captcha') && captchaDrawn(),
      ),
      () => (kind() === 'enroll_second_factor' ? renderErrors(enrollmentState().errors, client.localization) : null),
      // The code to type on another device. Only ever shown on the tab that started the flow.
      () =>
        matchCode() && !provedSignUp() && (kind() === 'collect_email_code' || (kind() === 'collect_first_factor' && emailSent() === 'email_link'))
          ? h('p', { class: 'atlas-text', 'data-atlas': 'link-match-code' }, `${t('link.matchCodeHint')} `, h('strong', h('code', matchCode()!)))
          : null,
      () => (kind() === 'collect_second_factor' ? secondFactorOptions() : null),
      () => {
        const enrolKey = kind() === 'enroll_second_factor' ? enrollmentSubmitKey(enrollmentState()) : undefined;
        return renderSubmit(
          kind(),
          state().busy,
          signUpBlocked() || awaitingEmail() || provedSignUp() || enrolKey === null,
          kind() === 'create_account' && policiesBlocked(),
          enrolKey && enrolKey !== 'signIn.submit' ? t(enrolKey) : undefined,
        );
      },
      () =>
        passkeyOffered()
          ? h(
              'button',
              {
                type: 'button',
                class: 'atlas-social-button atlas-passkey-button',
                'data-atlas-passkey-sign-in': '',
                disabled: () => state().busy,
                onClick: () => void passkey.signIn(),
              },
              t('signIn.passkeyButton'),
            )
          : null,
      () =>
        kind() === 'create_account' && !signUpBlocked() && hasPolicies()
          ? policyHost('p', (el) => mountPolicyClickwrap(el, policies, { t: pt }))
          : null,
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

/**
 * What a sign-in / sign-up widget draws when opened from a mailed link: tries
 * this browser's stored secret, then asks for the code the starting tab shows.
 * A success signs nobody in here: the starting tab continues on its own.
 */
function EmailLinkView(client: AtlasClient, link: EmailLink, title: string): JSX.Element {
  const controller = createEmailLinkConfirmation(
    new FapiClient({ publishableKey: client.publishableKey, baseUrl: client.frontendApi, locale: client.locale, sdk: ATLAS_SOLID_SDK }),
    link,
  );
  const [state, setState] = createSignal(controller.state);
  onCleanup(controller.subscribe((next) => setState(next)));
  void controller.start();
  const status = createMemo(() => state().status);
  return h(
    'form',
    {
      class: 'atlas-card',
      'data-atlas': 'email-link',
      'data-atlas-status': status,
      onSubmit: (event: Event) => {
        event.preventDefault();
        void controller.submitCode(formValues(event.currentTarget as HTMLFormElement).match_code ?? '');
      },
    },
    [
      h('h1', { class: 'atlas-title' }, title),
      // Through the memo: an error must not redraw the input and lose what's typed.
      () =>
        status() === 'needs_code'
          ? [
              h('p', { class: 'atlas-text' }, t('link.enterCodeHelp')),
              h('label', { class: 'atlas-field' }, [h('span', t('link.codeLabel')), h('input', { class: 'atlas-input', name: 'match_code', type: 'text', autocomplete: 'off', inputmode: 'numeric', required: true })]),
              h('button', { class: 'atlas-button', type: 'submit', disabled: () => state().busy }, t('link.confirm')),
            ]
          : h('p', { class: 'atlas-text', role: 'status', 'aria-live': 'polite' }, t(status() === 'confirmed' ? 'link.confirmed' : status() === 'invalid' ? 'link.invalid' : 'link.checking')),
      () => renderErrors(state().errors, client.localization),
      () => {
        const url = state().resetUrl;
        return url ? h('p', { class: 'atlas-text' }, h('a', { class: 'atlas-link', 'data-atlas-reset-link': '', href: url }, t('signIn.forgotPassword'))) : null;
      },
    ],
  ) as unknown as JSX.Element;
}

// --- Mount seams, called by the client's `mountX` methods. `render` returns the
// disposer that `onCleanup` later invokes to tear the nested root down. ---

export function mountSignInWidget(client: AtlasClient, el: HTMLElement): () => void {
  const link = emailLinkFromUrl(undefined, 'sign_in');
  return render(() => (link ? EmailLinkView(client, link, t('link.title')) : Flow({ client, title: 'Sign in', mode: 'sign-in' })), el);
}

export function mountSignUpWidget(client: AtlasClient, el: HTMLElement, links?: SignUpProps): () => void {
  const link = emailLinkFromUrl(undefined, 'sign_up');
  return render(() => (link ? EmailLinkView(client, link, t('link.title')) : Flow({ client, title: 'Sign up', mode: 'sign-up', links })), el);
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
function mountable<P extends object = object>(
  seam: (client: AtlasClient) => (el: HTMLElement, props: P) => () => void,
  rootClass: string,
) {
  return (props: P = {} as P): JSX.Element => {
    const client = useAtlas();
    if (isServer) return h('div', { class: rootClass });

    const container = document.createElement('div');
    container.className = rootClass;
    onMount(() => {
      // The seam drives a nested Solid root into `container`; its disposer is
      // the whole teardown, so unmounting the component unmounts the widget.
      const dispose = seam(client)(container, props);
      onCleanup(dispose);
    });
    return container;
  };
}

export const SignIn = mountable((client) => client.mountSignIn, 'atlas-signin-root');
export const SignUp = mountable<SignUpProps>((client) => client.mountSignUp, 'atlas-signup-root');
export const UserButton = mountable((client) => client.mountUserButton, 'atlas-user-button-root');
/** In-app policy re-acceptance: a banner (and the dialog / checkboxes) for a signed-in user whose policy changed. */
export const PolicyGate = mountable((client) => client.mountPolicyGate, 'atlas-policy-gate-root');
