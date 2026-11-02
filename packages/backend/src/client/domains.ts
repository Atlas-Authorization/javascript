import { enc, type RequestFn } from './request';

export interface CustomDomain {
  object: 'custom_domain';
  id: string;
  role: 'fapi' | 'accounts';
  host: string;
  status: string;
  action: string;
  live: boolean;
  /** 'path': a path mount on your own host, proven by an https file (no DNS). */
  method?: 'cname' | 'path';
  /** Null for a path mount (no CNAME). */
  cname_target: string | null;
  last_checked_at: number | null;
  last_observed_target: string | null;
  failure_reason: string | null;
  certificate_expires_at: number | null;
  cookie_domain: string | null;
  /** DNS automation: the provider Atlas writes this host's record with (the token is never returned). */
  dns?: { provider: 'cloudflare'; token_set: boolean } | null;
  /** Path mount: the prefix the Frontend API is served under. */
  base_path?: string | null;
  /** Path mount, once verified: Atlas routes it (`atlas_ingress`), or your reverse proxy does (`customer_proxy`). */
  routing?: 'atlas_ingress' | 'customer_proxy' | null;
  /** Path mount: `https://<host><base_path>`, the Frontend API and (once verified) the issuer. */
  frontend_api_url?: string;
  /** Path mount: publish `content` at `url` (status 200, no redirect), then verify. */
  verification?: { method: 'https_file'; url: string; token: string; content: string; instructions: string };
  /** Path mount, once verified: nothing to add, or the reverse-proxy rule (headers, nginx / Caddy / Traefik snippets). */
  instructions?: Record<string, unknown>;
}

/** POST /v1/domains with method "path": the Frontend API under a path on a host you already run. */
export interface CreatePathMountInput {
  method: 'path';
  hostname: string;
  /** Default `/__atlas`. */
  base_path?: string;
  role?: 'fapi';
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
      body: { host: string; role?: 'fapi' | 'accounts'; method?: 'cname'; dns?: CustomDomainDnsInput } | CreatePathMountInput,
      idempotencyKey?: string,
    ): Promise<CustomDomain & { instructions?: Record<string, unknown>; note?: string }> {
      return request({ method: 'POST', path: '/v1/domains', body, idempotencyKey });
    },
    verify(id: string): Promise<CustomDomain & { verified: boolean; issuer?: string }> {
      return request({ method: 'POST', path: `/v1/domains/${enc(id)}/verify` });
    },
    delete(id: string): Promise<{ object: 'custom_domain'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/domains/${enc(id)}` });
    },
  };
}
