import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishActiveAtlas, type ActiveAtlas } from './active-atlas';
import {
  auth0UserFrom,
  betterAuthSessionFrom,
  createBetterAuthCompatClient,
  getNextAuthSession,
  getSupabaseSessionCompat,
  getSupabaseUserCompat,
  nextAuthSessionFrom,
  nextAuthSignIn,
  nextAuthSignOut,
  onSupabaseAuthStateChangeCompat,
  supabaseSignInWithOAuthCompat,
  supabaseSignOutCompat,
  supabaseUserFrom,
} from './compat';
import type { AtlasUser, SessionClaims } from './types';

const user: AtlasUser = {
  id: 'user_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: 'ada',
  image_url: 'https://img.test/ada.png',
  public_metadata: { plan: 'pro' },
  unsafe_metadata: { theme: 'dark' },
  mfa_enabled: false,
  has_password: true,
  email_addresses: [
    { id: 'idn_2', email_address: 'old@ada.test', verified: false, primary: false },
    { id: 'idn_1', email_address: 'ada@ada.test', verified: true, primary: true },
  ],
  phone_numbers: [{ id: 'idn_3', phone_number: '+15550100', verified: true, primary: true }],
};
const claims: SessionClaims = { sub: 'user_1', sid: 'sess_1', exp: 2_000_000_000, org_id: 'org_1' };

function provider(over: Partial<ActiveAtlas> = {}): ActiveAtlas & { signOut: ReturnType<typeof vi.fn> } {
  return {
    status: 'signed_in',
    user,
    claims,
    getToken: async () => 'jwt.token.value',
    signOut: vi.fn(async () => ({ revoked: true })),
    reload: async () => true,
    ...over,
  } as ActiveAtlas & { signOut: ReturnType<typeof vi.fn> };
}

const assign = vi.fn();
function stubWindow() {
  vi.stubGlobal('window', { location: { assign, replace: assign, href: 'https://app.test/now' } });
}

afterEach(() => {
  publishActiveAtlas(null);
  assign.mockReset();
  vi.unstubAllGlobals();
});

describe('next-auth compat', () => {
  it('projects a signed-in user onto { data, status }', () => {
    const out = nextAuthSessionFrom({ status: 'signed_in', user, claims });
    expect(out.status).toBe('authenticated');
    expect(out.data).toEqual({
      user: { id: 'user_1', name: 'Ada Lovelace', email: 'ada@ada.test', image: 'https://img.test/ada.png' },
      expires: new Date(2_000_000_000_000).toISOString(),
    });
  });

  it('reports loading and unauthenticated like next-auth', () => {
    expect(nextAuthSessionFrom({ status: 'loading', user: null, claims: null })).toEqual({ data: null, status: 'loading' });
    expect(nextAuthSessionFrom({ status: 'signed_out', user: null, claims: null })).toEqual({
      data: null,
      status: 'unauthenticated',
    });
  });

  it('getSession / signIn / signOut act on the mounted provider', async () => {
    stubWindow();
    const p = provider();
    publishActiveAtlas(p);
    expect((await getNextAuthSession())?.user.email).toBe('ada@ada.test');

    await nextAuthSignIn('github', { callbackUrl: '/dashboard' });
    expect(assign).toHaveBeenLastCalledWith('/sign-in?redirect_url=%2Fdashboard');

    await nextAuthSignOut({ callbackUrl: '/bye' });
    expect(p.signOut).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenLastCalledWith('/bye');

    await nextAuthSignOut({ redirect: false });
    expect(assign).toHaveBeenCalledTimes(2);
  });

  it('fails clearly with no provider mounted', async () => {
    await expect(getNextAuthSession()).rejects.toThrow(/no <AtlasProvider> is mounted/);
  });
});

describe('auth0 compat', () => {
  it('maps the user onto the OIDC profile shape', () => {
    expect(auth0UserFrom(user, claims)).toEqual({
      sub: 'user_1',
      name: 'Ada Lovelace',
      given_name: 'Ada',
      family_name: 'Lovelace',
      nickname: 'ada',
      picture: 'https://img.test/ada.png',
      email: 'ada@ada.test',
      email_verified: true,
      org_id: 'org_1',
    });
    expect(auth0UserFrom(null)).toBeUndefined();
  });

  it('omits fields the user does not have', () => {
    const bare = { ...user, first_name: null, last_name: null, username: null, image_url: null, email_addresses: [] };
    expect(auth0UserFrom(bare)).toEqual({ sub: 'user_1' });
  });
});

describe('supabase compat', () => {
  it('maps the user onto the supabase User shape', () => {
    const out = supabaseUserFrom(user)!;
    expect(out.id).toBe('user_1');
    expect(out.aud).toBe('authenticated');
    expect(out.email).toBe('ada@ada.test');
    expect(out.phone).toBe('+15550100');
    expect(out.user_metadata).toMatchObject({ theme: 'dark', full_name: 'Ada Lovelace', avatar_url: 'https://img.test/ada.png' });
    expect(out.app_metadata).toEqual({ plan: 'pro' });
  });

  it('getUser / getSession / signOut resolve supabase-style { data, error }', async () => {
    const p = provider();
    publishActiveAtlas(p);
    expect((await getSupabaseUserCompat()).data.user?.id).toBe('user_1');
    const session = await getSupabaseSessionCompat();
    expect(session.data.session?.access_token).toBe('jwt.token.value');
    expect(session.error).toBeNull();
    expect(await supabaseSignOutCompat()).toEqual({ error: null });
    expect(p.signOut).toHaveBeenCalled();
  });

  it('getSession is null when signed out', async () => {
    publishActiveAtlas(provider({ status: 'signed_out', user: null, claims: null }));
    expect((await getSupabaseSessionCompat()).data.session).toBeNull();
    expect((await getSupabaseUserCompat()).data.user).toBeNull();
  });

  it('signInWithOAuth opens the sign-in page with the redirect', async () => {
    stubWindow();
    const res = await supabaseSignInWithOAuthCompat({ provider: 'github', options: { redirectTo: '/app' } });
    expect(res.data.url).toBe('/sign-in?redirect_url=%2Fapp');
    expect(assign).toHaveBeenCalledWith('/sign-in?redirect_url=%2Fapp');
  });

  it('onAuthStateChange emits INITIAL_SESSION, SIGNED_OUT, SIGNED_IN, USER_UPDATED and unsubscribes', () => {
    const events: string[] = [];
    publishActiveAtlas(provider());
    const { data } = onSupabaseAuthStateChangeCompat((event) => events.push(event));
    publishActiveAtlas(provider({ status: 'signed_out', user: null, claims: null }));
    publishActiveAtlas(provider({ status: 'loading', user: null, claims: null }));
    publishActiveAtlas(provider());
    publishActiveAtlas(provider()); // same user object: a token refresh, no event
    publishActiveAtlas(provider({ user: { ...user, first_name: 'Augusta' } }));
    data.subscription.unsubscribe();
    publishActiveAtlas(provider({ status: 'signed_out', user: null, claims: null }));
    expect(events).toEqual(['INITIAL_SESSION', 'SIGNED_OUT', 'SIGNED_IN', 'USER_UPDATED']);
  });
});

describe('better-auth compat', () => {
  it('projects the session pair', () => {
    const out = betterAuthSessionFrom({ status: 'signed_in', user, claims })!;
    expect(out.user).toEqual({
      id: 'user_1',
      email: 'ada@ada.test',
      emailVerified: true,
      name: 'Ada Lovelace',
      image: 'https://img.test/ada.png',
    });
    expect(out.session).toMatchObject({ id: 'sess_1', userId: 'user_1', activeOrganizationId: 'org_1' });
    expect(betterAuthSessionFrom({ status: 'signed_out', user: null, claims: null })).toBeNull();
  });

  it('the client keeps the createAuthClient() member shape', async () => {
    stubWindow();
    const p = provider();
    publishActiveAtlas(p);
    const client = createBetterAuthCompatClient({ baseURL: 'https://ignored.test', signUpUrl: '/register' });
    expect((await client.getSession()).data?.user.id).toBe('user_1');
    await client.signIn.social({ provider: 'github', callbackURL: '/home' });
    expect(assign).toHaveBeenLastCalledWith('/sign-in?redirect_url=%2Fhome');
    await client.signUp.email({});
    expect(assign).toHaveBeenLastCalledWith('/register');
    const onSuccess = vi.fn();
    expect(await client.signOut({ fetchOptions: { onSuccess } })).toEqual({ data: { success: true }, error: null });
    expect(onSuccess).toHaveBeenCalled();
    expect(typeof client.useSession).toBe('function');
  });
});
