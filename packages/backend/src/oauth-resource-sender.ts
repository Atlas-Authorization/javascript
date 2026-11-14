/**
 * Resource-server helpers beyond the access token itself: certificate-bound tokens (RFC 8705),
 * rich authorization requests (RFC 9396) and the grants a machine or agent token carries. No
 * Node built-ins, so they run on edge runtimes. `createAccessTokenVerifier` uses them through
 * its `clientCertThumbprint`, `requireSenderConstrained` and `requireAuthorizationDetails`
 * options; each is also exported to use on its own.
 */

// ── Certificate-bound tokens (RFC 8705) ──────────────────────────────────────────────────────

const b64u = (bytes: Uint8Array): string => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

/**
 * The `x5t#S256` thumbprint of a certificate: base64url of the SHA-256 of its DER encoding.
 * Accepts a PEM string (URL-encoded is fine, as proxies forward it), or the DER bytes.
 */
export async function certificateThumbprint(cert: string | Uint8Array): Promise<string> {
  let der: Uint8Array;
  if (typeof cert === 'string') {
    let pem = cert;
    try {
      pem = decodeURIComponent(cert);
    } catch {
      // not URL-encoded
    }
    const m = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
    const b64 = (m ? m[1]! : pem).replace(/\s+/g, '');
    der = Uint8Array.from(atob(b64.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  } else {
    der = cert;
  }
  if (der.length === 0) throw new Error('Empty certificate.');
  return b64u(new Uint8Array(await crypto.subtle.digest('SHA-256', der as never)));
}

/** Constant-time string equality, for comparing thumbprints. */
export function thumbprintsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

interface HeaderBag {
  headers: Record<string, string | string[] | undefined> | { get(name: string): string | null };
}
const headerOf = (req: HeaderBag, name: string): string | undefined => {
  const h = req.headers as { get?: (n: string) => string | null } & Record<string, string | string[] | undefined>;
  if (typeof h.get === 'function') return h.get(name) ?? undefined;
  const v = h[name] ?? h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
};

/**
 * A `clientCertThumbprint` function for a service behind an mTLS-terminating proxy that forwards
 * the client certificate in a header (nginx `ssl-client-cert`, Traefik, Envoy or an ALB-style
 * `x-amzn-mtls-clientcert`, all URL-encoded PEM), or its SHA-256 fingerprint.
 *
 * SECURITY: a client certificate is public, so these headers prove nothing unless only your
 * proxy can set them. Strip them from inbound traffic at the proxy, and pass `proxySecret` so
 * the proxy also adds a secret header that this function checks: without the secret it reports
 * no certificate, so a certificate-bound token is refused.
 */
export function forwardedClientCert(
  opts: {
    /** Headers to read the PEM from, in order. Default: ssl-client-cert, x-forwarded-client-cert, x-client-cert, x-amzn-mtls-clientcert. */
    certHeaders?: readonly string[];
    /** A header holding the certificate's SHA-256 fingerprint (hex, colon-separated hex or base64url) instead of the certificate. */
    fingerprintHeader?: string;
    /** A header and value only your proxy sets. */
    proxySecret?: { header: string; value: string };
  } = {},
): (request: HeaderBag) => Promise<string | undefined> {
  const certHeaders = opts.certHeaders ?? ['ssl-client-cert', 'x-forwarded-client-cert', 'x-client-cert', 'x-amzn-mtls-clientcert'];
  return async (request) => {
    if (opts.proxySecret) {
      const got = headerOf(request, opts.proxySecret.header);
      if (!got || !thumbprintsEqual(got, opts.proxySecret.value)) return undefined;
    }
    if (opts.fingerprintHeader) {
      const raw = headerOf(request, opts.fingerprintHeader);
      if (raw) {
        const hex = raw.replace(/:/g, '');
        if (/^[0-9a-fA-F]{64}$/.test(hex)) return b64u(Uint8Array.from(hex.match(/../g)!.map((h) => parseInt(h, 16))));
        if (/^[A-Za-z0-9_-]{43}$/.test(raw)) return raw;
      }
    }
    for (const name of certHeaders) {
      const raw = headerOf(request, name);
      if (!raw) continue;
      try {
        return await certificateThumbprint(raw);
      } catch {
        return undefined;
      }
    }
    return undefined;
  };
}

/** What a token's `cnf` claim binds it to. */
export function senderConstraintOf(claims: { cnf?: { jkt?: string; 'x5t#S256'?: string } }): { dpop: boolean; mtls: boolean } {
  return { dpop: typeof claims.cnf?.jkt === 'string' && claims.cnf.jkt.length > 0, mtls: typeof claims.cnf?.['x5t#S256'] === 'string' && claims.cnf['x5t#S256'].length > 0 };
}

// ── Rich authorization requests (RFC 9396) ───────────────────────────────────────────────────

/** One entry of a token's `authorization_details`. `type` is required; the other common fields are named, the rest are type specific. */
export interface AuthorizationDetail {
  type: string;
  locations?: string[];
  actions?: string[];
  datatypes?: string[];
  identifier?: string;
  privileges?: string[];
  [field: string]: unknown;
}

/** What an API call needs from the token's authorization details. */
export interface AuthorizationDetailRequirement {
  type: string;
  /** Every one of these must be among the granted actions / locations / datatypes / privileges. */
  actions?: readonly string[];
  locations?: readonly string[];
  datatypes?: readonly string[];
  privileges?: readonly string[];
  /** The granted identifier must equal this. */
  identifier?: string;
  /** Type-specific fields that must be equal in the granted entry (scalars, or compared as JSON). */
  fields?: Record<string, unknown>;
  /** Anything else you need, for example `detail.amount.value >= price`. Runs on entries that passed the checks above. */
  check?: (detail: AuthorizationDetail) => boolean;
}

export type AuthorizationDetailsMatch =
  | { ok: true; matched: AuthorizationDetail[] }
  | { ok: false; missing: AuthorizationDetailRequirement[] };

const stringList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The `authorization_details` of verified claims (entries without a string `type` are dropped). */
export function authorizationDetailsOf(claims: Readonly<Record<string, unknown>>): AuthorizationDetail[] {
  const raw = claims.authorization_details;
  return Array.isArray(raw) ? raw.filter((d): d is AuthorizationDetail => !!d && typeof d === 'object' && typeof (d as { type?: unknown }).type === 'string') : [];
}

const covers = (granted: readonly string[], needed: readonly string[] | undefined): boolean => !needed || needed.every((n) => granted.includes(n));

function satisfies(detail: AuthorizationDetail, req: AuthorizationDetailRequirement): boolean {
  if (detail.type !== req.type) return false;
  if (!covers(stringList(detail.actions), req.actions)) return false;
  if (!covers(stringList(detail.locations), req.locations)) return false;
  if (!covers(stringList(detail.datatypes), req.datatypes)) return false;
  if (!covers(stringList(detail.privileges), req.privileges)) return false;
  if (req.identifier !== undefined && detail.identifier !== req.identifier) return false;
  if (req.fields) {
    for (const [k, want] of Object.entries(req.fields)) {
      const got = detail[k];
      if (typeof want === 'object' && want !== null ? JSON.stringify(got) !== JSON.stringify(want) : got !== want) return false;
    }
  }
  return req.check ? req.check(detail) : true;
}

/**
 * Does the token's `authorization_details` cover everything this call needs? Every requirement
 * must be satisfied by at least one entry of the same `type`. A list a requirement names (actions,
 * locations, datatypes, privileges) must be wholly present in the entry; an entry that omits the
 * list does not cover it (the safe reading of an absent restriction).
 */
export function matchAuthorizationDetails(
  claimsOrDetails: Readonly<Record<string, unknown>> | readonly AuthorizationDetail[],
  required: AuthorizationDetailRequirement | readonly AuthorizationDetailRequirement[],
): AuthorizationDetailsMatch {
  const details = Array.isArray(claimsOrDetails) ? (claimsOrDetails as readonly AuthorizationDetail[]) : authorizationDetailsOf(claimsOrDetails as Record<string, unknown>);
  const reqs = Array.isArray(required) ? (required as readonly AuthorizationDetailRequirement[]) : [required as AuthorizationDetailRequirement];
  const matched: AuthorizationDetail[] = [];
  const missing: AuthorizationDetailRequirement[] = [];
  for (const r of reqs) {
    const hit = details.find((d) => satisfies(d, r));
    if (hit) {
      if (!matched.includes(hit)) matched.push(hit);
    } else {
      missing.push(r);
    }
  }
  return missing.length === 0 ? { ok: true, matched } : { ok: false, missing };
}

// ── Grants (machine and agent tokens) ───────────────────────────────────────────────────────

/** One grant a machine or agent token carries, in the one shape both use. */
export interface TokenGrant {
  type: 'machine' | 'agent';
  id: string;
  /** The API the grant is on (a resource server identifier), or an agent grant's resource. */
  resource: string;
  scopes: string[];
  kind?: string;
  constraints?: Record<string, unknown>;
  /** Epoch seconds when the grant stops minting tokens. */
  exp?: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * The grants a verified machine or agent token carries. Reads the `grants` claim; for a token
 * minted before it existed, rebuilds the same list from the older claims (`grant_id` /
 * `grant_type` / `scope` / `constraints` on a machine token, `agent_grants` on an agent token),
 * so one reader serves both.
 */
export function tokenGrants(claims: Readonly<Record<string, unknown>>): TokenGrant[] {
  const out: TokenGrant[] = [];
  const pick = (g: Record<string, unknown>, type: TokenGrant['type'], id: unknown): TokenGrant | null =>
    typeof id === 'string' && typeof g.resource === 'string'
      ? { type, id, resource: g.resource, scopes: stringList(g.scopes), ...(typeof g.kind === 'string' ? { kind: g.kind } : {}), ...(isObj(g.constraints) ? { constraints: g.constraints } : {}), ...(typeof g.exp === 'number' ? { exp: g.exp } : {}) }
      : null;
  if (Array.isArray(claims.grants)) {
    for (const g of claims.grants) {
      if (isObj(g) && (g.type === 'machine' || g.type === 'agent')) {
        const t = pick(g, g.type, g.id);
        if (t) out.push(t);
      }
    }
    return out;
  }
  if (Array.isArray(claims.agent_grants)) {
    for (const g of claims.agent_grants) {
      if (isObj(g)) {
        const t = pick(g, 'agent', g.grant_id);
        if (t) out.push(t);
      }
    }
  }
  if (typeof claims.grant_id === 'string' && claims.grant_type === 'machine') {
    const aud = Array.isArray(claims.aud) ? claims.aud[0] : claims.aud;
    if (typeof aud === 'string') {
      out.push({
        type: 'machine',
        id: claims.grant_id,
        resource: aud,
        scopes: typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [],
        ...(isObj(claims.constraints) ? { constraints: claims.constraints } : {}),
      });
    }
  }
  return out;
}
