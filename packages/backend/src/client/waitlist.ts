import { enc, type RequestFn } from './request';
import type { CursorParams } from './types';

export interface WaitlistEntry {
  object: 'waitlist_entry';
  id: string;
  email_address: string;
  status: string;
  note: string | null;
  decided_by: string | null;
  decided_at: number | null;
  created_at: number;
}

export interface ListWaitlistParams extends CursorParams {
  status?: string;
  query?: string;
}

export interface ListWaitlistResponse {
  object: 'list';
  data: WaitlistEntry[];
  counts: Record<string, number>;
  has_more: boolean;
  next_cursor: string | null;
}

export interface BulkWaitlistResult {
  object: 'list';
  data: WaitlistEntry[];
  errors: Array<{ index: number; email_address: string; code: string; message: string }>;
}

export function waitlistResource(request: RequestFn) {
  return {
    /** Add an address to the waitlist. Idempotent on the address. */
    create(body: { email_address: string }, idempotencyKey?: string): Promise<WaitlistEntry> {
      return request({ method: 'POST', path: '/v1/waitlist_entries', body, idempotencyKey });
    },
    /** Add up to 100 addresses; per-entry errors are returned, not thrown. */
    bulkCreate(emailAddresses: string[], idempotencyKey?: string): Promise<BulkWaitlistResult> {
      return request({
        method: 'POST',
        path: '/v1/waitlist_entries/bulk',
        body: { email_addresses: emailAddresses },
        idempotencyKey,
      });
    },
    delete(id: string): Promise<{ object: 'waitlist_entry'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/waitlist_entries/${enc(id)}` });
    },
    list(params: ListWaitlistParams = {}): Promise<ListWaitlistResponse> {
      return request({ method: 'GET', path: '/v1/waitlist_entries', query: { ...params } });
    },
    /** Approve or deny a waitlist entry. */
    decide(
      id: string,
      body: { status: 'approved' | 'denied'; note?: string },
    ): Promise<WaitlistEntry> {
      return request({ method: 'POST', path: `/v1/waitlist_entries/${enc(id)}/decide`, body });
    },
  };
}
