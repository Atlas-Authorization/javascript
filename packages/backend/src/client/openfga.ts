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

export interface OpenFgaCheckBody {
  tuple_key: OpenFgaTupleKey;
  authorization_model_id?: string;
  contextual_tuples?: OpenFgaContextualTuples;
}

export interface OpenFgaBatchCheckItem {
  tuple_key: OpenFgaTupleKey;
  /** Keys the result; defaults to the item's index. */
  correlation_id?: string;
  contextual_tuples?: OpenFgaContextualTuples;
}

export interface OpenFgaBatchCheckBody {
  /** 1–100 checks. */
  checks: OpenFgaBatchCheckItem[];
  authorization_model_id?: string;
}

export interface OpenFgaExpandBody {
  tuple_key: { object: string; relation: string };
  authorization_model_id?: string;
}

export interface OpenFgaListObjectsBody {
  /** Object type, e.g. `document`. */
  type: string;
  relation: string;
  user: string;
  authorization_model_id?: string;
  contextual_tuples?: OpenFgaContextualTuples;
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
  return {
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
}
