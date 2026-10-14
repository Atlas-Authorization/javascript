import {
  ForbiddenException,
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ProtectCondition, VerifyResult } from '@atlasauth/backend';
import { ATLAS_BACKEND, IS_PUBLIC_KEY, REQUIRE_PERMISSION_KEY } from './constants';
import { extractToken, getRequest, type AtlasRequest } from './request';

/**
 * The slice of `@atlasauth/backend`'s `AtlasBackend` a guard needs: local,
 * networkless `verify(token)`. Typing the dependency this narrowly is what lets
 * a test inject a stub verifier in place of the real one.
 */
export interface AtlasVerifier {
  verify(token: string): Promise<VerifyResult>;
}

/**
 * `AtlasGuard` — the server-side twin of `@atlasauth/express`'s `requireAuth`,
 * expressed as a Nest `CanActivate`.
 *
 * It pulls the session JWT off the request (`Authorization: Bearer` or the
 * `__session` cookie), verifies it LOCALLY through the injected
 * `@atlasauth/backend` verifier (§7.3 — no network call on the hot path), and on
 * success attaches the verified session to `request.atlas` and lets the request
 * through. A missing or invalid token throws `UnauthorizedException` (401) —
 * UNLESS the handler or its controller is marked `@Public()`, which the guard
 * honours via `Reflector`.
 *
 * Apply it per-route with `@UseGuards(AtlasGuard)`, or globally with
 * `APP_GUARD` so every route is closed by default and opened with `@Public()`.
 */
@Injectable()
export class AtlasGuard implements CanActivate {
  constructor(
    protected readonly reflector: Reflector,
    @Inject(ATLAS_BACKEND) protected readonly backend: AtlasVerifier,
  ) {}

  /** True when the handler or its class carries the `@Public()` marker. */
  protected isPublic(context: ExecutionContext): boolean {
    return (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
        context.getHandler(),
        context.getClass(),
      ]) ?? false
    );
  }

  /**
   * Verify the request and decorate it. Returns `true` (or throws 401). Shared
   * with {@link AtlasAuthGuard}, which layers a permission check on top.
   */
  protected async authenticate(context: ExecutionContext): Promise<AtlasRequest> {
    const request = getRequest(context);
    const token = extractToken(request);
    if (!token) {
      throw new UnauthorizedException('No Atlas session token on the request.');
    }

    const result = await this.backend.verify(token);
    if (!result.ok) {
      throw new UnauthorizedException('Invalid Atlas session token.');
    }

    // The verified session — claims + bound has()/protect() — rides on the
    // request for `@AtlasAuth()` / `@CurrentUser()` and downstream guards.
    request.atlas = result;
    return request;
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;
    await this.authenticate(context);
    return true;
  }
}

/**
 * `AtlasAuthGuard` — `AtlasGuard` plus a permission/role gate.
 *
 * It first authenticates exactly as {@link AtlasGuard} (honouring `@Public()`),
 * then, when the handler or class carries a `@RequirePermission(...)` condition,
 * asserts it against the verified claims using the session's bound `has()`.
 * An unmet condition throws `ForbiddenException` (403); with no
 * `@RequirePermission(...)` it behaves identically to `AtlasGuard`.
 *
 * @example
 * @UseGuards(AtlasAuthGuard)
 * @RequirePermission('org:billing:manage')
 * @Post('invoices') createInvoice() { ... }
 */
@Injectable()
export class AtlasAuthGuard extends AtlasGuard {
  override async canActivate(context: ExecutionContext): Promise<boolean> {
    if (this.isPublic(context)) return true;

    const request = await this.authenticate(context);

    const condition = this.reflector.getAllAndOverride<ProtectCondition>(REQUIRE_PERMISSION_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!condition) return true;

    // `request.atlas` is always set here — authenticate() either set it or threw.
    if (!request.atlas?.has(condition)) {
      throw new ForbiddenException('Missing the required permission for this route.');
    }
    return true;
  }
}
