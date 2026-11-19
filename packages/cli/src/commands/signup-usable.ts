import type { ConfigHttp } from '../config-http';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});

/** What decides whether anyone can sign up: the state AFTER the file is applied. */
export interface SignupState {
  strategies: Rec;
  /** Email methods the live instance reports inactive (snake_case: password, email_code, email_link). */
  inactive: ReadonlySet<string>;
  /** true / false when known (a provider is, or is not, set), undefined when unknown. */
  emailConfigured?: boolean;
  signInWithAtlas: boolean;
  /** A configured social / enterprise provider that allows sign-up. */
  socialSignUp: boolean;
}

/** The first-factor sign-up methods that would be usable, by name. Pure. */
export function usableSignupMethods(s: SignupState): string[] {
  const emailOk = (method: string) => (s.emailConfigured === undefined ? !s.inactive.has(method) : s.emailConfigured);
  const out: string[] = [];
  if (s.strategies.password === true && emailOk('password')) out.push('password');
  if (s.strategies.emailCode === true && emailOk('email_code')) out.push('email_code');
  if (s.strategies.emailLink === true && emailOk('email_link')) out.push('email_link');
  for (const k of ['phoneCode', 'siwe', 'siws', 'siwb', 'siwf']) if (s.strategies[k] === true) out.push(k);
  if (s.signInWithAtlas) out.push('sign_in_with_atlas');
  if (s.socialSignUp) out.push('social');
  return out;
}

export const NO_SIGNUP_METHOD_MESSAGE =
  'No usable sign-up method: after this change nobody can create an account. Turn on Sign in with Atlas first ' +
  '(PATCH /v1/instance/sign_in_with_atlas {"enabled":true}, or `sign_in_with_atlas: { enabled: true }` in the file; it needs no keys), ' +
  'then add an email provider (PUT /v1/messaging_providers/email) or a social provider such as Google.';

const merge = (base: Rec, over: Rec): Rec => {
  const out: Rec = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = v === null ? undefined : v;
  return out;
};

/**
 * An error-level message when the instance, once the file is applied, leaves no usable first-factor sign-up method;
 * null when there is one, or when it cannot be told (an unreachable or older server never raises a false alarm).
 * Silent when the file changes nothing that decides it; otherwise works it out from the merged strategies,
 * `inactive_methods`, providers and Sign in with Atlas.
 */
export async function signupUsabilityError(
  http: ConfigHttp,
  desired: { instance?: unknown; signInWithAtlas?: unknown; oauthProviders?: unknown; emailProviderInFile: boolean },
): Promise<string | null> {
  // A file that touches nothing deciding sign-up cannot break it; preflight and golive report the live state.
  const touches = desired.instance !== undefined || desired.signInWithAtlas !== undefined || desired.oauthProviders !== undefined || desired.emailProviderInFile;
  if (!touches) return null;
  try {
    const live = rec(await http.get<unknown>('/v1/instance'));

    const liveCfg = rec(live.auth_config_resolved ?? live.auth_config);
    const desiredCfg = rec(rec(desired.instance).auth_config);
    // No strategies anywhere (an older or partial answer): nothing to judge, so no alarm.
    if (!Object.keys(rec(liveCfg.strategies)).length && !Object.keys(rec(desiredCfg.strategies)).length) return null;
    const strategies = merge(rec(liveCfg.strategies), rec(desiredCfg.strategies));
    const inactive = new Set(
      (Array.isArray(live.inactive_methods) ? live.inactive_methods : []).map((m) => String(rec(m).method)),
    );

    let emailConfigured: boolean | undefined = desired.emailProviderInFile ? true : undefined;
    if (emailConfigured === undefined) {
      try {
        emailConfigured = rec(await http.get<unknown>('/v1/messaging_providers/email')).configured === true ? true : undefined;
      } catch {
        // Unknown: fall back to the live inactive_methods.
      }
    }

    let signInWithAtlas: boolean | undefined = desired.signInWithAtlas === undefined ? undefined : rec(desired.signInWithAtlas).enabled === true;
    if (signInWithAtlas === undefined) {
      try {
        signInWithAtlas = rec(await http.get<unknown>('/v1/instance/sign_in_with_atlas')).enabled === true;
      } catch {
        signInWithAtlas = false;
      }
    }

    let providers: unknown[] | undefined = Array.isArray(desired.oauthProviders) ? desired.oauthProviders : undefined;
    if (providers === undefined) {
      try {
        const body = rec(await http.get<unknown>('/v1/oauth_providers'));
        providers = (Array.isArray(body.data) ? body.data : []).filter((p) => rec(p).configured === true);
      } catch {
        return null; // cannot tell
      }
    }
    const socialSignUp = providers.some((p) => rec(p).allow_sign_up !== false);

    return usableSignupMethods({ strategies, inactive, emailConfigured, signInWithAtlas, socialSignUp }).length ? null : NO_SIGNUP_METHOD_MESSAGE;
  } catch {
    return null;
  }
}
