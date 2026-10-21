import type { AtlasSdkInfo } from '@atlasauth/js';

/** This package's version, sent as `X-Atlas-SDK` (kept in step with package.json by a test). */
export const ATLAS_SVELTE_VERSION = '0.6.1';
export const ATLAS_SVELTE_SDK: AtlasSdkInfo = { name: '@atlasauth/svelte', version: ATLAS_SVELTE_VERSION };
