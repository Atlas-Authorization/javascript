import { useContext, useMemo } from 'react';
import { useAtlas } from '@atlasauth/react';
import { ExpoNativeContext } from './fapi-context';
import { createExpoOAuth } from './expo-oauth';
import { useExpoFapiClient } from './policies';

/**
 * Sign in with a provider (Discord, GitHub, Google in Expo Go, …) in the system browser, in one call:
 * `const { signInWithOAuth } = useSignIn(); const r = await signInWithOAuth('discord');`
 * Enterprise SSO (OIDC, SAML, WS-Federation) the same way: `await signInWithSSO({ identifier: 'ada@example.com' })`, or `{ connectionId, strategy: 'saml' }`.
 *
 * `r.status` is `complete` (the session is stored and `useAuth()` updates), `cancelled` (the person closed the
 * browser; not an error), `needs_second_factor` / `needs_required_action` (the pending attempt is handed to
 * `useSignInScreen()`, which continues from that step), or `error` (`r.errors`, with codes such as
 * `CALLBACK_NOT_REGISTERED`). Needs `expo-web-browser`, and `<AtlasProvider appId="napp_…">` except in Expo Go on a development instance.
 */
export function useSignIn() {
  const client = useExpoFapiClient();
  const native = useContext(ExpoNativeContext);
  const { reload } = useAtlas();
  return useMemo(
    () =>
      createExpoOAuth({
        client,
        ...(native?.appId ? { appId: native.appId } : {}),
        adopt: async (jwt) => {
          await native?.saveToken(jwt);
          await reload();
        },
        setPending: (a) => native?.setPending(a),
      }),
    [client, native, reload],
  );
}
