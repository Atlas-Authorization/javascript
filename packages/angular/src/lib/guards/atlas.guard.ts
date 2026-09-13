import { inject } from '@angular/core';
import {
  CanActivateChildFn,
  CanActivateFn,
  Router,
  type UrlTree,
} from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { filter, take } from 'rxjs/operators';
import { evaluate, type ProtectCondition } from '@atlasauth/authz';
import { AtlasService } from '../atlas.service';

export interface AtlasGuardOptions extends ProtectCondition {
  /**
   * Where to send a user who fails the check. When set, the guard returns a
   * `UrlTree` (a redirect); when omitted it simply returns `false` and the
   * navigation is cancelled. A common value is your sign-in route.
   */
  redirectTo?: string;
  /**
   * When true, append the attempted URL as a `redirect_url` query param on the
   * `redirectTo` target, so the sign-in page can send the user back afterwards.
   * Ignored unless `redirectTo` is set. Defaults to true.
   */
  preserveReturnUrl?: boolean;
}

/**
 * Route guard factory that gates a route on session — and optionally on a
 * permission/role. The Angular peer of using `<SignedIn>` / `<Protect>` to fence
 * a page, expressed as a `CanActivateFn`.
 *
 * ```ts
 * export const routes: Routes = [
 *   { path: 'dashboard', canActivate: [atlasGuard({ redirectTo: '/sign-in' })], ... },
 *   {
 *     path: 'admin',
 *     canActivate: [atlasGuard({ permission: 'org:admin', redirectTo: '/' })],
 *     ...
 *   },
 * ];
 * ```
 *
 * The guard first waits for the SDK to finish booting, so a hard refresh onto a
 * protected URL does not bounce to sign-in before the session has been read.
 * Like the components, this is UX, not security: the server enforces the same
 * checks on every request.
 */
export function atlasGuard(options: AtlasGuardOptions = {}): CanActivateFn {
  const { redirectTo, preserveReturnUrl = true, ...condition } = options;

  return async (_route, state): Promise<boolean | UrlTree> => {
    const atlas = inject(AtlasService);
    const router = inject(Router);

    // Wait for boot to settle so we judge against a real answer, not `loading`.
    await firstValueFrom(
      atlas.status$.pipe(
        filter((s) => s !== 'loading'),
        take(1),
      ),
    );

    const allowed = evaluate(atlas.claims(), condition as ProtectCondition).allowed;
    if (allowed) return true;

    if (redirectTo) {
      return router.createUrlTree([redirectTo], {
        queryParams: preserveReturnUrl ? { redirect_url: state.url } : undefined,
      });
    }
    return false;
  };
}

/**
 * The `CanActivateChild` form of {@link atlasGuard}, for gating a whole child
 * route subtree with one declaration.
 */
export function atlasChildGuard(options: AtlasGuardOptions = {}): CanActivateChildFn {
  const guard = atlasGuard(options);
  return (route, state) => guard(route, state);
}
