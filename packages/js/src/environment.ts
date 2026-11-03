import type { FapiClient } from './fapi';

/**
 * The client environment (`GET /v1/client/environment`) and the email-delivery
 * facts both it and `GET /v1/appearance` publish.
 *
 * An app that cannot deliver email (a production instance with no email
 * provider) cannot send a reset code, an email sign-in code or link, or a
 * sign-up verification code. The server already stops offering email code / link
 * and refuses those requests; `email_delivery` lets a sign-in UI say so up front
 * instead: hide "Forgot password?" and email-code options, and show a "can't
 * send email" state where a sign-up would need one.
 */

/** `email_delivery`: what works given whether the app can deliver email. */
export interface EmailDelivery {
  /** The app can send email (its own provider, or the shared development sender). */
  available: boolean;
  /** "Forgot password?" can work: password sign-in is on and reset emails can be delivered. */
  passwordReset: boolean;
  /** Email + password sign-up can complete (email can be delivered, or verification is not required). */
  passwordSignUp: boolean;
}

/**
 * What an older server (no `email_delivery`) is taken to mean: everything works.
 * The server still refuses whatever it cannot deliver.
 */
export const EMAIL_DELIVERY_UNKNOWN: Readonly<EmailDelivery> = Object.freeze({
  available: true,
  passwordReset: true,
  passwordSignUp: true,
});

/** The default English copy for the "can't send email" state. */
export const EMAIL_UNAVAILABLE_MESSAGE =
  "This app can't send email right now. Try another sign-in method or contact the app owner.";

/** The first factors that need the app to deliver email. */
export const EMAIL_FIRST_FACTORS: readonly string[] = ['email_code', 'email_link'];

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Read `email_delivery` from a `/v1/client/environment` or `/v1/appearance`
 * body — or from the `email_delivery` object itself. A missing object or field
 * reads as available (see {@link EMAIL_DELIVERY_UNKNOWN}).
 */
export function emailDeliveryFrom(body: unknown): EmailDelivery {
  const raw = isRecord(body) && isRecord(body.email_delivery) ? body.email_delivery : body;
  if (!isRecord(raw) || !('available' in raw || 'password_reset' in raw || 'password_sign_up' in raw)) {
    return { ...EMAIL_DELIVERY_UNKNOWN };
  }
  const flag = (v: unknown) => (typeof v === 'boolean' ? v : true);
  return {
    available: flag(raw.available),
    passwordReset: flag(raw.password_reset),
    passwordSignUp: flag(raw.password_sign_up),
  };
}

/**
 * The first factors a sign-in UI should offer: `strategies` without email code /
 * link while the app cannot deliver email. A capability of the app, not of the
 * user, so it never narrows the server's uniform list per identifier. With no
 * `delivery` (not loaded yet) the list is returned unchanged.
 */
export function offeredFirstFactors(
  strategies: readonly string[],
  delivery: EmailDelivery | null | undefined,
): string[] {
  if (!delivery || delivery.available) return [...strategies];
  return strategies.filter((s) => !EMAIL_FIRST_FACTORS.includes(s));
}

/** The username rule an instance enforces (from `account.username`). */
export interface UsernameRule {
  minLength: number;
  maxLength: number;
  /** `default` = letters, digits and `. _ -`. */
  charset: 'default' | 'alphanumeric' | 'alphanumeric_underscore';
  requiredAtSignUp: boolean;
}

/** How an emailed proof arrives: a code to type, a link to click, or either. */
export type EmailProofDelivery = 'code' | 'link' | 'both';

/** `account`: what a sign-in / sign-up form needs to draw itself. */
export interface AccountUx {
  /** Null while usernames are off. */
  username: UsernameRule | null;
  /** Badge the method this browser last signed in with as "Last used". */
  lastSignInMethod: boolean;
  emailVerification: EmailProofDelivery;
  passwordReset: EmailProofDelivery;
  /** The second-factor step may offer "email me a code" ({@link prepareEmailSecondFactor}). */
  emailSecondFactor: boolean;
  /** The instance offers the custom challenge second factor (set only when true). */
  customSecondFactor?: boolean;
  /**
   * Passkey-only sign-up ({@link startPasskeySignUp}), when the instance offers
   * it: whether the form collects an email address. Null when not offered.
   */
  passkeySignUp: { email: 'off' | 'optional' | 'required' } | null;
  /**
   * The second factors a sign-in may set up or use, when the server says
   * (`account.mfa`): an authenticator app, texted codes (on AND the app can
   * text), and how many authenticator codes enrolment asks for. Absent on a
   * server that does not say: the MFA steps then offer the authenticator app
   * only (see `mfaChoicesFrom`).
   */
  mfa?: {
    totp: boolean;
    sms: boolean;
    totpCodes: 1 | 2;
    /** Counter tokens, YubiKeys, Duo, recovery questions and smart card sign-in. False/absent from an older server. */
    hotp?: boolean;
    yubikey?: boolean;
    duo?: boolean;
    securityQuestions?: boolean;
    smartCard?: boolean;
  };
}

/**
 * What an older server (no `account`) is taken to mean: no usernames at
 * sign-up, codes only, and no "Last used" hint (it has no endpoint for one).
 */
export const ACCOUNT_UX_DEFAULT: Readonly<AccountUx> = Object.freeze({
  username: null,
  lastSignInMethod: false,
  emailVerification: 'code',
  passwordReset: 'code',
  emailSecondFactor: false,
  passkeySignUp: null,
});

const proof = (v: unknown): EmailProofDelivery => (v === 'link' || v === 'both' ? v : 'code');

/** Read `account` from a `/v1/client/environment` or `/v1/appearance` body. */
export function accountUxFrom(body: unknown): AccountUx {
  const raw = isRecord(body) && isRecord(body.account) ? body.account : null;
  if (!raw) return { ...ACCOUNT_UX_DEFAULT };
  const u = isRecord(raw.username) ? raw.username : null;
  const n = (v: unknown, d: number) => (typeof v === 'number' && Number.isInteger(v) ? v : d);
  return {
    username: u
      ? {
          minLength: n(u.min_length, 3),
          maxLength: n(u.max_length, 30),
          charset:
            u.charset === 'alphanumeric' || u.charset === 'alphanumeric_underscore' ? u.charset : 'default',
          requiredAtSignUp: u.required_at_sign_up === true,
        }
      : null,
    lastSignInMethod: raw.last_sign_in_method === true,
    emailVerification: proof(raw.email_verification),
    passwordReset: proof(raw.password_reset),
    emailSecondFactor: raw.email_second_factor === true,
    ...(raw.custom_second_factor === true ? { customSecondFactor: true } : {}),
    ...(isRecord(raw.mfa)
      ? {
          mfa: {
            totp: raw.mfa.totp !== false,
            sms: raw.mfa.sms === true,
            totpCodes: Number(raw.mfa.totp_codes ?? raw.mfa.totpCodes) >= 2 ? 2 : 1,
            ...(raw.mfa.hotp === true ? { hotp: true } : {}),
            ...(raw.mfa.yubikey === true ? { yubikey: true } : {}),
            ...(raw.mfa.duo === true ? { duo: true } : {}),
            ...(raw.mfa.security_questions === true ? { securityQuestions: true } : {}),
            ...(raw.mfa.smart_card === true ? { smartCard: true } : {}),
          } as const,
        }
      : {}),
    passkeySignUp: isRecord(raw.passkey_sign_up)
      ? {
          email:
            raw.passkey_sign_up.email === 'off' || raw.passkey_sign_up.email === 'optional'
              ? raw.passkey_sign_up.email
              : 'required',
        }
      : null,
  };
}

/** One entry of the environment's `social_providers`. */
export interface EnvironmentSocialProvider {
  provider: string;
  /** Whether the provider signs in natively (One Tap etc.) on this instance. */
  native: boolean;
  mode: 'native' | 'redirect';
  /** The full button text, or null for the SDK's own label. */
  label: string | null;
  display_name: string | null;
  icon: { type: 'url' | 'svg'; value: string } | null;
  allow_sign_in: boolean;
  allow_sign_up: boolean;
  /** Public client id, for native providers only. */
  client_id?: string;
  /** Telegram's bot username. */
  bot_username?: string;
}

/** `GET /v1/client/environment`, typed. */
export interface ClientEnvironment {
  /** The enabled first factors (`password`, `email_code`, `passkey`, …). */
  firstFactors: string[];
  /**
   * The offered strategies, camelCase as the server sends them (`password`,
   * `emailCode`, `emailLink`, `passkey`, `phoneCode`, …, `oauthProviders`).
   */
  strategies: Record<string, unknown>;
  emailDelivery: EmailDelivery;
  socialProviders: EnvironmentSocialProvider[];
  account: AccountUx;
}

/** Read a `/v1/client/environment` body. Defensive: malformed parts read as empty. */
export function clientEnvironmentFrom(body: unknown): ClientEnvironment {
  const root = isRecord(body) ? body : {};
  return {
    firstFactors: Array.isArray(root.first_factors)
      ? root.first_factors.filter((f): f is string => typeof f === 'string')
      : [],
    strategies: isRecord(root.strategies) ? { ...root.strategies } : {},
    emailDelivery: emailDeliveryFrom(root),
    socialProviders: Array.isArray(root.social_providers)
      ? (root.social_providers.filter(
          (p) => isRecord(p) && typeof p.provider === 'string',
        ) as unknown as EnvironmentSocialProvider[])
      : [],
    account: accountUxFrom(root),
  };
}

/** Fetch the client environment. Null when the server can't be reached or errors. */
export async function fetchClientEnvironment(client: FapiClient): Promise<ClientEnvironment | null> {
  try {
    const response = await client.get<unknown>('/v1/client/environment');
    return response.ok ? clientEnvironmentFrom(response.data) : null;
  } catch {
    return null;
  }
}
