import { DEFAULT_API_URL, type RequestFn } from './request';
import type { ListPage } from './types';
import type { AtlasIdAppPreflight } from './platform';
import { verifyWebhook, type VerifyWebhookInput, type WebhookVerifyResult } from '../webhooks';

/**
 * The instance's own credentials (scoped secret keys, the standard key list,
 * whoami), partner links, and Sign in with Atlas grant revocation for apps
 * the instance manages.
 */

export type KeyKind = 'secret_key' | 'platform_key' | 'account_key' | 'webhook_secret' | 'partner_link' | 'access_token';

/** The standard key shape every credential listing uses. */
export interface StandardKey {
  object: 'key' | 'secret_key';
  id: string;
  kind: KeyKind;
  /** `atlas` = `atlas_<env>_<kind>_…`; `legacy` = `sk_` / `psk_` / `whsec_` / `dsk_`. */
  format: 'atlas' | 'legacy';
  prefix: string;
  name: string | null;
  owner: string | null;
  scopes: string[];
  environment: 'live' | 'test' | null;
  resource: { type: 'instance' | 'account' | 'application' | 'webhook_endpoint'; id: string };
  expires_at: number | null;
  expires_in_days: number | null;
  status: 'active' | 'expiring' | 'expired' | 'revoked';
  ip_allowlist: string[];
  origin_allowlist: string[];
  last_used_at: number | null;
  last_used_ip: string | null;
  created_at: number;
  revoked_at: number | null;
}

export interface SecretKey extends StandardKey {
  object: 'secret_key';
  allowed_ips: string[];
  /** Alias of `origin_allowlist`: browser origins the key may be used from (empty = any). */
  allowed_origins: string[];
  /** Partner admin: the organizations the key is limited to (empty = unrestricted). */
  organization_ids: string[];
  rotated_from: string | null;
  /** Provisioning tags (filter the list with `metadata`). */
  metadata?: Record<string, string | number | boolean>;
  /** The idempotent-create key the key was created with, if any. */
  external_ref?: string | null;
}

/** A create/rotate response: the secret is present once (or sealed, with a secret recipient). */
export interface SecretKeyWithSecret extends SecretKey {
  /** Absent on an `external_ref` replay (`idempotent_replay: true`): the secret was shown at the first create. */
  secret?: string;
  sealed_secret?: string;
  idempotent_replay?: boolean;
  note: string;
}

export interface CreateSecretKeyBody {
  name?: string;
  /** Instance scopes, or presets `read_only`, `privacy:execute`, `privacy:grants:revoke`. */
  scopes: string[];
  /** Unix ms or ISO 8601; at most one year away. Default: one year. Every new key expires. */
  expires_at?: number | string;
  /** CIDRs the key may be used from. */
  allowed_ips?: string[];
  /** Browser origins (`https://app.example.com`, `https://*.example.com`) a request with an Origin must come from. */
  allowed_origins?: string[];
  /**
   * Partner admin: limit the key to these organizations. A limited key may call only the organization routes for them.
   */
  organization_ids?: string[];
  /** The person or service responsible. Default: whoever creates the key. */
  owner?: string | null;
  /** `atlas` (default) or `legacy`. */
  key_format?: 'atlas' | 'legacy';
  /** Idempotent create: a second create with the same ref returns the existing key (without its secret). */
  external_ref?: string;
  /** Provisioning tags (up to 20; string, number or boolean values). */
  metadata?: Record<string, string | number | boolean>;
}

export interface Whoami {
  object: 'whoami';
  key: {
    id: string | null;
    type: 'secret' | 'publishable' | 'platform' | 'partner_link' | 'access_token';
    prefix: string | null;
    environment: 'live' | 'test' | null;
    scopes: string[];
    effective_scopes: string[];
    owner: string | null;
    created_at: number | null;
    expires_at: number | null;
    last_used_at: number | null;
    last_used_ip?: string | null;
    application_ids?: string[];
  };
  instance: { id: string; environment: string | null; issuer?: string; discovery_url?: string; jwks_uri?: string } | null;
  account: { id: string | null };
  platform?: { id: string };
  partner?: { link_id: string; id: string; name: string | null };
  operator?: { sub: string; auth_time: number | null; acr: string | null; amr: string[] };
}

export interface PartnerLink {
  object: 'partner_link';
  id: string;
  client_id: string;
  /** Any lowercase id; cookiemunch, chatly, forumulate and referalli are presets. */
  partner: string;
  name: string;
  preset: boolean;
  resource: string;
  scopes: string[];
  client_secret_prefix: string;
  token_endpoint: string;
  /** mTLS: client-certificate SHA-256 fingerprints (base64url) every use must present; [] = none. */
  cert_fingerprints: string[];
  auth_methods: string[];
  /** The partner link request this link was approved from; null when created by hand. */
  request_id: string | null;
  status: 'active' | 'expired' | 'revoked';
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  calls_30d: number;
  created_at: number;
  client_secret?: string;
  sealed_client_secret?: string;
}

/** A consent manager's script the hosted pages load (any CMP). */
export interface PartnerLinkCmp {
  script_url: string;
  script_id?: string | null;
  site_id?: string | null;
  blocking_mode?: string | null;
  extra_origins?: string[];
  settings_preset?: 'cookiemunch' | 'cookiebot' | 'onetrust' | 'custom' | null;
  /** The CMP's consent API on the page: Atlas reads (and, with request_method, records) consent through it. */
  consent_api?: { global: string; has_method?: string | null; request_method?: string | null; category_map?: Record<string, string> | null } | null;
}

/** A partner link request: a partner asking this instance (inbound), or Atlas asking a partner (outbound). */
export interface PartnerLinkRequest {
  object: 'partner_link_request';
  id: string;
  direction: 'inbound' | 'outbound';
  partner: string;
  name: string;
  preset: boolean;
  resource: string | null;
  scopes: string[];
  callback_url: string | null;
  callback_host: string | null;
  cert_fingerprints: string[];
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'delivery_failed' | 'installed' | 'failed';
  link_id: string | null;
  remote_request_id: string | null;
  decided_by: string | null;
  decided_at: number | null;
  delivery_attempts: number;
  delivered_at: number | null;
  last_error: string | null;
  expires_at: number;
  created_at: number;
}

export interface PartnerLinkRequestApproval extends PartnerLinkRequest {
  delivered: boolean;
  link: PartnerLink | null;
  note: string;
}

export interface OutboundPartnerLink {
  object: 'outbound_partner_link';
  id: string;
  partner: string;
  name: string;
  preset: boolean;
  resource: string | null;
  scopes: string[];
  base_url: string;
  token_url: string;
  client_id: string;
  auth_method: 'client_credentials' | 'bearer_secret';
  has_client_secret: true;
  /** manual, oauth_install (delivered by the partner), or registration (a partner platform's stored partner token). */
  source: 'manual' | 'oauth_install' | 'registration';
  status: 'active' | 'revoked' | 'failing';
  /** The consent manager this partner brings to the hosted pages, or null. */
  cmp: PartnerLinkCmp | null;
  /** True when `cmp` is derived (a Cookie Munch link with a `site:<id>` resource). */
  cmp_default: boolean;
  expires_at: number | null;
  last_used_at: number | null;
  last_error: string | null;
  last_error_at: number | null;
  calls_30d: number;
  created_at: number;
  updated_at: number;
}

export interface SaveOutboundPartnerLinkBody {
  client_id: string;
  client_secret: string;
  scopes?: string[];
  resource?: string;
  /** Required for a partner that is not a preset. */
  base_url?: string;
  token_url?: string;
  auth_method?: 'client_credentials' | 'bearer_secret';
  name?: string;
  expires_at?: number | string | null;
  /**
   * A consent-manager partner's script for the hosted pages. Used while the
   * instance has no cookie_consent setting of its own. Null clears it; absent
   * keeps it.
   */
  cmp?: PartnerLinkCmp | null;
}

export interface AtlasIdGrantLookup {
  object: 'atlas_id_user';
  sub: string;
  grant_id: string;
  scopes: string[];
  granted_at: number;
}

export interface InstanceAtlasIdGrantRevocation {
  object: 'atlas_id_grant';
  id: string;
  sub: string;
  revoked: true;
  tokens_revoked: number;
  backchannel_logouts: number;
}

const enc = encodeURIComponent;

export function whoamiResource(request: RequestFn) {
  /** Introspect the key this client uses. */
  return (): Promise<Whoami> => request({ method: 'GET', path: '/v1/whoami' });
}

export function secretKeysResource(request: RequestFn) {
  return {
    create(body: CreateSecretKeyBody): Promise<SecretKeyWithSecret> {
      return request({ method: 'POST', path: '/v1/secret_keys', body });
    },
    /** `metadata` filters on provisioning tags (`?metadata[key]=value`). */
    list(params: { metadata?: Record<string, string> } = {}): Promise<ListPage<SecretKey>> {
      const query: Record<string, string> = {};
      for (const [k, v] of Object.entries(params.metadata ?? {})) query[`metadata[${k}]`] = v;
      return request({ method: 'GET', path: '/v1/secret_keys', ...(Object.keys(query).length ? { query } : {}) });
    },
    get(id: string): Promise<SecretKey> {
      return request({ method: 'GET', path: `/v1/secret_keys/${enc(id)}` });
    },
    update(
      id: string,
      body: {
        name?: string | null;
        owner?: string | null;
        expires_at?: number | string | null;
        allowed_ips?: string[];
        allowed_origins?: string[];
        /** `[]` lifts an organization limit. */
        organization_ids?: string[];
        metadata?: Record<string, string | number | boolean> | null;
      },
    ): Promise<SecretKey> {
      return request({ method: 'PATCH', path: `/v1/secret_keys/${enc(id)}`, body });
    },
    /** New key with the same scopes; the old one works for `overlap_seconds` (default 72 h, 0 = now). */
    rotate(id: string, body: { overlap_seconds?: number; key_format?: 'atlas' | 'legacy' } = {}): Promise<SecretKeyWithSecret & { replaces: string; previous_key_expires_at: number | null }> {
      return request({ method: 'POST', path: `/v1/secret_keys/${enc(id)}/rotate`, body });
    },
    revoke(id: string): Promise<SecretKey & { revoked: true }> {
      return request({ method: 'POST', path: `/v1/secret_keys/${enc(id)}/revoke` });
    },
  };
}

export function keysResource(request: RequestFn) {
  return {
    /** Every credential on the instance, standard shape. */
    list(): Promise<ListPage<StandardKey>> {
      return request({ method: 'GET', path: '/v1/keys' });
    },
  };
}

export function partnerLinksResource(request: RequestFn) {
  return {
    /** Create a link by hand (the secret is returned once). Prefer approving a partner's request: no secret to hand over. */
    create(body: { partner: string; name?: string; scopes: string[]; expires_at?: number | string; cert_fingerprints?: string[] }): Promise<PartnerLink> {
      return request({ method: 'POST', path: '/v1/partner_links', body });
    },
    /** Lock a link to client certificates (mTLS); [] removes the lock. */
    setCertificates(id: string, certFingerprints: string[]): Promise<PartnerLink> {
      return request({ method: 'PATCH', path: `/v1/partner_links/${enc(id)}`, body: { cert_fingerprints: certFingerprints } });
    },
    requests: {
      list(params: { direction?: 'inbound' | 'outbound'; status?: PartnerLinkRequest['status'][] } = {}): Promise<ListPage<PartnerLinkRequest>> {
        const query: Record<string, string> = {};
        if (params.direction) query.direction = params.direction;
        if (params.status?.length) query.status = params.status.join(',');
        return request({ method: 'GET', path: '/v1/partner_links/requests', ...(Object.keys(query).length ? { query } : {}) });
      },
      get(id: string): Promise<PartnerLinkRequest> {
        return request({ method: 'GET', path: `/v1/partner_links/requests/${enc(id)}` });
      },
      /** Approve: Atlas creates the link and delivers its credentials to the partner, signed. */
      approve(id: string, body: { scopes?: string[]; expires_at?: number | string } = {}): Promise<PartnerLinkRequestApproval> {
        return request({ method: 'POST', path: `/v1/partner_links/requests/${enc(id)}/approve`, body });
      },
      deny(id: string): Promise<PartnerLinkRequest> {
        return request({ method: 'POST', path: `/v1/partner_links/requests/${enc(id)}/deny` });
      },
    },
    list(): Promise<ListPage<PartnerLink>> {
      return request({ method: 'GET', path: '/v1/partner_links' });
    },
    get(id: string): Promise<PartnerLink> {
      return request({ method: 'GET', path: `/v1/partner_links/${enc(id)}` });
    },
    rotateSecret(id: string): Promise<PartnerLink> {
      return request({ method: 'POST', path: `/v1/partner_links/${enc(id)}/rotate_secret` });
    },
    revoke(id: string): Promise<PartnerLink & { revoked: true }> {
      return request({ method: 'DELETE', path: `/v1/partner_links/${enc(id)}` });
    },
    outbound: {
      list(): Promise<ListPage<OutboundPartnerLink>> {
        return request({ method: 'GET', path: '/v1/partner_links/outbound' });
      },
      save(partner: string, body: SaveOutboundPartnerLinkBody): Promise<OutboundPartnerLink> {
        return request({ method: 'PUT', path: `/v1/partner_links/outbound/${enc(partner)}`, body });
      },
      test(partner: string): Promise<{ object: 'partner_link_test'; partner: string; ok: boolean; error?: string }> {
        return request({ method: 'POST', path: `/v1/partner_links/outbound/${enc(partner)}/test` });
      },
      remove(partner: string): Promise<{ object: 'outbound_partner_link'; partner: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/partner_links/outbound/${enc(partner)}` });
      },
      /** Ask a partner for a link; its credentials arrive by themselves once the partner approves. */
      request(
        partner: string,
        body: { scopes: string[]; resource?: string; base_url?: string; token_url?: string; name?: string },
      ): Promise<PartnerLinkRequest & { note: string }> {
        return request({ method: 'POST', path: `/v1/partner_links/outbound/${enc(partner)}/request`, body });
      },
    },
  };
}

export function atlasIdGrantsResource(request: RequestFn) {
  return {
    /** Sign in with Atlas apps this instance manages, with the origins their button rendered on in the last 7 days. */
    listApps(): Promise<
      ListPage<{
        object: 'atlas_id_app';
        id: string;
        client_id: string;
        name: string;
        managed_by_instance_id: string;
        managed_via?: 'instance_toggle' | 'adopted';
        allowed_scopes?: string[];
        created_at?: number;
        button_rendered_origins?: { origin: string; last_seen_at: number; requests: number }[];
      }>
    > {
      return request({ method: 'GET', path: '/v1/atlas_id_apps' });
    },
    /** The setup check of an app this instance manages (diagnostics:read is enough). */
    preflight(appId: string): Promise<AtlasIdAppPreflight> {
      return request({ method: 'GET', path: `/v1/atlas_id_apps/${enc(appId)}/preflight` });
    },
    /** Is this verified email a user of the app? Empty list otherwise. */
    lookup(appId: string, email: string): Promise<ListPage<AtlasIdGrantLookup>> {
      return request({ method: 'GET', path: `/v1/atlas_id_apps/${enc(appId)}/users`, query: { email } });
    },
    revoke(appId: string, grantId: string): Promise<InstanceAtlasIdGrantRevocation> {
      return request({ method: 'DELETE', path: `/v1/atlas_id_apps/${enc(appId)}/grants/${enc(grantId)}` });
    },
  };
}

/* ---- the partner's side of the link request protocol ------------------- */

export interface PartnerLinkRequestInput {
  /** Your product id (lowercase, 2–40 characters). */
  partner: string;
  name?: string;
  /** The Atlas instance: its `ins_…` id or publishable key. */
  resource: string;
  scopes: string[];
  /** Where Atlas delivers the credentials (https). */
  callback_url: string;
  state?: string;
  /** Ask for a certificate-locked (mTLS) link. */
  cert_fingerprints?: string[];
}

export interface PartnerLinkRequestCreated {
  object: 'partner_link_request';
  protocol: 'atlas.partner_link_request.v1';
  id: string;
  status: 'pending';
  resource: string;
  scopes: string[];
  /** Keep it: it verifies the delivery and reads the request. Shown once. */
  request_secret: string;
  expires_at: number;
}

/** What Atlas POSTs to your callback once the owner decides. */
export type PartnerLinkDelivery =
  | {
      object: 'partner_link.credentials';
      protocol: 'atlas.partner_link_request.v1';
      request_id: string;
      state: string | null;
      partner: string;
      instance_id: string;
      resource: string;
      client_id: string;
      client_secret: string;
      scopes: string[];
      token_endpoint: string;
      api_base_url: string;
      auth_methods: string[];
      cert_fingerprints: string[];
      expires_at: number | null;
      issued_at: number;
    }
  | { object: 'partner_link.denied'; protocol: 'atlas.partner_link_request.v1'; request_id: string; state: string | null; partner: string; instance_id: string; issued_at: number };

/**
 * For a PARTNER product: ask an Atlas instance for a link (no Atlas credential
 * needed). The owner approves it; the credentials then arrive at
 * `callback_url`, signed with the returned `request_secret`
 * (verify with {@link verifyPartnerLinkDelivery}).
 */
export async function requestPartnerLink(
  input: PartnerLinkRequestInput,
  opts: { apiUrl?: string; fetch?: typeof fetch } = {},
): Promise<PartnerLinkRequestCreated> {
  const base = (opts.apiUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
  const res = await (opts.fetch ?? fetch)(`${base}/v1/partner_link_requests`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(input),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const first = (body.errors as Array<{ message?: string }> | undefined)?.[0];
    throw new Error(`Atlas refused the partner link request (HTTP ${res.status}${first?.message ? `: ${first.message}` : ''}).`);
  }
  return body as unknown as PartnerLinkRequestCreated;
}

/**
 * For a PARTNER product: verify and parse the credentials (or denial) Atlas
 * delivered to your callback. `secret` is the request's `request_secret`;
 * pass `url` (your callback URL) to also check the URL-bound signature.
 */
export function verifyPartnerLinkDelivery(
  input: Omit<VerifyWebhookInput, 'secret'> & { requestSecret: string },
): WebhookVerifyResult<PartnerLinkDelivery> {
  const { requestSecret, ...rest } = input;
  return verifyWebhook<PartnerLinkDelivery>({ ...rest, secret: requestSecret });
}
