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
  created_at: number;
}

/** A tuple key. `object` is the target as `type:id`; `target` is accepted too. */
export interface FgaTupleKey {
  user: string;
  relation: string;
  object: string;
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

export interface FgaCheckBody {
  user: string;
  relation: string;
  object: string;
  /** Defaults to the store's latest model. */
  authorization_model_id?: string;
  contextual_tuples?: FgaTupleKeys;
}

export interface FgaListObjectsBody {
  user: string;
  relation: string;
  type: string;
  authorization_model_id?: string;
  contextual_tuples?: FgaTupleKeys;
}

/** One item in a batch check; `correlation_id` is echoed back to match results. */
export interface FgaBatchCheckItem {
  user: string;
  relation: string;
  object: string;
  correlation_id?: string;
  contextual_tuples?: FgaTupleKeys;
}

export interface FgaBatchCheckResult {
  object: 'fga.batch_check';
  authorization_model_id: string;
  result: Array<{ correlation_id: string; allowed: boolean }>;
}

export function fgaResource(request: RequestFn) {
  const api = {
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

    /** Write and/or delete tuples in one atomic call. */
    write(
      storeId: string,
      body: { writes?: FgaTupleKeys; deletes?: FgaTupleKeys },
      idempotencyKey?: string,
    ): Promise<{ object: 'fga.write_result'; writes: number; deletes: number }> {
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
    ): Promise<{ object: 'fga.check'; allowed: boolean; authorization_model_id: string }> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/check`, body });
    },
    /** Resolve MANY access questions in one round trip (list-authorization UIs). */
    batchCheck(
      storeId: string,
      body: { checks: FgaBatchCheckItem[]; authorization_model_id?: string },
    ): Promise<FgaBatchCheckResult> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/batch-check`, body });
    },
    /** List the objects of a type a user has a relation to. */
    listObjects(
      storeId: string,
      body: FgaListObjectsBody,
    ): Promise<{ object: 'fga.list_objects'; objects: string[]; authorization_model_id: string }> {
      return request({ method: 'POST', path: `/v1/fga/stores/${enc(storeId)}/list-objects`, body });
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
        batchCheck: (body: { checks: FgaBatchCheckItem[]; authorization_model_id?: string }) =>
          api.batchCheck(storeId, body),
        listObjects: (body: FgaListObjectsBody) => api.listObjects(storeId, body),
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
