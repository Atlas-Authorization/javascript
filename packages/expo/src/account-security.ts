/**
 * Change or set the signed-in user's password, and manage trusted devices, from
 * a native app. The provider's client authenticates with the stored session
 * token as a bearer, so these work without a cookie.
 */
import { useMemo } from 'react';
import { changePassword, listTrustedDevices, revokeTrustedDevice, setPassword, type FapiClient } from '@atlasauth/js';
import { useExpoFapiClient } from './policies';

export { changePassword, setPassword, listTrustedDevices, revokeTrustedDevice };

/** The calls bound to a client; separated from React so it is testable with a fake one. */
export function createAccountSecurityActions(client: FapiClient) {
  return {
    changePassword: (input: { currentPassword: string; newPassword: string }) => changePassword(client, input),
    setPassword: (password: string) => setPassword(client, password),
    listTrustedDevices: () => listTrustedDevices(client),
    revokeTrustedDevice: (id: string) => revokeTrustedDevice(client, id),
  };
}

/** `const { changePassword } = useAccountSecurity();` bound to the provider's bearer-authenticated client. */
export function useAccountSecurity() {
  const client = useExpoFapiClient();
  return useMemo(() => (client ? createAccountSecurityActions(client) : null), [client]);
}
