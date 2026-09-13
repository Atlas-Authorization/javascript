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

export function invitationsResource(request: RequestFn) {
  return {
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
