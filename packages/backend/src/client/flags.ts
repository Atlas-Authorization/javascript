import { sha256 } from '@noble/hashes/sha256';
import { enc, type RequestFn } from './request';
import type { CursorParams } from './types';

export type FeatureFlagType = 'boolean' | 'string' | 'int' | 'json';
export type FeatureFlagValue = boolean | string | number | Record<string, unknown> | unknown[];

/** Who a flag is evaluated for. `user_id` (else `org_id`) seeds percentage rollouts. */
export interface FeatureFlagSubject {
  user_id?: string | null;
  org_id?: string | null;
  plan?: string | null;
}

/** Every given `match` dimension must hold; an empty rule matches everyone. */
export interface FeatureFlagRule {
  match?: { user_ids?: string[]; org_ids?: string[]; plans?: string[] };
  /** 0–100: the share of matching subjects, stable per flag and subject. */
  percentage?: number;
  value: FeatureFlagValue;
}

export interface FeatureFlag {
  object: 'feature_flag';
  id: string;
  key: string;
  type: FeatureFlagType;
  description: string | null;
  enabled: boolean;
  default_value: FeatureFlagValue;
  /** Returned while the flag is switched off. */
  off_value: FeatureFlagValue;
  rules: FeatureFlagRule[];
  created_at: number;
  updated_at: number;
}

export interface CreateFeatureFlagBody {
  key: string;
  type: FeatureFlagType;
  default_value: FeatureFlagValue;
  description?: string;
  enabled?: boolean;
  off_value?: FeatureFlagValue;
  rules?: FeatureFlagRule[];
}

export type UpdateFeatureFlagBody = Partial<Omit<CreateFeatureFlagBody, 'key' | 'type'>>;

export interface FeatureFlagEvaluation {
  object: 'feature_flag_evaluation';
  subject: FeatureFlagSubject;
  flags: Record<string, { value: FeatureFlagValue; reason: string }>;
}

export interface AssignEntitlementsBody {
  plan?: string | null;
  features?: string[] | null;
  limits?: Record<string, unknown> | null;
  /** Epoch ms; omit for open-ended. */
  expires_at?: number | null;
}

export interface AssignedEntitlements {
  object: 'assigned_entitlements';
  subject_type: 'user' | 'org';
  subject_id: string;
  plan: string | null;
  features: string[] | null;
  limits: Record<string, unknown> | null;
  expires_at: number | null;
}

/** Same bucketing as the server: the same subject lands in the same bucket everywhere. */
function bucket(flagKey: string, subjectKey: string): number {
  const d = sha256(new TextEncoder().encode(`${flagKey}:${subjectKey}`));
  return (((d[0]! << 24) | (d[1]! << 16) | (d[2]! << 8) | d[3]!) >>> 0) % 100;
}

/** Evaluate a flag definition for a subject (first matching in-bucket rule wins, else the default). */
export function evaluateFeatureFlag(flag: FeatureFlag, subject: FeatureFlagSubject): FeatureFlagValue {
  if (!flag.enabled) return flag.off_value;
  const seed = subject.user_id ?? subject.org_id ?? '';
  for (const rule of flag.rules) {
    const m = rule.match ?? {};
    if (m.user_ids && (!subject.user_id || !m.user_ids.includes(subject.user_id))) continue;
    if (m.org_ids && (!subject.org_id || !m.org_ids.includes(subject.org_id))) continue;
    if (m.plans && (!subject.plan || !m.plans.includes(subject.plan))) continue;
    if (rule.percentage !== undefined && (!seed || bucket(flag.key, seed) >= rule.percentage)) continue;
    return rule.value;
  }
  return flag.default_value;
}

const pageAll = async (request: RequestFn): Promise<FeatureFlag[]> => {
  const out: FeatureFlag[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await request<{ data: FeatureFlag[]; has_more: boolean }>({
      method: 'GET',
      path: '/v1/feature_flags',
      query: { limit: 200, starting_after: after },
    });
    out.push(...page.data);
    if (!page.has_more || page.data.length === 0) return out;
    after = page.data[page.data.length - 1]!.key;
  }
};

export function flagsResource(request: RequestFn, cacheTtlMs = 30_000) {
  let cache: { at: number; flags: Map<string, FeatureFlag> } | undefined;
  let inflight: Promise<Map<string, FeatureFlag>> | undefined;

  /** All flag definitions, cached for `cacheTtlMs`; concurrent callers share one fetch. */
  const definitions = async (): Promise<Map<string, FeatureFlag>> => {
    if (cache && Date.now() - cache.at < cacheTtlMs) return cache.flags;
    inflight ??= pageAll(request)
      .then((all) => {
        cache = { at: Date.now(), flags: new Map(all.map((f) => [f.key, f])) };
        return cache.flags;
      })
      .finally(() => { inflight = undefined; });
    return inflight;
  };

  return {
    create(body: CreateFeatureFlagBody, idempotencyKey?: string): Promise<FeatureFlag> {
      return request({ method: 'POST', path: '/v1/feature_flags', body, idempotencyKey });
    },
    /** `starting_after` is the key of the last flag of the previous page. */
    list(params: CursorParams = {}): Promise<{ object: 'list'; data: FeatureFlag[]; has_more: boolean }> {
      return request({ method: 'GET', path: '/v1/feature_flags', query: params as Record<string, string | number | undefined> });
    },
    retrieve(key: string): Promise<FeatureFlag> {
      return request({ method: 'GET', path: `/v1/feature_flags/${enc(key)}` });
    },
    update(key: string, body: UpdateFeatureFlagBody): Promise<FeatureFlag> {
      return request({ method: 'PATCH', path: `/v1/feature_flags/${enc(key)}`, body });
    },
    delete(key: string): Promise<{ object: 'feature_flag'; id: string; key: string; deleted: boolean }> {
      return request({ method: 'DELETE', path: `/v1/feature_flags/${enc(key)}` });
    },
    /** Server-side evaluation; `plan` defaults to the org's (else the user's) resolved plan. */
    evaluate(body: FeatureFlagSubject & { keys?: string[] }): Promise<FeatureFlagEvaluation> {
      return request({ method: 'POST', path: '/v1/feature_flags/evaluate', body });
    },
    /** Local evaluation against cached definitions. `plan` is not looked up here — pass it for plan rules. */
    async get<T extends FeatureFlagValue>(key: string, subject: FeatureFlagSubject, fallback: T): Promise<T> {
      const flag = (await definitions()).get(key);
      return flag ? (evaluateFeatureFlag(flag, subject) as T) : fallback;
    },
    /** True only for a boolean flag that evaluates to true; an unknown flag is false. */
    async isEnabled(key: string, subject: FeatureFlagSubject = {}): Promise<boolean> {
      return (await this.get<FeatureFlagValue>(key, subject, false)) === true;
    },
    /** Drop the cached definitions (e.g. after changing a flag). */
    invalidate(): void {
      cache = undefined;
    },
    /** Replace the entitlements assigned to an organization (an empty body clears them). */
    assignOrganizationEntitlements(orgId: string, body: AssignEntitlementsBody): Promise<AssignedEntitlements> {
      return request({ method: 'PUT', path: `/v1/organizations/${enc(orgId)}/entitlements`, body });
    },
    assignUserEntitlements(userId: string, body: AssignEntitlementsBody): Promise<AssignedEntitlements> {
      return request({ method: 'PUT', path: `/v1/users/${enc(userId)}/entitlements`, body });
    },
  };
}
