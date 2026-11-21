/**
 * Browser sign-in for Expo: the system browser (`expo-web-browser`), PKCE, and the Expo Go dev callback.
 * No React here (testable in Node); the hook is `useSignIn()` in `./sign-in-hook`.
 *
 * `expo-web-browser`, `expo-constants` and `expo-linking` are optional peers, required lazily and guarded: an app
 * that never signs in through a browser never loads them, and tests inject fakes through `modules`.
 */
import { signInWithNativeBrowser, type FapiClient, type FieldError, type NativeAuthBrowser } from '@atlasauth/js';
import type { OAuthSignInResult } from '@atlasauth/react-native';
import type { PendingOAuthAttempt } from './fapi-context';
import { signInWithGoogle as signInWithGoogleSheet, type GoogleSigninLike } from './social';

export interface WebBrowserLike {
  openAuthSessionAsync(url: string, redirectUrl?: string | null, options?: { preferEphemeralSession?: boolean }): Promise<{ type: string; url?: string }>;
}
export interface ConstantsLike {
  executionEnvironment?: string;
  appOwnership?: string | null;
}
export interface LinkingLike {
  createURL(path: string): string;
}
export interface ExpoOAuthModules {
  webBrowser?: WebBrowserLike | null;
  constants?: ConstantsLike | null;
  linking?: LinkingLike | null;
}

// Metro needs each module name as a literal, so one guarded require per module.
const guarded = <T>(load: () => T): T | null => {
  try {
    return typeof require === 'function' ? load() ?? null : null;
  } catch {
    return null;
  }
};
const loadWebBrowser = () => guarded<WebBrowserLike>(() => require!('expo-web-browser'));
const loadConstants = () => guarded<ConstantsLike>(() => require!('expo-constants')?.default ?? require!('expo-constants'));
const loadLinking = () => guarded<LinkingLike>(() => require!('expo-linking'));

/** True in Expo Go (the store client), where there is no custom scheme and the callback is an `exp://` URL. */
export function isExpoGo(constants: ConstantsLike | null | undefined): boolean {
  return constants?.executionEnvironment === 'storeClient' || constants?.appOwnership === 'expo';
}

export interface ExpoSignInOptions {
  /** Override the registered app id given to `<AtlasProvider appId>`. */
  appId?: string;
  /** The hosted callback is the default; pass your own https redirect only if you run one. */
  redirectUrl?: string;
  /**
   * The URL the app is sent back to. Default: `Linking.createURL('/atlas-oauth')` (an `exp://` URL in Expo Go, your
   * scheme in a build). It must be one of the registered app's `callback_urls`; `atlas dev native` prints it.
   */
  callback?: string;
  /** iOS: share no cookies with Safari, so the provider always asks who is signing in. Default false. */
  preferEphemeralSession?: boolean;
}

const failure = (code: string, message: string): OAuthSignInResult => ({ status: 'error', errors: [{ code, message }] });

export function createExpoOAuth(deps: {
  client: FapiClient;
  appId?: string;
  /** Store the session JWT and refresh the provider's state. */
  adopt(jwt: string): Promise<void>;
  /** Hand a `needs_*` outcome to the sign-in screen. */
  setPending(attempt: PendingOAuthAttempt): void;
  modules?: ExpoOAuthModules;
}) {
  const mod = <K extends keyof ExpoOAuthModules>(key: K, load: () => ExpoOAuthModules[K]): ExpoOAuthModules[K] =>
    deps.modules && key in deps.modules ? deps.modules[key] : load();

  async function signInWithOAuth(provider: string, opts: ExpoSignInOptions = {}): Promise<OAuthSignInResult> {
    const webBrowser = mod('webBrowser', loadWebBrowser);
    if (!webBrowser) return failure('EXPO_WEB_BROWSER_MISSING', 'Install expo-web-browser (npx expo install expo-web-browser) to sign in with a provider.');
    let callback = opts.callback;
    if (!callback && !opts.redirectUrl) {
      const linking = mod('linking', loadLinking);
      if (!linking) return failure('EXPO_LINKING_MISSING', 'Install expo-linking (npx expo install expo-linking), or pass `callback`.');
      // Expo Go has no custom scheme: this is an exp:// URL there, which a development instance accepts.
      callback = linking.createURL('/atlas-oauth');
    }
    const appId = opts.appId ?? deps.appId;
    const browser: NativeAuthBrowser = {
      async openAuthSession(url, redirectUrl, { preferEphemeralSession }) {
        const r = await webBrowser.openAuthSessionAsync(url, redirectUrl, { preferEphemeralSession });
        return r.type === 'success' && r.url ? { type: 'success', url: r.url } : { type: 'cancel' };
      },
    };
    const out = await signInWithNativeBrowser(deps.client, {
      provider,
      browser,
      ...(appId ? { nativeAppId: appId } : {}),
      ...(opts.redirectUrl ? { redirectUrl: opts.redirectUrl } : {}),
      ...(callback ? { callback } : {}),
      preferEphemeralSession: opts.preferEphemeralSession ?? false,
      onStarted: ({ redirectUrl }) => {
        if ((globalThis as { __DEV__?: boolean }).__DEV__) console.log(`[atlas] OAuth redirect_url sent: ${redirectUrl}${callback ? ` (callback ${callback})` : ''}`);
      },
    });
    if (out.status === 'complete') {
      await deps.adopt(out.session.jwt);
      return { status: 'complete', errors: [] };
    }
    if (out.status === 'error') return out;
    if (out.status === 'cancelled') return { status: 'cancelled', errors: [] };
    deps.setPending({ id: out.attemptId, status: out.attemptStatus, codeVerifier: out.codeVerifier, ...(out.policyToken ? { policyToken: out.policyToken } : {}) });
    return { ...out, errors: [] };
  }

  /**
   * Google: the native sheet when a Google sign-in module is given and the app is not in Expo Go; otherwise the browser
   * flow (Expo Go has no native Google module).
   */
  async function signInWithGoogle(google?: GoogleSigninLike | null, opts: ExpoSignInOptions = {}): Promise<OAuthSignInResult> {
    if (!google || isExpoGo(mod('constants', loadConstants))) return signInWithOAuth('google', opts);
    const r = await signInWithGoogleSheet(deps.client, google);
    if (r.status === 'complete' && r.jwt) {
      await deps.adopt(r.jwt);
      return { status: 'complete', errors: [] };
    }
    if (r.status === 'cancelled') return { status: 'cancelled', errors: [] };
    if (r.status === 'needs_more' && r.attemptId) {
      deps.setPending({ id: r.attemptId, status: 'needs_second_factor' });
      return { status: 'needs_second_factor', attemptId: r.attemptId, attemptStatus: 'needs_second_factor', errors: [] };
    }
    return { status: 'error', errors: (r.errors.length ? r.errors : [{ code: 'GOOGLE_FAILED', message: 'Could not sign in with Google.' }]) as FieldError[] };
  }

  return { signInWithOAuth, signInWithGoogle };
}
