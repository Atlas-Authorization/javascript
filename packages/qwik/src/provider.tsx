import {
  component$,
  noSerialize,
  Slot,
  useContextProvider,
  useStore,
  useVisibleTask$,
} from '@builder.io/qwik';
import { resolveFrontendApi } from '@atlasauth/js';
import { createAtlasClient } from './client';
import { AtlasContextId } from './context';
import { applySnapshot, initialStore, type AtlasStore } from './store';

export interface AtlasProviderProps {
  /** Publishable key (`pk_…`) identifying the instance. */
  publishableKey: string;
  /**
   * The instance's Frontend API: an absolute URL such as
   * `"https://auth.example.com"`, or `"same-origin"` / a path such as `"/atlas"`
   * behind a reverse proxy on the app's own origin. Required at runtime — the
   * provider throws an `AtlasConfigError` (`FRONTEND_API_REQUIRED` /
   * `FRONTEND_API_INVALID`) while rendering, on the server as well, when it is
   * missing or malformed. Optional in the type only so existing call sites keep
   * compiling.
   */
  frontendApi?: string;
}

/**
 * `<AtlasProvider publishableKey="pk_…">` — the peer of React's `<AtlasProvider>`
 * and Vue's `createAtlas()` plugin.
 *
 * Qwik serialization boundary, handled explicitly:
 *   - A serializable `useStore` holds the plain auth snapshot and the instance
 *     keys. This is what Qwik ships to the browser and resumes from.
 *   - The LIVE client is created only in `useVisibleTask$`, which runs on the
 *     client, never on the server. It is placed on the store with `noSerialize`,
 *     so Qwik skips it when serializing (its closures, `TokenCache` and refresh
 *     timer are not serializable) and reads it back as `undefined` everywhere it
 *     has not been re-created. The hooks tolerate that `undefined`.
 *
 * The task subscribes to the client, mirrors each snapshot into the reactive
 * store, boots the session (which also completes an OAuth redirect), and tears
 * the client down on cleanup so a navigation or HMR swap leaves no live timer
 * behind.
 */
export const AtlasProvider = component$<AtlasProviderProps>((props) => {
  // Validated at render — including the SSR render — so a missing value fails
  // loudly instead of booting a client that calls relative paths on the app's
  // origin. The store carries the resolved base the widgets read.
  const frontendApi = resolveFrontendApi(props.frontendApi, { component: '<AtlasProvider>' });
  const store = useStore<AtlasStore>(initialStore(props.publishableKey, frontendApi));
  useContextProvider(AtlasContextId, store);

  // eslint-disable-next-line qwik/no-use-visible-task -- the Atlas client is a
  // browser-only engine (cookies, timers, redirect completion); it must not run
  // during SSR, and `useVisibleTask$` is exactly the client-only, post-paint hook
  // for that.
  useVisibleTask$(({ cleanup }) => {
    const client = createAtlasClient({
      publishableKey: props.publishableKey,
      frontendApi: props.frontendApi,
    });
    // noSerialize: keep the live client OFF the serialization path.
    store.client = noSerialize(client);

    const unsubscribe = client.subscribe((snapshot) => applySnapshot(store, snapshot));
    // Seed the store with the client's current (pre-boot) snapshot, then boot.
    applySnapshot(store, client.snapshot());
    void client.boot();

    cleanup(() => {
      unsubscribe();
      client.destroy();
      store.client = undefined;
    });
  });

  return <Slot />;
});
