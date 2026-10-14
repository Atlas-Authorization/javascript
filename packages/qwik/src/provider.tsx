import {
  component$,
  noSerialize,
  Slot,
  useContextProvider,
  useStore,
  useVisibleTask$,
} from '@builder.io/qwik';
import { createAtlasClient } from './client';
import { AtlasContextId } from './context';
import { applySnapshot, initialStore, type AtlasStore } from './store';

export interface AtlasProviderProps {
  /** Publishable key (`pk_…`) identifying the instance. */
  publishableKey: string;
  /** The instance's FAPI origin the client calls cross-origin. */
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
  const store = useStore<AtlasStore>(
    initialStore(props.publishableKey, props.frontendApi ?? ''),
  );
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
