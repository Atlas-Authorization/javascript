import { decodeJwt } from 'jose';
import { verifyWebhook } from './webhooks';

/**
 * LAZY MIGRATION, the half that runs on YOUR server.
 *
 * With a legacy-auth connection enabled, Atlas asks your `verify_url` whether
 * an unknown identifier + password is valid in the old system, then creates
 * the user with that password on success. This module is that endpoint for
 * the vendors that will not export password hashes (or whose hashes you chose
 * not to move): it checks Atlas's signature, asks the OLD vendor with YOUR
 * vendor credentials and answers with the profile. Vendor credentials stay on
 * your server; Atlas never sees them.
 *
 *   const verify = oktaPasswordVerifier({ domain: 'acme.okta.com' });
 *   app.post('/atlas/legacy-verify', express.text({ type: '*\/*' }), async (req, res) => {
 *     const out = await handleLegacyVerify({ body: req.body, headers: req.headers, secret, verify });
 *     res.status(out.status).json(out.body);
 *   });
 *
 * Every verifier FAILS CLOSED: a transport error, a timeout or an answer it
 * does not recognise is "not verified", never "verified".
 */

/** What Atlas needs to create the user. `external_id` keeps the old id for token bridges. */
export interface LegacyVerifiedProfile {
  email: string;
  email_verified?: boolean;
  name?: string;
  external_id?: string;
  metadata?: Record<string, unknown>;
}

export type LegacyPasswordVerifier = (input: {
  identifier: string;
  password: string;
}) => Promise<LegacyVerifiedProfile | null>;

interface VerifierTransport {
  fetchImpl?: typeof fetch;
  /** Per-call budget; Atlas's own call times out at the connection's `timeout_ms`. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 4000;

/**
 * Check Atlas's signature on the request and run `verify`. Returns the status
 * and JSON body to send: 200 `{ user }` on a valid credential, 401 when the
 * old system rejected it, 400 on a bad signature or body.
 */
export async function handleLegacyVerify(input: {
  body: string | Buffer;
  headers: Headers | Record<string, string | string[] | undefined>;
  secret: string;
  verify: LegacyPasswordVerifier;
  now?: Date;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  const checked = verifyWebhook<{ identifier?: unknown; password?: unknown }>({
    body: input.body,
    headers: input.headers,
    secret: input.secret,
    now: input.now,
  });
  if (!checked.verified) return { status: 400, body: { error: 'invalid_signature' } };
  const identifier = typeof checked.event?.identifier === 'string' ? checked.event.identifier.trim() : '';
  const password = typeof checked.event?.password === 'string' ? checked.event.password : '';
  if (!identifier || !password) return { status: 400, body: { error: 'invalid_body' } };
  let profile: LegacyVerifiedProfile | null = null;
  try {
    profile = await input.verify({ identifier, password });
  } catch {
    profile = null;
  }
  if (!profile || !profile.email.includes('@')) return { status: 401, body: { error: 'invalid_credentials' } };
  return { status: 200, body: { user: profile } };
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
const obj = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

async function call(
  t: VerifierTransport,
  url: string,
  init: RequestInit,
): Promise<{ status: number; json: Record<string, unknown> | null; raw: unknown } | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), t.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await (t.fetchImpl ?? fetch)(url, { ...init, signal: controller.signal, redirect: 'manual' });
    let raw: unknown = null;
    try {
      raw = (await res.json()) as unknown;
    } catch {
      raw = null;
    }
    return { status: res.status, json: obj(raw) ?? null, raw };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const origin = (domain: string): string => `https://${domain.replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
const joinName = (...parts: Array<string | undefined>): string | undefined =>
  parts.filter(Boolean).join(' ').trim() || undefined;

/**
 * Okta (Workforce Identity Cloud / Customer Identity Solution): the Authn API,
 * `POST /api/v1/authn`, needs no API token. A primary-authentication result of
 * SUCCESS, or any state that is only reached after a correct password
 * (MFA_REQUIRED, MFA_ENROLL, PASSWORD_WARN, PASSWORD_EXPIRED), counts as
 * verified; 401 (E0000004) and LOCKED_OUT do not.
 *
 * Orgs where the Authn API is turned off can verify with the resource-owner
 * password grant of an app that allows it: pass `passwordGrant`.
 */
export function oktaPasswordVerifier(
  opts: VerifierTransport & {
    domain: string;
    passwordGrant?: { authorizationServerId?: string; clientId: string; clientSecret?: string };
  },
): LegacyPasswordVerifier {
  const base = origin(opts.domain);
  const PASSED = new Set(['SUCCESS', 'MFA_REQUIRED', 'MFA_ENROLL', 'MFA_CHALLENGE', 'PASSWORD_WARN', 'PASSWORD_EXPIRED']);
  return async ({ identifier, password }) => {
    if (opts.passwordGrant) {
      const g = opts.passwordGrant;
      const server = g.authorizationServerId ?? 'default';
      const form = new URLSearchParams({ grant_type: 'password', username: identifier, password, scope: 'openid email profile', client_id: g.clientId });
      if (g.clientSecret) form.set('client_secret', g.clientSecret);
      const res = await call(opts, `${base}/oauth2/${server}/v1/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form.toString(),
      });
      if (!res || res.status !== 200) return null;
      return profileFromIdToken(str(res.json?.id_token), { externalIdClaim: 'sub' });
    }
    const res = await call(opts, `${base}/api/v1/authn`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ username: identifier, password, options: { warnBeforePasswordExpired: false, multiOptionalFactorEnroll: false } }),
    });
    if (!res || res.status !== 200 || !res.json) return null;
    if (!PASSED.has(String(res.json.status))) return null;
    const user = obj(obj(res.json._embedded)?.user);
    const profile = obj(user?.profile);
    const email = str(profile?.login)?.includes('@') ? str(profile?.login) : undefined;
    if (!email) return null;
    return {
      email: email.toLowerCase(),
      // Okta proved the user controls the login; it does not say the address was verified.
      email_verified: false,
      name: joinName(str(profile?.firstName), str(profile?.lastName)),
      external_id: str(user?.id),
    };
  };
}

/**
 * Auth0 (and Okta Customer Identity Cloud): the resource-owner password grant
 * against ONE database connection (`realm`), from an application with the
 * Password grant enabled. `mfa_required` means the password was right (Auth0
 * only asks for the second factor after it). Use a dedicated application for
 * this and keep its secret on your server.
 */
export function auth0PasswordVerifier(
  opts: VerifierTransport & { domain: string; clientId: string; clientSecret?: string; realm: string; audience?: string },
): LegacyPasswordVerifier {
  const base = origin(opts.domain);
  return async ({ identifier, password }) => {
    const body: Record<string, string> = {
      grant_type: 'http://auth0.com/oauth/grant-type/password-realm',
      realm: opts.realm,
      username: identifier,
      password,
      client_id: opts.clientId,
      scope: 'openid email profile',
    };
    if (opts.clientSecret) body.client_secret = opts.clientSecret;
    if (opts.audience) body.audience = opts.audience;
    const res = await call(opts, `${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res) return null;
    if (res.status === 200) return profileFromIdToken(str(res.json?.id_token), { externalIdClaim: 'sub' });
    if (res.status === 403 && res.json?.error === 'mfa_required') {
      // No ID token yet: the password is right, the profile comes from the MFA
      // token's user. Atlas needs at least the email, which is the identifier.
      return identifier.includes('@') ? { email: identifier.toLowerCase(), email_verified: false } : null;
    }
    return null;
  };
}

/**
 * Descope: `POST /v1/auth/password/signin` with the project id (public — no
 * management key). A 200 with a `user` means the password is right.
 */
export function descopePasswordVerifier(
  opts: VerifierTransport & { projectId: string; baseUrl?: string },
): LegacyPasswordVerifier {
  const base = origin(opts.baseUrl ?? 'api.descope.com');
  return async ({ identifier, password }) => {
    const res = await call(opts, `${base}/v1/auth/password/signin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${opts.projectId}` },
      body: JSON.stringify({ loginId: identifier, password }),
    });
    if (!res || res.status !== 200 || !res.json) return null;
    const user = obj(res.json.user);
    const email = str(user?.email) ?? (identifier.includes('@') ? identifier : undefined);
    if (!user || !email) return null;
    return {
      email: email.toLowerCase(),
      email_verified: user.verifiedEmail === true,
      name: str(user.name) ?? joinName(str(user.givenName), str(user.familyName)),
      external_id: str(user.userId),
    };
  };
}

/**
 * Clerk exports bcrypt digests, so most moves need no lazy step. For users
 * whose digest could not move (a peppered or Cognito-backed hasher), look the
 * user up by email and call `POST /v1/users/{id}/verify_password` with your
 * Clerk secret key.
 */
export function clerkPasswordVerifier(
  opts: VerifierTransport & { secretKey: string; apiUrl?: string },
): LegacyPasswordVerifier {
  const base = (opts.apiUrl ?? 'https://api.clerk.com').replace(/\/+$/, '');
  const headers = { authorization: `Bearer ${opts.secretKey}`, 'content-type': 'application/json', accept: 'application/json' };
  return async ({ identifier, password }) => {
    if (!identifier.includes('@')) return null;
    const found = await call(opts, `${base}/v1/users?email_address=${encodeURIComponent(identifier)}&limit=1`, { headers });
    if (!found || found.status !== 200) return null;
    // GET /v1/users answers with a bare array (or `{ data }` from newer API versions).
    const list = Array.isArray(found.raw) ? found.raw : Array.isArray(found.json?.data) ? (found.json!.data as unknown[]) : [];
    const user = obj(list[0]);
    const id = str(user?.id);
    if (!user || !id) return null;
    const res = await call(opts, `${base}/v1/users/${encodeURIComponent(id)}/verify_password`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ password }),
    });
    if (!res || res.status !== 200 || res.json?.verified !== true) return null;
    const emails = Array.isArray(user.email_addresses) ? user.email_addresses.map(obj) : [];
    const primary = emails.find((e) => e && e.id === user.primary_email_address_id) ?? emails[0];
    return {
      email: (str(primary?.email_address) ?? identifier).toLowerCase(),
      email_verified: obj(primary?.verification)?.status === 'verified',
      name: joinName(str(user.first_name), str(user.last_name)),
      external_id: id,
    };
  };
}

/**
 * The profile in an ID token returned DIRECTLY by the vendor's token endpoint
 * over TLS (so its signature need not be re-checked here).
 */
function profileFromIdToken(idToken: string | undefined, o: { externalIdClaim: string }): LegacyVerifiedProfile | null {
  if (!idToken) return null;
  let claims: Record<string, unknown>;
  try {
    claims = decodeJwt(idToken) as Record<string, unknown>;
  } catch {
    return null;
  }
  const email = str(claims.email);
  if (!email || !email.includes('@')) return null;
  return {
    email: email.toLowerCase(),
    email_verified: claims.email_verified === true,
    name: str(claims.name) ?? joinName(str(claims.given_name), str(claims.family_name)),
    external_id: str(claims[o.externalIdClaim]),
  };
}
