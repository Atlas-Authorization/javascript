import { enc, type RequestFn } from './request';



export type AllowlistIdentifiersDeleteResult = {
  object: 'allowlist_identifier';
  id: string;
  deleted: true;
};

/** Operations on `/v1/allowlist_identifiers` (1). */
export function allowlistIdentifiersOpsResource(request: RequestFn) {
  return {
    /** Remove an allowlist identifier. Another instance id is 404, never 403. */
    delete(id: string): Promise<AllowlistIdentifiersDeleteResult> {
      return request({ method: 'DELETE', path: `/v1/allowlist_identifiers/${enc(id)}` });
    },
  };
}
