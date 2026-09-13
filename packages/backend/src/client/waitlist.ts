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

export function waitlistResource(request: RequestFn) {
  return {
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
