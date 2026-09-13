import { WritableSignal, signal } from '@angular/core';
import {
  FapiClient,
  advance,
  flowFromPending,
  initialFlow,
  pollAttempt,
  shouldKeepPolling,
  type FlowState,
} from '@atlasauth/js';

/**
 * The server-driven sign-in / sign-up engine, shared by `<atlas-sign-in>` and
 * `<atlas-sign-up>` — the Angular counterpart of React's `useFlow` hook.
 *
 * It owns no decision about what comes next: every status comes back from the
 * server via `advance`, and this controller only posts whatever the current step
 * needs and re-renders the returned status. State lives in a signal so templates
 * update whether the app runs zoned or zoneless.
 */
export class AtlasFlowController {
  readonly state: WritableSignal<FlowState>;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly client: FapiClient,
    private readonly reload: () => Promise<void>,
    pending: { id: string; status: string } | null,
  ) {
    // Seeded from a redirect that came back mid-flow (e.g. OAuth needing a second
    // factor) so the user resumes at the demanded step instead of starting over.
    this.state = signal<FlowState>(pending ? flowFromPending(pending) : initialFlow);
  }

  /**
   * Advance the flow with the values the user typed. On completion, exchange the
   * one-time ticket for cookies over a same-origin request (FAPI is cross-origin
   * and cannot set the cookie on its own response), then re-boot so the rest of
   * the app sees a signed-in user.
   */
  async submit(values: Record<string, string>): Promise<void> {
    this.state.update((current) => ({ ...current, busy: true, errors: [] }));

    const next = await advance(this.client, this.state(), values);
    this.state.set(next);

    if (next.attempt?.status === 'complete') {
      if (next.ticket) {
        await this.client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket: next.ticket,
        });
      }
      await this.reload();
    } else {
      // A magic-link step may now be pollable (a link opened on another device).
      this.syncPolling();
    }
  }

  /** Start/stop the §5.3 magic-link poll to match the current state. */
  syncPolling(): void {
    if (shouldKeepPolling(this.state())) {
      this.startPolling();
    } else {
      this.stopPolling();
    }
  }

  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      void (async () => {
        const { state: next, ticket } = await pollAttempt(this.client, this.state());
        this.state.set(next);
        if (!ticket || !next.attempt) return;

        // The ticket is exchanged by a normal request, so no session token ever
        // appears in a URL.
        await this.client.post('/v1/client/tickets/exchange', {
          attempt_id: (next.attempt as { id?: string }).id,
          ticket,
        });
        await this.reload();
        this.stopPolling();
      })();
    }, 2_000);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /** Release the poll timer — call from the component's `ngOnDestroy`. */
  destroy(): void {
    this.stopPolling();
  }
}
