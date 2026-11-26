import { enc, type RequestFn } from './request';

type C_ReferralRisk = {
  level: 'low' | 'medium' | 'high';
  score: number;
  signals: ('self_referral' | 'ip_velocity' | 'device_velocity' | 'disposable_email' | 'datacenter_ip' | 'tor_ip' | 'captcha_not_passed' | 'email_unverified' | 'restricted_identifier')[];
  captcha: 'passed' | 'not_required' | 'not_configured';
  emailVerified: boolean;
};

export type InstanceDeleteNextSigningKeyResult = {
  object: 'signing_key';
  kid: string;
  status: 'next';
  deleted: true;
};

export type InstanceGetSigningKeyPolicyResult = {
  object: 'signing_key_policy';
  /** Stage every ordinary rotation this many days ahead (1..90). null = off: a rotation signs with the new key at once. */
  prepublish_days: number | null;
};

export type InstanceUpdateSigningKeyPolicyBody = {
  /** 1..90 days; null or 0 turns the policy off. */
  prepublish_days: number | null;
};

export type InstanceUpdateSigningKeyPolicyResult = {
  object: 'signing_key_policy';
  /** Stage every ordinary rotation this many days ahead (1..90). null = off: a rotation signs with the new key at once. */
  prepublish_days: number | null;
};

export type InstanceResyncReferralAccountsBody = {
  /** Continue after this organization id (the previous answer's next_starting_after). Omit to start from the oldest organization. */
  starting_after?: string;
};

export type InstanceResyncReferralAccountsResult = {
  object: 'referral_accounts_resync';
  /** GET /v1/instance/referrals/backfill/{id} shows the progress of its calls. */
  backfill_id: string;
  organizations_scanned: number;
  calls_queued: number;
  /** Organizations where no member holds an owner role: nothing sent. */
  organizations_without_owner: number;
  /** More organizations remain after this run. */
  truncated: boolean;
  /** When truncated: send it as starting_after to continue. */
  next_starting_after: string | null;
};

export type InstanceGetReferralCallResult = {
  object: 'referral_call';
  /** Also the signed atlas-id header of every attempt. */
  id: string;
  kind: 'signup' | 'erase' | 'export' | 'partner' | 'signal' | 'test' | 'alias' | 'user' | 'ping' | 'accounts';
  status: 'pending' | 'succeeded' | 'retrying' | 'failed' | 'held' | 'skipped';
  /** signup only: referred | not_referred | stripped. */
  outcome?: string | null;
  customer_ref: string;
  user_id?: string | null;
  /** The W3C trace-id every attempt carried in its traceparent. */
  trace_id?: string | null;
  http_status?: number | null;
  last_error?: string | null;
  /** Why the last attempt failed: signature_rejected (401 and the signed ping fails too, no auto-retry), call_kind_rejected (401 on this kind while the signed ping passes: the route does not accept this connection), connectio */
  error_code?: string | null;
  /** Duration of the last attempt. */
  latency_ms?: number | null;
  /** The platform's request id for its last answer, when it sent one. */
  request_id?: string | null;
  attempts: number;
  next_attempt_at?: number | null;
  /** The risk assessment sent with a sign-up, when any. */
  risk?: C_ReferralRisk | null;
  /** Atlas's own record of the call, the same for every provider (never secrets). It can hold fields a built-in platform is not sent (e.g. emailHash for Referalli); what was sent is `request`. */
  payload?: Record<string, unknown>;
  /** The last attempt's request exactly as the platform received it: method, URL and body in the adapter's own shape (personal fields redacted). Null until a request is sent. */
  request?: {
    method?: string;
    url?: string;
    /** The JSON body (or form fields) sent; null for a bodyless call. */
    body?: Record<string, unknown> | null;
  } | null;
  /** The platform's last answer, personal fields redacted; null for exports. */
  response?: Record<string, unknown> | null;
  /** Sign-up calls: how the platform matched the referral and why. */
  highlights?: {
    matched_via?: string | null;
    partner_external_ref?: string | null;
    notes?: string[];
  } | null;
  /** The backfill that queued the call. */
  batch_id?: string | null;
  created_at: number;
  updated_at?: number;
};

export interface InstanceListBeforeUserCreateHookCallsQuery {
  /** Page size (default 50). */
  limit?: number;
  /** `failed` = timeout, error or invalid_response (not ok, not denied). */
  status?: 'ok' | 'denied' | 'failed' | 'timeout' | 'error' | 'invalid_response';
  /** Only test calls, or only real ones. */
  test?: 'true' | 'false';
  /** A call id: the page after it. */
  starting_after?: string;
}

export type InstanceListBeforeUserCreateHookCallsResult = {
  object: 'list';
  data: ({
    object: 'before_user_create_hook_call';
    id: string;
    /** The user being created (for a test call, the made-up user_test_… id). */
    user_id?: string | null;
    /** A "Test hook" call, not a sign-up. */
    test: boolean;
    status: 'ok' | 'denied' | 'timeout' | 'error' | 'invalid_response';
    http_status?: number | null;
    latency_ms?: number | null;
    error?: string | null;
    /** What your hook answered: the external_id and only the keys of each metadata object (values are never kept). For a denied call: {deny: true, reason}. */
    answer?: {
      deny?: boolean;
      reason?: string | null;
      external_id?: string | null;
      public_metadata_keys?: string[] | null;
      private_metadata_keys?: string[] | null;
      unsafe_metadata_keys?: string[] | null;
    } | null;
    /** Epoch-ms. */
    created_at: number;
  })[];
  has_more: boolean;
  /** Pass as starting_after for the next page; null on the last page. */
  next_cursor?: string | null;
};

export type InstanceCreateSecretKeyBody = {
  name?: string;
  scopes?: string[];
  /** Unix ms or ISO 8601; at most one year away. Default one year from now. */
  expires_at?: number | string;
  allowed_ips?: string[];
  /** Alias of allowed_ips. */
  ip_allowlist?: string[];
  /** Origins like https://app.example.com or https://*.example.com. */
  allowed_origins?: string[];
  /** Alias of allowed_origins. */
  origin_allowlist?: string[];
  /** Partner admin: limit the key to these organizations. A limited key may call only /v1/organizations and /v1/organizations/:id/** for ids in the list (another organization is a 404, any other route a 403) and sees only tho */
  organization_ids?: string[];
  /** Default: the creating person (user:<id>) or key (api_key:<id>). */
  owner?: string | null;
  key_format?: 'atlas' | 'legacy';
  /** Idempotent-create key (up to 200 characters). */
  external_ref?: string;
  /** Provisioning tags (up to 20). */
  metadata?: {
    [key: string]: string | number | boolean;
  };
};

export type InstanceCreateSecretKeyResult = {
  /** `key` (or `secret_key` on /v1/secret_keys). */
  object: string;
  id: string;
  kind: 'secret_key' | 'platform_key' | 'account_key' | 'webhook_secret' | 'partner_link' | 'access_token';
  /** `atlas` = `atlas_<env>_<kind>_<random><checksum>`; `legacy` = `sk_`, `psk_`, `whsec_`, `dsk_`. */
  format: 'atlas' | 'legacy';
  /** Non-secret display prefix. */
  prefix: string;
  name?: string | null;
  /** The person or service responsible. */
  owner: string | null;
  scopes: string[];
  environment?: 'live' | 'test' | null;
  resource?: {
    type?: 'instance' | 'account' | 'application' | 'webhook_endpoint';
    id?: string;
  };
  /** When the key stops working. Every key created now expires (at most a year); null only for a key created before that rule (Unix ms). */
  expires_at: number | null;
  /** Days left when within the 30-day warning window. */
  expires_in_days?: number | null;
  status: 'active' | 'expiring' | 'expired' | 'revoked';
  ip_allowlist?: string[];
  /** Browser origins a request carrying an Origin header must come from (empty = any). */
  origin_allowlist?: string[];
  /** Last use, to the minute (Unix ms). */
  last_used_at: number | null;
  last_used_ip: string | null;
  created_at: number;
  /** When it stopped (or, inside a rotation overlap, will stop) working (Unix ms). */
  revoked_at: number | null;
  allowed_ips?: string[];
  /** Alias of origin_allowlist. */
  allowed_origins?: string[];
  /** Partner admin: the organizations this key is limited to (empty = unrestricted). */
  organization_ids?: string[];
  rotated_from?: string | null;
  /** Provisioning tags. */
  metadata?: Record<string, unknown>;
  /** The idempotent-create key, if any. */
  external_ref?: string | null;
  /** Create only: true when an existing key with this external_ref was returned (without its secret). */
  idempotent_replay?: boolean;
  /** Create and rotate only, shown once. With `X-Secret-Recipient` it arrives as `sealed_secret` instead. */
  secret?: string;
};

export interface InstanceListSecretKeysQuery {
  /** Page size, 1-500. Without limit (and without starting_after) the whole list is returned. */
  limit?: number;
  /** Cursor: return only items after this one. Pass the previous page's `next_cursor` (the last item's id). An unknown cursor is a 400. */
  starting_after?: string;
}

export type InstanceListSecretKeysResult = {
  object?: 'list';
  data?: ({
    /** `key` (or `secret_key` on /v1/secret_keys). */
    object: string;
    id: string;
    kind: 'secret_key' | 'platform_key' | 'account_key' | 'webhook_secret' | 'partner_link' | 'access_token';
    /** `atlas` = `atlas_<env>_<kind>_<random><checksum>`; `legacy` = `sk_`, `psk_`, `whsec_`, `dsk_`. */
    format: 'atlas' | 'legacy';
    /** Non-secret display prefix. */
    prefix: string;
    name?: string | null;
    /** The person or service responsible. */
    owner: string | null;
    scopes: string[];
    environment?: 'live' | 'test' | null;
    resource?: {
      type?: 'instance' | 'account' | 'application' | 'webhook_endpoint';
      id?: string;
    };
    /** When the key stops working. Every key created now expires (at most a year); null only for a key created before that rule (Unix ms). */
    expires_at: number | null;
    /** Days left when within the 30-day warning window. */
    expires_in_days?: number | null;
    status: 'active' | 'expiring' | 'expired' | 'revoked';
    ip_allowlist?: string[];
    /** Browser origins a request carrying an Origin header must come from (empty = any). */
    origin_allowlist?: string[];
    /** Last use, to the minute (Unix ms). */
    last_used_at: number | null;
    last_used_ip: string | null;
    created_at: number;
    /** When it stopped (or, inside a rotation overlap, will stop) working (Unix ms). */
    revoked_at: number | null;
    allowed_ips?: string[];
    /** Alias of origin_allowlist. */
    allowed_origins?: string[];
    /** Partner admin: the organizations this key is limited to (empty = unrestricted). */
    organization_ids?: string[];
    rotated_from?: string | null;
    /** Provisioning tags. */
    metadata?: Record<string, unknown>;
    /** The idempotent-create key, if any. */
    external_ref?: string | null;
    /** Create only: true when an existing key with this external_ref was returned (without its secret). */
    idempotent_replay?: boolean;
    /** Create and rotate only, shown once. With `X-Secret-Recipient` it arrives as `sealed_secret` instead. */
    secret?: string;
  })[];
  /** Whether another page follows the cursor. */
  has_more?: boolean;
  /** The cursor to pass as `starting_after` for the next page on a keyset-paginated list; null on the last page (and absent on lists that are not cursor-paginated). */
  next_cursor?: string | null;
};

export interface InstanceGetStorageDeclarationQuery {
  /** json (default), or csv: name,provider,domain,category,purpose,duration,duration_seconds,type,description for a generic importer. */
  format?: 'json' | 'csv';
}

export type InstanceGetStorageDeclarationResult = {
  object: 'storage_declaration';
  vendor: 'Atlas';
  frontend_api_host: string;
  /** See GET /v1/storage_declaration for the row shape. */
  declarations: Record<string, unknown>[];
};

/** Operations on `/v1/instance` (9). */
/** `GET /v1/instance/issuers`: the issuers a verifier accepts. */
export type InstanceIssuers = {
  /** The issuer new tokens carry now. */
  active: string;
  /** The issuer once a pending custom-domain or path-mount claim is verified (accepted early, so you can register it up front); null when none. */
  planned: string | null;
  /** Earlier issuers still accepted during their overlap window. */
  previous: string[];
  jwks_uri: string;
};

/** One receiver in `GET /v1/instance/integrations/health`. */
export type IntegrationsHealthEntry = {
  kind: 'webhook_endpoint' | 'integration' | 'privacy_orchestrator';
  id: string | null;
  name?: string | null;
  url?: string | null;
  /** The connected platform that owns it, if any. */
  managed_by?: string | null;
  /** `https`, a destination such as `lucida`, `events_receiver`, `tokens_only` or `case_api`. */
  destination?: string;
  state: 'healthy' | 'failing' | 'disabled' | 'inactive' | 'no_deliveries' | 'unknown';
  last_success_at?: number | null;
  last_failure?: { at?: number | null; status?: number | null; error?: string | null } | null;
  consecutive_failures?: number;
  /** `integration` only: the last token minted for it. */
  last_minted_at?: number | null;
};

export type InstanceIntegrationsHealth = {
  object: 'list';
  data: IntegrationsHealthEntry[];
  has_more: boolean;
  /** Rows that are `failing` or `disabled`. */
  unhealthy_count: number;
  generated_at?: number;
};

/** Where events can be forwarded: sign-ups (`user.created`) to the first four, security events to `watchtower`. */
export type SignupForwardingDestination = 'lucida' | 'hermetica' | 'seolyticize' | 'webhook' | 'watchtower';

/** `PUT /v1/instance/integrations/forwarding/{destination}`: send only the fields that destination takes. */
export type SignupForwardingBody = {
  /** lucida, hermetica, seolyticize: the destination's server-side key (write-only; an omitted key keeps the stored one on an update). */
  server_key?: string;
  /** seolyticize: the site key. */
  site_key?: string;
  /** lucida, hermetica: an https host other than the default. */
  host?: string;
  /** seolyticize: which event records the conversion. */
  conversion_event?: 'user.created' | 'user.attributed';
  /** lucida, seolyticize: send email, name, ip and user agent. Default false. */
  include_pii?: boolean;
  /** webhook: the https receiver. */
  url?: string;
  /** watchtower: your ingest host (https); `server_key` is then an ingestion key with the `ingest:logs` scope. */
  endpoint?: string;
  active?: boolean;
};

/** The managed webhook endpoint behind forwarding (see the webhook endpoint fields), plus: */
export type SignupForwarding = {
  object: 'integration_forwarding';
  forwarding: SignupForwardingDestination;
  /** The first event delivered: `user.created`, or `user.locked` for watchtower. */
  event: string;
  /** Every event this destination receives. */
  events: string[];
  /** True when this call created the endpoint (201), false on an update. */
  created: boolean;
  /** The managed webhook endpoint. */
  id: string;
  /** `webhook` only, on create: the signing secret, shown once. */
  secret?: string;
  [field: string]: unknown;
};

export function instanceOpsResource(request: RequestFn) {
  return {
    /** `GET /v1/instance/issuers`: active, planned and previous issuers and the JWKS URI. */
    getIssuers(): Promise<InstanceIssuers> {
      return request({ method: 'GET', path: '/v1/instance/issuers' });
    },
    /** `GET /v1/instance/integrations/health`: every connected receiver (webhook endpoints, integrations, privacy orchestrator) with its last delivery. */
    getIntegrationsHealth(): Promise<InstanceIntegrationsHealth> {
      return request({ method: 'GET', path: '/v1/instance/integrations/health' });
    },
    /** `GET /v1/instance/integrations/forwarding/{destination}`: the stored forwarding (never the key); 404 when it was not set. */
    getSignupForwarding(destination: SignupForwardingDestination): Promise<SignupForwarding> {
      return request({ method: 'GET', path: `/v1/instance/integrations/forwarding/${enc(destination)}` });
    },
    /** `PUT /v1/instance/integrations/forwarding/{destination}`: forward every sign-up to a platform (with your own key) or an https webhook. A repeat call updates the same endpoint. */
    putSignupForwarding(destination: SignupForwardingDestination, body: SignupForwardingBody, idempotencyKey?: string): Promise<SignupForwarding> {
      return request({ method: 'PUT', path: `/v1/instance/integrations/forwarding/${enc(destination)}`, body, idempotencyKey });
    },
    /** `DELETE /v1/instance/integrations/forwarding/{destination}`: stop forwarding (404 when it was not set). */
    deleteSignupForwarding(destination: SignupForwardingDestination): Promise<void> {
      return request({ method: 'DELETE', path: `/v1/instance/integrations/forwarding/${enc(destination)}` });
    },
    /** Cancel a staged rotation: the staged key leaves the JWKS and never signs. 404 when none is staged. Audited as signing_key.staged_canceled. */
    deleteNextSigningKey(): Promise<InstanceDeleteNextSigningKeyResult> {
      return request({ method: 'DELETE', path: '/v1/instance/signing_keys/next' });
    },
    /** The staged-rotation policy: `prepublish_days` (null = off). */
    getSigningKeyPolicy(): Promise<InstanceGetSigningKeyPolicyResult> {
      return request({ method: 'GET', path: '/v1/instance/signing_key_policy' });
    },
    /** Set the staged-rotation policy. With `prepublish_days` (1..90) every ordinary rotation is staged that many days ahead (its key published now, signing from then) unless the rotate call passes `staged: false`; null or 0 turns it off. Emergency rotations are never staged. Audited as signing_key.policy_updated. */
    updateSigningKeyPolicy(body: InstanceUpdateSigningKeyPolicyBody): Promise<InstanceUpdateSigningKeyPolicyResult> {
      return request({ method: 'PATCH', path: '/v1/instance/signing_key_policy', body });
    },
    /** Send every organization's owner to the referral platform once (an `accounts` call per organization: accountRef = the organization's external_id, else its id; ownerCustomerRef = the owner's customerRef). The owner is the organization's creator while they hold the creator role or org:admin, else the longest-standing member holding one of those roles; organizations with no such member are counted in organizations_without_owner and skipped. Calls go out at about 10 per second through the delivery log (kind `accounts`), oldest first, up to 10,000 organizations per request (continue with `starting_after` = `next_starting_after`); the platform treats a repeat as a no-op. Atlas already sends these on its own when an organization is created, its external_id changes or its owner changes, and once when the platform first advertises `accounts`: use this after restoring data or to be sure. Requires referrals to be on and the platform to advertise `accounts` (422 REFERRALS_NOT_CONFIGURED otherwise). */
    resyncReferralAccounts(body: InstanceResyncReferralAccountsBody, idempotencyKey?: string): Promise<InstanceResyncReferralAccountsResult> {
      return request({ method: 'POST', path: '/v1/instance/referrals/accounts/resync', body, idempotencyKey });
    },
    /** One call from the referral delivery log, the same object the list returns (including the request as sent and the platform's answer). The id may also be the platform's request id for an answer (request_id); the newest matching call is returned. */
    getReferralCall(id: string): Promise<InstanceGetReferralCallResult> {
      return request({ method: 'GET', path: `/v1/instance/referrals/calls/${enc(id)}` });
    },
    /** The hook's delivery log, newest first, kept 30 days: every call (sign-ups and tests, flagged) with its status, HTTP code, latency, error and what the hook answered (external_id and metadata keys only). A failed or timed-out call let the sign-up continue without your answer. */
    listBeforeUserCreateHookCalls(query?: InstanceListBeforeUserCreateHookCallsQuery): Promise<InstanceListBeforeUserCreateHookCallsResult> {
      return request({ method: 'GET', path: '/v1/instance/hooks/before_user_create/calls', query: { ...query } });
    },
    /** Alias of POST /v1/secret_keys. Create a scoped secret key: `name`, `scopes[]` (refused when unknown, or when the calling key does not hold them; presets `read_only`, `privacy:execute`, `privacy:grants:revoke`), `expires_at` (at most a year; default one year; "never" is refused), `allowed_ips` (CIDRs), `allowed_origins` (browser origins; a request with another Origin gets 403 ORIGIN_NOT_ALLOWED), `owner` (default: the creating person or key), `external_ref` (idempotent create: a repeat returns the existing key, 200, idempotent_replay, no secret), `metadata` (tags; filter the list with ?metadata[key]=value) and `key_format` (`atlas`, the default `atlas_<env>_sk_…`, or `legacy` `sk_<env>_…`). The secret is returned once. Minting with an operator token needs multi-factor sign-in within 5 minutes (403 STEP_UP_REQUIRED). Send `X-Secret-Recipient: x25519:<public key>` to receive the secret sealed (libsodium sealed box) as `sealed_secret` instead of in plaintext. Example: a data-rights tool's key, { "name": "DSAR executor", "scopes": ["privacy:execute", "privacy:grants:revoke"], "expires_at": "2027-04-01" }. */
    createSecretKey(body: InstanceCreateSecretKeyBody, idempotencyKey?: string): Promise<InstanceCreateSecretKeyResult> {
      return request({ method: 'POST', path: '/v1/instance/secret_keys', body, idempotencyKey });
    },
    /** Alias of GET /v1/secret_keys. List this instance's secret keys with scopes, owner, expiry, last use, last-used IP and provisioning tags. Revoked keys stay listed. Filter by tag with ?metadata[key]=value. */
    listSecretKeys(query?: InstanceListSecretKeysQuery): Promise<InstanceListSecretKeysResult> {
      return request({ method: 'GET', path: '/v1/instance/secret_keys', query: { ...query } });
    },
    /** Every cookie and browser-storage key the hosted pages set for this instance as a CMP-neutral declaration (name, provider, domain, category, type cookie or localStorage, duration, description), with the domain computed from your sign-in host and cross-subdomain setting. A consent manager imports it once; no manual rows. Needs only cookie_consent:read. Without a key the same list is public: GET /v1/storage_declaration on the Frontend API host. */
    getStorageDeclaration(query?: InstanceGetStorageDeclarationQuery): Promise<InstanceGetStorageDeclarationResult> {
      return request({ method: 'GET', path: '/v1/instance/storage_declaration', query: { ...query } });
    },
  };
}
