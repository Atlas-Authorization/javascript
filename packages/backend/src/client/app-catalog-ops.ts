import { enc, type RequestFn } from './request';



export type AppCatalogVoteRequestResult = {
  object?: 'app_request';
  id?: string;
  name?: string;
  protocol?: 'saml' | 'oidc';
  docs_url?: string | null;
  note?: string | null;
  status?: string;
  requested_by?: string | null;
  votes?: number;
  [key: string]: unknown;
};

/** Operations on `/v1/app_catalog` (1). */
export function appCatalogOpsResource(request: RequestFn) {
  return {
    /** Add one vote to an open or in-progress app request (409 when it is available or declined, 404 when unknown). One vote per person or key: a repeat vote changes nothing. */
    voteRequest(id: string): Promise<AppCatalogVoteRequestResult> {
      return request({ method: 'POST', path: `/v1/app_catalog/requests/${enc(id)}/vote` });
    },
  };
}
