import { enc, type RequestFn } from './request';
import type { ListPage } from './types';

/**
 * Fine-grained relationship-based authorization (Zanzibar / OpenFGA), in-house.
 * A tenant owns STORES; each store holds immutable, versioned authorization
 * MODELS and the relationship TUPLES the engine resolves. Every store is scoped
 * to the calling instance — a store from another instance reads as a 404.
 */

export interface FgaStore {
  object: 'fga.store';
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export interface FgaAuthorizationModel {
  object: 'fga.authorization_model';
  id: string;
  store_id: string;
  schema_version: string;
  /** The OpenFGA model. Present on get/create; omitted from list rows. */
  model?: Record<string, unknown>;
  created_at: number;
}

export interface FgaTuple {
  object: 'fga.tuple';
  /** `type:id` or `type:id#relation` for a userset. */
  user: string;
  relation: string;
  /** The object of the tuple as `type:id`. */
  target: string;
  condition?: FgaTupleCondition;
  /** Epoch ms after which the tuple stops granting. */
  expires_at?: number;
  created_at: number;
}

/** A model condition bound to a tuple, with the parameter values fixed on it. */
export interface FgaTupleCondition {
  name: string;
  context?: Record<string, unknown>;
}

/** A tuple key. `object` is the target as `type:id`; `target` is accepted too. */
export interface FgaTupleKey {
  user: string;
  relation: string;
  object: string;
  /** The tuple grants only while this model condition holds. */
  condition?: FgaTupleCondition;
  /** The tuple stops granting at this time (ISO 8601 or epoch ms, in the future); a sweep then deletes it. */
  expires_at?: string | number;
}

/**
 * Freshness of a read. `MINIMIZE_LATENCY` (and the default) may be served from a
 * short-lived cache; `HIGHER_CONSISTENCY` reads the primary.
 */
export type FgaConsistency = 'UNSPECIFIED' | 'MINIMIZE_LATENCY' | 'HIGHER_CONSISTENCY';

export interface FgaConsistencyOptions {
  consistency?: FgaConsistency;
  /** A token from a write: the read reflects at least that write. */
  consistency_token?: string;
}

/** An OpenFGA authorization model to persist. Validated before storage. */
export interface FgaAuthorizationModelInput {
  type_definitions: unknown[];
  /** Defaults to `1.1` when omitted. */
  schema_version?: string;
  conditions?: Record<string, unknown>;
}

/** Both `{ tuple_keys: [...] }` (OpenFGA shape) and a bare array are accepted. */
export type FgaTupleKeys = FgaTupleKey[] | { tuple_keys: FgaTupleKey[] };

export interface FgaCheckBody extends FgaConsistencyOptions {
  user: string;
  relation: string;
  object: string;
  /** Defaults to the store's latest model. */
  authorization_model_id?: string;
  contextual_tuples?: FgaTupleKeys;
  /** Values for tuple-condition parameters (a tuple's own context wins). */
  context?: Record<string, unknown>;
}

export interface FgaListObjectsBody extends FgaConsistencyOptions {
  user: string;
  relation: string;
  type: string;
  authorization_model_id?: string;
  contextual_tuples?: FgaTupleKeys;
  /** Page size; without it every object is returned. */
  limit?: number;
  /** The `next_cursor` of the previous page. */
  starting_after?: string;
  context?: Record<string, unknown>;
}

export interface FgaListUsersBody extends FgaConsistencyOptions {
  /** `type:id`. */
  object: string;
  relation: string;
  /** Exactly one filter; add `relation` to get usersets such as `group:eng#member`. */
  user_filters: [{ type: string; relation?: string }];
  authorization_model_id?: string;
  contextual_tuples?: FgaTupleKeys;
  context?: Record<string, unknown>;
  /** 1–1000; defaults to 1000. */
  page_size?: number;
  continuation_token?: string;
}

export interface FgaListUsersResult {
  object: 'fga.list_users';
  /** `type:id`, `type:id#relation`, or `type:*` for a public wildcard. */
  users: string[];
  /** Ids a wildcard in `users` does not cover. */
  excluded_users: string[];
  /** Pass back for the next page; null on the last. */
  continuation_token: string | null;
  authorization_model_id: string;
  consistency_token: string;
}

export interface FgaReadChangesParams {
  /** Only changes to tuples on objects of this type. */
  type?: string;
  /** 1–100; defaults to 50. */
  page_size?: number;
  continuation_token?: string;
  /** RFC 3339: only changes at or after it. */
  start_time?: string;
}

export interface FgaTupleChange {
  object: 'fga.tuple_change';
  operation: 'write' | 'delete';
  user: string;
  relation: string;
  target: string;
  condition?: FgaTupleCondition;
  consistency_token: string;
  created_at: number;
}

export interface FgaChangesPage {
  object: 'list';
  data: FgaTupleChange[];
  has_more: boolean;
  /** Save it and call again later to receive only newer changes. */
  continuation_token: string;
}

/** One item in a batch check; `correlation_id` is echoed back to match results. */
export interface FgaBatchCheckItem {
  user: string;
  relation: string;
  object: string;
  correlation_id?: string;
  contextual_tuples?: FgaTupleKeys;
  context?: Record<string, unknown>;
}

export interface FgaBatchCheckResult {
  object: 'fga.batch_check';
  authorization_model_id: string;
  consistency_token: string;
  result: Array<{ correlation_id: string; allowed: boolean }>;
}

/** How the instance runs FGA reads and keeps its tuple change log. */
export interface FgaSettings {
  object: 'fga.settings';
  /** Result-cache TTL in ms; null uses the platform default, 0 turns the cache off. */
  cache_ttl_ms: number | null;
  /** Applied to reads that name no `consistency`. */
  default_consistency: FgaConsistency;
  /** Days of tuple change log kept; null keeps all of it. */
  changelog_retention_days: number | null;
}

export type UpdateFgaSettingsBody = Partial<Omit<FgaSettings, 'object'>>;

export function fgaResource(request: RequestFn) {
  const api = {
    settings: {
      get(): Promise<FgaSettings> {
        return request({ method: 'GET', path: '/v1/fga/settings' });
      },
      update(body: UpdateFgaSettingsBody): Promise<FgaSettings> {
        return request({ method: 'PUT', path: '/v1/fga/settings', body });
      },
    },
    stores: {
      list(): Promise<ListPage<FgaStore>> {
        return request({ method: 'GET', path: '/v1/fga/stores' });
      },
      create(body: { name: string }, idempotencyKey?: string): Promise<FgaStore> {
        return request({ method: 'POST', path: '/v1/fga/stores', body, idempotencyKey });
      },
      get(id: string): Promise<FgaStore> {
        return request({ method: 'GET', path: `/v1/fga/stores/${enc(id)}` });
      },
      delete(id: string): Promise<{ object: 'fga.store'; id: string; deleted: true }> {
        return request({ method: 'DELETE', path: `/v1/fga/stores/${enc(id)}` });
      },
    },

    models: {
      list(storeId: string): Promise<ListPage<FgaAuthorizationModel>> {
        return request({
          method: 'GET',
          path: `/v1/fga/stores/${enc(storeId)}/authorization-models`,
        });
      },
      create(
        storeId: string,
        body: FgaAuthorizationModelInput,
        idempotencyKey?: string,
      ): Promise<FgaAuthorizationModel> {
        return request({
          method: 'POST',
          path: `/v1/fga/stores/${enc(storeId)}/authorization-models`,
          body,
          idempotencyKey,
        });
      },
      get(storeId: string, modelId: string): Promise<FgaAuthorizationModel> {
        return request({
          method: 'GET',
          path: `/v1/fga/stores/${enc(storeId)}/authorization-models/${enc(modelId)}`,
        });
      },
    },

    /** Write and/or delete tuples in one atomic call. `on_duplicate` / `on_missing` = `error` refuse a repeat write or a delete of nothing. */
    write(
      storeId: string,
      body: { writes?: FgaTupleKeys; deletes?: FgaTupleKeys; on_duplicate?: 'ignore' | 'error'; on_missing?: 'ignore' | 'error' },
      idempotencyKey?: string,
    ): Promise<{ object: 'fga.write_result'; writes: number; deletes: number; consistency_token: string }> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/write`, body, idempotencyKey });
    },
    /** Query stored tuples by any of user / relation / object. */
    read(
      storeId: string,
      body: { user?: string; relation?: string; object?: string },
    ): Promise<ListPage<FgaTuple>> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/read`, body });
    },
    /** Resolve a single access question against the model. */
    check(
      storeId: string,
      body: FgaCheckBody,
    ): Promise<{ object: 'fga.check'; allowed: boolean; authorization_model_id: string; consistency_token: string }> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/check`, body });
    },
    /** Resolve MANY access questions in one round trip (list-authorization UIs). */
    batchCheck(
      storeId: string,
      body: { checks: FgaBatchCheckItem[]; authorization_model_id?: string } & FgaConsistencyOptions,
    ): Promise<FgaBatchCheckResult> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/batch-check`, body });
    },
    /** List the objects of a type a user has a relation to. */
    listObjects(
      storeId: string,
      body: FgaListObjectsBody,
    ): Promise<{ object: 'fga.list_objects'; objects: string[]; has_more: boolean; next_cursor: string | null; authorization_model_id: string; consistency_token: string }> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/list-objects`, body });
    },
    /**
     * Who has a relation on an object: concrete users, usersets (give the filter
     * a `relation`) and the `type:*` wildcard with `excluded_users`. One page.
     */
    listUsers(storeId: string, body: FgaListUsersBody): Promise<FgaListUsersResult> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/list-users`, body });
    },
    /** {@link listUsers} following `continuation_token` until every page is collected. */
    async listAllUsers(storeId: string, body: FgaListUsersBody): Promise<FgaListUsersResult> {
      let page = await api.listUsers(storeId, body);
      const users = [...page.users];
      while (page.continuation_token) {
        page = await api.listUsers(storeId, { ...body, continuation_token: page.continuation_token });
        users.push(...page.users);
      }
      return { ...page, users };
    },
    /**
     * The store's tuple change log, in commit order. The returned
     * `continuation_token` works even on the last page: persist it and call again
     * to receive only what changed since.
     */
    readChanges(storeId: string, params: FgaReadChangesParams = {}): Promise<FgaChangesPage> {
      return request({
        method: 'GET',
        path: `/v1/fga/stores/${enc(storeId)}/changes`,
        query: { ...params },
      });
    },
    /** What a local PDP syncs: a page of tuples (full), or the changes after `since` (a store revision). */
    snapshot(storeId: string, params: { since?: number; cursor?: string; limit?: number } = {}): Promise<FgaSnapshot> {
      return request({ method: 'GET', path: `/v1/fga/stores/${enc(storeId)}/snapshot`, query: { ...params } });
    },
    /** Bulk-import tuples (idempotent; `dry_run` reports without writing). */
    importTuples(storeId: string, body: { tuples: Array<FgaTupleKey>; dry_run?: boolean }): Promise<{ object: 'fga.import_result'; dry_run: boolean; total: number; new: number; existing: number; revision: number; consistency_token?: string }> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/import`, body });
    },
    /** Run an FGA test suite in memory (the model from `dsl` / `modules`, or the store's). */
    runTests(storeId: string, body: FgaTestSuite): Promise<FgaTestReport> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/tests`, body });
    },
    /** The same, with no store: the model comes from `dsl` / `modules`. */
    runTestsWithoutStore(body: FgaTestSuite): Promise<FgaTestReport> {
      return request({ method: 'POST', path: '/v1/fga/tests', body });
    },
    /** Validate a model and convert it DSL <-> JSON; `modules` compile to one model. */
    transformModel(body: { dsl?: string; modules?: Array<{ name: string; contents: string }>; model?: Record<string, unknown> }): Promise<{ object: 'fga.model_transform'; valid: true; model: Record<string, unknown>; dsl: string }> {
      return request({ method: 'POST', path: '/v1/fga/models/transform', body });
    },
    /** Nodes and edges of a model version, for a visualizer. */
    modelGraph(storeId: string, modelId: string): Promise<{ object: 'fga.model_graph'; model_id: string; nodes: Array<{ id: string; kind: 'type' | 'relation'; type: string; relation?: string }>; edges: Array<{ from: string; to: string; kind: 'direct' | 'computed' | 'tupleset' | 'parent'; label?: string }> }> {
      return request({ method: 'GET', path: `/v1/fga/stores/${enc(storeId)}/authorization-models/${enc(modelId)}/graph` });
    },
    /** What changed from the previous version (or `against`). */
    modelDiff(storeId: string, modelId: string, against?: string): Promise<FgaModelDiff> {
      return request({ method: 'GET', path: `/v1/fga/stores/${enc(storeId)}/authorization-models/${enc(modelId)}/diff`, query: { against } });
    },
    /** OpenFGA assertions stored against a model version. */
    assertions: {
      get(storeId: string, modelId: string): Promise<{ authorization_model_id: string; assertions: unknown[] }> {
        return request({ method: 'GET', path: `/v1/openfga/stores/${enc(storeId)}/assertions/${enc(modelId)}` });
      },
      put(storeId: string, modelId: string, assertions: unknown[]): Promise<void> {
        return request({ method: 'PUT', path: `/v1/openfga/stores/${enc(storeId)}/assertions/${enc(modelId)}`, body: { assertions } });
      },
      run(storeId: string, modelId: string): Promise<{ object: 'fga.assertion_run'; passed: boolean; total: number; failed: number; results: unknown[] }> {
        return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/authorization-models/${enc(modelId)}/assertions/run` });
      },
    },
    /** Expand the full userset tree for an object#relation. */
    expand(
      storeId: string,
      body: { object: string; relation: string; authorization_model_id?: string },
    ): Promise<{ object: 'fga.expand'; tree: unknown; authorization_model_id: string }> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/expand`, body });
    },

    /**
     * Bind a default store so an app that uses one store (the common case) can
     * call `fga.store(id).check({ user, relation, object })` instead of threading
     * the store id through every call — the ergonomic OpenFGA/Auth0-FGA SDKs
     * offer. Returns the same operations with `storeId` pre-applied.
     */
    store(storeId: string) {
      return {
        write: (body: { writes?: FgaTupleKeys; deletes?: FgaTupleKeys }, idempotencyKey?: string) =>
          api.write(storeId, body, idempotencyKey),
        read: (body: { user?: string; relation?: string; object?: string }) =>
          api.read(storeId, body),
        check: (body: FgaCheckBody) => api.check(storeId, body),
        batchCheck: (body: { checks: FgaBatchCheckItem[]; authorization_model_id?: string } & FgaConsistencyOptions) =>
          api.batchCheck(storeId, body),
        listObjects: (body: FgaListObjectsBody) => api.listObjects(storeId, body),
        listUsers: (body: FgaListUsersBody) => api.listUsers(storeId, body),
        listAllUsers: (body: FgaListUsersBody) => api.listAllUsers(storeId, body),
        readChanges: (params?: FgaReadChangesParams) => api.readChanges(storeId, params),
        expand: (body: { object: string; relation: string; authorization_model_id?: string }) =>
          api.expand(storeId, body),
        models: {
          list: () => api.models.list(storeId),
          create: (body: FgaAuthorizationModelInput, idempotencyKey?: string) =>
            api.models.create(storeId, body, idempotencyKey),
          get: (modelId: string) => api.models.get(storeId, modelId),
        },
      };
    },
  };
  return api;
}

export interface FgaSnapshot {
  object: 'fga.snapshot';
  store_id: string;
  model_id: string | null;
  model: Record<string, unknown> | null;
  full: boolean;
  /** The store revision this snapshot is at; pass it back as `since`. */
  revision: number;
  tuples?: Array<FgaTupleKey>;
  changes?: Array<FgaTupleKey & { operation: 'write' | 'delete' }>;
  next_cursor?: string | null;
  has_more: boolean;
}

export interface FgaTestSuite {
  model_id?: string;
  dsl?: string;
  modules?: Array<{ name: string; contents: string }>;
  tuples?: Array<FgaTupleKey>;
  tests: Array<{
    name?: string;
    tuples?: Array<FgaTupleKey>;
    check?: Array<{ user: string; object: string; context?: Record<string, unknown>; assertions: Record<string, boolean> }>;
    list_objects?: Array<{ user: string; type: string; context?: Record<string, unknown>; assertions: Record<string, string[]> }>;
    list_users?: Array<{ object: string; user_filter: { type: string; relation?: string } | Array<{ type: string; relation?: string }>; context?: Record<string, unknown>; assertions: Record<string, { users: string[] }> }>;
  }>;
}

export interface FgaTestReport {
  object: 'fga.test_report';
  passed: boolean;
  total: number;
  failed: number;
  coverage: { relations: number; covered: number; uncovered: string[] };
  results: Array<{ name: string; passed: boolean; checks: number; failures: Array<{ kind: 'check' | 'list_objects' | 'list_users'; query: string; expected: unknown; actual: unknown; error?: string }> }>;
}

export interface FgaModelDiff {
  object: 'fga.model_diff';
  from: string | null;
  to: string;
  types: { added: string[]; removed: string[] };
  relations: { added: string[]; removed: string[]; changed: string[] };
  conditions: { added: string[]; removed: string[]; changed: string[] };
  breaking: boolean;
  identical: boolean;
}
