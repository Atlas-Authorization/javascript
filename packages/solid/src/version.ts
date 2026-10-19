import type { AtlasSdkInfo } from '@atlasauth/js';

/** This package's version, sent as `X-Atlas-SDK` (kept in step with package.json by a test). */
export const ATLAS_SOLID_VERSION = '0.5.0';
export const ATLAS_SOLID_SDK: AtlasSdkInfo = { name: '@atlasauth/solid', version: ATLAS_SOLID_VERSION };
