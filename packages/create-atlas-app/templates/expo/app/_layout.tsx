import { Slot } from 'expo-router';
import { AtlasProvider } from '@atlasauth/expo';
import { tokenCache } from '../lib/tokenCache';

// EXPO_PUBLIC_ variables are bundled into the app: only ever put the publishable key here.
export default function RootLayout() {
  return (
    <AtlasProvider
      publishableKey={process.env.EXPO_PUBLIC_ATLAS_PUBLISHABLE_KEY ?? ''}
      frontendApi={process.env.EXPO_PUBLIC_ATLAS_FRONTEND_API ?? ''}
      tokenCache={tokenCache}
    >
      <Slot />
    </AtlasProvider>
  );
}
