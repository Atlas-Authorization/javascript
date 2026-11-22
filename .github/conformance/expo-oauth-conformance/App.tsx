import { useEffect, useState } from 'react';
import { Button, Text, View } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { AtlasProvider, createSecureStoreTokenCache, useAuth, useSignIn } from '@atlasauth/expo';

// The development instance and the native app it registered come from the build environment (CI secrets).
const PK = process.env.EXPO_PUBLIC_ATLAS_DEV_PK ?? '';
const FAPI = process.env.EXPO_PUBLIC_ATLAS_DEV_FAPI ?? '';
const APP_ID = process.env.EXPO_PUBLIC_ATLAS_NATIVE_APP_ID;
// The id of the test OIDC provider enabled on that instance.
const PROVIDER = process.env.EXPO_PUBLIC_ATLAS_TEST_PROVIDER || 'atlas_test';

const tokenCache = createSecureStoreTokenCache(SecureStore);

function Screen() {
  const { signInWithOAuth } = useSignIn();
  const { isSignedIn } = useAuth();
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState('');
  // A raw request to the Frontend API, outside the SDK, so a failed run shows whether the device can reach it at all.
  const [probe, setProbe] = useState('probing');
  useEffect(() => {
    fetch(`${FAPI}/v1/environment`, { headers: { 'x-publishable-key': PK } })
      .then((r) => setProbe(`probe ${r.status}`))
      .catch((e) => setProbe(`probe failed: ${String(e)}`));
  }, []);

  async function onPress() {
    try {
      const result = await signInWithOAuth(PROVIDER);
      setStatus(result.status);
      // A failed run names the error on screen, so the Maestro report shows why.
      setError(result.errors.map((e) => `${e.code}: ${e.message}`).join('\n'));
    } catch (e) {
      setStatus('threw');
      setError(String(e));
    }
  }

  return (
    // Clear of the status bar on both platforms (Android draws edge to edge).
    <View style={{ paddingTop: 80, paddingHorizontal: 16 }}>
      <Text testID="signed-in">{isSignedIn ? 'signed-in' : 'signed-out'}</Text>
      <Text testID="status">{status}</Text>
      <Text testID="error">{error}</Text>
      <Text testID="fapi">{FAPI || 'no Frontend API configured'}</Text>
      <Text testID="probe">{probe}</Text>
      <Button testID="sign-in" title="Sign in" onPress={onPress} />
    </View>
  );
}

export default function App() {
  return (
    <AtlasProvider publishableKey={PK} frontendApi={FAPI} tokenCache={tokenCache} appId={APP_ID}>
      <Screen />
    </AtlasProvider>
  );
}
