import { enc, type RequestFn } from './request';
import type { ListPage } from './types';
import type { Filter, SqlColumn, SqlDialect } from '@atlasauth/authz';

export interface AbacPolicyTestCase {
  name: string;
  /** principal, action, resource, context and optional entities. */
  request: Record<string, unknown>;
  expect: 'allow' | 'deny';
}

/** An ABAC policy: named, versioned source in the Cedar-subset policy language. */
export interface AbacPolicy {
  object: 'abac_policy';
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  current_version: number;
  /** The FGA store `fga.check(...)` in the source consults. */
  fga_store_id: string | null;
  source: string;
  tests: AbacPolicyTestCase[];
  created_at: number;
  updated_at: number;
}

export interface AbacPolicyVersion {
  object: 'abac_policy_version';
  policy_id: string;
  version: number;
  source: string;
  tests: AbacPolicyTestCase[];
  current: boolean;
  created_at: number;
}

export interface CreateAbacPolicyBody {
  name: string;
  description?: string | null;
  enabled?: boolean;
  fga_store_id?: string | null;
  source: string;
  tests?: AbacPolicyTestCase[];
}

/** Sending `source` appends a new version; `current_version` (without source) rolls back. */
export type UpdateAbacPolicyBody = Partial<CreateAbacPolicyBody> & { current_version?: number };

export interface AbacEntity {
  type: string;
  id: string;
  attributes?: Record<string, unknown>;
  /** `Type::id` uids this entity is a member of (for `in`). */
  parents?: string[];
}

export interface AbacEvaluateBody {
  principal: AbacEntity;
  action: string;
  resource: AbacEntity;
  context?: Record<string, unknown>;
  entities?: AbacEntity[];
  /** Evaluate only these policies (default: every enabled one). */
  policy_ids?: string[];
}

export interface AbacDecision {
  object: 'abac_decision';
  decision: 'allow' | 'deny';
  reasons: string[];
  errors: string[];
  /** `@annotations` of the policies that decided it, when any carry them. */
  annotations?: Array<{ policy: string; annotations: Record<string, string> }>;
}

export interface AbacCoverageClause {
  kind: 'when' | 'unless';
  index: number;
  line: number | null;
  true: number;
  false: number;
  error: number;
}

/** Which rules and `when`/`unless` clauses the test cases exercised. */
export interface AbacCoverage {
  object: 'abac_coverage';
  tests: number;
  rules: Array<{
    rule: number;
    effect: 'permit' | 'forbid';
    line: number | null;
    in_scope: number;
    matched: number;
    status: 'covered' | 'partial' | 'untouched';
    clauses: AbacCoverageClause[];
  }>;
  summary: { rules: number; reached: number; matched: number; clauses: number; clauses_both_ways: number; percent: number };
  /** What to add a test for, one sentence each. */
  gaps: string[];
}

export interface AbacTestRun {
  object: 'abac_policy_test_run';
  passed: boolean;
  results: Array<{ name: string; expect: 'allow' | 'deny'; actual: 'allow' | 'deny'; passed: boolean }>;
  coverage: AbacCoverage;
}

export interface AbacEntityRef {
  type: string;
  id: string;
}

/** A policy template: source with `?principal` / `?resource` slots, filled by links. */
export interface AbacPolicyTemplate {
  object: 'abac_policy_template';
  id: string;
  name: string;
  description: string | null;
  source: string;
  version: number;
  slots: Array<'?principal' | '?resource'>;
  fga_store_id: string | null;
  link_count: number;
  /** On an update that changed `source`: the links that now evaluate the new source. */
  links_updated?: number;
  created_at: number;
  updated_at: number;
}

export interface CreateAbacTemplateBody {
  name: string;
  source: string;
  description?: string | null;
  fga_store_id?: string | null;
}

export interface AbacPolicyLink {
  object: 'abac_policy_link';
  id: string;
  name: string;
  template_id: string;
  template_name: string | null;
  /** The template version the link follows (always the latest). */
  template_version: number | null;
  principal: AbacEntityRef | null;
  resource: AbacEntityRef | null;
  enabled: boolean;
  /** The policy source the link evaluates: the template with its slots filled. */
  source: string;
  created_at: number;
  updated_at: number;
}

export interface CreateAbacLinkBody {
  template_id: string;
  name: string;
  principal?: AbacEntityRef | null;
  resource?: AbacEntityRef | null;
  enabled?: boolean;
}

export type AbacSchemaType =
  | { type: 'boolean' | 'long' | 'string' }
  | { type: 'set'; element: AbacSchemaType }
  | { type: 'entity'; name: string }
  | { type: 'record'; attributes: Record<string, AbacSchemaType & { required?: boolean }> };

/** The entity schema policies are type-checked against when saved. */
export interface AbacSchemaDocument {
  entity_types: Record<string, { attributes?: Record<string, AbacSchemaType & { required?: boolean }>; member_of?: string[] }>;
  actions?: Record<string, { applies_to?: { principal_types: string[]; resource_types: string[]; context?: Record<string, AbacSchemaType & { required?: boolean }> }; member_of?: string[] }>;
}

export interface AbacPolicyIssue {
  severity: 'error' | 'warning';
  /** 1-based position of the policy in the source (0 for a syntax error). */
  policy: number;
  rule: 'permit' | 'forbid';
  clause?: { kind: 'when' | 'unless'; index: number };
  message: string;
  offset?: number;
  line?: number;
  column?: number;
  source_name?: string;
}

export interface AbacSchemaState {
  object: 'abac_schema';
  schema: AbacSchemaDocument | null;
  version: number;
  updated_at: number | null;
  /** On a save: the errors the schema would give the policies and links already stored. */
  policy_issues?: AbacPolicyIssue[];
}

export interface AbacValidation {
  object: 'abac_validation';
  valid: boolean;
  schema_checked: boolean;
  issues: AbacPolicyIssue[];
}

export interface AbacDiffChange {
  request: Record<string, unknown>;
  before: 'allow' | 'deny';
  after: 'allow' | 'deny';
  /** Present when a version uses `fga.check`: the assumption the change holds under. */
  assuming?: { fga_check: boolean };
}

export interface AbacPolicyDiff {
  object: 'abac_policy_diff';
  policy_id?: string;
  from?: number;
  to?: number;
  text: { identical: boolean; added: number; removed: number; lines: Array<{ type: 'context' | 'add' | 'remove'; text: string; before_line?: number; after_line?: number }> };
  /** The requests whose decision changes; null when `semantic` was false. */
  semantic: {
    enumerated: number;
    space: number;
    exhaustive: boolean;
    changed: number;
    newly_allowed: number;
    newly_denied: number;
    by_action: Record<string, { newly_allowed: number; newly_denied: number }>;
    changes: AbacDiffChange[];
    truncated: boolean;
  } | null;
}

export interface AbacDiffOptions {
  from?: number;
  to?: number;
  /** false returns only the text diff. */
  semantic?: boolean;
  /** Requests to compare; the space is sampled beyond this. Default 5000. */
  max_requests?: number;
  /** Changed requests to list. Default 50. */
  max_changes?: number;
}

export interface AuthzenEvaluation {
  subject?: { type: string; id: string; properties?: Record<string, unknown> };
  resource?: { type: string; id: string; properties?: Record<string, unknown> };
  action?: { name: string; properties?: Record<string, unknown> };
  context?: Record<string, unknown>;
}

/** An entity for partial evaluation: an unknown one needs only its `type`. */
export interface AbacPartialEntity {
  type: string;
  id?: string;
  attributes?: Record<string, unknown>;
  parents?: string[];
}

export interface AbacPartialBody {
  principal: AbacPartialEntity;
  action: string;
  resource: AbacPartialEntity;
  context?: Record<string, unknown>;
  entities?: AbacEntity[];
  policy_ids?: string[];
  /** Which entity's attributes are unknown. Default `['resource']`. */
  unknowns?: Array<'principal' | 'resource'>;
  /** Replace relationship (`fga.check`) conditions with the ids the FGA store returns. Default true. */
  resolve_relations?: boolean;
  /** Ask for a ready-made query: parameterised SQL (field-to-column map) and/or a Prisma where object. */
  output?: {
    sql?: { columns: Record<string, SqlColumn>; dialect?: SqlDialect; param_offset?: number };
    prisma?: { fields: Record<string, string> };
  };
}

export interface AbacResidual {
  object: 'abac_residual';
  /** `allow` / `deny` when the filter is constant, else `conditional`. */
  decision: 'allow' | 'deny' | 'conditional';
  /** The condition on the unknown entity under which the request is allowed. */
  filter: Filter;
  permit: Filter;
  forbid: Filter;
  unknowns: Array<'principal' | 'resource'>;
  relations_resolved: boolean;
  sql?: { text: string; params: unknown[] };
  prisma?: Record<string, unknown>;
}

export interface AbacAccessibleBody {
  principal: AbacPartialEntity;
  action: string;
  /** The Atlas resource type key; policies see its PascalCase form. */
  resource_type: string;
  context?: Record<string, unknown>;
  entities?: AbacEntity[];
  /** Resources to filter instead of the Atlas ones. */
  candidates?: Array<{ id: string; attributes?: Record<string, unknown>; parents?: string[] }>;
  policy_ids?: string[];
  limit?: number;
  starting_after?: string;
}

export interface AbacAccessibleList {
  object: 'list';
  data: Array<{ object: 'abac_resource'; type: string; id: string }>;
  has_more: boolean;
  next_cursor: string | null;
  total: number;
  evaluated: number;
  /** `residual` when one filter was applied to every candidate; `per_resource` when each had to be evaluated. */
  method: 'residual' | 'per_resource';
}

/** AuthZEN 1.0 search request: leave the `id` out of the entity you are looking for. */
export interface AuthzenSearchRequest {
  subject?: { type: string; id?: string; properties?: Record<string, unknown> };
  resource?: { type: string; id?: string; properties?: Record<string, unknown> };
  action?: { name: string; properties?: Record<string, unknown> };
  context?: Record<string, unknown>;
  page?: { limit?: number; token?: string };
}

export interface AuthzenSearchPage {
  /** Empty on the last page. */
  next_token: string;
  count: number;
  total: number;
}

/** ABAC policies and the policy decision point (including the AuthZEN endpoints). */
export function abacResource(request: RequestFn) {
  return {
    list(): Promise<ListPage<AbacPolicy>> {
      return request({ method: 'GET', path: '/v1/abac_policies' });
    },
    get(id: string): Promise<AbacPolicy> {
      return request({ method: 'GET', path: `/v1/abac_policies/${enc(id)}` });
    },
    create(body: CreateAbacPolicyBody, idempotencyKey?: string): Promise<AbacPolicy> {
      return request({ method: 'POST', path: '/v1/abac_policies', body, idempotencyKey });
    },
    update(id: string, body: UpdateAbacPolicyBody): Promise<AbacPolicy> {
      return request({ method: 'PATCH', path: `/v1/abac_policies/${enc(id)}`, body });
    },
    delete(id: string): Promise<{ object: 'abac_policy'; id: string; deleted: true }> {
      return request({ method: 'DELETE', path: `/v1/abac_policies/${enc(id)}` });
    },
    versions(id: string): Promise<ListPage<AbacPolicyVersion>> {
      return request({ method: 'GET', path: `/v1/abac_policies/${enc(id)}/versions` });
    },
    /** Run a version's tests (default: current), or a draft `source` and `tests`, without saving. */
    test(id: string, body: { version?: number; source?: string; tests?: AbacPolicyTestCase[] } = {}): Promise<AbacTestRun> {
      return request({ method: 'POST', path: `/v1/abac_policies/${enc(id)}/test`, body });
    },
    /** Cedar JSON policy format: export policy text, import JSON (optionally creating the policy with `name`). */
    cedar: {
      export(source: string): Promise<{ object: 'cedar_json_policies'; policies: Array<Record<string, unknown>> }> {
        return request({ method: 'POST', path: '/v1/abac/cedar/export', body: { source } });
      },
      import(body: { policies: Array<Record<string, unknown>>; name?: string; fga_store_id?: string | null }): Promise<{ object: 'cedar_source'; source: string; policies: number } | AbacPolicy> {
        return request({ method: 'POST', path: '/v1/abac/cedar/import', body });
      },
      forPolicy(id: string): Promise<{ object: 'cedar_json_policies'; policies: Array<Record<string, unknown>> }> {
        return request({ method: 'GET', path: `/v1/abac_policies/${enc(id)}/cedar_json` });
      },
    },
    /** How access-token claims become a policy principal and its parents (used by {@link authorizeToken}). */
    tokenMapping: {
      get(): Promise<AbacTokenMapping> {
        return request({ method: 'GET', path: '/v1/abac/token_mapping' });
      },
      put(body: Partial<Omit<AbacTokenMapping, 'object'>>): Promise<AbacTokenMapping> {
        return request({ method: 'PUT', path: '/v1/abac/token_mapping', body });
      },
    },
    /** Decide for the principal an access token stands for (verified first; an invalid token is a 401). */
    authorizeToken(body: { access_token: string; action: string; resource: { type: string; id: string; attributes?: Record<string, unknown> }; context?: Record<string, unknown>; entities?: AbacEntity[]; policy_ids?: string[] }): Promise<AbacDecision & { principal: { type: string; id: string; parents: string[] }; issuer: 'atlas' | 'trusted' }> {
      return request({ method: 'POST', path: '/v1/abac/authorize_token', body });
    },
    /** May `principal` perform `action` on `resource`? */
    evaluate(body: AbacEvaluateBody): Promise<AbacDecision> {
      return request({ method: 'POST', path: '/v1/abac/evaluate', body });
    },
    /**
     * Partial evaluation (data filtering): the condition under which the request is allowed when
     * an entity is unknown, as a filter AST and, on request, parameterised SQL or a Prisma object.
     */
    partialEvaluate(body: AbacPartialBody): Promise<AbacResidual> {
      return request({ method: 'POST', path: '/v1/abac/partial_evaluate', body });
    },
    /** The resources of a type a principal may perform an action on, one page at a time. */
    accessibleResources(body: AbacAccessibleBody): Promise<AbacAccessibleList> {
      return request({ method: 'POST', path: '/v1/abac/accessible_resources', body });
    },
    /** Policy templates: policy source with `?principal` / `?resource` slots that links fill with entities. */
    templates: {
      list(): Promise<ListPage<AbacPolicyTemplate>> {
        return request({ method: 'GET', path: '/v1/abac_templates' });
      },
      get(id: string): Promise<AbacPolicyTemplate> {
        return request({ method: 'GET', path: `/v1/abac_templates/${enc(id)}` });
      },
      create(body: CreateAbacTemplateBody, idempotencyKey?: string): Promise<AbacPolicyTemplate> {
        return request({ method: 'POST', path: '/v1/abac_templates', body, idempotencyKey });
      },
      /** A new `source` reaches every link at once; it is refused if a link could no longer be filled in or would fail the schema. */
      update(id: string, body: Partial<CreateAbacTemplateBody>): Promise<AbacPolicyTemplate> {
        return request({ method: 'PATCH', path: `/v1/abac_templates/${enc(id)}`, body });
      },
      /** A template with links is refused unless `force` (which deletes the links too). */
      delete(id: string, opts: { force?: boolean } = {}): Promise<{ object: 'abac_policy_template'; id: string; deleted: true; links_deleted: number }> {
        return request({ method: 'DELETE', path: `/v1/abac_templates/${enc(id)}${opts.force ? '?force=true' : ''}` });
      },
    },
    /** Links: a template with its slots filled by entities. A link is evaluated from the template's current source. */
    links: {
      list(query: { template_id?: string } = {}): Promise<ListPage<AbacPolicyLink>> {
        return request({ method: 'GET', path: `/v1/abac_policy_links${query.template_id ? `?template_id=${enc(query.template_id)}` : ''}` });
      },
      get(id: string): Promise<AbacPolicyLink> {
        return request({ method: 'GET', path: `/v1/abac_policy_links/${enc(id)}` });
      },
      create(body: CreateAbacLinkBody, idempotencyKey?: string): Promise<AbacPolicyLink> {
        return request({ method: 'POST', path: '/v1/abac_policy_links', body, idempotencyKey });
      },
      update(id: string, body: Partial<Omit<CreateAbacLinkBody, 'template_id'>>): Promise<AbacPolicyLink> {
        return request({ method: 'PATCH', path: `/v1/abac_policy_links/${enc(id)}`, body });
      },
      delete(id: string): Promise<{ object: 'abac_policy_link'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/abac_policy_links/${enc(id)}` });
      },
    },
    /** The entity schema: once set, policies and templates are type-checked when saved. */
    schema: {
      get(): Promise<AbacSchemaState> {
        return request({ method: 'GET', path: '/v1/abac_schema' });
      },
      /** Saves the schema and reports the errors it would give the policies already stored (`policy_issues`). */
      set(schema: AbacSchemaDocument): Promise<AbacSchemaState> {
        return request({ method: 'PUT', path: '/v1/abac_schema', body: { schema } });
      },
      delete(): Promise<{ object: 'abac_schema'; deleted: true }> {
        return request({ method: 'DELETE', path: '/v1/abac_schema' });
      },
      /** Type-check draft source against the saved schema (or `schema`) without saving anything. */
      validate(body: { source: string; schema?: AbacSchemaDocument; template?: boolean }): Promise<AbacValidation> {
        return request({ method: 'POST', path: '/v1/abac_schema/validate', body });
      },
    },
    /** Compare two versions of a policy: the text, and the requests whose decision changes. */
    diff(id: string, opts: AbacDiffOptions = {}): Promise<AbacPolicyDiff> {
      const qs = Object.entries(opts)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
        .join('&');
      return request({ method: 'GET', path: `/v1/abac_policies/${enc(id)}/diff${qs ? `?${qs}` : ''}` });
    },
    /** The same comparison for two sources you send, without saving. */
    diffSources(body: { before: string; after: string; semantic?: boolean; max_requests?: number; max_changes?: number }): Promise<AbacPolicyDiff> {
      return request({ method: 'POST', path: '/v1/abac/diff', body });
    },
    /** AuthZEN 1.0 Subject Search: the subjects of a type that may perform the action on the resource. */
    authzenSearchSubject(body: AuthzenSearchRequest): Promise<{ results: Array<{ type: string; id: string }>; page: AuthzenSearchPage }> {
      return request({ method: 'POST', path: '/v1/authzen/access/v1/search/subject', body });
    },
    /** AuthZEN 1.0 Resource Search: the resources of a type the subject may perform the action on. */
    authzenSearchResource(body: AuthzenSearchRequest): Promise<{ results: Array<{ type: string; id: string }>; page: AuthzenSearchPage }> {
      return request({ method: 'POST', path: '/v1/authzen/access/v1/search/resource', body });
    },
    /** AuthZEN 1.0 Action Search: the actions the subject may perform on the resource. */
    authzenSearchAction(body: AuthzenSearchRequest): Promise<{ results: Array<{ name: string }>; page: AuthzenSearchPage }> {
      return request({ method: 'POST', path: '/v1/authzen/access/v1/search/action', body });
    },
    /** Convenience: the boolean answer to {@link evaluate}. */
    async isAllowed(body: AbacEvaluateBody): Promise<boolean> {
      return (await request<AbacDecision>({ method: 'POST', path: '/v1/abac/evaluate', body })).decision === 'allow';
    },
    /** AuthZEN 1.0 Access Evaluation. */
    authzenEvaluation(body: AuthzenEvaluation): Promise<{ decision: boolean; context?: Record<string, unknown> }> {
      return request({ method: 'POST', path: '/v1/authzen/access/v1/evaluation', body });
    },
    /** AuthZEN 1.0 Access Evaluations (batch). */
    authzenEvaluations(
      body: AuthzenEvaluation & { evaluations?: AuthzenEvaluation[]; options?: { evaluations_semantic?: 'execute_all' | 'deny_on_first_deny' | 'permit_on_first_permit' } },
    ): Promise<{ evaluations: Array<{ decision: boolean }> }> {
      return request({ method: 'POST', path: '/v1/authzen/access/v1/evaluations', body });
    },
  };
}

// The residual-filter helpers: evaluate a filter in memory, or compile it for SQL, Prisma or Drizzle.
export {
  FilterCompileError,
  evalFilter,
  filterToDrizzle,
  filterToPrisma,
  filterToSql,
  type DrizzleOps,
  type DrizzleOptions,
  type Filter,
  type FilterRows,
  type PrismaOptions,
  type SqlColumn,
  type SqlDialect,
  type SqlFragment,
  type SqlOptions,
} from '@atlasauth/authz';

export interface AbacTokenMapping {
  object: 'abac_token_mapping';
  principal_type: string;
  id_claim: string;
  parents: Array<{ claim: string; type: string }>;
  attribute_claims: string[];
  trusted_issuers: Array<{ issuer: string; jwks_uri: string; audience?: string }>;
}
