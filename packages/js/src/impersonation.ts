/**
 * Impersonation: who is acting on a session, and "return to admin".
 *
 * A session started from an impersonation carries `act: { sub }` on its token
 * (RFC 8693) and, on `GET /v1/client`, `actor` plus `actor_session_id` — the
 * impersonator's own session on this browser, kept alongside while they act as
 * the user. {@link endImpersonation} ends the impersonation and, when that
 * session is still usable, makes it active again without a sign-in.
 */

/** The party acting on an impersonated session (the token's `act` claim). */
export interface ImpersonationActor {
  sub: string;
}

/** The impersonation fields on a `GET /v1/client` session (absent otherwise). */
export interface ImpersonationSessionFields {
  actor?: ImpersonationActor | null;
  /** The impersonator's own session that ending the impersonation resumes, or null. */
  actor_session_id?: string | null;
}

/** What {@link endImpersonation} resolves with. */
export interface EndImpersonationResult {
  /** The Frontend API confirmed the impersonation session is over. */
  ended: boolean;
  /** The impersonator's own session became active again (no sign-in needed). */
  resumed: boolean;
  /**
   * The session now active on this browser, when any: the impersonator's own
   * (`resumed: true`) or another account signed in here. Absent → signed out.
   */
  activeSessionId?: string;
  /** The newly active session's JWT, when there is one. */
  jwt?: string;
  /** The HTTP status (`0` when the server never answered). */
  status: number;
}

/** The actor on a session token's claims, or null for an ordinary session. */
export function actorFromClaims(claims: Record<string, unknown> | null | undefined): ImpersonationActor | null {
  const act = claims?.act as { sub?: unknown } | undefined;
  return act && typeof act === 'object' && typeof act.sub === 'string' && act.sub ? { sub: act.sub } : null;
}

/**
 * `POST /v1/client/sessions/:id/end_impersonation`. `request` is the caller's
 * credentialed FAPI fetch (cookies included) — the server reads the active and
 * parked session cookies and rewrites them. Not retried: ending twice is
 * harmless, but a refusal (404/409) is final.
 */
export async function endImpersonation(
  request: (path: string, init?: RequestInit) => Promise<Response>,
  sessionId: string,
): Promise<EndImpersonationResult> {
  let response: Response;
  try {
    response = await request(`/v1/client/sessions/${encodeURIComponent(sessionId)}/end_impersonation`, {
      method: 'POST',
    });
  } catch {
    return { ended: false, resumed: false, status: 0 };
  }
  if (!response.ok) return { ended: false, resumed: false, status: response.status };
  // A body we cannot read still means the impersonation ended.
  const body = (await response.json().catch(() => null)) as {
    resumed?: unknown;
    active_session_id?: unknown;
    jwt?: unknown;
  } | null;
  return {
    ended: true,
    resumed: body?.resumed === true,
    status: response.status,
    ...(typeof body?.active_session_id === 'string' ? { activeSessionId: body.active_session_id } : {}),
    ...(typeof body?.jwt === 'string' ? { jwt: body.jwt } : {}),
  };
}
