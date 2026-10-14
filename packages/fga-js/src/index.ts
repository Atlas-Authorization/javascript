/**
 * @atlasauth/fga-js — the Atlas FGA client for JavaScript/TypeScript.
 *
 * Fine-grained, relationship-based authorization (Zanzibar / OpenFGA), served
 * by Atlas's in-house engine at the Backend API's `/v1/fga` surface. This is a
 * NATIVE client (not a wrapper over `@openfga/sdk`): Atlas's FGA API is
 * OpenFGA-SHAPED but not byte-for-byte wire-identical — it wraps responses in
 * Atlas's `{ object, ... }` envelope, returns `read` as a `{ object:'list',
 * data, has_more }` page, and mounts `list-objects` / `read` / `expand` only on
 * `/v1/fga` (the OpenFGA-wire-compatible mirror at `/v1/openfga` covers only
 * check / write / stores / models). So the full surface needs this thin native
 * client. See the README "Divergences from OpenFGA" section.
 *
 * Zero runtime dependencies — uses the global `fetch` (Node 18+, browsers,
 * edge workers). Authenticated with an Atlas secret key:
 * `Authorization: Bearer sk_...`.
 *
 *   const fga = new AtlasFga({ secretKey: 'sk_live_...', storeId: 'store_...' });
 *   const { allowed } = await fga.check({ user: 'user:alice', relation: 'viewer', object: 'doc:readme' });
 */

/** The default Atlas Backend API origin; override with `baseUrl`. */
export const DEFAULT_BASE_URL = 'https://api.atlasauth.net';

export interface AtlasFgaOptions {
  /**
   * Atlas secret key (`sk_live_…` / `sk_test_…`). Falls back to the
   * `ATLAS_SECRET_KEY` env var when omitted.
   */
  secretKey?: string;
  /**
   * Default store id applied to every store-scoped call (`check`, `write`,
   * `listObjects`, …) so you need not thread it through each call. Falls back
   * to the `ATLAS_FGA_STORE_ID` env var. Override per call with `.store(id)`.
   */
  storeId?: string;
  /**
   * Default authorization model id folded into query bodies (`check`,
   * `listObjects`, `expand`, `batchCheck`) when a call does not set its own.
   * When unset, Atlas resolves the store's latest model. Falls back to
   * `ATLAS_FGA_MODEL_ID`.
   */
  authorizationModelId?: string;
  /** Backend API origin. Defaults to {@link DEFAULT_BASE_URL}. */
  baseUrl?: string;
  /** Inject a `fetch` implementation (tests, custom agents). Defaults to global `fetch`. */
  fetch?: typeof fetch;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
}

/* ---- wire types (mirror the Atlas `/v1/fga` responses) ----------------- */

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
  /** The OpenFGA model body. Present on get/create; omitted from list rows. */
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

/** A tuple key. `object` is the target as `type:id`. */
export interface FgaTupleKey {
  user: string;
  relation: string;
  object: string;
}

/** Both `{ tuple_keys: [...] }` (OpenFGA shape) and a bare array are accepted. */
export type FgaTupleKeys = FgaTupleKey[] | { tuple_keys: FgaTupleKey[] };

/** An OpenFGA authorization model to persist. Validated server-side before storage. */
export interface FgaAuthorizationModelInput {
  type_definitions: unknown[];
  /** Defaults to `1.1` when omitted. */
  schema_version?: string;
  conditions?: Record<string, unknown>;
}

export interface FgaListPage<T> {
  object: 'list';
  data: T[];
  has_more: boolean;
}

export interface FgaCheckBody {
  user: string;
  relation: string;
  object: string;
  authorization_model_id?: string;
  contextual_tuples?: FgaTupleKeys;
}
export interface FgaCheckResult {
  object: 'fga.check';
  allowed: boolean;
  authorization_model_id: string;
}

export interface FgaListObjectsBody {
  user: string;
  relation: string;
  type: string;
  authorization_model_id?: string;
  contextual_tuples?: FgaTupleKeys;
}
export interface FgaListObjectsResult {
  object: 'fga.list_objects';
  /** Matching objects as `type:id`. */
  objects: string[];
  authorization_model_id: string;
}

export interface FgaReadBody {
  user?: string;
  relation?: string;
  object?: string;
}

export interface FgaExpandBody {
  object: string;
  relation: string;
  authorization_model_id?: string;
}
export interface FgaExpandResult {
  object: 'fga.expand';
  tree: unknown;
  authorization_model_id: string;
}

export interface FgaWriteBody {
  writes?: FgaTupleKeys;
  deletes?: FgaTupleKeys;
}
export interface FgaWriteResult {
  object: 'fga.write_result';
  writes: number;
  deletes: number;
}

export interface FgaBatchCheckItem {
  user: string;
  relation: string;
  object: string;
  /** Echoed back on the matching result so callers can pair them. */
  correlation_id?: string;
  contextual_tuples?: FgaTupleKeys;
}
export interface FgaBatchCheckBody {
  checks: FgaBatchCheckItem[];
  authorization_model_id?: string;
}
export interface FgaBatchCheckResult {
  object: 'fga.batch_check';
  authorization_model_id: string;
  result: Array<{ correlation_id: string; allowed: boolean }>;
}

/* ---- errors ------------------------------------------------------------ */

export interface AtlasApiErrorDetail {
  code: string;
  message: string;
  param?: string;
  meta?: Record<string, unknown>;
}

/** Thrown when Atlas returns a non-2xx response. Carries the §9.1 error envelope. */
export class AtlasFgaError extends Error {
  readonly status: number;
  readonly errors: AtlasApiErrorDetail[];
  constructor(status: number, errors: AtlasApiErrorDetail[], message?: string) {
    super(message ?? errors[0]?.message ?? `Atlas FGA request failed (HTTP ${status}).`);
    this.name = 'AtlasFgaError';
    this.status = status;
    this.errors = errors;
  }
  /** The first error code (e.g. `store_id_not_found`), the usual branch point. */
  get code(): string | undefined {
    return this.errors[0]?.code;
  }
}

/* ---- client ------------------------------------------------------------ */

// Minimal ambient for `process` so the package needs no @types/node; reading it
// is still guarded in `envGet` for non-Node runtimes.
declare const process: { env?: Record<string, string | undefined> } | undefined;

const envGet = (key: string): string | undefined => {
  // Guarded so the client still loads in a browser / edge worker with no `process`.
  try {
    return typeof process !== 'undefined' ? process.env?.[key] : undefined;
  } catch {
    return undefined;
  }
};

/**
 * The Atlas FGA client. Construct once, reuse everywhere; safe to share.
 * When a default `storeId` is configured, the store-scoped operations are
 * callable straight off the client; otherwise bind one with `.store(id)`.
 */
export class AtlasFga {
  readonly baseUrl: string;
  private readonly secretKey: string;
  private readonly defaultStoreId?: string;
  private readonly defaultModelId?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly extraHeaders: Record<string, string>;

  readonly stores: StoresApi;
  readonly models: ModelsApi;

  constructor(options: AtlasFgaOptions = {}) {
    const secretKey = options.secretKey ?? envGet('ATLAS_SECRET_KEY');
    if (!secretKey) {
      throw new Error(
        'AtlasFga: a secret key is required (pass { secretKey } or set ATLAS_SECRET_KEY).',
      );
    }
    this.secretKey = secretKey;
    this.baseUrl = (options.baseUrl ?? envGet('ATLAS_FGA_URL') ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.defaultStoreId = options.storeId ?? envGet('ATLAS_FGA_STORE_ID');
    this.defaultModelId = options.authorizationModelId ?? envGet('ATLAS_FGA_MODEL_ID');
    const f = options.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
    if (!f) {
      throw new Error('AtlasFga: no global `fetch` found; pass { fetch } (Node < 18).');
    }
    // Bind so a passed `globalThis.fetch` keeps its receiver.
    this.fetchImpl = f.bind(globalThis);
    this.extraHeaders = options.headers ?? {};

    this.stores = new StoresApi(this);
    this.models = new ModelsApi(this);
  }

  /** @internal issue an authenticated JSON request against the Backend API. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.secretKey}`,
      accept: 'application/json',
      'user-agent': 'atlasauth-fga-js',
      ...this.extraHeaders,
    };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await res.text();
    const parsed: unknown = text ? safeJson(text) : undefined;

    if (!res.ok) {
      const errors =
        parsed && typeof parsed === 'object' && Array.isArray((parsed as { errors?: unknown }).errors)
          ? ((parsed as { errors: AtlasApiErrorDetail[] }).errors)
          : [{ code: 'request_failed', message: text || res.statusText }];
      throw new AtlasFgaError(res.status, errors);
    }
    return parsed as T;
  }

  /** @internal resolve the effective store id for a store-scoped call. */
  resolveStoreId(explicit?: string): string {
    const id = explicit ?? this.defaultStoreId;
    if (!id) {
      throw new Error(
        'AtlasFga: no store id. Configure { storeId } / ATLAS_FGA_STORE_ID, or use client.store(id).',
      );
    }
    return id;
  }

  /** @internal fold the default model id into a body when it has none. */
  withModel<T extends { authorization_model_id?: string }>(body: T): T {
    if (body.authorization_model_id === undefined && this.defaultModelId !== undefined) {
      return { ...body, authorization_model_id: this.defaultModelId };
    }
    return body;
  }

  /* ---- store-scoped operations (use the default store) ---- */

  /** Resolve a single access question. */
  async check(body: FgaCheckBody, storeId?: string): Promise<FgaCheckResult> {
    return this.request('POST', `/v1/fga/stores/${enc(this.resolveStoreId(storeId))}/check`, this.withModel(body));
  }

  /** Write and/or delete tuples in one atomic call. */
  async write(body: FgaWriteBody, idempotencyKey?: string, storeId?: string): Promise<FgaWriteResult> {
    return this.request('POST', `/v1/fga/stores/${enc(this.resolveStoreId(storeId))}/write`, body, idempotencyKey);
  }

  /** Convenience: write a batch of tuples (no deletes). Alias of `write({ writes })`. */
  writeTuples(writes: FgaTupleKey[], idempotencyKey?: string, storeId?: string): Promise<FgaWriteResult> {
    return this.write({ writes }, idempotencyKey, storeId);
  }

  /** Convenience: delete a batch of tuples. Alias of `write({ deletes })`. */
  deleteTuples(deletes: FgaTupleKey[], idempotencyKey?: string, storeId?: string): Promise<FgaWriteResult> {
    return this.write({ deletes }, idempotencyKey, storeId);
  }

  /** List the objects of a `type` a `user` has a `relation` to. */
  async listObjects(body: FgaListObjectsBody, storeId?: string): Promise<FgaListObjectsResult> {
    return this.request('POST', `/v1/fga/stores/${enc(this.resolveStoreId(storeId))}/list-objects`, this.withModel(body));
  }

  /** Query stored tuples by any of user / relation / object. */
  async read(body: FgaReadBody = {}, storeId?: string): Promise<FgaListPage<FgaTuple>> {
    return this.request('POST', `/v1/fga/stores/${enc(this.resolveStoreId(storeId))}/read`, body);
  }

  /** Expand the full userset tree for an `object#relation`. */
  async expand(body: FgaExpandBody, storeId?: string): Promise<FgaExpandResult> {
    return this.request('POST', `/v1/fga/stores/${enc(this.resolveStoreId(storeId))}/expand`, this.withModel(body));
  }

  /** Resolve MANY access questions in one round trip (≤100). */
  async batchCheck(body: FgaBatchCheckBody, storeId?: string): Promise<FgaBatchCheckResult> {
    return this.request('POST', `/v1/fga/stores/${enc(this.resolveStoreId(storeId))}/batch-check`, this.withModel(body));
  }

  /**
   * Bind a store id for a scope of calls, OpenFGA-SDK style:
   *   fga.store('store_123').check({ user, relation, object })
   */
  store(storeId: string): BoundStore {
    return new BoundStore(this, storeId);
  }
}

/** The store-scoped operations with a fixed store id. */
export class BoundStore {
  constructor(private readonly client: AtlasFga, private readonly storeId: string) {}
  check(body: FgaCheckBody): Promise<FgaCheckResult> {
    return this.client.check(body, this.storeId);
  }
  write(body: FgaWriteBody, idempotencyKey?: string): Promise<FgaWriteResult> {
    return this.client.write(body, idempotencyKey, this.storeId);
  }
  writeTuples(writes: FgaTupleKey[], idempotencyKey?: string): Promise<FgaWriteResult> {
    return this.client.writeTuples(writes, idempotencyKey, this.storeId);
  }
  deleteTuples(deletes: FgaTupleKey[], idempotencyKey?: string): Promise<FgaWriteResult> {
    return this.client.deleteTuples(deletes, idempotencyKey, this.storeId);
  }
  listObjects(body: FgaListObjectsBody): Promise<FgaListObjectsResult> {
    return this.client.listObjects(body, this.storeId);
  }
  read(body?: FgaReadBody): Promise<FgaListPage<FgaTuple>> {
    return this.client.read(body, this.storeId);
  }
  expand(body: FgaExpandBody): Promise<FgaExpandResult> {
    return this.client.expand(body, this.storeId);
  }
  batchCheck(body: FgaBatchCheckBody): Promise<FgaBatchCheckResult> {
    return this.client.batchCheck(body, this.storeId);
  }
  models = {
    list: (): Promise<FgaListPage<FgaAuthorizationModel>> =>
      this.client.models.list(this.storeId),
    create: (body: FgaAuthorizationModelInput, idempotencyKey?: string): Promise<FgaAuthorizationModel> =>
      this.client.models.create(this.storeId, body, idempotencyKey),
    get: (modelId: string): Promise<FgaAuthorizationModel> =>
      this.client.models.get(this.storeId, modelId),
  };
}

/** Store lifecycle operations. */
export class StoresApi {
  constructor(private readonly client: AtlasFga) {}
  list(): Promise<FgaListPage<FgaStore>> {
    return this.client.request('GET', '/v1/fga/stores');
  }
  create(name: string, idempotencyKey?: string): Promise<FgaStore> {
    return this.client.request('POST', '/v1/fga/stores', { name }, idempotencyKey);
  }
  get(id: string): Promise<FgaStore> {
    return this.client.request('GET', `/v1/fga/stores/${enc(id)}`);
  }
  delete(id: string): Promise<{ object: 'fga.store'; id: string; deleted: true }> {
    return this.client.request('DELETE', `/v1/fga/stores/${enc(id)}`);
  }
}

/** Authorization-model (schema) operations. */
export class ModelsApi {
  constructor(private readonly client: AtlasFga) {}
  list(storeId: string): Promise<FgaListPage<FgaAuthorizationModel>> {
    return this.client.request('GET', `/v1/fga/stores/${enc(storeId)}/authorization-models`);
  }
  create(storeId: string, body: FgaAuthorizationModelInput, idempotencyKey?: string): Promise<FgaAuthorizationModel> {
    return this.client.request('POST', `/v1/fga/stores/${enc(storeId)}/authorization-models`, body, idempotencyKey);
  }
  get(storeId: string, modelId: string): Promise<FgaAuthorizationModel> {
    return this.client.request('GET', `/v1/fga/stores/${enc(storeId)}/authorization-models/${enc(modelId)}`);
  }
}

function enc(s: string): string {
  return encodeURIComponent(s);
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
