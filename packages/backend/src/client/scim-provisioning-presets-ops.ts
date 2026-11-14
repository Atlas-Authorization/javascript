import { type RequestFn } from './request';



export interface ScimProvisioningPresetsListQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type ScimProvisioningPresetsListResult = {
  object?: 'list';
  data?: ({
    id?: string;
    name?: string;
    base_url_template?: string;
    params?: {
      key?: string;
      label?: string;
    }[];
    deprovision_action?: string;
    token_hint?: string | null;
  })[];
  has_more?: boolean;
};

/** Operations on `/v1/scim_provisioning_presets` (1). */
export function scimProvisioningPresetsOpsResource(request: RequestFn) {
  return {
    /** List the pre-built outbound provisioning targets (Slack, GitHub, Zoom, Salesforce, Atlassian) with their base-URL template and required parameters. */
    list(query?: ScimProvisioningPresetsListQuery): Promise<ScimProvisioningPresetsListResult> {
      return request({ method: 'GET', path: '/v1/scim_provisioning_presets', query: { ...query } });
    },
  };
}
