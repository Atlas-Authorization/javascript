import { enc, type RequestFn } from './request';

export interface AllowlistIdentifier {
  object: 'allowlist_identifier';
  id: string;
  identifier: string;
  created_at: number;
}

export interface BlocklistIdentifier {
  object: 'blocklist_identifier';
  id: string;
  identifier: string;
  created_at: number;
}

/**
 * Allowlist and blocklist share an identical route shape, so they share a
 * factory. `path` and the `object` literal differ; nothing else does.
 */
function restrictionResource<T extends { id: string }>(request: RequestFn, path: string) {
  return {
    list(): Promise<{ object: 'list'; data: T[]; has_more: false }> {
      return request({ method: 'GET', path });
    },
    add(identifier: string): Promise<T> {
      return request({ method: 'POST', path, body: { identifier } });
    },
    remove(id: string): Promise<{ object: string; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `${path}/${enc(id)}` });
    },
  };
}

export function allowlistResource(request: RequestFn) {
  return restrictionResource<AllowlistIdentifier>(request, '/v1/allowlist_identifiers');
}

export function blocklistResource(request: RequestFn) {
  return restrictionResource<BlocklistIdentifier>(request, '/v1/blocklist_identifiers');
}
