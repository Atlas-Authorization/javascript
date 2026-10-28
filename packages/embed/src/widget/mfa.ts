import {
  canDownloadRecoveryCodes,
  copyRecoveryCodes,
  createMfaEnrollment,
  downloadRecoveryCodes,
  enrollmentSubmitKey,
  groupSetupKey,
  mfaChoicesFrom,
  prepareSecondFactorCode,
  type MfaEnrollmentController,
} from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { cls, doc, el } from './dom';
import { render } from './render';
import { saveRecoveryCodes, submit } from './flow';

/**
 * The sign-in's MFA steps in the widget: setting up a second factor mid-sign-in
 * (`needs_mfa_enrollment`: the authenticator app with its QR code and setup
 * key, or a texted code where the app can text) and "Text me a code instead" /
 * "Email me a code instead" at the second-factor step. The requests and the
 * enrolment state come from `@atlasauth/js`, shared with the framework SDKs.
 *
 * Strings use the `mfa.*` keys of the widget's `localization` catalog (e.g. a
 * bundle from `@atlasauth/localizations`), else English.
 */
const EN: Record<string, string> = {
  'mfa.enrollChoose': 'Set up a second step for signing in.',
  'mfa.enrollTotpOption': 'Use an authenticator app',
  'mfa.enrollSmsOption': 'Use text messages',
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
  'mfa.codeLabel': 'Code',
  'mfa.smsCodeOption': 'Text me a code instead',
  'mfa.recoveryCodesTitle': 'Save your recovery codes',
  'mfa.recoveryCodesHelp': "Each code works once. If you can't use your second step, sign in with one of these. Keep them somewhere safe: they won't be shown again.",
  'mfa.recoveryCodesCopy': 'Copy codes',
  'mfa.recoveryCodesCopied': 'Copied.',
  'mfa.recoveryCodesDownload': 'Download as .txt',
  'mfa.recoveryCodesSaved': "I've saved my codes",
  'signIn.emailCodeOption': 'Email me a code instead',
  'signIn.codeSentTo': 'We sent a code to {email}. Enter it below.',
  'signIn.resendCode': 'Resend code',
  'signIn.sending': 'Sending…',
};

/** A string in the widget's language: its `localization` catalog, else English. */
export function say(w: AtlasWidget, key: string, vars: Record<string, string> = {}): string {
  const catalog = w.options.localization as unknown;
  const own =
    typeof catalog === 'function'
      ? (catalog as (k: string) => unknown)(key)
      : catalog && typeof catalog === 'object'
        ? (catalog as Record<string, unknown>)[key]
        : undefined;
  const template = typeof own === 'string' && own.trim() ? own : (EN[key] ?? key);
  return template.replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}

/** The enrolment controller for the current attempt (created once, started per attempt). */
export function enrollmentFor(w: AtlasWidget): MfaEnrollmentController | null {
  const id = w.state.attempt?.id;
  if (!id) return null;
  if (!w.enrollment) {
    w.enrollment = createMfaEnrollment(w.client, () => mfaChoicesFrom(w.account));
    // Redraw after the step's own requests; deferred, so a change raised while
    // the panel is being drawn never redraws inside that draw.
    w.enrollment.subscribe(() => queueMicrotask(() => render(w)));
  }
  w.enrollment.start(id);
  return w.enrollment;
}

/**
 * Draw the enrolment step into `form`. Returns the submit button's label, or
 * null when the step has nothing to submit yet (choosing a method, or fetching
 * the authenticator's setup).
 */
export function renderEnrollment(
  w: AtlasWidget,
  form: HTMLElement,
  helpers: {
    addField: (name: string, label: string, type: string, autocomplete: string) => void;
    addCodeField: (name: string, label: string, autofocus: boolean) => void;
    trailing: HTMLElement[];
  },
  submitLabel: string,
): string | null {
  const enrol = enrollmentFor(w);
  if (!enrol) return submitLabel;
  const s = enrol.state;
  const methodButton = (m: 'totp' | 'phone_code', into: HTMLElement[] | HTMLElement) => {
    const b = el(w, 'button', 'atlas-embed-step-back', say(w, m === 'totp' ? 'mfa.enrollTotpOption' : 'mfa.enrollSmsOption')) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('data-atlas-mfa-method', m);
    b.disabled = w.busy || s.busy;
    b.addEventListener('click', () => void enrol.choose(m));
    if (Array.isArray(into)) into.push(b);
    else into.appendChild(b);
  };

  if (s.method === null) {
    form.appendChild(el(w, 'p', 'atlas-embed-note', say(w, 'mfa.enrollChoose')));
    for (const m of s.options) methodButton(m, form);
  } else if (s.method === 'totp') {
    const e = s.enrollment;
    if (!e) {
      const note = el(w, 'p', 'atlas-embed-note', s.busy ? say(w, 'mfa.enrollPreparing') : '');
      note.setAttribute('aria-live', 'polite');
      form.appendChild(note);
    } else {
      form.appendChild(el(w, 'p', 'atlas-embed-note', say(w, 'mfa.enrollScan')));
      if (e.qrCode) {
        const img = doc(w).createElement('img');
        img.className = 'atlas-embed-mfa-qr';
        img.setAttribute('data-atlas', 'mfa-qr');
        img.src = e.qrCode;
        img.alt = say(w, 'mfa.enrollQrAlt');
        img.width = 180;
        img.height = 180;
        form.appendChild(img);
      }
      if (e.secret) {
        const key = el(w, 'p', 'atlas-embed-note', `${say(w, 'mfa.enrollSetupKey')}: `);
        key.setAttribute('data-atlas', 'mfa-setup-key');
        key.appendChild(el(w, 'code', 'atlas-embed-mfa-key', groupSetupKey(e.secret)));
        form.appendChild(key);
      }
      helpers.addCodeField('code', say(w, 'mfa.enrollFirstCodeLabel'), true);
      if (s.totpCodes >= 2) helpers.addCodeField('secondCode', say(w, 'mfa.enrollSecondCodeLabel'), false);
    }
  } else if (!s.enrollment) {
    helpers.addField('phone', say(w, 'mfa.phoneLabel'), 'tel', 'tel');
    form.appendChild(el(w, 'p', 'atlas-embed-note', say(w, 'mfa.phoneHint')));
  } else {
    const note = el(w, 'p', 'atlas-embed-note', say(w, 'mfa.codeTextedTo', { phone: s.enrollment.phone ?? '' }));
    note.setAttribute('data-atlas', 'mfa-code-texted');
    form.appendChild(note);
    helpers.addCodeField('code', say(w, 'mfa.codeLabel'), true);
    const again = el(w, 'button', 'atlas-embed-step-back', say(w, 'signIn.resendCode')) as HTMLButtonElement;
    again.type = 'button';
    again.setAttribute('data-atlas-resend', '');
    again.disabled = w.busy || s.busy;
    again.addEventListener('click', () => void enrol.resend());
    helpers.trailing.push(again);
  }
  for (const error of s.errors) {
    const p = el(w, 'p', 'atlas-embed-error', w.errorText(error));
    p.setAttribute('role', 'alert');
    form.appendChild(p);
  }
  if (s.method !== null && s.options.length > 1) {
    for (const other of s.options.filter((m) => m !== s.method)) methodButton(other, helpers.trailing);
  }
  const key = enrollmentSubmitKey(s);
  return key === null ? null : key === 'mfa.sendCode' ? say(w, 'mfa.sendCode') : submitLabel;
}

/** The enrolment form's submit: text the code to the typed number, or confirm the factor. */
export async function submitEnrollment(w: AtlasWidget, values: Record<string, string>): Promise<void> {
  const enrol = enrollmentFor(w);
  if (!enrol) return;
  const next = await enrol.submit(values);
  if (next) await submit(w, next);
}

/**
 * "Text me a code instead" / "Email me a code instead" at the second-factor
 * step, where the app offers them; once sent, the line saying where it went.
 */
export function renderSecondFactorAlternatives(w: AtlasWidget, trailing: HTMLElement[]): void {
  const id = w.state.attempt?.id;
  if (!id) return;
  const choices = mfaChoicesFrom(w.account);
  const sent = w.secondFactorCode && w.secondFactorCode.attemptId === id ? w.secondFactorCode : null;
  const offer: ('sms' | 'email_code')[] = [];
  if (choices.sms) offer.push('sms');
  if (choices.emailCode) offer.push('email_code');
  for (const strategy of offer) {
    const name = strategy === 'sms' ? 'sms-second-factor' : 'email-second-factor';
    if (sent?.strategy === strategy && sent.sentTo !== undefined) {
      const note = el(
        w,
        'p',
        'atlas-embed-note',
        strategy === 'sms' ? say(w, 'mfa.codeTextedTo', { phone: sent.sentTo }) : say(w, 'signIn.codeSentTo', { email: sent.sentTo }),
      );
      note.setAttribute('data-atlas', `${name}-sent`);
      note.setAttribute('aria-live', 'polite');
      trailing.push(note);
      continue;
    }
    const busy = sent?.strategy === strategy && sent.busy === true;
    const b = el(w, 'button', 'atlas-embed-step-back', busy ? say(w, 'signIn.sending') : say(w, strategy === 'sms' ? 'mfa.smsCodeOption' : 'signIn.emailCodeOption')) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('data-atlas', name);
    b.disabled = w.busy || busy;
    b.addEventListener('click', () => {
      w.secondFactorCode = { attemptId: id, strategy, busy: true };
      render(w);
      prepareSecondFactorCode(w.client, id, strategy).then(
        ({ sentTo }) => {
          w.secondFactorCode = { attemptId: id, strategy, sentTo };
          render(w);
        },
        (error: unknown) => {
          w.secondFactorCode = { attemptId: id, strategy, error: error instanceof Error ? error.message : String(error) };
          render(w);
        },
      );
    });
    trailing.push(b);
    if (sent?.strategy === strategy && sent.error) {
      const p = el(w, 'p', 'atlas-embed-error', sent.error);
      p.setAttribute('role', 'alert');
      trailing.push(p);
    }
  }
}

/**
 * The recovery codes a mid-sign-in enrolment came with, shown once before the
 * sign-in finishes: copy them, download them as a .txt file, then
 * "I've saved my codes" exchanges the ticket. The codes live only in the
 * widget's flow state (memory) and are forgotten once saved.
 */
export function renderRecoveryCodes(w: AtlasWidget, codes: readonly string[]): HTMLElement {
  const box = el(w, 'div', 'atlas-embed-recovery-codes');
  box.setAttribute('data-atlas', 'recovery-codes');
  box.appendChild(el(w, 'h2', cls(w, 'title', 'atlas-embed-title'), say(w, 'mfa.recoveryCodesTitle')));
  box.appendChild(el(w, 'p', 'atlas-embed-note', say(w, 'mfa.recoveryCodesHelp')));
  const list = el(w, 'ul', 'atlas-embed-recovery-list');
  list.setAttribute('data-atlas', 'recovery-codes-list');
  list.setAttribute(
    'style',
    'list-style:none;padding:0;margin:8px 0 12px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;text-align:center',
  );
  for (const code of codes) {
    const li = el(w, 'li');
    li.appendChild(el(w, 'code', 'atlas-embed-mfa-key', code));
    list.appendChild(li);
  }
  box.appendChild(list);

  const nav = (doc(w).defaultView ?? globalThis).navigator as Navigator | undefined;
  if (nav?.clipboard?.writeText) {
    const copy = el(w, 'button', 'atlas-embed-step-back', say(w, 'mfa.recoveryCodesCopy')) as HTMLButtonElement;
    copy.type = 'button';
    copy.setAttribute('data-atlas', 'recovery-codes-copy');
    copy.addEventListener('click', () => {
      void copyRecoveryCodes(codes).then((ok) => {
        if (!ok || box.querySelector('[data-atlas="recovery-codes-copied"]')) return;
        const note = el(w, 'p', 'atlas-embed-note', say(w, 'mfa.recoveryCodesCopied'));
        note.setAttribute('data-atlas', 'recovery-codes-copied');
        note.setAttribute('aria-live', 'polite');
        box.insertBefore(note, saved);
      });
    });
    box.appendChild(copy);
  }
  if (canDownloadRecoveryCodes()) {
    const download = el(w, 'button', 'atlas-embed-step-back', say(w, 'mfa.recoveryCodesDownload')) as HTMLButtonElement;
    download.type = 'button';
    download.setAttribute('data-atlas', 'recovery-codes-download');
    download.addEventListener('click', () => downloadRecoveryCodes(codes));
    box.appendChild(download);
  }
  const saved = el(w, 'button', cls(w, 'buttonPrimary', 'atlas-embed-button'), say(w, 'mfa.recoveryCodesSaved')) as HTMLButtonElement;
  saved.type = 'button';
  saved.setAttribute('data-atlas', 'recovery-codes-saved');
  saved.disabled = w.busy;
  saved.addEventListener('click', () => {
    saved.disabled = true;
    void saveRecoveryCodes(w);
  });
  box.appendChild(saved);
  return box;
}
