import { createEffect, createSignal, onCleanup, onMount, type Accessor } from 'solid-js';
import {
  ApiKeysController,
  BillingController,
  CheckoutController,
  DeviceAuthorizationController,
  FapiClient,
  UsageController,
  type ApiKeysState,
  type BillingState,
  type CheckoutControllerOptions,
  type CheckoutState,
  type UsageState,
  type DeviceAuthorizationState,
  type ObservableController,
  type ReauthOptions,
} from '@atlasauth/js';
import { useAtlas } from './context';
import { ATLAS_SOLID_SDK } from './version';

/** The shared plumbing of the API keys, billing and device authorization primitives and components. */

function mirror<S extends object>(controller: ObservableController<S>): Accessor<S> {
  const [state, setState] = createSignal(controller.getState());
  onCleanup(controller.subscribe((next) => setState(() => next)));
  return state;
}

/** A Frontend API client and the step-up options for the signed-in user. */
export function useMeClients(): { client: FapiClient; reauth: ReauthOptions } {
  const atlas = useAtlas();
  return {
    client: new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_SOLID_SDK }),
    reauth: { api: atlas.frontendApi, publishableKey: atlas.publishableKey, locale: atlas.locale ?? undefined },
  };
}

/** The signed-in user's own API keys (or the active organization's with `organizationId`). */
export function createApiKeys(options: { organizationId?: string } = {}): { state: Accessor<ApiKeysState>; controller: ApiKeysController } {
  const { client, reauth } = useMeClients();
  const controller = new ApiKeysController(client, reauth, options);
  const state = mirror(controller);
  onMount(() => void controller.load());
  return { state, controller };
}

/** Device sign-in (RFC 8628) approval: `controller.lookup(code)`, then `approve()` or `deny()`. */
export function createDeviceAuthorization(): { state: Accessor<DeviceAuthorizationState>; controller: DeviceAuthorizationController } {
  const { client, reauth } = useMeClients();
  const controller = new DeviceAuthorizationController(client, reauth);
  return { state: mirror(controller), controller };
}

/** Plans, subscription, invoices and payment method, with checkout, portal, plan change, cancel, restore and a feature check. */
export function createBilling(options: { orgId?: string } = {}): { state: Accessor<BillingState>; controller: BillingController } {
  const atlas = useAtlas();
  const { client } = useMeClients();
  const controller = new BillingController(client, options);
  const state = mirror(controller);
  createEffect(() => {
    const status = atlas.state.status;
    if (status !== 'loading') void controller.load(status === 'signed_in');
  });
  return { state, controller };
}

/** The checkout step for one plan (interval, discount code with server-side apply, continue to payment). Pass the controller from {@link createBilling}. */
export function createCheckoutStep(
  billing: BillingController,
  planId: string,
  options: CheckoutControllerOptions = {},
): { state: Accessor<CheckoutState>; controller: CheckoutController } {
  const controller = new CheckoutController(billing, planId, options);
  return { state: mirror(controller), controller };
}

/** The subject's metered usage this billing period, for a "you have used N" display. For UI only; enforce on your server. */
export function createUsage(options: { orgId?: string; feature?: string } = {}): { state: Accessor<UsageState>; controller: UsageController } {
  const atlas = useAtlas();
  const { client } = useMeClients();
  const controller = new UsageController(client, options);
  const state = mirror(controller);
  createEffect(() => {
    const status = atlas.state.status;
    if (status !== 'loading') void controller.load(status === 'signed_in');
  });
  return { state, controller };
}
