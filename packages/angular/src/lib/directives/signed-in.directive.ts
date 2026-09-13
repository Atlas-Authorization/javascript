import { Directive } from '@angular/core';
import { Observable, combineLatest } from 'rxjs';
import { map } from 'rxjs/operators';
import { AtlasToggleDirective } from './toggle.directive';

/**
 * `*atlasSignedIn` — render the template only when the SDK has loaded AND the
 * user is signed in. The Angular peer of React's `<SignedIn>`. Renders nothing
 * while loading, so no signed-in UI flashes before boot completes.
 *
 * ```html
 * <div *atlasSignedIn>Welcome back</div>
 * ```
 */
@Directive({
  selector: '[atlasSignedIn]',
  standalone: true,
})
export class AtlasSignedInDirective extends AtlasToggleDirective {
  protected override source(): Observable<boolean> {
    return combineLatest([this.atlas.isLoaded$, this.atlas.isSignedIn$]).pipe(
      map(([loaded, signedIn]) => loaded && signedIn),
    );
  }
}
