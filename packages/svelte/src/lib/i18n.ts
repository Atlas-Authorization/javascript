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

import { EMAIL_UNAVAILABLE_MESSAGE, POLICY_STRINGS } from '@atlasauth/js';

export type Catalog = Record<string, string>;

export const EN_US: Catalog = {
  'signIn.title': 'Sign in',
  'signIn.subtitle': 'to continue to {application}',
  'signIn.identifierLabel': 'Email address',
  'signIn.passwordLabel': 'Password',
  'signIn.submit': 'Continue',
  'signIn.forgotPassword': 'Forgot password?',
  'signIn.noAccount': 'No account?',
  'signIn.lastUsed': 'Last used',
  'signIn.signUpLink': 'Sign up',
  'signIn.orDivider': 'or',
  'signIn.socialButton': 'Continue with {provider}',
  'signIn.emailCodeLabel': 'Verification code',
  'signIn.emailCodeOption': 'Email me a code',
  'signIn.emailLinkOption': 'Email me a sign-in link',
  'signIn.magicLinkSent': 'Check your email for a sign-in link.',
  'signIn.codeSentTo': 'We sent a code to {email}. Enter it below.',
  'signIn.linkSentTo': 'We sent a sign-in link to {email}. Open it on any device to continue.',
  'signIn.sending': 'Sending…',
  'signIn.resendCode': 'Resend code',
  'signIn.resendLink': 'Resend link',
  'signIn.passwordOption': 'Use your password instead',
  'signIn.signedIn': 'You\'re signed in.',
  'signIn.sessionNotKept':
    'You signed in, but this browser didn\'t keep the session. If it blocks third-party cookies, allow cookies for this site and try again.',
  'signIn.checkOtherTab': 'You can close this tab — you are signed in where you started.',

  'signUp.title': 'Create your account',
  'signUp.submit': 'Continue',
  'signUp.haveAccount': 'Already have an account?',
  'signUp.signInLink': 'Sign in',
  'signUp.emailLabel': 'Email address',
  'signUp.passwordLabel': 'Password',
  'signUp.optionalField': '{label} (optional)',
  'signUp.selectPlaceholder': 'Select…',
  'signUp.consentAgree': 'I agree to the',
  'signUp.consentNotice': 'By continuing you agree to the',
  'signUp.terms': 'Terms of Service',
  'signUp.privacy': 'Privacy Policy',
  'signUp.and': 'and',
  // Shown instead of the email + password form when the app cannot send email.
  'signUp.emailUnavailable': EMAIL_UNAVAILABLE_MESSAGE,
  'signUp.passkeyOption': 'Sign up with a passkey instead',
  'signUp.passwordOption': 'Sign up with a password instead',
  'signUp.passkeyIntro': "No password needed: you'll sign in with a passkey saved on this device or in your password manager.",
  'signUp.passkeyPrompt': 'Create a passkey to finish setting up your account.',
  'signUp.passkeyCreate': 'Create passkey',
  'signUp.passkeyCancelled': "The passkey wasn't created. Try again when you're ready.",
  'signUp.linkSentTo': 'We sent a confirmation link to {email}. Open it on any device; this page continues on its own.',

  'captcha.prompt': 'Complete the security check to continue.',
  'captcha.required': 'Please complete the security check, then try again.',
  'captcha.failed': "The security check didn't pass. Please try again.",
  'captcha.checking': 'Checking your browser…',
  'captcha.verified': 'Security check complete.',
  'captcha.puzzlePrompt': "Select every picture that shows the same shape as this one. Colour and size don't matter.",
  'captcha.puzzleConfirm': 'Confirm',
  'captcha.puzzleTile': 'Picture {n}',
  'captcha.puzzleAlternative': "Can't do the picture check? Use a longer automatic check instead.",

  'mfa.title': 'Two-step verification',
  'mfa.subtitle': 'Enter the code from your authenticator app.',
  'mfa.codeLabel': 'Code',
  'mfa.enrollFirstCodeLabel': 'Code from your authenticator app',
  'mfa.enrollSecondCodeLabel': 'The next code it shows',
  'mfa.usePasskey': 'Use a passkey instead',
  'mfa.useBackupCode': 'Use a recovery code',
  'mfa.submit': 'Verify',
  'mfa.enrollChoose': 'Set up a second step for signing in.',
  'mfa.enrollTotpOption': 'Use an authenticator app',
  'mfa.enrollSmsOption': 'Use text messages',
  'mfa.enrollScan': 'Scan this QR code with your authenticator app, or enter the setup key.',
  'mfa.enrollQrAlt': 'QR code for your authenticator app',
  'mfa.enrollSetupKey': 'Setup key',
  'mfa.enrollPreparing': 'Setting up…',
  'mfa.phoneLabel': 'Mobile number',
  'mfa.phoneHint': 'Include the country code, for example +14155550101.',
  'mfa.sendCode': 'Text me a code',
  'mfa.codeTextedTo': 'Enter the code we texted to {phone}.',
  'mfa.smsCodeOption': 'Text me a code instead',
  'mfa.recoveryCodesTitle': 'Save your recovery codes',
  'mfa.recoveryCodesHelp': "Each code works once. If you can't use your second step, sign in with one of these. Keep them somewhere safe: they won't be shown again.",
  'mfa.recoveryCodesCopy': 'Copy codes',
  'mfa.recoveryCodesCopied': 'Copied.',
  'mfa.recoveryCodesDownload': 'Download as .txt',
  'mfa.recoveryCodesSaved': "I've saved my codes",

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
  'userProfile.verify': 'Verify',
  'userProfile.verifyConfirm': 'Confirm',
  'userProfile.verifyCodePlaceholder': 'Code from the email',
  'userProfile.verifySendFailed': 'We could not send a code right now. Try again in a minute.',
  'userProfile.verifyCodeRejected': 'That code was not accepted.',
  'userProfile.revokeDevice': 'Sign out',
  'userProfile.deleteAccount': 'Delete account',

  'organization.switcher': 'Switch organization',
  'organization.personal': 'Personal account',
  'organization.members': 'Members',
  'organization.invite': 'Invite member',
  'organization.roleLabel': 'Role',
  'organization.invitations': 'Invitations',
  'organization.settings': 'Settings',
  'organization.emailLabel': 'Email address',
  'organization.sendInvite': 'Send invitation',
  'organization.noInvitations': 'No pending invitations.',
  'organization.remove': 'Remove',
  'organization.revoke': 'Revoke',
  'organization.resend': 'Resend',
  'organization.you': '(you)',
  'organization.leave': 'Leave organization',
  'organization.leaveConfirm': 'Leave {name}? You will lose access until you are invited again.',
  'organization.delete': 'Delete organization',
  'organization.deleteConfirm': 'Delete {name} for every member? This cannot be undone.',
  'organization.confirm': 'Confirm',
  'organization.cancel': 'Cancel',
  'organization.unnamedMember': 'Unnamed member',
  'organization.passwordPrompt': 'Enter your password to confirm.',
  'organization.roles': 'Roles',
  'organization.roleName': 'Role name',
  'organization.roleKey': 'Role key (for example org:auditor)',
  'organization.rolePermissions': 'Permissions',
  'organization.createRole': 'Create role',
  'organization.saveRole': 'Save role',
  'organization.editRole': 'Edit',
  'organization.deleteRole': 'Delete',
  'organization.noCustomRoles': 'This organization has no roles of its own yet.',
  'impersonation.banner': 'You are signed in as {name} on someone else\'s behalf.',
  'impersonation.returnToAdmin': 'Return to admin',
  'impersonation.end': 'End impersonation',

  // Policy acceptance (terms, privacy, any policy).
  ...POLICY_STRINGS,

  'error.generic': 'Something went wrong. Please try again.',
  'error.network': 'We could not reach the server. Check your connection.',

  // Server errors, by the stable `reason` the Frontend API sends. Shown instead
  // of the server's `message` (see `localizedErrorMessage` in @atlasauth/js).
  'error.form_password_incorrect': 'Those credentials are incorrect.',
  'error.form_code_incorrect': 'That code is incorrect.',
  'error.form_code_already_used': 'That code has already been used. Wait for a new one.',
  'error.form_code_expired': 'That code has expired. Request a new one.',
  'error.form_code_max_attempts': 'Too many incorrect codes. Request a new code.',
  'error.form_link_invalid': 'That sign-in link is invalid or has already been used.',
  'error.form_identifier_not_found': "We couldn't find an account with those details.",
  'error.form_identifier_exists': "There's already an account for this email. Sign in with {methods}.",
  'error.form_password_pwned': 'This password has appeared in a known data breach. Please choose a different one.',
  'error.form_password_too_short': 'Password must be at least {min_length} characters.',
  'error.form_password_too_long': 'Password must be at most {max_length} characters.',
  'error.form_password_requires_uppercase': 'Password must contain an uppercase letter.',
  'error.form_password_requires_lowercase': 'Password must contain a lowercase letter.',
  'error.form_password_requires_number': 'Password must contain a number.',
  'error.form_password_requires_symbol': 'Password must contain a symbol.',
  'error.form_password_not_allowed': 'That password is not allowed. Choose a different one.',
  'error.form_password_contains_identifier': 'Password must not contain your email or username.',
  'error.form_password_same_as_current': 'Your new password must be different from your current one.',
  'error.form_password_reused': 'Your new password must not match any of your last {history_count} passwords.',
  'error.password_expired': 'Your password has expired. Reset it to continue.',
  'error.email_not_verified': 'Your email address is not verified yet. Verify it before signing in with your password.',
  'error.sign_in_token_invalid': 'That sign-in token is invalid or has expired.',
  'error.too_many_attempts': 'Too many failed attempts. Try again later.',
  'error.too_many_requests': 'Too many requests. Please try again later.',
  'error.captcha_required': 'Please complete the security check, then try again.',
  'error.captcha_failed': "The security check didn't pass. Please try again.",
  'error.captcha_unavailable': 'The security check is unavailable right now. Please try again later.',
  'error.email_delivery_unavailable': "This app can't send email right now. Try another sign-in method or contact the app owner.",
  'error.strategy_disabled': 'This sign-in method is not available for this app.',
  'error.sign_up_restricted': 'Sign-up on this app is by invitation only.',
  'error.waitlisted': "You're on the waitlist. We'll email you when a place opens up.",
  'error.identifier_not_allowed': 'This email or phone number is not allowed on this app.',
  'error.disposable_email_blocked': 'Sign-up with a disposable or temporary email address is not allowed.',
  'error.sso_required': 'This organization requires signing in through single sign-on.',
  'error.sign_ins_disabled': 'Sign-ins are temporarily disabled.',
  'error.sign_ups_disabled': 'Sign-ups are temporarily disabled.',
  'error.high_risk_blocked': 'This sign-in was blocked because it looked unusual.',
  'error.sms_region_blocked': 'Text messages are not available for this phone number.',
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
