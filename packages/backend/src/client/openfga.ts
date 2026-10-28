import { enc, type RequestFn } from './request';

/**
 * The OpenFGA-wire ReBAC surface (`/v1/openfga/stores/...`). Shapes follow the
 * OpenFGA HTTP API (snake_case on the wire), so an existing OpenFGA client's
 * payloads work unchanged. Distinct from `fga` (Atlas's own relationship API).
 */

/** An OpenFGA store. Timestamps are ISO-8601 strings, as in OpenFGA. */
export interface OpenFgaStore {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
}

/** A relationship tuple key: `user` (e.g. `user:alice`), `relation`, `object` (e.g. `document:roadmap`). */
export interface OpenFgaTupleKey {
  user: string;
  relation: string;
  object: string;
  /** A model condition the tuple is bound to. */
  condition?: { name: string; context?: Record<string, unknown> };
}

/** OpenFGA's `consistency` enum plus Atlas's consistency token (see ListUsers/Check docs). */
export interface OpenFgaConsistencyOptions {
  consistency?: 'UNSPECIFIED' | 'MINIMIZE_LATENCY' | 'HIGHER_CONSISTENCY';
  /** A token from a write; the read reflects at least that write. Also sent as the `Atlas-Consistency-Token` header. */
  consistency_token?: string;
}

/** Contextual tuples: either the OpenFGA `{ tuple_keys }` wrapper or a bare array. */
export type OpenFgaContextualTuples = { tuple_keys: OpenFgaTupleKey[] } | OpenFgaTupleKey[];

/** An authorization model. `type_definitions` and other OpenFGA keys pass through as-is. */
export interface OpenFgaAuthorizationModel {
  id: string;
  schema_version: string;
  type_definitions?: Array<Record<string, unknown>>;
  [key: string]: unknown;
}

/**
 * A new model: the OpenFGA JSON form (`schema_version` + `type_definitions`) or
 * the DSL text in `dsl`.
 */
export interface WriteOpenFgaModelBody {
  type_definitions?: Array<Record<string, unknown>>;
  schema_version?: string;
  dsl?: string;
  [key: string]: unknown;
}

export interface OpenFgaCheckBody extends OpenFgaConsistencyOptions {
  tuple_key: OpenFgaTupleKey;
  authorization_model_id?: string;
  contextual_tuples?: OpenFgaContextualTuples;
  /** Values for condition parameters. */
  context?: Record<string, unknown>;
}

export interface OpenFgaBatchCheckItem {
  tuple_key: OpenFgaTupleKey;
  /** Keys the result; defaults to the item's index. */
  correlation_id?: string;
  contextual_tuples?: OpenFgaContextualTuples;
  context?: Record<string, unknown>;
}

export interface OpenFgaBatchCheckBody extends OpenFgaConsistencyOptions {
  /** 1–100 checks. */
  checks: OpenFgaBatchCheckItem[];
  authorization_model_id?: string;
}

export interface OpenFgaExpandBody {
  tuple_key: { object: string; relation: string };
  authorization_model_id?: string;
}

export interface OpenFgaListObjectsBody extends OpenFgaConsistencyOptions {
  /** Object type, e.g. `document`. */
  type: string;
  relation: string;
  user: string;
  authorization_model_id?: string;
  contextual_tuples?: OpenFgaContextualTuples;
  context?: Record<string, unknown>;
}

export interface OpenFgaListUsersBody extends OpenFgaConsistencyOptions {
  object: { type: string; id: string };
  relation: string;
  /** Exactly one filter; add `relation` to get usersets. */
  user_filters: [{ type: string; relation?: string }];
  authorization_model_id?: string;
  contextual_tuples?: OpenFgaContextualTuples;
  context?: Record<string, unknown>;
  /** Atlas extension: 1–1000, default 1000. */
  page_size?: number;
  /** Atlas extension: the previous page's `continuation_token`. */
  continuation_token?: string;
}

/** One listed user: a person/thing, a userset, or the public wildcard. */
export type OpenFgaListedUser =
  | { object: { type: string; id: string } }
  | { userset: { type: string; id: string; relation: string } }
  | { wildcard: { type: string } };

export interface OpenFgaListUsersResult {
  users: OpenFgaListedUser[];
  excluded_users: Array<{ object: { type: string; id: string } }>;
  /** Empty on the last page. */
  continuation_token: string;
}

export interface OpenFgaReadChangesParams {
  type?: string;
  /** 1–100, default 50. */
  page_size?: number;
  continuation_token?: string;
  /** RFC 3339. */
  start_time?: string;
}

export interface OpenFgaTupleChange {
  tuple_key: OpenFgaTupleKey;
  operation: 'TUPLE_OPERATION_WRITE' | 'TUPLE_OPERATION_DELETE';
  timestamp: string;
}

export interface OpenFgaReadBody {
  /** Optional filter; `object` may be a full `type:id` or a bare `type:` prefix. */
  tuple_key?: Partial<OpenFgaTupleKey>;
  page_size?: number;
  continuation_token?: string;
}

export interface OpenFgaTuple {
  key: OpenFgaTupleKey;
  timestamp: string;
}

export interface OpenFgaWriteBody {
  writes?: { tuple_keys: OpenFgaTupleKey[] };
  deletes?: { tuple_keys: OpenFgaTupleKey[] };
}

export function openfgaResource(request: RequestFn) {
  const api = {
    stores: {
      list(): Promise<{ stores: OpenFgaStore[] }> {
        return request({ method: 'GET', path: '/v1/openfga/stores' });
      },
      create(body: { name: string }, idempotencyKey?: string): Promise<OpenFgaStore> {
        return request({ method: 'POST', path: '/v1/openfga/stores', body, idempotencyKey });
      },
      get(store: string): Promise<OpenFgaStore> {
        return request({ method: 'GET', path: `/v1/openfga/stores/${enc(store)}` });
      },
    },
    authorizationModels: {
      list(store: string): Promise<{ authorization_models: OpenFgaAuthorizationModel[] }> {
        return request({
          method: 'GET',
          path: `/v1/openfga/stores/${enc(store)}/authorization-models`,
        });
      },
      /** Write a new model; it becomes the latest model of the store. */
      write(store: string, body: WriteOpenFgaModelBody): Promise<{ authorization_model_id: string }> {
        return request({
          method: 'POST',
          path: `/v1/openfga/stores/${enc(store)}/authorization-models`,
          body,
        });
      },
      get(
        store: string,
        modelId: string,
      ): Promise<{ authorization_model: OpenFgaAuthorizationModel }> {
        return request({
          method: 'GET',
          path: `/v1/openfga/stores/${enc(store)}/authorization-models/${enc(modelId)}`,
        });
      },
    },
    check(store: string, body: OpenFgaCheckBody): Promise<{ allowed: boolean }> {
      return request({ method: 'POST', path: `/v1/openfga/stores/${enc(store)}/check`, body });
    },
    /** Up to 100 checks in one call; results keyed by correlation id. */
    batchCheck(
      store: string,
      body: OpenFgaBatchCheckBody,
    ): Promise<{ result: Record<string, { allowed: boolean }> }> {
      return request({
        method: 'POST',
        path: `/v1/openfga/stores/${enc(store)}/batch-check`,
        body,
      });
    },
    /** The userset tree for an (object, relation), in OpenFGA's node format. */
    expand(
      store: string,
      body: OpenFgaExpandBody,
    ): Promise<{ tree: { root: Record<string, unknown> } }> {
      return request({ method: 'POST', path: `/v1/openfga/stores/${enc(store)}/expand`, body });
    },
    /** Objects (`type:id`) of `type` the user has `relation` on. */
    listObjects(store: string, body: OpenFgaListObjectsBody): Promise<{ objects: string[] }> {
      return request({
        method: 'POST',
        path: `/v1/openfga/stores/${enc(store)}/list-objects`,
        body,
      });
    },
    /**
     * Who has `relation` on `object` (OpenFGA ListUsers): users, usersets and the
     * wildcard with `excluded_users`. One page — see {@link listAllUsers}.
     */
    listUsers(store: string, body: OpenFgaListUsersBody): Promise<OpenFgaListUsersResult> {
      return request({ method: 'POST', path: `/v1/openfga/stores/${enc(store)}/list-users`, body });
    },
    /** {@link listUsers} following `continuation_token` until every page is collected. */
    async listAllUsers(store: string, body: OpenFgaListUsersBody): Promise<OpenFgaListUsersResult> {
      let page = await api.listUsers(store, body);
      const users = [...page.users];
      while (page.continuation_token) {
        page = await api.listUsers(store, { ...body, continuation_token: page.continuation_token });
        users.push(...page.users);
      }
      return { ...page, users };
    },
    /** The tuple change log (OpenFGA ReadChanges); the token also resumes after the last page. */
    readChanges(
      store: string,
      params: OpenFgaReadChangesParams = {},
    ): Promise<{ changes: OpenFgaTupleChange[]; continuation_token: string }> {
      return request({
        method: 'GET',
        path: `/v1/openfga/stores/${enc(store)}/changes`,
        query: { ...params },
      });
    },
    read(
      store: string,
      body: OpenFgaReadBody = {},
    ): Promise<{ tuples: OpenFgaTuple[]; continuation_token: string }> {
      return request({ method: 'POST', path: `/v1/openfga/stores/${enc(store)}/read`, body });
    },
    /** Add (`writes`) and/or remove (`deletes`) tuples. */
    write(store: string, body: OpenFgaWriteBody): Promise<Record<string, never>> {
      return request({ method: 'POST', path: `/v1/openfga/stores/${enc(store)}/write`, body });
    },
  };
  return api;
}
