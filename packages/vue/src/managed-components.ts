import { onMounted, onScopeDispose, shallowRef, watch, type ShallowRef } from 'vue';
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
import { useAuth } from './composables';
import { ATLAS_VUE_SDK } from './version';

/** The shared plumbing of the API keys, billing and device authorization composables and components. */

/** Mirror a controller's snapshot into a ref for the life of the calling scope. */
function mirror<S extends object>(controller: ObservableController<S>): ShallowRef<S> {
  const state = shallowRef(controller.getState()) as ShallowRef<S>;
  const stop = controller.subscribe((next) => {
    state.value = next;
  });
  onScopeDispose(stop);
  return state;
}

/** A Frontend API client and the step-up options for the signed-in user. */
export function useMeClients() {
  const atlas = useAtlas();
  const client = new FapiClient({ publishableKey: atlas.publishableKey, baseUrl: atlas.frontendApi, locale: atlas.locale, sdk: ATLAS_VUE_SDK });
  const reauth: ReauthOptions = { api: atlas.frontendApi, publishableKey: atlas.publishableKey, locale: atlas.locale ?? undefined };
  return { client, reauth };
}

/**
 * The signed-in user's own API keys (or the active organization's with `organizationId`): list, create with the
 * step-up wired in (`state.needsReverification`, then `controller.completeReverification(password)`), rename, revoke.
 */
export function useApiKeys(options: { organizationId?: string } = {}): { state: ShallowRef<ApiKeysState>; controller: ApiKeysController } {
  const { client, reauth } = useMeClients();
  const controller = new ApiKeysController(client, reauth, options);
  const state = mirror(controller);
  onMounted(() => void controller.load());
  return { state, controller };
}

/** Device sign-in (RFC 8628) approval: `controller.lookup(code)`, then `approve()` or `deny()`. */
export function useDeviceAuthorization(): { state: ShallowRef<DeviceAuthorizationState>; controller: DeviceAuthorizationController } {
  const { client, reauth } = useMeClients();
  const controller = new DeviceAuthorizationController(client, reauth);
  return { state: mirror(controller), controller };
}

/**
 * Plans, the subscription, invoices and payment method, with checkout, portal, plan change, cancel, restore and a
 * feature check on `controller`. Pass `orgId` to act on an organization the user administers.
 */
export function useBilling(options: { orgId?: string } = {}): { state: ShallowRef<BillingState>; controller: BillingController } {
  const { client } = useMeClients();
  const { status } = useAuth();
  const controller = new BillingController(client, options);
  const state = mirror(controller);
  watch(status, (s) => void (s !== 'loading' && controller.load(s === 'signed_in')), { immediate: true });
  return { state, controller };
}

/** Just the Frontend API client. */
export const useMeClient = (): FapiClient => useMeClients().client;

/** The checkout step for one plan (interval, discount code with server-side apply, continue to payment). Pass the controller from {@link useBilling}. */
export function useCheckoutStep(
  billing: BillingController,
  planId: string,
  options: CheckoutControllerOptions = {},
): { state: ShallowRef<CheckoutState>; controller: CheckoutController } {
  const controller = new CheckoutController(billing, planId, options);
  return { state: mirror(controller), controller };
}

/** The subject's metered usage this billing period, for a "you have used N" display. For UI only; enforce on your server. */
export function useUsage(options: { orgId?: string; feature?: string } = {}): { state: ShallowRef<UsageState>; controller: UsageController } {
  const { client } = useMeClients();
  const { status } = useAuth();
  const controller = new UsageController(client, options);
  const state = mirror(controller);
  watch(status, (s) => void (s !== 'loading' && controller.load(s === 'signed_in')), { immediate: true });
  return { state, controller };
}
