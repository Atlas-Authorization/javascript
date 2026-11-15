/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Engine, Reply, RouteContext, RouteDef } from '../engine';
import { EmulatorError, notFound } from '../errors';
import type { Obj } from '../openapi';
import { Table } from '../store';
import { engineState } from './support';
import { audit, bad, isObj } from './emu4-shared';

/**
 * SAML HTTP-Artifact binding. Two roles share one emulator:
 *  - an identity provider for your app: `POST /v1/saml/idp/artifact` answers a SOAP ArtifactResolve with an ArtifactResponse
 *    carrying the signed-in user's Response exactly once (the artifact is 160 random bits, single use, bound to the app that was
 *    meant to receive it, valid for a minute);
 *  - a service provider for an identity provider you federate with: `GET`/`POST /v1/sso/saml/acs` takes a `SAMLart` for a sign-in
 *    this side started, claims it once, sends a back-channel ArtifactResolve and checks the answer (InResponseTo, issuer, status,
 *    exactly one Response, audience, recipient, validity window, no assertion replay) before it signs the user in.
 * Everything the emulator does on either side is driven by the helper routes under `/__emulator/saml/`.
 * shortcut: XML signatures are neither produced nor verified (the XML carries none), and the SAMLResponse of a SOAP exchange is
 * built by the emulator IdP, so signature and encryption failures cannot be reproduced.
 */
const SAMLP = 'urn:oasis:names:tc:SAML:2.0:protocol';
const SAML = 'urn:oasis:names:tc:SAML:2.0:assertion';
const SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const SOAP_NS = 'http://schemas.xmlsoap.org/soap/envelope/';
const ARTIFACT_TTL_MS = 60_000;
const ATTEMPT_TTL_MS = 10 * 60_000;
const SKEW_MS = 5 * 60_000;
const TYPE_CODE = 0x0004;

// ── a small XML reader (no DTDs, no entities beyond the five predefined) ──

interface XNode { name: string; attrs: Record<string, string>; kids: XNode[]; text: string }
const unescapeXml = (s: string): string => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const local = (n: string): string => n.slice(n.indexOf(':') + 1);

export function parseXml(src: string): XNode | null {
  if (typeof src !== 'string' || src.length > 256 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(src)) return null;
  const tok = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[([\s\S]*?)\]\]>|<\/([^\s>]+)\s*>|<([^\s/>!?]+)((?:\s+[^\s=/>]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  const root: XNode = { name: '#root', attrs: {}, kids: [], text: '' };
  const stack: XNode[] = [root];
  for (let m = tok.exec(src); m; m = tok.exec(src)) {
    const top = stack[stack.length - 1]!;
    if (m[1] !== undefined) top.text += m[1];
    else if (m[2] !== undefined) {
      if (stack.length < 2 || local(stack[stack.length - 1]!.name) !== local(m[2])) return null;
      stack.pop();
    } else if (m[3] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[4]!.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attrs[local(a[1]!)] = unescapeXml(a[2] ?? a[3] ?? '');
      const node: XNode = { name: local(m[3]), attrs, kids: [], text: '' };
      top.kids.push(node);
      if (m[5] !== '/') stack.push(node);
    } else if (m[6] !== undefined) top.text += unescapeXml(m[6]);
  }
  return stack.length === 1 && root.kids.length === 1 ? root.kids[0]! : null;
}
const kids = (n: XNode | undefined, name: string): XNode[] => (n ? n.kids.filter((k) => k.name === name) : []);
const textOf = (n: XNode | undefined): string => (n ? n.text.trim() : '');
const find = (n: XNode, name: string, out: XNode[] = []): XNode[] => {
  for (const k of n.kids) {
    if (k.name === name) out.push(k);
    find(k, name, out);
  }
  return out;
};

// ── ids, artifacts ──

const hexOf = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
const msgId = (): string => `_${hexOf(crypto.getRandomValues(new Uint8Array(16)))}`;
const sha1 = async (s: string): Promise<Uint8Array> => new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)));
const b64 = (b: Uint8Array): string => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
};
async function newArtifact(issuer: string): Promise<{ artifact: string; handle: string }> {
  const handle = crypto.getRandomValues(new Uint8Array(20));
  const head = new Uint8Array(4);
  head[0] = TYPE_CODE >> 8;
  head[1] = TYPE_CODE & 0xff;
  const bytes = new Uint8Array(44);
  bytes.set(head, 0);
  bytes.set(await sha1(issuer), 4);
  bytes.set(handle, 24);
  return { artifact: b64(bytes), handle: hexOf(handle) };
}
/** The message handle of an artifact addressed to this issuer; null when malformed, of another type or another source. */
async function readArtifact(artifact: unknown, issuer: string): Promise<string | null> {
  if (typeof artifact !== 'string' || artifact.length > 200) return null;
  const raw = unb64(artifact);
  if (!raw || raw.length !== 44 || ((raw[0]! << 8) | raw[1]!) !== TYPE_CODE) return null;
  const want = await sha1(issuer);
  return hexOf(raw.subarray(4, 24)) === hexOf(want) ? hexOf(raw.subarray(24)) : null;
}
/** Only the shape of an artifact (any source): what the SP checks before it spends a back-channel call. */
const wellFormedArtifact = (artifact: unknown): boolean => {
  if (typeof artifact !== 'string' || artifact.length > 200) return false;
  const raw = unb64(artifact);
  return !!raw && raw.length === 44 && ((raw[0]! << 8) | raw[1]!) === TYPE_CODE;
};

// ── state ──

interface Saml {
  /** Apps this emulator is the identity provider for. */
  sps: Table;
  /** Identity providers this emulator is the service provider for. */
  connections: Table;
  /** Pending artifacts: handle -> the Response XML behind it. */
  artifacts: Map<string, { sp_id: string; xml: string; expires_at: number }>;
  attempts: Table;
  consumed: Set<string>;
  tickets: Map<string, Obj>;
}
const st = engineState((e: Engine): Saml => ({ sps: new Table('saml_idp_sps', e.clock.now, 'samlsp'), connections: new Table('saml_connections', e.clock.now, 'samlc'), artifacts: new Map(), attempts: new Table('saml_attempts', e.clock.now, 'samla'), consumed: new Set(), tickets: new Map() }));

const idpEntityId = (e: Engine): string => `${e.issuer}/v1/saml/idp/metadata`;
const idpArtifactUrl = (e: Engine): string => `${e.issuer}/v1/saml/idp/artifact`;
const acsUrl = (e: Engine): string => `${e.issuer}/v1/sso/saml/acs`;
const spEntityId = (e: Engine, c: Obj): string => `${e.issuer}/v1/sso/saml/${c.id}/metadata`;
/** A connection to the emulator's own identity provider follows the issuer; any other keeps what it was given. */
const connIdp = (e: Engine, c: Obj): { entity: string; url: string | null } => (c.own_idp === true ? { entity: idpEntityId(e), url: idpArtifactUrl(e) } : { entity: c.idp_entity_id, url: c.artifact_resolution_url ?? null });
/** An app of the emulator's identity provider; one made for a connection follows the issuer. */
const spEntity = (e: Engine, s: Obj): string => (s.conn_id ? spEntityId(e, { id: s.conn_id }) : s.entity_id);
const spAcs = (e: Engine, s: Obj): string => (s.conn_id ? acsUrl(e) : s.acs_url);

const rawBodies = new WeakMap<Request, string>();
/** Called once by the engine: hands the SOAP route its raw XML body (the engine itself only reads JSON and form bodies). */
export function installSaml(e: Engine): void {
  const handle = e.handle.bind(e);
  e.handle = async (request: Request) => {
    if (request.method !== 'POST' || !/^\/v1\/saml\/idp\/artifact\/?$/.test(new URL(request.url).pathname)) return handle(request);
    const raw = await request.text();
    const headers = new Headers(request.headers);
    headers.set('content-type', 'application/json');
    const next = new Request(request.url, { method: 'POST', headers, body: '{}' });
    rawBodies.set(next, raw);
    return handle(next);
  };
}

const xmlReply = (status: number, body: string): Reply => ({ status, raw: body, headers: { 'content-type': 'text/xml; charset=utf-8', 'cache-control': 'no-store' } });
const soap = (inner: string): string => `<?xml version="1.0" encoding="UTF-8"?><soap-env:Envelope xmlns:soap-env="${SOAP_NS}"><soap-env:Body>${inner}</soap-env:Body></soap-env:Envelope>`;
const fault = (status: number, message: string): Reply => xmlReply(status, soap(`<soap-env:Fault><faultcode>soap-env:Client</faultcode><faultstring>${message.replace(/[<>&]/g, '')}</faultstring></soap-env:Fault>`));
const iso = (ms: number): string => new Date(ms).toISOString();

// ── the identity provider: a Response, an artifact for it, and the resolution service ──

function buildResponse(e: Engine, sp: Obj, input: { inResponseTo: string | null; user: Obj; email: string; attributes: Obj; destination: string; ttlMs?: number }): { xml: string; assertionId: string } {
  const now = e.clock.now();
  const respId = msgId();
  const assertionId = msgId();
  const entity = idpEntityId(e);
  const until = iso(now + (input.ttlMs ?? ARTIFACT_TTL_MS * 5));
  const irt = input.inResponseTo ? ` InResponseTo="${esc(input.inResponseTo)}"` : '';
  const attrs = Object.entries({ email: input.email, first_name: input.user.first_name ?? undefined, last_name: input.user.last_name ?? undefined, ...input.attributes })
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `<saml:Attribute Name="${esc(k)}"><saml:AttributeValue>${esc(String(v))}</saml:AttributeValue></saml:Attribute>`)
    .join('');
  const xml =
    `<samlp:Response xmlns:samlp="${SAMLP}" xmlns:saml="${SAML}" ID="${respId}" Version="2.0" IssueInstant="${iso(now)}" Destination="${esc(input.destination)}"${irt}>` +
    `<saml:Issuer>${esc(entity)}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${SUCCESS}"/></samlp:Status>` +
    `<saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${iso(now)}"><saml:Issuer>${esc(entity)}</saml:Issuer>` +
    `<saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${esc(input.email)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${until}" Recipient="${esc(input.destination)}"${irt}/></saml:SubjectConfirmation></saml:Subject>` +
    `<saml:Conditions NotBefore="${iso(now - 1000)}" NotOnOrAfter="${until}"><saml:AudienceRestriction><saml:Audience>${esc(spEntity(e, sp))}</saml:Audience></saml:AudienceRestriction></saml:Conditions>` +
    `<saml:AttributeStatement>${attrs}</saml:AttributeStatement></saml:Assertion></samlp:Response>`;
  return { xml, assertionId };
}

async function resolveArtifact(e: Engine, body: string): Promise<Reply> {
  const env = parseXml(body);
  const bodyEl = env && env.name === 'Envelope' ? kids(env, 'Body')[0] : undefined;
  const root = bodyEl && bodyEl.kids.length === 1 && bodyEl.kids[0]!.name === 'ArtifactResolve' ? bodyEl.kids[0]! : undefined;
  const id = root?.attrs.ID;
  const issuer = textOf(kids(root, 'Issuer')[0]);
  const artifact = textOf(kids(root, 'Artifact')[0]);
  if (!root || !id || !issuer || !artifact) return fault(400, 'Expected one ArtifactResolve.');
  const sp = st(e).sps.find((s) => spEntity(e, s) === issuer && s.artifact_binding === true);
  if (!sp) return fault(403, 'Unknown requester.');
  const handle = await readArtifact(artifact, idpEntityId(e));
  const pending = handle ? st(e).artifacts.get(handle) : undefined;
  if (handle) st(e).artifacts.delete(handle); // single use: spent whether or not it was valid
  const response = pending && pending.sp_id === sp.id && pending.expires_at >= e.clock.now() ? pending.xml : null;
  const rid = msgId();
  return xmlReply(200, soap(
    `<samlp:ArtifactResponse xmlns:samlp="${SAMLP}" xmlns:saml="${SAML}" ID="${rid}" Version="2.0" IssueInstant="${iso(e.clock.now())}" InResponseTo="${esc(id.replace(/[^\w.-]/g, ''))}">` +
    `<saml:Issuer>${esc(idpEntityId(e))}</saml:Issuer><samlp:Status><samlp:StatusCode Value="${SUCCESS}"/></samlp:Status>${response ?? ''}</samlp:ArtifactResponse>`,
  ));
}

// ── the service provider side ──

const generic = (param: string) => new EmulatorError('VALIDATION_FAILED', 'Could not verify that SAML sign-in.', param);

/** Why a sign-in failed goes to the audit log and the attempt, never to the browser. */
function failAttempt(e: Engine, attempt: Obj | undefined, reason: string, artifact: boolean): never {
  if (attempt) Object.assign(attempt, { status: 'failed', failure_reason: reason });
  audit(e, null, artifact ? 'sso.saml.artifact_resolve' : 'sso.saml.response', 'sso_connection', attempt?.connection_id ?? 'unknown', { outcome: 'failed', reason });
  throw generic(artifact ? 'SAMLart' : 'SAMLResponse');
}

class Reason extends Error {}

/** Send the ArtifactResolve and return the one Response inside the answer. Throws Reason(code); the code is for the audit log only. */
async function redeemArtifact(e: Engine, conn: Obj, artifact: string): Promise<string> {
  const id = msgId();
  const request = soap(`<samlp:ArtifactResolve xmlns:samlp="${SAMLP}" xmlns:saml="${SAML}" ID="${id}" Version="2.0" IssueInstant="${iso(e.clock.now())}" Destination="${esc(connIdp(e, conn).url ?? '')}"><saml:Issuer>${esc(spEntityId(e, conn))}</saml:Issuer><samlp:Artifact>${esc(artifact)}</samlp:Artifact></samlp:ArtifactResolve>`);
  let status: number;
  let text: string;
  try {
    const target = connIdp(e, conn).url!;
    if (target === idpArtifactUrl(e)) {
      const reply = await resolveArtifact(e, request);
      status = reply.status ?? 200;
      text = reply.raw ?? '';
    } else {
      const res = await (e.options.fetch ?? fetch)(target, { method: 'POST', headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: 'http://www.oasis-open.org/committees/security' }, body: request, redirect: 'manual' });
      status = res.status;
      text = await res.text();
    }
  } catch {
    throw new Reason('transport');
  }
  if (status !== 200) throw new Reason('http_status');
  const env = parseXml(text);
  if (!env) throw new Reason('malformed');
  const bodies = env.name === 'Envelope' ? kids(env, 'Body') : [];
  if (bodies.length !== 1) throw new Reason('malformed');
  const art = bodies[0]!.kids.length === 1 && bodies[0]!.kids[0]!.name === 'ArtifactResponse' ? bodies[0]!.kids[0]! : null;
  if (!art || find(env, 'ArtifactResponse').length !== 1) throw new Reason('malformed');
  if (art.attrs.InResponseTo !== id) throw new Reason('in_response_to_mismatch');
  const issuers = kids(art, 'Issuer');
  if (issuers.length !== 1 || textOf(issuers[0]) !== connIdp(e, conn).entity) throw new Reason('issuer_mismatch');
  const statuses = kids(art, 'Status');
  const codes = statuses.length === 1 ? kids(statuses[0], 'StatusCode') : [];
  if (codes.length !== 1 || codes[0]!.attrs.Value !== SUCCESS) throw new Reason('status_not_success');
  const inner = kids(art, 'Response');
  if (inner.length !== 1) throw new Reason('no_response');
  return serialize(inner[0]!);
}

function serialize(n: XNode): string {
  const attrs = Object.entries(n.attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('');
  return `<${n.name}${attrs}>${esc(n.text)}${n.kids.map(serialize).join('')}</${n.name}>`;
}

interface Identity { email: string; first_name: string | null; last_name: string | null; assertion_id: string; in_response_to: string | null }

/** The checks a SAML Response must pass before anyone is signed in. Throws Reason(code). */
function verifyResponse(e: Engine, conn: Obj, xml: string, expectedRequestId: string | null): Identity {
  const root = parseXml(xml);
  if (!root || root.name !== 'Response') throw new Reason('malformed');
  const now = e.clock.now();
  const status = kids(kids(root, 'Status')[0], 'StatusCode')[0]?.attrs.Value;
  if (status !== SUCCESS) throw new Reason('status_not_success');
  const irt = root.attrs.InResponseTo ?? null;
  if (expectedRequestId !== null && irt !== expectedRequestId) throw new Reason('in_response_to_mismatch');
  if (root.attrs.Destination && root.attrs.Destination !== acsUrl(e)) throw new Reason('destination_mismatch');
  const assertions = kids(root, 'Assertion');
  if (assertions.length !== 1) throw new Reason('assertion_count');
  const a = assertions[0]!;
  if (textOf(kids(a, 'Issuer')[0]) !== connIdp(e, conn).entity) throw new Reason('issuer_mismatch');
  const cond = kids(a, 'Conditions')[0];
  if (!cond) throw new Reason('no_conditions');
  const nb = cond.attrs.NotBefore ? Date.parse(cond.attrs.NotBefore) : null;
  const na = cond.attrs.NotOnOrAfter ? Date.parse(cond.attrs.NotOnOrAfter) : null;
  if (na === null || Number.isNaN(na) || now >= na + SKEW_MS) throw new Reason('expired');
  if (nb !== null && now < nb - SKEW_MS) throw new Reason('not_yet_valid');
  const audiences = find(cond, 'Audience').map(textOf);
  if (!audiences.includes(spEntityId(e, conn))) throw new Reason('audience_mismatch');
  const scd = find(a, 'SubjectConfirmationData')[0];
  if (!scd || (scd.attrs.Recipient && scd.attrs.Recipient !== acsUrl(e))) throw new Reason('recipient_mismatch');
  if (scd.attrs.InResponseTo && irt && scd.attrs.InResponseTo !== irt) throw new Reason('in_response_to_mismatch');
  const attrOf = (...names: string[]): string | null => {
    for (const at of find(a, 'Attribute')) if (names.includes(at.attrs.Name ?? '')) return textOf(kids(at, 'AttributeValue')[0]) || null;
    return null;
  };
  const nameId = find(a, 'NameID')[0];
  const email = (nameId?.attrs.Format?.endsWith('emailAddress') ? textOf(nameId) : null) ?? attrOf('email', 'mail', 'emailAddress');
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Reason('no_email');
  const assertionId = a.attrs.ID;
  if (!assertionId) throw new Reason('no_assertion_id');
  if (st(e).consumed.has(assertionId)) throw new Reason('replay');
  return { email: email.toLowerCase(), first_name: attrOf('first_name', 'givenName'), last_name: attrOf('last_name', 'surname', 'sn'), assertion_id: assertionId, in_response_to: irt };
}

async function internal(e: Engine, method: string, path: string, body: Obj): Promise<Obj> {
  const res = await e.handle(new Request(`http://emulator.internal${path}`, { method, headers: { authorization: `Bearer ${e.keys[0]!.key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
  return (await res.json()) as Obj;
}

async function completeSignIn(e: Engine, conn: Obj, attempt: Obj, id: Identity): Promise<void> {
  st(e).consumed.add(id.assertion_id);
  let user = e.db.users.all().find((u) => !u.deleted && (u.emails as Obj[]).some((m) => m.email_address.toLowerCase() === id.email));
  let created = false;
  if (!user) {
    if (conn.allow_sign_up === false) throw new Reason('sign_up_disabled');
    const made = await internal(e, 'POST', '/v1/users', { email_address: id.email, ...(id.first_name ? { first_name: id.first_name } : {}), ...(id.last_name ? { last_name: id.last_name } : {}) });
    user = e.db.users.get(made.id);
    created = true;
    if (!user) throw new Reason('user_create_failed');
  }
  if (user.banned) throw new Reason('user_banned');
  const session = await internal(e, 'POST', '/v1/sessions', { user_id: user.id });
  if (!session.id) throw new Reason('session_failed');
  const ticket = `tkt_${hexOf(crypto.getRandomValues(new Uint8Array(24)))}`;
  st(e).tickets.set(ticket, { attempt_id: attempt.id, session });
  Object.assign(attempt, { status: 'complete', user_id: user.id, session_id: session.id, ticket, created_user: created, completed_at: e.clock.now() });
}

const attemptView = (a: Obj): Obj => ({ object: 'saml_attempt', id: a.id, connection_id: a.connection_id, status: a.status, request_id: a.request_id, relay_state: a.relay_state, redirect_url: a.redirect_url, user_id: a.user_id ?? null, session_id: a.session_id ?? null, created_user: a.created_user ?? false, failure_reason: a.failure_reason ?? null, artifact_claimed: a.artifact_claimed === true, created_at: a.created_at, completed_at: a.completed_at ?? null });
const connView = (e: Engine, c: Obj): Obj => ({ object: 'saml_connection', id: c.id, name: c.name, idp_entity_id: connIdp(e, c).entity, artifact_resolution_url: connIdp(e, c).url, sp_entity_id: spEntityId(e, c), acs_url: acsUrl(e), allow_sign_up: c.allow_sign_up !== false, created_at: c.created_at });
const spView = (e: Engine, s: Obj): Obj => ({ object: 'saml_idp_service_provider', id: s.id, entity_id: spEntity(e, s), acs_url: spAcs(e, s), artifact_binding: s.artifact_binding === true, created_at: s.created_at });

async function handleAcs(c: RouteContext): Promise<Reply> {
  const e = c.engine;
  const get = (k: string): string | undefined => {
    const v = c.request.method === 'GET' ? c.query.get(k) : c.body[k];
    return typeof v === 'string' && v ? v : undefined;
  };
  const response = c.request.method === 'GET' ? undefined : get('SAMLResponse');
  const art = get('SAMLart');
  const relay = get('RelayState');
  if (response && art) throw bad('Send a SAMLResponse or a SAMLart, not both.', 'SAMLart');
  if (!response && !art) throw bad('Missing SAMLResponse.', 'SAMLResponse');
  const attempt = relay ? st(e).attempts.find((a) => a.relay_state === relay) : undefined;
  const now = e.clock.now();
  const redirect = (url: string, params: Record<string, string>): Reply => {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return { status: 302, headers: { location: u.toString(), 'cache-control': 'no-store' } };
  };

  // IdP-initiated: no attempt behind the RelayState. An artifact has no request to bind to, so it is refused.
  if (!attempt) {
    if (!response) throw bad('Unknown or expired sign-in link.', 'RelayState');
    const raw = (() => { try { return atob(response); } catch { return ''; } })();
    const issuer = textOf(kids(parseXml(raw) ?? undefined, 'Issuer')[0]);
    const conn = st(e).connections.find((x) => connIdp(e, x).entity === issuer);
    const shell = st(e).attempts.insert({ connection_id: conn?.id ?? 'unknown', status: 'pending', relay_state: null, request_id: null, redirect_url: null, created_at: now } as any);
    if (!conn) failAttempt(e, undefined, 'unknown_connection', false);
    try {
      await completeSignIn(e, conn, shell, verifyResponse(e, conn, raw, null));
    } catch (err) {
      failAttempt(e, shell, err instanceof Reason ? err.message : 'error', false);
    }
    audit(e, null, 'sso.saml.response', 'sso_connection', conn.id, { outcome: 'ok', initiated: 'idp' });
    return redirect(e.issuer, { __atlas_attempt: shell.id, __atlas_ticket: shell.ticket });
  }

  if (attempt.status !== 'pending' || now > attempt.created_at + ATTEMPT_TTL_MS) throw bad('Unknown or expired sign-in link.', 'RelayState');
  const conn = st(e).connections.get(attempt.connection_id);
  if (!conn) throw bad('Unknown or expired sign-in link.', 'RelayState');

  let responseXml: string;
  if (art) {
    // The handle is claimed before the back-channel call: a second use of the same artifact never reaches the IdP.
    if (attempt.artifact_claimed) throw bad('Unknown or expired sign-in link.', 'RelayState');
    attempt.artifact_claimed = true;
    if (!connIdp(e, conn).url) failAttempt(e, attempt, 'artifact_not_configured', true);
    if (!wellFormedArtifact(art)) failAttempt(e, attempt, 'malformed_artifact', true);
    try {
      responseXml = await redeemArtifact(e, conn, art);
    } catch (err) {
      failAttempt(e, attempt, err instanceof Reason ? err.message : 'transport', true);
    }
  } else {
    const raw = (() => { try { return atob(response!); } catch { return ''; } })();
    if (!raw) failAttempt(e, attempt, 'malformed', false);
    responseXml = raw;
  }
  try {
    await completeSignIn(e, conn, attempt, verifyResponse(e, conn, responseXml, attempt.request_id));
  } catch (err) {
    failAttempt(e, attempt, err instanceof Reason ? err.message : 'error', art !== undefined);
  }
  audit(e, null, art ? 'sso.saml.artifact_resolve' : 'sso.saml.response', 'sso_connection', conn.id, { outcome: 'ok', attempt_id: attempt.id });
  return redirect(attempt.redirect_url, { __atlas_attempt: attempt.id, __atlas_ticket: attempt.ticket });
}

export function samlHandlers(): RouteDef[] {
  return [
    // ── the identity provider ──
    { method: 'GET', pattern: '/v1/saml/idp/metadata', public: true, handler: (c) => {
      const e = c.engine;
      const body = `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${esc(idpEntityId(e))}"><md:IDPSSODescriptor protocolSupportEnumeration="${SAMLP}"><md:ArtifactResolutionService Binding="urn:oasis:names:tc:SAML:2.0:bindings:SOAP" Location="${esc(idpArtifactUrl(e))}" index="0" isDefault="true"/><md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${esc(`${e.issuer}/v1/saml/idp/sso`)}"/></md:IDPSSODescriptor></md:EntityDescriptor>`;
      return { raw: body, headers: { 'content-type': 'application/samlmetadata+xml; charset=utf-8', 'cache-control': 'no-store' } };
    } },
    { method: 'POST', pattern: '/v1/saml/idp/artifact', public: true, handler: (c) => {
      const raw = rawBodies.get(c.request);
      return raw === undefined || !raw.trim() ? fault(400, 'Expected one ArtifactResolve.') : resolveArtifact(c.engine, raw);
    } },
    // ── the service provider's metadata ──
    { method: 'GET', pattern: '/v1/sso/saml/:connectionId/metadata', public: true, handler: (c) => {
      const e = c.engine;
      const conn = st(e).connections.get(c.params.connectionId);
      if (!conn) throw notFound('SAML connection');
      const artifact = connIdp(e, conn).url ? `<md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Artifact" Location="${esc(acsUrl(e))}" index="2"/>` : '';
      return { raw: `<?xml version="1.0" encoding="UTF-8"?><md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${esc(spEntityId(e, conn))}"><md:SPSSODescriptor protocolSupportEnumeration="${SAMLP}"><md:AssertionConsumerService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" Location="${esc(acsUrl(e))}" index="1" isDefault="true"/>${artifact}</md:SPSSODescriptor></md:EntityDescriptor>`, headers: { 'content-type': 'application/samlmetadata+xml; charset=utf-8' } };
    } },
    { method: 'POST', pattern: '/v1/sso/saml/acs', public: true, handler: handleAcs },
    { method: 'GET', pattern: '/v1/sso/saml/acs', public: true, handler: handleAcs },

    // ── emulator helpers ──
    // POST /__emulator/saml/idp/service_providers { entity_id, acs_url, artifact_binding? }: an app the emulator IdP issues Responses for.
    { method: 'POST', pattern: '/__emulator/saml/idp/service_providers', public: true, handler: (c) => {
      const e = c.engine;
      if (typeof c.body.entity_id !== 'string' || !c.body.entity_id) throw bad('entity_id is required.', 'entity_id');
      if (typeof c.body.acs_url !== 'string' || !/^https?:\/\//.test(c.body.acs_url)) throw bad('acs_url must be an http(s) URL.', 'acs_url');
      if (c.body.artifact_binding !== undefined && typeof c.body.artifact_binding !== 'boolean') throw bad('artifact_binding is a boolean.', 'artifact_binding');
      if (st(e).sps.find((s) => spEntity(e, s) === c.body.entity_id)) throw new EmulatorError('CONFLICT', 'A service provider with this entity_id already exists.');
      const row = st(e).sps.insert({ entity_id: c.body.entity_id, acs_url: c.body.acs_url, artifact_binding: c.body.artifact_binding !== false, created_at: e.clock.now() } as any);
      return { status: 201, body: spView(e, row) };
    } },
    // POST /__emulator/saml/idp/authenticate { sp_entity_id, user_id? | email?, in_response_to?, relay_state?, binding?: artifact|post, attributes? }: sign a user in at the IdP (an email alone asserts an address nobody has signed up with).
    { method: 'POST', pattern: '/__emulator/saml/idp/authenticate', public: true, handler: async (c) => {
      const e = c.engine;
      const sp = st(e).sps.find((s) => spEntity(e, s) === c.body.sp_entity_id);
      if (!sp) throw notFound('Service provider');
      const user: Obj = c.body.user_id !== undefined ? (e.db.users.get(c.body.user_id) ?? {}) : {};
      if (c.body.user_id !== undefined && (!user.id || user.deleted)) throw notFound('User');
      if (c.body.email !== undefined && (typeof c.body.email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.body.email))) throw bad('email must be an email address.', 'email');
      const binding = c.body.binding ?? 'artifact';
      if (binding !== 'artifact' && binding !== 'post') throw bad('binding is artifact or post.', 'binding');
      if (binding === 'artifact' && !sp.artifact_binding) throw bad('This service provider does not use the artifact binding.', 'binding');
      const emails = (user.emails as Obj[] | undefined) ?? [];
      const email = String(c.body.email ?? (emails.find((m) => m.id === user.primary_email_address_id) ?? emails[0])?.email_address ?? '');
      if (!email) throw bad('Send user_id of a user with an email address, or an email to assert.', 'user_id');
      const { xml } = buildResponse(e, sp, { inResponseTo: typeof c.body.in_response_to === 'string' ? c.body.in_response_to : null, user, email, attributes: isObj(c.body.attributes) ? c.body.attributes : {}, destination: spAcs(e, sp) });
      const relay = typeof c.body.relay_state === 'string' ? c.body.relay_state : null;
      if (binding === 'post') return { body: { object: 'saml_post_binding', saml_response: btoa(xml), relay_state: relay, acs_url: spAcs(e, sp) } };
      const { artifact, handle } = await newArtifact(idpEntityId(e));
      st(e).artifacts.set(handle, { sp_id: sp.id, xml, expires_at: e.clock.now() + ARTIFACT_TTL_MS });
      const u = new URL(spAcs(e, sp));
      u.searchParams.set('SAMLart', artifact);
      if (relay) u.searchParams.set('RelayState', relay);
      return { body: { object: 'saml_artifact_binding', saml_art: artifact, relay_state: relay, acs_url: spAcs(e, sp), redirect_url: u.toString(), expires_at: e.clock.now() + ARTIFACT_TTL_MS } };
    } },
    // POST /__emulator/saml/sp/connections { name, idp?: "emulator", idp_entity_id?, artifact_resolution_url?, allow_sign_up? }: an identity provider Atlas federates with.
    { method: 'POST', pattern: '/__emulator/saml/sp/connections', public: true, handler: (c) => {
      const e = c.engine;
      const b = c.body;
      const own = b.idp === 'emulator';
      const idpEntity = own ? null : b.idp_entity_id;
      if (!own && (typeof idpEntity !== 'string' || !idpEntity)) throw bad('idp_entity_id is required (or idp: "emulator").', 'idp_entity_id');
      const url = own ? null : (b.artifact_resolution_url ?? null);
      if (url !== null && (typeof url !== 'string' || !/^https:\/\//.test(url))) throw bad('artifact_resolution_url must be an https URL.', 'artifact_resolution_url');
      if (b.allow_sign_up !== undefined && typeof b.allow_sign_up !== 'boolean') throw bad('allow_sign_up is a boolean.', 'allow_sign_up');
      const row = st(e).connections.insert({ name: typeof b.name === 'string' && b.name ? b.name : 'SAML', own_idp: own, idp_entity_id: idpEntity, artifact_resolution_url: url, allow_sign_up: b.allow_sign_up !== false, created_at: e.clock.now() } as any);
      if (own) st(e).sps.insert({ conn_id: row.id, entity_id: spEntityId(e, row), acs_url: acsUrl(e), artifact_binding: true, created_at: e.clock.now() } as any);
      return { status: 201, body: connView(e, row) };
    } },
    // POST /__emulator/saml/sp/connections/:id/start { redirect_url }: begin a sign-in (the AuthnRequest and the RelayState it carries).
    { method: 'POST', pattern: '/__emulator/saml/sp/connections/:id/start', public: true, handler: (c) => {
      const e = c.engine;
      const conn = st(e).connections.get(c.params.id);
      if (!conn) throw notFound('SAML connection');
      if (typeof c.body.redirect_url !== 'string' || !/^https?:\/\//.test(c.body.redirect_url)) throw bad('redirect_url must be an http(s) URL.', 'redirect_url');
      const a = st(e).attempts.insert({ connection_id: conn.id, status: 'pending', request_id: msgId(), relay_state: hexOf(crypto.getRandomValues(new Uint8Array(16))), redirect_url: c.body.redirect_url, created_at: e.clock.now() } as any);
      return { status: 201, body: { ...attemptView(a), sp_entity_id: spEntityId(e, conn) } };
    } },
    { method: 'GET', pattern: '/__emulator/saml/attempts/:id', public: true, handler: (c) => {
      const a = st(c.engine).attempts.get(c.params.id);
      if (!a) throw notFound('Attempt');
      return { body: attemptView(a) };
    } },
    // POST /__emulator/saml/attempts/:id/redeem { ticket }: the ticket in the return URL becomes the session, once.
    { method: 'POST', pattern: '/__emulator/saml/attempts/:id/redeem', public: true, handler: (c) => {
      const e = c.engine;
      const t = typeof c.body.ticket === 'string' ? st(e).tickets.get(c.body.ticket) : undefined;
      if (!t || t.attempt_id !== c.params.id) throw new EmulatorError('VERIFICATION_FAILED', 'The ticket is not valid.');
      st(e).tickets.delete(c.body.ticket);
      return { body: t.session };
    } },
  ];
}
