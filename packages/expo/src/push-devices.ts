/**
 * Register this phone for "Approve in your app" pushes, without enrolling push
 * as a second factor. A thin hook over the `@atlasauth/js` calls, bound to the
 * provider's bearer-authenticated client.
 */
import { useCallback, useState } from 'react';
import { listPushDevices, registerApprovalDevice, removePushDevice, respondToPushDevice, type FapiClient, type PendingPushDevice, type PushDevice } from '@atlasauth/js';
import { useExpoFapiClient } from './policies';

export interface PushDevicesController {
  /** The device just registered, awaiting its number. Show `pending.number` to the person. */
  pending: PendingPushDevice | null;
  error: string | null;
  /** Register an Expo (or native) push token for approvals only. */
  register(input: { deviceToken: string; platform: PushDevice['platform']; label?: string }): Promise<boolean>;
  /** Confirm with the number the person tapped. */
  confirm(number: string): Promise<boolean>;
  list(): Promise<PushDevice[]>;
  remove(id: string): Promise<boolean>;
}

/** Controller logic, separated from React so it is testable with a fake client. */
export function createPushDeviceActions(client: FapiClient) {
  return {
    register: (input: { deviceToken: string; platform: PushDevice['platform']; label?: string }) => registerApprovalDevice(client, input),
    confirm: async (challengeId: string, number: string) => (await respondToPushDevice(client, { challengeId, number })).ok,
    list: () => listPushDevices(client),
    remove: async (id: string) => (await removePushDevice(client, id)).ok,
  };
}

export function usePushDevices(): PushDevicesController {
  const client = useExpoFapiClient();
  const [pending, setPending] = useState<PendingPushDevice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const actions = createPushDeviceActions(client);

  const register = useCallback(async (input: { deviceToken: string; platform: PushDevice['platform']; label?: string }) => {
    const { pending: next, response } = await createPushDeviceActions(client).register(input);
    setPending(next);
    setError(next ? null : (response.errors[0]?.message ?? 'The device could not be registered.'));
    return next !== null;
  }, [client]);

  const confirm = useCallback(async (number: string) => {
    if (!pending) return false;
    const ok = await createPushDeviceActions(client).confirm(pending.challengeId, number);
    setError(ok ? null : 'The number was not accepted.');
    if (ok) setPending(null);
    return ok;
  }, [client, pending]);

  return { pending, error, register, confirm, list: actions.list, remove: actions.remove };
}
