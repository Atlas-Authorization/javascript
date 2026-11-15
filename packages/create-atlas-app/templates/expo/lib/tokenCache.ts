import * as SecureStore from 'expo-secure-store';
import { createSecureStoreTokenCache } from '@atlasauth/expo';

// The session token lives in the platform keychain / keystore, so it survives an app restart.
export const tokenCache = createSecureStoreTokenCache(SecureStore);
