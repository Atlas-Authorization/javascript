import type { AtlasSdkInfo } from '@atlasauth/js';

/** This package's version, sent as `X-Atlas-SDK` (kept in step with package.json by a test). */
export const ATLAS_ANGULAR_VERSION = '0.12.0';
export const ATLAS_ANGULAR_SDK: AtlasSdkInfo = { name: '@atlasauth/angular', version: ATLAS_ANGULAR_VERSION };
