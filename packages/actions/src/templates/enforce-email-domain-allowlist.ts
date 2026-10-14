import { defineAction } from '../types';

/** One-line description for the gallery manifest. */
export const description =
  'Block registration unless the email domain is on an approved allowlist.';

/**
 * enforce-email-domain-allowlist (pre_user_registration)
 *
 * Only let people register with an email on an approved domain — e.g. lock a
 * B2B app to a customer's corporate domains. Configure the secret
 * `ALLOWED_EMAIL_DOMAINS` as a comma-separated list (e.g. `acme.com,acme.io`);
 * if it is unset the action allows everyone (fail-open on mis-config, since a
 * missing allowlist is not itself a security decision).
 */
export const action = defineAction('pre_user_registration', async (event, api) => {
  const allowed = (event.secrets.ALLOWED_EMAIL_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0) return;

  const email = (event.user.email || '').toLowerCase();
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1) : '';

  if (!domain || !allowed.includes(domain)) {
    api.access.deny('Registration is restricted to approved email domains.');
  }
});
