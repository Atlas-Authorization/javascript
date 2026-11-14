import { enc, type RequestFn } from './request';



export type SessionsGetStatusResult = {
  id: string;
  status: 'active' | 'expired' | 'revoked' | 'ended';
  user_id: string;
  /** Epoch ms. */
  expires_at: number | null;
  /** Epoch ms; absent for a device or CIBA sign-in. */
  last_active_at?: number | null;
};

/** Operations on `/v1/sessions` (1). */
export function sessionsOpsResource(request: RequestFn) {
  return {
    /** Cheap session-freshness check for a relying party: `{ id, status, user_id, expires_at, last_active_at? }`, where status is active, expired, revoked or ended. `:id` is the session id or the `sid` claim of an ID token (a device or CIBA sign-in answers from its grant, without last_active_at). Sent with `Cache-Control: private, max-age=5` and an ETag; `If-None-Match` answers 304. Another instance session is 404, never 403. A banned user session is revoked at once and the back-channel logout is sent in the same request. */
    getStatus(id: string): Promise<SessionsGetStatusResult> {
      return request({ method: 'GET', path: `/v1/sessions/${enc(id)}/status` });
    },
  };
}
