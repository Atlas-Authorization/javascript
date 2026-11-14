import { FapiClient, type ReauthOptions } from '@atlasauth/js';
import type { AtlasStore } from './store';

/** A Frontend API client and the step-up options for the signed-in user, built client-side from the store. */
export function meClients(store: Pick<AtlasStore, 'publishableKey' | 'frontendApi'>): { client: FapiClient; reauth: ReauthOptions } {
  return {
    client: new FapiClient({ publishableKey: store.publishableKey, baseUrl: store.frontendApi }),
    reauth: { api: store.frontendApi, publishableKey: store.publishableKey },
  };
}
