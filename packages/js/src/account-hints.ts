import type { FapiClient } from './fapi';
import type { UsernameRule } from './environment';

/**
 * Sign-up / sign-in form hints: whether a username is free (a live hint beside
 * the field) and which method this browser last signed in with (the "Last used"
 * badge). Both are hints only — the server enforces everything on submit.
 */

/** `POST /v1/client/usernames/availability`. */
export interface UsernameAvailability {
  username: string;
  /** Meets the instance's username rule. */
  valid: boolean;
  /** Valid and nobody holds it. */
  available: boolean;
  /** The rule it breaks, when not valid. */
  message?: string;
}

/**
 * Ask whether a username is free. Null when the server cannot say (usernames
 * off, rate-limited, unreachable) — a form then simply shows no hint.
 */
export async function checkUsernameAvailability(
  client: FapiClient,
  username: string,
): Promise<UsernameAvailability | null> {
  try {
    const response = await client.post<{
      username?: unknown;
      valid?: unknown;
      available?: unknown;
      message?: unknown;
    }>('/v1/client/usernames/availability', { username });
    const d = response.data;
    if (!response.ok || !d) return null;
    return {
      username: typeof d.username === 'string' ? d.username : username.trim(),
      valid: d.valid === true,
      available: d.available === true,
      ...(typeof d.message === 'string' ? { message: d.message } : {}),
    };
  } catch {
    return null;
  }
}

const CHARSET_RE: Record<UsernameRule['charset'], RegExp> = {
  default: /^[A-Za-z0-9._-]+$/,
  alphanumeric: /^[A-Za-z0-9]+$/,
  alphanumeric_underscore: /^[A-Za-z0-9_]+$/,
};

/** Check a username against the rule locally (before asking the server). */
export function usernameMeetsRule(username: string, rule: UsernameRule): boolean {
  const v = username.trim();
  return v.length >= rule.minLength && v.length <= rule.maxLength && CHARSET_RE[rule.charset].test(v);
}

/**
 * The method this browser last signed in with, as the server recorded it
 * (`password`, `email_code`, `email_link`, `passkey`, `phone_code`,
 * `oauth_google`, …). Null when none is remembered, the instance turned the
 * hint off, or the server cannot be reached.
 */
export async function fetchLastSignInMethod(client: FapiClient): Promise<string | null> {
  try {
    const response = await client.get<{ method?: unknown }>('/v1/client/last_sign_in_method');
    const m = response.ok ? response.data?.method : null;
    return typeof m === 'string' && m ? m : null;
  } catch {
    return null;
  }
}

/**
 * Whether a sign-in option is the one last used. `option` is a first factor
 * (`password`, `email_code`, `passkey`, …) or a social provider id (`google`).
 * Email code and email link count as one ("email"), as do the OAuth and the
 * native flow of a provider.
 */
export function isLastUsed(lastMethod: string | null | undefined, option: string): boolean {
  if (!lastMethod) return false;
  const norm = (m: string) => {
    if (m.startsWith('oauth_')) return `oauth:${m.slice(6)}`;
    if (m.startsWith('id_token_')) return `oauth:${m.slice(9)}`;
    if (m === 'email_code' || m === 'email_link') return 'email';
    return m;
  };
  const last = norm(lastMethod);
  return last === norm(option) || last === `oauth:${option}`;
}

/**
 * The label a sign-in form shows for a first-party "Last used" method
 * (`Last used: Password`), or null for social / enterprise methods (badged on
 * their own buttons) and anything unrecognised. `t` is the form's translator.
 */
export function lastUsedMethodLabel(
  lastMethod: string | null | undefined,
  t: (key: string) => string,
): string | null {
  switch (lastMethod) {
    case 'password':
      return t('signIn.passwordLabel');
    case 'email_code':
    case 'email_link':
      return t('signIn.identifierLabel');
    case 'passkey':
      return 'Passkey';
    case 'phone_code':
      return 'Phone';
    default:
      return null;
  }
}

/**
 * Email OTP second factor: mail a code to the user's verified address for this
 * sign-in attempt (on its `needs_second_factor` step). Resolves the masked
 * address it went to; the code is then submitted like any second-factor code.
 * Throws with the server's message when the factor is not offered.
 */
export async function prepareEmailSecondFactor(
  client: FapiClient,
  attemptId: string,
): Promise<{ sentTo: string }> {
  const response = await client.post<{ sent_to?: unknown }>(
    `/v1/client/sign_ins/${encodeURIComponent(attemptId)}/prepare_second_factor`,
    { strategy: 'email_code' },
  );
  if (!response.ok) {
    const first = response.errors[0];
    const error = new Error(first?.message ?? 'Could not send the code.') as Error & { code?: string };
    if (first?.code) error.code = first.code;
    throw error;
  }
  return { sentTo: typeof response.data?.sent_to === 'string' ? response.data.sent_to : '' };
}
