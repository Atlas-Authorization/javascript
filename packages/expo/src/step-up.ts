/**
 * Re-authenticate from a native app, on the bearer session, with no sign-out.
 *
 * ```ts
 * const { withStepUp } = useStepUp({
 *   choose: ({ factors, error }) => askWithYourOwnSheet(factors, error), // → { strategy: 'totp', code } | { strategy: 'passkey' } | null
 *   passkeyAssertion: nativePasskeyAssertion(Passkey),                   // from @atlasauth/expo-passkeys
 * });
 * const res = await withStepUp(() => enrollTotp(client));
 * ```
 *
 * `choose` is only offered the factors the account holds and the refusal accepts.
 * The re-minted session token the server returns is stored by the provider's token
 * cache like any other rotated token.
 */
import { useMemo, useRef } from 'react';
import { createStepUp, type FapiClient, type StepUpFlowOptions } from '@atlasauth/js';
import { useExpoFapiClient } from './policies';

export type { StepUpChoice, StepUpFactor, StepUpRequest } from '@atlasauth/js';
export { StepUpCancelledError, stepUpRequirement } from '@atlasauth/js';

export type UseStepUpOptions = Omit<StepUpFlowOptions, 'client'>;

/** The step-up calls bound to a client; separated from React so it is testable with a fake one. */
export function createExpoStepUp(client: FapiClient, options: UseStepUpOptions) {
  return createStepUp({ client, ...options });
}

/** `withStepUp(call)` and `reauthenticate()` on the provider's bearer-authenticated client. */
export function useStepUp(options: UseStepUpOptions) {
  const client = useExpoFapiClient();
  // The latest callbacks without re-creating the actions on every render.
  const latest = useRef(options);
  latest.current = options;
  return useMemo(
    () =>
      createExpoStepUp(client, {
        choose: (request) => latest.current.choose(request),
        passkeyAssertion: (challenge) => {
          const provider = latest.current.passkeyAssertion;
          if (!provider) throw new Error('Pass passkeyAssertion to useStepUp to use a passkey.');
          return provider(challenge);
        },
        ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client],
  );
}
