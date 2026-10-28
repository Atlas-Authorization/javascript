import { enc, type RequestFn } from './request';

/**
 * Policy acceptance: the policies (Terms of Service, privacy policy, any key)
 * your users accept at sign-up — and, per policy, again at sign-in when a new
 * version takes effect. A policy's versions go draft → published (with an
 * `effective_at`) → retired; a published version is immutable, and its
 * `content_sha256` is the SHA-256 of the sanitised HTML users are shown.
 * Acceptances are consent records carrying that hash and the reading evidence.
 *
 * Content can also come from any external system through the Atlas policy
 * source protocol (`policySource`): Atlas fetches `GET {endpoint_url}/policies`
 * signed like an Atlas webhook, and your system tells Atlas about a new
 * version with a signed `policy.published` event.
 */

export type PolicyDisplay = 'checkbox' | 'scroll' | 'link';
export type PolicyAppliesTo = 'sign_up' | 'sign_in_and_sign_up';
export type PolicyReaccept = 'none' | 'next_sign_in' | 'grace';

export interface PolicyVersionRef {
  id: string;
  version: string;
  status: 'draft' | 'published' | 'retired' | (string & {});
  content_sha256: string;
  published_at: number | null;
  effective_at: number | null;
}

export interface Policy {
  object: 'policy';
  id: string;
  key: string;
  title: string;
  display: PolicyDisplay;
  required: boolean;
  applies_to: PolicyAppliesTo;
  reaccept: PolicyReaccept;
  grace_days: number | null;
  source: 'atlas' | 'external';
  position: number;
  status: 'active' | 'retired';
  /** External policies: fields changed in Atlas that a sync keeps. */
  overrides: string[];
  /** The version in effect now. */
  current_version: PolicyVersionRef | null;
  /** A newer published version that is not in effect yet. */
  upcoming_version: PolicyVersionRef | null;
  /** The newest version of any status (drafts included). */
  latest_version: PolicyVersionRef | null;
  retired_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface PolicyVersion {
  object: 'policy_version';
  id: string;
  policy_id: string;
  policy: string;
  version: string;
  status: 'draft' | 'published' | 'retired';
  content_markdown: string | null;
  /** The sanitised HTML clients render. */
  content_html: string;
  content_url: string | null;
  /** Hex SHA-256 of `content_html`. */
  content_sha256: string;
  summary_of_changes: string | null;
  locale: string | null;
  published_at: number | null;
  effective_at: number | null;
  retired_at: number | null;
  created_at: number;
  updated_at: number;
  /** On list: how many users accepted this version. */
  acceptance_count?: number;
}

export interface PolicyAcceptance {
  object: 'policy_acceptance';
  id: string;
  user_id: string;
  policy: string;
  version: string;
  policy_version_id: string | null;
  status: 'accepted' | 'withdrawn';
  source: 'signup' | 'signin' | 'reaccept' | 'api' | 'import' | (string & {}) | null;
  content_sha256: string | null;
  display: PolicyDisplay | null;
  scrolled_to_end: boolean | null;
  view_ms: number | null;
  locale: string | null;
  ip: string | null;
  user_agent: string | null;
  accepted_at: number;
}

export interface PolicyStanding {
  object: 'policy_standing';
  policy: string;
  policy_id: string;
  title: string;
  display: PolicyDisplay;
  required: boolean;
  applies_to: PolicyAppliesTo;
  reaccept: PolicyReaccept;
  current_version_id: string | null;
  current_version: string | null;
  content_sha256: string | null;
  summary_of_changes: string | null;
  accepted_version_id: string | null;
  accepted_version: string | null;
  accepted_at: number | null;
  needs_reaccept: boolean;
  /** Accepting is required before the user's next sign-in completes. */
  blocking: boolean;
  grace_ends_at: number | null;
}

export interface CreatePolicyBody {
  /** Slug, unique per instance (e.g. `tos`, `privacy`). Becomes the consent record's `policy`. */
  key: string;
  title: string;
  display?: PolicyDisplay;
  required?: boolean;
  applies_to?: PolicyAppliesTo;
  reaccept?: PolicyReaccept;
  /** Required with `reaccept: 'grace'` (1–365). */
  grace_days?: number | null;
  position?: number;
}

export type UpdatePolicyBody = Partial<Omit<CreatePolicyBody, 'key'>> & { status?: 'active' | 'retired' };

export interface CreatePolicyVersionBody {
  /** A label such as `2026-10-24` or `1.2.0`, unique per policy. */
  version: string;
  /** Markdown (rendered and sanitised by Atlas) — or `content_html`. */
  content_markdown?: string;
  content_html?: string;
  content_url?: string | null;
  summary_of_changes?: string | null;
  locale?: string | null;
  /** Publish immediately instead of saving a draft. */
  publish?: boolean;
  /** With `publish`: when the gate starts asking for it (epoch ms or ISO; default now). */
  effective_at?: number | string;
}

export type UpdatePolicyVersionBody = Partial<Omit<CreatePolicyVersionBody, 'publish' | 'effective_at'>>;

export interface ListPolicyAcceptancesParams {
  /** A version id or label. */
  version?: string;
  /** `accepted` (default), `withdrawn` or `all`. */
  status?: 'accepted' | 'withdrawn' | 'all';
  limit?: number;
  starting_after?: string;
}

export interface PolicyAcceptancePage {
  object: 'list';
  data: PolicyAcceptance[];
  has_more: boolean;
  next_cursor: string | null;
}

export interface PolicySettings {
  object: 'policy_settings';
  /** Put `pol` (accepted versions of required policies) on session tokens. */
  session_claim: boolean;
}

export interface PolicySource {
  object: 'policy_source';
  enabled: boolean;
  endpoint_url: string | null;
  signing_secret_set: boolean;
  sync: 'webhook' | 'poll';
  poll_interval_minutes: number;
  /** Where your source sends `policy.published` / `policy.retired` events. */
  webhook_url: string | null;
  protocol_version: string;
  last_synced_at: number | null;
  last_sync_ok: boolean | null;
  last_sync_error: string | null;
  next_poll_at: number | null;
}

export interface UpdatePolicySourceBody {
  enabled?: boolean;
  /** Base URL; Atlas calls `GET {endpoint_url}/policies`. */
  endpoint_url?: string | null;
  /** Write-only (a `whsec_` secret works). */
  signing_secret?: string | null;
  sync?: 'webhook' | 'poll';
  /** Poll mode: 5–1440. */
  poll_interval_minutes?: number;
}

export interface PolicySourceDelivery {
  object: 'policy_source_delivery';
  id: string;
  direction: 'outbound' | 'inbound';
  kind: 'fetch' | 'test' | 'poll' | 'webhook';
  status: 'ok' | 'failed' | 'rejected';
  http_status: number | null;
  error: string | null;
  event_type: string | null;
  policy: string | null;
  version: string | null;
  url: string | null;
  changes: Record<string, unknown> | null;
  latency_ms: number | null;
  created_at: number;
}

export interface PolicySourceTest {
  object: 'policy_source_test';
  ok: boolean;
  http_status: number | null;
  latency_ms: number | null;
  error: string | null;
  warnings: string[];
  policies: Array<{ key: string; title: string; versions: string[] }>;
  delivery: PolicySourceDelivery;
}

export interface PolicySourceSync {
  object: 'policy_source_sync';
  ok: boolean;
  error: string | null;
  warnings: string[];
  changes: { created: string[]; updated: string[]; published: string[]; unchanged: string[]; rejected: string[]; retired: string[] } | null;
  delivery: PolicySourceDelivery;
}

export function policiesResource(request: RequestFn) {
  return {
    /** `GET /v1/policies` — active policies (`include_retired` for all). */
    list(params: { include_retired?: boolean } = {}): Promise<{ object: 'list'; data: Policy[] }> {
      return request({ method: 'GET', path: '/v1/policies', query: { ...params } });
    },
    /** `POST /v1/policies`. */
    create(body: CreatePolicyBody): Promise<Policy> {
      return request({ method: 'POST', path: '/v1/policies', body });
    },
    /** `GET /v1/policies/:id` — by id or key. */
    get(idOrKey: string): Promise<Policy> {
      return request({ method: 'GET', path: `/v1/policies/${enc(idOrKey)}` });
    },
    /** `PATCH /v1/policies/:id`. */
    update(idOrKey: string, body: UpdatePolicyBody): Promise<Policy> {
      return request({ method: 'PATCH', path: `/v1/policies/${enc(idOrKey)}`, body });
    },
    /** `DELETE /v1/policies/:id` — deletes a never-published policy, retires one with history. */
    delete(idOrKey: string): Promise<{ object: 'policy'; id: string; key: string; deleted: boolean; retired: boolean; policy?: Policy }> {
      return request({ method: 'DELETE', path: `/v1/policies/${enc(idOrKey)}` });
    },
    versions: {
      list(idOrKey: string): Promise<{ object: 'list'; data: PolicyVersion[] }> {
        return request({ method: 'GET', path: `/v1/policies/${enc(idOrKey)}/versions` });
      },
      /** `POST /v1/policies/:id/versions` — a draft (or published at once with `publish: true`). */
      create(idOrKey: string, body: CreatePolicyVersionBody): Promise<PolicyVersion> {
        return request({ method: 'POST', path: `/v1/policies/${enc(idOrKey)}/versions`, body });
      },
      get(idOrKey: string, versionIdOrLabel: string): Promise<PolicyVersion> {
        return request({ method: 'GET', path: `/v1/policies/${enc(idOrKey)}/versions/${enc(versionIdOrLabel)}` });
      },
      /** Drafts only. */
      update(idOrKey: string, versionIdOrLabel: string, body: UpdatePolicyVersionBody): Promise<PolicyVersion> {
        return request({ method: 'PATCH', path: `/v1/policies/${enc(idOrKey)}/versions/${enc(versionIdOrLabel)}`, body });
      },
      /** Drafts only. */
      delete(idOrKey: string, versionIdOrLabel: string): Promise<{ object: 'policy_version'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/policies/${enc(idOrKey)}/versions/${enc(versionIdOrLabel)}` });
      },
      /** `POST …/publish` — `effective_at` (epoch ms or ISO; default now) is when the gate starts asking for it. */
      publish(idOrKey: string, versionIdOrLabel: string, body: { effective_at?: number | string } = {}): Promise<PolicyVersion> {
        return request({ method: 'POST', path: `/v1/policies/${enc(idOrKey)}/versions/${enc(versionIdOrLabel)}/publish`, body });
      },
      retire(idOrKey: string, versionIdOrLabel: string): Promise<PolicyVersion> {
        return request({ method: 'POST', path: `/v1/policies/${enc(idOrKey)}/versions/${enc(versionIdOrLabel)}/retire` });
      },
    },
    /** `GET /v1/policies/:id/acceptances` — who accepted, newest first. */
    listAcceptances(idOrKey: string, params: ListPolicyAcceptancesParams = {}): Promise<PolicyAcceptancePage> {
      return request({ method: 'GET', path: `/v1/policies/${enc(idOrKey)}/acceptances`, query: { ...params } });
    },
    /** The same as CSV (`format=csv`, up to 100,000 rows). */
    exportAcceptancesCsv(idOrKey: string, params: Omit<ListPolicyAcceptancesParams, 'limit' | 'starting_after'> = {}): Promise<string> {
      return request({ method: 'GET', path: `/v1/policies/${enc(idOrKey)}/acceptances`, query: { ...params, format: 'csv' }, raw: true });
    },
    /** `GET /v1/users/:id/policies` — a user's standing on every policy. */
    forUser(userId: string): Promise<{ object: 'list'; user_id: string; data: PolicyStanding[]; needs_acceptance: boolean }> {
      return request({ method: 'GET', path: `/v1/users/${enc(userId)}/policies` });
    },
    settings: {
      get(): Promise<PolicySettings> {
        return request({ method: 'GET', path: '/v1/instance/policy_settings' });
      },
      update(body: { session_claim?: boolean }): Promise<PolicySettings> {
        return request({ method: 'PATCH', path: '/v1/instance/policy_settings', body });
      },
    },
  };
}

export function policySourceResource(request: RequestFn) {
  return {
    get(): Promise<PolicySource> {
      return request({ method: 'GET', path: '/v1/instance/policy_source' });
    },
    /** `PUT /v1/instance/policy_source` — partial; `signing_secret` is write-only. */
    update(body: UpdatePolicySourceBody): Promise<PolicySource> {
      return request({ method: 'PUT', path: '/v1/instance/policy_source', body });
    },
    /** Disconnect the source (its policies and history stay). */
    delete(): Promise<PolicySource> {
      return request({ method: 'DELETE', path: '/v1/instance/policy_source' });
    },
    /** A signed fetch of the feed, validated but not stored. */
    test(): Promise<PolicySourceTest> {
      return request({ method: 'POST', path: '/v1/instance/policy_source/test' });
    },
    /** Fetch and store now. */
    sync(): Promise<PolicySourceSync> {
      return request({ method: 'POST', path: '/v1/instance/policy_source/sync' });
    },
    listDeliveries(params: { limit?: number; starting_after?: string; kind?: string; status?: string } = {}): Promise<{
      object: 'list';
      data: PolicySourceDelivery[];
      has_more: boolean;
      next_cursor: string | null;
    }> {
      return request({ method: 'GET', path: '/v1/instance/policy_source/deliveries', query: { ...params } });
    },
  };
}
