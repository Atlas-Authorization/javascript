import { defineAction } from '../types';

export const description =
  'Reject sign-ups that use a known disposable / throwaway email provider.';

/**
 * block-disposable-emails (pre_user_registration)
 *
 * Keep throwaway inboxes out of your user base. The domain list is inlined (the
 * sandbox has no network, so it cannot call a disposable-domain API) and can be
 * extended; a real deployment typically pastes a larger curated list in here or
 * supplements it from the `EXTRA_DISPOSABLE_DOMAINS` secret.
 */
export const action = defineAction('pre_user_registration', async (event, api) => {
  const DISPOSABLE = [
    'mailinator.com',
    'guerrillamail.com',
    '10minutemail.com',
    'tempmail.com',
    'temp-mail.org',
    'trashmail.com',
    'yopmail.com',
    'getnada.com',
    'sharklasers.com',
    'dispostable.com',
    'maildrop.cc',
    'throwawaymail.com',
  ];
  const extra = (event.secrets.EXTRA_DISPOSABLE_DOMAINS || '')
    .split(',')
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  const blocked = new Set([...DISPOSABLE, ...extra]);

  const email = (event.user.email || '').toLowerCase();
  const at = email.lastIndexOf('@');
  const domain = at >= 0 ? email.slice(at + 1) : '';

  if (domain && blocked.has(domain)) {
    api.access.deny('Please sign up with a permanent email address.');
  }
});
