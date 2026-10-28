import type { AtlasSdkInfo } from '@atlasauth/js';

/** This package's version, sent as `X-Atlas-SDK` (kept in step with package.json by a test). */
export const ATLAS_EMBED_VERSION = '0.14.0';
export const ATLAS_EMBED_SDK: AtlasSdkInfo = { name: '@atlasauth/embed', version: ATLAS_EMBED_VERSION };
