import { signInWithWebAuthFlow } from '@atlasauth/chrome-extension/background';

signInWithWebAuthFlow({
  frontendApi: 'https://fapi.example.com',
  publishableKey: 'pk_test_example',
  clientId: 'example-extension-client',
}).catch(() => {});
