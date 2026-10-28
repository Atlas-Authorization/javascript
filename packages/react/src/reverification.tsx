'use client';

import { useCallback, useRef, useState } from 'react';
import { reauthenticate, type ReauthInput } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { useClasses, useErrorText, useText } from './components-shared';

/**
 * Clerk-parity `useReverification()`. A thin, headless wrapper over the EXISTING
 * step-up path (`@atlasauth/js`'s {@link reauthenticate} → `POST /v1/client/me/reauthenticate`)
 * — it invents no server endpoint.
 *
 * Wrap a security-sensitive action with `withReverification(action)`. It runs the
 * action; if that throws or returns a `STEP_UP_REQUIRED` (reauthentication-required)
 * signal, it flips `needsReverification` true and parks the call. The caller renders
 * its own prompt, gathers a credential, and calls `completeReverification(input)`,
 * which re-authenticates in place and retries the action ONCE — resolving the
 * original `withReverification` promise with the retry's result. `cancelReverification`
 * abandons the parked call. A wrong password throws out of `completeReverification`
 * with the parked call intact, so the prompt can let the user try again.
 */
export function useReverification(): {
  withReverification<T>(action: () => T | Promise<T>): Promise<T>;
  needsReverification: boolean;
  completeReverification(input: ReauthInput): Promise<void>;
  cancelReverification(): void;
} {
  const { publishableKey, frontendApi, locale } = useAtlas();
  const [needsReverification, setNeedsReverification] = useState(false);
  const pending = useRef<{
    action: () => unknown | Promise<unknown>;
    resolve: (value: unknown) => void;
    reject: (reason: unknown) => void;
  } | null>(null);

  // A STEP_UP_REQUIRED signal, whether it arrived as a thrown Error carrying a
  // `.code`, or as a returned FapiClient response whose `errors[]` names it.
  const isStepUp = (candidate: unknown): boolean => {
    if (!candidate || typeof candidate !== 'object') return false;
    if ((candidate as { code?: string }).code === 'STEP_UP_REQUIRED') return true;
    const errors = (candidate as { errors?: Array<{ code?: string }> }).errors;
    return Array.isArray(errors) && errors.some((error) => error?.code === 'STEP_UP_REQUIRED');
  };

  const park = <T,>(action: () => T | Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pending.current = { action, resolve: resolve as (value: unknown) => void, reject };
      setNeedsReverification(true);
    });

  const withReverification = useCallback(
    async <T,>(action: () => T | Promise<T>): Promise<T> => {
      try {
        const result = await action();
        return isStepUp(result) ? await park(action) : result;
      } catch (err) {
        if (isStepUp(err)) return await park(action);
        throw err;
      }
    },
    [],
  );

  const completeReverification = useCallback(
    async (input: ReauthInput): Promise<void> => {
      // Throws on a bad credential; the parked call is left intact so the prompt
      // can retry, and we neither clear it nor drop the flag until this resolves.
      await reauthenticate(input, { api: frontendApi, publishableKey, locale });
      const job = pending.current;
      pending.current = null;
      setNeedsReverification(false);
      if (!job) return;
      try {
        job.resolve(await job.action());
      } catch (err) {
        job.reject(err);
      }
    },
    [frontendApi, publishableKey, locale],
  );

  const cancelReverification = useCallback(() => {
    const job = pending.current;
    pending.current = null;
    setNeedsReverification(false);
    job?.reject(new Error(REVERIFICATION_CANCELLED));
  }, []);

  return { withReverification, needsReverification, completeReverification, cancelReverification };
}

/** What {@link useReverification} returns; the prompt drives it. */
export type Reverification = ReturnType<typeof useReverification>;

/** A cancelled reverification rejects the parked call with this message. */
export const REVERIFICATION_CANCELLED = 'Reverification cancelled.';

/** True for the rejection a user's own "Cancel" produces (not worth an error). */
export function isReverificationCancelled(err: unknown): boolean {
  return err instanceof Error && err.message === REVERIFICATION_CANCELLED;
}

/**
 * The drop-in "Confirm it's you" prompt for a parked {@link useReverification}
 * call. Renders nothing until a sensitive action came back `STEP_UP_REQUIRED`;
 * then it asks for the password, re-authenticates in place, and the parked
 * action retries once. The account components (`<UserProfile>`, `<ManageMfa>`,
 * `<ManagePasskeys>`, the phone and email sections) all use it, so a stale
 * session never fails a destructive action silently.
 */
export function ReverificationPrompt({
  reverification,
  name = 'reverification',
}: {
  reverification: Reverification;
  /** `data-atlas` hook for styling/tests. */
  name?: string;
}) {
  const t = useText();
  const errorText = useErrorText();
  const cls = useClasses();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!reverification.needsReverification) return null;

  const confirm = async () => {
    setError(null);
    setBusy(true);
    try {
      await reverification.completeReverification({ strategy: 'password', password });
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? errorText(err) : t('error.generic'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-atlas={name} role="dialog" aria-label={t('reverification.title')}>
      <p className={cls('text', 'atlas-text')}><strong>{t('reverification.title')}</strong></p>
      <p className={cls('text', 'atlas-text')}>{t('reverification.subtitle')}</p>
      <label className={cls('formField', 'atlas-field')}>
        <span className={cls('formFieldLabel', 'atlas-field-label')}>{t('reverification.passwordLabel')}</span>
        <input
          className={cls('formFieldInput', 'atlas-account-input')}
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </label>
      {error ? <p className={cls('formFieldError', 'atlas-error')} role="alert">{error}</p> : null}
      <button className={cls('formButtonPrimary', 'atlas-button')} type="button" disabled={busy} onClick={() => void confirm()}>
        {t('reverification.submit')}
      </button>
      <button
        className={cls('formButtonSecondary', 'atlas-button-secondary')}
        type="button"
        onClick={() => {
          setPassword('');
          setError(null);
          reverification.cancelReverification();
        }}
      >
        {t('reverification.cancel')}
      </button>
    </div>
  );
}
