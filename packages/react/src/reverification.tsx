'use client';

import { useCallback, useRef, useState } from 'react';
import { reauthenticate, type ReauthInput } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';

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
    job?.reject(new Error('Reverification cancelled.'));
  }, []);

  return { withReverification, needsReverification, completeReverification, cancelReverification };
}
