import { enc, type RequestFn } from './request';



export interface AdministrativeUnitsListQuery {
  /** Only units limited to this organization. */
  organization_id?: string;
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type AdministrativeUnitsListResult = {
  object: 'list';
  data: ({
    object: 'administrative_unit';
    id: string;
    key: string;
    name: string;
    description?: string | null;
    /** Limits the unit to one organization; null = usable in any. */
    organization_id?: string | null;
    kind: 'static' | 'dynamic';
    filter?: {
      /** Members of this instance group (id or slug). */
      group?: string;
      /** People with a verified email on this domain. */
      email_domain?: string;
      /** People holding this role in the unit's organization. */
      org_role?: string;
      /** public_metadata[key] equals this value. */
      metadata?: {
        key: string;
        equals: unknown;
      };
    } | null;
    /** Listed members of a static unit. */
    member_count?: number;
    /** Created, Unix ms. */
    created_at: number;
    /** Updated, Unix ms. */
    updated_at?: number;
  })[];
  has_more: boolean;
};

export type AdministrativeUnitsCreateBody = {
  key: string;
  name: string;
  description?: string;
  organization_id?: string | null;
  /** All conditions given must hold. A unit with a filter is dynamic: its members are whoever match now. */
  filter?: {
    /** Members of this instance group (id or slug). */
    group?: string;
    /** People with a verified email on this domain. */
    email_domain?: string;
    /** People holding this role in the unit's organization. */
    org_role?: string;
    /** public_metadata[key] equals this value. */
    metadata?: {
      key: string;
      equals: unknown;
    };
  };
};

export type AdministrativeUnitsCreateResult = {
  object: 'administrative_unit';
  id: string;
  key: string;
  name: string;
  description?: string | null;
  /** Limits the unit to one organization; null = usable in any. */
  organization_id?: string | null;
  kind: 'static' | 'dynamic';
  filter?: {
    /** Members of this instance group (id or slug). */
    group?: string;
    /** People with a verified email on this domain. */
    email_domain?: string;
    /** People holding this role in the unit's organization. */
    org_role?: string;
    /** public_metadata[key] equals this value. */
    metadata?: {
      key: string;
      equals: unknown;
    };
  } | null;
  /** Listed members of a static unit. */
  member_count?: number;
  /** Created, Unix ms. */
  created_at: number;
  /** Updated, Unix ms. */
  updated_at?: number;
};

export type AdministrativeUnitsGetResult = {
  object: 'administrative_unit';
  id: string;
  key: string;
  name: string;
  description?: string | null;
  /** Limits the unit to one organization; null = usable in any. */
  organization_id?: string | null;
  kind: 'static' | 'dynamic';
  filter?: {
    /** Members of this instance group (id or slug). */
    group?: string;
    /** People with a verified email on this domain. */
    email_domain?: string;
    /** People holding this role in the unit's organization. */
    org_role?: string;
    /** public_metadata[key] equals this value. */
    metadata?: {
      key: string;
      equals: unknown;
    };
  } | null;
  /** Listed members of a static unit. */
  member_count?: number;
  /** Created, Unix ms. */
  created_at: number;
  /** Updated, Unix ms. */
  updated_at?: number;
};

export type AdministrativeUnitsUpdateBody = {
  name?: string;
  description?: string | null;
  filter?: {
    /** Members of this instance group (id or slug). */
    group?: string;
    /** People with a verified email on this domain. */
    email_domain?: string;
    /** People holding this role in the unit's organization. */
    org_role?: string;
    /** public_metadata[key] equals this value. */
    metadata?: {
      key: string;
      equals: unknown;
    };
  } | null;
};

export type AdministrativeUnitsUpdateResult = {
  object: 'administrative_unit';
  id: string;
  key: string;
  name: string;
  description?: string | null;
  /** Limits the unit to one organization; null = usable in any. */
  organization_id?: string | null;
  kind: 'static' | 'dynamic';
  filter?: {
    /** Members of this instance group (id or slug). */
    group?: string;
    /** People with a verified email on this domain. */
    email_domain?: string;
    /** People holding this role in the unit's organization. */
    org_role?: string;
    /** public_metadata[key] equals this value. */
    metadata?: {
      key: string;
      equals: unknown;
    };
  } | null;
  /** Listed members of a static unit. */
  member_count?: number;
  /** Created, Unix ms. */
  created_at: number;
  /** Updated, Unix ms. */
  updated_at?: number;
};

export type AdministrativeUnitsDeleteResult = {
  object: 'administrative_unit';
  id: string;
  deleted: true;
};

export interface AdministrativeUnitsListMembersQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type AdministrativeUnitsListMembersResult = {
  object: 'list';
  data: {
    object: 'administrative_unit_member';
    user_id: string;
  }[];
  has_more: boolean;
};

export type AdministrativeUnitsAddMemberBody = {
  add?: string[];
  remove?: string[];
};

export type AdministrativeUnitsAddMemberResult = {
  object: 'administrative_unit_members_change';
  added: number;
  removed: number;
};

/** Operations on `/v1/administrative_units` (7). */
export function administrativeUnitsOpsResource(request: RequestFn) {
  return {
    /** List administrative units: named sets of users that a scoped organization administrator may manage. */
    list(query?: AdministrativeUnitsListQuery): Promise<AdministrativeUnitsListResult> {
      return request({ method: 'GET', path: '/v1/administrative_units', query: { ...query } });
    },
    /** Create an administrative unit. Without a `filter` it is static and you list its members; with one it is dynamic and its members are whoever match. */
    create(body: AdministrativeUnitsCreateBody, idempotencyKey?: string): Promise<AdministrativeUnitsCreateResult> {
      return request({ method: 'POST', path: '/v1/administrative_units', body, idempotencyKey });
    },
    /** Read one unit by id or key. */
    get(id: string): Promise<AdministrativeUnitsGetResult> {
      return request({ method: 'GET', path: `/v1/administrative_units/${enc(id)}` });
    },
    /** Change a unit's name, description or filter. */
    update(id: string, body: AdministrativeUnitsUpdateBody): Promise<AdministrativeUnitsUpdateResult> {
      return request({ method: 'PATCH', path: `/v1/administrative_units/${enc(id)}`, body });
    },
    /** Delete a unit. A membership scope that named it stops reaching those people. */
    delete(id: string): Promise<AdministrativeUnitsDeleteResult> {
      return request({ method: 'DELETE', path: `/v1/administrative_units/${enc(id)}` });
    },
    /** The listed members of a static unit (409 for a dynamic unit). */
    listMembers(id: string, query?: AdministrativeUnitsListMembersQuery): Promise<AdministrativeUnitsListMembersResult> {
      return request({ method: 'GET', path: `/v1/administrative_units/${enc(id)}/members`, query: { ...query } });
    },
    /** Add and remove people on a static unit. */
    addMember(id: string, body: AdministrativeUnitsAddMemberBody, idempotencyKey?: string): Promise<AdministrativeUnitsAddMemberResult> {
      return request({ method: 'POST', path: `/v1/administrative_units/${enc(id)}/members`, body, idempotencyKey });
    },
  };
}
