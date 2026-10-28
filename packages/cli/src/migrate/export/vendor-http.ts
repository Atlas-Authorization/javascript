/**
 * The HTTP side of `atlas migrate export <vendor>`: calls the OLD vendor's
 * management API from the owner's machine, with the owner's vendor
 * credentials. Nothing here talks to Atlas, and no vendor credential is ever
 * written into a bundle or sent anywhere but the vendor.
 *
 * Shared by every vendor exporter: JSON requests, a bounded retry on 429 and
 * 5xx that honours `Retry-After` (and the `X-RateLimit-Reset` epoch some
 * vendors send instead), and errors that name the call without echoing a
 * credential.
 */

export class VendorApiError extends Error {
  constructor(
    readonly vendor: string,
    readonly status: number,
    readonly path: string,
    detail: string,
  ) {
    super(`${vendor} API ${status} on ${path}${detail ? `: ${detail}` : ''}`);
  }
}

export interface VendorHttpOptions {
  vendor: string;
  baseUrl: string;
  /** Headers on every call (the authorization header lives here, never in a URL). */
  headers?: Record<string, string> | (() => Promise<Record<string, string>> | Record<string, string>);
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Attempts per call on 429/5xx, the first included. */
  attempts?: number;
  now?: () => number;
}

export interface VendorResponse<T> {
  status: number;
  body: T;
  headers: Headers;
}

const MAX_WAIT_MS = 60_000;

export class VendorHttp {
  constructor(private readonly o: VendorHttpOptions) {}

  get vendor(): string {
    return this.o.vendor;
  }

  url(path: string): string {
    return /^https:\/\//.test(path) ? path : `${this.o.baseUrl.replace(/\/+$/, '')}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  async get<T>(path: string): Promise<VendorResponse<T>> {
    return this.request<T>('GET', path);
  }

  async post<T>(path: string, body: unknown): Promise<VendorResponse<T>> {
    return this.request<T>('POST', path, body);
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<VendorResponse<T>> {
    const fetchImpl = this.o.fetchImpl ?? fetch;
    const sleep = this.o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const attempts = Math.max(1, this.o.attempts ?? 5);
    const display = path.split('?')[0]!.replace(/^https:\/\/[^/]+/, '');
    for (let attempt = 1; ; attempt++) {
      const extra = typeof this.o.headers === 'function' ? await this.o.headers() : this.o.headers;
      const headers: Record<string, string> = { accept: 'application/json', ...extra };
      if (body !== undefined) headers['content-type'] = 'application/json';
      let res: Response;
      try {
        res = await fetchImpl(this.url(path), {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (err) {
        if (attempt < attempts) {
          await sleep(backoff(attempt));
          continue;
        }
        throw new VendorApiError(this.o.vendor, 0, display, err instanceof Error ? err.message : String(err));
      }
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(this.waitFor(res, attempt));
        continue;
      }
      const text = await res.text();
      let parsed: unknown = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = text;
        }
      }
      if (res.status < 200 || res.status >= 300) {
        throw new VendorApiError(this.o.vendor, res.status, display, errorDetail(parsed));
      }
      return { status: res.status, body: parsed as T, headers: res.headers };
    }
  }

  private waitFor(res: Response, attempt: number): number {
    const retryAfter = res.headers.get('retry-after');
    if (retryAfter) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs)) return Math.min(Math.max(secs * 1000, 0), MAX_WAIT_MS);
      const at = Date.parse(retryAfter);
      if (Number.isFinite(at)) return Math.min(Math.max(at - this.now(), 0), MAX_WAIT_MS);
    }
    const reset = Number(res.headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 1e9) {
      return Math.min(Math.max(reset * 1000 - this.now(), 250), MAX_WAIT_MS);
    }
    return backoff(attempt);
  }

  private now(): number {
    return (this.o.now ?? Date.now)();
  }
}

function backoff(attempt: number): number {
  return Math.min(500 * 2 ** (attempt - 1), MAX_WAIT_MS);
}

/** A short, credential-free description of a vendor error body. */
function errorDetail(body: unknown): string {
  if (typeof body === 'string') return body.slice(0, 200);
  if (!body || typeof body !== 'object') return '';
  const b = body as Record<string, unknown>;
  const first = Array.isArray(b.errors) ? (b.errors[0] as Record<string, unknown> | undefined) : undefined;
  const pick = [b.message, b.error_description, b.errorSummary, b.errorDescription, first?.long_message, first?.message, b.error, b.errorCode];
  const found = pick.find((v) => typeof v === 'string' && v);
  return typeof found === 'string' ? found.slice(0, 200) : '';
}

/** The `rel="next"` URL of an RFC 8288 `Link` header (Okta's pagination). */
export function nextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;\s*rel="?next"?/.exec(part.trim());
    if (m) return m[1]!;
  }
  return null;
}
