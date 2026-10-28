import { AtlasApiError, type AtlasErrorItem } from '@atlasauth/backend';

/**
 * A tiny, management-API HTTP seam used only by `atlas config`. The typed
 * `@atlasauth/backend` client deliberately exposes a NARROW, hand-curated
 * surface (and omits several config-only endpoints — redirect URLs, the org
 * settings schema, notification templates, webhook PATCH, …). The deploy tool
 * instead speaks to the raw `/v1/...` endpoints the Terraform provider already
 * drives, so it needs a thin verb-per-method client over the same credential.
 *
 * It reuses the backend's {@link AtlasApiError} so a failure is formatted by the
 * CLI's one error reporter exactly like any other API error, and it is a plain
 * interface so tests inject an in-memory fake with no network.
 */
export interface ConfigHttp {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  put<T>(path: string, body: unknown): Promise<T>;
  patch<T>(path: string, body: unknown): Promise<T>;
  delete(path: string, body?: unknown): Promise<void>;
}

/** The production {@link ConfigHttp}: Bearer-authed `fetch`, mirroring the backend client. */
export function createConfigHttp(opts: {
  secretKey: string;
  apiUrl: string;
  fetch?: typeof fetch;
  /** Extra request headers (e.g. `X-Secret-Recipient` for sealed secret delivery). */
  headers?: Record<string, string>;
}): ConfigHttp {
  const base = opts.apiUrl.replace(/\/+$/, '');
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('No fetch implementation found for the Atlas config client.');
  }

  async function send<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      ...opts.headers,
      authorization: `Bearer ${opts.secretKey}`,
      accept: 'application/json',
    };
    let payload: string | undefined;
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetchImpl(`${base}${path}`, { method, headers, body: payload });
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? (JSON.parse(text) as T) : (undefined as T));
  }

  return {
    get: (path) => send('GET', path),
    post: (path, body) => send('POST', path, body),
    put: (path, body) => send('PUT', path, body),
    patch: (path, body) => send('PATCH', path, body),
    delete: async (path, body) => {
      await send<void>('DELETE', path, body);
    },
  };
}

async function toApiError(res: Response): Promise<AtlasApiError> {
  let errors: AtlasErrorItem[] = [];
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      const parsed = JSON.parse(text) as { errors?: AtlasErrorItem[] };
      if (Array.isArray(parsed.errors) && parsed.errors.length) errors = parsed.errors;
    } catch {
      /* non-JSON body */
    }
  }
  if (!errors.length) {
    errors = [{ code: 'UNKNOWN', message: `Atlas API request failed with status ${res.status}` }];
  }
  return new AtlasApiError(res.status, errors);
}

/** True when an error is an Atlas 404 — a resource that does not (yet) exist. */
export function isNotFound(err: unknown): boolean {
  return err instanceof AtlasApiError && err.status === 404;
}
