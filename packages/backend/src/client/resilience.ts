/**
 * Status-aware retries and optional OpenTelemetry for the request core.
 *
 * OpenTelemetry is opt-in and never imported unless asked for: with `otel`
 * unset the client does no extra work at all, and `@opentelemetry/api` is an
 * optional peer dependency resolved lazily the first time it is needed.
 */

export interface RetryOptions {
  /** Extra attempts after the first. Default 2. `0` turns retries off. */
  maxRetries?: number;
  /** First backoff when the server sent no `Retry-After`; doubles per attempt, with full jitter. Default 250. */
  baseDelayMs?: number;
  /** Longest wait between attempts. A `Retry-After` above this is not waited for: the error is returned. Default 30000. */
  maxDelayMs?: number;
  /** Replace the wait, for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface ResolvedRetry {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  sleep: (ms: number) => Promise<void>;
}

export function resolveRetry(retry: false | RetryOptions | undefined): ResolvedRetry {
  const o = retry === false ? { maxRetries: 0 } : (retry ?? {});
  return {
    maxRetries: Math.max(0, Math.floor(o.maxRetries ?? 2)),
    baseDelayMs: (o as RetryOptions).baseDelayMs ?? 250,
    maxDelayMs: (o as RetryOptions).maxDelayMs ?? 30_000,
    sleep: (o as RetryOptions).sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
  };
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. `undefined` when absent or unreadable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? undefined : Math.max(0, at - now);
}

/**
 * Whether to retry a failed response and how long to wait first (`undefined` = do not retry).
 * 429 is retried for every method (the request was refused before it ran); 503 only when a
 * repeat is safe: GET, PUT, DELETE, or a write carrying an idempotency key.
 */
export function retryDelay(
  policy: ResolvedRetry,
  attempt: number,
  status: number,
  method: string,
  hasIdempotencyKey: boolean,
  retryAfterHeader: string | null | undefined,
  random: () => number = Math.random,
): number | undefined {
  if (attempt >= policy.maxRetries) return undefined;
  const safe = method === 'GET' || method === 'PUT' || method === 'DELETE' || hasIdempotencyKey;
  if (!(status === 429 || (status === 503 && safe))) return undefined;
  const asked = parseRetryAfter(retryAfterHeader);
  if (asked !== undefined) return asked > policy.maxDelayMs ? undefined : asked;
  return Math.min(policy.maxDelayMs, Math.floor(random() * policy.baseDelayMs * 2 ** attempt));
}

// ---- OpenTelemetry (structural types: no dependency on @opentelemetry/api) ----

export interface OtelSpanLike {
  setAttribute(key: string, value: string | number | boolean): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException?(error: unknown): unknown;
  end(): void;
}
export interface OtelTracerLike {
  startSpan(name: string, options?: { attributes?: Record<string, string | number | boolean>; kind?: number }): OtelSpanLike;
}
export interface OtelMeterLike {
  createCounter(name: string, options?: { description?: string; unit?: string }): { add(value: number, attributes?: Record<string, string | number | boolean>): void };
  createHistogram(name: string, options?: { description?: string; unit?: string }): { record(value: number, attributes?: Record<string, string | number | boolean>): void };
}

/** `true` resolves the global tracer and meter from `@opentelemetry/api` (when installed); or pass your own. */
export type OtelOption = boolean | { tracer?: OtelTracerLike; meter?: OtelMeterLike };

export interface Instrumentation {
  /** Run one logical request (all retries) inside a client span. */
  start(method: string, path: string): Promise<RequestObserver>;
}

export interface RequestObserver {
  retry(status: number, delayMs: number): void;
  finish(result: { status?: number; error?: unknown }): void;
}

const SPAN_KIND_CLIENT = 2;
const SPAN_STATUS_ERROR = 2;
const SPAN_STATUS_OK = 1;

export function createInstrumentation(option: OtelOption | undefined): Instrumentation | undefined {
  if (!option) return undefined;
  let ready: Promise<{ tracer?: OtelTracerLike; requests?: ReturnType<OtelMeterLike['createCounter']>; retries?: ReturnType<OtelMeterLike['createCounter']>; duration?: ReturnType<OtelMeterLike['createHistogram']> }> | undefined;
  const resolve = () =>
    (ready ??= (async () => {
      let tracer = typeof option === 'object' ? option.tracer : undefined;
      let meter = typeof option === 'object' ? option.meter : undefined;
      if (!tracer || !meter) {
        try {
          // A variable specifier keeps bundlers and the type checker from requiring the optional peer.
          const name = '@opentelemetry/api';
          const api = (await import(/* @vite-ignore */ name)) as { trace: { getTracer(n: string, v?: string): OtelTracerLike }; metrics: { getMeter(n: string, v?: string): OtelMeterLike } };
          tracer ??= api.trace.getTracer('@atlasauth/backend');
          meter ??= api.metrics.getMeter('@atlasauth/backend');
        } catch {
          // Not installed: no spans, no metrics, no error.
        }
      }
      return {
        tracer,
        requests: meter?.createCounter('atlas.client.requests', { description: 'Atlas API requests' }),
        retries: meter?.createCounter('atlas.client.retries', { description: 'Atlas API retries (429/503)' }),
        duration: meter?.createHistogram('atlas.client.request.duration', { description: 'Atlas API request duration', unit: 'ms' }),
      };
    })());

  return {
    async start(method, path) {
      const o = await resolve();
      const began = Date.now();
      const route = path.replace(/\/[A-Za-z]+_[A-Za-z0-9]{6,}(?=\/|$)/g, '/{id}'); // low-cardinality route for metrics
      const span = o.tracer?.startSpan(`atlas ${method} ${route}`, {
        kind: SPAN_KIND_CLIENT,
        attributes: { 'http.request.method': method, 'url.path': path, 'rpc.system': 'atlas-backend-api' },
      });
      let retried = 0;
      return {
        retry(status, delayMs) {
          retried++;
          o.retries?.add(1, { 'http.request.method': method, 'http.response.status_code': status });
          span?.setAttribute('atlas.retry_count', retried);
          span?.setAttribute('atlas.retry_delay_ms', delayMs);
        },
        finish({ status, error }) {
          const attrs = { 'http.request.method': method, 'http.route': route, ...(status ? { 'http.response.status_code': status } : {}) };
          o.requests?.add(1, attrs);
          o.duration?.record(Date.now() - began, attrs);
          if (status !== undefined) span?.setAttribute('http.response.status_code', status);
          if (error !== undefined || (status !== undefined && status >= 400)) {
            if (error !== undefined) span?.recordException?.(error);
            span?.setStatus({ code: SPAN_STATUS_ERROR, message: error instanceof Error ? error.message : undefined });
          } else {
            span?.setStatus({ code: SPAN_STATUS_OK });
          }
          span?.end();
        },
      };
    },
  };
}
