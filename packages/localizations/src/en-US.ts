import type { LocalizationResource } from './types';

/**
 * English (United States) — the COMPLETE reference bundle.
 *
 * Every key is filled. Strings are copied verbatim from the Atlas catalog in
 * `packages/react/src/i18n.ts` (`EN_US`); this file is the single source every
 * other locale is a (partial) override of, and the test suite's strict-subset
 * check is anchored on its key set.
 */
export const enUS: LocalizationResource = {
  locale: 'en-US',

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
  'userButton.switchTo': 'Switch to',

  'commerce.subscribe': 'Subscribe',
  'commerce.manage': 'Manage billing',
  'commerce.invoices': 'Invoices',
  'commerce.noInvoices': 'No invoices yet.',
  'commerce.viewInvoice': 'View',

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
  'organization.createTitle': 'Create organization',
  'organization.nameLabel': 'Organization name',
  'organization.create': 'Create organization',
  'organization.orCreate': 'or create a new organization',

  'waitlist.title': 'Join the waitlist',
  'waitlist.emailLabel': 'Email address',
  'waitlist.submit': 'Join the waitlist',
  'waitlist.success': "You're on the list. We'll be in touch.",

  'reverification.title': "Confirm it's you",
  'reverification.subtitle': 'Re-enter your password to continue.',
  'reverification.passwordLabel': 'Password',
  'reverification.submit': 'Confirm',
  'reverification.cancel': 'Cancel',

  'error.generic': 'Something went wrong. Please try again.',
  'error.network': 'We could not reach the server. Check your connection.',
};

export default enUS;
