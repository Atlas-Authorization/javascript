import { passkeysSupported, resetStep, type FieldError } from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { COPY } from './constants';
import { cls, doc, el, submitButton } from './dom';
import { render } from './render';
import { startReset, submit, submitReset, submitSignUp } from './flow';

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
  if (formError) form.appendChild(el(w, 'div', 'atlas-embed-form-error', formError.message));

  let subtitle: string | null = null;
  let submitLabel = 'Continue';
  let showSubmit = true;
  switch (step) {
    case 'request':
      subtitle = 'Enter your email and we’ll send you a reset code.';
      submitLabel = 'Send reset code';
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
      break;
    default:
      showSubmit = false;
      form.appendChild(el(w, 'p', 'atlas-embed-note', 'You’re all set.'));
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
    field.appendChild(el(w, 'span', cls(w, 'error', 'atlas-embed-error'), err.message));
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
    field.appendChild(el(w, 'span', cls(w, 'error', 'atlas-embed-error'), err.message));
  }
  form.appendChild(field);
}

export function renderForm(w: AtlasWidget, stepKind: string): HTMLElement {
  const form = doc(w).createElement('form');

  const formError = w.state.errors.find((e) => !e.param);
  if (formError) {
    form.appendChild(el(w, 'div', 'atlas-embed-form-error', formError.message));
  }

  const inputs = new Map<string, HTMLInputElement>();
  const errors = w.state.errors;
  const addField = (name: string, label: string, type: string, autocomplete: string) =>
    fieldInto(w, form, inputs, errors, name, label, type, autocomplete);
  const addCodeField = (name: string, label: string, autofocus: boolean) =>
    codeFieldInto(w, form, inputs, errors, name, label, autofocus);

  let showSubmit = true;
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
    case 'collect_first_factor':
      addField('password', 'Password', 'password', 'current-password');
      break;
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
      break;
    case 'collect_email_code':
      addCodeField('code', 'Verification code', true);
      break;
    case 'collect_new_password':
      addField('password', 'New password', 'password', 'new-password');
      break;
    case 'enroll_second_factor':
      addCodeField('code', 'Authenticator code', true);
      addCodeField('secondCode', 'Next code', false);
      break;
    default:
      showSubmit = false;
      form.appendChild(el(w, 'p', 'atlas-embed-note', 'Please continue in your application.'));
  }

  if (showSubmit) {
    form.appendChild(submitButton(w, COPY[w.mode].submit));
  }

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
  // only when password sign-in is actually on.
  const passwordStep =
    (stepKind === 'collect_identifier' && w.mode === 'sign-in' && w.passwordEnabled) ||
    stepKind === 'collect_first_factor';
  if (passwordStep) {
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
export function renderSignUpForm(w: AtlasWidget): HTMLElement {
  const form = doc(w).createElement('form');

  const formError = w.state.errors.find((e) => !e.param);
  if (formError) form.appendChild(el(w, 'div', 'atlas-embed-form-error', formError.message));

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
      field.appendChild(el(w, 'span', cls(w, 'error', 'atlas-embed-error'), err.message));
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
  const consent = renderLegalConsent(w);
  if (consent) form.appendChild(consent.row);

  const button = submitButton(w, COPY[w.mode].submit);
  const consentOk = () => !consent?.checkbox || consent.checkbox.checked;
  button.disabled = w.busy || !consentOk();
  consent?.checkbox?.addEventListener('change', () => {
    button.disabled = w.busy || !consentOk();
  });
  form.appendChild(button);

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const values: Record<string, string> = {};
    for (const [name, read] of readers) values[name] = read();
    // §5.1 carry the consent tick to the server (true when there is no gate).
    void submitSignUp(w, values, consentOk());
  });

  return form;
}
