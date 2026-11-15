import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/** A verified publisher of OAuth apps: a domain the instance owner proved they control, and the apps on it. */
export interface OAuthPublisher {
  object: 'oauth_publisher';
  id: string;
  name: string;
  domain: string;
  /** True once the DNS TXT record was found. Only a verified publisher is named on consent screens, shares a sector or skips consent. */
  verified: boolean;
  verified_at: number | null;
  last_checked_at: number | null;
  /** Publish a TXT record with this name and `record_value` to verify the domain. */
  record_name: string;
  record_value: string;
  shared_sector: boolean;
  /** The shared sector (the domain) when `shared_sector` is on and the domain is verified. */
  sector_identifier: string | null;
  skip_consent: boolean;
  /** Public client ids of the attached apps. */
  client_ids: string[];
  created_at: number;
  updated_at: number;
}

export interface CreateOAuthPublisherBody {
  name: string;
  /** The domain to prove, for example `example.com`. Fixed at create. */
  domain: string;
  /** Only `false` is accepted at create: a shared sector needs the verified domain first. */
  shared_sector?: boolean;
  skip_consent?: boolean;
}

export type UpdateOAuthPublisherBody = Partial<Omit<CreateOAuthPublisherBody, 'domain'>>;

/** Verified publishers: one name and domain for a family of apps, an opt-in shared pairwise sector, and one consent across them. */
export function oauthPublishersResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<OAuthPublisher>> {
      return request({ method: 'GET', path: '/v1/oauth_publishers' });
    },
    create(body: CreateOAuthPublisherBody): Promise<OAuthPublisher> {
      return request({ method: 'POST', path: '/v1/oauth_publishers', body });
    },
    get(id: string): Promise<OAuthPublisher> {
      return request({ method: 'GET', path: `/v1/oauth_publishers/${enc(id)}` });
    },
    update(id: string, body: UpdateOAuthPublisherBody): Promise<OAuthPublisher> {
      return request({ method: 'PATCH', path: `/v1/oauth_publishers/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'oauth_publisher'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/oauth_publishers/${enc(id)}` });
    },
    /** Look up the DNS TXT record; `record_found` says what this check saw. */
    verify(id: string): Promise<OAuthPublisher & { record_found: boolean }> {
      return request({ method: 'POST', path: `/v1/oauth_publishers/${enc(id)}/verify` });
    },
    /** Attach an app by its public client id. `allow_subject_change` confirms moving a pairwise app to the shared sector. */
    attachClient(id: string, clientId: string, body: { allow_subject_change?: boolean } = {}): Promise<OAuthPublisher> {
      return request({ method: 'PUT', path: `/v1/oauth_publishers/${enc(id)}/clients/${enc(clientId)}`, body });
    },
    detachClient(id: string, clientId: string): Promise<OAuthPublisher> {
      return request({ method: 'DELETE', path: `/v1/oauth_publishers/${enc(id)}/clients/${enc(clientId)}` });
    },
  };
}
