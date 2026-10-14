import {
  SetMetadata,
  createParamDecorator,
  type CustomDecorator,
  type ExecutionContext,
} from '@nestjs/common';
import type { ProtectCondition, SessionClaims, AuthorizedSession } from '@atlasauth/backend';
import { IS_PUBLIC_KEY, REQUIRE_PERMISSION_KEY } from './constants';
import { getRequest } from './request';

/**
 * Mark a route handler (or an entire controller) as public: {@link AtlasGuard}
 * sees the metadata through `Reflector` and skips verification, so no token is
 * required. Everything else the guard protects stays closed by default.
 *
 * @example
 * @Public()
 * @Get('health')
 * health() { return { ok: true }; }
 */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC_KEY, true);

/**
 * Require an authorization condition on a route guarded by {@link AtlasAuthGuard}.
 * Accepts a bare permission string (shorthand for `{ permission }`) or a full
 * {@link ProtectCondition} (`role` / `anyPermission` / `allPermissions` / `plan`
 * / `feature`). The guard asserts it against the verified claims and throws
 * `ForbiddenException` (403) when unmet.
 *
 * @example
 * @RequirePermission('org:billing:manage')
 * @RequirePermission({ role: 'admin' })
 */
export const RequirePermission = (condition: string | ProtectCondition): CustomDecorator =>
  SetMetadata(
    REQUIRE_PERMISSION_KEY,
    typeof condition === 'string' ? { permission: condition } : condition,
  );

/**
 * The factory behind {@link AtlasAuth}: returns the whole verified session that
 * {@link AtlasGuard} attached (`claims`, `actor`, `has()`, `protect()`), or
 * `null` when none is present. Exported so it can be unit-tested with a plain
 * `ExecutionContext` double, without booting Nest.
 */
export const atlasAuthFactory = (
  _data: unknown,
  context: ExecutionContext,
): AuthorizedSession | null => getRequest(context).atlas ?? null;

/**
 * The factory behind {@link CurrentUser}: returns the verified {@link SessionClaims}
 * (which carry `sub`, `sid`, org fields, entitlements…), or `null` when the
 * request was not authenticated. Exported for direct unit testing.
 */
export const currentUserFactory = (
  _data: unknown,
  context: ExecutionContext,
): SessionClaims | null => getRequest(context).atlas?.claims ?? null;

/**
 * Param decorator giving a handler the full verified session {@link AuthorizedSession}
 * — the result shape `@atlasauth/backend` produces, with the bound `has()` /
 * `protect()` helpers. `null` on an unauthenticated request.
 *
 * @example
 * @Get('me') me(@AtlasAuth() auth: AuthorizedSession) { return auth.claims.sub; }
 */
export const AtlasAuth = createParamDecorator(atlasAuthFactory);

/**
 * Param decorator giving a handler the verified {@link SessionClaims} directly
 * — the common case when you only want the signed-in user.
 *
 * @example
 * @Get('me') me(@CurrentUser() user: SessionClaims) { return user.sub; }
 */
export const CurrentUser = createParamDecorator(currentUserFactory);
