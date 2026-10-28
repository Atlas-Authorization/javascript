'use client';

/**
 * Appwrite, PocketBase and Nhost compatibility helpers, for
 * `atlas migrate code --from appwrite|pocketbase|nhost`. These backends keep
 * serving your data; only their AUTH surface moves to Atlas:
 *
 *  - Appwrite: `new Account(client)` → `AppwriteAccountCompat` (`get`,
 *    `getPrefs`, `deleteSession`, `deleteSessions`, `createJWT`,
 *    `createOAuth2Session`); credential methods throw with a pointer to the
 *    Atlas sign-in page, and the codemod marks each call site.
 *  - PocketBase: `pb.authStore` → `pocketbaseAuthStoreCompat` (`isValid`,
 *    `token`, `record`/`model`, `clear`, `onChange`).
 *  - Nhost: `@nhost/react` hooks → `useNhost…Compat`, and `nhost.auth.*`
 *    session readers → `nhostAuthCompat`.
 *
 * Ids are ATLAS user ids; the old vendor id is the user's external id.
 */
import { useAtlas } from './AtlasProvider';
import { navigateTo, withRedirect } from './components-shared';
import { displayName, primaryEmail } from './compat';
import type { AtlasUser } from './types';
import { getActiveAtlas, onActiveAtlasChange, requireActive, type ActiveAtlas } from './active-atlas';

function signedInUser(atlas: ActiveAtlas | null): AtlasUser | null {
  return atlas?.status === 'signed_in' ? atlas.user : null;
}

function primaryPhone(user: AtlasUser): { phone_number: string; verified: boolean } | null {
  return (user.phone_numbers ?? []).find((p) => p.primary) ?? user.phone_numbers?.[0] ?? null;
}

function backHere(): string | undefined {
  return typeof window !== 'undefined' ? window.location.href : undefined;
}

function moved(method: string, instead: string): never {
  throw new Error(`${method}: this runs on Atlas now — ${instead}.`);
}

// ---- Appwrite ------------------------------------------------------------------

/** The fields of Appwrite's `Models.User` apps read. */
export interface AppwriteCompatUser {
  $id: string;
  name: string;
  email: string;
  emailVerification: boolean;
  phone: string;
  phoneVerification: boolean;
  status: true;
  labels: string[];
  prefs: Record<string, unknown>;
  mfa: boolean;
}

export function appwriteUserFrom(user: AtlasUser): AppwriteCompatUser {
  const email = primaryEmail(user);
  const phone = primaryPhone(user);
  const labels = user.public_metadata?.appwrite_labels;
  return {
    $id: user.id,
    name: displayName(user) ?? '',
    email: email?.address ?? '',
    emailVerification: email?.verified ?? false,
    phone: phone?.phone_number ?? '',
    phoneVerification: phone?.verified ?? false,
    status: true,
    labels: Array.isArray(labels) ? labels.filter((l): l is string => typeof l === 'string') : [],
    prefs: { ...(user.unsafe_metadata ?? {}) },
    mfa: user.mfa_enabled,
  };
}

/** Thrown like Appwrite's `AppwriteException` (code 401, `general_unauthorized_scope`) when signed out. */
export class AppwriteCompatException extends Error {
  readonly code = 401;
  readonly type = 'general_unauthorized_scope';
  constructor() {
    super('User (role: guests) missing scope (account)');
    this.name = 'AppwriteException';
  }
}

const SIGN_IN_PAGE = 'credentials are collected on the Atlas sign-in page (<SignIn /> or /sign-in)';
const PROFILE = 'use <UserProfile /> or the Atlas user API';

/** `new Account(client)` from the Appwrite web SDK. The client is accepted and ignored. */
export class AppwriteAccountCompat {
  constructor(_client?: unknown) {}

  async get(): Promise<AppwriteCompatUser> {
    const user = signedInUser(requireActive('account.get'));
    if (!user) throw new AppwriteCompatException();
    return appwriteUserFrom(user);
  }

  async getPrefs(): Promise<Record<string, unknown>> {
    return (await this.get()).prefs;
  }

  /** `deleteSession('current')` signs out; other session ids are managed in <UserProfile />. */
  async deleteSession(sessionId: string = 'current'): Promise<Record<string, never>> {
    if (sessionId !== 'current') moved('account.deleteSession(id)', 'revoke other sessions from <UserProfile /> or the sessions API');
    await requireActive('account.deleteSession').signOut();
    return {};
  }

  async deleteSessions(): Promise<Record<string, never>> {
    await requireActive('account.deleteSessions').signOut();
    return {};
  }

  /** `createJWT()`: `{ jwt }` is the Atlas session JWT (verify it with @atlasauth/backend). */
  async createJWT(): Promise<{ jwt: string }> {
    const jwt = await requireActive('account.createJWT').getToken();
    if (!jwt) throw new AppwriteCompatException();
    return { jwt };
  }

  /** `createOAuth2Session(provider, success)`: opens the Atlas sign-in page, returning to `success`. */
  createOAuth2Session(_provider?: unknown, success?: string, _failure?: string, _scopes?: string[]): void {
    navigateTo(withRedirect('/sign-in', success ?? backHere()));
  }

  createOAuth2Token(provider?: unknown, success?: string, failure?: string, scopes?: string[]): void {
    this.createOAuth2Session(provider, success, failure, scopes);
  }

  async create(..._args: unknown[]): Promise<never> {
    return moved('account.create', 'sign-up runs on the Atlas sign-up page (<SignUp /> or /sign-up)');
  }
  async createEmailPasswordSession(..._args: unknown[]): Promise<never> {
    return moved('account.createEmailPasswordSession', SIGN_IN_PAGE);
  }
  async createEmailSession(..._args: unknown[]): Promise<never> {
    return moved('account.createEmailSession', SIGN_IN_PAGE);
  }
  async createMagicURLToken(..._args: unknown[]): Promise<never> {
    return moved('account.createMagicURLToken', 'enable magic links in the Atlas dashboard; the sign-in page sends them');
  }
  async createEmailToken(..._args: unknown[]): Promise<never> {
    return moved('account.createEmailToken', 'enable email codes in the Atlas dashboard; the sign-in page sends them');
  }
  async createPhoneToken(..._args: unknown[]): Promise<never> {
    return moved('account.createPhoneToken', 'enable SMS codes in the Atlas dashboard; the sign-in page sends them');
  }
  async createSession(..._args: unknown[]): Promise<never> {
    return moved('account.createSession', SIGN_IN_PAGE);
  }
  async createAnonymousSession(..._args: unknown[]): Promise<never> {
    return moved('account.createAnonymousSession', 'enable anonymous users in the Atlas dashboard');
  }
  async updatePassword(..._args: unknown[]): Promise<never> {
    return moved('account.updatePassword', PROFILE);
  }
  async updateEmail(..._args: unknown[]): Promise<never> {
    return moved('account.updateEmail', PROFILE);
  }
  async updateName(..._args: unknown[]): Promise<never> {
    return moved('account.updateName', PROFILE);
  }
  async updatePrefs(..._args: unknown[]): Promise<never> {
    return moved('account.updatePrefs', 'store preferences in the user\'s unsafe_metadata (user.update from @atlasauth/js)');
  }
  async createRecovery(..._args: unknown[]): Promise<never> {
    return moved('account.createRecovery', 'password reset is built into the Atlas sign-in page');
  }
  async updateRecovery(..._args: unknown[]): Promise<never> {
    return moved('account.updateRecovery', 'password reset is built into the Atlas sign-in page');
  }
  async createVerification(..._args: unknown[]): Promise<never> {
    return moved('account.createVerification', 'Atlas verifies email addresses during sign-up and in <UserProfile />');
  }
  async updateVerification(..._args: unknown[]): Promise<never> {
    return moved('account.updateVerification', 'Atlas verifies email addresses during sign-up and in <UserProfile />');
  }
}

// ---- PocketBase ------------------------------------------------------------------

/** The PocketBase auth record shape apps read off `pb.authStore.record` / `.model`. */
export interface PocketBaseCompatRecord {
  id: string;
  collectionName: 'users';
  email: string;
  verified: boolean;
  username: string;
  name: string;
  avatar: string;
  [field: string]: unknown;
}

export function pocketbaseRecordFrom(user: AtlasUser): PocketBaseCompatRecord {
  const email = primaryEmail(user);
  const fields = user.public_metadata?.pocketbase_fields;
  return {
    ...(fields && typeof fields === 'object' && !Array.isArray(fields) ? (fields as Record<string, unknown>) : {}),
    id: user.id,
    collectionName: 'users',
    email: email?.address ?? '',
    verified: email?.verified ?? false,
    username: user.username ?? '',
    name: displayName(user) ?? '',
    avatar: user.image_url ?? '',
  };
}

let cachedToken = '';
let tokenWatch: (() => void) | null = null;

/** Keep `authStore.token` (synchronous in PocketBase) filled from the async Atlas token. */
function watchToken(): void {
  if (tokenWatch) return;
  const refresh = (atlas: ActiveAtlas | null) => {
    if (!atlas || atlas.status !== 'signed_in') {
      cachedToken = '';
      return;
    }
    void atlas.getToken().then(
      (t) => {
        cachedToken = t ?? '';
      },
      () => {
        cachedToken = '';
      },
    );
  };
  tokenWatch = onActiveAtlasChange(refresh);
  refresh(getActiveAtlas());
}

/** `pb.authStore`, answered by the Atlas session. */
export const pocketbaseAuthStoreCompat = {
  get isValid(): boolean {
    return getActiveAtlas()?.status === 'signed_in';
  },
  /** The last Atlas session JWT seen (empty until the first one is minted); prefer `await getToken()`. */
  get token(): string {
    watchToken();
    return cachedToken;
  },
  get record(): PocketBaseCompatRecord | null {
    const user = signedInUser(getActiveAtlas());
    return user ? pocketbaseRecordFrom(user) : null;
  },
  /** Pre-0.23 name for `record`. */
  get model(): PocketBaseCompatRecord | null {
    return this.record;
  },
  get isSuperuser(): boolean {
    return false;
  },
  get isAdmin(): boolean {
    return false;
  },
  /** The current Atlas session JWT. */
  async getToken(): Promise<string> {
    return (await getActiveAtlas()?.getToken()) ?? '';
  },
  clear(): void {
    void getActiveAtlas()?.signOut();
  },
  /** `onChange((token, record) => …, fireImmediately)`: returns the unsubscribe. */
  onChange(callback: (token: string, record: PocketBaseCompatRecord | null) => void, fireImmediately = false): () => void {
    let lastId: string | null | undefined;
    const listener = (atlas: ActiveAtlas | null) => {
      if (!atlas || atlas.status === 'loading') return;
      const user = signedInUser(atlas);
      const id = user?.id ?? null;
      if (lastId === undefined && !fireImmediately) {
        lastId = id;
        return;
      }
      if (id === lastId) return;
      lastId = id;
      if (!user) {
        callback('', null);
        return;
      }
      void atlas.getToken().then((t) => callback(t ?? '', pocketbaseRecordFrom(user)));
    };
    const unsubscribe = onActiveAtlasChange(listener);
    listener(getActiveAtlas());
    return unsubscribe;
  },
  /** Atlas keeps its own session cookie: there is nothing to load. */
  loadFromCookie(_cookie?: string, _key?: string): void {},
  /** Atlas keeps its own session cookie: there is nothing to export. */
  exportToCookie(_options?: unknown, _key?: string): string {
    return '';
  },
  save(_token?: string, _record?: unknown): void {
    moved('pb.authStore.save', 'Atlas manages the session; sign users in through <SignIn />');
  },
};

// ---- Nhost -------------------------------------------------------------------------

/** Nhost's `User` shape (camelCase, as `@nhost/react` returns it). */
export interface NhostCompatUser {
  id: string;
  email?: string;
  emailVerified: boolean;
  displayName: string;
  avatarUrl: string;
  phoneNumber?: string;
  phoneNumberVerified: boolean;
  defaultRole: string;
  roles: string[];
  locale: string;
  isAnonymous: false;
  metadata: Record<string, unknown>;
}

export function nhostUserFrom(user: AtlasUser): NhostCompatUser {
  const email = primaryEmail(user);
  const phone = primaryPhone(user);
  const meta = user.public_metadata ?? {};
  const roles = Array.isArray(meta.nhost_roles) ? meta.nhost_roles.filter((r): r is string => typeof r === 'string') : ['user'];
  return {
    id: user.id,
    ...(email ? { email: email.address } : {}),
    emailVerified: email?.verified ?? false,
    displayName: displayName(user) ?? '',
    avatarUrl: user.image_url ?? '',
    ...(phone ? { phoneNumber: phone.phone_number } : {}),
    phoneNumberVerified: phone?.verified ?? false,
    defaultRole: typeof meta.nhost_default_role === 'string' ? meta.nhost_default_role : 'user',
    roles,
    locale: typeof meta.locale === 'string' ? meta.locale : 'en',
    isAnonymous: false,
    metadata: { ...(user.unsafe_metadata ?? {}) },
  };
}

/** `nhost.auth.*` session readers. */
export const nhostAuthCompat = {
  getUser(): NhostCompatUser | null {
    const user = signedInUser(getActiveAtlas());
    return user ? nhostUserFrom(user) : null;
  },
  isAuthenticated(): boolean {
    return getActiveAtlas()?.status === 'signed_in';
  },
  /** Resolves once the session is known (not while the provider is still loading). */
  isAuthenticatedAsync(): Promise<boolean> {
    return new Promise((resolve) => {
      let unsubscribe: (() => void) | null = null;
      let done = false;
      const settle = (atlas: ActiveAtlas | null) => {
        if (done || !atlas || atlas.status === 'loading') return;
        done = true;
        unsubscribe?.();
        resolve(atlas.status === 'signed_in');
      };
      unsubscribe = onActiveAtlasChange(settle);
      settle(getActiveAtlas());
    });
  },
  async getAccessToken(): Promise<string | undefined> {
    return (await getActiveAtlas()?.getToken()) ?? undefined;
  },
  async getSession(): Promise<{ accessToken: string; user: NhostCompatUser } | null> {
    const atlas = getActiveAtlas();
    const user = signedInUser(atlas);
    const token = user ? await atlas!.getToken() : null;
    return user && token ? { accessToken: token, user: nhostUserFrom(user) } : null;
  },
  async signOut(_params?: { all?: boolean }): Promise<{ error: null }> {
    await requireActive('nhost.auth.signOut').signOut();
    return { error: null };
  },
  /** `onAuthStateChanged((event, session) => …)`: SIGNED_IN / SIGNED_OUT. Returns the unsubscribe. */
  onAuthStateChanged(callback: (event: 'SIGNED_IN' | 'SIGNED_OUT', session: { user: NhostCompatUser } | null) => void): () => void {
    let lastId: string | null | undefined;
    const listener = (atlas: ActiveAtlas | null) => {
      if (!atlas || atlas.status === 'loading') return;
      const user = signedInUser(atlas);
      const id = user?.id ?? null;
      if (id === lastId) return;
      const first = lastId === undefined;
      lastId = id;
      if (user) callback('SIGNED_IN', { user: nhostUserFrom(user) });
      else if (!first) callback('SIGNED_OUT', null);
    };
    const unsubscribe = onActiveAtlasChange(listener);
    listener(getActiveAtlas());
    return unsubscribe;
  },
  /** `onTokenChanged(cb)`: fires when the session token is refreshed. */
  onTokenChanged(callback: (session: { accessToken: string } | null) => void): () => void {
    let lastExp: unknown;
    return onActiveAtlasChange((atlas) => {
      if (!atlas || atlas.status === 'loading') return;
      const exp = atlas.claims?.exp ?? null;
      if (exp === lastExp) return;
      lastExp = exp;
      if (atlas.status !== 'signed_in') callback(null);
      else void atlas.getToken().then((t) => callback(t ? { accessToken: t } : null));
    });
  },
};

/** `useAuthenticationStatus()`: `{ isAuthenticated, isLoading }`. */
export function useNhostAuthenticationStatusCompat(): { isAuthenticated: boolean; isLoading: boolean; error: null; isError: false } {
  const atlas = useAtlas();
  return { isAuthenticated: atlas.status === 'signed_in', isLoading: atlas.status === 'loading', error: null, isError: false };
}

/** `useAuthenticated()`. */
export function useNhostAuthenticatedCompat(): boolean {
  return useAtlas().status === 'signed_in';
}

/** `useUserData()`: the user, or null. */
export function useNhostUserDataCompat(): NhostCompatUser | null {
  const atlas = useAtlas();
  return atlas.status === 'signed_in' && atlas.user ? nhostUserFrom(atlas.user) : null;
}

/** `useUserId()`. */
export function useNhostUserIdCompat(): string | undefined {
  return useNhostUserDataCompat()?.id;
}

/** `useUserEmail()`. */
export function useNhostUserEmailCompat(): string | undefined {
  return useNhostUserDataCompat()?.email;
}

/** `useUserDisplayName()`. */
export function useNhostUserDisplayNameCompat(): string | undefined {
  return useNhostUserDataCompat()?.displayName || undefined;
}

/** `useUserAvatarUrl()`. */
export function useNhostUserAvatarUrlCompat(): string | undefined {
  return useNhostUserDataCompat()?.avatarUrl || undefined;
}

/** `useSignOut()`: `{ signOut, isSuccess }`. */
export function useNhostSignOutCompat(): { signOut: (all?: boolean) => Promise<{ isSuccess: boolean; isError: boolean; error: null }>; isSuccess: boolean } {
  const atlas = useAtlas();
  return {
    signOut: async () => {
      await requireActive('useSignOut').signOut();
      return { isSuccess: true, isError: false, error: null };
    },
    isSuccess: atlas.status === 'signed_out',
  };
}
