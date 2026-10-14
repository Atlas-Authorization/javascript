import { enc, type RequestFn } from './request';
import type { CursorPage, CursorParams, Metadata } from './types';

export interface Invitation {
  object: 'invitation';
  id: string;
  email_address: string;
  status: string;
  public_metadata: Metadata;
  expires_at: number;
  accepted_at: number | null;
  created_at: number;
}

export interface CreateInvitationBody {
  email_address: string;
  public_metadata?: Metadata;
}

/** A per-entry failure from a bulk create; `index` points into the request array. */
export interface BulkInvitationError {
  index: number;
  email_address: string | null;
  code: string;
  message: string;
}

export interface BulkInvitationsResult {
  object: 'list';
  data: Invitation[];
  errors: BulkInvitationError[];
}

export function invitationsResource(request: RequestFn) {
  return {
    /** Create up to 100 invitations; each entry is validated and de-duplicated on its own. */
    bulkCreate(
      invitations: CreateInvitationBody[],
      idempotencyKey?: string,
    ): Promise<BulkInvitationsResult> {
      return request({
        method: 'POST',
        path: '/v1/invitations/bulk',
        body: { invitations },
        idempotencyKey,
      });
    },
    list(params: CursorParams = {}): Promise<CursorPage<Invitation>> {
      return request({ method: 'GET', path: '/v1/invitations', query: { ...params } });
    },
    create(body: CreateInvitationBody, idempotencyKey?: string): Promise<Invitation> {
      return request({ method: 'POST', path: '/v1/invitations', body, idempotencyKey });
    },
    revoke(id: string): Promise<Invitation> {
      return request({ method: 'POST', path: `/v1/invitations/${enc(id)}/revoke` });
    },
  };
}
