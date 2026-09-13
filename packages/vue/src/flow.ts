import { onScopeDispose, shallowRef, watch, type ShallowRef } from 'vue';
import {
  FapiClient,
  advance,
  flowFromPending,
  pollAttempt,
  shouldKeepPolling,
  type FlowState,
} from './fapi';
import { useAtlas } from './context';

/**
 * §10.2 the server-driven sign-in / sign-up flow, as a composable.
 *
 * The Vue peer of the React SDK's internal `useFlow`. It never decides what
 * comes next — it drives the flow through `advance`, which owns the
 * step-to-endpoint mapping in `@atlasauth/js`, and renders whatever `status` the
 * server returned. `useSignIn` and `useSignUp` are the same driver; only the
 * `<SignIn>` / `<SignUp>` title differs, exactly as in React.
 */
export interface FlowController {
  /** The current server-driven attempt state. */
  state: ShallowRef<FlowState>;
  /** Post the current step's fields; the server decides the next status. */
  submit(values: Record<string, string>): void;
}

export function useFlow(): FlowController {
  const atlas = useAtlas();
  // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
  // factor), so the user resumes at the demanded step instead of starting over.
  const state = shallowRef<FlowState>(flowFromPending(atlas.pendingAttempt));

  const client = new FapiClient({
    publishableKey: atlas.publishableKey,
    baseUrl: atlas.frontendApi,
  });

  const submit = (values: Record<string, string>) => {
    void (async () => {
      state.value = { ...state.value, busy: true, errors: [] };
      const next = await advance(client, state.value, values);
      state.value = next;

      // On completion the response carries a one-time ticket (§7.1). Exchange it
      // for cookies over a same-origin request — FAPI is cross-origin to the app
      // and cannot set the cookie on the completion response itself — THEN
      // re-boot so the rest of the app sees a signed-in user.
      if (next.attempt?.status === 'complete') {
        if (next.ticket) {
          await client.post('/v1/client/tickets/exchange', {
            attempt_id: (next.attempt as { id?: string }).id,
            ticket: next.ticket,
          });
        }
        await atlas.reload();
      }
    })();
  };

  // §5.3: collect a sign-in completed by a link opened on another device. The
  // poll restarts whenever the flow state changes and only runs while the state
  // says it should — the Vue peer of React's polling effect.
  let poller: ReturnType<typeof setInterval> | null = null;
  const stopPolling = () => {
    if (poller) {
      clearInterval(poller);
      poller = null;
    }
  };

  watch(
    state,
    (current) => {
      stopPolling();
      if (!shouldKeepPolling(current)) return;

      poller = setInterval(() => {
        void (async () => {
          const { state: next, ticket } = await pollAttempt(client, state.value);
          state.value = next;
          if (!ticket || !next.attempt) return;

          // The ticket is exchanged by a normal request, so no session token has
          // ever appeared in a URL.
          await client.post('/v1/client/tickets/exchange', {
            attempt_id: (next.attempt as { id?: string }).id,
            ticket,
          });
          await atlas.reload();
        })();
      }, 2_000);
    },
    { immediate: true },
  );

  onScopeDispose(stopPolling);

  return { state, submit };
}

/** §10.2 `useSignIn()` — drive a sign-in attempt. */
export function useSignIn(): FlowController {
  return useFlow();
}

/** §10.2 `useSignUp()` — drive a sign-up attempt. */
export function useSignUp(): FlowController {
  return useFlow();
}
