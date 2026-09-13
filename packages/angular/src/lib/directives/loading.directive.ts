import { Directive } from '@angular/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { AtlasToggleDirective } from './toggle.directive';

/**
 * `*atlasLoading` — render the template only while the SDK is still booting. The
 * Angular peer of React's `<AtlasLoading>`; show a spinner here.
 */
@Directive({
  selector: '[atlasLoading]',
  standalone: true,
})
export class AtlasLoadingDirective extends AtlasToggleDirective {
  protected override source(): Observable<boolean> {
    return this.atlas.isLoaded$.pipe(map((loaded) => !loaded));
  }
}
