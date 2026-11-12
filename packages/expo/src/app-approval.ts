/**
 * Approve-in-your-app for the signed-in app: read the pending request (its id
 * arrives in your push notification, or by polling), show the person the
 * shuffled number choices, and answer. A thin hook over the `@atlasauth/js`
 * calls, bound to the provider's bearer-authenticated client.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { approveSignIn, denySignIn, getAppApproval, type AppApprovalDetails, type FapiClient } from '@atlasauth/js';
import { useExpoFapiClient } from './policies';

export interface AppApprovalController {
  /** The request, or null while loading / when it does not exist. */
  details: AppApprovalDetails | null;
  loading: boolean;
  /** Approve with the number the person tapped. Resolves true when the answer was accepted. */
  approve(number: string): Promise<boolean>;
  /** "This was not me". */
  deny(): Promise<boolean>;
  error: string | null;
}

/** Controller logic, separated from React so it is testable with a fake client. */
export function createAppApprovalActions(client: FapiClient, id: string) {
  return {
    load: () => getAppApproval(client, id),
    approve: async (number: string) => (await approveSignIn(client, { id, number })).ok,
    deny: async () => (await denySignIn(client, id)).ok,
  };
}

/**
 * @param id the approval id from your push or webhook; null does nothing.
 * @param pollMs while the request is pending, re-read it this often (default 3000; 0 disables).
 */
export function useAppApproval(id: string | null, pollMs = 3000): AppApprovalController {
  const client = useExpoFapiClient();
  const [details, setDetails] = useState<AppApprovalDetails | null>(null);
  const [loading, setLoading] = useState(id !== null);
  const [error, setError] = useState<string | null>(null);
  const actions = useRef<ReturnType<typeof createAppApprovalActions> | null>(null);
  actions.current = id ? createAppApprovalActions(client, id) : null;

  useEffect(() => {
    if (!id) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await actions.current?.load();
      if (!live) return;
      setDetails(next ?? null);
      setLoading(false);
      if (pollMs > 0 && next?.status === 'pending') timer = setTimeout(tick, pollMs);
    };
    setLoading(true);
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [id, pollMs]);

  const answer = useCallback(async (run: () => Promise<boolean> | undefined) => {
    const ok = (await run()) ?? false;
    setError(ok ? null : 'The answer was not accepted.');
    if (ok) setDetails((d) => (d ? { ...d, status: 'approved' } : d));
    return ok;
  }, []);

  return {
    details,
    loading,
    error,
    approve: (n) => answer(() => actions.current?.approve(n)),
    deny: async () => {
      const ok = (await actions.current?.deny()) ?? false;
      setError(ok ? null : 'The answer was not accepted.');
      if (ok) setDetails((d) => (d ? { ...d, status: 'denied' } : d));
      return ok;
    },
  };
}
