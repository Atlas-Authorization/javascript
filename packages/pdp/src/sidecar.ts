import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PdpError, type LocalPdp } from './pdp';
import type { AbacRequest } from '../../core/src/abac/policy-language';

const MAX_BODY = 1024 * 1024;

const pascal = (s: unknown) => (typeof s === 'string' && s ? s.replace(/(^|[_\-\s])(\w)/g, (_, __, c: string) => c.toUpperCase()) : s);
type Part = Record<string, unknown> | undefined;
const entity = (p: Part) => (p ? { type: pascal(p.type) as string, id: p.id as string, attributes: p.properties as Record<string, unknown> | undefined } : undefined);

/** AuthZEN subject/resource/action/context to the engine's request (same mapping as the Atlas API). */
export function authzenToRequest(defaults: Record<string, unknown>, own: Record<string, unknown>): AbacRequest {
  const subject = (own.subject ?? defaults.subject) as Part;
  const resource = (own.resource ?? defaults.resource) as Part;
  const action = (own.action ?? defaults.action) as Part;
  if (!subject || !resource || !action) throw new HttpError(400, 'subject, resource and action are required.');
  const principal = entity(subject)!;
  const res = entity(resource)!;
  if (typeof principal.id !== 'string' || typeof res.id !== 'string' || typeof action.name !== 'string') throw new HttpError(400, 'subject.id, resource.id and action.name must be strings.');
  return {
    principal,
    resource: res,
    action: { id: action.name },
    context: { ...((defaults.context as object) ?? {}), ...((own.context as object) ?? {}), ...(action.properties ? { action: action.properties } : {}) },
  };
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large.');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Body must be a JSON object.');
  }
}

export interface SidecarOptions {
  pdp: LocalPdp;
  /** Require `Authorization: Bearer <token>` on every call except /healthz. */
  token?: string;
}

const send = (res: ServerResponse, status: number, body: unknown) => {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
};

/**
 * A localhost HTTP PDP: AuthZEN evaluation(s), an ABAC authorize call and OpenFGA-shaped check / list-objects
 * per bundle store. Bind it to 127.0.0.1 (the CLI default) and set a token if anything else can reach the port.
 */
export function createSidecar(o: SidecarOptions): Server {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      if (req.method === 'GET' && path === '/healthz') return send(res, o.pdp.revision ? 200 : 503, { status: o.pdp.revision ? 'ok' : 'loading', ...o.pdp.status() });
      if (o.token) {
        const got = String(req.headers.authorization ?? '');
        const want = `Bearer ${o.token}`;
        // constant-time compare
        let diff = got.length ^ want.length;
        for (let i = 0; i < want.length; i++) diff |= (got.charCodeAt(i) || 0) ^ want.charCodeAt(i);
        if (diff !== 0) return send(res, 401, { errors: [{ code: 'unauthorized', message: 'Missing or invalid token.' }] });
      }
      if (req.method === 'GET' && path === '/.well-known/authzen-configuration') {
        const host = req.headers.host ?? 'localhost';
        return send(res, 200, { policy_decision_point: `http://${host}`, access_evaluation_endpoint: `http://${host}/access/v1/evaluation`, access_evaluations_endpoint: `http://${host}/access/v1/evaluations` });
      }
      if (req.method !== 'POST') return send(res, 404, { errors: [{ code: 'not_found', message: 'Unknown route.' }] });
      const body = await readJson(req);

      if (path === '/access/v1/evaluation') {
        const r = await o.pdp.authorize(authzenToRequest({}, body));
        return send(res, 200, { decision: r.decision === 'allow', context: { reasons: r.reasons, revision: r.revision } });
      }
      if (path === '/access/v1/evaluations') {
        const items = Array.isArray(body.evaluations) ? (body.evaluations as Record<string, unknown>[]) : null;
        if (!items) return send(res, 200, { decision: (await o.pdp.authorize(authzenToRequest({}, body))).decision === 'allow' });
        if (items.length > 100) throw new HttpError(400, 'At most 100 evaluations per request.');
        const semantic = ((body.options as Record<string, unknown> | undefined)?.evaluations_semantic ?? 'execute_all') as string;
        if (!['execute_all', 'deny_on_first_deny', 'permit_on_first_permit'].includes(semantic)) throw new HttpError(400, 'Unknown evaluations_semantic.');
        const out: Array<{ decision: boolean }> = [];
        for (const item of items) {
          const allowed = (await o.pdp.authorize(authzenToRequest(body, item))).decision === 'allow';
          out.push({ decision: allowed });
          if ((semantic === 'deny_on_first_deny' && !allowed) || (semantic === 'permit_on_first_permit' && allowed)) break;
        }
        return send(res, 200, { evaluations: out });
      }
      if (path === '/v1/abac/authorize') {
        const principal = body.principal as AbacRequest['principal'];
        const resource = body.resource as AbacRequest['resource'];
        const action = typeof body.action === 'string' ? body.action : (body.action as { id?: string } | undefined)?.id;
        if (!principal?.type || !principal.id || !resource?.type || !resource.id || !action) throw new HttpError(400, 'principal, action and resource are required.');
        const r = await o.pdp.authorize({ principal, resource, action: { id: action }, context: body.context as Record<string, unknown> | undefined, entities: body.entities as AbacRequest['entities'] });
        return send(res, 200, r);
      }
      const m = /^\/stores\/([^/]+)\/(check|list-objects)$/.exec(path);
      if (m) {
        const store = decodeURIComponent(m[1]!);
        const tupleList = (raw: unknown) => ((raw && typeof raw === 'object' && 'tuple_keys' in raw ? (raw as { tuple_keys: unknown }).tuple_keys : raw) ?? []) as never[];
        if (m[2] === 'check') {
          const k = (body.tuple_key ?? {}) as Record<string, unknown>;
          if (typeof k.user !== 'string' || typeof k.relation !== 'string' || typeof k.object !== 'string') throw new HttpError(400, 'tuple_key needs user, relation and object.');
          const allowed = await o.pdp.check(store, { user: k.user, relation: k.relation, object: k.object, contextualTuples: tupleList(body.contextual_tuples), context: body.context as Record<string, unknown> | undefined });
          return send(res, 200, { allowed });
        }
        if (typeof body.user !== 'string' || typeof body.relation !== 'string' || typeof body.type !== 'string') throw new HttpError(400, 'user, relation and type are required.');
        const objects = await o.pdp.listObjects(store, { user: body.user, relation: body.relation, type: body.type, contextualTuples: tupleList(body.contextual_tuples), context: body.context as Record<string, unknown> | undefined });
        return send(res, 200, { objects: objects.map((id) => `${body.type}:${id}`) });
      }
      return send(res, 404, { errors: [{ code: 'not_found', message: 'Unknown route.' }] });
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { errors: [{ code: 'invalid_request', message: err.message }] });
      if (err instanceof PdpError) return send(res, err.code === 'not_loaded' ? 503 : 404, { errors: [{ code: err.code, message: err.message }] });
      // Anything else is a malformed tuple/request from the caller; never a fail-open.
      return send(res, 400, { errors: [{ code: 'invalid_request', message: err instanceof Error ? err.message : 'Bad request.' }] });
    }
  });
}
