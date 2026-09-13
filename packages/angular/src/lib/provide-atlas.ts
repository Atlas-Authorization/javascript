import {
  ENVIRONMENT_INITIALIZER,
  EnvironmentProviders,
  ModuleWithProviders,
  NgModule,
  Provider,
  inject,
  makeEnvironmentProviders,
} from '@angular/core';
import { ATLAS_OPTIONS, type AtlasOptions } from './atlas.config';
import { AtlasService } from './atlas.service';
import { ATLAS_UI } from './atlas.ui';

/**
 * Standalone-provider entry point (Angular 17+). Register Atlas once at the
 * application root — the direct analogue of wrapping the tree in React's
 * `<AtlasProvider publishableKey>`:
 *
 * ```ts
 * bootstrapApplication(AppComponent, {
 *   providers: [
 *     provideAtlas({ publishableKey: 'pk_test_…' }),
 *     provideRouter(routes),
 *   ],
 * });
 * ```
 *
 * The returned providers make {@link AtlasService} injectable and eagerly
 * construct it, so the SDK begins its first boot (redirect-completion + session
 * read) as soon as the app starts — matching the React provider mounting on the
 * first render.
 */
export function provideAtlas(options: AtlasOptions): EnvironmentProviders {
  return makeEnvironmentProviders([
    { provide: ATLAS_OPTIONS, useValue: options },
    AtlasService,
    {
      // Eagerly instantiate AtlasService so its boot runs at startup rather than
      // lazily on first injection — the equivalent of the provider mounting.
      provide: ENVIRONMENT_INITIALIZER,
      multi: true,
      useValue: () => {
        inject(AtlasService);
      },
    },
  ]);
}

/**
 * NgModule entry point for apps not yet on the standalone bootstrap. Import
 * `AtlasModule.forRoot({ publishableKey })` once in the root module; feature
 * modules import `AtlasModule` (no args) to use the directives/components.
 */
@NgModule({
  // Standalone directives/components are re-exported so NgModule consumers get
  // them just by importing AtlasModule, the way they would with a classic module.
  imports: [...ATLAS_UI],
  exports: [...ATLAS_UI],
})
export class AtlasModule {
  static forRoot(options: AtlasOptions): ModuleWithProviders<AtlasModule> {
    const providers: Provider[] = [
      { provide: ATLAS_OPTIONS, useValue: options },
      AtlasService,
      {
        provide: ENVIRONMENT_INITIALIZER,
        multi: true,
        useValue: () => {
          inject(AtlasService);
        },
      },
    ];
    return { ngModule: AtlasModule, providers };
  }
}
