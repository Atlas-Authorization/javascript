import type { TranslationResult } from '../framework/plugin';
import { ConfigBuilder } from './translate-kit';

/**
 * `atlas migrate magic config` — Magic has no settings API (login methods,
 * social connections and wallet settings live in its dashboard), so the
 * translation is the sensible Atlas defaults for a Magic app plus a report of
 * where each Magic setting is and what replaces it. `clientId` is the
 * publishable client id (`did:magic:…`) the DID tokens are issued for.
 */
export interface MagicConfigInput {
  clientId?: string;
  /** What the dashboard export showed (users with a phone number). */
  hasPhones?: boolean;
}

export function translateMagicConfig(input: MagicConfigInput): TranslationResult {
  const b = new ConfigBuilder();
  b.set('strategies.emailCode', true);
  b.add('mapped', 'login methods', 'Email OTP', 'Magic\'s one-time email code becomes Atlas\'s email code sign-in.', 'auth_config.strategies.emailCode');
  b.set('strategies.emailLink', true);
  b.add('mapped', 'login methods', 'Magic link', 'The emailed sign-in link becomes Atlas\'s email link sign-in.', 'auth_config.strategies.emailLink');
  if (input.hasPhones) {
    b.set('strategies.phoneCode', true);
    b.add('mapped', 'login methods', 'SMS login', 'SMS code sign-in.', 'auth_config.strategies.phoneCode');
  }
  for (const [setting, where, note] of [
    ['social login (OAuth connections)', 'Dashboard → Social Login', 'Add each provider in Atlas (oauth_providers) with the same OAuth app so accounts relink by email; Magic keeps the client secrets, copy them from the provider.'],
    ['passkey / WebAuthn login', 'Dashboard → Settings', 'Turn on Atlas passkeys; Magic does not export credentials, so users register a passkey again.'],
    ['wallets (embedded wallet keys)', 'Dashboard → Settings → Wallets', 'Atlas does not custody wallet keys. Users export their key from Magic before the switch, or keep Magic for wallet operations only; "Sign in with Ethereum" (siwe) covers wallet-based sign-in.'],
    ['allowed origins and redirect URLs', 'Dashboard → Settings → Allowed Origins & Redirects', 'Add them to Atlas redirect URLs and the instance\'s allowed origins.'],
    ['session / DID token lifespan', 'magic.user.getIdToken({ lifespan })', 'DID tokens are minted by your app; with Atlas, sessions are configured under Sessions in the dashboard.'],
    ['custom SMTP / branding', 'Dashboard → Settings → Custom SMTP, Branding', 'Configure your own email sender and branding in Atlas.'],
  ] as const) {
    b.add('manual', 'settings not in the API', setting, `Magic does not expose this by API; it is at ${where}. ${note}`);
  }
  const vars: Record<string, string> = input.clientId ? { client_id: input.clientId } : {};
  return b.result(input.clientId ? `Magic client ${input.clientId}` : 'Magic app', input.clientId ? { bridge: { preset: 'magic', vars } } : {});
}
