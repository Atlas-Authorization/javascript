import { useState } from 'react';
import { Button, SafeAreaView, Text } from 'react-native';
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

  async function onPress() {
    const result = await signInWithOAuth(PROVIDER);
    setStatus(result.status);
  }

  return (
    <SafeAreaView>
      <Text testID="signed-in">{isSignedIn ? 'signed-in' : 'signed-out'}</Text>
      <Text testID="status">{status}</Text>
      <Button testID="sign-in" title="Sign in" onPress={onPress} />
    </SafeAreaView>
  );
}

export default function App() {
  return (
    <AtlasProvider publishableKey={PK} frontendApi={FAPI} tokenCache={tokenCache} appId={APP_ID}>
      <Screen />
    </AtlasProvider>
  );
}
