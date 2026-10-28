'use client';

import { useCallback, useMemo, useState } from 'react';
import {
  continueDelegatedFlow,
  createDelegatedUiClient,
  readDelegatedChallenge,
  type DelegatedChallenge,
  type DelegatedUiClientOptions,
} from '@atlasauth/js';

/**
 * React helpers for your own login / consent pages (the page Atlas redirects
 * to with `?login_challenge=` or `?consent_challenge=`). Reading and deciding
 * the challenge goes through YOUR backend (see `delegatedUiProxy` in
 * @atlasauth/backend); this hook wraps the calls with busy/error state and
 * follows the redirect Atlas returns.
 */
export function useDelegatedChallenge(href?: string): DelegatedChallenge | null {
  return useMemo(() => {
    const where = href ?? (typeof window !== 'undefined' ? window.location.href : undefined);
    return where ? readDelegatedChallenge(where) : null;
  }, [href]);
}

export function useDelegatedFlow(opts: DelegatedUiClientOptions & { allowedOrigins?: string[]; navigate?: (url: string) => void }) {
  const { baseUrl, fetch: f, headers, allowedOrigins, navigate } = opts;
  const client = useMemo(() => createDelegatedUiClient({ baseUrl, fetch: f, headers }), [baseUrl, f, headers]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Run a call that returns `{ redirect_to }` and follow it. */
  const decide = useCallback(
    async (call: () => Promise<{ redirect_to: string }>) => {
      setBusy(true);
      setError(null);
      try {
        continueDelegatedFlow((await call()).redirect_to, { allowedOrigins, navigate });
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Request failed.');
      } finally {
        setBusy(false);
      }
    },
    [allowedOrigins, navigate],
  );

  return { client, decide, busy, error };
}
