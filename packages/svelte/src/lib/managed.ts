import { onDestroy } from 'svelte';
import { readable, type Readable } from 'svelte/store';
import {
  ApiKeysController,
  BillingController,
  CheckoutController,
  DeviceAuthorizationController,
  UsageController,
  type CheckoutControllerOptions,
  type ObservableController,
  type UsageState,
  type ReauthOptions,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { FapiClient } from './fapi';
import { ATLAS_SVELTE_SDK } from './version';

/** The shared plumbing of the API keys, billing and device authorization components. */

/** A controller as a Svelte store: `$state` in a component re-renders on every change. */
export function controllerStore<S extends object>(controller: ObservableController<S>): Readable<S> {
  return readable(controller.getState(), (set) => controller.subscribe(set));
}

function clients() {
  const atlas = useAtlas();
  const client = new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_SVELTE_SDK });
  const reauth: ReauthOptions = { api: atlas.frontendApi, publishableKey: atlas.publishableKey, locale: atlas.locale };
  return { atlas, client, reauth };
}

/** Call during component setup: the signed-in user's own API keys (or the organization's with `organizationId`). */
export function createApiKeysController(options: { organizationId?: string } = {}) {
  const { client, reauth } = clients();
  return new ApiKeysController(client, reauth, options);
}

/** Call during component setup: device sign-in approval. */
export function createDeviceAuthorizationController() {
  const { client, reauth } = clients();
  return new DeviceAuthorizationController(client, reauth);
}

/** Call during component setup: plans, subscription, invoices and payment method for the user (or `orgId`). */
export function createBillingController(options: { orgId?: string } = {}) {
  const { atlas, client } = clients();
  return { atlas, client, controller: new BillingController(client, options) };
}

/** Call during component setup: the checkout step for one plan. Pass the controller from {@link createBillingController}. */
export function createCheckoutController(billing: BillingController, planId: string, options: CheckoutControllerOptions = {}) {
  return new CheckoutController(billing, planId, options);
}

/**
 * Call during component setup: the subject's metered usage this billing period as a store (`$usage.total`),
 * loaded and reloaded as the auth status settles. For UI only; enforce on your server.
 */
export function createUsage(options: { orgId?: string; feature?: string } = {}): { usage: Readable<UsageState>; controller: UsageController } {
  const { atlas, client } = clients();
  const controller = new UsageController(client, options);
  onDestroy(atlas.status.subscribe((s) => void (s !== 'loading' && controller.load(s === 'signed_in'))));
  return { usage: controllerStore(controller), controller };
}
