/**
 * Policy acceptance (Terms of Service, privacy policy, any policy the
 * application defines) — the Frontend API helpers every framework SDK and
 * custom UI share.
 *
 *  - `getPolicies()` — the current version of every policy, ready to render
 *    (`content_html` is already sanitised; `content_sha256` is its hash).
 *  - `buildPolicyAcceptances()` — turn what the user saw into the
 *    `policy_acceptances` a sign-up, a held sign-in or an in-app acceptance sends.
 *  - `startSignUp({ policyAcceptances })` — accept at sign-up.
 *  - `acceptAttemptPolicies()` — continue a sign-in (or social sign-up) the
 *    server held at `needs_policy_acceptance`; the completion carries the
 *    ticket exactly like any other step.
 *  - `getMyPolicies()` / `acceptPolicies()` — the signed-in user's standing,
 *    and accepting from inside the app (e.g. a banner during a grace window).
 */

import type { AttemptView, FieldError, PendingPolicy } from './attempt';
import type { FapiClient, FlowState } from './fapi';

export type PolicyDisplayMode = 'checkbox' | 'scroll' | 'link';

/** A policy's current version as `GET /v1/client/policies` returns it. */
export interface PublicPolicy {
  object: 'policy';
  key: string;
  title: string;
  display: PolicyDisplayMode;
  required: boolean;
  applies_to: 'sign_up' | 'sign_in_and_sign_up';
  position: number;
  version_id: string;
  version: string;
  content_markdown: string | null;
  /** Sanitised HTML: render this (it is what `content_sha256` covers). */
  content_html: string;
  content_sha256: string;
  content_url: string | null;
  summary_of_changes: string | null;
  locale: string | null;
  published_at: number | null;
  effective_at: number | null;
}

export interface PublicPolicies {
  object: 'list';
  data: PublicPolicy[];
  /** The legacy single legal checkbox (send `consent: true` on sign-up), when configured. */
  legacy_consent: { required: boolean; terms_url: string | null; privacy_url: string | null } | null;
}

/** One entry of `policy_acceptances`. */
export interface PolicyAcceptance {
  policy: string;
  version_id: string;
  content_sha256: string;
  display?: PolicyDisplayMode;
  /** Scroll mode: the user reached the end (client-attested evidence). */
  scrolled_to_end?: boolean;
  /** How long the document was open, in ms (client-attested evidence). */
  view_ms?: number;
  locale?: string;
}

export interface PolicyStanding {
  object: 'policy_standing';
  policy: string;
  policy_id: string;
  title: string;
  display: PolicyDisplayMode;
  required: boolean;
  applies_to: 'sign_up' | 'sign_in_and_sign_up';
  reaccept: 'none' | 'next_sign_in' | 'grace';
  current_version_id: string | null;
  current_version: string | null;
  content_sha256: string | null;
  summary_of_changes: string | null;
  accepted_version_id: string | null;
  accepted_version: string | null;
  accepted_at: number | null;
  needs_reaccept: boolean;
  /** The next sign-in will stop for this policy. */
  blocking: boolean;
  /** A grace window is running until then (show a banner; sign-in still works). */
  grace_ends_at: number | null;
}

export interface MyPolicies {
  object: 'list';
  data: PolicyStanding[];
  /** A required policy's current version is not accepted (banner time). */
  needs_acceptance: boolean;
  /** The next sign-in will stop for at least one policy. */
  blocking: boolean;
}

export type PolicyResult<T> = { ok: true; data: T } | { ok: false; errors: FieldError[] };

/** `GET /v1/client/policies` — the current version of every policy. */
export async function getPolicies(client: FapiClient, opts: { locale?: string } = {}): Promise<PolicyResult<PublicPolicies>> {
  const q = opts.locale ? `?locale=${encodeURIComponent(opts.locale)}` : '';
  const res = await client.request<PublicPolicies>(`/v1/client/policies${q}`, { method: 'GET' });
  return res.ok && res.data ? { ok: true, data: res.data } : { ok: false, errors: res.errors };
}

/** What the user was shown, per policy: enough to build an acceptance. */
export interface ShownPolicy {
  /** The policy key. */
  policy?: string;
  key?: string;
  version_id: string;
  content_sha256: string;
  display?: PolicyDisplayMode | string;
}

/**
 * Build `policy_acceptances` from the policies the user was shown and agreed
 * to (public policies or an attempt's `pending_policies`). `evidence` carries
 * the per-policy reading signals the UI measured.
 */
export function buildPolicyAcceptances(
  shown: ReadonlyArray<ShownPolicy | PublicPolicy | PendingPolicy>,
  evidence: Record<string, { scrolledToEnd?: boolean; viewMs?: number }> = {},
  opts: { locale?: string } = {},
): PolicyAcceptance[] {
  return shown.map((p) => {
    const key = ('key' in p && typeof p.key === 'string' ? p.key : undefined) ?? (p as { policy?: string }).policy ?? '';
    const e = evidence[key] ?? {};
    const display = (p.display === 'checkbox' || p.display === 'scroll' || p.display === 'link' ? p.display : undefined) as
      | PolicyDisplayMode
      | undefined;
    return {
      policy: key,
      version_id: p.version_id,
      content_sha256: p.content_sha256,
      ...(display ? { display } : {}),
      ...(e.scrolledToEnd !== undefined ? { scrolled_to_end: e.scrolledToEnd } : {}),
      ...(e.viewMs !== undefined ? { view_ms: Math.max(0, Math.round(e.viewMs)) } : {}),
      ...(opts.locale ? { locale: opts.locale } : {}),
    };
  });
}

/**
 * The `accept_policies` request body: the acceptances plus the proof of the
 * held attempt — the one-time `policy_acceptance_token` (the flow's
 * `policyToken`, else the token on the held attempt view), else the attempt's
 * `poll_secret` (a magic-link or QR tab). The attempt id alone is never enough.
 */
export function acceptPoliciesBody(
  proof: {
    policyToken?: string | null;
    attempt?: { policy_acceptance_token?: unknown } | null;
    pollSecret?: string | null;
  },
  acceptances: PolicyAcceptance[],
): { policy_acceptances: PolicyAcceptance[]; policy_acceptance_token?: string; poll_secret?: string } {
  const viewToken = typeof proof.attempt?.policy_acceptance_token === 'string' ? proof.attempt.policy_acceptance_token : null;
  const token = proof.policyToken || viewToken;
  return {
    policy_acceptances: acceptances,
    ...(token ? { policy_acceptance_token: token } : proof.pollSecret ? { poll_secret: proof.pollSecret } : {}),
  };
}

/**
 * `POST /v1/client/sign_ins/:id/accept_policies` — continue an attempt held at
 * `needs_policy_acceptance`. Uses the flow's `policyToken` (or its poll secret
 * for magic-link / QR tabs). The result is the next flow state: usually
 * `complete` with a `ticket` to exchange, or still `needs_policy_acceptance`
 * when a newer version was published meanwhile.
 */
export async function acceptAttemptPolicies(
  client: FapiClient,
  state: FlowState,
  acceptances: PolicyAcceptance[],
): Promise<FlowState> {
  const id = state.attempt?.id;
  if (!id) return { ...state, errors: [{ code: 'VALIDATION_FAILED', message: 'There is no sign-in attempt to continue.' }] };
  const res = await client.post<AttemptView & { ticket?: string }>(
    `/v1/client/sign_ins/${encodeURIComponent(id)}/accept_policies`,
    acceptPoliciesBody({ policyToken: state.policyToken, attempt: state.attempt, pollSecret: state.pollSecret }, acceptances),
  );
  if (!res.ok || !res.data) return { ...state, busy: false, errors: res.errors };
  const view = res.data;
  return {
    attempt: view,
    errors: [],
    busy: false,
    pollSecret: state.pollSecret,
    ticket: view.ticket ?? null,
    prepared: null,
    policyToken: view.policy_acceptance_token ?? null,
  };
}

/** `GET /v1/client/me/policies` — the signed-in user's standing on every policy. */
export async function getMyPolicies(client: FapiClient): Promise<PolicyResult<MyPolicies>> {
  const res = await client.request<MyPolicies>('/v1/client/me/policies', { method: 'GET' });
  return res.ok && res.data ? { ok: true, data: res.data } : { ok: false, errors: res.errors };
}

/** `POST /v1/client/me/policies/accept` — accept from inside the app. */
export async function acceptPolicies(
  client: FapiClient,
  acceptances: PolicyAcceptance[],
): Promise<PolicyResult<{ object: 'list'; data: unknown[]; standings: PolicyStanding[] }>> {
  const res = await client.post<{ object: 'list'; data: unknown[]; standings: PolicyStanding[] }>('/v1/client/me/policies/accept', {
    policy_acceptances: acceptances,
  });
  return res.ok && res.data ? { ok: true, data: res.data } : { ok: false, errors: res.errors };
}
