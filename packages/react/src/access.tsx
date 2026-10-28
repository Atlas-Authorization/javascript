'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import {
  cancelAccessRequest,
  decideAccessRequest,
  decideAccessReview,
  listAccessCatalog,
  listAccessReviews,
  listMyAccess,
  listMyAccessRequests,
  listPendingApprovals,
  requestAccess,
  type AccessCatalogItem,
  type AccessGrant,
  type AccessRequest,
  type AccessReviewItem,
} from '@atlasauth/js';
import { useFapiClient } from './components-shared';

/**
 * Identity governance for the signed-in user: request access from the catalog,
 * follow requests, decide approvals waiting on you and certify access you were
 * asked to review. {@link useAccess} is the state behind it; {@link AccessRequests}
 * is a ready-made panel. The component sets no cookies and loads nothing from
 * third parties.
 */

export interface UseAccessResult {
  catalog: AccessCatalogItem[];
  grants: AccessGrant[];
  requests: AccessRequest[];
  approvals: AccessRequest[];
  reviews: AccessReviewItem[];
  loading: boolean;
  /** The reason the last action or load was refused. */
  error: string | null;
  refresh: () => Promise<void>;
  request: (entitlement: string, justification?: string, durationSeconds?: number) => Promise<boolean>;
  cancel: (id: string) => Promise<boolean>;
  decide: (id: string, decision: 'approve' | 'deny', comment?: string) => Promise<boolean>;
  review: (id: string, decision: 'certify' | 'revoke', comment?: string) => Promise<boolean>;
}

export function useAccess(): UseAccessResult {
  const client = useFapiClient();
  const [state, setState] = useState<Pick<UseAccessResult, 'catalog' | 'grants' | 'requests' | 'approvals' | 'reviews'>>({ catalog: [], grants: [], requests: [], approvals: [], reviews: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [catalog, grants, requests, approvals, reviews] = await Promise.all([listAccessCatalog(client), listMyAccess(client), listMyAccessRequests(client), listPendingApprovals(client), listAccessReviews(client)]);
    const first = [catalog, grants, requests, approvals, reviews].find((r) => !r.ok);
    setError(first && !first.ok ? (first.errors[0]?.message ?? 'Could not load your access.') : null);
    setState({ catalog: catalog.ok ? catalog.data : [], grants: grants.ok ? grants.data : [], requests: requests.ok ? requests.data : [], approvals: approvals.ok ? approvals.data : [], reviews: reviews.ok ? reviews.data : [] });
    setLoading(false);
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const act = useCallback(
    async (run: () => Promise<{ ok: true } | { ok: false; errors: Array<{ message: string }> }>) => {
      const res = await run();
      setError(res.ok ? null : (res.errors[0]?.message ?? 'That did not work.'));
      if (res.ok) await refresh();
      return res.ok;
    },
    [refresh],
  );

  return {
    ...state,
    loading,
    error,
    refresh,
    request: (entitlement, justification, durationSeconds) => act(() => requestAccess(client, { entitlement, justification, durationSeconds })),
    cancel: (id) => act(() => cancelAccessRequest(client, id)),
    decide: (id, decision, comment) => act(() => decideAccessRequest(client, id, decision, comment)),
    review: (id, decision, comment) => act(() => decideAccessReview(client, id, decision, comment)),
  };
}

const when = (ms: number | null) => (ms ? new Date(ms).toISOString().slice(0, 10) : null);

/** A ready-made access panel: what you have, what you can request, your requests, approvals and reviews. */
export function AccessRequests() {
  const a = useAccess();
  const uid = useId();
  const [reason, setReason] = useState<Record<string, string>>({});
  const names = new Map(a.catalog.map((c) => [c.id, c.name]));
  const nameOf = (entitlementId: string) => names.get(entitlementId) ?? 'Access';

  if (a.loading) return <div data-atlas-access aria-busy="true" />;
  return (
    <div data-atlas-access>
      {a.error ? <p role="alert" data-atlas-access-error>{a.error}</p> : null}
      {a.approvals.length ? (
        <section aria-labelledby={`${uid}-appr`} data-atlas-access-approvals>
          <h2 id={`${uid}-appr`}>Waiting for your approval</h2>
          <ul>
            {a.approvals.map((r) => (
              <li key={r.id}>
                <span>{nameOf(r.entitlement_id)}{r.justification ? ` — “${r.justification}”` : ''}</span>{' '}
                <button type="button" onClick={() => void a.decide(r.id, 'approve')}>Approve</button>{' '}
                <button type="button" onClick={() => void a.decide(r.id, 'deny')}>Deny</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {a.reviews.length ? (
        <section aria-labelledby={`${uid}-rev`} data-atlas-access-reviews>
          <h2 id={`${uid}-rev`}>Access reviews</h2>
          <ul>
            {a.reviews.map((r) => (
              <li key={r.id}>
                <span>{nameOf(r.entitlement_id)} — {r.user_id}</span>{' '}
                <button type="button" onClick={() => void a.review(r.id, 'certify')}>Keep</button>{' '}
                <button type="button" onClick={() => void a.review(r.id, 'revoke')}>Remove</button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <section aria-labelledby={`${uid}-mine`} data-atlas-access-grants>
        <h2 id={`${uid}-mine`}>What you have</h2>
        {a.grants.length ? (
          <ul>{a.grants.map((g) => <li key={g.id}>{nameOf(g.entitlement_id)}{g.expires_at ? ` (until ${when(g.expires_at)})` : ''}</li>)}</ul>
        ) : (
          <p>You have no governed access yet.</p>
        )}
      </section>
      <section aria-labelledby={`${uid}-req`} data-atlas-access-catalog>
        <h2 id={`${uid}-req`}>Request access</h2>
        <ul>
          {a.catalog.map((c) => (
            <li key={c.id}>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void a.request(c.key, reason[c.key] || undefined);
                }}
              >
                <strong>{c.name}</strong> <small>{c.risk_level} risk · {c.approval_steps ? `${c.approval_steps} approval step${c.approval_steps === 1 ? '' : 's'}` : 'granted immediately'}</small>
                {c.description ? <p>{c.description}</p> : null}
                <label>
                  <span className="atlas-sr-only">Reason for {c.name}</span>
                  <input name="justification" maxLength={2000} required={c.require_justification} placeholder="Why do you need it?" value={reason[c.key] ?? ''} onChange={(e) => setReason({ ...reason, [c.key]: e.target.value })} />
                </label>{' '}
                <button type="submit">Request</button>
              </form>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby={`${uid}-my`} data-atlas-access-requests>
        <h2 id={`${uid}-my`}>Your requests</h2>
        {a.requests.length ? (
          <ul>
            {a.requests.map((r) => (
              <li key={r.id}>
                {nameOf(r.entitlement_id)} — {r.status}
                {r.status === 'pending' ? <> <button type="button" onClick={() => void a.cancel(r.id)}>Cancel</button></> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p>You have not requested anything.</p>
        )}
      </section>
    </div>
  );
}
