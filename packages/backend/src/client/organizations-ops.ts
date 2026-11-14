import { enc, type RequestFn } from './request';

type C_Organization = {
  object: 'organization';
  id: string;
  name: string;
  slug: string;
  image_url: string | null;
  parent_organization_id: string | null;
  public_metadata: Record<string, unknown>;
  max_allowed_memberships: number | null;
  /** The user seated at creation; null for an organization your backend created with no creator. */
  created_by: string | null;
  /** Your own id for this customer; unique per instance. */
  external_id?: string | null;
  /** Role key → your product's name for it (e.g. {"org:admin": "owner"}); a member's mapped name rides in the org_role_mapped token claim. */
  role_mappings?: {
    [key: string]: string;
  } | null;
  /** On create with owner_email only: the invitation sent to that address. */
  owner_invitation?: {
    object: 'organization_invitation';
    id: string;
    email: string;
    role: string;
    status: string;
    expires_at: number | null;
  };
  /** Created (epoch ms). */
  created_at: number;
  /** Last updated (epoch ms). */
  updated_at: number;
};

export type OrganizationsGetBySlugResult = C_Organization;

export interface OrganizationsCheckSlugQuery {
  /** The slug to check. */
  slug: string;
}

export type OrganizationsCheckSlugResult = {
  object?: 'organization_slug_check';
  slug?: string;
  /** Whether the slug has an allowed shape. */
  valid?: boolean;
  /** Valid and not used by another organization. */
  available?: boolean;
};

export interface OrganizationsListTeamsQuery {
  /** Only the teams this user belongs to. */
  user_id?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrganizationsListTeamsResult = {
  object?: 'list';
  data?: ({
    object?: 'team';
    id?: string;
    organization_id?: string;
    name?: string;
    description?: string | null;
    members_count?: number;
    created_at?: number;
    updated_at?: number;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type OrganizationsCreateTeamBody = {
  /** Unique among the organization's teams. */
  name: string;
  description?: string | null;
};

export type OrganizationsCreateTeamResult = {
  object?: 'team';
  id?: string;
  organization_id?: string;
  name?: string;
  description?: string | null;
  members_count?: number;
  created_at?: number;
  updated_at?: number;
};

export type OrganizationsGetTeamResult = {
  object?: 'team';
  id?: string;
  organization_id?: string;
  name?: string;
  description?: string | null;
  members_count?: number;
  created_at?: number;
  updated_at?: number;
};

export type OrganizationsUpdateTeamBody = {
  /** Unique among the organization's teams. */
  name?: string;
  description?: string | null;
};

export type OrganizationsUpdateTeamResult = {
  object?: 'team';
  id?: string;
  organization_id?: string;
  name?: string;
  description?: string | null;
  members_count?: number;
  created_at?: number;
  updated_at?: number;
};

export type OrganizationsDeleteTeamResult = {
  object?: 'team';
  id?: string;
  deleted?: true;
};

export interface OrganizationsListTeamMembersQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrganizationsListTeamMembersResult = {
  object?: 'list';
  data?: ({
    object?: 'team_membership';
    team_id?: string;
    user_id?: string;
    user?: {
      id?: string;
      first_name?: string | null;
      last_name?: string | null;
      image_url?: string | null;
    } | null;
    deleted?: boolean;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type OrganizationsAddTeamMemberBody = {
  /** Must already be a member of the organization. */
  user_id: string;
};

export type OrganizationsAddTeamMemberResult = {
  object?: 'team_membership';
  team_id?: string;
  user_id?: string;
  user?: {
    id?: string;
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string | null;
  } | null;
  deleted?: boolean;
};

export type OrganizationsDeleteTeamMemberResult = {
  object?: 'team_membership';
  team_id?: string;
  user_id?: string;
  user?: {
    id?: string;
    first_name?: string | null;
    last_name?: string | null;
    image_url?: string | null;
  } | null;
  deleted?: boolean;
};

export interface OrganizationsListRolesQuery {
  /** "true" for only the organization's own roles. */
  own?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrganizationsListRolesResult = {
  object?: 'list';
  data?: ({
    object?: 'role';
    id?: string;
    key?: string;
    name?: string;
    description?: string | null;
    is_system?: boolean;
    /** Set on the organization's own custom roles; null for an instance-wide role. */
    organization_id?: string | null;
    permissions?: string[];
    member_count?: number;
    created_at?: number;
    updated_at?: number;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type OrganizationsCreateRoleBody = {
  /** Like "org:auditor": lowercase, prefixed with "org:". Immutable. */
  key: string;
  name: string;
  description?: string | null;
  /** Replaces the role's permissions; each must be an instance permission key. */
  permissions?: string[];
};

export type OrganizationsCreateRoleResult = {
  object?: 'role';
  id?: string;
  key?: string;
  name?: string;
  description?: string | null;
  is_system?: boolean;
  /** Set on the organization's own custom roles; null for an instance-wide role. */
  organization_id?: string | null;
  permissions?: string[];
  member_count?: number;
  created_at?: number;
  updated_at?: number;
};

export type OrganizationsUpdateRoleBody = {
  name?: string;
  description?: string | null;
  /** Replaces the role's permissions; each must be an instance permission key. */
  permissions?: string[];
};

export type OrganizationsUpdateRoleResult = {
  object?: 'role';
  id?: string;
  key?: string;
  name?: string;
  description?: string | null;
  is_system?: boolean;
  /** Set on the organization's own custom roles; null for an instance-wide role. */
  organization_id?: string | null;
  permissions?: string[];
  member_count?: number;
  created_at?: number;
  updated_at?: number;
};

export interface OrganizationsDeleteRoleQuery {
  /** A role key assignable in this organization. */
  reassign_to?: string;
}

export type OrganizationsDeleteRoleResult = {
  object?: 'role';
  id?: string;
  key?: string;
  deleted?: true;
  members_reassigned?: number;
};

export interface OrganizationsListConnectedAppsQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrganizationsListConnectedAppsResult = {
  object?: 'list';
  data?: ({
    object?: 'connected_app';
    /** The grant id; pass it to DELETE to revoke. */
    id?: string;
    organization_id?: string;
    user_id?: string;
    client_id?: string | null;
    client_name?: string | null;
    scope?: string;
    /** Connected (epoch ms). */
    connected_at?: number;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export type OrganizationsDeleteConnectedAppResult = {
  object?: 'connected_app';
  id?: string;
  deleted?: true;
};

export interface OrganizationsListApplicationsQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrganizationsListApplicationsResult = {
  object: 'list';
  data: ({
    object: 'organization_application';
    id: string;
    organization_id: string;
    /** The application's public client identifier. */
    client_id: string;
    /** The application's id. */
    application_id?: string;
    application_name?: string | null;
    /** Organization role keys allowed to use the app; empty = every member. */
    roles: string[];
    enabled: boolean;
    created_at?: number;
    updated_at?: number;
  })[];
  has_more: boolean;
};

export type OrganizationsSetApplicationBody = {
  roles?: string[];
  enabled?: boolean;
};

export type OrganizationsSetApplicationResult = {
  object: 'organization_application';
  id: string;
  organization_id: string;
  /** The application's public client identifier. */
  client_id: string;
  /** The application's id. */
  application_id?: string;
  application_name?: string | null;
  /** Organization role keys allowed to use the app; empty = every member. */
  roles: string[];
  enabled: boolean;
  created_at?: number;
  updated_at?: number;
};

export type OrganizationsDeleteApplicationResult = {
  object: 'organization_application';
  organization_id?: string;
  client_id?: string;
  deleted: true;
};

export interface OrganizationsListItAlertsQuery {
  /** certificate_expiring, sso_failure or scim_error. */
  kind?: string;
  /** 1 to 100 (default 20). */
  limit?: string;
  /** The id of the last alert of the previous page. */
  starting_after?: string;
}

export type OrganizationsListItAlertsResult = {
  object?: 'list';
  data?: ({
    object: 'organization_it_alert';
    id: string;
    organization_id: string;
    kind?: string | null;
    connection_id?: string | null;
    title?: string | null;
    days_left?: number | null;
    contacts_notified?: number;
    created_at: number;
  })[];
  has_more?: boolean;
};

export interface OrganizationsListAppEventTypesQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OrganizationsListAppEventTypesResult = {
  object?: 'list';
  data?: ({
    object: 'app_event_type';
    /** aet_ id. */
    id: string;
    /** Lowercase dotted name, e.g. call.completed. */
    type: string;
    description: string | null;
    /** JSON Schema every published data object must match; null = any object. */
    schema: Record<string, unknown> | null;
    /** Still publishable and delivered; hidden from the endpoint picker. */
    deprecated: boolean;
    created_at: number;
    updated_at: number;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

/** Operations on `/v1/organizations` (21). */
export function organizationsOpsResource(request: RequestFn) {
  return {
    /** Fetch an organization by its slug (case-insensitive). */
    getBySlug(slug: string): Promise<OrganizationsGetBySlugResult> {
      return request({ method: 'GET', path: `/v1/organizations/by_slug/${enc(slug)}` });
    },
    /** Check whether a slug is valid and free, for a create-organization form. */
    checkSlug(query: OrganizationsCheckSlugQuery): Promise<OrganizationsCheckSlugResult> {
      return request({ method: 'GET', path: '/v1/organizations/check_slug', query: { ...query } });
    },
    /** List the organization's teams with member counts. ?user_id= narrows to the teams that user is in. */
    listTeams(id: string, query?: OrganizationsListTeamsQuery): Promise<OrganizationsListTeamsResult> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/teams`, query: { ...query } });
    },
    /** Create a team inside the organization. Emits team.created. */
    createTeam(id: string, body: OrganizationsCreateTeamBody, idempotencyKey?: string): Promise<OrganizationsCreateTeamResult> {
      return request({ method: 'POST', path: `/v1/organizations/${enc(id)}/teams`, body, idempotencyKey });
    },
    /** Fetch one team of the organization. */
    getTeam(id: string, teamId: string): Promise<OrganizationsGetTeamResult> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/teams/${enc(teamId)}` });
    },
    /** Rename a team or change its description. Emits team.updated. */
    updateTeam(id: string, teamId: string, body: OrganizationsUpdateTeamBody): Promise<OrganizationsUpdateTeamResult> {
      return request({ method: 'PATCH', path: `/v1/organizations/${enc(id)}/teams/${enc(teamId)}`, body });
    },
    /** Delete a team (its memberships go with it; the organization memberships stay). Emits team.deleted. */
    deleteTeam(id: string, teamId: string): Promise<OrganizationsDeleteTeamResult> {
      return request({ method: 'DELETE', path: `/v1/organizations/${enc(id)}/teams/${enc(teamId)}` });
    },
    /** List a team's members. */
    listTeamMembers(id: string, teamId: string, query?: OrganizationsListTeamMembersQuery): Promise<OrganizationsListTeamMembersResult> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/teams/${enc(teamId)}/members`, query: { ...query } });
    },
    /** Add an organization member to the team (201; 200 if already in it). */
    addTeamMember(id: string, teamId: string, body: OrganizationsAddTeamMemberBody, idempotencyKey?: string): Promise<OrganizationsAddTeamMemberResult> {
      return request({ method: 'POST', path: `/v1/organizations/${enc(id)}/teams/${enc(teamId)}/members`, body, idempotencyKey });
    },
    /** Remove a user from the team. */
    deleteTeamMember(id: string, teamId: string, userId: string): Promise<OrganizationsDeleteTeamMemberResult> {
      return request({ method: 'DELETE', path: `/v1/organizations/${enc(id)}/teams/${enc(teamId)}/members/${enc(userId)}` });
    },
    /** The roles an organization can assign: the instance-wide roles plus its own custom roles (organization_id set). ?own=true lists only its own. */
    listRoles(id: string, query?: OrganizationsListRolesQuery): Promise<OrganizationsListRolesResult> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/roles`, query: { ...query } });
    },
    /** Create a custom role for one organization, from any of the instance's permissions. Its key must not be an instance-wide role key or one of this organization's; other organizations may reuse it. Emits role.created. */
    createRole(id: string, body: OrganizationsCreateRoleBody, idempotencyKey?: string): Promise<OrganizationsCreateRoleResult> {
      return request({ method: 'POST', path: `/v1/organizations/${enc(id)}/roles`, body, idempotencyKey });
    },
    /** Rename one of the organization's own roles or replace its permissions. Emits role.updated. */
    updateRole(id: string, roleId: string, body: OrganizationsUpdateRoleBody): Promise<OrganizationsUpdateRoleResult> {
      return request({ method: 'PATCH', path: `/v1/organizations/${enc(id)}/roles/${enc(roleId)}`, body });
    },
    /** Delete one of the organization's own roles; ?reassign_to=<role key> moves members and pending invitations first (409 ROLE_IN_USE without it). Emits role.deleted. */
    deleteRole(id: string, roleId: string, query?: OrganizationsDeleteRoleQuery): Promise<OrganizationsDeleteRoleResult> {
      return request({ method: 'DELETE', path: `/v1/organizations/${enc(id)}/roles/${enc(roleId)}`, query: { ...query } });
    },
    /** List the apps (OAuth clients) that hold an active grant in this organization's context, one entry per grant. */
    listConnectedApps(id: string, query?: OrganizationsListConnectedAppsQuery): Promise<OrganizationsListConnectedAppsResult> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/connected_apps`, query: { ...query } });
    },
    /** Revoke one connected app grant of the organization: its tokens and any session minted from it stop working. Emits grant.revoked; audited as organization.connected_app_revoked. */
    deleteConnectedApp(id: string, grantId: string): Promise<OrganizationsDeleteConnectedAppResult> {
      return request({ method: 'DELETE', path: `/v1/organizations/${enc(id)}/connected_apps/${enc(grantId)}` });
    },
    /** The OAuth applications an organization has been given access to. */
    listApplications(id: string, query?: OrganizationsListApplicationsQuery): Promise<OrganizationsListApplicationsResult> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/applications`, query: { ...query } });
    },
    /** Give an organization access to an application (by client id or id), optionally limited to some organization roles. Idempotent; send `enabled: false` to pause access without removing it. Only matters while the application is `restricted`. */
    setApplication(id: string, clientId: string, body: OrganizationsSetApplicationBody): Promise<OrganizationsSetApplicationResult> {
      return request({ method: 'PUT', path: `/v1/organizations/${enc(id)}/applications/${enc(clientId)}`, body });
    },
    /** Take an organization's access to an application away. */
    deleteApplication(id: string, clientId: string): Promise<OrganizationsDeleteApplicationResult> {
      return request({ method: 'DELETE', path: `/v1/organizations/${enc(id)}/applications/${enc(clientId)}` });
    },
    /** Recent alerts sent to an organization's IT contacts, newest first: a single sign-on signing certificate nearing expiry, failing sign-ins, failing SCIM requests. Filter with kind (certificate_expiring, sso_failure, scim_error); page with limit and starting_after. Each alert also fired the organization.it_alert webhook event. Another instance's or org's id is a 404. */
    listItAlerts(id: string, query?: OrganizationsListItAlertsQuery): Promise<OrganizationsListItAlertsResult> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/it_alerts`, query: { ...query } });
    },
    /** The app's event catalog for the endpoint picker (deprecated types left out). */
    listAppEventTypes(id: string, query?: OrganizationsListAppEventTypesQuery): Promise<OrganizationsListAppEventTypesResult> {
      return request({ method: 'GET', path: `/v1/organizations/${enc(id)}/app_event_types`, query: { ...query } });
    },
  };
}
