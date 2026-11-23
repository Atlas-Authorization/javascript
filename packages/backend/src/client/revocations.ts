import { type RequestFn } from './request';
import type { RevocationFrame } from '../revocation-stream';

export interface RevocationsQuery {
  /** Resume cursor: the `next_cursor` of the previous answer. */
  after?: string;
  since?: string;
  /** Comma-separated kinds to keep. */
  kinds?: string;
  limit?: string;
  /** Seconds (up to 30) to hold the request open until an event arrives. */
  wait?: string;
  starting_after?: string;
}

export interface RevocationsPage {
  object: 'list';
  data: RevocationFrame[];
  /** True when a full page was returned: ask again at once. */
  has_more?: boolean;
  /** Pass as `after` on the next call. */
  next_cursor?: string;
  retention?: { days?: number };
}

/** Operations on `/v1/revocations`. */
export function revocationsResource(request: RequestFn) {
  return {
    /** Long-poll the revocation stream: everything that ended a session, token family, API key, machine, grant or a person's access, in commit order. Resume with `after`. */
    list(query: RevocationsQuery = {}): Promise<RevocationsPage> {
      return request({ method: 'GET', path: '/v1/revocations', query: { ...query } });
    },
  };
}
