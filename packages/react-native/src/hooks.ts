import { hasFromClaims, type ProtectCondition, type ProviderToken } from '@atlasauth/js';
import { useAtlasState, useAtlasStore } from './AtlasProvider';
import type { AtlasSession, AtlasUser, FlowResult } from './types';

/**
 * The RN hook surface. Mirrors `@atlasauth/react` — `useAuth`, `useUser`,
 * `useSession`, `useSignIn`, `useSignUp` — minus the DOM-bound pieces (`<Protect>`
 * components, appearance, i18n). Each hook is a thin binding over `AtlasStore`;
 * every one reports `isLoaded` so a component can tell "still booting" from
 * "signed out" and avoid a flash of the sign-in screen on launch.
 */

export function useAuth(): {
  isLoaded: boolean;
  isSignedIn: boolean;
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  /**
   * Gate on an authorization condition (permission / role / anyPermission /
   * allPermissions) — the same `@atlasauth/authz` primitive React's `<Protect>` and
   * the backend's `has()` use, so a native app checks access identically. This
   * is a rendering aid, never a security boundary: the server must re-check.
   */
  has(condition?: ProtectCondition): boolean;
  getToken(): Promise<string | null>;
  getProviderToken(provider: string): Promise<ProviderToken | null>;
  signOut(): Promise<void>;
} {
  const store = useAtlasStore();
  const { status, claims } = useAtlasState();
  return {
    isLoaded: status !== 'loading',
    isSignedIn: status === 'signed_in',
    userId: claims?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: claims?.org_id ?? null,
    orgRole: claims?.org_role ?? null,
    has: (condition = {}) => hasFromClaims(claims, condition),
    getToken: store.getToken,
    getProviderToken: store.getProviderToken,
    signOut: store.signOut,
  };
}

export function useUser(): {
  isLoaded: boolean;
  isSignedIn: boolean;
  user: AtlasUser | null;
  /** The signed-in user's own live token at a connected provider (§6.6). */
  getProviderToken(provider: string): Promise<ProviderToken | null>;
} {
  const store = useAtlasStore();
  const { status, user } = useAtlasState();
  return {
    isLoaded: status !== 'loading',
    isSignedIn: status === 'signed_in',
    user,
    getProviderToken: store.getProviderToken,
  };
}

export function useSession(): { isLoaded: boolean; session: AtlasSession | null } {
  const { status, session } = useAtlasState();
  return { isLoaded: status !== 'loading', session };
}

export function useSignIn(): {
  signInWithPassword(input: { identifier: string; password: string }): Promise<FlowResult>;
  attemptSecondFactor(input: {
    attemptId: string;
    status: string;
    code: string;
  }): Promise<FlowResult>;
  startOAuth(input: {
    provider: string;
    redirectUrl: string;
  }): Promise<{
    authorizationUrl: string | null;
    errors: Array<{ code: string; message: string; param?: string }>;
  }>;
  completeOAuthRedirect(callbackUrl: string): Promise<FlowResult>;
} {
  const store = useAtlasStore();
  return {
    signInWithPassword: store.signInWithPassword,
    attemptSecondFactor: store.attemptSecondFactor,
    startOAuth: store.startOAuth,
    completeOAuthRedirect: store.completeOAuthRedirect,
  };
}

export function useSignUp(): {
  signUpWithPassword(input: {
    emailAddress: string;
    password: string;
    firstName?: string;
    lastName?: string;
  }): Promise<FlowResult>;
  verifyEmailCode(input: { attemptId: string; code: string }): Promise<FlowResult>;
} {
  const store = useAtlasStore();
  return {
    signUpWithPassword: store.signUpWithPassword,
    verifyEmailCode: store.verifyEmailCode,
  };
}
