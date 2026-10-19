import { enc, type RequestFn } from './request';

export interface CustomDomain {
  object: 'custom_domain';
  id: string;
  role: 'fapi' | 'accounts';
  host: string;
  status: string;
  action: string;
  live: boolean;
  cname_target: string;
  last_checked_at: number | null;
  last_observed_target: string | null;
  failure_reason: string | null;
  certificate_expires_at: number | null;
  cookie_domain: string | null;
  /** DNS automation: the provider Atlas writes this host's record with (the token is never returned). */
  dns?: { provider: 'cloudflare'; token_set: boolean } | null;
}

/** Let Atlas write the domain's DNS record. The token is write-only. */
export interface CustomDomainDnsInput {
  provider: 'cloudflare';
  api_token: string;
  /** Replace a conflicting existing record. */
  overwrite?: boolean;
}

export interface ListDomainsResponse {
  object: 'list';
  data: CustomDomain[];
  cname_target: string;
  instructions: Record<string, unknown>;
  cookie_checks: Array<{ origin: string; first_party: boolean }>;
  required: boolean;
  environment: string | undefined;
}

export function domainsResource(request: RequestFn) {
  return {
    list(): Promise<ListDomainsResponse> {
      return request({ method: 'GET', path: '/v1/domains' });
    },
    create(
      body: { host: string; role?: 'fapi' | 'accounts'; dns?: CustomDomainDnsInput },
      idempotencyKey?: string,
    ): Promise<CustomDomain & { instructions: Record<string, unknown> }> {
      return request({ method: 'POST', path: '/v1/domains', body, idempotencyKey });
    },
    verify(id: string): Promise<CustomDomain & { verified: boolean }> {
      return request({ method: 'POST', path: `/v1/domains/${enc(id)}/verify` });
    },
    delete(id: string): Promise<{ object: 'custom_domain'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/domains/${enc(id)}` });
    },
  };
}
