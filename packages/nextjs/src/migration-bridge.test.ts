import { describe, expect, it, vi } from 'vitest';
import { createAtlasDecider } from './middleware';

const ISSUER = 'https://fapi.atlas.test';
const JWKS_URL = `${ISSUER}/.well-known/jwks.json`;

function fapi(answer: { status: number; body: unknown }) {
  const exchanges: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/exchange')) {
      exchanges.push({ url: url.toString(), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(answer.body), { status: answer.status });
    }
    return new Response(JSON.stringify({ keys: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { fetchImpl, exchanges };
}

const req = (path: string, cookie: string, method = 'GET') => ({
  method,
  url: `https://app.example.com${path}`,
  nextUrl: { pathname: path.split('?')[0]! },
  headers: { get: (n: string) => (n.toLowerCase() === 'cookie' ? cookie : null) },
});

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
const jwt = (claims: Record<string, unknown>) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(claims))}.sig`;

const base = { jwksUrl: JWKS_URL, issuer: ISSUER, publishableKey: 'pk_test_x', publicRoutes: ['/(.*)'] };
const CLERK = { source: 'clerk', presetVars: { frontend_api: 'clerk.example.com' } };

describe('migrationBridge (Next.js middleware)', () => {
  it("exchanges a Clerk __session at the clerk path and re-enters with the Atlas session", async () => {
    const { fetchImpl, exchanges } = fapi({ status: 200, body: { object: 'session_tokens', jwt: 'jwt1', refresh_token: 'rt1' } });
    const decide = createAtlasDecider({ ...base, fetchImpl, migrationBridge: CLERK });
    const old = jwt({ iss: 'https://clerk.example.com', sub: 'user_2x', sid: 'sess_1' });
    const out = await decide(req('/app?x=1', `__session=${old}; __client_uat=1`));
    expect(exchanges).toEqual([{ url: 'https://fapi.atlas.test/v1/client/migrations/clerk/exchange', body: { token: old, delivery: 'body' } }]);
    expect(out.kind).toBe('redirect');
    if (out.kind !== 'redirect') return;
    expect(out.location).toBe('https://app.example.com/app?x=1');
    expect(out.cookies.filter((c) => c.name === '__session').map((c) => c.value)).toEqual(['jwt1']);
  });

  it("leaves Atlas's own __session and non-GET requests alone", async () => {
    const { fetchImpl, exchanges } = fapi({ status: 200, body: {} });
    const decide = createAtlasDecider({ ...base, fetchImpl, migrationBridge: CLERK });
    await decide(req('/', `__session=${jwt({ iss: ISSUER, sub: 'user_1' })}`));
    await decide(req('/api', `__session=${jwt({ iss: 'https://clerk.example.com' })}`, 'POST'));
    expect(exchanges).toHaveLength(0);
  });

  it('owed MFA → the sign-in URL; a closed bridge continues', async () => {
    const mfa = fapi({ status: 200, body: { object: 'sign_in_attempt', id: 'sia_7', status: 'needs_second_factor' } });
    const out = await createAtlasDecider({ ...base, fetchImpl: mfa.fetchImpl, migrationBridge: { source: 'lucia', signInUrl: '/sign-in' } })(req('/app', 'auth_session=s'));
    expect(out.kind === 'redirect' && out.location).toBe('https://app.example.com/sign-in?__atlas_attempt=sia_7&__atlas_status=needs_second_factor');
    const closed = fapi({ status: 403, body: { errors: [{ meta: { bridge_outcome: 'closed' } }] } });
    const kept = await createAtlasDecider({ ...base, fetchImpl: closed.fetchImpl, migrationBridge: { source: 'lucia' } })(req('/', 'auth_session=s'));
    expect(kept.kind).toBe('continue');
  });

  it('runs after the Better Auth bridge, and needs a publishable key', async () => {
    const { fetchImpl, exchanges } = fapi({ status: 403, body: { errors: [{ meta: { bridge_outcome: 'closed' } }] } });
    const decide = createAtlasDecider({ ...base, fetchImpl, betterAuthBridge: true, migrationBridge: { source: 'lucia' } });
    await decide(req('/', 'better-auth.session_token=t; auth_session=s'));
    expect(exchanges.map((e) => new URL(e.url).pathname)).toEqual(['/v1/client/migrations/better_auth/exchange', '/v1/client/migrations/lucia/exchange']);
    expect(() => createAtlasDecider({ jwksUrl: JWKS_URL, issuer: ISSUER, migrationBridge: { source: 'lucia' } })).toThrow(/publishableKey/);
  });
});
