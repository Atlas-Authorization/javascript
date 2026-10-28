'use client';

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  canDownloadRecoveryCodes,
  copyRecoveryCodes,
  createMfaEnrollment,
  downloadRecoveryCodes,
  groupSetupKey,
  mfaChoicesFrom,
  prepareDuo,
  prepareSecondFactorCode,
  type MfaChoices,
  type MfaEnrollmentController,
  type MfaEnrollmentState,
} from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useClass, useClasses, useFapiClient, useText } from './components-shared';

/**
 * The sign-in's MFA steps for `<SignIn>`: setting up a second factor when the
 * app requires one (`needs_mfa_enrollment`) and the texted / emailed code at the
 * second-factor step. The requests and the step's state live in
 * `@atlasauth/js` (`createMfaEnrollment`), shared with every framework SDK.
 */

/** What the instance lets the MFA steps offer (`account.mfa`, `account.emailSecondFactor`). */
export function useMfaChoices(): MfaChoices {
  const { instanceSettings } = useAtlas();
  return mfaChoicesFrom(instanceSettings?.account);
}

/**
 * The enrolment step's controller and state, started for `attemptId` while
 * `active` (the flow is at `needs_mfa_enrollment`) and reset when it leaves.
 */
export function useMfaEnrollment(
  attemptId: string | null,
  active: boolean,
): { controller: MfaEnrollmentController; state: MfaEnrollmentState } {
  const client = useFapiClient();
  const choices = useMfaChoices();
  const choicesRef = useRef(choices);
  choicesRef.current = choices;
  const controller = useMemo(() => createMfaEnrollment(client, () => choicesRef.current), [client]);
  const [state, setState] = useState(controller.state);
  useEffect(() => controller.subscribe(setState), [controller]);
  useEffect(() => {
    if (active && attemptId) controller.start(attemptId);
    else controller.reset();
  }, [controller, active, attemptId]);
  return { controller, state };
}

/**
 * The enrolment step's body: the method choice, the authenticator's QR code and
 * setup key with its code field(s), or the phone number then the texted code.
 * `field` draws an input the way the rest of the form does.
 */
export function MfaEnrollmentFields({
  controller,
  state,
  busy,
  field,
  clearValues,
}: {
  controller: MfaEnrollmentController;
  state: MfaEnrollmentState;
  busy: boolean;
  field: (name: string, labelKey: string, type?: string, extra?: { autoComplete?: string; inputMode?: 'numeric' | 'tel' }) => ReactNode;
  clearValues: () => void;
}) {
  const t = useText();
  const cls = useClasses();
  const errorClass = useClass('formFieldError', 'atlas-error');
  const secondaryClass = useClass('formButtonSecondary', 'atlas-button-secondary');
  const { method, enrollment, options } = state;
  const out: ReactNode[] = [];

  if (method === null) {
    out.push(
      <p key="choose" className={cls('text', 'atlas-text')}>
        {t('mfa.enrollChoose')}
      </p>,
      ...options.map((m) => (
        <button
          key={m}
          type="button"
          className={secondaryClass}
          data-atlas-mfa-method={m}
          disabled={busy || state.busy}
          onClick={() => {
            clearValues();
            void controller.choose(m);
          }}
        >
          {t(m === 'totp' ? 'mfa.enrollTotpOption' : 'mfa.enrollSmsOption')}
        </button>
      )),
    );
  } else if (method === 'totp') {
    if (!enrollment) {
      out.push(
        <p key="preparing" className={cls('text', 'atlas-text')} aria-live="polite">
          {state.busy ? t('mfa.enrollPreparing') : null}
        </p>,
      );
    } else {
      out.push(
        <p key="scan" className={cls('text', 'atlas-text')}>
          {t('mfa.enrollScan')}
        </p>,
      );
      if (enrollment.qrCode) {
        out.push(
          <img key="qr" className="atlas-mfa-qr" data-atlas="mfa-qr" src={enrollment.qrCode} alt={t('mfa.enrollQrAlt')} width={180} height={180} />,
        );
      }
      if (enrollment.secret) {
        out.push(
          <p key="secret" className={cls('text', 'atlas-text')} data-atlas="mfa-setup-key">
            {t('mfa.enrollSetupKey')}: <code>{groupSetupKey(enrollment.secret)}</code>
          </p>,
        );
      }
      out.push(field('code', 'mfa.enrollFirstCodeLabel', 'text', { autoComplete: 'one-time-code', inputMode: 'numeric' }));
      if (state.totpCodes >= 2) {
        out.push(field('secondCode', 'mfa.enrollSecondCodeLabel', 'text', { autoComplete: 'one-time-code', inputMode: 'numeric' }));
      }
    }
  } else if (!enrollment) {
    out.push(
      field('phone', 'mfa.phoneLabel', 'tel', { autoComplete: 'tel', inputMode: 'tel' }),
      <p key="phone-hint" className={cls('text', 'atlas-text')}>
        {t('mfa.phoneHint')}
      </p>,
    );
  } else {
    out.push(
      <p key="texted" className={cls('text', 'atlas-text')} data-atlas="mfa-code-texted" aria-live="polite">
        {t('mfa.codeTextedTo', { phone: enrollment.phone ?? '' })}
      </p>,
      field('code', 'mfa.codeLabel', 'text', { autoComplete: 'one-time-code', inputMode: 'numeric' }),
      <button
        key="resend"
        type="button"
        className={cls('link', 'atlas-link')}
        data-atlas-resend=""
        disabled={busy || state.busy}
        onClick={() => void controller.resend()}
      >
        {t('signIn.resendCode')}
      </button>,
    );
  }

  for (const error of state.errors) {
    out.push(
      <p key={`enrol-error-${error.code}-${error.param ?? ''}`} className={errorClass} role="alert">
        {error.message}
      </p>,
    );
  }

  if (method !== null && options.length > 1) {
    const other = options.find((m) => m !== method)!;
    out.push(
      <button
        key="switch"
        type="button"
        className={cls('link', 'atlas-link')}
        data-atlas-mfa-method={other}
        disabled={busy || state.busy}
        onClick={() => {
          clearValues();
          void controller.choose(other);
        }}
      >
        {t(other === 'totp' ? 'mfa.enrollTotpOption' : 'mfa.enrollSmsOption')}
      </button>,
    );
  }
  return <>{out}</>;
}

/**
 * "Text me a code instead" / "Email me a code instead" at the second factor:
 * sends the code for this attempt, then says where it went. The code is typed
 * into the step's code field like any second-factor code.
 */
export function SecondFactorCodeOption({ attemptId, strategy }: { attemptId: string; strategy: 'sms' | 'email_code' }) {
  const client = useFapiClient();
  const t = useText();
  const cls = useClasses();
  const [state, setState] = useState<{ sentTo?: string; error?: string; busy?: boolean }>({});
  const name = strategy === 'sms' ? 'sms-second-factor' : 'email-second-factor';
  const send = () => {
    setState({ busy: true });
    prepareSecondFactorCode(client, attemptId, strategy)
      .then(({ sentTo }) => setState({ sentTo }))
      .catch((e: unknown) => setState({ error: e instanceof Error ? e.message : String(e) }));
  };
  if (state.sentTo !== undefined) {
    return (
      <p className={cls('text', 'atlas-text')} data-atlas={`${name}-sent`} aria-live="polite">
        {strategy === 'sms' ? t('mfa.codeTextedTo', { phone: state.sentTo }) : t('signIn.codeSentTo', { email: state.sentTo })}
      </p>
    );
  }
  return (
    <>
      <button type="button" className={cls('link', 'atlas-link')} data-atlas={name} disabled={state.busy} onClick={send}>
        {state.busy ? t('signIn.sending') : t(strategy === 'sms' ? 'mfa.smsCodeOption' : 'signIn.emailCodeOption')}
      </button>
      {state.error ? (
        <div className={cls('alert', 'atlas-alert')} role="alert">
          {state.error}
        </div>
      ) : null}
    </>
  );
}

const RECOVERY_LIST_STYLE = {
  listStyle: 'none',
  padding: 0,
  margin: '8px 0 12px',
  display: 'grid',
  gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
  gap: 6,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  textAlign: 'center',
} as const;

/**
 * The recovery codes a mid-sign-in enrolment came with, shown once before the
 * sign-in finishes: copy them, download them as a .txt file, then "I've saved
 * my codes" (`onSaved`) exchanges the ticket. The codes live only in the flow's
 * memory and are forgotten once saved.
 */
export function RecoveryCodes({ codes, busy, onSaved }: { codes: string[]; busy: boolean; onSaved(): void }) {
  const t = useText();
  const cls = useClasses();
  const cardClass = useClass('card', 'atlas-card');
  const titleClass = useClass('headerTitle', 'atlas-title');
  const buttonClass = useClass('formButtonPrimary', 'atlas-button');
  const secondaryClass = useClass('formButtonSecondary', 'atlas-button-secondary');
  const [copied, setCopied] = useState(false);
  const canCopy = typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
  return (
    <div className={cardClass} data-atlas="recovery-codes">
      <h1 className={titleClass}>{t('mfa.recoveryCodesTitle')}</h1>
      <p className={cls('text', 'atlas-text')}>{t('mfa.recoveryCodesHelp')}</p>
      <ul data-atlas="recovery-codes-list" style={RECOVERY_LIST_STYLE}>
        {codes.map((code) => (
          <li key={code}>
            <code>{code}</code>
          </li>
        ))}
      </ul>
      <div className="atlas-alternatives">
        {canCopy ? (
          <button
            type="button"
            className={secondaryClass}
            data-atlas="recovery-codes-copy"
            onClick={() => void copyRecoveryCodes(codes).then(setCopied)}
          >
            {t('mfa.recoveryCodesCopy')}
          </button>
        ) : null}
        {canDownloadRecoveryCodes() ? (
          <button
            type="button"
            className={secondaryClass}
            data-atlas="recovery-codes-download"
            onClick={() => downloadRecoveryCodes(codes)}
          >
            {t('mfa.recoveryCodesDownload')}
          </button>
        ) : null}
      </div>
      {copied ? (
        <p className={cls('text', 'atlas-text')} aria-live="polite" data-atlas="recovery-codes-copied">
          {t('mfa.recoveryCodesCopied')}
        </p>
      ) : null}
      <button type="button" className={buttonClass} data-atlas="recovery-codes-saved" disabled={busy} onClick={onSaved}>
        {t('mfa.recoveryCodesSaved')}
      </button>
    </div>
  );
}

const DUO_POLL_MS = 2500;
const DUO_POLL_LIMIT = 120;

/**
 * "Use Duo instead" at the second-factor step. Opens Duo's prompt in a window and polls the
 * sign-in (`onSubmit({ strategy: "duo" })`) until Duo's callback has approved this attempt,
 * which completes the sign-in. The strings are English; wrap the component to localise.
 */
export function DuoSecondFactorOption({ attemptId, onSubmit }: { attemptId: string; onSubmit(values: Record<string, string>): void }) {
  const client = useFapiClient();
  const cls = useClasses();
  const [state, setState] = useState<{ waiting?: boolean; busy?: boolean; error?: string }>({});
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);
  const start = async () => {
    setState({ busy: true });
    // The popup must open from the click, before the request resolves.
    const popup = typeof window !== 'undefined' ? window.open('', 'atlas_duo', 'width=480,height=720') : null;
    const { prompt, response } = await prepareDuo(client, attemptId);
    if (!prompt) {
      popup?.close();
      setState({ error: response.errors[0]?.message ?? 'Duo is not available right now.' });
      return;
    }
    if (popup) popup.location.href = prompt.authorizationUrl;
    else if (typeof window !== 'undefined') window.location.assign(prompt.authorizationUrl);
    setState({ waiting: true });
    let polls = 0;
    stop();
    timer.current = setInterval(() => {
      polls += 1;
      if (polls > DUO_POLL_LIMIT) {
        stop();
        setState({ error: 'Duo did not confirm in time. Try again.' });
        return;
      }
      onSubmit({ strategy: 'duo' });
    }, DUO_POLL_MS);
  };
  if (state.waiting) {
    return (
      <p className={cls('text', 'atlas-text')} data-atlas="duo-waiting" aria-live="polite">
        Approve the request in the Duo window. You will be signed in here when it is confirmed.
      </p>
    );
  }
  return (
    <>
      <button type="button" className={cls('link', 'atlas-link')} data-atlas="duo-second-factor" disabled={state.busy} onClick={() => void start()}>
        Use Duo instead
      </button>
      {state.error ? (
        <div className={cls('alert', 'atlas-alert')} role="alert">
          {state.error}
        </div>
      ) : null}
    </>
  );
}
