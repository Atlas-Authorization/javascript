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
  /** Path mount: publish `content` at `url` (status 200, no redirect, never cached), then verify. */
  verification?: DomainVerification;
  /** Path mount, once verified: nothing to add, or the reverse-proxy rule (headers, nginx / Caddy / Traefik snippets). */
  instructions?: Record<string, unknown>;
}

/** What the last failed verification fetch got back. Null on the domain until a check fails. */
export interface DomainVerificationObservation {
  status: number;
  content_type: string | null;
  /** Body bytes seen (headers not counted); a lower bound when `bytes_capped`. */
  bytes: number;
  bytes_capped: boolean;
  /** The first 200 bytes of the body. */
  body_prefix: string;
  final_url: string;
  redirect_to?: string | null;
  age: number | null;
  /** `cf-cache-status` or `x-cache`, when present. */
  cache_status: string | null;
  is_html?: boolean;
  /** A cache answered, not your origin. */
  served_from_cache?: boolean;
  checked_at: number;
}

export interface DomainVerification {
  method: 'https_file';
  url: string;
  token: string;
  content: string;
  instructions: string;
  /** After a rotation: the replaced token's URL, valid until `previous_valid_until`. */
  previous_url?: string;
  previous_valid_until?: number | null;
  last_observation?: DomainVerificationObservation | null;
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
    get(id: string): Promise<CustomDomain> {
      return request({ method: 'GET', path: `/v1/domains/${enc(id)}` });
    },
    /** A path mount: issue a new random verification token (the old one works for 24 hours). Use it when a CDN cached a wrong answer for the old URL. */
    rotateVerification(id: string, idempotencyKey?: string): Promise<CustomDomain> {
      return request({ method: 'POST', path: `/v1/domains/${enc(id)}/verification/rotate`, idempotencyKey });
    },
    verify(id: string): Promise<CustomDomain & { verified: boolean; issuer?: string }> {
      return request({ method: 'POST', path: `/v1/domains/${enc(id)}/verify` });
    },
    delete(id: string): Promise<{ object: 'custom_domain'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/domains/${enc(id)}` });
    },
  };
}
