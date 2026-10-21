import type { AtlasSdkInfo } from '@atlasauth/js';

/**
 * This package's version, sent as `X-Atlas-SDK` so the Frontend API can answer
 * an upgrade advisory. Kept in step with package.json by version.test.ts.
 */
export const ATLAS_REACT_VERSION = '0.10.1';

/** How this SDK names itself to the Frontend API. */
export const ATLAS_REACT_SDK: AtlasSdkInfo = { name: '@atlasauth/react', version: ATLAS_REACT_VERSION };
