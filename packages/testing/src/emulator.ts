/**
 * Test helpers for the Atlas emulator (`@atlasauth/emulator`, `@atlasauth/emulator-core`). Plain HTTP:
 * they need no engine import, so they also work against a development instance, except
 * {@link seedScenario} and {@link waitForMessage}, which use the emulator's own `/__emulator` routes.
 */

export interface AtlasTestTarget {
  /** Base URL of the emulator or the Backend API, e.g. `http://127.0.0.1:4400`. */
  baseUrl: string;
  /** The secret key. The emulator accepts `sk_test_emulator` unless you configured another. */
  secretKey: string;
  fetchImpl?: typeof fetch;
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

async function call(t: AtlasTestTarget, method: string, path: string, body?: unknown, auth = true): Promise<Json> {
  const res = await (t.fetchImpl ?? fetch)(`${t.baseUrl.replace(/\/+$/, '')}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${t.secretKey}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Json;
  if (!res.ok) throw new Error(`${method} ${path} failed with ${res.status}: ${json.errors?.[0]?.code ?? ''} ${json.errors?.[0]?.message ?? ''}`.trim());
  return json;
}

const unique = (): string => Math.random().toString(36).slice(2, 10);

export interface CreateTestUserOptions {
  email?: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  publicMetadata?: Record<string, unknown>;
}

/** Create a user with a unique address unless one is given. */
export function createTestUser(t: AtlasTestTarget, o: CreateTestUserOptions = {}): Promise<Json> {
  return call(t, 'POST', '/v1/users', {
    email_address: o.email ?? `test-${unique()}@example.com`,
    first_name: o.firstName,
    last_name: o.lastName,
    password: o.password,
    public_metadata: o.publicMetadata,
  });
}

export interface CreateTestOrgOptions {
  name?: string;
  slug?: string;
  /** A user id seated as the organization's admin. */
  createdBy?: string;
  publicMetadata?: Record<string, unknown>;
}

export function createTestOrg(t: AtlasTestTarget, o: CreateTestOrgOptions = {}): Promise<Json> {
  return call(t, 'POST', '/v1/organizations', { name: o.name ?? `Test org ${unique()}`, slug: o.slug, created_by: o.createdBy, public_metadata: o.publicMetadata });
}

export function createTestMembership(t: AtlasTestTarget, o: { organizationId: string; userId: string; role?: string }): Promise<Json> {
  return call(t, 'POST', `/v1/organizations/${o.organizationId}/memberships`, { user_id: o.userId, role: o.role ?? 'org:member' });
}

export function createTestRole(t: AtlasTestTarget, o: { key: string; name?: string; permissions?: string[] }): Promise<Json> {
  return call(t, 'POST', '/v1/roles', { key: o.key, name: o.name ?? o.key, permissions: o.permissions });
}

/** The shape `POST /__emulator/scenarios` takes. Emulator only. */
export interface TestScenario {
  users?: Array<{ ref?: string; email: string; first_name?: string; last_name?: string; password?: string; public_metadata?: Record<string, unknown> }>;
  roles?: Array<{ ref?: string; key: string; name?: string; permissions?: string[] }>;
  organizations?: Array<{ ref?: string; name: string; slug?: string; created_by?: string; members?: Array<{ user: string; role?: string }> }>;
  webhook_endpoints?: Array<{ ref?: string; url: string; enabled_events?: string[] }>;
}

/** Create a whole fixture in one call; returns every created resource by `ref`. Emulator only. */
export async function seedScenario(t: AtlasTestTarget, scenario: TestScenario): Promise<Record<string, Json>> {
  const out = await call(t, 'POST', '/__emulator/scenarios', scenario, false);
  return out.refs as Record<string, Json>;
}

export interface SunkMessage {
  id: number;
  at: string;
  channel: string;
  to: string;
  subject?: string;
  body?: string;
  code?: string;
  link?: string;
}

/**
 * Wait for the first message (email, SMS, ...) sent to an address. Emulator only. Rejects after `timeoutMs`
 * (default 5000). Pass `after` (a message id) to skip messages you have already seen.
 */
export async function waitForMessage(t: AtlasTestTarget, o: { to?: string; channel?: string; after?: number; timeoutMs?: number }): Promise<SunkMessage> {
  const timeoutMs = o.timeoutMs ?? 5000;
  const q = new URLSearchParams({ wait: String(timeoutMs) });
  if (o.to) q.set('to', o.to);
  if (o.channel) q.set('channel', o.channel);
  if (o.after !== undefined) q.set('after', String(o.after));
  const out = await call(t, 'GET', `/__emulator/messages?${q}`, undefined, false);
  const first = (out.data as SunkMessage[])[0];
  if (!first) throw new Error(`No message for ${JSON.stringify({ to: o.to, channel: o.channel })} within ${timeoutMs} ms.`);
  return first;
}

const enc = new TextEncoder();
const b64 = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/**
 * Sign a webhook body the way Atlas does, to drive your own receiver in a test. Returns the headers to
 * send (`atlas-id`, `atlas-timestamp`, `atlas-signature`) that `verifyAtlasWebhook` accepts for `secret`.
 */
export async function signWebhook(o: { secret: string; body: string | object; id?: string; timestamp?: number }): Promise<{ body: string; headers: Record<string, string> }> {
  const body = typeof o.body === 'string' ? o.body : JSON.stringify(o.body);
  const id = o.id ?? `evt_test_${unique()}`;
  const timestamp = o.timestamp ?? Date.now();
  const key = await crypto.subtle.importKey('raw', enc.encode(o.secret) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = b64(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${id}.${timestamp}.${body}`) as BufferSource)));
  return { body, headers: { 'content-type': 'application/json', 'atlas-id': id, 'atlas-timestamp': String(timestamp), 'atlas-signature': `v1,${mac}` } };
}
