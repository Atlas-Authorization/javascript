import { afterEach, describe, expect, it, vi } from 'vitest';
import { publishActiveAtlas, type ActiveAtlas } from './active-atlas';
import {
  AmplifyCompatUnauthenticatedError,
  amplifyAttributesFrom,
  amplifyAuthV5Compat,
  amplifyFetchAuthSessionCompat,
  amplifyFetchUserAttributesCompat,
  amplifyGetCurrentUserCompat,
  amplifyHubListenCompat,
  amplifySignOutCompat,
  AppwriteAccountCompat,
  AppwriteCompatException,
  firebaseSignInWithRedirectCompat,
  firebaseSignOutCompat,
  firebaseUserFrom,
  getFirebaseCurrentUserCompat,
  getFirebaseIdTokenCompat,
  MsalCompatClient,
  MsalCompatInteractionRequiredError,
  nhostAuthCompat,
  onFirebaseAuthStateChangedCompat,
  onFirebaseIdTokenChangedCompat,
  pocketbaseAuthStoreCompat,
} from './compat';
import type { AtlasUser, SessionClaims } from './types';

const user: AtlasUser = {
  id: 'user_1',
  first_name: 'Ada',
  last_name: 'Lovelace',
  username: 'ada',
  image_url: 'https://img.test/ada.png',
  public_metadata: { plan: 'pro', firebase_uid: 'fb-uid-1', nhost_roles: ['user', 'editor'], nhost_default_role: 'editor' },
  unsafe_metadata: { theme: 'dark' },
  mfa_enabled: false,
  has_password: true,
  email_addresses: [{ id: 'idn_1', email_address: 'ada@ada.test', verified: true, primary: true }],
  phone_numbers: [{ id: 'idn_3', phone_number: '+15550100', verified: true, primary: true }],
};
const claims: SessionClaims = { sub: 'user_1', sid: 'sess_1', exp: 2_000_000_000, iat: 1_999_999_000 };
// header.payload.sig with payload {"sub":"user_1"}
const TOKEN = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJ1c2VyXzEifQ.sig';

function provider(over: Partial<ActiveAtlas> = {}): ActiveAtlas & { signOut: ReturnType<typeof vi.fn> } {
  return {
    status: 'signed_in',
    user,
    claims,
    getToken: async () => TOKEN,
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

describe('Firebase', () => {
  it('projects the user onto Firebase User fields', async () => {
    const atlas = provider();
    publishActiveAtlas(atlas);
    const u = firebaseUserFrom(user, atlas)!;
    expect(u).toMatchObject({
      uid: 'user_1',
      firebaseUid: 'fb-uid-1',
      email: 'ada@ada.test',
      emailVerified: true,
      displayName: 'Ada Lovelace',
      photoURL: 'https://img.test/ada.png',
      phoneNumber: '+15550100',
      isAnonymous: false,
    });
    expect(await u.getIdToken()).toBe(TOKEN);
    expect((await u.getIdTokenResult()).claims).toMatchObject({ sub: 'user_1' });
    expect(u.toJSON()).not.toHaveProperty('getIdToken');
    expect(firebaseUserFrom(null)).toBeNull();
  });

  it('onAuthStateChanged fires on sign-in and sign-out only; onIdTokenChanged also on refresh', () => {
    publishActiveAtlas(provider());
    const auth = vi.fn();
    const token = vi.fn();
    const stopAuth = onFirebaseAuthStateChangedCompat({}, auth);
    const stopToken = onFirebaseIdTokenChangedCompat({}, { next: token });
    expect(auth).toHaveBeenCalledTimes(1);
    expect(auth.mock.calls[0]![0]).toMatchObject({ uid: 'user_1' });
    publishActiveAtlas(provider({ claims: { ...claims, exp: 2_000_000_600 } }));
    expect(auth).toHaveBeenCalledTimes(1);
    expect(token).toHaveBeenCalledTimes(2);
    publishActiveAtlas(provider({ status: 'signed_out', user: null, claims: null }));
    expect(auth).toHaveBeenLastCalledWith(null);
    stopAuth();
    stopToken();
    publishActiveAtlas(provider());
    expect(auth).toHaveBeenCalledTimes(2);
  });

  it('signOut, getIdToken, currentUser, signInWithRedirect', async () => {
    stubWindow();
    const atlas = provider();
    publishActiveAtlas(atlas);
    expect(await getFirebaseIdTokenCompat({})).toBe(TOKEN);
    expect(getFirebaseCurrentUserCompat()?.uid).toBe('user_1');
    await firebaseSignOutCompat({});
    expect(atlas.signOut).toHaveBeenCalled();
    await firebaseSignInWithRedirectCompat({}, {});
    expect(assign).toHaveBeenCalledWith(`/sign-in?redirect_url=${encodeURIComponent('https://app.test/now')}`);
    publishActiveAtlas(provider({ status: 'signed_out', user: null, getToken: async () => null }));
    await expect(getFirebaseIdTokenCompat()).rejects.toThrow(/signed out/);
    expect(getFirebaseCurrentUserCompat()).toBeNull();
  });
});

describe('Amplify', () => {
  it('getCurrentUser / fetchAuthSession / fetchUserAttributes', async () => {
    publishActiveAtlas(provider());
    expect(await amplifyGetCurrentUserCompat()).toEqual({ username: 'ada', userId: 'user_1', signInDetails: { loginId: 'ada@ada.test' } });
    const session = await amplifyFetchAuthSessionCompat();
    expect(session.tokens!.idToken!.toString()).toBe(TOKEN);
    expect(session.tokens!.accessToken.payload).toEqual({ sub: 'user_1' });
    expect(session.userSub).toBe('user_1');
    expect(await amplifyFetchUserAttributesCompat()).toMatchObject({
      sub: 'user_1',
      email: 'ada@ada.test',
      email_verified: 'true',
      given_name: 'Ada',
      family_name: 'Lovelace',
      'custom:plan': 'pro',
    });
  });

  it('throws UserUnAuthenticatedException when signed out; fetchAuthSession resolves {}', async () => {
    publishActiveAtlas(provider({ status: 'signed_out', user: null }));
    await expect(amplifyGetCurrentUserCompat()).rejects.toBeInstanceOf(AmplifyCompatUnauthenticatedError);
    await expect(amplifyGetCurrentUserCompat()).rejects.toMatchObject({ name: 'UserUnAuthenticatedException' });
    expect(await amplifyFetchAuthSessionCompat()).toEqual({});
  });

  it('Hub.listen("auth") emits signedIn / tokenRefresh / signedOut', () => {
    publishActiveAtlas(provider({ status: 'signed_out', user: null, claims: null }));
    const events: string[] = [];
    const stop = amplifyHubListenCompat('auth', ({ payload }) => events.push(payload.event));
    publishActiveAtlas(provider());
    publishActiveAtlas(provider({ claims: { ...claims, exp: 2_000_000_900 } }));
    publishActiveAtlas(provider({ status: 'signed_out', user: null, claims: null }));
    stop();
    expect(events).toEqual(['signedIn', 'tokenRefresh', 'signedOut']);
    expect(amplifyHubListenCompat('storage', () => undefined)).toBeTypeOf('function');
  });

  it('v5 Auth readers and signOut', async () => {
    const atlas = provider();
    publishActiveAtlas(atlas);
    expect(await amplifyAuthV5Compat.currentAuthenticatedUser()).toMatchObject({ username: 'ada', attributes: { email: 'ada@ada.test' } });
    expect((await amplifyAuthV5Compat.currentSession()).getIdToken().getJwtToken()).toBe(TOKEN);
    await amplifySignOutCompat();
    expect(atlas.signOut).toHaveBeenCalled();
    expect(amplifyAttributesFrom(user).phone_number_verified).toBe('true');
  });
});

describe('MSAL', () => {
  it('accounts and acquireTokenSilent from the Atlas session', async () => {
    publishActiveAtlas(provider());
    const msal = new MsalCompatClient({ auth: { clientId: 'x' } });
    await msal.initialize();
    expect(await msal.handleRedirectPromise()).toBeNull();
    const [account] = msal.getAllAccounts();
    expect(account).toMatchObject({ localAccountId: 'user_1', username: 'ada@ada.test', name: 'Ada Lovelace' });
    expect(msal.getAccountByUsername('ADA@ada.test')?.homeAccountId).toBe('user_1');
    const result = await msal.acquireTokenSilent({ scopes: ['api://x/read'], account });
    expect(result).toMatchObject({ accessToken: TOKEN, idToken: TOKEN, scopes: ['api://x/read'], tokenType: 'Bearer' });
    expect(result.expiresOn?.getTime()).toBe(2_000_000_000_000);
  });

  it('signed out: no accounts, acquireTokenSilent requires interaction, loginRedirect opens sign-in', async () => {
    stubWindow();
    publishActiveAtlas(provider({ status: 'signed_out', user: null, getToken: async () => null }));
    const msal = new MsalCompatClient();
    expect(msal.getAllAccounts()).toEqual([]);
    await expect(msal.acquireTokenSilent({ scopes: [] })).rejects.toBeInstanceOf(MsalCompatInteractionRequiredError);
    await msal.loginRedirect({ redirectStartPage: 'https://app.test/after' });
    expect(assign).toHaveBeenCalledWith(`/sign-in?redirect_url=${encodeURIComponent('https://app.test/after')}`);
  });

  it('logoutRedirect signs out, then goes to postLogoutRedirectUri', async () => {
    stubWindow();
    const atlas = provider();
    publishActiveAtlas(atlas);
    await new MsalCompatClient().logoutRedirect({ postLogoutRedirectUri: '/bye' });
    expect(atlas.signOut).toHaveBeenCalled();
    expect(assign).toHaveBeenCalledWith('/bye');
  });
});

describe('Appwrite', () => {
  it('account.get / createJWT / deleteSession("current")', async () => {
    const atlas = provider();
    publishActiveAtlas(atlas);
    const account = new AppwriteAccountCompat({});
    expect(await account.get()).toMatchObject({ $id: 'user_1', email: 'ada@ada.test', emailVerification: true, name: 'Ada Lovelace', prefs: { theme: 'dark' } });
    expect(await account.createJWT()).toEqual({ jwt: TOKEN });
    await account.deleteSession('current');
    expect(atlas.signOut).toHaveBeenCalled();
    await expect(account.deleteSession('other-id')).rejects.toThrow(/sessions/);
  });

  it('credential methods point at the Atlas pages; signed-out get() throws like Appwrite', async () => {
    publishActiveAtlas(provider({ status: 'signed_out', user: null }));
    const account = new AppwriteAccountCompat();
    await expect(account.get()).rejects.toBeInstanceOf(AppwriteCompatException);
    await expect(account.createEmailPasswordSession('a@b.co', 'pw')).rejects.toThrow(/Atlas sign-in page/);
    await expect(account.create('id', 'a@b.co', 'pw')).rejects.toThrow(/sign-up/);
  });
});

describe('PocketBase', () => {
  it('authStore reads the Atlas session', async () => {
    const atlas = provider();
    publishActiveAtlas(atlas);
    expect(pocketbaseAuthStoreCompat.isValid).toBe(true);
    expect(pocketbaseAuthStoreCompat.record).toMatchObject({ id: 'user_1', email: 'ada@ada.test', verified: true, username: 'ada' });
    expect(pocketbaseAuthStoreCompat.model?.id).toBe('user_1');
    expect(await pocketbaseAuthStoreCompat.getToken()).toBe(TOKEN);
    pocketbaseAuthStoreCompat.clear();
    expect(atlas.signOut).toHaveBeenCalled();
  });

  it('onChange fires on transitions (and immediately when asked)', async () => {
    publishActiveAtlas(provider());
    const seen: Array<string | null> = [];
    const stop = pocketbaseAuthStoreCompat.onChange((_t, record) => seen.push(record?.id ?? null), true);
    await Promise.resolve();
    await Promise.resolve();
    publishActiveAtlas(provider({ status: 'signed_out', user: null }));
    await Promise.resolve();
    await Promise.resolve();
    stop();
    expect(seen).toEqual(['user_1', null]);
  });
});

describe('Nhost', () => {
  it('auth session readers', async () => {
    const atlas = provider();
    publishActiveAtlas(atlas);
    expect(nhostAuthCompat.isAuthenticated()).toBe(true);
    expect(await nhostAuthCompat.isAuthenticatedAsync()).toBe(true);
    expect(nhostAuthCompat.getUser()).toMatchObject({ id: 'user_1', email: 'ada@ada.test', defaultRole: 'editor', roles: ['user', 'editor'] });
    expect(await nhostAuthCompat.getAccessToken()).toBe(TOKEN);
    expect((await nhostAuthCompat.getSession())?.accessToken).toBe(TOKEN);
    expect(await nhostAuthCompat.signOut()).toEqual({ error: null });
    expect(atlas.signOut).toHaveBeenCalled();
  });

  it('isAuthenticatedAsync waits for the provider to finish loading', async () => {
    publishActiveAtlas(provider({ status: 'loading', user: null }));
    const pending = nhostAuthCompat.isAuthenticatedAsync();
    publishActiveAtlas(provider({ status: 'signed_out', user: null }));
    expect(await pending).toBe(false);
  });

  it('onAuthStateChanged reports SIGNED_IN then SIGNED_OUT', () => {
    publishActiveAtlas(provider());
    const events: string[] = [];
    const stop = nhostAuthCompat.onAuthStateChanged((event) => events.push(event));
    publishActiveAtlas(provider({ status: 'signed_out', user: null }));
    stop();
    expect(events).toEqual(['SIGNED_IN', 'SIGNED_OUT']);
  });
});
