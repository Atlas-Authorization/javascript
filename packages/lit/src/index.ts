export * from './types';
export * from './client';
export * from './context';
export * from './widget';
export {
  AtlasProvider,
  AtlasElement,
  AtlasSignedIn,
  AtlasSignedOut,
  AtlasLoading,
  AtlasProtect,
  AtlasSignOutButton,
  AtlasSignIn,
  AtlasSignUp,
  defineAtlasElements,
} from './elements';
export { SignOutError } from '@atlasauth/js';
export type { SignOutOptions, SignOutResult } from '@atlasauth/js';

import { defineAtlasElements } from './elements';

// Registering on import is what makes `<atlas-provider>` work from a plain <script type="module">.
if (typeof customElements !== 'undefined') defineAtlasElements();
