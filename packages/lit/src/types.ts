/**
 * The public auth shapes, identical to the React and Vue SDKs so a team moving
 * between frameworks reads the same `user` / `session` / `claims` everywhere.
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

export interface AtlasOrganizationMembership {
  role: string;
  organization: {
    id: string;
    name: string;
    slug: string;
    image_url: string | null;
  };
}

export interface AtlasSession {
  id: string;
  status: string;
  last_active_organization_id: string | null;
}

/** `loading` until the first boot settles, then `signed_in` / `signed_out`. */
export type AuthStatus = 'loading' | 'signed_in' | 'signed_out';

/** The plain snapshot of auth state: values only, never functions or timers. */
export interface AtlasSnapshot {
  status: AuthStatus;
  user: AtlasUser | null;
  session: AtlasSession | null;
  claims: SessionClaims | null;
  memberships: AtlasOrganizationMembership[];
}
