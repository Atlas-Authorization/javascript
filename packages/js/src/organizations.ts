import type { FapiClient } from './fapi';

/**
 * Organization self-management from the browser, over the Frontend API: the
 * signed-in user's organizations, members, invitations, roles, teams, settings,
 * membership requests, leaving and deleting. Cookie-authenticated through the
 * {@link FapiClient}. Admin actions are gated by the user's role in the ACTIVE
 * organization, exactly as the server enforces them.
 *
 * {@link OrganizationProfileController} is the headless state behind every SDK's
 * `<OrganizationProfile>`: members, invitations and roles, with the actions an
 * admin needs, as a subscribable store a framework renders.
 */

export interface ClientOrganization {
  object: 'organization';
  id: string;
  name: string;
  slug: string | null;
  image_url?: string | null;
  public_metadata?: Record<string, unknown>;
  max_allowed_memberships?: number | null;
  members_count?: number;
  created_at?: number;
  updated_at?: number;
  /** On by-slug reads: the caller's own role. */
  membership?: { role: string };
}

export interface OrganizationMember {
  object: 'organization_membership';
  id: string;
  role: string;
  user: { id: string; first_name: string | null; last_name: string | null; image_url: string | null } | null;
}

export interface OrganizationInvitation {
  object: 'organization_invitation';
  id: string;
  organization_id: string;
  email_address: string;
  role: string | null;
  status: 'pending' | 'accepted' | 'revoked' | 'expired' | string;
  inviter_user_id: string | null;
  expires_at: number;
  created_at: number;
}

/** What an accept page shows before the invitee signs in. */
export interface PublicOrganizationInvitation {
  object: 'organization_invitation';
  id: string;
  email_address: string;
  role: string | null;
  status: string;
  expires_at: number;
  organization: { id: string; name: string; slug: string | null; image_url: string | null };
  inviter: { first_name: string | null; last_name: string | null; image_url: string | null } | null;
}

export interface OrganizationRole {
  object: 'role';
  /** Present from servers that support per-organization custom roles. */
  id?: string;
  key: string;
  name: string;
  description: string | null;
  is_system?: boolean;
  /** Set on the organization's own custom roles; null for an instance-wide role. */
  organization_id?: string | null;
  /** Included only for a caller who manages members. */
  permissions?: string[];
  member_count?: number;
}

/** A permission an organization admin may put on a custom role. */
export interface OrganizationPermission {
  object: 'permission';
  key: string;
  name: string;
  description: string | null;
}

/** What a custom role is made of. */
export interface OrganizationRoleInput {
  name?: string;
  description?: string | null;
  /** Permission keys; each must be one the caller holds. */
  permissions?: string[];
}

export interface OrganizationTeam {
  object: 'team';
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  members_count?: number;
  created_at: number;
  updated_at: number;
}

export interface OrganizationTeamMember {
  object: 'team_membership';
  team_id: string;
  user_id: string;
  user: { id: string; first_name: string | null; last_name: string | null; image_url: string | null } | null;
}

export interface OrganizationSlugCheck {
  object: 'organization_slug_check';
  slug: string;
  valid: boolean;
  available: boolean;
}

export interface OrganizationPage<T> {
  data: T[];
  totalCount?: number;
  hasMore: boolean;
}

/** A refused request. `code` is the server's stable error code. */
export class OrganizationRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly param?: string;
  readonly reason?: string;
  readonly meta?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    message: string,
    param?: string,
    reason?: string,
    meta?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'OrganizationRequestError';
    this.status = status;
    this.code = code;
    this.param = param;
    if (reason) this.reason = reason;
    if (meta) this.meta = meta;
  }

  /** True when the action needs a fresh re-authentication first (deleting an organization). */
  get needsReverification(): boolean {
    return this.code === 'STEP_UP_REQUIRED';
  }
}

const enc = encodeURIComponent;
const ORGS = '/v1/client/organizations';

async function call<T>(client: FapiClient, path: string, init: RequestInit = {}): Promise<T> {
  const res = await client.request<T>(path, init);
  if (!res.ok || !res.data) {
    const first = res.errors[0];
    throw new OrganizationRequestError(
      res.status,
      first?.code ?? 'UNKNOWN',
      first?.message ?? 'The request failed.',
      first?.param,
      first?.reason,
      first?.meta,
    );
  }
  return res.data;
}

const json = (method: string, body?: unknown): RequestInit =>
  body === undefined ? { method } : { method, body: JSON.stringify(body) };

function list<T>(body: { data?: T[]; total_count?: number; has_more?: boolean }): OrganizationPage<T> {
  return {
    data: body.data ?? [],
    ...(body.total_count !== undefined ? { totalCount: body.total_count } : {}),
    hasMore: body.has_more ?? false,
  };
}

// ---- Organizations -----------------------------------------------------------

/** The organizations the signed-in user belongs to. */
export async function listMyOrganizations(client: FapiClient): Promise<OrganizationPage<Record<string, unknown>>> {
  return list(await call(client, '/v1/client/me/organizations', json('GET')));
}

export async function createOrganization(
  client: FapiClient,
  input: { name: string; slug?: string },
): Promise<ClientOrganization> {
  return call(client, ORGS, json('POST', input));
}

/** The ACTIVE organization. */
export async function getOrganization(client: FapiClient, organizationId: string): Promise<ClientOrganization> {
  return call(client, `${ORGS}/${enc(organizationId)}`, json('GET'));
}

export async function updateOrganization(
  client: FapiClient,
  organizationId: string,
  input: { name?: string; slug?: string; image_url?: string | null },
): Promise<ClientOrganization> {
  return call(client, `${ORGS}/${enc(organizationId)}`, json('PATCH', input));
}

/**
 * Delete the active organization (admin only, when the application allows it).
 * Needs a recent re-authentication: a stale session gets an error whose
 * `needsReverification` is true.
 */
export async function deleteOrganization(
  client: FapiClient,
  organizationId: string,
): Promise<{ object: 'organization'; id: string; deleted: true }> {
  return call(client, `${ORGS}/${enc(organizationId)}`, json('DELETE'));
}

/** Leave an organization (any member; the only admin must promote someone first). */
export async function leaveOrganization(
  client: FapiClient,
  organizationId: string,
): Promise<{ object: 'organization_membership'; organization_id: string; user_id: string; deleted: true }> {
  return call(client, `/v1/client/me/organizations/${enc(organizationId)}/membership`, json('DELETE'));
}

export async function checkOrganizationSlug(client: FapiClient, slug: string): Promise<OrganizationSlugCheck> {
  return call(client, `${ORGS}/check_slug?slug=${enc(slug)}`, json('GET'));
}

/** An organization the user belongs to, by slug (404 otherwise). */
export async function getOrganizationBySlug(client: FapiClient, slug: string): Promise<ClientOrganization> {
  return call(client, `${ORGS}/by_slug/${enc(slug)}`, json('GET'));
}

/** The roles a member can hold (for a role picker). */
export async function listOrganizationRoles(
  client: FapiClient,
  organizationId: string,
): Promise<OrganizationRole[]> {
  return (await call<{ data: OrganizationRole[] }>(client, `${ORGS}/${enc(organizationId)}/roles`, json('GET'))).data ?? [];
}

/**
 * The permissions the caller may put on a custom role: the instance's
 * permissions that the caller holds (needs member management).
 */
export async function listAssignablePermissions(
  client: FapiClient,
  organizationId: string,
): Promise<OrganizationPermission[]> {
  return (
    await call<{ data: OrganizationPermission[] }>(client, `${ORGS}/${enc(organizationId)}/permissions`, json('GET'))
  ).data ?? [];
}

/** Create a custom role for the active organization (never past the caller's own permissions). */
export async function createOrganizationRole(
  client: FapiClient,
  organizationId: string,
  input: OrganizationRoleInput & { key: string; name: string },
): Promise<OrganizationRole> {
  return call(client, `${ORGS}/${enc(organizationId)}/roles`, json('POST', input));
}

/** Rename one of the organization's own roles or replace its permissions (the key is fixed). */
export async function updateOrganizationRole(
  client: FapiClient,
  organizationId: string,
  roleId: string,
  input: OrganizationRoleInput,
): Promise<OrganizationRole> {
  return call(client, `${ORGS}/${enc(organizationId)}/roles/${enc(roleId)}`, json('PATCH', input));
}

/**
 * Delete one of the organization's own roles. A role still in use needs
 * `reassignTo` (a role key) — its members and pending invitations move first.
 */
export async function deleteOrganizationRole(
  client: FapiClient,
  organizationId: string,
  roleId: string,
  options: { reassignTo?: string } = {},
): Promise<{ object: 'role'; id: string; key: string; deleted: true; members_reassigned: number }> {
  const qs = options.reassignTo ? `?reassign_to=${enc(options.reassignTo)}` : '';
  return call(client, `${ORGS}/${enc(organizationId)}/roles/${enc(roleId)}${qs}`, json('DELETE'));
}

// ---- Members -----------------------------------------------------------------

export async function listOrganizationMembers(
  client: FapiClient,
  organizationId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<OrganizationPage<OrganizationMember>> {
  const q = new URLSearchParams();
  if (options.limit !== undefined) q.set('limit', String(options.limit));
  if (options.offset !== undefined) q.set('offset', String(options.offset));
  const qs = q.toString();
  return list(await call(client, `${ORGS}/${enc(organizationId)}/memberships${qs ? `?${qs}` : ''}`, json('GET')));
}

export async function updateMemberRole(
  client: FapiClient,
  organizationId: string,
  userId: string,
  role: string,
): Promise<{ object: 'organization_membership'; organization_id: string; user_id: string; role: string }> {
  return call(client, `${ORGS}/${enc(organizationId)}/memberships/${enc(userId)}`, json('PATCH', { role }));
}

export async function removeMember(client: FapiClient, organizationId: string, userId: string): Promise<unknown> {
  return call(client, `${ORGS}/${enc(organizationId)}/memberships/${enc(userId)}`, json('DELETE'));
}

// ---- Invitations ---------------------------------------------------------------

export async function listOrganizationInvitations(
  client: FapiClient,
  organizationId: string,
  options: { status?: string } = {},
): Promise<OrganizationPage<OrganizationInvitation>> {
  const qs = options.status ? `?status=${enc(options.status)}` : '';
  return list(await call(client, `${ORGS}/${enc(organizationId)}/invitations${qs}`, json('GET')));
}

export async function inviteMember(
  client: FapiClient,
  organizationId: string,
  input: { emailAddress: string; role: string },
): Promise<OrganizationInvitation> {
  return call(
    client,
    `${ORGS}/${enc(organizationId)}/invitations`,
    json('POST', { email_address: input.emailAddress, role: input.role }),
  );
}

export async function revokeInvitation(
  client: FapiClient,
  organizationId: string,
  invitationId: string,
): Promise<OrganizationInvitation> {
  return call(client, `${ORGS}/${enc(organizationId)}/invitations/${enc(invitationId)}/revoke`, json('POST'));
}

export async function resendInvitation(
  client: FapiClient,
  organizationId: string,
  invitationId: string,
): Promise<OrganizationInvitation> {
  return call(client, `${ORGS}/${enc(organizationId)}/invitations/${enc(invitationId)}/resend`, json('POST'));
}

/** The public view of an invitation, for an accept page (no sign-in needed). */
export async function getOrganizationInvitation(
  client: FapiClient,
  invitationId: string,
): Promise<PublicOrganizationInvitation> {
  return call(client, `/v1/client/organization_invitations/${enc(invitationId)}`, json('GET'));
}

/** Accept an invitation by id as the signed-in user. */
export async function acceptOrganizationInvitation(client: FapiClient, invitationId: string): Promise<unknown> {
  return call(client, `/v1/client/organization_invitations/${enc(invitationId)}/accept`, json('POST'));
}

/** Invitations addressed to the signed-in user. */
export async function listMyOrganizationInvitations(client: FapiClient): Promise<OrganizationPage<Record<string, unknown>>> {
  return list(await call(client, '/v1/client/me/organization_invitations', json('GET')));
}

export async function acceptMyOrganizationInvitation(client: FapiClient, invitationId: string): Promise<unknown> {
  return call(client, `/v1/client/me/organization_invitations/${enc(invitationId)}/accept`, json('POST'));
}

export async function declineMyOrganizationInvitation(client: FapiClient, invitationId: string): Promise<unknown> {
  return call(client, `/v1/client/me/organization_invitations/${enc(invitationId)}/decline`, json('POST'));
}

/** Organizations the user could join (verified email domain matches). */
export async function listMyOrganizationSuggestions(client: FapiClient): Promise<OrganizationPage<Record<string, unknown>>> {
  return list(await call(client, '/v1/client/me/organization_suggestions', json('GET')));
}

export async function acceptOrganizationSuggestion(client: FapiClient, organizationId: string): Promise<unknown> {
  return call(client, `/v1/client/me/organization_suggestions/${enc(organizationId)}/accept`, json('POST'));
}

// ---- Membership requests --------------------------------------------------------

export async function listMembershipRequests(
  client: FapiClient,
  organizationId: string,
): Promise<OrganizationPage<Record<string, unknown>>> {
  return list(await call(client, `${ORGS}/${enc(organizationId)}/membership_requests`, json('GET')));
}

export async function acceptMembershipRequest(client: FapiClient, organizationId: string, requestId: string): Promise<unknown> {
  return call(client, `${ORGS}/${enc(organizationId)}/membership_requests/${enc(requestId)}/accept`, json('POST'));
}

export async function rejectMembershipRequest(client: FapiClient, organizationId: string, requestId: string): Promise<unknown> {
  return call(client, `${ORGS}/${enc(organizationId)}/membership_requests/${enc(requestId)}/reject`, json('POST'));
}

// ---- Settings ---------------------------------------------------------------------

export async function getOrganizationSettings(
  client: FapiClient,
  organizationId: string,
): Promise<{ schema: Record<string, unknown> | null; values: Record<string, unknown>; version: number }> {
  return call(client, `${ORGS}/${enc(organizationId)}/settings`, json('GET'));
}

/** Write the organization's settings (admin; needs a recent re-authentication). */
export async function updateOrganizationSettings(
  client: FapiClient,
  organizationId: string,
  values: Record<string, unknown>,
): Promise<{ values: Record<string, unknown>; version: number }> {
  return call(client, `${ORGS}/${enc(organizationId)}/settings`, json('PUT', { values }));
}

// ---- Teams ------------------------------------------------------------------------

export async function listTeams(client: FapiClient, organizationId: string): Promise<OrganizationTeam[]> {
  return (await call<{ data: OrganizationTeam[] }>(client, `${ORGS}/${enc(organizationId)}/teams`, json('GET'))).data ?? [];
}

/** The caller's own teams, and the session's active team. */
export async function listMyTeams(
  client: FapiClient,
  organizationId: string,
): Promise<{ data: OrganizationTeam[]; activeTeamId: string | null }> {
  const body = await call<{ data: OrganizationTeam[]; active_team_id?: string | null }>(
    client,
    `${ORGS}/${enc(organizationId)}/teams/mine`,
    json('GET'),
  );
  return { data: body.data ?? [], activeTeamId: body.active_team_id ?? null };
}

export async function createTeam(
  client: FapiClient,
  organizationId: string,
  input: { name: string; description?: string | null },
): Promise<OrganizationTeam> {
  return call(client, `${ORGS}/${enc(organizationId)}/teams`, json('POST', input));
}

export async function updateTeam(
  client: FapiClient,
  organizationId: string,
  teamId: string,
  input: { name?: string; description?: string | null },
): Promise<OrganizationTeam> {
  return call(client, `${ORGS}/${enc(organizationId)}/teams/${enc(teamId)}`, json('PATCH', input));
}

export async function deleteTeam(client: FapiClient, organizationId: string, teamId: string): Promise<unknown> {
  return call(client, `${ORGS}/${enc(organizationId)}/teams/${enc(teamId)}`, json('DELETE'));
}

export async function listTeamMembers(
  client: FapiClient,
  organizationId: string,
  teamId: string,
): Promise<OrganizationTeamMember[]> {
  return (
    await call<{ data: OrganizationTeamMember[] }>(client, `${ORGS}/${enc(organizationId)}/teams/${enc(teamId)}/members`, json('GET'))
  ).data ?? [];
}

export async function addTeamMember(client: FapiClient, organizationId: string, teamId: string, userId: string): Promise<unknown> {
  return call(client, `${ORGS}/${enc(organizationId)}/teams/${enc(teamId)}/members`, json('POST', { user_id: userId }));
}

export async function removeTeamMember(client: FapiClient, organizationId: string, teamId: string, userId: string): Promise<unknown> {
  return call(client, `${ORGS}/${enc(organizationId)}/teams/${enc(teamId)}/members/${enc(userId)}`, json('DELETE'));
}

// ---- Headless <OrganizationProfile> state -------------------------------------------

export interface OrganizationProfileState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  members: OrganizationMember[];
  membersTotal: number;
  /** Pending invitations (admins only; empty for others). */
  invitations: OrganizationInvitation[];
  roles: OrganizationRole[];
  /** Permissions an admin may put on a custom role (admins only; empty for others). */
  permissions: OrganizationPermission[];
  /** The last failure, for display. */
  error: OrganizationRequestError | Error | null;
  /** The action in flight (e.g. `invite`, `remove:<userId>`), or null. */
  busy: string | null;
}

/**
 * The state and actions behind `<OrganizationProfile>`, framework-free. Each
 * SDK wraps it in its own reactivity (`subscribe` + `getState`). Admin-only
 * reads (invitations) are skipped when `canManage` is false; a refused admin
 * call surfaces as `error` rather than throwing out of an event handler.
 */
export class OrganizationProfileController {
  private state: OrganizationProfileState = {
    status: 'idle',
    members: [],
    membersTotal: 0,
    invitations: [],
    roles: [],
    permissions: [],
    error: null,
    busy: null,
  };
  private readonly listeners = new Set<(state: OrganizationProfileState) => void>();

  constructor(
    private readonly client: FapiClient,
    readonly organizationId: string,
    private readonly options: { canManage?: boolean; onChange?: () => void | Promise<void> } = {},
  ) {}

  getState(): OrganizationProfileState {
    return this.state;
  }

  subscribe(listener: (state: OrganizationProfileState) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(patch: Partial<OrganizationProfileState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l(this.state);
  }

  /** Load members, roles and (for admins) pending invitations. */
  async load(): Promise<void> {
    this.set({ status: 'loading', error: null });
    try {
      const [members, roles, invitations, permissions] = await Promise.all([
        listOrganizationMembers(this.client, this.organizationId, { limit: 200 }),
        listOrganizationRoles(this.client, this.organizationId),
        this.options.canManage
          ? listOrganizationInvitations(this.client, this.organizationId, { status: 'pending' })
          : Promise.resolve({ data: [] as OrganizationInvitation[], hasMore: false }),
        // Custom roles are optional: an older server (or none to grant) is just an empty list.
        this.options.canManage
          ? listAssignablePermissions(this.client, this.organizationId).catch(() => [] as OrganizationPermission[])
          : Promise.resolve([] as OrganizationPermission[]),
      ]);
      this.set({
        status: 'ready',
        members: members.data,
        membersTotal: members.totalCount ?? members.data.length,
        roles,
        invitations: invitations.data,
        permissions,
      });
    } catch (error) {
      this.set({ status: 'error', error: error as Error });
    }
  }

  private async run<T>(busy: string, fn: () => Promise<T>, reload = true): Promise<T | undefined> {
    this.set({ busy, error: null });
    try {
      const out = await fn();
      if (reload) await this.load();
      return out;
    } catch (error) {
      this.set({ error: error as Error });
      return undefined;
    } finally {
      this.set({ busy: null });
    }
  }

  changeRole(userId: string, role: string) {
    return this.run(`role:${userId}`, () => updateMemberRole(this.client, this.organizationId, userId, role));
  }

  removeMember(userId: string) {
    return this.run(`remove:${userId}`, () => removeMember(this.client, this.organizationId, userId));
  }

  invite(emailAddress: string, role: string) {
    return this.run('invite', () => inviteMember(this.client, this.organizationId, { emailAddress, role }));
  }

  revokeInvitation(invitationId: string) {
    return this.run(`revoke:${invitationId}`, () => revokeInvitation(this.client, this.organizationId, invitationId));
  }

  resendInvitation(invitationId: string) {
    return this.run(`resend:${invitationId}`, () => resendInvitation(this.client, this.organizationId, invitationId));
  }

  /** The organization's own custom roles (a subset of `roles`). */
  customRoles(): OrganizationRole[] {
    return this.state.roles.filter((r) => Boolean(r.organization_id));
  }

  createRole(input: OrganizationRoleInput & { key: string; name: string }) {
    return this.run('role:create', () => createOrganizationRole(this.client, this.organizationId, input));
  }

  updateRole(roleId: string, input: OrganizationRoleInput) {
    return this.run(`role:update:${roleId}`, () => updateOrganizationRole(this.client, this.organizationId, roleId, input));
  }

  deleteRole(roleId: string, options: { reassignTo?: string } = {}) {
    return this.run(`role:delete:${roleId}`, () => deleteOrganizationRole(this.client, this.organizationId, roleId, options));
  }

  /** Leave; `onChange` (e.g. a session reload) runs after. */
  async leave(): Promise<boolean> {
    const out = await this.run('leave', () => leaveOrganization(this.client, this.organizationId), false);
    if (out) await this.options.onChange?.();
    return Boolean(out);
  }

  /** Delete (admin; may need re-authentication: check `error.needsReverification`). */
  async deleteOrganization(): Promise<boolean> {
    const out = await this.run('delete', () => deleteOrganization(this.client, this.organizationId), false);
    if (out) await this.options.onChange?.();
    return Boolean(out);
  }
}
