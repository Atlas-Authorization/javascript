import type { LegacyIssuer } from './legacy-issuers';

/**
 * `legacyIssuers` presets for the JWT-issuing auth vendors, so a cutover only
 * names the old tenant and the end of the window:
 *
 *   new AtlasBackend({
 *     ...,
 *     legacyIssuers: [
 *       ...clerkLegacyIssuer({ publishableKey: process.env.CLERK_PUBLISHABLE_KEY!, until: '2027-01-31' }),
 *     ],
 *   });
 *
 * Each preset returns an array (Descope tokens carry one of two `iss` shapes)
 * of entries with the vendor's issuer, key-set URL, algorithms and subject
 * claim filled in. The old user id maps to the Atlas user through
 * `external_id`, which every Atlas importer sets to the vendor's user id.
 */

type Window = Pick<LegacyIssuer, 'until' | 'resolveSubject'>;

const RSA_ALGS = ['RS256'];

function stripSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

/** `example.com` / `https://example.com/` → `https://example.com`. */
export function httpsOrigin(domainOrUrl: string): string {
  const raw = domainOrUrl.trim();
  const url = new URL(/^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`);
  if (url.protocol !== 'https:') throw new Error(`legacyIssuers: ${domainOrUrl} must be https.`);
  return `https://${url.host}`;
}

/**
 * The Frontend API host a Clerk publishable key encodes: `pk_(test|live)_` +
 * base64(`<host>$`).
 */
export function clerkFrontendApiFromPublishableKey(publishableKey: string): string | null {
  const m = /^pk_(?:test|live)_([A-Za-z0-9+/=_-]+)$/.exec(publishableKey.trim());
  if (!m) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(m[1]!.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return null;
  }
  if (!decoded.endsWith('$')) return null;
  const host = decoded.slice(0, -1);
  return /^[a-z0-9.-]+(?::\d+)?$/i.test(host) ? host : null;
}

/**
 * Clerk session tokens (the `__session` cookie / `getToken()`): RS256, `iss` =
 * the Frontend API origin, keys at `<iss>/.well-known/jwks.json`, `sub` = the
 * Clerk user id (`user_…`). `authorizedParties` checks `azp` like Clerk's own
 * `authorizedParties`; a pending session (`sts: "pending"`) is refused.
 */
export function clerkLegacyIssuer(
  opts: Window & ({ publishableKey: string } | { frontendApi: string }) & { authorizedParties?: readonly string[] },
): LegacyIssuer[] {
  const host =
    'publishableKey' in opts ? clerkFrontendApiFromPublishableKey(opts.publishableKey) : opts.frontendApi;
  if (!host) throw new Error('clerkLegacyIssuer: the publishable key does not encode a Frontend API host.');
  const issuer = httpsOrigin(host);
  const parties = opts.authorizedParties?.map((p) => stripSlash(p));
  return [
    {
      kind: 'clerk',
      issuer,
      jwksUrl: `${issuer}/.well-known/jwks.json`,
      algorithms: RSA_ALGS,
      until: opts.until,
      resolveSubject: opts.resolveSubject,
      checkClaims: (claims) => {
        if (claims.sts === 'pending') return false;
        if (parties && parties.length > 0 && typeof claims.azp === 'string' && !parties.includes(stripSlash(claims.azp))) {
          return false;
        }
        return true;
      },
    },
  ];
}

/**
 * Auth0 (and Okta Customer Identity Cloud) access or ID tokens: `iss` =
 * `https://<tenant domain>/` WITH the trailing slash, keys at
 * `/.well-known/jwks.json`, `sub` = the Auth0 user id (`auth0|…`,
 * `google-oauth2|…`). `audience` is the API identifier (access tokens) or the
 * client id (ID tokens) — required, since an Auth0 tenant mints tokens for many.
 */
export function auth0LegacyIssuer(
  opts: Window & { domain: string; audience: string | readonly string[]; algorithms?: readonly string[] },
): LegacyIssuer[] {
  const origin = httpsOrigin(opts.domain);
  return [
    {
      kind: 'auth0',
      issuer: `${origin}/`,
      jwksUrl: `${origin}/.well-known/jwks.json`,
      audience: opts.audience,
      algorithms: opts.algorithms ?? ['RS256', 'PS256'],
      until: opts.until,
      resolveSubject: opts.resolveSubject,
    },
  ];
}

/**
 * Okta (Workforce Identity Cloud, Customer Identity Solution) tokens from a
 * CUSTOM authorization server: `iss` = `https://<okta domain>/oauth2/<id>`
 * (`default` unless set), keys at `<iss>/v1/keys`. Access tokens put the login
 * in `sub` and the Okta user id in `uid`; ID tokens put the user id in `sub`.
 * Tokens from the org authorization server (`iss` = the bare domain) are not
 * meant for resource servers and are not accepted here.
 */
export function oktaLegacyIssuer(
  opts: Window & {
    domain: string;
    authorizationServerId?: string;
    /** Access tokens: `api://default` unless the server says otherwise. ID tokens: the client id. */
    audience?: string | readonly string[];
    token?: 'access' | 'id';
  },
): LegacyIssuer[] {
  const server = opts.authorizationServerId ?? 'default';
  if (!/^[A-Za-z0-9_-]+$/.test(server)) throw new Error('oktaLegacyIssuer: authorizationServerId is not an Okta id.');
  const issuer = `${httpsOrigin(opts.domain)}/oauth2/${server}`;
  const token = opts.token ?? 'access';
  if (token === 'id' && !opts.audience) throw new Error('oktaLegacyIssuer: ID tokens need audience (the client id).');
  return [
    {
      kind: 'okta',
      issuer,
      jwksUrl: `${issuer}/v1/keys`,
      audience: opts.audience ?? (server === 'default' ? 'api://default' : undefined),
      algorithms: RSA_ALGS,
      subjectClaim: token === 'access' ? 'uid' : 'sub',
      until: opts.until,
      resolveSubject: opts.resolveSubject,
    },
  ];
}

/**
 * Kinde access or ID tokens: `iss` = `https://<business>.kinde.com` (or the
 * custom domain), keys at `/.well-known/jwks`, `sub` = the Kinde user id
 * (`kp_…`). Set `audience` when the app registered an API audience.
 */
export function kindeLegacyIssuer(
  opts: Window & { issuerUrl: string; audience?: string | readonly string[] },
): LegacyIssuer[] {
  const issuer = httpsOrigin(opts.issuerUrl);
  return [
    {
      kind: 'kinde',
      issuer,
      jwksUrl: `${issuer}/.well-known/jwks`,
      audience: opts.audience,
      algorithms: RSA_ALGS,
      until: opts.until,
      resolveSubject: opts.resolveSubject,
    },
  ];
}

/**
 * Descope session tokens (the `DS` cookie / `sessionToken`): RS256, keys at
 * `<base>/v2/keys/<project id>`, `sub` = the Descope user id. Projects issue
 * either `https://api.descope.com/<project id>` or the bare project id as
 * `iss`, so both are accepted. Refresh tokens (`drn: "DSR"`) are refused.
 */
export function descopeLegacyIssuer(
  opts: Window & { projectId: string; baseUrl?: string },
): LegacyIssuer[] {
  if (!/^P[A-Za-z0-9]{20,40}$/.test(opts.projectId)) throw new Error('descopeLegacyIssuer: projectId is not a Descope project id.');
  const base = httpsOrigin(opts.baseUrl ?? 'https://api.descope.com');
  const shared: Omit<LegacyIssuer, 'issuer'> = {
    kind: 'descope',
    jwksUrl: `${base}/v2/keys/${opts.projectId}`,
    algorithms: RSA_ALGS,
    until: opts.until,
    resolveSubject: opts.resolveSubject,
    checkClaims: (claims) => claims.drn === undefined || claims.drn === 'DS',
  };
  return [
    { ...shared, issuer: `${base}/${opts.projectId}` },
    { ...shared, issuer: opts.projectId },
  ];
}
