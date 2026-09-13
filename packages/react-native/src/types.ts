/**
 * The shapes the RN hooks expose. Deliberately identical to `@atlasauth/react`'s so
 * a codebase sharing logic between web and native reads one set of types — the
 * only difference between the SDKs is where the session token is kept, never
 * what a user or a session looks like.
 */

export interface SessionClaims {
  sub: string;
  sid: string;
  exp: number;
  org_id?: string;
  org_slug?: string;
  org_role?: string;
  org_permissions?: string[];
  mfa?: boolean;
  [claim: string]: unknown;
}

export interface AtlasUser {
  id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  image_url: string | null;
  public_metadata: Record<string, unknown>;
  unsafe_metadata: Record<string, unknown>;
  mfa_enabled: boolean;
  has_password: boolean;
  email_addresses?: Array<{
    id: string;
    email_address: string;
    verified: boolean;
    primary: boolean;
  }>;
}

export interface AtlasSession {
  id: string;
  status: string;
  last_active_organization_id: string | null;
}

export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

/**
 * The outcome of a flow step (sign-in, sign-up, OAuth completion).
 *
 * `complete` means a session token was obtained and persisted — the app can
 * navigate on. `needs_more` means the server still owes a step (a second
 * factor, an email code); the raw attempt status rides along so the app can
 * render the next input. `error` carries the server's human-written messages.
 */
export interface FlowResult {
  status: 'complete' | 'needs_more' | 'error';
  /** The server's attempt status when `needs_more` (e.g. `needs_second_factor`). */
  attemptStatus?: string;
  /** The attempt id, so a follow-up call (2FA, verification) targets it. */
  attemptId?: string;
  errors: Array<{ code: string; message: string; param?: string }>;
}

/** Read the (unverified) claims out of a JWT — a display/routing hint only. */
export function decodeClaims(jwt: string): SessionClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as SessionClaims;
  } catch {
    return null;
  }
}
