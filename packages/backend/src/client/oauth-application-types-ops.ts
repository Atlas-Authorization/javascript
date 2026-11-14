import { type RequestFn } from './request';



export interface OauthApplicationTypesListQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type OauthApplicationTypesListResult = {
  object: 'list';
  data: {
    object: 'oauth_application_type';
    key: string;
    name: string;
    description: string;
    defaults: Record<string, unknown>;
  }[];
  has_more: boolean;
};

/** Operations on `/v1/oauth_application_types` (1). */
export function oauthApplicationTypesOpsResource(request: RequestFn) {
  return {
    /** The application types `application_type` accepts when creating an OAuth client (web, spa, native, device, mcp), with the defaults each applies to the fields you leave out. */
    list(query?: OauthApplicationTypesListQuery): Promise<OauthApplicationTypesListResult> {
      return request({ method: 'GET', path: '/v1/oauth_application_types', query: { ...query } });
    },
  };
}
