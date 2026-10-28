import type { FapiClient, FapiResponse } from './fapi';
import type { FieldError } from './attempt';

/**
 * Share a resource with the members of an organization you administer, and read what roles a resource type has.
 * The calls behind `<ShareDialog/>` and `<RoleMatrix/>`. The server is the authority: it lets an organization share
 * only what it holds the `share` permission on, and only roles it already holds there.
 */

export interface ShareableResource {
  object: 'resource';
  id: string;
  type: string;
  external_id: string;
  name: string | null;
  parent_id: string | null;
}
export interface ShareRole {
  key: string;
  name: string;
  permissions: string[];
}
export interface ResourceShare {
  object: 'resource_role_assignment';
  id: string;
  resource_id: string;
  subject: { type: 'user' | 'group' | 'org'; id: string };
  role: string;
  inherit: boolean;
  created_at: number;
}
export interface ResourceShares {
  object: 'resource_shares';
  resource: ShareableResource;
  roles: ShareRole[];
  data: ResourceShare[];
}
export interface RoleMatrixData {
  key: string;
  name: string;
  permissions: string[];
  matrix: Array<{ role: string; name: string; grants: Record<string, boolean> }>;
}

export type SharingResult<T> = { ok: true; data: T } | { ok: false; errors: FieldError[] };
const wrap = <T>(res: FapiResponse<T>): SharingResult<T> => (res.ok && res.data !== null ? { ok: true, data: res.data } : { ok: false, errors: res.errors });
const base = (orgId: string) => `/v1/client/organizations/${encodeURIComponent(orgId)}`;

export async function listShareableResources(client: FapiClient, organizationId: string, opts: { type?: string; limit?: number } = {}): Promise<SharingResult<ShareableResource[]>> {
  const q = new URLSearchParams();
  if (opts.type) q.set('type', opts.type);
  if (opts.limit) q.set('limit', String(opts.limit));
  const r = wrap(await client.get<{ data: ShareableResource[] }>(`${base(organizationId)}/shareable_resources${q.size ? `?${q}` : ''}`));
  return r.ok ? { ok: true, data: r.data.data } : r;
}

export async function listResourceShares(client: FapiClient, organizationId: string, resourceId: string): Promise<SharingResult<ResourceShares>> {
  return wrap(await client.get<ResourceShares>(`${base(organizationId)}/resources/${encodeURIComponent(resourceId)}/shares`));
}

/** Share with an organization member as `role`. A refusal says why: not a member, unknown role, or a role beyond what the organization holds. */
export async function shareResource(client: FapiClient, organizationId: string, resourceId: string, input: { userId: string; role: string }): Promise<SharingResult<ResourceShare>> {
  return wrap(await client.post<ResourceShare>(`${base(organizationId)}/resources/${encodeURIComponent(resourceId)}/shares`, { user_id: input.userId, role: input.role }));
}

export async function unshareResource(client: FapiClient, organizationId: string, resourceId: string, shareId: string): Promise<SharingResult<{ id: string; deleted: true }>> {
  return wrap(await client.request<{ id: string; deleted: true }>(`${base(organizationId)}/resources/${encodeURIComponent(resourceId)}/shares/${encodeURIComponent(shareId)}`, { method: 'DELETE' }));
}

export async function getRoleMatrix(client: FapiClient, organizationId: string, resourceType: string): Promise<SharingResult<RoleMatrixData>> {
  return wrap(await client.get<RoleMatrixData>(`${base(organizationId)}/resource_types/${encodeURIComponent(resourceType)}`));
}
