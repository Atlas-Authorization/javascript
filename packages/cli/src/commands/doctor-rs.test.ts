import { describe, expect, it } from 'vitest';
import { checkResourceServer, metadataUrlFor } from './doctor-rs';

const API = 'https://api.example.com/v1/orders';
const META = 'https://api.example.com/.well-known/oauth-protected-resource/v1/orders';
const ISSUER = 'https://id.example.com';

type Handler = (url: string, init?: RequestInit) => Response | undefined;

/** A fake API whose behaviour each test bends. */
function server(over: Partial<Record<string, Handler>> = {}): typeof fetch {
  const base: Record<string, Handler> = {
    api: (url, init) => {
      const auth = new Headers(init?.headers).get('authorization');
      const challenge = `Bearer realm="api", resource_metadata="${META}"`;
      if (!auth) return new Response('', { status: 401, headers: { 'www-authenticate': challenge } });
      if (auth === 'Bearer ') return new Response('', { status: 400 });
      return new Response('', { status: 401, headers: { 'www-authenticate': `${challenge}, error="invalid_token"` } });
    },
    meta: () => Response.json({ resource: 'https://api.example.com/v1/orders', authorization_servers: [ISSUER], dpop_signing_alg_values_supported: ['ES256'] }),
    asMeta: () => Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` }),
    jwks: () => Response.json({ keys: [{ kty: 'RSA' }] }),
  };
  const h = { ...base, ...over };
  return (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const r =
      url === META ? h.meta!(url, init)
      : url === `${ISSUER}/.well-known/oauth-authorization-server` ? h.asMeta!(url, init)
      : url === `${ISSUER}/.well-known/jwks.json` ? h.jwks!(url, init)
      : url.startsWith(API) ? h.api!(url, init)
      : new Response('', { status: 404 });
    return r ?? new Response('', { status: 404 });
  }) as typeof fetch;
}

const failing = (checks: Awaited<ReturnType<typeof checkResourceServer>>) => checks.filter((c) => !c.ok).map((c) => c.id);

describe('atlas doctor rs', () => {
  it('computes the RFC 9728 metadata URL with the path inserted', () => {
    expect(metadataUrlFor(new URL('https://api.example.com/v1/orders'))).toBe(META);
    expect(metadataUrlFor(new URL('https://api.example.com/'))).toBe('https://api.example.com/.well-known/oauth-protected-resource');
  });

  it('passes a correctly protected API', async () => {
    expect(failing(await checkResourceServer(API, server()))).toEqual([]);
  });

  it('flags an API that lets a forged token, a query-string token or a malformed header through', async () => {
    const lax = server({ api: (url, init) => (new Headers(init?.headers).get('authorization')?.startsWith('Bearer ey') ? new Response('', { status: 200 }) : url.includes('access_token=') ? new Response('', { status: 200 }) : new Response('', { status: 500 })) });
    const failed = failing(await checkResourceServer(API, lax));
    expect(failed).toEqual(expect.arrayContaining(['rejects_anonymous', 'rejects_forged_token', 'rejects_query_token', 'survives_malformed_header']));
  });

  it('flags a 401 with no challenge, no resource_metadata, missing metadata and an unreachable issuer', async () => {
    const f = server({
      api: () => new Response('', { status: 401 }),
      meta: () => new Response('', { status: 404 }),
    });
    const failed = failing(await checkResourceServer(API, f));
    expect(failed).toEqual(expect.arrayContaining(['www_authenticate', 'resource_metadata_hint', 'metadata']));
    const noIssuer = server({ asMeta: () => new Response('', { status: 404 }) });
    expect(failing(await checkResourceServer(API, noIssuer))).toEqual([`issuer:${ISSUER}`]);
    const noKeys = server({ jwks: () => Response.json({ keys: [] }) });
    expect(failing(await checkResourceServer(API, noKeys))).toEqual([`jwks:${ISSUER}`]);
  });

  it('reports an unreachable URL and refuses a malformed one', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    expect(failing(await checkResourceServer(API, down))).toContain('reachable');
    await expect(checkResourceServer('not a url', down)).rejects.toThrow(/URL/);
  });

  it('flags plain http', async () => {
    const checks = await checkResourceServer('http://api.example.com/v1/orders', async () => new Response('', { status: 401 }));
    expect(failing(checks)).toContain('https');
  });
});
