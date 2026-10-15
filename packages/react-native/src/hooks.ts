import { useEffect, useState } from 'react';
import {
  hasFromClaims,
  type EmailDelivery,
  type ProtectCondition,
  type ProviderToken,
  type SignOutOptions,
  type SignOutResult,
} from '@atlasauth/js';
import { useAtlasState, useAtlasStore } from './AtlasProvider';
import type { AtlasSession, AtlasUser, AuthStatus, FlowResult } from './types';

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
  /** Three-state auth status (`loading` | `signed_in` | `signed_out`); same source as isLoaded/isSignedIn. */
  status: AuthStatus;
  /** The active session, or null while loading or signed out. */
  session: AtlasSession | null;
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
  /**
   * Revoke the session and sign out locally. Resolves `{ revoked, activeSessionId? }`;
   * `{ strict: true }` rejects with a `SignOutError` (after the local sign-out)
   * when the server could not confirm the revoke.
   */
  signOut(options?: SignOutOptions): Promise<SignOutResult>;
} {
  const store = useAtlasStore();
  const { status, session, claims } = useAtlasState();
  return {
    isLoaded: status !== 'loading',
    isSignedIn: status === 'signed_in',
    status,
    session,
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
  signInWithPassword(input: {
    identifier: string;
    password: string;
    captchaToken?: string;
  }): Promise<FlowResult>;
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
    fields?: Record<string, string>;
    consent?: boolean;
    captchaToken?: string;
  }): Promise<FlowResult>;
  verifyEmailCode(input: { attemptId: string; code: string }): Promise<FlowResult>;
} {
  const store = useAtlasStore();
  return {
    signUpWithPassword: store.signUpWithPassword,
    verifyEmailCode: store.verifyEmailCode,
  };
}

/**
 * Whether the app can deliver email (`InstanceSettings.emailDelivery`), for an
 * app drawing its own sign-in / sign-up screens: hide "Forgot password?" when
 * `passwordReset` is false, show `EMAIL_UNAVAILABLE_MESSAGE` instead of the
 * email + password sign-up form when `passwordSignUp` is false, and pass
 * `emailDelivery` to `offeredFirstFactors()` to drop email code / link. Null
 * until loaded; everything reads as available if the settings can't be read.
 */
export function useEmailDelivery(): { isLoaded: boolean; emailDelivery: EmailDelivery | null } {
  const store = useAtlasStore();
  const [emailDelivery, setEmailDelivery] = useState<EmailDelivery | null>(null);
  useEffect(() => {
    let live = true;
    void store.getEmailDelivery().then((delivery) => {
      if (live) setEmailDelivery(delivery);
    });
    return () => {
      live = false;
    };
  }, [store]);
  return { isLoaded: emailDelivery !== null, emailDelivery };
}
