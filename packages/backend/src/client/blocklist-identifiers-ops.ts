import { enc, type RequestFn } from './request';



export type BlocklistIdentifiersDeleteResult = {
  object: 'blocklist_identifier';
  id: string;
  deleted: true;
};

/** Operations on `/v1/blocklist_identifiers` (1). */
export function blocklistIdentifiersOpsResource(request: RequestFn) {
  return {
    /** Remove a blocklist identifier. Another instance id is 404, never 403. */
    delete(id: string): Promise<BlocklistIdentifiersDeleteResult> {
      return request({ method: 'DELETE', path: `/v1/blocklist_identifiers/${enc(id)}` });
    },
  };
}
