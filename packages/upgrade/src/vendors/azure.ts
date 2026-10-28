import {
  applyImportRules,
  applyReexportRules,
  fixProviderProps,
  renameEnv,
  vendorTransform,
  type ModuleRule,
  type Target,
} from './engine';
import { ATLAS } from './shared';

/**
 * Azure AD B2C / Microsoft Entra External ID (MSAL) → Atlas:
 *
 *  - `@azure/msal-react`: `<MsalProvider instance>` → `<AtlasProvider>`;
 *    `useMsal`, `useIsAuthenticated`, `useAccount` → compat hooks;
 *    `<AuthenticatedTemplate>` / `<UnauthenticatedTemplate>` → `<SignedIn>` /
 *    `<SignedOut>`;
 *  - `@azure/msal-browser`: `new PublicClientApplication(config)` →
 *    `new MsalCompatClient(config)` (same account and token methods), the
 *    result/account types and `InteractionRequiredAuthError` → compat peers;
 *  - MSAL Node, passport-azure-ad and the MSAL Angular/Vue wrappers are
 *    reported: Atlas hosts sign-in, and servers verify Atlas session tokens.
 */

const manual = (message: string): Target => ({ manual: message });
const SERVER =
  'server-side: Atlas hosts sign-in and callbacks; read the session with auth() from @atlasauth/nextjs/server or verify tokens with AtlasBackend from @atlasauth/backend';

const RULES: readonly ModuleRule[] = [
  {
    match: '@azure/msal-react',
    named: {
      MsalProvider: {
        module: ATLAS.react,
        name: 'AtlasProvider',
        after: (ref, ctx) => fixProviderProps(ctx, ref, { drop: ['instance'] }),
      },
      useMsal: { module: ATLAS.reactCompat, name: 'useMsalCompat' },
      useIsAuthenticated: { module: ATLAS.reactCompat, name: 'useIsAuthenticatedCompat' },
      useAccount: { module: ATLAS.reactCompat, name: 'useAccountCompat' },
      AuthenticatedTemplate: { module: ATLAS.react, name: 'SignedIn' },
      UnauthenticatedTemplate: { module: ATLAS.react, name: 'SignedOut' },
      MsalAuthenticationTemplate: manual(
        '<MsalAuthenticationTemplate>: protect the route in middleware (createAtlasMiddleware) or render <SignedIn> with <RedirectToSignIn /> inside <SignedOut>',
      ),
      useMsalAuthentication: manual('useMsalAuthentication(): use useAuth() from @atlasauth/react and send signed-out users to /sign-in'),
      withMsal: manual('withMsal(Class): read auth in a function component with useMsalCompat() and pass it down as props'),
      MsalContext: manual('MsalContext: use useMsalCompat() (or useAuth()) from @atlasauth/react'),
      MsalConsumer: manual('MsalConsumer: use useMsalCompat() (or useAuth()) from @atlasauth/react'),
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: '@azure/msal-browser',
    named: {
      PublicClientApplication: { module: ATLAS.reactCompat, name: 'MsalCompatClient' },
      IPublicClientApplication: { module: ATLAS.reactCompat, name: 'MsalCompatClient', typeOnly: true },
      AccountInfo: { module: ATLAS.reactCompat, name: 'MsalCompatAccount', typeOnly: true },
      AuthenticationResult: { module: ATLAS.reactCompat, name: 'MsalCompatAuthResult', typeOnly: true },
      InteractionRequiredAuthError: { module: ATLAS.reactCompat, name: 'MsalCompatInteractionRequiredError' },
      // Request/config types and the enums stay valid while msal-browser is installed.
      Configuration: { keep: true },
      PopupRequest: { keep: true },
      RedirectRequest: { keep: true },
      SilentRequest: { keep: true },
      EndSessionRequest: { keep: true },
      InteractionType: { keep: true },
      InteractionStatus: { keep: true },
      BrowserCacheLocation: { keep: true },
      LogLevel: { keep: true },
      EventType: manual('MSAL events: subscribe to Atlas session changes with useAuth() / useSignOutListener() from @atlasauth/react'),
      EventMessage: manual('MSAL events: subscribe to Atlas session changes with useAuth() / useSignOutListener() from @atlasauth/react'),
    },
    otherNamed: 'no Atlas counterpart — migrate it manually',
  },
  {
    match: (s) => s === '@azure/msal-node' || s === 'passport-azure-ad' || s === '@azure/msal-common' || s === '@azure/msal-node-extensions',
    otherNamed: SERVER,
    default: manual(SERVER),
  },
  {
    match: (s) => s === '@azure/msal-angular' || s === 'msal-vue' || s === '@azure/msal-react-native',
    otherNamed: 'MSAL framework wrapper: use the Atlas SDK for this framework',
  },
];

export default vendorTransform({
  mightApply: (source) => /@azure\/msal|passport-azure-ad|AZURE_AD|B2C|ENTRA/i.test(source),
  run(ctx) {
    applyReexportRules(ctx, RULES);
    applyImportRules(ctx, RULES);
    renameEnv(ctx, (key) => {
      if (/^(NEXT_PUBLIC_|VITE_|REACT_APP_)?(AZURE_AD_B2C|AZURE_AD|AZURE_B2C|B2C|ENTRA(_EXTERNAL_ID)?|MSAL)_[A-Z0-9_]+$/.test(key)) {
        return { report: `${key}: MSAL configuration; Atlas reads its publishable key and frontend API from the ATLAS_* env vars instead` };
      }
      return null;
    });
  },
});
