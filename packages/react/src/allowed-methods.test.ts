// @vitest-environment happy-dom
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AtlasProvider } from './AtlasProvider';
import { SignIn } from './sign-in';
import type { FlowProps } from './flow';
import { runSignedIn, tokenIds } from './signed-in';
import { parseAllowedMethods } from './allowed-methods';

const environment = {
  first_factors: ['password'],
  strategies: { password: true },
  email_delivery: { available: true, password_reset: true, password_sign_up: true },
  social_providers: [
    { provider: 'github', native: false, mode: 'redirect', label: null, display_name: 'GitHub', icon: null, allow_sign_in: true, allow_sign_up: true },
    { provider: 'discord', native: false, mode: 'redirect', label: null, display_name: 'Discord', icon: null, allow_sign_in: true, allow_sign_up: true },
  ],
};
const appearance = { object: 'appearance', appearance: { legal: { termsUrl: null, privacyUrl: null, required: false }, signUpFields: [] }, captchaFlows: {}, email_delivery: environment.email_delivery };

function html(allowedMethods?: string[]) {
  return renderToString(
    createElement(AtlasProvider, {
      publishableKey: 'pk_test_x',
      frontendApi: 'https://fapi.example',
      initialState: { appearance, environment },
      children: createElement<FlowProps>(SignIn, { allowedMethods }),
    }),
  );
}

describe('<SignIn allowedMethods>', () => {
  it('offers every provider without a filter', () => {
    const out = html();
    expect(out).toContain('data-atlas-provider="github"');
    expect(out).toContain('data-atlas-provider="discord"');
  });
  it('keeps only the named provider', () => {
    const out = html(['password', 'oauth_github']);
    expect(out).toContain('data-atlas-provider="github"');
    expect(out).not.toContain('data-atlas-provider="discord"');
  });
  it('the oauth family keeps all providers; a list without them keeps none', () => {
    expect(html(['oauth'])).toContain('data-atlas-provider="discord"');
    expect(html(['passkey'])).not.toContain('data-atlas-provider="github"');
  });
});

describe('tokenIds', () => {
  const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;
  it('reads sid and sub, and is empty for anything else', () => {
    expect(tokenIds(jwt({ sid: 'sess_1', sub: 'user_1' }))).toEqual({ sid: 'sess_1', sub: 'user_1' });
    expect(tokenIds(null)).toEqual({ sid: '', sub: '' });
    expect(tokenIds('garbage')).toEqual({ sid: '', sub: '' });
  });
});

describe('runSignedIn', () => {
  const jwt = `h.${Buffer.from(JSON.stringify({ sid: 'sess_1', sub: 'user_1' })).toString('base64url')}.s`;
  const getToken = async () => jwt;
  const answer = (status: number) => (async () => new Response('{}', { status })) as unknown as typeof fetch;

  it('does nothing without exchange or onSignedIn', async () => {
    expect(await runSignedIn({ getToken })).toEqual({ failed: false });
  });
  it('POSTs the token once, then awaits onSignedIn and passes its URL on', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const seen: unknown[] = [];
    const out = await runSignedIn({
      exchange: '/api/auth/atlas/session',
      getToken,
      fetchImpl,
      onSignedIn: async (ctx) => {
        seen.push(ctx.sessionId, ctx.userId);
        return '/dashboard';
      },
    });
    expect(out).toEqual({ failed: false, url: '/dashboard' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('/api/auth/atlas/session');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ token: jwt });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${jwt}`);
    expect(seen).toEqual(['sess_1', 'user_1']);
  });
  it('a non-2xx exchange fails and never reaches onSignedIn', async () => {
    let reached = false;
    const out = await runSignedIn({ exchange: '/x', getToken, fetchImpl: answer(500), onSignedIn: async () => { reached = true; } });
    expect(out.failed).toBe(true);
    expect(reached).toBe(false);
  });
  it('a throwing onSignedIn fails; a blank string keeps afterUrl', async () => {
    expect((await runSignedIn({ getToken, onSignedIn: async () => { throw new Error('x'); } })).failed).toBe(true);
    expect(await runSignedIn({ getToken, onSignedIn: async () => '  ' })).toEqual({ failed: false, url: undefined });
  });
});

describe('parseAllowedMethods', () => {
  it('a list is UI only; a signed token also names what to send to the server', () => {
    expect(parseAllowedMethods(['passkey'])).toEqual({ list: ['passkey'], token: null });
    expect(parseAllowedMethods('oauth_google,passkey.sig-1_x')).toEqual({ list: ['oauth_google', 'passkey'], token: 'oauth_google,passkey.sig-1_x' });
    expect(parseAllowedMethods([])).toBeNull();
    expect(parseAllowedMethods('nodot')).toBeNull();
    expect(parseAllowedMethods(undefined)).toBeNull();
  });
  it('a token drives the panel too', () => {
    const out = renderToString(
      createElement(AtlasProvider, {
        publishableKey: 'pk_test_x',
        frontendApi: 'https://fapi.example',
        initialState: { appearance, environment },
        children: createElement<FlowProps>(SignIn, { allowedMethods: 'oauth_github.sig' }),
      }),
    );
    expect(out).toContain('data-atlas-provider="github"');
    expect(out).not.toContain('data-atlas-provider="discord"');
  });
});
