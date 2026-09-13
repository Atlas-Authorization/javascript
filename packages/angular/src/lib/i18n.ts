/**
 * §10.3: "Every string passes through an i18n catalog; en-US ships, catalog
 * format documented for community locales."
 *
 * A flat key-to-string map rather than nested objects, because nesting looks
 * tidier and makes a missing key a runtime crash on `undefined.of.a.chain`
 * rather than a visible fallback.
 *
 * A missing key renders the KEY, not an empty string. A blank button is a bug
 * nobody can report; a button reading `signIn.submit` is one anyone can.
 */

export type Catalog = Record<string, string>;

export const EN_US: Catalog = {
  'signIn.title': 'Sign in',
  'signIn.subtitle': 'to continue to {application}',
  'signIn.identifierLabel': 'Email address',
  'signIn.passwordLabel': 'Password',
  'signIn.submit': 'Continue',
  'signIn.forgotPassword': 'Forgot password?',
  'signIn.noAccount': 'No account?',
  'signIn.signUpLink': 'Sign up',
  'signIn.orDivider': 'or',
  'signIn.socialButton': 'Continue with {provider}',
  'signIn.emailCodeLabel': 'Verification code',
  'signIn.magicLinkSent': 'Check your email for a sign-in link.',
  'signIn.checkOtherTab': 'You can close this tab — you are signed in where you started.',

  'signUp.title': 'Create your account',
  'signUp.submit': 'Continue',
  'signUp.haveAccount': 'Already have an account?',
  'signUp.signInLink': 'Sign in',

  'mfa.title': 'Two-step verification',
  'mfa.subtitle': 'Enter the code from your authenticator app.',
  'mfa.codeLabel': 'Code',
  'mfa.enrollFirstCodeLabel': 'Code from your authenticator app',
  'mfa.enrollSecondCodeLabel': 'The next code it shows',
  'mfa.usePasskey': 'Use a passkey instead',
  'mfa.useBackupCode': 'Use a recovery code',
  'mfa.submit': 'Verify',

  'reset.title': 'Reset your password',
  'reset.submit': 'Send reset code',
  'reset.newPasswordLabel': 'New password',

  'userButton.manageAccount': 'Manage account',
  'userButton.signOut': 'Sign out',
  'userButton.signOutAll': 'Sign out of all devices',

  'userProfile.title': 'Account',
  'userProfile.profileSection': 'Profile',
  'userProfile.emailsSection': 'Email addresses',
  'userProfile.securitySection': 'Security',
  'userProfile.devicesSection': 'Active devices',
  'userProfile.dangerSection': 'Danger zone',
  'userProfile.addEmail': 'Add an email address',
  'userProfile.makePrimary': 'Make primary',
  'userProfile.unverified': 'Unverified',
  'userProfile.revokeDevice': 'Sign out',
  'userProfile.deleteAccount': 'Delete account',

  'organization.switcher': 'Switch organization',
  'organization.personal': 'Personal account',
  'organization.members': 'Members',
  'organization.invite': 'Invite member',
  'organization.roleLabel': 'Role',

  'error.generic': 'Something went wrong. Please try again.',
  'error.network': 'We could not reach the server. Check your connection.',
};

/**
 * Look up a key and interpolate `{placeholders}`.
 *
 * An unknown placeholder is left visible for the same reason a missing key is:
 * `Continue with {provider}` in the UI is a bug report waiting to be filed,
 * whereas `Continue with ` is one nobody notices until a customer does.
 */
export function translate(
  catalog: Catalog,
  key: string,
  variables: Record<string, string> = {},
): string {
  const template = catalog[key] ?? EN_US[key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name: string) => variables[name] ?? match);
}

/** Merge a community locale over en-US so a partial translation still renders. */
export function withFallback(locale: Catalog): Catalog {
  return { ...EN_US, ...locale };
}
