import type { RunContext } from '../context';
import { CliError } from '../errors';
import { renderTable, printJson, type Column } from '../output';

/**
 * `atlas doctor rs <url>`: probe a resource server (your API) from outside, with no key. It
 * checks what a client and an attacker would both see: that the API refuses missing, forged
 * and mis-presented tokens the way RFC 6750 and RFC 9449 say, advertises where to get tokens
 * (RFC 9728), and that the authorization server it names is reachable and publishes signing
 * keys. It sends only requests with invalid credentials, so it cannot reach anything a
 * valid caller could.
 */

export interface RsCheck {
  id: string;
  ok: boolean;
  detail: string;
  fix: string | null;
}

const FORGED_JWT = 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJhdGxhcy1kb2N0b3IiLCJzdWIiOiJwcm9iZSIsImV4cCI6MX0.AAAA';
const TIMEOUT_MS = 8000;

interface Probe {
  status: number;
  www: string | null;
  json: Record<string, unknown> | null;
}

async function probe(f: typeof fetch, url: string, init: RequestInit = {}): Promise<Probe | null> {
  try {
    const res = await f(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), ...init });
    const text = await res.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try {
      const parsed = text ? JSON.parse(text) : null;
      json = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      json = null;
    }
    return { status: res.status, www: res.headers.get('www-authenticate'), json };
  } catch {
    return null;
  }
}

/** Where RFC 9728 puts a resource's metadata: the well-known path inserted before the resource's own path. */
export function metadataUrlFor(resource: URL): string {
  const path = resource.pathname === '/' ? '' : resource.pathname.replace(/\/+$/, '');
  return `${resource.origin}/.well-known/oauth-protected-resource${path}`;
}

const challengeParam = (www: string | null, name: string): string | null => {
  const m = new RegExp(`${name}="([^"]*)"`).exec(www ?? '');
  return m ? m[1]! : null;
};

export async function checkResourceServer(rawUrl: string, f: typeof fetch = fetch): Promise<RsCheck[]> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new CliError('atlas doctor rs needs the URL of one of your API routes, for example https://api.example.com/v1/me.');
  }
  const checks: RsCheck[] = [];
  const add = (id: string, ok: boolean, detail: string, fix: string | null = null) => checks.push({ id, ok, detail, fix: ok ? null : fix });

  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  add('https', url.protocol === 'https:' || local, url.protocol === 'https:' ? 'The API is served over https.' : local ? 'A local address; https is not required.' : 'The API is served over plain http, so tokens cross the network in the clear.', 'Serve the API over https only.');

  // 1. No credentials at all.
  const bare = await probe(f, url.toString());
  if (!bare) {
    add('reachable', false, 'The URL did not answer.', 'Check the URL and that the API is up.');
    return checks;
  }
  add('reachable', true, `Answered with ${bare.status}.`);
  const needsAuth = bare.status === 401;
  add('rejects_anonymous', needsAuth, needsAuth ? 'An anonymous request gets 401.' : `An anonymous request got ${bare.status}, not 401. Point this at a route that needs a token.`, 'Protect the route with the access token verifier.');
  if (needsAuth) {
    add('www_authenticate', !!bare.www && /^(Bearer|DPoP)\b/i.test(bare.www), bare.www ? `WWW-Authenticate: ${bare.www}` : 'The 401 has no WWW-Authenticate header.', 'Send the challenge the verifier returns (result.wwwAuthenticate) as the WWW-Authenticate header.');
    const hasMeta = !!challengeParam(bare.www, 'resource_metadata');
    add('resource_metadata_hint', hasMeta, hasMeta ? 'The challenge points clients at the protected-resource metadata.' : 'The challenge has no resource_metadata, so a client (an MCP client, for one) cannot discover where to sign in.', 'Pass resourceMetadataUrl to createAccessTokenVerifier.');
  }

  // 2. Forged and mis-presented tokens.
  const forged = await probe(f, url.toString(), { headers: { authorization: `Bearer ${FORGED_JWT}` } });
  add('rejects_forged_token', forged?.status === 401, forged ? `A forged JWT got ${forged.status}${forged.status === 401 ? '' : ', not 401'}.` : 'No answer to a forged token.', 'The API must verify the token signature against the issuer keys before trusting any claim.');
  if (forged?.status === 401) {
    const err = challengeParam(forged.www, 'error');
    add('invalid_token_error', err === 'invalid_token', err ? `error="${err}"` : 'The 401 for a bad token carries no error="invalid_token" (RFC 6750).', 'Use the verifier result: it sets error and WWW-Authenticate for you.');
  }
  const garbage = await probe(f, url.toString(), { headers: { authorization: 'Bearer ' } });
  add('survives_malformed_header', !!garbage && garbage.status >= 400 && garbage.status < 500, garbage ? `A malformed Authorization header got ${garbage.status}.` : 'No answer to a malformed header.', 'A malformed header is a 400 or 401, never a 5xx or a pass.');
  const dpop = await probe(f, url.toString(), { headers: { authorization: `DPoP ${FORGED_JWT}`, dpop: FORGED_JWT } });
  add('rejects_forged_dpop', dpop?.status === 401 || dpop?.status === 400, dpop ? `A forged DPoP token and proof got ${dpop.status}.` : 'No answer to a forged DPoP request.', 'Run DPoP-bound tokens through the verifier: it checks the proof, its key, the request and the token.');
  const query = new URL(url.toString());
  query.searchParams.set('access_token', FORGED_JWT);
  const inQuery = await probe(f, query.toString());
  add('rejects_query_token', !!inQuery && inQuery.status !== 200, inQuery ? `A token in the query string got ${inQuery.status}.` : 'No answer to a query-string token.', 'Never accept access tokens in the URL: they end up in logs and referrers.');

  // 3. Protected-resource metadata (RFC 9728).
  const metaUrl = challengeParam(bare.www, 'resource_metadata') ?? metadataUrlFor(url);
  const meta = await probe(f, metaUrl, { headers: { accept: 'application/json' } });
  let authServers: string[] = [];
  if (meta?.status === 200 && meta.json) {
    authServers = Array.isArray(meta.json.authorization_servers) ? meta.json.authorization_servers.filter((s): s is string => typeof s === 'string') : [];
    add('metadata', authServers.length > 0, authServers.length > 0 ? `Served at ${metaUrl}; names ${authServers.join(', ')}.` : 'The metadata lists no authorization_servers.', 'Build the document with protectedResourceMetadata({ resource, issuer }).');
    const resource = typeof meta.json.resource === 'string' ? meta.json.resource : null;
    const sameHost = !!resource && (() => { try { return new URL(resource).origin === url.origin; } catch { return false; } })();
    add('metadata_resource', sameHost, sameHost ? `resource is ${resource}.` : `resource (${resource ?? 'missing'}) is not on this API's origin, so clients will refuse the document.`, 'Set resource to your API identifier (its https origin and path).');
    const algs = Array.isArray(meta.json.dpop_signing_alg_values_supported) ? meta.json.dpop_signing_alg_values_supported : [];
    add('dpop_supported', algs.length > 0, algs.length > 0 ? `DPoP algorithms advertised: ${algs.join(' ')}.` : 'DPoP is not advertised (only needed to accept sender-constrained tokens).', 'protectedResourceMetadata advertises them by default.');
  } else {
    add('metadata', false, `No protected-resource metadata at ${metaUrl}.`, 'Serve protectedResourceMetadata(...) at /.well-known/oauth-protected-resource.');
  }

  // 4. The authorization server it names.
  for (const issuer of authServers.slice(0, 3)) {
    const base = issuer.replace(/\/+$/, '');
    const asMeta = (await probe(f, `${base}/.well-known/oauth-authorization-server`)) ?? null;
    const doc = asMeta?.status === 200 && asMeta.json ? asMeta : await probe(f, `${base}/.well-known/openid-configuration`);
    if (!doc || doc.status !== 200 || !doc.json) {
      add(`issuer:${base}`, false, `${base} serves no authorization server metadata.`, 'Check the issuer URL in your verifier options.');
      continue;
    }
    add(`issuer:${base}`, doc.json.issuer === issuer || doc.json.issuer === base, `Issuer metadata found; issuer is ${String(doc.json.issuer)}.`, 'The issuer in the metadata must equal the issuer you verify tokens against.');
    const jwksUri = typeof doc.json.jwks_uri === 'string' ? doc.json.jwks_uri : `${base}/.well-known/jwks.json`;
    const jwks = await probe(f, jwksUri);
    const keys = jwks?.status === 200 && Array.isArray(jwks.json?.keys) ? (jwks.json!.keys as unknown[]).length : 0;
    add(`jwks:${base}`, keys > 0, keys > 0 ? `${keys} signing key(s) at ${jwksUri}.` : `No signing keys at ${jwksUri}.`, 'The verifier needs the issuer JWKS to check signatures.');
  }
  return checks;
}

const COLUMNS: Column<RsCheck>[] = [
  { header: 'STATE', get: (c) => (c.ok ? 'ok' : 'FAIL') },
  { header: 'CHECK', get: (c) => c.id },
  { header: 'DETAIL', get: (c) => c.detail },
];

/** `atlas doctor rs <url>`; exit 1 when a check fails. */
export async function doctorResourceServer(ctx: RunContext, url: string | undefined, json: boolean): Promise<number> {
  if (!url) throw new CliError('Usage: atlas doctor rs <url>  (the URL of one of your protected API routes)');
  const checks = await checkResourceServer(url, ctx.fetch ?? fetch);
  const failing = checks.filter((c) => !c.ok);
  if (json) {
    printJson(ctx.io, { ok: failing.length === 0, url, checks });
  } else {
    ctx.io.out(renderTable(COLUMNS, [...checks].sort((a, b) => Number(a.ok) - Number(b.ok))));
    for (const c of failing) if (c.fix) ctx.io.out(`${c.id}: ${c.fix}`);
    ctx.io.out('');
    ctx.io.out(`${failing.length} failing, ${checks.length - failing.length} passing.`);
  }
  if (failing.length) {
    ctx.io.err(`atlas: ${failing.length} resource server check(s) failing.`);
    return 1;
  }
  return 0;
}
