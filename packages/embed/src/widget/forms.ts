import {
  EMAIL_UNAVAILABLE_MESSAGE,
  awaitingSignUpLink,
  initialResetFlow,
  nextStep,
  passkeysSupported,
  planFirstFactor,
  resetStep,
  signUpProvedByLink,
  type FieldError,
  type PendingRequiredAction,
  type ProfileCompletionField,
} from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { COPY } from './constants';
import { cls, doc, el, submitButton } from './dom';
import { render } from './render';
import { mountSignUpPolicies, policyT } from './policies';
import { continueAfterExistingAccount, resendSignUp, sendEmailFactor, signInAfterProof, startReset, submit, submitReset, submitSignUp } from './flow';
import { renderEnrollment, renderSecondFactorAlternatives, say, submitEnrollment } from './mfa';

/**
 * The sign-up's code proved an address that already had an account: its password
 * still applies. The session is already in place; Continue finishes.
 */
export function renderExistingAccountNotice(w: AtlasWidget): HTMLElement {
  const box = el(w, 'div', 'atlas-embed-existing-account');
  box.setAttribute('data-atlas', 'existing-account');
  const note = el(w, 'p', 'atlas-embed-note', say(w, 'signUp.existingAccount'));
  note.setAttribute('role', 'status');
  box.appendChild(note);
  if (w.passwordResetEnabled) {
    const forgot = el(w, 'button', 'atlas-embed-step-back', say(w, 'signIn.forgotPassword')) as HTMLButtonElement;
    forgot.type = 'button';
    forgot.addEventListener('click', () => {
      w.enteredIdentifier ??= w.state.attempt?.identifier ?? null;
      startReset(w);
    });
    box.appendChild(forgot);
  }
  const next = el(w, 'button', cls(w, 'buttonPrimary', 'atlas-embed-button'), say(w, 'signUp.submit')) as HTMLButtonElement;
  next.type = 'button';
  next.setAttribute('data-atlas', 'existing-account-continue');
  next.addEventListener('click', () => void continueAfterExistingAccount(w));
  box.appendChild(next);
  return box;
}

/**
 * §5.4 the reset sub-flow panel: email → emailed code → (2FA) → new password →
 * signed in. Reuses the shared field builders + the segmented code input, and
 * always offers a way back to sign in.
 */
export function renderReset(w: AtlasWidget): HTMLElement {
  const flow = w.resetFlow!;
  const step = resetStep(flow);
  const wrap = el(w, 'div', 'atlas-embed-reset');

  wrap.appendChild(el(w, 'h1', cls(w, 'title', 'atlas-embed-title'), 'Reset your password'));

  const form = doc(w).createElement('form');
  const errors = flow.errors;
  const inputs = new Map<string, HTMLInputElement>();
  const formError = errors.find((e) => !e.param);
  if (formError) form.appendChild(el(w, 'div', 'atlas-embed-form-error', w.errorText(formError)));

  let subtitle: string | null = null;
  let submitLabel = 'Continue';
  let showSubmit = true;
  // How the instance emails the reset: a code, a link, or one email with both.
  const delivery = w.account.passwordReset;
  switch (step) {
    case 'request':
      subtitle =
        delivery === 'link'
          ? 'Enter your email and we’ll send you a reset link.'
          : delivery === 'both'
            ? 'Enter your email and we’ll send you a reset link and code.'
            : 'Enter your email and we’ll send you a reset code.';
      submitLabel = delivery === 'link' ? 'Send reset link' : 'Send reset code';
      fieldInto(w, form, inputs, errors, 'email', 'Email address', 'email', 'username');
      {
        const emailField = inputs.get('email');
        if (emailField) {
          if (w.enteredIdentifier) emailField.value = w.enteredIdentifier;
          emailField.setAttribute('data-atlas-autofocus', '');
        }
      }
      break;
    case 'collect_email_code':
      if (delivery === 'link') {
        // Nothing to type: the link carries the proof, and this tab follows the
        // attempt (it continues on its own once the link is opened, anywhere).
        showSubmit = false;
        subtitle = 'Check your email';
        const note = el(
          w,
          'p',
          'atlas-embed-note',
          w.enteredIdentifier
            ? `We sent a reset link to ${w.enteredIdentifier}. Open it on any device; this page continues on its own.`
            : 'We sent you a reset link. Open it on any device; this page continues on its own.',
        );
        note.setAttribute('data-atlas-link-sent', '');
        form.appendChild(note);
        const again = el(w, 'button', 'atlas-embed-step-back', 'Send another link') as HTMLButtonElement;
        again.type = 'button';
        again.setAttribute('data-atlas-resend', '');
        again.disabled = w.busy;
        again.addEventListener('click', () => {
          w.resetFlow = { ...initialResetFlow };
          void submitReset(w, { email: w.enteredIdentifier ?? '' });
        });
        form.appendChild(again);
        break;
      }
      subtitle = w.enteredIdentifier
        ? `Enter the code we sent to ${w.enteredIdentifier}`
        : 'Enter the code we sent to your email';
      codeFieldInto(w, form, inputs, errors, 'code', 'Reset code', true);
      break;
    case 'collect_second_factor':
      subtitle = 'Enter the code from your authenticator app';
      codeFieldInto(w, form, inputs, errors, 'code', 'Two-factor code', true);
      break;
    case 'collect_new_password':
      subtitle = 'Choose a new password';
      submitLabel = 'Set new password';
      fieldInto(w, form, inputs, errors, 'password', 'New password', 'password', 'new-password');
      inputs.get('password')?.setAttribute('data-atlas-autofocus', '');
      // A user who set security questions answers them before the new password is accepted.
      (flow.securityQuestions ?? []).forEach((question, i) => fieldInto(w, form, inputs, errors, `security_answer_${i}`, question, 'text', 'off'));
      break;
    default:
      showSubmit = false;
      form.appendChild(el(w, 'p', 'atlas-embed-note', 'You’re all set.'));
  }
  // The code to type on another device. Only ever shown on the tab that asked for the reset.
  if (step === 'collect_email_code' && flow.attempt?.match_code) {
    const hint = el(w, 'p', 'atlas-embed-note', `${say(w, 'link.matchCodeHint')} `);
    hint.setAttribute('data-atlas', 'link-match-code');
    hint.appendChild(el(w, 'code', 'atlas-embed-mfa-key', flow.attempt.match_code));
    form.appendChild(hint);
  }

  if (subtitle) {
    wrap.appendChild(el(w, 'p', cls(w, 'subtitle', 'atlas-embed-subtitle'), subtitle));
  }
  wrap.appendChild(form);

  if (showSubmit) {
    form.appendChild(submitButton(w, submitLabel));
  }

  const back = el(w, 'button', 'atlas-embed-step-back', 'Back to sign in');
  (back as HTMLButtonElement).type = 'button';
  back.addEventListener('click', () => {
    w.resetFlow = null;
    render(w);
  });
  form.appendChild(back);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values: Record<string, string> = {};
    for (const [name, input] of inputs) values[name] = input.value;
    void submitReset(w, values);
  });

  return wrap;
}

function owedAction(w: AtlasWidget): PendingRequiredAction | undefined {
  return w.state.attempt?.pending_required_actions?.[0];
}

/**
 * The step a held attempt owes (a new password, profile fields, a verified
 * address, the app's own step). Resolves whether the form has anything to submit.
 */
function renderRequiredAction(
  w: AtlasWidget,
  form: HTMLElement,
  inputs: Map<string, HTMLInputElement>,
  ctx: {
    addField(name: string, label: string, type: string, autocomplete: string): void;
    addCodeField(name: string, label: string, autofocus: boolean): void;
    trailing: HTMLElement[];
  },
): boolean {
  const owed = owedAction(w);
  const note = (text: string) => form.appendChild(el(w, 'p', 'atlas-embed-note', text));
  const action = (label: string, onClick: () => void, primary = false) => {
    const b = el(w, 'button', primary ? cls(w, 'buttonPrimary', 'atlas-embed-button') : 'atlas-embed-step-back', label) as HTMLButtonElement;
    b.type = 'button';
    b.disabled = w.busy;
    b.addEventListener('click', onClick);
    return b;
  };
  switch (owed?.action) {
    case 'update_password':
      ctx.addField('password', 'New password', 'password', 'new-password');
      return true;
    case 'update_profile':
      ctx.addField('first_name', say(w, 'requiredAction.firstNameLabel'), 'text', 'given-name');
      ctx.addField('last_name', say(w, 'requiredAction.lastNameLabel'), 'text', 'family-name');
      return true;
    case 'complete_profile':
    case 'journey_form': {
      if (owed.title) note(owed.title);
      if (owed.intro) note(owed.intro);
      const asked = owed.fields ?? [];
      for (const f of asked) addAskedField(w, form, inputs, ctx.addField, f);
      if (owed.action === 'complete_profile' && asked.every((f) => !f.required)) {
        ctx.trailing.push(action(say(w, 'requiredAction.skip'), () => void submit(w, { action: 'complete_profile', skip: 'true' })));
      }
      return true;
    }
    case 'verify_email':
      note(say(w, 'requiredAction.verifyIntro'));
      ctx.trailing.push(action(say(w, 'requiredAction.sendCode'), () => void submit(w, { action: 'verify_email', step: 'send' })));
      ctx.addCodeField('code', 'Verification code', true);
      return true;
    case 'identity_verification': {
      const idv = w.state.attempt?.identity_verification ?? null;
      note(say(w, 'requiredAction.idvIntro'));
      // shortcut: the user presses "I've finished" where the hosted page also polls; add a timer if that proves too slow.
      if (idv?.url) {
        const open = el(w, 'a', cls(w, 'buttonPrimary', 'atlas-embed-button'), say(w, 'requiredAction.idvOpen')) as HTMLAnchorElement;
        open.href = idv.url;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        form.appendChild(open);
        form.appendChild(action(say(w, 'requiredAction.idvCheck'), () => void submit(w, { action: 'identity_verification' })));
      } else {
        const here = doc(w).defaultView?.location;
        const returnTo = here?.protocol === 'https:' ? here.href : undefined;
        form.appendChild(
          action(say(w, 'requiredAction.idvStart'), () => void submit(w, { action: 'identity_verification', step: 'start', ...(returnTo ? { redirect_url: returnTo } : {}) }), true),
        );
      }
      const status = idv?.status === 'declined' ? 'requiredAction.idvDeclined' : idv?.status === 'needs_review' ? 'requiredAction.idvReview' : idv?.url ? 'requiredAction.idvWaiting' : null;
      if (status) note(say(w, status)).setAttribute('role', 'status');
      return false;
    }
    default:
      // An application-defined step: the app closes it, then the user signs in again.
      note(say(w, 'requiredAction.customIntro'));
      if (owed?.url) {
        const go = el(w, 'a', cls(w, 'buttonPrimary', 'atlas-embed-button'), say(w, 'signUp.submit')) as HTMLAnchorElement;
        go.href = owed.url;
        go.rel = 'noopener';
        form.appendChild(go);
      }
      return false;
  }
}

/** One field the server asked for, under the `field:<key>` name `advance` sends as `fields`. */
function addAskedField(
  w: AtlasWidget,
  form: HTMLElement,
  inputs: Map<string, HTMLInputElement>,
  addField: (name: string, label: string, type: string, autocomplete: string) => void,
  f: ProfileCompletionField,
): void {
  const name = `field:${f.key}`;
  const label = `${f.label}${f.required ? ' *' : ''}`;
  if (f.type === 'select' || f.type === 'textarea' || f.type === 'checkbox') {
    const wrap = el(w, 'label', cls(w, 'field', 'atlas-embed-field'));
    wrap.appendChild(el(w, 'span', cls(w, 'label', 'atlas-embed-label'), label));
    let control: HTMLSelectElement | HTMLTextAreaElement | HTMLInputElement;
    if (f.type === 'select') {
      control = doc(w).createElement('select');
      control.appendChild(doc(w).createElement('option'));
      for (const o of f.options ?? []) {
        const option = doc(w).createElement('option');
        option.value = o;
        option.textContent = o;
        control.appendChild(option);
      }
    } else if (f.type === 'textarea') {
      control = doc(w).createElement('textarea');
    } else {
      const box = doc(w).createElement('input');
      box.type = 'checkbox';
      box.value = 'false';
      box.addEventListener('change', () => {
        box.value = box.checked ? 'true' : 'false';
      });
      control = box;
    }
    if (f.type !== 'checkbox') control.className = cls(w, 'input', 'atlas-embed-input');
    control.name = name;
    wrap.appendChild(control);
    form.appendChild(wrap);
    // The form reads only `.value`, which these share with an input.
    inputs.set(name, control as HTMLInputElement);
    return;
  }
  addField(name, label, ['tel', 'email', 'url', 'number', 'date'].includes(f.type) ? f.type : 'text', 'off');
  if (f.placeholder) inputs.get(name)?.setAttribute('placeholder', f.placeholder);
}

/** A labelled text input, appended to `form` and registered in `inputs`. */
export function fieldInto(
  w: AtlasWidget,
  form: HTMLElement,
  inputs: Map<string, HTMLInputElement>,
  errors: readonly FieldError[],
  name: string,
  label: string,
  type: string,
  autocomplete: string,
): void {
  const field = el(w, 'label', cls(w, 'field', 'atlas-embed-field'));
  field.appendChild(el(w, 'span', cls(w, 'label', 'atlas-embed-label'), label));
  const input = doc(w).createElement('input');
  input.className = cls(w, 'input', 'atlas-embed-input');
  input.type = type;
  input.name = name;
  input.setAttribute('autocomplete', autocomplete);

  if (type === 'password') {
    // A show/hide eye toggle — reveals the typed password. preventDefault keeps
    // the wrapping <label> from stealing focus back to the input on the click.
    const wrap = el(w, 'div', 'atlas-embed-password');
    wrap.appendChild(input);
    const toggle = el(w, 'button', 'atlas-embed-password-toggle', 'Show') as HTMLButtonElement;
    toggle.type = 'button';
    toggle.setAttribute('aria-label', 'Show password');
    toggle.addEventListener('click', (event) => {
      event.preventDefault();
      const revealing = input.type === 'password';
      input.type = revealing ? 'text' : 'password';
      toggle.textContent = revealing ? 'Hide' : 'Show';
      toggle.setAttribute('aria-label', revealing ? 'Hide password' : 'Show password');
    });
    wrap.appendChild(toggle);
    field.appendChild(wrap);
  } else {
    field.appendChild(input);
  }

  for (const err of errors.filter((e) => e.param === name)) {
    field.appendChild(el(w, 'span', cls(w, 'error', 'atlas-embed-error'), w.errorText(err)));
  }
  inputs.set(name, input);
  form.appendChild(field);
}

/**
 * A verification-code field. `boxes` (default) is a segmented one-box-per-digit
 * input that auto-advances, accepts a paste, and auto-submits when full;
 * `single` (or a non-6-digit code) is a plain field. Both feed the same `name`.
 * Shared by the sign-in and the password-reset forms.
 */
export function codeFieldInto(
  w: AtlasWidget,
  form: HTMLElement,
  inputs: Map<string, HTMLInputElement>,
  errors: readonly FieldError[],
  name: string,
  label: string,
  autofocus: boolean,
): void {
  const CODE_LEN = 6;
  if (w.codeInputStyle === 'single') {
    fieldInto(w, form, inputs, errors, name, label, 'text', 'one-time-code');
    if (autofocus) inputs.get(name)?.setAttribute('data-atlas-autofocus', '');
    return;
  }
  const field = el(w, 'div', cls(w, 'field', 'atlas-embed-field'));
  field.appendChild(el(w, 'span', cls(w, 'label', 'atlas-embed-label'), label));
  const group = el(w, 'div', 'atlas-embed-code');
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', label);

  const hidden = doc(w).createElement('input');
  hidden.type = 'hidden';
  hidden.name = name;
  inputs.set(name, hidden);

  const boxes: HTMLInputElement[] = [];
  const sync = () => {
    hidden.value = boxes.map((b) => b.value).join('');
  };
  const maybeSubmit = () => {
    // A complete code submits itself — the expected OTP UX — but only once.
    // Dispatch the form's own submit event (our listener preventDefaults it and
    // drives the flow); we never want native navigation, so this works on every
    // host, jsdom included.
    if (hidden.value.length !== CODE_LEN || w.busy) return;
    form.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
  };
  for (let i = 0; i < CODE_LEN; i++) {
    const box = doc(w).createElement('input');
    box.className = 'atlas-embed-code-box';
    box.type = 'text';
    box.setAttribute('inputmode', 'numeric');
    box.setAttribute('autocomplete', i === 0 ? 'one-time-code' : 'off');
    box.setAttribute('aria-label', `${label} digit ${i + 1}`);
    box.maxLength = 1;
    if (autofocus && i === 0) box.setAttribute('data-atlas-autofocus', '');
    box.addEventListener('input', () => {
      box.value = box.value.replace(/\D/g, '').slice(0, 1);
      sync();
      if (box.value && i < CODE_LEN - 1) boxes[i + 1]!.focus();
      maybeSubmit();
    });
    box.addEventListener('keydown', (event) => {
      if (event.key === 'Backspace' && !box.value && i > 0) boxes[i - 1]!.focus();
    });
    box.addEventListener('paste', (event) => {
      event.preventDefault();
      const text = (event.clipboardData?.getData('text') ?? '').replace(/\D/g, '').slice(0, CODE_LEN);
      for (let j = 0; j < CODE_LEN; j++) boxes[j]!.value = text[j] ?? '';
      sync();
      boxes[Math.min(text.length, CODE_LEN - 1)]!.focus();
      maybeSubmit();
    });
    boxes.push(box);
    group.appendChild(box);
  }
  field.appendChild(group);
  field.appendChild(hidden);
  for (const err of errors.filter((e) => e.param === name)) {
    field.appendChild(el(w, 'span', cls(w, 'error', 'atlas-embed-error'), w.errorText(err)));
  }
  form.appendChild(field);
}

export function renderForm(w: AtlasWidget, stepKind: string): HTMLElement {
  const form = doc(w).createElement('form');

  const formError = w.state.errors.find((e) => !e.param);
  if (formError) {
    const shown = el(w, 'div', 'atlas-embed-form-error', w.errorText(formError));
    // The losing tab of a sign-up race: the address is taken, so the way on is signing in.
    if (w.mode === 'sign-up' && stepKind === 'collect_email_code' && formError.code === 'IDENTIFIER_EXISTS' && formError.meta?.['identifier'] !== 'username') {
      const toSignIn = el(w, 'button', 'atlas-embed-step-back', say(w, 'signIn.title')) as HTMLButtonElement;
      toSignIn.type = 'button';
      toSignIn.setAttribute('data-atlas', 'identifier-exists-sign-in');
      toSignIn.addEventListener('click', () => signInAfterProof(w));
      shown.append(' ', toSignIn);
    }
    form.appendChild(shown);
  }

  const inputs = new Map<string, HTMLInputElement>();
  const errors = w.state.errors;
  const addField = (name: string, label: string, type: string, autocomplete: string) =>
    fieldInto(w, form, inputs, errors, name, label, type, autocomplete);
  const addCodeField = (name: string, label: string, autofocus: boolean) =>
    codeFieldInto(w, form, inputs, errors, name, label, autofocus);

  let showSubmit = true;
  let submitLabel: string = COPY[w.mode].submit;
  // Secondary actions drawn under the submit button (resend, other factors).
  const trailing: HTMLElement[] = [];
  // The emailed link made no session here, or an earlier sign-up finished. Says the same for any address.
  const emailConfirmedNotice = () => {
    showSubmit = false;
    const confirmed = el(w, 'p', 'atlas-embed-note', say(w, 'signUp.emailConfirmed'));
    confirmed.setAttribute('role', 'status');
    confirmed.setAttribute('data-atlas-email-confirmed', '');
    form.appendChild(confirmed);
    const toSignIn = el(w, 'button', cls(w, 'buttonPrimary', 'atlas-embed-button'), say(w, 'signIn.title')) as HTMLButtonElement;
    toSignIn.type = 'button';
    toSignIn.setAttribute('data-atlas', 'email-confirmed-sign-in');
    toSignIn.addEventListener('click', () => signInAfterProof(w));
    form.appendChild(toSignIn);
  };
  // The code to type on another device. Only ever shown on the tab that started the flow.
  const matchCodeHint = () => {
    if (!w.state.matchCode) return;
    const hint = el(w, 'p', 'atlas-embed-note', `${say(w, 'link.matchCodeHint')} `);
    hint.setAttribute('data-atlas', 'link-match-code');
    hint.appendChild(el(w, 'code', 'atlas-embed-mfa-key', w.state.matchCode));
    form.appendChild(hint);
  };
  switch (stepKind) {
    case 'collect_identifier':
      // §5.5 the `webauthn` autocomplete token opts this field into passkey
      // autofill (conditional UI), so the browser can surface saved passkeys in
      // the email field when the instance offers them.
      addField(
        'identifier',
        'Email address',
        'email',
        w.passkeyEnabled && passkeysSupported() ? 'username webauthn' : 'username',
      );
      // Prefill what they last typed so a wrong-password retry keeps the email
      // in place (the single-screen box never loses it).
      if (w.enteredIdentifier) inputs.get('identifier')!.value = w.enteredIdentifier;
      // Single-screen sign-in: email + password on one form (the classic login
      // box), matching the sign-up form. `submit()` sends the identifier, then
      // auto-submits this password when the server asks for the first factor.
      // Omitted when password isn't enabled (a passwordless instance branches).
      if (w.mode === 'sign-in' && w.passwordEnabled) {
        addField('password', 'Password', 'password', 'current-password');
        // §5.3 with an emailed code (or link) also on, it is one click away.
        const instead: ('email_code' | 'email_link')[] = [];
        if (w.emailDeliveryAvailable && w.emailCodeEnabled) instead.push('email_code');
        else if (w.emailDeliveryAvailable && w.emailLinkEnabled) instead.push('email_link');
        for (const strategy of instead) {
          const b = el(w, 'button', 'atlas-embed-step-back', strategy === 'email_code' ? 'Email me a code instead' : 'Email me a sign-in link instead');
          (b as HTMLButtonElement).type = 'button';
          b.setAttribute('data-strategy', strategy);
          (b as HTMLButtonElement).disabled = w.busy;
          b.addEventListener('click', () => {
            const id = inputs.get('identifier')!;
            if (!id.value.trim()) {
              id.reportValidity?.();
              id.focus();
              return;
            }
            void submit(w, { identifier: id.value }, strategy);
          });
          trailing.push(b);
        }
      }
      // §7.5 Remember me — ticked keeps a persistent session; unticked makes it a
      // browser-session cookie. Its value is read live via `this.remember`, so it
      // is carried to the ticket exchange even though it is not a form field.
      if (w.mode === 'sign-in' && w.rememberMeEnabled) {
        const row = el(w, 'label', 'atlas-embed-remember');
        const box = doc(w).createElement('input');
        box.type = 'checkbox';
        box.className = 'atlas-embed-remember-check';
        box.checked = w.remember;
        box.addEventListener('change', () => {
          w.remember = box.checked;
        });
        row.appendChild(box);
        row.appendChild(el(w, 'span', 'atlas-embed-remember-text', 'Remember me'));
        form.appendChild(row);
      }
      break;
    case 'collect_first_factor': {
      if (signUpProvedByLink(w.state.attempt)) {
        emailConfirmedNotice();
        break;
      }
      // §5.3 a password field only when the server offers `password`; an emailed
      // code (or link) is sent by `submit()` when it isn't.
      const strategies = w.state.attempt ? (nextStep(w.state.attempt) as { strategies?: string[] }).strategies ?? [] : [];
      const plan = planFirstFactor(
        w.emailDeliveryAvailable ? strategies : strategies.filter((s) => s !== 'email_code' && s !== 'email_link'),
      );
      const sent = w.state.prepared ?? null;
      const who = w.enteredIdentifier ?? (w.state.attempt as { identifier?: string | null } | null)?.identifier ?? '';
      const action = (strategy: 'email_code' | 'email_link', label: string, attr: string) => {
        const b = el(w, 'button', 'atlas-embed-step-back', label);
        (b as HTMLButtonElement).type = 'button';
        b.setAttribute(attr, attr === 'data-strategy' ? strategy : '');
        (b as HTMLButtonElement).disabled = w.busy;
        b.addEventListener('click', () => void sendEmailFactor(w, strategy));
        return b;
      };
      if (sent === 'email_code') {
        const note = el(w, 'p', 'atlas-embed-note', who ? `We sent a code to ${who}. Enter it below.` : 'We sent you a code. Enter it below.');
        note.setAttribute('data-atlas-code-sent', '');
        form.appendChild(note);
        addCodeField('code', 'Verification code', true);
        trailing.push(action('email_code', 'Resend code', 'data-atlas-resend'));
      } else if (sent === 'email_link') {
        showSubmit = false;
        const note = el(w, 'p', 'atlas-embed-note', who ? `We sent a sign-in link to ${who}. Open it on any device to continue.` : 'Check your email for a sign-in link.');
        note.setAttribute('data-atlas-link-sent', '');
        form.appendChild(note);
        matchCodeHint();
        trailing.push(action('email_link', 'Resend link', 'data-atlas-resend'));
      } else if (!plan.password && plan.email.length > 0) {
        // The automatic send failed (its error is shown above): retry here.
        showSubmit = false;
        for (const strategy of plan.email) {
          trailing.push(action(strategy, strategy === 'email_code' ? 'Email me a code' : 'Email me a sign-in link', 'data-strategy'));
        }
      } else {
        addField('password', 'Password', 'password', 'current-password');
        for (const strategy of plan.email) {
          trailing.push(
            action(strategy, strategy === 'email_code' ? 'Email me a code instead' : 'Email me a sign-in link instead', 'data-strategy'),
          );
        }
      }
      break;
    }
    case 'collect_second_factor':
      // A recovery/backup code is alphanumeric + variable-length, so it can't go
      // in fixed digit boxes — the "use a backup code" toggle swaps to a single
      // field for it, and the digit boxes are used for the authenticator code.
      if (w.backupCodeMode) addField('code', 'Backup code', 'text', 'one-time-code');
      else addCodeField('code', 'Two-factor code', true);
      // §5.3 "Remember this device" — unticked by default (opt-in). Read live via
      // `this.rememberDevice`, injected into the second-factor submit below.
      if (w.trustedDeviceEnabled) {
        const row = el(w, 'label', 'atlas-embed-remember');
        const box = doc(w).createElement('input');
        box.type = 'checkbox';
        box.className = 'atlas-embed-remember-check';
        box.checked = w.rememberDevice;
        box.addEventListener('change', () => {
          w.rememberDevice = box.checked;
        });
        row.appendChild(box);
        row.appendChild(el(w, 'span', 'atlas-embed-remember-text', 'Remember this device'));
        form.appendChild(row);
      }
      // "Text me a code instead" / "Email me a code instead", where the app offers them.
      renderSecondFactorAlternatives(w, trailing);
      break;
    case 'collect_email_code': {
      if (signUpProvedByLink(w.state.attempt)) {
        emailConfirmedNotice();
        break;
      }
      const linkOnly = awaitingSignUpLink(w.state.attempt, w.account.emailVerification);
      if (linkOnly) {
        // Nothing to type: this tab polls and continues once the link is opened.
        showSubmit = false;
        const who = w.enteredIdentifier ?? (w.state.attempt as { identifier?: string | null } | null)?.identifier ?? '';
        const note = el(
          w,
          'p',
          'atlas-embed-note',
          who
            ? `We sent a confirmation link to ${who}. Open it on any device; this page continues on its own.`
            : 'We sent you a confirmation link. Open it on any device; this page continues on its own.',
        );
        note.setAttribute('data-atlas-link-sent', '');
        form.appendChild(note);
      } else {
        addCodeField('code', 'Verification code', true);
      }
      matchCodeHint();
      // A sign-up can ask for a fresh email (the earlier code / link stops working).
      if (w.state.attempt?.object === 'sign_up_attempt') {
        const again = el(w, 'button', 'atlas-embed-step-back', linkOnly ? 'Resend link' : 'Resend code') as HTMLButtonElement;
        again.type = 'button';
        again.setAttribute('data-atlas-resend', '');
        again.disabled = w.busy;
        again.addEventListener('click', () => void resendSignUp(w));
        trailing.push(again);
      }
      break;
    }
    case 'collect_new_password':
      addField('password', 'New password', 'password', 'new-password');
      break;
    case 'complete_required_action':
      submitLabel = say(w, 'signUp.submit');
      showSubmit = renderRequiredAction(w, form, inputs, { addField, addCodeField, trailing });
      break;
    case 'enroll_second_factor': {
      // The authenticator app (QR code, setup key, its code) or a texted code.
      const label = renderEnrollment(w, form, { addField, addCodeField, trailing }, submitLabel);
      if (label === null) showSubmit = false;
      else submitLabel = label;
      break;
    }
    default:
      showSubmit = false;
      form.appendChild(el(w, 'p', 'atlas-embed-note', 'Please continue in your application.'));
  }

  if (showSubmit) {
    form.appendChild(submitButton(w, submitLabel));
  }
  for (const node of trailing) form.appendChild(node);

  // §5.3 2FA fallback: let the user swap between the authenticator boxes and a
  // free-text backup-code field.
  if (stepKind === 'collect_second_factor') {
    const toggle = el(
      w,
      'button',
      'atlas-embed-step-back',
      w.backupCodeMode ? 'Use your authenticator app' : 'Use a backup code instead',
    );
    (toggle as HTMLButtonElement).type = 'button';
    toggle.addEventListener('click', () => {
      w.backupCodeMode = !w.backupCodeMode;
      render(w);
    });
    form.appendChild(toggle);
  }

  // §5.4 "Forgot password?" — start the reset sub-flow. Shown wherever a password
  // is being asked for (the single-screen box, or a dedicated password step), and
  // only when password sign-in is actually on and the app can email the reset code.
  const passwordStep =
    (stepKind === 'collect_identifier' && w.mode === 'sign-in' && w.passwordEnabled) ||
    (stepKind === 'collect_first_factor' && inputs.has('password'));
  if (passwordStep && w.passwordResetEnabled) {
    const forgot = el(w, 'button', 'atlas-embed-step-back', 'Forgot password?');
    (forgot as HTMLButtonElement).type = 'button';
    forgot.addEventListener('click', () => startReset(w));
    form.appendChild(forgot);
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values: Record<string, string> = {};
    for (const [name, input] of inputs) values[name] = input.value;
    // §5.3 carry the "remember this device" choice into the second-factor submit.
    if (stepKind === 'collect_second_factor' && w.trustedDeviceEnabled && w.rememberDevice) {
      values.remember_device = 'true';
    }
    if (stepKind === 'enroll_second_factor') {
      void submitEnrollment(w, values);
      return;
    }
    // Required actions: name the action; an emailed code is verified, not re-sent; blank optional fields stay out.
    if (stepKind === 'complete_required_action') {
      const owed = owedAction(w)?.action ?? '';
      for (const name of Object.keys(values)) if (name.startsWith('field:') && !values[name]) delete values[name];
      void submit(w, { ...values, action: owed, ...(owed === 'verify_email' ? { step: 'verify' } : {}) });
      return;
    }
    void submit(w, values);
  });

  return form;
}

/**
 * §5.1 legal consent on sign-up: a line linking the Terms of Service / Privacy
 * Policy the tenant configured. When `required`, it carries a checkbox that gates
 * account creation. Returns null when the tenant set no links. The URLs are
 * https-sanitised server-side, so they are safe to render as anchors.
 */
export function renderLegalConsent(
  w: AtlasWidget,
): { row: HTMLElement; checkbox: HTMLInputElement | null } | null {
  const legal = w.appearance?.legal;
  if (!legal || (!legal.termsUrl && !legal.privacyUrl)) return null;
  const document = doc(w);
  const row = el(w, 'div', 'atlas-embed-consent');

  let checkbox: HTMLInputElement | null = null;
  if (legal.required) {
    checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'atlas-embed-consent-check';
    checkbox.setAttribute('aria-label', 'Agree to the terms and privacy policy');
    row.appendChild(checkbox);
  }

  const text = el(w, 'span', 'atlas-embed-consent-text');
  const link = (url: string, label: string): HTMLElement => {
    const a = document.createElement('a');
    a.href = url;
    a.textContent = label;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    a.className = 'atlas-embed-consent-link';
    return a;
  };
  text.appendChild(document.createTextNode(legal.required ? 'I agree to the ' : 'By continuing you agree to the '));
  const parts: HTMLElement[] = [];
  if (legal.termsUrl) parts.push(link(legal.termsUrl, 'Terms of Service'));
  if (legal.privacyUrl) parts.push(link(legal.privacyUrl, 'Privacy Policy'));
  parts.forEach((part, i) => {
    if (i > 0) text.appendChild(document.createTextNode(' and '));
    text.appendChild(part);
  });
  text.appendChild(document.createTextNode('.'));
  row.appendChild(text);
  return { row, checkbox };
}

/**
 * §5 The create-account form: the tenant's configured fields (name, company,
 * phone, custom…) followed by email + password. Submits to
 * /v1/client/sign_ups; the server then emails a code and the shared flow drives
 * verification to completion.
 */
/** The end-user words the API uses for EMAIL_DELIVERY_NOT_CONFIGURED (shared with every SDK). */
export { EMAIL_UNAVAILABLE_MESSAGE };

export function renderSignUpForm(w: AtlasWidget): HTMLElement {
  const form = doc(w).createElement('form');
  // A sign-up that must verify by email on an app that can't send email would
  // only be refused: say so instead of drawing the form.
  if (!w.passwordSignUpEnabled) {
    form.appendChild(el(w, 'div', 'atlas-embed-form-error', EMAIL_UNAVAILABLE_MESSAGE));
    return form;
  }

  const formError = w.state.errors.find((e) => !e.param);
  if (formError) form.appendChild(el(w, 'div', 'atlas-embed-form-error', w.errorText(formError)));

  // Each field registers a reader that produces its string value at submit —
  // this is what lets one loop collect text, dropdowns, checkboxes, radio and
  // multi-select uniformly.
  const readers = new Map<string, () => string>();
  const addField = (
    name: string,
    label: string,
    opts: {
      type?: string;
      required?: boolean;
      placeholder?: string | null;
      options?: string[];
      autocomplete?: string;
    },
  ) => {
    const type = opts.type ?? 'text';
    const asLabel = type === 'radio' || type === 'multiselect';
    const field = el(w, asLabel ? 'fieldset' : 'label', cls(w, 'field', 'atlas-embed-field'));
    field.appendChild(
      el(
        w,
        asLabel ? 'legend' : 'span',
        cls(w, 'label', 'atlas-embed-label'),
        opts.required ? label : `${label} (optional)`,
      ),
    );
    const document = doc(w);

    if (type === 'select') {
      const select = document.createElement('select');
      select.className = cls(w, 'input', 'atlas-embed-input');
      select.name = name;
      const blank = document.createElement('option');
      blank.value = '';
      blank.textContent = opts.placeholder || 'Select…';
      select.appendChild(blank);
      for (const o of opts.options ?? []) {
        const element = document.createElement('option');
        element.value = o;
        element.textContent = o;
        select.appendChild(element);
      }
      field.appendChild(select);
      readers.set(name, () => select.value);
    } else if (type === 'textarea') {
      const area = document.createElement('textarea');
      area.className = cls(w, 'input', 'atlas-embed-input');
      area.name = name;
      area.rows = 3;
      if (opts.placeholder) area.setAttribute('placeholder', opts.placeholder);
      field.appendChild(area);
      readers.set(name, () => area.value);
    } else if (type === 'checkbox') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.name = name;
      box.className = 'atlas-embed-checkbox';
      field.classList.add('atlas-embed-field-checkbox');
      field.appendChild(box);
      readers.set(name, () => (box.checked ? 'true' : ''));
    } else if (type === 'radio' || type === 'multiselect') {
      const group = document.createElement('div');
      group.className = 'atlas-embed-choices';
      const boxes: HTMLInputElement[] = [];
      for (const choice of opts.options ?? []) {
        const row = document.createElement('label');
        row.className = 'atlas-embed-choice';
        const box = document.createElement('input');
        box.type = type === 'radio' ? 'radio' : 'checkbox';
        box.name = name;
        box.value = choice;
        boxes.push(box);
        row.appendChild(box);
        row.appendChild(el(w, 'span', undefined, choice));
        group.appendChild(row);
      }
      field.appendChild(group);
      readers.set(name, () =>
        type === 'radio'
          ? boxes.find((b) => b.checked)?.value ?? ''
          : boxes.filter((b) => b.checked).map((b) => b.value).join(', '),
      );
    } else {
      const text = document.createElement('input');
      text.className = cls(w, 'input', 'atlas-embed-input');
      text.type = type;
      text.name = name;
      if (opts.autocomplete) text.setAttribute('autocomplete', opts.autocomplete);
      if (opts.placeholder) text.setAttribute('placeholder', opts.placeholder);
      field.appendChild(text);
      readers.set(name, () => text.value);
    }

    for (const err of w.state.errors.filter((e) => e.param === name)) {
      field.appendChild(el(w, 'span', cls(w, 'error', 'atlas-embed-error'), w.errorText(err)));
    }
    form.appendChild(field);
  };

  // The tenant's fields first, then the always-present credentials.
  for (const f of w.signUpFields) {
    addField(f.key, f.label, {
      type: f.type,
      required: f.required,
      placeholder: f.placeholder,
      options: f.options,
    });
  }
  addField('identifier', 'Email address', { type: 'email', required: true, autocomplete: 'email' });
  addField('password', 'Password', { type: 'password', required: true, autocomplete: 'new-password' });

  // §5.1 legal consent — links, and a checkbox that gates the button when
  // agreement is required (no re-render, so typed values are never lost).
  // Instance policies (terms, privacy, …) replace the legacy single consent row.
  let button: HTMLButtonElement;
  const policies = mountSignUpPolicies(w, () => {
    if (button) button.disabled = w.busy || !policies?.canSubmit();
  });
  const consent = policies ? null : renderLegalConsent(w);
  if (consent) form.appendChild(consent.row);
  if (policies) form.appendChild(policies.consent);

  button = submitButton(w, COPY[w.mode].submit);
  const consentOk = () => (policies ? policies.canSubmit() : !consent?.checkbox || consent.checkbox.checked);
  button.disabled = w.busy || !consentOk();
  consent?.checkbox?.addEventListener('change', () => {
    button.disabled = w.busy || !consentOk();
  });
  form.appendChild(button);
  if (policies) form.appendChild(policies.clickwrap);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values: Record<string, string> = {};
    for (const [name, read] of readers) values[name] = read();
    // §5.1 carry the consent tick to the server (true when there is no gate).
    if (!policies) {
      void submitSignUp(w, values, consentOk());
      return;
    }
    // Scroll-mode policies are read in their dialog first; declining cancels the sign-up.
    void policies.read().then((ok) => {
      if (ok) {
        void submitSignUp(w, values, true);
        return;
      }
      const declined = w.policies.policies.find((p) => !w.policies.isChecked(p.key))?.title ?? '';
      w.state = { ...w.state, errors: [{ code: 'POLICY_DECLINED', message: policyT(w)('policy.declined', { policy: declined }) }] };
      render(w);
    });
  });

  return form;
}
