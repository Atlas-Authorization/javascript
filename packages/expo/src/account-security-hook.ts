import { useMemo } from 'react';
import { createAccountSecurityActions } from './account-security';
import { useExpoFapiClient } from './policies';

/** `const { changePassword } = useAccountSecurity();` bound to the provider's bearer-authenticated client. */
export function useAccountSecurity() {
  const client = useExpoFapiClient();
  return useMemo(() => (client ? createAccountSecurityActions(client) : null), [client]);
}
