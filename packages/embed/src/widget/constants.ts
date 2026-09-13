/** Providers that need the user's handle collected BEFORE the redirect (the
 *  handle resolves their server): AT-Proto / Bluesky. */
export const HANDLE_PROVIDERS = new Set<string>(['bluesky']);

/** Static, first-party chevrons for the carousel scroll buttons. */
export const CHEVRON_LEFT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
export const CHEVRON_RIGHT =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';

export const COPY = {
  'sign-in': { title: 'Sign in', submit: 'Continue' },
  'sign-up': { title: 'Create your account', submit: 'Continue' },
} as const;
