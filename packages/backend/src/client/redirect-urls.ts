import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** An allowlisted OAuth/SSO redirect URL. */
export interface RedirectUrl {
  object: 'redirect_url';
  id: string;
  url: string;
  /** Epoch ms. */
  created_at: number;
}

export function redirectUrlsResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<RedirectUrl> & { next_cursor?: string | null }> {
      return request({ method: 'GET', path: '/v1/redirect_urls' });
    },
    /** Add an absolute http(s) URL. Idempotent on the URL. */
    create(url: string, idempotencyKey?: string): Promise<RedirectUrl> {
      return request({ method: 'POST', path: '/v1/redirect_urls', body: { url }, idempotencyKey });
    },
    get(id: string): Promise<RedirectUrl> {
      return request({ method: 'GET', path: `/v1/redirect_urls/${enc(id)}` });
    },
    delete(id: string): Promise<{ object: 'redirect_url'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/redirect_urls/${enc(id)}` });
    },
  };
}
