import { Directive } from '@angular/core';
import { Observable } from 'rxjs';
import { AtlasToggleDirective } from './toggle.directive';

/**
 * `*atlasLoaded` — render the template only once the SDK has finished booting.
 * The Angular peer of React's `<AtlasLoaded>`, the symmetric partner of
 * `*atlasLoading`.
 */
@Directive({
  selector: '[atlasLoaded]',
  standalone: true,
})
export class AtlasLoadedDirective extends AtlasToggleDirective {
  protected override source(): Observable<boolean> {
    return this.atlas.isLoaded$;
  }
}
