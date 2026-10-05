import { useCallback, useMemo } from 'react';
import { startSignUp } from '@atlasauth/js';
import { useAtlas } from './AtlasProvider';
import { FapiClient, type FlowState } from './fapi';
import { AttemptFlow, useFlow, type FlowProps } from './flow';

export function SignUp(props: FlowProps = {}) {
  const { state, submit } = useFlow({ afterUrl: props.afterUrl });

  return (
    <AttemptFlow
      attempt={state.attempt}
      busy={state.busy}
      errors={state.errors}
      titleKey="signUp.title"
      hideTitle={props.hideTitle}
      onSubmit={submit}
    />
  );
}

/**
 * §5.1 headless sign-up — the sign-up counterpart of {@link useSignIn}. Starts a
 * sign-up attempt and returns the resulting flow (usually `needs_email_verification`;
 * the shared `advance` then drives the code to completion), reloading the provider
 * when a sign-up completes with a session ticket.
 */
export function useSignUp() {
  const { publishableKey, frontendApi, reload } = useAtlas();
  const client = useMemo(
    () => new FapiClient({ publishableKey, baseUrl: frontendApi }),
    [frontendApi, publishableKey],
  );
  const create = useCallback(
    async (input: {
      email: string;
      password: string;
      fields?: Record<string, string>;
      consent?: boolean;
      captchaToken?: string;
    }): Promise<FlowState> => {
      const next = await startSignUp(client, input);
      if (next.attempt?.status === 'complete' && next.ticket) {
        await client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
        await reload();
      }
      return next;
    },
    [client, reload],
  );
  return { create };
}
