'use client';

/**
 * MSAL (Azure AD B2C / Microsoft Entra External ID) compatibility helpers, for
 * `atlas migrate code --from azure-ad-b2c` / `--from entra-external-id`.
 *
 *  - `MsalCompatClient` stands in for `PublicClientApplication`: the account
 *    and token methods apps call (`getAllAccounts`, `getActiveAccount`,
 *    `acquireTokenSilent`, `loginRedirect`, `logoutRedirect`, …) answer from
 *    the `<AtlasProvider>` session; `acquireTokenSilent` resolves the Atlas
 *    session JWT as both `accessToken` and `idToken`.
 *  - `useMsalCompat`, `useIsAuthenticatedCompat`, `useAccountCompat` keep the
 *    `@azure/msal-react` hook shapes.
 *
 * `localAccountId` / `homeAccountId` are the ATLAS user id; the directory
 * object id (`oid`) the user had is kept by the import as their external id.
 */
import { useAtlas } from './AtlasProvider';
import { navigateTo, withRedirect } from './components-shared';
import { displayName, primaryEmail } from './compat';
import type { AtlasUser } from './types';
import { getActiveAtlas, requireActive } from './active-atlas';

/** MSAL's `AccountInfo`, as far as apps read it. */
export interface MsalCompatAccount {
  homeAccountId: string;
  localAccountId: string;
  environment: string;
  tenantId: string;
  username: string;
  name?: string;
  idTokenClaims?: Record<string, unknown>;
}

export interface MsalCompatAuthResult {
  accessToken: string;
  idToken: string;
  account: MsalCompatAccount;
  scopes: string[];
  expiresOn: Date | null;
  tokenType: 'Bearer';
  idTokenClaims: Record<string, unknown>;
  uniqueId: string;
  tenantId: string;
  fromCache: boolean;
}

/** Thrown like MSAL's `InteractionRequiredAuthError` when nobody is signed in. */
export class MsalCompatInteractionRequiredError extends Error {
  readonly errorCode = 'interaction_required';
  constructor() {
    super('interaction_required: no signed-in user');
    this.name = 'InteractionRequiredAuthError';
  }
}

export function msalAccountFrom(user: AtlasUser | null, claims: Record<string, unknown> | null = null): MsalCompatAccount | null {
  if (!user) return null;
  const email = primaryEmail(user)?.address;
  const name = displayName(user) ?? undefined;
  return {
    homeAccountId: user.id,
    localAccountId: user.id,
    environment: 'atlas',
    tenantId: 'atlas',
    username: email ?? user.username ?? user.id,
    ...(name ? { name } : {}),
    idTokenClaims: { ...(claims ?? {}), ...(email ? { emails: [email], email } : {}), ...(name ? { name } : {}) },
  };
}

function current(): MsalCompatAccount | null {
  const atlas = getActiveAtlas();
  return atlas?.status === 'signed_in' ? msalAccountFrom(atlas.user, (atlas.claims as Record<string, unknown> | null) ?? null) : null;
}

function goToSignIn(redirectUri?: string): void {
  const back = redirectUri ?? (typeof window !== 'undefined' ? window.location.href : undefined);
  navigateTo(withRedirect('/sign-in', back));
}

/** `PublicClientApplication`, answered by the Atlas session. The config is accepted and ignored. */
export class MsalCompatClient {
  constructor(_config?: unknown) {}

  /** `PublicClientApplication.createPublicClientApplication(config)`. */
  static async createPublicClientApplication(config?: unknown): Promise<MsalCompatClient> {
    return new MsalCompatClient(config);
  }

  async initialize(): Promise<void> {}

  async handleRedirectPromise(_hash?: string): Promise<MsalCompatAuthResult | null> {
    return null;
  }

  getAllAccounts(): MsalCompatAccount[] {
    const account = current();
    return account ? [account] : [];
  }

  getActiveAccount(): MsalCompatAccount | null {
    return current();
  }

  getAccountByHomeId(id: string): MsalCompatAccount | null {
    const account = current();
    return account && account.homeAccountId === id ? account : null;
  }

  getAccountByLocalId(id: string): MsalCompatAccount | null {
    return this.getAccountByHomeId(id);
  }

  getAccountByUsername(username: string): MsalCompatAccount | null {
    const account = current();
    return account && account.username.toLowerCase() === username.toLowerCase() ? account : null;
  }

  /** There is one account: the signed-in user. */
  setActiveAccount(_account: MsalCompatAccount | null): void {}

  async acquireTokenSilent(request: { scopes?: string[]; account?: unknown } = {}): Promise<MsalCompatAuthResult> {
    const atlas = requireActive('acquireTokenSilent');
    const account = current();
    const token = account ? await atlas.getToken() : null;
    if (!account || !token) throw new MsalCompatInteractionRequiredError();
    const exp = typeof atlas.claims?.exp === 'number' ? new Date(atlas.claims.exp * 1000) : null;
    return {
      accessToken: token,
      idToken: token,
      account,
      scopes: request.scopes ?? [],
      expiresOn: exp,
      tokenType: 'Bearer',
      idTokenClaims: account.idTokenClaims ?? {},
      uniqueId: account.localAccountId,
      tenantId: account.tenantId,
      fromCache: true,
    };
  }

  async acquireTokenPopup(request: { scopes?: string[] } = {}): Promise<MsalCompatAuthResult> {
    return this.acquireTokenSilent(request);
  }

  async acquireTokenRedirect(request: { redirectUri?: string } = {}): Promise<void> {
    if (!current()) goToSignIn(request.redirectUri);
  }

  async loginRedirect(request: { redirectUri?: string; redirectStartPage?: string } = {}): Promise<void> {
    goToSignIn(request.redirectStartPage ?? request.redirectUri);
  }

  /** There is no popup sign-in: this opens the sign-in page in the window. */
  async loginPopup(request: { redirectUri?: string } = {}): Promise<MsalCompatAuthResult> {
    goToSignIn(request.redirectUri);
    return new Promise(() => undefined);
  }

  async logoutRedirect(request: { postLogoutRedirectUri?: string } = {}): Promise<void> {
    await requireActive('logoutRedirect').signOut();
    if (request.postLogoutRedirectUri) navigateTo(request.postLogoutRedirectUri);
  }

  async logoutPopup(request: { postLogoutRedirectUri?: string; mainWindowRedirectUri?: string } = {}): Promise<void> {
    await this.logoutRedirect({ postLogoutRedirectUri: request.mainWindowRedirectUri ?? request.postLogoutRedirectUri });
  }

  /** MSAL events have no Atlas counterpart; the callback never fires. */
  addEventCallback(_callback: unknown): string | null {
    return null;
  }

  removeEventCallback(_id: string): void {}
}

/** The single client `useMsalCompat().instance` returns. */
export const msalCompatInstance = new MsalCompatClient();

/** `useMsal()`: `{ instance, accounts, inProgress }`. */
export function useMsalCompat(): { instance: MsalCompatClient; accounts: MsalCompatAccount[]; inProgress: 'startup' | 'none' } {
  const atlas = useAtlas();
  const account = atlas.status === 'signed_in' ? msalAccountFrom(atlas.user) : null;
  return { instance: msalCompatInstance, accounts: account ? [account] : [], inProgress: atlas.status === 'loading' ? 'startup' : 'none' };
}

/** `useIsAuthenticated()`. */
export function useIsAuthenticatedCompat(_matchAccount?: unknown): boolean {
  return useAtlas().status === 'signed_in';
}

/** `useAccount(accountIdentifiers)`: the signed-in account, or null. */
export function useAccountCompat(_accountIdentifiers?: unknown): MsalCompatAccount | null {
  const atlas = useAtlas();
  return atlas.status === 'signed_in' ? msalAccountFrom(atlas.user) : null;
}
