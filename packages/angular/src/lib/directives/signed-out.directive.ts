import { Directive } from '@angular/core';
import { Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';
import { AtlasToggleDirective } from './toggle.directive';

/**
 * `*atlasSignedOut` — render the template only when the SDK has loaded AND the
 * user is signed out. The Angular peer of React's `<SignedOut>`. Renders nothing
 * while loading, the symmetric partner of `*atlasSignedIn`.
 *
 * ```html
 * <atlas-sign-in *atlasSignedOut></atlas-sign-in>
 * ```
 */
@Directive({
  selector: '[atlasSignedOut]',
  standalone: true,
})
export class AtlasSignedOutDirective extends AtlasToggleDirective {
  protected override source(): Observable<boolean> {
    return combineLatest([this.atlas.isLoaded$, this.atlas.isSignedIn$]).pipe(
      map(([loaded, signedIn]) => loaded && !signedIn),
    );
  }
}
