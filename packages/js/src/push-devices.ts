import type { FapiClient, FapiResponse } from './fapi';

/**
 * Push devices for the signed-in person. Register one for "Approve in your app"
 * only ({@link registerApprovalDevice}): it never enrolls push as a second factor.
 * Registering needs a recent step-up, a push sender on the instance, and
 * approve-in-your-app turned on. Confirm the device by answering the number it is
 * pushed ({@link respondToPushDevice}).
 */
export interface PushDevice {
  id: string;
  platform: 'apns' | 'fcm' | 'expo';
  label: string | null;
  /** `mfa` devices serve the push second factor and approvals; `approvals` devices get approval pushes only. */
  purpose: 'mfa' | 'approvals';
  verified: boolean;
  createdAt: number;
  lastSeenAt: number | null;
}

/** A push device as the API returns it (snake_case). */
export interface PushDeviceWire {
  id: string;
  platform: PushDevice['platform'];
  label: string | null;
  purpose: PushDevice['purpose'];
  verified: boolean;
  created_at: number;
  last_seen_at: number | null;
}

const toDevice = (d: PushDeviceWire): PushDevice => ({ id: d.id, platform: d.platform, label: d.label, purpose: d.purpose ?? 'mfa', verified: d.verified, createdAt: d.created_at, lastSeenAt: d.last_seen_at });

/** A device that was just registered: show `number` to the person, who taps it on the device. */
export interface PendingPushDevice {
  device: PushDevice;
  challengeId: string;
  number: string;
  expiresAt: number;
}

/** Register this device for approval pushes only. No push factor is created. */
export async function registerApprovalDevice(
  client: FapiClient,
  input: { deviceToken: string; platform: PushDevice['platform']; label?: string },
): Promise<{ pending: PendingPushDevice | null; response: FapiResponse<PushDeviceWire & { challenge_id: string; number_match: string; expires_at: number }> }> {
  const response = await client.post<PushDeviceWire & { challenge_id: string; number_match: string; expires_at: number }>('/v1/client/me/push_devices', {
    device_token: input.deviceToken,
    platform: input.platform,
    ...(input.label ? { label: input.label } : {}),
  });
  const d = response.data;
  return { pending: response.ok && d ? { device: toDevice(d), challengeId: d.challenge_id, number: d.number_match, expiresAt: d.expires_at } : null, response };
}

/** Answer a device confirmation challenge with the number the person tapped. */
export function respondToPushDevice(client: FapiClient, input: { challengeId: string; number: string }): Promise<FapiResponse<{ status: string; verified?: boolean }>> {
  return client.post(`/v1/client/me/push_devices/challenges/${encodeURIComponent(input.challengeId)}/respond`, { action: 'approve', selected_number: input.number });
}

/** Every push device the person has registered, approvals-only ones included. */
export async function listPushDevices(client: FapiClient): Promise<PushDevice[]> {
  const response = await client.get<{ data: PushDeviceWire[] }>('/v1/client/me/push_devices');
  return response.ok && response.data ? response.data.data.map(toDevice) : [];
}

/** Remove a push device. Needs a recent step-up. */
export function removePushDevice(client: FapiClient, id: string): Promise<FapiResponse<unknown>> {
  return client.request(`/v1/client/me/push_devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
