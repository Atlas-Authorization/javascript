import {
  canDownloadRecoveryCodes,
  copyRecoveryCodes,
  createMfaEnrollment,
  downloadRecoveryCodes,
  enrollmentOptionKey,
  enrollmentSubmitKey,
  groupSetupKey,
  mfaChoicesFrom,
  prepareSecondFactorCode,
  sendOnlyWaySecondFactorCode,
  holdsSecondFactor,
  secondFactorSendText,
  codeWaitSeconds,
  codeWaitText,
  createCodeWaits,
  type CodeWaits,
  continueOnHostedPage,
  type MfaEnrollmentController,
  type MfaEnrollmentStrategy,
} from '@atlasauth/js';
import type { AtlasWidget } from '../widget';
import { cls, doc, el } from './dom';
import { render } from './render';
import { saveRecoveryCodes, submit } from './flow';

/**
 * The sign-in's MFA steps in the widget: setting up a second factor mid-sign-in
 * (`needs_mfa_enrollment`: whichever factors the app offers, drawn from the
 * shared controller) and "Text me a code instead" /
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
  'mfa.codeWaitOne': 'You can ask for another code in 1 second.',
  'mfa.codeResent': 'Code sent.',
  'mfa.codeWaitMinutes': 'You can ask for another code in {minutes} minutes.',
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
  'signIn.forgotPassword': 'Forgot password?',
  'signUp.existingAccount': 'You already had an account. Your existing password still applies.',
  'signUp.emailConfirmed': 'Your email is confirmed. Sign in to continue.',
  'signUp.submit': 'Continue',
  'signIn.title': 'Sign in',
  'requiredAction.firstNameLabel': 'First name',
  'requiredAction.lastNameLabel': 'Last name',
  'requiredAction.sendCode': 'Email me a code',
  'requiredAction.skip': 'Skip for now',
  'requiredAction.customIntro': 'Your account needs one more step before you continue.',
  'requiredAction.verifyIntro': 'We will email a code to confirm your address.',
  'requiredAction.idvIntro': 'To continue, verify your identity with a photo ID and a selfie.',
  'requiredAction.idvStart': 'Start verification',
  'requiredAction.idvOpen': 'Open the verification page',
  'requiredAction.idvWaiting': 'Waiting for your verification to finish…',
  'requiredAction.idvCheck': "I've finished",
  'requiredAction.idvDeclined': 'We could not verify your identity. You can try again.',
  'requiredAction.idvReview': 'Your verification is being reviewed. This can take a little while.',
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
    let drawn = w.enrollment.state;
    w.enrollment.subscribe((s) => {
      // A tick redraws nothing: a redraw would throw away what's being typed.
      const tick =
        !!drawn.wait && s.wait !== drawn.wait && s.busy === drawn.busy && s.errors === drawn.errors && s.method === drawn.method && s.enrollment === drawn.enrollment && s.options === drawn.options;
      drawn = s;
      if (tick) drawCodeWait(w, s.wait ?? null);
      else queueMicrotask(() => render(w));
    });
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
  const methodButton = (m: MfaEnrollmentStrategy, into: HTMLElement[] | HTMLElement) => {
    const b = el(w, 'button', 'atlas-embed-step-back', say(w, enrollmentOptionKey(m))) as HTMLButtonElement;
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
  } else if (s.method === 'yubikey') {
    helpers.addField('otp', say(w, 'mfa.yubikeyLabel'), 'text', 'off');
  } else if (s.method === 'duo' || s.method === 'passkey') {
    const e = s.enrollment;
    if (!e) {
      const note = el(w, 'p', 'atlas-embed-note', s.busy ? say(w, 'mfa.enrollPreparing') : '');
      note.setAttribute('aria-live', 'polite');
      form.appendChild(note);
    } else if (s.method === 'passkey') {
      form.appendChild(el(w, 'p', 'atlas-embed-note', say(w, 'mfa.enrollPasskeyHelp')));
    } else {
      form.appendChild(el(w, 'p', 'atlas-embed-note', say(w, 'mfa.enrollDuoHelp')));
      if (e.authorizationUrl) {
        const open = el(w, 'a', 'atlas-embed-step-back', say(w, 'mfa.enrollDuoOpen')) as HTMLAnchorElement;
        open.setAttribute('data-atlas', 'mfa-duo-open');
        open.href = e.authorizationUrl;
        open.target = '_blank';
        open.rel = 'noopener noreferrer';
        form.appendChild(open);
      }
    }
  } else if (s.method === 'totp' || s.method === 'hotp') {
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
      if (s.method === 'totp' && s.totpCodes >= 2) helpers.addCodeField('secondCode', say(w, 'mfa.enrollSecondCodeLabel'), false);
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
    again.disabled = w.busy || s.busy || !!s.wait;
    if (s.wait) again.setAttribute('data-atlas-waiting', '');
    again.addEventListener('click', () => void enrol.resend());
    helpers.trailing.push(again);
  }
  if (s.resent) {
    const again = el(w, 'p', 'atlas-embed-note', say(w, 'mfa.codeResent'));
    again.setAttribute('data-atlas', 'mfa-code-resent');
    again.setAttribute('aria-live', 'polite');
    form.appendChild(again);
  }
  if (s.wait) form.appendChild(codeWaitLine(w, s.wait, !!s.waitTicking));
  for (const error of s.errors) {
    const p = el(w, 'p', 'atlas-embed-error', w.errorText(error));
    p.setAttribute('role', 'alert');
    form.appendChild(p);
  }
  if (s.method !== null && s.options.length > 1) {
    for (const other of s.options.filter((m) => m !== s.method)) methodButton(other, helpers.trailing);
  }
  const key = enrollmentSubmitKey(s);
  return key === null ? null : key === 'signIn.submit' ? submitLabel : say(w, key);
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
const onlyWaySent = new WeakMap<AtlasWidget, string>();
const heldAsked = new WeakMap<AtlasWidget, string>();
const heldAnswer = new WeakMap<AtlasWidget, Set<string>>();
const codeWaits = new WeakMap<AtlasWidget, CodeWaits>();

function codeWaitLine(w: AtlasWidget, left: number, ticking: boolean): HTMLElement {
  const line = el(w, 'p', 'atlas-embed-error', codeWaitText(left, (key, vars) => say(w, key, vars)));
  line.setAttribute('data-atlas', 'code-wait');
  line.setAttribute('role', ticking ? 'timer' : 'alert');
  return line;
}

/** One second of a wait, in place. At zero the line goes and the button comes back. */
function drawCodeWait(w: AtlasWidget, left: number | null): void {
  const line = w.root.querySelector('[data-atlas="code-wait"]');
  if (left === null) {
    line?.remove();
    for (const b of Array.from(w.root.querySelectorAll<HTMLButtonElement>('[data-atlas-waiting]'))) {
      b.removeAttribute('data-atlas-waiting');
      b.disabled = w.busy;
    }
  } else if (line) {
    line.textContent = codeWaitText(left, (key, vars) => say(w, key, vars));
    line.setAttribute('role', 'timer');
  }
}

function startCodeWait(w: AtlasWidget, id: string, strategy: 'sms' | 'email_code', seconds: number, sentTo?: string): void {
  let waits = codeWaits.get(w);
  if (!waits) codeWaits.set(w, (waits = createCodeWaits()));
  const running = waits;
  running.start(strategy, seconds, ({ wait, ticking }) => {
    if (w.state.attempt?.id !== id) {
      running.stopAll();
      return;
    }
    w.secondFactorCode = { attemptId: id, strategy, sentTo, wait, ticking };
    if (ticking || wait === null) drawCodeWait(w, wait);
    else render(w);
  });
}

export function renderSecondFactorAlternatives(w: AtlasWidget, trailing: HTMLElement[]): void {
  const id = w.state.attempt?.id;
  if (!id) return;
  const choices = mfaChoicesFrom(w.account);
  if (heldAsked.get(w) !== id) {
    heldAsked.set(w, id);
    heldAnswer.delete(w);
    // Options are drawn hidden until the account's answer is in, then shown or dropped in place.
    for (const factor of ['passkey', 'sms', 'email_code'] as const) {
      void holdsSecondFactor(w.client, id, factor).then((held) => {
        if (heldAsked.get(w) !== id) return;
        let answer = heldAnswer.get(w);
        if (!answer) heldAnswer.set(w, (answer = new Set()));
        answer.add(`${factor}:${held}`);
        for (const b of Array.from(w.root.querySelectorAll<HTMLElement>(`[data-atlas-factor="${factor}"]`))) {
          if (held) b.style.display = '';
          else b.remove();
        }
      });
    }
  }
  // Once per attempt, on arrival: send the code if that channel is the only way.
  if ((choices.emailCode || choices.sms) && onlyWaySent.get(w) !== id) {
    onlyWaySent.set(w, id);
    const channels: ('sms' | 'email_code')[] = [...(choices.sms ? (['sms'] as const) : []), ...(choices.emailCode ? (['email_code'] as const) : [])];
    for (const strategy of channels) {
      const limited = (seconds: number) => {
        if (w.state.attempt?.id !== id) return;
        startCodeWait(w, id, strategy, seconds);
      };
      void sendOnlyWaySecondFactorCode(w.client, id, strategy, limited).then((sentTo) => {
        if (!sentTo || w.state.attempt?.id !== id) return;
        w.secondFactorCode = { attemptId: id, strategy, sentTo };
        render(w);
      });
    }
  }
  const sent = w.secondFactorCode && w.secondFactorCode.attemptId === id ? w.secondFactorCode : null;
  const offer: ('sms' | 'email_code')[] = [];
  if (choices.sms) offer.push('sms');
  if (choices.emailCode) offer.push('email_code');
  for (const strategy of offer) {
    if (heldAnswer.get(w)?.has(`${strategy}:false`)) continue;
    const name = strategy === 'sms' ? 'sms-second-factor' : 'email-second-factor';
    const mine = sent?.strategy === strategy ? sent : null;
    const wasSent = mine?.sentTo !== undefined;
    if (wasSent) {
      const note = el(
        w,
        'p',
        'atlas-embed-note',
        strategy === 'sms' ? say(w, 'mfa.codeTextedTo', { phone: mine!.sentTo! }) : say(w, 'signIn.codeSentTo', { email: mine!.sentTo! }),
      );
      note.setAttribute('data-atlas', `${name}-sent`);
      note.setAttribute('aria-live', 'polite');
      trailing.push(note);
    }
    const busy = mine?.busy === true;
    const label = busy ? 'signIn.sending' : wasSent || mine?.error || mine?.wait !== undefined ? 'signIn.resendCode' : strategy === 'sms' ? 'mfa.smsCodeOption' : 'signIn.emailCodeOption';
    const b = el(w, 'button', 'atlas-embed-step-back', say(w, label)) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('data-atlas', wasSent ? `${name}-resend` : name);
    b.disabled = w.busy || busy || !!mine?.wait;
    if (mine?.wait) b.setAttribute('data-atlas-waiting', '');
    b.setAttribute('data-atlas-factor', strategy);
    if (!heldAnswer.get(w)?.has(`${strategy}:true`)) b.style.display = 'none';
    b.addEventListener('click', () => {
      const before = mine?.sentTo;
      codeWaits.get(w)?.stop(strategy);
      w.secondFactorCode = { attemptId: id, strategy, sentTo: before, busy: true };
      render(w);
      prepareSecondFactorCode(w.client, id, strategy).then(
        ({ sentTo }) => {
          w.secondFactorCode = { attemptId: id, strategy, sentTo, resent: before !== undefined };
          // A wrong code's message no longer applies once a new code has gone out.
          w.state = { ...w.state, errors: [] };
          render(w);
        },
        (error: unknown) => {
          const seconds = codeWaitSeconds(error);
          if (seconds !== null) {
            startCodeWait(w, id, strategy, seconds, before);
            return;
          }
          w.secondFactorCode = { attemptId: id, strategy, sentTo: before, error: secondFactorSendText(error, (key, vars) => say(w, key, vars)) };
          render(w);
        },
      );
    });
    trailing.push(b);
    if (mine?.resent) {
      const again = el(w, 'p', 'atlas-embed-note', say(w, 'mfa.codeResent'));
      again.setAttribute('data-atlas', `${name}-resent`);
      again.setAttribute('aria-live', 'polite');
      trailing.push(again);
    }
    if (mine?.wait) trailing.push(codeWaitLine(w, mine.wait, !!mine.ticking));
    if (mine?.error) {
      const p = el(w, 'p', 'atlas-embed-error', mine.error);
      p.setAttribute('role', 'alert');
      trailing.push(p);
    }
  }
  if (choices.passkey && !heldAnswer.get(w)?.has('passkey:false')) {
    const b = el(w, 'button', 'atlas-embed-step-back', say(w, 'mfa.enrollPasskeyOption')) as HTMLButtonElement;
    b.type = 'button';
    b.setAttribute('data-atlas', 'passkey-second-factor');
    b.setAttribute('data-atlas-factor', 'passkey');
    if (!heldAnswer.get(w)?.has('passkey:true')) b.style.display = 'none';
    b.disabled = w.busy;
    b.addEventListener('click', () => continueOnHostedPage(choices, id, 'needs_second_factor'));
    trailing.push(b);
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
