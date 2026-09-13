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
   * Base URL of the instance's Backend API, e.g. `https://api.atlas.dev`. The
   * `/v1/...` path is appended by each method. Trailing slashes are tolerated.
   */
  apiUrl?: string;
  /** Injectable `fetch`, for tests and non-global-fetch runtimes. */
  fetch?: typeof fetch;
}

/** The default BAPI origin, overridable per instance via `apiUrl`. */
export const DEFAULT_API_URL = 'https://api.atlas.dev';

export type QueryValue = string | number | boolean | undefined | null;
export type QueryParams = Record<string, QueryValue | QueryValue[]>;

export interface RequestOptions {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** Path beginning with `/v1/...`; already interpolated (no `:params`). */
  path: string;
  query?: QueryParams;
  /** JSON body; omitted entirely when undefined. */
  body?: unknown;
  /** Idempotency-Key header (§9.1), when a caller supplies one. */
  idempotencyKey?: string;
  /** When true, the raw text body is returned instead of parsed JSON (SAML XML). */
  raw?: boolean;
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
      authorization: `Bearer ${config.secretKey}`,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(options.body);
    }
    if (options.idempotencyKey) {
      headers['idempotency-key'] = options.idempotencyKey;
    }

    const response = await fetchImpl(url, { method: options.method, headers, body });

    if (!response.ok) {
      throw await toApiError(response);
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
