import { AtlasApiError, type AtlasErrorItem } from './error';

/**
 * The shared HTTP core every resource namespace calls. One place decides how a
 * BAPI request is authenticated, serialized, and how a failure becomes an
 * {@link AtlasApiError} — so a namespace method is a one-liner naming a method,
 * a path, and its shapes.
 *
 * Deliberately built on nothing but `fetch`. `@atlasauth/backend` verifies tokens
 * on customers' hot paths — Node servers, edge workers, serverless — and a
 * management client that dragged in a Node-only HTTP stack would not run in
 * half of them. `fetch` is the one primitive present everywhere (Node 18+,
 * Deno, Bun, browsers, edge) and is injectable so tests need no network.
 */
export interface AtlasClientConfig {
  /**
   * The instance secret key (`sk_...`). Sent as `Authorization: Bearer <key>`
   * on every request and never logged, never placed in a URL.
   */
  secretKey: string;
  /**
   * Base URL of the instance's Backend API, e.g. `https://api.atlasauth.net`. The
   * `/v1/...` path is appended by each method. Trailing slashes are tolerated.
   */
  apiUrl?: string;
  /** Injectable `fetch`, for tests and non-global-fetch runtimes. */
  fetch?: typeof fetch;
  /**
   * Strict request bodies. `true` sends `Atlas-Strict: true` on every write, so
   * a body field the endpoint does not accept is refused with
   * `422 UNKNOWN_FIELD` (before anything changes) instead of being ignored.
   * `false` sends `Atlas-Strict: false`, opting out of an instance-wide strict
   * default. Unset sends nothing and the instance setting applies. Override it
   * for a single call with `client.withOptions({ strict })`.
   */
  strict?: boolean;
  /**
   * Called when a write succeeded but Atlas ignored some body fields (the
   * `Atlas-Unknown-Fields` response header) — usually a typo or a field from a
   * newer API version. Not called in strict mode, where the write fails instead.
   */
  onUnknownFields?: (event: UnknownFieldsEvent) => void;
}

/** What {@link AtlasClientConfig.onUnknownFields} receives. */
export interface UnknownFieldsEvent {
  method: RequestOptions['method'];
  /** The request path, e.g. `/v1/users/user_123`. */
  path: string;
  /** Every ignored field; nested fields as `parent.child`. */
  fields: string[];
}

/** Per-client settings `withOptions` can override. */
export type AtlasRequestSettings = Pick<AtlasClientConfig, 'strict' | 'onUnknownFields'>;

/** A raw (non-JSON) request body, e.g. image bytes for a design-asset upload. */
export interface RawBody {
  data: Blob | ArrayBuffer | ArrayBufferView;
  /** The body's media type, e.g. `image/png`. Defaults to a Blob's own `type`. */
  contentType?: string;
}

/** The default BAPI origin, overridable per instance via `apiUrl`. */
export const DEFAULT_API_URL = 'https://api.atlasauth.net';

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path beginning with `/v1/...`; already interpolated (no `:params`). */
  path: string;
  query?: QueryParams;
  /** JSON body; omitted entirely when undefined. */
  body?: unknown;
  /** A raw body sent as-is with its own content type (instead of `body`). */
  rawBody?: RawBody;
  /** Idempotency-Key header (§9.1), when a caller supplies one. */
  idempotencyKey?: string;
  /** When true, the raw text body is returned instead of parsed JSON (SAML XML). */
  raw?: boolean;
  /** Per-request override of {@link AtlasClientConfig.strict}. */
  strict?: boolean;
}

/** Serialize a query object to a string, dropping null/undefined, spreading arrays. */
export function serializeQuery(query: QueryParams | undefined): string {
  if (!query) return '';
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (v === undefined || v === null) continue;
      parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
    }
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Percent-encode a single path segment (an id, slug, provider name). */
export function enc(segment: string): string {
  return encodeURIComponent(segment);
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}${path.startsWith('/') ? path : `/${path}`}`;
}

/**
 * The bound request function each namespace receives. Resolves the config once
 * (base URL, fetch impl) so per-call sites stay declarative.
 */
export type RequestFn = <T>(options: RequestOptions) => Promise<T>;

export function createRequest(config: AtlasClientConfig): RequestFn {
  if (!config.secretKey) {
    throw new Error('createAtlasClient requires a secretKey.');
  }
  return createKeyedRequest(config.secretKey, config);
}

/** Settings shared by every keyed client (secret key or platform key). */
export interface KeyedRequestConfig extends AtlasRequestSettings {
  apiUrl?: string;
  fetch?: typeof fetch;
}

/**
 * The request core for any bearer key: the secret key (`sk_...`) of the
 * management client or the platform key (`psk_...`) of the platform client.
 */
export function createKeyedRequest(key: string, config: KeyedRequestConfig): RequestFn {
  const base = config.apiUrl ?? DEFAULT_API_URL;
  const fetchImpl = config.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error(
      'No fetch implementation found. Pass { fetch } to createAtlasClient on a runtime without a global fetch.',
    );
  }

  return async function request<T>(options: RequestOptions): Promise<T> {
    const url = joinUrl(base, options.path) + serializeQuery(options.query);

    const headers: Record<string, string> = {
      authorization: `Bearer ${key}`,
      accept: 'application/json',
    };
    let body: RequestInit['body'];
    if (options.rawBody !== undefined) {
      const { data, contentType } = options.rawBody;
      const type =
        contentType ?? (typeof Blob !== 'undefined' && data instanceof Blob ? data.type : '');
      if (!type) {
        throw new Error('A raw upload needs a contentType (for example image/png).');
      }
      headers['content-type'] = type;
      body = data as RequestInit['body'];
    } else if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey) {
      headers['idempotency-key'] = options.idempotencyKey;
    }
    const strict = options.strict ?? config.strict;
    if (strict !== undefined && options.method !== 'GET') {
      headers['atlas-strict'] = strict ? 'true' : 'false';
    }

    const response = await fetchImpl(url, { method: options.method, headers, body });

    if (!response.ok) {
      throw await toApiError(response);
    }

    if (config.onUnknownFields) {
      const ignored = response.headers?.get?.('atlas-unknown-fields');
      if (ignored) {
        const fields = ignored
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean);
        if (fields.length) {
          config.onUnknownFields({ method: options.method, path: options.path, fields });
        }
      }
    }

    // 204 and other empty bodies: nothing to parse.
    if (response.status === 204) return undefined as T;

    if (options.raw) {
      return (await response.text()) as unknown as T;
    }

    const text = await response.text();
    if (!text) return undefined as T;
    return JSON.parse(text) as T;
  };
}

async function toApiError(response: Response): Promise<AtlasApiError> {
  let errors: AtlasErrorItem[] = [];
  let message: string | undefined;
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      const parsed = JSON.parse(text) as { errors?: AtlasErrorItem[] };
      if (Array.isArray(parsed.errors) && parsed.errors.length) {
        errors = parsed.errors;
      } else {
        message = text.slice(0, 500);
      }
    } catch {
      // Non-JSON error body (e.g. an upstream proxy): keep it as the message.
      message = text.slice(0, 500);
    }
  }
  if (!errors.length) {
    errors = [
      {
        code: 'UNKNOWN',
        message: message ?? `Atlas API request failed with status ${response.status}`,
      },
    ];
  }
  return new AtlasApiError(response.status, errors);
}
