/* eslint-disable @typescript-eslint/no-explicit-any */
import { EmulatorError, errorResponse, type ErrorItem } from './errors';
import { createClock, type Clock } from './clock';
import { OpenApiIndex, synthesize, validate, type Obj, type Operation } from './openapi';
import { Table, newId } from './store';
import { TokenService } from './tokens';
import { WebhookService } from './webhooks';
import { ChangeFeed, type FeedResource } from './feed';
import { MessageSink } from './messages';
import { genericHandler } from './generic';
import { allHandlers, installPresenters, resetConsumers, resetSessions, resetUsage, seedAccess } from './handlers';

export interface KeyInfo {
  key: string;
  /** Null: every scope. */
  scopes: string[] | null;
}

export interface EmulatorOptions {
  /** The Atlas OpenAPI document the engine is driven by. */
  openapi: Obj;
  /** Backend API secret key(s) the engine accepts. Default one key, `sk_test_emulator`, with every scope. */
  secretKeys?: string | Array<{ key: string; scopes?: string[] }>;
  /**
   * The `iss` of every token. Defaults to a reserved `.invalid` host (RFC 2606), which no
   * production verifier is configured with; the HTTP server replaces it with its own origin.
   */
  issuer?: string;
  /** Reject unknown body fields (422 UNKNOWN_FIELD) even without `Atlas-Strict: true`. */
  strict?: boolean;
  instanceId?: string;
  /** Epoch-millisecond clock source; the engine adds `time/advance` offsets on top. */
  now?: () => number;
  /** Transport for webhook deliveries (default global fetch). */
  fetch?: typeof fetch;
  /** Delays before each webhook retry, in ms. Default `[1000, 5000, 30000]`; `[]` disables retries. */
  webhookRetryDelaysMs?: number[];
}

export interface RouteContext {
  engine: Engine;
  request: Request;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Obj;
  key: KeyInfo | null;
  op?: Operation;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (c: RouteContext) => Reply | Promise<Reply>;

export interface RouteDef {
  method: string;
  /** Express-style pattern, e.g. `/v1/users/:id`. */
  pattern: string;
  handler: Handler;
  /** No secret key required. */
  public?: boolean;
  /** Scope to enforce when the OpenAPI document does not name one for this route. */
  scope?: string;
}

interface CompiledRoute extends RouteDef {
  regex: RegExp;
  names: string[];
  statics: number;
  op?: Operation;
}

const compileRoute = (r: RouteDef): Pick<CompiledRoute, 'regex' | 'names' | 'statics'> => {
  const names: string[] = [];
  let statics = 0;
  const src = r.pattern
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        names.push(seg.slice(1));
        return '([^/]+)';
      }
      if (seg) statics++;
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    })
    .join('/');
  return { regex: new RegExp(`^${src}/?$`), names, statics };
};

export class Engine {
  readonly index: OpenApiIndex;
  readonly clock: Clock;
  readonly instanceId: string;
  readonly tokens: TokenService;
  readonly webhooks: WebhookService;
  readonly feed: ChangeFeed;
  readonly messages: MessageSink;
  readonly db: ReturnType<typeof createDb>;
  /** Tables for resources only the generic CRUD layer knows, keyed by collection path. */
  readonly generic = new Map<string, Table>();
  /** Last written body of each singleton settings route. */
  readonly singletons = new Map<string, Obj>();
  /** Current-state presenters the change feed and snapshots read through. */
  readonly presenters = new Map<FeedResource, { one(id: string): Obj | null; all(): string[] }>();
  readonly keys: KeyInfo[];
  private routes: CompiledRoute[] = [];
  private readonly idem = new Map<string, { hash: string; status: number; body: string; headers: Record<string, string> }>();

  constructor(readonly options: EmulatorOptions) {
    this.index = new OpenApiIndex(options.openapi);
    this.clock = createClock(options.now);
    this.instanceId = options.instanceId ?? 'ins_emulator';
    const keys = options.secretKeys ?? 'sk_test_emulator';
    this.keys = (typeof keys === 'string' ? [{ key: keys }] : keys).map((k) => ({ key: k.key, scopes: 'scopes' in k && k.scopes ? k.scopes : null }));
    this.db = createDb(this.clock.now);
    this.messages = new MessageSink(this.clock);
    this.tokens = new TokenService(this);
    this.webhooks = new WebhookService(this);
    this.feed = new ChangeFeed(this);
    this.register(allHandlers());
    installPresenters(this);
    seedAccess(this);
  }

  /** The issuer every token carries; settable because the HTTP server only knows its origin once listening. */
  get issuer(): string {
    return this.tokens.issuer;
  }

  register(routes: RouteDef[]): void {
    for (const r of routes) {
      const c = compileRoute(r);
      const norm = (path: string) => path.replace(/\{[^}]+\}|:[A-Za-z_]+/g, '{}');
      const op = this.index.ops.find((o) => o.method === r.method && norm(o.path) === norm(r.pattern));
      this.routes.push({ ...r, ...c, op });
    }
    this.routes.sort((a, b) => b.statics - a.statics);
  }

  /** Overlay values onto the minimal valid object for a named schema, so required fields are always present. */
  shape(schemaName: string, overlay: Obj): Obj {
    const base = this.index.schemaByName(schemaName);
    const synth = base ? synthesize(this.index, base) : {};
    return { ...(synth && typeof synth === 'object' ? synth : {}), ...overlay };
  }

  /** Record a state change: emits the webhook event and, for feed resources, a change entry. */
  changed(event: { type: string; data: Obj; resource?: FeedResource; id?: string; op?: 'create' | 'update' | 'delete'; actor?: Obj | null }): void {
    if (event.resource && event.id && event.op) this.feed.append(event.resource, event.id, event.op);
    this.webhooks.emit(event.type, event.data, event.actor ?? null);
  }

  /** Wait for in-flight webhook deliveries (and their scheduled retries to finish or be cancelled). */
  async flush(): Promise<void> {
    await this.webhooks.flush();
  }

  reset(): void {
    this.db.clearAll();
    this.generic.clear();
    this.singletons.clear();
    this.idem.clear();
    this.messages.clear();
    this.feed.clear();
    this.webhooks.clear();
    this.tokens.reset();
    this.clock.reset();
    resetUsage(this);
    resetConsumers(this);
    resetSessions(this);
    seedAccess(this);
  }

  async close(): Promise<void> {
    await this.webhooks.close();
  }

  private authenticate(request: Request): KeyInfo {
    const h = request.headers.get('authorization');
    const m = /^Bearer\s+(.+)$/i.exec(h ?? '');
    if (!m?.[1]) throw new EmulatorError('UNAUTHENTICATED', 'Send the instance secret key as `Authorization: Bearer sk_...`.');
    const found = this.keys.find((k) => k.key === m[1]);
    if (!found) throw new EmulatorError('INVALID_KEY', 'The secret key is not valid for this instance.');
    return found;
  }

  async handle(request: Request): Promise<Response> {
    try {
      return await this.dispatch(request);
    } catch (err) {
      if (err instanceof EmulatorError) return errorResponse(err);
      return Response.json({ errors: [{ code: 'INTERNAL_ERROR', message: String((err as Error)?.message ?? err) }] satisfies ErrorItem[] }, { status: 500 });
    }
  }

  private async dispatch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const path = url.pathname.replace(/\/+$/, '') || '/';

    let route: CompiledRoute | undefined;
    let params: Record<string, string> = {};
    for (const r of this.routes) {
      if (r.method !== method) continue;
      const m = r.regex.exec(path);
      if (!m) continue;
      route = r;
      r.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1] ?? '')));
      break;
    }
    let op = route?.op;
    let handler: Handler | undefined = route?.handler;
    let isPublic = route?.public === true;
    if (!route) {
      const hit = this.index.match(method, path);
      if (hit) {
        op = hit.op;
        params = hit.params;
        handler = (c) => genericHandler(c);
        isPublic = !hit.op.needsSecretKey;
      }
    }
    if (!handler) {
      const allowed = [...new Set([...this.routes.filter((r) => r.regex.test(path)).map((r) => r.method), ...this.index.methodsFor(path)])];
      throw new EmulatorError('ROUTE_NOT_FOUND', `No ${method} ${path} in this API.`, undefined, allowed.length ? { allowed_methods: allowed } : {});
    }

    let key: KeyInfo | null = null;
    if (!isPublic) {
      key = this.authenticate(request);
      const scope = op?.scope ?? route?.scope;
      if (scope && key.scopes && !key.scopes.includes(scope) && !key.scopes.includes('*')) {
        throw new EmulatorError('SCOPE_MISSING', `This key lacks the \`${scope}\` scope.`, undefined, { meta: { required_scope: scope } });
      }
    }

    let body: Obj = {};
    let raw = '';
    if (method !== 'GET' && method !== 'DELETE') {
      raw = await request.text();
      if (raw.trim()) {
        try {
          const parsed = JSON.parse(raw);
          if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
          body = parsed;
        } catch {
          throw new EmulatorError('VALIDATION_FAILED', 'The request body must be a JSON object.');
        }
      } else if (op?.requestRequired) throw new EmulatorError('VALIDATION_FAILED', 'A JSON body is required.');
    }

    const unknown: string[] = [];
    if (op?.requestSchema && raw.trim()) {
      const v = validate(this.index, op.requestSchema, body);
      const first = v.violations[0];
      if (first) throw new EmulatorError('VALIDATION_FAILED', first.message, first.param);
      unknown.push(...v.unknown);
    } else if (op?.requestSchema && op.requestRequired) {
      const v = validate(this.index, op.requestSchema, body);
      const first = v.violations[0];
      if (first) throw new EmulatorError('VALIDATION_FAILED', first.message, first.param);
    }
    const strict = this.options.strict === true || request.headers.get('atlas-strict') === 'true';
    if (unknown.length && strict) throw new EmulatorError('UNKNOWN_FIELD', `Unknown field: ${unknown[0]}.`, unknown[0]);

    const idemKey = method === 'POST' ? request.headers.get('idempotency-key') : null;
    const idemId = idemKey ? `${key?.key ?? ''}|${path}|${idemKey}` : null;
    if (idemId) {
      const seen = this.idem.get(idemId);
      if (seen) {
        if (seen.hash !== raw) throw new EmulatorError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used with a different request body.');
        return new Response(seen.body || null, { status: seen.status, headers: { ...seen.headers, 'idempotent-replayed': 'true' } });
      }
    }

    const reply = await handler({ engine: this, request, params, query: url.searchParams, body, key, op });
    // A handler says "success" with 200 or 201; the document decides which one (a create is 201 only where the API says so).
    const status = op && (reply.status === undefined || reply.status === 200 || reply.status === 201) ? op.successStatus : (reply.status ?? 200);
    const headers: Record<string, string> = { ...(reply.headers ?? {}) };
    if (unknown.length) headers['Atlas-Unknown-Fields'] = unknown.join(',');
    let text = '';
    if (reply.body !== undefined && status !== 204) {
      text = JSON.stringify(reply.body);
      headers['content-type'] = 'application/json';
    }
    if (idemId && status < 500) this.idem.set(idemId, { hash: raw, status, body: text, headers });
    return new Response(status === 204 ? null : text || null, { status, headers });
  }
}

function createDb(now: () => number) {
  const t = <T extends Obj = Obj>(name: string, prefix: string) => new Table<T & { id: string }>(name, now, prefix);
  const tables = {
    users: t('users', 'user'),
    organizations: t('organizations', 'org'),
    memberships: t('memberships', 'orgmem'),
    invitations: t('invitations', 'inv'),
    orgInvitations: t('org_invitations', 'orginv'),
    roles: t('roles', 'role'),
    permissions: t('permissions', 'perm'),
    apiKeys: t('api_keys', 'apikey'),
    machines: t('machines', 'mch'),
    grants: t('grants', 'mgrant'),
    endpoints: t('webhook_endpoints', 'whep'),
    sessions: t('sessions', 'sess'),
    jwtTemplates: t('jwt_templates', 'jwtt'),
  };
  return { ...tables, clearAll: () => Object.values(tables).forEach((x) => x.clear()), newId: (p: string) => newId(p, now()) };
}

export function createEmulatorEngine(options: EmulatorOptions): Engine {
  return new Engine(options);
}
