import { DestroyRef, inject, signal, type Signal } from '@angular/core';
import { UsageController, type ObservableController, type UsageState } from '@atlasauth/js';
import { AtlasService } from '../atlas.service';

/**
 * A controller's snapshot as an Angular signal, unsubscribed when the component (its `DestroyRef`) is destroyed.
 */
export function controllerSignal<S extends object>(controller: ObservableController<S>, destroyRef: DestroyRef): Signal<S> {
  const state = signal(controller.getState());
  destroyRef.onDestroy(controller.subscribe((next) => state.set(next)));
  return state.asReadonly();
}

/**
 * Call in an injection context (a constructor or field initializer): the subject's metered usage this billing
 * period as a signal, reloaded as the auth status settles. For UI only; enforce on your server.
 */
export function injectUsage(options: { orgId?: string; feature?: string } = {}): { state: Signal<UsageState>; controller: UsageController } {
  const atlas = inject(AtlasService);
  const destroyRef = inject(DestroyRef);
  const controller = new UsageController(atlas.createFapiClient(), options);
  const state = controllerSignal(controller, destroyRef);
  const sub = atlas.status$.subscribe((status) => {
    if (status !== 'loading') void controller.load(status === 'signed_in');
  });
  destroyRef.onDestroy(() => sub.unsubscribe());
  return { state, controller };
}
