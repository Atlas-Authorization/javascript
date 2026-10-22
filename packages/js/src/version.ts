/**
 * This package's version, sent as `X-Atlas-SDK: @atlasauth/js/<version>` so the
 * Frontend API can answer an upgrade advisory. A constant (not read from
 * package.json at runtime) so the bundle stays dependency-free and tests stay
 * deterministic; `version.test.ts` fails when it drifts from package.json.
 */
export const ATLAS_JS_VERSION = '0.15.0';
