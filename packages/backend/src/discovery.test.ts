import { describe, expect, it, vi } from 'vitest';
import { AtlasBackend } from './verify';
import { createTestIssuer } from './testing';
import { discoveryUrlFor, instanceIdFromPublishableKey, JwksDiscovery } from './discovery';
import { REFETCH_INTERVAL_MS } from './jwks-cache';

/**
 * `new AtlasBackend({ issuer })` with no `jwksUrl` discovers the JWKS URL from
 * the issuer's OIDC discovery document — and, for an instance on the SHARED host
 * (whose tokens carry the shared issuer), from the per-instance document, since
 * the shared host's root document describes a different instance's keys.
 */

type Route = (url: string) => Response | Promise<Response>;

function server(routes: Record<string, Route>) {
  const impl = vi.fn(async (input: unknown) => {
    const url = String(input);
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route(url);
  });
  return impl as unknown as typeof fetch & { mock: { calls: unknown[][] } };
}

const json = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });
const urlsCalled = (impl: { mock: { calls: unknown[][] } }) => impl.mock.calls.map((c) => String(c[0]));

describe('JWKS discovery from the issuer', () => {
  it('verifies with only { issuer }: discovery → jwks_uri → keys', async () => {
    const fx = await createTestIssuer({ issuer: 'https://acme.clerk-like.test' });
    const fetchImpl = server({
      'https://acme.clerk-like.test/.well-known/openid-configuration': json({
        issuer: 'https://acme.clerk-like.test',
        jwks_uri: 'https://acme.clerk-like.test/.well-known/jwks.json',
      }),
      'https://acme.clerk-like.test/.well-known/jwks.json': json(fx.jwks),
    });
    const atlas = new AtlasBackend({ issuer: fx.issuer, fetchImpl });

    const result = await atlas.verify(await fx.mintSession({ sub: 'user_d' }));
    expect(result.ok).toBe(true);

    // A second verify is fully cached: no further network calls.
    await atlas.verify(await fx.mintSession({ sub: 'user_d2' }));
    expect(urlsCalled(fetchImpl)).toEqual([
      'https://acme.clerk-like.test/.well-known/openid-configuration',
      'https://acme.clerk-like.test/.well-known/jwks.json',
    ]);
  });

  it('accepts a trailing slash on the configured issuer', () => {
    expect(discoveryUrlFor('https://a.test/')).toBe('https://a.test/.well-known/openid-configuration');
  });

  /**
   * The shared host: tokens carry iss = the shared origin, but the root
   * discovery document there describes ANOTHER instance's key set. With an
   * instance id (or publishable key), discovery uses the per-instance document,
   * whose issuer still equals the token's iss and whose jwks_uri is this
   * instance's keys — so its tokens verify, and the root keys are never used.
   */
  it('uses the per-instance document for a shared-host instance', async () => {
    const shared = 'https://shared.atlas.test';
    const mine = await createTestIssuer({ issuer: shared });
    const other = await createTestIssuer({ issuer: shared });
    const fetchImpl = server({
      [`${shared}/.well-known/openid-configuration`]: json({
        issuer: shared,
        jwks_uri: `${shared}/.well-known/jwks.json`,
      }),
      [`${shared}/.well-known/jwks.json`]: json(other.jwks),
      [`${shared}/instances/ins_01ABC/.well-known/openid-configuration`]: json({
        issuer: shared,
        jwks_uri: `https://api.atlas.test/instances/ins_01ABC/.well-known/jwks.json`,
      }),
      ['https://api.atlas.test/instances/ins_01ABC/.well-known/jwks.json']: json(mine.jwks),
    });

    const atlas = new AtlasBackend({ issuer: shared, publishableKey: 'pk_live_ins_01ABC', fetchImpl });
    expect((await atlas.verify(await mine.mintSession())).ok).toBe(true);
    // A token signed with the root (other instance's) key does not verify.
    expect((await atlas.verify(await other.mintSession())).ok).toBe(false);
    expect(urlsCalled(fetchImpl)).not.toContain(`${shared}/.well-known/jwks.json`);
  });

  it('reads the instance id from a publishable key', () => {
    expect(instanceIdFromPublishableKey('pk_test_ins_01J9ZX')).toBe('ins_01J9ZX');
    expect(instanceIdFromPublishableKey('pk_live_somethingelse')).toBeUndefined();
    expect(() => new AtlasBackend({ issuer: 'https://a.test', publishableKey: 'pk_live_nope' })).toThrow(
      /instance id/,
    );
  });

  it('refuses a discovery document for a different issuer, with a clear detail', async () => {
    const fetchImpl = server({
      'https://a.test/.well-known/openid-configuration': json({
        issuer: 'https://evil.test',
        jwks_uri: 'https://evil.test/jwks.json',
      }),
    });
    const fx = await createTestIssuer({ issuer: 'https://a.test' });
    const atlas = new AtlasBackend({ issuer: 'https://a.test', fetchImpl });
    const result = await atlas.verify(await fx.mintSession());
    expect(result).toMatchObject({ ok: false, reason: 'no_keys' });
    if (!result.ok) expect(result.detail).toMatch(/does not match the configured issuer/);
    expect(urlsCalled(fetchImpl)).not.toContain('https://evil.test/jwks.json');
  });

  it('reports a failed discovery and retries at most once a minute', async () => {
    let now = 1_000_000;
    const fetchImpl = server({});
    const discovery = new JwksDiscovery({ issuer: 'https://down.test', fetchImpl, now: () => now });
    await expect(discovery.jwksUri()).rejects.toThrow(/HTTP 404.*jwksUrl/);
    await expect(discovery.jwksUri()).rejects.toThrow(/HTTP 404/);
    expect(fetchImpl.mock.calls.length).toBe(1);
    now += REFETCH_INTERVAL_MS;
    await expect(discovery.jwksUri()).rejects.toThrow();
    expect(fetchImpl.mock.calls.length).toBe(2);
  });

  it('refuses a non-https jwks_uri', async () => {
    const fetchImpl = server({
      'https://a.test/.well-known/openid-configuration': json({ issuer: 'https://a.test', jwks_uri: 'http://a.test/jwks' }),
    });
    await expect(new JwksDiscovery({ issuer: 'https://a.test', fetchImpl }).jwksUri()).rejects.toThrow(/not https/);
  });

  it('keeps serving the last good jwks_uri through a discovery outage', async () => {
    let now = 0;
    let up = true;
    const fetchImpl = vi.fn(async () =>
      up
        ? new Response(JSON.stringify({ issuer: 'https://a.test', jwks_uri: 'https://a.test/jwks.json' }), { status: 200 })
        : new Response('down', { status: 503 }),
    ) as unknown as typeof fetch;
    const discovery = new JwksDiscovery({ issuer: 'https://a.test', fetchImpl, now: () => now, ttlMs: 1000 });
    expect(await discovery.jwksUri()).toBe('https://a.test/jwks.json');
    up = false;
    now += 2000;
    expect(await discovery.jwksUri()).toBe('https://a.test/jwks.json');
  });
});
