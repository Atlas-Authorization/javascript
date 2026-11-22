import type { FapiClient, FapiResponse, FlowState } from './fapi';

/**
 * "Approve in your app" sign-in. The sign-in screen shows a short number; the
 * integrator's own app, signed in as the same user, taps that number among a few
 * choices to approve. These are the screen's half (`prepareAppApproval` for a first
 * factor, `prepareAppApprovalSecondFactor` for a step-up) and the app's half
 * (`getAppApproval`, `approveSignIn`, `denySignIn`).
 */

/** First factor: after the email is entered, ask the app to approve. The number to show comes back as `matchCode`, and `pollSecret` makes the flow's usual poll collect the sign-in. */
export async function prepareAppApproval(client: FapiClient, state: FlowState): Promise<FlowState> {
  const id = state.attempt?.id;
  if (!id) return state;
  const response = await client.post<{ poll_secret?: string; match_code?: string }>(`/v1/client/sign_ins/${encodeURIComponent(id)}/prepare_first_factor`, { strategy: 'app_approval' });
  if (!response.ok) return { ...state, busy: false, errors: response.errors };
  return {
    ...state,
    busy: false,
    errors: [],
    pollSecret: response.data?.poll_secret ?? null,
    prepared: 'app_approval',
    matchCode: response.data?.match_code ?? null,
  };
}

/** A step-up request: show `number`, then poll with {@link pollAppApprovalSecondFactor}. */
export interface AppApprovalRequest {
  approvalId: string;
  number: string;
  expiresAt: number;
}

/** Step-up: at the second-factor step, ask the app to approve. */
export async function prepareAppApprovalSecondFactor(
  client: FapiClient,
  attemptId: string,
): Promise<{ request: AppApprovalRequest | null; response: FapiResponse<{ challenge_id: string; number_match: string; expires_at: number }> }> {
  const response = await client.post<{ challenge_id: string; number_match: string; expires_at: number }>(
    `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/prepare_second_factor`,
    { strategy: 'app_approval' },
  );
  const d = response.data;
  return { request: response.ok && d ? { approvalId: d.challenge_id, number: d.number_match, expiresAt: d.expires_at } : null, response };
}

/** Step-up: poll after showing the number. The attempt stays at `needs_second_factor` until the app approves, then `complete`; a denial or a timeout is an error with reason `app_approval_denied` or `app_approval_expired`. */
export function pollAppApprovalSecondFactor(client: FapiClient, attemptId: string): Promise<FapiResponse<Record<string, unknown>>> {
  return client.post(`/v1/client/sign_ins/${encodeURIComponent(attemptId)}/attempt_second_factor`, { strategy: 'app_approval' });
}

/** What the approving app shows before answering. */
export interface AppApprovalDetails {
  id: string;
  purpose: 'first_factor' | 'step_up';
  status: 'pending' | 'approved' | 'denied' | 'expired';
  /** The shuffled numbers to offer; the right one is not marked. The person taps the number the sign-in screen shows. */
  choices: string[];
  requestedFrom: { userAgent: string | null; ip: string | null; location: string | null };
  expiresAt: number;
}

interface DetailsWire {
  id: string;
  purpose: 'first_factor' | 'step_up';
  status: AppApprovalDetails['status'];
  choices: string[];
  requested_from?: { user_agent?: string | null; ip?: string | null; location?: string | null };
  expires_at: number;
}

/** The approving app: read a request (the id comes from your `sign_in.approval_requested` webhook or push). Needs the user's own session. */
export async function getAppApproval(client: FapiClient, id: string): Promise<AppApprovalDetails | null> {
  const response = await client.get<DetailsWire>(`/v1/client/app_approvals/${encodeURIComponent(id)}`);
  const d = response.data;
  if (!response.ok || !d) return null;
  return {
    id: d.id,
    purpose: d.purpose,
    status: d.status,
    choices: d.choices,
    requestedFrom: { userAgent: d.requested_from?.user_agent ?? null, ip: d.requested_from?.ip ?? null, location: d.requested_from?.location ?? null },
    expiresAt: d.expires_at,
  };
}

/** The approving app: approve with the number the person picked. A wrong number does not sign anyone in. One answer only. */
export function approveSignIn(client: FapiClient, input: { id: string; number: string }): Promise<FapiResponse<{ status: string }>> {
  return client.post(`/v1/client/app_approvals/${encodeURIComponent(input.id)}/respond`, { action: 'approve', selected_number: input.number });
}

/** The approving app: deny ("this was not me"). */
export function denySignIn(client: FapiClient, id: string): Promise<FapiResponse<{ status: string }>> {
  return client.post(`/v1/client/app_approvals/${encodeURIComponent(id)}/respond`, { action: 'deny' });
}

/** How a held sign-in wait ended. `no_account` and `no_approver_device` appear only when the application turned on `appApproval.revealNoAccount`. */
export type SignInWaitOutcome = 'pending' | 'complete' | 'denied' | 'expired' | 'cancelled' | 'no_account' | 'no_approver_device';

export interface SignInWaitResult {
  outcome: SignInWaitOutcome;
  status: string | null;
  /** The one-time ticket to exchange for a session; present when `outcome` is `complete`. */
  ticket: string | null;
}

/**
 * Wait for an email-link or approve-in-your-app sign-in to finish without polling every couple of seconds. The server
 * holds the request up to `timeoutSeconds` (at most 25) and answers as soon as the sign-in changes. `pending` means the
 * hold ran out: call again. Resolves null when the request itself failed (offline, unknown attempt), so fall back to the
 * ordinary poll.
 */
export async function waitForSignIn(
  client: FapiClient,
  input: { attemptId: string; pollSecret: string; timeoutSeconds?: number },
): Promise<SignInWaitResult | null> {
  const query = new URLSearchParams({ poll_secret: input.pollSecret });
  if (input.timeoutSeconds !== undefined) query.set('timeout', String(input.timeoutSeconds));
  const response = await client.get<{ outcome?: SignInWaitOutcome; status?: string; ticket?: string }>(
    `/v1/client/sign_ins/${encodeURIComponent(input.attemptId)}/wait?${query}`,
  );
  const d = response.data;
  if (!response.ok || !d?.outcome) return null;
  return { outcome: d.outcome, status: d.status ?? null, ticket: d.ticket ?? null };
}

/** One request waiting on the signed-in user: a sign-in approval (`kind: "sign_in_approval"`) or an approval request. */
export interface PendingApproval {
  kind: 'sign_in_approval' | 'approval_request';
  id: string;
  /** For `sign_in_approval`: answer with {@link approveSignIn} / {@link denySignIn}. */
  choices: string[];
  purpose: 'first_factor' | 'step_up' | null;
  requestedFrom: { userAgent: string | null; ip: string | null; location: string | null } | null;
  expiresAt: number | null;
  /** The raw object, for fields of an `approval_request` this type does not name. */
  raw: Record<string, unknown>;
}

/** Everything waiting on the signed-in user, so an app needs no pointer to the latest request. Needs the user's own session. */
export async function listPendingApprovalRequests(client: FapiClient): Promise<PendingApproval[]> {
  const response = await client.get<{ data?: Array<Record<string, unknown>> }>('/v1/client/me/approval_requests?status=pending');
  if (!response.ok) return [];
  return (response.data?.data ?? []).map((r) => {
    const from = r.requested_from as { user_agent?: string | null; ip?: string | null; location?: string | null } | undefined;
    return {
      kind: r.kind === 'sign_in_approval' ? 'sign_in_approval' : 'approval_request',
      id: String(r.id),
      choices: Array.isArray(r.choices) ? (r.choices as string[]) : [],
      purpose: r.purpose === 'first_factor' || r.purpose === 'step_up' ? r.purpose : null,
      requestedFrom: from ? { userAgent: from.user_agent ?? null, ip: from.ip ?? null, location: from.location ?? null } : null,
      expiresAt: typeof r.expires_at === 'number' ? r.expires_at : null,
      raw: r,
    };
  });
}
