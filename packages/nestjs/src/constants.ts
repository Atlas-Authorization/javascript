/**
 * Injection tokens and metadata keys for `@atlasauth/nestjs`.
 *
 * Kept in their own module so a decorator, a guard and the dynamic module can
 * all reference the same string without a circular import between them.
 */

/**
 * The DI token under which {@link AtlasModule} provides the configured
 * `@atlasauth/backend` verifier. Inject it with `@Inject(ATLAS_BACKEND)` — or
 * the {@link InjectAtlas} shorthand — to reach the verifier directly.
 */
export const ATLAS_BACKEND = 'ATLAS_BACKEND';

/**
 * Metadata key set by {@link Public}. `AtlasGuard` reads it off the handler and
 * its class via `Reflector` and skips verification when it is truthy.
 */
export const IS_PUBLIC_KEY = 'atlas:public';

/**
 * Metadata key set by {@link RequirePermission}. `AtlasAuthGuard` reads it and
 * asserts the condition against the verified claims, 403-ing when unmet.
 */
export const REQUIRE_PERMISSION_KEY = 'atlas:require-permission';
