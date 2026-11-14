/**
 * Change or set the signed-in user's password, manage trusted devices, sessions,
 * two-factor methods, passkeys, linked accounts and notification preferences,
 * from a native app. The provider's client authenticates with the stored session
 * token as a bearer, so these work without a cookie.
 *
 * This module imports no React or React Native, so it is also the
 * `@atlasauth/expo/account-security` subpath (usable in plain Node, tests, workers).
 * The `useAccountSecurity` hook lives in `./account-security-hook`.
 */
import {
  changePassword,
  getNotificationPreferences,
  listMfaFactors,
  listPasskeys,
  listSessions,
  listTrustedDevices,
  regenerateBackupCodes,
  removeMfaFactor,
  removePasskey,
  revokeAllSessions,
  revokeAllTrustedDevices,
  revokeAccountSession,
  revokeTrustedDevice,
  setPassword,
  startSms,
  startTotp,
  unlinkExternalAccount,
  updateNotificationPreferences,
  verifySms,
  verifyTotp,
  type FapiClient,
} from '@atlasauth/js';

export {
  changePassword,
  setPassword,
  listTrustedDevices,
  revokeTrustedDevice,
  revokeAllTrustedDevices,
  listSessions,
  revokeAccountSession,
  revokeAllSessions,
  listMfaFactors,
  startTotp,
  verifyTotp,
  startSms,
  verifySms,
  removeMfaFactor,
  regenerateBackupCodes,
  listPasskeys,
  removePasskey,
  unlinkExternalAccount,
  getNotificationPreferences,
  updateNotificationPreferences,
};

/** The calls bound to a client; separated from React so it is testable with a fake one. */
export function createAccountSecurityActions(client: FapiClient) {
  return {
    changePassword: (input: { currentPassword: string; newPassword: string }) => changePassword(client, input),
    setPassword: (password: string) => setPassword(client, password),
    listTrustedDevices: () => listTrustedDevices(client),
    revokeTrustedDevice: (id: string) => revokeTrustedDevice(client, id),
    revokeAllTrustedDevices: () => revokeAllTrustedDevices(client),
    listSessions: () => listSessions(client),
    revokeAccountSession: (id: string) => revokeAccountSession(client, id),
    revokeAllSessions: () => revokeAllSessions(client),
    listMfaFactors: () => listMfaFactors(client),
    startTotp: () => startTotp(client),
    verifyTotp: (factorId: string, codes: string[]) => verifyTotp(client, factorId, codes),
    startSms: (phone: string) => startSms(client, phone),
    verifySms: (factorId: string, code: string) => verifySms(client, factorId, code),
    removeMfaFactor: (factorId: string) => removeMfaFactor(client, factorId),
    regenerateBackupCodes: () => regenerateBackupCodes(client),
    listPasskeys: () => listPasskeys(client),
    removePasskey: (id: string) => removePasskey(client, id),
    unlinkExternalAccount: (id: string) => unlinkExternalAccount(client, id),
    getNotificationPreferences: () => getNotificationPreferences(client),
    updateNotificationPreferences: (preferences: Record<string, boolean>) => updateNotificationPreferences(client, preferences),
  };
}

export type AccountSecurityActions = ReturnType<typeof createAccountSecurityActions>;
